//! One list of everything that is behind its library: copies in projects and
//! on this machine, and projects whose record cannot be read.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::install::plan::Decisions;
use habi_core::service::{Habi, ItemRef, UpdatePlace};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::{Path, PathBuf};
use std::process::Command;

const SKILL: &str = "liquibase-migration-review";

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

struct Env {
    _dirs: Vec<tempfile::TempDir>,
    habi: Habi,
    library: PathBuf,
    project: PathBuf,
    project_id: String,
    source_id: String,
}

fn setup() -> Env {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    copy_tree(&fixture("repos/billing-service"), proj.path());
    let habi = Habi::open(AppPaths::at(data.path().to_path_buf()))
        .unwrap()
        .with_user_home(home.path().to_path_buf());
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team library".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let project = habi.open_project(proj.path()).unwrap();
    Env {
        library: lib.path().to_path_buf(),
        project: project.root.clone(),
        project_id: project.id,
        source_id: source.id,
        habi,
        _dirs: vec![data, home, lib, proj],
    }
}

#[test]
fn copies_behind_their_library_are_listed_by_where_they_are() {
    let env = setup();
    let item = || ItemRef {
        source_id: env.source_id.clone(),
        item_id: SKILL.into(),
    };
    let clients = [ClientId::ClaudeCode];
    let in_project = env
        .habi
        .plan_install(
            &env.project_id,
            &[item()],
            &clients,
            false,
            &Decisions::new(),
        )
        .unwrap();
    env.habi.apply_accepting_cautions(&in_project.id).unwrap();
    let on_machine = env
        .habi
        .plan_install_machine(&[item()], &clients, &Decisions::new())
        .unwrap();
    env.habi.apply_accepting_cautions(&on_machine.id).unwrap();

    // Up to date: nothing to say.
    let pending = env.habi.pending_updates().unwrap();
    assert!(pending.copies.is_empty(), "{:?}", pending.copies);
    assert!(pending.libraries.is_empty());
    assert!(pending.unreadable.is_empty());

    // A check made now is overtaken by the refresh below, and must not go on
    // saying the library has something newer.
    env.habi
        .sources()
        .check_update(&env.source_id, &CancelToken::new())
        .unwrap();
    let skill = env.library.join("skills").join(SKILL).join("SKILL.md");
    let text = std::fs::read_to_string(&skill).unwrap();
    std::fs::write(&skill, format!("{text}\nOne more step.\n")).unwrap();
    git(&env.library, &["commit", "-qam", "change"]);
    env.habi
        .sources()
        .refresh(&env.source_id, &CancelToken::new())
        .unwrap();

    let pending = env.habi.pending_updates().unwrap();
    assert!(pending.libraries.is_empty(), "{:?}", pending.libraries);
    assert_eq!(pending.copies.len(), 2, "{:?}", pending.copies);
    let project = pending
        .copies
        .iter()
        .find(|c| matches!(&c.place, UpdatePlace::Project { id, .. } if *id == env.project_id))
        .unwrap();
    assert_eq!(project.library, "Team library");
    assert_eq!(project.titles.len(), 1);
    let machine = pending
        .copies
        .iter()
        .find(|c| c.place == UpdatePlace::Machine)
        .unwrap();
    // What it lists is what an update takes.
    let update = env
        .habi
        .plan_update_machine(&machine.keys, &Decisions::new())
        .unwrap();
    env.habi.apply_accepting_cautions(&update.id).unwrap();
    let pending = env.habi.pending_updates().unwrap();
    assert_eq!(pending.copies.len(), 1);
    assert!(matches!(
        pending.copies[0].place,
        UpdatePlace::Project { .. }
    ));
}

#[test]
fn a_project_whose_record_cannot_be_read_is_said_not_skipped() {
    let env = setup();
    std::fs::create_dir_all(env.project.join(".habi")).unwrap();
    std::fs::write(env.project.join(".habi/lock.json"), "not a lock file").unwrap();
    let pending = env.habi.pending_updates().unwrap();
    assert!(pending.copies.is_empty());
    assert_eq!(pending.unreadable.len(), 1);
    assert_eq!(pending.unreadable[0].id, env.project_id);
    assert!(pending.unreadable[0].reason.contains("not a valid"));
}
