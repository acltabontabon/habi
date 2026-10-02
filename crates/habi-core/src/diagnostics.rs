//! Diagnostic bundle: a redacted text report the user previews before saving.
//!
//! Contains versions, platform, database schema version, source health
//! (names and error codes; locations reduced to their host), recent
//! operation states and the tail of Habi's own log. It never includes
//! library content, project files, environment values or credentials.

use crate::error::Result;
use crate::service::Habi;
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiagnosticBundle {
    pub file_name: String,
    pub text: String,
}

fn host_only(location: &str) -> String {
    if crate::source::is_local_location(location) {
        return "local folder".into();
    }
    match crate::contribute::remote_repo(location) {
        Some(r) => format!("{} (repository path omitted)", r.host),
        None => "remote (unrecognized URL form)".into(),
    }
}

fn log_tail(habi: &Habi, lines: usize) -> String {
    let Ok(entries) = std::fs::read_dir(habi.paths.logs()) else {
        return "(no log files)".into();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    let Some(latest) = files.last() else {
        return "(no log files)".into();
    };
    let text = read_end(latest, LOG_TAIL_BYTES).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    crate::redact::redact(&all.get(start..).unwrap_or_default().join("\n"))
}

/// How much of the end of a log file is read for its last lines.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

/// The last `limit` bytes of a file as text, starting at a line boundary.
/// A day's log can be large; only its end is needed.
fn read_end(path: &std::path::Path, limit: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(limit);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(match (start, text.split_once('\n')) {
        // Started mid-line: drop the partial first line.
        (1.., Some((_, rest))) => rest.to_string(),
        _ => text,
    })
}

pub fn bundle(habi: &Habi, app_version: &str) -> Result<DiagnosticBundle> {
    let mut t = String::new();
    let _ = writeln!(t, "{} diagnostic report", crate::brand::APP_NAME);
    let _ = writeln!(t, "generated: {}", crate::time::now());
    let _ = writeln!(t, "app version: {app_version}");
    let _ = writeln!(t, "core version: {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(
        t,
        "platform: {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let _ = writeln!(t, "database schema: v{}", habi.store.schema_version()?);
    let _ = writeln!(
        t,
        "git: {}",
        if which::which("git").is_ok() {
            "found"
        } else {
            "not found"
        }
    );
    let _ = writeln!(
        t,
        "gh: {}",
        if which::which("gh").is_ok() {
            "found"
        } else {
            "not found"
        }
    );
    let _ = writeln!(
        t,
        "glab: {}",
        if which::which("glab").is_ok() {
            "found"
        } else {
            "not found"
        }
    );
    let _ = writeln!(t);
    let _ = writeln!(t, "sources:");
    for s in habi.sources().list()? {
        let _ = writeln!(
            t,
            "  - {} [{:?}] {} · {:?} · snapshot {} · last error: {}",
            s.name,
            s.kind,
            host_only(&s.location),
            s.freshness,
            s.snapshot
                .as_deref()
                .map(crate::fsutil::short)
                .unwrap_or("none"),
            s.last_error
                .as_ref()
                .map(|e| e.code.as_str())
                .unwrap_or("none")
        );
    }
    let projects = habi.recent_projects()?;
    let _ = writeln!(t, "\nprojects opened: {} (paths omitted)", projects.len());
    for p in projects.iter().take(10) {
        let history = habi.history(&p.id).unwrap_or_default();
        let unfinished = history
            .iter()
            .filter(|o| !matches!(o.state, crate::install::apply::JournalState::Committed))
            .count();
        let _ = writeln!(
            t,
            "  - project {}: {} operations, {} not committed",
            &p.id[..8.min(p.id.len())],
            history.len(),
            unfinished
        );
    }
    let _ = writeln!(t, "\nrecent log (redacted):\n{}", log_tail(habi, 300));
    Ok(DiagnosticBundle {
        file_name: format!(
            "habi-diagnostics-{}.txt",
            crate::time::now().replace(':', "-")
        ),
        text: crate::redact::redact(&t),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_the_end_of_a_log() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("habi.log");
        let text: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&log, &text).unwrap();
        assert_eq!(read_end(&log, 1 << 20).unwrap(), text);
        let end = read_end(&log, 30).unwrap();
        assert!(end.starts_with("line 99"), "{end:?}");
        assert!(end.ends_with("line 999\n"));
    }

    #[test]
    fn local_folders_are_not_named() {
        assert_eq!(host_only("/Users/ana/skills"), "local folder");
        assert_eq!(host_only("~/skills"), "local folder");
        assert!(host_only("https://example.com/team/skills.git").starts_with("example.com"));
        #[cfg(windows)]
        assert_eq!(host_only(r"C:\Users\ana\skills"), "local folder");
    }
}
