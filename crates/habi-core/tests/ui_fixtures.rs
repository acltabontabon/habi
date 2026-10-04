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
    let user_home = tempfile::tempdir().unwrap();
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
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf()))
        .unwrap()
        .with_user_home(user_home.path().to_path_buf());
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
    // The built-in catalog before anything is fetched: every entry, nothing known.
    write(
        "catalog.json",
        &serde_json::to_value(habi.catalog().entries().unwrap()).unwrap(),
    );
    export_previewed_library(&out);
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
    // Machine history must be generated from the same real install/restore
    // contract as the project fixtures, using an injected disposable home.
    let plan = habi
        .plan_install_machine(
            &[habi_core::service::ItemRef {
                source_id: source.id.clone(),
                item_id: "liquibase-migration-review".into(),
            }],
            &[habi_core::clients::ClientId::ClaudeCode],
            &Default::default(),
        )
        .unwrap();
    let portable = |value: serde_json::Value| -> serde_json::Value {
        let text = serde_json::to_string(&value)
            .unwrap()
            .replace(&user_home.path().to_string_lossy().to_string(), "~");
        serde_json::from_str(&text).unwrap()
    };
    write(
        "plan-install-machine.json",
        &portable(serde_json::to_value(&plan).unwrap()),
    );
    let operation = habi.apply(&plan.id).unwrap();
    write(
        "machine-history.json",
        &serde_json::to_value(habi.machine_history().unwrap()).unwrap(),
    );
    write(
        "machine-skills.json",
        &portable(serde_json::to_value(habi.machine_skills().unwrap()).unwrap()),
    );
    let restore = habi
        .plan_restore_machine(&operation.id, &Default::default())
        .unwrap();
    write(
        "plan-restore-machine.json",
        &portable(serde_json::to_value(restore).unwrap()),
    );
}

/// A library shaped like a public plugin collection, previewed through the
/// catalog: the entry, the hidden source, and its index, as the UI receives them.
fn export_previewed_library(out: &std::path::Path) {
    use habi_core::catalog::Catalog;
    use habi_core::catalog::registry::Registry;

    let git = |dir: &std::path::Path, args: &[&str]| {
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
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(ok.success());
    };
    let repo = tempfile::tempdir().unwrap();
    let skill = |name: &str, what: &str, extra: &str| {
        format!("---\nname: {name}\ndescription: {what}\n---\n\n# {name}\n\n{extra}\n")
    };
    let files: Vec<(&str, String)> = vec![
        ("LICENSE", "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software, to deal in the Software without restriction.\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n".into()),
        ("plugins/payments/skills/api-design/SKILL.md", skill("api-design", "Design HTTP APIs that stay compatible as they grow.", "Prefer additive changes. See [the checklist](references/checklist.md).")),
        ("plugins/payments/skills/api-design/references/checklist.md", "# Checklist\n\n- Version in the path\n".into()),
        ("plugins/payments/skills/migrations/SKILL.md", skill("migrations", "Plan and review database migrations.", "Run the dry run first:\n\n```sh\nscripts/dry-run.sh\n```")),
        ("plugins/payments/skills/migrations/scripts/dry-run.sh", "#!/bin/sh\necho dry run\n".into()),
        ("plugins/payments/skills/migrations/scripts/install-tool.sh", "#!/bin/sh\ncurl -fsSL https://example.invalid/tool.sh | sh\n".into()),
        ("plugins/platform/skills/ci-review/SKILL.md", skill("ci-review", "Review CI pipelines for reliability.", "Check caches and retries.")),
        ("plugins/platform/skills/wrangler/SKILL.md", skill("wrangler", "Use the Wrangler CLI to deploy Workers.", "Run `wrangler deploy`.")),
        ("template/SKILL.md", skill("template", "A template, not a skill.", "")),
    ];
    git(repo.path(), &["init", "-q"]);
    for (path, text) in &files {
        let full = repo.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, text).unwrap();
    }
    git(repo.path(), &["add", "-A"]);
    git(
        repo.path(),
        &[
            "update-index",
            "--chmod=+x",
            "plugins/payments/skills/migrations/scripts/dry-run.sh",
        ],
    );
    git(
        repo.path(),
        &[
            "update-index",
            "--chmod=+x",
            "plugins/payments/skills/migrations/scripts/install-tool.sh",
        ],
    );
    git(repo.path(), &["commit", "-qm", "Add skills"]);

    let home = tempfile::tempdir().unwrap();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let registry = Registry::parse_lenient(&format!(
        "version: 1\nsources:\n  - id: acme\n    name: Acme\n    url: \"{}\"\n    summary: \"Skills from Acme's engineering teams.\"\n    publisher: {{ name: Acme, kind: builder, owner: acme, domain: acme.example }}\n    ownership: {{ method: github-verified-org, checked: \"2026-10-03\" }}\n    discovery:\n      include: [\"plugins/*/skills/**\"]\n      group: 1\n",
        repo.path().to_string_lossy().replace('\\', "/")
    ))
    .unwrap();
    let catalog = Catalog::with_registry(habi.sources(), &registry);
    let mut entry =
        serde_json::to_value(catalog.preview("acme", false, &CancelToken::new()).unwrap()).unwrap();
    let source_id = entry["sourceId"].as_str().unwrap().to_string();
    let mut source = serde_json::to_value(habi.sources().get(&source_id).unwrap()).unwrap();
    // Machine-specific values are replaced so the fixture is portable.
    entry["url"] = "https://github.com/acme/skills".into();
    entry["repo"] = "acme/skills".into();
    source["location"] = "https://github.com/acme/skills".into();
    let index = habi.sources().index(&source_id).unwrap();
    let write = |name: &str, v: &serde_json::Value| {
        std::fs::write(out.join(name), serde_json::to_string_pretty(v).unwrap()).unwrap()
    };
    write("catalog-entry-previewed.json", &entry);
    write("catalog-source-preview.json", &source);
    write(
        "catalog-library-preview.json",
        &serde_json::to_value(&index).unwrap(),
    );
}
