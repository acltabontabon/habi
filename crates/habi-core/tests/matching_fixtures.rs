//! One team library, several structurally different repositories: the
//! recommendations must differ, and every outcome must be explainable.

mod common;

use common::*;
use habi_core::inspect::model::{CoverageStatus, FactSubject, VersionState};
use habi_core::library::model::{LibraryIndex, MetadataStatus};
use habi_core::matching::eval::{Declaration, DeclaredSubject};
use habi_core::matching::{Applicability, ApplicabilityResult, assess};

fn result(
    library: &LibraryIndex,
    repo: &str,
    item: &str,
    declarations: &[Declaration],
) -> ApplicabilityResult {
    let inspection = inspect_fixture(repo);
    let item = library
        .items
        .iter()
        .find(|i| i.id == item)
        .unwrap_or_else(|| panic!("no item {item}"));
    assess(
        item.applies_when.as_ref(),
        item.excludes.as_ref(),
        item.scope,
        &inspection,
        declarations,
    )
}

fn outcome(library: &LibraryIndex, repo: &str, item: &str) -> Applicability {
    result(library, repo, item, &[]).applicability
}

fn library() -> LibraryIndex {
    let lib = library_from_dir(&fixture("libraries/example-team-library"));
    assert!(
        lib.diagnostics.is_empty(),
        "library diagnostics: {:?}",
        lib.diagnostics
    );
    for item in &lib.items {
        assert!(
            item.diagnostics.is_empty(),
            "{} has diagnostics: {:?}",
            item.id,
            item.diagnostics
        );
    }
    lib
}

#[test]
fn backend_service_gets_migration_review_with_concrete_evidence() {
    let lib = library();
    let r = result(
        &lib,
        "repos/billing-service",
        "liquibase-migration-review",
        &[],
    );
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
    // The explanation points at the actual declaration.
    assert!(r.reason.contains("pom.xml"), "{}", r.reason);
    let module = &r.modules[0];
    let tree = module.applies.as_ref().unwrap();
    assert!(!tree.children.is_empty());

    assert_eq!(
        outcome(&lib, "repos/billing-service", "jpa-entity-review"),
        Applicability::Applies
    );
    assert_eq!(
        outcome(&lib, "repos/billing-service", "jooq-query-review"),
        Applicability::DoesNotApply
    );
    assert_eq!(
        outcome(&lib, "repos/billing-service", "api-contract-review"),
        Applicability::DoesNotApply
    );
    assert_eq!(
        outcome(&lib, "repos/billing-service", "react-component-review"),
        Applicability::DoesNotApply
    );
    assert_eq!(
        outcome(&lib, "repos/billing-service", "java-service-conventions"),
        Applicability::Applies
    );
    assert_eq!(
        outcome(&lib, "repos/billing-service", "incident-notes"),
        Applicability::Undeclared
    );
}

#[test]
fn openapi_and_jooq_service() {
    let lib = library();
    let r = result(&lib, "repos/orders-api", "api-contract-review", &[]);
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
    assert!(r.reason.contains("orders-api.yaml"), "{}", r.reason);

    assert_eq!(
        outcome(&lib, "repos/orders-api", "jooq-query-review"),
        Applicability::Applies
    );
    // jOOQ with complete Gradle evidence: the JPA-only skill does not apply.
    let jpa = result(&lib, "repos/orders-api", "jpa-entity-review", &[]);
    assert_eq!(
        jpa.applicability,
        Applicability::DoesNotApply,
        "{}",
        jpa.reason
    );
    assert_eq!(
        outcome(&lib, "repos/orders-api", "liquibase-migration-review"),
        Applicability::DoesNotApply
    );
}

#[test]
fn frontend_is_not_fooled_by_its_readme() {
    let lib = library();
    let inspection = inspect_fixture("repos/storefront-web");
    assert!(
        inspection
            .facts
            .iter()
            .all(|f| f.tag() != Some("framework:spring-boot") && f.tag() != Some("db:liquibase")),
        "README mentions must not become facts"
    );
    assert_eq!(
        outcome(&lib, "repos/storefront-web", "react-component-review"),
        Applicability::Applies
    );
    assert_eq!(
        outcome(&lib, "repos/storefront-web", "frontend-test-practices"),
        Applicability::Applies
    );
    let lq = result(
        &lib,
        "repos/storefront-web",
        "liquibase-migration-review",
        &[],
    );
    assert_eq!(
        lq.applicability,
        Applicability::DoesNotApply,
        "{}",
        lq.reason
    );
    assert_eq!(
        outcome(&lib, "repos/storefront-web", "java-service-conventions"),
        Applicability::DoesNotApply
    );
    assert_eq!(
        outcome(&lib, "repos/storefront-web", "service-observability"),
        Applicability::DoesNotApply
    );

    // The lockfile pins the installed React version.
    let react = inspection
        .facts
        .iter()
        .find_map(|f| match &f.subject {
            FactSubject::Dependency { name, version, .. } if name == "react" => {
                Some(version.clone())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(react.state, VersionState::Resolved);
    assert_eq!(react.resolved.as_deref(), Some("18.3.1"));
}

#[test]
fn monorepo_matches_per_module() {
    let lib = library();
    let inspection = inspect_fixture("repos/platform-monorepo");
    assert!(inspection.repository.is_monorepo);

    let lq = result(
        &lib,
        "repos/platform-monorepo",
        "liquibase-migration-review",
        &[],
    );
    assert_eq!(lq.applicability, Applicability::Applies);
    let applying: Vec<&str> = lq
        .modules
        .iter()
        .filter(|m| m.applicability == Applicability::Applies)
        .map(|m| m.module.as_str())
        .collect();
    assert_eq!(applying, vec!["services/inventory"], "{}", lq.reason);

    let react = result(
        &lib,
        "repos/platform-monorepo",
        "react-component-review",
        &[],
    );
    let applying: Vec<&str> = react
        .modules
        .iter()
        .filter(|m| m.applicability == Applicability::Applies)
        .map(|m| m.module.as_str())
        .collect();
    assert_eq!(applying, vec!["apps/web"]);

    // catalog uses jOOQ: the JPA skill is excluded there; elsewhere JPA is absent.
    let jpa = result(&lib, "repos/platform-monorepo", "jpa-entity-review", &[]);
    assert_eq!(
        jpa.applicability,
        Applicability::DoesNotApply,
        "{:#?}",
        jpa.modules
            .iter()
            .map(|m| (&m.module, m.applicability, &m.reason))
            .collect::<Vec<_>>()
    );
    let catalog = jpa
        .modules
        .iter()
        .find(|m| m.module == "services/catalog")
        .unwrap();
    assert!(catalog.reason.starts_with("Excluded"), "{}", catalog.reason);

    // The corporate parent POM is external, so catalog's Maven coverage is partial
    // and the unresolved jOOQ version is reported as such.
    let cov = inspection
        .coverage
        .iter()
        .find(|c| c.module == "services/catalog" && c.area == "maven")
        .unwrap();
    assert_eq!(cov.status, CoverageStatus::Partial);
    let jooq_version = inspection
        .facts
        .iter()
        .find_map(|f| match &f.subject {
            FactSubject::Dependency { name, version, .. } if name == "org.jooq:jooq" => {
                Some(version.clone())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(jooq_version.state, VersionState::Unresolved);

    // Markdown mentioning "openapi: 3.0" is not a specification.
    assert_eq!(
        outcome(&lib, "repos/platform-monorepo", "api-contract-review"),
        Applicability::DoesNotApply
    );
}

#[test]
fn incomplete_evidence_needs_information_instead_of_guessing() {
    // A module whose parent POM is external: JPA absence is not established.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("pom.xml"),
        r#"<project><parent><groupId>com.example</groupId><artifactId>corp-parent</artifactId><version>7</version></parent>
           <artifactId>svc</artifactId>
           <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
           </project>"#,
    )
    .unwrap();
    let inspection = habi_core::inspect::inspect(
        dir.path(),
        &Default::default(),
        &habi_core::cancel::CancelToken::new(),
    )
    .unwrap();
    let lib = library();
    let jpa = lib
        .items
        .iter()
        .find(|i| i.id == "jpa-entity-review")
        .unwrap();
    let r = assess(
        jpa.applies_when.as_ref(),
        jpa.excludes.as_ref(),
        jpa.scope,
        &inspection,
        &[],
    );
    assert_eq!(
        r.applicability,
        Applicability::NeedsInformation,
        "{}",
        r.reason
    );
    assert!(r.reason.contains("corp-parent"), "{}", r.reason);

    // An explicit, reversible user declaration resolves it.
    let declared = vec![Declaration {
        id: "d1".into(),
        module: "*".into(),
        subject: DeclaredSubject::Tag {
            tag: "orm:jpa".into(),
        },
        present: true,
        note: Some("JPA comes from the corporate parent".into()),
        created_at: "2026-10-02T00:00:00Z".into(),
    }];
    let r = assess(
        jpa.applies_when.as_ref(),
        jpa.excludes.as_ref(),
        jpa.scope,
        &inspection,
        &declared,
    );
    assert_eq!(
        r.applicability,
        Applicability::NeedsInformation,
        "jOOQ exclusion still unknown: {}",
        r.reason
    );
    let mut declared = declared;
    declared.push(Declaration {
        id: "d2".into(),
        module: "*".into(),
        subject: DeclaredSubject::Tag {
            tag: "db:jooq".into(),
        },
        present: false,
        note: None,
        created_at: "2026-10-02T00:00:00Z".into(),
    });
    let r = assess(
        jpa.applies_when.as_ref(),
        jpa.excludes.as_ref(),
        jpa.scope,
        &inspection,
        &declared,
    );
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
}

#[test]
fn conflicting_declaration_is_surfaced_not_silently_applied() {
    let lib = library();
    let inspection = inspect_fixture("repos/billing-service");
    let item = lib
        .items
        .iter()
        .find(|i| i.id == "jpa-entity-review")
        .unwrap();
    let declared = vec![Declaration {
        id: "d1".into(),
        module: "*".into(),
        subject: DeclaredSubject::Tag {
            tag: "orm:jpa".into(),
        },
        present: false,
        note: None,
        created_at: "2026-10-02T00:00:00Z".into(),
    }];
    let r = assess(
        item.applies_when.as_ref(),
        item.excludes.as_ref(),
        item.scope,
        &inspection,
        &declared,
    );
    assert_eq!(r.applicability, Applicability::NeedsInformation);
    assert!(r.reason.contains("conflict"), "{}", r.reason);
}

#[test]
fn same_library_yields_different_recommendation_sets() {
    let lib = library();
    let applying = |repo: &str| -> Vec<String> {
        let inspection = inspect_fixture(repo);
        let mut ids: Vec<String> = lib
            .items
            .iter()
            .filter(|i| i.metadata_status == MetadataStatus::Declared)
            .filter(|i| {
                assess(
                    i.applies_when.as_ref(),
                    i.excludes.as_ref(),
                    i.scope,
                    &inspection,
                    &[],
                )
                .applicability
                    == Applicability::Applies
            })
            .map(|i| i.id.clone())
            .collect();
        ids.sort();
        ids
    };
    let backend = applying("repos/billing-service");
    let frontend = applying("repos/storefront-web");
    let mono = applying("repos/platform-monorepo");
    assert_ne!(backend, frontend);
    assert_ne!(backend, mono);
    assert_ne!(frontend, mono);
    assert!(backend.contains(&"liquibase-migration-review".to_string()));
    assert!(!frontend.contains(&"liquibase-migration-review".to_string()));
    assert!(frontend.contains(&"react-component-review".to_string()));
    assert!(
        mono.contains(&"react-component-review".to_string())
            && mono.contains(&"liquibase-migration-review".to_string())
    );
}

// ----- regressions --------------------------------------------------------

use habi_core::inspect::model::ProjectInspection;
use habi_core::matching::Scope;
use habi_core::matching::condition::Condition;
use std::path::Path;

fn cond(json: serde_json::Value) -> Condition {
    Condition::parse(&json).unwrap()
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn inspect_dir(root: &Path) -> ProjectInspection {
    habi_core::inspect::inspect(
        root,
        &Default::default(),
        &habi_core::cancel::CancelToken::new(),
    )
    .unwrap()
}

fn pom(artifact: &str, deps: &[(&str, &str)], modules: &[&str]) -> String {
    let deps: String = deps
        .iter()
        .map(|(g, a)| {
            format!("<dependency><groupId>{g}</groupId><artifactId>{a}</artifactId><version>1.0.0</version></dependency>")
        })
        .collect();
    let modules: String = modules
        .iter()
        .map(|m| format!("<module>{m}</module>"))
        .collect();
    format!(
        "<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>{artifact}</artifactId><version>1</version><modules>{modules}</modules><dependencies>{deps}</dependencies></project>"
    )
}

fn declaration(module: &str, tag: &str, present: bool) -> Declaration {
    Declaration {
        id: format!("{module}-{tag}"),
        module: module.into(),
        subject: DeclaredSubject::Tag { tag: tag.into() },
        present,
        note: None,
        created_at: "2026-10-02T00:00:00Z".into(),
    }
}

#[test]
fn many_modules_are_assessed_quickly() {
    // 100 Maven modules with 100 files each. Matching used to recompute the
    // owning module of every file for every module (modules² × files).
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let names: Vec<String> = (0..100).map(|i| format!("services/m{i:03}")).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    write(root, "pom.xml", &pom("root", &[], &refs));
    for name in &names {
        write(
            root,
            &format!("{name}/pom.xml"),
            &pom(
                name.rsplit('/').next().unwrap(),
                &[("org.springframework.boot", "spring-boot-starter-web")],
                &[],
            ),
        );
        for j in 0..99 {
            write(
                root,
                &format!("{name}/src/main/java/com/acme/F{j}.java"),
                "",
            );
        }
    }
    let inspection = inspect_dir(root);
    assert!(inspection.files.len() >= 10_000);
    let applies = cond(serde_json::json!({"all": [
        {"tag": "framework:spring-boot"},
        {"tag": "lang:java"},
        {"file": "src/main/java/**/*.java"}
    ]}));
    let excludes = cond(serde_json::json!({"tag": "db:jooq"}));
    // An overview assesses many items against one inspection. Each one must be
    // fast even in a debug build (it took minutes at 200 modules before).
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let r = assess(
            Some(&applies),
            Some(&excludes),
            Scope::Module,
            &inspection,
            &[],
        );
        assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
        assert_eq!(
            r.modules
                .iter()
                .filter(|m| m.applicability == Applicability::Applies)
                .count(),
            100
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "one assessment took {elapsed:?}"
        );
    }
}

#[test]
fn modules_see_repository_level_facts_of_the_root() {
    // A root aggregator, one Spring Boot module, and CI at the repository root.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "pom.xml", &pom("parent", &[], &["api"]));
    write(
        root,
        "api/pom.xml",
        &pom(
            "api",
            &[("org.springframework.boot", "spring-boot-starter-web")],
            &[],
        ),
    );
    write(root, ".github/workflows/ci.yml", "on: push\n");
    write(root, "AGENTS.md", "# Agents\n");
    let inspection = inspect_dir(root);
    let applies = cond(serde_json::json!({"all": [
        {"tag": "framework:spring-boot"},
        {"tag": "ci:github-actions"},
        {"tag": "agents:agents-md"}
    ]}));
    let r = assess(Some(&applies), None, Scope::Module, &inspection, &[]);
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
    let api = r.modules.iter().find(|m| m.module == "api").unwrap();
    assert_eq!(api.applicability, Applicability::Applies, "{}", api.reason);
    let ci = &api.applies.as_ref().unwrap().children[1];
    assert!(
        ci.reason.contains("repository root") && ci.reason.contains("ci.yml"),
        "{}",
        ci.reason
    );
    // Build-manifest facts are not inherited: the root itself has no Spring Boot.
    let root_match = r.modules.iter().find(|m| m.module == ".").unwrap();
    assert_eq!(root_match.applicability, Applicability::DoesNotApply);
}

#[test]
fn content_probe_limit_does_not_turn_file_absence_into_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "pom.xml", &pom("svc", &[], &[]));
    for i in 0..650 {
        write(root, &format!("fixtures/data/f{i:04}.json"), "{}");
    }
    let inspection = inspect_dir(root);
    let no_docker = cond(serde_json::json!({"not": {"file": "**/Dockerfile"}}));
    let r = assess(Some(&no_docker), None, Scope::Module, &inspection, &[]);
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
    let no_ci = cond(serde_json::json!({"not": {"tag": "ci:github-actions"}}));
    let r = assess(Some(&no_ci), None, Scope::Module, &inspection, &[]);
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
    // Content-based tags are honestly unknown: an unread file may be a spec.
    let openapi = cond(serde_json::json!({"tag": "api:openapi"}));
    let r = assess(Some(&openapi), None, Scope::Module, &inspection, &[]);
    assert_eq!(
        r.applicability,
        Applicability::NeedsInformation,
        "{}",
        r.reason
    );
}

#[cfg(unix)]
#[test]
fn unreadable_directory_makes_file_absence_unknown() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "pom.xml", &pom("svc", &[], &[]));
    write(root, "deploy/Dockerfile", "FROM scratch\n");
    let locked = root.join("deploy");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let inspection = habi_core::inspect::inspect(
        root,
        &Default::default(),
        &habi_core::cancel::CancelToken::new(),
    );
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let inspection = inspection.unwrap();
    if inspection.files.iter().any(|f| f == "deploy/Dockerfile") {
        return; // privileged run: the directory was readable after all
    }
    let no_docker = cond(serde_json::json!({"not": {"file": "**/Dockerfile"}}));
    let r = assess(Some(&no_docker), None, Scope::Module, &inspection, &[]);
    assert_eq!(
        r.applicability,
        Applicability::NeedsInformation,
        "{}",
        r.reason
    );
}

#[test]
fn module_declarations_do_not_leak_into_repository_scope() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "pom.xml", &pom("parent", &[], &["api"]));
    write(root, "api/pom.xml", &pom("api", &[], &[]));
    write(root, ".github/workflows/ci.yml", "on: push\n");
    let inspection = inspect_dir(root);

    // "No CI in api" says nothing about the CI found at the root.
    let ci = cond(serde_json::json!({"tag": "ci:github-actions"}));
    let declared = vec![declaration("api", "ci:github-actions", false)];
    let r = assess(Some(&ci), None, Scope::Repository, &inspection, &declared);
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);

    // "api is not team:payments" does not make the whole repository not so.
    let team = cond(serde_json::json!({"tag": "team:payments"}));
    let declared = vec![declaration("api", "team:payments", false)];
    let r = assess(Some(&team), None, Scope::Repository, &inspection, &declared);
    assert_eq!(
        r.applicability,
        Applicability::NeedsInformation,
        "{}",
        r.reason
    );
    // A repository-wide declaration does decide it.
    let declared = vec![declaration("*", "team:payments", false)];
    let r = assess(Some(&team), None, Scope::Repository, &inspection, &declared);
    assert_eq!(r.applicability, Applicability::DoesNotApply, "{}", r.reason);
    // "api is team:payments" establishes presence somewhere, and says where.
    let declared = vec![declaration("api", "team:payments", true)];
    let r = assess(Some(&team), None, Scope::Repository, &inspection, &declared);
    assert_eq!(r.applicability, Applicability::Applies, "{}", r.reason);
    let leaf = r.modules[0].applies.as_ref().unwrap();
    assert!(leaf.reason.contains("module api"), "{}", leaf.reason);
}

#[test]
fn does_not_apply_reason_cites_the_module_with_evidence() {
    // The root aggregator has nothing; `api` fails because it uses jOOQ.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "pom.xml", &pom("parent", &[], &["api"]));
    write(
        root,
        "api/pom.xml",
        &pom("api", &[("org.jooq", "jooq")], &[]),
    );
    let inspection = inspect_dir(root);
    let applies = cond(serde_json::json!({"all": [
        {"tag": "lang:python"},
        {"not": {"tag": "db:jooq"}}
    ]}));
    let r = assess(Some(&applies), None, Scope::Module, &inspection, &[]);
    assert_eq!(r.applicability, Applicability::DoesNotApply, "{}", r.reason);
    assert!(r.reason.contains("— in api:"), "{}", r.reason);
}
