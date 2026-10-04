//! Planning installs, updates, removals and restores.
//!
//! A plan lists every file Habi would create, modify or delete, with the
//! content digest it expects to find there (so apply can detect edits made
//! after the preview) and a readable diff. Planning reads the project but
//! never writes to it. Anything Habi does not own, or that was edited since
//! Habi wrote it, becomes an explicit conflict that the user resolves.

use super::diff::{TextDiff, diff};
use super::lock::{
    LockFile, LockedFile, LockedItem, LockedMcpEntry, LockedSection, LockedSource, lock_key,
};
use crate::brand;
use crate::clients::{ClientId, layout, mcp, sections};
use crate::error::{HabiError, Result};
use crate::fsutil::{Bounded, digest_matches, read_bounded, same_text, sha256, short, text_digest};
use crate::library::model::{ItemKind, LibraryItem};
use crate::paths::{RelPath, resolve_for_read, resolve_links};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use ts_rs::TS;

const MAX_PROJECT_FILE: u64 = 4 * 1024 * 1024;
pub const BRIDGE_ID: &str = "claude-code-agents-import";
const BRIDGE_IDENTITY: &str = "habi:internal";

/// A file that makes a client read AGENTS.md by importing it, for the clients
/// that read a file of their own rather than AGENTS.md.
struct Bridge {
    id: &'static str,
    client: ClientId,
    kind: ChangeKind,
    /// The files that can hold the import, each with the line it takes. The
    /// first is the default; an earlier one that exists is used first.
    files: &'static [(&'static str, &'static str)],
    why: &'static str,
}

const BRIDGES: [Bridge; 2] = [
    Bridge {
        id: BRIDGE_ID,
        client: ClientId::ClaudeCode,
        kind: ChangeKind::ClaudeBridge,
        files: &[
            ("CLAUDE.md", "@AGENTS.md"),
            (".claude/CLAUDE.md", "@../AGENTS.md"),
        ],
        why: "Claude Code reads CLAUDE.md; this import makes it read AGENTS.md too (documented, loaded once).",
    },
    Bridge {
        id: "gemini-cli-agents-import",
        client: ClientId::GeminiCli,
        kind: ChangeKind::GeminiBridge,
        files: &[("GEMINI.md", "@./AGENTS.md")],
        why: "Gemini CLI reads GEMINI.md; this import makes it read AGENTS.md too (documented).",
    },
];
const INSTRUCTIONS_FILE: &str = "AGENTS.md";
/// Codex's default `project_doc_max_bytes` (see `docs/dev/compatibility-research.md`).
const CODEX_INSTRUCTIONS_LIMIT: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeOp {
    Create,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeKind {
    SkillFile,
    InstructionsSection,
    ClaudeBridge,
    GeminiBridge,
    McpConfig,
    LockFile,
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileChange {
    /// Project-relative path.
    pub path: String,
    pub op: ChangeOp,
    pub kind: ChangeKind,
    /// Titles of the items this change belongs to.
    pub items: Vec<String>,
    pub clients: Vec<ClientId>,
    /// Digest expected on disk when applying (`None` = must not exist).
    pub before: Option<String>,
    /// Digest after applying (`None` = deleted).
    pub after: Option<String>,
    pub explanation: String,
    pub diff: TextDiff,
    /// `Some(true)` makes the written file executable, `Some(false)` clears
    /// the bit, `None` keeps whatever the file has.
    pub executable: Option<bool>,
    #[serde(skip)]
    #[ts(skip)]
    pub content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ConflictKind {
    /// A file Habi does not manage already exists where Habi would write.
    UnmanagedContent,
    /// A file Habi wrote was edited since.
    LocalEdits,
    /// Habi's section markers are damaged.
    DamagedMarkers,
    /// A configuration file cannot be parsed, so it is left alone.
    InvalidConfig,
    /// Two items would write the same path.
    PathCollision,
    /// The target is reached through a symbolic link Habi will not write through.
    SymbolicLink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Resolution {
    /// Leave what is on disk. For updates, the local version is kept.
    Keep,
    /// Use Habi's version (writes, or deletes for removals). The previous
    /// content is kept in the operation journal and can be restored.
    Overwrite,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Conflict {
    pub path: String,
    pub kind: ConflictKind,
    pub item: Option<String>,
    pub message: String,
    pub options: Vec<Resolution>,
    /// What choosing `Overwrite` would change, compared to what is on disk.
    pub diff: Option<TextDiff>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PlanAction {
    Install,
    Update,
    Remove,
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanItem {
    pub key: String,
    pub title: String,
    pub kind: ItemKind,
    pub source: String,
    pub version: String,
    pub clients: Vec<ClientId>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Plan {
    pub id: String,
    pub action: PlanAction,
    /// Specific, human description of the final action.
    pub title: String,
    pub project: String,
    pub created_at: String,
    pub items: Vec<PlanItem>,
    pub changes: Vec<FileChange>,
    /// Must be resolved (re-plan with decisions) before applying.
    pub conflicts: Vec<Conflict>,
    pub notes: Vec<String>,
    /// MCP servers an update found that an item newly suggests. They are
    /// added only when the update was planned to add them (`added`).
    pub mcp_suggestions: Vec<McpSuggestion>,
    pub recovery: String,
    #[serde(skip)]
    #[ts(skip)]
    pub root: PathBuf,
}

/// An MCP server an installed item suggests since it was installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct McpSuggestion {
    /// Title of the item that suggests it.
    pub item: String,
    pub server: String,
    /// Whether this plan adds it.
    pub added: bool,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
    pub fn is_blocked(&self) -> bool {
        !self.conflicts.is_empty()
    }
}

/// An item and its content, ready to install.
#[derive(Debug, Clone)]
pub struct Payload {
    pub item: LibraryItem,
    pub source: LockedSource,
    pub snapshot: String,
    pub files: Vec<PayloadFile>,
}

/// One file of an item to install.
#[derive(Debug, Clone)]
pub struct PayloadFile {
    /// Item-relative path.
    pub path: String,
    pub bytes: Vec<u8>,
    pub executable: bool,
}

impl Payload {
    pub fn key(&self) -> String {
        lock_key(&self.source.identity, &self.item.id)
    }
}

pub type Decisions = HashMap<String, Resolution>;

/// Reads the current content of a project file (no symlinks, bounded).
pub fn read_project_file(root: &Path, rel: &str) -> Result<Option<Vec<u8>>> {
    let rel = RelPath::new(rel)?;
    let path = match resolve_for_read(root, &rel) {
        Ok(Some(path)) => path,
        Ok(None) => return Ok(None),
        Err(HabiError::PathEscape(_)) => {
            // A link that stays inside the project is a layout choice, not an
            // attack: say what it is and how to proceed.
            return Err(match resolve_links(root, &rel) {
                Ok(Some(target)) => HabiError::Conflict(format!(
                    "`{rel}` is reached through a symbolic link (to `{target}` in this project). Habi does not write through links: replace the link with a regular file or folder, then preview again."
                )),
                Ok(None) => HabiError::PathEscape(rel.to_string()),
                Err(e) => e,
            });
        }
        Err(e) => return Err(e),
    };
    let meta =
        std::fs::symlink_metadata(&path).map_err(|e| HabiError::io(format!("reading {rel}"), e))?;
    if meta.is_dir() {
        return Err(HabiError::Conflict(format!(
            "`{rel}` is a directory where Habi expects a file"
        )));
    }
    match read_bounded(&path, MAX_PROJECT_FILE)? {
        Bounded::Content(b) => Ok(Some(b)),
        Bounded::TooLarge(n) => Err(HabiError::Conflict(format!(
            "`{rel}` is {n} bytes; too large for Habi to manage"
        ))),
    }
}

pub fn read_lock(root: &Path) -> Result<LockFile> {
    match read_project_file(root, brand::LOCK_FILE)? {
        Some(bytes) => LockFile::parse(&bytes),
        None => Ok(LockFile::default()),
    }
}

#[derive(Default)]
struct Meta {
    kind: Option<ChangeKind>,
    items: BTreeSet<String>,
    clients: BTreeSet<ClientId>,
    explanations: Vec<String>,
}

/// Staged view of the project: original content plus planned edits.
struct Workspace<'a> {
    root: &'a Path,
    original: HashMap<String, Option<Vec<u8>>>,
    staged: BTreeMap<String, Option<Vec<u8>>>,
    meta: HashMap<String, Meta>,
    /// Desired executable bit for written files.
    modes: HashMap<String, bool>,
    /// Paths to write even if the content read through the file system is
    /// identical (case-only renames on case-insensitive file systems, mode changes).
    forced: BTreeSet<String>,
}

impl<'a> Workspace<'a> {
    fn new(root: &'a Path) -> Self {
        Workspace {
            root,
            original: HashMap::new(),
            staged: BTreeMap::new(),
            meta: HashMap::new(),
            modes: HashMap::new(),
            forced: BTreeSet::new(),
        }
    }

    fn on_disk_executable(&self, path: &str) -> bool {
        RelPath::new(path)
            .map(|r| crate::fsutil::is_executable(&r.to_path(self.root)))
            .unwrap_or(false)
    }

    /// The path as the file system spells it, when it differs from `path`
    /// only in the letter case of the file name. `None` if the spelling
    /// matches, the file is absent, or an exact match exists beside it.
    fn spelled_differently(&self, path: &str) -> Option<String> {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        let folder = RelPath::new(path)
            .ok()?
            .to_path(self.root)
            .parent()?
            .to_path_buf();
        let mut found = None;
        for entry in std::fs::read_dir(folder).ok()?.flatten() {
            let actual = entry.file_name().into_string().ok()?;
            if actual == name {
                return None;
            }
            if actual.to_lowercase() == name.to_lowercase() {
                found = Some(actual);
            }
        }
        found.map(|actual| {
            if dir.is_empty() {
                actual
            } else {
                format!("{dir}/{actual}")
            }
        })
    }

    fn original(&mut self, path: &str) -> Result<Option<Vec<u8>>> {
        if let Some(v) = self.original.get(path) {
            return Ok(v.clone());
        }
        let v = read_project_file(self.root, path)?;
        self.original.insert(path.to_string(), v.clone());
        Ok(v)
    }

    fn read(&mut self, path: &str) -> Result<Option<Vec<u8>>> {
        if let Some(v) = self.staged.get(path) {
            return Ok(v.clone());
        }
        self.original(path)
    }

    fn read_text(&mut self, path: &str) -> Result<Option<String>> {
        match self.read(path)? {
            None => Ok(None),
            Some(b) => String::from_utf8(b)
                .map(Some)
                .map_err(|_| HabiError::Conflict(format!("`{path}` is not UTF-8 text"))),
        }
    }

    fn write(
        &mut self,
        path: &str,
        content: Option<Vec<u8>>,
        kind: ChangeKind,
        item: &str,
        clients: &[ClientId],
        why: &str,
    ) -> Result<()> {
        RelPath::new(path)?;
        self.original(path)?;
        self.staged.insert(path.to_string(), content);
        let meta = self.meta.entry(path.to_string()).or_default();
        meta.kind = Some(meta.kind.map_or(kind, |k| k.min(kind)));
        if !item.is_empty() {
            meta.items.insert(item.to_string());
        }
        meta.clients.extend(clients.iter().copied());
        if !why.is_empty() && !meta.explanations.iter().any(|e| e == why) {
            meta.explanations.push(why.to_string());
        }
        Ok(())
    }

    fn into_changes(self) -> Result<Vec<FileChange>> {
        let mut changes = Vec::new();
        let mut lower: HashMap<String, (String, bool)> = HashMap::new();
        for (path, new) in &self.staged {
            let old = self.original.get(path).cloned().flatten();
            if old == *new && !self.forced.contains(path) {
                continue;
            }
            // Two paths differing only in letter case may be one file. That is
            // allowed only as a rename: one of them deleted, the other written.
            let deleting = new.is_none();
            if let Some((other, other_deleting)) =
                lower.insert(path.to_lowercase(), (path.clone(), deleting))
                && deleting == other_deleting
            {
                return Err(HabiError::Conflict(format!(
                    "`{path}` and `{other}` differ only in letter case, which some file systems treat as the same file"
                )));
            }
            let meta = self.meta.get(path);
            let op = match (&old, new) {
                (None, Some(_)) => ChangeOp::Create,
                (Some(_), None) => ChangeOp::Delete,
                _ => ChangeOp::Modify,
            };
            changes.push(FileChange {
                path: path.clone(),
                op,
                kind: meta.and_then(|m| m.kind).unwrap_or(ChangeKind::SkillFile),
                items: meta
                    .map(|m| m.items.iter().cloned().collect())
                    .unwrap_or_default(),
                clients: meta
                    .map(|m| m.clients.iter().copied().collect())
                    .unwrap_or_default(),
                before: old.as_ref().map(|b| sha256(b)),
                after: new.as_ref().map(|b| sha256(b)),
                explanation: meta.map(|m| m.explanations.join(" ")).unwrap_or_default(),
                diff: diff(old.as_deref(), new.as_deref()),
                executable: new.as_ref().and(self.modes.get(path).copied()),
                content: new.clone(),
            });
        }
        // Lock file last, so an interrupted apply never records unwritten
        // files. A delete runs before a write whose path differs only in case.
        changes.sort_by_key(|c| {
            (
                c.kind == ChangeKind::LockFile,
                c.path.to_lowercase(),
                c.op != ChangeOp::Delete,
                c.path.clone(),
            )
        });
        Ok(changes)
    }
}

/// Where a plan writes: into one project, or into the person's own skill
/// folders under their home folder (the "root" is then the home folder).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Project,
    Machine,
}

impl Scope {
    /// "this project" / "this machine", for sentences about what a plan changes.
    fn here(self) -> &'static str {
        match self {
            Scope::Project => "this project",
            Scope::Machine => "this machine",
        }
    }

    /// "in this project" / "on this machine".
    fn on(self) -> &'static str {
        match self {
            Scope::Project => "in this project",
            Scope::Machine => "on this machine",
        }
    }
}

struct Planner<'a> {
    scope: Scope,
    ws: Workspace<'a>,
    lock: LockFile,
    original_lock: LockFile,
    decisions: &'a Decisions,
    conflicts: Vec<Conflict>,
    notes: Vec<String>,
    mcp_suggestions: Vec<McpSuggestion>,
    items: Vec<PlanItem>,
}

fn conflict(
    path: &str,
    kind: ConflictKind,
    item: &str,
    message: String,
    options: Vec<Resolution>,
    d: Option<TextDiff>,
) -> Conflict {
    Conflict {
        path: path.to_string(),
        kind,
        item: Some(item.to_string()),
        message,
        options,
        diff: d,
    }
}

impl<'a> Planner<'a> {
    fn new(root: &'a Path, decisions: &'a Decisions, scope: Scope) -> Result<Self> {
        let lock = read_lock(root)?;
        if scope == Scope::Machine {
            // The lock in the home folder is as editable as a project's, but
            // Habi only ever records skill folders there. Instruction sections
            // and MCP entries would send updates and removals into files
            // outside the skill folders.
            if let Some(item) = lock.items.iter().find(|i| {
                i.kind == ItemKind::Instructions || !i.sections.is_empty() || !i.mcp.is_empty()
            }) {
                return Err(HabiError::Conflict(format!(
                    "{} in your home folder lists `{}` with instruction or MCP entries, which Habi never installs on this machine. Fix or remove that lock file.",
                    crate::brand::LOCK_FILE,
                    item.id
                )));
            }
        }
        Ok(Planner {
            scope,
            ws: Workspace::new(root),
            original_lock: lock.clone(),
            lock,
            decisions,
            conflicts: Vec::new(),
            notes: Vec::new(),
            mcp_suggestions: Vec::new(),
            items: Vec::new(),
        })
    }

    fn decision(&self, path: &str) -> Option<Resolution> {
        self.decisions.get(path).copied()
    }

    /// Where `path` really is, if reaching it crosses a symbolic link that
    /// stays inside the project. Links that leave it are refused.
    fn link_target(&self, path: &str) -> Result<Option<String>> {
        Ok(resolve_links(self.ws.root, &RelPath::new(path)?)?.map(|t| t.to_string()))
    }

    /// Writes one managed file using three digests: what Habi last wrote
    /// (`baseline`), what is on disk, and what it wants to write. Returns the
    /// digest to record in the lock, or `None` if the file is not tracked.
    #[allow(clippy::too_many_arguments)]
    fn put_file(
        &mut self,
        path: &str,
        new: &[u8],
        executable: bool,
        baseline: Option<&str>,
        item: &str,
        clients: &[ClientId],
        why: &str,
    ) -> Result<Option<String>> {
        self.ws.modes.insert(path.to_string(), executable);
        let new_digest = sha256(new);
        let current = self.ws.read(path)?;
        // Content is compared without regard to line endings: a checkout with
        // `core.autocrlf=true` turns the LF files Habi wrote into CRLF.
        let matches_new = current.as_deref().is_some_and(|c| same_text(c, new));
        let unedited = current
            .as_deref()
            .zip(baseline)
            .is_some_and(|(c, base)| digest_matches(c, base));
        let upstream_unchanged =
            baseline.is_some_and(|base| base == new_digest || base == text_digest(new));
        match (&current, baseline) {
            (None, Some(_)) => {
                // Habi installed this file and the user deleted it.
                match self.decision(path) {
                    Some(Resolution::Overwrite) => {
                        self.ws.write(
                            path,
                            Some(new.to_vec()),
                            ChangeKind::SkillFile,
                            item,
                            clients,
                            "Restores a file you deleted, at your request.",
                        )?;
                        Ok(Some(new_digest))
                    }
                    Some(Resolution::Keep) => {
                        self.notes
                            .push(format!("{path} stays deleted; Habi no longer tracks it."));
                        Ok(None)
                    }
                    None => {
                        self.conflicts.push(conflict(
                            path,
                            ConflictKind::LocalEdits,
                            item,
                            format!("{path} was deleted after Habi installed it."),
                            vec![Resolution::Keep, Resolution::Overwrite],
                            Some(diff(None, Some(new))),
                        ));
                        Ok(baseline.map(str::to_string))
                    }
                }
            }
            (None, None) => {
                self.ws.write(
                    path,
                    Some(new.to_vec()),
                    ChangeKind::SkillFile,
                    item,
                    clients,
                    why,
                )?;
                Ok(Some(new_digest))
            }
            (Some(_), _) if matches_new => {
                if self.ws.on_disk_executable(path) != executable && cfg!(unix) {
                    self.ws.forced.insert(path.to_string());
                    self.ws.write(
                        path,
                        Some(new.to_vec()),
                        ChangeKind::SkillFile,
                        item,
                        clients,
                        if executable {
                            "Makes the file executable, as in the library."
                        } else {
                            "Clears the executable bit, as in the library."
                        },
                    )?;
                }
                Ok(Some(new_digest))
            }
            (Some(_), Some(_)) if unedited => {
                self.ws.write(
                    path,
                    Some(new.to_vec()),
                    ChangeKind::SkillFile,
                    item,
                    clients,
                    why,
                )?;
                Ok(Some(new_digest))
            }
            (Some(_), Some(base)) if upstream_unchanged => {
                // Upstream did not change this file; the local edit stays.
                self.notes.push(format!(
                    "Kept your local edits to {path} (unchanged upstream)."
                ));
                Ok(Some(base.to_string()))
            }
            (Some(_), managed) => {
                let kind = if managed.is_some() {
                    ConflictKind::LocalEdits
                } else {
                    ConflictKind::UnmanagedContent
                };
                match self.decision(path) {
                    Some(Resolution::Overwrite) => {
                        self.ws.write(path, Some(new.to_vec()), ChangeKind::SkillFile, item, clients, "Replaces the existing file at your request; the previous version is kept for restore.")?;
                        Ok(Some(new_digest))
                    }
                    Some(Resolution::Keep) => {
                        if managed.is_some() {
                            self.notes.push(format!("Keeping your version of {path}; it now differs from the team version."));
                            Ok(Some(new_digest))
                        } else {
                            self.notes.push(format!(
                                "Left the existing {path} untouched; it is not managed by Habi."
                            ));
                            Ok(None)
                        }
                    }
                    None => {
                        let message = if managed.is_some() {
                            format!(
                                "{path} was edited after Habi installed it, and the team version changed too."
                            )
                        } else {
                            format!("{path} already exists and was not installed by Habi.")
                        };
                        self.conflicts.push(conflict(
                            path,
                            kind,
                            item,
                            message,
                            vec![Resolution::Keep, Resolution::Overwrite],
                            Some(diff(current.as_deref(), Some(new))),
                        ));
                        Ok(baseline.map(str::to_string))
                    }
                }
            }
        }
    }

    fn delete_file(
        &mut self,
        path: &str,
        baseline: &str,
        item: &str,
        clients: &[ClientId],
        why: &str,
    ) -> Result<bool> {
        if !self.ws.staged.contains_key(path)
            && let Some(target) = self.link_target(path)?
        {
            // The folder became a link (e.g. `.claude/skills` now points at
            // `.agents/skills`): deleting through it would delete the other copy.
            self.notes.push(format!(
                "{path} is now reached through a symbolic link (to {target}); Habi no longer tracks it as a separate copy and leaves it alone."
            ));
            return Ok(true);
        }
        let current = self.ws.read(path)?;
        let Some(current) = current else {
            return Ok(true);
        };
        if digest_matches(&current, baseline) {
            self.ws
                .write(path, None, ChangeKind::SkillFile, item, clients, why)?;
            return Ok(true);
        }
        match self.decision(path) {
            Some(Resolution::Overwrite) => {
                self.ws.write(
                    path,
                    None,
                    ChangeKind::SkillFile,
                    item,
                    clients,
                    "Deletes your edited copy at your request; it is kept for restore.",
                )?;
                Ok(true)
            }
            Some(Resolution::Keep) => {
                self.notes.push(format!(
                    "Kept your edited {path}; Habi no longer tracks it."
                ));
                Ok(true)
            }
            None => {
                self.conflicts.push(conflict(
                    path,
                    ConflictKind::LocalEdits,
                    item,
                    format!("{path} was edited after Habi installed it."),
                    vec![Resolution::Keep, Resolution::Overwrite],
                    Some(diff(Some(&current), None)),
                ));
                Ok(false)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn put_section(
        &mut self,
        file: &str,
        id: &str,
        body: &str,
        baseline: Option<&str>,
        item: &str,
        clients: &[ClientId],
        kind: ChangeKind,
        note: &str,
        why: &str,
    ) -> Result<Option<String>> {
        let new_digest = sections::digest(body);
        let key = section_key(file, id);
        let text = self.ws.read_text(file)?.unwrap_or_default();
        let span = match sections::find(&text, id) {
            Ok(s) => s,
            Err(e) => {
                self.conflicts.push(conflict(
                    file,
                    ConflictKind::DamagedMarkers,
                    item,
                    damaged_markers_message(file, &e),
                    vec![],
                    None,
                ));
                return Ok(baseline.map(str::to_string));
            }
        };
        if span.is_none() && baseline.is_some() {
            // Habi added this section and someone removed it.
            match self.decision(&key) {
                Some(Resolution::Overwrite) => {}
                Some(Resolution::Keep) => {
                    self.notes.push(format!(
                        "The `{id}` section stays removed from {file}; Habi no longer tracks it."
                    ));
                    return Ok(None);
                }
                None => {
                    let restored = sections::upsert(&text, id, note, body)?;
                    self.conflicts.push(conflict(
                        &key,
                        ConflictKind::LocalEdits,
                        item,
                        format!("The Habi-managed `{id}` section was removed from {file}."),
                        vec![Resolution::Keep, Resolution::Overwrite],
                        Some(diff(Some(text.as_bytes()), Some(restored.as_bytes()))),
                    ));
                    return Ok(baseline.map(str::to_string));
                }
            }
        }
        if let Some(span) = &span {
            let current = sections::content(&text, span);
            if sections::digest(current) == new_digest {
                return Ok(Some(new_digest));
            }
            let edited = !baseline.is_some_and(|b| sections::digest_matches(current, b));
            let upstream_unchanged = baseline.is_some_and(|b| sections::digest_matches(body, b));
            if edited && upstream_unchanged {
                self.notes.push(format!(
                    "Kept your edits to the `{id}` section of {file} (unchanged upstream)."
                ));
                return Ok(Some(new_digest));
            }
            if edited {
                match self.decision(&key) {
                    Some(Resolution::Overwrite) => {}
                    Some(Resolution::Keep) => {
                        self.notes.push(format!(
                            "Keeping your version of the `{id}` section in {file}."
                        ));
                        return Ok(Some(new_digest));
                    }
                    None => {
                        let updated = sections::upsert(&text, id, note, body)?;
                        self.conflicts.push(conflict(
                            &key,
                            ConflictKind::LocalEdits,
                            item,
                            format!(
                                "The Habi-managed `{id}` section of {file} was edited by hand."
                            ),
                            vec![Resolution::Keep, Resolution::Overwrite],
                            Some(diff(Some(text.as_bytes()), Some(updated.as_bytes()))),
                        ));
                        return Ok(baseline.map(str::to_string));
                    }
                }
            }
        }
        let updated = sections::upsert(&text, id, note, body)?;
        self.ws
            .write(file, Some(updated.into_bytes()), kind, item, clients, why)?;
        Ok(Some(new_digest))
    }

    fn remove_section(
        &mut self,
        file: &str,
        id: &str,
        baseline: &str,
        created: Option<bool>,
        item: &str,
        kind: ChangeKind,
    ) -> Result<()> {
        let Some(text) = self.ws.read_text(file)? else {
            return Ok(());
        };
        let span = match sections::find(&text, id) {
            Ok(Some(s)) => s,
            Ok(None) => return Ok(()),
            Err(e) => {
                self.conflicts.push(conflict(
                    file,
                    ConflictKind::DamagedMarkers,
                    item,
                    damaged_markers_message(file, &e),
                    vec![],
                    None,
                ));
                return Ok(());
            }
        };
        let key = section_key(file, id);
        if !sections::digest_matches(sections::content(&text, &span), baseline) {
            match self.decision(&key) {
                Some(Resolution::Overwrite) => {}
                Some(Resolution::Keep) => {
                    self.notes
                        .push(format!("Left your edited `{id}` section in {file}."));
                    return Ok(());
                }
                None => {
                    let updated = sections::remove(&text, id)?;
                    self.conflicts.push(conflict(
                        &key,
                        ConflictKind::LocalEdits,
                        item,
                        format!("The `{id}` section of {file} was edited after Habi added it."),
                        vec![Resolution::Keep, Resolution::Overwrite],
                        Some(diff(Some(text.as_bytes()), Some(updated.as_bytes()))),
                    ));
                    return Ok(());
                }
            }
        }
        let updated = sections::remove(&text, id)?;
        // Delete the file only if Habi created it and nothing but whitespace
        // is left. Lock files from before `created` was recorded: only if
        // nothing at all is left.
        let delete = match created {
            Some(true) => updated.trim().is_empty(),
            Some(false) => false,
            None => updated.is_empty(),
        };
        if delete {
            self.ws.write(
                file,
                None,
                kind,
                item,
                &[],
                "Removes the Habi-managed section; Habi created this file and nothing else is in it.",
            )?;
        } else {
            self.ws.write(
                file,
                Some(updated.into_bytes()),
                kind,
                item,
                &[],
                "Removes the Habi-managed section; the rest of the file is unchanged.",
            )?;
        }
        Ok(())
    }

    /// True if `file` does not exist yet, or Habi created it for a section or
    /// MCP entry it still manages (so it may be deleted once it is empty).
    fn created_by_habi(&mut self, file: &str) -> Result<bool> {
        Ok(self.ws.original(file)?.is_none()
            || self.lock.items.iter().any(|i| {
                i.sections
                    .iter()
                    .any(|s| s.file == file && s.created == Some(true))
                    || i.mcp
                        .iter()
                        .any(|m| m.file == file && m.created == Some(true))
            }))
    }

    fn install_skill(
        &mut self,
        p: &Payload,
        clients: &[ClientId],
        existing: Option<&LockedItem>,
    ) -> Result<LockedItem> {
        let item = &p.item;
        if !item.complete {
            return Err(HabiError::invalid(format!(
                "`{}` is incomplete in the library (some files were skipped while reading it) and cannot be installed",
                item.title
            )));
        }
        if let Err(e) = crate::library::check_skill_name(&item.name) {
            return Err(HabiError::invalid(format!(
                "`{}` cannot be installed: its SKILL.md name {e}",
                item.title
            )));
        }
        if item.license_restricted && existing.is_none() {
            let terms = item
                .license_file
                .as_deref()
                .map(|f| format!(" ({f} in the library)"))
                .unwrap_or_default();
            self.notes.push(match self.scope {
                Scope::Project => format!(
                    "{} declares a proprietary licence (\u{201c}{}\u{201d}). Installing copies it into this project; check its terms{terms} before committing it where others can see it.",
                    item.title,
                    item.license.as_deref().unwrap_or_default(),
                ),
                Scope::Machine => format!(
                    "{} declares a proprietary licence (\u{201c}{}\u{201d}). Installing copies it into your own skill folders; check its terms{terms}.",
                    item.title,
                    item.license.as_deref().unwrap_or_default(),
                ),
            });
        }
        let (dirs, dir_notes) = layout::skill_dirs(clients);
        self.notes.extend(dir_notes);
        let dirs = self.resolve_skill_dirs(dirs, item)?;
        let baselines: HashMap<String, String> = existing
            .map(|e| {
                e.files
                    .iter()
                    .map(|f| (f.path.clone(), f.digest.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut files = Vec::new();
        let mut written = BTreeSet::new();
        // Previously installed paths by lower-case form, to recognize renames
        // that only change letter case.
        let previous_by_case: HashMap<String, (String, String, Vec<ClientId>)> = existing
            .map(|e| {
                e.files
                    .iter()
                    .map(|f| {
                        (
                            f.path.to_lowercase(),
                            (f.path.clone(), f.digest.clone(), f.clients.clone()),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        for dir in &dirs {
            let names: Vec<&str> = dir.clients.iter().map(|c| c.label()).collect();
            let verb = if names.len() == 1 { "reads" } else { "read" };
            let why = format!("{} {verb} skills from {}.", names.join(" and "), dir.base);
            for file in &p.files {
                let (rel, bytes) = (&file.path, &file.bytes);
                let target =
                    RelPath::new(&format!("{}/{}/{}", dir.base, item.name, rel))?.to_string();
                if let Some((old_path, old_digest, old_clients)) =
                    previous_by_case.get(&target.to_lowercase())
                    && old_path != &target
                {
                    // Case-only rename: delete the old name (respecting local
                    // edits), then write the new name explicitly.
                    written.insert(old_path.clone());
                    if self.delete_file(
                        old_path,
                        old_digest,
                        &item.title,
                        old_clients,
                        "Renamed in the library (letter case only).",
                    )? {
                        self.ws.modes.insert(target.clone(), file.executable);
                        self.ws.forced.insert(target.clone());
                        self.ws.write(
                            &target,
                            Some(bytes.clone()),
                            ChangeKind::SkillFile,
                            &item.title,
                            &dir.clients,
                            "Renamed in the library (letter case only).",
                        )?;
                        files.push(LockedFile {
                            path: target.clone(),
                            digest: sha256(bytes),
                            clients: dir.clients.clone(),
                        });
                    } else {
                        files.push(LockedFile {
                            path: old_path.clone(),
                            digest: old_digest.clone(),
                            clients: old_clients.clone(),
                        });
                    }
                    written.insert(target);
                    continue;
                }
                if let Some(owner) = self.lock.owner_of(&target).filter(|o| o.key() != p.key()) {
                    self.conflicts.push(conflict(
                        &target,
                        ConflictKind::PathCollision,
                        &item.title,
                        format!("{target} is already installed by `{}` from {}; two skills share the name `{}`. Remove the installed one first, or leave this one out of the install.", owner.title, owner.source.name, item.name),
                        vec![],
                        None,
                    ));
                    continue;
                }
                let baseline = baselines.get(&target).map(String::as_str);
                if let Some(digest) = self.put_file(
                    &target,
                    bytes,
                    file.executable,
                    baseline,
                    &item.title,
                    &dir.clients,
                    &why,
                )? {
                    files.push(LockedFile {
                        path: target.clone(),
                        digest,
                        clients: dir.clients.clone(),
                    });
                }
                written.insert(target);
            }
        }
        // Files Habi installed before that the new version no longer has.
        if let Some(prev) = existing {
            for f in &prev.files {
                if !written.contains(&f.path) {
                    let why = "No longer part of this skill (removed upstream or no longer needed for the selected clients).";
                    if !self.delete_file(&f.path, &f.digest, &item.title, &f.clients, why)? {
                        files.push(f.clone());
                    }
                }
            }
        }
        Ok(LockedItem {
            source: p.source.clone(),
            id: item.id.clone(),
            kind: item.kind,
            title: item.title.clone(),
            snapshot: p.snapshot.clone(),
            content_digest: item.content_digest.clone(),
            installed_at: crate::time::now(),
            clients: clients.to_vec(),
            files,
            sections: Vec::new(),
            mcp: existing.map(|e| e.mcp.clone()).unwrap_or_default(),
        })
    }

    /// Accounts for skill folders that are symbolic links inside the project.
    /// A link from one skills folder to the other (the layout in
    /// `docs/guide/agent-tools.md`, e.g. `.claude/skills -> ../.agents/skills`)
    /// means one copy serves both, so Habi writes it once, in the real
    /// folder. Any other link is a conflict that says how to proceed.
    fn resolve_skill_dirs(
        &mut self,
        dirs: Vec<layout::SkillDir>,
        item: &LibraryItem,
    ) -> Result<Vec<layout::SkillDir>> {
        let mut out: Vec<layout::SkillDir> = Vec::new();
        for dir in dirs {
            let at = format!("{}/{}", dir.base, item.name);
            let dir = match self.link_target(&at)? {
                None => dir,
                Some(target) => {
                    let other = [layout::AGENTS_SKILLS, layout::CLAUDE_SKILLS]
                        .into_iter()
                        .find(|b| *b != dir.base && target == format!("{b}/{}", item.name));
                    let Some(base) = other else {
                        self.conflicts.push(conflict(
                            &at,
                            ConflictKind::SymbolicLink,
                            &item.title,
                            format!(
                                "{at} is reached through a symbolic link to {target}. Habi installs skills only into {} and {}, and does not write through links. Point the link at {} instead, or replace it with a regular folder, then preview again.",
                                layout::AGENTS_SKILLS,
                                layout::CLAUDE_SKILLS,
                                layout::AGENTS_SKILLS
                            ),
                            vec![],
                            None,
                        ));
                        continue;
                    };
                    self.notes.push(format!(
                        "{at} is a symbolic link to {target}, so the copy in {base} also serves {}. Habi writes it there, not through the link.",
                        clients_phrase(&dir.clients)
                    ));
                    layout::SkillDir {
                        base,
                        clients: dir.clients,
                    }
                }
            };
            match out.iter_mut().find(|d| d.base == dir.base) {
                Some(same) => {
                    same.clients.extend(dir.clients);
                    same.clients.sort();
                    same.clients.dedup();
                }
                None => out.push(dir),
            }
        }
        Ok(out)
    }

    fn install_instructions(
        &mut self,
        p: &Payload,
        clients: &[ClientId],
        existing: Option<&LockedItem>,
    ) -> Result<LockedItem> {
        let item = &p.item;
        if !item.complete {
            return Err(HabiError::invalid(format!(
                "`{}` is incomplete in the library and cannot be installed",
                item.title
            )));
        }
        let body = p
            .files
            .first()
            .map(|f| String::from_utf8_lossy(&f.bytes).into_owned())
            .unwrap_or_default();
        if body
            .lines()
            .any(|l| l.contains("<!-- habi:begin") || l.contains("<!-- habi:end"))
        {
            return Err(HabiError::invalid(format!(
                "`{}` contains Habi section markers in its text and cannot be installed safely",
                item.title
            )));
        }
        // Section markers are item ids, so two sources can ship the same id.
        // One section cannot belong to two items: removing either would
        // delete the text the other still relies on.
        if let Some(owner) = self
            .lock
            .section_owner(INSTRUCTIONS_FILE, &item.id)
            .filter(|o| o.key() != p.key())
        {
            self.conflicts.push(conflict(
                &section_key(INSTRUCTIONS_FILE, &item.id),
                ConflictKind::PathCollision,
                &item.title,
                format!(
                    "The `{id}` section of {INSTRUCTIONS_FILE} is already installed by `{}` from {}, and `{}` from {} uses the same id. Only one of them can be installed in this project: remove `{}` first, or leave `{}` out of this install.",
                    owner.title,
                    owner.source.name,
                    item.title,
                    p.source.name,
                    owner.title,
                    item.title,
                    id = item.id,
                ),
                vec![],
                None,
            ));
            return Ok(LockedItem {
                source: p.source.clone(),
                id: item.id.clone(),
                kind: ItemKind::Instructions,
                title: item.title.clone(),
                snapshot: p.snapshot.clone(),
                content_digest: item.content_digest.clone(),
                installed_at: crate::time::now(),
                clients: clients.to_vec(),
                files: Vec::new(),
                sections: existing.map(|e| e.sections.clone()).unwrap_or_default(),
                mcp: Vec::new(),
            });
        }
        let baseline = existing
            .and_then(|e| e.sections.first())
            .map(|s| s.digest.clone());
        let created = match existing.and_then(|e| e.sections.first()) {
            Some(s) => s.created,
            None => Some(self.created_by_habi(INSTRUCTIONS_FILE)?),
        };
        let note = format!("from {} — managed by Habi", p.source.name);
        let readers: Vec<ClientId> = clients
            .iter()
            .copied()
            .filter(|c| !matches!(c, ClientId::ClaudeCode | ClientId::GeminiCli))
            .collect();
        let why = "Codex, Cursor, GitHub Copilot, OpenCode and Junie read AGENTS.md natively; Claude Code reads it through the CLAUDE.md import.";
        let digest = self.put_section(
            INSTRUCTIONS_FILE,
            &item.id,
            &body,
            baseline.as_deref(),
            &item.title,
            &readers,
            ChangeKind::InstructionsSection,
            &note,
            why,
        )?;
        Ok(LockedItem {
            source: p.source.clone(),
            id: item.id.clone(),
            kind: ItemKind::Instructions,
            title: item.title.clone(),
            snapshot: p.snapshot.clone(),
            content_digest: item.content_digest.clone(),
            installed_at: crate::time::now(),
            clients: clients.to_vec(),
            files: Vec::new(),
            sections: digest
                .map(|d| {
                    vec![LockedSection {
                        file: INSTRUCTIONS_FILE.into(),
                        marker: item.id.clone(),
                        digest: d,
                        created,
                    }]
                })
                .unwrap_or_default(),
            mcp: existing.map(|e| e.mcp.clone()).unwrap_or_default(),
        })
    }

    fn add_mcp(
        &mut self,
        p: &Payload,
        clients: &[ClientId],
        locked: &mut LockedItem,
        only: Option<&BTreeSet<String>>,
    ) -> Result<()> {
        for requirement in &p.item.mcp {
            if only.is_some_and(|names| !names.contains(&requirement.name)) {
                continue;
            }
            let Some(spec) = &requirement.server else {
                self.notes.push(format!(
                    "`{}` needs the MCP server `{}`, but the library does not suggest a configuration; set it up in your client.",
                    p.item.title, requirement.name
                ));
                continue;
            };
            // Clients that read one file (Claude Code and GitHub Copilot read
            // `.mcp.json`) are configured once.
            let mut handled: Vec<&str> = Vec::new();
            for &client in clients {
                let file = mcp::config_path(client);
                if handled.contains(&file) {
                    self.notes.push(format!(
                        "{} reads the same {file}, so the `{}` MCP server is configured once for both.",
                        client.label(),
                        requirement.name
                    ));
                    continue;
                }
                handled.push(file);
                if locked
                    .mcp
                    .iter()
                    .any(|m| m.file == file && m.server == requirement.name)
                {
                    continue;
                }
                // Another installed item (possibly earlier in this plan) has
                // Habi's entry for this server: share it, so it stays until
                // no installed item needs it.
                if let Some((owner, entry)) =
                    self.mcp_owner(client, &requirement.name, &locked.key())
                {
                    let added_here = !self.original_lock.find(&owner.key()).is_some_and(|o| {
                        o.mcp
                            .iter()
                            .any(|m| m.file == file && m.server == requirement.name)
                    });
                    self.notes.push(if added_here {
                        format!(
                            "`{}` also uses the `{}` MCP server this plan adds to {file} for `{}`; it is configured once and kept while either is installed.",
                            p.item.title, requirement.name, owner.title
                        )
                    } else {
                        format!(
                            "{} already has the `{}` MCP server in {file}, added by Habi for `{}`; `{}` uses it too.",
                            client.label(),
                            requirement.name,
                            owner.title,
                            p.item.title
                        )
                    });
                    locked.mcp.push(entry);
                    continue;
                }
                let existing = self.ws.read(file)?;
                match mcp::is_configured(client, existing.as_deref(), &requirement.name) {
                    Ok(true) => {
                        self.notes.push(format!(
                            "{} already configures the MCP server `{}` in {file}; left unchanged.",
                            client.label(),
                            requirement.name
                        ));
                        continue;
                    }
                    Ok(false) => {}
                    Err(e) => {
                        if self.decision(file) == Some(Resolution::Keep) {
                            self.notes.push(format!(
                                "Left {file} unchanged; add the `{}` MCP server for {} yourself once the file is fixed.",
                                requirement.name,
                                client.label()
                            ));
                        } else {
                            let way_out = if only.is_some() {
                                "turn off adding the newly suggested MCP configuration"
                            } else {
                                "turn off “Add suggested MCP configuration”"
                            };
                            self.conflicts.push(conflict(
                                file,
                                ConflictKind::InvalidConfig,
                                &p.item.title,
                                format!(
                                    "{e}. Fix the file and preview again, choose to leave it unchanged (the `{}` server is then not added for {}), or {way_out}.",
                                    requirement.name,
                                    client.label()
                                ),
                                vec![Resolution::Keep],
                                None,
                            ));
                        }
                        continue;
                    }
                }
                let created = self.created_by_habi(file)?;
                let (content, digest) =
                    mcp::insert(client, existing.as_deref(), &requirement.name, spec)?;
                let mut why = vec![format!(
                    "Adds the `{}` MCP server for {}.",
                    requirement.name,
                    client.label()
                )];
                if existing.is_some() && client != ClientId::Codex {
                    why.push(
                        "Habi rewrites this file with standard JSON formatting; review the diff."
                            .into(),
                    );
                }
                why.extend(mcp::translation_notes(client, spec));
                self.ws.write(
                    file,
                    Some(content),
                    ChangeKind::McpConfig,
                    &p.item.title,
                    &[client],
                    &why.join(" "),
                )?;
                locked.mcp.push(LockedMcpEntry {
                    client,
                    file: file.into(),
                    server: requirement.name.clone(),
                    digest,
                    created: Some(created),
                });
            }
        }
        Ok(())
    }

    /// Another lock item (not `except`) with Habi's entry for `server` in
    /// `client`'s configuration, and that entry.
    fn mcp_owner(
        &self,
        client: ClientId,
        server: &str,
        except: &str,
    ) -> Option<(LockedItem, LockedMcpEntry)> {
        self.lock
            .items
            .iter()
            .filter(|i| i.key() != except)
            .find_map(|i| {
                i.mcp
                    .iter()
                    .find(|m| m.file == mcp::config_path(client) && m.server == server)
                    .map(|m| (i.clone(), m.clone()))
            })
    }

    fn remove_mcp(&mut self, locked: &LockedItem) -> Result<()> {
        for entry in &locked.mcp {
            self.remove_mcp_entry(entry, locked)?;
        }
        Ok(())
    }

    /// Removes one server Habi added for `locked`, unless another installed
    /// item still uses it or someone changed it since.
    fn remove_mcp_entry(&mut self, entry: &LockedMcpEntry, locked: &LockedItem) -> Result<()> {
        if let Some((other, _)) = self.mcp_owner(entry.client, &entry.server, &locked.key()) {
            self.notes.push(format!(
                "The `{}` MCP server in {} stays: `{}` uses it too.",
                entry.server, entry.file, other.title
            ));
            return Ok(());
        }
        let Some(existing) = self.ws.read(&entry.file)? else {
            return Ok(());
        };
        match mcp::remove(entry.client, &existing, &entry.server, &entry.digest) {
            Ok(Some(updated)) if updated != existing => {
                if entry.created == Some(true) && mcp::is_empty_config(entry.client, &updated) {
                    self.ws.write(
                        &entry.file,
                        None,
                        ChangeKind::McpConfig,
                        &locked.title,
                        &[entry.client],
                        &format!(
                            "Removes the `{}` MCP server Habi added; Habi created this file and nothing else is in it.",
                            entry.server
                        ),
                    )?;
                } else {
                    let mut why = format!(
                        "Removes the `{}` MCP server Habi added; other servers are unchanged.",
                        entry.server
                    );
                    if entry.client != ClientId::Codex {
                        why.push_str(
                            " Habi rewrites this file with standard JSON formatting; review the diff.",
                        );
                    }
                    self.ws.write(
                        &entry.file,
                        Some(updated),
                        ChangeKind::McpConfig,
                        &locked.title,
                        &[entry.client],
                        &why,
                    )?;
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => self.notes.push(format!(
                "The `{}` MCP server in {} changed since Habi added it; left in place.",
                entry.server, entry.file
            )),
            Err(e) => self.notes.push(format!(
                "Could not update {}: {e}. The `{}` MCP server was left in place; remove it by hand if you no longer need it.",
                entry.file, entry.server
            )),
        }
        Ok(())
    }

    /// Brings the MCP servers Habi added for an item in line with an update:
    /// a changed definition replaces the entry Habi wrote (if nobody edited
    /// it), and a server the item no longer needs is removed. A server the
    /// item newly suggests is reported, and added only if `add_new`.
    fn update_mcp(&mut self, p: &Payload, locked: &mut LockedItem, add_new: bool) -> Result<()> {
        // Installed with "Add suggested MCP configuration".
        let opted_in = !locked.mcp.is_empty();
        let mut kept = Vec::new();
        for entry in std::mem::take(&mut locked.mcp) {
            let requirement = p.item.mcp.iter().find(|r| r.name == entry.server);
            let Some(requirement) = requirement else {
                self.notes.push(format!(
                    "`{}` no longer needs the `{}` MCP server.",
                    p.item.title, entry.server
                ));
                self.remove_mcp_entry(&entry, locked)?;
                continue;
            };
            let Some(spec) = &requirement.server else {
                kept.push(entry);
                continue;
            };
            let Some(current) = self.ws.read(&entry.file)? else {
                kept.push(entry);
                continue;
            };
            match mcp::replace(entry.client, &current, &entry.server, spec, &entry.digest) {
                Ok(Some((content, digest))) => {
                    if content != current {
                        let mut why = vec![format!(
                            "Updates the `{}` MCP server to the library's new definition.",
                            entry.server
                        )];
                        if entry.client != ClientId::Codex {
                            why.push(
                                "Habi rewrites this file with standard JSON formatting; review the diff."
                                    .into(),
                            );
                        }
                        why.extend(mcp::translation_notes(entry.client, spec));
                        self.ws.write(
                            &entry.file,
                            Some(content),
                            ChangeKind::McpConfig,
                            &p.item.title,
                            &[entry.client],
                            &why.join(" "),
                        )?;
                    }
                    // Items sharing this entry now share the new definition.
                    for other in &mut self.lock.items {
                        for m in &mut other.mcp {
                            if m.file == entry.file
                                && m.server == entry.server
                                && m.digest == entry.digest
                            {
                                m.digest = digest.clone();
                            }
                        }
                    }
                    kept.push(LockedMcpEntry { digest, ..entry });
                }
                Ok(None) => {
                    if mcp::spec_digest(entry.client, &entry.server, spec)? != entry.digest {
                        self.notes.push(format!(
                            "The library changed the `{}` MCP server, but the entry in {} was edited or removed since Habi added it, so it was left as is. Compare it with the library's definition and update it by hand.",
                            entry.server, entry.file
                        ));
                    }
                    kept.push(entry);
                }
                Err(e) => {
                    self.notes.push(format!(
                        "Could not update {}: {e}. The `{}` MCP server was left as is.",
                        entry.file, entry.server
                    ));
                    kept.push(entry);
                }
            }
        }
        locked.mcp = kept;
        let newly: BTreeSet<String> = p
            .item
            .mcp
            .iter()
            .filter(|r| {
                opted_in && r.server.is_some() && !locked.mcp.iter().any(|m| m.server == r.name)
            })
            .map(|r| r.name.clone())
            .collect();
        for server in &newly {
            self.mcp_suggestions.push(McpSuggestion {
                item: p.item.title.clone(),
                server: server.clone(),
                added: add_new,
            });
        }
        if add_new && !newly.is_empty() {
            let clients = locked.clients.clone();
            self.add_mcp(p, &clients, locked, Some(&newly))?;
        }
        Ok(())
    }

    /// Handles an import file (CLAUDE.md for Claude Code) that is a symbolic
    /// link inside the project. Returns true if that settles the bridge: a
    /// link to AGENTS.md already makes the client read the instructions; a link
    /// elsewhere is a conflict (Habi does not write through links) unless the
    /// user keeps it as is.
    fn bridge_through_link(&mut self, bridge: &Bridge) -> Result<bool> {
        let label = bridge.client.label();
        let Some(&(first, first_import)) = bridge.files.first() else {
            return Ok(false);
        };
        let title = format!("{label} bridge");
        for &(candidate, _) in bridge.files {
            if candidate != first && self.ws.read(first)?.is_some() {
                break;
            }
            let Some(target) = self.link_target(candidate)? else {
                continue;
            };
            if target == INSTRUCTIONS_FILE {
                self.notes.push(format!(
                    "{candidate} is a symbolic link to {INSTRUCTIONS_FILE}, so {label} reads the instructions directly; no import is needed."
                ));
                return Ok(true);
            }
            if self.ws.read(&target)?.is_none() {
                // The link leads to a folder without the file: nothing to bridge there.
                continue;
            }
            if self.decision(candidate) == Some(Resolution::Keep) {
                self.notes.push(format!(
                    "{candidate} was left as it is; until it imports {INSTRUCTIONS_FILE}, {label} does not read the instructions Habi installs there."
                ));
            } else {
                self.conflicts.push(conflict(
                    candidate,
                    ConflictKind::SymbolicLink,
                    &title,
                    format!(
                        "{candidate} is a symbolic link to {target}. {label} needs the line `{first_import}` there to read the instructions, but Habi does not write through links. Add that line to {target} yourself, or replace the link with a regular file, then preview again; or leave it as it is."
                    ),
                    vec![Resolution::Keep],
                    None,
                ));
            }
            return Ok(true);
        }
        Ok(false)
    }

    /// Ensures (or removes) each client's import of AGENTS.md depending on
    /// whether any instructions are installed for that client.
    fn reconcile_bridge(&mut self) -> Result<()> {
        for bridge in &BRIDGES {
            self.reconcile_one_bridge(bridge)?;
        }
        Ok(())
    }

    fn reconcile_one_bridge(&mut self, bridge: &Bridge) -> Result<()> {
        let label = bridge.client.label();
        let title = format!("{label} bridge");
        let needed = self.lock.items.iter().any(|i| {
            i.kind == ItemKind::Instructions
                && i.source.identity != BRIDGE_IDENTITY
                && i.clients.contains(&bridge.client)
        });
        let key = lock_key(BRIDGE_IDENTITY, bridge.id);
        let present = self.lock.find(&key).cloned();
        match (needed, present) {
            (true, None) => {
                if self.bridge_through_link(bridge)? {
                    return Ok(());
                }
                let Some(&(default_file, default_import)) = bridge.files.first() else {
                    return Ok(());
                };
                let mut chosen = (default_file, default_import);
                for &(file, import) in bridge.files {
                    if self.ws.read(file)?.is_some() {
                        chosen = (file, import);
                        break;
                    }
                }
                let (file, import) = chosen;
                let text = self.ws.read_text(file)?.unwrap_or_default();
                if text
                    .lines()
                    .any(|l| l.trim_start_matches('\u{feff}').trim() == import)
                {
                    self.notes.push(format!(
                        "{file} already imports AGENTS.md, so {label} will read the instructions."
                    ));
                    return Ok(());
                }
                let created = Some(self.created_by_habi(file)?);
                let digest = self.put_section(
                    file,
                    bridge.id,
                    import,
                    None,
                    &title,
                    &[bridge.client],
                    bridge.kind,
                    &format!("lets {label} read AGENTS.md"),
                    bridge.why,
                )?;
                if let Some(digest) = digest {
                    self.lock.items.push(LockedItem {
                        source: LockedSource {
                            identity: BRIDGE_IDENTITY.into(),
                            name: brand::APP_NAME.into(),
                            subdir: None,
                        },
                        id: bridge.id.into(),
                        kind: ItemKind::Instructions,
                        title: format!("{label} import of AGENTS.md"),
                        snapshot: String::new(),
                        content_digest: String::new(),
                        installed_at: crate::time::now(),
                        clients: vec![bridge.client],
                        files: Vec::new(),
                        sections: vec![LockedSection {
                            file: file.into(),
                            marker: bridge.id.into(),
                            digest,
                            created,
                        }],
                        mcp: Vec::new(),
                    });
                }
            }
            (false, Some(installed)) => {
                for s in &installed.sections {
                    self.remove_section(
                        &s.file,
                        &s.marker,
                        &s.digest,
                        s.created,
                        &installed.title,
                        bridge.kind,
                    )?;
                }
                self.lock.items.retain(|i| i.key() != key);
            }
            _ => {}
        }
        Ok(())
    }

    fn upsert_lock(&mut self, item: LockedItem) {
        let key = item.key();
        self.lock.items.retain(|i| i.key() != key);
        self.lock.items.push(item);
    }

    /// Recomputes the lock for a restore. `before` and `after` are the lock
    /// as the restored operation found and left it. Items it did not change
    /// keep their current entries, and so do items a later operation changed
    /// again. The others go back to their `before` entries, keeping only what
    /// the restore actually leaves on disk.
    fn restore_lock(&mut self, before: &LockFile, after: &LockFile) -> Result<()> {
        let keys: BTreeSet<String> = before
            .items
            .iter()
            .chain(&after.items)
            .map(|i| i.key())
            .collect();
        for key in keys {
            let (was, became) = (before.find(&key), after.find(&key));
            if was == became {
                continue;
            }
            let current = self.lock.find(&key).cloned();
            let restored = if current.as_ref() != became {
                // Changed again later: keep tracking it as it is now, minus
                // what this restore removes.
                let Some(c) = &current else {
                    continue;
                };
                self.notes.push(format!(
                    "`{}` was changed again by a later operation; Habi keeps tracking it as it is now.",
                    c.title
                ));
                self.restored_entry(c, None)?
            } else {
                match was {
                    None => {
                        self.lock.items.retain(|i| i.key() != key);
                        continue;
                    }
                    Some(was) => self.restored_entry(was, current.as_ref())?,
                }
            };
            if restored.files.is_empty() && restored.sections.is_empty() && restored.mcp.is_empty()
            {
                self.lock.items.retain(|i| i.key() != key);
            } else {
                self.upsert_lock(restored);
            }
        }
        Ok(())
    }

    /// `was` limited to what is on disk once the restore is applied: files
    /// that stay absent are dropped, files kept with other content keep their
    /// current entry if that matches, sections and MCP servers that are gone
    /// are dropped.
    fn restored_entry(
        &mut self,
        was: &LockedItem,
        current: Option<&LockedItem>,
    ) -> Result<LockedItem> {
        let mut item = was.clone();
        let mut files = Vec::new();
        for f in &was.files {
            let Some(bytes) = self.ws.read(&f.path)? else {
                continue;
            };
            if digest_matches(&bytes, &f.digest) {
                files.push(f.clone());
            } else if let Some(now) = current
                .and_then(|c| c.files.iter().find(|n| n.path == f.path))
                .filter(|n| digest_matches(&bytes, &n.digest))
            {
                files.push(now.clone());
            } else {
                // Kept with other content: shown as edited locally.
                files.push(f.clone());
            }
        }
        item.files = files;
        let mut kept_sections = Vec::new();
        for s in &was.sections {
            let text = self.ws.read_text(&s.file).ok().flatten();
            if text.is_some_and(|t| !matches!(sections::find(&t, &s.marker), Ok(None))) {
                kept_sections.push(s.clone());
            }
        }
        item.sections = kept_sections;
        let mut kept_mcp = Vec::new();
        for m in &was.mcp {
            let content = self.ws.read(&m.file)?;
            if !matches!(
                mcp::is_configured(m.client, content.as_deref(), &m.server),
                Ok(false)
            ) {
                kept_mcp.push(m.clone());
            }
        }
        item.mcp = kept_mcp;
        Ok(item)
    }

    fn finish(mut self, root: &Path, action: PlanAction, title: String) -> Result<Plan> {
        if action != PlanAction::Restore {
            self.reconcile_bridge()?;
        }
        if self.lock != self.original_lock {
            let content = if self.lock.items.is_empty() {
                None
            } else {
                Some(self.lock.to_bytes())
            };
            self.ws.write(
                brand::LOCK_FILE,
                content,
                ChangeKind::LockFile,
                "",
                &[],
                match self.scope {
                    Scope::Project => "Records what Habi installed (sources, versions, file digests) so it can detect updates and local edits. Safe to commit; contains no absolute paths or secrets.",
                    Scope::Machine => "Records what Habi installed on this machine (sources, versions, file digests) so it can detect updates and local edits. Personal to this machine; contains no absolute paths or secrets.",
                },
            )?;
        }
        // Codex stops reading instructions after 32 KiB, and Habi appends its
        // sections at the end of AGENTS.md, so they are the first to be cut.
        if let Some(Some(agents)) = self.ws.staged.get(INSTRUCTIONS_FILE)
            && agents.len() > CODEX_INSTRUCTIONS_LIMIT
        {
            self.notes.push(format!(
                "{INSTRUCTIONS_FILE} would be {} KiB. Codex reads at most 32 KiB of instructions by default (`project_doc_max_bytes`) and ignores the rest; Habi's sections are at the end of the file, so they are the first to be cut. Shorten the file or raise `project_doc_max_bytes` in your Codex configuration.",
                agents.len().div_ceil(1024)
            ));
        }
        let changes = self.ws.into_changes()?;
        Ok(Plan {
            id: uuid::Uuid::new_v4().to_string(),
            action,
            title,
            project: crate::paths::display_path(root),
            created_at: crate::time::now(),
            items: self.items,
            changes,
            conflicts: self.conflicts,
            notes: dedup(self.notes),
            mcp_suggestions: self.mcp_suggestions,
            recovery: match self.scope {
                // Plain text: the desktop shows it as is, so no Markdown backticks.
                Scope::Project => "Replaced or deleted files are kept. Restore them from the project's history, or with habi restore.".into(),
                Scope::Machine => "Replaced or deleted files are kept, and can be restored.".into(),
            },
            root: root.to_path_buf(),
        })
    }
}

fn damaged_markers_message(file: &str, e: &HabiError) -> String {
    format!(
        "{e}. Open {file} and repair or delete the `<!-- habi:begin … -->` / `<!-- habi:end … -->` lines for this section (keep the text you want), then preview again."
    )
}

/// Decision key for a managed section: `<file>#<marker>`, so each section in
/// a file can be kept or overwritten independently.
pub fn section_key(file: &str, marker: &str) -> String {
    format!("{file}#{marker}")
}

fn dedup(mut v: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    v.retain(|x| seen.insert(x.clone()));
    v
}

fn clients_phrase(clients: &[ClientId]) -> String {
    let names: Vec<&str> = clients.iter().map(|c| c.label()).collect();
    match names.as_slice() {
        [] => "no client".into(),
        [one] => (*one).to_string(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Clients the item can be installed for, with notes about the rest.
fn compatible_clients(item: &LibraryItem, requested: &[ClientId]) -> (Vec<ClientId>, Vec<String>) {
    let mut notes = Vec::new();
    let clients: Vec<ClientId> = match &item.clients {
        None => requested.to_vec(),
        Some(declared) => requested
            .iter()
            .copied()
            .filter(|c| {
                let ok = declared.contains(c);
                if !ok {
                    notes.push(format!(
                        "`{}` is not declared compatible with {}; skipped for that client.",
                        item.title,
                        c.label()
                    ));
                }
                ok
            })
            .collect(),
    };
    (clients, notes)
}

/// Plans installing `payloads` for `clients`. Re-installing an installed
/// item is idempotent; installing an item whose upstream changed behaves
/// like an update (three-way).
pub fn plan_install(
    root: &Path,
    payloads: &[Payload],
    clients: &[ClientId],
    include_mcp: bool,
    decisions: &Decisions,
) -> Result<Plan> {
    install_in(
        root,
        payloads,
        clients,
        include_mcp,
        decisions,
        Scope::Project,
    )
}

/// Plans installing skills into the person's own skill folders under `home`
/// (`~/.claude/skills`, `~/.agents/skills`), recorded in `~/.habi/lock.json`.
/// Skills only: instruction files and MCP configuration are never written
/// outside a project.
pub fn plan_install_on_machine(
    home: &Path,
    payloads: &[Payload],
    clients: &[ClientId],
    decisions: &Decisions,
) -> Result<Plan> {
    if let Some(p) = payloads
        .iter()
        .find(|p| p.item.kind == ItemKind::Instructions)
    {
        return Err(HabiError::invalid(format!(
            "`{}` is an instruction file; Habi adds those to a project, not to this machine",
            p.item.title
        )));
    }
    install_in(home, payloads, clients, false, decisions, Scope::Machine)
}

fn install_in(
    root: &Path,
    payloads: &[Payload],
    clients: &[ClientId],
    include_mcp: bool,
    decisions: &Decisions,
    scope: Scope,
) -> Result<Plan> {
    if clients.is_empty() {
        return Err(HabiError::invalid("choose at least one client"));
    }
    let mut planner = Planner::new(root, decisions, scope)?;
    let mut all_clients = BTreeSet::new();
    for p in payloads {
        let (mut wanted, notes) = compatible_clients(&p.item, clients);
        planner.notes.extend(notes);
        let existing = planner.lock.find(&p.key()).cloned();
        if let Some(e) = &existing {
            for c in &e.clients {
                if !wanted.contains(c) {
                    wanted.push(*c);
                }
            }
            wanted.sort();
        }
        if wanted.is_empty() {
            continue;
        }
        all_clients.extend(wanted.iter().copied());
        let mut locked = match p.item.kind {
            ItemKind::Instructions => {
                planner.install_instructions(p, &wanted, existing.as_ref())?
            }
            _ => planner.install_skill(p, &wanted, existing.as_ref())?,
        };
        if include_mcp {
            planner.add_mcp(p, &wanted, &mut locked, None)?;
        }
        // Keep the original install time when nothing about the item changed.
        if let Some(e) = &existing
            && e.content_digest == locked.content_digest
            && e.files == locked.files
            && e.sections == locked.sections
            && e.mcp == locked.mcp
            && e.clients == locked.clients
        {
            locked.installed_at = e.installed_at.clone();
            locked.snapshot = e.snapshot.clone();
        }
        planner.items.push(PlanItem {
            key: p.key(),
            title: p.item.title.clone(),
            kind: p.item.kind,
            source: p.source.name.clone(),
            version: short(&p.snapshot).to_string(),
            clients: wanted.clone(),
            notes: Vec::new(),
        });
        planner.upsert_lock(locked);
    }
    let clients: Vec<ClientId> = all_clients.into_iter().collect();
    let title = format!("Install for {} {}", clients_phrase(&clients), scope.on());
    planner.finish(root, PlanAction::Install, title)
}

/// Plans updating installed items to the given payloads (same clients).
pub fn plan_update(
    root: &Path,
    payloads: &[Payload],
    add_mcp: bool,
    decisions: &Decisions,
) -> Result<Plan> {
    update_in(root, payloads, add_mcp, decisions, Scope::Project)
}

/// `plan_update` for skills installed on this machine.
pub fn plan_update_on_machine(
    home: &Path,
    payloads: &[Payload],
    decisions: &Decisions,
) -> Result<Plan> {
    update_in(home, payloads, false, decisions, Scope::Machine)
}

fn update_in(
    root: &Path,
    payloads: &[Payload],
    add_mcp: bool,
    decisions: &Decisions,
    scope: Scope,
) -> Result<Plan> {
    let mut planner = Planner::new(root, decisions, scope)?;
    for p in payloads {
        let Some(existing) = planner.lock.find(&p.key()).cloned() else {
            return Err(HabiError::NotFound(format!(
                "`{}` is not installed on {}",
                p.item.title,
                scope.here()
            )));
        };
        let clients = existing.clients.clone();
        let mut locked = match p.item.kind {
            ItemKind::Instructions => planner.install_instructions(p, &clients, Some(&existing))?,
            _ => planner.install_skill(p, &clients, Some(&existing))?,
        };
        planner.update_mcp(p, &mut locked, add_mcp)?;
        planner.items.push(PlanItem {
            key: p.key(),
            title: p.item.title.clone(),
            kind: p.item.kind,
            source: p.source.name.clone(),
            version: format!("{} → {}", short(&existing.snapshot), short(&p.snapshot)),
            clients: clients.clone(),
            notes: Vec::new(),
        });
        planner.upsert_lock(locked);
    }
    planner.finish(
        root,
        PlanAction::Update,
        format!("Adopt the reviewed update {}", scope.on()),
    )
}

/// Plans removing installed items. Only unchanged, Habi-managed content is
/// deleted unless the user explicitly chooses otherwise per file.
pub fn plan_remove(root: &Path, keys: &[String], decisions: &Decisions) -> Result<Plan> {
    remove_in(root, keys, decisions, Scope::Project)
}

/// `plan_remove` for skills installed on this machine. Only files Habi
/// installed (and recorded) are deleted; anything added to those folders stays.
pub fn plan_remove_on_machine(home: &Path, keys: &[String], decisions: &Decisions) -> Result<Plan> {
    remove_in(home, keys, decisions, Scope::Machine)
}

fn remove_in(root: &Path, keys: &[String], decisions: &Decisions, scope: Scope) -> Result<Plan> {
    let mut planner = Planner::new(root, decisions, scope)?;
    for key in keys {
        let Some(existing) = planner.lock.find(key).cloned() else {
            return Err(HabiError::NotFound(format!("installed item {key}")));
        };
        let mut remaining = Vec::new();
        for f in &existing.files {
            if !planner.delete_file(
                &f.path,
                &f.digest,
                &existing.title,
                &f.clients,
                "Removes a file Habi installed.",
            )? {
                remaining.push(f.clone());
            }
        }
        for s in &existing.sections {
            // Lock files written before sections were checked for collisions
            // may record one section for two items: leave it for the other.
            if let Some(other) = planner.lock.items.iter().find(|i| {
                &i.key() != key
                    && i.sections
                        .iter()
                        .any(|o| o.file == s.file && o.marker == s.marker)
            }) {
                planner.notes.push(format!(
                    "The `{}` section of {} is also recorded for `{}` from {}; it stays in place.",
                    s.marker, s.file, other.title, other.source.name
                ));
                continue;
            }
            planner.remove_section(
                &s.file,
                &s.marker,
                &s.digest,
                s.created,
                &existing.title,
                ChangeKind::InstructionsSection,
            )?;
        }
        planner.remove_mcp(&existing)?;
        planner.items.push(PlanItem {
            key: key.clone(),
            title: existing.title.clone(),
            kind: existing.kind,
            source: existing.source.name.clone(),
            version: short(&existing.snapshot).to_string(),
            clients: existing.clients.clone(),
            notes: Vec::new(),
        });
        planner.lock.items.retain(|i| &i.key() != key);
    }
    planner.finish(
        root,
        PlanAction::Remove,
        format!("Remove from {}", scope.here()),
    )
}

/// A file to restore: put `content` back if the file still has `expected`.
pub struct RestoreStep {
    pub path: String,
    /// Digest Habi wrote (what should be on disk now).
    pub expected: Option<String>,
    /// Content to restore (`None` = the file did not exist).
    pub content: Option<Vec<u8>>,
    /// Whether the file was executable before the operation, if known.
    pub executable: Option<bool>,
    /// What the operation wrote. Only provided for the lock file, which is
    /// recomputed rather than restored.
    pub written: Option<Vec<u8>>,
}

/// Plans restoring files from a journal. Files edited since the operation
/// become conflicts. The lock file is not restored as a file: later
/// operations may have changed it too, so the entries the operation changed
/// are recomputed from what the restore leaves on disk.
pub fn plan_restore(
    root: &Path,
    steps: &[RestoreStep],
    label: &str,
    decisions: &Decisions,
) -> Result<Plan> {
    restore_in(root, steps, label, decisions, Scope::Project)
}

/// `plan_restore` for an operation on this machine.
pub fn plan_restore_on_machine(
    home: &Path,
    steps: &[RestoreStep],
    label: &str,
    decisions: &Decisions,
) -> Result<Plan> {
    restore_in(home, steps, label, decisions, Scope::Machine)
}

fn restore_in(
    root: &Path,
    steps: &[RestoreStep],
    label: &str,
    decisions: &Decisions,
    scope: Scope,
) -> Result<Plan> {
    let mut planner = Planner::new(root, decisions, scope)?;
    let mut lock_step = None;
    for step in steps {
        if step.path == brand::LOCK_FILE {
            lock_step = Some(step);
            continue;
        }
        let current = planner.ws.read(&step.path)?;
        let unchanged = match (&current, &step.content) {
            (None, None) => true,
            (Some(c), Some(t)) => same_text(c, t),
            _ => false,
        };
        if unchanged {
            // A case-only rename leaves the content as before but the file
            // under the new name, which a case-insensitive file system reads
            // as the old one too. Rename it back, if the operation wrote the
            // name it has now.
            if let (Some(content), Some(actual)) =
                (&step.content, planner.ws.spelled_differently(&step.path))
                && steps.iter().any(|s| s.path == actual)
            {
                let why = "Restores the file name's letter case from before the operation.";
                planner
                    .ws
                    .write(&actual, None, ChangeKind::Restore, label, &[], why)?;
                if let Some(executable) = step.executable {
                    planner.ws.modes.insert(step.path.clone(), executable);
                }
                planner.ws.forced.insert(step.path.clone());
                planner.ws.write(
                    &step.path,
                    Some(content.clone()),
                    ChangeKind::Restore,
                    label,
                    &[],
                    why,
                )?;
                continue;
            }
            // Content is as before; put back an executable bit the
            // operation changed.
            if let (Some(executable), Some(content)) = (step.executable, &step.content)
                && cfg!(unix)
                && planner.ws.on_disk_executable(&step.path) != executable
            {
                planner.ws.forced.insert(step.path.clone());
                planner.ws.modes.insert(step.path.clone(), executable);
                planner.ws.write(
                    &step.path,
                    Some(content.clone()),
                    ChangeKind::Restore,
                    label,
                    &[],
                    "Restores the file's executable bit from before the operation.",
                )?;
            }
            continue;
        }
        let as_written = match (&current, &step.expected) {
            (None, None) => true,
            (Some(c), Some(d)) => digest_matches(c, d),
            _ => false,
        };
        if !as_written && planner.decision(&step.path) != Some(Resolution::Overwrite) {
            if planner.decision(&step.path) == Some(Resolution::Keep) {
                continue;
            }
            planner.conflicts.push(conflict(
                &step.path,
                ConflictKind::LocalEdits,
                label,
                format!(
                    "{} changed after that operation; restoring would discard those edits.",
                    step.path
                ),
                vec![Resolution::Keep, Resolution::Overwrite],
                Some(diff(current.as_deref(), step.content.as_deref())),
            ));
            continue;
        }
        if let Some(executable) = step.executable {
            planner.ws.modes.insert(step.path.clone(), executable);
        }
        planner.ws.write(
            &step.path,
            step.content.clone(),
            ChangeKind::Restore,
            label,
            &[],
            "Restores the version from before the operation.",
        )?;
    }
    if let Some(step) = lock_step {
        let parse = |bytes: &Option<Vec<u8>>| match bytes {
            Some(b) => LockFile::parse(b),
            None => Ok(LockFile::default()),
        };
        planner.restore_lock(&parse(&step.content)?, &parse(&step.written)?)?;
    }
    let mut plan = planner.finish(
        root,
        PlanAction::Restore,
        format!("Restore files changed by “{label}”"),
    )?;
    plan.recovery = "Restoring is itself journaled and can be undone the same way.".into();
    Ok(plan)
}
