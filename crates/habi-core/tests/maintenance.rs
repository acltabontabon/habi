//! Pruning keeps what history, restore and recovery need, and only that.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::install::apply::{Applier, Fault, JournalState};
use habi_core::install::plan::Decisions;
use habi_core::maintenance::prune_keeping;
use habi_core::service::{Habi, ItemRef};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::Path;
use std::time::{Duration, SystemTime};

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

fn object_exists(habi: &Habi, digest: &str) -> bool {
    let hex = digest.strip_prefix("sha256:").unwrap();
    habi.paths
        .blobs()
        .join("sha256")
        .join(&hex[..2])
        .join(&hex[2..])
        .is_file()
}

#[test]
fn prune_keeps_recent_unfinished_and_referenced_records() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    copy_tree(&fixture("repos/storefront-web"), proj.path());
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    let cancel = CancelToken::new();
    let first = habi.sources().refresh(&source.id, &cancel).unwrap().current;
    let project = habi.open_project(proj.path()).unwrap();
    let none = Decisions::new();
    let item = ItemRef {
        source_id: source.id.clone(),
        item_id: "react-component-review".into(),
    };

    // Five installs and five removals.
    for _ in 0..5 {
        let plan = habi
            .plan_install(
                &project.id,
                std::slice::from_ref(&item),
                &[ClientId::Cursor],
                false,
                &none,
            )
            .unwrap();
        habi.apply(&plan.id).unwrap();
        let overview = habi.overview(&project.id, true, &cancel).unwrap();
        let keys: Vec<String> = overview
            .recommendations
            .iter()
            .filter_map(|r| r.installation.as_ref().map(|i| i.key.clone()))
            .collect();
        let plan = habi.plan_remove(&project.id, &keys, &none).unwrap();
        habi.apply(&plan.id).unwrap();
    }
    // An operation a crash interrupted.
    let plan = habi
        .plan_install(
            &project.id,
            std::slice::from_ref(&item),
            &[ClientId::Cursor],
            false,
            &none,
        )
        .unwrap();
    let applier = Applier {
        paths: &habi.paths,
        store: &habi.store,
    };
    assert!(applier.apply_with(&plan, Fault::CrashBefore(1)).is_err());

    // The library changes three times; a local skill was copied from the
    // first snapshot.
    for n in 0..3 {
        append(
            &lib.path().join("skills/react-component-review/SKILL.md"),
            &format!("\nRevision {n}.\n"),
        );
        habi.sources().refresh(&source.id, &cancel).unwrap();
    }
    habi.store
        .conn()
        .unwrap()
        .execute(
            "INSERT INTO local_skills (id, title, origin_json, created_at, updated_at)
             VALUES ('copy', 'Copy', ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [serde_json::json!({
                "type": "library",
                "sourceName": "Team",
                "sourceIdentity": "local:Team",
                "itemId": "react-component-review",
                "snapshot": first,
            })
            .to_string()],
        )
        .unwrap();

    let orphan = habi
        .sources()
        .blobs()
        .put(b"referred to by nothing")
        .unwrap();
    age_objects(&habi.paths.blobs());
    let report = prune_keeping(&habi.paths, &habi.store, 2).unwrap();
    assert_eq!(report.operations_removed, 8, "{report:?}");
    assert!(report.objects_removed > 0, "{report:?}");
    assert!(report.bytes_freed > 0, "{report:?}");
    assert!(!object_exists(&habi, &orphan));
    // Four snapshots: the current one, the two newest earlier ones, and the
    // first (a local skill is based on it) are all kept.
    assert_eq!(report.snapshots_removed, 0, "{report:?}");
    assert!(habi.sources().index_at(&source.id, &first).is_ok());

    let history = habi.history(&project.id).unwrap();
    let finished: Vec<_> = history
        .iter()
        .filter(|o| o.state == JournalState::Committed)
        .collect();
    assert_eq!(finished.len(), 2);
    let actions: Vec<&str> = finished.iter().map(|o| o.action.as_str()).collect();
    assert_eq!(actions, ["remove", "install"], "the newest are kept");
    assert!(
        history.iter().any(|o| o.state == JournalState::Applying),
        "the interrupted operation is kept"
    );
    // Kept operations still restore, and recovery still has its backups.
    let journal_dir = habi.paths.journal().join(&project.id);
    for entry in std::fs::read_dir(&journal_dir).unwrap().flatten() {
        if entry.path().extension().is_some_and(|e| e == "json") {
            let journal: serde_json::Value =
                serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
            for step in journal["steps"].as_array().unwrap() {
                for side in ["before", "after"] {
                    if let Some(d) = step[side].as_str() {
                        assert!(object_exists(&habi, d), "{d} kept");
                    }
                }
            }
        }
    }
    let recovered = habi.recover(&project.id).unwrap();
    assert_eq!(recovered[0].state, JournalState::RolledBack);
    let restore = habi
        .plan_restore(&project.id, &finished[0].id, &none)
        .unwrap();
    habi.apply(&restore.id).unwrap();

    // Without the local skill's reference, the oldest earlier snapshot goes.
    habi.store
        .conn()
        .unwrap()
        .execute("DELETE FROM local_skills", [])
        .unwrap();
    let report = prune_keeping(&habi.paths, &habi.store, 2).unwrap();
    assert_eq!(report.snapshots_removed, 1, "{report:?}");
    assert!(habi.sources().index_at(&source.id, &first).is_err());
    assert!(habi.sources().index(&source.id).is_ok());

    // Pruning again finds nothing more to remove.
    age_objects(&habi.paths.blobs());
    prune_keeping(&habi.paths, &habi.store, 2).unwrap();
    let again = prune_keeping(&habi.paths, &habi.store, 2).unwrap();
    assert_eq!(again.operations_removed + again.snapshots_removed, 0);
    assert_eq!(again.objects_removed, 0);
}

#[test]
fn recent_objects_are_spared() {
    let home = tempfile::tempdir().unwrap();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let digest = habi.sources().blobs().put(b"not referenced yet").unwrap();
    let report = prune_keeping(&habi.paths, &habi.store, 2).unwrap();
    assert_eq!(report.objects_removed, 0);
    assert!(object_exists(&habi, &digest));
    // Old, unreferenced content goes; storing it again marks it as fresh.
    age_objects(&habi.paths.blobs());
    habi.sources().blobs().put(b"not referenced yet").unwrap();
    assert_eq!(
        prune_keeping(&habi.paths, &habi.store, 2)
            .unwrap()
            .objects_removed,
        0
    );
    age_objects(&habi.paths.blobs());
    assert_eq!(
        prune_keeping(&habi.paths, &habi.store, 2)
            .unwrap()
            .objects_removed,
        1
    );
    assert!(!object_exists(&habi, &digest));
}

fn append(path: &Path, text: &str) {
    let mut s = std::fs::read_to_string(path).unwrap();
    s.push_str(text);
    std::fs::write(path, s).unwrap();
}
