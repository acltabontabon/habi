//! What GitHub says about a catalog repository: stars, forks, when it was
//! last pushed to, whether it is archived. Context for deciding whether to
//! connect a library, nothing more: it never ranks, filters or recommends.
//!
//! This is the one place Habi asks a web service anything, and it is narrow:
//! a single anonymous request to GitHub's public API, only when a person opens
//! the page of a library they have not connected, for a repository the
//! built-in catalog names (never an address a person typed). No account and no
//! token are sent. The answer is kept for a day, so the page works offline
//! afterwards, and a failure just means the figures are not shown.
//!
//! The request goes through the system `curl` (arguments as an array, bounded
//! output and time), so Habi carries no HTTP client of its own.

use crate::cancel::CancelToken;
use crate::process::{self, Spec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use ts_rs::TS;

/// How long an answer is trusted before GitHub is asked again.
pub const TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoFacts {
    pub stars: u32,
    pub forks: u32,
    /// The last push to any branch (an RFC 3339 time).
    pub pushed_at: Option<String>,
    /// The year the repository was created.
    pub created_year: Option<u32>,
    /// GitHub marks it archived: its owner no longer maintains it.
    pub archived: bool,
    /// When Habi asked GitHub (an RFC 3339 time).
    pub fetched_at: String,
}

/// Reads GitHub's `/repos/{owner}/{repo}` answer.
pub fn parse_repo(json: &str, fetched_at: &str) -> Option<RepoFacts> {
    let v: Value = serde_json::from_str(json).ok()?;
    let count = |key: &str| {
        v.get(key)
            .and_then(Value::as_u64)
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
    };
    Some(RepoFacts {
        stars: count("stargazers_count")?,
        forks: count("forks_count").unwrap_or(0),
        pushed_at: v
            .get("pushed_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_year: v
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(|t| t.get(..4))
            .and_then(|y| y.parse().ok()),
        archived: v.get("archived").and_then(Value::as_bool).unwrap_or(false),
        fetched_at: fetched_at.to_string(),
    })
}

/// Asks GitHub about `owner/repo`. `None` on any failure (offline, rate
/// limited, not found, no `curl`): the caller shows nothing rather than an error.
pub fn fetch_repo(owner: &str, repo: &str, cancel: &CancelToken) -> Option<String> {
    // Owner and repo come from the catalog, which only holds plain names;
    // anything else is refused rather than put into an address.
    let plain = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !plain(owner) || !plain(repo) {
        return None;
    }
    let curl = which::which("curl").ok()?;
    let mut spec = Spec::new(
        curl,
        vec![
            "--silent".into(),
            "--fail".into(),
            "--location".into(),
            "--max-time".into(),
            "10".into(),
            "--proto".into(),
            "=https".into(),
            "--header".into(),
            "Accept: application/vnd.github+json".into(),
            "--header".into(),
            "User-Agent: habi".into(),
            format!("https://api.github.com/repos/{owner}/{repo}"),
        ],
    );
    spec.timeout = Duration::from_secs(15);
    spec.stdout_limit = 512 * 1024;
    let out = process::run(spec, cancel).ok()?;
    if !out.success() || out.stdout_truncated {
        return None;
    }
    Some(out.stdout_text())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"name":"skills","stargazers_count":12345,"forks_count":678,"pushed_at":"2026-09-29T10:00:00Z","created_at":"2025-03-01T00:00:00Z","archived":false}"#;

    #[test]
    fn reads_what_github_says() {
        let facts = parse_repo(SAMPLE, "2026-10-03T00:00:00Z").unwrap();
        assert_eq!(facts.stars, 12_345);
        assert_eq!(facts.forks, 678);
        assert_eq!(facts.created_year, Some(2025));
        assert_eq!(facts.pushed_at.as_deref(), Some("2026-09-29T10:00:00Z"));
        assert!(!facts.archived);
    }

    #[test]
    fn an_archived_repository_says_so() {
        let json = SAMPLE.replace("\"archived\":false", "\"archived\":true");
        assert!(parse_repo(&json, "t").unwrap().archived);
    }

    #[test]
    fn an_error_or_odd_answer_is_nothing() {
        assert!(parse_repo(r#"{"message":"Not Found"}"#, "t").is_none());
        assert!(parse_repo("not json", "t").is_none());
        assert!(parse_repo("", "t").is_none());
    }

    #[test]
    fn only_plain_names_are_put_into_an_address() {
        let cancel = CancelToken::new();
        for bad in ["", "a/b", "a b", "../x", "a?b=c", "a\nb"] {
            assert!(fetch_repo(bad, "repo", &cancel).is_none(), "{bad}");
            assert!(fetch_repo("owner", bad, &cancel).is_none(), "{bad}");
        }
    }
}
