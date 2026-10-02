//! Content-addressed blob store.
//!
//! Library snapshots, installation baselines and backups are stored by their
//! SHA-256 digest. Reads verify the digest, so corruption is detected rather
//! than propagated into a project.

use crate::error::{HabiError, Result};
use crate::fsutil::{atomic_write, sha256};
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

    /// Stores `bytes` and returns their digest. Idempotent.
    pub fn put(&self, bytes: &[u8]) -> Result<String> {
        let digest = sha256(bytes);
        let path = self.path_for(&digest)?;
        // Content stored before is marked as just used: maintenance spares
        // recent objects, and the caller is about to refer to this one.
        let reused = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(std::time::SystemTime::now()))
            .is_ok();
        if !reused {
            atomic_write(&path, bytes)?;
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
}
