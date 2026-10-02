//! Opening and reading review requests through stand-in `gh`/`glab`
//! programs: the arguments Habi passes, which tool it picks for a host, and
//! what it refuses to trust from their output.
#![cfg(unix)]

use habi_core::cancel::CancelToken;
use habi_core::review::{
    CommentKind, RemoteRepo, ReviewHost, ReviewState, ReviewTools, fetch_status, open_request,
};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Writes an executable stand-in that logs its arguments to `<name>.log`.
fn stand_in(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    let log = dir.join(format!("{name}.log"));
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\n{body}\n",
            log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn log(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(format!("{name}.log"))).unwrap_or_default()
}

fn gitlab_repo() -> RemoteRepo {
    RemoteRepo {
        host: "gitlab.example.com".into(),
        path: "group/sub/skills".into(),
    }
}

const GLAB: &str = r#"
case "$1 $2" in
  "mr create") echo "https://gitlab.example.com/group/sub/skills/-/merge_requests/3"; exit 0 ;;
  "auth status") exit 0 ;;
esac
case "$4" in
  projects/group%2Fsub%2Fskills/merge_requests\?*)
    echo '[{"iid":3,"state":"opened","draft":false,"sha":"def","created_at":"2026-10-01T00:00:00Z","web_url":"https://gitlab.example.com/group/sub/skills/-/merge_requests/3"}]' ;;
  */merge_requests/3/approvals) echo '{"approved_by":[]}' ;;
  */merge_requests/3/discussions*)
    echo '[{"notes":[{"system":false,"body":"Please split this","author":{"username":"cy"},"created_at":"2","position":{"new_path":"skills/x/SKILL.md","new_line":5}}]}]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac"#;

#[test]
fn gitlab_requests_use_the_full_project_url_and_rest_endpoints() {
    let dir = tempfile::tempdir().unwrap();
    let tools = ReviewTools {
        gh: None,
        glab: Some(stand_in(dir.path(), "glab", GLAB)),
        cwd: None,
    };
    let cancel = CancelToken::new();
    let url = open_request(
        &tools,
        &gitlab_repo(),
        "habi/contrib/x-1a2b3c",
        "main",
        "Share x",
        "Why",
        &cancel,
    )
    .unwrap();
    assert_eq!(
        url,
        "https://gitlab.example.com/group/sub/skills/-/merge_requests/3"
    );
    let calls = log(dir.path(), "glab");
    assert!(
        calls.contains(
            "mr create --repo https://gitlab.example.com/group/sub/skills --source-branch habi/contrib/x-1a2b3c --target-branch main"
        ),
        "a nested group path is passed as a full URL: {calls}"
    );

    let status = fetch_status(&tools, &gitlab_repo(), "habi/contrib/x-1a2b3c", &cancel)
        .unwrap()
        .unwrap();
    assert_eq!(status.host, ReviewHost::GitLab);
    assert_eq!(status.state, ReviewState::Open);
    assert_eq!(status.number, 3);
    assert_eq!(status.comments.len(), 1);
    assert_eq!(status.comments[0].kind, CommentKind::Inline);
    assert_eq!(status.comments[0].line, Some(5));
    let calls = log(dir.path(), "glab");
    assert!(
        calls.contains(
            "api --hostname gitlab.example.com projects/group%2Fsub%2Fskills/merge_requests?state=all&per_page=10&source_branch=habi%2Fcontrib%2Fx-1a2b3c"
        ),
        "{calls}"
    );
}

#[test]
fn a_self_hosted_instance_is_recognized_by_the_signed_in_tool() {
    let dir = tempfile::tempdir().unwrap();
    let tools = ReviewTools {
        gh: Some(stand_in(
            dir.path(),
            "gh",
            r#"[ "$1 $2" = "auth status" ] && exit 1; exit 1"#,
        )),
        glab: Some(stand_in(
            dir.path(),
            "glab",
            r#"[ "$1 $2" = "auth status" ] && exit 0; exit 1"#,
        )),
        cwd: None,
    };
    let repo = RemoteRepo {
        host: "git.example.com".into(),
        path: "team/skills".into(),
    };
    assert_eq!(
        tools.resolve(&repo, &CancelToken::new()),
        Ok(ReviewHost::GitLab)
    );
    assert!(log(dir.path(), "gh").contains("auth status --hostname git.example.com"));

    let none = ReviewTools {
        gh: Some(stand_in(dir.path(), "gh2", "exit 1")),
        glab: None,
        cwd: None,
    };
    let err = none.resolve(&repo, &CancelToken::new()).unwrap_err();
    assert!(err.contains("cannot tell whether git.example.com"), "{err}");
}

#[test]
fn missing_tools_and_foreign_urls_are_reported_not_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let github = RemoteRepo {
        host: "github.com".into(),
        path: "acme/skills".into(),
    };
    let err = open_request(
        &ReviewTools::default(),
        &github,
        "b",
        "main",
        "t",
        "",
        &CancelToken::new(),
    )
    .unwrap_err();
    assert!(
        err.contains("`gh`") && err.contains("not installed"),
        "{err}"
    );

    // A tool that prints an address on another host: not shown as the request.
    let tools = ReviewTools {
        gh: Some(stand_in(
            dir.path(),
            "gh",
            "echo https://evil.example/acme/skills/pull/1",
        )),
        glab: None,
        cwd: None,
    };
    let err = open_request(&tools, &github, "b", "main", "t", "", &CancelToken::new()).unwrap_err();
    assert!(err.contains("did not print"), "{err}");

    // A failing tool: its first error line, no request.
    let tools = ReviewTools {
        gh: Some(stand_in(
            dir.path(),
            "gh3",
            "echo 'HTTP 403: Resource not accessible' >&2; exit 1",
        )),
        glab: None,
        cwd: None,
    };
    let err = open_request(&tools, &github, "b", "main", "t", "", &CancelToken::new()).unwrap_err();
    assert!(
        err.contains("HTTP 403") && err.contains("No pull request was opened"),
        "{err}"
    );
}

/// A `gh` whose conversation comments come in pages: `full_pages` pages of
/// 100, then a page of 5 (or full pages forever when `full_pages` is 0).
fn paging_gh(dir: &Path, name: &str, full_pages: u32) -> PathBuf {
    let body = format!(
        r#"
items() {{
  n=$1; i=0; printf '['
  while [ $i -lt $n ]; do
    [ $i -gt 0 ] && printf ','
    printf '{{"user":{{"login":"u%s"}},"body":"c%s","created_at":"2026-10-01T%05d"}}' "$i" "$i" "$i"
    i=$((i+1))
  done
  printf ']\n'
}}
case "$4" in
  repos/acme/skills/pulls\?*)
    echo '[{{"number":7,"state":"open","draft":false,"merged_at":null,"html_url":"https://github.com/acme/skills/pull/7","created_at":"2026-10-01T00:00:00Z","head":{{"sha":"abc"}}}}]' ;;
  */issues/7/comments*)
    page=$(printf '%s' "$4" | sed 's/.*page=//')
    if [ {full_pages} -eq 0 ] || [ "$page" -le {full_pages} ]; then items 100; else items 5; fi ;;
  *) echo '[]' ;;
esac"#
    );
    stand_in(dir, name, &body)
}

fn github_repo() -> RemoteRepo {
    RemoteRepo {
        host: "github.com".into(),
        path: "acme/skills".into(),
    }
}

#[test]
fn comments_are_read_page_by_page_up_to_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let tools = ReviewTools {
        gh: Some(paging_gh(dir.path(), "gh", 1)),
        glab: None,
        cwd: None,
    };
    let status = fetch_status(&tools, &github_repo(), "habi/contrib/x-1", &cancel)
        .unwrap()
        .unwrap();
    assert_eq!(status.comments.len(), 105, "the second page is read");
    assert!(!status.comments_truncated);
    let calls = log(dir.path(), "gh");
    assert!(
        calls.contains("repos/acme/skills/issues/7/comments?per_page=100&page=2"),
        "{calls}"
    );
    assert!(!calls.contains("comments?per_page=100&page=3"), "{calls}");

    // More than Habi shows: it stops reading and says so.
    let tools = ReviewTools {
        gh: Some(paging_gh(dir.path(), "gh-many", 0)),
        glab: None,
        cwd: None,
    };
    let status = fetch_status(&tools, &github_repo(), "habi/contrib/x-1", &cancel)
        .unwrap()
        .unwrap();
    assert_eq!(status.comments.len(), 200);
    assert!(status.comments_truncated);
    let pages = log(dir.path(), "gh-many")
        .lines()
        .filter(|l| l.contains("/issues/7/comments"))
        .count();
    assert_eq!(pages, 3, "reading stops after the limit");
}

#[test]
fn the_tools_run_in_habis_own_folder() {
    let dir = tempfile::tempdir().unwrap();
    let own = dir.path().join("empty");
    let tools = ReviewTools {
        gh: Some(stand_in(
            dir.path(),
            "gh",
            r#"pwd >> "$(dirname "$0")/pwd.log"; echo https://github.com/acme/skills/pull/1"#,
        )),
        glab: None,
        cwd: Some(own.clone()),
    };
    open_request(
        &tools,
        &github_repo(),
        "b",
        "main",
        "t",
        "",
        &CancelToken::new(),
    )
    .unwrap();
    let seen = std::fs::read_to_string(dir.path().join("pwd.log")).unwrap();
    assert_eq!(
        Path::new(seen.trim()).canonicalize().unwrap(),
        own.canonicalize().unwrap()
    );
}
