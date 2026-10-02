//! Versioned schema migrations, tracked with `PRAGMA user_version`.
//!
//! Each migration runs in a transaction. Before migrating an existing
//! database, a copy is kept next to it (`habi.db.pre-v<N>.bak`) so a failed
//! or unwanted upgrade never destroys local state. A database written by a
//! newer Habi is refused rather than modified.

use crate::error::{HabiError, Result};
use rusqlite::Connection;
use std::path::Path;

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        location TEXT NOT NULL,
        subdir TEXT,
        ref_kind TEXT NOT NULL,
        ref_name TEXT,
        created_at TEXT NOT NULL,
        snapshot TEXT,
        snapshot_at TEXT,
        last_attempt_at TEXT,
        last_error_code TEXT,
        last_error TEXT,
        warning TEXT
    );
    CREATE TABLE snapshots (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        snapshot TEXT NOT NULL,
        resolved_ref TEXT,
        commit_summary TEXT,
        created_at TEXT NOT NULL,
        files_json TEXT NOT NULL,
        PRIMARY KEY (source_id, snapshot)
    );
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        exclusions_json TEXT NOT NULL DEFAULT '[]',
        clients_json TEXT
    );
    CREATE TABLE declarations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        module TEXT NOT NULL,
        subject_json TEXT NOT NULL,
        present INTEGER NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE check_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_digest TEXT NOT NULL,
        check_id TEXT NOT NULL,
        module TEXT NOT NULL,
        argv_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        project_fingerprint TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        status TEXT NOT NULL,
        output_tail TEXT
    );
    CREATE INDEX check_runs_by_item ON check_runs (project_id, item_key);
    CREATE TABLE contributions (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        item_path TEXT NOT NULL,
        title TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        commit_id TEXT,
        state TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_url TEXT,
        patch_path TEXT
    );
    CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
    );
    CREATE INDEX operations_by_project ON operations (project_id, created_at);
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2: local skills (drafts and imported editable copies). Content lives
    // in `<data>/skills/<id>/package`; this table holds identity and origin.
    r#"
    CREATE TABLE local_skills (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        origin_digest TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    "#,
    // v3: whether a library is the team's own or a community one (not
    // reviewed by the team). A user's classification, changeable any time.
    r#"
    ALTER TABLE sources ADD COLUMN role TEXT NOT NULL DEFAULT 'team';
    "#,
    // v4: changed files the author leaves out of a contribution (a JSON list
    // of paths in the skill folder). A column of its own, so saving the
    // reviewer form never overwrites a selection made meanwhile.
    r#"
    ALTER TABLE contributions ADD COLUMN excluded_json TEXT NOT NULL DEFAULT '[]';
    "#,
];

pub const LATEST: i64 = MIGRATIONS.len() as i64;

pub fn migrate(conn: &mut Connection, path: &Path) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > LATEST {
        return Err(HabiError::Unsupported(format!(
            "the local database (schema v{current}) was created by a newer version of Habi; this version understands up to v{LATEST}. Update Habi, or move {} aside to start fresh.",
            path.display()
        )));
    }
    if current == LATEST {
        return Ok(());
    }
    if current > 0 {
        // Keep a copy of the pre-migration database.
        let backup = path.with_extension(format!("db.pre-v{}.bak", current + 1));
        if !backup.exists() {
            conn.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
                .map_err(|e| {
                    HabiError::Internal(format!(
                        "could not back up the database before migrating: {e}"
                    ))
                })?;
        }
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = index as i64 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql).map_err(|e| {
            HabiError::Internal(format!(
                "database migration to v{version} failed: {e}. The previous database is unchanged."
            ))
        })?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}
