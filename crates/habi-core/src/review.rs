//! Review requests on the library's Git host: opening one (through the
//! author's own fork when they cannot push to the library), and reading back
//! what happened to it.
//!
//! Habi talks to GitHub and GitLab only through the user's own `gh` and
//! `glab` command-line tools, so authentication stays with them and Habi
//! stores no tokens. Their REST endpoints (`gh api`, `glab api`) are used
//! rather than CLI-specific output formats, which change between versions.
//!
//! Everything read back from a host is untrusted: comment bodies, author
//! names and paths are written by other people. They are reduced to plain
//! text here (control and bidirectional-override characters removed, lengths
//! bounded, paths validated) and the UI renders them as plain text only.
//! Status is read only when the user asks; nothing polls in the background.

use crate::cancel::CancelToken;
use crate::paths::RelPath;
use crate::process::{self, Spec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use ts_rs::TS;

/// Most comments kept per request; the UI links to the host for the rest.
const MAX_COMMENTS: usize = 200;
/// Reviews read per pull request (each person's latest decides the state).
const MAX_REVIEWS: usize = 1000;
const PER_PAGE: usize = 100;
/// Pages read from one list endpoint at most.
const MAX_PAGES: usize = 20;
const MAX_BODY_CHARS: usize = 8000;
const MAX_NAME_CHARS: usize = 64;
/// GitLab's Developer role, the lowest that may push a new branch.
const GITLAB_DEVELOPER: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReviewHost {
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "gitlab")]
    GitLab,
}

impl ReviewHost {
    pub fn tool(self) -> &'static str {
        match self {
            ReviewHost::GitHub => "gh",
            ReviewHost::GitLab => "glab",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            ReviewHost::GitHub => "GitHub",
            ReviewHost::GitLab => "GitLab",
        }
    }
    fn request_word(self) -> &'static str {
        match self {
            ReviewHost::GitHub => "pull request",
            ReviewHost::GitLab => "merge request",
        }
    }
}

/// `host` and `owner/repo` (or `group/subgroup/repo`) of a remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRepo {
    /// Host name, with `:port` when an http(s) remote names a non-default
    /// port (an SSH port says nothing about where the web interface is).
    pub host: String,
    pub path: String,
}

impl RemoteRepo {
    /// The host this remote is on, when its name says so. Self-hosted
    /// instances with other names are recognized by asking the tools.
    pub fn known_host(&self) -> Option<ReviewHost> {
        let host = self.host.to_ascii_lowercase();
        if host == "github.com" || host.ends_with(".ghe.com") || host.contains("github") {
            Some(ReviewHost::GitHub)
        } else if host.contains("gitlab") {
            Some(ReviewHost::GitLab)
        } else {
            None
        }
    }

    pub fn https_url(&self) -> String {
        let path = self
            .path
            .split(['?', '#'])
            .next()
            .unwrap_or(&self.path)
            .trim_end_matches('/')
            .trim_end_matches(".git");
        format!("https://{}/{path}", self.host)
    }
}

/// Parses `https://host(:port)/owner/repo(.git)`, `ssh://git@host/owner/repo`
/// and `git@host:owner/repo(.git)`.
pub fn remote_repo(url: &str) -> Option<RemoteRepo> {
    let (web, rest) = if let Some((scheme, r)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        (scheme == "https" || scheme == "http", r.to_string())
    } else if let Some((userhost, path)) = url.split_once(':') {
        (false, format!("{userhost}/{path}"))
    } else {
        return None;
    };
    let (authority, path) = rest.split_once('/')?;
    let authority = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = match authority.split_once(':') {
        // The web interface is on the same port as an http(s) remote.
        Some((name, port))
            if web && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) =>
        {
            if port == "443" || port == "80" {
                name.to_string()
            } else {
                format!("{name}:{port}")
            }
        }
        Some((name, _)) => name.to_string(),
        None => authority.to_string(),
    };
    let path = path
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();
    if host.is_empty() || path.split('/').count() < 2 {
        return None;
    }
    Some(RemoteRepo { host, path })
}

/// Where the `gh` and `glab` programs are, if installed.
#[derive(Debug, Clone, Default)]
pub struct ReviewTools {
    pub gh: Option<PathBuf>,
    pub glab: Option<PathBuf>,
    /// Folder the tools run in. They look for a Git repository in their
    /// working folder, so it must not be whatever repository Habi was started
    /// from; Habi uses an empty folder in its data directory (the system
    /// temporary folder when unset).
    pub cwd: Option<PathBuf>,
}

impl ReviewTools {
    pub fn from_path() -> Self {
        ReviewTools {
            gh: which::which("gh").ok(),
            glab: which::which("glab").ok(),
            cwd: None,
        }
    }

    fn program(&self, host: ReviewHost) -> Option<&PathBuf> {
        match host {
            ReviewHost::GitHub => self.gh.as_ref(),
            ReviewHost::GitLab => self.glab.as_ref(),
        }
    }

    fn run(
        &self,
        host: ReviewHost,
        args: Vec<String>,
        cancel: &CancelToken,
    ) -> std::result::Result<String, String> {
        let tool = host.tool();
        let program = self
            .program(host)
            .ok_or_else(|| format!("`{tool}` ({} CLI) is not installed.", host.name()))?;
        let mut spec = Spec::new(program, args);
        spec.cwd = Some(
            self.cwd
                .clone()
                .filter(|d| std::fs::create_dir_all(d).is_ok())
                .unwrap_or_else(std::env::temp_dir),
        );
        spec.timeout = Duration::from_secs(120);
        spec.stdout_limit = 8 * 1024 * 1024;
        spec.env = vec![
            ("GH_PROMPT_DISABLED".into(), "1".into()),
            ("GLAB_NO_PROMPT".into(), "1".into()),
            ("NO_COLOR".into(), "1".into()),
            ("NO_PROMPT".into(), "1".into()),
        ];
        match process::run(spec, cancel) {
            Ok(out) if out.success() => {
                if out.stdout_truncated {
                    return Err(format!("`{tool}` returned more output than Habi reads."));
                }
                Ok(out.stdout_text())
            }
            Ok(out) => Err(format!(
                "`{tool}` failed: {}",
                crate::redact::redact(
                    out.stderr_text()
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("unknown error")
                )
            )),
            Err(e) => Err(format!("`{tool}` could not run: {e}")),
        }
    }

    /// Which host this remote is on, and that its tool is installed and
    /// signed in for it. Errors are sentences for the user.
    pub fn resolve(
        &self,
        repo: &RemoteRepo,
        cancel: &CancelToken,
    ) -> std::result::Result<ReviewHost, String> {
        if let Some(host) = repo.known_host() {
            if self.program(host).is_none() {
                return Err(format!(
                    "The {} CLI (`{}`) is not installed, so Habi cannot reach {} {}s.",
                    host.name(),
                    host.tool(),
                    host.name(),
                    host.request_word()
                ));
            }
            return Ok(host);
        }
        // A self-hosted instance: whichever tool is signed in to it.
        for host in [ReviewHost::GitHub, ReviewHost::GitLab] {
            if self.program(host).is_some()
                && self
                    .run(
                        host,
                        vec![
                            "auth".into(),
                            "status".into(),
                            "--hostname".into(),
                            repo.host.clone(),
                        ],
                        cancel,
                    )
                    .is_ok()
            {
                return Ok(host);
            }
        }
        Err(format!(
            "Habi cannot tell whether {} is GitHub or GitLab: neither `gh` nor `glab` is signed in to it.",
            repo.host
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReviewState {
    Draft,
    Open,
    ChangesRequested,
    Approved,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CommentKind {
    /// A review submission (approve, request changes, comment).
    Review,
    /// Attached to a file and line.
    Inline,
    /// On the request as a whole.
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReviewVerdict {
    Approved,
    ChangesRequested,
}

/// One comment, reduced to plain text. Written by someone else: shown, never
/// followed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewComment {
    pub kind: CommentKind,
    pub author: String,
    pub body: String,
    /// Repository path the comment is attached to, when inline.
    pub path: Option<String>,
    pub line: Option<u32>,
    /// The line it was written on no longer exists in the latest revision.
    pub outdated: bool,
    pub verdict: Option<ReviewVerdict>,
    pub created_at: String,
}

/// Who can see the library repository, as the host reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RepoVisibility {
    Public,
    Internal,
    Private,
}

/// What the host reported, and when Habi asked.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewStatus {
    pub host: ReviewHost,
    /// Only kept when it points at the library's own host.
    pub url: Option<String>,
    pub number: u64,
    pub state: ReviewState,
    /// The commit the host sees at the head of the branch.
    pub head_commit: Option<String>,
    /// People whose latest review approves the change.
    pub approved_by: Vec<String>,
    pub comments: Vec<ReviewComment>,
    /// More comments exist than Habi shows.
    pub comments_truncated: bool,
    /// The branch the request targets, as the host reported it.
    #[serde(default)]
    pub target_branch: Option<String>,
    /// The repository's visibility, when the host's answer includes it
    /// (GitHub does; GitLab's merge request does not).
    #[serde(default)]
    pub visibility: Option<RepoVisibility>,
    pub checked_at: String,
}

/// Plain text from untrusted input: no control characters other than
/// newlines and tabs, no bidirectional overrides, bounded length.
pub fn plain_text(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    for c in input.chars() {
        let bidi = matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}');
        let control = c.is_control() && c != '\n' && c != '\t';
        if bidi || control || c == '\u{FEFF}' {
            continue;
        }
        if count == max_chars {
            out.push('…');
            break;
        }
        out.push(c);
        count += 1;
    }
    out.replace("\r\n", "\n").trim().to_string()
}

fn name_of(v: &Value) -> String {
    let raw = v
        .get("login")
        .or_else(|| v.get("username"))
        .and_then(Value::as_str)
        .unwrap_or("someone");
    let name = plain_text(raw, MAX_NAME_CHARS);
    if name.is_empty() {
        "someone".into()
    } else {
        name
    }
}

fn repo_path(v: Option<&Value>) -> Option<String> {
    let p = v?.as_str()?;
    RelPath::new(p).ok().map(|_| p.to_string())
}

fn https_on_host(url: Option<&str>, host: &str) -> Option<String> {
    let url = url?;
    let rest = url.strip_prefix("https://")?;
    let (h, _) = rest.split_once('/')?;
    let h = h.strip_suffix(":443").unwrap_or(h);
    (h.eq_ignore_ascii_case(host) && !url.chars().any(|c| c.is_control() || c.is_whitespace()))
        .then(|| url.to_string())
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn parse_json(text: &str, what: &str) -> std::result::Result<Value, String> {
    serde_json::from_str(text)
        .map_err(|_| format!("the host's answer about {what} was not readable"))
}

/// Percent-encodes a GitLab project path for `projects/:id`.
fn encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn finish(mut comments: Vec<ReviewComment>) -> (Vec<ReviewComment>, bool) {
    comments.retain(|c| !c.body.is_empty() || c.verdict.is_some());
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let truncated = comments.len() > MAX_COMMENTS;
    comments.truncate(MAX_COMMENTS);
    (comments, truncated)
}

// ----- GitHub -----------------------------------------------------------------

/// Reads a GitHub pull request from REST answers: the pull request itself,
/// its reviews, its conversation comments and its inline comments.
pub fn parse_github(
    host: &str,
    pull: &Value,
    reviews: &Value,
    issue_comments: &Value,
    inline_comments: &Value,
    checked_at: &str,
) -> std::result::Result<ReviewStatus, String> {
    let number = pull
        .get("number")
        .and_then(Value::as_u64)
        .ok_or("the pull request has no number")?;
    let merged = pull.get("merged_at").is_some_and(|v| !v.is_null())
        || pull.get("merged").and_then(Value::as_bool) == Some(true);
    let closed = str_of(pull, "state") == Some("closed");
    let draft = pull.get("draft").and_then(Value::as_bool) == Some(true);

    // The latest review per person decides; comments-only reviews do not
    // change an earlier verdict, as on GitHub itself.
    let mut latest: Vec<(String, ReviewVerdict)> = Vec::new();
    let mut comments = Vec::new();
    for r in reviews.as_array().into_iter().flatten() {
        let author = r
            .get("user")
            .map(name_of)
            .unwrap_or_else(|| "someone".into());
        let verdict = match str_of(r, "state") {
            Some("APPROVED") => Some(ReviewVerdict::Approved),
            Some("CHANGES_REQUESTED") => Some(ReviewVerdict::ChangesRequested),
            Some("DISMISSED") => {
                latest.retain(|(a, _)| a != &author);
                None
            }
            _ => None,
        };
        if let Some(v) = verdict {
            latest.retain(|(a, _)| a != &author);
            latest.push((author.clone(), v));
        }
        comments.push(ReviewComment {
            kind: CommentKind::Review,
            author,
            body: plain_text(str_of(r, "body").unwrap_or(""), MAX_BODY_CHARS),
            path: None,
            line: None,
            outdated: false,
            verdict,
            created_at: str_of(r, "submitted_at").unwrap_or("").to_string(),
        });
    }
    for c in issue_comments.as_array().into_iter().flatten() {
        comments.push(ReviewComment {
            kind: CommentKind::Conversation,
            author: c
                .get("user")
                .map(name_of)
                .unwrap_or_else(|| "someone".into()),
            body: plain_text(str_of(c, "body").unwrap_or(""), MAX_BODY_CHARS),
            path: None,
            line: None,
            outdated: false,
            verdict: None,
            created_at: str_of(c, "created_at").unwrap_or("").to_string(),
        });
    }
    for c in inline_comments.as_array().into_iter().flatten() {
        let line = c.get("line").and_then(Value::as_u64);
        let original = c.get("original_line").and_then(Value::as_u64);
        comments.push(ReviewComment {
            kind: CommentKind::Inline,
            author: c
                .get("user")
                .map(name_of)
                .unwrap_or_else(|| "someone".into()),
            body: plain_text(str_of(c, "body").unwrap_or(""), MAX_BODY_CHARS),
            path: repo_path(c.get("path")),
            line: line.or(original).and_then(|n| u32::try_from(n).ok()),
            outdated: line.is_none(),
            verdict: None,
            created_at: str_of(c, "created_at").unwrap_or("").to_string(),
        });
    }
    let approved_by: Vec<String> = latest
        .iter()
        .filter(|(_, v)| *v == ReviewVerdict::Approved)
        .map(|(a, _)| a.clone())
        .collect();
    let state = if merged {
        ReviewState::Merged
    } else if closed {
        ReviewState::Closed
    } else if latest
        .iter()
        .any(|(_, v)| *v == ReviewVerdict::ChangesRequested)
    {
        ReviewState::ChangesRequested
    } else if !approved_by.is_empty() {
        ReviewState::Approved
    } else if draft {
        ReviewState::Draft
    } else {
        ReviewState::Open
    };
    let (comments, comments_truncated) = finish(comments);
    Ok(ReviewStatus {
        host: ReviewHost::GitHub,
        url: https_on_host(str_of(pull, "html_url"), host),
        number,
        state,
        head_commit: pull
            .get("head")
            .and_then(|h| str_of(h, "sha"))
            .map(str::to_string),
        approved_by,
        comments,
        comments_truncated,
        target_branch: pull
            .get("base")
            .and_then(|b| str_of(b, "ref"))
            .map(|r| plain_text(r, 255)),
        visibility: pull
            .get("base")
            .and_then(|b| b.get("repo"))
            .and_then(|repo| match str_of(repo, "visibility") {
                Some("public") => Some(RepoVisibility::Public),
                Some("internal") => Some(RepoVisibility::Internal),
                Some("private") => Some(RepoVisibility::Private),
                _ => repo.get("private").and_then(Value::as_bool).map(|p| {
                    if p {
                        RepoVisibility::Private
                    } else {
                        RepoVisibility::Public
                    }
                }),
            }),
        checked_at: checked_at.to_string(),
    })
}

// ----- GitLab -----------------------------------------------------------------

/// Reads a GitLab merge request from REST answers: the merge request, its
/// approvals and its discussions.
pub fn parse_gitlab(
    host: &str,
    mr: &Value,
    approvals: &Value,
    discussions: &Value,
    checked_at: &str,
) -> std::result::Result<ReviewStatus, String> {
    let number = mr
        .get("iid")
        .and_then(Value::as_u64)
        .ok_or("the merge request has no number")?;
    let approved_by: Vec<String> = approvals
        .get("approved_by")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| a.get("user").map(name_of))
        .collect();
    let draft = mr.get("draft").and_then(Value::as_bool) == Some(true)
        || mr.get("work_in_progress").and_then(Value::as_bool) == Some(true);
    let state = match str_of(mr, "state") {
        Some("merged") => ReviewState::Merged,
        Some("closed") | Some("locked") => ReviewState::Closed,
        _ if !approved_by.is_empty() => ReviewState::Approved,
        _ if draft => ReviewState::Draft,
        _ => ReviewState::Open,
    };
    let mut comments = Vec::new();
    for d in discussions.as_array().into_iter().flatten() {
        for n in d
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if n.get("system").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let position = n.get("position");
            let path =
                position.and_then(|p| repo_path(p.get("new_path").or_else(|| p.get("old_path"))));
            let new_line = position
                .and_then(|p| p.get("new_line"))
                .and_then(Value::as_u64);
            let old_line = position
                .and_then(|p| p.get("old_line"))
                .and_then(Value::as_u64);
            comments.push(ReviewComment {
                kind: if path.is_some() {
                    CommentKind::Inline
                } else {
                    CommentKind::Conversation
                },
                author: n
                    .get("author")
                    .map(name_of)
                    .unwrap_or_else(|| "someone".into()),
                body: plain_text(str_of(n, "body").unwrap_or(""), MAX_BODY_CHARS),
                line: new_line.or(old_line).and_then(|x| u32::try_from(x).ok()),
                outdated: path.is_some() && new_line.is_none(),
                path,
                verdict: None,
                created_at: str_of(n, "created_at").unwrap_or("").to_string(),
            });
        }
    }
    let (comments, comments_truncated) = finish(comments);
    Ok(ReviewStatus {
        host: ReviewHost::GitLab,
        url: https_on_host(str_of(mr, "web_url"), host),
        number,
        state,
        head_commit: str_of(mr, "sha").map(str::to_string),
        approved_by,
        comments,
        comments_truncated,
        target_branch: str_of(mr, "target_branch").map(|r| plain_text(r, 255)),
        visibility: None,
        checked_at: checked_at.to_string(),
    })
}

// ----- talking to the host ------------------------------------------------------

/// Opens a pull/merge request from `branch` into `base`. Returns its URL.
pub fn open_request(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
    cancel: &CancelToken,
) -> std::result::Result<String, String> {
    let host = tools.resolve(repo, cancel)?;
    // Title and message are the author's free text: attached with `=` so
    // one starting with `-` is never read as an option.
    let args: Vec<String> = match host {
        ReviewHost::GitHub => vec![
            "pr".into(),
            "create".into(),
            "--repo".into(),
            format!("{}/{}", repo.host, repo.path),
            "--head".into(),
            branch.into(),
            "--base".into(),
            base.into(),
            format!("--title={title}"),
            format!("--body={body}"),
        ],
        // `--repo host/group/repo` would be read as a group path; a full
        // URL is unambiguous for nested groups and self-hosted instances.
        ReviewHost::GitLab => vec![
            "mr".into(),
            "create".into(),
            "--repo".into(),
            repo.https_url(),
            "--source-branch".into(),
            branch.into(),
            "--target-branch".into(),
            base.into(),
            format!("--title={title}"),
            format!("--description={body}"),
            "--yes".into(),
        ],
    };
    let out = tools
        .run(host, args, cancel)
        .map_err(|e| format!("{e} No {} was opened.", host.request_word()))?;
    out.lines()
        .rev()
        .map(str::trim)
        .find_map(|l| https_on_host(Some(l), &repo.host))
        .ok_or_else(|| {
            format!(
                "`{}` succeeded but did not print the request's address.",
                host.tool()
            )
        })
}

/// What the signed-in person may do with a repository, as its host said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoAccess {
    pub host: ReviewHost,
    /// The account the host's tool is signed in as.
    pub account: String,
    pub can_push: bool,
    /// False only when the host says forks are turned off.
    pub can_fork: bool,
    pub archived: bool,
}

/// Asks the host what the signed-in person may do with `repo`. Reads only.
pub fn read_access(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    cancel: &CancelToken,
) -> std::result::Result<RepoAccess, String> {
    let host = tools.resolve(repo, cancel)?;
    let user = api_get(tools, host, repo, "user", cancel)?;
    let account = name_of(&user);
    let endpoint = match host {
        ReviewHost::GitHub => format!("repos/{}", repo.path),
        ReviewHost::GitLab => format!("projects/{}", encode_path(&repo.path)),
    };
    let project = api_get(tools, host, repo, &endpoint, cancel)?;
    let archived = project.get("archived").and_then(Value::as_bool) == Some(true);
    let (can_push, can_fork) = match host {
        ReviewHost::GitHub => (
            project
                .get("permissions")
                .and_then(|p| p.get("push"))
                .and_then(Value::as_bool)
                == Some(true),
            project.get("allow_forking").and_then(Value::as_bool) != Some(false),
        ),
        ReviewHost::GitLab => {
            let level = |key: &str| {
                project
                    .get("permissions")
                    .and_then(|p| p.get(key))
                    .and_then(|a| a.get("access_level"))
                    .and_then(Value::as_u64)
            };
            (
                level("project_access").max(level("group_access")) >= Some(GITLAB_DEVELOPER),
                str_of(&project, "forking_access_level") != Some("disabled"),
            )
        }
    };
    Ok(RepoAccess {
        host,
        account,
        can_push,
        can_fork,
        archived,
    })
}

/// One GET through the host's tool, as JSON.
fn api_get(
    tools: &ReviewTools,
    host: ReviewHost,
    repo: &RemoteRepo,
    endpoint: &str,
    cancel: &CancelToken,
) -> std::result::Result<Value, String> {
    let out = tools.run(
        host,
        vec![
            "api".into(),
            "--hostname".into(),
            repo.host.clone(),
            endpoint.into(),
        ],
        cancel,
    )?;
    parse_json(&out, endpoint)
}

/// One POST through the host's tool, as JSON. Field values are attached with
/// `=` and sent as plain strings, so free text is never read as an option or
/// as a file to upload.
fn api_post(
    tools: &ReviewTools,
    host: ReviewHost,
    repo: &RemoteRepo,
    endpoint: &str,
    fields: &[(&str, &str)],
    cancel: &CancelToken,
) -> std::result::Result<Value, String> {
    let mut args: Vec<String> = vec![
        "api".into(),
        "--hostname".into(),
        repo.host.clone(),
        endpoint.into(),
        "--method".into(),
        "POST".into(),
    ];
    args.extend(
        fields
            .iter()
            .map(|(key, value)| format!("--raw-field={key}={value}")),
    );
    let out = tools.run(host, args, cancel)?;
    parse_json(&out, endpoint)
}

/// The author's own copy of a library, which their branch is pushed to when
/// they cannot push to the library itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Fork {
    /// `owner/repo` (or `group/subgroup/repo`) on the library's host.
    pub path: String,
    /// Where to open it on the host.
    pub url: String,
    /// The address a push last reached it at.
    pub push_url: Option<String>,
    /// GitLab's id for it; merge requests from a fork are created through it.
    pub project_id: Option<u64>,
}

impl Fork {
    fn on(repo: &RemoteRepo, path: String, project_id: Option<u64>) -> Fork {
        let url = RemoteRepo {
            host: repo.host.clone(),
            path: path.clone(),
        }
        .https_url();
        Fork {
            path,
            url,
            push_url: None,
            project_id,
        }
    }

    /// The account or group the fork is under.
    pub fn owner(&self) -> &str {
        self.path.split('/').next().unwrap_or(&self.path)
    }
}

/// A repository path from a host's answer, only if it is safe to build a Git
/// address from.
fn fork_path(raw: Option<&str>) -> Option<String> {
    let path = raw?;
    let segment_ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with(['-', '.'])
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (path.split('/').count() >= 2 && path.split('/').all(segment_ok)).then(|| path.to_string())
}

/// The signed-in person's fork of `repo`, created if they have none. Safe to
/// repeat: GitHub answers with the fork that already exists, and on GitLab
/// Habi looks for one first. A new fork takes a moment to accept pushes.
pub fn ensure_fork(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    cancel: &CancelToken,
) -> std::result::Result<Fork, String> {
    let host = tools.resolve(repo, cancel)?;
    let unreadable = || format!("{} did not say where the fork is.", host.name());
    match host {
        ReviewHost::GitHub => {
            let endpoint = format!("repos/{}/forks", repo.path);
            let made = api_post(tools, host, repo, &endpoint, &[], cancel)?;
            if made.get("fork").and_then(Value::as_bool) != Some(true) {
                return Err(unreadable());
            }
            let path = fork_path(str_of(&made, "full_name")).ok_or_else(unreadable)?;
            Ok(Fork::on(repo, path, None))
        }
        ReviewHost::GitLab => {
            let project = encode_path(&repo.path);
            let mine = api_get(
                tools,
                host,
                repo,
                &format!("projects/{project}/forks?owned=true&per_page={PER_PAGE}"),
                cancel,
            )?;
            let existing = mine.as_array().and_then(|list| {
                list.iter()
                    .find(|p| p.get("archived").and_then(Value::as_bool) != Some(true))
                    .cloned()
            });
            let made = match existing {
                Some(found) => found,
                None => api_post(
                    tools,
                    host,
                    repo,
                    &format!("projects/{project}/fork"),
                    &[],
                    cancel,
                )?,
            };
            let path = fork_path(str_of(&made, "path_with_namespace")).ok_or_else(unreadable)?;
            Ok(Fork::on(repo, path, made.get("id").and_then(Value::as_u64)))
        }
    }
}

/// The addresses to try pushing to a fork at, best first: the protocol the
/// host's tool was set up with, then the one the library was connected with.
/// Built from the validated path, never taken from a host's answer.
pub fn fork_push_urls(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    fork: &Fork,
    library_url: &str,
    cancel: &CancelToken,
) -> Vec<String> {
    let https = format!("{}.git", fork.url);
    // An SSH port is not known from a web address.
    let ssh = (!repo.host.contains(':')).then(|| format!("git@{}:{}.git", repo.host, fork.path));
    let configured = tools.resolve(repo, cancel).ok().and_then(|host| {
        tools
            .run(
                host,
                vec![
                    "config".into(),
                    "get".into(),
                    "git_protocol".into(),
                    "--host".into(),
                    repo.host.clone(),
                ],
                cancel,
            )
            .ok()
    });
    let prefer_ssh = match configured.as_deref().map(str::trim) {
        Some("ssh") => true,
        Some("https") => false,
        _ => !library_url.to_ascii_lowercase().starts_with("http"),
    };
    match (ssh, prefer_ssh) {
        (Some(ssh), true) => vec![ssh, https],
        (Some(ssh), false) => vec![https, ssh],
        (None, _) => vec![https],
    }
}

/// Opens a pull/merge request from `branch` on `fork` into `base` on `repo`.
/// Returns its URL.
#[allow(clippy::too_many_arguments)]
pub fn open_request_from_fork(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    fork: &Fork,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
    cancel: &CancelToken,
) -> std::result::Result<String, String> {
    let host = tools.resolve(repo, cancel)?;
    let not_opened = |e: String| format!("{e} No {} was opened.", host.request_word());
    let printed = match host {
        ReviewHost::GitHub => tools
            .run(
                host,
                vec![
                    "pr".into(),
                    "create".into(),
                    "--repo".into(),
                    format!("{}/{}", repo.host, repo.path),
                    "--head".into(),
                    format!("{}:{branch}", fork.owner()),
                    "--base".into(),
                    base.into(),
                    format!("--title={title}"),
                    format!("--body={body}"),
                ],
                cancel,
            )
            .map_err(not_opened)?,
        // Created through the REST endpoint: `glab mr create` works from a
        // checkout of the fork, and Habi never has one.
        ReviewHost::GitLab => {
            let target = api_get(
                tools,
                host,
                repo,
                &format!("projects/{}", encode_path(&repo.path)),
                cancel,
            )
            .map_err(not_opened)?;
            let target_id = target
                .get("id")
                .and_then(Value::as_u64)
                .map(|id| id.to_string())
                .ok_or_else(|| not_opened("GitLab did not say which project this is.".into()))?;
            let source = fork
                .project_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| encode_path(&fork.path));
            let made = api_post(
                tools,
                host,
                repo,
                &format!("projects/{source}/merge_requests"),
                &[
                    ("source_branch", branch),
                    ("target_branch", base),
                    ("target_project_id", &target_id),
                    ("title", title),
                    ("description", body),
                ],
                cancel,
            )
            .map_err(not_opened)?;
            str_of(&made, "web_url").unwrap_or_default().to_string()
        }
    };
    printed
        .lines()
        .rev()
        .map(str::trim)
        .find_map(|l| https_on_host(Some(l), &repo.host))
        .ok_or_else(|| {
            format!(
                "`{}` succeeded but did not print the request's address.",
                host.tool()
            )
        })
}

/// Reads the request for `branch` (the newest one, open or not).
pub fn fetch_status(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    branch: &str,
    cancel: &CancelToken,
) -> std::result::Result<Option<ReviewStatus>, String> {
    fetch_status_from(tools, repo, None, branch, cancel)
}

/// Like `fetch_status`, for a branch that lives on the author's fork.
pub fn fetch_status_from(
    tools: &ReviewTools,
    repo: &RemoteRepo,
    fork: Option<&Fork>,
    branch: &str,
    cancel: &CancelToken,
) -> std::result::Result<Option<ReviewStatus>, String> {
    let host = tools.resolve(repo, cancel)?;
    let now = crate::time::now();
    let api = |endpoint: String| -> std::result::Result<Value, String> {
        let out = tools.run(
            host,
            vec![
                "api".into(),
                "--hostname".into(),
                repo.host.clone(),
                endpoint.clone(),
            ],
            cancel,
        )?;
        parse_json(&out, &endpoint)
    };
    // A list endpoint, page by page, until a short page or the cap. Returns
    // the items and whether more exist than were read.
    let pages = |endpoint: String, cap: usize| -> std::result::Result<(Value, bool), String> {
        let mut items: Vec<Value> = Vec::new();
        for page in 1..=MAX_PAGES {
            let batch = api(format!("{endpoint}?per_page={PER_PAGE}&page={page}"))?;
            let batch = batch.as_array().cloned().unwrap_or_default();
            let full = batch.len() >= PER_PAGE;
            items.extend(batch);
            if !full {
                return Ok((Value::Array(items), false));
            }
            if items.len() > cap {
                break;
            }
        }
        Ok((Value::Array(items), true))
    };
    match host {
        ReviewHost::GitHub => {
            let owner = fork
                .map(Fork::owner)
                .unwrap_or_else(|| repo.path.split('/').next().unwrap_or_default());
            let pulls = api(format!(
                "repos/{}/pulls?state=all&per_page=10&head={}:{}",
                repo.path,
                owner,
                encode_path(branch)
            ))?;
            let Some(pull) = newest(&pulls, "created_at") else {
                return Ok(None);
            };
            let n = pull.get("number").and_then(Value::as_u64).unwrap_or(0);
            // Every review is read (the latest per person decides the
            // state); comments up to the number Habi shows.
            let (reviews, more_reviews) = pages(
                format!("repos/{}/pulls/{n}/reviews", repo.path),
                MAX_REVIEWS,
            )?;
            let (issue, more_issue) = pages(
                format!("repos/{}/issues/{n}/comments", repo.path),
                MAX_COMMENTS,
            )?;
            let (inline, more_inline) = pages(
                format!("repos/{}/pulls/{n}/comments", repo.path),
                MAX_COMMENTS,
            )?;
            let mut status = parse_github(&repo.host, &pull, &reviews, &issue, &inline, &now)?;
            status.comments_truncated |= more_reviews || more_issue || more_inline;
            Ok(Some(status))
        }
        ReviewHost::GitLab => {
            let project = encode_path(&repo.path);
            let mrs = api(format!(
                "projects/{project}/merge_requests?state=all&per_page=10&source_branch={}",
                encode_path(branch)
            ))?;
            // The same branch name in someone else's fork is another request.
            let mrs = match fork.and_then(|f| f.project_id) {
                Some(id) => Value::Array(
                    mrs.as_array()
                        .into_iter()
                        .flatten()
                        .filter(|m| m.get("source_project_id").and_then(Value::as_u64) == Some(id))
                        .cloned()
                        .collect(),
                ),
                None => mrs,
            };
            let Some(mr) = newest(&mrs, "created_at") else {
                return Ok(None);
            };
            let n = mr.get("iid").and_then(Value::as_u64).unwrap_or(0);
            let approvals = api(format!("projects/{project}/merge_requests/{n}/approvals"))?;
            let (discussions, more) = pages(
                format!("projects/{project}/merge_requests/{n}/discussions"),
                MAX_COMMENTS,
            )?;
            let mut status = parse_gitlab(&repo.host, &mr, &approvals, &discussions, &now)?;
            status.comments_truncated |= more;
            Ok(Some(status))
        }
    }
}

fn newest(list: &Value, key: &str) -> Option<Value> {
    list.as_array()?
        .iter()
        .max_by(|a, b| str_of(a, key).cmp(&str_of(b, key)))
        .cloned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn repository_link_drops_credentials_and_query_parameters() {
        let repo = super::remote_repo(
            "https://user:password@github.com/acme/skills.git?token=secret#readme",
        )
        .unwrap();
        assert_eq!(repo.https_url(), "https://github.com/acme/skills");
    }
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_remote_urls() {
        assert_eq!(
            remote_repo("https://github.com/acme/skills.git"),
            Some(RemoteRepo {
                host: "github.com".into(),
                path: "acme/skills".into()
            })
        );
        assert_eq!(
            remote_repo("git@gitlab.example.com:group/sub/skills.git"),
            Some(RemoteRepo {
                host: "gitlab.example.com".into(),
                path: "group/sub/skills".into()
            })
        );
        assert_eq!(remote_repo("/srv/git/skills.git"), None);
    }

    #[test]
    fn keeps_a_web_port_but_not_an_ssh_port() {
        let r = remote_repo("https://gitlab.example.com:8443/group/sub/skills.git").unwrap();
        assert_eq!(r.host, "gitlab.example.com:8443");
        assert_eq!(
            r.https_url(),
            "https://gitlab.example.com:8443/group/sub/skills"
        );
        assert_eq!(
            https_on_host(
                Some("https://gitlab.example.com:8443/group/sub/skills/-/merge_requests/3"),
                &r.host
            )
            .as_deref(),
            Some("https://gitlab.example.com:8443/group/sub/skills/-/merge_requests/3")
        );
        assert_eq!(
            https_on_host(Some("https://gitlab.example.com/x/y"), &r.host),
            None,
            "another port is another site"
        );
        assert_eq!(
            remote_repo("https://user@github.com:443/acme/skills")
                .unwrap()
                .host,
            "github.com"
        );
        assert_eq!(
            remote_repo("ssh://git@gitlab.example.com:2222/group/skills.git")
                .unwrap()
                .host,
            "gitlab.example.com"
        );
    }

    #[test]
    fn recognizes_hosts_by_name_only_when_clear() {
        let r = |h: &str| RemoteRepo {
            host: h.into(),
            path: "a/b".into(),
        };
        assert_eq!(r("github.com").known_host(), Some(ReviewHost::GitHub));
        assert_eq!(r("gitlab.com").known_host(), Some(ReviewHost::GitLab));
        assert_eq!(
            r("gitlab.internal.example").known_host(),
            Some(ReviewHost::GitLab)
        );
        assert_eq!(r("git.example.com").known_host(), None);
    }

    #[test]
    fn untrusted_text_is_reduced_to_plain_text() {
        let evil = "ok\u{202E}gnp.exe\u{0007} done\r\nnext\u{FEFF}";
        assert_eq!(plain_text(evil, 100), "okgnp.exe done\nnext");
        assert_eq!(plain_text("abcdef", 3), "abc…");
        assert_eq!(
            https_on_host(Some("https://github.com/a/b/pull/1"), "github.com").as_deref(),
            Some("https://github.com/a/b/pull/1")
        );
        assert_eq!(
            https_on_host(Some("https://evil.example/a"), "github.com"),
            None
        );
        assert_eq!(
            https_on_host(Some("javascript:alert(1)"), "github.com"),
            None
        );
        assert_eq!(repo_path(Some(&json!("../../etc/passwd"))), None);
        assert_eq!(
            repo_path(Some(&json!("skills/x/SKILL.md"))).as_deref(),
            Some("skills/x/SKILL.md")
        );
    }

    #[test]
    fn github_latest_review_per_person_decides() {
        let pull = json!({
            "number": 7, "state": "open", "draft": false, "merged_at": null,
            "html_url": "https://github.com/acme/skills/pull/7", "head": { "sha": "abc" },
            "base": { "ref": "main", "repo": { "private": true, "visibility": "internal" } }
        });
        let reviews = json!([
            { "user": { "login": "ana" }, "state": "CHANGES_REQUESTED", "body": "Please add an example.", "submitted_at": "2026-10-01T10:00:00Z" },
            { "user": { "login": "bo" }, "state": "APPROVED", "body": "", "submitted_at": "2026-10-01T11:00:00Z" },
            { "user": { "login": "ana" }, "state": "COMMENTED", "body": "Still missing.", "submitted_at": "2026-10-01T12:00:00Z" }
        ]);
        let inline = json!([
            { "user": { "login": "ana" }, "body": "Typo", "path": "skills/x/SKILL.md", "line": 4, "original_line": 4, "created_at": "2026-10-01T10:01:00Z" },
            { "user": { "login": "ana" }, "body": "Old", "path": "skills/x/SKILL.md", "line": null, "original_line": 9, "created_at": "2026-10-01T09:00:00Z" }
        ]);
        let s = parse_github("github.com", &pull, &reviews, &json!([]), &inline, "now").unwrap();
        assert_eq!(
            s.state,
            ReviewState::ChangesRequested,
            "ana's comment does not withdraw her request"
        );
        assert_eq!(s.approved_by, vec!["bo"]);
        assert_eq!(s.head_commit.as_deref(), Some("abc"));
        assert_eq!(s.target_branch.as_deref(), Some("main"));
        assert_eq!(s.visibility, Some(RepoVisibility::Internal));
        assert_eq!(
            s.url.as_deref(),
            Some("https://github.com/acme/skills/pull/7")
        );
        let old = s.comments.iter().find(|c| c.body == "Old").unwrap();
        assert!(old.outdated);
        assert_eq!(old.line, Some(9));
        assert_eq!(s.comments.first().unwrap().body, "Old", "sorted by time");
        assert!(
            !s.comments
                .iter()
                .any(|c| c.body.is_empty() && c.verdict.is_none())
        );

        let approved = json!([{ "user": { "login": "bo" }, "state": "APPROVED", "body": "", "submitted_at": "x" }]);
        let s = parse_github(
            "github.com",
            &pull,
            &approved,
            &json!([]),
            &json!([]),
            "now",
        )
        .unwrap();
        assert_eq!(s.state, ReviewState::Approved);

        let merged = json!({ "number": 7, "state": "closed", "merged_at": "2026-10-02T00:00:00Z" });
        let s = parse_github(
            "github.com",
            &merged,
            &json!([]),
            &json!([]),
            &json!([]),
            "now",
        )
        .unwrap();
        assert_eq!(s.state, ReviewState::Merged);
    }

    #[test]
    fn gitlab_states_approvals_and_notes() {
        let mr = json!({ "iid": 3, "state": "opened", "draft": false, "sha": "def",
                         "web_url": "https://gitlab.example.com/g/sub/skills/-/merge_requests/3" });
        let approvals = json!({ "approved_by": [{ "user": { "username": "cy" } }] });
        let discussions = json!([
            { "notes": [{ "system": true, "body": "added 1 commit", "author": { "username": "x" }, "created_at": "1" }] },
            { "notes": [{ "system": false, "body": "Line note", "author": { "username": "cy" }, "created_at": "2",
                          "position": { "new_path": "skills/x/habi.yaml", "new_line": 3 } }] },
            { "notes": [{ "system": false, "body": "General", "author": { "username": "dee" }, "created_at": "3" }] }
        ]);
        let s = parse_gitlab("gitlab.example.com", &mr, &approvals, &discussions, "now").unwrap();
        assert_eq!(s.state, ReviewState::Approved);
        assert_eq!(s.approved_by, vec!["cy"]);
        assert_eq!(s.comments.len(), 2, "system notes are skipped");
        assert_eq!(s.comments[0].kind, CommentKind::Inline);
        assert_eq!(s.comments[0].path.as_deref(), Some("skills/x/habi.yaml"));
        assert_eq!(s.comments[1].kind, CommentKind::Conversation);

        let merged = json!({ "iid": 3, "state": "merged" });
        let s = parse_gitlab("gitlab.example.com", &merged, &json!({}), &json!([]), "now").unwrap();
        assert_eq!(s.state, ReviewState::Merged);
    }

    #[test]
    fn a_fork_path_must_be_safe_to_build_an_address_from() {
        assert_eq!(fork_path(Some("me/skills")).as_deref(), Some("me/skills"));
        assert_eq!(
            fork_path(Some("group/sub/skills-1")).as_deref(),
            Some("group/sub/skills-1")
        );
        for bad in [
            "skills",
            "me/../../etc",
            "-u/x",
            "me/x y",
            "me/x\ny",
            "me//x",
            "ext::sh/x",
        ] {
            assert_eq!(fork_path(Some(bad)), None, "{bad}");
        }
        assert_eq!(fork_path(None), None);
    }

    #[test]
    fn encodes_gitlab_project_paths() {
        assert_eq!(encode_path("group/sub/skills"), "group%2Fsub%2Fskills");
        assert_eq!(
            encode_path("habi/contrib/x-1a2b3c"),
            "habi%2Fcontrib%2Fx-1a2b3c"
        );
    }
}
