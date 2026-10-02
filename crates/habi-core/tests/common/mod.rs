#![allow(dead_code)]
//! Helpers shared by integration tests.

use habi_core::cancel::CancelToken;
use habi_core::fsutil::sha256;
use habi_core::inspect::model::ProjectInspection;
use habi_core::inspect::{WalkOptions, inspect};
use habi_core::library::build_index;
use habi_core::library::model::{LibraryIndex, SnapshotFile};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

pub fn fixture(rel: &str) -> PathBuf {
    workspace_root().join("fixtures").join(rel)
}

fn collect(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, base, out);
        } else {
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, std::fs::read(&path).unwrap()));
        }
    }
}

pub fn library_from_dir(dir: &Path) -> LibraryIndex {
    let mut files = Vec::new();
    collect(dir, dir, &mut files);
    let content: HashMap<String, Vec<u8>> = files.iter().cloned().collect();
    let list: Vec<SnapshotFile> = files
        .iter()
        .map(|(p, b)| SnapshotFile {
            path: p.clone(),
            digest: sha256(b),
            size: b.len() as u64,
            executable: false,
        })
        .collect();
    build_index("team", "fixture", &list, &|p| {
        content
            .get(p)
            .cloned()
            .ok_or_else(|| format!("missing {p}"))
    })
}

pub fn inspect_fixture(rel: &str) -> ProjectInspection {
    inspect(&fixture(rel), &WalkOptions::default(), &CancelToken::new()).unwrap()
}

/// Copies a directory tree (used to make writable copies of fixtures).
pub fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}
