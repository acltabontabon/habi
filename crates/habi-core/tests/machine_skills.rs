//! The person's own skill folders (`~/.claude/skills` and the like): what is
//! found there, how a skill is copied out of one, and how it relates to the
//! copies in My skills and in projects. Every test reads a fake home folder;
//! none looks at the real one.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::clients::layout::Precedence;
use habi_core::install::plan::Decisions;
use habi_core::service::{Habi, ImportFrom, ItemRef};
use habi_core::skills::LOCAL_SOURCE_ID;
use habi_core::skills::intake::ImportSelection;
use habi_core::store::AppPaths;
use std::path::Path;

fn skill_text(name: &str, extra: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Reviews database migrations before they ship. Use when a change touches migrations.\n---\n\n# {name}\n\nCheck the rollback.\n{extra}\n"
    )
}

fn write_skill(home: &Path, base: &str, name: &str, extra: &str) {
    let dir = home.join(base).join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), skill_text(name, extra)).unwrap();
}

/// A Habi whose data and "home folder" are both temporary.
fn open(data: &Path, home: &Path) -> Habi {
    Habi::open(AppPaths::at(data.to_path_buf()))
        .unwrap()
        .with_user_home(home.to_path_buf())
}

fn import(habi: &Habi, id: &str) -> habi_core::skills::LocalSkillSummary {
    let from = ImportFrom::Machine { id: id.into() };
    let outcome = habi
        .import_skills(
            &from,
            &[ImportSelection {
                path: String::new(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    outcome.imported.into_iter().next().unwrap()
}

#[test]
fn skills_in_the_three_folders_are_found_with_their_readers() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write_skill(home.path(), ".claude/skills", "alpha", "");
    write_skill(home.path(), ".agents/skills", "beta", "");
    write_skill(home.path(), ".cursor/skills", "gamma", "");
    // Not skills: a loose file, a folder without SKILL.md, a hidden folder,
    // a plugin's skills, and a folder Codex's docs do not list.
    std::fs::write(home.path().join(".claude/skills/notes.txt"), "x").unwrap();
    std::fs::create_dir_all(home.path().join(".claude/skills/empty")).unwrap();
    write_skill(home.path(), ".claude/skills/.hidden-dir", "inner", "");
    write_skill(home.path(), ".claude/plugins/cache/p/skills", "plugged", "");
    write_skill(home.path(), ".codex/skills", "codexish", "");

    let habi = open(data.path(), home.path());
    let found = habi.machine_skills().unwrap();
    let ids: Vec<&str> = found.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["claude/alpha", "agents/beta", "cursor/gamma"]);

    let alpha = &found[0];
    assert_eq!(alpha.name, "alpha");
    assert_eq!(alpha.location, "~/.claude/skills/alpha");
    assert_eq!(alpha.readers, [ClientId::ClaudeCode, ClientId::Cursor]);
    assert_eq!(found[1].readers, [ClientId::Codex, ClientId::Cursor]);
    assert_eq!(found[2].readers, [ClientId::Cursor]);
    assert!(!alpha.is_link && alpha.complete && alpha.digest.len() > 10);
    assert!(alpha.imported_as.is_none() && alpha.in_projects.is_empty());
}

#[test]
fn nothing_found_is_an_empty_list_not_an_error() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let habi = open(data.path(), home.path());
    assert!(habi.machine_skills().unwrap().is_empty());
    // A skills folder that exists but is empty, and one that is a plain file.
    std::fs::create_dir_all(home.path().join(".claude/skills")).unwrap();
    std::fs::write(home.path().join(".cursor"), "not a folder").unwrap();
    assert!(habi.machine_skills().unwrap().is_empty());
}

#[test]
fn a_skill_in_two_folders_is_listed_once_per_location() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write_skill(home.path(), ".claude/skills", "shared", "");
    write_skill(home.path(), ".agents/skills", "shared", "");
    let found = open(data.path(), home.path()).machine_skills().unwrap();
    let ids: Vec<&str> = found.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["claude/shared", "agents/shared"]);
    assert_eq!(found[0].digest, found[1].digest);
}

#[test]
fn adding_to_my_skills_copies_and_leaves_the_global_folder_alone() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write_skill(home.path(), ".claude/skills", "alpha", "");
    let refs = home.path().join(".claude/skills/alpha/references");
    std::fs::create_dir_all(&refs).unwrap();
    std::fs::write(refs.join("rules.md"), "- one rule\n").unwrap();
    let before = std::fs::read(home.path().join(".claude/skills/alpha/SKILL.md")).unwrap();

    let habi = open(data.path(), home.path());
    let inspected = habi
        .inspect_import(
            &ImportFrom::Machine {
                id: "claude/alpha".into(),
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert_eq!(inspected.origin, "~/.claude/skills/alpha");
    assert_eq!(inspected.candidates.len(), 1);
    assert!(inspected.candidates[0].duplicate.is_none());

    let copy = import(&habi, "claude/alpha");
    assert_eq!(copy.name, "alpha");
    let local = habi.skills().get(&copy.id).unwrap();
    assert!(local.files.iter().any(|f| f.path == "references/rules.md"));
    assert_eq!(
        std::fs::read(habi.skills().file_path(&copy.id, "SKILL.md").unwrap()).unwrap(),
        before
    );
    // The original is exactly as it was.
    assert_eq!(
        std::fs::read(home.path().join(".claude/skills/alpha/SKILL.md")).unwrap(),
        before
    );

    // Once copied, the listing says so, and asking again reports a duplicate.
    let listed = habi.machine_skills().unwrap();
    assert_eq!(listed[0].imported_as.as_deref(), Some(copy.id.as_str()));
    let again = habi
        .inspect_import(
            &ImportFrom::Machine {
                id: "claude/alpha".into(),
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert!(again.candidates[0].duplicate.is_some());
}

#[test]
fn adding_to_a_project_installs_a_byte_identical_copy_and_says_who_wins() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    write_skill(home.path(), ".claude/skills", "alpha", "");
    let habi = open(data.path(), home.path());
    copy_tree(&fixture("repos/billing-service"), proj.path());
    let project_id = habi.open_project(proj.path()).unwrap().id;

    let copy = import(&habi, "claude/alpha");
    let plan = habi
        .plan_install(
            &project_id,
            &[ItemRef {
                source_id: LOCAL_SOURCE_ID.into(),
                item_id: copy.name.clone(),
            }],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    habi.apply(&plan.id).unwrap();

    let global = std::fs::read(home.path().join(".claude/skills/alpha/SKILL.md")).unwrap();
    let installed = std::fs::read(proj.path().join(".claude/skills/alpha/SKILL.md")).unwrap();
    assert_eq!(global, installed);

    // Day one the two are identical, and Claude Code reads both, so it uses
    // the personal one; Cursor also reads both and does not document an order.
    let listed = habi.machine_skills().unwrap();
    let copies = &listed[0].in_projects;
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0].project_id, project_id);
    assert_eq!(copies[0].path, ".claude/skills/alpha");
    assert!(copies[0].identical);
    let by_client: Vec<(ClientId, Precedence)> = copies[0]
        .shared_readers
        .iter()
        .map(|u| (u.client, u.precedence))
        .collect();
    assert_eq!(
        by_client,
        [
            (ClientId::ClaudeCode, Precedence::PersonalWins),
            (ClientId::Cursor, Precedence::NotDocumented)
        ]
    );

    // The project's copy drifts; the listing notices.
    std::fs::write(
        proj.path().join(".claude/skills/alpha/SKILL.md"),
        skill_text("alpha", "A teammate's change."),
    )
    .unwrap();
    assert!(!habi.machine_skills().unwrap()[0].in_projects[0].identical);
}

#[test]
fn a_copy_no_client_reads_alongside_the_global_one_shadows_nothing() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    // Global: read by Claude Code and Cursor. Project: only in `.agents/skills`,
    // which Claude Code does not read, so only Cursor sees both.
    write_skill(home.path(), ".claude/skills", "alpha", "");
    write_skill(proj.path(), ".agents/skills", "alpha", "");
    let habi = open(data.path(), home.path());
    habi.open_project(proj.path()).unwrap();
    let listed = habi.machine_skills().unwrap();
    let copies = &listed[0].in_projects;
    assert_eq!(copies.len(), 1);
    let clients: Vec<ClientId> = copies[0].shared_readers.iter().map(|u| u.client).collect();
    assert_eq!(clients, [ClientId::Cursor]);
}

#[test]
fn text_pointing_into_a_home_folder_is_flagged() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    write_skill(
        home.path(),
        ".claude/skills",
        "clean",
        "Use ~/notes and ./scripts.",
    );
    write_skill(
        home.path(),
        ".claude/skills",
        "personal",
        "Run /Users/ana/bin/tool first.",
    );
    let own = format!("Reads {}/dotfiles/x.", home.path().display());
    write_skill(home.path(), ".claude/skills", "own-home", &own);
    let found = open(data.path(), home.path()).machine_skills().unwrap();
    let flagged = |name: &str| {
        found
            .iter()
            .find(|s| s.name == name)
            .unwrap()
            .mentions_home
            .clone()
    };
    assert!(flagged("clean").is_empty());
    assert_eq!(flagged("personal"), ["SKILL.md"]);
    assert_eq!(flagged("own-home"), ["SKILL.md"]);
}

#[test]
fn ids_that_try_to_leave_the_skill_folders_are_refused() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("SKILL.md"), skill_text("outside", "")).unwrap();
    write_skill(home.path(), ".claude/skills", "alpha", "");
    let habi = open(data.path(), home.path());
    for id in [
        "claude/..".to_string(),
        "claude/../../x".to_string(),
        format!("claude/{}", outside.path().display()),
        "elsewhere/alpha".to_string(),
        "alpha".to_string(),
        "claude/missing".to_string(),
    ] {
        assert!(
            habi.inspect_import(&ImportFrom::Machine { id: id.clone() }, &CancelToken::new())
                .is_err(),
            "{id}"
        );
        assert!(
            habi.import_skills(
                &ImportFrom::Machine { id: id.clone() },
                &[ImportSelection {
                    path: String::new(),
                    rename: None
                }],
                &CancelToken::new()
            )
            .is_err(),
            "{id}"
        );
    }
    assert!(habi.skills().list().unwrap().is_empty());
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_linked_skill_is_marked_and_copied_by_content() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        // The skill really lives in a dotfiles checkout.
        write_skill(home.path(), "dotfiles", "alpha", "");
        std::fs::create_dir_all(home.path().join(".claude/skills")).unwrap();
        symlink(
            home.path().join("dotfiles/alpha"),
            home.path().join(".claude/skills/alpha"),
        )
        .unwrap();
        // And a dangling link is not a skill.
        symlink(
            home.path().join("gone"),
            home.path().join(".claude/skills/dangling"),
        )
        .unwrap();

        let habi = open(data.path(), home.path());
        let found = habi.machine_skills().unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].is_link && found[0].complete);

        let copy = import(&habi, "claude/alpha");
        let path = habi.skills().file_path(&copy.id, "SKILL.md").unwrap();
        assert!(
            !std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read(path).unwrap(),
            std::fs::read(home.path().join("dotfiles/alpha/SKILL.md")).unwrap()
        );
    }

    #[test]
    fn a_skills_folder_that_is_a_link_marks_every_skill_in_it() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write_skill(home.path(), "dotfiles/skills", "alpha", "");
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        symlink(
            home.path().join("dotfiles/skills"),
            home.path().join(".claude/skills"),
        )
        .unwrap();
        let found = open(data.path(), home.path()).machine_skills().unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].is_link);
    }

    #[test]
    fn a_link_inside_a_skill_makes_it_incomplete_and_not_importable() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write_skill(home.path(), ".claude/skills", "alpha", "");
        symlink("/etc/hosts", home.path().join(".claude/skills/alpha/hosts")).unwrap();
        let habi = open(data.path(), home.path());
        let found = habi.machine_skills().unwrap();
        assert!(!found[0].complete);
        let outcome = habi
            .import_skills(
                &ImportFrom::Machine {
                    id: "claude/alpha".into(),
                },
                &[ImportSelection {
                    path: String::new(),
                    rename: None,
                }],
                &CancelToken::new(),
            )
            .unwrap();
        assert!(outcome.imported.is_empty());
        assert_eq!(outcome.skipped.len(), 1);
    }
}
