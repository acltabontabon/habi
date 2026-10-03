//! Choosing a project folder inside Habi: the code repositories found in the
//! usual places, and a folder-by-folder look at the home directory, each
//! folder described by what Habi would see in it.
//!
//! Read-only and shallow: names, the presence of a few build files, and a
//! bounded look for `SKILL.md`. Hidden folders are never listed or browsed.

use crate::error::{HabiError, Result};
use crate::inspect::walk::{DEFAULT_SKIPPED_DIRS, folder_shape_within};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use ts_rs::TS;

/// What a folder is, as far as opening a project goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FolderKind {
    /// Build files or a Git checkout: code to open.
    Project,
    /// Skills and no build files: a library, not a project.
    Skills,
    /// Neither, as far as a quick look goes.
    Folder,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderEntry {
    pub name: String,
    /// Full path, to browse into or open.
    pub path: String,
    /// Home abbreviated.
    pub display: String,
    pub kind: FolderKind,
    /// Languages and build tools, from the build files at its top.
    pub stacks: Vec<String>,
    pub skills: u32,
    /// When it was last worked on: the last commit or checkout here, else
    /// when the folder last changed.
    pub modified: Option<String>,
    /// Read from its `.git` folder, without running Git.
    pub git: Option<GitFacts>,
    /// Already has instructions for coding agents (`AGENTS.md`, `.claude`…).
    pub agents: bool,
    /// For a plain folder: how many of its subfolders are projects.
    pub inside: u32,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitFacts {
    pub branch: Option<String>,
    /// Where `origin` is hosted, without credentials: `github.com/acme/app`.
    pub remote: Option<String>,
    /// Commits made on this machine, a week per entry, oldest first.
    pub weeks: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Crumb {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderListing {
    pub folder: FolderEntry,
    /// From the home directory down to this folder.
    pub crumbs: Vec<Crumb>,
    pub entries: Vec<FolderEntry>,
    /// More folders than are listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectPlaces {
    pub home: Crumb,
    /// Folders in the home folder that hold projects, the fullest first.
    pub roots: Vec<CodePlace>,
    /// The projects in them (and any right in the home folder), latest work first.
    pub found: Vec<FolderEntry>,
    /// How many there are, though only the latest are in `found`.
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CodePlace {
    pub name: String,
    pub path: String,
    pub projects: u32,
}

/// Build files and the stack each one names.
const STACKS: &[(&str, &str)] = &[
    ("package.json", "Node"),
    ("deno.json", "Deno"),
    ("pom.xml", "Maven"),
    ("build.gradle", "Gradle"),
    ("build.gradle.kts", "Gradle"),
    ("settings.gradle", "Gradle"),
    ("settings.gradle.kts", "Gradle"),
    ("Cargo.toml", "Rust"),
    ("go.mod", "Go"),
    ("pyproject.toml", "Python"),
    ("setup.py", "Python"),
    ("requirements.txt", "Python"),
    ("Gemfile", "Ruby"),
    ("composer.json", "PHP"),
    ("build.sbt", "Scala"),
    ("Package.swift", "Swift"),
    ("pubspec.yaml", "Dart"),
    ("mix.exs", "Elixir"),
    ("build.xml", "Ant"),
];

/// Home folders macOS guards with a privacy prompt. They are listed, but
/// only looked inside when the person opens one, so the prompt comes when
/// it makes sense.
const GUARDED: &[&str] = &["Desktop", "Documents", "Downloads"];

/// Home folders that never hold code: left out of the home listing.
const NOT_CODE: &[&str] = &[
    "Library",
    "Applications",
    "Movies",
    "Music",
    "Pictures",
    "Public",
];

/// Files and folders that hold instructions for coding agents.
const AGENT_FILES: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".claude",
    ".cursor",
    ".cursorrules",
    ".windsurfrules",
    ".github/copilot-instructions.md",
];

const WEEKS: usize = 12;
const MAX_ENTRIES: usize = 300;
const MAX_FOUND: usize = 60;

pub fn home() -> Result<PathBuf> {
    directories::BaseDirs::new()
        .map(|b| b.home_dir().to_path_buf())
        .and_then(|h| crate::paths::canonical(h).ok())
        .ok_or_else(|| HabiError::invalid("the home folder could not be found"))
}

/// Whether `path` is a folder this module may list: the home directory or
/// below it, through no hidden folder.
pub fn browsable(home: &Path, path: &Path) -> bool {
    path.strip_prefix(home).is_ok_and(|rest| {
        rest.components()
            .all(|c| !c.as_os_str().to_string_lossy().starts_with('.'))
    })
}

/// Finds where the code is rather than guessing folder names: every home
/// subfolder with repositories in it (one or two levels down) is a place.
pub fn places(home: &Path) -> ProjectPlaces {
    let mut candidates: Vec<(Option<usize>, PathBuf)> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in subfolders(home) {
        let name = name_of(&dir);
        if NOT_CODE.contains(&name.as_str()) || GUARDED.contains(&name.as_str()) {
            continue;
        }
        if looks_like_repo(&dir) {
            // A project right in the home folder.
            candidates.push((None, dir));
        } else {
            let inside = repos_in(&dir);
            if !inside.is_empty() {
                candidates.extend(inside.into_iter().map(|p| (Some(dirs.len()), p)));
                dirs.push(dir);
            }
        }
    }
    let mut counts = vec![0u32; dirs.len()];
    let mut found: Vec<FolderEntry> = Vec::new();
    for (root, path) in candidates {
        let entry = describe(&path);
        if entry.kind != FolderKind::Project {
            continue;
        }
        if let Some(count) = root.and_then(|i| counts.get_mut(i)) {
            *count += 1;
        }
        found.push(entry);
    }
    let mut roots: Vec<CodePlace> = dirs
        .iter()
        .zip(counts)
        .filter(|(_, n)| *n > 0)
        .map(|(dir, projects)| CodePlace {
            name: name_of(dir),
            path: dir.to_string_lossy().into_owned(),
            projects,
        })
        .collect();
    roots.sort_by(|a, b| {
        b.projects
            .cmp(&a.projects)
            .then_with(|| a.name.cmp(&b.name))
    });
    found.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    let total = found.len() as u32;
    found.truncate(MAX_FOUND);
    ProjectPlaces {
        home: crumb(home),
        roots,
        found,
        total,
    }
}

/// A Git checkout. Build files alone are not enough to be found: SDKs and
/// tool installs are full of them. Browsing still shows those projects.
fn looks_like_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// Projects in `dir` and one level further (`~/code/work/app`), a few hundred folders at most.
fn repos_in(dir: &Path) -> Vec<PathBuf> {
    let mut budget = MAX_ENTRIES;
    let mut out = Vec::new();
    for child in subfolders(dir).into_iter().take(MAX_ENTRIES) {
        if looks_like_repo(&child) {
            out.push(child);
            continue;
        }
        for grandchild in subfolders(&child).into_iter().take(budget) {
            budget -= 1;
            if looks_like_repo(&grandchild) {
                out.push(grandchild);
            }
        }
        if budget == 0 {
            break;
        }
    }
    out
}

pub fn list(home: &Path, path: &Path) -> Result<FolderListing> {
    let dir = crate::paths::canonical_dir(path)?;
    if !browsable(home, &dir) {
        return Err(HabiError::invalid(
            "only folders in your home folder can be browsed here; use Other location",
        ));
    }
    let at_home = dir == home;
    let children: Vec<PathBuf> = subfolders(&dir)
        .into_iter()
        .filter(|p| !(at_home && NOT_CODE.contains(&name_of(p).as_str())))
        .collect();
    let truncated = children.len() > MAX_ENTRIES;
    let entries = children
        .iter()
        .take(MAX_ENTRIES)
        .filter_map(|p| {
            if at_home && GUARDED.contains(&name_of(p).as_str()) {
                Some(unread(p))
            } else {
                // A folder with nothing in it leads nowhere.
                let entry = describe(p);
                (entry.kind != FolderKind::Folder || !is_empty(p)).then_some(entry)
            }
        })
        .collect();
    let mut crumbs = vec![crumb(home)];
    let mut at = home.to_path_buf();
    if let Ok(rest) = dir.strip_prefix(home) {
        for part in rest.components() {
            at.push(part);
            crumbs.push(crumb(&at));
        }
    }
    Ok(FolderListing {
        folder: describe(&dir),
        crumbs,
        entries,
        truncated,
    })
}

/// Nothing in it but hidden files, if anything.
fn is_empty(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut read| {
        !read.any(|e| e.is_ok_and(|e| !e.file_name().to_string_lossy().starts_with('.')))
    })
}

/// Visible, non-dependency subfolders, by name. Symbolic links are not followed.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = read
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !DEFAULT_SKIPPED_DIRS.contains(&name.as_ref())
        })
        .map(|e| e.path())
        .collect();
    out.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    out
}

fn describe(dir: &Path) -> FolderEntry {
    let stacks = stacks_of(dir);
    let git = git_facts(dir);
    let shape = folder_shape_within(dir, 2, 40);
    let kind = if shape.skills > 0 && stacks.is_empty() {
        FolderKind::Skills
    } else if !stacks.is_empty() || git.is_some() {
        FolderKind::Project
    } else {
        FolderKind::Folder
    };
    let inside = if kind == FolderKind::Folder {
        subfolders(dir)
            .iter()
            .take(MAX_ENTRIES)
            .filter(|c| c.join(".git").exists() || !stacks_of(c).is_empty())
            .count() as u32
    } else {
        0
    };
    let last_git = git.as_ref().and_then(|g| g.1);
    let modified = last_git
        .or_else(|| {
            std::fs::metadata(dir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(unix)
        })
        .and_then(|t| time::OffsetDateTime::from_unix_timestamp(t).ok())
        .map(crate::time::format);
    FolderEntry {
        name: name_of(dir),
        path: dir.to_string_lossy().into_owned(),
        display: crate::paths::display_path(dir),
        kind,
        stacks,
        skills: shape.skills,
        modified,
        git: git.map(|g| g.0),
        agents: kind == FolderKind::Project && AGENT_FILES.iter().any(|f| dir.join(f).exists()),
        inside,
    }
}

fn stacks_of(dir: &Path) -> Vec<String> {
    let mut stacks: Vec<String> = Vec::new();
    for (file, stack) in STACKS {
        if dir.join(file).is_file() && !stacks.iter().any(|s| s == stack) {
            stacks.push((*stack).to_string());
        }
    }
    stacks
}

fn unix(t: SystemTime) -> Option<i64> {
    Some(t.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as i64)
}

/// Branch, remote and recent commits from the `.git` folder's own files,
/// with the time of the last entry in its log. `None` when not a checkout.
fn git_facts(dir: &Path) -> Option<(GitFacts, Option<i64>)> {
    let dot = dir.join(".git");
    // A worktree or submodule points elsewhere: `gitdir: <path>`.
    let git_dir = if dot.is_dir() {
        dot
    } else {
        let text = std::fs::read_to_string(&dot).ok()?;
        let target = text.strip_prefix("gitdir:")?.trim();
        dir.join(target)
    };
    // Still a checkout when its files cannot be read; there is just less to say.
    let head = std::fs::read_to_string(git_dir.join("HEAD")).unwrap_or_default();
    let branch = match head.trim().strip_prefix("ref: refs/heads/") {
        Some(name) => Some(name.to_string()),
        None => head.trim().get(..7).map(str::to_string),
    };
    // A worktree keeps its config in the main repository.
    let config = std::fs::read_to_string(git_dir.join("config"))
        .or_else(|_| {
            let common = std::fs::read_to_string(git_dir.join("commondir"))?;
            std::fs::read_to_string(git_dir.join(common.trim()).join("config"))
        })
        .unwrap_or_default();
    let (weeks, last) = activity(&git_dir.join("logs/HEAD"));
    Some((
        GitFacts {
            branch,
            remote: origin(&config),
            weeks,
        },
        last,
    ))
}

/// The `origin` remote's address, as `host/owner/repo`.
fn origin(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line == r#"[remote "origin"]"#;
        } else if in_origin && let Some(url) = line.strip_prefix("url").map(str::trim_start) {
            return url.strip_prefix('=').map(|u| tidy_remote(u.trim()));
        }
    }
    None
}

fn tidy_remote(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    // Credentials and user names never leave this function.
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    // scp-style `host:owner/repo`.
    let rest = rest.replacen(':', "/", 1);
    rest.trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string()
}

/// Commits per week from the log's last 256 KiB, and the time of its last entry.
fn activity(log: &Path) -> (Vec<u32>, Option<i64>) {
    use std::io::{Read, Seek, SeekFrom};
    let mut weeks = vec![0; WEEKS];
    let Ok(mut file) = std::fs::File::open(log) else {
        return (weeks, None);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(256 * 1024)));
    let mut text = String::new();
    if file.read_to_string(&mut text).is_err() {
        return (weeks, None);
    }
    let now = unix(SystemTime::now()).unwrap_or(0);
    let mut last = None;
    for line in text.lines() {
        // `<old> <new> <name> <email> <seconds> <zone>\t<message>`
        let Some((who, message)) = line.split_once('\t') else {
            continue;
        };
        let Some(seconds) = who
            .rsplit_once('>')
            .and_then(|(_, t)| t.split_whitespace().next())
            .and_then(|t| t.parse::<i64>().ok())
        else {
            continue;
        };
        last = Some(seconds);
        if message.starts_with("commit") || message.starts_with("merge") {
            let age = (now - seconds).max(0) / (7 * 86_400);
            if let Some(slot) = (WEEKS - 1)
                .checked_sub(age as usize)
                .and_then(|i| weeks.get_mut(i))
            {
                *slot += 1;
            }
        }
    }
    (weeks, last)
}

/// A folder named, not looked inside.
fn unread(dir: &Path) -> FolderEntry {
    FolderEntry {
        name: name_of(dir),
        path: dir.to_string_lossy().into_owned(),
        display: crate::paths::display_path(dir),
        kind: FolderKind::Folder,
        stacks: Vec::new(),
        skills: 0,
        modified: None,
        git: None,
        agents: false,
        inside: 0,
    }
}

fn crumb(dir: &Path) -> Crumb {
    Crumb {
        name: name_of(dir),
        path: dir.to_string_lossy().into_owned(),
    }
}

fn name_of(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_git_facts_without_git() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join(".git");
        fs::create_dir_all(git.join("logs")).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/feat/weave\n").unwrap();
        fs::write(
            git.join("config"),
            "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://x-token:secret@github.com/acme/app.git\n",
        )
        .unwrap();
        let now = unix(SystemTime::now()).unwrap();
        let week_ago = now - 8 * 86_400;
        fs::write(
            git.join("logs/HEAD"),
            format!(
                "0 1 A <a@b.c> {week_ago} +0000\tcommit: one\n\
                 1 2 A <a@b.c> {now} +0000\tcommit: two\n\
                 2 3 A <a@b.c> {now} +0000\tcheckout: moving from main to feat/weave\n"
            ),
        )
        .unwrap();
        fs::write(dir.path().join("AGENTS.md"), "").unwrap();
        let entry = describe(dir.path());
        assert_eq!(entry.kind, FolderKind::Project);
        assert!(entry.agents);
        let git = entry.git.unwrap();
        assert_eq!(git.branch.as_deref(), Some("feat/weave"));
        assert_eq!(git.remote.as_deref(), Some("github.com/acme/app"));
        assert_eq!(git.weeks.len(), WEEKS);
        assert_eq!(git.weeks[WEEKS - 1], 1);
        assert_eq!(git.weeks[WEEKS - 2], 1);
        assert_eq!(
            tidy_remote("git@gitlab.com:team/lib.git"),
            "gitlab.com/team/lib"
        );
    }

    #[test]
    fn finds_repositories_and_tells_folders_apart() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::canonical(dir.path()).unwrap();
        fs::create_dir_all(home.join("Workspace/app/src")).unwrap();
        fs::write(home.join("Workspace/app/package.json"), "{}").unwrap();
        fs::write(home.join("Workspace/app/Cargo.toml"), "").unwrap();
        fs::create_dir_all(home.join("Workspace/app/.git")).unwrap();
        fs::create_dir_all(home.join("Workspace/work/api/.git")).unwrap();
        fs::create_dir_all(home.join("Workspace/agent-skills/review")).unwrap();
        fs::write(home.join("Workspace/agent-skills/review/SKILL.md"), "").unwrap();
        fs::create_dir_all(home.join("Workspace/.hidden/x/.git")).unwrap();

        fs::create_dir_all(home.join("dev/notes")).unwrap();
        fs::create_dir_all(home.join("IdeaProjects/shop/.git")).unwrap();
        fs::write(home.join("IdeaProjects/shop/pom.xml"), "").unwrap();
        // An SDK full of build files is not a place.
        fs::create_dir_all(home.join("sdk/tools")).unwrap();
        fs::write(home.join("sdk/tools/package.json"), "{}").unwrap();
        let places = places(&home);
        let roots: Vec<(&str, u32)> = places
            .roots
            .iter()
            .map(|r| (r.name.as_str(), r.projects))
            .collect();
        // Found, not guessed: no `dev` (nothing in it), and `IdeaProjects` by its contents.
        assert_eq!(roots, vec![("Workspace", 2), ("IdeaProjects", 1)]);
        let names: Vec<&str> = places.found.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"app") && names.contains(&"api"),
            "{names:?}"
        );
        assert!(!names.contains(&"agent-skills") && !names.contains(&"x"));
        let app = places.found.iter().find(|e| e.name == "app").unwrap();
        assert_eq!(app.stacks, vec!["Node", "Rust"]);

        fs::create_dir_all(home.join("Workspace/empty")).unwrap();
        fs::write(home.join("Workspace/empty/.DS_Store"), "").unwrap();
        let work = list(&home, &home.join("Workspace")).unwrap();
        assert!(!work.entries.iter().any(|e| e.name == "empty"));
        assert_eq!(
            work.entries
                .iter()
                .find(|e| e.name == "work")
                .unwrap()
                .inside,
            1
        );

        let listing = list(&home, &home.join("Workspace")).unwrap();
        let kinds: Vec<(&str, FolderKind)> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("agent-skills", FolderKind::Skills),
                ("app", FolderKind::Project),
                ("work", FolderKind::Folder),
            ]
        );
        assert_eq!(listing.crumbs.len(), 2);

        fs::create_dir_all(home.join("Library/app/.git")).unwrap();
        fs::create_dir_all(home.join("Documents/app/.git")).unwrap();
        fs::write(home.join("Documents/package.json"), "{}").unwrap();
        let at_home = list(&home, &home).unwrap();
        let names: Vec<&str> = at_home.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["dev", "Documents", "IdeaProjects", "sdk", "Workspace"]);
        // Guarded by macOS: named, not looked inside, until opened.
        assert_eq!(at_home.entries[1].kind, FolderKind::Folder);
        assert_eq!(
            list(&home, &home.join("Documents")).unwrap().folder.kind,
            FolderKind::Project
        );

        assert!(list(&home, &home.join("Workspace/.hidden")).is_err());
        assert!(list(&home, home.parent().unwrap()).is_err());
    }
}
