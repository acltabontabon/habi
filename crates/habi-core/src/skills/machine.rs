//! Skills kept for the person rather than for a project: the user-level
//! folders the supported clients read (`~/.claude/skills`, `~/.agents/skills`,
//! `~/.cursor/skills`).
//!
//! Everything here reads. Habi never writes to those folders; a skill found
//! there reaches "My skills" or a project as an independent copy through the
//! usual import and install. Links are followed only to read, and nothing
//! found here is executed.

use super::{Tree, TreeLimits, describe_tree, read_tree};
use crate::clients::ClientId;
use crate::clients::layout::{self, Precedence, USER_SKILL_DIRS};
use crate::error::{HabiError, Result};
use crate::library::SKILL_FILE;
use crate::library::model::Diagnostic;
use crate::paths::{RelPath, resolve_for_read};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use ts_rs::TS;

/// Skills read per folder; a folder holding more is cut off here.
const MAX_PER_DIR: usize = 300;

/// A client that reads both a personal skill and a project's copy of it, and
/// what it does with the two.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientUse {
    pub client: ClientId,
    pub precedence: Precedence,
}

/// The same folder name, found in a project.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectCopy {
    pub project_id: String,
    pub project_name: String,
    /// Project-relative folder holding the copy.
    pub path: String,
    /// The same files, byte for byte.
    pub identical: bool,
    /// Clients that read both this copy and the personal one; empty when no
    /// client sees both, so neither hides the other.
    pub shared_readers: Vec<ClientUse>,
}

/// A skill in one of the person's own skill folders.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MachineSkill {
    /// Folder key and skill folder ("claude/pdf"); names it for import.
    pub id: String,
    pub folder: String,
    pub name: String,
    pub description: String,
    /// Where it is, with the home folder shown as `~`.
    pub location: String,
    pub readers: Vec<ClientId>,
    /// The folder, or the skills folder around it, is a link.
    pub is_link: bool,
    pub file_count: u32,
    pub digest: String,
    pub problems: Vec<Diagnostic>,
    /// False when files would be lost on copying (links inside, oversized files).
    pub complete: bool,
    /// Id of the skill in My skills with the same content, if one exists.
    pub imported_as: Option<String>,
    /// Files whose text names a folder under a home directory.
    pub mentions_home: Vec<String>,
    pub in_projects: Vec<ProjectCopy>,
}

/// A skill folder that was asked for by id, found and checked.
pub(crate) struct Found {
    pub path: PathBuf,
    pub location: String,
}

/// A project to look for copies in.
pub(crate) struct ProjectRef<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub root: &'a Path,
}

fn is_folder_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\'])
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Every skill in the three folders, in folder order and then by name. A
/// folder that is missing or unreadable simply has none.
pub(crate) fn scan(home: &Path) -> Vec<MachineSkill> {
    let mut skills = Vec::new();
    if home.as_os_str().is_empty() {
        return skills;
    }
    for dir in &USER_SKILL_DIRS {
        let root = home.join(dir.base);
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        let around = is_link(&root);
        let mut folders: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                is_folder_name(&name).then(|| (name, e.path()))
            })
            .collect();
        folders.sort();
        for (folder, path) in folders.into_iter().take(MAX_PER_DIR) {
            // `metadata` follows links, so a dangling link is not a skill.
            if !std::fs::metadata(&path).is_ok_and(|m| m.is_dir())
                || !path.join(SKILL_FILE).is_file()
            {
                continue;
            }
            skills.push(describe(
                home,
                format!("{}/{folder}", dir.key),
                &folder,
                format!("~/{}/{folder}", dir.base),
                dir.readers.to_vec(),
                around || is_link(&path),
                &path,
            ));
        }
    }
    skills
}

fn describe(
    home: &Path,
    id: String,
    folder: &str,
    location: String,
    readers: Vec<ClientId>,
    is_link: bool,
    path: &Path,
) -> MachineSkill {
    let skill = |name: String,
                 description: String,
                 tree: Option<&Tree>,
                 digest: String,
                 problems: Vec<Diagnostic>| {
        MachineSkill {
            id: id.clone(),
            folder: folder.to_string(),
            name,
            description,
            location: location.clone(),
            readers: readers.clone(),
            is_link,
            file_count: tree.map_or(0, |t| t.files.len() as u32),
            digest,
            problems,
            complete: tree.is_some_and(|t| t.skipped.is_empty()),
            imported_as: None,
            mentions_home: tree.map(|t| mentions_home(t, home)).unwrap_or_default(),
            in_projects: Vec::new(),
        }
    };
    match read_tree(path, &TreeLimits::PACKAGE) {
        Ok(tree) => {
            let described = describe_tree(&tree);
            let digest = described
                .item
                .as_ref()
                .map(|i| i.content_digest.clone())
                .unwrap_or_default();
            let mut problems = described.diagnostics;
            problems.extend(tree.skipped.iter().cloned());
            let name = if described.name.is_empty() {
                folder.to_string()
            } else {
                described.name
            };
            skill(name, described.description, Some(&tree), digest, problems)
        }
        Err(e) => skill(
            folder.to_string(),
            String::new(),
            None,
            String::new(),
            vec![Diagnostic::error(e.to_string(), None)],
        ),
    }
}

/// Finds the skill folder an id names, refusing anything that is not one of
/// the scanned folders' direct children.
pub(crate) fn locate(home: &Path, id: &str) -> Result<Found> {
    let gone = || HabiError::NotFound(format!("the skill {id} on this machine"));
    let (key, folder) = id.split_once('/').ok_or_else(gone)?;
    let dir = USER_SKILL_DIRS
        .iter()
        .find(|d| d.key == key)
        .ok_or_else(gone)?;
    if !is_folder_name(folder) {
        return Err(HabiError::invalid("that is not the name of a skill folder"));
    }
    if home.as_os_str().is_empty() {
        return Err(gone());
    }
    let path = home.join(dir.base).join(folder);
    if !path.join(SKILL_FILE).is_file() {
        return Err(gone());
    }
    Ok(Found {
        path,
        location: format!("~/{}/{folder}", dir.base),
    })
}

/// The copies a project holds under the same folder name, whether or not
/// they match.
pub(crate) fn project_copies(skill: &MachineSkill, projects: &[ProjectRef]) -> Vec<ProjectCopy> {
    let mut copies = Vec::new();
    for project in projects {
        for base in layout::PROJECT_SKILL_DIRS {
            let rel = format!("{base}/{}", skill.folder);
            let dir = RelPath::new(&rel)
                .ok()
                .and_then(|r| resolve_for_read(project.root, &r).ok().flatten());
            let Some(dir) = dir.filter(|d| d.join(SKILL_FILE).is_file()) else {
                continue;
            };
            let digest = read_tree(&dir, &TreeLimits::PACKAGE)
                .ok()
                .and_then(|t| describe_tree(&t).item.map(|i| i.content_digest))
                .unwrap_or_default();
            let seen_by = layout::readers_of(&format!("{base}/"));
            copies.push(ProjectCopy {
                project_id: project.id.to_string(),
                project_name: project.name.to_string(),
                path: rel,
                identical: !digest.is_empty() && digest == skill.digest,
                shared_readers: skill
                    .readers
                    .iter()
                    .filter(|c| seen_by.contains(c))
                    .map(|&client| ClientUse {
                        client,
                        precedence: layout::precedence(client),
                    })
                    .collect(),
            });
        }
    }
    copies
}

/// A folder under a home directory, written the way a person's own machine
/// writes it (`/Users/ana/…`, `/home/ana/…`, `C:\Users\ana\…`).
fn personal_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?m)(?:^|[\s"'`=(:])(?:/Users/|/home/)[A-Za-z0-9._-]+/|(?:^|[\s"'`=(:])[A-Za-z]:\\Users\\[^\\\s]+\\"#,
        )
        .unwrap_or_else(|_| unreachable!("the pattern is a literal"))
    })
}

/// Files whose text points into someone's home folder: the home folder this
/// machine has, or any `/Users/<name>/`-style path. A skill like that works
/// on one machine and not on a teammate's.
pub(crate) fn mentions_home(tree: &Tree, home: &Path) -> Vec<String> {
    let home = home.to_string_lossy();
    let own = home.trim_end_matches(['/', '\\']);
    let own = (!own.is_empty()).then(|| format!("{own}/"));
    tree.files
        .iter()
        .filter_map(|(path, bytes)| {
            let text = std::str::from_utf8(bytes).ok()?;
            let hit =
                own.as_deref().is_some_and(|h| text.contains(h)) || personal_path().is_match(text);
            hit.then(|| path.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(text: &str) -> Tree {
        let mut t = Tree::default();
        t.files.insert("SKILL.md".into(), text.as_bytes().to_vec());
        t
    }

    #[test]
    fn home_paths_are_found_but_ordinary_ones_are_not() {
        let home = Path::new("/Users/ana");
        for text in [
            "run /Users/bo/bin/tool",
            "path=\"/home/cy/.config\"",
            "(C:\\Users\\dee\\notes\\x)",
            "see /Users/ana/x",
        ] {
            assert_eq!(mentions_home(&tree(text), home), ["SKILL.md"], "{text}");
        }
        for text in [
            "src/home/index/page",
            "use ~/notes",
            "a /Users folder",
            "plain",
        ] {
            assert!(mentions_home(&tree(text), home).is_empty(), "{text}");
        }
    }

    #[test]
    fn ids_cannot_leave_the_skill_folders() {
        let home = Path::new("/nonexistent-home");
        for id in [
            "claude/../x",
            "claude/a/b",
            "claude/",
            "nope/x",
            "claude",
            "claude/.hidden",
        ] {
            assert!(locate(home, id).is_err(), "{id}");
        }
    }
}
