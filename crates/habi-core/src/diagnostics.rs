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
    let text = std::fs::read_to_string(latest).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    crate::redact::redact(&all[start..].join("\n"))
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
    fn local_folders_are_not_named() {
        assert_eq!(host_only("/Users/ana/skills"), "local folder");
        assert_eq!(host_only("~/skills"), "local folder");
        assert!(host_only("https://example.com/team/skills.git").starts_with("example.com"));
        #[cfg(windows)]
        assert_eq!(host_only(r"C:\Users\ana\skills"), "local folder");
    }
}
