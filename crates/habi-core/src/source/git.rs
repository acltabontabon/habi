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
use std::sync::OnceLock;
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

/// Files larger than this are never read by Habi (it skips them with a
/// warning), so a shallow fetch does not download them either.
pub const SKIP_BLOBS_OVER: u64 = 2 * 1024 * 1024;

/// How much of a repository a fetch downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchDepth {
    /// All history and all files.
    Full,
    /// The newest commit only, without files over `SKIP_BLOBS_OVER`.
    Tip,
}

/// The remote's answer to `ls-remote` for one ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHead {
    /// The commit the ref points at (a tag is peeled to its commit).
    pub commit: String,
    /// The branch `HEAD` names, when the ref asked about was `HEAD`.
    pub branch: Option<String>,
}

fn parse_ls_remote(text: &str) -> Option<RemoteHead> {
    let mut branch = None;
    let mut commit = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("ref: ") {
            let target = rest.split('\t').next().unwrap_or(rest);
            branch = target.strip_prefix("refs/heads/").map(str::to_string);
            continue;
        }
        let Some((oid, name)) = line.split_once('\t') else {
            continue;
        };
        let valid = oid.len() >= 40 && oid.chars().all(|c| c.is_ascii_hexdigit());
        if !valid {
            continue;
        }
        // An annotated tag is listed twice; the peeled `^{}` line is the commit.
        if name.ends_with("^{}") || commit.is_none() {
            commit = Some(oid.to_string());
        }
    }
    Some(RemoteHead {
        commit: commit?,
        branch,
    })
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

/// The most `git ls-remote --tags` output `list_tags` reads: room for tens of
/// thousands of tags.
const LIST_TAGS_LIMIT: usize = 8 * 1024 * 1024;

/// Where Git is, and whether Habi may run SSH in batch mode (see
/// `ssh_command_is_set`), found by the first `Git::locate` that succeeds.
///
/// Every Git operation starts with `locate`, and finding these takes a search
/// of PATH and a `git config` run: a refresh or a contribution runs Git many
/// times. Both depend only on the environment and the person's global Git
/// configuration, which do not change under a running Habi in practice; such a
/// change (Git moved, `core.sshCommand` set) takes effect at the next start. A
/// failed search is not remembered, so Git installed while Habi runs is found.
static LOCATED: OnceLock<(PathBuf, bool)> = OnceLock::new();

impl Git {
    pub fn locate(hooks_dir: &Path) -> Result<Git> {
        let found = LOCATED.get().cloned();
        let program = match &found {
            Some((program, _)) => program.clone(),
            None => which::which("git").map_err(|_| HabiError::Git {
                failure: GitFailure::GitMissing,
                message:
                    "Git is not installed or not on PATH. Install Git to use Git-hosted libraries."
                        .into(),
            })?,
        };
        std::fs::create_dir_all(hooks_dir)
            .map_err(|e| HabiError::io("creating the empty hooks directory", e))?;
        let (program, batch_ssh) = match found {
            Some(found) => found,
            // The hooks directory is empty, so `git config` there reads only
            // the person's global and system settings.
            None => {
                let batch_ssh = !ssh_command_is_set(&program, hooks_dir);
                LOCATED.get_or_init(|| (program, batch_ssh)).clone()
            }
        };
        Ok(Git {
            batch_ssh,
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
        if git_dir.is_none() {
            // Without a repository of its own, Git would look for one from
            // wherever Habi was started and read that repository's
            // `.git/config` (`credential.helper`, `core.sshCommand`,
            // `url.insteadOf`). Run in the empty directory, and never above it.
            // The person's global Git and SSH configuration is unaffected.
            spec.cwd = Some(self.hooks_dir.clone());
        }
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
            // A cache fetched without large files must report them missing,
            // not quietly download them one by one.
            ("GIT_NO_LAZY_FETCH".into(), "1".into()),
        ];
        if git_dir.is_none()
            && let Some(parent) = self.hooks_dir.parent()
        {
            spec.env.push((
                "GIT_CEILING_DIRECTORIES".into(),
                parent.to_string_lossy().into_owned(),
            ));
        }
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

    /// Fetches `refspec_source` from `url` into `target_ref`, with full history.
    pub fn fetch(
        &self,
        git_dir: &Path,
        url: &str,
        source: &str,
        target_ref: &str,
        cancel: &CancelToken,
    ) -> Result<()> {
        self.fetch_with(git_dir, url, source, target_ref, FetchDepth::Full, cancel)
    }

    /// `fetch` with a choice of how much to download.
    pub fn fetch_with(
        &self,
        git_dir: &Path,
        url: &str,
        source: &str,
        target_ref: &str,
        depth: FetchDepth,
        cancel: &CancelToken,
    ) -> Result<()> {
        let refspec = format!("+{source}:{target_ref}");
        let filter = format!("--filter=blob:limit={SKIP_BLOBS_OVER}");
        let mut args = vec!["fetch", "--no-tags", "--no-recurse-submodules", "--quiet"];
        if depth == FetchDepth::Tip {
            // Habi reads one commit's files, and never a file over its own
            // size limit, so neither history nor oversized blobs are needed.
            args.extend(["--depth=1", filter.as_str()]);
        }
        args.extend(["--", url, refspec.as_str()]);
        self.run(Some(git_dir), &args, Duration::from_secs(300), cancel)?;
        Ok(())
    }

    /// True if the repository holds a truncated history (a `Tip` fetch).
    pub fn is_shallow(&self, git_dir: &Path, cancel: &CancelToken) -> Result<bool> {
        let out = self.run(
            Some(git_dir),
            &["rev-parse", "--is-shallow-repository"],
            Duration::from_secs(30),
            cancel,
        )?;
        Ok(out.stdout_text().trim() == "true")
    }

    /// What the remote's `source` ref points at right now, without
    /// downloading any objects. For `HEAD`, also the branch it names.
    pub fn ls_remote(&self, url: &str, source: &str, cancel: &CancelToken) -> Result<RemoteHead> {
        let peeled = format!("{source}^{{}}");
        let out = self.run(
            None,
            &["ls-remote", "--symref", "--", url, source, &peeled],
            Duration::from_secs(60),
            cancel,
        )?;
        parse_ls_remote(&out.stdout_text())
            .ok_or_else(|| HabiError::NotFound(format!("`{source}` in the remote repository")))
    }

    /// The names of the tags a remote has, without downloading anything.
    ///
    /// Each tag is a line of about a hundred bytes, so a long-lived repository
    /// with thousands of release tags prints far more than `run`'s default
    /// limit; `LIST_TAGS_LIMIT` still bounds a remote that answers without end.
    pub fn list_tags(&self, url: &str, cancel: &CancelToken) -> Result<Vec<String>> {
        let out = self.run_limited(
            None,
            &["ls-remote", "--tags", "--refs", "--", url],
            Duration::from_secs(60),
            LIST_TAGS_LIMIT,
            cancel,
        )?;
        Ok(out
            .stdout_text()
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .filter_map(|(_, name)| name.strip_prefix("refs/tags/"))
            .map(str::to_string)
            .collect())
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
            let [mode, kind, oid, size, ..] = fields.as_slice() else {
                continue;
            };
            entries.push(TreeEntry {
                mode: mode.to_string(),
                kind: kind.to_string(),
                oid: oid.to_string(),
                size: size.parse().ok(),
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
        // Each blob: `<oid> blob <size>\n<content>\n`.
        let mut rest: &[u8] = &out.stdout;
        for oid in oids {
            let header_end = rest
                .iter()
                .position(|b| *b == b'\n')
                .ok_or_else(|| HabiError::Internal("truncated git cat-file output".into()))?;
            let (header, after) = rest.split_at(header_end);
            let header = String::from_utf8_lossy(header).to_string();
            let fields: Vec<&str> = header.split(' ').collect();
            let [name, "blob", size] = fields.as_slice() else {
                return Err(HabiError::Internal(format!(
                    "unexpected git cat-file header: {header}"
                )));
            };
            if name != oid {
                return Err(HabiError::Internal(format!(
                    "unexpected git cat-file header: {header}"
                )));
            }
            let size: usize = size
                .parse()
                .map_err(|_| HabiError::Internal("bad blob size from git".into()))?;
            // Skip the header's newline; the content is followed by one too.
            let (content, tail) = after
                .get(1..)
                .unwrap_or_default()
                .split_at_checked(size)
                .ok_or_else(|| HabiError::Internal("truncated blob from git".into()))?;
            blobs.push(content.to_vec());
            rest = tail.get(1..).unwrap_or_default();
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

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn ls_remote_names_the_head_branch() {
        let text = format!("ref: refs/heads/main\tHEAD\n{SHA_A}\tHEAD\n");
        let head = parse_ls_remote(&text).unwrap();
        assert_eq!(head.commit, SHA_A);
        assert_eq!(head.branch.as_deref(), Some("main"));
    }

    #[test]
    fn ls_remote_peels_annotated_tags() {
        let text = format!("{SHA_A}\trefs/tags/v1\n{SHA_B}\trefs/tags/v1^{{}}\n");
        let head = parse_ls_remote(&text).unwrap();
        assert_eq!(head.commit, SHA_B, "the commit, not the tag object");
        assert_eq!(head.branch, None);
    }

    #[test]
    fn ls_remote_without_the_ref_is_nothing() {
        assert!(parse_ls_remote("").is_none());
        assert!(parse_ls_remote("not a ref line\n").is_none());
    }

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
    fn a_remote_with_thousands_of_tags_lists_them_all() {
        let tmp = tempfile::tempdir().unwrap();
        let git = Git::locate(&tmp.path().join("hooks")).unwrap();
        let repo = tmp.path().join("repo.git");
        let cancel = CancelToken::new();
        git.init_bare(&repo, &cancel).unwrap();
        let tree = git
            .run_with_input(Some(&repo), &["mktree"], Vec::new(), 4096, &cancel)
            .unwrap()
            .stdout_text()
            .trim()
            .to_string();
        let identity = [
            ("GIT_AUTHOR_NAME", "Habi"),
            ("GIT_AUTHOR_EMAIL", "habi@example.invalid"),
            ("GIT_COMMITTER_NAME", "Habi"),
            ("GIT_COMMITTER_EMAIL", "habi@example.invalid"),
        ];
        let commit = git
            .run_env_with_input(
                Some(&repo),
                &["commit-tree", &tree, "-F", "-"],
                &identity,
                b"tags".to_vec(),
                &cancel,
            )
            .unwrap()
            .stdout_text()
            .trim()
            .to_string();
        // Enough tags that `ls-remote` prints well past the 64 KiB default.
        let count = 2000;
        let refs: String = (0..count)
            .map(|i| {
                format!(
                    "create refs/tags/release-candidate-of-a-long-lived-project-{i:05} {commit}\n"
                )
            })
            .collect();
        git.run_with_input(
            Some(&repo),
            &["update-ref", "--stdin"],
            refs.into_bytes(),
            4096,
            &cancel,
        )
        .unwrap();
        let tags = git.list_tags(&repo.to_string_lossy(), &cancel).unwrap();
        assert_eq!(tags.len(), count);
        assert!(tags.contains(&"release-candidate-of-a-long-lived-project-01999".to_string()));
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
    fn repository_less_commands_run_in_the_empty_directory() {
        let tmp = tempfile::tempdir().unwrap();
        // The data directory sits inside a repository whose configuration
        // must not be read.
        let cancel = CancelToken::new();
        let git = Git::locate(&tmp.path().join("data").join("empty")).unwrap();
        git.run(
            None,
            &["init", "--quiet", &tmp.path().to_string_lossy()],
            Duration::from_secs(30),
            &cancel,
        )
        .unwrap();
        let spec = git.spec(None, &["ls-remote"]);
        assert_eq!(spec.cwd.as_deref(), Some(git.hooks_dir.as_path()));
        assert!(spec.env.iter().any(|(k, _)| k == "GIT_CEILING_DIRECTORIES"));
        assert!(git.spec(Some(tmp.path()), &["fetch"]).cwd.is_none());
        let found = git.run(
            None,
            &["rev-parse", "--git-dir"],
            Duration::from_secs(30),
            &cancel,
        );
        assert!(
            found.is_err(),
            "found a repository above the empty directory"
        );
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
