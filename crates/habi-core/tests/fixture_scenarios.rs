//! Scenarios built on the second library and the edge-case repositories:
//! multiple sources, name collisions, invalid metadata, partial Gradle
//! evidence, projects with no supported manifests, and projects that already
//! contain agent files Habi did not install.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::inspect::model::{CoverageStatus, FactSubject, VersionState};
use habi_core::install::plan::{ConflictKind, Decisions};
use habi_core::library::model::MetadataStatus;
use habi_core::matching::Applicability;
use habi_core::service::{Habi, ItemRef, ProjectRecord};
use habi_core::source::{NewSource, Source, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;

struct World {
    _dirs: Vec<tempfile::TempDir>,
    habi: Habi,
    team: Source,
    security: Source,
}

fn world() -> World {
    let home = tempfile::tempdir().unwrap();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let add = |name: &str, dir: &str| {
        let s = habi
            .sources()
            .add(&NewSource {
                name: name.into(),
                location: fixture(dir).to_string_lossy().into(),
                subdir: None,
                tracked: TrackedRef::Default,
            })
            .unwrap();
        habi.sources().refresh(&s.id, &CancelToken::new()).unwrap();
        habi.sources().get(&s.id).unwrap()
    };
    let team = add("Team", "libraries/example-team-library");
    let security = add("Security", "libraries/security-guild-library");
    World {
        _dirs: vec![home],
        habi,
        team,
        security,
    }
}

fn project_copy(w: &mut World, repo: &str) -> (ProjectRecord, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture(repo), dir.path());
    let root = dir.path().to_path_buf();
    let p = w.habi.open_project(&root).unwrap();
    w._dirs.push(dir);
    (p, root)
}

#[test]
fn second_library_edge_cases_are_reported() {
    let w = world();
    let index = w.habi.sources().index(&w.security.id).unwrap();
    let get = |id: &str| index.items.iter().find(|i| i.id == id).unwrap();
    assert_eq!(
        get("secrets-hygiene").metadata_status,
        MetadataStatus::Invalid
    );
    assert!(
        get("secrets-hygiene").applies_when.is_none(),
        "invalid metadata is not guessed"
    );
    assert_eq!(
        get("threat-model").metadata_status,
        MetadataStatus::Undeclared
    );
    let audit = get("dependency-audit");
    let script = audit
        .files
        .iter()
        .find(|f| f.path == "scripts/summarize.sh")
        .unwrap();
    #[cfg(unix)]
    assert!(
        script.executable,
        "executable bit read from the folder source"
    );
    let _ = script;
    assert!(index.items.iter().any(|i| i.id == "secure-defaults"));
}

#[test]
fn partial_gradle_evidence_needs_information() {
    let mut w = world();
    let (project, _) = project_copy(&mut w, "repos/inventory-gradle-multi");
    let overview = w
        .habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let inspection = &overview.inspection;
    let api = inspection
        .coverage
        .iter()
        .find(|c| c.module == "api" && c.area == "gradle")
        .unwrap();
    assert_eq!(
        api.status,
        CoverageStatus::Partial,
        "convention plugins in buildSrc"
    );
    let worker_dep = inspection
        .facts
        .iter()
        .find_map(|f| match &f.subject {
            FactSubject::Dependency { name, version, .. } if name == "com.example.queue:client" => {
                Some(version.clone())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(worker_dep.state, VersionState::Unresolved);
    assert!(
        inspection
            .facts
            .iter()
            .any(|f| f.module == "api" && f.tag() == Some("db:flyway"))
    );

    let jpa = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "jpa-entity-review")
        .unwrap();
    assert_eq!(
        jpa.applicability.applicability,
        Applicability::NeedsInformation,
        "JPA is present but a jOOQ exclusion cannot be ruled out: {}",
        jpa.applicability.reason
    );
}

#[test]
fn project_without_supported_manifests_gets_no_false_matches() {
    let mut w = world();
    let (project, _) = project_copy(&mut w, "repos/legacy-scripts");
    let overview = w
        .habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    assert!(
        overview
            .inspection
            .facts
            .iter()
            .any(|f| f.tag() == Some("lang:python"))
    );
    let applying: Vec<&str> = overview
        .recommendations
        .iter()
        .filter(|r| r.applicability.applicability == Applicability::Applies)
        .map(|r| r.item.id.as_str())
        .collect();
    assert!(
        applying.is_empty(),
        "README mentions are not evidence: {applying:?}"
    );
    assert!(
        overview
            .recommendations
            .iter()
            .any(|r| r.applicability.applicability == Applicability::Undeclared),
        "undeclared skills stay available"
    );
}

#[test]
fn existing_agent_files_are_respected() {
    let mut w = world();
    let (project, root) = project_copy(&mut w, "repos/agent-ready-service");
    let overview = w
        .habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let jpa = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "jpa-entity-review")
        .unwrap();
    assert_eq!(jpa.applicability.applicability, Applicability::Applies);
    assert_eq!(
        jpa.unmanaged_copies,
        vec![".claude/skills/jpa-entity-review/SKILL.md".to_string()]
    );

    let item = |s: &Source, id: &str| ItemRef {
        source_id: s.id.clone(),
        item_id: id.into(),
    };
    let plan = w
        .habi
        .plan_install(
            &project.id,
            &[item(&w.team, "jpa-entity-review")],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].kind, ConflictKind::UnmanagedContent);

    // MCP configuration is added next to the existing server, not over it.
    let plan = w
        .habi
        .plan_install(
            &project.id,
            &[item(&w.team, "github-pr-summary")],
            &[ClientId::ClaudeCode],
            true,
            &Decisions::new(),
        )
        .unwrap();
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    w.habi.apply(&plan.id).unwrap();
    let mcp: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join(".mcp.json")).unwrap()).unwrap();
    assert!(
        mcp["mcpServers"].get("postgres").is_some() && mcp["mcpServers"].get("github").is_some()
    );
    let agents = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
    assert!(agents.starts_with("# accounts-service"));
}

#[test]
fn same_name_from_two_libraries_is_kept_apart() {
    let mut w = world();
    let (project, _) = project_copy(&mut w, "repos/orders-api");
    let overview = w
        .habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let both: Vec<&str> = overview
        .recommendations
        .iter()
        .filter(|r| r.item.id == "api-contract-review")
        .map(|r| r.item.source_name.as_str())
        .collect();
    assert_eq!(both.len(), 2, "one per library: {both:?}");

    let item = |s: &Source| ItemRef {
        source_id: s.id.clone(),
        item_id: "api-contract-review".into(),
    };
    let first = w
        .habi
        .plan_install(
            &project.id,
            &[item(&w.team)],
            &[ClientId::Codex],
            false,
            &Decisions::new(),
        )
        .unwrap();
    w.habi.apply(&first.id).unwrap();
    let second = w
        .habi
        .plan_install(
            &project.id,
            &[item(&w.security)],
            &[ClientId::Codex],
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert!(
        second
            .conflicts
            .iter()
            .any(|c| c.kind == ConflictKind::PathCollision),
        "{:?}",
        second.conflicts
    );
    let _ = Path::new("");
}

fn has_dependency(i: &habi_core::inspect::model::ProjectInspection, name: &str) -> bool {
    i.facts
        .iter()
        .any(|f| matches!(&f.subject, FactSubject::Dependency { name: n, .. } if n == name))
}

#[test]
fn cached_inspections_notice_edits_new_files_and_invalidation() {
    let mut w = world();
    let (p, root) = project_copy(&mut w, "repos/billing-service");
    let cancel = CancelToken::new();
    let first = w.habi.inspect(&p.id, false, &cancel).unwrap();
    assert!(!has_dependency(&first, "org.jooq:jooq"));
    // Unchanged project: the cached copy is served.
    let again = w.habi.inspect(&p.id, false, &cancel).unwrap();
    assert_eq!(again.inspected_at, first.inspected_at);
    assert_eq!(again.fingerprint, first.fingerprint);

    // A manifest edit (as after a branch switch) is picked up without an
    // explicit rescan.
    let pom = root.join("pom.xml");
    let text = std::fs::read_to_string(&pom).unwrap().replacen(
        "<dependencies>",
        "<dependencies>\n        <dependency><groupId>org.jooq</groupId><artifactId>jooq</artifactId><version>3.19.10</version></dependency>",
        1,
    );
    std::fs::write(&pom, text).unwrap();
    let edited = w.habi.inspect(&p.id, false, &cancel).unwrap();
    assert!(has_dependency(&edited, "org.jooq:jooq"));
    assert_ne!(edited.fingerprint, first.fingerprint);

    // A new file in a new directory (CI added) is picked up too.
    std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
    std::fs::write(root.join(".github/workflows/ci.yml"), "on: push\n").unwrap();
    let with_ci = w.habi.inspect(&p.id, false, &cancel).unwrap();
    assert!(
        with_ci
            .facts
            .iter()
            .any(|f| f.tag() == Some("ci:github-actions")),
        "new workflow not seen"
    );

    // Explicit invalidation always re-inspects.
    w.habi.invalidate_inspection(&p.id);
    let fresh = w.habi.inspect(&p.id, false, &cancel).unwrap();
    assert!(
        fresh
            .facts
            .iter()
            .any(|f| f.tag() == Some("ci:github-actions"))
    );
}

#[test]
fn applying_a_plan_refreshes_the_cached_inspection() {
    let mut w = world();
    let (p, root) = project_copy(&mut w, "repos/billing-service");
    let cancel = CancelToken::new();
    let before = w.habi.overview(&p.id, false, &cancel).unwrap();
    let has_skills = |i: &habi_core::inspect::model::ProjectInspection| {
        i.facts.iter().any(|f| f.tag() == Some("agents:skills"))
    };
    assert!(!has_skills(&before.inspection));
    let plan = w
        .habi
        .plan_install(
            &p.id,
            &[ItemRef {
                source_id: w.team.id.clone(),
                item_id: "liquibase-migration-review".into(),
            }],
            &[ClientId::ClaudeCode],
            false,
            &Decisions::new(),
        )
        .unwrap();
    w.habi.apply(&plan.id).unwrap();
    assert!(root.join(".claude/skills").is_dir());
    let after = w.habi.overview(&p.id, false, &cancel).unwrap();
    assert!(
        has_skills(&after.inspection),
        "installed skill not seen after apply"
    );
}
