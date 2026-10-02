//! Local skills end to end: discovery, drafts, import, applicability
//! preview, installation, sharing — with real fixtures and persisted state.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::contribute::{
    ContributionOrigin, ContributionState, DraftFileStatus, MatchMode, ShareForm,
};
use habi_core::error::HabiError;
use habi_core::install::plan::{ConflictKind, Decisions};
use habi_core::install::status::InstallState;
use habi_core::library::model::{DiagnosticLevel, MetadataStatus};
use habi_core::matching::Applicability;
use habi_core::service::{Habi, ImportFrom, ItemRef, PreviewRequest, SuggestionKind};
use habi_core::skills::intake::{DuplicateKind, ImportSelection};
use habi_core::skills::{
    LOCAL_SOURCE_ID, LocalSkill, NewSkill, SkillDocument, SkillOrigin, SkillTemplate,
};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn open(home: &Path) -> Habi {
    Habi::open(AppPaths::at(home.to_path_buf())).unwrap()
}

fn project(habi: &Habi, fixture_name: &str, dir: &Path) -> String {
    copy_tree(&fixture(&format!("repos/{fixture_name}")), dir);
    habi.open_project(dir).unwrap().id
}

fn draft(habi: &Habi, title: &str, description: &str, body: &str) -> LocalSkill {
    let created = habi
        .create_skill(
            &NewSkill {
                title: title.into(),
                description: description.into(),
                template: SkillTemplate::Blank,
            },
            None,
        )
        .unwrap();
    habi.skills()
        .save_document(
            &created.summary.id,
            title,
            &SkillDocument {
                name: created.document.name.clone(),
                description: description.into(),
                body: body.into(),
            },
            created.document_digest.as_deref(),
        )
        .unwrap()
}

fn liquibase_form(title: &str) -> ShareForm {
    ShareForm {
        title: title.into(),
        conditions_editable: true,
        match_mode: MatchMode::All,
        applies_tags: vec!["framework:spring-boot".into()],
        applies_dependencies: vec!["org.liquibase:liquibase-core".into()],
        ..Default::default()
    }
}

/// Scenario 1: fresh installation, no team library — open a project, see
/// what is already there, and turn part of it into a local draft.
#[test]
fn a_project_alone_is_enough_to_discover_knowledge_and_start_a_draft() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let id = project(&habi, "agent-ready-service", proj.path());
    assert!(habi.sources().list().unwrap().is_empty());

    let found = habi.discover(&id, &CancelToken::new()).unwrap();
    let skill = &found.skills[0];
    assert_eq!(skill.path, ".claude/skills/jpa-entity-review");
    assert_eq!(skill.name, "jpa-entity-review");
    assert_eq!(skill.readers, vec![ClientId::ClaudeCode, ClientId::Cursor]);
    assert_eq!(skill.managed_by, None);
    assert_eq!(skill.imported_as, None);
    let paths: Vec<&str> = found.instructions.iter().map(|i| i.path.as_str()).collect();
    assert!(paths.contains(&"AGENTS.md") && paths.contains(&"CLAUDE.md"));
    assert!(paths.contains(&".cursor/rules/style.mdc"));

    // The project overview works without any library and invents nothing.
    let overview = habi.overview(&id, false, &CancelToken::new()).unwrap();
    assert!(overview.recommendations.is_empty());

    // Turn explicitly selected lines of AGENTS.md into a draft.
    let before = std::fs::read(proj.path().join("AGENTS.md")).unwrap();
    let document = habi.read_instructions(&id, "AGENTS.md").unwrap();
    assert_eq!(document.sections[0].title, "accounts-service");
    let created = habi
        .create_skill_from_instructions(&id, "AGENTS.md", 5, 5, "Money amounts")
        .unwrap();
    assert_eq!(created.document.name, "money-amounts");
    assert_eq!(
        created.document.body.trim(),
        "- Money amounts use BigDecimal with scale 2."
    );
    assert!(matches!(
        &created.summary.origin,
        SkillOrigin::Instructions { path, start_line: 5, end_line: 5, .. } if path == "AGENTS.md"
    ));
    // The standards file stays in place, byte for byte.
    assert_eq!(
        std::fs::read(proj.path().join("AGENTS.md")).unwrap(),
        before
    );
    // A draft is not installed anywhere.
    assert!(!proj.path().join(".claude/skills/money-amounts").exists());
    // Reading outside the recognized instruction files is refused.
    assert!(habi.read_instructions(&id, "pom.xml").is_err());
    assert!(habi.read_instructions(&id, "../outside.md").is_err());
}

/// Scenario 2: no project — create and save a draft, restart, resume intact.
#[test]
fn drafts_survive_a_restart_without_a_project_or_library() {
    let home = tempfile::tempdir().unwrap();
    let id = {
        let habi = open(home.path());
        let created = habi
            .create_skill(
                &NewSkill {
                    title: "Release notes: écrire & ship".into(),
                    description: String::new(),
                    template: SkillTemplate::ReviewProcedure,
                },
                None,
            )
            .unwrap();
        assert_eq!(created.document.name, "release-notes-crire-ship");
        // Incomplete work is a valid draft, with problems reported, not hidden.
        assert!(created.summary.errors > 0);
        assert!(
            created
                .diagnostics
                .iter()
                .any(|d| d.message.contains("no `description`"))
        );
        let saved = habi
            .skills()
            .save_document(
                &created.summary.id,
                "Release notes",
                &SkillDocument {
                    name: "release-notes".into(),
                    description: "Draft release notes from merged changes. Use when preparing a release: \"notes\".".into(),
                    body: "## Steps\n\n1. List merged changes since the last tag.\n2. Group by audience.\n".into(),
                },
                created.document_digest.as_deref(),
            )
            .unwrap();
        assert_eq!(saved.summary.errors, 0, "{:?}", saved.diagnostics);
        saved.summary.id
    };

    let habi = open(home.path());
    let resumed = habi.skills().get(&id).unwrap();
    assert_eq!(resumed.summary.title, "Release notes");
    assert_eq!(resumed.document.name, "release-notes");
    assert!(resumed.document.description.contains("\"notes\""));
    assert!(resumed.document.body.starts_with("## Steps"));
    assert_eq!(resumed.summary.origin, SkillOrigin::Created);
    assert_eq!(habi.skills().list().unwrap().len(), 1);

    // The package on disk is a plain Agent Skills folder.
    let text =
        std::fs::read_to_string(home.path().join(format!("skills/{id}/package/SKILL.md"))).unwrap();
    assert!(text.starts_with("---\nname: release-notes\n"), "{text}");
    // No Habi metadata was invented for a skill without applicability rules.
    assert!(
        !home
            .path()
            .join(format!("skills/{id}/package/habi.yaml"))
            .exists()
    );
    assert_eq!(resumed.metadata_status, MetadataStatus::Undeclared);

    // Trash is reversible; purge needs the trash first.
    assert!(habi.skills().purge(&id).is_err());
    habi.skills().trash(&id).unwrap();
    assert!(habi.skills().get(&id).unwrap().summary.deleted_at.is_some());
    assert!(
        habi.skills()
            .save_document(
                &id,
                "x",
                &resumed.document,
                resumed.document_digest.as_deref()
            )
            .is_err()
    );
    let back = habi.skills().restore(&id).unwrap();
    assert_eq!(back.document, resumed.document);
}

/// Scenario 3: applicability rules preview with distinct results across
/// projects, including an unknown one.
#[test]
fn applicability_preview_distinguishes_applies_absent_and_unknown() {
    let home = tempfile::tempdir().unwrap();
    let (billing, storefront, unknown) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let habi = open(home.path());
    let billing_id = project(&habi, "billing-service", billing.path());
    let storefront_id = project(&habi, "storefront-web", storefront.path());
    // A module whose parent POM is outside the repository: dependencies it
    // may inherit cannot be established.
    std::fs::write(
        unknown.path().join("pom.xml"),
        r#"<project><parent><groupId>com.example</groupId><artifactId>corp-parent</artifactId><version>7</version></parent>
           <artifactId>reporting-service</artifactId>
           <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
           </project>"#,
    )
    .unwrap();
    let unknown_id = habi.open_project(unknown.path()).unwrap().id;

    let skill = draft(
        &habi,
        "Migration review",
        "Review Liquibase changesets. Use when a change adds or edits a changelog.",
        "1. Find the master changelog.\n",
    );
    let id = skill.summary.id.clone();

    // Unsaved rules are previewed exactly as the editor holds them.
    let preview = habi
        .preview_skill(
            &PreviewRequest {
                skill_id: Some(id.clone()),
                form: Some(liquibase_form("Migration review")),
                metadata_text: None,
                project_id: None,
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert_eq!(preview.problem, None);
    let result = |project: &str| {
        preview
            .projects
            .iter()
            .find(|p| p.project.id == project)
            .and_then(|p| p.result.clone())
            .unwrap()
    };
    let applies = result(&billing_id);
    assert_eq!(applies.applicability, Applicability::Applies);
    assert!(applies.reason.contains("pom.xml"), "{}", applies.reason);
    let absent = result(&storefront_id);
    assert_eq!(absent.applicability, Applicability::DoesNotApply);
    let open_question = result(&unknown_id);
    assert_eq!(
        open_question.applicability,
        Applicability::NeedsInformation,
        "{}",
        open_question.reason
    );
    assert!(open_question.reason.contains("corp-parent"));
    // Nothing was written by previewing.
    assert_eq!(habi.skills().get(&id).unwrap().metadata_text, None);

    // An invalid rule is explained instead of evaluated.
    let mut bad = liquibase_form("Migration review");
    bad.applies_files = vec!["../outside/**".into()];
    let rejected = habi
        .preview_skill(
            &PreviewRequest {
                skill_id: Some(id.clone()),
                form: Some(bad.clone()),
                metadata_text: None,
                project_id: None,
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert!(rejected.problem.is_some() && rejected.projects.is_empty());
    assert!(habi.skills().save_applicability(&id, &bad, None).is_err());

    // Saving writes standard sidecar metadata; the stored rules preview the same.
    let saved = habi
        .skills()
        .save_applicability(&id, &liquibase_form("Migration review"), None)
        .unwrap();
    assert_eq!(saved.metadata_status, MetadataStatus::Declared);
    assert!(saved.summary.has_applicability);
    let stored = habi
        .preview_skill(
            &PreviewRequest {
                skill_id: Some(id.clone()),
                ..Default::default()
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert_eq!(stored.applies_when, preview.applies_when);

    // The raw view round-trips: unknown keys and complex rules are kept.
    let raw = "habi: 1\nx-team: keep me\napplies_when:\n  all:\n    - tag: framework:spring-boot\n    - not:\n        tag: db:jooq\n";
    let advanced = habi
        .skills()
        .save_metadata_text(&id, raw, saved.metadata_digest.as_deref())
        .unwrap();
    assert_eq!(advanced.metadata_text.as_deref(), Some(raw));
    assert!(!advanced.form.conditions_editable);
    let kept = habi
        .skills()
        .save_applicability(&id, &advanced.form, advanced.metadata_digest.as_deref())
        .unwrap();
    let text = kept.metadata_text.unwrap();
    assert!(
        text.contains("x-team: keep me") && text.contains("not:"),
        "{text}"
    );

    // The valid local skill now takes part in the project's recommendations.
    let overview = habi
        .overview(&billing_id, false, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "migration-review")
        .unwrap();
    assert_eq!(rec.item.source_id, LOCAL_SOURCE_ID);
    assert_eq!(rec.applicability.applicability, Applicability::Applies);

    // Suggestions come from observed facts and are offered, not applied.
    let suggestions = habi.suggest_conditions(&billing_id).unwrap();
    assert!(
        suggestions
            .iter()
            .any(|s| s.kind == SuggestionKind::Tag && s.value == "framework:spring-boot")
    );
    assert!(suggestions.iter().any(|s| {
        s.kind == SuggestionKind::Dependency
            && s.value == "org.liquibase:liquibase-core"
            && s.evidence
                .as_deref()
                .is_some_and(|e| e.starts_with("pom.xml:"))
    }));

    // A cancelled preview stops instead of returning partial results.
    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(matches!(
        habi.preview_skill(&PreviewRequest::default(), &cancelled),
        Err(HabiError::Cancelled)
    ));
}

/// Scenarios 4, 5 and 6: import standard packages, keep structure and
/// attribution, and resolve duplicates and name collisions without loss.
#[test]
fn importing_keeps_packages_whole_and_never_loses_an_original() {
    let home = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    copy_tree(
        &fixture("libraries/example-team-library/skills"),
        &folder.path().join("skills"),
    );
    // A package with a script, an asset and an unknown frontmatter field.
    let rich = folder.path().join("skills/incident-notes");
    std::fs::create_dir_all(rich.join("scripts")).unwrap();
    std::fs::create_dir_all(rich.join("assets")).unwrap();
    std::fs::write(
        rich.join("scripts/collect.sh"),
        "#!/bin/sh\necho collecting\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            rich.join("scripts/collect.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    std::fs::write(rich.join("assets/template.bin"), [0u8, 159, 146, 150]).unwrap();
    std::fs::write(
        rich.join("SKILL.md"),
        "---\nname: incident-notes\ndescription: Turn an incident chat log into a blameless timeline. Use after an incident.\nlicense: Apache-2.0\nmetadata:\n  author: sre-guild\n---\n\n# Incident notes\n\nSee scripts/collect.sh.\n",
    )
    .unwrap();
    let source_before = std::fs::read(rich.join("SKILL.md")).unwrap();

    let from = ImportFrom::Folder {
        path: folder.path().to_string_lossy().into(),
    };
    let inspection = habi.inspect_import(&from, &CancelToken::new()).unwrap();
    assert_eq!(inspection.candidates.len(), 9);
    // Inspecting writes nothing.
    assert!(habi.skills().list().unwrap().is_empty());
    let incident = inspection
        .candidates
        .iter()
        .find(|c| c.name == "incident-notes")
        .unwrap();
    assert_eq!(incident.path, "skills/incident-notes");
    assert_eq!(incident.license.as_deref(), Some("Apache-2.0"));
    assert!(!incident.has_metadata && incident.complete && incident.duplicate.is_none());
    assert_eq!(
        incident.files,
        ["SKILL.md", "assets/template.bin", "scripts/collect.sh"]
    );

    let outcome = habi
        .import_skills(
            &from,
            &[
                ImportSelection {
                    path: "skills/incident-notes".into(),
                    rename: None,
                },
                ImportSelection {
                    path: "skills/liquibase-migration-review".into(),
                    rename: None,
                },
            ],
            &CancelToken::new(),
        )
        .unwrap();
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    let imported = &outcome.imported[0];
    assert!(matches!(
        &imported.origin,
        SkillOrigin::Folder { path } if path.ends_with("skills/incident-notes")
    ));
    // Byte-for-byte copy with structure, executable bit and unknown fields.
    let package = home.path().join(format!("skills/{}/package", imported.id));
    assert_eq!(
        std::fs::read(package.join("SKILL.md")).unwrap(),
        source_before
    );
    assert_eq!(
        std::fs::read(package.join("assets/template.bin")).unwrap(),
        [0u8, 159, 146, 150]
    );
    #[cfg(unix)]
    assert!(habi_core::fsutil::is_executable(
        &package.join("scripts/collect.sh")
    ));
    // The original is untouched.
    assert_eq!(std::fs::read(rich.join("SKILL.md")).unwrap(), source_before);

    // Scenario 4: no Habi metadata — usable manually, no match invented.
    let plain = habi.skills().get(&imported.id).unwrap();
    assert_eq!(plain.metadata_status, MetadataStatus::Undeclared);
    assert!(!plain.summary.has_applicability);
    assert_eq!(plain.summary.errors, 0, "{:?}", plain.diagnostics);
    let project_id = project(&habi, "billing-service", proj.path());
    let overview = habi
        .overview(&project_id, false, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "incident-notes")
        .unwrap();
    assert_eq!(rec.applicability.applicability, Applicability::Undeclared);
    assert_eq!(rec.group, habi_core::recommend::Group::Available);
    // Editing the body keeps frontmatter the editor does not know about.
    let edited = habi
        .skills()
        .save_document(
            &imported.id,
            &plain.summary.title,
            &SkillDocument {
                body: format!("{}\nAlways use UTC.\n", plain.document.body),
                ..plain.document.clone()
            },
            plain.document_digest.as_deref(),
        )
        .unwrap();
    let text = std::fs::read_to_string(package.join("SKILL.md")).unwrap();
    assert!(
        text.contains("license: Apache-2.0\nmetadata:\n  author: sre-guild\n"),
        "{text}"
    );
    assert!(edited.document.body.ends_with("Always use UTC.\n"));

    // The package with references and Habi metadata kept both.
    let workflow = habi.skills().get(&outcome.imported[1].id).unwrap();
    assert!(
        workflow
            .files
            .iter()
            .any(|f| f.path == "references/checklist.md")
    );
    assert_eq!(workflow.metadata_status, MetadataStatus::Declared);
    assert_eq!(workflow.summary.title, "Liquibase migration review");

    // Scenario 6: the same source again — one is identical, one diverged.
    let again = habi.inspect_import(&from, &CancelToken::new()).unwrap();
    let same = again
        .candidates
        .iter()
        .find(|c| c.name == "liquibase-migration-review")
        .unwrap();
    assert_eq!(
        same.duplicate.as_ref().unwrap().kind,
        DuplicateKind::SameContent
    );
    let diverged = again
        .candidates
        .iter()
        .find(|c| c.name == "incident-notes")
        .unwrap();
    // Recognized by the content it was imported from, although edited since.
    assert_eq!(
        diverged.duplicate.as_ref().unwrap().kind,
        DuplicateKind::SameContent
    );
    assert_eq!(diverged.suggested_name.as_deref(), Some("incident-notes-2"));

    // Importing under the taken identifier is refused, with both kept…
    let refused = habi
        .import_skills(
            &from,
            &[ImportSelection {
                path: "skills/incident-notes".into(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    assert!(refused.imported.is_empty());
    assert!(refused.skipped[0].reason.contains("already used"));
    // …and importing under a new identifier keeps both versions.
    let both = habi
        .import_skills(
            &from,
            &[ImportSelection {
                path: "skills/incident-notes".into(),
                rename: Some("incident-notes-2".into()),
            }],
            &CancelToken::new(),
        )
        .unwrap();
    let copy = habi.skills().get(&both.imported[0].id).unwrap();
    assert_eq!(copy.document.name, "incident-notes-2");
    assert!(!copy.document.body.contains("Always use UTC."));
    assert!(
        habi.skills()
            .get(&imported.id)
            .unwrap()
            .document
            .body
            .contains("Always use UTC.")
    );
    assert_eq!(std::fs::read(rich.join("SKILL.md")).unwrap(), source_before);

    // A different skill that reuses an identifier is a name collision.
    let other = tempfile::tempdir().unwrap();
    std::fs::write(
        other.path().join("SKILL.md"),
        "---\nname: incident-notes\ndescription: A different procedure. Use when paged.\n---\n\nPage the lead.\n",
    )
    .unwrap();
    let collision = habi
        .inspect_import(
            &ImportFrom::Folder {
                path: other.path().to_string_lossy().into(),
            },
            &CancelToken::new(),
        )
        .unwrap();
    assert_eq!(collision.candidates[0].path, "");
    assert_eq!(
        collision.candidates[0].duplicate.as_ref().unwrap().kind,
        DuplicateKind::SameName
    );

    // Links are never followed, and a package that would lose files is not imported.
    #[cfg(unix)]
    {
        let linked = tempfile::tempdir().unwrap();
        std::fs::write(
            linked.path().join("SKILL.md"),
            "---\nname: linked\ndescription: Has a link. Use never.\n---\n\nBody.\n",
        )
        .unwrap();
        std::os::unix::fs::symlink("/etc/hosts", linked.path().join("hosts")).unwrap();
        let from = ImportFrom::Folder {
            path: linked.path().to_string_lossy().into(),
        };
        let seen = habi.inspect_import(&from, &CancelToken::new()).unwrap();
        assert!(!seen.candidates[0].complete);
        let out = habi
            .import_skills(
                &from,
                &[ImportSelection {
                    path: String::new(),
                    rename: None,
                }],
                &CancelToken::new(),
            )
            .unwrap();
        assert!(out.imported.is_empty() && out.skipped[0].reason.contains("lose content"));
    }
}

/// Scenario 7 and 11: prepare a local skill for client targets through the
/// reviewed plan, keep unrelated configuration, and detect external edits.
#[test]
fn local_skills_install_through_reviewed_plans_and_edits_are_detected() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let project_id = project(&habi, "agent-ready-service", proj.path());
    let agents_before = std::fs::read(proj.path().join("AGENTS.md")).unwrap();
    let claude_before = std::fs::read(proj.path().join("CLAUDE.md")).unwrap();
    let mcp_before = std::fs::read(proj.path().join(".mcp.json")).unwrap();

    let skill = draft(&habi, "Money amounts", "", "Use BigDecimal with scale 2.\n");
    let id = skill.summary.id.clone();
    let item = ItemRef {
        source_id: LOCAL_SOURCE_ID.into(),
        item_id: "money-amounts".into(),
    };
    // An incomplete draft cannot be installed, and says why.
    assert!(skill.summary.errors > 0);
    assert!(
        habi.plan_install(
            &project_id,
            std::slice::from_ref(&item),
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new()
        )
        .is_err()
    );
    let ready = habi
        .skills()
        .save_document(
            &id,
            "Money amounts",
            &SkillDocument {
                description: "How money is represented. Use when touching amounts or prices."
                    .into(),
                ..skill.document.clone()
            },
            skill.document_digest.as_deref(),
        )
        .unwrap();
    assert_eq!(ready.summary.errors, 0, "{:?}", ready.diagnostics);

    let plan = habi
        .plan_install(
            &project_id,
            std::slice::from_ref(&item),
            &[ClientId::ClaudeCode, ClientId::Codex],
            false,
            &Decisions::new(),
        )
        .unwrap();
    let written: Vec<&str> = plan.changes.iter().map(|c| c.path.as_str()).collect();
    assert!(written.contains(&".claude/skills/money-amounts/SKILL.md"));
    assert!(written.contains(&".agents/skills/money-amounts/SKILL.md"));
    assert!(plan.conflicts.is_empty());
    // Previewing changed nothing; applying changes only what was previewed.
    assert!(!proj.path().join(".claude/skills/money-amounts").exists());
    habi.apply(&plan.id).unwrap();
    assert_eq!(
        std::fs::read(proj.path().join("AGENTS.md")).unwrap(),
        agents_before
    );
    assert_eq!(
        std::fs::read(proj.path().join("CLAUDE.md")).unwrap(),
        claude_before
    );
    assert_eq!(
        std::fs::read(proj.path().join(".mcp.json")).unwrap(),
        mcp_before
    );
    assert!(
        proj.path()
            .join(".claude/skills/jpa-entity-review/SKILL.md")
            .exists()
    );
    let installed =
        std::fs::read_to_string(proj.path().join(".claude/skills/money-amounts/SKILL.md")).unwrap();
    assert_eq!(
        installed,
        std::fs::read_to_string(home.path().join(format!("skills/{id}/package/SKILL.md"))).unwrap()
    );

    let state = |habi: &Habi| {
        habi.overview(&project_id, false, &CancelToken::new())
            .unwrap()
            .recommendations
            .into_iter()
            .find(|r| r.item.id == "money-amounts")
            .unwrap()
            .install_state
    };
    assert_eq!(state(&habi), InstallState::Current);

    // Editing the draft does not touch the installed copy; it becomes an update.
    let edited = habi
        .skills()
        .save_document(
            &id,
            "Money amounts",
            &SkillDocument {
                body: "Use BigDecimal with scale 2. Never use double.\n".into(),
                ..ready.document.clone()
            },
            ready.document_digest.as_deref(),
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(proj.path().join(".claude/skills/money-amounts/SKILL.md")).unwrap(),
        installed
    );
    assert_eq!(state(&habi), InstallState::UpdateAvailable);

    // Scenario 11: the installed (managed) file is edited outside Habi.
    std::fs::write(
        proj.path().join(".claude/skills/money-amounts/SKILL.md"),
        format!("{installed}\nLocal note.\n"),
    )
    .unwrap();
    assert_eq!(state(&habi), InstallState::Conflict);
    let key = habi
        .overview(&project_id, false, &CancelToken::new())
        .unwrap()
        .recommendations
        .into_iter()
        .find(|r| r.item.id == "money-amounts")
        .unwrap()
        .installation
        .unwrap()
        .key;
    let update = habi
        .plan_update(&project_id, &[key], &Decisions::new())
        .unwrap();
    assert!(update.is_blocked());
    assert_eq!(update.conflicts[0].kind, ConflictKind::LocalEdits);
    assert!(
        std::fs::read_to_string(proj.path().join(".claude/skills/money-amounts/SKILL.md"))
            .unwrap()
            .contains("Local note.")
    );

    // …and the draft itself is edited outside Habi while the editor is open.
    let package = home.path().join(format!("skills/{id}/package/SKILL.md"));
    let outside = std::fs::read_to_string(&package)
        .unwrap()
        .replace("Never use double.", "Never use float.");
    std::fs::write(&package, &outside).unwrap();
    let stale = habi.skills().save_document(
        &id,
        "Money amounts",
        &SkillDocument {
            body: "My unsaved edit.\n".into(),
            ..edited.document.clone()
        },
        edited.document_digest.as_deref(),
    );
    assert!(matches!(stale, Err(HabiError::Conflict(_))));
    // Nothing was overwritten.
    assert_eq!(std::fs::read_to_string(&package).unwrap(), outside);
    // Reloading shows the other version; keeping mine names the new base.
    let reloaded = habi.skills().get(&id).unwrap();
    assert!(reloaded.document.body.contains("Never use float."));
    let kept = habi
        .skills()
        .save_document(
            &id,
            "Money amounts",
            &SkillDocument {
                body: "My unsaved edit.\n".into(),
                ..reloaded.document.clone()
            },
            reloaded.document_digest.as_deref(),
        )
        .unwrap();
    assert_eq!(kept.document.body, "My unsaved edit.\n");

    // Supporting files: created, guarded against clobbering, escaping and links.
    let with_ref = habi
        .skills()
        .write_file(&id, "references/rounding.md", "# Rounding\n", None)
        .unwrap();
    assert!(
        with_ref
            .files
            .iter()
            .any(|f| f.path == "references/rounding.md")
    );
    assert!(
        habi.skills()
            .write_file(&id, "references/rounding.md", "x", None)
            .is_err()
    );
    assert!(
        habi.skills()
            .write_file(&id, "../escape.md", "x", None)
            .is_err()
    );
    assert!(
        habi.skills()
            .write_file(&id, ".git/config", "x", None)
            .is_err()
    );
    assert!(habi.skills().remove_path(&id, "SKILL.md").is_err());
    #[cfg(unix)]
    {
        let dir = home.path().join(format!("skills/{id}/package"));
        std::os::unix::fs::symlink(proj.path(), dir.join("link")).unwrap();
        assert!(matches!(
            habi.skills().write_file(&id, "link/planted.md", "x", None),
            Err(HabiError::PathEscape(_))
        ));
        assert!(!proj.path().join("planted.md").exists());
        std::fs::remove_file(dir.join("link")).unwrap();
    }

    // A portable export works without Habi and refuses to replace a folder.
    let out = tempfile::tempdir().unwrap();
    let exported = habi.skills().export(&id, out.path()).unwrap();
    assert!(exported.join("SKILL.md").is_file());
    assert!(exported.join("references/rounding.md").is_file());
    assert!(exported.ends_with("money-amounts"));
    assert!(matches!(
        habi.skills().export(&id, out.path()),
        Err(HabiError::Conflict(_))
    ));
}

/// Scenarios 8, 9 and 10: share a local skill with a library connected
/// later, keep "prepared" apart from "submitted", and adopt upstream changes
/// only on request.
#[test]
fn sharing_continues_from_a_draft_and_never_overstates_what_happened() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let habi = open(home.path());

    let skill = draft(
        &habi,
        "Migration review",
        "Review Liquibase changesets. Use when a change adds or edits a changelog.",
        "1. Find the master changelog.\n",
    );
    let id = skill.summary.id.clone();
    habi.skills()
        .save_applicability(&id, &liquibase_form("Migration review"), None)
        .unwrap();

    // Scenario 8: no library connected — sharing cannot start, the draft is
    // intact, and a portable export is available instead.
    assert!(
        habi.start_contribution(
            "missing",
            ContributionOrigin::LocalSkill {
                skill_id: id.clone()
            }
        )
        .is_err()
    );
    let out = tempfile::tempdir().unwrap();
    assert!(
        habi.skills()
            .export(&id, out.path())
            .unwrap()
            .join("habi.yaml")
            .is_file()
    );
    let before = habi.skills().get(&id).unwrap();

    // Connect a library afterwards (a temporary Git remote).
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    let main_before = git(lib.path(), &["rev-parse", "main"]);
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let cache = habi.sources().cache_dir(&source.id);
    git(&cache, &["config", "user.name", "Dev Example"]);
    git(&cache, &["config", "user.email", "dev@example.invalid"]);
    let after_connect = habi.skills().get(&id).unwrap();
    assert_eq!(after_connect.document, before.document);
    assert_eq!(after_connect.metadata_text, before.metadata_text);

    // Scenario 9: prepare a contribution; a prepared branch is not a submission.
    let contribution = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LocalSkill {
                skill_id: id.clone(),
            },
        )
        .unwrap();
    assert_eq!(contribution.item_path, "skills/migration-review");
    assert_eq!(contribution.state, ContributionState::Draft);
    assert!(
        contribution
            .form
            .applies_tags
            .contains(&"framework:spring-boot".to_string())
    );
    let leaving: Vec<(&str, DraftFileStatus)> = contribution
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status))
        .collect();
    assert_eq!(
        leaving,
        [
            ("skills/migration-review/SKILL.md", DraftFileStatus::Added),
            ("skills/migration-review/habi.yaml", DraftFileStatus::Added),
        ]
    );
    assert!(
        !contribution
            .validation
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error),
        "{:?}",
        contribution.validation
    );
    let committed = habi
        .commit_contribution(&contribution.id, &CancelToken::new())
        .unwrap();
    assert_eq!(committed.state, ContributionState::Committed);
    assert_eq!(committed.published_url, None);
    assert!(!committed.in_library);
    // Nothing reached the remote yet.
    assert!(git(lib.path(), &["branch", "--list", &committed.branch]).is_empty());

    // The patch fallback is a real file.
    let patch = habi
        .contributions()
        .export_patch(&contribution.id, out.path(), &CancelToken::new())
        .unwrap();
    assert!(
        std::fs::read_to_string(&patch)
            .unwrap()
            .contains("skills/migration-review/SKILL.md")
    );

    // Publishing pushes the branch; without a host integration no request is claimed.
    let outcome = habi
        .publish_contribution(&contribution.id, true, &CancelToken::new())
        .unwrap();
    assert_eq!(outcome.pull_request_url, None);
    assert!(outcome.pull_request_note.is_some());
    assert!(!git(lib.path(), &["branch", "--list", &committed.branch]).is_empty());
    assert_eq!(git(lib.path(), &["rev-parse", "main"]), main_before);
    let listed = habi.contributions().list().unwrap();
    assert_eq!(listed[0].state, ContributionState::Published);
    assert_eq!(listed[0].published_url, None);
    assert!(listed[0].published_note.is_some());
    assert!(!listed[0].in_library);
    // The local draft is still there and still editable.
    assert_eq!(habi.skills().get(&id).unwrap().document, before.document);

    // Scenario 10: a maintainer merges; refreshing updates the catalog only.
    let project_id = project(&habi, "billing-service", proj.path());
    let plan = habi
        .plan_install(
            &project_id,
            &[ItemRef {
                source_id: source.id.clone(),
                item_id: "liquibase-migration-review".into(),
            }],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    habi.apply(&plan.id).unwrap();
    let installed_path = proj
        .path()
        .join(".claude/skills/liquibase-migration-review/SKILL.md");
    let installed = std::fs::read(&installed_path).unwrap();

    git(
        lib.path(),
        &["merge", "-q", "--no-ff", "-m", "merge", &committed.branch],
    );
    let upstream = lib
        .path()
        .join("skills/liquibase-migration-review/SKILL.md");
    let mut text = std::fs::read_to_string(&upstream).unwrap();
    text.push_str("\n8. Check lock timeouts.\n");
    std::fs::write(&upstream, text).unwrap();
    git(lib.path(), &["commit", "-qam", "upstream change"]);
    let refreshed = habi
        .sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    assert!(refreshed.changed);
    assert!(refreshed.added.contains(&"migration-review".to_string()));
    assert!(
        refreshed
            .updated
            .contains(&"liquibase-migration-review".to_string())
    );
    // Nothing installed changed.
    assert_eq!(std::fs::read(&installed_path).unwrap(), installed);
    let overview = habi
        .overview(&project_id, false, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.key == format!("{}/liquibase-migration-review", source.id))
        .unwrap();
    assert_eq!(rec.install_state, InstallState::UpdateAvailable);
    // The contribution is now observed in the library.
    assert!(habi.contributions().list().unwrap()[0].in_library);

    // Editing a shared skill starts from an attributed local copy, never the cache.
    let copied = habi
        .import_skills(
            &ImportFrom::Library {
                source_id: source.id.clone(),
            },
            &[ImportSelection {
                path: "jpa-entity-review".into(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    assert!(matches!(
        &copied.imported[0].origin,
        SkillOrigin::Library { source_name, item_id, .. }
            if source_name == "Team" && item_id == "jpa-entity-review"
    ));
    let copy = habi.skills().get(&copied.imported[0].id).unwrap();
    habi.skills()
        .save_document(
            &copy.summary.id,
            &copy.summary.title,
            &SkillDocument {
                body: format!("{}\nCheck fetch types.\n", copy.document.body),
                ..copy.document.clone()
            },
            copy.document_digest.as_deref(),
        )
        .unwrap();
    assert!(
        !String::from_utf8(
            habi.item_detail(&source.id, "jpa-entity-review")
                .unwrap()
                .body
                .into_bytes()
        )
        .unwrap()
        .contains("Check fetch types.")
    );
    let improvement = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LocalSkill {
                skill_id: copy.summary.id.clone(),
            },
        )
        .unwrap();
    assert_eq!(improvement.item_path, "skills/jpa-entity-review");
    assert!(improvement.files.iter().any(|f| {
        f.path == "skills/jpa-entity-review/SKILL.md" && f.status == DraftFileStatus::Modified
    }));
}

/// The database migration keeps existing local state.
#[test]
fn upgrading_the_database_keeps_existing_state() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path()).unwrap();
    {
        // A v1 database with a registered project, as written by 0.1.0.
        let conn = rusqlite::Connection::open(home.path().join("habi.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, location TEXT NOT NULL, subdir TEXT, ref_kind TEXT NOT NULL, ref_name TEXT, created_at TEXT NOT NULL, snapshot TEXT, snapshot_at TEXT, last_attempt_at TEXT, last_error_code TEXT, last_error TEXT, warning TEXT);
             CREATE TABLE snapshots (source_id TEXT NOT NULL, snapshot TEXT NOT NULL, resolved_ref TEXT, commit_summary TEXT, created_at TEXT NOT NULL, files_json TEXT NOT NULL, PRIMARY KEY (source_id, snapshot));
             CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_opened_at TEXT NOT NULL, exclusions_json TEXT NOT NULL DEFAULT '[]', clients_json TEXT);
             CREATE TABLE declarations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, module TEXT NOT NULL, subject_json TEXT NOT NULL, present INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL);
             CREATE TABLE check_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, item_key TEXT NOT NULL, item_digest TEXT NOT NULL, check_id TEXT NOT NULL, module TEXT NOT NULL, argv_json TEXT NOT NULL, cwd TEXT NOT NULL, project_fingerprint TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, status TEXT NOT NULL, output_tail TEXT);
             CREATE TABLE contributions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, item_path TEXT NOT NULL, title TEXT NOT NULL, base_commit TEXT NOT NULL, branch TEXT NOT NULL, commit_id TEXT, state TEXT NOT NULL, origin_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_url TEXT, patch_path TEXT);
             CREATE TABLE operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO projects (id, path, name, last_opened_at) VALUES ('p1', '/nowhere/billing', 'billing', '2026-09-01T00:00:00Z');
             INSERT INTO sources (id, name, kind, location, ref_kind, created_at) VALUES ('s1', 'Team', 'git', 'https://example.invalid/skills.git', 'default', '2026-09-01T00:00:00Z');
             INSERT INTO settings (key, value) VALUES ('desktop', '{}');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let habi = open(home.path());
    assert_eq!(habi.store.schema_version().unwrap(), 8);
    assert_eq!(habi.project("p1").unwrap().name, "billing");
    // Libraries connected before roles existed are the team's own.
    assert_eq!(
        habi.sources().get("s1").unwrap().role,
        habi_core::source::SourceRole::Team
    );
    // Nor is a library from then a sample one; never fetched, it has no items.
    assert!(!habi.sources().get("s1").unwrap().sample);
    assert_eq!(habi.sources().get("s1").unwrap().skill_count, 0);
    // Nor a catalog preview: it is listed, and reads the whole repository.
    let old = habi.sources().get("s1").unwrap();
    assert!(!old.preview && old.catalog_id.is_none() && old.include.is_empty());
    assert_eq!(habi.sources().list().unwrap().len(), 1);
    assert_eq!(
        habi.store.setting("desktop").unwrap().as_deref(),
        Some("{}")
    );
    assert!(habi.skills().list().unwrap().is_empty());
    // A copy of the pre-migration database is kept.
    assert!(home.path().join("habi.db.pre-v2.bak").exists());
}

/// A revision of a skill from My skills includes edits made in My skills
/// after "Revise", keeps its metadata, and an unchanged one is refused.
#[test]
fn revising_a_shared_draft_takes_edits_made_after_revise() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let cancel = CancelToken::new();
    let skill = draft(
        &habi,
        "Migration review",
        "Review Liquibase changesets. Use when a change adds or edits a changelog.",
        "1. Find the master changelog.\n",
    );
    let id = skill.summary.id.clone();
    habi.skills()
        .save_applicability(&id, &liquibase_form("Migration review"), None)
        .unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "init"]);
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources().refresh(&source.id, &cancel).unwrap();
    let cache = habi.sources().cache_dir(&source.id);
    git(&cache, &["config", "user.name", "Dev Example"]);
    git(&cache, &["config", "user.email", "dev@example.invalid"]);

    let c = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LocalSkill {
                skill_id: id.clone(),
            },
        )
        .unwrap();
    assert!(
        !c.validation
            .iter()
            .any(|d| d.message.contains("already exists")),
        "a new name replaces nothing: {:?}",
        c.validation
    );
    habi.commit_contribution(&c.id, &cancel).unwrap();
    habi.publish_contribution(&c.id, false, &cancel).unwrap();
    let r = habi.revise_contribution(&c.id).unwrap();
    assert_eq!(r.revision, 1);
    assert!(
        r.form
            .applies_tags
            .contains(&"framework:spring-boot".to_string())
    );
    let err = habi.commit_contribution(&c.id, &cancel).unwrap_err();
    assert!(err.to_string().contains("Nothing changed"), "{err}");

    // Edited in My skills after "Revise".
    let current = habi.skills().get(&id).unwrap();
    habi.skills()
        .save_document(
            &id,
            &current.summary.title,
            &SkillDocument {
                body: format!("{}2. Check rollbacks.\n", current.document.body),
                ..current.document.clone()
            },
            current.document_digest.as_deref(),
        )
        .unwrap();
    let revised = habi.commit_contribution(&c.id, &cancel).unwrap();
    let commit = revised.commit_id.clone().unwrap();
    let shown = git(
        &cache,
        &[
            "show",
            &format!("{commit}:skills/migration-review/SKILL.md"),
        ],
    );
    assert!(shown.contains("2. Check rollbacks."), "{shown}");
    let metadata = git(
        &cache,
        &[
            "show",
            &format!("{commit}:skills/migration-review/habi.yaml"),
        ],
    );
    assert!(metadata.contains("framework:spring-boot"), "{metadata}");
}

/// The package editor's file operations: rename and move (files and
/// folders), remove a folder, mark a script executable, replace a binary
/// file, and preview an image. None of them can leave the package.
#[test]
fn package_files_can_be_renamed_moved_replaced_and_previewed() {
    let home = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let skill = draft(
        &habi,
        "Release check",
        "Checks a release. Use before tagging.",
        "Run it.",
    );
    let id = skill.summary.id.clone();
    let skills = habi.skills();
    skills
        .write_file(&id, "scripts/check.sh", "#!/bin/sh\n", None)
        .unwrap();
    skills
        .write_file(&id, "references/a.md", "a", None)
        .unwrap();
    skills
        .write_file(&id, "references/b.md", "b", None)
        .unwrap();

    // Rename a file; the destination must not exist; SKILL.md stays put.
    let s = skills
        .rename_path(&id, "scripts/check.sh", "scripts/verify.sh")
        .unwrap();
    assert!(s.files.iter().any(|f| f.path == "scripts/verify.sh"));
    assert!(!s.files.iter().any(|f| f.path == "scripts/check.sh"));
    assert!(matches!(
        skills.rename_path(&id, "references/a.md", "references/b.md"),
        Err(HabiError::Conflict(_))
    ));
    assert!(skills.rename_path(&id, "SKILL.md", "README.md").is_err());
    assert!(
        skills
            .rename_path(&id, "references/a.md", "SKILL.md")
            .is_err()
    );
    assert!(
        skills
            .rename_path(&id, "references/a.md", "../a.md")
            .is_err()
    );
    assert!(
        skills
            .rename_path(&id, "references", "references/inner")
            .is_err()
    );

    // Move a whole folder; the old one disappears.
    let s = skills
        .rename_path(&id, "references", "docs/references")
        .unwrap();
    let paths: Vec<&str> = s.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"docs/references/a.md") && paths.contains(&"docs/references/b.md"));
    let package = home.path().join(format!("skills/{id}/package"));
    assert!(!package.join("references").exists());

    // Executable bit on and off. Windows has no such bit: there it stays off.
    let s = skills
        .set_executable(&id, "scripts/verify.sh", true)
        .unwrap();
    assert_eq!(
        s.files
            .iter()
            .find(|f| f.path == "scripts/verify.sh")
            .unwrap()
            .executable,
        cfg!(unix)
    );
    let s = skills
        .set_executable(&id, "scripts/verify.sh", false)
        .unwrap();
    assert!(
        !s.files
            .iter()
            .find(|f| f.path == "scripts/verify.sh")
            .unwrap()
            .executable
    );

    // Replace an image; it is previewed as a data URL. A 1x1 PNG.
    let png: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ];
    let picked = tempfile::tempdir().unwrap();
    std::fs::write(picked.path().join("logo.png"), png).unwrap();
    skills
        .add_files(&id, "assets", &[picked.path().join("logo.png")])
        .unwrap();
    let shown = skills.read_file(&id, "assets/logo.png").unwrap();
    assert!(shown.binary);
    assert!(
        shown
            .preview
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,iVBORw0KGgo")
    );
    std::fs::write(picked.path().join("new.png"), [png, b"x"].concat()).unwrap();
    let s = skills
        .replace_file(&id, "assets/logo.png", &picked.path().join("new.png"))
        .unwrap();
    assert_eq!(
        s.files
            .iter()
            .find(|f| f.path == "assets/logo.png")
            .unwrap()
            .size,
        17
    );
    assert!(
        skills
            .replace_file(&id, "SKILL.md", &picked.path().join("new.png"))
            .is_err()
    );
    assert!(
        skills
            .read_file(&id, "scripts/verify.sh")
            .unwrap()
            .preview
            .is_none()
    );

    // Remove a folder with everything in it; SKILL.md cannot go.
    let s = skills.remove_path(&id, "docs").unwrap();
    assert!(!s.files.iter().any(|f| f.path.starts_with("docs/")));
    assert!(!package.join("docs").exists());
    assert!(skills.remove_path(&id, "SKILL.md").is_err());
    assert!(skills.remove_path(&id, "../outside").is_err());
}

/// Copying a skill Habi installed from a library keeps the library item and
/// the installed version as its origin — and the project's local edits.
#[test]
fn copying_an_installed_skill_keeps_its_library_and_local_edits() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    git(lib.path(), &["init", "-q", "-b", "main"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "library"]);
    let habi = open(home.path());
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    let fetched = habi
        .sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let project_id = project(&habi, "billing-service", proj.path());
    let plan = habi
        .plan_install(
            &project_id,
            &[ItemRef {
                source_id: source.id.clone(),
                item_id: "liquibase-migration-review".into(),
            }],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    habi.apply(&plan.id).unwrap();
    let installed = proj
        .path()
        .join(".claude/skills/liquibase-migration-review/SKILL.md");
    let mut text = std::fs::read_to_string(&installed).unwrap();
    text.push_str("\nLocal note: the billing DBA reviews every changeset.\n");
    std::fs::write(&installed, &text).unwrap();

    let from = ImportFrom::Project {
        project_id: project_id.clone(),
    };
    let outcome = habi
        .import_skills(
            &from,
            &[ImportSelection {
                path: ".claude/skills/liquibase-migration-review".into(),
                rename: None,
            }],
            &CancelToken::new(),
        )
        .unwrap();
    let copied = &outcome.imported[0];
    match &copied.origin {
        SkillOrigin::Library {
            source_name,
            item_id,
            snapshot,
            ..
        } => {
            assert_eq!(source_name, "Team");
            assert_eq!(item_id, "liquibase-migration-review");
            assert_eq!(Some(snapshot), fetched.source.snapshot.as_ref());
        }
        other => panic!("expected a library origin, got {other:?}"),
    }
    let skill = habi.skills().get(&copied.id).unwrap();
    assert!(
        skill
            .document
            .body
            .contains("the billing DBA reviews every changeset")
    );
    // Supporting files came along too.
    assert!(
        skill
            .files
            .iter()
            .any(|f| f.path == "references/checklist.md")
    );
}

// ----- updates from the library a copy came from --------------------------------------

fn put(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

const REVIEW_SKILL: &str =
    "---\nname: review\ndescription: Review changes before merge.\n---\n\nRead references/a.md.\n";

/// A directory library with one skill, connected and fetched, and a copy of
/// that skill in My skills.
fn library_copy(habi: &Habi, lib: &Path) -> (String, String) {
    put(lib, "skills/review/SKILL.md", REVIEW_SKILL);
    put(lib, "skills/review/references/a.md", "A1\n");
    put(lib, "skills/review/references/b.md", "B1\n");
    put(lib, "skills/review/references/c.md", "C1\n");
    put(lib, "skills/review/scripts/run.sh", "#!/bin/sh\necho 1\n");
    #[cfg(unix)]
    make_executable(&lib.join("skills/review/scripts/run.sh"));
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

fn text(habi: &Habi, id: &str, rel: &str) -> String {
    habi.skills().read_file(id, rel).unwrap().text.unwrap()
}

#[test]
fn library_updates_take_untouched_files_and_never_overwrite_edits_silently() {
    use habi_core::skills::upstream::{UpstreamChoice, UpstreamFileStatus, UpstreamState};
    use std::collections::BTreeMap;
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let (source_id, id) = library_copy(&habi, lib.path());

    // Fresh copy: nothing to take. A draft has no library at all.
    let status = habi.skill_upstream(&id).unwrap().unwrap();
    assert_eq!(status.state, UpstreamState::Unchanged);
    assert_eq!(status.source_id.as_deref(), Some(source_id.as_str()));
    let own = draft(&habi, "Own", "Written here.", "Body.\n");
    assert!(habi.skill_upstream(&own.summary.id).unwrap().is_none());

    // Your edits alone are not an update.
    edit(&habi, &id, "references/b.md", "B mine\n");
    edit(&habi, &id, "references/c.md", "C mine\n");
    assert_eq!(
        habi.skill_upstream(&id).unwrap().unwrap().state,
        UpstreamState::Unchanged
    );
    assert!(habi.apply_upstream_sync(&id, "", &BTreeMap::new()).is_err());

    // The library changes a file you did not touch, one you did, adds one
    // and changes a script.
    put(lib.path(), "skills/review/references/a.md", "A2\n");
    put(lib.path(), "skills/review/references/c.md", "C2\n");
    put(lib.path(), "skills/review/references/new.md", "New\n");
    put(
        lib.path(),
        "skills/review/scripts/run.sh",
        "#!/bin/sh\necho 2\n",
    );
    habi.sources()
        .refresh(&source_id, &CancelToken::new())
        .unwrap();
    let current_snapshot = habi.sources().get(&source_id).unwrap().snapshot.unwrap();

    let status = habi.skill_upstream(&id).unwrap().unwrap();
    assert_eq!(status.state, UpstreamState::Changed);
    assert_ne!(status.origin_snapshot, current_snapshot);

    let plan = habi.plan_upstream_sync(&id).unwrap();
    let by_path: BTreeMap<&str, UpstreamFileStatus> = plan
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status))
        .collect();
    assert_eq!(by_path["references/a.md"], UpstreamFileStatus::Library);
    assert_eq!(by_path["references/new.md"], UpstreamFileStatus::Library);
    assert_eq!(by_path["scripts/run.sh"], UpstreamFileStatus::Library);
    assert_eq!(by_path["references/b.md"], UpstreamFileStatus::Yours);
    assert_eq!(by_path["references/c.md"], UpstreamFileStatus::Conflict);
    assert!(!by_path.contains_key("SKILL.md"));
    assert_eq!(
        (plan.take, plan.keep, plan.conflicts, plan.unchanged),
        (3, 1, 1, 1)
    );
    let conflict = plan
        .files
        .iter()
        .find(|f| f.path == "references/c.md")
        .unwrap();
    assert_eq!(conflict.library_diff.as_ref().unwrap().added, 1);
    assert_eq!(conflict.your_diff.as_ref().unwrap().added, 1);
    assert!(plan.blocked.is_none());

    // A conflict needs an explicit choice; without one nothing is written.
    let err = habi
        .apply_upstream_sync(&id, &plan.token, &BTreeMap::new())
        .unwrap_err();
    assert!(err.to_string().contains("references/c.md"), "{err}");
    assert_eq!(text(&habi, &id, "references/a.md"), "A1\n");
    // A plan that no longer matches what is on disk is refused.
    edit(&habi, &id, "references/b.md", "B mine, again\n");
    let decisions = BTreeMap::from([("references/c.md".to_string(), UpstreamChoice::KeepMine)]);
    assert!(matches!(
        habi.apply_upstream_sync(&id, &plan.token, &decisions),
        Err(HabiError::Conflict(_))
    ));
    let plan = habi.plan_upstream_sync(&id).unwrap();

    let updated = habi
        .apply_upstream_sync(&id, &plan.token, &decisions)
        .unwrap();
    assert_eq!(text(&habi, &id, "references/a.md"), "A2\n");
    assert_eq!(text(&habi, &id, "references/new.md"), "New\n");
    assert_eq!(text(&habi, &id, "scripts/run.sh"), "#!/bin/sh\necho 2\n");
    assert_eq!(text(&habi, &id, "references/b.md"), "B mine, again\n");
    assert_eq!(text(&habi, &id, "references/c.md"), "C mine\n");
    #[cfg(unix)]
    assert!(
        updated
            .files
            .iter()
            .find(|f| f.path == "scripts/run.sh")
            .unwrap()
            .executable
    );

    // The origin now names the library's current snapshot, so the next
    // comparison starts from what was just reviewed.
    assert!(matches!(
        &updated.summary.origin,
        SkillOrigin::Library { snapshot, .. } if snapshot == &current_snapshot
    ));
    let status = habi.skill_upstream(&id).unwrap().unwrap();
    assert_eq!(status.state, UpstreamState::Unchanged);
    assert_eq!(status.origin_snapshot, current_snapshot);

    // A later library change to the file you kept is again a conflict —
    // measured from C2, not C1 — and taking the library's version is a
    // choice you make.
    put(lib.path(), "skills/review/references/c.md", "C3\n");
    habi.sources()
        .refresh(&source_id, &CancelToken::new())
        .unwrap();
    let plan = habi.plan_upstream_sync(&id).unwrap();
    assert_eq!((plan.take, plan.conflicts), (0, 1));
    let conflict = &plan
        .files
        .iter()
        .find(|f| f.status == UpstreamFileStatus::Conflict)
        .unwrap();
    assert_eq!(conflict.path, "references/c.md");
    let removed: Vec<String> = conflict
        .library_diff
        .as_ref()
        .unwrap()
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.tag == habi_core::install::diff::LineTag::Removed)
        .map(|l| l.text.clone())
        .collect();
    assert_eq!(removed, ["C2"]);
    habi.apply_upstream_sync(
        &id,
        &plan.token,
        &BTreeMap::from([("references/c.md".to_string(), UpstreamChoice::TakeLibrary)]),
    )
    .unwrap();
    assert_eq!(text(&habi, &id, "references/c.md"), "C3\n");
    assert_eq!(text(&habi, &id, "references/b.md"), "B mine, again\n");
}

#[test]
fn removed_and_unreachable_library_items_are_reported_not_guessed() {
    use habi_core::skills::upstream::UpstreamState;
    use std::collections::BTreeMap;
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let habi = open(home.path());
    let (source_id, id) = library_copy(&habi, lib.path());
    let before = habi.skills().get(&id).unwrap();

    // Removed from the library: said plainly, nothing to apply, copy intact.
    std::fs::remove_dir_all(lib.path().join("skills/review")).unwrap();
    put(
        lib.path(),
        "skills/other/SKILL.md",
        "---\nname: other\ndescription: Another skill.\n---\n\nBody.\n",
    );
    habi.sources()
        .refresh(&source_id, &CancelToken::new())
        .unwrap();
    let status = habi.skill_upstream(&id).unwrap().unwrap();
    assert_eq!(status.state, UpstreamState::Removed);
    assert!(status.detail.unwrap().contains("no longer in Team"));
    let plan = habi.plan_upstream_sync(&id).unwrap();
    assert!(plan.files.is_empty());
    assert!(
        habi.apply_upstream_sync(&id, &plan.token, &BTreeMap::new())
            .is_err()
    );
    assert_eq!(
        habi.skills().get(&id).unwrap().files.len(),
        before.files.len()
    );

    // The library is no longer connected: unavailable, with the reason.
    habi.sources().remove(&source_id).unwrap();
    let status = habi.skill_upstream(&id).unwrap().unwrap();
    assert_eq!(status.state, UpstreamState::Unavailable);
    assert!(status.detail.unwrap().contains("not connected"));
    assert!(status.source_id.is_none());
}
