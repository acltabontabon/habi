//! Verification checks: preview, explicit run, recorded result, staleness.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::checks::CheckStatus;
use habi_core::recommend::EvidenceState;
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::collections::HashMap;

#[test]
fn checks_are_previewed_run_explicitly_and_recorded() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let skill = lib.path().join("skills/changelog-check");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), "---\nname: changelog-check\ndescription: Checks that a changelog file exists.\n---\nRun the check.\n").unwrap();
    std::fs::write(
        skill.join("habi.yaml"),
        r#"habi: 1
applies_when: { file: "**/db/changelog/*.yaml" }
bindings:
  - name: changelog
    kind: file
    glob: "**/db/changelog/*.yaml"
checks:
  - id: exists
    title: Changelog is readable
    run: ["git", "hash-object", { binding: changelog }]
    cwd: repository
    timeout_seconds: 30
"#,
    )
    .unwrap();
    copy_tree(&fixture("repos/billing-service"), proj.path());

    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Folder".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let project = habi.open_project(proj.path()).unwrap();
    let key = format!("{}/changelog-check", source.id);

    // Preview: the binding has one discovered candidate, preselected.
    let preview = habi
        .prepare_check(&project.id, &key, "exists", ".", &HashMap::new())
        .unwrap();
    assert!(preview.ready);
    assert_eq!(preview.program, "git");
    assert!(preview.resolved_program.is_some());
    assert_eq!(
        preview.args,
        vec![
            "hash-object",
            "src/main/resources/db/changelog/db.changelog-master.yaml"
        ]
    );
    assert!(preview.warnings.iter().any(|w| w.contains("not sandbox")));

    // Values that were not discovered are refused.
    let mut bad = HashMap::new();
    bad.insert("changelog".to_string(), "../../etc/passwd".to_string());
    assert!(
        habi.prepare_check(&project.id, &key, "exists", ".", &bad)
            .is_err()
    );

    // Nothing ran yet.
    let overview = habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "changelog-check")
        .unwrap();
    assert_eq!(rec.evidence.state, EvidenceState::NotEvaluated);

    let run = habi
        .run_check(&project.id, &preview.preview_id, &CancelToken::new())
        .unwrap();
    // Preview ids are single-use.
    assert!(
        habi.run_check(&project.id, &preview.preview_id, &CancelToken::new())
            .is_err()
    );
    assert_eq!(run.status, CheckStatus::Passed, "{}", run.output_tail);
    assert_eq!(run.argv[0], "git");
    assert!(
        run.output_tail.trim().len() >= 40,
        "git printed an object id"
    );

    let overview = habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "changelog-check")
        .unwrap();
    assert_eq!(rec.evidence.state, EvidenceState::LocallyChecked);

    // The project changes: the passing run no longer counts.
    std::fs::write(
        proj.path().join("pom.xml"),
        "<project><artifactId>changed</artifactId></project>",
    )
    .unwrap();
    let overview = habi
        .overview(&project.id, true, &CancelToken::new())
        .unwrap();
    let rec = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "changelog-check")
        .unwrap();
    assert_eq!(rec.evidence.state, EvidenceState::Stale);
    assert_eq!(habi.check_runs(&project.id, &key).unwrap().len(), 1);
}
