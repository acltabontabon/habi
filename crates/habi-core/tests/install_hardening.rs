//! What a crash, a hand edit or a hostile file must not be able to do to an install.

use habi_core::clients::{ClientId, sections};
use habi_core::error::HabiError;
use habi_core::fsutil::sha256;
use habi_core::install::apply::{Applier, Fault, JournalState};
use habi_core::install::lock::LockedSource;
use habi_core::install::plan::{self, Decisions, Payload, PayloadFile, Resolution, read_lock};
use habi_core::library::build_index;
use habi_core::library::model::{ItemKind, LibraryIndex, SnapshotFile};
use habi_core::service::Habi;
use habi_core::store::AppPaths;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/libraries/example-team-library"
);
const SKILL: &str = "liquibase-migration-review";
const INSTRUCTIONS: &str = "java-service-conventions";
const CODEX: &[ClientId] = &[ClientId::Codex];

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

fn index(dir: &Path) -> LibraryIndex {
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

fn payload(id: &str) -> Payload {
    let dir = PathBuf::from(FIXTURE);
    let library = index(&dir);
    let item = library.items.iter().find(|i| i.id == id).unwrap().clone();
    let files = item
        .files
        .iter()
        .map(|f| {
            let rel = match item.kind {
                ItemKind::Instructions => item.path.clone(),
                _ => format!("{}/{}", item.path, f.path),
            };
            PayloadFile {
                path: f.path.clone(),
                bytes: std::fs::read(dir.join(rel)).unwrap(),
                executable: f.executable,
            }
        })
        .collect();
    Payload {
        item,
        source: LockedSource {
            identity: "https://example.invalid/team.git".into(),
            name: "Team".into(),
            subdir: None,
        },
        snapshot: library.snapshot.clone(),
        files,
    }
}

struct World {
    _tmp: tempfile::TempDir,
    habi: Habi,
    root: PathBuf,
}

impl World {
    fn new() -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let habi = Habi::open(AppPaths::at(tmp.path().join("home"))).unwrap();
        World {
            _tmp: tmp,
            habi,
            root,
        }
    }

    fn applier(&self) -> Applier<'_> {
        Applier {
            paths: &self.habi.paths,
            store: &self.habi.store,
        }
    }

    fn install(&self, p: &Payload) {
        let plan =
            plan::plan_install(&self.root, std::slice::from_ref(p), CODEX, false, &none()).unwrap();
        self.applier().apply(&plan).unwrap();
    }

    fn folder(&self, rel: &str) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(self.root.join(rel))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// True where `Abc` and `abc` are one file: the default on macOS and Windows.
    fn ignores_case(&self) -> bool {
        let probe = self.root.join(".case-probe");
        std::fs::write(&probe, "").unwrap();
        let same = self.root.join(".CASE-PROBE").exists();
        std::fs::remove_file(probe).unwrap();
        same
    }
}

fn none() -> Decisions {
    Decisions::new()
}

fn renamed(p: &Payload, from: &str, to: &str) -> Payload {
    let mut newer = p.clone();
    for f in &mut newer.files {
        if f.path == from {
            f.path = to.into();
        }
    }
    newer
}

#[test]
fn an_interrupted_install_is_not_committed_by_the_next_preview() {
    let w = World::new();
    let plan = plan::plan_install(&w.root, &[payload(SKILL)], CODEX, false, &none()).unwrap();
    let last = plan.changes.len() - 1;
    assert!(
        w.applier()
            .apply_with(&plan, Fault::CrashBefore(last))
            .is_err()
    );

    // What the app does next: preview again and apply. The half-written files look finished, so
    // the preview leaves them out; undoing the crash then removes them.
    let again = plan::plan_install(&w.root, &[payload(SKILL)], CODEX, false, &none()).unwrap();
    let err = w.applier().apply(&again).unwrap_err();
    assert!(matches!(err, HabiError::StalePlan(_)), "{err}");

    let fresh = plan::plan_install(&w.root, &[payload(SKILL)], CODEX, false, &none()).unwrap();
    w.applier().apply(&fresh).unwrap();
    let lock = read_lock(&w.root).unwrap();
    for file in &lock.items[0].files {
        assert!(
            w.root.join(&file.path).is_file(),
            "{} is missing",
            file.path
        );
    }
}

#[test]
fn keeping_an_edited_file_through_a_case_only_rename_keeps_the_edits() {
    let w = World::new();
    if !w.ignores_case() {
        return;
    }
    let p = payload(SKILL);
    w.install(&p);
    let old = format!(".agents/skills/{SKILL}/references/checklist.md");
    std::fs::write(w.root.join(&old), "my edits\n").unwrap();
    let newer = renamed(&p, "references/checklist.md", "references/Checklist.md");

    let first = plan::plan_update(&w.root, std::slice::from_ref(&newer), false, &none()).unwrap();
    assert!(first.conflicts.iter().any(|c| c.path == old));

    let mut keep = none();
    keep.insert(old.clone(), Resolution::Keep);
    let second = plan::plan_update(&w.root, &[newer], false, &keep).unwrap();
    assert!(second.conflicts.is_empty());
    w.applier().apply(&second).unwrap();
    assert_eq!(
        std::fs::read_to_string(w.root.join(&old)).unwrap(),
        "my edits\n"
    );
}

#[test]
fn a_file_deleted_before_a_case_only_rename_is_asked_about() {
    let w = World::new();
    if !w.ignores_case() {
        return;
    }
    let p = payload(SKILL);
    w.install(&p);
    std::fs::remove_file(
        w.root
            .join(format!(".agents/skills/{SKILL}/references/checklist.md")),
    )
    .unwrap();
    let newer = renamed(&p, "references/checklist.md", "references/Checklist.md");
    let plan = plan::plan_update(&w.root, &[newer], false, &none()).unwrap();
    assert!(
        plan.conflicts
            .iter()
            .any(|c| c.path.ends_with("Checklist.md")),
        "{:?}",
        plan.conflicts
    );
}

#[test]
fn undoing_a_case_only_rename_reports_a_clean_rollback() {
    let w = World::new();
    if !w.ignores_case() {
        return;
    }
    let p = payload(SKILL);
    w.install(&p);
    let mut newer = renamed(&p, "references/checklist.md", "references/Checklist.md");
    for f in &mut newer.files {
        if f.path == "references/Checklist.md" {
            f.bytes = b"new upstream\n".to_vec();
        }
    }
    let plan = plan::plan_update(&w.root, &[newer], false, &none()).unwrap();
    let at = plan
        .changes
        .iter()
        .position(|c| c.path.ends_with("Checklist.md"))
        .unwrap();
    assert!(
        w.applier()
            .apply_with(&plan, Fault::FailBefore(at))
            .is_err()
    );
    let newest = &w.applier().history(&w.root).unwrap()[0];
    assert_eq!(
        newest.state,
        JournalState::RolledBack,
        "{:?}",
        newest.problems
    );
    assert_eq!(
        w.folder(&format!(".agents/skills/{SKILL}/references"))
            .len(),
        1
    );
}

#[test]
fn a_rename_that_only_changes_how_an_accent_is_encoded_keeps_the_file() {
    let w = World::new();
    let mut p = payload(SKILL);
    p.files.push(PayloadFile {
        path: "references/caf\u{e9}.md".into(),
        bytes: b"hello\n".to_vec(),
        executable: false,
    });
    w.install(&p);
    let newer = renamed(&p, "references/caf\u{e9}.md", "references/cafe\u{301}.md");
    let plan = plan::plan_update(&w.root, &[newer], false, &none()).unwrap();
    w.applier().apply(&plan).unwrap();

    let lock = read_lock(&w.root).unwrap();
    let cafe: Vec<_> = lock.items[0]
        .files
        .iter()
        .filter(|f| f.path.contains("caf"))
        .collect();
    assert_eq!(cafe.len(), 1);
    assert_eq!(
        std::fs::read_to_string(w.root.join(&cafe[0].path)).unwrap(),
        "hello\n"
    );
}

#[test]
fn a_skill_with_both_encodings_of_one_name_is_refused_at_the_preview() {
    let w = World::new();
    let mut p = payload(SKILL);
    for name in ["references/caf\u{e9}.md", "references/cafe\u{301}.md"] {
        p.files.push(PayloadFile {
            path: name.into(),
            bytes: name.as_bytes().to_vec(),
            executable: false,
        });
    }
    let err = plan::plan_install(&w.root, &[p], CODEX, false, &none()).unwrap_err();
    assert!(err.to_string().contains("accent"), "{err}");
}

#[test]
fn a_project_moved_after_the_preview_is_not_recreated() {
    let w = World::new();
    let plan = plan::plan_install(&w.root, &[payload(SKILL)], CODEX, false, &none()).unwrap();
    std::fs::rename(&w.root, w.root.with_file_name("renamed")).unwrap();
    let err = w.applier().apply(&plan).unwrap_err();
    assert!(matches!(err, HabiError::NotFound(_)), "{err}");
    assert!(!w.root.exists());
}

fn age(root: &Path) {
    let old = SystemTime::now() - Duration::from_secs(3 * 3600);
    for entry in std::fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            age(&path);
        } else {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
    }
}

#[test]
fn pruning_keeps_backups_while_a_record_is_unreadable() {
    let w = World::new();
    std::fs::write(w.root.join("AGENTS.md"), "team notes\n").unwrap();
    let original = sha256(b"team notes\n");
    let plan =
        plan::plan_install(&w.root, &[payload(INSTRUCTIONS)], CODEX, false, &none()).unwrap();
    let op = w.applier().apply(&plan).unwrap();

    let id = habi_core::install::apply::project_id(&w.root);
    let record = w
        .habi
        .paths
        .journal()
        .join(&id)
        .join(format!("{}.json", op.id));
    let good = std::fs::read(&record).unwrap();
    std::fs::write(&record, &good[..good.len() - 2]).unwrap();

    age(&w.habi.paths.blobs());
    habi_core::maintenance::prune(&w.habi.paths, &w.habi.store).unwrap();
    assert!(habi_core::store::cas::Blobs::new(&w.habi.paths.blobs()).has(&original));

    // Repaired, the record can still put the file back.
    std::fs::write(&record, &good).unwrap();
    let (_, steps) = w.applier().restore_steps(&w.root, &op.id).unwrap();
    assert!(!steps.is_empty());
}

#[cfg(unix)]
#[test]
fn a_named_pipe_at_a_managed_path_is_refused_instead_of_hanging() {
    let w = World::new();
    let made = std::process::Command::new("mkfifo")
        .arg(w.root.join("AGENTS.md"))
        .status()
        .unwrap();
    assert!(made.success());
    let root = w.root.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let planned = plan::plan_install(&root, &[payload(INSTRUCTIONS)], CODEX, false, &none());
        let _ = tx.send(planned.map(|_| ()).map_err(|e| e.to_string()));
    });
    let answer = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the preview hung");
    assert!(answer.unwrap_err().contains("not a regular file"));
}

#[test]
fn a_byte_order_mark_before_a_section_is_kept_and_not_called_damage() {
    let text = "\u{feff}<!-- habi:begin id=a -->\nold\n<!-- habi:end id=a -->\nmine\n";
    assert!(sections::find(text, "a").unwrap().is_some());
    let updated = sections::upsert(text, "a", "", "new").unwrap();
    assert!(updated.starts_with('\u{feff}'));
    assert!(updated.contains("new\n"));
    assert!(updated.ends_with("mine\n"));
    let removed = sections::remove(text, "a").unwrap();
    assert_eq!(removed, "\u{feff}mine\n");
}

#[test]
fn overlapping_sections_are_refused_rather_than_cut_in_half() {
    let text = "<!-- habi:begin id=a -->\nA\n<!-- habi:begin id=b -->\nB\n<!-- habi:end id=a -->\nC\n<!-- habi:end id=b -->\n";
    assert!(sections::upsert(text, "a", "", "new").is_err());
    assert!(sections::remove(text, "a").is_err());
}

#[test]
fn habi_does_not_write_a_file_it_could_not_read_back() {
    let w = World::new();
    std::fs::write(
        w.root.join("AGENTS.md"),
        "x\n".repeat(2 * 1024 * 1024 - 100),
    )
    .unwrap();
    let mut p = payload(INSTRUCTIONS);
    p.files[0].bytes = "y\n".repeat(1024 * 1024 - 100).into_bytes();
    let err = plan::plan_install(&w.root, &[p], CODEX, false, &none()).unwrap_err();
    assert!(err.to_string().contains("AGENTS.md"), "{err}");
}

#[test]
fn a_lock_entry_with_files_and_no_agent_tools_is_refused() {
    let w = World::new();
    let p = payload(SKILL);
    w.install(&p);
    let path = w.root.join(".habi/lock.json");
    let mut lock: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    lock["items"][0]["clients"] = serde_json::json!([]);
    std::fs::write(&path, serde_json::to_vec_pretty(&lock).unwrap()).unwrap();
    assert!(plan::plan_update(&w.root, &[p], false, &none()).is_err());
}

#[test]
fn a_machine_folder_holding_files_habi_did_not_install_is_left_alone() {
    let w = World::new();
    let folder = w.root.join(format!(".agents/skills/{SKILL}"));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("my-notes.md"), "mine\n").unwrap();
    let plan = plan::plan_install_on_machine(&w.root, &[payload(SKILL)], CODEX, &none()).unwrap();
    assert!(plan.is_blocked());
    assert!(plan.conflicts.iter().any(|c| c.path.ends_with(SKILL)));
}

#[test]
fn a_missing_working_folder_is_not_reported_as_a_missing_program() {
    let spec = habi_core::process::Spec {
        cwd: Some(PathBuf::from("/nonexistent/project")),
        ..habi_core::process::Spec::new("git", vec!["--version".into()])
    };
    let err = habi_core::process::run(spec, &habi_core::cancel::CancelToken::new()).unwrap_err();
    assert!(err.to_string().contains("folder"), "{err}");
}

#[test]
fn secrets_are_redacted_whole() {
    for (text, secret) in [
        ("DB_PASSWORD=p4ss,w0rd", "w0rd"),
        ("password=\"my long secret\"", "long secret"),
        ("token=abc;def", "def"),
        ("{\"api_key\": \"abcd1234abcd1234\"}", "abcd1234"),
        ("https://u:p@ss@example.invalid/x", "ss@"),
    ] {
        let out = habi_core::redact::redact(text);
        assert!(!out.contains(secret), "{text} became {out}");
    }
}

#[test]
fn a_home_folder_or_a_whole_disk_is_not_a_project() {
    let w = World::new();
    let home = directories::BaseDirs::new()
        .unwrap()
        .home_dir()
        .to_path_buf();
    assert!(w.habi.open_project(&home).is_err());
    assert!(w.habi.open_project(Path::new("/")).is_err());
    assert!(w.habi.open_project(&w.root).is_ok());
}

#[test]
fn checks_are_only_read_from_connected_libraries() {
    let w = World::new();
    let project = w.habi.open_project(&w.root).unwrap();
    let err = w
        .habi
        .prepare_check(
            &project.id,
            "not-a-library/some-skill",
            "check",
            ".",
            &HashMap::new(),
        )
        .unwrap_err();
    assert!(matches!(err, HabiError::NotFound(_)), "{err}");
}

#[test]
fn upkeep_runs_at_most_once_a_day() {
    let w = World::new();
    assert!(
        habi_core::maintenance::prune_if_due(&w.habi.paths, &w.habi.store)
            .unwrap()
            .is_some()
    );
    assert!(
        habi_core::maintenance::prune_if_due(&w.habi.paths, &w.habi.store)
            .unwrap()
            .is_none()
    );
}

#[test]
fn one_repository_has_one_key_however_its_address_is_written() {
    use habi_core::install::lock::lock_key;
    let https = lock_key("https://github.com/acme/skills.git", "jpa");
    assert_eq!(https, lock_key("git@github.com:Acme/Skills.git", "jpa"));
    assert_eq!(https, lock_key("ssh://git@github.com/acme/skills", "jpa"));
    assert_ne!(https, lock_key("https://github.com/acme/other", "jpa"));
}
