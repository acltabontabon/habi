//! End-to-end tests of the `habi` binary: exit codes, `--json` output,
//! project detection and the messages people act on. Each test has its own
//! `HABI_HOME`, so nothing touches the developer's data.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use tempfile::TempDir;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn library_fixture() -> PathBuf {
    repo_root().join("fixtures/libraries/example-team-library")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("git is installed");
    assert!(status.success(), "git {args:?} failed");
}

struct Env {
    home: TempDir,
    work: TempDir,
}

impl Env {
    fn new() -> Env {
        Env {
            home: tempfile::tempdir().unwrap(),
            work: tempfile::tempdir().unwrap(),
        }
    }

    /// Runs `habi` in `cwd` with no terminal on stdin.
    fn run(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_habi"))
            .args(args)
            .current_dir(cwd)
            .env("HABI_HOME", self.home.path())
            .env_remove("HABI_LOG")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    fn ok(&self, cwd: &Path, args: &[&str]) -> Output {
        let out = self.run(cwd, args);
        assert!(
            out.status.success(),
            "habi {args:?} failed: {}{}",
            stdout(&out),
            stderr(&out)
        );
        out
    }

    /// Runs with `--json` and parses stdout as exactly one JSON document.
    fn json(&self, cwd: &Path, args: &[&str]) -> (Output, Value) {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        let out = self.run(cwd, &all);
        let value: Value = serde_json::from_str(&stdout(&out)).unwrap_or_else(|e| {
            panic!(
                "habi {all:?} did not print one JSON document ({e}):\n{}\nstderr: {}",
                stdout(&out),
                stderr(&out)
            )
        });
        (out, value)
    }

    /// A Git project (copy of a fixture repository) inside the work folder.
    fn project(&self, fixture: &str) -> PathBuf {
        let dir = self.work.path().join(fixture);
        copy_dir(&repo_root().join("fixtures/repos").join(fixture), &dir);
        git(&dir, &["init", "-q"]);
        habi_core::paths::canonical(dir).unwrap()
    }

    /// Connects and fetches the example library as `Team`.
    fn connect_library(&self) {
        let lib = library_fixture();
        self.ok(
            self.work.path(),
            &["source", "add", "Team", lib.to_str().unwrap()],
        );
        self.ok(self.work.path(), &["source", "refresh"]);
    }

    fn registered_projects(&self) -> Vec<PathBuf> {
        let habi = habi_core::service::Habi::open(habi_core::store::AppPaths::at(
            self.home.path().to_path_buf(),
        ))
        .unwrap();
        habi.recent_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.root)
            .collect()
    }
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn error_code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or("")
}

#[test]
fn json_mode_prints_exactly_one_document() {
    let env = Env::new();
    let project = env.project("billing-service");
    let p = project.to_str().unwrap();
    let lib = library_fixture();
    let (out, v) = env.json(
        env.work.path(),
        &["source", "add", "Team", lib.to_str().unwrap()],
    );
    assert!(out.status.success());
    assert_eq!(v["name"], "Team");
    let (out, v) = env.json(env.work.path(), &["source", "refresh"]);
    assert!(out.status.success());
    assert_eq!(v["refreshed"].as_array().unwrap().len(), 1);

    for args in [
        vec!["source", "list"],
        vec!["source", "items", "Team"],
        vec!["recommend", "-C", p],
        vec!["explain", "liquibase-migration-review", "-C", p],
        vec!["status", "-C", p],
        vec!["inspect", "-C", p],
        vec!["history", "-C", p],
        vec!["declarations", "-C", p],
        vec!["contribute", "list"],
        vec!["diagnostics"],
        vec![
            "check",
            "liquibase-migration-review",
            "changelog-is-wellformed",
            "-C",
            p,
        ],
    ] {
        let (out, _) = env.json(env.work.path(), &args);
        assert!(out.status.success(), "{args:?}: {}", stderr(&out));
    }

    let (out, v) = env.json(
        env.work.path(),
        &[
            "install",
            "jpa-entity-review",
            "--client",
            "codex",
            "--yes",
            "-C",
            p,
        ],
    );
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(v["applied"], true);
    assert!(v["plan"]["id"].is_string());
    assert!(v["operation"]["id"].is_string());

    let (out, v) = env.json(
        env.work.path(),
        &["declare", "tag", "db:jooq", "--absent", "-C", p],
    );
    assert!(out.status.success());
    let id = v["id"].as_str().unwrap().to_string();
    let (out, v) = env.json(env.work.path(), &["undeclare", &id, "-C", p]);
    assert!(out.status.success());
    assert_eq!(v["removed"]["id"], id.as_str());

    let (out, v) = env.json(env.work.path(), &["recover", "-C", p]);
    assert!(out.status.success());
    assert!(v.is_array());
}

#[test]
fn json_errors_are_json_with_nonzero_exit() {
    let env = Env::new();
    let project = env.project("billing-service");
    let p = project.to_str().unwrap();
    env.connect_library();

    let (out, v) = env.json(env.work.path(), &["explain", "nope", "-C", p]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(error_code(&v), "notFound");
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("habi source items")
    );

    // Nothing is asked in JSON mode: changing files needs --yes.
    let (out, v) = env.json(
        env.work.path(),
        &["install", "jpa-entity-review", "--client", "codex", "-C", p],
    );
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(error_code(&v), "confirmationRequired");
    assert!(!project.join(".habi/lock.json").exists());

    // --dry-run previews without --yes.
    let (out, v) = env.json(
        env.work.path(),
        &[
            "install",
            "jpa-entity-review",
            "--client",
            "codex",
            "--dry-run",
            "-C",
            p,
        ],
    );
    assert!(out.status.success());
    assert_eq!(v["applied"], false);
    assert!(!project.join(".habi/lock.json").exists());

    let (out, v) = env.json(env.work.path(), &["install"]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(error_code(&v), "usage");
}

#[test]
fn validate_reports_problems_with_nonzero_exit() {
    let env = Env::new();
    let lib = library_fixture();
    let out = env.ok(env.work.path(), &["validate", lib.to_str().unwrap()]);
    assert!(stdout(&out).contains("0 errors."));

    // A library with an error: SKILL.md without a name.
    let bad = env.work.path().join("bad-lib");
    std::fs::create_dir_all(bad.join("skills/broken")).unwrap();
    std::fs::write(
        bad.join("skills/broken/SKILL.md"),
        "---\ndescription: no name\n---\nBody\n",
    )
    .unwrap();
    let (out, v) = env.json(env.work.path(), &["validate", bad.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(error_code(&v), "invalidLibrary");
    assert!(v["index"].is_object());

    // Not a library at all.
    let empty = env.work.path().join("not-a-library");
    std::fs::create_dir_all(empty.join("docs")).unwrap();
    let out = env.run(env.work.path(), &["validate", empty.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("No SKILL.md found under"));

    // A missing folder is named.
    let missing = env.work.path().join("nope");
    let out = env.run(env.work.path(), &["validate", missing.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains(missing.to_str().unwrap()));
}

#[test]
fn subfolder_uses_the_project_root() {
    let env = Env::new();
    let project = env.project("billing-service");
    env.connect_library();
    let deep = project.join("src/main");
    assert!(deep.is_dir());

    let out = env.ok(&deep, &["declare", "tag", "db:jooq", "--absent"]);
    assert!(stderr(&out).contains("Using project"), "{}", stderr(&out));
    assert!(stdout(&out).contains(" -C "), "follow-up names the project");
    assert_eq!(env.registered_projects(), vec![project.clone()]);

    let (_, list) = env.json(
        env.work.path(),
        &["declarations", "-C", project.to_str().unwrap()],
    );
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[test]
fn read_only_commands_do_not_register_projects() {
    let env = Env::new();
    let project = env.project("billing-service");
    env.connect_library();
    env.ok(&project, &["recommend"]);
    env.ok(&project, &["status"]);
    env.ok(&project, &["explain", "jpa-entity-review"]);
    env.ok(&project, &["inspect"]);
    assert!(env.registered_projects().is_empty());

    // Changing the project registers it.
    env.ok(
        &project,
        &["install", "jpa-entity-review", "--client", "codex", "--yes"],
    );
    assert_eq!(env.registered_projects(), vec![project]);
}

#[test]
fn undeclare_unknown_id_fails_and_says_why() {
    let env = Env::new();
    let project = env.project("billing-service");
    let other = env.project("orders-api");
    let out = env.ok(
        &project,
        &[
            "--json",
            "declare",
            "dependency",
            "org.example:x",
            "--present",
        ],
    );
    let declared: Value = serde_json::from_slice(&out.stdout).unwrap();
    let id = declared["id"].as_str().unwrap();

    // Wrong project: an error that explains declarations are per project
    // and points at the right one.
    let out = env.run(&other, &["undeclare", id]);
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(err.contains("No declaration"), "{err}");
    assert!(err.contains("pass -C <project>"), "{err}");
    assert!(err.contains("It belongs to"), "{err}");

    // Right project, by prefix.
    env.ok(&project, &["undeclare", &id[..8]]);
    let out = env.run(&project, &["undeclare", &id[..8]]);
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn update_with_nothing_to_update_changes_nothing() {
    let env = Env::new();
    let project = env.project("billing-service");
    env.connect_library();
    env.ok(
        &project,
        &[
            "install",
            "jpa-entity-review",
            "--client",
            "claude-code",
            "--yes",
        ],
    );
    let lock = std::fs::read(project.join(".habi/lock.json")).unwrap();

    let out = env.ok(&project, &["update", "--yes"]);
    assert!(stdout(&out).contains("Everything is up to date."));
    let (out, v) = env.json(&project, &["update", "--yes"]);
    assert!(out.status.success());
    assert_eq!(v["upToDate"], true);

    assert_eq!(
        std::fs::read(project.join(".habi/lock.json")).unwrap(),
        lock
    );
    let (_, history) = env.json(&project, &["history"]);
    assert_eq!(history.as_array().unwrap().len(), 1, "only the install");
}

#[test]
fn messages_say_what_to_do_next() {
    let env = Env::new();
    let out = env.ok(env.work.path(), &["source", "refresh"]);
    assert!(stdout(&out).contains("No libraries connected. Add one with: habi source add"));

    // Relative library folders are accepted.
    copy_dir(&library_fixture(), &env.work.path().join("lib"));
    env.ok(env.work.path(), &["source", "add", "Fresh", "lib"]);
    let out = env.run(env.work.path(), &["source", "items", "Fresh"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).contains("`Fresh` hasn't been fetched yet. Run: habi source refresh Fresh")
    );
    env.ok(env.work.path(), &["source", "refresh", "Fresh"]);

    let project = env.project("billing-service");
    let out = env.run(&project, &["check", "liquibase-migration-review", "nope"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("Available checks: changelog-is-wellformed"));

    let out = env.run(&project, &["restore", "", "--yes"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("at least the first 4 characters"));

    let out = env.ok(&project, &["recommend"]);
    let text = stdout(&out);
    for internal in [
        "NotInstalled",
        "NoRequirements",
        "NotEvaluated",
        "next: None",
    ] {
        assert!(!text.contains(internal), "{internal} in:\n{text}");
    }
    // Items without applicability rules are summarized, not listed.
    assert!(!text.contains("Incident notes"), "{text}");
    assert!(
        text.contains(
            "1 item has no applicability rules, so Habi does not match it to projects (Fresh 1)"
        ),
        "{text}"
    );
    let all = stdout(&env.ok(&project, &["recommend", "--all"]));
    assert!(all.contains("Incident notes"), "{all}");
}

#[test]
fn contribution_describe_keeps_what_is_not_given() {
    let env = Env::new();
    // Contributions need a Git-backed library.
    let lib = env.work.path().join("lib");
    copy_dir(&library_fixture(), &lib);
    git(&lib, &["init", "-q", "-b", "main"]);
    git(&lib, &["add", "-A"]);
    git(&lib, &["commit", "-q", "-m", "init"]);
    env.ok(env.work.path(), &["source", "add", "Team", "lib"]);
    env.ok(env.work.path(), &["source", "refresh"]);

    let (out, c) = env.json(
        env.work.path(),
        &["contribute", "start", "Team", "--item", "jpa-entity-review"],
    );
    assert!(out.status.success(), "{}", stderr(&out));
    let id = c["id"].as_str().unwrap().to_string();

    env.ok(
        env.work.path(),
        &["contribute", "describe", &id, "--message", "Why this helps"],
    );
    let (_, c) = env.json(
        env.work.path(),
        &[
            "contribute",
            "describe",
            &id,
            "--title",
            "Better entity review",
        ],
    );
    assert_eq!(c["title"], "Better entity review");
    assert_eq!(c["message"], "Why this helps");

    let out = env.ok(env.work.path(), &["contribute", "show", &id]);
    assert!(stdout(&out).contains("Edit files in: "));

    // Publishing before committing says what to do, without the push preamble.
    let out = env.run(env.work.path(), &["contribute", "publish", &id, "--yes"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(!stdout(&out).contains("This pushes"));
    assert!(stderr(&out).contains(&format!("habi contribute commit {id}")));

    // Export creates the folder it is given.
    let staged = env
        .home
        .path()
        .join("contributions")
        .join(&id)
        .join("files/SKILL.md");
    let mut text = std::fs::read_to_string(&staged).unwrap();
    text.push_str("\nOne more rule.\n");
    std::fs::write(&staged, text).unwrap();
    env.ok(env.work.path(), &["contribute", "commit", &id]);
    let dest = env.work.path().join("patches/new");
    let (out, v) = env.json(
        env.work.path(),
        &["contribute", "export", &id, dest.to_str().unwrap()],
    );
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(Path::new(v["path"].as_str().unwrap()).is_file());

    // Without a terminal, publishing needs --yes and says so.
    let out = env.run(env.work.path(), &["contribute", "publish", &id]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("refusing to publish without --yes"));
}

#[test]
fn install_defaults_to_the_agent_tools_the_project_uses() {
    let env = Env::new();
    // orders-api has no agent tool set up.
    let project = env.project("orders-api");
    env.connect_library();

    // No agent tool set up yet: say how to choose instead of guessing.
    let out = env.run(&project, &["install", "jpa-entity-review", "--dry-run"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("--client"),
        "should explain --client: {}",
        stderr(&out)
    );

    // A project that already uses Claude Code gets it for Claude Code.
    std::fs::write(project.join("CLAUDE.md"), "# Notes\n").unwrap();
    let (out, plan) = env.json(&project, &["install", "jpa-entity-review", "--dry-run"]);
    // (JPA entity review is a plain skill folder, so it can be installed anywhere.)
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(stderr(&out).contains("Installing for Claude Code"));
    assert!(
        plan.to_string()
            .contains(".claude/skills/jpa-entity-review"),
        "{plan}"
    );
}
