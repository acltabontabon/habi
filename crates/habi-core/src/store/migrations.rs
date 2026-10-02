//! Versioned schema migrations, tracked with `PRAGMA user_version`.
//!
//! Each migration runs in a transaction. Before migrating an existing
//! database, a copy is kept next to it (`habi.db.pre-v<N>.bak`) so a failed
//! or unwanted upgrade never destroys local state. A database written by a
//! newer Habi is refused rather than modified.

use crate::error::{HabiError, Result};
use rusqlite::{Connection, TransactionBehavior};
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
    // v5: libraries of the sample workspace, so they are recognized by a
    // flag rather than by name, and kept out of the user's own projects.
    r#"
    ALTER TABLE sources ADD COLUMN sample INTEGER NOT NULL DEFAULT 0;
    "#,
    // v6: how many items a snapshot holds, so library lists can say so
    // without building every library's index. NULL until counted.
    r#"
    ALTER TABLE snapshots ADD COLUMN item_count INTEGER;
    "#,
    // v7: the library catalog. A source can be a hidden preview (fetched so
    // it can be inspected, not yet connected), remember which catalog entry it
    // came from, and read only part of its repository (`include_json` and
    // `exclude_json` are globs, applied before the size limits). The default
    // branch is what the remote's HEAD named at the last check. A snapshot
    // keeps its derived summary (licence, signal counts) so lists do not
    // rebuild every index.
    r#"
    ALTER TABLE sources ADD COLUMN preview INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sources ADD COLUMN catalog_id TEXT;
    ALTER TABLE sources ADD COLUMN include_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE sources ADD COLUMN exclude_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE sources ADD COLUMN default_branch TEXT;
    ALTER TABLE snapshots ADD COLUMN summary_json TEXT;
    "#,
];

pub const LATEST: i64 = MIGRATIONS.len() as i64;

fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Migrates to `LATEST`. Safe to run from several processes at once (the
/// desktop app and the CLI starting together): each step takes the write
/// lock first (`BEGIN IMMEDIATE`) and re-reads the version under it, so a
/// step another process already applied is skipped.
pub fn migrate(conn: &mut Connection, path: &Path) -> Result<()> {
    let current = user_version(conn)?;
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
        // Keep a copy of the pre-migration database. Another process may be
        // writing the same copy right now; once it exists, that is enough.
        let backup = path.with_extension(format!("db.pre-v{}.bak", current + 1));
        if !backup.exists()
            && let Err(e) = conn.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
            && !backup.exists()
        {
            return Err(HabiError::Internal(format!(
                "could not back up the database before migrating: {e}"
            )));
        }
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = index as i64 + 1;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if user_version(&tx)? >= version {
            // Applied by another process while this one waited.
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::sync::{Arc, Barrier};

    /// Opens the database at `path` from two threads at the same moment.
    fn open_twice(path: &Path) {
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let barrier = barrier.clone();
                let path = path.to_path_buf();
                std::thread::spawn(move || {
                    barrier.wait();
                    Store::open(&path).map(|_| ())
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert_eq!(Store::open(path).unwrap().schema_version().unwrap(), LATEST);
    }

    #[test]
    fn concurrent_first_opens_both_succeed() {
        for _ in 0..5 {
            let dir = tempfile::tempdir().unwrap();
            open_twice(&dir.path().join("habi.db"));
        }
    }

    #[test]
    fn upgrading_from_v6_keeps_existing_sources_as_ordinary_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("habi.db");
        let conn = Connection::open(&path).unwrap();
        for sql in &MIGRATIONS[..6] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn.execute(
            "INSERT INTO sources (id, name, kind, location, ref_kind, created_at)
             VALUES ('s1', 'Team', 'git', 'https://example.com/team/skills', 'default', 'now')",
            [],
        )
        .unwrap();
        drop(conn);

        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), LATEST);
        assert!(dir.path().join("habi.db.pre-v7.bak").is_file());
        let conn = store.conn().unwrap();
        let (preview, catalog, include, exclude): (i64, Option<String>, String, String) = conn
            .query_row(
                "SELECT preview, catalog_id, include_json, exclude_json FROM sources WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(preview, 0, "an existing source is not a preview");
        assert_eq!(catalog, None);
        assert_eq!((include.as_str(), exclude.as_str()), ("[]", "[]"));
    }

    #[test]
    fn concurrent_upgrades_both_succeed_and_keep_a_backup() {
        for _ in 0..5 {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("habi.db");
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            drop(conn);
            open_twice(&path);
            assert!(dir.path().join("habi.db.pre-v2.bak").is_file());
        }
    }
}
