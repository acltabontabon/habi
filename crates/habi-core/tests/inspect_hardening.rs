//! Repositories are untrusted input. Each test here is a repository built to
//! hang, exhaust or mislead inspection, and says what inspection does instead.

use habi_core::cancel::CancelToken;
use habi_core::inspect::model::{CoverageStatus, ProjectInspection};
use habi_core::inspect::{WalkOptions, inspect};
use habi_core::matching::condition::Condition;
use habi_core::matching::{Applicability, Scope, assess};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn inspected(root: &Path) -> ProjectInspection {
    inspect(root, &WalkOptions::default(), &CancelToken::new()).unwrap()
}

/// Fails rather than hangs if `work` does not finish in `seconds`: the thread is
/// left behind, and the test binary's exit takes it down.
fn within<T: Send + 'static>(seconds: u64, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(work());
    });
    receive
        .recv_timeout(Duration::from_secs(seconds))
        .expect("finished in time")
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let made = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .unwrap();
    assert!(made.success());
}

fn coverage(i: &ProjectInspection, module: &str, area: &str) -> CoverageStatus {
    i.coverage
        .iter()
        .find(|c| c.module == module && c.area == area)
        .map(|c| c.status)
        .unwrap_or_else(|| panic!("no {area} coverage for {module}"))
}

// Ignore files.

#[cfg(unix)]
#[test]
fn an_ignore_file_linked_to_a_device_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink("/dev/zero", dir.path().join(".gitignore")).unwrap();
    write(dir.path(), "pom.xml", "<project/>");
    let root = dir.path().to_path_buf();
    let i = within(30, move || inspected(&root));
    assert_eq!(i.scan.symlinks_skipped, 1);
    assert_eq!(coverage(&i, ".", "files"), CoverageStatus::Partial);
    assert!(
        i.scan.unreadable.iter().any(|u| u.contains(".gitignore")),
        "{:?}",
        i.scan.unreadable
    );
}

#[cfg(unix)]
#[test]
fn a_fifo_named_like_an_ignore_file_does_not_block() {
    for fifo in [
        ".gitignore",
        ".ignore",
        ".habiignore",
        "sub/.gitignore",
        "sub/.habiignore",
        ".git/info/exclude",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "sub/app.txt", "");
        mkfifo(&dir.path().join(fifo));
        let root = dir.path().to_path_buf();
        let i = within(30, move || inspected(&root));
        assert!(i.files.iter().any(|f| f == "sub/app.txt"), "{fifo}");
        assert_eq!(
            coverage(&i, ".", "files"),
            CoverageStatus::Partial,
            "{fifo}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_fifo_in_a_skipped_folder_is_never_looked_at() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "app.txt", "");
    mkfifo(&dir.path().join("node_modules/.gitignore"));
    let root = dir.path().to_path_buf();
    let i = within(30, move || inspected(&root));
    assert_eq!(coverage(&i, ".", "files"), CoverageStatus::Complete);
}

#[test]
fn a_parent_ignore_file_does_not_hide_a_repository_below_it() {
    // The bare-dotfiles habit: `*` in a `.gitignore` in the home folder.
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ".gitignore", "*\n");
    write(dir.path(), "code/app/.git/HEAD", "ref: refs/heads/main\n");
    write(dir.path(), "code/app/pom.xml", "<project/>");
    let i = inspected(&dir.path().join("code/app"));
    assert_eq!(i.files, vec!["pom.xml"]);
    assert_eq!(i.modules.len(), 1);
    assert!(
        i.modules[0]
            .ecosystems
            .contains(&habi_core::inspect::model::Ecosystem::Maven)
    );
}

#[test]
fn a_subdirectory_of_a_repository_keeps_its_rules() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "repo/.git/HEAD", "ref: refs/heads/main\n");
    write(dir.path(), "repo/.gitignore", "generated.txt\n");
    write(dir.path(), "repo/svc/app.txt", "");
    write(dir.path(), "repo/svc/generated.txt", "");
    let i = inspected(&dir.path().join("repo/svc"));
    assert_eq!(i.files, vec!["app.txt"]);
}

// Git metadata.

#[cfg(unix)]
#[test]
fn a_fifo_at_git_head_does_not_block() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "app.txt", "");
    mkfifo(&dir.path().join(".git/HEAD"));
    let root = dir.path().to_path_buf();
    let i = within(30, move || inspected(&root));
    assert_eq!(i.repository.branch, None);
}

#[allow(dead_code)]
fn outcome(i: &ProjectInspection, rule: serde_json::Value, scope: Scope) -> Applicability {
    let rule = Condition::parse(&rule).unwrap();
    assess(Some(&rule), None, scope, i, &[]).applicability
}
