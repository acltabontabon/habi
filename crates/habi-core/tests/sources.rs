//! Source synchronization against temporary local Git repositories.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::source::{Freshness, NewSource, SourceKind, Sources, TrackedRef};
use habi_core::store::{AppPaths, Store};
use std::path::Path;
use std::process::Command;

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub fn library_repo(dir: &Path) {
    copy_tree(&fixture("libraries/example-team-library"), dir);
    git(dir, &["init", "-q"]);
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "Initial library"]);
}

fn services(home: &Path) -> Sources {
    let paths = AppPaths::at(home.to_path_buf());
    paths.ensure().unwrap();
    let store = Store::open(&paths.db()).unwrap();
    Sources::new(&paths, &store)
}

#[test]
fn register_fetch_update_and_go_offline() {
    let home = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    library_repo(remote.path());
    let sources = services(home.path());

    let source = sources
        .add(&NewSource {
            name: "Team".into(),
            location: remote.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    assert_eq!(source.kind, SourceKind::Git);
    assert_eq!(source.freshness, Freshness::NeverFetched);
    assert!(
        sources.index(&source.id).is_err(),
        "nothing is available before the explicit fetch"
    );

    let first = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(first.changed);
    let head = git(remote.path(), &["rev-parse", "HEAD"]);
    assert_eq!(
        first.current, head,
        "snapshots are pinned to the resolved commit"
    );
    let index = sources.index(&source.id).unwrap();
    assert!(
        index
            .items
            .iter()
            .any(|i| i.id == "liquibase-migration-review")
    );
    assert_eq!(index.name.as_deref(), Some("Example team library"));

    // Refreshing without upstream changes reports no change.
    let again = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(!again.changed);

    // Upstream change: refresh discovers it (and only reports it).
    let skill = remote
        .path()
        .join("skills/liquibase-migration-review/SKILL.md");
    let mut text = std::fs::read_to_string(&skill).unwrap();
    text.push_str("\n7. Confirm the changelog runs on an empty database.\n");
    std::fs::write(&skill, text).unwrap();
    git(
        remote.path(),
        &["commit", "-qam", "Extend migration review"],
    );
    let update = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(update.changed);
    assert_eq!(
        update.updated,
        vec!["liquibase-migration-review".to_string()]
    );
    assert!(update.added.is_empty() && update.removed.is_empty());

    // The previous snapshot remains readable (baseline for three-way updates).
    let old = sources.index_at(&source.id, &first.current).unwrap();
    let new = sources.index(&source.id).unwrap();
    let id = |i: &habi_core::library::model::LibraryIndex| {
        i.items
            .iter()
            .find(|x| x.id == "liquibase-migration-review")
            .unwrap()
            .content_digest
            .clone()
    };
    assert_ne!(id(&old), id(&new));

    // Offline: the remote disappears. Refresh fails, the cache stays, marked stale.
    let parking = tempfile::tempdir().unwrap();
    let gone = parking.path().join("moved-away");
    std::fs::rename(remote.path(), &gone).unwrap();
    let err = sources
        .refresh(&source.id, &CancelToken::new())
        .unwrap_err();
    assert!(err.code().starts_with("git"), "{}", err.code());
    let stale = sources.get(&source.id).unwrap();
    assert_eq!(stale.freshness, Freshness::Stale);
    assert!(stale.last_error.is_some());
    assert_eq!(stale.snapshot.as_deref(), Some(update.current.as_str()));
    assert!(
        sources.index(&source.id).unwrap().items.len() > 5,
        "cached library still browsable"
    );
    std::fs::rename(&gone, remote.path()).unwrap();
}

#[test]
fn moved_tags_and_rewritten_history_are_flagged() {
    let home = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    library_repo(remote.path());
    git(remote.path(), &["tag", "v1"]);
    let sources = services(home.path());
    let source = sources
        .add(&NewSource {
            name: "Pinned".into(),
            location: remote.path().to_string_lossy().into(),
            subdir: Some("skills".into()),
            tracked: TrackedRef::Tag { name: "v1".into() },
        })
        .unwrap();
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    // Subdirectory narrowing: paths are relative to `skills/`.
    let index = sources.index(&source.id).unwrap();
    assert!(index.items.iter().all(|i| !i.path.starts_with("skills/")));
    assert!(
        index.name.is_none(),
        "the manifest lives outside the subdirectory"
    );

    std::fs::write(remote.path().join("skills/incident-notes/extra.md"), "more").unwrap();
    git(remote.path(), &["add", "-A"]);
    git(remote.path(), &["commit", "-qm", "change"]);
    git(remote.path(), &["tag", "-f", "v1"]);
    let outcome = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(outcome.changed);
    assert!(
        outcome
            .source
            .warning
            .as_deref()
            .unwrap_or("")
            .contains("moved"),
        "{:?}",
        outcome.source.warning
    );
}

#[cfg(unix)]
#[test]
fn symlinks_and_submodules_in_libraries_are_not_followed() {
    let home = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    library_repo(remote.path());
    std::os::unix::fs::symlink(
        "/etc/hosts",
        remote.path().join("skills/incident-notes/hosts"),
    )
    .unwrap();
    git(remote.path(), &["add", "-A"]);
    git(remote.path(), &["commit", "-qm", "symlink"]);
    let sources = services(home.path());
    let source = sources
        .add(&NewSource {
            name: "Team".into(),
            location: remote.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    let index = sources.index(&source.id).unwrap();
    assert!(
        index
            .diagnostics
            .iter()
            .any(|d| d.message.contains("symbolic link"))
    );
    let item = index
        .items
        .iter()
        .find(|i| i.id == "incident-notes")
        .unwrap();
    assert!(item.files.iter().all(|f| f.path != "hosts"));
}

#[test]
fn plain_directory_sources_and_removal() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    let sources = services(home.path());
    let source = sources
        .add(&NewSource {
            name: "Folder".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    assert_eq!(source.kind, SourceKind::Directory);
    let r = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(r.current.starts_with("sha256:"));
    assert!(sources.index(&source.id).unwrap().items.len() > 5);
    assert!(
        sources
            .add(&NewSource {
                name: "folder".into(),
                location: lib.path().to_string_lossy().into(),
                subdir: None,
                tracked: TrackedRef::Default,
            })
            .is_err(),
        "names are unique, case-insensitively"
    );
    sources.remove(&source.id).unwrap();
    assert!(sources.list().unwrap().is_empty());
}

#[test]
fn credential_urls_are_rejected() {
    let home = tempfile::tempdir().unwrap();
    let sources = services(home.path());
    let err = sources
        .add(&NewSource {
            name: "x".into(),
            location: "https://alice:secret@example.com/team/skills.git".into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap_err();
    assert!(err.to_string().contains("password"));
    assert!(!err.to_info().message.contains("secret"));
}
