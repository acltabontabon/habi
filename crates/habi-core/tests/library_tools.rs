//! Tools a library ships: a command its skills call, kept outside any skill
//! folder. What is read as one, that it is installed only on a person's own
//! machine and only after they accept it, and that it leaves nothing behind.

mod common;

use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::install::lock::LockFile;
use habi_core::install::plan::{ChangeKind, ConflictKind, Decisions, Plan, Resolution};
use habi_core::library::model::{ItemKind, LibraryItem};
use habi_core::library::signals::SignalKind;
use habi_core::service::{Habi, ItemRef};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::path::{Path, PathBuf};
use std::process::Command;

const MANIFEST: &str = "habi: 1\nname: Team\nskills_root: skills\ntools:\n  - name: eng\n    entry: bin/eng\n    paths: [bin/eng, \"src/eng/**\"]\n    requires:\n      tools:\n        - name: Python\n          commands: [python3]\n";
const SKILL: &str =
    "---\nname: review\ndescription: Reviews. Use when asked.\n---\n\nRun `eng review`.\n";
const NEEDS: &str = "habi: 1\nrequires:\n  tools:\n    - name: eng\n      commands: [eng]\n";

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
        write(lib.path(), "skills/review/SKILL.md", SKILL);
        write(lib.path(), "skills/review/habi.yaml", NEEDS);
        write(lib.path(), "bin/eng", "#!/bin/sh\necho eng\n");
        write(lib.path(), "src/eng/cli.py", "print('eng')\n");
        write(lib.path(), "src/eng/sub/more.py", "print('more')\n");
        write(lib.path(), "src/other/not-part.py", "print('no')\n");
        write(lib.path(), "docs/notes.md", "# Notes\n");
        git(lib.path(), &["init", "-q"]);
        git(lib.path(), &["add", "-A"]);
        git(lib.path(), &["update-index", "--chmod=+x", "bin/eng"]);
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

    fn item(&self, id: &str) -> LibraryItem {
        let libraries = self.habi.libraries().unwrap();
        let (_, index) = libraries
            .into_iter()
            .find(|(s, _)| s.id == self.source_id)
            .unwrap();
        index.items.into_iter().find(|i| i.id == id).unwrap()
    }

    fn eng(&self) -> ItemRef {
        ItemRef {
            source_id: self.source_id.clone(),
            item_id: "eng".into(),
        }
    }

    fn plan(&self, decisions: &Decisions) -> Plan {
        self.habi
            .plan_install_machine(&[self.eng()], &[], decisions)
            .unwrap()
    }

    fn install(&self) -> String {
        let plan = self.plan(&Decisions::new());
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        let key = plan.items[0].key.clone();
        self.habi.apply_accepting_cautions(&plan.id).unwrap();
        key
    }

    fn change_library(&self, rel: &str, text: &str) {
        write(&self.library, rel, text);
        git(&self.library, &["add", "-A"]);
        // The file on disk was written without the bit; the index is what counts.
        git(&self.library, &["update-index", "--chmod=+x", "bin/eng"]);
        git(&self.library, &["commit", "-qm", "change"]);
        self.habi
            .sources()
            .refresh(&self.source_id, &CancelToken::new())
            .unwrap();
    }

    fn left_in_home(&self) -> Vec<String> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    out.push(path.strip_prefix(root).unwrap().to_string_lossy().into());
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.home, &self.home, &mut out);
        out.sort();
        out
    }
}

#[test]
fn a_tool_is_the_files_its_paths_name_and_skills_that_need_it_say_so() {
    let env = Env::new(MANIFEST);
    let tool = env.item("eng");
    assert_eq!(tool.kind, ItemKind::Tool);
    let files: Vec<&str> = tool.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(files, ["bin/eng", "src/eng/cli.py", "src/eng/sub/more.py"]);
    assert_eq!(tool.tool.as_ref().unwrap().command, "eng");
    assert_eq!(tool.tools[0].name, "Python");
    assert!(habi_core::recommend::installable(&tool));

    let skill = env.item("review");
    assert_eq!(skill.tools[0].provided_by.as_deref(), Some("eng"));

    // A tool is for a person's machine: no project is offered it.
    let overview = env
        .habi
        .overview(&env.project_id, true, &CancelToken::new())
        .unwrap();
    assert!(overview.recommendations.iter().all(|r| r.item.id != "eng"));
    let needs = overview
        .recommendations
        .iter()
        .find(|r| r.item.id == "review")
        .unwrap();
    assert!(
        needs
            .readiness
            .prerequisites
            .iter()
            .any(|p| p.provided_by.as_deref() == Some("eng"))
    );
}

#[test]
fn a_tool_that_does_not_hold_together_is_listed_but_not_installed() {
    for (manifest, why) in [
        (
            MANIFEST.replace("entry: bin/eng", "entry: bin/missing"),
            "not among its paths",
        ),
        (
            MANIFEST.replace("bin/eng, \"src/eng/**\"", "\"src/eng/**\""),
            "not among its paths",
        ),
        (
            MANIFEST.replace("entry: bin/eng", "entry: src/eng/cli.py"),
            "not marked executable",
        ),
    ] {
        let env = Env::new(&manifest);
        let tool = env.item("eng");
        assert!(
            tool.diagnostics.iter().any(|d| d.message.contains(why)),
            "{:?}",
            tool.diagnostics
        );
        assert!(!habi_core::recommend::installable(&tool));
        assert!(
            env.habi
                .plan_install_machine(&[env.eng()], &[], &Decisions::new())
                .is_err()
        );
    }
    // A name Habi itself looks up on PATH is never a library's to take.
    let env = Env::new(&MANIFEST.replace("name: eng\n", "name: eng\n    command: git\n"));
    let refused = env
        .habi
        .plan_install_machine(&[env.eng()], &[], &Decisions::new())
        .unwrap_err();
    assert!(
        refused.to_string().contains("already relies on"),
        "{refused}"
    );
}

#[test]
fn a_tool_installs_on_this_machine_only_and_only_once_accepted() {
    let env = Env::new(MANIFEST);
    let in_project = env.habi.plan_install(
        &env.project_id,
        &[env.eng()],
        &[ClientId::ClaudeCode],
        false,
        &Decisions::new(),
    );
    assert!(
        in_project
            .unwrap_err()
            .to_string()
            .contains("not in a project")
    );

    let plan = env.plan(&Decisions::new());
    assert_eq!(plan.title, "Install eng on this machine");
    let mut paths: Vec<&str> = plan.changes.iter().map(|c| c.path.as_str()).collect();
    paths.sort_unstable();
    let launcher = if cfg!(windows) {
        ".local/bin/eng.cmd"
    } else {
        ".local/bin/eng"
    };
    assert_eq!(
        paths,
        [
            ".habi/lock.json",
            ".habi/tools/eng/bin/eng",
            ".habi/tools/eng/src/eng/cli.py",
            ".habi/tools/eng/src/eng/sub/more.py",
            launcher,
        ]
    );
    let kind = |path: &str| plan.changes.iter().find(|c| c.path == path).unwrap().kind;
    assert_eq!(kind(launcher), ChangeKind::ToolCommand);
    assert_eq!(kind(".habi/tools/eng/bin/eng"), ChangeKind::ToolFile);
    assert!(
        plan.items[0]
            .signals
            .iter()
            .any(|s| s.kind == SignalKind::AddsCommand)
    );
    assert!(plan.notes.iter().any(|n| n.contains("not on your PATH")));

    // Nothing is written by looking, and nothing without a yes to the caution.
    assert!(env.left_in_home().is_empty());
    assert!(env.habi.apply(&plan.id).is_err());
    assert!(env.left_in_home().is_empty());
    env.habi.apply_accepting_cautions(&plan.id).unwrap();

    let script = std::fs::read_to_string(env.home.join(launcher)).unwrap();
    let entry = env.home.join(".habi/tools/eng/bin/eng");
    assert!(script.contains(&*entry.to_string_lossy()), "{script}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(script.lines().count(), 2);
        for file in [env.home.join(launcher), entry] {
            assert_ne!(file.metadata().unwrap().permissions().mode() & 0o111, 0);
        }
    }
    let lock = LockFile::parse(&std::fs::read(env.home.join(".habi/lock.json")).unwrap()).unwrap();
    assert_eq!(lock.items[0].kind, ItemKind::Tool);
    assert!(lock.items[0].clients.is_empty());
    assert!(!env.project.join(".habi").exists());

    let listed = env.habi.machine_installations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].state,
        habi_core::install::status::InstallState::Current
    );
}

#[test]
fn an_update_asks_again_and_removal_leaves_nothing() {
    let env = Env::new(MANIFEST);
    let key = env.install();

    // Installing what is already there changes nothing and asks nothing.
    let again = env.plan(&Decisions::new());
    assert!(again.changes.is_empty(), "{:?}", again.changes.len());
    assert_eq!(again.cautions(), 0);

    env.change_library("src/eng/cli.py", "print('eng 2')\n");
    let update = env
        .habi
        .plan_update_machine(std::slice::from_ref(&key), &Decisions::new())
        .unwrap();
    assert_eq!(update.cautions(), 1, "{:?}", update.items[0].new_signals);
    assert!(env.habi.apply(&update.id).is_err());
    env.habi.apply_accepting_cautions(&update.id).unwrap();
    assert_eq!(
        std::fs::read_to_string(env.home.join(".habi/tools/eng/src/eng/cli.py")).unwrap(),
        "print('eng 2')\n"
    );

    // What running the tool left in its folder goes with it.
    write(
        &env.home,
        ".habi/tools/eng/src/eng/__pycache__/cli.pyc",
        "cache",
    );
    let remove = env
        .habi
        .plan_remove_machine(&[key], &Decisions::new())
        .unwrap();
    assert!(
        remove
            .changes
            .iter()
            .any(|c| c.path.ends_with("__pycache__/cli.pyc"))
    );
    env.habi.apply(&remove.id).unwrap();
    assert!(env.left_in_home().is_empty(), "{:?}", env.left_in_home());
    assert!(!env.home.join(".habi/tools").exists());
    assert!(env.home.join(".local/bin").is_dir());
}

#[test]
fn a_command_that_is_already_there_is_asked_about_not_replaced() {
    let env = Env::new(MANIFEST);
    let launcher = if cfg!(windows) {
        ".local/bin/eng.cmd"
    } else {
        ".local/bin/eng"
    };
    write(&env.home, launcher, "mine\n");
    let plan = env.plan(&Decisions::new());
    assert_eq!(plan.conflicts.len(), 1, "{:?}", plan.conflicts);
    assert_eq!(plan.conflicts[0].kind, ConflictKind::UnmanagedContent);
    assert!(env.habi.apply_accepting_cautions(&plan.id).is_err());
    assert_eq!(
        std::fs::read_to_string(env.home.join(launcher)).unwrap(),
        "mine\n"
    );

    let mut keep = Decisions::new();
    keep.insert(launcher.to_string(), Resolution::Keep);
    let kept = env.plan(&keep);
    assert!(kept.conflicts.is_empty());
    env.habi.apply_accepting_cautions(&kept.id).unwrap();
    assert_eq!(
        std::fs::read_to_string(env.home.join(launcher)).unwrap(),
        "mine\n"
    );
}

#[cfg(unix)]
#[test]
fn a_link_where_the_command_goes_is_not_written_through() {
    let env = Env::new(MANIFEST);
    let theirs = env.library.join("bin/eng");
    std::fs::create_dir_all(env.home.join(".local/bin")).unwrap();
    std::os::unix::fs::symlink(&theirs, env.home.join(".local/bin/eng")).unwrap();
    let before = std::fs::read(&theirs).unwrap();
    let plan = env.plan(&Decisions::new());
    assert_eq!(plan.conflicts.len(), 1, "{:?}", plan.conflicts);
    assert_eq!(plan.conflicts[0].kind, ConflictKind::SymbolicLink);
    assert!(env.habi.apply_accepting_cautions(&plan.id).is_err());
    assert_eq!(std::fs::read(&theirs).unwrap(), before);
}

#[test]
fn a_lock_file_cannot_send_a_tool_anywhere_else() {
    let env = Env::new(MANIFEST);
    env.install();
    let lock = env.home.join(".habi/lock.json");
    let text = std::fs::read_to_string(&lock).unwrap();
    for elsewhere in [
        ".ssh/authorized_keys",
        ".local/bin/git",
        ".local/bin/git-credential-x",
        ".zshrc",
        ".claude/skills/a/SKILL.md",
    ] {
        let edited = text.replace(".local/bin/eng", elsewhere);
        assert!(LockFile::parse(edited.as_bytes()).is_err(), "{elsewhere}");
    }
    // A project's lock is shared: a tool listed there is refused, not acted on.
    write(&env.project, ".habi/lock.json", &text);
    let skill = ItemRef {
        source_id: env.source_id.clone(),
        item_id: "review".into(),
    };
    let refused = env.habi.plan_install(
        &env.project_id,
        &[skill],
        &[ClientId::ClaudeCode],
        false,
        &Decisions::new(),
    );
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("never in a project")
    );
}
