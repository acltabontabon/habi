//! Sending a contribution to a library the author cannot push to: Habi asks
//! the host, forks through `gh`, waits for the fork, pushes there, opens the
//! pull request from it, and keeps revisions and status on that fork.
//!
//! Git reaches both repositories through `insteadOf` rules pointing at local
//! bare repositories; `gh` is a stand-in that answers like the GitHub REST API
//! and creates the fork a few seconds after being asked, as GitHub does. The
//! rules are set through `GIT_CONFIG_GLOBAL`, so this file holds a single test.
#![cfg(unix)]

mod common;

use common::*;
use habi_core::cancel::CancelToken;
use habi_core::contribute::{ContributionOrigin, ContributionState, SendRoute};
use habi_core::error::HabiError;
use habi_core::review::ReviewTools;
use habi_core::service::Habi;
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const LIBRARY: &str = "https://github.com/acme/skills.git";
const FORK_HTTPS: &str = "https://github.com/me/skills.git";
const FORK_SSH: &str = "git@github.com:me/skills.git";

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

fn has_ref(repo: &Path, name: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", name])
        .current_dir(repo)
        .output()
        .unwrap()
        .status
        .success()
}

/// `access` holds the answer about the library; asking for a fork leaves
/// `fork-asked` behind, for `host_forks_when_asked` to act on.
fn fake_gh(dir: &Path) -> PathBuf {
    let d = dir.display();
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> "{d}/log"
case "$1 $2" in
  "pr create") echo "https://github.com/acme/skills/pull/9"; exit 0 ;;
  "config get") echo https; exit 0 ;;
esac
case "$4" in
  user)
    [ -f "{d}/signed-out" ] && {{ echo "To get started, run: gh auth login" >&2; exit 1; }}
    echo '{{"login":"me"}}' ;;
  repos/acme/skills) cat "{d}/access" ;;
  repos/acme/skills/forks)
    touch "{d}/fork-asked"
    echo '{{"full_name":"me/skills","fork":true}}' ;;
  repos/acme/skills/pulls\?*me:*)
    echo '[{{"number":9,"state":"open","draft":false,"merged_at":null,"html_url":"https://github.com/acme/skills/pull/9","created_at":"2026-10-01T00:00:00Z","head":{{"sha":"abc"}}}}]' ;;
  repos/acme/skills/pulls\?*) echo '[]' ;;
  *) echo '[]' ;;
esac
"#
    );
    let path = dir.join("gh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// Plays the host's background job: the fork appears a few seconds after it
/// was asked for, so the first pushes find nothing there.
fn host_forks_when_asked(tools: &Path, library: &Path, fork: &Path) {
    let (asked, library, fork) = (
        tools.join("fork-asked"),
        library.to_path_buf(),
        fork.to_path_buf(),
    );
    std::thread::spawn(move || {
        while !asked.exists() {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_secs(3));
        let building = fork.with_extension("tmp");
        git(
            fork.parent().unwrap(),
            &[
                "clone",
                "-q",
                "--bare",
                library.to_str().unwrap(),
                building.to_str().unwrap(),
            ],
        );
        std::fs::rename(&building, &fork).unwrap();
    });
}

fn answer(tools: &Path, push: bool, allow_forking: bool, archived: bool) {
    std::fs::write(
        tools.join("access"),
        format!(
            r#"{{"full_name":"acme/skills","archived":{archived},"allow_forking":{allow_forking},"permissions":{{"push":{push}}}}}"#
        ),
    )
    .unwrap();
}

#[test]
fn a_library_you_cannot_push_to_is_reached_through_your_fork() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (seed, library, fork, home, tools) = (
        root.join("seed"),
        root.join("library.git"),
        root.join("fork.git"),
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
            "[user]\n\tname = Dev Example\n\temail = dev@example.invalid\n\
             [url \"file://{}\"]\n\tinsteadOf = {LIBRARY}\n\
             [url \"file://{}\"]\n\tinsteadOf = {FORK_HTTPS}\n\tinsteadOf = {FORK_SSH}\n",
            library.display(),
            fork.display()
        ),
    )
    .unwrap();
    // SAFETY: the only test in this binary; set before any thread starts.
    #[allow(unsafe_code)] // Setting the environment is unsafe since Rust 2024.
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
            library.to_str().unwrap(),
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
            name: "Community".into(),
            location: LIBRARY.into(),
            subdir: None,
            tracked: TrackedRef::Branch {
                name: "main".into(),
            },
        })
        .unwrap();
    habi.sources().refresh(&source.id, &cancel).unwrap();
    let c = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LibraryItem {
                item_id: "jpa-entity-review".into(),
            },
        )
        .unwrap();
    let mut form = c.form.clone();
    form.owner = "Data Guild".into();
    habi.update_contribution(&c.id, "Owner for JPA review", "First version", &form)
        .unwrap();
    let first = habi.commit_contribution(&c.id, &cancel).unwrap();
    let branch = format!("refs/heads/{}", c.branch);

    // What the host says decides the route, and asking changes nothing.
    let route = |habi: &Habi| habi.contribution_send_route(&c.id, &cancel).unwrap();
    answer(&tools, true, true, false);
    assert_eq!(route(&habi), SendRoute::Library);
    answer(&tools, false, false, false);
    assert!(
        matches!(route(&habi), SendRoute::Blocked { reason } if reason.contains("turned off forks"))
    );
    answer(&tools, false, true, true);
    assert!(matches!(route(&habi), SendRoute::Blocked { reason } if reason.contains("archived")));
    answer(&tools, false, true, false);
    std::fs::write(tools.join("signed-out"), "").unwrap();
    assert!(
        matches!(route(&habi), SendRoute::Unknown { reason } if reason.contains("gh auth login"))
    );
    std::fs::remove_file(tools.join("signed-out")).unwrap();
    assert_eq!(
        route(&habi),
        SendRoute::Fork {
            account: "me".into(),
            existing: None
        }
    );
    assert!(!fork.exists(), "asking does not fork");
    let log = || std::fs::read_to_string(tools.join("log")).unwrap_or_default();
    assert!(!log().contains("--method POST"), "{}", log());

    host_forks_when_asked(&tools, &library, &fork);
    // Sending forks, waits out a fork that is not there yet, pushes to it and
    // opens the request from it. The library gets no branch.
    let out = habi
        .publish_contribution_with(&c.id, true, true, &cancel)
        .unwrap();
    assert_eq!(out.fork.as_deref(), Some("me/skills"));
    assert_eq!(out.remote, "https://github.com/me/skills");
    assert_eq!(
        out.pull_request_url.as_deref(),
        Some("https://github.com/acme/skills/pull/9")
    );
    assert_eq!(
        git(&fork, &["rev-parse", &branch]),
        first.commit_id.clone().unwrap()
    );
    assert!(!has_ref(&library, &branch), "the library was not pushed to");
    assert!(
        log().contains("api --hostname github.com repos/acme/skills/forks --method POST"),
        "{}",
        log()
    );
    assert!(
        log().contains(&format!(
            "pr create --repo github.com/acme/skills --head me:{} --base main",
            c.branch
        )),
        "{}",
        log()
    );
    let sent = habi.contributions().preview(&c.id).unwrap();
    assert_eq!(sent.state, ContributionState::Published);
    let recorded = sent.fork.clone().unwrap();
    assert_eq!(recorded.path, "me/skills");
    assert_eq!(recorded.url, "https://github.com/me/skills");
    assert_eq!(recorded.push_url.as_deref(), Some(FORK_HTTPS));

    // From now on the contribution knows its fork without asking the host.
    assert!(matches!(
        route(&habi),
        SendRoute::Fork { existing: Some(f), .. } if f.path == "me/skills"
    ));

    // Status looks for the request from the fork's branch.
    let checked = habi.refresh_contribution_review(&c.id, &cancel).unwrap();
    assert_eq!(checked.review.as_ref().map(|r| r.number), Some(9));
    assert!(
        log().contains(&format!(
            "pulls?state=all&per_page=10&head=me:{}",
            "habi%2Fcontrib"
        )),
        "{}",
        log()
    );

    // A revision goes to the same fork and updates the same request.
    habi.revise_contribution(&c.id).unwrap();
    let mut form = checked.form.clone();
    form.owner = "Platform Guild".into();
    habi.update_contribution(&c.id, "Owner for JPA review", "Second version", &form)
        .unwrap();
    let second = habi.commit_contribution(&c.id, &cancel).unwrap();
    let out = habi.publish_contribution(&c.id, false, &cancel).unwrap();
    assert!(out.updated_existing);
    assert_eq!(out.fork.as_deref(), Some("me/skills"));
    assert_eq!(
        git(&fork, &["rev-parse", &branch]),
        second.commit_id.clone().unwrap()
    );
    assert_eq!(log().matches("pr create").count(), 1, "{}", log());
    assert!(!has_ref(&library, &branch));

    // A maintainer's commit on the fork's branch is seen, and never overwritten.
    let other = root.join("other");
    git(
        root,
        &[
            "clone",
            "-q",
            "--branch",
            &c.branch,
            fork.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    std::fs::write(other.join("note.txt"), "from a maintainer").unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-qm", "maintainer edit"]);
    git(&other, &["push", "-q", "origin", &c.branch]);
    habi.revise_contribution(&c.id).unwrap();
    let mut form = checked.form.clone();
    form.owner = "Third Guild".into();
    habi.update_contribution(&c.id, "Owner for JPA review", "Third version", &form)
        .unwrap();
    assert!(matches!(
        habi.commit_contribution(&c.id, &cancel),
        Err(HabiError::Conflict(_))
    ));

    // A contribution already sent to the library itself does not move to a fork.
    let direct = habi
        .start_contribution(
            &source.id,
            ContributionOrigin::LibraryItem {
                item_id: "jpa-entity-review".into(),
            },
        )
        .unwrap();
    let mut form = direct.form.clone();
    form.owner = "Direct Guild".into();
    habi.update_contribution(&direct.id, "Direct", "", &form)
        .unwrap();
    habi.commit_contribution(&direct.id, &cancel).unwrap();
    habi.publish_contribution(&direct.id, false, &cancel)
        .unwrap();
    assert!(has_ref(&library, &format!("refs/heads/{}", direct.branch)));
    assert_eq!(
        habi.contribution_send_route(&direct.id, &cancel).unwrap(),
        SendRoute::Library
    );
    let err = habi
        .publish_contribution_with(&direct.id, false, true, &cancel)
        .unwrap_err();
    assert!(
        err.to_string().contains("already sent to the library"),
        "{err}"
    );
}
