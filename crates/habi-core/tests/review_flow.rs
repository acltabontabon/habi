//! The whole review loop against a GitHub-shaped remote: send, read status
//! and comments, revise on the same branch, refuse to overwrite someone
//! else's commits, and stop revising once merged.
//!
//! Git reaches "https://github.com/acme/skills.git" through an `insteadOf`
//! rule pointing at a local bare repository; `gh` is a stand-in script that
//! records its arguments and answers like the GitHub REST API. The rule is set
//! through `GIT_CONFIG_GLOBAL`, so this file holds a single test.
#![cfg(unix)]

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::contribute::{ContributionOrigin, ContributionState};
use habi_core::review::{CommentKind, ReviewHost, ReviewState, ReviewTools};
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

const URL: &str = "https://github.com/acme/skills.git";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A `gh` that answers from files in `dir`: `state` is "open" or "merged".
fn fake_gh(dir: &Path) -> std::path::PathBuf {
    let d = dir.display();
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> "{d}/log"
case "$1 $2" in
  "pr create") echo "Creating pull request..."; echo "https://github.com/acme/skills/pull/7"; exit 0 ;;
  "auth status") exit 1 ;;
esac
state=$(cat "{d}/state" 2>/dev/null || echo open)
case "$4" in
  repos/acme/skills/pulls\?*)
    if [ "$state" = merged ]; then
      echo '[{{"number":7,"state":"closed","merged_at":"2026-10-03T00:00:00Z","html_url":"https://github.com/acme/skills/pull/7","created_at":"2026-10-01T00:00:00Z","head":{{"sha":"abc"}}}}]'
    else
      echo '[{{"number":7,"state":"open","draft":false,"merged_at":null,"html_url":"https://github.com/acme/skills/pull/7","created_at":"2026-10-01T00:00:00Z","head":{{"sha":"abc"}}}}]'
    fi ;;
  */pulls/7/reviews*)
    echo '[{{"user":{{"login":"ana"}},"state":"CHANGES_REQUESTED","body":"Please add an example.","submitted_at":"2026-10-01T10:00:00Z"}}]' ;;
  */issues/7/comments*)
    echo '[{{"user":{{"login":"bo"}},"body":"Thanks!\u202e (see link)","created_at":"2026-10-01T11:00:00Z"}}]' ;;
  */pulls/7/comments*)
    echo '[{{"user":{{"login":"ana"}},"body":"Typo here","path":"skills/jpa-entity-review/SKILL.md","line":3,"original_line":3,"created_at":"2026-10-01T10:01:00Z"}}]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
"#
    );
    let path = dir.join("gh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn review_loop_on_a_github_remote() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (seed, bare, other, home, tools) = (
        root.join("seed"),
        root.join("remote.git"),
        root.join("other"),
        root.join("home"),
        root.join("tools"),
    );
    for d in [&seed, &home, &tools] {
        std::fs::create_dir_all(d).unwrap();
    }
    let config = root.join("gitconfig");
    std::fs::write(
        &config,
        format!(
            "[user]\n\tname = Dev Example\n\temail = dev@example.invalid\n[url \"file://{}\"]\n\tinsteadOf = {URL}\n",
            bare.display()
        ),
    )
    .unwrap();
    // SAFETY: the only test in this binary; set before any thread starts.
    unsafe {
        std::env::set_var("GIT_CONFIG_GLOBAL", &config);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    }

    copy_tree(&fixture("libraries/example-team-library"), &seed);
    git(&seed, &["init", "-q"]);
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-qm", "init"]);
    git(
        root,
        &[
            "clone",
            "-q",
            "--bare",
            seed.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );

    let mut habi = Habi::open(AppPaths::at(home.clone())).unwrap();
    habi.review_tools = ReviewTools {
        gh: Some(fake_gh(&tools)),
        glab: None,
        cwd: None,
    };
    let cancel = CancelToken::new();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Team".into(),
            location: URL.into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    habi.sources().refresh(&source.id, &cancel).unwrap();

    // Send a metadata improvement for review.
    let c = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LibraryItem {
                item_id: "jpa-entity-review".into(),
            },
        )
        .unwrap();
    let remote = c.remote.clone().unwrap();
    assert_eq!(remote.host, Some(ReviewHost::GitHub));
    assert!(!remote.on_this_machine);
    assert!(remote.request_unavailable.is_none());
    let mut form = c.form.clone();
    form.owner = "Data Guild".into();
    habi.update_contribution(&c.id, "Owner for JPA review", "First version", &form)
        .unwrap();
    let first = habi.commit_contribution(&c.id, &cancel).unwrap();
    let first_commit = first.commit_id.clone().unwrap();
    let out = habi.publish_contribution(&c.id, true, &cancel).unwrap();
    assert_eq!(
        out.pull_request_url.as_deref(),
        Some("https://github.com/acme/skills/pull/7")
    );
    assert!(!out.updated_existing);
    let branch = format!("refs/heads/{}", c.branch);
    assert_eq!(git(&bare, &["rev-parse", &branch]), first_commit);
    let log = std::fs::read_to_string(tools.join("log")).unwrap();
    assert!(
        log.contains(&format!(
            "pr create --repo github.com/acme/skills --head {} --base main",
            c.branch
        )),
        "{log}"
    );

    // Status and comments, read on request.
    let c2 = habi.refresh_contribution_review(&c.id, &cancel).unwrap();
    let review = c2.review.clone().unwrap();
    assert_eq!(review.state, ReviewState::ChangesRequested);
    assert_eq!(review.number, 7);
    let inline = review
        .comments
        .iter()
        .find(|x| x.kind == CommentKind::Inline)
        .unwrap();
    assert_eq!(
        inline.path.as_deref(),
        Some("skills/jpa-entity-review/SKILL.md")
    );
    assert_eq!(inline.line, Some(3));
    let thanks = review.comments.iter().find(|x| x.author == "bo").unwrap();
    assert!(
        !thanks.body.contains('\u{202e}'),
        "bidi overrides are removed"
    );

    // Revise: same branch, built on the first commit, same request.
    let r = habi.revise_contribution(&c.id).unwrap();
    assert_eq!(r.state, ContributionState::Draft);
    assert_eq!(r.revision, 1);
    let mut form = r.form.clone();
    form.examples = vec![habi_core::contribute::ExampleEntry {
        title: "New entity".into(),
        description: "Review a new @Entity".into(),
    }];
    habi.update_contribution(&c.id, "Owner for JPA review", "Added an example", &form)
        .unwrap();
    let second = habi.commit_contribution(&c.id, &cancel).unwrap();
    let second_commit = second.commit_id.clone().unwrap();
    let out = habi.publish_contribution(&c.id, true, &cancel).unwrap();
    assert!(out.updated_existing, "the open request is reused");
    assert_eq!(git(&bare, &["rev-parse", &branch]), second_commit);
    assert_eq!(
        git(&bare, &["rev-parse", &format!("{second_commit}^")]),
        first_commit
    );
    let log = std::fs::read_to_string(tools.join("log")).unwrap();
    assert_eq!(log.matches("pr create").count(), 1, "no second request");
    let message = git(&bare, &["log", "-1", "--format=%B", &second_commit]);
    assert!(message.contains("Revision 1 after review."), "{message}");

    // Someone else pushes to the branch: Habi stops instead of overwriting.
    git(
        root,
        &[
            "clone",
            "-q",
            bare.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["checkout", "-q", &c.branch]);
    std::fs::write(
        other.join("skills/jpa-entity-review/NOTES.md"),
        "from a reviewer\n",
    )
    .unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-qm", "reviewer suggestion"]);
    git(&other, &["push", "-q", "origin", &c.branch]);
    let theirs = git(&other, &["rev-parse", "HEAD"]);

    habi.revise_contribution(&c.id).unwrap();
    let err = habi.commit_contribution(&c.id, &cancel).unwrap_err();
    assert_eq!(err.to_info().code, "conflict", "{err}");
    assert_eq!(
        git(&bare, &["rev-parse", &branch]),
        theirs,
        "nothing changed"
    );
    let third = habi.commit_contribution_with(&c.id, true, &cancel).unwrap();
    let third_commit = third.commit_id.clone().unwrap();
    habi.publish_contribution(&c.id, true, &cancel).unwrap();
    assert_eq!(git(&bare, &["rev-parse", &branch]), third_commit);
    assert_eq!(
        git(&bare, &["rev-parse", &format!("{third_commit}^")]),
        theirs,
        "built on their commit"
    );
    // The skill folder is exactly what the author staged.
    let files = git(
        &bare,
        &[
            "ls-tree",
            "-r",
            "--name-only",
            &third_commit,
            "--",
            "skills/jpa-entity-review",
        ],
    );
    assert!(!files.contains("NOTES.md"), "{files}");

    // Without a way to ask the host, a revision is allowed but says so, and
    // sending it does not claim the request was updated.
    let gh = habi.review_tools.gh.take();
    let r = habi.revise_contribution(&c.id).unwrap();
    assert!(
        r.published_note
            .as_deref()
            .is_some_and(|n| n.contains("could not check")),
        "{:?}",
        r.published_note
    );
    let mut form = r.form.clone();
    form.owner = "Data Guild (JPA)".into();
    habi.update_contribution(&c.id, "Owner for JPA review", "Owner wording", &form)
        .unwrap();
    let fourth = habi.commit_contribution(&c.id, &cancel).unwrap();
    let fourth_commit = fourth.commit_id.clone().unwrap();
    let out = habi.publish_contribution(&c.id, true, &cancel).unwrap();
    assert!(!out.updated_existing, "not observed, so not claimed");
    assert_eq!(out.pull_request_url, None);
    assert!(
        out.pull_request_note
            .as_deref()
            .is_some_and(|n| n.contains("could not check")),
        "{:?}",
        out.pull_request_note
    );
    assert_eq!(git(&bare, &["rev-parse", &branch]), fourth_commit);
    let shown = habi.contributions().preview(&c.id).unwrap();
    assert_eq!(
        shown.published_url.as_deref(),
        Some("https://github.com/acme/skills/pull/7"),
        "the known address is kept"
    );
    habi.review_tools.gh = gh;

    // Once merged, revising is refused with a reason.
    std::fs::write(tools.join("state"), "merged").unwrap();
    let merged = habi.refresh_contribution_review(&c.id, &cancel).unwrap();
    assert_eq!(merged.review.unwrap().state, ReviewState::Merged);
    let err = habi.revise_contribution(&c.id).unwrap_err();
    assert!(err.to_string().contains("merged"), "{err}");
    // Sending again is refused too: the request is checked first.
    let err = habi.publish_contribution(&c.id, true, &cancel).unwrap_err();
    assert!(err.to_string().contains("nothing was pushed"), "{err}");
    assert_eq!(git(&bare, &["rev-parse", &branch]), fourth_commit);
}
