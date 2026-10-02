//! Keeping Habi's own data from growing without bound.
//!
//! Every apply keeps a journal and the earlier content of the files it
//! changed, and every refresh that finds new library content keeps a
//! snapshot. `prune` keeps:
//! - per project, the newest `KEEP` journals plus every operation that is
//!   unfinished or needs attention (never pruned: they are how files are
//!   put back);
//! - per library, the current snapshot, the newest `KEEP` others, and every
//!   snapshot a contribution or a skill copied from the library is based on;
//!
//! and then removes content-store objects none of those refer to. Objects
//! written or reused within the last hour are spared: a refresh or apply
//! running meanwhile may be about to refer to them. Projects and libraries
//! busy with another operation are skipped, not waited for.

use crate::error::{HabiError, Result};
use crate::install::apply::{self, JournalState};
use crate::store::{AppPaths, ResourceLock, Store};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{Duration, SystemTime};
use ts_rs::TS;

/// How many finished operations per project, and earlier snapshots per
/// library, are kept.
pub const KEEP: usize = 20;

/// Objects younger than this are never removed.
const GRACE: Duration = Duration::from_secs(60 * 60);

/// After an apply, everything is pruned at most this often; otherwise only
/// the project's own journals.
const FULL_INTERVAL_SECONDS: i64 = 24 * 60 * 60;

const LAST_FULL_KEY: &str = "maintenance:last-prune";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PruneReport {
    /// Records of finished operations removed (beyond the newest per project).
    pub operations_removed: u32,
    /// Earlier library snapshots removed.
    pub snapshots_removed: u32,
    /// Stored file contents removed because nothing kept refers to them.
    pub objects_removed: u32,
    pub bytes_freed: u64,
    /// Projects and libraries skipped because another operation was using them.
    pub skipped_busy: u32,
}

/// Prunes everything, keeping `KEEP` of each.
pub fn prune(paths: &AppPaths, store: &Store) -> Result<PruneReport> {
    prune_keeping(paths, store, KEEP)
}

/// `prune`, keeping the newest `keep` finished operations per project and
/// earlier snapshots per library.
pub fn prune_keeping(paths: &AppPaths, store: &Store, keep: usize) -> Result<PruneReport> {
    let mut report = PruneReport::default();
    let mut referenced = HashSet::new();
    for project_id in journal_projects(paths) {
        prune_journals(
            paths,
            store,
            &project_id,
            keep,
            &mut report,
            &mut referenced,
        );
    }
    prune_snapshots(paths, store, keep, &mut report, &mut referenced)?;
    remove_unreferenced(paths, &referenced, &mut report)?;
    store.set_setting(LAST_FULL_KEY, &crate::time::now())?;
    tracing::info!(?report, "pruned Habi's data");
    Ok(report)
}

/// Upkeep after a successful apply: the project's own journals beyond the
/// newest `KEEP`, and everything else at most once a day.
pub fn after_apply(paths: &AppPaths, store: &Store, project_id: &str) -> Result<PruneReport> {
    let due = store
        .setting(LAST_FULL_KEY)?
        .and_then(|last| crate::time::seconds_between(&last, &crate::time::now()))
        .is_none_or(|elapsed| !(0..FULL_INTERVAL_SECONDS).contains(&elapsed));
    if due {
        return prune(paths, store);
    }
    let mut report = PruneReport::default();
    prune_journals(
        paths,
        store,
        project_id,
        KEEP,
        &mut report,
        &mut HashSet::new(),
    );
    Ok(report)
}

/// Projects that have journals (folders under `<data>/journal`).
fn journal_projects(paths: &AppPaths) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(paths.journal()) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

fn add_journal_refs(journal: &apply::Journal, referenced: &mut HashSet<String>) {
    for step in &journal.steps {
        referenced.extend(step.before.iter().cloned());
        referenced.extend(step.after.iter().cloned());
    }
}

/// Removes a project's finished journals beyond the newest `keep`, and adds
/// what the remaining ones refer to to `referenced`. A project another
/// operation is using is left as it is (its journals all count as kept).
fn prune_journals(
    paths: &AppPaths,
    store: &Store,
    project_id: &str,
    keep: usize,
    report: &mut PruneReport,
    referenced: &mut HashSet<String>,
) {
    let lock = ResourceLock::acquire(
        paths,
        &format!("project-{project_id}"),
        Duration::from_millis(200),
    );
    let journals = apply::load_all(paths, project_id);
    if lock.is_err() {
        report.skipped_busy += 1;
        for journal in &journals {
            add_journal_refs(journal, referenced);
        }
        return;
    }
    let mut finished = 0;
    for journal in &journals {
        // Newest first; unfinished operations and ones needing attention
        // are always kept and do not count towards `keep`.
        let done = matches!(
            journal.state,
            JournalState::Committed | JournalState::RolledBack
        );
        if done {
            finished += 1;
        }
        if !done || finished <= keep {
            add_journal_refs(journal, referenced);
            continue;
        }
        let file = apply::journal_dir(paths, project_id).join(format!("{}.json", journal.id));
        match std::fs::remove_file(&file) {
            Ok(()) => {
                report.operations_removed += 1;
                if let Err(e) = store.conn().and_then(|c| {
                    Ok(c.execute("DELETE FROM operations WHERE id = ?1", [&journal.id])?)
                }) {
                    tracing::warn!(error = %e, "could not remove an operation from the history table");
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, path = %file.display(), "could not remove a journal");
                add_journal_refs(journal, referenced);
            }
        }
    }
}

/// Every string field named `snapshot` in a JSON document (origins of
/// contributions and local skills record the snapshot they were based on).
fn snapshot_fields(value: &serde_json::Value, out: &mut HashSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, v) in map {
                match v {
                    serde_json::Value::String(s) if key == "snapshot" => {
                        out.insert(s.clone());
                    }
                    _ => snapshot_fields(v, out),
                }
            }
        }
        serde_json::Value::Array(items) => {
            for v in items {
                snapshot_fields(v, out);
            }
        }
        _ => {}
    }
}

#[derive(Deserialize)]
struct Listing {
    files: Vec<ListedFile>,
}

#[derive(Deserialize)]
struct ListedFile {
    digest: String,
}

/// Removes earlier snapshots of every library beyond the newest `keep`
/// (keeping the current one and those something is based on), and adds
/// what the remaining ones refer to to `referenced`.
fn prune_snapshots(
    paths: &AppPaths,
    store: &Store,
    keep: usize,
    report: &mut PruneReport,
    referenced: &mut HashSet<String>,
) -> Result<()> {
    let conn = store.conn()?;
    // Snapshots something else is based on, by source and by value.
    let mut based_on: HashSet<String> = HashSet::new();
    let mut bases: HashSet<(String, String)> = HashSet::new();
    {
        let mut stmt =
            conn.prepare("SELECT source_id, base_commit, origin_json FROM contributions")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (source, base, origin) = row?;
            bases.insert((source, base));
            if let Ok(value) = serde_json::from_str(&origin) {
                snapshot_fields(&value, &mut based_on);
            }
        }
        let mut stmt = conn.prepare("SELECT origin_json FROM local_skills")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for origin in rows {
            if let Ok(value) = serde_json::from_str(&origin?) {
                snapshot_fields(&value, &mut based_on);
            }
        }
    }
    let sources: Vec<(String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, snapshot FROM sources")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (id, current) in sources {
        let lock =
            ResourceLock::acquire(paths, &format!("source-{id}"), Duration::from_millis(200));
        if lock.is_err() {
            report.skipped_busy += 1;
        } else {
            let snapshots: Vec<String> = {
                let mut stmt = conn.prepare(
                    "SELECT snapshot FROM snapshots WHERE source_id = ?1 ORDER BY created_at DESC, rowid DESC",
                )?;
                stmt.query_map([&id], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            let mut earlier = 0;
            for snapshot in snapshots {
                if current.as_deref() == Some(snapshot.as_str()) {
                    continue;
                }
                earlier += 1;
                let needed = earlier <= keep
                    || based_on.contains(&snapshot)
                    || bases.contains(&(id.clone(), snapshot.clone()));
                if !needed {
                    report.snapshots_removed += conn.execute(
                        "DELETE FROM snapshots WHERE source_id = ?1 AND snapshot = ?2",
                        [&id, &snapshot],
                    )? as u32;
                }
            }
        }
        drop(lock);
    }
    // Everything still listed is kept, including snapshots of libraries
    // that were busy.
    let mut stmt = conn.prepare("SELECT files_json FROM snapshots")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for json in rows {
        let json = json?;
        let listing: Listing = serde_json::from_str(&json).map_err(|e| {
            HabiError::Internal(format!(
                "a cached snapshot listing is unreadable ({e}); nothing was removed from the content store"
            ))
        })?;
        referenced.extend(listing.files.into_iter().map(|f| f.digest));
    }
    Ok(())
}

/// Removes content-store objects nobody refers to (and temporary files a
/// crash left behind), sparing anything changed within `GRACE`.
fn remove_unreferenced(
    paths: &AppPaths,
    referenced: &HashSet<String>,
    report: &mut PruneReport,
) -> Result<()> {
    let root = paths.blobs().join("sha256");
    let Ok(prefixes) = std::fs::read_dir(&root) else {
        return Ok(());
    };
    let cutoff = SystemTime::now()
        .checked_sub(GRACE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for prefix in prefixes.flatten() {
        let dir = prefix.path();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let head = prefix.file_name().to_string_lossy().into_owned();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() || meta.modified().is_ok_and(|m| m > cutoff) {
                continue;
            }
            let leftover = name.starts_with(".habi-tmp-");
            if !leftover && referenced.contains(&format!("sha256:{head}{name}")) {
                continue;
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => {
                    report.bytes_freed += meta.len();
                    if !leftover {
                        report.objects_removed += 1;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, path = %entry.path().display(), "could not remove a stored object")
                }
            }
        }
        // Only succeeds once the folder is empty.
        let _ = std::fs::remove_dir(&dir);
    }
    Ok(())
}
