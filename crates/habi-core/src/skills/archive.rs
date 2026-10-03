//! A skill package as one zip archive, to hand to someone or keep.
//!
//! Every entry sits under a folder named by the skill's identifier, so
//! unpacking it gives an ordinary Agent Skills folder. Entries are deflated
//! (or stored, when that is smaller), names are UTF-8, scripts keep their
//! executable bit, and every entry carries the time of the export. Packages are small (see `MAX_FILES`), so the
//! classic format suffices; anything that would need ZIP64 is refused.

use crate::error::{HabiError, Result};
use flate2::Compression;
use flate2::write::DeflateEncoder;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

/// Now, on this machine's clock: zip times are local, so that is what an
/// unpacked file should show. Falls back to UTC where the offset is unknown.
pub(crate) fn local_now() -> time::OffsetDateTime {
    let now = time::OffsetDateTime::now_utc();
    #[cfg(unix)]
    {
        // `time_t` is 32 bits on some targets, where this can fail.
        #[allow(irrefutable_let_patterns)]
        if let Ok(secs) = libc::time_t::try_from(now.unix_timestamp()) {
            let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
            // SAFETY: `localtime_r` (the reentrant variant) reads `secs` and,
            // when it returns non-null, has filled all of `tm`, which is only
            // read after that check.
            #[allow(unsafe_code)] // The standard library cannot tell the local UTC offset.
            let offset = unsafe {
                if libc::localtime_r(&raw const secs, tm.as_mut_ptr()).is_null() {
                    None
                } else {
                    Some(tm.assume_init().tm_gmtoff)
                }
            };
            if let Some(Ok(offset)) =
                offset.map(|s| time::UtcOffset::from_whole_seconds(i32::try_from(s).unwrap_or(0)))
            {
                return now.to_offset(offset);
            }
        }
    }
    now
}

/// A moment as the DOS time and date zip entries carry (2-second precision).
pub(crate) fn dos_stamp(at: time::OffsetDateTime) -> (u16, u16) {
    let year = u16::try_from(at.year().clamp(1980, 2107) - 1980).unwrap_or(0);
    let time =
        (u16::from(at.hour()) << 11) | (u16::from(at.minute()) << 5) | (u16::from(at.second()) / 2);
    let date = (year << 9) | (u16::from(u8::from(at.month())) << 5) | u16::from(at.day());
    (time, date)
}
/// Names are UTF-8.
const FLAG_UTF8: u16 = 1 << 11;
/// Made by Unix, so the external attributes carry the file mode.
const MADE_BY_UNIX: u16 = (3 << 8) | 20;

struct Entry {
    name: Vec<u8>,
    method: u16,
    crc: u32,
    compressed: u32,
    size: u32,
    offset: u32,
    mode: u32,
}

fn too_large() -> HabiError {
    HabiError::invalid("the package is too large to archive")
}

fn u32_of(n: usize) -> Result<u32> {
    u32::try_from(n).map_err(|_| too_large())
}

/// The archive's bytes: `files` (paths relative to the package) under `root/`.
pub(crate) fn zip(
    root: &str,
    files: &BTreeMap<String, Vec<u8>>,
    executables: &BTreeSet<String>,
    at: time::OffsetDateTime,
) -> Result<Vec<u8>> {
    let (dos_time, dos_date) = dos_stamp(at);
    let mut out: Vec<u8> = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (rel, bytes) in files {
        let mut deflater = DeflateEncoder::new(Vec::new(), Compression::default());
        deflater
            .write_all(bytes)
            .map_err(|e| HabiError::io("compressing the package", e))?;
        let deflated = deflater
            .finish()
            .map_err(|e| HabiError::io("compressing the package", e))?;
        let (method, data) = if deflated.len() < bytes.len() {
            (8u16, deflated)
        } else {
            (0u16, bytes.clone())
        };
        let entry = Entry {
            name: format!("{root}/{rel}").into_bytes(),
            method,
            crc: crc32fast::hash(bytes),
            compressed: u32_of(data.len())?,
            size: u32_of(bytes.len())?,
            offset: u32_of(out.len())?,
            mode: if executables.contains(rel) {
                0o100_755
            } else {
                0o100_644
            },
        };
        // Local file header.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&FLAG_UTF8.to_le_bytes());
        out.extend_from_slice(&entry.method.to_le_bytes());
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&entry.crc.to_le_bytes());
        out.extend_from_slice(&entry.compressed.to_le_bytes());
        out.extend_from_slice(&entry.size.to_le_bytes());
        out.extend_from_slice(
            &u16::try_from(entry.name.len())
                .map_err(|_| too_large())?
                .to_le_bytes(),
        );
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&data);
        entries.push(entry);
    }

    let directory = u32_of(out.len())?;
    for e in &entries {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&MADE_BY_UNIX.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&FLAG_UTF8.to_le_bytes());
        out.extend_from_slice(&e.method.to_le_bytes());
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&e.compressed.to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(
            &u16::try_from(e.name.len())
                .map_err(|_| too_large())?
                .to_le_bytes(),
        );
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(&0u16.to_le_bytes()); // comment
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        out.extend_from_slice(&(e.mode << 16).to_le_bytes());
        out.extend_from_slice(&e.offset.to_le_bytes());
        out.extend_from_slice(&e.name);
    }
    let size = u32_of(out.len())? - directory;
    let count = u16::try_from(entries.len()).map_err(|_| too_large())?;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&directory.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }
    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    /// Reads the archive back through its central directory: name, mode, contents.
    fn read(zip: &[u8]) -> Vec<(String, u32, Vec<u8>)> {
        let end = zip.len() - 22;
        assert_eq!(u32_at(zip, end), 0x0605_4b50);
        let count = u16_at(zip, end + 10) as usize;
        let mut at = u32_at(zip, end + 16) as usize;
        let mut out = Vec::new();
        for _ in 0..count {
            assert_eq!(u32_at(zip, at), 0x0201_4b50);
            let method = u16_at(zip, at + 10);
            let crc = u32_at(zip, at + 16);
            let compressed = u32_at(zip, at + 20) as usize;
            let name_len = u16_at(zip, at + 28) as usize;
            let mode = u32_at(zip, at + 38) >> 16;
            let local = u32_at(zip, at + 42) as usize;
            let name = String::from_utf8(zip[at + 46..at + 46 + name_len].to_vec()).unwrap();
            let start =
                local + 30 + u16_at(zip, local + 26) as usize + u16_at(zip, local + 28) as usize;
            let raw = &zip[start..start + compressed];
            let data = if method == 8 {
                let mut v = Vec::new();
                DeflateDecoder::new(raw).read_to_end(&mut v).unwrap();
                v
            } else {
                raw.to_vec()
            };
            assert_eq!(crc32fast::hash(&data), crc, "{name}");
            out.push((name, mode, data));
            at += 46 + name_len;
        }
        out
    }

    #[test]
    fn packs_the_skill_under_its_folder_and_reads_back_exactly() {
        let mut files = BTreeMap::new();
        files.insert(
            "SKILL.md".to_string(),
            b"---\nname: review\n---\n\nSteps.\n".repeat(20),
        );
        files.insert(
            "scripts/check.py".to_string(),
            b"#!/usr/bin/env python3\n".to_vec(),
        );
        files.insert("assets/é.txt".to_string(), Vec::new());
        let executables = BTreeSet::from(["scripts/check.py".to_string()]);
        let at = time::macros::datetime!(2026-10-03 18:59:30 UTC);
        let bytes = zip("review", &files, &executables, at).unwrap();
        let back = read(&bytes);
        assert_eq!(
            back.iter().map(|(n, ..)| n.as_str()).collect::<Vec<_>>(),
            [
                "review/SKILL.md",
                "review/assets/é.txt",
                "review/scripts/check.py"
            ]
        );
        for (name, mode, data) in &back {
            let rel = name.strip_prefix("review/").unwrap();
            assert_eq!(data, &files[rel]);
            assert_eq!(
                *mode,
                if rel == "scripts/check.py" {
                    0o100_755
                } else {
                    0o100_644
                }
            );
        }
        // Same package and moment, same bytes; the moment is the export's.
        assert_eq!(bytes, zip("review", &files, &executables, at).unwrap());
        assert_eq!(
            dos_stamp(at),
            ((18 << 11) | (59 << 5) | 15, (46 << 9) | (10 << 5) | 3)
        );
    }
}
