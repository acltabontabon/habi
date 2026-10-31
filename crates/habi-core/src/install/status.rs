//! Installation status: what is installed, whether it was edited locally,
//! and whether the team library has a newer version.

use super::lock::LockedItem;
use super::plan::read_project_file;
use crate::clients::{layout, sections};
use crate::fsutil::digest_matches;
use crate::library::model::LibraryItem;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum InstallState {
    NotInstalled,
    /// Installed, unedited, same version as the library.
    Current,
    /// The library has a newer version; local files are unedited.
    UpdateAvailable,
    /// Local edits; the library has not changed those files.
    LocallyModified,
    /// Local edits to files the library also changed.
    Conflict,
    /// Installed, but its source is not connected on this machine.
    SourceUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FileState {
    Unchanged,
    Modified,
    Missing,
    /// In the skill's folder, and not something Habi installed.
    Added,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledFile {
    pub path: String,
    pub state: FileState,
    /// The library changed this file since it was installed.
    pub upstream_changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Installation {
    pub key: String,
    pub id: String,
    pub title: String,
    pub source_name: String,
    pub snapshot: String,
    pub installed_at: String,
    pub clients: Vec<crate::clients::ClientId>,
    pub state: InstallState,
    pub files: Vec<InstalledFile>,
    pub upstream_snapshot: Option<String>,
    /// The library's address as the lock file records it.
    #[serde(default)]
    pub source_identity: String,
    /// Who it came from, when the lock file says.
    #[serde(default)]
    pub provenance: Option<super::lock::Provenance>,
    /// What does not add up, in a sentence each.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Whether a file's executable bit is not what was installed. An older lock file
/// does not say, and a system without the bit has nothing to tell.
fn mode_changed(root: &Path, path: &str, executable: Option<bool>) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Some(expected) = executable else {
            return false;
        };
        std::fs::symlink_metadata(root.join(path))
            .is_ok_and(|m| m.is_file() && (m.permissions().mode() & 0o111 != 0) != expected)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path, executable);
        false
    }
}

/// Files in a skill's folders that the lock file does not list: dropped in after
/// it was installed, where an agent will read or run them. Bounded: a folder
/// with more than this has something else wrong, and is said so by what is listed.
fn added_files(root: &Path, locked: &LockedItem) -> Vec<String> {
    const MAX_LISTED: usize = 200;
    let listed: std::collections::HashSet<&str> =
        locked.files.iter().map(|f| f.path.as_str()).collect();
    let folders: std::collections::BTreeSet<String> = locked
        .files
        .iter()
        .filter_map(|f| {
            [layout::AGENTS_SKILLS, layout::CLAUDE_SKILLS]
                .iter()
                .find_map(|base| {
                    let rest = f.path.strip_prefix(&format!("{base}/"))?;
                    let (name, _) = rest.split_once('/')?;
                    Some(format!("{base}/{name}"))
                })
        })
        .collect();
    let mut added = Vec::new();
    for folder in folders {
        let mut queue = vec![folder];
        while let Some(dir) = queue.pop() {
            let Ok(entries) = std::fs::read_dir(root.join(&dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let rel = format!("{dir}/{}", entry.file_name().to_string_lossy());
                if kind.is_dir() {
                    queue.push(rel);
                } else if !listed.contains(rel.as_str())
                    && added.len() < MAX_LISTED
                    && entry.file_name() != ".DS_Store"
                {
                    added.push(rel);
                }
            }
        }
    }
    added.sort();
    added
}

fn file_state(root: &Path, path: &str, digest: &str) -> FileState {
    match read_project_file(root, path) {
        Ok(Some(bytes)) if digest_matches(&bytes, digest) => FileState::Unchanged,
        Ok(Some(_)) => FileState::Modified,
        Ok(None) => FileState::Missing,
        Err(_) => FileState::Modified,
    }
}

fn section_state(root: &Path, file: &str, marker: &str, digest: &str) -> FileState {
    let Ok(Some(bytes)) = read_project_file(root, file) else {
        return FileState::Missing;
    };
    let text = String::from_utf8_lossy(&bytes);
    match sections::find(&text, marker) {
        Ok(Some(span)) => {
            if sections::digest_matches(sections::content(&text, &span), digest) {
                FileState::Unchanged
            } else {
                FileState::Modified
            }
        }
        Ok(None) => FileState::Missing,
        Err(_) => FileState::Modified,
    }
}

/// Status of an installed item. `upstream` is the item in the current
/// library snapshot, or `None` if its source is not connected.
pub fn installation(
    root: &Path,
    locked: &LockedItem,
    upstream: Option<(&LibraryItem, &str)>,
) -> Installation {
    let upstream_files: HashMap<&str, &str> = upstream
        .map(|(item, _)| {
            item.files
                .iter()
                .map(|f| (f.path.as_str(), f.digest.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let upstream_changed_item =
        upstream.is_some_and(|(item, _)| item.content_digest != locked.content_digest);
    let mut files = Vec::new();
    for f in &locked.files {
        // `<base>/<name>/<rel>` -> `<rel>`
        let rel = [layout::AGENTS_SKILLS, layout::CLAUDE_SKILLS]
            .iter()
            .find_map(|base| f.path.strip_prefix(&format!("{base}/")))
            .and_then(|rest| rest.split_once('/').map(|(_, r)| r))
            .unwrap_or(&f.path);
        let upstream_changed =
            upstream_changed_item && upstream_files.get(rel).is_none_or(|d| *d != f.digest);
        let state = match file_state(root, &f.path, &f.digest) {
            FileState::Unchanged if mode_changed(root, &f.path, f.executable) => {
                FileState::Modified
            }
            state => state,
        };
        files.push(InstalledFile {
            path: f.path.clone(),
            state,
            upstream_changed,
        });
    }
    for path in added_files(root, locked) {
        files.push(InstalledFile {
            path,
            state: FileState::Added,
            upstream_changed: false,
        });
    }
    for s in &locked.sections {
        files.push(InstalledFile {
            path: format!("{} (section {})", s.file, s.marker),
            state: section_state(root, &s.file, &s.marker, &s.digest),
            upstream_changed: upstream_changed_item,
        });
    }
    let edited = files.iter().any(|f| f.state != FileState::Unchanged);
    let overlapping = files
        .iter()
        .any(|f| f.state != FileState::Unchanged && f.upstream_changed);
    let state = match (upstream.is_some(), upstream_changed_item, edited) {
        (false, _, _) => InstallState::SourceUnavailable,
        (true, true, true) if overlapping => InstallState::Conflict,
        (true, true, _) => InstallState::UpdateAvailable,
        (true, false, true) => InstallState::LocallyModified,
        (true, false, false) => InstallState::Current,
    };
    // At the same revision a library holds one thing: if the lock file says
    // otherwise, one of them is not what it claims.
    let mut warnings = Vec::new();
    let lock_disagrees = |locked: &LockedItem, item: &LibraryItem| {
        item.content_digest != locked.content_digest
            || locked.files.iter().any(|f| {
                [layout::AGENTS_SKILLS, layout::CLAUDE_SKILLS]
                    .iter()
                    .find_map(|base| f.path.strip_prefix(&format!("{base}/")))
                    .and_then(|rest| rest.split_once('/').map(|(_, rel)| rel))
                    .is_some_and(|rel| upstream_files.get(rel).is_some_and(|d| *d != f.digest))
            })
    };
    if let Some((item, snapshot)) = upstream
        && snapshot == locked.snapshot
        && lock_disagrees(locked, item)
    {
        warnings.push(format!(
            "The lock file records different content than `{}` has at this same revision. It may have been edited by hand.",
            locked.source.name
        ));
    }
    Installation {
        key: locked.key(),
        id: locked.id.clone(),
        title: locked.title.clone(),
        source_name: locked.source.name.clone(),
        snapshot: locked.snapshot.clone(),
        installed_at: locked.installed_at.clone(),
        clients: locked.clients.clone(),
        state,
        files,
        upstream_snapshot: upstream.map(|(_, s)| s.to_string()),
        source_identity: locked.source.identity.clone(),
        provenance: locked.provenance.clone(),
        warnings,
    }
}

/// Skill directories that exist in the project for `name` but are not
/// recorded in the lock file (installed by hand or by another tool).
pub fn unmanaged_copies(root: &Path, name: &str, lock: &super::lock::LockFile) -> Vec<String> {
    SkillFolders::of(root).unmanaged_copies(root, name, lock)
}

/// The folder names in each agent's project skill folder, listed once so
/// that checking many skills does not probe every path for each of them.
/// A listing only narrows the search: each copy is still confirmed with the
/// same guarded read as a single check.
pub struct SkillFolders(Vec<(&'static str, std::collections::HashSet<String>)>);

impl SkillFolders {
    pub fn of(root: &Path) -> SkillFolders {
        SkillFolders(
            layout::PROJECT_SKILL_DIRS
                .iter()
                .filter_map(|base| {
                    let names = std::fs::read_dir(root.join(base))
                        .ok()?
                        .filter_map(|e| e.ok()?.file_name().into_string().ok())
                        .collect();
                    Some((*base, names))
                })
                .collect(),
        )
    }

    /// Whether the project has a skill of this name in any agent's folder,
    /// whoever put it there.
    pub fn has(&self, root: &Path, name: &str) -> bool {
        self.0.iter().any(|(base, names)| {
            names.contains(name)
                && matches!(
                    read_project_file(root, &format!("{base}/{name}/SKILL.md")),
                    Ok(Some(_))
                )
        })
    }

    pub fn unmanaged_copies(
        &self,
        root: &Path,
        name: &str,
        lock: &super::lock::LockFile,
    ) -> Vec<String> {
        self.0
            .iter()
            .filter(|(_, names)| names.contains(name))
            .map(|(base, _)| format!("{base}/{name}/SKILL.md"))
            .filter(|p| matches!(read_project_file(root, p), Ok(Some(_))))
            .filter(|p| lock.owner_of(p).is_none())
            .collect()
    }
}
