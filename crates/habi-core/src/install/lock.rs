//! The project lock file (`.habi/lock.json`).
//!
//! Records what Habi installed: which item, from which source (by a
//! credential-free, machine-independent identity), at which snapshot, for
//! which clients, and the digest of every file and section Habi wrote. It
//! contains no absolute paths and no secrets, so teams may commit it. Skills
//! keep working without it; it only lets Habi detect drift and updates.

use crate::clients::ClientId;
use crate::error::{HabiError, Result};
use crate::library::model::ItemKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const LOCK_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LockedSource {
    /// Normalized remote URL, or `local:<name>` for machine-local sources.
    pub identity: String,
    pub name: String,
    pub subdir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LockedFile {
    /// Project-relative path.
    pub path: String,
    pub digest: String,
    /// Clients this copy serves.
    pub clients: Vec<ClientId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LockedSection {
    /// Project-relative Markdown file (e.g. `AGENTS.md`).
    pub file: String,
    pub marker: String,
    pub digest: String,
    /// True if the file did not exist before Habi added this section, so Habi
    /// may delete it once no content is left. `None` in lock files written
    /// before this was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LockedMcpEntry {
    pub client: ClientId,
    pub file: String,
    pub server: String,
    /// Digest of the entry as Habi wrote it (canonical JSON).
    pub digest: String,
    /// True if the configuration file did not exist before Habi added an
    /// entry to it, so Habi may delete it once it is empty again. `None` in
    /// lock files written before this was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LockedItem {
    pub source: LockedSource,
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    /// Commit (Git) or content digest (folder) the item was installed from.
    pub snapshot: String,
    pub content_digest: String,
    pub installed_at: String,
    pub clients: Vec<ClientId>,
    #[serde(default)]
    pub files: Vec<LockedFile>,
    #[serde(default)]
    pub sections: Vec<LockedSection>,
    #[serde(default)]
    pub mcp: Vec<LockedMcpEntry>,
}

impl LockedItem {
    /// Stable key: source identity plus item id.
    pub fn key(&self) -> String {
        lock_key(&self.source.identity, &self.id)
    }
}

pub fn lock_key(identity: &str, id: &str) -> String {
    format!("{identity}#{id}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LockFile {
    pub habi_lock: u32,
    pub items: Vec<LockedItem>,
}

impl Default for LockFile {
    fn default() -> Self {
        LockFile {
            habi_lock: LOCK_VERSION,
            items: Vec::new(),
        }
    }
}

impl LockFile {
    pub fn parse(bytes: &[u8]) -> Result<LockFile> {
        let lock: LockFile = serde_json::from_slice(bytes).map_err(|e| {
            HabiError::Conflict(format!(
                "{} is not a valid Habi lock file ({e}). Fix or remove it before installing.",
                crate::brand::LOCK_FILE
            ))
        })?;
        if lock.habi_lock > LOCK_VERSION {
            return Err(HabiError::Unsupported(format!(
                "{} was written by a newer version of Habi (format {}).",
                crate::brand::LOCK_FILE,
                lock.habi_lock
            )));
        }
        // A lock file may be edited or committed by anyone, and Habi deletes
        // the files it lists. Confine every entry to locations Habi manages.
        let invalid = |what: &str| {
            HabiError::Conflict(format!(
                "{} lists {what}, which is not a location Habi manages. Fix or remove the lock file.",
                crate::brand::LOCK_FILE
            ))
        };
        for item in &lock.items {
            for f in &item.files {
                let rel = crate::paths::RelPath::new(&f.path)?;
                let under_skills = [
                    crate::clients::layout::AGENTS_SKILLS,
                    crate::clients::layout::CLAUDE_SKILLS,
                ]
                .iter()
                .any(|base| {
                    rel.as_str()
                        .strip_prefix(&format!("{base}/"))
                        .is_some_and(|rest| rest.contains('/'))
                });
                if !under_skills {
                    return Err(invalid(&format!("the file `{rel}`")));
                }
            }
            for sec in &item.sections {
                crate::paths::RelPath::new(&sec.file)?;
                if !["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"].contains(&sec.file.as_str()) {
                    return Err(invalid(&format!("a section in `{}`", sec.file)));
                }
            }
            for m in &item.mcp {
                if m.file != crate::clients::mcp::config_path(m.client) {
                    return Err(invalid(&format!("an MCP entry in `{}`", m.file)));
                }
            }
        }
        Ok(lock)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut sorted = self.clone();
        sorted.items.sort_by_key(|i| i.key());
        for item in &mut sorted.items {
            item.files.sort_by(|a, b| a.path.cmp(&b.path));
            item.clients.sort();
        }
        let mut text = serde_json::to_string_pretty(&sorted).expect("lock serializes");
        text.push('\n');
        text.into_bytes()
    }

    pub fn find(&self, key: &str) -> Option<&LockedItem> {
        self.items.iter().find(|i| i.key() == key)
    }

    /// Which item owns a project-relative file, if any.
    pub fn owner_of(&self, path: &str) -> Option<&LockedItem> {
        self.items
            .iter()
            .find(|i| i.files.iter().any(|f| f.path == path))
    }

    /// Which item owns the managed section `marker` in `file`, if any.
    pub fn section_owner(&self, file: &str, marker: &str) -> Option<&LockedItem> {
        self.items.iter().find(|i| {
            i.sections
                .iter()
                .any(|s| s.file == file && s.marker == marker)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_with_file(path: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "habiLock": 1,
            "items": [{
                "source": { "identity": "x", "name": "x", "subdir": null },
                "id": "a", "kind": "skill", "title": "A", "snapshot": "s",
                "contentDigest": "d", "installedAt": "t", "clients": ["codex"],
                "files": [{ "path": path, "digest": "sha256:00", "clients": ["codex"] }]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn lock_entries_are_confined_to_managed_locations() {
        assert!(LockFile::parse(&lock_with_file(".agents/skills/a/SKILL.md")).is_ok());
        assert!(LockFile::parse(&lock_with_file("README.md")).is_err());
        assert!(LockFile::parse(&lock_with_file(".agents/skills/SKILL.md")).is_err());
        assert!(LockFile::parse(&lock_with_file("../outside")).is_err());
    }
}
