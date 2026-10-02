//! Small file-system helpers: hashing, bounded reads, atomic writes.

use crate::error::{HabiError, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;

/// Hex SHA-256 of `bytes`, prefixed so digests are self-describing.
pub fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{}", hex::encode(h.finalize()))
}

/// `bytes` with CRLF line endings turned into LF, if it is text that has any.
/// Binary content (and text without CRLF) is returned unchanged.
pub fn lf_text(bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if !bytes.windows(2).any(|w| w == b"\r\n") || !is_probably_text(bytes) {
        return std::borrow::Cow::Borrowed(bytes);
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    std::borrow::Cow::Owned(out)
}

/// Digest that ignores line-ending style: SHA-256 of the content with CRLF
/// turned into LF (binary content as is). For LF text it equals `sha256`.
pub fn text_digest(bytes: &[u8]) -> String {
    sha256(&lf_text(bytes))
}

/// True if `bytes` is the content recorded as `digest`, either exactly or
/// with different line endings. Lock files record the digest of what Habi
/// wrote (library content, LF); a checkout with `core.autocrlf=true` turns
/// those files into CRLF without anyone editing them.
pub fn digest_matches(bytes: &[u8], digest: &str) -> bool {
    sha256(bytes) == digest || text_digest(bytes) == digest
}

/// True if two contents are the same apart from line endings.
pub fn same_text(a: &[u8], b: &[u8]) -> bool {
    a == b || lf_text(a) == lf_text(b)
}

/// Digest of a set of (path, content digest) pairs, independent of order.
pub fn tree_digest<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    let mut pairs: Vec<(&str, &str)> = entries.into_iter().collect();
    pairs.sort();
    let mut h = Sha256::new();
    for (path, digest) in pairs {
        h.update(path.as_bytes());
        h.update([0u8]);
        h.update(digest.as_bytes());
        h.update(*b"\n");
    }
    format!("sha256:{}", hex::encode(h.finalize()))
}

/// Short form of a digest or commit for display: its first ten characters.
/// Ids may come from hand-edited files, so the cut is on a character
/// boundary, never in the middle of one.
pub fn short(id: &str) -> &str {
    let id = id.strip_prefix("sha256:").unwrap_or(id);
    match id.char_indices().nth(10) {
        Some((end, _)) => id.get(..end).unwrap_or(id),
        None => id,
    }
}

pub enum Bounded {
    Content(Vec<u8>),
    TooLarge(u64),
}

/// Reads a regular file if it is at most `limit` bytes. Symbolic links are
/// refused by the caller (via `symlink_metadata`) before reaching here.
pub fn read_bounded(path: &Path, limit: u64) -> Result<Bounded> {
    let file = std::fs::File::open(path)
        .map_err(|e| HabiError::io(format!("reading {}", path.display()), e))?;
    let len = file
        .metadata()
        .map_err(|e| HabiError::io(format!("reading {}", path.display()), e))?
        .len();
    if len > limit {
        return Ok(Bounded::TooLarge(len));
    }
    let mut buf = Vec::with_capacity(len as usize);
    // `take` guards against a file that grows while being read.
    file.take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| HabiError::io(format!("reading {}", path.display()), e))?;
    if buf.len() as u64 > limit {
        return Ok(Bounded::TooLarge(buf.len() as u64));
    }
    Ok(Bounded::Content(buf))
}

/// Reads the first `limit` bytes of a file.
pub fn read_prefix(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let mut buf = Vec::with_capacity(limit);
    file.take(limit as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Writes `bytes` to `path` atomically: a temporary file in the same
/// directory is written, flushed to disk and renamed over the target. Readers
/// see either the old or the new content, never a torn write. An existing
/// file keeps its permissions; a new file gets ordinary (0644) permissions.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_write_mode(path, bytes, None)
}

/// Like `atomic_write`, optionally setting (`Some(true)`) or clearing
/// (`Some(false)`) the executable bits, e.g. for skill scripts.
pub fn atomic_write_mode(path: &Path, bytes: &[u8], executable: Option<bool>) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| HabiError::invalid(format!("{} has no parent", path.display())))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| HabiError::io(format!("creating {}", dir.display()), e))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".habi-tmp-")
        .tempfile_in(dir)
        .map_err(|e| HabiError::io(format!("writing in {}", dir.display()), e))?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| HabiError::io(format!("writing {}", path.display()), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let existing = std::fs::symlink_metadata(path)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.permissions().mode() & 0o7777);
        let mut mode = existing.unwrap_or(0o644);
        match executable {
            Some(true) => mode |= (mode & 0o444) >> 2,
            Some(false) => mode &= !0o111,
            None => {}
        }
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| HabiError::io(format!("setting permissions on {}", path.display()), e))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    tmp.persist(path)
        .map_err(|e| HabiError::io(format!("replacing {}", path.display()), e.error))?;
    sync_dir(dir);
    Ok(())
}

/// Sets (`true`) or clears (`false`) the executable bits of a regular file,
/// the same way `atomic_write_mode` does. Does nothing on platforms without
/// Unix permissions.
pub fn set_executable(path: &Path, executable: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::symlink_metadata(path)
            .map_err(|e| HabiError::io(format!("reading {}", path.display()), e))?;
        if !meta.is_file() {
            return Ok(());
        }
        let mut mode = meta.permissions().mode() & 0o7777;
        if executable {
            mode |= (mode & 0o444) >> 2;
        } else {
            mode &= !0o111;
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| HabiError::io(format!("setting permissions on {}", path.display()), e))?;
    }
    #[cfg(not(unix))]
    let _ = (path, executable);
    Ok(())
}

/// True if the file at `path` has an executable bit set (always false on
/// platforms without Unix permissions).
pub fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// Best-effort directory fsync so a rename survives power loss (Unix only).
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(f) = std::fs::File::open(dir) {
        let _ = f.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Is this byte buffer probably text? Used to decide whether to show a diff.
pub fn is_probably_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_ids_cut_on_character_boundaries() {
        assert_eq!(short("sha256:0123456789abcdef"), "0123456789");
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("ééééééééééééé"), "éééééééééé");
        assert_eq!(short("a€€€€€€€€€€€"), "a€€€€€€€€€");
    }

    #[test]
    fn tree_digest_is_order_independent() {
        let a = tree_digest([("a", "1"), ("b", "2")]);
        let b = tree_digest([("b", "2"), ("a", "1")]);
        assert_eq!(a, b);
        assert_ne!(a, tree_digest([("a", "2"), ("b", "1")]));
    }

    #[test]
    fn line_endings_do_not_change_text_digests() {
        let lf = b"a\nb\n";
        let crlf = b"a\r\nb\r\n";
        assert!(digest_matches(crlf, &sha256(lf)));
        assert!(digest_matches(lf, &sha256(lf)));
        assert!(!digest_matches(b"a\r\nc\r\n", &sha256(lf)));
        assert!(same_text(lf, crlf));
        assert_eq!(text_digest(lf), sha256(lf));
        // Binary content is compared exactly.
        let bin = [0u8, b'\r', b'\n'];
        assert_eq!(lf_text(&bin).as_ref(), &bin);
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested/file.txt");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".habi-tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn modes_are_preserved_or_set_explicitly() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("script.sh");
        atomic_write(&p, b"one").unwrap();
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o644
        );
        atomic_write_mode(&p, b"two", Some(true)).unwrap();
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o755
        );
        atomic_write(&p, b"three").unwrap();
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o755,
            "existing mode kept"
        );
        assert!(is_executable(&p));
    }

    #[test]
    fn bounded_read_refuses_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big");
        std::fs::write(&p, vec![b'x'; 100]).unwrap();
        assert!(matches!(
            read_bounded(&p, 10).unwrap(),
            Bounded::TooLarge(100)
        ));
        assert!(matches!(
            read_bounded(&p, 100).unwrap(),
            Bounded::Content(_)
        ));
    }
}

/// Standard base64 (RFC 4648, with padding), for data URLs of image previews.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod base64_tests {
    #[test]
    fn encodes_like_rfc_4648() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
    }
}
