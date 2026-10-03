//! Install pipeline edge cases: line endings, items that share a section or an
//! MCP server, restoring older operations, linked folders and size limits.
//!
//! These tests drive the planner directly with payloads built from fixture
//! libraries, so each scenario controls exactly which sources and items exist.

mod common;

use common::*;
use habi_core::clients::ClientId;
use habi_core::install::apply::Applier;
use habi_core::install::lock::{LockFile, LockedSource};
use habi_core::install::plan::{
    self, ConflictKind, Decisions, Payload, PayloadFile, Plan, Resolution, read_lock,
};
use habi_core::install::status::{self, FileState, InstallState};
use habi_core::library::model::{ItemKind, LibraryIndex};
use habi_core::service::Habi;
use habi_core::store::AppPaths;
use std::path::{Path, PathBuf};

struct Lib {
    dir: PathBuf,
    index: LibraryIndex,
    source: LockedSource,
}

fn lib(dir: &Path, identity: &str, name: &str) -> Lib {
    Lib {
        dir: dir.to_path_buf(),
        index: library_from_dir(dir),
        source: LockedSource {
            identity: identity.into(),
            name: name.into(),
            subdir: None,
        },
    }
}

fn team_lib(tmp: &Path) -> Lib {
    let dir = tmp.join("team-library");
    copy_tree(&fixture("libraries/example-team-library"), &dir);
    lib(&dir, "https://example.invalid/team.git", "Team library")
}

fn payload(lib: &Lib, id: &str) -> Payload {
    let item = lib
        .index
        .items
        .iter()
        .find(|i| i.id == id)
        .unwrap_or_else(|| panic!("no item {id}"))
        .clone();
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
                bytes: std::fs::read(lib.dir.join(rel)).unwrap(),
                executable: f.executable,
            }
        })
        .collect();
    Payload {
        item,
        source: lib.source.clone(),
        snapshot: lib.index.snapshot.clone(),
        files,
    }
}

struct World {
    _tmp: tempfile::TempDir,
    tmp: PathBuf,
    habi: Habi,
    root: PathBuf,
}

fn world(repo: Option<&str>) -> World {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    match repo {
        Some(r) => copy_tree(&fixture(r), &root),
        None => std::fs::create_dir_all(&root).unwrap(),
    }
    let root = root.canonicalize().unwrap();
    let habi = Habi::open(AppPaths::at(tmp.path().join("home"))).unwrap();
    World {
        tmp: tmp.path().to_path_buf(),
        _tmp: tmp,
        habi,
        root,
    }
}

impl World {
    fn apply(&self, plan: &Plan) -> String {
        assert!(plan.conflicts.is_empty(), "{:#?}", plan.conflicts);
        let applier = Applier {
            paths: &self.habi.paths,
            store: &self.habi.store,
        };
        applier.apply(plan).unwrap().id
    }

    fn restore(&self, operation: &str, decisions: &Decisions) -> Plan {
        let applier = Applier {
            paths: &self.habi.paths,
            store: &self.habi.store,
        };
        let (title, steps) = applier.restore_steps(&self.root, operation).unwrap();
        plan::plan_restore(&self.root, &steps, &title, decisions).unwrap()
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).unwrap()
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn lock(&self) -> LockFile {
        read_lock(&self.root).unwrap()
    }
}

fn none() -> Decisions {
    Decisions::new()
}

/// Converts every text file under `dir` to CRLF, as `git checkout` does with
/// `core.autocrlf=true`.
fn to_crlf(dir: &Path) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            to_crlf(&p);
        } else {
            let text = std::fs::read_to_string(&p).unwrap();
            std::fs::write(&p, text.replace("\r\n", "\n").replace('\n', "\r\n")).unwrap();
        }
    }
}

#[test]
fn crlf_checkouts_are_not_local_edits() {
    let w = world(Some("repos/billing-service"));
    let team = team_lib(&w.tmp);
    w.write(
        "AGENTS.md",
        "# Team rules\r\n\r\nNever commit generated code.\r\n",
    );
    let payloads = [
        payload(&team, "liquibase-migration-review"),
        payload(&team, "java-service-conventions"),
    ];
    let clients = [ClientId::ClaudeCode, ClientId::Codex];
    let p = plan::plan_install(&w.root, &payloads, &clients, false, &none()).unwrap();
    w.apply(&p);

    // A section added to a CRLF file uses CRLF too (no mixed line endings).
    let agents = w.read("AGENTS.md");
    assert!(agents.starts_with("# Team rules\r\n\r\nNever commit generated code.\r\n"));
    assert_eq!(
        agents.matches('\n').count(),
        agents.matches("\r\n").count(),
        "{agents:?}"
    );

    // A teammate's Windows checkout converts every text file to CRLF.
    for dir in [".agents", ".claude"] {
        to_crlf(&w.root.join(dir));
    }
    for file in ["AGENTS.md", "CLAUDE.md"] {
        let text = w.read(file);
        w.write(file, &text.replace("\r\n", "\n").replace('\n', "\r\n"));
    }

    let lock = w.lock();
    for locked in &lock.items {
        if locked.source.identity == "habi:internal" {
            continue;
        }
        let upstream = team.index.items.iter().find(|i| i.id == locked.id).unwrap();
        let s = status::installation(&w.root, locked, Some((upstream, &team.index.snapshot)));
        assert_eq!(
            s.state,
            InstallState::Current,
            "{}: {:?}",
            locked.id,
            s.files
        );
        assert!(s.files.iter().all(|f| f.state == FileState::Unchanged));
    }

    // Installing again changes nothing; updating or removing raises no conflict.
    let again = plan::plan_install(&w.root, &payloads, &clients, false, &none()).unwrap();
    assert!(again.conflicts.is_empty(), "{:?}", again.conflicts);
    assert!(
        again.changes.is_empty(),
        "{:?}",
        again.changes.iter().map(|c| &c.path).collect::<Vec<_>>()
    );

    let mut newer = payload(&team, "liquibase-migration-review");
    newer.files[0]
        .bytes
        .extend_from_slice(b"\n7. One more step.\n");
    newer.item.content_digest = "sha256:newer".into();
    let update = plan::plan_update(&w.root, &[newer], &none()).unwrap();
    assert!(update.conflicts.is_empty(), "{:?}", update.conflicts);
    w.apply(&update);

    let keys: Vec<String> = w
        .lock()
        .items
        .iter()
        .filter(|i| i.source.identity != "habi:internal")
        .map(|i| i.key())
        .collect();
    let removal = plan::plan_remove(&w.root, &keys, &none()).unwrap();
    assert!(removal.conflicts.is_empty(), "{:?}", removal.conflicts);
    w.apply(&removal);
    assert!(
        !w.root
            .join(".agents/skills/liquibase-migration-review")
            .exists()
    );
    assert_eq!(
        w.read("AGENTS.md"),
        "# Team rules\r\n\r\nNever commit generated code.\r\n"
    );
}

/// A minimal library with one instructions item `conventions`.
fn instructions_lib(tmp: &Path, folder: &str, name: &str, body: &str) -> Lib {
    let dir = tmp.join(folder);
    std::fs::create_dir_all(dir.join("instructions")).unwrap();
    std::fs::write(
        dir.join("habi-library.yaml"),
        format!(
            "habi: 1\nname: {name}\ninstructions:\n  - id: conventions\n    title: Conventions ({name})\n    description: House rules.\n    path: instructions/conventions.md\n"
        ),
    )
    .unwrap();
    std::fs::write(dir.join("instructions/conventions.md"), body).unwrap();
    lib(&dir, &format!("https://example.invalid/{folder}.git"), name)
}

fn install(w: &World, payloads: &[Payload], clients: &[ClientId], mcp: bool) -> Plan {
    plan::plan_install(&w.root, payloads, clients, mcp, &none()).unwrap()
}

#[test]
fn instructions_sections_with_the_same_id_from_two_sources_collide() {
    for (body_a, body_b) in [
        ("Use tabs.\n", "Use tabs.\n"),
        ("Use tabs.\n", "Use spaces.\n"),
    ] {
        let w = world(None);
        let a = instructions_lib(&w.tmp, "lib-a", "Library A", body_a);
        let b = instructions_lib(&w.tmp, "lib-b", "Library B", body_b);
        let codex = [ClientId::Codex];

        // Installed separately: the second install is blocked by a named collision.
        w.apply(&install(&w, &[payload(&a, "conventions")], &codex, false));
        let second = install(&w, &[payload(&b, "conventions")], &codex, false);
        assert_eq!(second.conflicts.len(), 1, "{:?}", second.conflicts);
        let c = &second.conflicts[0];
        assert_eq!(c.kind, ConflictKind::PathCollision);
        assert_eq!(c.path, "AGENTS.md#conventions");
        assert!(c.message.contains("Library A") && c.message.contains("Library B"));
        assert!(!c.message.contains("by hand"), "{}", c.message);

        // In one plan: the same collision.
        let fresh = world(None);
        let both = install(
            &fresh,
            &[payload(&a, "conventions"), payload(&b, "conventions")],
            &codex,
            false,
        );
        assert_eq!(both.conflicts.len(), 1);
        assert_eq!(both.conflicts[0].kind, ConflictKind::PathCollision);
    }
}

#[test]
fn removing_a_section_keeps_files_habi_did_not_create() {
    let w = world(None);
    let a = instructions_lib(&w.tmp, "lib-a", "Library A", "Use tabs.\n");
    let codex = [ClientId::Codex];
    // A whitespace-only AGENTS.md the team committed (e.g. a placeholder).
    w.write("AGENTS.md", "\n");
    w.apply(&install(&w, &[payload(&a, "conventions")], &codex, false));
    let key = w.lock().items[0].key();
    w.apply(&plan::plan_remove(&w.root, &[key], &none()).unwrap());
    assert_eq!(
        w.read("AGENTS.md"),
        "\n",
        "the team's file is kept as it was"
    );

    // A file Habi created is removed once only whitespace is left, even when
    // another item's section was added later and is removed last.
    let w = world(None);
    let b = instructions_lib(&w.tmp, "lib-b", "Library B", "Use spaces.\n");
    let mut spacing = payload(&b, "conventions");
    spacing.item.id = "spacing".into();
    w.apply(&install(&w, &[payload(&a, "conventions")], &codex, false));
    w.apply(&install(&w, &[spacing], &codex, false));
    let keys: Vec<String> = w.lock().items.iter().map(|i| i.key()).collect();
    for key in keys {
        w.apply(&plan::plan_remove(&w.root, &[key], &none()).unwrap());
    }
    assert!(!w.root.join("AGENTS.md").exists());
}

#[test]
fn large_agents_md_is_flagged_for_codex() {
    let w = world(None);
    let a = instructions_lib(&w.tmp, "lib-a", "Library A", "Use tabs.\n");
    w.write(
        "AGENTS.md",
        &format!("# Rules\n\n{}\n", "x".repeat(33 * 1024)),
    );
    let p = install(&w, &[payload(&a, "conventions")], &[ClientId::Codex], false);
    assert!(
        p.notes.iter().any(|n| n.contains("32 KiB")),
        "{:?}",
        p.notes
    );
    let small = world(None);
    let p = install(
        &small,
        &[payload(&a, "conventions")],
        &[ClientId::Codex],
        false,
    );
    assert!(!p.notes.iter().any(|n| n.contains("32 KiB")));
}

/// `github-pr-summary` and a second skill that needs the same MCP server.
fn github_pair(team: &Lib) -> (Payload, Payload) {
    let a = payload(team, "github-pr-summary");
    let mut b = a.clone();
    b.item.id = "github-triage".into();
    b.item.name = "github-triage".into();
    b.item.title = "GitHub triage".into();
    (a, b)
}

fn mcp_servers(w: &World, rel: &str) -> serde_json::Value {
    let v: serde_json::Value = serde_json::from_str(&w.read(rel)).unwrap();
    v["mcpServers"].clone()
}

#[test]
fn an_mcp_server_shared_by_two_items_stays_until_neither_needs_it() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let (a, b) = github_pair(&team);
    let clients = [ClientId::ClaudeCode, ClientId::Codex];
    let p = install(&w, &[a.clone(), b.clone()], &clients, true);
    assert!(
        p.notes
            .iter()
            .any(|n| n.contains("also uses the `github` MCP server this plan adds")),
        "{:?}",
        p.notes
    );
    assert!(
        !p.notes.iter().any(|n| n.contains("left unchanged")),
        "{:?}",
        p.notes
    );
    w.apply(&p);
    let lock = w.lock();
    for key in [a.key(), b.key()] {
        let item = lock.find(&key).unwrap();
        assert_eq!(item.mcp.len(), 2, "both items record both clients: {key}");
    }

    // Removing the first keeps the server for the second.
    let r = plan::plan_remove(&w.root, &[a.key()], &none()).unwrap();
    assert!(
        r.notes.iter().any(|n| n.contains("uses it too")),
        "{:?}",
        r.notes
    );
    w.apply(&r);
    assert!(mcp_servers(&w, ".mcp.json").get("github").is_some());
    assert!(
        w.read(".codex/config.toml")
            .contains("[mcp_servers.github]")
    );

    // Removing the last user removes it, and the files Habi created with it.
    w.apply(&plan::plan_remove(&w.root, &[b.key()], &none()).unwrap());
    assert!(!w.root.join(".mcp.json").exists());
    assert!(!w.root.join(".codex/config.toml").exists());

    // Installed one after the other, and removed together.
    w.apply(&install(&w, std::slice::from_ref(&a), &clients, true));
    let p = install(&w, std::slice::from_ref(&b), &clients, true);
    assert!(
        p.notes
            .iter()
            .any(|n| n.contains("added by Habi for `GitHub PR summary`")),
        "{:?}",
        p.notes
    );
    w.apply(&p);
    w.apply(&plan::plan_remove(&w.root, &[a.key(), b.key()], &none()).unwrap());
    assert!(!w.root.join(".mcp.json").exists());
}

#[test]
fn mcp_files_the_team_owns_are_kept_and_reformatting_is_explained() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let (a, _) = github_pair(&team);
    // A team file with a byte order mark (written by a Windows editor).
    w.write(".mcp.json", "\u{feff}{\n  \"mcpServers\": {}\n}\n");
    let p = install(&w, std::slice::from_ref(&a), &[ClientId::ClaudeCode], true);
    w.apply(&p);
    let bytes = std::fs::read(w.root.join(".mcp.json")).unwrap();
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"), "BOM kept");
    let r = plan::plan_remove(&w.root, &[a.key()], &none()).unwrap();
    let change = r.changes.iter().find(|c| c.path == ".mcp.json").unwrap();
    assert!(
        change.explanation.contains("standard JSON formatting"),
        "{}",
        change.explanation
    );
    w.apply(&r);
    assert!(w.root.join(".mcp.json").exists(), "the team's file stays");
}

#[test]
fn invalid_mcp_config_can_be_left_alone() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let (a, _) = github_pair(&team);
    w.write(".mcp.json", "{ not json");
    let p = install(&w, std::slice::from_ref(&a), &[ClientId::ClaudeCode], true);
    assert_eq!(p.conflicts.len(), 1);
    let c = &p.conflicts[0];
    assert_eq!(c.kind, ConflictKind::InvalidConfig);
    assert_eq!(c.options, vec![Resolution::Keep]);
    assert!(
        c.message.contains("Add suggested MCP configuration"),
        "{}",
        c.message
    );
    let mut keep = Decisions::new();
    keep.insert(".mcp.json".into(), Resolution::Keep);
    let p = plan::plan_install(&w.root, &[a], &[ClientId::ClaudeCode], true, &keep).unwrap();
    w.apply(&p);
    assert_eq!(w.read(".mcp.json"), "{ not json");
}

#[test]
fn updates_adopt_changed_mcp_definitions() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let (a, b) = github_pair(&team);
    let clients = [ClientId::Cursor, ClientId::Codex];
    w.apply(&install(&w, &[a.clone(), b.clone()], &clients, true));

    let mut newer = a.clone();
    newer.item.content_digest = "sha256:newer".into();
    if let Some(habi_core::library::model::McpServerSpec::Stdio { args, .. }) =
        newer.item.mcp[0].server.as_mut()
    {
        args[1] = "@modelcontextprotocol/server-github@2".into();
    }
    let u = plan::plan_update(&w.root, &[newer], &none()).unwrap();
    assert!(u.conflicts.is_empty(), "{:?}", u.conflicts);
    w.apply(&u);
    assert!(w.read(".cursor/mcp.json").contains("server-github@2"));
    assert!(w.read(".codex/config.toml").contains("server-github@2"));

    // The item sharing the server follows the new definition, so removing
    // both leaves nothing behind.
    w.apply(&plan::plan_remove(&w.root, &[a.key(), b.key()], &none()).unwrap());
    assert!(!w.root.join(".cursor/mcp.json").exists());
    assert!(!w.root.join(".codex/config.toml").exists());

    // A hand-edited entry is not replaced; the plan says why.
    w.apply(&install(&w, std::slice::from_ref(&a), &clients, true));
    let edited = w.read(".cursor/mcp.json").replace("\"-y\"", "\"--yes\"");
    w.write(".cursor/mcp.json", &edited);
    let mut newer = a.clone();
    if let Some(habi_core::library::model::McpServerSpec::Stdio { args, .. }) =
        newer.item.mcp[0].server.as_mut()
    {
        args[1] = "@modelcontextprotocol/server-github@3".into();
    }
    let u = plan::plan_update(&w.root, &[newer], &none()).unwrap();
    assert!(
        u.notes.iter().any(|n| n.contains("update it by hand")),
        "{:?}",
        u.notes
    );
    w.apply(&u);
    assert_eq!(w.read(".cursor/mcp.json"), edited);
}

fn lock_ids(w: &World) -> Vec<String> {
    let mut ids: Vec<String> = w.lock().items.iter().map(|i| i.id.clone()).collect();
    ids.sort();
    ids
}

#[test]
fn restoring_an_older_operation_keeps_the_lock_consistent() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let codex = [ClientId::Codex];
    let first = w.apply(&install(
        &w,
        &[payload(&team, "jpa-entity-review")],
        &codex,
        false,
    ));
    w.apply(&install(
        &w,
        &[payload(&team, "react-component-review")],
        &codex,
        false,
    ));

    // Undo the first install: its files go, the later install stays recorded.
    let r = w.restore(&first, &none());
    assert!(r.conflicts.is_empty(), "{:?}", r.conflicts);
    w.apply(&r);
    assert!(!w.root.join(".agents/skills/jpa-entity-review").exists());
    assert!(
        w.root
            .join(".agents/skills/react-component-review/SKILL.md")
            .exists()
    );
    assert_eq!(lock_ids(&w), vec!["react-component-review"]);
    let locked = &w.lock().items[0];
    let upstream = team
        .index
        .items
        .iter()
        .find(|i| i.id == "react-component-review")
        .unwrap();
    let s = status::installation(&w.root, locked, Some((upstream, &team.index.snapshot)));
    assert_eq!(s.state, InstallState::Current);
}

#[test]
fn restoring_past_a_later_update_keeps_what_the_user_kept() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let codex = [ClientId::Codex];
    let first = w.apply(&install(
        &w,
        &[payload(&team, "jpa-entity-review")],
        &codex,
        false,
    ));
    let mut newer = payload(&team, "jpa-entity-review");
    newer.files[0].bytes.extend_from_slice(b"\nA newer rule.\n");
    newer.item.content_digest = "sha256:newer".into();
    w.apply(&plan::plan_update(&w.root, &[newer], &none()).unwrap());

    // The update changed the files the first install wrote: restoring needs
    // decisions, and keeping them keeps the newer version tracked.
    let r = w.restore(&first, &none());
    assert!(!r.conflicts.is_empty());
    assert!(r.conflicts.iter().all(|c| c.path != ".habi/lock.json"));
    let mut keep = Decisions::new();
    for c in &r.conflicts {
        keep.insert(c.path.clone(), Resolution::Keep);
    }
    let r = w.restore(&first, &keep);
    assert!(r.conflicts.is_empty());
    w.apply(&r);
    // Files the restore deleted are no longer recorded; the kept file is,
    // with the version the update wrote.
    let lock = w.lock();
    assert!(!lock.items[0].files.is_empty());
    assert_eq!(lock_ids(&w), vec!["jpa-entity-review"]);
    assert_eq!(lock.items[0].content_digest, "sha256:newer");
    for f in &lock.items[0].files {
        let bytes = std::fs::read(w.root.join(&f.path)).unwrap();
        assert_eq!(habi_core::fsutil::sha256(&bytes), f.digest, "{}", f.path);
    }
}

#[cfg(unix)]
#[test]
fn executable_bit_changes_are_undone() {
    use habi_core::fsutil::is_executable;
    use habi_core::install::apply::Fault;
    let w = world(None);
    let team = team_lib(&w.tmp);
    let codex = [ClientId::Codex];
    let mut skill = payload(&team, "liquibase-migration-review");
    let script = skill
        .files
        .iter()
        .position(|f| f.path != "SKILL.md")
        .unwrap();
    skill.files[script].executable = true;
    let script_path = format!(
        ".agents/skills/liquibase-migration-review/{}",
        skill.files[script].path
    );
    w.apply(&install(&w, std::slice::from_ref(&skill), &codex, false));
    assert!(is_executable(&w.root.join(&script_path)));

    // Someone clears the bit; installing again plans a mode-only change.
    habi_core::fsutil::set_executable(&w.root.join(&script_path), false).unwrap();
    let p = install(
        &w,
        &[skill.clone(), payload(&team, "jpa-entity-review")],
        &codex,
        false,
    );
    let applier = Applier {
        paths: &w.habi.paths,
        store: &w.habi.store,
    };
    let last = p.changes.len() - 1;
    assert!(applier.apply_with(&p, Fault::FailBefore(last)).is_err());
    assert!(
        !is_executable(&w.root.join(&script_path)),
        "rollback restores the bit"
    );

    // Applied for real, then restored: the bit goes back too.
    let op = w.apply(&install(&w, std::slice::from_ref(&skill), &codex, false));
    assert!(is_executable(&w.root.join(&script_path)));
    let r = w.restore(&op, &none());
    assert!(
        r.changes.iter().any(|c| c.path == script_path),
        "{:?}",
        r.changes
    );
    w.apply(&r);
    assert!(!is_executable(&w.root.join(&script_path)));
}

#[cfg(unix)]
#[test]
fn claude_md_linked_to_agents_md_needs_no_bridge() {
    use std::os::unix::fs::symlink;
    let w = world(None);
    let team = team_lib(&w.tmp);
    w.write("AGENTS.md", "# Team rules\n");
    symlink("AGENTS.md", w.root.join("CLAUDE.md")).unwrap();
    let p = install(
        &w,
        &[payload(&team, "java-service-conventions")],
        &[ClientId::ClaudeCode, ClientId::Codex],
        false,
    );
    assert!(
        p.notes.iter().any(|n| n.contains("no import is needed")),
        "{:?}",
        p.notes
    );
    assert!(p.changes.iter().all(|c| c.path != "CLAUDE.md"));
    w.apply(&p);
    assert!(
        std::fs::symlink_metadata(w.root.join("CLAUDE.md"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(w.read("CLAUDE.md").contains("Java service conventions"));
}

#[cfg(unix)]
#[test]
fn claude_md_linked_elsewhere_is_explained_and_links_out_are_refused() {
    use std::os::unix::fs::symlink;
    let w = world(None);
    let team = team_lib(&w.tmp);
    w.write("docs/CLAUDE.md", "# Notes\n");
    symlink("docs/CLAUDE.md", w.root.join("CLAUDE.md")).unwrap();
    let items = [payload(&team, "java-service-conventions")];
    let p = install(&w, &items, &[ClientId::ClaudeCode], false);
    assert_eq!(p.conflicts.len(), 1, "{:?}", p.conflicts);
    let c = &p.conflicts[0];
    assert_eq!(c.kind, ConflictKind::SymbolicLink);
    assert_eq!(c.options, vec![Resolution::Keep]);
    assert!(c.message.contains("docs/CLAUDE.md") && c.message.contains("@AGENTS.md"));
    let mut keep = Decisions::new();
    keep.insert("CLAUDE.md".into(), Resolution::Keep);
    let p = plan::plan_install(&w.root, &items, &[ClientId::ClaudeCode], false, &keep).unwrap();
    w.apply(&p);
    assert_eq!(w.read("docs/CLAUDE.md"), "# Notes\n");

    // A link that leaves the project is still refused outright.
    let out = world(None);
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::write(elsewhere.path().join("CLAUDE.md"), "x").unwrap();
    symlink(
        elsewhere.path().join("CLAUDE.md"),
        out.root.join("CLAUDE.md"),
    )
    .unwrap();
    let err =
        plan::plan_install(&out.root, &items, &[ClientId::ClaudeCode], false, &none()).unwrap_err();
    assert_eq!(err.code(), "pathEscape", "{err}");
}

#[cfg(unix)]
#[test]
fn linked_skills_folders_are_written_once_in_the_real_folder() {
    use std::os::unix::fs::symlink;
    let w = world(None);
    let team = team_lib(&w.tmp);
    std::fs::create_dir_all(w.root.join(".agents/skills")).unwrap();
    std::fs::create_dir_all(w.root.join(".claude")).unwrap();
    symlink("../.agents/skills", w.root.join(".claude/skills")).unwrap();
    let skill = payload(&team, "jpa-entity-review");
    let both = [ClientId::ClaudeCode, ClientId::Codex];
    let p = install(&w, std::slice::from_ref(&skill), &both, false);
    assert!(p.conflicts.is_empty(), "{:?}", p.conflicts);
    assert!(p.changes.iter().all(|c| !c.path.starts_with(".claude/")));
    assert!(
        p.notes.iter().any(|n| n.contains("symbolic link")),
        "{:?}",
        p.notes
    );
    w.apply(&p);
    let lock = w.lock();
    let files = &lock.items[0].files;
    assert!(files.iter().all(|f| f.path.starts_with(".agents/skills/")));
    assert!(
        files
            .iter()
            .all(|f| f.clients == vec![ClientId::ClaudeCode, ClientId::Codex])
    );
    assert!(
        w.root
            .join(".claude/skills/jpa-entity-review/SKILL.md")
            .exists()
    );

    // Installing again is a no-op; removing deletes the real copy only.
    assert!(
        install(&w, std::slice::from_ref(&skill), &both, false)
            .changes
            .is_empty()
    );
    w.apply(&plan::plan_remove(&w.root, &[skill.key()], &none()).unwrap());
    assert!(!w.root.join(".agents/skills/jpa-entity-review").exists());
    assert!(
        std::fs::symlink_metadata(w.root.join(".claude/skills"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn copies_replaced_by_a_link_are_no_longer_tracked_separately() {
    use std::os::unix::fs::symlink;
    let w = world(None);
    let team = team_lib(&w.tmp);
    let skill = payload(&team, "jpa-entity-review");
    let both = [ClientId::ClaudeCode, ClientId::Codex];
    w.apply(&install(&w, std::slice::from_ref(&skill), &both, false));
    // The team switches to the linked layout.
    std::fs::remove_dir_all(w.root.join(".claude/skills")).unwrap();
    symlink("../.agents/skills", w.root.join(".claude/skills")).unwrap();
    let p = install(&w, std::slice::from_ref(&skill), &both, false);
    assert!(p.conflicts.is_empty(), "{:?}", p.conflicts);
    assert!(
        p.changes.iter().all(|c| c.path == ".habi/lock.json"),
        "{:?}",
        p.changes
    );
    w.apply(&p);
    assert!(
        w.lock().items[0]
            .files
            .iter()
            .all(|f| f.path.starts_with(".agents/skills/"))
    );
    assert!(
        w.root
            .join(".agents/skills/jpa-entity-review/SKILL.md")
            .exists()
    );
}

#[cfg(unix)]
#[test]
fn other_skill_folder_links_are_named_conflicts() {
    use std::os::unix::fs::symlink;
    let w = world(None);
    let team = team_lib(&w.tmp);
    std::fs::create_dir_all(w.root.join("shared/skills")).unwrap();
    std::fs::create_dir_all(w.root.join(".claude")).unwrap();
    symlink("../shared/skills", w.root.join(".claude/skills")).unwrap();
    let skill = payload(&team, "jpa-entity-review");
    let p = install(
        &w,
        std::slice::from_ref(&skill),
        &[ClientId::ClaudeCode],
        false,
    );
    assert_eq!(p.conflicts.len(), 1, "{:?}", p.conflicts);
    assert_eq!(p.conflicts[0].kind, ConflictKind::SymbolicLink);
    assert!(
        p.conflicts[0]
            .message
            .contains("shared/skills/jpa-entity-review")
    );

    let out = world(None);
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(out.root.join(".claude")).unwrap();
    symlink(elsewhere.path(), out.root.join(".claude/skills")).unwrap();
    let err = plan::plan_install(
        &out.root,
        std::slice::from_ref(&skill),
        &[ClientId::ClaudeCode],
        false,
        &none(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "pathEscape", "{err}");
}

#[test]
fn all_seven_clients_get_one_skill_copy_per_folder_and_each_their_own_mcp_file() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let a = payload(&team, "github-pr-summary");
    let p = install(&w, std::slice::from_ref(&a), &ClientId::ALL, true);
    // Copilot reads the file Claude Code reads, so the server is written once.
    assert!(
        p.notes
            .iter()
            .any(|n| n.contains("GitHub Copilot reads the same .mcp.json")),
        "{:?}",
        p.notes
    );
    w.apply(&p);

    let name = &a.item.name;
    for folder in [".agents/skills", ".claude/skills"] {
        assert!(w.root.join(format!("{folder}/{name}/SKILL.md")).is_file());
    }
    // Folders only one client owns are never written.
    for folder in [
        ".cursor/skills",
        ".gemini/skills",
        ".github/skills",
        ".opencode/skills",
        ".junie/skills",
    ] {
        assert!(!w.root.join(folder).exists(), "{folder}");
    }

    assert!(mcp_servers(&w, ".mcp.json").get("github").is_some());
    assert!(mcp_servers(&w, ".cursor/mcp.json").get("github").is_some());
    assert!(
        mcp_servers(&w, ".gemini/settings.json")
            .get("github")
            .is_some()
    );
    assert!(
        mcp_servers(&w, ".junie/mcp/mcp.json")
            .get("github")
            .is_some()
    );
    let opencode: serde_json::Value = serde_json::from_str(&w.read("opencode.json")).unwrap();
    assert_eq!(opencode["mcp"]["github"]["type"], "local");
    assert!(
        w.read(".codex/config.toml")
            .contains("[mcp_servers.github]")
    );

    let lock = w.lock();
    let item = lock.find(&a.key()).unwrap();
    let files: std::collections::BTreeSet<&str> =
        item.mcp.iter().map(|m| m.file.as_str()).collect();
    assert_eq!(item.mcp.len(), files.len(), "one entry per file");
    assert_eq!(files.len(), 6);
    assert_eq!(item.clients.len(), 7);

    // Removing the item takes out everything Habi created.
    w.apply(&plan::plan_remove(&w.root, &[a.key()], &none()).unwrap());
    for file in [
        ".mcp.json",
        ".cursor/mcp.json",
        ".codex/config.toml",
        ".gemini/settings.json",
        "opencode.json",
        ".junie/mcp/mcp.json",
    ] {
        assert!(!w.root.join(file).exists(), "{file} should be gone");
    }
    for folder in [".agents/skills", ".claude/skills"] {
        assert!(!w.root.join(folder).join(name).exists(), "{folder}/{name}");
    }
}

#[test]
fn copilot_joins_a_server_claude_code_already_has_from_another_item() {
    let w = world(None);
    let team = team_lib(&w.tmp);
    let (a, b) = github_pair(&team);
    w.apply(&install(
        &w,
        std::slice::from_ref(&a),
        &[ClientId::ClaudeCode],
        true,
    ));
    let p = install(&w, std::slice::from_ref(&b), &[ClientId::Copilot], true);
    assert!(
        p.notes
            .iter()
            .any(|n| n.contains("already has the `github` MCP server")),
        "{:?}",
        p.notes
    );
    w.apply(&p);
    // Still one entry in the file, kept while either item needs it.
    assert_eq!(mcp_servers(&w, ".mcp.json").as_object().unwrap().len(), 1);
    w.apply(&plan::plan_remove(&w.root, &[a.key()], &none()).unwrap());
    assert!(mcp_servers(&w, ".mcp.json").get("github").is_some());
    w.apply(&plan::plan_remove(&w.root, &[b.key()], &none()).unwrap());
    assert!(!w.root.join(".mcp.json").exists());
}
