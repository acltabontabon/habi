//! Generates JSON fixtures for the desktop UI's component tests from the real
//! core (not hand-written data). Run with:
//! `cargo test -p habi-core --test ui_fixtures -- --ignored`

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::process::Command;

#[test]
#[ignore = "writes fixture files for the desktop UI tests"]
fn export_ui_fixtures() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    for args in [
        vec!["init", "-q"],
        vec!["add", "-A"],
        vec!["commit", "-qm", "Example library"],
    ] {
        let ok = Command::new("git")
            .args([
                "-c",
                "user.name=Example",
                "-c",
                "user.email=example@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(&args)
            .current_dir(lib.path())
            .status()
            .unwrap();
        assert!(ok.success());
    }
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Example team library".into(),
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
    let out = workspace_root().join("apps/desktop/src/test/fixtures");
    std::fs::create_dir_all(&out).unwrap();
    let index = habi.sources().index(&source.id).unwrap();
    let mut details = serde_json::Map::new();
    for item in &index.items {
        let mut d = serde_json::to_value(habi.item_detail(&source.id, &item.id).unwrap()).unwrap();
        d["source"]["location"] = "git@example.invalid:team/skills.git".into();
        details.insert(item.id.clone(), d);
    }
    std::fs::create_dir_all(workspace_root().join("apps/desktop/src/test/fixtures")).unwrap();
    let write = |name: &str, v: &serde_json::Value| {
        std::fs::write(
            workspace_root()
                .join("apps/desktop/src/test/fixtures")
                .join(name),
            serde_json::to_string_pretty(v).unwrap(),
        )
        .unwrap()
    };
    write("library.json", &serde_json::to_value(&index).unwrap());
    write("item-details.json", &serde_json::Value::Object(details));
    for repo in ["billing-service", "platform-monorepo"] {
        let project = habi
            .open_project(&fixture(&format!("repos/{repo}")))
            .unwrap();
        let mut overview = serde_json::to_value(
            habi.overview(&project.id, true, &CancelToken::new())
                .unwrap(),
        )
        .unwrap();
        // Machine-specific paths are replaced so the fixture is portable.
        overview["project"]["path"] = format!("~/work/{repo}").into();
        overview["inspection"]["root"] = format!("~/work/{repo}").into();
        overview["sources"][0]["location"] = "git@example.invalid:team/skills.git".into();
        std::fs::write(
            out.join(format!("overview-{repo}.json")),
            serde_json::to_string_pretty(&overview).unwrap(),
        )
        .unwrap();
        if repo == "billing-service" {
            let plan = habi
                .plan_install(
                    &project.id,
                    &[
                        habi_core::service::ItemRef {
                            source_id: source.id.clone(),
                            item_id: "liquibase-migration-review".into(),
                        },
                        habi_core::service::ItemRef {
                            source_id: source.id.clone(),
                            item_id: "java-service-conventions".into(),
                        },
                    ],
                    &[
                        habi_core::clients::ClientId::ClaudeCode,
                        habi_core::clients::ClientId::Codex,
                    ],
                    false,
                    &Default::default(),
                )
                .unwrap();
            let mut plan = serde_json::to_value(plan).unwrap();
            plan["project"] = "~/work/billing-service".into();
            write("plan-install.json", &plan);
        }
    }
}
