//! Exercises the real IPC boundary with Tauri's mock runtime: commands are
//! invoked with camelCase JSON exactly as the webview sends it, so argument
//! naming, deserialization and error shapes are checked end to end.

use crate::commands;
use crate::state::AppState;
use habi_core::service::Habi;
use habi_core::store::AppPaths;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::{InvokeRequest, WebviewWindow};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_tree(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
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

fn call(webview: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap())
}

#[test]
fn webview_contract_end_to_end() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(
        &fixtures().join("libraries/example-team-library"),
        lib.path(),
    );
    git(lib.path(), &["init", "-q"]);
    git(lib.path(), &["add", "-A"]);
    git(lib.path(), &["commit", "-qm", "lib"]);
    copy_tree(&fixtures().join("repos/billing-service"), proj.path());

    // Registration and project opening normally go through native pickers (Rust side).
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&habi_core::source::NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: habi_core::source::TrackedRef::Default,
        })
        .unwrap();
    let project = habi.open_project(proj.path()).unwrap();

    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::log_ui_error,
            commands::add_source,
            commands::refresh_source,
            commands::project_overview,
            commands::plan_install,
            commands::apply_plan,
            commands::history,
            commands::declare,
            commands::read_project_excerpt,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(AppState::new(Some(habi), None, None));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let info = call(&webview, "app_info", json!({})).unwrap();
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));

    // UI errors are logged; a missing detail is fine.
    call(
        &webview,
        "log_ui_error",
        json!({ "message": "TypeError: x is undefined", "detail": null }),
    )
    .unwrap();

    let refreshed = call(
        &webview,
        "refresh_source",
        json!({ "sourceId": source.id, "jobId": "job-1" }),
    )
    .unwrap();
    assert_eq!(refreshed["changed"], true);

    let overview = call(
        &webview,
        "project_overview",
        json!({ "projectId": project.id, "rescan": true, "jobId": null }),
    )
    .unwrap();
    assert!(overview["recommendations"].as_array().unwrap().len() >= 10);

    let plan = call(
        &webview,
        "plan_install",
        json!({
            "projectId": project.id,
            "items": [{ "sourceId": source.id, "itemId": "liquibase-migration-review" }],
            "clients": ["claude-code"],
            "includeMcp": false,
            "decisions": {}
        }),
    )
    .unwrap();
    assert_eq!(plan["title"], "Install for Claude Code in this project");
    assert!(
        plan["changes"][0].get("content").is_none(),
        "file contents never reach the webview"
    );

    let op = call(&webview, "apply_plan", json!({ "planId": plan["id"] })).unwrap();
    assert_eq!(op["state"], "committed");
    assert!(
        proj.path()
            .join(".claude/skills/liquibase-migration-review/SKILL.md")
            .exists()
    );

    // Plans are single-use.
    let again = call(&webview, "apply_plan", json!({ "planId": plan["id"] })).unwrap_err();
    assert_eq!(again["code"], "notFound");

    let history = call(&webview, "history", json!({ "projectId": project.id })).unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);

    let declared = call(
        &webview,
        "declare",
        json!({ "projectId": project.id, "module": "*", "subject": { "type": "tag", "tag": "team:payments" }, "present": true, "note": null }),
    )
    .unwrap();
    assert_eq!(declared["present"], true);

    // Untrusted input is refused.
    let local = call(
        &webview,
        "add_source",
        json!({ "source": { "name": "Sneaky", "location": home.path().to_string_lossy(), "subdir": null, "tracked": { "kind": "default" } } }),
    )
    .unwrap_err();
    assert_eq!(
        local["code"], "invalidInput",
        "local folders must come from the native picker"
    );
    let escape = call(
        &webview,
        "read_project_excerpt",
        json!({ "projectId": project.id, "path": "../outside.txt", "line": null }),
    )
    .unwrap_err();
    assert_eq!(escape["code"], "invalidInput");
    std::fs::write(proj.path().join(".env"), "SECRET=1").unwrap();
    let secret = call(
        &webview,
        "read_project_excerpt",
        json!({ "projectId": project.id, "path": ".env", "line": 1 }),
    )
    .unwrap_err();
    assert_eq!(secret["code"], "invalidInput");
    let malformed = call(
        &webview,
        "plan_install",
        json!({ "projectId": project.id, "items": "nope" }),
    )
    .unwrap_err();
    assert!(
        malformed.is_string() || malformed.is_object(),
        "malformed arguments are rejected: {malformed}"
    );
}

/// The local-skill commands with the argument names and shapes the webview
/// sends: create, autosave with conflict detection, preview, discovery,
/// installation through a plan, and the folder-picker guard on imports.
#[test]
fn local_skill_contract_end_to_end() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    copy_tree(&fixtures().join("repos/billing-service"), proj.path());
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let project = habi.open_project(proj.path()).unwrap();

    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::list_skills,
            commands::get_skill,
            commands::create_skill,
            commands::save_skill_document,
            commands::save_skill_applicability,
            commands::write_skill_file,
            commands::trash_skill,
            commands::restore_skill,
            commands::preview_skill,
            commands::suggest_conditions,
            commands::discover_project,
            commands::read_instructions,
            commands::inspect_import,
            commands::import_skills,
            commands::plan_install,
            commands::apply_plan,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(AppState::new(Some(habi), None, None));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    // Creating needs nothing but a title, and no project or library.
    let created = call(
        &webview,
        "create_skill",
        json!({ "skill": { "title": "Migration review", "description": "", "template": "reviewProcedure" }, "projectId": null }),
    )
    .unwrap();
    let id = created["summary"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["document"]["name"], "migration-review");
    assert!(created["summary"]["errors"].as_u64().unwrap() > 0);

    let document = json!({
        "name": "migration-review",
        "description": "Review Liquibase changesets. Use when a change edits a changelog.",
        "body": "1. Find the master changelog.\n"
    });
    let saved = call(
        &webview,
        "save_skill_document",
        json!({ "id": id, "title": "Migration review", "document": document, "baseDigest": created["documentDigest"] }),
    )
    .unwrap();
    assert_eq!(saved["summary"]["errors"], 0);

    // A save that names a stale version is refused as a conflict.
    let stale = call(
        &webview,
        "save_skill_document",
        json!({ "id": id, "title": "Migration review", "document": document, "baseDigest": created["documentDigest"] }),
    )
    .unwrap_err();
    assert_eq!(stale["code"], "conflict");

    let form = json!({
        "title": "Migration review", "owner": "", "repositoryScope": false, "conditionsEditable": true,
        "matchMode": "all", "appliesTags": ["framework:spring-boot"],
        "appliesDependencies": ["org.liquibase:liquibase-core"], "appliesFiles": [],
        "excludeTags": [], "excludeDependencies": [], "tools": [], "examples": []
    });
    let preview = call(
        &webview,
        "preview_skill",
        json!({ "request": { "skillId": id, "form": form, "metadataText": null }, "jobId": "job-p" }),
    )
    .unwrap();
    assert_eq!(preview["projects"][0]["result"]["applicability"], "applies");
    let with_rules = call(
        &webview,
        "save_skill_applicability",
        json!({ "id": id, "form": form, "baseDigest": null }),
    )
    .unwrap();
    assert_eq!(with_rules["summary"]["hasApplicability"], true);

    let suggestions = call(
        &webview,
        "suggest_conditions",
        json!({ "projectId": project.id }),
    )
    .unwrap();
    assert!(
        suggestions
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["value"] == "framework:spring-boot")
    );

    let found = call(
        &webview,
        "discover_project",
        json!({ "projectId": project.id, "jobId": null }),
    )
    .unwrap();
    assert_eq!(found["instructions"][0]["path"], "CLAUDE.md");
    let escape = call(
        &webview,
        "read_instructions",
        json!({ "projectId": project.id, "path": "../../etc/hosts" }),
    )
    .unwrap_err();
    assert_eq!(escape["code"], "notFound");

    // The local skill installs through the same reviewed plan as team items.
    let plan = call(
        &webview,
        "plan_install",
        json!({
            "projectId": project.id,
            "items": [{ "sourceId": "local", "itemId": "migration-review" }],
            "clients": ["cursor"],
            "includeMcp": false,
            "decisions": {}
        }),
    )
    .unwrap();
    assert_eq!(plan["title"], "Install for Cursor in this project");
    assert!(!proj.path().join(".agents/skills/migration-review").exists());
    call(&webview, "apply_plan", json!({ "planId": plan["id"] })).unwrap();
    assert!(
        proj.path()
            .join(".agents/skills/migration-review/SKILL.md")
            .exists()
    );

    // Untrusted input is refused: paths that leave the package, and folders
    // that did not come from the native picker.
    let traversal = call(
        &webview,
        "write_skill_file",
        json!({ "id": id, "path": "../../escape.md", "text": "x", "baseDigest": null }),
    )
    .unwrap_err();
    assert_eq!(traversal["code"], "invalidInput");
    let bad_id = call(&webview, "get_skill", json!({ "id": "../x" })).unwrap_err();
    assert_eq!(bad_id["code"], "notFound");
    std::fs::write(
        outside.path().join("SKILL.md"),
        "---\nname: outside\ndescription: Not picked. Use never.\n---\n",
    )
    .unwrap();
    let from = json!({ "type": "folder", "path": outside.path().to_string_lossy() });
    let unpicked = call(
        &webview,
        "inspect_import",
        json!({ "from": from, "jobId": null }),
    )
    .unwrap_err();
    assert_eq!(unpicked["code"], "invalidInput");
    let unpicked = call(
        &webview,
        "import_skills",
        json!({ "from": from, "selections": [{ "path": "", "rename": null }], "jobId": null }),
    )
    .unwrap_err();
    assert_eq!(unpicked["code"], "invalidInput");

    // Trash is reversible.
    call(&webview, "trash_skill", json!({ "id": id })).unwrap();
    let listed = call(&webview, "list_skills", json!({})).unwrap();
    assert!(listed[0]["deletedAt"].is_string());
    let restored = call(&webview, "restore_skill", json!({ "id": id })).unwrap();
    assert!(restored["summary"]["deletedAt"].is_null());
}
