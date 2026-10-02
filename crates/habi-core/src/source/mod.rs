//! Team library sources: registration, refresh, cached offline browsing.
//!
//! A source is a Git repository (remote or local) or a plain local directory,
//! optionally narrowed to a subdirectory. Refreshing fetches the tracked ref,
//! resolves it to an immutable commit, copies the library files into the
//! content-addressed cache and records a snapshot. A failed refresh keeps the
//! last good snapshot and marks the source stale. Refreshing never changes a
//! project and never executes library content.

pub mod git;

use crate::cancel::CancelToken;
use crate::error::{ErrorInfo, HabiError, Result};
use crate::fsutil::{Bounded, read_bounded, short, tree_digest};
use crate::library::model::{Diagnostic, LibraryIndex, SnapshotFile};
use crate::library::{self};
use crate::paths::{RelPath, display_path};
use crate::store::cas::Blobs;
use crate::store::{AppPaths, ResourceLock, Store};
use git::Git;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SourceKind {
    /// A Git repository (remote URL or local clone).
    Git,
    /// A plain local directory (no version history).
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum TrackedRef {
    /// The remote's default branch (`HEAD`).
    Default,
    Branch {
        name: String,
    },
    Tag {
        name: String,
    },
}

impl TrackedRef {
    fn git_source(&self) -> String {
        match self {
            TrackedRef::Default => "HEAD".into(),
            TrackedRef::Branch { name } => format!("refs/heads/{name}"),
            TrackedRef::Tag { name } => format!("refs/tags/{name}"),
        }
    }

    pub fn label(&self) -> String {
        match self {
            TrackedRef::Default => "default branch".into(),
            TrackedRef::Branch { name } => format!("branch {name}"),
            TrackedRef::Tag { name } => format!("tag {name}"),
        }
    }

    fn validate(&self) -> Result<()> {
        let name = match self {
            TrackedRef::Default => return Ok(()),
            TrackedRef::Branch { name } | TrackedRef::Tag { name } => name,
        };
        let ok = !name.is_empty()
            && name.len() <= 200
            && !name.starts_with('-')
            && !name.starts_with('/')
            && !name.ends_with('/')
            && !name.ends_with(".lock")
            && !name.contains("..")
            && !name.contains("//")
            && !name.contains("@{")
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
        if ok {
            Ok(())
        } else {
            Err(HabiError::invalid(format!(
                "`{name}` is not a valid branch or tag name"
            )))
        }
    }

    fn to_columns(&self) -> (&'static str, Option<String>) {
        match self {
            TrackedRef::Default => ("default", None),
            TrackedRef::Branch { name } => ("branch", Some(name.clone())),
            TrackedRef::Tag { name } => ("tag", Some(name.clone())),
        }
    }

    fn from_columns(kind: &str, name: Option<String>) -> TrackedRef {
        match (kind, name) {
            ("branch", Some(name)) => TrackedRef::Branch { name },
            ("tag", Some(name)) => TrackedRef::Tag { name },
            _ => TrackedRef::Default,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Freshness {
    /// Registered but never fetched.
    NeverFetched,
    /// The first fetch failed; nothing is cached.
    FetchFailed,
    /// The last refresh succeeded.
    Current,
    /// The last refresh failed; the cached snapshot is shown.
    Stale,
}

/// Who stands behind a library. Habi does not guess this from a URL: the
/// user says so when connecting it, and can change it later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SourceRole {
    /// The team's own library: its content is reviewed where it is maintained.
    #[default]
    Team,
    /// Published by others (an open-source skills repository, say). Its
    /// content has not been reviewed by the team.
    Community,
}

impl SourceRole {
    fn as_str(self) -> &'static str {
        match self {
            SourceRole::Team => "team",
            SourceRole::Community => "community",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub role: SourceRole,
    /// URL, or a local path shown with `~`.
    pub location: String,
    pub subdir: Option<String>,
    pub tracked: TrackedRef,
    pub created_at: String,
    /// Commit (Git) or content digest (directory) of the cached snapshot.
    pub snapshot: Option<String>,
    pub snapshot_at: Option<String>,
    pub commit_summary: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<ErrorInfo>,
    /// Integrity warnings such as a moved tag or rewritten history.
    pub warning: Option<String>,
    pub freshness: Freshness,
    /// Part of the explicitly labeled sample workspace. Sample libraries are
    /// matched only against sample projects.
    pub sample: bool,
    /// Items (skills, workflows, instructions) in the cached snapshot; 0
    /// before the first fetch.
    pub skill_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewSource {
    pub name: String,
    /// Remote URL (https, ssh, git, scp-style) or an absolute local path.
    pub location: String,
    pub subdir: Option<String>,
    pub tracked: TrackedRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RefreshOutcome {
    pub source: Source,
    pub changed: bool,
    pub previous: Option<String>,
    pub current: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub updated: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotData {
    files: Vec<SnapshotFile>,
    skipped: Vec<Diagnostic>,
}

/// Where a library comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Remote(String),
    LocalGit(PathBuf),
    LocalDir(PathBuf),
}

/// Validates a user-supplied location. Rejects embedded credentials, Git
/// transport helpers (`ext::`) and anything that could be read as an option.
pub fn parse_location(input: &str) -> Result<Location> {
    let s = input.trim();
    if s.is_empty() {
        return Err(HabiError::invalid(
            "enter a repository URL or a local folder",
        ));
    }
    if s.starts_with('-')
        || s.chars().any(|c| c.is_control())
        || s.contains(char::is_whitespace) && !Path::new(s).is_absolute()
    {
        return Err(HabiError::invalid(
            "that location contains characters Habi does not accept",
        ));
    }
    if s.contains("::") {
        return Err(HabiError::invalid(
            "Git transport helpers (`<transport>::<address>`) are not supported",
        ));
    }
    if let Some((scheme, rest)) = s.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !["https", "http", "ssh", "git", "file"].contains(&scheme.as_str()) {
            return Err(HabiError::invalid(format!(
                "`{scheme}` URLs are not supported; use https or ssh"
            )));
        }
        let authority = rest.split('/').next().unwrap_or("");
        if let Some((userinfo, _)) = authority.rsplit_once('@') {
            // A user name is normal for ssh (`git@host`). Over http(s) and git://
            // any userinfo is treated as a credential: tokens are often passed as
            // the user name.
            let plain_user = !userinfo.is_empty()
                && userinfo
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
            if scheme != "ssh" || !plain_user {
                return Err(HabiError::invalid(
                    "the URL contains a user name, password or token. Remove it: Habi uses your existing Git credential helper or SSH agent.",
                ));
            }
        }
        if scheme == "file" {
            return local_location(&file_url_path(rest));
        }
        return Ok(Location::Remote(s.to_string()));
    }
    // scp-like `user@host:path` or `host:path` (not a Windows drive letter).
    if let Some((host, _)) = s.split_once(':')
        && host.len() > 1
        && !host.contains('/')
        && !host.contains('\\')
    {
        if let Some((user, _)) = host.rsplit_once('@')
            && !user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(HabiError::invalid(
                "that location's user name is not accepted",
            ));
        }
        return Ok(Location::Remote(s.to_string()));
    }
    let expanded = if let Some(rest) = s.strip_prefix("~/") {
        directories::BaseDirs::new()
            .map(|b| b.home_dir().join(rest))
            .ok_or_else(|| HabiError::invalid("no home directory"))?
    } else {
        PathBuf::from(s)
    };
    if !expanded.is_absolute() {
        return Err(HabiError::invalid("local folders must be absolute paths"));
    }
    local_location(&expanded)
}

/// The local path of a `file://` URL (`rest` is what follows `file://`):
/// `/srv/skills` from `file:///srv/skills`, and `C:/skills` (not
/// `/C:/skills`) from `file:///C:/skills`.
fn file_url_path(rest: &str) -> PathBuf {
    let path = rest.trim_start_matches('/');
    let drive = path.as_bytes();
    let has_drive = matches!(drive, [letter, b':', ..] if letter.is_ascii_alphabetic())
        && matches!(drive.get(2), None | Some(b'/' | b'\\'));
    if has_drive {
        PathBuf::from(path)
    } else {
        PathBuf::from(format!("/{path}"))
    }
}

/// True if a source location (as stored, or as shown with `~`) names a
/// folder on this machine rather than a remote URL. `C:\…` is absolute on
/// Windows, so a leading `/` alone is not the test.
pub fn is_local_location(location: &str) -> bool {
    location.starts_with('/') || location.starts_with('~') || Path::new(location).is_absolute()
}

fn local_location(path: &Path) -> Result<Location> {
    let dir = crate::paths::canonical_dir(path)?;
    let is_git =
        dir.join(".git").exists() || (dir.join("HEAD").is_file() && dir.join("objects").is_dir());
    Ok(if is_git {
        Location::LocalGit(dir)
    } else {
        Location::LocalDir(dir)
    })
}

/// Credential-free, machine-independent identity of a source, recorded in
/// project lock files so teammates can match installed items to sources.
pub fn portable_identity(source: &Source) -> String {
    match source.kind {
        SourceKind::Git if !is_local_location(&source.location) => {
            let mut url = source
                .location
                .trim_end_matches('/')
                .trim_end_matches(".git")
                .to_string();
            if let Some(pos) = url.find("://") {
                let (scheme, rest) = url.split_at(pos + 3);
                // Never carry user information into the (committable) lock file.
                let rest = match rest.split_once('/') {
                    Some((authority, path)) => {
                        let host = authority
                            .rsplit_once('@')
                            .map(|(_, h)| h)
                            .unwrap_or(authority);
                        format!("{host}/{path}")
                    }
                    None => rest
                        .rsplit_once('@')
                        .map(|(_, h)| h)
                        .unwrap_or(rest)
                        .to_string(),
                };
                url = format!("{}{}", scheme.to_ascii_lowercase(), rest);
            } else if let Some((user_host, path)) = url.split_once(':') {
                // scp-like: drop the user, keep host and path.
                let host = user_host
                    .rsplit_once('@')
                    .map(|(_, h)| h)
                    .unwrap_or(user_host);
                url = format!("{host}:{path}");
            }
            crate::redact::redact(&url)
        }
        _ => format!("local:{}", source.name),
    }
}

pub struct Sources {
    paths: AppPaths,
    store: Store,
    blobs: Blobs,
}

fn freshness(
    snapshot: &Option<String>,
    snapshot_at: &Option<String>,
    attempt: &Option<String>,
    error: &Option<ErrorInfo>,
) -> Freshness {
    match (snapshot, error) {
        (None, None) => Freshness::NeverFetched,
        (None, Some(_)) => Freshness::FetchFailed,
        (Some(_), None) => Freshness::Current,
        (Some(_), Some(_)) => {
            if attempt >= snapshot_at {
                Freshness::Stale
            } else {
                Freshness::Current
            }
        }
    }
}

fn row_to_source(row: &Row) -> rusqlite::Result<Source> {
    let kind: String = row.get("kind")?;
    let location: String = row.get("location")?;
    let snapshot: Option<String> = row.get("snapshot")?;
    let snapshot_at: Option<String> = row.get("snapshot_at")?;
    let attempt: Option<String> = row.get("last_attempt_at")?;
    let code: Option<String> = row.get("last_error_code")?;
    let message: Option<String> = row.get("last_error")?;
    let last_error = code.map(|code| ErrorInfo {
        code,
        message: message.unwrap_or_default(),
    });
    let kind = if kind == "git" {
        SourceKind::Git
    } else {
        SourceKind::Directory
    };
    let display_location = if is_local_location(&location) {
        display_path(Path::new(&location))
    } else {
        location
    };
    Ok(Source {
        id: row.get("id")?,
        name: row.get("name")?,
        kind,
        role: if row.get::<_, String>("role")? == "community" {
            SourceRole::Community
        } else {
            SourceRole::Team
        },
        location: display_location,
        subdir: row.get("subdir")?,
        tracked: TrackedRef::from_columns(&row.get::<_, String>("ref_kind")?, row.get("ref_name")?),
        created_at: row.get("created_at")?,
        freshness: freshness(&snapshot, &snapshot_at, &attempt, &last_error),
        snapshot,
        snapshot_at,
        commit_summary: row.get("commit_summary")?,
        last_attempt_at: attempt,
        last_error,
        warning: row.get("warning")?,
        sample: row.get::<_, i64>("sample")? != 0,
        skill_count: row
            .get::<_, Option<i64>>("item_count")?
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0),
    })
}

const SELECT_SOURCE: &str = "SELECT s.*, n.commit_summary, n.item_count FROM sources s LEFT JOIN snapshots n ON n.source_id = s.id AND n.snapshot = s.snapshot";

impl Sources {
    pub fn new(paths: &AppPaths, store: &Store) -> Self {
        Sources {
            paths: paths.clone(),
            store: store.clone(),
            blobs: Blobs::new(&paths.blobs()),
        }
    }

    pub fn blobs(&self) -> &Blobs {
        &self.blobs
    }

    fn git(&self) -> Result<Git> {
        Git::locate(&self.paths.empty_dir())
    }

    pub fn list(&self) -> Result<Vec<Source>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!("{SELECT_SOURCE} ORDER BY s.name COLLATE NOCASE"))?;
        let rows = stmt.query_map([], row_to_source)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get(&self, id: &str) -> Result<Source> {
        let conn = self.store.conn()?;
        conn.query_row(
            &format!("{SELECT_SOURCE} WHERE s.id = ?1"),
            [id],
            row_to_source,
        )
        .optional()?
        .ok_or_else(|| HabiError::NotFound(format!("source {id}")))
    }

    /// Absolute location as stored (local paths are not abbreviated).
    fn raw_location(&self, id: &str) -> Result<String> {
        let conn = self.store.conn()?;
        Ok(
            conn.query_row("SELECT location FROM sources WHERE id = ?1", [id], |r| {
                r.get(0)
            })?,
        )
    }

    /// Counts the items of current snapshots fetched before snapshots
    /// recorded their item count (a one-time cost after upgrading).
    pub(crate) fn count_uncounted(&self) -> Result<()> {
        let pending: Vec<(String, String)> = {
            let conn = self.store.conn()?;
            let mut stmt = conn.prepare(
                "SELECT n.source_id, n.snapshot FROM snapshots n JOIN sources s
                 ON s.id = n.source_id AND s.snapshot = n.snapshot WHERE n.item_count IS NULL",
            )?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (id, snapshot) in pending {
            let index = self.index_at(&id, &snapshot)?;
            set_item_count(&self.store.conn()?, &id, &snapshot, index.items.len())?;
        }
        Ok(())
    }

    /// Marks a library as part of the sample workspace.
    pub(crate) fn mark_sample(&self, id: &str) -> Result<()> {
        self.store
            .conn()?
            .execute("UPDATE sources SET sample = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Marks libraries stored under `dir` as sample libraries: the sample
    /// workspace's own, created before libraries carried the flag.
    pub(crate) fn mark_samples_under(&self, dir: &Path) -> Result<()> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT id, location FROM sources WHERE sample = 0")?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, location) in rows {
            if is_local_location(&location) && Path::new(&location).starts_with(dir) {
                self.mark_sample(&id)?;
            }
        }
        Ok(())
    }

    /// Records whether a library is the team's own or a community one.
    pub fn set_role(&self, id: &str, role: SourceRole) -> Result<Source> {
        let conn = self.store.conn()?;
        let changed = conn.execute(
            "UPDATE sources SET role = ?1 WHERE id = ?2",
            params![role.as_str(), id],
        )?;
        if changed == 0 {
            return Err(HabiError::NotFound(format!("no source with id {id}")));
        }
        self.get(id)
    }

    /// Registers a source. Does not fetch: fetching is an explicit action.
    pub fn add(&self, new: &NewSource) -> Result<Source> {
        let name = new.name.trim();
        if name.is_empty() || name.len() > 80 || name.chars().any(|c| c.is_control()) {
            return Err(HabiError::invalid(
                "give the source a short name (1–80 characters)",
            ));
        }
        new.tracked.validate()?;
        let subdir = match new
            .subdir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(s) => Some(RelPath::new(s)?.to_string()),
            None => None,
        };
        let location = parse_location(&new.location)?;
        let (kind, stored) = match &location {
            Location::Remote(url) => ("git", url.clone()),
            Location::LocalGit(p) => ("git", p.to_string_lossy().into_owned()),
            Location::LocalDir(p) => {
                if !matches!(new.tracked, TrackedRef::Default) {
                    return Err(HabiError::invalid(
                        "a plain folder has no branches or tags; track the default content instead",
                    ));
                }
                ("directory", p.to_string_lossy().into_owned())
            }
        };
        let conn = self.store.conn()?;
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM sources WHERE name = ?1 COLLATE NOCASE",
                [name],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Err(HabiError::Conflict(format!(
                "a source named `{name}` already exists"
            )));
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let (ref_kind, ref_name) = new.tracked.to_columns();
        conn.execute(
            "INSERT INTO sources (id, name, kind, location, subdir, ref_kind, ref_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                name,
                kind,
                stored,
                subdir,
                ref_kind,
                ref_name,
                crate::time::now()
            ],
        )?;
        tracing::info!(source = %id, kind, "registered source");
        self.get(&id)
    }

    /// Removes a source and its cache. Installed content in projects is untouched.
    pub fn remove(&self, id: &str) -> Result<()> {
        let _lock =
            ResourceLock::acquire(&self.paths, &format!("source-{id}"), Duration::from_secs(5))?;
        self.get(id)?;
        self.store
            .conn()?
            .execute("DELETE FROM sources WHERE id = ?1", [id])?;
        let dir = self.paths.sources().join(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| HabiError::io("removing the source cache", e))?;
        }
        Ok(())
    }

    /// Fetches the tracked ref and records a new snapshot if content changed.
    pub fn refresh(&self, id: &str, cancel: &CancelToken) -> Result<RefreshOutcome> {
        let _lock =
            ResourceLock::acquire(&self.paths, &format!("source-{id}"), Duration::from_secs(2))?;
        let before = self.get(id)?;
        let previous_index = before.snapshot.as_ref().and_then(|_| self.index(id).ok());
        let attempt_at = crate::time::now();
        let result = match before.kind {
            SourceKind::Git => self.fetch_git(&before, cancel),
            SourceKind::Directory => self.read_directory(&before, cancel),
        };
        let conn = self.store.conn()?;
        match result {
            Err(e) => {
                let info = e.to_info();
                conn.execute(
                    "UPDATE sources SET last_attempt_at = ?2, last_error_code = ?3, last_error = ?4 WHERE id = ?1",
                    params![id, attempt_at, info.code, info.message],
                )?;
                tracing::warn!(source = %id, code = %info.code, "refresh failed; keeping cached snapshot");
                Err(e)
            }
            Ok((snapshot, data, summary, resolved, warning)) => {
                conn.execute(
                    "INSERT INTO snapshots (source_id, snapshot, resolved_ref, commit_summary, created_at, files_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(source_id, snapshot) DO NOTHING",
                    params![
                        id,
                        snapshot,
                        resolved,
                        summary,
                        crate::time::now(),
                        serde_json::to_string(&data).map_err(|e| HabiError::Internal(e.to_string()))?
                    ],
                )?;
                // A warning about a moved ref persists until the next refresh.
                conn.execute(
                    "UPDATE sources SET snapshot = ?2, snapshot_at = ?3, last_attempt_at = ?3,
                     last_error_code = NULL, last_error = NULL, warning = ?4 WHERE id = ?1",
                    params![id, snapshot, attempt_at, warning],
                )?;
                let index = self.index(id)?;
                set_item_count(&conn, id, &snapshot, index.items.len())?;
                let source = self.get(id)?;
                let (added, removed, updated) = diff_indexes(previous_index.as_ref(), &index);
                Ok(RefreshOutcome {
                    changed: before.snapshot.as_deref() != Some(snapshot.as_str()),
                    previous: before.snapshot.clone(),
                    current: snapshot,
                    source,
                    added,
                    removed,
                    updated,
                })
            }
        }
    }

    #[allow(clippy::type_complexity)]
    fn fetch_git(
        &self,
        source: &Source,
        cancel: &CancelToken,
    ) -> Result<(
        String,
        SnapshotData,
        Option<String>,
        Option<String>,
        Option<String>,
    )> {
        let git = self.git()?;
        let cache = self.paths.sources().join(&source.id).join("repo.git");
        git.init_bare(&cache, cancel)?;
        let url = self.raw_location(&source.id)?;
        let tracking = format!("{}/upstream", crate::brand::REF_NAMESPACE);
        git.fetch(
            &cache,
            &url,
            &source.tracked.git_source(),
            &tracking,
            cancel,
        )?;
        let commit = git.rev_parse_commit(&cache, &tracking, cancel)?;

        let mut warning = None;
        if let Some(previous) = &source.snapshot
            && previous != &commit
        {
            match &source.tracked {
                TrackedRef::Tag { name } => {
                    warning = Some(format!(
                        "Tag {name} moved from {} to {}. A tag name is not proof that content is unchanged; review the update before adopting it.",
                        short(previous),
                        short(&commit)
                    ));
                }
                _ => match git.is_ancestor(&cache, previous, &commit, cancel) {
                    Ok(true) => {}
                    Ok(false) => {
                        warning = Some(format!(
                            "History was rewritten: the previously fetched commit {} is not an ancestor of {}.",
                            short(previous),
                            short(&commit)
                        ));
                    }
                    Err(HabiError::Cancelled) => return Err(HabiError::Cancelled),
                    // The new content is still valid; say what could not be checked.
                    Err(e) => {
                        warning = Some(format!(
                            "Habi could not check whether history was rewritten since commit {} ({e}). Review the update before adopting it.",
                            short(previous)
                        ));
                    }
                },
            }
        }

        let subdir = source.subdir.as_deref();
        let entries = git.ls_tree(&cache, &commit, subdir, cancel)?;
        let prefix = subdir.map(|s| format!("{s}/")).unwrap_or_default();
        if subdir.is_some() && entries.is_empty() {
            return Err(HabiError::NotFound(format!(
                "folder `{}` at commit {}",
                subdir.unwrap_or_default(),
                short(&commit)
            )));
        }
        let mut skipped = Vec::new();
        let mut wanted: Vec<(String, String, u64, bool)> = Vec::new();
        let mut total = 0u64;
        for entry in entries {
            let rel = entry
                .path
                .strip_prefix(&prefix)
                .unwrap_or(&entry.path)
                .to_string();
            match (entry.kind.as_str(), entry.mode.as_str()) {
                ("blob", "120000") => {
                    skipped.push(Diagnostic::warning("symbolic link skipped", Some(&rel)));
                    continue;
                }
                ("commit", _) => {
                    skipped.push(Diagnostic::warning(
                        "Git submodule skipped (submodules are not supported)",
                        Some(&rel),
                    ));
                    continue;
                }
                ("blob", _) => {}
                _ => continue,
            }
            if RelPath::new(&rel).is_err() {
                skipped.push(Diagnostic::warning(
                    "file name is not a safe relative path; skipped",
                    Some(&rel),
                ));
                continue;
            }
            let size = entry.size.unwrap_or(0);
            if size > MAX_FILE_BYTES {
                skipped.push(Diagnostic::warning(
                    format!("file is {size} bytes, above the {MAX_FILE_BYTES}-byte limit; skipped"),
                    Some(&rel),
                ));
                continue;
            }
            if wanted.len() >= MAX_FILES || total + size > MAX_TOTAL_BYTES {
                // A truncated snapshot could cut skills in half; refuse it instead.
                return Err(too_large());
            }
            total += size;
            wanted.push((rel, entry.oid, size, entry.mode == "100755"));
        }
        let oids: Vec<String> = wanted.iter().map(|(_, o, _, _)| o.clone()).collect();
        let contents = git.read_blobs(&cache, &oids, total, cancel)?;
        let mut files = Vec::with_capacity(wanted.len());
        for ((rel, _, size, executable), bytes) in wanted.into_iter().zip(contents) {
            let digest = self.blobs.put(&bytes)?;
            files.push(SnapshotFile {
                path: rel,
                digest,
                size,
                executable,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        git.update_ref(
            &cache,
            &format!("{}/snapshots/{commit}", crate::brand::REF_NAMESPACE),
            &commit,
            cancel,
        )?;
        let summary = git.describe_commit(&cache, &commit, cancel).ok();
        Ok((
            commit,
            SnapshotData { files, skipped },
            summary,
            Some(source.tracked.label()),
            warning,
        ))
    }

    #[allow(clippy::type_complexity)]
    fn read_directory(
        &self,
        source: &Source,
        cancel: &CancelToken,
    ) -> Result<(
        String,
        SnapshotData,
        Option<String>,
        Option<String>,
        Option<String>,
    )> {
        let root = PathBuf::from(self.raw_location(&source.id)?);
        let root = match &source.subdir {
            Some(s) => RelPath::new(s)?.to_path(&root),
            None => root,
        };
        if !root.is_dir() {
            return Err(HabiError::NotFound(format!(
                "folder {}",
                display_path(&root)
            )));
        }
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        let mut total = 0u64;
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            cancel.check()?;
            let mut entries: Vec<_> = std::fs::read_dir(&dir)
                .map_err(|e| HabiError::io(format!("reading {}", display_path(&dir)), e))?
                .filter_map(|e| e.ok())
                .collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let path = entry.path();
                let rel = path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                let Ok(meta) = std::fs::symlink_metadata(&path) else {
                    skipped.push(Diagnostic::warning("could not be read", Some(&rel)));
                    continue;
                };
                if meta.file_type().is_symlink() {
                    skipped.push(Diagnostic::warning("symbolic link skipped", Some(&rel)));
                } else if meta.is_dir() {
                    if entry.file_name() != ".git" {
                        stack.push(path);
                    }
                } else if meta.is_file() {
                    if RelPath::new(&rel).is_err() {
                        continue;
                    }
                    if files.len() >= MAX_FILES || total + meta.len() > MAX_TOTAL_BYTES {
                        return Err(too_large());
                    }
                    match read_bounded(&path, MAX_FILE_BYTES)? {
                        Bounded::Content(bytes) => {
                            total += bytes.len() as u64;
                            let digest = self.blobs.put(&bytes)?;
                            files.push(SnapshotFile {
                                path: rel,
                                digest,
                                size: bytes.len() as u64,
                                executable: crate::fsutil::is_executable(&path),
                            });
                        }
                        Bounded::TooLarge(size) => skipped.push(Diagnostic::warning(
                            format!("file is {size} bytes, above the limit; skipped"),
                            Some(&rel),
                        )),
                    }
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let keyed: Vec<(String, String)> = files
            .iter()
            .map(|f| {
                (
                    f.path.clone(),
                    if f.executable {
                        format!("{}+x", f.digest)
                    } else {
                        f.digest.clone()
                    },
                )
            })
            .collect();
        let digest = tree_digest(keyed.iter().map(|(p, d)| (p.as_str(), d.as_str())));
        Ok((digest, SnapshotData { files, skipped }, None, None, None))
    }

    fn snapshot_data(&self, id: &str, snapshot: &str) -> Result<SnapshotData> {
        let conn = self.store.conn()?;
        let json: String = conn
            .query_row(
                "SELECT files_json FROM snapshots WHERE source_id = ?1 AND snapshot = ?2",
                [id, snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                HabiError::NotFound(format!("snapshot {} of source {id}", short(snapshot)))
            })?;
        serde_json::from_str(&json).map_err(|e| {
            HabiError::Internal(format!(
                "cached snapshot metadata is corrupted ({e}); refresh the source"
            ))
        })
    }

    /// Files of a snapshot (library-relative paths).
    pub fn snapshot_files(&self, id: &str, snapshot: &str) -> Result<Vec<SnapshotFile>> {
        Ok(self.snapshot_data(id, snapshot)?.files)
    }

    /// Index of the current snapshot.
    pub fn index(&self, id: &str) -> Result<LibraryIndex> {
        let source = self.get(id)?;
        let snapshot = source.snapshot.ok_or_else(|| {
            HabiError::NotFound(format!(
                "content for source `{}` (fetch it first)",
                source.name
            ))
        })?;
        self.index_at(id, &snapshot)
    }

    pub fn index_at(&self, id: &str, snapshot: &str) -> Result<LibraryIndex> {
        let data = self.snapshot_data(id, snapshot)?;
        let by_path: HashMap<&str, &str> = data
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.digest.as_str()))
            .collect();
        let blobs = &self.blobs;
        let mut index = library::build_index(id, snapshot, &data.files, &|path| {
            let digest = by_path
                .get(path)
                .ok_or_else(|| format!("{path} is not in the snapshot"))?;
            blobs.get(digest).map_err(|e| e.to_string())
        });
        // Items with skipped files are incomplete: installing them would
        // silently drop content, so they are marked and refused at install.
        for item in &mut index.items {
            let prefix = if item.path.is_empty() {
                String::new()
            } else {
                format!("{}/", item.path)
            };
            let missing: Vec<&Diagnostic> = data
                .skipped
                .iter()
                .filter(|d| {
                    d.path
                        .as_deref()
                        .is_some_and(|p| prefix.is_empty() || p.starts_with(&prefix))
                })
                .collect();
            if !missing.is_empty() {
                item.complete = false;
                for d in missing {
                    item.diagnostics.push(Diagnostic::error(
                        format!(
                            "{} (the item is incomplete and cannot be installed)",
                            d.message
                        ),
                        d.path.as_deref(),
                    ));
                }
            }
        }
        index.diagnostics.extend(data.skipped);
        Ok(index)
    }

    /// Reads a file of an item at a snapshot.
    pub fn read_file(&self, id: &str, snapshot: &str, library_path: &str) -> Result<Vec<u8>> {
        let data = self.snapshot_data(id, snapshot)?;
        let file = data
            .files
            .iter()
            .find(|f| f.path == library_path)
            .ok_or_else(|| HabiError::NotFound(format!("{library_path} in the library")))?;
        self.blobs.get(&file.digest)
    }

    /// Path of the bare cache for a Git source (used by contributions).
    pub fn cache_dir(&self, id: &str) -> PathBuf {
        self.paths.sources().join(id).join("repo.git")
    }

    pub fn fetch_url(&self, id: &str) -> Result<String> {
        self.raw_location(id)
    }
}

fn set_item_count(
    conn: &rusqlite::Connection,
    id: &str,
    snapshot: &str,
    count: usize,
) -> Result<()> {
    conn.execute(
        "UPDATE snapshots SET item_count = ?3 WHERE source_id = ?1 AND snapshot = ?2",
        params![id, snapshot, i64::try_from(count).unwrap_or(i64::MAX)],
    )?;
    Ok(())
}

fn too_large() -> HabiError {
    HabiError::Unsupported(format!(
        "the library is larger than Habi's limits ({MAX_FILES} files, {} MiB). Narrow the source to a subfolder; the previous snapshot is kept.",
        MAX_TOTAL_BYTES / 1024 / 1024
    ))
}

fn diff_indexes(
    before: Option<&LibraryIndex>,
    after: &LibraryIndex,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let old: BTreeMap<&str, &str> = before
        .map(|b| {
            b.items
                .iter()
                .map(|i| (i.id.as_str(), i.content_digest.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let new: BTreeMap<&str, &str> = after
        .items
        .iter()
        .map(|i| (i.id.as_str(), i.content_digest.as_str()))
        .collect();
    let added = new
        .keys()
        .filter(|k| !old.contains_key(*k))
        .map(|k| k.to_string())
        .collect();
    let removed = old
        .keys()
        .filter(|k| !new.contains_key(*k))
        .map(|k| k.to_string())
        .collect();
    let updated = new
        .iter()
        .filter(|(k, v)| old.get(*k).is_some_and(|o| o != *v))
        .map(|(k, _)| k.to_string())
        .collect();
    (added, removed, updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn location_validation() {
        assert!(matches!(
            parse_location("https://example.com/team/skills.git"),
            Ok(Location::Remote(_))
        ));
        assert!(matches!(
            parse_location("git@example.com:team/skills.git"),
            Ok(Location::Remote(_))
        ));
        assert!(matches!(
            parse_location("ssh://git@example.com/team/skills.git"),
            Ok(Location::Remote(_))
        ));
        assert!(parse_location("https://user:token@example.com/x.git").is_err());
        assert!(
            parse_location("https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git").is_err()
        );
        assert!(parse_location("https://user%3Asecret@example.com/x.git").is_err());
        assert!(parse_location("ssh://git@example.com/x.git").is_ok());
        assert!(parse_location("ext::sh -c touch% /tmp/pwned").is_err());
        assert!(parse_location("--upload-pack=touch /tmp/x").is_err());
        assert!(parse_location("ftp://example.com/x").is_err());
        assert!(parse_location("relative/path").is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            parse_location(&dir.path().to_string_lossy()),
            Ok(Location::LocalDir(_))
        ));
    }

    #[test]
    fn file_urls_keep_drive_letters() {
        assert_eq!(file_url_path("/srv/skills"), PathBuf::from("/srv/skills"));
        assert_eq!(file_url_path("//srv/skills"), PathBuf::from("/srv/skills"));
        assert_eq!(
            file_url_path("/C:/team/skills"),
            PathBuf::from("C:/team/skills")
        );
        assert_eq!(file_url_path("/d:\\skills"), PathBuf::from("d:\\skills"));
        assert_eq!(file_url_path("/C:"), PathBuf::from("C:"));
        // Not a drive: a folder whose name happens to contain a colon.
        assert_eq!(file_url_path("/ab:/x"), PathBuf::from("/ab:/x"));
    }

    fn git_source(location: &str) -> Source {
        Source {
            id: "s".into(),
            name: "Team".into(),
            kind: SourceKind::Git,
            role: SourceRole::Team,
            location: location.into(),
            subdir: None,
            tracked: TrackedRef::Default,
            created_at: String::new(),
            snapshot: None,
            snapshot_at: None,
            commit_summary: None,
            last_attempt_at: None,
            last_error: None,
            warning: None,
            freshness: Freshness::NeverFetched,
            sample: false,
            skill_count: 0,
        }
    }

    #[test]
    fn local_locations_are_told_from_urls() {
        assert!(is_local_location("/srv/skills"));
        assert!(is_local_location("~/code/skills"));
        assert!(!is_local_location("https://example.com/team/skills.git"));
        assert!(!is_local_location("git@example.com:team/skills.git"));
        assert_eq!(portable_identity(&git_source("/srv/skills")), "local:Team");
        assert_eq!(portable_identity(&git_source("~/skills")), "local:Team");
        assert_eq!(
            portable_identity(&git_source("git@example.com:team/skills.git")),
            "example.com:team/skills"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_are_local() {
        assert!(is_local_location(r"C:\Users\ana\skills"));
        assert!(is_local_location(r"\\server\share\skills"));
        // Once read as an scp-style `C:` host, leaking the path into lock files.
        assert_eq!(
            portable_identity(&git_source(r"C:\Users\ana\skills")),
            "local:Team"
        );
        let dir = tempfile::tempdir().unwrap();
        let url = format!(
            "file:///{}",
            dir.path().to_string_lossy().replace('\\', "/")
        );
        assert!(matches!(parse_location(&url), Ok(Location::LocalDir(_))));
    }

    #[test]
    fn ref_validation() {
        assert!(
            TrackedRef::Branch {
                name: "main".into()
            }
            .validate()
            .is_ok()
        );
        assert!(
            TrackedRef::Tag {
                name: "v1.2.0".into()
            }
            .validate()
            .is_ok()
        );
        assert!(
            TrackedRef::Branch {
                name: "--upload-pack=x".into()
            }
            .validate()
            .is_err()
        );
        assert!(
            TrackedRef::Branch {
                name: "a..b".into()
            }
            .validate()
            .is_err()
        );
    }
}
