//! What a project's list of fits says: where to start, in a stated order, with
//! each reason true of the modules it is given for, and without what a skill
//! only names in passing.

use habi_core::cancel::CancelToken;
use habi_core::recommend::{Group, Recommendation};
use habi_core::service::{Habi, ProjectOverview};
use habi_core::source::{NewSource, TrackedRef};
use habi_core::store::AppPaths;
use std::fs;
use std::path::Path;

fn write(root: &Path, path: &str, text: &str) {
    let file = root.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, text).unwrap();
}

/// A skill with no `habi.yaml`: only its own words say what it is for.
fn skill(library: &Path, name: &str, description: &str) {
    write(
        library,
        &format!("skills/{name}/SKILL.md"),
        &format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nSteps.\n"),
    );
}

struct Fixture {
    habi: Habi,
    _home: tempfile::TempDir,
    _library: tempfile::TempDir,
}

fn connected(skills: &[(&str, &str)], declared: &[(&str, &str)]) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    write(
        library.path(),
        "habi-library.yaml",
        "habi: 1\nname: Words (example)\nowner: Example\ndescription: Example skills.\nskills_root: skills\n",
    );
    for (name, description) in skills {
        skill(library.path(), name, description);
    }
    for (name, applies_when) in declared {
        skill(library.path(), name, "A way of working.");
        write(
            library.path(),
            &format!("skills/{name}/habi.yaml"),
            &format!("habi: 1\ntitle: {name}\napplies_when:\n{applies_when}\n"),
        );
    }
    let habi = Habi::open(AppPaths::at(home.path().to_path_buf())).unwrap();
    let source = habi
        .sources()
        .add(&NewSource {
            name: "Words".into(),
            location: library.path().to_string_lossy().into(),
            subdir: None,
            tracked: TrackedRef::Default,
        })
        .unwrap();
    habi.sources()
        .refresh(&source.id, &CancelToken::new())
        .unwrap();
    Fixture {
        habi,
        _home: home,
        _library: library,
    }
}

/// An app with a native shell under the same name, a crate with tests, and one
/// CI folder at the root.
fn app_repo() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    write(
        root,
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/core\", \"apps/web/src-tauri\"]\n",
    );
    write(root, ".github/workflows/ci.yml", "on: push\njobs: {}\n");
    write(
        root,
        "apps/web/package.json",
        r#"{"name":"web","dependencies":{"react":"19.0.0"},"devDependencies":{"vitest":"3.0.0"}}"#,
    );
    write(root, "apps/web/src/main.tsx", "export const a = 1;\n");
    write(
        root,
        "apps/web/src-tauri/Cargo.toml",
        "[package]\nname = \"web\"\nversion = \"0.1.0\"\n",
    );
    write(root, "apps/web/src-tauri/src/main.rs", "fn main() {}\n");
    write(
        root,
        "crates/core/Cargo.toml",
        "[package]\nname = \"core\"\nversion = \"0.1.0\"\n",
    );
    write(root, "crates/core/src/lib.rs", "pub fn a() {}\n");
    write(root, "crates/core/tests/it.rs", "#[test]\nfn a() {}\n");
    repo
}

fn overview(habi: &Habi, repo: &Path) -> ProjectOverview {
    let project = habi.open_project(repo).unwrap();
    habi.overview(&project.id, true, &CancelToken::new())
        .unwrap()
}

fn rec<'a>(overview: &'a ProjectOverview, name: &str) -> &'a Recommendation {
    overview
        .recommendations
        .iter()
        .find(|r| r.item.name == name)
        .unwrap_or_else(|| panic!("{name} is listed"))
}

fn tops(overview: &ProjectOverview) -> Vec<&str> {
    overview
        .recommendations
        .iter()
        .filter(|r| r.top)
        .map(|r| r.item.name.as_str())
        .collect()
}

const TESTS_RULE: &str = "  any:\n    - tag: test:vitest\n    - file: \"**/tests/*.rs\"";

fn app_fixture() -> Fixture {
    connected(
        &[
            ("react-best-practices", "React guidelines."),
            ("react-state-management", "React state."),
            (
                "react-view-transitions",
                "Animate between views with the React View Transition API.",
            ),
            (
                "web-artifacts-builder",
                "Build rich artifacts using modern web technologies (React, Tailwind).",
            ),
            ("rust-patterns", "Idiomatic Rust."),
            (
                "github-actions-hardening",
                "Harden GitHub Actions workflows.",
            ),
        ],
        &[("tests-first", TESTS_RULE)],
    )
}

#[test]
fn modules_that_share_a_name_are_told_apart() {
    let fixture = app_fixture();
    let repo = app_repo();
    let overview = overview(&fixture.habi, repo.path());
    let names: Vec<&str> = overview
        .inspection
        .modules
        .iter()
        .map(|m| m.name.as_str())
        .collect();
    assert!(
        names.contains(&"web") && names.contains(&"web/src-tauri"),
        "{names:?}"
    );
    // A workspace is said, so `inspect` has something to print beside "monorepo".
    assert!(overview.inspection.repository.is_monorepo);
    assert!(
        overview
            .inspection
            .repository
            .workspace_signals
            .iter()
            .any(|s| s.contains("Cargo workspace")),
        "{:?}",
        overview.inspection.repository.workspace_signals
    );
}

#[test]
fn a_reason_is_true_of_the_modules_it_is_given_for() {
    let fixture = app_fixture();
    let repo = app_repo();
    let overview = overview(&fixture.habi, repo.path());

    // One root folder is a fact about the repository, not about each module.
    let ci = &rec(&overview, "github-actions-hardening").applicability;
    assert!(
        ci.reason.starts_with("Applies to the whole repository — "),
        "{}",
        ci.reason
    );
    assert!(ci.reason.contains("Uses GitHub Actions"), "{}", ci.reason);

    // What holds differently in each module is said for each.
    let tests = &rec(&overview, "tests-first").applicability.reason;
    assert!(tests.starts_with("Applies to 2 of"), "{tests}");
    assert!(tests.contains("web: Uses Vitest"), "{tests}");
    assert!(tests.contains("core: Has files matching"), "{tests}");

    // What holds alike keeps one reason, naming the modules.
    let rust = &rec(&overview, "rust-patterns").applicability.reason;
    assert!(rust.contains("(web/src-tauri, core) — "), "{rust}");
    assert!(rust.contains("Rust"), "{rust}");
}

#[test]
fn a_skill_only_naming_a_technology_does_not_fit() {
    let fixture = app_fixture();
    let repo = app_repo();
    let overview = overview(&fixture.habi, repo.path());

    let narrower = rec(&overview, "react-view-transitions");
    assert_eq!(narrower.group, Group::Available);
    assert!(narrower.applicability.modules.is_empty());
    assert!(
        narrower.applicability.reason.contains("Named for React")
            && narrower.applicability.reason.contains("narrower"),
        "{}",
        narrower.applicability.reason
    );

    let passing = rec(&overview, "web-artifacts-builder");
    assert_eq!(passing.group, Group::Available);
    assert!(
        passing.applicability.reason.contains("only in passing"),
        "{}",
        passing.applicability.reason
    );
}

#[test]
fn the_list_says_where_to_start() {
    let fixture = app_fixture();
    let repo = app_repo();
    let overview = overview(&fixture.habi, repo.path());

    // The author's rule first, then what the project is built on before how it
    // is shipped, one technology each, and not on a language its words name alone.
    assert_eq!(
        tops(&overview),
        [
            "tests-first",
            "react-best-practices",
            "github-actions-hardening"
        ]
    );
    // They lead the group, so the list reads in the order it is explained.
    let fits: Vec<&Recommendation> = overview
        .recommendations
        .iter()
        .filter(|r| r.group == Group::Relevant)
        .collect();
    assert!(fits.iter().take(3).all(|r| r.top), "top three lead");
    assert!(fits.iter().skip(3).all(|r| !r.top));
    assert_eq!(fits.len(), 5, "and the rest stay listed");
}

#[test]
fn what_the_project_has_is_not_where_to_start() {
    let fixture = app_fixture();
    let repo = app_repo();
    write(
        repo.path(),
        ".claude/skills/react-best-practices/SKILL.md",
        "---\nname: react-best-practices\ndescription: Our copy.\n---\n\nSteps.\n",
    );
    let overview = overview(&fixture.habi, repo.path());
    let started = tops(&overview);
    assert!(!started.contains(&"react-best-practices"), "{started:?}");
    assert!(started.contains(&"react-state-management"), "{started:?}");
}

#[test]
fn places_left_go_to_the_next_best() {
    let fixture = connected(
        &[
            ("react-best-practices", "React guidelines."),
            ("react-state-management", "React state."),
            ("react-testing", "React tests."),
            ("react-performance", "React performance."),
        ],
        &[],
    );
    let repo = tempfile::tempdir().unwrap();
    write(
        repo.path(),
        "package.json",
        r#"{"name":"web","dependencies":{"react":"19.0.0"}}"#,
    );
    let overview = overview(&fixture.habi, repo.path());
    assert_eq!(
        tops(&overview).len(),
        3,
        "one technology still fills the list"
    );
}

#[test]
fn nothing_to_start_with_when_nothing_fits() {
    let fixture = connected(&[("django-admin-review", "Review Django admin.")], &[]);
    let repo = app_repo();
    let overview = overview(&fixture.habi, repo.path());
    assert!(tops(&overview).is_empty());
}
