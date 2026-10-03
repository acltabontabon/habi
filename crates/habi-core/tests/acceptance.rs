//! The acceptance scenario from the product brief, end to end, through the
//! same service the desktop app and CLI use. Each numbered step matches the
//! brief. Git operations use temporary local repositories only.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::contribute::{ContributionOrigin, ContributionState};
use habi_core::install::plan::{ConflictKind, Decisions, Resolution};
use habi_core::install::status::InstallState;
use habi_core::library::model::Requirement;
use habi_core::library::parse_frontmatter;
use habi_core::matching::Applicability;
use habi_core::recommend::{Group, ReadinessState};
use habi_core::service::{Habi, ItemRef};
use habi_core::source::{Freshness, NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Team Maintainer",
            "-c",
            "user.email=maintainer@example.invalid",
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
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn tree_bytes(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            if e.path().is_dir() {
                stack.push(e.path());
            } else {
                out.push((
                    e.path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into(),
                    std::fs::read(e.path()).unwrap(),
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn acceptance_scenario() {
    let home = tempfile::tempdir().unwrap();
    let remote_parent = tempfile::tempdir().unwrap();
    let remote = remote_parent.path().join("team-skills");
    let workspace = tempfile::tempdir().unwrap();
    let patches = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();

    // 1. Start Habi with no account or cloud backend: only a local data folder.
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();

    // 2. Connect a local Git team-library fixture and open a real fixture project.
    copy_tree(&fixture("libraries/example-team-library"), &remote);
    git(&remote, &["init", "-q"]);
    git(&remote, &["add", "-A"]);
    git(&remote, &["commit", "-qm", "Team library"]);
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: remote.to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    habi.sources().refresh(&source.id, &cancel).unwrap();
    let project_dir = workspace.path().join("billing-service");
    copy_tree(&fixture("repos/billing-service"), &project_dir);
    let other_dir = workspace.path().join("storefront-web");
    copy_tree(&fixture("repos/storefront-web"), &other_dir);
    let other_before = tree_bytes(&other_dir);
    let project = habi.open_project(&project_dir).unwrap();

    // 3. Evidence-backed recommendations, and an intentionally inapplicable skill.
    let overview = habi.overview(&project.id, true, &cancel).unwrap();
    let rec = |id: &str| {
        overview
            .recommendations
            .iter()
            .find(|r| r.item.id == id)
            .unwrap()
            .clone()
    };
    let liquibase = rec("liquibase-migration-review");
    assert_eq!(liquibase.group, Group::Relevant);
    let leaf_with_evidence = liquibase.applicability.modules[0]
        .applies
        .as_ref()
        .unwrap()
        .children
        .iter()
        .any(|c| !c.facts.is_empty());
    assert!(leaf_with_evidence, "reasons link to facts");
    let react = rec("react-component-review");
    assert_eq!(
        react.applicability.applicability,
        Applicability::DoesNotApply
    );
    assert_eq!(react.group, Group::NotApplicable);

    // A team requirement whose conditions do not hold is listed with what does
    // not apply, still marked required — never as a requirement of this project.
    let storefront = habi.open_project(&other_dir).unwrap();
    let front = habi.overview(&storefront.id, true, &cancel).unwrap();
    let java = front
        .recommendations
        .iter()
        .find(|r| r.item.id == "java-service-conventions")
        .unwrap();
    assert_eq!(
        java.applicability.applicability,
        Applicability::DoesNotApply
    );
    assert_eq!(java.group, Group::NotApplicable);
    assert_eq!(java.item.requirement, Requirement::Required);

    // 4. A relevant skill with a missing prerequisite: applicability and readiness stay separate.
    let pr = rec("github-pr-summary");
    assert_eq!(pr.applicability.applicability, Applicability::Applies);
    assert_eq!(pr.readiness.state, ReadinessState::Missing);

    // 5. Select clients, preview, install only to the selected project.
    let plan = habi
        .plan_install(
            &project.id,
            &[ItemRef {
                source_id: source.id.clone(),
                item_id: "liquibase-migration-review".into(),
            }],
            &[ClientId::Cursor],
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(plan.title, "Install for Cursor in this project");
    assert!(plan.conflicts.is_empty());
    habi.apply(&plan.id).unwrap();
    assert!(
        project_dir
            .join(".agents/skills/liquibase-migration-review/SKILL.md")
            .exists()
    );
    assert_eq!(
        tree_bytes(&other_dir),
        other_before,
        "other projects are untouched"
    );

    // 6. Close Habi: installed artifacts remain ordinary, standard files.
    drop(habi);
    let skill = std::fs::read_to_string(
        project_dir.join(".agents/skills/liquibase-migration-review/SKILL.md"),
    )
    .unwrap();
    let (front, body) = parse_frontmatter(&skill).unwrap();
    assert_eq!(front.name.as_deref(), Some("liquibase-migration-review"));
    assert!(body.contains("Procedure"));
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();

    // 7. Update the source library; refresh discovers the update without applying it.
    let lib_skill = remote.join("skills/liquibase-migration-review/SKILL.md");
    let mut text = std::fs::read_to_string(&lib_skill).unwrap();
    text.push_str("\n7. Run the changelog against an empty database in CI.\n");
    std::fs::write(&lib_skill, text).unwrap();
    git(&remote, &["commit", "-qam", "Add CI step"]);
    let before_refresh = tree_bytes(&project_dir);
    let outcome = habi.sources().refresh(&source.id, &cancel).unwrap();
    assert_eq!(
        outcome.updated,
        vec!["liquibase-migration-review".to_string()]
    );
    assert_eq!(tree_bytes(&project_dir), before_refresh);
    let overview = habi.overview(&project.id, true, &cancel).unwrap();
    let installed = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "liquibase-migration-review")
        .unwrap();
    assert_eq!(installed.install_state, InstallState::UpdateAvailable);
    let key = installed.installation.as_ref().unwrap().key.clone();

    // 8. Modify the installed file; the update shows the conflict and preserves the edit.
    let installed_path = project_dir.join(".agents/skills/liquibase-migration-review/SKILL.md");
    let mut local = std::fs::read_to_string(&installed_path).unwrap();
    local.push_str("\nTeam note: page the DBA for changes to the invoice table.\n");
    std::fs::write(&installed_path, &local).unwrap();
    let update = habi
        .plan_update(
            &project.id,
            std::slice::from_ref(&key),
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(update.conflicts.len(), 1);
    assert_eq!(update.conflicts[0].kind, ConflictKind::LocalEdits);
    let mut keep = Decisions::new();
    keep.insert(
        ".agents/skills/liquibase-migration-review/SKILL.md".into(),
        Resolution::Keep,
    );
    let update = habi.plan_update(&project.id, &[key], false, &keep).unwrap();
    if !update.changes.is_empty() {
        habi.apply(&update.id).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&installed_path).unwrap(), local);

    // 9. Prepare a contribution in isolation; produce branch and patch output.
    git(
        &habi.sources().cache_dir(&source.id),
        &["config", "user.name", "Developer"],
    );
    git(
        &habi.sources().cache_dir(&source.id),
        &["config", "user.email", "dev@example.invalid"],
    );
    let draft = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::ProjectSkill {
                project_id: project.id.clone(),
                path: ".agents/skills/liquibase-migration-review".into(),
            },
        )
        .unwrap();
    let committed = habi.commit_contribution(&draft.id, &cancel).unwrap();
    assert_eq!(committed.state, ContributionState::Committed);
    let patch = habi
        .contributions()
        .export_patch(&draft.id, patches.path(), &cancel)
        .unwrap();
    assert!(
        std::fs::read_to_string(patch)
            .unwrap()
            .contains("page the DBA")
    );
    let published = habi
        .publish_contribution(&draft.id, false, &cancel)
        .unwrap();
    assert_eq!(
        git(&remote, &["rev-parse", &published.branch]),
        committed.commit_id.unwrap()
    );
    assert_eq!(
        git(&remote, &["log", "-1", "--format=%s", "main"]),
        "Add CI step",
        "the tracked branch is untouched"
    );

    // 10. Disconnect from the network: cached browsing continues with honest freshness.
    let gone = remote_parent.path().join("unreachable");
    std::fs::rename(&remote, &gone).unwrap();
    assert!(habi.sources().refresh(&source.id, &cancel).is_err());
    let stale = habi.sources().get(&source.id).unwrap();
    assert_eq!(stale.freshness, Freshness::Stale);
    let overview = habi.overview(&project.id, true, &cancel).unwrap();
    assert!(
        overview.recommendations.len() >= 10,
        "recommendations come from the cached library"
    );
    assert_eq!(overview.sources[0].freshness, Freshness::Stale);
}

#[test]
fn damaged_exclusions_are_an_error_not_an_empty_list() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("repos/billing-service"), proj.path());
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let project = habi.open_project(proj.path()).unwrap();
    habi.set_exclusions(&project.id, vec!["secrets/**".into()])
        .unwrap();
    habi.store
        .conn()
        .unwrap()
        .execute("UPDATE projects SET exclusions_json = '[\"secrets/**'", [])
        .unwrap();
    let err = habi
        .inspect(&project.id, true, &CancelToken::new())
        .unwrap_err();
    assert_eq!(err.code(), "conflict", "{err}");
    // Setting them again repairs it.
    habi.set_exclusions(&project.id, vec!["secrets/**".into()])
        .unwrap();
    habi.inspect(&project.id, true, &CancelToken::new())
        .unwrap();
}
