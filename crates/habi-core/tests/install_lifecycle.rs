//! Install → update → local edits → remove → restore, plus failure handling.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::error::HabiError;
use habi_core::install::apply::{Applier, Fault, JournalState};
use habi_core::install::plan::{ChangeOp, ConflictKind, Decisions, Resolution};
use habi_core::install::status::InstallState;
use habi_core::service::{Habi, ItemRef};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::{AppPaths, ResourceLock};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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

fn setup(repo: &str) -> Env {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    copy_tree(&fixture(repo), proj.path());
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
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
        _dirs: vec![home, lib, proj],
    }
}

fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into(),
                    std::fs::read(&p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn item(env: &Env, id: &str) -> ItemRef {
    ItemRef {
        source_id: env.source_id.clone(),
        item_id: id.into(),
    }
}

fn state(env: &Env, id: &str) -> InstallState {
    let overview = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap();
    overview
        .recommendations
        .iter()
        .find(|r| r.item.id == id)
        .unwrap()
        .install_state
}

#[test]
fn full_lifecycle_preserves_user_content() {
    let env = setup("repos/billing-service");
    let original_claude = std::fs::read_to_string(env.project.join("CLAUDE.md")).unwrap();
    let clients = [ClientId::ClaudeCode, ClientId::Codex];
    let none = Decisions::new();

    // Preview: nothing is written yet.
    let before = tree(&env.project);
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[
                item(&env, "liquibase-migration-review"),
                item(&env, "java-service-conventions"),
                item(&env, "github-pr-summary"),
            ],
            &clients,
            true,
            &none,
        )
        .unwrap();
    assert_eq!(
        tree(&env.project),
        before,
        "planning must not modify the project"
    );
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    assert_eq!(
        plan.title,
        "Install for Claude Code and Codex in this project"
    );
    let paths: Vec<&str> = plan.changes.iter().map(|c| c.path.as_str()).collect();
    for expected in [
        ".agents/skills/liquibase-migration-review/SKILL.md",
        ".claude/skills/liquibase-migration-review/references/checklist.md",
        "AGENTS.md",
        "CLAUDE.md",
        ".mcp.json",
        ".codex/config.toml",
        ".habi/lock.json",
    ] {
        assert!(paths.contains(&expected), "missing {expected} in {paths:?}");
    }
    assert_eq!(
        paths.last(),
        Some(&".habi/lock.json"),
        "lock file is written last"
    );
    let claude_change = plan.changes.iter().find(|c| c.path == "CLAUDE.md").unwrap();
    assert_eq!(claude_change.op, ChangeOp::Modify);

    env.habi.apply(&plan.id).unwrap();
    let claude = std::fs::read_to_string(env.project.join("CLAUDE.md")).unwrap();
    assert!(
        claude.starts_with(&original_claude),
        "existing CLAUDE.md text is preserved"
    );
    assert!(claude.contains("@AGENTS.md"));
    let agents = std::fs::read_to_string(env.project.join("AGENTS.md")).unwrap();
    assert!(agents.contains("## Java service conventions"));
    let mcp = std::fs::read_to_string(env.project.join(".mcp.json")).unwrap();
    assert!(mcp.contains("${GITHUB_PERSONAL_ACCESS_TOKEN}"));
    let lock = std::fs::read_to_string(env.project.join(".habi/lock.json")).unwrap();
    assert!(
        !lock.contains(&env.library.to_string_lossy().to_string()),
        "no absolute paths in the lock"
    );
    assert!(!lock.contains(&env.project.to_string_lossy().to_string()));

    // Installed artifacts are plain files: usable without Habi.
    let skill = std::fs::read_to_string(
        env.project
            .join(".claude/skills/liquibase-migration-review/SKILL.md"),
    )
    .unwrap();
    assert!(skill.starts_with("---\nname: liquibase-migration-review"));

    // Idempotent: the same request now changes nothing.
    let again = env
        .habi
        .plan_install(
            &env.project_id,
            &[
                item(&env, "liquibase-migration-review"),
                item(&env, "java-service-conventions"),
                item(&env, "github-pr-summary"),
            ],
            &clients,
            true,
            &none,
        )
        .unwrap();
    assert!(
        again.changes.is_empty(),
        "{:?}",
        again.changes.iter().map(|c| &c.path).collect::<Vec<_>>()
    );
    assert_eq!(
        state(&env, "liquibase-migration-review"),
        InstallState::Current
    );

    // Upstream change: refresh discovers it without touching the project.
    let lib_skill = env
        .library
        .join("skills/liquibase-migration-review/SKILL.md");
    let mut text = std::fs::read_to_string(&lib_skill).unwrap();
    text.push_str("\n7. Check that the changelog applies to an empty database.\n");
    std::fs::write(&lib_skill, text).unwrap();
    git(&env.library, &["commit", "-qam", "Add empty-database step"]);
    let snapshot_before_refresh = tree(&env.project);
    let outcome = env
        .habi
        .sources()
        .refresh(&env.source_id, &CancelToken::new())
        .unwrap();
    assert_eq!(
        outcome.updated,
        vec!["liquibase-migration-review".to_string()]
    );
    assert_eq!(
        tree(&env.project),
        snapshot_before_refresh,
        "refresh never modifies a project"
    );
    assert_eq!(
        state(&env, "liquibase-migration-review"),
        InstallState::UpdateAvailable
    );

    // Local edit to the Claude Code copy: update shows a conflict and keeps the edit.
    let claude_copy = env
        .project
        .join(".claude/skills/liquibase-migration-review/SKILL.md");
    let mut edited = std::fs::read_to_string(&claude_copy).unwrap();
    edited.push_str("\nLocal note: our DBA reviews every changeset.\n");
    std::fs::write(&claude_copy, &edited).unwrap();
    assert_eq!(
        state(&env, "liquibase-migration-review"),
        InstallState::Conflict
    );
    let installed_key = env
        .habi
        .overview(&env.project_id, false, &CancelToken::new())
        .unwrap()
        .recommendations
        .iter()
        .find(|r| r.item.id == "liquibase-migration-review")
        .and_then(|r| r.installation.as_ref().map(|i| i.key.clone()))
        .unwrap();
    let update = env
        .habi
        .plan_update(&env.project_id, std::slice::from_ref(&installed_key), &none)
        .unwrap();
    assert_eq!(update.conflicts.len(), 1);
    assert_eq!(update.conflicts[0].kind, ConflictKind::LocalEdits);
    assert_eq!(
        update.conflicts[0].path,
        ".claude/skills/liquibase-migration-review/SKILL.md"
    );
    assert!(
        env.habi.apply(&update.id).is_err(),
        "a plan with conflicts cannot be applied"
    );
    assert_eq!(std::fs::read_to_string(&claude_copy).unwrap(), edited);

    let mut keep = Decisions::new();
    keep.insert(
        ".claude/skills/liquibase-migration-review/SKILL.md".into(),
        Resolution::Keep,
    );
    let update = env
        .habi
        .plan_update(&env.project_id, std::slice::from_ref(&installed_key), &keep)
        .unwrap();
    assert!(update.conflicts.is_empty());
    env.habi.apply(&update.id).unwrap();
    assert_eq!(
        std::fs::read_to_string(&claude_copy).unwrap(),
        edited,
        "local edit preserved"
    );
    let agents_copy = std::fs::read_to_string(
        env.project
            .join(".agents/skills/liquibase-migration-review/SKILL.md"),
    )
    .unwrap();
    assert!(
        agents_copy.contains("empty database"),
        "unedited copy updated"
    );
    assert_eq!(
        state(&env, "liquibase-migration-review"),
        InstallState::LocallyModified
    );

    // Stale preview: a file changes between preview and apply.
    let removal = env
        .habi
        .plan_remove(&env.project_id, std::slice::from_ref(&installed_key), &keep)
        .unwrap();
    std::fs::write(
        env.project
            .join(".agents/skills/liquibase-migration-review/SKILL.md"),
        "changed after preview",
    )
    .unwrap();
    let err = env.habi.apply(&removal.id).unwrap_err();
    assert!(matches!(err, HabiError::StalePlan(_)), "{err}");
    std::fs::write(
        env.project
            .join(".agents/skills/liquibase-migration-review/SKILL.md"),
        &agents_copy,
    )
    .unwrap();

    // Removal deletes only unchanged managed content; the edited copy needs a decision.
    let removal = env
        .habi
        .plan_remove(&env.project_id, std::slice::from_ref(&installed_key), &none)
        .unwrap();
    assert_eq!(removal.conflicts.len(), 1);
    let removal = env
        .habi
        .plan_remove(&env.project_id, std::slice::from_ref(&installed_key), &keep)
        .unwrap();
    let removed = env.habi.apply(&removal.id).unwrap();
    assert!(
        !env.project
            .join(".agents/skills/liquibase-migration-review")
            .exists()
    );
    assert_eq!(
        std::fs::read_to_string(&claude_copy).unwrap(),
        edited,
        "edited copy kept"
    );

    // Remove the rest; CLAUDE.md returns to exactly what the team wrote.
    let overview = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap();
    let keys: Vec<String> = overview
        .recommendations
        .iter()
        .filter_map(|r| r.installation.as_ref().map(|i| i.key.clone()))
        .collect();
    assert_eq!(keys.len(), 2, "{keys:?}");
    let rest = env.habi.plan_remove(&env.project_id, &keys, &none).unwrap();
    assert!(rest.conflicts.is_empty(), "{:?}", rest.conflicts);
    let rest_op = env.habi.apply(&rest.id).unwrap();
    assert_eq!(
        std::fs::read_to_string(env.project.join("CLAUDE.md")).unwrap(),
        original_claude
    );
    assert!(
        !env.project.join("AGENTS.md").exists(),
        "AGENTS.md Habi created and emptied is removed"
    );
    assert!(!env.project.join(".habi/lock.json").exists());
    assert!(
        !env.project.join(".mcp.json").exists() && !env.project.join(".codex/config.toml").exists(),
        "MCP files Habi created and emptied are removed"
    );

    // Restoring an older operation does not restore the lock file blindly (a
    // later operation changed it too): the lock is recomputed, so there is
    // nothing to decide about it.
    let older = env
        .habi
        .plan_restore(&env.project_id, &removed.id, &none)
        .unwrap();
    assert!(older.conflicts.is_empty(), "{:?}", older.conflicts);
    let lock_change = older
        .changes
        .iter()
        .find(|c| c.path == ".habi/lock.json")
        .expect("the lock records the restored skill");
    let lock =
        habi_core::install::lock::LockFile::parse(lock_change.content.as_ref().unwrap()).unwrap();
    let ids: Vec<&str> = lock.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["liquibase-migration-review"],
        "later removals stay removed"
    );

    // Restoring the latest operation brings the instructions, bridge and MCP entry back.
    let restore = env
        .habi
        .plan_restore(&env.project_id, &rest_op.id, &none)
        .unwrap();
    assert!(
        restore.conflicts.is_empty(),
        "{:?}",
        restore
            .conflicts
            .iter()
            .map(|c| &c.path)
            .collect::<Vec<_>>()
    );
    env.habi.apply(&restore.id).unwrap();
    assert!(
        std::fs::read_to_string(env.project.join("CLAUDE.md"))
            .unwrap()
            .contains("@AGENTS.md")
    );
    assert!(
        std::fs::read_to_string(env.project.join("AGENTS.md"))
            .unwrap()
            .contains("Java service conventions")
    );
    assert!(env.project.join(".habi/lock.json").exists());

    // Then the older one: the skill comes back and the lock keeps the
    // entries the later restore added.
    let older = env
        .habi
        .plan_restore(&env.project_id, &removed.id, &none)
        .unwrap();
    assert!(older.conflicts.is_empty(), "{:?}", older.conflicts);
    env.habi.apply(&older.id).unwrap();
    assert!(
        env.project
            .join(".agents/skills/liquibase-migration-review/SKILL.md")
            .exists()
    );
    let lock = habi_core::install::lock::LockFile::parse(
        &std::fs::read(env.project.join(".habi/lock.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        lock.items.len(),
        4,
        "three items and the Claude Code bridge"
    );
    let overview = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap();
    let installed: Vec<&str> = overview
        .recommendations
        .iter()
        .filter(|r| r.installation.is_some())
        .map(|r| r.item.id.as_str())
        .collect();
    assert_eq!(installed.len(), 3, "{installed:?}");
    // The Claude Code copy was kept with the local edit throughout.
    assert_eq!(
        state(&env, "liquibase-migration-review"),
        InstallState::LocallyModified
    );
}

#[test]
fn unmanaged_files_are_never_overwritten_silently() {
    let env = setup("repos/billing-service");
    let target = env.project.join(".claude/skills/jpa-entity-review");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(
        target.join("SKILL.md"),
        "---\nname: jpa-entity-review\ndescription: our own\n---\nHand written.\n",
    )
    .unwrap();
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "jpa-entity-review")],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].kind, ConflictKind::UnmanagedContent);
    assert!(plan.conflicts[0].diff.is_some());
    assert!(env.habi.apply(&plan.id).is_err());
    assert!(
        std::fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .contains("Hand written")
    );

    // Explicitly adopting it replaces the file and keeps the original recoverable.
    let mut adopt = Decisions::new();
    adopt.insert(
        ".claude/skills/jpa-entity-review/SKILL.md".into(),
        Resolution::Overwrite,
    );
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "jpa-entity-review")],
            &[ClientId::ClaudeCode],
            false,
            &adopt,
        )
        .unwrap();
    let op = env.habi.apply(&plan.id).unwrap();
    assert!(
        !std::fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .contains("Hand written")
    );
    let restore = env
        .habi
        .plan_restore(&env.project_id, &op.id, &Decisions::new())
        .unwrap();
    env.habi.apply(&restore.id).unwrap();
    assert!(
        std::fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .contains("Hand written")
    );
}

#[test]
fn failures_and_crashes_roll_back() {
    let env = setup("repos/storefront-web");
    let before = tree(&env.project);
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[
                item(&env, "react-component-review"),
                item(&env, "frontend-test-practices"),
            ],
            &[ClientId::Cursor],
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert!(plan.changes.len() > 3);
    let applier = Applier {
        paths: &env.habi.paths,
        store: &env.habi.store,
    };

    // A failure mid-apply undoes the completed steps.
    let err = applier.apply_with(&plan, Fault::FailBefore(2)).unwrap_err();
    assert!(err.to_string().contains("rolled back"), "{err}");
    assert_eq!(tree(&env.project), before);

    // A crash leaves an `applying` journal; recovery restores the project.
    assert!(applier.apply_with(&plan, Fault::CrashBefore(2)).is_err());
    assert_ne!(tree(&env.project), before, "crash left partial changes");
    let recovered = env.habi.recover(&env.project_id).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, JournalState::RolledBack);
    assert_eq!(tree(&env.project), before);

    // The same plan still applies cleanly afterwards.
    applier.apply(&plan).unwrap();
    assert!(
        env.project
            .join(".agents/skills/react-component-review/SKILL.md")
            .exists()
    );
    // Existing AGENTS.md written by the team was not touched (no instructions installed).
    assert_eq!(
        std::fs::read(env.project.join("AGENTS.md")).unwrap(),
        before["AGENTS.md"]
    );
}

#[test]
fn recovery_reads_unfinished_operations_and_reports_unreadable_ones() {
    let env = setup("repos/storefront-web");
    let before = tree(&env.project);
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "react-component-review")],
            &[ClientId::Cursor],
            false,
            &Decisions::new(),
        )
        .unwrap();
    let applier = Applier {
        paths: &env.habi.paths,
        store: &env.habi.store,
    };
    let dir = env.habi.paths.journal().join(&env.project_id);
    let markers = || {
        std::fs::read_dir(dir.join("unfinished"))
            .map(|d| d.count())
            .unwrap_or(0)
    };
    assert!(applier.apply_with(&plan, Fault::CrashBefore(1)).is_err());
    assert_eq!(markers(), 1, "the interrupted operation is indexed");

    // Journals written before the index existed (no index folder) are all
    // read once; an unreadable one is listed as needing attention.
    std::fs::remove_dir_all(dir.join("unfinished")).unwrap();
    std::fs::write(dir.join("broken.json"), b"{ not json").unwrap();
    let recovered = env.habi.recover(&env.project_id).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, JournalState::RolledBack);
    assert_eq!(tree(&env.project), before);
    assert_eq!(markers(), 0);
    let history = env.habi.history(&env.project_id).unwrap();
    let broken = history.iter().find(|o| o.id == "broken").unwrap();
    assert_eq!(broken.state, JournalState::NeedsAttention);
    assert!(!broken.problems.is_empty());

    // An indexed journal that cannot be read is reported once.
    std::fs::write(dir.join("unfinished").join("broken"), b"").unwrap();
    let recovered = env.habi.recover(&env.project_id).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, JournalState::NeedsAttention);
    assert!(env.habi.recover(&env.project_id).unwrap().is_empty());

    // A completed operation leaves nothing in the index.
    applier.apply(&plan).unwrap();
    assert_eq!(markers(), 0);
}

#[test]
fn concurrent_operations_are_serialized() {
    let env = setup("repos/storefront-web");
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "react-component-review")],
            &[ClientId::Codex],
            false,
            &Decisions::new(),
        )
        .unwrap();
    let applier = Applier {
        paths: &env.habi.paths,
        store: &env.habi.store,
    };
    // Another process (e.g. the CLI) holds the project lock.
    let held = ResourceLock::acquire(
        &env.habi.paths,
        &format!(
            "project-{}",
            habi_core::install::apply::project_id(&env.project)
        ),
        Duration::from_millis(10),
    )
    .unwrap();
    let err = applier.apply(&plan).unwrap_err();
    assert!(matches!(err, HabiError::Busy(_)), "{err}");
    drop(held);
    applier.apply(&plan).unwrap();
    // Re-applying the same (now stale) plan is refused.
    assert!(matches!(applier.apply(&plan), Err(HabiError::StalePlan(_))));
}

#[test]
fn instructions_respect_existing_agents_md() {
    let env = setup("repos/platform-monorepo");
    std::fs::write(
        env.project.join("AGENTS.md"),
        "# Team rules\n\nNever commit generated code.\n",
    )
    .unwrap();
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "java-service-conventions")],
            &[ClientId::Codex, ClientId::Cursor],
            false,
            &Decisions::new(),
        )
        .unwrap();
    env.habi.apply(&plan.id).unwrap();
    let text = std::fs::read_to_string(env.project.join("AGENTS.md")).unwrap();
    assert!(text.starts_with("# Team rules\n\nNever commit generated code.\n"));
    assert!(text.contains("<!-- habi:begin id=java-service-conventions"));
    assert!(
        !env.project.join("CLAUDE.md").exists(),
        "no Claude bridge without Claude Code"
    );

    // Hand edit inside the managed section is detected on removal.
    let edited = text.replace(
        "Prefer constructor injection",
        "Prefer constructor injection (always)",
    );
    std::fs::write(env.project.join("AGENTS.md"), &edited).unwrap();
    let key = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap()
        .recommendations
        .into_iter()
        .find(|r| r.item.id == "java-service-conventions")
        .unwrap()
        .installation
        .unwrap()
        .key;
    let removal = env
        .habi
        .plan_remove(&env.project_id, &[key], &Decisions::new())
        .unwrap();
    assert_eq!(removal.conflicts.len(), 1);
    assert_eq!(
        removal.conflicts[0].path, "AGENTS.md#java-service-conventions",
        "decisions are per section"
    );
}

#[test]
fn case_only_renames_executable_bits_and_user_deletions() {
    let env = setup("repos/billing-service");
    // Library v2: rename a reference by letter case and add an executable script.
    let skill_dir = env.library.join("skills/liquibase-migration-review");
    let plan = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "liquibase-migration-review")],
            &[ClientId::Codex],
            false,
            &Decisions::new(),
        )
        .unwrap();
    env.habi.apply(&plan.id).unwrap();
    let installed = env
        .project
        .join(".agents/skills/liquibase-migration-review");

    git(
        &env.library,
        &[
            "mv",
            "skills/liquibase-migration-review/references/checklist.md",
            "skills/liquibase-migration-review/references/tmp.md",
        ],
    );
    git(
        &env.library,
        &[
            "mv",
            "skills/liquibase-migration-review/references/tmp.md",
            "skills/liquibase-migration-review/references/Checklist.md",
        ],
    );
    std::fs::create_dir_all(skill_dir.join("scripts")).unwrap();
    std::fs::write(
        skill_dir.join("scripts/validate.sh"),
        "#!/bin/sh\necho ok\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            skill_dir.join("scripts/validate.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    git(&env.library, &["add", "-A"]);
    git(&env.library, &["commit", "-qm", "Rename and add script"]);
    env.habi
        .sources()
        .refresh(&env.source_id, &CancelToken::new())
        .unwrap();

    let key = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap()
        .recommendations
        .into_iter()
        .find(|r| r.item.id == "liquibase-migration-review")
        .unwrap()
        .installation
        .unwrap()
        .key;
    let update = env
        .habi
        .plan_update(
            &env.project_id,
            std::slice::from_ref(&key),
            &Decisions::new(),
        )
        .unwrap();
    assert!(update.conflicts.is_empty(), "{:?}", update.conflicts);
    env.habi.apply(&update.id).unwrap();
    let names: Vec<String> = std::fs::read_dir(installed.join("references"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        vec!["Checklist.md".to_string()],
        "renamed by case, content kept"
    );
    let lock = std::fs::read_to_string(env.project.join(".habi/lock.json")).unwrap();
    assert!(lock.contains("references/Checklist.md") && !lock.contains("references/checklist.md"));
    #[cfg(unix)]
    assert!(
        habi_core::fsutil::is_executable(&installed.join("scripts/validate.sh")),
        "scripts stay executable"
    );

    // A user deletes an installed file: Habi asks before putting it back.
    std::fs::remove_file(installed.join("SKILL.md")).unwrap();
    let again = env
        .habi
        .plan_install(
            &env.project_id,
            &[item(&env, "liquibase-migration-review")],
            &[ClientId::Codex],
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(
        again.conflicts.len(),
        1,
        "{:?}",
        again.changes.iter().map(|c| &c.path).collect::<Vec<_>>()
    );
    assert!(again.conflicts[0].message.contains("deleted"));
}
