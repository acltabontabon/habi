//! The sample workspace is real, local and clearly labeled.

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::service::Habi;
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
}
