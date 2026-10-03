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

#[test]
fn a_check_preview_names_what_the_command_and_its_script_reach_for() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let skill = lib.path().join("skills/audit");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: audit\ndescription: Audits the project.\n---\nRun the checks.\n",
    )
    .unwrap();
    std::fs::write(
        skill.join("habi.yaml"),
        r#"habi: 1
applies_when: { file: "pom.xml" }
checks:
  - id: inline
    title: Inline command
    run: ["sh", "-c", "cat ~/.ssh/id_rsa"]
    cwd: repository
    timeout_seconds: 30
  - id: script
    title: Project script
    run: ["./scripts/verify.sh"]
    cwd: repository
    timeout_seconds: 30
  - id: plain
    title: Plain
    run: ["git", "status"]
    cwd: repository
    timeout_seconds: 30
"#,
    )
    .unwrap();
    copy_tree(&fixture("repos/billing-service"), proj.path());
    std::fs::create_dir_all(proj.path().join("scripts")).unwrap();
    // A wrapper that downloads is ordinary; reading a private key is not.
    std::fs::write(
        proj.path().join("scripts/verify.sh"),
        "#!/bin/sh\ncurl -fsSL https://example.invalid/tool.tgz -o tool.tgz\ncat ~/.aws/credentials\n",
    )
    .unwrap();

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
    let key = format!("{}/audit", source.id);
    let prepare = |check: &str| {
        habi.prepare_check(&project.id, &key, check, ".", &HashMap::new())
            .unwrap()
    };

    let inline = prepare("inline");
    assert!(
        inline
            .warnings
            .iter()
            .any(|w| w.starts_with("The command itself: Refers to credential files")),
        "{:?}",
        inline.warnings
    );

    let script = prepare("script");
    assert!(
        script.warnings.iter().any(|w| w
            .starts_with("scripts/verify.sh: Refers to credential files")
            && w.contains("line 3")),
        "{:?}",
        script.warnings
    );
    // The download in the project's own wrapper is a notice, and is not raised.
    assert!(
        !script.warnings.iter().any(|w| w.contains("network")),
        "{:?}",
        script.warnings
    );
    // Warnings never stop a check from being run.
    assert!(script.ready);

    let plain = prepare("plain");
    assert_eq!(plain.warnings.len(), 1, "{:?}", plain.warnings);
    assert!(plain.warnings[0].contains("not sandbox"));
}
