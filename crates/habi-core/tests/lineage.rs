//! Where a skill came from, what it changed since, where it is installed,
//! and the validation and starters the Skill Studio builds on.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::contribute::{MatchMode, ShareForm, ToolEntry};
use habi_core::install::plan::Decisions;
use habi_core::library::model::DiagnosticCode;
use habi_core::recommend::PrerequisiteStatus;
use habi_core::service::{Habi, ImportFrom, ItemRef, PreviewRequest};
use habi_core::skills::intake::ImportSelection;
use habi_core::skills::upstream::{SideChange, UpstreamState};
use habi_core::skills::{LOCAL_SOURCE_ID, NewSkill, SkillDocument, SkillTemplate};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;
use std::time::{Duration, SystemTime};

fn open(home: &Path) -> Habi {
    Habi::open(AppPaths::at(home.to_path_buf())).unwrap()
}

fn put(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Makes every stored object look older than maintenance's grace period.
fn age_objects(dir: &Path) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            age_objects(&path);
        } else {
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(SystemTime::now() - Duration::from_secs(3 * 60 * 60))
                .unwrap();
        }
    }
}

const REVIEW_SKILL: &str = "---\nname: review\ndescription: Review changes before merge.\n---\n\nRead [the guide](references/a.md).\n";

/// A folder library with one skill, connected and fetched; returns the
/// library's id and the id of a copy in My skills.
fn copy_from_library(habi: &Habi, lib: &Path) -> (String, String) {
    put(lib, "skills/review/SKILL.md", REVIEW_SKILL);
    put(lib, "skills/review/references/a.md", "A1\n");
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let copied = habi
        .import_skills(
            &ImportFrom::Library {
                source_id: source.id.clone(),
            },
            &[ImportSelection {
                path: "review".into(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    (source.id, copied.imported[0].id.clone())
}

fn edit(habi: &Habi, id: &str, rel: &str, text: &str) {
    let current = habi.skills().read_file(id, rel).unwrap();
    habi.skills()
        .write_file(id, rel, text, Some(&current.digest))
        .unwrap();
}

#[test]
fn a_copy_knows_what_it_changed_even_after_its_library_is_gone() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let (source_id, id) = copy_from_library(&habi, lib.path());

    let fresh = habi.skills().get(&id).unwrap();
    assert_eq!(fresh.summary.modified_locally, Some(false));
    let changes = habi.skill_local_changes(&id).unwrap();
    assert!(changes.known && changes.files.is_empty());
    assert_eq!(changes.unchanged, 2);

    edit(
        &habi,
        &id,
        "references/a.md",
        "A1\nAlso check the rollback.\n",
    );
    assert_eq!(
        habi.skills().get(&id).unwrap().summary.modified_locally,
        Some(true)
    );
    let changes = habi.skill_local_changes(&id).unwrap();
    assert_eq!(changes.files.len(), 1);
    assert_eq!(changes.files[0].path, "references/a.md");
    assert_eq!(changes.files[0].change, SideChange::Modified);
    assert_eq!(changes.files[0].diff.added, 1);

    // Undoing the edit is no change at all.
    edit(&habi, &id, "references/a.md", "A1\n");
    assert_eq!(
        habi.skills().get(&id).unwrap().summary.modified_locally,
        Some(false)
    );

    // The original outlives the library and maintenance.
    edit(&habi, &id, "references/a.md", "A2\n");
    habi.sources().remove(&source_id).unwrap();
    age_objects(&habi.paths.blobs());
    habi.prune().unwrap();
    let changes = habi.skill_local_changes(&id).unwrap();
    assert!(changes.known, "{:?}", changes.detail);
    assert_eq!(changes.files.len(), 1);
    assert_eq!(changes.files[0].diff.removed, 1);
}

#[test]
fn drafts_have_no_original_and_say_so() {
    let home = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let draft = habi
        .create_skill(
            &NewSkill {
                title: "Money".into(),
                description: String::new(),
                template: SkillTemplate::Blank,
            },
            None,
        )
        .unwrap();
    assert_eq!(draft.summary.modified_locally, None);
    let changes = habi.skill_local_changes(&draft.summary.id).unwrap();
    assert!(!changes.known);
    assert!(changes.detail.unwrap().contains("written here"));
}

#[test]
fn a_one_off_copy_tracks_its_library_once_it_is_connected() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let (source_id, id) = copy_from_library(&habi, lib.path());
    // The library goes away (as a one-off copy's preview does), its cached
    // versions with it, and the library moves on meanwhile.
    habi.sources().remove(&source_id).unwrap();
    put(
        lib.path(),
        "skills/review/references/a.md",
        "A1\nA newer line.\n",
    );
    let again = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&again.id, &CancelToken::new())
        .unwrap();
    // Connected again: the copy's own record of its original stands in for
    // the version that is no longer cached.
    let status = habi.skill_upstream(&id).unwrap().unwrap();
    assert_eq!(status.state, UpstreamState::Changed, "{:?}", status.detail);
    let plan = habi.plan_upstream_sync(&id).unwrap();
    assert_eq!(plan.take, 1);
    assert_eq!(plan.conflicts, 0);
}

#[test]
fn overview_says_where_a_skill_is_installed_and_whether_it_is_current() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    copy_tree(&fixture("repos/agent-ready-service"), proj.path());
    let project_id = habi.open_project(proj.path()).unwrap().id;
    let created = habi
        .create_skill(
            &NewSkill {
                title: "Money amounts".into(),
                description: "How money is represented. Use when touching amounts.".into(),
                template: SkillTemplate::Blank,
            },
            None,
        )
        .unwrap();
    let id = created.summary.id.clone();
    let saved = habi
        .skills()
        .save_document(
            &id,
            "Money amounts",
            &SkillDocument {
                body: "Use BigDecimal with scale 2.\n".into(),
                ..created.document.clone()
            },
            created.document_digest.as_deref(),
        )
        .unwrap();
    assert!(
        habi.skills_overview()
            .unwrap()
            .iter()
            .all(|s| s.installed_in.is_empty())
    );
    let plan = habi
        .plan_install(
            &project_id,
            &[ItemRef {
                source_id: LOCAL_SOURCE_ID.into(),
                item_id: saved.document.name.clone(),
            }],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    habi.apply(&plan.id).unwrap();

    let standing = habi.skills_overview().unwrap();
    let mine = standing.iter().find(|s| s.skill_id == id).unwrap();
    assert_eq!(mine.installed_in.len(), 1);
    assert_eq!(mine.installed_in[0].project_id, project_id);
    assert!(mine.installed_in[0].current);
    assert_eq!(mine.installed_in[0].clients, vec![ClientId::ClaudeCode]);

    // Editing the skill makes the installed copy an older version.
    let latest = habi.skills().get(&id).unwrap();
    habi.skills()
        .save_document(
            &id,
            "Money amounts",
            &SkillDocument {
                body: "Use BigDecimal with scale 2. Never use double.\n".into(),
                ..latest.document.clone()
            },
            latest.document_digest.as_deref(),
        )
        .unwrap();
    let standing = habi.skills_overview().unwrap();
    let mine = standing.iter().find(|s| s.skill_id == id).unwrap();
    assert!(!mine.installed_in[0].current);
}

#[test]
fn diagnostics_name_the_kind_of_problem_and_its_line() {
    let home = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let created = habi
        .create_skill(
            &NewSkill {
                title: "Review".into(),
                description: String::new(),
                template: SkillTemplate::Blank,
            },
            None,
        )
        .unwrap();
    let saved = habi
        .skills()
        .save_document(
            &created.summary.id,
            "Review",
            &SkillDocument {
                body: "# Review\n\nFirst read\n[the checklist](references/missing.md).\n".into(),
                ..created.document.clone()
            },
            created.document_digest.as_deref(),
        )
        .unwrap();
    let code = |c: DiagnosticCode| saved.diagnostics.iter().find(|d| d.code == Some(c));
    assert!(code(DiagnosticCode::MissingDescription).is_some());
    let missing = code(DiagnosticCode::MissingReferencedFile).unwrap();
    assert_eq!(missing.path.as_deref(), Some("SKILL.md"));
    // Lines count in the instructions, as the editor shows them.
    assert_eq!(missing.line, Some(4));

    // Rule problems all send the author to the rules.
    let broken = habi
        .skills()
        .save_metadata_text(
            &created.summary.id,
            "habi: 1\napplies_when:\n  colour: blue\n",
            None,
        )
        .unwrap();
    assert!(
        broken
            .diagnostics
            .iter()
            .any(|d| d.code == Some(DiagnosticCode::InvalidMetadata)),
        "{:?}",
        broken.diagnostics
    );
}

#[test]
fn every_starter_makes_a_skill_that_only_lacks_a_description() {
    let home = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let offered = habi.skill_templates();
    assert_eq!(
        offered.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(),
        [
            "Blank",
            "Workflow",
            "Troubleshooting",
            "Code review",
            "Tool-assisted"
        ]
    );
    for starter in offered {
        let skill = habi
            .create_skill(
                &NewSkill {
                    title: format!("From {}", starter.label),
                    description: String::new(),
                    template: starter.template,
                },
                None,
            )
            .unwrap();
        assert_eq!(skill.document.body, starter.body);
        let errors: Vec<_> = skill
            .diagnostics
            .iter()
            .filter(|d| d.level == habi_core::library::model::DiagnosticLevel::Error)
            .map(|d| d.code)
            .collect();
        assert_eq!(
            errors,
            [Some(DiagnosticCode::MissingDescription)],
            "{}",
            starter.label
        );
    }
}

#[test]
fn one_project_can_be_evaluated_with_the_tools_it_needs() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    copy_tree(&fixture("repos/billing-service"), proj.path());
    put(proj.path(), "mvnw", "#!/bin/sh\n");
    copy_tree(&fixture("repos/storefront-web"), other.path());
    let project_id = habi.open_project(proj.path()).unwrap().id;
    habi.open_project(other.path()).unwrap();
    let draft = habi
        .create_skill(
            &NewSkill {
                title: "Build".into(),
                description: String::new(),
                template: SkillTemplate::Blank,
            },
            None,
        )
        .unwrap();
    let form = ShareForm {
        title: "Build".into(),
        conditions_editable: true,
        match_mode: MatchMode::Any,
        applies_tags: vec!["lang:java".into()],
        tools: vec![
            ToolEntry {
                name: "Maven".into(),
                commands: vec!["habi-test-no-such-mvn".into(), "./mvnw".into()],
            },
            ToolEntry {
                name: "Nothing".into(),
                commands: vec!["habi-test-no-such-command".into()],
            },
        ],
        ..Default::default()
    };
    let preview = habi
        .preview_skill(
            &PreviewRequest {
                skill_id: Some(draft.summary.id.clone()),
                form: Some(form),
                metadata_text: None,
                project_id: Some(project_id.clone()),
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert_eq!(preview.projects.len(), 1, "only the chosen project");
    let p = &preview.projects[0];
    assert_eq!(p.project.id, project_id);
    let status = |name: &str| {
        p.prerequisites
            .iter()
            .find(|x| x.name == name)
            .map(|x| x.status)
    };
    assert_eq!(status("Maven"), Some(PrerequisiteStatus::Present));
    assert_eq!(status("Nothing"), Some(PrerequisiteStatus::Missing));
}

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(ok.success());
}

#[test]
fn a_one_off_copy_from_git_connects_nothing_and_remembers_where_it_came_from() {
    let home = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    put(repo.path(), "skills/review/SKILL.md", REVIEW_SKILL);
    put(repo.path(), "skills/review/references/a.md", "A1\n");
    git(repo.path(), &["init", "-q"]);
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-qm", "skills"]);

    let copy = habi
        .open_git_copy(&repo.path().to_string_lossy(), &CancelToken::new())
        .unwrap();
    assert!(copy.snapshot.is_some());
    // Fetched, but not a library: nothing appears among connected sources.
    assert!(habi.sources().list().unwrap().is_empty());
    let from = ImportFrom::GitCopy {
        source_id: copy.source_id.clone(),
    };
    let found = habi.inspect_import(&from, &CancelToken::new()).unwrap();
    assert_eq!(found.candidates.len(), 1);
    // Copying from it the way a connected library is copied is refused.
    assert!(
        habi.inspect_import(
            &ImportFrom::Library {
                source_id: copy.source_id.clone()
            },
            &CancelToken::new()
        )
        .is_err()
    );
    let imported = habi
        .import_skills(
            &from,
            &[ImportSelection {
                path: found.candidates[0].path.clone(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    let id = imported.imported[0].id.clone();
    habi.forget_git_copy(&copy.source_id).unwrap();
    assert!(habi.sources().get(&copy.source_id).is_err());

    let skill = habi.skills().get(&id).unwrap();
    match &skill.summary.origin {
        habi_core::skills::SkillOrigin::Library {
            source_name,
            snapshot,
            ..
        } => {
            assert_eq!(source_name, &copy.label);
            assert_eq!(Some(snapshot), copy.snapshot.as_ref());
        }
        other => panic!("unexpected origin {other:?}"),
    }
    assert_eq!(skill.summary.modified_locally, Some(false));
    // Its original is kept even though the repository was discarded.
    let changes = habi.skill_local_changes(&id).unwrap();
    assert!(changes.known, "{:?}", changes.detail);
    // A source that is not a copy is never discarded by forget_git_copy.
    let lib = tempfile::tempdir().unwrap();
    put(
        lib.path(),
        "skills/other/SKILL.md",
        "---\nname: other\ndescription: x\n---\n",
    );
    let connected = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.forget_git_copy(&connected.id).unwrap();
    assert!(habi.sources().get(&connected.id).is_ok());
}
