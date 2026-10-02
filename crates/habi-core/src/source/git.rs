//! Controlled invocation of the system `git`.
//!
//! Habi uses the user's Git installation so existing credential helpers and
//! SSH agents keep working, and Habi never sees passwords. Every invocation:
//! - passes arguments as an array (no shell), with a timeout and cancellation;
//! - points `core.hooksPath` at an empty directory so no hook can run;
//! - disables submodule recursion and the `ext::` transport, and restricts
//!   transports to file, git, http(s) and ssh;
//! - disables interactive prompts (terminal and SSH askpass), and runs SSH
//!   in batch mode unless the user configured an SSH command of their own;
//! - removes environment variables that could redirect Git to another
//!   repository or index.
//!
//! Library caches are bare repositories: content is read with `ls-tree` and
//! `cat-file`, so no checkout, smudge filter or attribute-driven conversion
//! ever runs on library content.
//!
//! Residual trust: the user's own Git configuration (credential helpers,
//! `url.*.insteadOf`, `core.sshCommand`) is honored, because it is what makes
//! authentication work. It is user-owned, not repository-supplied.

use crate::cancel::CancelToken;
use crate::error::{GitFailure, HabiError, Result};
use crate::process::{self, Output, Spec};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLEARED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_EDITOR",
];

#[derive(Debug, Clone)]
pub struct Git {
    program: PathBuf,
    hooks_dir: PathBuf,
    /// Run SSH in batch mode (see `ssh_command_is_set`).
    batch_ssh: bool,
}

/// What Habi runs SSH as when the user has not chosen a command: batch mode
/// never prompts. Without it, SSH asks for a passphrase or a new host key on
/// the terminal (the CLI's, or none at all in the desktop app) and the
/// operation hangs until its timeout.
const BATCH_SSH: &str = "ssh -o BatchMode=yes";

/// Whether the user chose how Git runs SSH (`GIT_SSH_COMMAND`, `GIT_SSH` or
/// `core.sshCommand`). Habi then leaves SSH as it is: setting
/// `GIT_SSH_COMMAND` would override their choice.
fn ssh_command_is_set(program: &Path, cwd: &Path) -> bool {
    if ["GIT_SSH_COMMAND", "GIT_SSH"]
        .iter()
        .any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
    {
        return true;
    }
    let mut spec = Spec::new(
        program,
        vec!["config".into(), "--get".into(), "core.sshCommand".into()],
    );
    spec.cwd = Some(cwd.to_path_buf());
    spec.env_remove = CLEARED_ENV.iter().map(|s| s.to_string()).collect();
    spec.timeout = Duration::from_secs(10);
    process::run(spec, &CancelToken::new())
        .is_ok_and(|out| out.success() && !out.stdout_text().trim().is_empty())
}

/// A sentence on how to fix an SSH failure Habi cannot prompt through.
fn ssh_hint(stderr: &str) -> Option<&'static str> {
    let s = stderr.to_ascii_lowercase();
    if s.contains("host key verification failed") {
        Some(
            "SSH does not know this server's host key yet. Connect once from a terminal (for example `ssh -T git@<host>`) and accept the key, then try again.",
        )
    } else if s.contains("permission denied (publickey") || s.contains("passphrase") {
        Some(
            "Habi cannot answer SSH prompts, so a key protected by a passphrase must be in your SSH agent: run `ssh-add`, then try again.",
        )
    } else {
        None
    }
}

/// One entry of `git ls-tree -r -l`.
#[derive(Debug, Clone)]
pub struct TreeEntry {
    pub mode: String,
    pub kind: String,
    pub oid: String,
    pub size: Option<u64>,
    pub path: String,
}

impl Git {
    pub fn locate(hooks_dir: &Path) -> Result<Git> {
        let program = which::which("git").map_err(|_| HabiError::Git {
            failure: GitFailure::GitMissing,
            message:
                "Git is not installed or not on PATH. Install Git to use Git-hosted libraries."
                    .into(),
        })?;
        std::fs::create_dir_all(hooks_dir)
            .map_err(|e| HabiError::io("creating the empty hooks directory", e))?;
        Ok(Git {
            batch_ssh: !ssh_command_is_set(&program, hooks_dir),
            program,
            hooks_dir: hooks_dir.to_path_buf(),
        })
    }

    fn spec(&self, git_dir: Option<&Path>, args: &[&str]) -> Spec {
        let mut all: Vec<String> = vec![
            "-c".into(),
            format!("core.hooksPath={}", self.hooks_dir.display()),
            "-c".into(),
            "core.fsmonitor=false".into(),
            "-c".into(),
            "protocol.ext.allow=never".into(),
            "-c".into(),
            "submodule.recurse=false".into(),
            "-c".into(),
            "fetch.recurseSubmodules=false".into(),
            "-c".into(),
            "diff.external=".into(),
            "-c".into(),
            "core.pager=cat".into(),
            "-c".into(),
            "gc.auto=0".into(),
        ];
        if let Some(dir) = git_dir {
            all.push(format!("--git-dir={}", dir.display()));
        }
        all.extend(args.iter().map(|s| s.to_string()));
        let mut spec = Spec::new(&self.program, all);
        spec.env_remove = CLEARED_ENV.iter().map(|s| s.to_string()).collect();
        spec.env = vec![
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("GIT_ASKPASS".into(), String::new()),
            ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
            (
                "GIT_ALLOW_PROTOCOL".into(),
                "file:git:http:https:ssh".into(),
            ),
            ("LC_ALL".into(), "C".into()),
            ("LANG".into(), "C".into()),
        ];
        if self.batch_ssh {
            spec.env.push(("GIT_SSH_COMMAND".into(), BATCH_SSH.into()));
        }
        spec.timeout = Duration::from_secs(60);
        spec
    }

    /// Runs git and returns its output if it exited successfully. Output
    /// larger than the default limit (64 KiB) is an error, never silently
    /// cut; use `run_limited` for commands that print more.
    pub fn run(
        &self,
        git_dir: Option<&Path>,
        args: &[&str],
        timeout: Duration,
        cancel: &CancelToken,
    ) -> Result<Output> {
        let mut spec = self.spec(git_dir, args);
        spec.timeout = timeout;
        self.finish(spec, args, cancel)
    }

    /// `run` for commands whose output may be large, up to `stdout_limit`.
    pub fn run_limited(
        &self,
        git_dir: Option<&Path>,
        args: &[&str],
        timeout: Duration,
        stdout_limit: usize,
        cancel: &CancelToken,
    ) -> Result<Output> {
        let mut spec = self.spec(git_dir, args);
        spec.timeout = timeout;
        spec.stdout_limit = stdout_limit;
        self.finish(spec, args, cancel)
    }

    pub fn run_with_input(
        &self,
        git_dir: Option<&Path>,
        args: &[&str],
        input: Vec<u8>,
        stdout_limit: usize,
        cancel: &CancelToken,
    ) -> Result<Output> {
        let mut spec = self.spec(git_dir, args);
        spec.stdin = Some(input);
        spec.stdout_limit = stdout_limit;
        spec.timeout = Duration::from_secs(300);
        self.finish(spec, args, cancel)
    }

    /// `run_env` with standard input (plumbing that reads from stdin while
    /// using a private index).
    pub fn run_env_with_input(
        &self,
        git_dir: Option<&Path>,
        args: &[&str],
        env: &[(&str, &str)],
        input: Vec<u8>,
        cancel: &CancelToken,
    ) -> Result<Output> {
        let mut spec = self.spec(git_dir, args);
        for (k, v) in env {
            spec.env.push((k.to_string(), v.to_string()));
        }
        spec.stdin = Some(input);
        spec.timeout = Duration::from_secs(300);
        self.finish(spec, args, cancel)
    }

    pub fn run_env(
        &self,
        git_dir: Option<&Path>,
        args: &[&str],
        env: &[(&str, &str)],
        cancel: &CancelToken,
    ) -> Result<Output> {
        let mut spec = self.spec(git_dir, args);
        for (k, v) in env {
            spec.env.push((k.to_string(), v.to_string()));
        }
        self.finish(spec, args, cancel)
    }

    fn finish(&self, spec: Spec, args: &[&str], cancel: &CancelToken) -> Result<Output> {
        let out = self.finish_partial(spec, args, cancel)?;
        // Callers parse or store stdout; a partial answer must never pass as
        // a complete one.
        if out.stdout_truncated {
            return Err(HabiError::Git {
                failure: GitFailure::Other,
                message: format!(
                    "git {} printed more output than Habi reads",
                    args.first().unwrap_or(&"")
                ),
            });
        }
        Ok(out)
    }

    /// `finish` for callers that report truncated output themselves.
    fn finish_partial(&self, spec: Spec, args: &[&str], cancel: &CancelToken) -> Result<Output> {
        let out = start(spec, cancel)?;
        if !out.success() {
            return Err(failure(args, &out));
        }
        Ok(out)
    }

    pub fn init_bare(&self, dir: &Path, cancel: &CancelToken) -> Result<()> {
        if dir.join("HEAD").exists() {
            return Ok(());
        }
        std::fs::create_dir_all(dir).map_err(|e| HabiError::io("creating the source cache", e))?;
        let d = dir.to_string_lossy().to_string();
        self.run(
            None,
            &["init", "--bare", "--quiet", &d],
            Duration::from_secs(30),
            cancel,
        )?;
        Ok(())
    }

    /// Fetches `refspec_source` from `url` into `target_ref`.
    pub fn fetch(
        &self,
        git_dir: &Path,
        url: &str,
        source: &str,
        target_ref: &str,
        cancel: &CancelToken,
    ) -> Result<()> {
        let refspec = format!("+{source}:{target_ref}");
        self.run(
            Some(git_dir),
            &[
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--quiet",
                "--",
                url,
                &refspec,
            ],
            Duration::from_secs(300),
            cancel,
        )?;
        Ok(())
    }

    pub fn rev_parse_commit(
        &self,
        git_dir: &Path,
        rev: &str,
        cancel: &CancelToken,
    ) -> Result<String> {
        let spec = format!("{rev}^{{commit}}");
        let out = self.run(
            Some(git_dir),
            &["rev-parse", "--verify", "--quiet", &spec],
            Duration::from_secs(30),
            cancel,
        )?;
        let commit = out.stdout_text().trim().to_string();
        if commit.len() < 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(HabiError::Internal(format!(
                "unexpected commit id from git: {commit}"
            )));
        }
        Ok(commit)
    }

    /// True if `ancestor` is reachable from `descendant`. Git answers "no"
    /// with exit status 1; any other failure (an unknown commit, a damaged
    /// repository, a timeout) is an error, not a "no".
    pub fn is_ancestor(
        &self,
        git_dir: &Path,
        ancestor: &str,
        descendant: &str,
        cancel: &CancelToken,
    ) -> Result<bool> {
        let args = ["merge-base", "--is-ancestor", ancestor, descendant];
        let out = start(self.spec(Some(git_dir), &args), cancel)?;
        match out.status {
            Some(0) if !out.timed_out => Ok(true),
            Some(1) if !out.timed_out => Ok(false),
            _ => Err(failure(&args, &out)),
        }
    }

    pub fn update_ref(
        &self,
        git_dir: &Path,
        name: &str,
        value: &str,
        cancel: &CancelToken,
    ) -> Result<()> {
        self.run(
            Some(git_dir),
            &["update-ref", name, value],
            Duration::from_secs(30),
            cancel,
        )?;
        Ok(())
    }

    /// One-line description of a commit: subject, author, date.
    pub fn describe_commit(
        &self,
        git_dir: &Path,
        commit: &str,
        cancel: &CancelToken,
    ) -> Result<String> {
        let out = self.run(
            Some(git_dir),
            &[
                "log",
                "-1",
                "--no-show-signature",
                "--format=%s%x1f%an%x1f%cs",
                commit,
                "--",
            ],
            Duration::from_secs(30),
            cancel,
        )?;
        let text = out.stdout_text();
        let parts: Vec<&str> = text.trim().split('\u{1f}').collect();
        Ok(match parts.as_slice() {
            [subject, author, date] => format!("{subject} — {author}, {date}"),
            _ => text.trim().to_string(),
        })
    }

    /// Lists blobs (recursively) under `subdir` at `commit`.
    pub fn ls_tree(
        &self,
        git_dir: &Path,
        commit: &str,
        subdir: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<Vec<TreeEntry>> {
        let mut args = vec!["ls-tree", "-r", "-z", "-l", "--full-tree", commit];
        if let Some(s) = subdir {
            args.push("--");
            args.push(s);
        }
        let mut spec = self.spec(Some(git_dir), &args);
        spec.stdout_limit = 32 * 1024 * 1024;
        let out = self.finish_partial(spec, &args, cancel)?;
        if out.stdout_truncated {
            return Err(HabiError::Unsupported(
                "the library tree listing is too large".into(),
            ));
        }
        let mut entries = Vec::new();
        for record in out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let text = String::from_utf8_lossy(record);
            let Some((meta, path)) = text.split_once('\t') else {
                continue;
            };
            let fields: Vec<&str> = meta.split_whitespace().collect();
            if fields.len() < 4 {
                continue;
            }
            entries.push(TreeEntry {
                mode: fields[0].to_string(),
                kind: fields[1].to_string(),
                oid: fields[2].to_string(),
                size: fields[3].parse().ok(),
                path: path.to_string(),
            });
        }
        Ok(entries)
    }

    /// Reads several blobs in one `cat-file --batch` process.
    pub fn read_blobs(
        &self,
        git_dir: &Path,
        oids: &[String],
        expected_total: u64,
        cancel: &CancelToken,
    ) -> Result<Vec<Vec<u8>>> {
        if oids.is_empty() {
            return Ok(Vec::new());
        }
        let input: String = oids.iter().map(|o| format!("{o}\n")).collect();
        let limit = (expected_total as usize) + oids.len() * 128 + 1024;
        let out = self.run_with_input(
            Some(git_dir),
            &["cat-file", "--batch"],
            input.into_bytes(),
            limit,
            cancel,
        )?;
        if out.stdout_truncated {
            return Err(HabiError::Internal(
                "library content was larger than expected".into(),
            ));
        }
        let mut blobs = Vec::with_capacity(oids.len());
        let data = &out.stdout;
        let mut pos = 0;
        for oid in oids {
            let header_end = data[pos..]
                .iter()
                .position(|b| *b == b'\n')
                .ok_or_else(|| HabiError::Internal("truncated git cat-file output".into()))?
                + pos;
            let header = String::from_utf8_lossy(&data[pos..header_end]).to_string();
            let fields: Vec<&str> = header.split(' ').collect();
            if fields.len() != 3 || fields[0] != oid || fields[1] != "blob" {
                return Err(HabiError::Internal(format!(
                    "unexpected git cat-file header: {header}"
                )));
            }
            let size: usize = fields[2]
                .parse()
                .map_err(|_| HabiError::Internal("bad blob size from git".into()))?;
            let start = header_end + 1;
            let end = start + size;
            if end > data.len() {
                return Err(HabiError::Internal("truncated blob from git".into()));
            }
            blobs.push(data[start..end].to_vec());
            pos = end + 1;
        }
        Ok(blobs)
    }
}

fn start(spec: Spec, cancel: &CancelToken) -> Result<Output> {
    process::run(spec, cancel).map_err(|e| match e {
        HabiError::NotFound(_) => HabiError::Git {
            failure: GitFailure::GitMissing,
            message: "Git could not be started.".into(),
        },
        other => other,
    })
}

/// The error for a git command that timed out or exited unsuccessfully.
fn failure(args: &[&str], out: &Output) -> HabiError {
    if out.timed_out {
        return HabiError::Git {
            failure: GitFailure::Network,
            message: format!(
                "git {} timed out after {}s",
                args.first().unwrap_or(&""),
                out.duration.as_secs()
            ),
        };
    }
    let stderr = out.stderr_text();
    let mut message = summarize(args, &stderr);
    if let Some(hint) = ssh_hint(&stderr) {
        message = format!("{message}. {hint}");
    }
    HabiError::Git {
        failure: classify(&stderr),
        message: crate::redact::redact(&message),
    }
}

fn summarize(args: &[&str], stderr: &str) -> String {
    let first: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(3)
        .collect();
    let verb = args.first().copied().unwrap_or("git");
    if first.is_empty() {
        format!("git {verb} failed")
    } else {
        format!("git {verb} failed: {}", first.join(" "))
    }
}

/// Classifies Git's error output (forced to the C locale).
pub fn classify(stderr: &str) -> GitFailure {
    let s = stderr.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|n| s.contains(n));
    if any(&[
        "authentication failed",
        "permission denied (publickey",
        "terminal prompts disabled",
        "could not read username",
        "could not read password",
        "access denied",
        "invalid username or password",
        "returned error: 401",
        "returned error: 403",
        "host key verification failed",
    ]) {
        GitFailure::Authentication
    } else if any(&[
        "[rejected]",
        "[remote rejected]",
        "protected branch",
        "pre-receive hook declined",
        "permission to",
        "failed to push",
    ]) {
        GitFailure::Rejected
    } else if any(&[
        "repository not found",
        "does not appear to be a git repository",
        "couldn't find remote ref",
        "not found",
        "no such file or directory",
        "returned error: 404",
    ]) {
        GitFailure::NotFound
    } else if any(&[
        "could not resolve host",
        "failed to connect",
        "connection timed out",
        "connection refused",
        "network is unreachable",
        "operation timed out",
        "temporary failure in name resolution",
        "could not read from remote repository",
        "unable to access",
        "connection reset",
    ]) {
        GitFailure::Network
    } else {
        GitFailure::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_output_is_an_error_unless_the_caller_allows_it() {
        let tmp = tempfile::tempdir().unwrap();
        let git = Git::locate(&tmp.path().join("hooks")).unwrap();
        let repo = tmp.path().join("repo.git");
        let cancel = CancelToken::new();
        git.init_bare(&repo, &cancel).unwrap();
        let big = "x".repeat(200 * 1024).into_bytes();
        let oid = git
            .run_with_input(
                Some(&repo),
                &["hash-object", "-w", "--stdin"],
                big.clone(),
                4096,
                &cancel,
            )
            .unwrap()
            .stdout_text()
            .trim()
            .to_string();
        let args = ["cat-file", "blob", oid.as_str()];
        let err = git
            .run(Some(&repo), &args, Duration::from_secs(30), &cancel)
            .unwrap_err();
        assert!(err.to_string().contains("more output"), "{err}");
        let out = git
            .run_limited(
                Some(&repo),
                &args,
                Duration::from_secs(30),
                1024 * 1024,
                &cancel,
            )
            .unwrap();
        assert_eq!(out.stdout, big);
    }

    #[test]
    fn is_ancestor_reports_failures_instead_of_no() {
        let tmp = tempfile::tempdir().unwrap();
        let git = Git::locate(&tmp.path().join("hooks")).unwrap();
        let repo = tmp.path().join("repo.git");
        let cancel = CancelToken::new();
        git.init_bare(&repo, &cancel).unwrap();
        let missing = "0123456789abcdef0123456789abcdef01234567";
        assert!(git.is_ancestor(&repo, missing, missing, &cancel).is_err());
    }

    #[test]
    fn ssh_runs_in_batch_mode_unless_the_user_chose_a_command() {
        let tmp = tempfile::tempdir().unwrap();
        let git = Git::locate(&tmp.path().join("hooks")).unwrap();
        let ssh = |g: &Git| {
            g.spec(None, &["fetch"])
                .env
                .into_iter()
                .find(|(k, _)| k == "GIT_SSH_COMMAND")
                .map(|(_, v)| v)
        };
        let batch = Git {
            batch_ssh: true,
            ..git.clone()
        };
        assert_eq!(ssh(&batch).as_deref(), Some(BATCH_SSH));
        let theirs = Git {
            batch_ssh: false,
            ..git
        };
        assert_eq!(ssh(&theirs), None);
    }

    #[test]
    fn ssh_prompts_get_a_way_out() {
        let out = |stderr: &str| Output {
            status: Some(128),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            duration: Duration::ZERO,
        };
        let host_key = failure(
            &["fetch"],
            &out("Host key verification failed.\nfatal: Could not read from remote repository."),
        );
        assert_eq!(host_key.code(), "gitAuthentication");
        assert!(
            host_key.to_string().contains("accept the key"),
            "{host_key}"
        );
        let passphrase = failure(
            &["fetch"],
            &out("git@example.com: Permission denied (publickey)."),
        );
        assert!(passphrase.to_string().contains("ssh-add"), "{passphrase}");
        let other = failure(&["fetch"], &out("fatal: couldn't find remote ref x"));
        assert!(!other.to_string().contains("ssh"), "{other}");
    }

    #[test]
    fn classifies_common_failures() {
        assert_eq!(
            classify("fatal: unable to access 'https://x/': Could not resolve host: x"),
            GitFailure::Network
        );
        assert_eq!(
            classify("git@github.com: Permission denied (publickey)."),
            GitFailure::Authentication
        );
        assert_eq!(
            classify("ERROR: Repository not found."),
            GitFailure::NotFound
        );
        assert_eq!(
            classify("fatal: couldn't find remote ref refs/heads/nope"),
            GitFailure::NotFound
        );
        assert_eq!(
            classify(" ! [remote rejected] main -> main (protected branch hook declined)"),
            GitFailure::Rejected
        );
    }
}
