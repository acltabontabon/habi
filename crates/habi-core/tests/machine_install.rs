//! Installing library skills into the person's own skill folders ("this
//! machine"): what is written, what is recorded, what is refused, and how it
//! is removed and restored. The "home folder" is always a temporary one.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::clients::layout::Precedence;
use habi_core::install::plan::{ChangeOp, ConflictKind, Decisions, Resolution};
use habi_core::install::status::InstallState;
use habi_core::library::model::ItemKind;
use habi_core::service::{Habi, ItemRef};
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
    home: PathBuf,
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
        home: home.path().to_path_buf(),
        library: lib.path().to_path_buf(),
        project: project.root.clone(),
        project_id: project.id,
        source_id: source.id,
        habi,
        _dirs: vec![data, home, lib, proj],
    }
}

fn item(env: &Env, id: &str) -> ItemRef {
    ItemRef {
        source_id: env.source_id.clone(),
        item_id: id.into(),
    }
}

fn install(env: &Env, clients: &[ClientId]) -> habi_core::install::apply::OperationSummary {
    let plan = env
        .habi
        .plan_install_machine(&[item(env, SKILL)], clients, &Decisions::new())
        .unwrap();
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    env.habi.apply(&plan.id).unwrap()
}

fn library_file(env: &Env, rel: &str) -> Vec<u8> {
    std::fs::read(env.library.join("skills").join(SKILL).join(rel)).unwrap()
}

#[test]
fn a_machine_install_writes_only_the_chosen_folders_and_records_them() {
    let env = setup();
    let plan = env
        .habi
        .plan_install_machine(
            &[item(&env, SKILL)],
            &[ClientId::ClaudeCode],
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(plan.root, env.home);
    assert!(plan.title.ends_with("on this machine"), "{}", plan.title);
    let paths: Vec<&str> = plan.changes.iter().map(|c| c.path.as_str()).collect();
    assert!(paths.contains(&".claude/skills/liquibase-migration-review/SKILL.md"));
    assert!(paths.contains(&".habi/lock.json"));
    assert!(
        paths
            .iter()
            .all(|p| p.starts_with(".claude/skills/") || *p == ".habi/lock.json"),
        "{paths:?}"
    );
    assert!(plan.changes.iter().all(|c| c.op == ChangeOp::Create));
    // Previewing wrote nothing, here or in the project.
    assert!(!env.home.join(".claude").exists());
    assert!(!env.project.join(".claude/skills").join(SKILL).exists());

    env.habi.apply(&plan.id).unwrap();
    assert_eq!(
        std::fs::read(env.home.join(".claude/skills").join(SKILL).join("SKILL.md")).unwrap(),
        library_file(&env, "SKILL.md")
    );
    assert!(env.home.join(".habi/lock.json").is_file());
    assert!(!env.home.join(".agents").exists());
    // The project was not touched.
    assert!(!env.project.join(".claude/skills").join(SKILL).exists());

    // The listing knows Habi put it there, and from where.
    let listed = env.habi.machine_skills().unwrap();
    let ours = listed.iter().find(|s| s.folder == SKILL).unwrap();
    let managed = ours
        .managed
        .as_ref()
        .expect("recorded as installed by Habi");
    assert_eq!(managed.library, "Team library");
    assert_eq!(managed.state, InstallState::Current);
}

#[test]
fn clients_choose_the_folders_as_they_do_in_a_project() {
    let env = setup();
    install(&env, &[ClientId::Codex]);
    assert!(env.home.join(".agents/skills").join(SKILL).is_dir());
    assert!(!env.home.join(".claude").exists());
}

#[test]
fn a_folder_habi_did_not_install_is_a_conflict_and_is_left_alone() {
    let env = setup();
    let theirs = env.home.join(".claude/skills").join(SKILL);
    std::fs::create_dir_all(&theirs).unwrap();
    std::fs::write(theirs.join("SKILL.md"), "my own version\n").unwrap();

    let plan = env
        .habi
        .plan_install_machine(
            &[item(&env, SKILL)],
            &[ClientId::ClaudeCode],
            &Decisions::new(),
        )
        .unwrap();
    assert!(plan.is_blocked());
    let c = plan
        .conflicts
        .iter()
        .find(|c| c.path.ends_with("SKILL.md"))
        .unwrap();
    assert_eq!(c.kind, ConflictKind::UnmanagedContent);
    assert_eq!(c.options, [Resolution::Keep, Resolution::Overwrite]);
    assert_eq!(
        std::fs::read_to_string(theirs.join("SKILL.md")).unwrap(),
        "my own version\n"
    );
}

#[test]
fn removing_deletes_only_what_habi_installed() {
    let env = setup();
    install(&env, &[ClientId::ClaudeCode]);
    let folder = env.home.join(".claude/skills").join(SKILL);
    std::fs::write(folder.join("my-notes.txt"), "mine\n").unwrap();

    let key = env.habi.machine_skills().unwrap()[0]
        .managed
        .as_ref()
        .unwrap()
        .key
        .clone();
    let plan = env
        .habi
        .plan_remove_machine(&[key], &Decisions::new())
        .unwrap();
    assert!(plan.title.ends_with("this machine"), "{}", plan.title);
    assert!(plan.changes.iter().all(|c| c.op == ChangeOp::Delete));
    assert!(
        !plan
            .changes
            .iter()
            .any(|c| c.path.ends_with("my-notes.txt"))
    );
    env.habi.apply(&plan.id).unwrap();

    assert!(!folder.join("SKILL.md").exists());
    assert_eq!(
        std::fs::read_to_string(folder.join("my-notes.txt")).unwrap(),
        "mine\n"
    );
    // Nothing is recorded any more.
    assert!(!env.home.join(".habi/lock.json").exists());
}

#[test]
fn a_removal_can_be_restored_and_is_in_the_machine_history() {
    let env = setup();
    install(&env, &[ClientId::ClaudeCode]);
    let key = env.habi.machine_skills().unwrap()[0]
        .managed
        .as_ref()
        .unwrap()
        .key
        .clone();
    let removal = env
        .habi
        .plan_remove_machine(&[key], &Decisions::new())
        .unwrap();
    let removed = env.habi.apply(&removal.id).unwrap();
    let skill_md = env.home.join(".claude/skills").join(SKILL).join("SKILL.md");
    assert!(!skill_md.exists());

    let history = env.habi.machine_history().unwrap();
    assert!(history.iter().any(|o| o.id == removed.id));

    let restore = env
        .habi
        .plan_restore_machine(&removed.id, &Decisions::new())
        .unwrap();
    assert!(restore.conflicts.is_empty(), "{:?}", restore.conflicts);
    env.habi.apply(&restore.id).unwrap();
    assert_eq!(
        std::fs::read(&skill_md).unwrap(),
        library_file(&env, "SKILL.md")
    );
    let listed = env.habi.machine_skills().unwrap();
    assert!(listed[0].managed.is_some(), "the record came back too");
}

#[test]
fn an_update_shows_what_the_library_changed_and_keeps_local_edits_for_a_decision() {
    let env = setup();
    install(&env, &[ClientId::ClaudeCode]);
    let installed = env.home.join(".claude/skills").join(SKILL).join("SKILL.md");

    // The library moves on.
    let lib_file = env.library.join("skills").join(SKILL).join("SKILL.md");
    let newer = format!(
        "{}\nA new rule.\n",
        std::fs::read_to_string(&lib_file).unwrap()
    );
    std::fs::write(&lib_file, &newer).unwrap();
    git(&env.library, &["commit", "-qam", "newer"]);
    env.habi
        .sources()
        .refresh(&env.source_id, &CancelToken::new())
        .unwrap();
    let listed = env.habi.machine_skills().unwrap();
    let managed = listed[0].managed.as_ref().unwrap();
    assert_eq!(managed.state, InstallState::UpdateAvailable);

    let plan = env
        .habi
        .plan_update_machine(std::slice::from_ref(&managed.key), &Decisions::new())
        .unwrap();
    assert!(plan.conflicts.is_empty());
    assert!(
        plan.changes
            .iter()
            .any(|c| c.op == ChangeOp::Modify && c.path.ends_with("SKILL.md"))
    );
    env.habi.apply(&plan.id).unwrap();
    assert_eq!(std::fs::read_to_string(&installed).unwrap(), newer);

    // A local edit, then another upstream change: the edit is never overwritten silently.
    std::fs::write(&installed, format!("{newer}\nMy edit.\n")).unwrap();
    let newest = format!("{newer}\nAnother rule.\n");
    std::fs::write(&lib_file, &newest).unwrap();
    git(&env.library, &["commit", "-qam", "newest"]);
    env.habi
        .sources()
        .refresh(&env.source_id, &CancelToken::new())
        .unwrap();
    let key = env.habi.machine_skills().unwrap()[0]
        .managed
        .as_ref()
        .unwrap()
        .key
        .clone();
    let plan = env
        .habi
        .plan_update_machine(&[key], &Decisions::new())
        .unwrap();
    assert!(plan.is_blocked());
    assert!(
        plan.conflicts
            .iter()
            .any(|c| c.kind == ConflictKind::LocalEdits)
    );
    assert!(
        std::fs::read_to_string(&installed)
            .unwrap()
            .contains("My edit.")
    );
}

#[test]
fn instruction_files_are_never_added_to_this_machine() {
    let env = setup();
    let index = env.habi.sources().index(&env.source_id).unwrap();
    let instructions = index
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Instructions)
        .expect("the example library has an instruction file");
    let err = env
        .habi
        .plan_install_machine(
            &[item(&env, &instructions.id)],
            &[ClientId::ClaudeCode],
            &Decisions::new(),
        )
        .unwrap_err();
    assert!(err.to_string().contains("instruction"), "{err}");
    assert!(!env.home.join("AGENTS.md").exists());
}

#[test]
fn a_machine_lock_with_instruction_or_mcp_entries_is_refused() {
    let env = setup();
    install(&env, &[ClientId::ClaudeCode]);
    let lock_path = env.home.join(".habi/lock.json");
    let original = std::fs::read_to_string(&lock_path).unwrap();
    let key = {
        let lock: serde_json::Value = serde_json::from_str(&original).unwrap();
        let item = &lock["items"][0];
        format!(
            "{}#{}",
            item["source"]["identity"].as_str().unwrap(),
            item["id"].as_str().unwrap()
        )
    };
    let tampered: [fn(&mut serde_json::Value); 3] = [
        |v| {
            v["items"][0]["sections"] = serde_json::json!([
                { "file": "AGENTS.md", "marker": "m", "digest": "d" }
            ]);
        },
        |v| {
            v["items"][0]["mcp"] = serde_json::json!([
                { "client": "claude-code", "file": ".mcp.json", "server": "s", "digest": "d" }
            ]);
        },
        |v| v["items"][0]["kind"] = serde_json::json!("instructions"),
    ];
    for edit in tampered {
        let mut lock: serde_json::Value = serde_json::from_str(&original).unwrap();
        edit(&mut lock);
        std::fs::write(&lock_path, serde_json::to_string(&lock).unwrap()).unwrap();
        let removed = env
            .habi
            .plan_remove_machine(std::slice::from_ref(&key), &Decisions::new());
        let message = removed.map(|_| String::new()).unwrap_err().to_string();
        assert!(message.contains("never installs"), "{message}");
        let updated = env
            .habi
            .plan_update_machine(std::slice::from_ref(&key), &Decisions::new());
        let message = updated.map(|_| String::new()).unwrap_err().to_string();
        assert!(message.contains("never installs"), "{message}");
    }
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_skills_folder_that_is_a_link_into_dotfiles_is_refused_and_nothing_is_written() {
        let env = setup();
        let dotfiles = env.home.join("dotfiles/skills");
        std::fs::create_dir_all(&dotfiles).unwrap();
        std::fs::create_dir_all(env.home.join(".claude")).unwrap();
        symlink(&dotfiles, env.home.join(".claude/skills")).unwrap();

        let plan = env
            .habi
            .plan_install_machine(
                &[item(&env, SKILL)],
                &[ClientId::ClaudeCode],
                &Decisions::new(),
            )
            .unwrap();
        assert!(plan.is_blocked());
        let c = &plan.conflicts[0];
        assert_eq!(c.kind, ConflictKind::SymbolicLink);
        assert!(c.options.is_empty(), "there is no way to override a link");
        assert!(
            plan.changes
                .iter()
                .all(|c| !c.path.starts_with(".claude/skills/")),
            "{:?}",
            plan.changes.iter().map(|c| &c.path).collect::<Vec<_>>()
        );
        assert_eq!(std::fs::read_dir(&dotfiles).unwrap().count(), 0);
    }

    #[test]
    fn a_link_that_leaves_the_home_folder_is_refused() {
        let env = setup();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(env.home.join(".claude")).unwrap();
        symlink(elsewhere.path(), env.home.join(".claude/skills")).unwrap();
        let outcome = env.habi.plan_install_machine(
            &[item(&env, SKILL)],
            &[ClientId::ClaudeCode],
            &Decisions::new(),
        );
        // Either an error or a blocked plan, but never a write outside home.
        if let Ok(plan) = outcome {
            assert!(plan.is_blocked());
        }
        assert_eq!(std::fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }
}

#[test]
fn the_preview_names_projects_that_hold_the_same_skill_and_which_copy_wins() {
    let env = setup();
    // The project already has it, installed the usual way.
    let in_project = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, SKILL)],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    env.habi.apply(&in_project.id).unwrap();

    let shadows = env
        .habi
        .machine_install_preview(&[item(&env, SKILL)], &[ClientId::ClaudeCode])
        .unwrap();
    assert_eq!(shadows.len(), 1);
    assert_eq!(shadows[0].name, SKILL);
    let copy = &shadows[0].copies[0];
    assert_eq!(copy.project_id, env.project_id);
    assert_eq!(copy.path, format!(".claude/skills/{SKILL}"));
    assert!(
        copy.identical,
        "the library's digest matches the project's files"
    );
    let wins: Vec<(ClientId, Precedence)> = copy
        .shared_readers
        .iter()
        .map(|u| (u.client, u.precedence))
        .collect();
    assert_eq!(
        wins,
        [
            (ClientId::ClaudeCode, Precedence::PersonalWins),
            (ClientId::Cursor, Precedence::NotDocumented),
            (ClientId::Copilot, Precedence::NotDocumented),
            (ClientId::OpenCode, Precedence::NotDocumented)
        ]
    );

    // The project's copy drifts.
    std::fs::write(
        env.project
            .join(".claude/skills")
            .join(SKILL)
            .join("SKILL.md"),
        "changed\n",
    )
    .unwrap();
    let again = env
        .habi
        .machine_install_preview(&[item(&env, SKILL)], &[ClientId::ClaudeCode])
        .unwrap();
    assert!(!again[0].copies[0].identical);
}

#[test]
fn a_machine_install_is_not_confused_with_the_projects_own_record() {
    let env = setup();
    install(&env, &[ClientId::ClaudeCode]);
    // The project has no record of it, and its history is untouched.
    assert!(env.habi.history(&env.project_id).unwrap().is_empty());
    assert!(!env.project.join(".habi/lock.json").exists());
    let overview = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == SKILL)
        .unwrap();
    assert_eq!(rec.install_state, InstallState::NotInstalled);
}
