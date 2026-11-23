//! Subagents: single Markdown files a library offers beside its skills. What
//! is read as one, where it is written for each client, what is asked before
//! it is, and how it is updated and removed.

mod common;

use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::install::lock::LockFile;
use habi_core::install::plan::{ChangeKind, ConflictKind, Decisions, Plan};
use habi_core::library::model::{ItemKind, LibraryItem};
use habi_core::library::signals::{SignalKind, SignalSeverity};
use habi_core::service::{Habi, ItemRef};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::{Path, PathBuf};
use std::process::Command;

const REVIEWER: &str = "---\nname: code-reviewer\ndescription: Reviews a change. Use after writing code.\n---\n\nFollow the `code-review` skill, then `test-gaps`.\n";
const HOOKED: &str = "---\nname: deployer\ndescription: Deploys. Use when asked to ship.\npermissionMode: bypassPermissions\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./notify.sh\n---\n\nDeploy it.\n";

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn skill(name: &str) -> String {
    format!("---\nname: {name}\ndescription: Does {name}. Use when asked.\n---\n\nDo it.\n")
}

struct Env {
    _dirs: Vec<tempfile::TempDir>,
    habi: Habi,
    home: PathBuf,
    library: PathBuf,
    project: PathBuf,
    project_id: String,
    source_id: String,
}

impl Env {
    fn new(manifest: &str) -> Env {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        write(lib.path(), "habi-library.yaml", manifest);
        write(
            lib.path(),
            "skills/code-review/SKILL.md",
            &skill("code-review"),
        );
        write(lib.path(), "skills/test-gaps/SKILL.md", &skill("test-gaps"));
        write(lib.path(), "agents/code-reviewer.md", REVIEWER);
        write(lib.path(), "agents/deployer.md", HOOKED);
        write(
            lib.path(),
            "agents/README.md",
            "# Agents\n\nNotes for people.\n",
        );
        write(lib.path(), "agents/drafts/later.md", REVIEWER);
        git(lib.path(), &["init", "-q"]);
        git(lib.path(), &["add", "-A"]);
        git(lib.path(), &["commit", "-qm", "init"]);
        write(proj.path(), "README.md", "# A project\n");
        let habi = Habi::open(AppPaths::at(data.path().to_path_buf()))
            .unwrap()
            .with_user_home(home.path().to_path_buf());
        let source = habi
            .sources()
            .add(&NewSource {
                name: "Team library".into(),
                location: lib.path().to_string_lossy().into(),
                subdir: None,
                tracked: TrackedRef::Branch {
                    name: "main".into(),
                },
            })
            .unwrap();
        habi.sources()
            .refresh(&source.id, &CancelToken::new())
            .unwrap();
        let project = habi.open_project(proj.path()).unwrap();
        Env {
            home: home.path().to_path_buf(),
            library: lib.path().to_path_buf(),
            project: project.root.clone(),
            project_id: project.id,
            source_id: source.id,
            habi,
            _dirs: vec![data, home, lib, proj],
        }
    }

    fn with_agents() -> Env {
        Env::new("habi: 1\nname: Team\nskills_root: skills\nagents_root: agents\n")
    }

    fn items(&self) -> Vec<LibraryItem> {
        let libraries = self.habi.libraries().unwrap();
        libraries
            .into_iter()
            .find(|(s, _)| s.id == self.source_id)
            .unwrap()
            .1
            .items
    }

    fn item(&self, id: &str) -> LibraryItem {
        self.items().into_iter().find(|i| i.id == id).unwrap()
    }

    fn plan(&self, id: &str, clients: &[ClientId]) -> Plan {
        let item = ItemRef {
            source_id: self.source_id.clone(),
            item_id: id.into(),
        };
        self.habi
            .plan_install(&self.project_id, &[item], clients, false, &Decisions::new())
            .unwrap()
    }

    fn change_library(&self, rel: &str, text: &str) {
        write(&self.library, rel, text);
        git(&self.library, &["add", "-A"]);
        git(&self.library, &["commit", "-qm", "change"]);
        self.habi
            .sources()
            .refresh(&self.source_id, &CancelToken::new())
            .unwrap();
    }
}

fn paths(plan: &Plan) -> Vec<&str> {
    plan.changes.iter().map(|c| c.path.as_str()).collect()
}

#[test]
fn only_a_library_that_names_a_folder_has_subagents() {
    let without = Env::new("habi: 1\nname: Team\nskills_root: skills\n");
    assert!(without.items().iter().all(|i| i.kind != ItemKind::Agent));

    let env = Env::with_agents();
    let agents: Vec<LibraryItem> = env
        .items()
        .into_iter()
        .filter(|i| i.kind == ItemKind::Agent)
        .collect();
    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    // Not the README (no frontmatter), and nothing in a folder below.
    assert_eq!(ids, ["code-reviewer", "deployer"]);

    let reviewer = env.item("code-reviewer");
    assert_eq!(reviewer.path, "agents/code-reviewer.md");
    assert_eq!(reviewer.files.len(), 1);
    assert_eq!(reviewer.files[0].path, "code-reviewer.md");
    assert_eq!(reviewer.calls, ["code-review", "test-gaps"]);
    assert_eq!(
        reviewer.clients.as_deref(),
        Some(&[ClientId::ClaudeCode, ClientId::Cursor, ClientId::Junie][..])
    );
    assert!(
        reviewer
            .signals
            .iter()
            .all(|s| s.severity != SignalSeverity::Caution)
    );
}

#[test]
fn what_a_subagent_sets_for_itself_is_a_caution() {
    let env = Env::with_agents();
    let deployer = env.item("deployer");
    let caution = |kind: SignalKind| {
        deployer
            .signals
            .iter()
            .any(|s| s.kind == kind && s.severity == SignalSeverity::Caution)
    };
    assert!(caution(SignalKind::AutoRun), "{:?}", deployer.signals);
    assert!(
        caution(SignalKind::ToolPermission),
        "{:?}",
        deployer.signals
    );
    assert!(
        deployer
            .signals
            .iter()
            .all(|s| s.path == "agents/deployer.md"),
        "{:?}",
        deployer.signals
    );

    let plan = env.plan("deployer", &[ClientId::ClaudeCode]);
    assert!(plan.cautions() > 0);
    assert!(env.habi.apply(&plan.id).is_err());
    assert!(!env.project.join(".claude/agents/deployer.md").exists());
    env.habi.apply_accepting_cautions(&plan.id).unwrap();
    assert!(env.project.join(".claude/agents/deployer.md").is_file());
}

#[test]
fn a_subagent_is_written_once_for_each_folder_the_chosen_tools_read() {
    let env = Env::with_agents();
    let plan = env.plan(
        "code-reviewer",
        &[
            ClientId::ClaudeCode,
            ClientId::Cursor,
            ClientId::Codex,
            ClientId::Junie,
        ],
    );
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    let mut written = paths(&plan);
    written.sort_unstable();
    assert_eq!(
        written,
        [
            ".claude/agents/code-reviewer.md",
            ".habi/lock.json",
            ".junie/agents/code-reviewer.md"
        ]
    );
    let file = plan
        .changes
        .iter()
        .find(|c| c.path == ".claude/agents/code-reviewer.md")
        .unwrap();
    assert_eq!(file.kind, ChangeKind::AgentFile);
    assert_eq!(file.clients, [ClientId::ClaudeCode, ClientId::Cursor]);
    assert!(
        plan.notes.iter().any(|n| n.contains("Codex")),
        "{:?}",
        plan.notes
    );
    env.habi.apply(&plan.id).unwrap();
    assert_eq!(
        std::fs::read_to_string(env.project.join(".claude/agents/code-reviewer.md")).unwrap(),
        REVIEWER
    );

    // Cursor alone has a folder of its own.
    let other = Env::with_agents();
    let alone = other.plan("code-reviewer", &[ClientId::Cursor]);
    assert!(paths(&alone).contains(&".cursor/agents/code-reviewer.md"));
    // A tool with no such files gets nothing, and the plan says why.
    let none = other.plan("code-reviewer", &[ClientId::Codex]);
    assert!(none.changes.is_empty(), "{:?}", paths(&none));
    assert!(none.notes.iter().any(|n| n.contains("Codex")));
}

#[test]
fn a_lock_that_lists_a_subagent_says_it_is_newer_and_keeps_to_one_file() {
    let env = Env::with_agents();
    let skill = env.plan("code-review", &[ClientId::ClaudeCode]);
    env.habi.apply(&skill.id).unwrap();
    let lock_path = env.project.join(".habi/lock.json");
    let before = LockFile::parse(&std::fs::read(&lock_path).unwrap()).unwrap();
    assert_eq!(before.habi_lock, 1);

    let plan = env.plan("code-reviewer", &[ClientId::ClaudeCode]);
    env.habi.apply(&plan.id).unwrap();
    let text = std::fs::read_to_string(&lock_path).unwrap();
    let lock = LockFile::parse(text.as_bytes()).unwrap();
    assert_eq!(lock.habi_lock, 2);
    let agent = lock.items.iter().find(|i| i.id == "code-reviewer").unwrap();
    assert_eq!(agent.kind, ItemKind::Agent);

    // A lock is a file anyone can edit, and Habi deletes what it lists.
    for elsewhere in [
        ".claude/settings.json",
        ".claude/agents/team/code-reviewer.md",
        ".claude/skills/code-review/SKILL.md",
        ".agents/code-reviewer.md",
    ] {
        let edited = text.replace(".claude/agents/code-reviewer.md", elsewhere);
        assert!(LockFile::parse(edited.as_bytes()).is_err(), "{elsewhere}");
    }
}

#[test]
fn an_update_follows_the_library_and_asks_again_about_a_changed_caution() {
    let env = Env::with_agents();
    let plan = env.plan("code-reviewer", &[ClientId::ClaudeCode, ClientId::Junie]);
    let key = plan.items[0].key.clone();
    env.habi.apply(&plan.id).unwrap();

    env.change_library(
        "agents/code-reviewer.md",
        &REVIEWER.replace("---\n\n", "permissionMode: acceptEdits\n---\n\n"),
    );
    let update = env
        .habi
        .plan_update(
            &env.project_id,
            std::slice::from_ref(&key),
            false,
            &Decisions::new(),
        )
        .unwrap();
    assert_eq!(update.cautions(), 1, "{:?}", update.items[0].new_signals);
    let mut changed = paths(&update);
    changed.sort_unstable();
    assert_eq!(
        changed,
        [
            ".claude/agents/code-reviewer.md",
            ".habi/lock.json",
            ".junie/agents/code-reviewer.md"
        ]
    );
    env.habi.apply_accepting_cautions(&update.id).unwrap();

    env.change_library(
        "agents/code-reviewer.md",
        &REVIEWER.replace(
            "---\n\n",
            "permissionMode: acceptEdits\n---\n\nBe brief.\n\n",
        ),
    );
    let again = env
        .habi
        .plan_update(
            &env.project_id,
            std::slice::from_ref(&key),
            false,
            &Decisions::new(),
        )
        .unwrap();
    // Accepted once, but it sits in the file that changed, so it is asked about again.
    assert_eq!(again.cautions(), 1, "{:?}", again.items[0].new_signals);
    env.habi.apply_accepting_cautions(&again.id).unwrap();

    let remove = env
        .habi
        .plan_remove(&env.project_id, &[key], &Decisions::new())
        .unwrap();
    env.habi.apply(&remove.id).unwrap();
    assert!(!env.project.join(".claude/agents/code-reviewer.md").exists());
    assert!(!env.project.join(".junie/agents/code-reviewer.md").exists());
    // The folders are the tools' own, so they stay.
    assert!(env.project.join(".claude/agents").is_dir());
}

#[test]
fn a_subagent_installs_on_this_machine_too() {
    let env = Env::with_agents();
    let item = ItemRef {
        source_id: env.source_id.clone(),
        item_id: "code-reviewer".into(),
    };
    let plan = env
        .habi
        .plan_install_machine(&[item], &[ClientId::ClaudeCode], &Decisions::new())
        .unwrap();
    assert_eq!(plan.root, env.home);
    env.habi.apply(&plan.id).unwrap();
    assert!(env.home.join(".claude/agents/code-reviewer.md").is_file());
    assert!(!env.project.join(".claude").exists());
}

#[cfg(unix)]
#[test]
fn a_link_another_installer_left_is_not_written_through() {
    let env = Env::with_agents();
    let theirs = env.project.join("their-agents/code-reviewer.md");
    write(&env.project, "their-agents/code-reviewer.md", "theirs\n");
    std::fs::create_dir_all(env.project.join(".claude/agents")).unwrap();
    std::os::unix::fs::symlink(&theirs, env.project.join(".claude/agents/code-reviewer.md"))
        .unwrap();
    let plan = env.plan("code-reviewer", &[ClientId::ClaudeCode]);
    assert_eq!(plan.conflicts.len(), 1, "{:?}", plan.conflicts);
    assert_eq!(plan.conflicts[0].kind, ConflictKind::SymbolicLink);
    assert!(plan.conflicts[0].message.contains("Remove the link"));
    assert!(env.habi.apply(&plan.id).is_err());
    assert_eq!(std::fs::read_to_string(&theirs).unwrap(), "theirs\n");
}

#[test]
fn a_subagent_with_a_name_a_folder_cannot_hold_is_listed_but_not_installed() {
    let env = Env::with_agents();
    env.change_library(
        "agents/Big Reviewer.md",
        "---\nname: big-reviewer\ndescription: Reviews. Use when asked.\n---\n\nReview.\n",
    );
    let item = env.item("big-reviewer");
    assert!(!habi_core::recommend::installable(&item));
    let asked = ItemRef {
        source_id: env.source_id.clone(),
        item_id: "big-reviewer".into(),
    };
    let refused = env.habi.plan_install(
        &env.project_id,
        &[asked],
        &[ClientId::ClaudeCode],
        false,
        &Decisions::new(),
    );
    assert!(refused.is_err());
}
