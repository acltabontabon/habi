//! Verification freshness and agent readiness must not overstate what was checked.
mod common;

use common::{fixture, library_from_dir};
use habi_core::cancel::CancelToken;
use habi_core::checks::{CheckRun, CheckStatus};
use habi_core::clients::ClientId;
use habi_core::inspect::{WalkOptions, inspect};
use habi_core::library::model::{CheckCwd, CheckSpec, LibraryItem, McpRequirement};
use habi_core::recommend::{EvidenceState, ReadinessState, evidence, readiness_for_clients};
use std::fs::{File, FileTimes};
use std::time::{Duration, UNIX_EPOCH};

fn item() -> LibraryItem {
    let mut item = library_from_dir(&fixture("libraries/example-team-library"))
        .items
        .remove(0);
    item.tools.clear();
    item.mcp.clear();
    item.checks.clear();
    item.evidence.clear();
    item.clients = None;
    item
}

#[test]
fn same_size_source_edits_invalidate_cached_inspection_and_checks() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("app.ts");
    std::fs::write(&source, "export const answer = 1;\n").unwrap();
    let set_time = |seconds| {
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
            .unwrap()
    };
    set_time(1_700_000_000);
    let first = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
    let again = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
    assert_eq!(
        first.fingerprint, again.fingerprint,
        "a rescan alone changes nothing"
    );
    assert!(!first.is_stale());
    std::fs::write(&source, "export const answer = 2;\n").unwrap();
    set_time(1_700_000_002);
    assert!(
        first.is_stale(),
        "source content edits invalidate the cache too"
    );
    let changed = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
    assert_ne!(first.fingerprint, changed.fingerprint);
    let mut item = item();
    item.checks = vec![check("verify")];
    let run = run(
        &item,
        "verify",
        ".",
        CheckStatus::Passed,
        &first.fingerprint,
    );
    assert_eq!(
        evidence(&item, &[run], &changed.fingerprint, &[".".into()], true).state,
        EvidenceState::Stale
    );
}

#[test]
fn an_mcp_entry_for_cursor_does_not_establish_readiness_for_codex() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".cursor")).unwrap();
    std::fs::write(
        dir.path().join(".cursor/mcp.json"),
        r#"{"mcpServers":{"review":{"command":"review-server"}}}"#,
    )
    .unwrap();
    let mut item = item();
    item.clients = Some(vec![ClientId::Cursor, ClientId::Codex]);
    item.mcp = vec![McpRequirement {
        name: "review".into(),
        purpose: None,
        server: None,
    }];
    let for_codex = readiness_for_clients(dir.path(), &item, &[".".into()], &[ClientId::Codex]);
    assert_eq!(for_codex.state, ReadinessState::Missing);
    assert_eq!(
        for_codex
            .by_client
            .iter()
            .find(|r| r.client == ClientId::Cursor)
            .unwrap()
            .state,
        ReadinessState::Ready
    );
    assert_eq!(
        for_codex
            .by_client
            .iter()
            .find(|r| r.client == ClientId::Codex)
            .unwrap()
            .state,
        ReadinessState::Missing
    );
    let for_cursor = readiness_for_clients(dir.path(), &item, &[], &[ClientId::Cursor]);
    assert_eq!(for_cursor.state, ReadinessState::Ready);
    let both = readiness_for_clients(dir.path(), &item, &[], &[ClientId::Cursor, ClientId::Codex]);
    assert_eq!(both.state, ReadinessState::Missing);
    let unchosen = readiness_for_clients(dir.path(), &item, &[], &[]);
    assert_eq!(unchosen.state, ReadinessState::Unknown);
}

fn check(id: &str) -> CheckSpec {
    CheckSpec {
        id: id.into(),
        title: id.into(),
        description: None,
        run: vec![],
        cwd: CheckCwd::Module,
        timeout_seconds: 30,
    }
}

fn run(
    item: &LibraryItem,
    check: &str,
    module: &str,
    status: CheckStatus,
    fingerprint: &str,
) -> CheckRun {
    CheckRun {
        id: format!("{check}-{module}"),
        item_key: item.key.clone(),
        item_digest: item.content_digest.clone(),
        check_id: check.into(),
        module: module.into(),
        argv: vec!["verify".into()],
        cwd: module.into(),
        project_fingerprint: fingerprint.into(),
        started_at: "2026-10-04T00:00:00Z".into(),
        finished_at: Some("2026-10-04T00:00:01Z".into()),
        exit_code: Some(0),
        status,
        output_tail: String::new(),
    }
}

#[test]
fn a_later_pass_does_not_hide_other_failed_or_unchecked_pairs() {
    let mut item = item();
    item.checks = vec![check("lint"), check("test")];
    let modules = vec!["web".into(), "api".into()];
    let pass = run(&item, "lint", "web", CheckStatus::Passed, "f");
    let fail = run(&item, "test", "api", CheckStatus::Failed, "f");
    let result = evidence(&item, &[pass.clone(), fail], "f", &modules, true);
    assert_eq!(result.state, EvidenceState::Failed);
    assert_eq!(result.coverage.passed, 1);
    assert_eq!(result.coverage.failed, 1);
    assert_eq!(result.coverage.unchecked, 2);
    let partial = evidence(&item, std::slice::from_ref(&pass), "f", &modules, true);
    assert_eq!(partial.state, EvidenceState::Partial);
    assert_eq!(partial.coverage.unchecked, 3);
    let outdated = run(&item, "test", "web", CheckStatus::Failed, "old");
    assert_eq!(
        evidence(&item, &[pass, outdated], "f", &modules, true).state,
        EvidenceState::Stale
    );
}

#[test]
fn cancellation_preserves_the_previous_completed_result() {
    let mut item = item();
    item.checks = vec![check("test")];
    let cancelled = run(&item, "test", ".", CheckStatus::Cancelled, "f");
    let failed = run(&item, "test", ".", CheckStatus::Failed, "f");
    assert_eq!(
        evidence(&item, &[cancelled, failed], "f", &[".".into()], true).state,
        EvidenceState::Failed
    );
}

#[test]
fn incomplete_inspection_does_not_claim_full_check_coverage() {
    let mut item = item();
    item.checks = vec![check("test")];
    let passed = run(&item, "test", ".", CheckStatus::Passed, "f");
    let result = evidence(&item, &[passed], "f", &[".".into()], false);
    assert_eq!(result.state, EvidenceState::Partial);
    assert_eq!(result.coverage.passed, 1);
    assert!(!result.coverage.inputs_complete);
}
