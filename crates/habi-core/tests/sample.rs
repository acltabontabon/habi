//! The sample workspace earlier versions could create is removed on startup,
//! and nothing of the user's goes with it.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;

fn library(habi: &Habi, name: &str, location: &std::path::Path) -> String {
    let source = habi
        .sources()
        .add(&NewSource {
            name: name.into(),
            location: location.to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    source.id
}

#[test]
fn a_leftover_sample_workspace_is_removed_and_the_users_data_kept() {
    let home = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    copy_tree(&fixture("libraries/example-team-library"), lib.path());
    copy_tree(&fixture("repos/billing-service"), proj.path());
    let paths = AppPaths::at(home.path().to_path_buf());
    let (own_library, own_project) = {
        let habi = Habi::open(paths.clone()).unwrap();
        // The user's own library, named like the sample's, and project.
        let own_library = library(&habi, "Sample team library", lib.path());
        let own_project = habi.open_project(proj.path()).unwrap().id;

        // What the sample workspace left under `<data>/sample`: a flagged
        // library, one from before the flag, and a sample project.
        let sample = home.path().join("sample");
        copy_tree(
            &fixture("libraries/example-team-library"),
            &sample.join("team-library"),
        );
        copy_tree(
            &fixture("libraries/security-guild-library"),
            &sample.join("security-library"),
        );
        copy_tree(
            &fixture("repos/orders-api"),
            &sample.join("projects/orders-api"),
        );
        let flagged = library(
            &habi,
            "Sample team library (sample)",
            &sample.join("team-library"),
        );
        habi.store
            .conn()
            .unwrap()
            .execute("UPDATE sources SET sample = 1 WHERE id = ?1", [&flagged])
            .unwrap();
        library(
            &habi,
            "Sample security library",
            &sample.join("security-library"),
        );
        habi.open_project(&sample.join("projects/orders-api"))
            .unwrap();
        assert_eq!(habi.sources().list().unwrap().len(), 3);
        assert_eq!(habi.recent_projects().unwrap().len(), 2);
        (own_library, own_project)
    };

    let habi = Habi::open(paths.clone()).unwrap();
    let sources = habi.sources().list().unwrap();
    assert_eq!(sources.len(), 1, "a shared name is not a sample");
    assert_eq!(sources[0].id, own_library);
    let projects = habi.recent_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, own_project);
    assert!(!home.path().join("sample").exists());
    assert!(
        lib.path().read_dir().unwrap().next().is_some(),
        "the user's library folder is untouched"
    );

    // Opening again is a no-op.
    let again = Habi::open(paths).unwrap();
    assert_eq!(again.sources().list().unwrap().len(), 1);
    assert_eq!(again.recent_projects().unwrap().len(), 1);
}
