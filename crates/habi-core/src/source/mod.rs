//! Team library sources: registration, refresh, cached offline browsing.
//!
//! A source is a Git repository (remote or local) or a plain local directory,
//! optionally narrowed to a subdirectory. Refreshing fetches the tracked ref,
//! resolves it to an immutable commit, copies the library files into the
//! content-addressed cache and records a snapshot. A failed refresh keeps the
//! last good snapshot and marks the source stale. Refreshing never changes a
//! project and never executes library content.

pub mod git;
pub mod release;

use crate::cancel::CancelToken;
use crate::error::{ErrorInfo, HabiError, Result};
use crate::fsutil::{Bounded, read_bounded, short, tree_digest};
use crate::library::model::{Diagnostic, LibraryIndex, SnapshotFile};
use crate::library::{self};
use crate::paths::{RelPath, display_path};
use crate::store::cas::Blobs;
use crate::store::{AppPaths, ResourceLock, Store};
use git::{FetchDepth, Git, RemoteHead};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use ts_rs::TS;

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = git::SKIP_BLOBS_OVER;
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
    /// The newest release tag (`v1.4.0`), or the default branch for a
    /// repository that has published none. Which tag that is can only be
    /// asked of the remote: see `Sources::resolve`.
    LatestRelease,
}

impl TrackedRef {
    /// The ref to fetch. For `LatestRelease` this is the fallback; the real
    /// answer comes from `Sources::resolve`.
    fn git_source(&self) -> String {
        match self {
            TrackedRef::Default | TrackedRef::LatestRelease => "HEAD".into(),
            TrackedRef::Branch { name } => format!("refs/heads/{name}"),
            TrackedRef::Tag { name } => format!("refs/tags/{name}"),
        }
    }

    pub fn label(&self) -> String {
        match self {
            TrackedRef::Default => "default branch".into(),
            TrackedRef::LatestRelease => "latest release".into(),
            TrackedRef::Branch { name } => format!("branch {name}"),
            TrackedRef::Tag { name } => format!("tag {name}"),
        }
    }

    fn validate(&self) -> Result<()> {
        let name = match self {
            TrackedRef::Default | TrackedRef::LatestRelease => return Ok(()),
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
            TrackedRef::LatestRelease => ("latest-release", None),
            TrackedRef::Branch { name } => ("branch", Some(name.clone())),
            TrackedRef::Tag { name } => ("tag", Some(name.clone())),
        }
    }

    fn from_columns(kind: &str, name: Option<String>) -> TrackedRef {
        match (kind, name) {
            ("branch", Some(name)) => TrackedRef::Branch { name },
            ("tag", Some(name)) => TrackedRef::Tag { name },
            ("latest-release", _) => TrackedRef::LatestRelease,
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
    /// Fetched so it can be inspected, but not connected: previews are kept
    /// out of every list, recommendation and installation until connected.
    pub preview: bool,
    /// The catalog entry this source was added from, if any.
    pub catalog_id: Option<String>,
    /// Only files matching one of these globs are read (all files when empty).
    pub include: Vec<String>,
    /// Files matching one of these globs are never read.
    pub exclude: Vec<String>,
    /// The branch the remote's `HEAD` named at the last check.
    pub default_branch: Option<String>,
}

/// How a source relates to the library catalog and to its repository.
#[derive(Debug, Clone, Default)]
pub struct CatalogBinding {
    pub catalog_id: Option<String>,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub preview: bool,
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

/// One version of a library: a release tag, or a branch at a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceVersion {
    /// The release tag (`v6.4.2`) or the branch name (`main`).
    pub label: String,
    /// Whether `label` is a release tag.
    pub release: bool,
    pub commit: String,
}

/// What a check for updates found. Nothing was downloaded, and nothing
/// changed: applying it is the user's decision (`Sources::refresh`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceUpdate {
    pub source_id: String,
    /// What is read now.
    pub current: Option<SourceVersion>,
    /// What the remote has now.
    pub latest: SourceVersion,
    /// The remote has something other than what is read now.
    pub available: bool,
    pub checked_at: String,
}

/// A skill named in an update report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReportedSkill {
    pub id: String,
    pub title: String,
}

/// What an update changed in a library, kept until it is dismissed so the
/// changes can be read, and marked in the library, after the fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateReport {
    pub source_id: String,
    pub from: Option<SourceVersion>,
    pub to: SourceVersion,
    pub at: String,
    pub added: Vec<ReportedSkill>,
    pub updated: Vec<ReportedSkill>,
    pub removed: Vec<ReportedSkill>,
}

/// The ref a source is read at right now, and how it is named.
#[derive(Debug, Clone)]
struct Resolved {
    git_source: String,
    /// What the snapshot records (`tag v6.4.2`, `default branch`).
    label: String,
}

/// The remote's answer for a source's ref.
struct Probe {
    head: RemoteHead,
    resolved: Resolved,
}

/// The most skills an update report names in each list.
const REPORT_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCheck {
    latest: SourceVersion,
    checked_at: String,
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
            remote_identity(&source.location)
        }
        _ => format!("local:{}", source.name),
    }
}

/// `portable_identity` of a remote repository address: credential-free,
/// without a trailing `.git`, with a lower-case scheme.
pub fn remote_identity(location: &str) -> String {
    let mut url = location
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

pub struct Sources {
    paths: AppPaths,
    store: Store,
    blobs: Blobs,
    /// Indexes built before (see `IndexMemo`).
    indexes: Mutex<IndexMemo>,
}

/// Library indexes this process built, by source and snapshot.
///
/// Building an index reads every skill's files back from the blob store,
/// verifying each digest, and parses and validates their metadata; every
/// project overview and install plan needs the index of every library, and
/// the overview runs again on each change the project watcher reports. A
/// recorded snapshot never changes (its row is inserted once and its files
/// are addressed by digest), so its index is built once and then copied.
/// Each use still looks up the snapshot's row, so a snapshot maintenance
/// removed is not found here either, and one recorded again is rebuilt.
#[derive(Default)]
struct IndexMemo {
    entries: HashMap<(String, String), MemoIndex>,
    /// Counts uses, to find the least recently used entry.
    clock: u64,
}

struct MemoIndex {
    /// The snapshot row it was built from: its `rowid` and `created_at`.
    row: (i64, String),
    index: LibraryIndex,
    used: u64,
}

/// Indexes kept at most: a few libraries, each at its current snapshot and at
/// the snapshots projects installed from. The least recently used goes first.
const MAX_MEMO_INDEXES: usize = 32;

impl IndexMemo {
    fn get(&mut self, key: &(String, String), row: &(i64, String)) -> Option<LibraryIndex> {
        self.clock += 1;
        let clock = self.clock;
        let entry = self.entries.get_mut(key).filter(|e| &e.row == row)?;
        entry.used = clock;
        Some(entry.index.clone())
    }

    fn put(&mut self, key: (String, String), row: (i64, String), index: &LibraryIndex) {
        self.clock += 1;
        if !self.entries.contains_key(&key) && self.entries.len() >= MAX_MEMO_INDEXES {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            MemoIndex {
                row,
                index: index.clone(),
                used: self.clock,
            },
        );
    }
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
        preview: row.get::<_, i64>("preview")? != 0,
        catalog_id: row.get("catalog_id")?,
        include: json_list(row.get::<_, String>("include_json")?),
        exclude: json_list(row.get::<_, String>("exclude_json")?),
        default_branch: row.get("default_branch")?,
    })
}

fn json_list(json: String) -> Vec<String> {
    serde_json::from_str(&json).unwrap_or_default()
}

const SELECT_SOURCE: &str = "SELECT s.*, n.commit_summary, n.item_count FROM sources s LEFT JOIN snapshots n ON n.source_id = s.id AND n.snapshot = s.snapshot";

impl Sources {
    pub fn new(paths: &AppPaths, store: &Store) -> Self {
        Sources {
            paths: paths.clone(),
            store: store.clone(),
            blobs: Blobs::new(&paths.blobs()),
            indexes: Mutex::default(),
        }
    }

    pub fn blobs(&self) -> &Blobs {
        &self.blobs
    }

    fn git(&self) -> Result<Git> {
        Git::locate(&self.paths.empty_dir())
    }

    /// Connected sources. Previews are not listed: nothing that is only being
    /// looked at may be offered, recommended or installed.
    pub fn list(&self) -> Result<Vec<Source>> {
        self.list_where("s.preview = 0")
    }

    /// Sources fetched for inspection only.
    pub fn list_previews(&self) -> Result<Vec<Source>> {
        self.list_where("s.preview = 1")
    }

    fn list_where(&self, condition: &str) -> Result<Vec<Source>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(&format!(
            "{SELECT_SOURCE} WHERE {condition} ORDER BY s.name COLLATE NOCASE"
        ))?;
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

    /// `get` for a source that is about to be installed from, copied from or
    /// contributed to: a preview must be connected first, which is a decision
    /// the person makes.
    pub fn connected(&self, id: &str) -> Result<Source> {
        let source = self.get(id)?;
        if source.preview {
            return Err(HabiError::Conflict(
                "this library is only being previewed. Connect it first; nothing is installed or copied until you do.".into(),
            ));
        }
        Ok(source)
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
            // A cache that cannot be read stays uncounted (shown as 0); the
            // library itself reports the problem when it is opened.
            match self.index_at(&id, &snapshot) {
                Ok(index) => {
                    set_item_count(&self.store.conn()?, &id, &snapshot, index.items.len())?
                }
                Err(e) => tracing::warn!(source = %id, error = %e, "could not count library items"),
            }
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
    /// Changes which version of its repository a library follows. What it
    /// has read stays until it is next updated.
    pub fn set_tracked(&self, id: &str, tracked: &TrackedRef) -> Result<Source> {
        tracked.validate()?;
        let (kind, name) = tracked.to_columns();
        self.store.conn()?.execute(
            "UPDATE sources SET ref_kind = ?2, ref_name = ?3 WHERE id = ?1",
            params![id, kind, name],
        )?;
        self.get(id)
    }

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

    /// Turns a preview into a connected library, keeping what was fetched.
    /// The visible name is chosen here; a name already in use gets a suffix
    /// rather than failing a connection the user already confirmed.
    pub fn connect_preview(&self, id: &str, name: &str, role: SourceRole) -> Result<Source> {
        let _lock =
            ResourceLock::acquire(&self.paths, &format!("source-{id}"), Duration::from_secs(5))?;
        let current = self.get(id)?;
        if !current.preview {
            return Err(HabiError::Conflict(format!(
                "`{}` is already connected",
                current.name
            )));
        }
        let conn = self.store.conn()?;
        let taken = |candidate: &str| -> Result<bool> {
            Ok(conn
                .query_row(
                    "SELECT 1 FROM sources WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
                    params![candidate, id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        };
        let mut chosen = name.trim().to_string();
        let mut attempt = 1;
        while taken(&chosen)? {
            attempt += 1;
            chosen = format!("{} ({attempt})", name.trim());
        }
        conn.execute(
            "UPDATE sources SET preview = 0, name = ?2, role = ?3 WHERE id = ?1",
            params![id, chosen, role.as_str()],
        )?;
        drop(conn);
        self.get(id)
    }

    /// Registers a source. Does not fetch: fetching is an explicit action.
    pub fn add(&self, new: &NewSource) -> Result<Source> {
        self.add_with(new, &CatalogBinding::default())
    }

    /// `add` for a source that comes from the catalog: it may read only part
    /// of its repository, and may be a preview.
    pub fn add_with(&self, new: &NewSource, binding: &CatalogBinding) -> Result<Source> {
        scope_globs(&binding.include)?;
        scope_globs(&binding.exclude)?;
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
        let id: String = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(12)
            .collect();
        let (ref_kind, ref_name) = new.tracked.to_columns();
        conn.execute(
            "INSERT INTO sources (id, name, kind, location, subdir, ref_kind, ref_name, created_at,
                                  preview, catalog_id, include_json, exclude_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                name,
                kind,
                stored,
                subdir,
                ref_kind,
                ref_name,
                crate::time::now(),
                i64::from(binding.preview),
                binding.catalog_id,
                json_string(&binding.include)?,
                json_string(&binding.exclude)?
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
        let attempt_at = crate::time::now();
        // Ask the remote what it has before downloading anything: a library
        // that has not changed costs one small request, and no reading.
        let probe = match before.kind {
            SourceKind::Git => self.probe_remote(&before, cancel)?,
            SourceKind::Directory => None,
        };
        let remote = probe.as_ref().map(|p| &p.head);
        if let (Some(probe), Some(snapshot)) = (&probe, &before.snapshot)
            && &probe.head.commit == snapshot
            && self.snapshot_data(id, snapshot).is_ok()
        {
            let conn = self.store.conn()?;
            conn.execute(
                "UPDATE sources SET snapshot_at = ?2, last_attempt_at = ?2, last_error_code = NULL,
                 last_error = NULL, warning = NULL, default_branch = COALESCE(?3, default_branch)
                 WHERE id = ?1",
                params![id, attempt_at, probe.head.branch],
            )?;
            // The same commit may now be known by another name: a branch tip that was tagged.
            conn.execute(
                "UPDATE snapshots SET resolved_ref = ?3 WHERE source_id = ?1 AND snapshot = ?2",
                params![id, snapshot, probe.resolved.label],
            )?;
            return Ok(RefreshOutcome {
                changed: false,
                previous: Some(snapshot.clone()),
                current: snapshot.clone(),
                source: self.get(id)?,
                added: Vec::new(),
                removed: Vec::new(),
                updated: Vec::new(),
            });
        }
        let previous_index = before.snapshot.as_ref().and_then(|_| self.index(id).ok());
        let result = match before.kind {
            SourceKind::Git => self.fetch_git(&before, probe.as_ref().map(|p| &p.resolved), cancel),
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
                     last_error_code = NULL, last_error = NULL, warning = ?4,
                     default_branch = COALESCE(?5, default_branch) WHERE id = ?1",
                    params![
                        id,
                        snapshot,
                        attempt_at,
                        warning,
                        remote.and_then(|r| r.branch.clone())
                    ],
                )?;
                let index = self.index(id)?;
                set_item_count(&conn, id, &snapshot, index.items.len())?;
                let source = self.get(id)?;
                let (added, removed, updated) = diff_indexes(previous_index.as_ref(), &index);
                if before.kind == SourceKind::Git
                    && before.snapshot.as_deref() != Some(snapshot.as_str())
                {
                    self.keep_report(
                        &before,
                        &source,
                        resolved.as_deref(),
                        previous_index.as_ref(),
                        &index,
                        (&added, &removed, &updated),
                    );
                }
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

    /// What the remote's tracked ref points at, or `None` if it cannot be
    /// asked (the fetch that follows reports the real problem).
    fn probe_remote(&self, source: &Source, cancel: &CancelToken) -> Result<Option<Probe>> {
        let git = self.git()?;
        let url = self.raw_location(&source.id)?;
        let asked = self
            .resolve(source, &git, &url, cancel)
            .and_then(|resolved| {
                git.ls_remote(&url, &resolved.git_source, cancel)
                    .map(|head| Probe { head, resolved })
            });
        match asked {
            Ok(probe) => Ok(Some(probe)),
            Err(HabiError::Cancelled) => Err(HabiError::Cancelled),
            Err(e) => {
                tracing::debug!(source = %source.id, error = %e, "could not ask the remote; fetching instead");
                Ok(None)
            }
        }
    }

    /// The ref to read a source at. A source that follows releases reads the
    /// newest release tag, or the default branch while the repository has none.
    fn resolve(
        &self,
        source: &Source,
        git: &Git,
        url: &str,
        cancel: &CancelToken,
    ) -> Result<Resolved> {
        if source.tracked == TrackedRef::LatestRelease {
            let tags = git.list_tags(url, cancel)?;
            if let Some(tag) = release::latest_release(tags.iter().map(String::as_str)) {
                return Ok(Resolved {
                    git_source: format!("refs/tags/{tag}"),
                    label: format!("tag {tag}"),
                });
            }
            return Ok(Resolved {
                git_source: "HEAD".into(),
                label: TrackedRef::Default.label(),
            });
        }
        Ok(Resolved {
            git_source: source.tracked.git_source(),
            label: source.tracked.label(),
        })
    }

    #[allow(clippy::type_complexity)]
    fn fetch_git(
        &self,
        source: &Source,
        resolved: Option<&Resolved>,
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
        let resolved = match resolved {
            Some(r) => r.clone(),
            None => self.resolve(source, &git, &url, cancel)?,
        };
        let tracking = format!("{}/upstream", crate::brand::REF_NAMESPACE);
        // Catalog libraries are read, not developed in: the newest commit is
        // enough. A source once fetched that way keeps being fetched that way.
        let shallow = source.catalog_id.is_some() || git.is_shallow(&cache, cancel)?;
        git.fetch_with(
            &cache,
            &url,
            &resolved.git_source,
            &tracking,
            if shallow {
                FetchDepth::Tip
            } else {
                FetchDepth::Full
            },
            cancel,
        )?;
        let commit = git.rev_parse_commit(&cache, &tracking, cancel)?;
        let scope = Scope::new(&source.include, &source.exclude)?;

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
                // A new release is the point of following releases; the same
                // release pointing somewhere else is not.
                TrackedRef::LatestRelease => {
                    let was = self.snapshot_ref(&source.id, previous)?;
                    if resolved.label.starts_with("tag ") && was.as_deref() == Some(&resolved.label)
                    {
                        warning = Some(format!(
                            "{} moved from {} to {}. A tag name is not proof that content is unchanged; review the update before adopting it.",
                            resolved.label,
                            short(previous),
                            short(&commit)
                        ));
                    }
                }
                // Without history there is nothing to compare against.
                _ if shallow => {}
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
        let relative: Vec<(git::TreeEntry, String)> = entries
            .into_iter()
            .map(|entry| {
                let rel = entry
                    .path
                    .strip_prefix(&prefix)
                    .unwrap_or(&entry.path)
                    .to_string();
                (entry, rel)
            })
            .collect();
        let mut admitted_dirs = HashSet::new();
        for (_, rel) in relative.iter().filter(|(_, rel)| scope.admits(rel)) {
            with_ancestors(rel, &mut admitted_dirs);
        }
        for (entry, rel) in relative {
            if !scope.admits(&rel) && !scope.admits_license(&rel, &admitted_dirs) {
                continue;
            }
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
            // A file larger than Habi reads is not downloaded by a shallow
            // fetch, so git cannot say how large it is.
            let Some(size) = entry.size else {
                skipped.push(Diagnostic::warning(
                    format!("file is above the {MAX_FILE_BYTES}-byte limit; skipped"),
                    Some(&rel),
                ));
                continue;
            };
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
            // Snapshot content can be fetched again: stored as cache, unflushed
            // (see `store::cas`).
            let digest = self.blobs.put_cached(&bytes)?;
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
            Some(resolved.label),
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
        let scope = Scope::new(&source.include, &source.exclude)?;
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
                    let name = rel.rsplit('/').next().unwrap_or(&rel);
                    let admitted = scope.admits(&rel)
                        || (library::is_license_file(name) && !scope.exclude.is_match(&rel));
                    if RelPath::new(&rel).is_err() || !admitted {
                        continue;
                    }
                    if files.len() >= MAX_FILES || total + meta.len() > MAX_TOTAL_BYTES {
                        return Err(too_large());
                    }
                    match read_bounded(&path, MAX_FILE_BYTES)? {
                        Bounded::Content(bytes) => {
                            total += bytes.len() as u64;
                            // Read again on the next refresh: cache (see `store::cas`).
                            let digest = self.blobs.put_cached(&bytes)?;
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

    /// Index of a snapshot, built once per process (see `IndexMemo`).
    pub fn index_at(&self, id: &str, snapshot: &str) -> Result<LibraryIndex> {
        let row: (i64, String) = self
            .store
            .conn()?
            .query_row(
                "SELECT rowid, created_at FROM snapshots WHERE source_id = ?1 AND snapshot = ?2",
                [id, snapshot],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                HabiError::NotFound(format!("snapshot {} of source {id}", short(snapshot)))
            })?;
        let key = (id.to_string(), snapshot.to_string());
        let memo = || self.indexes.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(index) = memo().get(&key, &row) {
            return Ok(index);
        }
        let (index, complete) = self.build_index_at(id, snapshot)?;
        // An index built while a blob could not be read reports that; once the
        // blob is restored, the next use must build it again.
        if complete {
            memo().put(key, row, &index);
        }
        Ok(index)
    }

    /// Builds the index of a snapshot, and says whether every file it needed
    /// could be read from the blob store.
    fn build_index_at(&self, id: &str, snapshot: &str) -> Result<(LibraryIndex, bool)> {
        let data = self.snapshot_data(id, snapshot)?;
        let by_path: HashMap<&str, &str> = data
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.digest.as_str()))
            .collect();
        let blobs = &self.blobs;
        let unreadable = std::cell::Cell::new(false);
        let mut index = library::build_index(id, snapshot, &data.files, &|path| {
            let digest = by_path
                .get(path)
                .ok_or_else(|| format!("{path} is not in the snapshot"))?;
            blobs.get(digest).map_err(|e| {
                unreadable.set(true);
                e.to_string()
            })
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
        Ok((index, !unreadable.get()))
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

    /// A remembered value (the catalog keeps what GitHub said about a repository).
    /// How a snapshot was reached when it was fetched (`tag v6.4.2`).
    pub fn snapshot_ref(&self, id: &str, snapshot: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                "SELECT resolved_ref FROM snapshots WHERE source_id = ?1 AND snapshot = ?2",
                [id, snapshot],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Asks the remote whether it has something other than what a library
    /// reads now, downloading nothing and changing nothing. `None` for a
    /// folder, which has no remote. The answer is kept, so the library list
    /// can say so without asking again.
    pub fn check_update(&self, id: &str, cancel: &CancelToken) -> Result<Option<SourceUpdate>> {
        let source = self.get(id)?;
        if source.kind != SourceKind::Git {
            return Ok(None);
        }
        let probe = self
            .probe_remote(&source, cancel)?
            .ok_or_else(|| HabiError::NotFound("the library's repository did not answer".into()))?;
        let latest = version_of(
            &probe.head.commit,
            Some(&probe.resolved.label),
            probe
                .head
                .branch
                .as_deref()
                .or(source.default_branch.as_deref()),
        );
        let stored = StoredCheck {
            latest,
            checked_at: crate::time::now(),
        };
        self.set_setting(
            &format!("update:{id}"),
            &serde_json::to_string(&stored).map_err(|e| HabiError::Internal(e.to_string()))?,
        )?;
        Ok(Some(self.update_from(&source, stored)))
    }

    fn update_from(&self, source: &Source, check: StoredCheck) -> SourceUpdate {
        let current = source.snapshot.as_ref().map(|snapshot| {
            let reached = self.snapshot_ref(&source.id, snapshot).ok().flatten();
            version_of(
                snapshot,
                reached.as_deref(),
                source.default_branch.as_deref(),
            )
        });
        SourceUpdate {
            source_id: source.id.clone(),
            available: current
                .as_ref()
                .is_some_and(|c| c.commit != check.latest.commit),
            current,
            latest: check.latest,
            checked_at: check.checked_at,
        }
    }

    /// What the last check of each library found, judged against what each
    /// reads now: a library that has since been updated no longer shows one.
    pub fn updates(&self) -> Result<Vec<SourceUpdate>> {
        let mut out = Vec::new();
        for source in self.list()? {
            if source.kind != SourceKind::Git {
                continue;
            }
            let Some(json) = self.setting(&format!("update:{}", source.id))? else {
                continue;
            };
            if let Ok(check) = serde_json::from_str::<StoredCheck>(&json) {
                out.push(self.update_from(&source, check));
            }
        }
        Ok(out)
    }

    /// What the last update changed in a library, if it is still to be read.
    pub fn last_update(&self, id: &str) -> Result<Option<UpdateReport>> {
        Ok(self
            .setting(&format!("update-report:{id}"))?
            .and_then(|json| serde_json::from_str(&json).ok()))
    }

    /// The user has read what changed: the marks go.
    pub fn dismiss_update_report(&self, id: &str) -> Result<()> {
        self.set_setting(&format!("update-report:{id}"), "")
    }

    /// Keeps what an update changed, by name, so it can be shown after the fact.
    /// Never fails an update: a report that cannot be kept is only not shown.
    fn keep_report(
        &self,
        before: &Source,
        after: &Source,
        reached: Option<&str>,
        previous: Option<&LibraryIndex>,
        index: &LibraryIndex,
        (added, removed, updated): (&[String], &[String], &[String]),
    ) {
        let (Some(was), Some(now)) = (&before.snapshot, &after.snapshot) else {
            return;
        };
        let was_ref = self.snapshot_ref(&before.id, was).ok().flatten();
        let title = |idx: Option<&LibraryIndex>, id: &str| {
            idx.and_then(|i| i.items.iter().find(|x| x.id == id))
                .map(|x| x.title.clone())
                .unwrap_or_else(|| id.to_string())
        };
        let list = |ids: &[String], idx: Option<&LibraryIndex>| -> Vec<ReportedSkill> {
            ids.iter()
                .take(REPORT_LIMIT)
                .map(|id| ReportedSkill {
                    id: id.clone(),
                    title: title(idx, id),
                })
                .collect()
        };
        let report = UpdateReport {
            source_id: after.id.clone(),
            from: Some(version_of(
                was,
                was_ref.as_deref(),
                before.default_branch.as_deref(),
            )),
            to: version_of(now, reached, after.default_branch.as_deref()),
            at: crate::time::now(),
            added: list(added, Some(index)),
            updated: list(updated, Some(index)),
            removed: list(removed, previous),
        };
        if let Ok(json) = serde_json::to_string(&report) {
            let _ = self.set_setting(&format!("update-report:{}", after.id), &json);
        }
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.store.setting(key)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.store.set_setting(key, value)
    }

    /// The stored summary of a snapshot (JSON), if it was counted.
    pub fn summary_json(&self, id: &str, snapshot: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .conn()?
            .query_row(
                "SELECT summary_json FROM snapshots WHERE source_id = ?1 AND snapshot = ?2",
                [id, snapshot],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn set_summary_json(&self, id: &str, snapshot: &str, json: &str) -> Result<()> {
        self.store.conn()?.execute(
            "UPDATE snapshots SET summary_json = ?3 WHERE source_id = ?1 AND snapshot = ?2",
            params![id, snapshot, json],
        )?;
        Ok(())
    }

    /// Path of the bare cache for a Git source (used by contributions).
    pub fn cache_dir(&self, id: &str) -> PathBuf {
        self.paths.sources().join(id).join("repo.git")
    }

    pub fn fetch_url(&self, id: &str) -> Result<String> {
        self.raw_location(id)
    }
}

/// Which files of a repository a source reads.
struct Scope {
    include: Option<GlobSet>,
    exclude: GlobSet,
}

impl Scope {
    fn new(include: &[String], exclude: &[String]) -> Result<Scope> {
        Ok(Scope {
            include: if include.is_empty() {
                None
            } else {
                Some(scope_globs(include)?)
            },
            exclude: scope_globs(exclude)?,
        })
    }

    fn admits(&self, rel: &str) -> bool {
        self.include.as_ref().is_none_or(|g| g.is_match(rel)) && !self.exclude.is_match(rel)
    }

    /// A licence file next to admitted files (or in a folder above them) is
    /// read too, even when it is outside the patterns: a library narrowed to
    /// part of a repository can still say what the repository is licensed as.
    fn admits_license(&self, rel: &str, admitted_dirs: &HashSet<String>) -> bool {
        let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
        library::is_license_file(name) && !self.exclude.is_match(rel) && admitted_dirs.contains(dir)
    }
}

/// `dir` and every folder above it (the root is `""`).
fn with_ancestors(rel: &str, into: &mut HashSet<String>) {
    let mut dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    loop {
        if !into.insert(dir.to_string()) {
            return;
        }
        match dir.rsplit_once('/') {
            Some((parent, _)) => dir = parent,
            None if dir.is_empty() => return,
            None => dir = "",
        }
    }
}

/// Checks the patterns a source or catalog entry narrows itself with.
pub fn validate_scope(patterns: &[String]) -> Result<()> {
    scope_globs(patterns).map(|_| ())
}

const MAX_SCOPE_GLOBS: usize = 64;

/// Compiles scope globs. `*` stays within one folder, `**` crosses folders.
fn scope_globs(patterns: &[String]) -> Result<GlobSet> {
    if patterns.len() > MAX_SCOPE_GLOBS {
        return Err(HabiError::invalid(format!(
            "a source can narrow itself with at most {MAX_SCOPE_GLOBS} patterns"
        )));
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let bad = pattern.is_empty()
            || pattern.len() > 200
            || pattern.starts_with('/')
            || pattern.contains('\\')
            || pattern.chars().any(|c| c.is_control())
            || pattern.split('/').any(|part| part == "..");
        if bad {
            return Err(HabiError::invalid(format!(
                "`{pattern}` is not a valid path pattern"
            )));
        }
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|e| HabiError::invalid(format!("`{pattern}` is not a valid pattern: {e}")))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|e| HabiError::invalid(format!("invalid path patterns: {e}")))
}

fn json_string(list: &[String]) -> Result<String> {
    serde_json::to_string(list).map_err(|e| HabiError::Internal(e.to_string()))
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

/// A snapshot as a version a person would name: its release tag, or its branch.
fn version_of(commit: &str, reached: Option<&str>, branch: Option<&str>) -> SourceVersion {
    let (label, release) = match reached {
        Some(r) if r.starts_with("tag ") => (r.trim_start_matches("tag "), true),
        Some(r) if r.starts_with("branch ") => (r.trim_start_matches("branch "), false),
        _ => (branch.unwrap_or("default branch"), false),
    };
    SourceVersion {
        label: label.to_string(),
        release,
        commit: commit.to_string(),
    }
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
            preview: false,
            catalog_id: None,
            include: Vec::new(),
            exclude: Vec::new(),
            default_branch: None,
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
