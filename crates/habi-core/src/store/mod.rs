//! Local application state: where it lives, and the SQLite database.
//!
//! The database holds machine-local state and caches (registered sources,
//! snapshot listings, projects, declarations, check results, contribution
//! drafts). It is never the authoritative store of shared skill content:
//! that is Git (and the content-addressed blob cache derived from it).

pub mod cas;
mod migrations;

use crate::brand;
use crate::error::{HabiError, Result};
use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

/// Locations of Habi's machine-local data.
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
}

impl AppPaths {
    /// Uses `HABI_HOME` if set, otherwise the platform data directory.
    pub fn from_env() -> Result<Self> {
        if let Some(home) = std::env::var_os(brand::HOME_ENV) {
            // Sources and samples below the root must be absolute paths.
            let home = std::path::absolute(PathBuf::from(home))
                .map_err(|e| HabiError::io("resolving HABI_HOME", e))?;
            return Ok(AppPaths::at(home));
        }
        let (q, o, a) = brand::DIRS;
        let dirs = directories::ProjectDirs::from(q, o, a)
            .ok_or_else(|| HabiError::Internal("no home directory available".into()))?;
        Ok(AppPaths::at(dirs.data_dir().to_path_buf()))
    }

    pub fn at(root: PathBuf) -> Self {
        AppPaths { root }
    }

    pub fn db(&self) -> PathBuf {
        self.root.join("habi.db")
    }
    pub fn blobs(&self) -> PathBuf {
        self.root.join("blobs")
    }
    pub fn sources(&self) -> PathBuf {
        self.root.join("sources")
    }
    pub fn journal(&self) -> PathBuf {
        self.root.join("journal")
    }
    pub fn locks(&self) -> PathBuf {
        self.root.join("locks")
    }
    pub fn contributions(&self) -> PathBuf {
        self.root.join("contributions")
    }
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
    /// Local skills ("My skills"): one folder per draft or imported copy.
    pub fn skills(&self) -> PathBuf {
        self.root.join("skills")
    }
    /// An always-empty directory, used as Git's hooks path so no hook runs.
    pub fn empty_dir(&self) -> PathBuf {
        self.root.join("empty")
    }

    pub fn ensure(&self) -> Result<()> {
        for dir in [
            self.root.clone(),
            self.blobs(),
            self.sources(),
            self.journal(),
            self.locks(),
            self.contributions(),
            self.skills(),
            self.logs(),
            self.empty_dir(),
        ] {
            crate::fsutil::create_dir_all_synced(&dir)?;
            private(&dir, 0o700)?;
        }
        // Log files written by an earlier run, before they were private.
        if let Ok(entries) = std::fs::read_dir(self.logs()) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_file()) {
                    private_found(&entry.path(), 0o600)?;
                }
            }
        }
        Ok(())
    }
}

/// Limits `path` to the current user (unix: `mode`, `0700` for folders and
/// `0600` for files). The journal keeps copies of files Habi overwrote, and
/// the logs and database name projects, so none of it is for other accounts.
/// Windows keeps a profile folder's access rules and needs nothing here.
#[cfg(unix)]
fn private(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| HabiError::io(format!("restricting {}", path.display()), e))
}

#[cfg(not(unix))]
fn private(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

/// `private` for a file a listing found. Another process may remove it before
/// this runs (SQLite deletes a journal when its write ends, and the write-ahead
/// log when the last connection closes); a file that is gone has nothing left
/// to limit, and must not stop this process from opening.
fn private_found(path: &Path, mode: u32) -> Result<()> {
    match private(path, mode) {
        Err(HabiError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(())
        }
        other => other,
    }
}

/// Connections kept open between operations. Beyond this, a connection closes when it is done.
const MAX_IDLE_CONNECTIONS: usize = 4;

/// Handle to the SQLite database. Clones share the connections left open
/// between operations, because opening one costs far more than most queries:
/// it reads the schema and, as the only connection, sets up and removes the
/// write-ahead log. The handle is cheap to clone and safe to share between
/// threads; WAL mode and a busy timeout let the desktop app and the CLI use it
/// concurrently.
#[derive(Debug, Clone)]
pub struct Store {
    path: PathBuf,
    pool: Arc<Pool>,
}

/// The connections left open between operations.
#[derive(Debug, Default)]
struct Pool {
    idle: Mutex<Vec<Connection>>,
    /// The app is quitting: a connection closes as soon as its operation ends.
    closing: AtomicBool,
}

/// A connection for one operation. It stays open for the next one when dropped.
#[derive(Debug)]
pub struct StoreConnection {
    conn: Option<Connection>,
    pool: Arc<Pool>,
}

impl Deref for StoreConnection {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("present until dropped")
    }
}

impl DerefMut for StoreConnection {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("present until dropped")
    }
}

impl Drop for StoreConnection {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        // A transaction left open must not reach the next operation: closing rolls it back.
        if conn.is_autocommit() && !self.pool.closing.load(Ordering::Relaxed) {
            let mut idle = self
                .pool
                .idle
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if idle.len() < MAX_IDLE_CONNECTIONS {
                idle.push(conn);
            }
        }
    }
}

impl Store {
    /// Opens (creating and migrating if needed) the database at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        let store = Store {
            path: path.to_path_buf(),
            pool: Arc::default(),
        };
        // Created private from the start, not made private afterwards.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| HabiError::io(format!("opening {}", path.display()), e))?;
        }
        let mut conn = store.connect_raw()?;
        migrations::migrate(&mut conn, path)?;
        // The write-ahead log, shared-memory and pre-migration backup files
        // come and go with the connections; those that exist now are limited
        // like the database.
        if let (Some(dir), Some(name)) = (path.parent(), path.file_name()) {
            let name = name.to_string_lossy().into_owned();
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let file = entry.file_name().to_string_lossy().into_owned();
                let ours = file == name
                    || [format!("{name}-wal"), format!("{name}-shm")].contains(&file)
                    || file.starts_with(&format!("{name}.pre-v"));
                if ours && entry.file_type().is_ok_and(|t| t.is_file()) {
                    private_found(&entry.path(), 0o600)?;
                }
            }
        }
        drop(store.lend(conn));
        Ok(store)
    }

    fn connect_raw(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_secs(10))?;
        // Switching a new database to WAL needs an exclusive lock and does not
        // wait on the busy timeout; another process opening the same new
        // database at the same moment makes it fail with "busy". Retry briefly.
        let started = std::time::Instant::now();
        loop {
            match conn.pragma_update(None, "journal_mode", "WAL") {
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == rusqlite::ErrorCode::DatabaseBusy
                        && started.elapsed() < Duration::from_secs(10) =>
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                result => break result?,
            }
        }
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // A connection stays open, so nothing moves the log into the database
        // when one closes: a commit is made durable when it is written.
        conn.pragma_update(None, "synchronous", "FULL")?;
        Ok(conn)
    }

    fn lend(&self, conn: Connection) -> StoreConnection {
        StoreConnection {
            conn: Some(conn),
            pool: Arc::clone(&self.pool),
        }
    }

    pub fn conn(&self) -> Result<StoreConnection> {
        let idle = self
            .pool
            .idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop();
        let conn = match idle {
            Some(conn) => conn,
            None => self.connect_raw()?,
        };
        Ok(self.lend(conn))
    }

    /// For when the app is about to quit: stops keeping connections open. The
    /// last one to close folds the write-ahead log into the database and
    /// removes it, so the data folder can be copied once Habi has quit.
    pub fn close_connections(&self) {
        self.pool.closing.store(true, Ordering::Relaxed);
        self.pool
            .idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn()?
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn()?
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn()?.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

/// Exclusive, cross-process lock on a named resource (a project, a source).
/// Released when dropped. Fails fast with `Busy` rather than waiting forever.
pub struct ResourceLock {
    _file: std::fs::File,
    name: String,
}

impl ResourceLock {
    pub fn acquire(paths: &AppPaths, name: &str, wait: Duration) -> Result<Self> {
        std::fs::create_dir_all(paths.locks())
            .map_err(|e| HabiError::io("creating the locks directory", e))?;
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let path = paths.locks().join(format!("{safe}.lock"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| HabiError::io(format!("opening lock {}", path.display()), e))?;
        let started = std::time::Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => {
                    return Ok(ResourceLock {
                        _file: file,
                        name: name.to_string(),
                    });
                }
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(std::fs::TryLockError::Error(e)) => {
                    return Err(HabiError::io(format!("locking {name}"), e));
                }
            }
            if started.elapsed() >= wait {
                return Err(HabiError::Busy(name.to_string()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_a_fresh_database() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("habi.db")).unwrap();
        assert_eq!(store.schema_version().unwrap(), migrations::LATEST);
        // Re-opening is a no-op.
        let store = Store::open(&dir.path().join("habi.db")).unwrap();
        store.set_setting("a", "1").unwrap();
        assert_eq!(store.setting("a").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn connections_stay_open_until_closed_and_then_leave_no_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("habi.db");
        let store = Store::open(&path).unwrap();
        store.set_setting("a", "1").unwrap();
        let idle = || store.pool.idle.lock().unwrap().len();
        assert_eq!(idle(), 1);
        {
            let (_first, _second) = (store.conn().unwrap(), store.conn().unwrap());
            assert_eq!(idle(), 0);
        }
        assert_eq!(idle(), 2);
        let held: Vec<_> = (0..MAX_IDLE_CONNECTIONS + 1)
            .map(|_| store.conn().unwrap())
            .collect();
        drop(held);
        assert_eq!(idle(), MAX_IDLE_CONNECTIONS);

        let in_use = store.conn().unwrap();
        store.close_connections();
        assert_eq!(idle(), 0);
        drop(in_use);
        assert_eq!(idle(), 0, "the one still in use closes when it is done");
        assert!(!dir.path().join("habi.db-wal").exists());
        assert!(!dir.path().join("habi.db-shm").exists());
        assert_eq!(store.setting("a").unwrap().as_deref(), Some("1"));
        assert_eq!(idle(), 0);
        assert!(!dir.path().join("habi.db-wal").exists());
    }

    #[test]
    fn a_transaction_left_open_does_not_reach_the_next_operation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("habi.db")).unwrap();
        store
            .conn()
            .unwrap()
            .execute_batch("BEGIN; INSERT INTO settings (key, value) VALUES ('a', '1');")
            .unwrap();
        assert_eq!(store.setting("a").unwrap(), None);
    }

    #[test]
    fn refuses_a_database_from_a_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("habi.db");
        Store::open(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
        drop(conn);
        assert!(Store::open(&path).is_err());
    }

    #[test]
    fn locks_are_exclusive_across_handles() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::at(dir.path().to_path_buf());
        let first = ResourceLock::acquire(&paths, "project-x", Duration::from_millis(10)).unwrap();
        let second = ResourceLock::acquire(&paths, "project-x", Duration::from_millis(100));
        assert!(matches!(second, Err(HabiError::Busy(_))));
        drop(first);
        assert!(ResourceLock::acquire(&paths, "project-x", Duration::from_millis(10)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_gone_before_it_is_restricted_does_not_stop_an_open() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // SQLite removed this journal between the listing and the call.
        let gone = dir.path().join("habi.db.pre-v4.bak-journal");
        private_found(&gone, 0o600).unwrap();
        // Only that is forgiven: a folder Habi just made must exist.
        assert!(private(&gone, 0o600).is_err());
        // Any other failure still says so.
        let file = dir.path().join("habi.db-wal");
        std::fs::write(&file, "x").unwrap();
        assert!(private_found(&file.join("child"), 0o600).is_err());
        // And a file that is there is still limited.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        private_found(&file, 0o600).unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn the_data_folder_and_database_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::at(dir.path().join("data"));
        // A folder and a log from before they were private.
        std::fs::create_dir_all(paths.logs()).unwrap();
        std::fs::set_permissions(paths.root.clone(), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(paths.logs().join("habi.log"), "x").unwrap();
        std::fs::set_permissions(
            paths.logs().join("habi.log"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        paths.ensure().unwrap();
        let store = Store::open(&paths.db()).unwrap();
        store.set_setting("a", "1").unwrap();
        for sub in [paths.root.clone(), paths.journal(), paths.logs()] {
            assert_eq!(mode(&sub), 0o700, "{}", sub.display());
        }
        assert_eq!(mode(&paths.logs().join("habi.log")), 0o600);
        assert_eq!(mode(&paths.db()), 0o600);
        // Re-opening keeps it that way.
        Store::open(&paths.db()).unwrap();
        assert_eq!(mode(&paths.db()), 0o600);
    }
}
