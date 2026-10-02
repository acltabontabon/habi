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
use std::path::{Path, PathBuf};
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
            std::fs::create_dir_all(&dir)
                .map_err(|e| HabiError::io(format!("creating {}", dir.display()), e))?;
        }
        Ok(())
    }
}

/// Handle to the SQLite database. Connections are opened per operation, so
/// the handle is cheap to clone and safe to share between threads; WAL mode
/// and a busy timeout let the desktop app and the CLI use it concurrently.
#[derive(Debug, Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    /// Opens (creating and migrating if needed) the database at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        let store = Store {
            path: path.to_path_buf(),
        };
        let mut conn = store.connect_raw()?;
        migrations::migrate(&mut conn, path)?;
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
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(conn)
    }

    pub fn conn(&self) -> Result<Connection> {
        self.connect_raw()
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
}
