//! The sample workspace is real, local and clearly labeled.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;

#[test]
fn sample_workspace_is_created_labeled_and_recreatable() {
    let home = tempfile::tempdir().unwrap();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let sample = habi_core::sample::create(&habi, &fixture("")).unwrap();
    assert_eq!(
        sample.sources[0].name,
        habi_core::sample::SAMPLE_SOURCE_NAME
    );
    assert_eq!(sample.sources.len(), 2);
    assert_eq!(sample.projects.len(), 7);
    assert!(
        sample.projects.iter().all(|p| p.sample),
        "sample projects are labeled"
    );
    let overview = habi
        .overview(&sample.projects[0].id, true, &CancelToken::new())
        .unwrap();
    assert!(!overview.recommendations.is_empty());

    // Recreating replaces the previous sample without touching anything else.
    let again = habi_core::sample::create(&habi, &fixture("")).unwrap();
    assert_eq!(habi.sources().list().unwrap().len(), 2);
    assert_ne!(again.sources[0].id, sample.sources[0].id);
    assert!(again.sources.iter().all(|s| s.sample), "flagged as sample");
}

/// A Habi home with the sample workspace, one library of the user's (named
/// like the sample's) and one project of the user's.
struct Workspace {
    _dirs: Vec<tempfile::TempDir>,
    habi: Habi,
    own_library: String,
    own_project: String,
}

fn workspace() -> Workspace {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    copy_tree(&fixture("repos/billing-service"), proj.path());
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let own = habi
        .sources()
        .add(&NewSource {
            name: habi_core::sample::SAMPLE_SOURCE_NAME.into(),
            location: lib.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&own.id, &CancelToken::new())
        .unwrap();
    let project = habi.open_project(proj.path()).unwrap();
    habi_core::sample::create(&habi, &fixture("")).unwrap();
    Workspace {
        _dirs: vec![home, lib, proj],
        habi,
        own_library: own.id,
        own_project: project.id,
    }
}

#[test]
fn sample_libraries_stay_out_of_the_users_projects() {
    let w = workspace();
    let samples: Vec<String> = w
        .habi
        .sources()
        .list()
        .unwrap()
        .into_iter()
        .filter(|s| s.sample)
        .map(|s| s.id)
        .collect();
    assert_eq!(samples.len(), 2);
    assert!(
        !samples.contains(&w.own_library),
        "a shared name is not a flag"
    );

    let own = w
        .habi
        .overview(&w.own_project, true, &CancelToken::new())
        .unwrap();
    assert!(!own.recommendations.is_empty());
    assert!(
        own.recommendations
            .iter()
            .all(|r| !samples.contains(&r.item.source_id)),
        "no sample items in the user's project"
    );
    assert!(own.sources.iter().all(|s| !s.sample));

    let sample_project = w
        .habi
        .recent_projects()
        .unwrap()
        .into_iter()
        .find(|p| p.sample)
        .unwrap();
    let sample = w
        .habi
        .overview(&sample_project.id, true, &CancelToken::new())
        .unwrap();
    assert!(
        sample
            .recommendations
            .iter()
            .any(|r| samples.contains(&r.item.source_id))
    );
}

#[test]
fn removing_the_sample_workspace_keeps_the_users_own_data() {
    let w = workspace();
    habi_core::sample::remove(&w.habi).unwrap();
    let sources = w.habi.sources().list().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].id, w.own_library);
    let projects = w.habi.recent_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, w.own_project);
    assert!(!w.habi.paths.root.join("sample").exists());
    // Removing again is a no-op; creating again works.
    habi_core::sample::remove(&w.habi).unwrap();
    habi_core::sample::create(&w.habi, &fixture("")).unwrap();
}

#[test]
fn sample_libraries_from_before_the_flag_are_recognized() {
    let w = workspace();
    w.habi
        .store
        .conn()
        .unwrap()
        .execute("UPDATE sources SET sample = 0", [])
        .unwrap();
    let reopened = Habi::open(w.habi.paths.clone()).unwrap();
    let flagged: Vec<_> = reopened
        .sources()
        .list()
        .unwrap()
        .into_iter()
        .filter(|s| s.sample)
        .collect();
    assert_eq!(flagged.len(), 2);
    assert!(flagged.iter().all(|s| s.id != w.own_library));
}
