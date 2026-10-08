//! Content-addressed blob store.
//!
//! Library snapshots, installation baselines and backups are stored by their
//! SHA-256 digest. Reads verify the digest, so corruption is detected rather
//! than propagated into a project.
//!
//! Content is stored in one of two ways, and the difference matters:
//!
//! - `put` is durable: the blob is flushed to disk before it returns. It is for
//!   content that may be the only copy anywhere: the backups of project files
//!   an install keeps before replacing them (the journal's way back), what the
//!   install wrote (the baseline later diffs compare against), and the
//!   baselines of imported skills.
//! - `put_cached` is not: the operating system flushes the blob when it likes.
//!   It is for library snapshots, which are copies of a library Habi can fetch
//!   or read again, and which can hold thousands of files: flushing each one
//!   (a full drive-cache flush per file on macOS) makes refreshing a large
//!   library slow. A blob lost or damaged by a crash is caught by the
//!   digest check on read, and the next `put` of the same content replaces it.

use crate::error::{HabiError, Result};
use crate::fsutil::{atomic_write, atomic_write_unsynced, sha256, sync_dir};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Blobs {
    root: PathBuf,
}

impl Blobs {
    pub fn new(root: &Path) -> Self {
        Blobs {
            root: root.to_path_buf(),
        }
    }

    fn path_for(&self, digest: &str) -> Result<PathBuf> {
        let (head, tail) = digest
            .strip_prefix("sha256:")
            .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
            .and_then(|h| h.split_at_checked(2))
            .ok_or_else(|| HabiError::invalid(format!("not a content digest: {digest}")))?;
        Ok(self.root.join("sha256").join(head).join(tail))
    }

    /// Stores `bytes` durably and returns their digest. Idempotent. For content
    /// that may be the only copy, such as an install's backups (see the module
    /// documentation).
    pub fn put(&self, bytes: &[u8]) -> Result<String> {
        self.store(bytes, true)
    }

    /// Stores `bytes` as rebuildable cache and returns their digest: fast, but
    /// a crash soon after may lose the blob. Only for library snapshot content,
    /// never for backups (see the module documentation).
    pub fn put_cached(&self, bytes: &[u8]) -> Result<String> {
        self.store(bytes, false)
    }

    fn store(&self, bytes: &[u8], durable: bool) -> Result<String> {
        let digest = sha256(bytes);
        let path = self.path_for(&digest)?;
        if !reuse(&path, bytes, durable) {
            if durable {
                atomic_write(&path, bytes)?;
            } else {
                atomic_write_unsynced(&path, bytes)?;
            }
        }
        Ok(digest)
    }

    pub fn has(&self, digest: &str) -> bool {
        self.path_for(digest).map(|p| p.exists()).unwrap_or(false)
    }

    pub fn get(&self, digest: &str) -> Result<Vec<u8>> {
        let path = self.path_for(digest)?;
        let bytes = std::fs::read(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                HabiError::NotFound(format!("cached content {}", crate::fsutil::short(digest)))
            } else {
                HabiError::io("reading cached content", e)
            }
        })?;
        if sha256(&bytes) != digest {
            return Err(HabiError::Internal(format!(
                "cached content {} is corrupted; refresh the source to restore it",
                crate::fsutil::short(digest)
            )));
        }
        Ok(bytes)
    }
}

/// Keeps a blob stored before, if it still holds `bytes`, and marks it as just
/// used: maintenance spares recent objects, and the caller is about to refer to
/// this one. False means it must be written again.
///
/// The content is compared because a blob stored as cache may have been left
/// empty or damaged by a crash; keeping it would make the damage permanent.
/// For a durable store the blob is also flushed, since the earlier store may
/// have been a cached one that never reached the disk.
fn reuse(path: &Path, bytes: &[u8], durable: bool) -> bool {
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    else {
        return false;
    };
    if file.metadata().map(|m| m.len()).ok() != Some(bytes.len() as u64) {
        return false;
    }
    let mut existing = Vec::with_capacity(bytes.len());
    let intact = (&mut file)
        .take(bytes.len() as u64)
        .read_to_end(&mut existing)
        .is_ok()
        && existing == bytes;
    if !intact || file.set_modified(std::time::SystemTime::now()).is_err() {
        return false;
    }
    if durable {
        if file.sync_all().is_err() {
            return false;
        }
        if let Some(dir) = path.parent()
            && sync_dir(dir).is_err()
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_detects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = Blobs::new(dir.path());
        let d = blobs.put(b"hello").unwrap();
        assert_eq!(blobs.get(&d).unwrap(), b"hello");
        assert!(blobs.has(&d));
        std::fs::write(blobs.path_for(&d).unwrap(), b"tampered").unwrap();
        assert!(blobs.get(&d).is_err());
        assert!(blobs.get("sha256:../../etc/passwd").is_err());
    }

    #[test]
    fn storing_again_repairs_a_damaged_blob() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = Blobs::new(dir.path());
        let d = blobs.put_cached(b"snapshot content").unwrap();
        let path = blobs.path_for(&d).unwrap();
        // What a crash can leave of a blob the system had not yet flushed.
        std::fs::write(&path, b"").unwrap();
        assert!(blobs.get(&d).is_err());
        assert_eq!(blobs.put_cached(b"snapshot content").unwrap(), d);
        assert_eq!(blobs.get(&d).unwrap(), b"snapshot content");
        std::fs::write(&path, b"snapshot c0ntent").unwrap();
        assert_eq!(blobs.put(b"snapshot content").unwrap(), d);
        assert_eq!(blobs.get(&d).unwrap(), b"snapshot content");
    }
}
