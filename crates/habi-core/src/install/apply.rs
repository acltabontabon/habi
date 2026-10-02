//! Applying plans safely.
//!
//! Multi-file changes cannot be one atomic file-system transaction, so Habi
//! uses a write-ahead journal:
//!
//! 1. Take the project lock (shared by the desktop app and the CLI).
//! 2. Roll back any operation a previous crash left unfinished.
//! 3. Re-check every precondition: each file must still have the digest the
//!    plan saw. Any difference means the preview is stale.
//! 4. Save the current content of every file that will change into the blob
//!    store, then write the journal (state `applying`) to disk.
//! 5. Apply each change with an atomic replace, marking progress in the journal.
//! 6. Mark the journal `committed`.
//!
//! If a step fails, completed steps are undone and the journal is marked
//! `rolledBack`. If the process dies, the next operation on the project (or
//! `recover`) finds the `applying` journal and undoes it. Undo only restores
//! a file whose content is still exactly what Habi wrote; anything else is
//! left alone and reported (`needsAttention`), never overwritten.

use super::plan::{Plan, RestoreStep};
use crate::error::{HabiError, Result};
use crate::fsutil::{atomic_write, atomic_write_mode, sha256, sync_dir};
use crate::paths::{RelPath, resolve_for_write};
use crate::store::cas::Blobs;
use crate::store::{AppPaths, ResourceLock, Store};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum JournalState {
    Applying,
    Committed,
    RolledBack,
    /// Some files could not be restored automatically; see the journal.
    NeedsAttention,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStep {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub done: bool,
    /// Whether the file was executable before the step (Unix; `None` if it
    /// did not exist, on other platforms, and in older journals).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_executable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub id: String,
    pub project_id: String,
    pub project_root: PathBuf,
    pub title: String,
    pub action: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub state: JournalState,
    pub steps: Vec<JournalStep>,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationSummary {
    pub id: String,
    pub title: String,
    pub action: String,
    pub state: JournalState,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub files: Vec<String>,
    pub problems: Vec<String>,
}

impl From<&Journal> for OperationSummary {
    fn from(j: &Journal) -> Self {
        OperationSummary {
            id: j.id.clone(),
            title: j.title.clone(),
            action: j.action.clone(),
            state: j.state,
            created_at: j.created_at.clone(),
            finished_at: j.finished_at.clone(),
            files: j.steps.iter().map(|s| s.path.clone()).collect(),
            problems: j.problems.clone(),
        }
    }
}

/// Test hook for simulating failures. Production code passes `Fault::None`.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    None,
    /// Return an error before step `n` (rollback runs).
    FailBefore(usize),
    /// Stop before step `n` as if the process died (no rollback).
    CrashBefore(usize),
}

/// Stable identifier for a project directory.
pub fn project_id(root: &Path) -> String {
    let digest = sha256(root.to_string_lossy().as_bytes());
    digest["sha256:".len().."sha256:".len() + 16].to_string()
}

fn journal_dir(paths: &AppPaths, project_id: &str) -> PathBuf {
    paths.journal().join(project_id)
}

fn save(paths: &AppPaths, journal: &Journal) -> Result<()> {
    let path = journal_dir(paths, &journal.project_id).join(format!("{}.json", journal.id));
    let bytes =
        serde_json::to_vec_pretty(journal).map_err(|e| HabiError::Internal(e.to_string()))?;
    atomic_write(&path, &bytes)
}

fn digest_on_disk(root: &Path, rel: &str) -> Result<Option<String>> {
    Ok(super::plan::read_project_file(root, rel)?.map(|b| sha256(&b)))
}

/// Directories Habi never prunes even when empty.
const KEEP_DIRS: &[&str] = &[
    ".agents",
    ".agents/skills",
    ".claude",
    ".claude/skills",
    ".cursor",
    ".codex",
];

fn prune_empty_parents(root: &Path, rel: &RelPath) {
    let mut current = rel.parent();
    while let Some(dir) = current {
        if KEEP_DIRS.contains(&dir.as_str()) {
            break;
        }
        let full = dir.to_path(root);
        // remove_dir only succeeds on empty directories.
        if std::fs::remove_dir(&full).is_err() {
            break;
        }
        current = dir.parent();
    }
}

fn write_step(
    root: &Path,
    step: &JournalStep,
    content: Option<&[u8]>,
    executable: Option<bool>,
) -> Result<()> {
    let rel = RelPath::new(&step.path)?;
    let target = resolve_for_write(root, &rel)?;
    match content {
        Some(bytes) => {
            atomic_write_mode(&target, bytes, executable)?;
            if sha256(bytes) != step.after.clone().unwrap_or_default() {
                return Err(HabiError::Internal(format!(
                    "content for {rel} does not match the plan"
                )));
            }
        }
        None => {
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(HabiError::io(format!("deleting {rel}"), e)),
            }
            if let Some(parent) = target.parent() {
                sync_dir(parent);
            }
            prune_empty_parents(root, &rel);
        }
    }
    Ok(())
}

/// Sets or clears the executable bits of an existing project file.
fn set_mode(root: &Path, rel: &str, executable: bool) -> Result<()> {
    let rel = RelPath::new(rel)?;
    let target = resolve_for_write(root, &rel)?;
    crate::fsutil::set_executable(&target, executable)
}

/// Whether a project file is executable now (`None` if it does not exist or
/// the platform has no executable bit).
fn executable_on_disk(root: &Path, rel: &str) -> Option<bool> {
    if !cfg!(unix) {
        return None;
    }
    let rel = RelPath::new(rel).ok()?;
    let path = crate::paths::resolve_for_read(root, &rel).ok()??;
    Some(crate::fsutil::is_executable(&path))
}

/// Undoes steps whose result is still on disk. Returns problems for files
/// that changed in the meantime (left untouched).
fn undo(root: &Path, blobs: &Blobs, steps: &[JournalStep]) -> Vec<String> {
    let mut problems = Vec::new();
    for step in steps.iter().rev() {
        let current = match digest_on_disk(root, &step.path) {
            Ok(d) => d,
            Err(e) => {
                problems.push(format!("{}: {e}", step.path));
                continue;
            }
        };
        if current == step.before {
            // Content is as before. A step that changed only the executable
            // bit is undone by restoring the bit.
            if step.done
                && step.before == step.after
                && let Some(executable) = step.before_executable
                && let Err(e) = set_mode(root, &step.path, executable)
            {
                problems.push(format!("{}: {e}", step.path));
            }
            continue;
        }
        if current != step.after {
            problems.push(format!(
                "{} changed after Habi wrote it; it was left as is. Its earlier version is kept in Habi's journal.",
                step.path
            ));
            continue;
        }
        let restore = match &step.before {
            None => None,
            Some(digest) => match blobs.get(digest) {
                Ok(b) => Some(b),
                Err(e) => {
                    problems.push(format!("{}: backup unavailable ({e})", step.path));
                    continue;
                }
            },
        };
        let back = JournalStep {
            path: step.path.clone(),
            before: step.after.clone(),
            after: step.before.clone(),
            done: false,
            before_executable: None,
        };
        if let Err(e) = write_step(root, &back, restore.as_deref(), step.before_executable) {
            problems.push(format!("{}: {e}", step.path));
        }
    }
    problems
}

pub struct Applier<'a> {
    pub paths: &'a AppPaths,
    pub store: &'a Store,
}

impl<'a> Applier<'a> {
    fn blobs(&self) -> Blobs {
        Blobs::new(&self.paths.blobs())
    }

    pub fn lock_project(&self, root: &Path) -> Result<ResourceLock> {
        ResourceLock::acquire(
            self.paths,
            &format!("project-{}", project_id(root)),
            Duration::from_secs(3),
        )
    }

    /// Applies a plan. Returns the committed operation.
    pub fn apply(&self, plan: &Plan) -> Result<OperationSummary> {
        self.apply_with(plan, Fault::None)
    }

    #[doc(hidden)]
    pub fn apply_with(&self, plan: &Plan, fault: Fault) -> Result<OperationSummary> {
        if plan.is_blocked() {
            return Err(HabiError::Conflict(
                "resolve the listed conflicts before applying".into(),
            ));
        }
        if plan.is_empty() {
            return Err(HabiError::invalid(
                "nothing to apply: the project already matches",
            ));
        }
        let root = &plan.root;
        let _lock = self.lock_project(root)?;
        let recovered = self.recover_locked(root)?;
        if recovered
            .iter()
            .any(|r| r.state == JournalState::NeedsAttention)
        {
            tracing::warn!(
                "previous operation needs attention; continuing with precondition checks"
            );
        }

        // Preconditions: every file must still be as the preview saw it. The
        // bytes whose digest was verified are the ones backed up.
        let blobs = self.blobs();
        let mut stale = Vec::new();
        for change in &plan.changes {
            let rel = RelPath::new(&change.path)?;
            resolve_for_write(root, &rel)?;
            let current = super::plan::read_project_file(root, &change.path)?;
            if current.as_ref().map(|b| sha256(b)) != change.before {
                stale.push(change.path.clone());
            } else if let Some(bytes) = &current {
                blobs.put(bytes)?;
            }
            if let Some(content) = &change.content {
                // Keep what Habi writes too: it is the baseline for later diffs.
                blobs.put(content)?;
            }
        }
        if !stale.is_empty() {
            return Err(HabiError::StalePlan(format!(
                "{} changed since the preview ({}). Review the new preview.",
                if stale.len() == 1 { "a file" } else { "files" },
                stale.join(", ")
            )));
        }

        let pid = project_id(root);
        let mut journal = Journal {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            project_id: pid.clone(),
            project_root: root.clone(),
            title: plan.title.clone(),
            action: format!("{:?}", plan.action).to_lowercase(),
            created_at: crate::time::now(),
            finished_at: None,
            state: JournalState::Applying,
            steps: plan
                .changes
                .iter()
                .map(|c| JournalStep {
                    path: c.path.clone(),
                    before: c.before.clone(),
                    after: c.after.clone(),
                    done: false,
                    before_executable: c
                        .before
                        .as_ref()
                        .and_then(|_| executable_on_disk(root, &c.path)),
                })
                .collect(),
            problems: Vec::new(),
        };
        save(self.paths, &journal)?;
        self.record(&journal, &pid);

        // What earlier steps of this plan left at a path (by lower-case path,
        // because a case-only rename touches one file under two names on
        // case-insensitive file systems).
        let mut produced: std::collections::HashMap<String, Option<String>> = Default::default();
        for (index, change) in plan.changes.iter().enumerate() {
            match fault {
                Fault::CrashBefore(n) if n == index => {
                    return Err(HabiError::Internal("simulated crash".into()));
                }
                Fault::FailBefore(n) if n == index => {
                    return Err(self.roll_back(
                        root,
                        &mut journal,
                        HabiError::Internal("simulated failure".into()),
                    ));
                }
                _ => {}
            }
            // Re-check right before writing: an editor may have saved since
            // the preconditions were verified.
            let expected = produced
                .get(&change.path.to_lowercase())
                .cloned()
                .unwrap_or_else(|| change.before.clone());
            match digest_on_disk(root, &change.path) {
                Ok(now) if now == expected => {}
                Ok(_) => {
                    let cause = HabiError::StalePlan(format!(
                        "{} changed while applying; nothing of it was overwritten",
                        change.path
                    ));
                    return Err(self.roll_back(root, &mut journal, cause));
                }
                Err(e) => return Err(self.roll_back(root, &mut journal, e)),
            }
            if let Err(e) = write_step(
                root,
                &journal.steps[index],
                change.content.as_deref(),
                change.executable,
            ) {
                return Err(self.roll_back(root, &mut journal, e));
            }
            produced.insert(change.path.to_lowercase(), change.after.clone());
            journal.steps[index].done = true;
            if let Err(e) = save(self.paths, &journal) {
                return Err(self.roll_back(root, &mut journal, e));
            }
        }
        journal.state = JournalState::Committed;
        journal.finished_at = Some(crate::time::now());
        if let Err(e) = save(self.paths, &journal) {
            // Without a committed journal, recovery would later undo this
            // operation; undo it now and say so instead.
            return Err(self.roll_back(root, &mut journal, e));
        }
        self.record(&journal, &pid);
        tracing::info!(operation = %journal.id, files = journal.steps.len(), "applied plan");
        Ok(OperationSummary::from(&journal))
    }

    fn roll_back(&self, root: &Path, journal: &mut Journal, cause: HabiError) -> HabiError {
        let problems = undo(root, &self.blobs(), &journal.steps);
        journal.state = if problems.is_empty() {
            JournalState::RolledBack
        } else {
            JournalState::NeedsAttention
        };
        journal.problems = problems;
        journal.finished_at = Some(crate::time::now());
        let _ = save(self.paths, journal);
        self.record(journal, &journal.project_id.clone());
        HabiError::Conflict(format!(
            "applying failed and was rolled back{}: {cause}",
            if journal.state == JournalState::NeedsAttention {
                " (some files need attention; see the operation history)"
            } else {
                ""
            }
        ))
    }

    fn record(&self, journal: &Journal, project_id: &str) {
        let result = self.store.conn().and_then(|c| {
            c.execute(
                "INSERT INTO operations (id, project_id, kind, summary, state, created_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at",
                rusqlite::params![
                    journal.id,
                    project_id,
                    journal.action,
                    journal.title,
                    format!("{:?}", journal.state),
                    journal.created_at,
                    journal.finished_at
                ],
            )
            .map_err(HabiError::from)
        });
        if let Err(e) = result {
            tracing::warn!(error = %e, "could not record operation history; the journal file remains authoritative");
        }
    }

    fn journals(&self, root: &Path) -> Result<Vec<Journal>> {
        let dir = journal_dir(self.paths, &project_id(root));
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(out);
        };
        for entry in entries.flatten() {
            if entry.path().extension().is_some_and(|e| e == "json") {
                match std::fs::read(entry.path())
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Journal>(&b).ok())
                {
                    Some(j) => out.push(j),
                    None => {
                        tracing::warn!(path = %entry.path().display(), "unreadable journal skipped")
                    }
                }
            }
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    /// Rolls back operations a crash left unfinished. Takes the project lock.
    pub fn recover(&self, root: &Path) -> Result<Vec<OperationSummary>> {
        let _lock = self.lock_project(root)?;
        self.recover_locked(root)
    }

    fn recover_locked(&self, root: &Path) -> Result<Vec<OperationSummary>> {
        let mut recovered = Vec::new();
        for mut journal in self.journals(root)? {
            if journal.state != JournalState::Applying {
                continue;
            }
            let problems = undo(root, &self.blobs(), &journal.steps);
            journal.state = if problems.is_empty() {
                JournalState::RolledBack
            } else {
                JournalState::NeedsAttention
            };
            journal.problems = problems;
            journal.finished_at = Some(crate::time::now());
            save(self.paths, &journal)?;
            self.record(&journal, &journal.project_id.clone());
            tracing::warn!(operation = %journal.id, state = ?journal.state, "recovered an interrupted operation");
            recovered.push(OperationSummary::from(&journal));
        }
        Ok(recovered)
    }

    pub fn history(&self, root: &Path) -> Result<Vec<OperationSummary>> {
        Ok(self
            .journals(root)?
            .iter()
            .map(OperationSummary::from)
            .collect())
    }

    /// Steps to restore the files an operation changed.
    pub fn restore_steps(
        &self,
        root: &Path,
        operation_id: &str,
    ) -> Result<(String, Vec<RestoreStep>)> {
        let journal = self
            .journals(root)?
            .into_iter()
            .find(|j| j.id == operation_id)
            .ok_or_else(|| HabiError::NotFound(format!("operation {operation_id}")))?;
        if journal.state != JournalState::Committed {
            return Err(HabiError::invalid(
                "only completed operations can be restored; interrupted ones are rolled back automatically",
            ));
        }
        let blobs = self.blobs();
        let mut steps = Vec::new();
        for s in journal.steps.iter().rev() {
            let content = match &s.before {
                None => None,
                Some(d) => Some(blobs.get(d)?),
            };
            // The lock file is recomputed rather than restored, which needs
            // what the operation wrote to it.
            let written = match &s.after {
                Some(d) if s.path == crate::brand::LOCK_FILE => Some(blobs.get(d)?),
                _ => None,
            };
            steps.push(RestoreStep {
                path: s.path.clone(),
                expected: s.after.clone(),
                content,
                executable: s.before_executable,
                written,
            });
        }
        Ok((journal.title, steps))
    }
}
