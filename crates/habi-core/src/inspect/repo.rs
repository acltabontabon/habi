//! Reads Git metadata files to describe the repository, without running Git.

use super::model::{RepositoryInfo, RepositoryKind};
use crate::fsutil::read_prefix;
use std::path::{Path, PathBuf};

fn read_head(git_dir: &Path) -> Option<String> {
    let head = git_dir.join("HEAD");
    // Opening a FIFO would wait forever, and a link can lead anywhere.
    std::fs::symlink_metadata(&head)
        .ok()
        .filter(|m| m.is_file())?;
    let bytes = read_prefix(&head, 512).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    text.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

/// Where a pointer in a repository's own files leads (the `gitdir:` of a `.git`
/// file, a worktree's `commondir`), relative to `base` unless absolute. `None`
/// for a path on another machine: these files come with any downloaded or
/// unpacked folder, and on Windows merely reading `\\host\share\HEAD` connects
/// to that host and offers it the person's credentials (`is_network_path`).
pub(crate) fn git_pointer(base: &Path, target: &str) -> Option<PathBuf> {
    let target = target.trim();
    (!crate::paths::is_network_path(target)).then(|| base.join(target))
}

fn gitdir_from_file(dot_git: &Path) -> Option<PathBuf> {
    let bytes = read_prefix(dot_git, 4096).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let target = text.trim().strip_prefix("gitdir:")?;
    git_pointer(dot_git.parent()?, target)
}

/// The nearest folder at or above `root` with a `.git` of its own, how many
/// levels up it is, and what that `.git` is.
fn nearest_git(root: &Path) -> Option<(usize, &Path, std::fs::Metadata)> {
    root.ancestors()
        .take(64)
        .enumerate()
        .find_map(|(depth, dir)| {
            let meta = std::fs::symlink_metadata(dir.join(".git")).ok()?;
            (meta.is_dir() || meta.is_file()).then_some((depth, dir, meta))
        })
}

/// The root of the repository `root` is inside, when that is not `root` itself:
/// the folder that makes it a `GitSubdirectory`.
pub(crate) fn enclosing_root(root: &Path) -> Option<&Path> {
    nearest_git(root)
        .filter(|(depth, ..)| *depth > 0)
        .map(|(_, dir, _)| dir)
}

pub fn describe(root: &Path) -> RepositoryInfo {
    let mut info = RepositoryInfo {
        kind: RepositoryKind::Plain,
        branch: None,
        repository_root: None,
        is_monorepo: false,
        workspace_signals: Vec::new(),
    };
    let Some((depth, current, meta)) = nearest_git(root) else {
        return info;
    };
    let dot_git = current.join(".git");
    if meta.is_dir() {
        info.kind = if depth == 0 {
            RepositoryKind::Git
        } else {
            RepositoryKind::GitSubdirectory
        };
        info.branch = read_head(&dot_git);
    } else {
        let gitdir = gitdir_from_file(&dot_git);
        let is_worktree = gitdir
            .as_ref()
            .is_some_and(|g| g.to_string_lossy().contains("/worktrees/"));
        info.kind = match (depth, is_worktree) {
            (0, true) => RepositoryKind::Worktree,
            (0, false) => RepositoryKind::Git,
            _ => RepositoryKind::GitSubdirectory,
        };
        info.branch = gitdir.as_deref().and_then(read_head);
    }
    if depth > 0 {
        info.repository_root = Some(crate::paths::display_path(current));
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_repositories_worktrees_and_subdirectories() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        let info = describe(&repo);
        assert_eq!(info.kind, RepositoryKind::Git);
        assert_eq!(info.branch.as_deref(), Some("feature/x"));

        std::fs::create_dir_all(repo.join("services/api")).unwrap();
        assert_eq!(
            describe(&repo.join("services/api")).kind,
            RepositoryKind::GitSubdirectory
        );

        let wt = dir.path().join("wt");
        std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
        std::fs::write(
            repo.join(".git/worktrees/wt/HEAD"),
            "ref: refs/heads/topic\n",
        )
        .unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        let info = describe(&wt);
        assert_eq!(info.kind, RepositoryKind::Worktree);
        assert_eq!(info.branch.as_deref(), Some("topic"));

        let plain = tempfile::tempdir().unwrap();
        // A temp dir could be inside a repo on some machines; only assert when not.
        let info = describe(plain.path());
        if info.repository_root.is_none() {
            assert_eq!(info.kind, RepositoryKind::Plain);
        }
    }

    /// `path`, written to start with two slashes yet still name it: `//x` is
    /// `/x` on macOS and Linux, and `\\?\C:\x` is `C:\x` on Windows.
    fn doubled(path: &Path) -> String {
        if cfg!(windows) {
            format!(r"\\?\{}", path.display())
        } else {
            format!("/{}", path.display())
        }
    }

    #[test]
    fn gitdir_never_leads_to_another_machine() {
        let dir = tempfile::tempdir().unwrap();
        let gitdir = dir
            .path()
            .join("repo")
            .join(".git")
            .join("worktrees")
            .join("wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        assert_eq!(describe(&wt).branch.as_deref(), Some("topic"));
        // Still a checkout, with nothing read through the pointer; the first
        // one would reach the same folder if it were followed.
        for target in [
            doubled(&gitdir),
            r"\\host.invalid\share\repo\.git".into(),
            "//host.invalid/share/repo/.git".into(),
            r"\\?\UNC\host.invalid\share\repo\.git".into(),
        ] {
            std::fs::write(wt.join(".git"), format!("gitdir: {target}\n")).unwrap();
            let info = describe(&wt);
            assert_eq!(info.kind, RepositoryKind::Git, "{target}");
            assert_eq!(info.branch, None, "{target}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_at_head_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let head = dir.path().join(".git/HEAD");
        let made = std::process::Command::new("mkfifo")
            .arg(&head)
            .status()
            .unwrap();
        assert!(made.success());

        // On another thread: the old code never comes back from this.
        let root = dir.path().to_path_buf();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || send.send(describe(&root)).unwrap());
        let info = receive
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("describe returned");
        assert_eq!(info.kind, RepositoryKind::Git);
        assert_eq!(info.branch, None);
    }
}
