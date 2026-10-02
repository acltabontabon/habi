//! Running external programs safely.
//!
//! Every subprocess Habi starts goes through `run`: arguments are passed as an
//! array (never through a shell), output is bounded, and the process — with
//! everything it started — is killed on timeout or cancellation.

use crate::cancel::CancelToken;
use crate::error::{HabiError, Result};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Keeps the last `capacity` bytes of a stream.
struct Tail {
    bytes: VecDeque<u8>,
    capacity: usize,
    total: u64,
}

impl Tail {
    fn new(capacity: usize) -> Self {
        Tail {
            bytes: VecDeque::new(),
            capacity,
            total: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        // Only the last `capacity` bytes of the chunk can survive; drop
        // as many old bytes as needed in one go, then append in one go.
        let keep = chunk.len().min(self.capacity);
        let chunk = chunk.get(chunk.len() - keep..).unwrap_or_default();
        let overflow = (self.bytes.len() + keep).saturating_sub(self.capacity);
        self.bytes.drain(..overflow);
        self.bytes.extend(chunk);
    }
}

pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Environment variables to set (added to the inherited environment).
    pub env: Vec<(String, String)>,
    /// Variables removed from the inherited environment.
    pub env_remove: Vec<String>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    /// Maximum bytes kept from stdout. Git plumbing needs complete output, so
    /// callers that parse stdout set this high and treat truncation as an error.
    pub stdout_limit: usize,
    pub stderr_limit: usize,
}

impl Spec {
    pub fn new(program: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Spec {
            program: program.into(),
            args,
            cwd: None,
            env: Vec::new(),
            env_remove: Vec::new(),
            stdin: None,
            timeout: Duration::from_secs(120),
            stdout_limit: 64 * 1024,
            stderr_limit: 64 * 1024,
        }
    }
}

#[derive(Debug)]
pub struct Output {
    /// `None` when the process was killed by a signal.
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// More was written than `stdout_limit`, or the output could not be read
    /// to its end (another process kept the pipe open). Either way `stdout`
    /// is not the complete output.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration: Duration,
}

impl Output {
    pub fn success(&self) -> bool {
        self.status == Some(0) && !self.timed_out
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_string()
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// How long to wait for output readers once the process has ended. A
/// grandchild that inherited the pipes (for example `git-remote-https`) is
/// killed with the group, but Habi never waits on it indefinitely.
const READER_GRACE: Duration = Duration::from_secs(2);

fn drain<R: Read + Send + 'static>(mut reader: R, limit: usize) -> mpsc::Receiver<Tail> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut tail = Tail::new(limit);
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => tail.push(buf.get(..n).unwrap_or_default()),
            }
        }
        let _ = tx.send(tail);
    });
    rx
}

/// `CREATE_NO_WINDOW`: console programs started from the desktop app (which
/// has no console) would otherwise each flash a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Puts the child in a process group of its own so that stopping it also
/// stops everything it started.
fn isolate(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

/// Kills the child and every process in its group (Unix) or tree (Windows).
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: a plain system call with no memory arguments. `pgid` is
            // the group `isolate` created for this child; it is called before
            // the child is reaped, or while a group member still holds its
            // pipes, so the id cannot have been reused.
            #[allow(unsafe_code)] // The standard library cannot signal a process group.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let taskkill = std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
        let _ = Command::new(taskkill)
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Waits for a reader until `deadline`. If it is still blocked (a process the
/// child started holds the pipe), kills the group and gives up shortly after.
/// The flag is false when the output is incomplete.
fn collect(rx: &mpsc::Receiver<Tail>, deadline: Instant, child: &mut Child) -> (Tail, bool) {
    let wait = deadline.saturating_duration_since(Instant::now());
    if let Ok(tail) = rx.recv_timeout(wait) {
        return (tail, true);
    }
    kill_tree(child);
    match rx.recv_timeout(Duration::from_millis(500)) {
        Ok(tail) => (tail, true),
        Err(_) => (Tail::new(0), false),
    }
}

/// Runs a program to completion, enforcing the timeout and cancellation.
/// Returns `Err(Cancelled)` if cancelled; a timeout is reported in `Output`.
/// On timeout or cancellation the child's whole process group is killed, so
/// helpers it started (such as Git's remote helpers) stop too.
pub fn run(spec: Spec, cancel: &CancelToken) -> Result<Output> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    for key in &spec.env_remove {
        cmd.env_remove(key);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    isolate(&mut cmd);
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            HabiError::NotFound(format!("program `{}`", spec.program.display()))
        } else {
            HabiError::io(format!("starting {}", spec.program.display()), e)
        }
    })?;

    let stdout = drain(
        child.stdout.take().expect("piped stdout"),
        spec.stdout_limit,
    );
    let stderr = drain(
        child.stderr.take().expect("piped stderr"),
        spec.stderr_limit,
    );
    if let Some(input) = spec.stdin {
        let mut pipe = child.stdin.take().expect("piped stdin");
        // Not joined: if the child stops reading, the write fails once it is
        // gone and the thread ends on its own.
        thread::spawn(move || {
            let _ = pipe.write_all(&input);
            // Dropping the pipe closes stdin so the child sees EOF.
        });
    }

    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(HabiError::io("waiting for a subprocess", e));
            }
        }
        if cancel.is_cancelled() {
            cancelled = true;
            kill_tree(&mut child);
            break child.wait().ok();
        }
        if started.elapsed() > spec.timeout {
            timed_out = true;
            kill_tree(&mut child);
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(15));
    };

    // Once the child is gone, everything it wrote is already in the pipes;
    // a reader still blocked after the grace period is waiting on a process
    // the child left behind.
    let deadline = Instant::now() + READER_GRACE;
    let (out, out_complete) = collect(&stdout, deadline, &mut child);
    let (err, _) = collect(&stderr, deadline, &mut child);
    if cancelled {
        return Err(HabiError::Cancelled);
    }
    let stdout_truncated = !out_complete || out.total > out.bytes.len() as u64;
    let stderr_truncated = err.total > err.bytes.len() as u64;
    Ok(Output {
        status: if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        stdout: out.bytes.into(),
        stderr: err.bytes.into(),
        stdout_truncated,
        stderr_truncated,
        timed_out,
        duration: started.elapsed(),
    })
}

#[cfg(test)]
mod tail_tests {
    use super::Tail;

    #[test]
    fn keeps_the_last_bytes_across_chunks() {
        let mut tail = Tail::new(5);
        tail.push(b"abc");
        assert_eq!(tail.bytes, b"abc");
        tail.push(b"de");
        assert_eq!(tail.bytes, b"abcde");
        tail.push(b"fg");
        assert_eq!(tail.bytes, b"cdefg");
        tail.push(b"0123456789");
        assert_eq!(tail.bytes, b"56789");
        tail.push(b"");
        assert_eq!(tail.bytes, b"56789");
        assert_eq!(tail.total, 17);
        let mut none = Tail::new(0);
        none.push(b"abc");
        assert!(none.bytes.is_empty());
        assert_eq!(none.total, 3);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn captures_output_and_status() {
        let mut spec = Spec::new("sh", vec!["-c".into(), "printf hello; exit 3".into()]);
        spec.timeout = Duration::from_secs(5);
        let out = run(spec, &CancelToken::new()).unwrap();
        assert_eq!(out.status, Some(3));
        assert_eq!(out.stdout, b"hello");
    }

    #[test]
    fn arguments_are_not_interpreted_by_a_shell() {
        let spec = Spec::new(
            "printf",
            vec!["%s".into(), "$(echo injected); rm -rf /".into()],
        );
        let out = run(spec, &CancelToken::new()).unwrap();
        assert_eq!(out.stdout_text(), "$(echo injected); rm -rf /");
    }

    #[test]
    fn enforces_timeout() {
        let mut spec = Spec::new("sleep", vec!["5".into()]);
        spec.timeout = Duration::from_millis(100);
        let out = run(spec, &CancelToken::new()).unwrap();
        assert!(out.timed_out);
        assert!(!out.success());
    }

    #[test]
    fn keeps_only_the_tail_of_large_output() {
        let mut spec = Spec::new("sh", vec!["-c".into(), "yes x | head -c 100000".into()]);
        spec.stdout_limit = 1000;
        let out = run(spec, &CancelToken::new()).unwrap();
        assert_eq!(out.stdout.len(), 1000);
        assert!(out.stdout_truncated);
    }

    #[test]
    fn cancellation_kills_the_process() {
        let cancel = CancelToken::new();
        let c2 = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            c2.cancel();
        });
        let started = Instant::now();
        let result = run(Spec::new("sleep", vec!["5".into()]), &cancel);
        assert!(matches!(result, Err(HabiError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn cancellation_stops_grandchildren_holding_the_pipes() {
        // The shell starts a background sleeper that inherits stdout, as Git
        // does with `git-remote-https`; killing only the shell would leave
        // the reader waiting on the sleeper for 30 seconds.
        let cancel = CancelToken::new();
        let c2 = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            c2.cancel();
        });
        let started = Instant::now();
        let result = run(
            Spec::new("sh", vec!["-c".into(), "sleep 30 & sleep 30; wait".into()]),
            &cancel,
        );
        assert!(matches!(result, Err(HabiError::Cancelled)));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn timeout_stops_grandchildren_holding_the_pipes() {
        let mut spec = Spec::new(
            "sh",
            vec!["-c".into(), "(sleep 30; echo late) & sleep 30".into()],
        );
        spec.timeout = Duration::from_millis(150);
        let started = Instant::now();
        let out = run(spec, &CancelToken::new()).unwrap();
        assert!(out.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_lingering_grandchild_after_exit_does_not_hang_the_caller() {
        // The shell exits at once; its background child keeps stdout open.
        let mut spec = Spec::new("sh", vec!["-c".into(), "sleep 30 & echo done".into()]);
        spec.timeout = Duration::from_millis(300);
        let started = Instant::now();
        let out = run(spec, &CancelToken::new()).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        assert_eq!(out.status, Some(0));
        assert_eq!(out.stdout_text().trim(), "done");
    }
}
