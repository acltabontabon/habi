//! User-initiated verification checks.
//!
//! A check is a command declared in a skill's metadata (an argument array,
//! never a shell string). Habi never runs one implicitly. The user sees the
//! exact program, arguments, working directory and environment policy first,
//! and must pick binding values from discovered candidates. Running a build
//! or test executes repository code; Habi says so and does not claim a
//! sandbox. Results record exactly what ran, against which item version and
//! project state, and validate only that command's own success condition.

use crate::cancel::CancelToken;
use crate::error::{HabiError, Result};
use crate::inspect::model::ProjectInspection;
use crate::library::model::{BindingKind, CheckArg, CheckCwd, LibraryItem};
use crate::library::signals::{self, SignalSeverity};
use crate::paths::{RelPath, display_path, resolve_for_read};
use crate::process::{self, Spec};
use crate::store::Store;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BindingChoice {
    pub name: String,
    pub kind: BindingKind,
    pub description: Option<String>,
    pub candidates: Vec<String>,
    pub selected: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckPreview {
    /// Single-use id to run exactly this command (set by the service).
    pub preview_id: String,
    pub item_key: String,
    pub item_title: String,
    pub item_digest: String,
    pub check_id: String,
    pub title: String,
    pub description: Option<String>,
    pub module: String,
    /// Program as declared.
    pub program: String,
    /// Where it resolves on this machine, if found.
    pub resolved_program: Option<String>,
    pub args: Vec<String>,
    /// Project-relative working directory (`.` for the root).
    pub cwd: String,
    pub environment: String,
    pub timeout_seconds: u32,
    pub warnings: Vec<String>,
    pub bindings: Vec<BindingChoice>,
    /// All bindings chosen and the program found.
    pub ready: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CheckStatus {
    Passed,
    Failed,
    TimedOut,
    Cancelled,
    /// The command could not be started.
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckRun {
    pub id: String,
    pub item_key: String,
    pub item_digest: String,
    pub check_id: String,
    pub module: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub project_fingerprint: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub status: CheckStatus,
    /// Last part of the combined output, with secrets redacted.
    pub output_tail: String,
}

fn file_candidates(
    inspection: &ProjectInspection,
    glob: Option<&str>,
    module: &str,
) -> Vec<String> {
    let Some(glob) = glob else {
        return Vec::new();
    };
    let Ok(matcher) = globset::GlobBuilder::new(glob)
        .literal_separator(true)
        .build()
    else {
        return Vec::new();
    };
    let matcher = matcher.compile_matcher();
    inspection
        .files
        .iter()
        .filter(|p| module == "." || p.starts_with(&format!("{module}/")))
        .filter(|p| matcher.is_match(p.as_str()))
        .take(50)
        .cloned()
        .collect()
}

/// Builds the preview for a check. `chosen` maps binding names to values;
/// values must be among the discovered candidates.
pub fn prepare(
    root: &Path,
    inspection: &ProjectInspection,
    item: &LibraryItem,
    check_id: &str,
    module: &str,
    chosen: &HashMap<String, String>,
) -> Result<CheckPreview> {
    let check = item
        .checks
        .iter()
        .find(|c| c.id == check_id)
        .ok_or_else(|| HabiError::NotFound(format!("check `{check_id}` in `{}`", item.title)))?;
    if inspection.module(module).is_none() {
        return Err(HabiError::invalid(format!("unknown module `{module}`")));
    }
    let cwd_rel = match check.cwd {
        CheckCwd::Repository => ".".to_string(),
        CheckCwd::Module => module.to_string(),
    };
    let mut bindings = Vec::new();
    for spec in &item.bindings {
        let candidates = match spec.kind {
            BindingKind::File => file_candidates(inspection, spec.glob.as_deref(), module),
            BindingKind::Module => inspection.modules.iter().map(|m| m.id.clone()).collect(),
        };
        let selected = match chosen.get(&spec.name) {
            Some(v) if candidates.contains(v) => Some(v.clone()),
            Some(v) => {
                return Err(HabiError::invalid(format!(
                    "`{v}` is not a discovered candidate for `{}`",
                    spec.name
                )));
            }
            None if candidates.len() == 1 => candidates.first().cloned(),
            None => None,
        };
        bindings.push(BindingChoice {
            name: spec.name.clone(),
            kind: spec.kind,
            description: spec.description.clone(),
            candidates,
            selected,
        });
    }
    let mut argv = Vec::new();
    let mut unbound = false;
    for arg in &check.run {
        match arg {
            CheckArg::Literal { value } => argv.push(value.clone()),
            CheckArg::Binding { name } => match bindings
                .iter()
                .find(|b| &b.name == name)
                .and_then(|b| b.selected.clone())
            {
                Some(v) => {
                    // File bindings are repository-relative; make them relative to the cwd.
                    let rel = if cwd_rel != "." {
                        v.strip_prefix(&format!("{cwd_rel}/"))
                            .unwrap_or(&v)
                            .to_string()
                    } else {
                        v
                    };
                    argv.push(rel);
                }
                None => {
                    unbound = true;
                    argv.push(format!("<{name}>"));
                }
            },
        }
    }
    let program = argv.first().cloned().unwrap_or_default();
    let cwd_path = if cwd_rel == "." {
        root.to_path_buf()
    } else {
        RelPath::new(&cwd_rel)?.to_path(root)
    };
    let mut warnings = vec![
        "This command runs code from this repository and its build (plugins, tests, scripts). Habi does not sandbox it.".to_string(),
    ];
    let resolved = resolve_program(root, &cwd_rel, &cwd_path, &program, &mut warnings);
    warnings.extend(signal_warnings(root, &argv, &program, resolved.as_deref()));
    Ok(CheckPreview {
        preview_id: String::new(),
        item_key: item.key.clone(),
        item_title: item.title.clone(),
        item_digest: item.content_digest.clone(),
        check_id: check.id.clone(),
        title: check.title.clone(),
        description: check.description.clone(),
        module: module.to_string(),
        ready: resolved.is_some() && !unbound,
        resolved_program: resolved.map(|p| display_path(&p)),
        program,
        args: argv.into_iter().skip(1).collect(),
        cwd: cwd_rel,
        environment:
            "Inherits your current environment (variable values are not shown or recorded).".into(),
        timeout_seconds: check.timeout_seconds,
        warnings,
        bindings,
    })
}

/// What a static reading of the command and, for a `./script`, of that one
/// script finds worth knowing before it runs. It is a warning, never a
/// block: a check may have a good reason to touch what it names. The script
/// is read as data; scripts it calls are not followed.
fn signal_warnings(
    root: &Path,
    argv: &[String],
    program: &str,
    resolved: Option<&Path>,
) -> Vec<String> {
    let mut out = Vec::new();
    // The command line is what the skill declared, so notices count too.
    for s in signals::scan_command(argv) {
        if s.severity >= SignalSeverity::Notice {
            out.push(format!("The command itself: {}", describe(&s)));
        }
    }
    // A script belongs to the project, and build wrappers legitimately
    // download and install, so only what could do harm is raised.
    if program.starts_with("./")
        && let Some(path) = resolved
        && let Some(text) = read_script(path)
    {
        let name = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| program.to_string());
        for s in signals::scan_code(&name, &text) {
            if s.severity >= SignalSeverity::Caution {
                out.push(format!("{name}: {}", describe(&s)));
            }
        }
    }
    out
}

fn describe(s: &signals::Signal) -> String {
    let mut text = s.summary.clone();
    if let Some(line) = s.line {
        text.push_str(&format!(" (line {line}"));
        if s.more > 0 {
            text.push_str(&format!(", and {} more", s.more));
        }
        text.push(')');
    }
    if let Some(detail) = &s.detail {
        text.push_str(&format!(": {detail}"));
    }
    text
}

/// The script's text if it is a regular file small enough to read.
fn read_script(path: &Path) -> Option<String> {
    const LIMIT: u64 = 256 * 1024;
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > LIMIT {
        return None;
    }
    String::from_utf8(std::fs::read(path).ok()?).ok()
}

fn resolve_program(
    root: &Path,
    cwd_rel: &str,
    cwd: &Path,
    program: &str,
    warnings: &mut Vec<String>,
) -> Option<PathBuf> {
    if let Some(local) = program.strip_prefix("./") {
        let rel = if cwd_rel == "." {
            local.to_string()
        } else {
            format!("{cwd_rel}/{local}")
        };
        let rel = RelPath::new(&rel).ok()?;
        let path = resolve_for_read(root, &rel).ok().flatten()?;
        if !path.is_file() {
            return None;
        }
        warnings.push(format!("{program} is a script from this repository."));
        Some(path)
    } else if program.contains('/') || program.contains('\\') {
        warnings.push("Programs given as paths outside the project are not run.".into());
        None
    } else {
        let _ = cwd;
        which::which(program).ok()
    }
}

/// Runs a prepared check and records the result.
pub fn run(
    root: &Path,
    store: &Store,
    project_id: &str,
    fingerprint: &str,
    preview: &CheckPreview,
    cancel: &CancelToken,
) -> Result<CheckRun> {
    if !preview.ready {
        return Err(HabiError::invalid(
            "choose values for every binding and make sure the program is installed",
        ));
    }
    let program = if preview.program.starts_with("./") {
        let rel = if preview.cwd == "." {
            preview.program.trim_start_matches("./").to_string()
        } else {
            format!(
                "{}/{}",
                preview.cwd,
                preview.program.trim_start_matches("./")
            )
        };
        RelPath::new(&rel)?.to_path(root)
    } else {
        which::which(&preview.program)
            .map_err(|_| HabiError::NotFound(format!("program `{}`", preview.program)))?
    };
    let cwd = if preview.cwd == "." {
        root.to_path_buf()
    } else {
        RelPath::new(&preview.cwd)?.to_path(root)
    };
    let mut spec = Spec::new(program, preview.args.clone());
    spec.cwd = Some(cwd);
    spec.timeout = Duration::from_secs(preview.timeout_seconds as u64);
    spec.stdout_limit = OUTPUT_LIMIT;
    spec.stderr_limit = OUTPUT_LIMIT;
    let id = uuid::Uuid::new_v4().to_string();
    let started_at = crate::time::now();
    let argv: Vec<String> = std::iter::once(preview.program.clone())
        .chain(preview.args.iter().cloned())
        .collect();
    let (status, exit_code, output) = match process::run(spec, cancel) {
        Ok(out) => {
            let mut text = String::new();
            if !out.stdout.is_empty() {
                text.push_str(&out.stdout_text());
            }
            if !out.stderr.is_empty() {
                if !text.is_empty() {
                    text.push_str("\n--- stderr ---\n");
                }
                text.push_str(&out.stderr_text());
            }
            if out.stdout_truncated || out.stderr_truncated {
                text = format!("[earlier output omitted]\n{text}");
            }
            let status = if out.timed_out {
                CheckStatus::TimedOut
            } else if out.status == Some(0) {
                CheckStatus::Passed
            } else {
                CheckStatus::Failed
            };
            (status, out.status, text)
        }
        Err(HabiError::Cancelled) => (CheckStatus::Cancelled, None, String::new()),
        Err(e) => (CheckStatus::Error, None, e.to_string()),
    };
    let output_tail = crate::redact::redact(&output);
    let run = CheckRun {
        id,
        item_key: preview.item_key.clone(),
        item_digest: preview.item_digest.clone(),
        check_id: preview.check_id.clone(),
        module: preview.module.clone(),
        argv,
        cwd: preview.cwd.clone(),
        project_fingerprint: fingerprint.to_string(),
        started_at,
        finished_at: Some(crate::time::now()),
        exit_code,
        status,
        output_tail,
    };
    store.conn()?.execute(
        "INSERT INTO check_runs (id, project_id, item_key, item_digest, check_id, module, argv_json, cwd,
         project_fingerprint, started_at, finished_at, exit_code, status, output_tail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            run.id,
            project_id,
            run.item_key,
            run.item_digest,
            run.check_id,
            run.module,
            serde_json::to_string(&run.argv).unwrap_or_default(),
            run.cwd,
            run.project_fingerprint,
            run.started_at,
            run.finished_at,
            run.exit_code,
            serde_json::to_string(&run.status).unwrap_or_default().trim_matches('"'),
            run.output_tail
        ],
    )?;
    Ok(run)
}

const RUN_COLUMNS: &str =
    "id, item_key, item_digest, check_id, module, argv_json, cwd, project_fingerprint,
                started_at, finished_at, exit_code, status, output_tail";

fn run_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CheckRun> {
    let status: String = r.get(11)?;
    Ok(CheckRun {
        id: r.get(0)?,
        item_key: r.get(1)?,
        item_digest: r.get(2)?,
        check_id: r.get(3)?,
        module: r.get(4)?,
        argv: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
        cwd: r.get(6)?,
        project_fingerprint: r.get(7)?,
        started_at: r.get(8)?,
        finished_at: r.get(9)?,
        exit_code: r.get(10)?,
        status: serde_json::from_str(&format!("\"{status}\"")).unwrap_or(CheckStatus::Error),
        output_tail: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
    })
}

pub fn runs(store: &Store, project_id: &str, item_key: &str) -> Result<Vec<CheckRun>> {
    let conn = store.conn()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS}
         FROM check_runs WHERE project_id = ?1 AND item_key = ?2 ORDER BY started_at DESC LIMIT 20"
    ))?;
    let rows = stmt.query_map([project_id, item_key], run_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Latest non-cancelled result for each check/module pair, across every item.
/// Unlike the bounded history, repeated runs of one check cannot hide a
/// different check's failure or leave an assessed module out of the summary.
pub fn runs_by_item(
    store: &Store,
    project_id: &str,
) -> Result<std::collections::HashMap<String, Vec<CheckRun>>> {
    let conn = store.conn()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM (
             SELECT *, ROW_NUMBER() OVER (
                 PARTITION BY item_key, check_id, module ORDER BY started_at DESC, id DESC
             ) AS n
             FROM check_runs WHERE project_id = ?1 AND status != 'cancelled'
         ) WHERE n = 1 ORDER BY item_key, started_at DESC, id DESC"
    ))?;
    let mut by_item: std::collections::HashMap<String, Vec<CheckRun>> =
        std::collections::HashMap::new();
    for run in stmt.query_map([project_id], run_from_row)? {
        let run = run?;
        by_item.entry(run.item_key.clone()).or_default().push(run);
    }
    Ok(by_item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_keep_the_latest_result_per_check_and_module() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("habi.db")).unwrap();
        let conn = store.conn().unwrap();
        // Twenty-five runs of one item (only the newest 20 are kept), one of
        // another, and one in another project.
        let rows = (0..25)
            .map(|i| ("p1", "a#x", i))
            .chain([("p1", "b#y", 0), ("p2", "a#x", 0)]);
        for (n, (project, key, i)) in rows.enumerate() {
            conn.execute(
                "INSERT INTO check_runs (id, project_id, item_key, item_digest, check_id, module,
                 argv_json, cwd, project_fingerprint, started_at, status)
                 VALUES (?1, ?2, ?3, 'd', 'c', 'm', '[]', '.', 'f', ?4, 'passed')",
                params![
                    format!("r{n}"),
                    project,
                    key,
                    format!("2026-01-01T00:00:{i:02}Z")
                ],
            )
            .unwrap();
        }
        let all = runs_by_item(&store, "p1").unwrap();
        assert_eq!(all.len(), 2);
        for key in ["a#x", "b#y"] {
            let one = runs(&store, "p1", key).unwrap();
            let ids = |v: &[CheckRun]| v.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
            assert_eq!(ids(&all[key]), ids(&one[..1]), "{key}");
        }
        assert_eq!(all["a#x"].len(), 1);
        assert_eq!(all["a#x"][0].started_at, "2026-01-01T00:00:24Z");
        conn.execute(
            "INSERT INTO check_runs (id, project_id, item_key, item_digest, check_id, module,
             argv_json, cwd, project_fingerprint, started_at, status)
             VALUES ('old-failure', 'p1', 'a#x', 'd', 'other', 'backend', '[]', '.', 'f',
                     '2025-01-01T00:00:00Z', 'failed')",
            [],
        )
        .unwrap();
        let all = runs_by_item(&store, "p1").unwrap();
        assert_eq!(
            all["a#x"].len(),
            2,
            "failure survives more than twenty other runs"
        );
        assert!(runs_by_item(&store, "none").unwrap().is_empty());
    }
}
