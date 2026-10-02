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
        files.push(InstalledFile {
            path: f.path.clone(),
            state: file_state(root, &f.path, &f.digest),
            upstream_changed,
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
    }
}

/// Skill directories that exist in the project for `name` but are not
/// recorded in the lock file (installed by hand or by another tool).
pub fn unmanaged_copies(root: &Path, name: &str, lock: &super::lock::LockFile) -> Vec<String> {
    [
        layout::AGENTS_SKILLS,
        layout::CLAUDE_SKILLS,
        ".cursor/skills",
    ]
    .iter()
    .map(|base| format!("{base}/{name}/SKILL.md"))
    .filter(|p| matches!(read_project_file(root, p), Ok(Some(_))))
    .filter(|p| lock.owner_of(p).is_none())
    .collect()
}
