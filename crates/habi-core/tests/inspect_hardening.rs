//! Repositories are untrusted input. Each test here is a repository built to
//! hang, exhaust or mislead inspection, and says what inspection does instead.

use habi_core::cancel::CancelToken;
use habi_core::inspect::model::{CoverageStatus, ProjectInspection};
use habi_core::inspect::{WalkOptions, inspect};
use habi_core::matching::condition::Condition;
use habi_core::matching::{Applicability, Scope, assess};
use serde_json::json;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn inspected(root: &Path) -> ProjectInspection {
    inspect(root, &WalkOptions::default(), &CancelToken::new()).unwrap()
}

/// Fails rather than hangs if `work` does not finish in `seconds`: the thread is
/// left behind, and the test binary's exit takes it down.
fn within<T: Send + 'static>(seconds: u64, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(work());
    });
    receive
        .recv_timeout(Duration::from_secs(seconds))
        .expect("finished in time")
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let made = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .unwrap();
    assert!(made.success());
}

fn coverage(i: &ProjectInspection, module: &str, area: &str) -> CoverageStatus {
    i.coverage
        .iter()
        .find(|c| c.module == module && c.area == area)
        .map(|c| c.status)
        .unwrap_or_else(|| panic!("no {area} coverage for {module}"))
}

// Ignore files.

#[cfg(unix)]
#[test]
fn an_ignore_file_linked_to_a_device_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink("/dev/zero", dir.path().join(".gitignore")).unwrap();
    write(dir.path(), "pom.xml", "<project/>");
    let root = dir.path().to_path_buf();
    let i = within(30, move || inspected(&root));
    assert_eq!(i.scan.symlinks_skipped, 1);
    assert_eq!(coverage(&i, ".", "files"), CoverageStatus::Partial);
    assert!(
        i.scan.unreadable.iter().any(|u| u.contains(".gitignore")),
        "{:?}",
        i.scan.unreadable
    );
}

#[cfg(unix)]
#[test]
fn a_fifo_named_like_an_ignore_file_does_not_block() {
    for fifo in [
        ".gitignore",
        ".ignore",
        ".habiignore",
        "sub/.gitignore",
        "sub/.habiignore",
        ".git/info/exclude",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "sub/app.txt", "");
        mkfifo(&dir.path().join(fifo));
        let root = dir.path().to_path_buf();
        let i = within(30, move || inspected(&root));
        assert!(i.files.iter().any(|f| f == "sub/app.txt"), "{fifo}");
        assert_eq!(
            coverage(&i, ".", "files"),
            CoverageStatus::Partial,
            "{fifo}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_fifo_in_a_skipped_folder_is_never_looked_at() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "app.txt", "");
    mkfifo(&dir.path().join("node_modules/.gitignore"));
    let root = dir.path().to_path_buf();
    let i = within(30, move || inspected(&root));
    assert_eq!(coverage(&i, ".", "files"), CoverageStatus::Complete);
}

#[test]
fn a_parent_ignore_file_does_not_hide_a_repository_below_it() {
    // The bare-dotfiles habit: `*` in a `.gitignore` in the home folder.
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ".gitignore", "*\n");
    write(dir.path(), "code/app/.git/HEAD", "ref: refs/heads/main\n");
    write(dir.path(), "code/app/pom.xml", "<project/>");
    let i = inspected(&dir.path().join("code/app"));
    assert_eq!(i.files, vec!["pom.xml"]);
    assert_eq!(i.modules.len(), 1);
    assert!(
        i.modules[0]
            .ecosystems
            .contains(&habi_core::inspect::model::Ecosystem::Maven)
    );
}

#[test]
fn a_subdirectory_of_a_repository_keeps_its_rules() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "repo/.git/HEAD", "ref: refs/heads/main\n");
    write(dir.path(), "repo/.gitignore", "generated.txt\n");
    write(dir.path(), "repo/svc/app.txt", "");
    write(dir.path(), "repo/svc/generated.txt", "");
    let i = inspected(&dir.path().join("repo/svc"));
    assert_eq!(i.files, vec!["app.txt"]);
}

// Git metadata.

#[cfg(unix)]
#[test]
fn a_fifo_at_git_head_does_not_block() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "app.txt", "");
    mkfifo(&dir.path().join(".git/HEAD"));
    let root = dir.path().to_path_buf();
    let i = within(30, move || inspected(&root));
    assert_eq!(i.repository.branch, None);
}

fn outcome(i: &ProjectInspection, rule: serde_json::Value, scope: Scope) -> Applicability {
    let rule = Condition::parse(&rule).unwrap();
    assess(Some(&rule), None, scope, i, &[]).applicability
}

/// One small manifest with very many dependencies: every old cost here grew
/// with the square of them. The budget is minutes below what that took, and
/// far above what a debug build needs now.
fn reads_quickly(file: &str, text: String) -> ProjectInspection {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), file, &text);
    let root = dir.path().to_path_buf();
    let started = Instant::now();
    let i = within(30, move || {
        let i = inspected(&root);
        drop(dir);
        i
    });
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "{file} took {:?}",
        started.elapsed()
    );
    i
}

fn dependency_line(i: &ProjectInspection, id: &str) -> Option<u32> {
    i.fact(id)?.evidence.first()?.line
}

#[test]
fn a_pyproject_with_a_dependency_per_line_reads_in_linear_time() {
    let deps: String = (0..20_000).map(|n| format!("  \"pkg{n}>=1\",\n")).collect();
    let i = reads_quickly(
        "pyproject.toml",
        format!("[project]\nname = \"x\"\ndependencies = [\n{deps}]\n"),
    );
    assert_eq!(dependency_line(&i, "dep:.:pypi:pkg19999"), Some(20_003));
}

#[test]
fn a_pyproject_with_all_dependencies_on_one_line_reads_in_linear_time() {
    let deps: Vec<String> = (0..100_000).map(|n| format!("\"p{n}\"")).collect();
    let i = reads_quickly(
        "pyproject.toml",
        format!(
            "[project]\nname = \"x\"\ndependencies = [{}]\n",
            deps.join(",")
        ),
    );
    assert_eq!(dependency_line(&i, "dep:.:pypi:p99999"), Some(3));
}

#[test]
fn a_package_json_with_many_dependencies_reads_in_linear_time() {
    let deps: Vec<String> = (0..110_000).map(|n| format!("\n\"p{n}\":\"1\"")).collect();
    let i = reads_quickly(
        "package.json",
        format!("{{\"dependencies\":{{{}}}}}", deps.join(",")),
    );
    assert_eq!(dependency_line(&i, "dep:.:npm:p109999"), Some(110_001));
}

#[test]
fn a_composer_json_with_many_dependencies_reads_in_linear_time() {
    let deps: Vec<String> = (0..100_000)
        .map(|n| format!("\n\"v/p{n}\":\"1\""))
        .collect();
    let i = reads_quickly(
        "composer.json",
        format!("{{\"require\":{{{}}}}}", deps.join(",")),
    );
    assert_eq!(
        dependency_line(&i, "dep:.:composer:v/p99999"),
        Some(100_001)
    );
}

#[test]
fn a_pom_with_many_dependencies_reads_in_linear_time() {
    let deps: String = (0..26_000)
        .map(|n| {
            format!("<dependency><groupId>g</groupId><artifactId>a{n}</artifactId></dependency>\n")
        })
        .collect();
    let i = reads_quickly(
        "pom.xml",
        format!("<project>\n<dependencies>\n{deps}</dependencies></project>"),
    );
    assert_eq!(dependency_line(&i, "dep:.:maven:g:a25999"), Some(26_002));
}

#[test]
fn a_cargo_toml_with_many_dependencies_reads_in_linear_time() {
    let deps: String = (0..100_000).map(|n| format!("c{n} = \"1\"\n")).collect();
    let i = reads_quickly("Cargo.toml", format!("[dependencies]\n{deps}"));
    assert_eq!(dependency_line(&i, "dep:.:cargo:c99999"), Some(100_001));
}

#[test]
fn a_build_gradle_of_open_braces_reads_in_linear_time() {
    let i = reads_quickly("build.gradle", "{a".repeat(1_000_000));
    assert_eq!(coverage(&i, ".", "gradle"), CoverageStatus::Partial);
    let notes = &i
        .coverage
        .iter()
        .find(|c| c.area == "gradle")
        .unwrap()
        .notes;
    assert!(notes.iter().any(|n| n.contains("nested")), "{notes:?}");
}

#[test]
fn a_block_past_the_depth_limit_does_not_lose_what_follows_it() {
    let braces = 1_000;
    let i = reads_quickly(
        "build.gradle",
        format!(
            "{}\ndependencies {{ implementation 'g:deep:1' }}\n{}\ndependencies {{\n  implementation 'g:after:1'\n}}\n",
            "x {\n".repeat(braces),
            "}\n".repeat(braces)
        ),
    );
    assert!(i.fact("dep:.:gradle:g:after").is_some());
    assert!(i.fact("dep:.:gradle:g:deep").is_none());
}

// Budgets across a repository.

#[test]
fn modules_past_the_limit_are_dropped_and_the_scan_says_so() {
    let dir = tempfile::tempdir().unwrap();
    // The deepest are dropped first, so a manifest at the top is always read.
    write(
        dir.path(),
        "top/package.json",
        r#"{"dependencies":{"react":"^18.2.0"}}"#,
    );
    for n in 0..2_100 {
        write(dir.path(), &format!("deep/{n}/package.json"), "{}");
    }
    let started = Instant::now();
    let i = inspected(dir.path());
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(i.modules.len(), 2_000);
    assert!(i.scan.truncated);
    assert!(i.fact("dep:top:npm:react").is_some());
    assert_eq!(coverage(&i, ".", "files"), CoverageStatus::Partial);
    // What a dropped module declares is not established.
    assert_eq!(
        outcome(&i, json!({"dependency": "org.x:y"}), Scope::Repository),
        Applicability::NeedsInformation
    );

    // One evaluation stays small enough to send per skill, per overview.
    let rule = Condition::parse(&json!({"dependency": "org.x:y"})).unwrap();
    let started = Instant::now();
    let result = assess(Some(&rule), None, Scope::Module, &i, &[]);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(result.applicability, Applicability::NeedsInformation);
    assert_eq!(result.modules.len(), 2_000);
    let size = serde_json::to_string(&result).unwrap().len();
    assert!(size < 1024 * 1024, "{size} bytes");
}

#[test]
fn a_module_finds_its_parent_past_a_sibling_with_the_same_prefix() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "package.json", "{}");
    write(dir.path(), "a/package.json", "{}");
    write(dir.path(), "a/b/c/package.json", "{}");
    write(dir.path(), "a-b/package.json", "{}");
    let i = inspected(dir.path());
    let parent = |id: &str| i.module(id).unwrap().parent.clone();
    assert_eq!(parent("."), None);
    assert_eq!(parent("a").as_deref(), Some("."));
    assert_eq!(parent("a/b/c").as_deref(), Some("a"));
    assert_eq!(parent("a-b").as_deref(), Some("."));
    assert_eq!(i.ancestors("a/b/c"), vec!["a", "."]);
}

fn fan_out(dir: &Path, deps: usize, children: usize) {
    let deps: String = (0..deps)
        .map(|n| {
            format!("<dependency><groupId>g</groupId><artifactId>a{n}</artifactId><version>1</version></dependency>")
        })
        .collect();
    write(
        dir,
        "pom.xml",
        &format!(
            "<project><groupId>g</groupId><artifactId>root</artifactId><dependencies>{deps}</dependencies></project>"
        ),
    );
    for n in 0..children {
        write(
            dir,
            &format!("c{n}/pom.xml"),
            "<project><parent><groupId>g</groupId><artifactId>root</artifactId></parent><artifactId>c</artifactId></project>",
        );
    }
}

#[test]
fn a_parent_pom_fanning_out_to_its_children_stays_quick() {
    let dir = tempfile::tempdir().unwrap();
    fan_out(dir.path(), 2_000, 100);
    let started = Instant::now();
    let i = inspected(dir.path());
    assert!(
        started.elapsed() < Duration::from_secs(25),
        "{:?}",
        started.elapsed()
    );
    assert!(i.facts.len() > 200_000);
    assert_eq!(coverage(&i, "c99", "maven"), CoverageStatus::Complete);
}

#[test]
fn a_parent_pom_past_the_fact_limit_leaves_absence_open() {
    let dir = tempfile::tempdir().unwrap();
    fan_out(dir.path(), 26_000, 50);
    let started = Instant::now();
    let i = inspected(dir.path());
    assert!(
        started.elapsed() < Duration::from_secs(25),
        "{:?}",
        started.elapsed()
    );
    assert!(i.facts.len() < 260_000, "{}", i.facts.len());
    assert_eq!(coverage(&i, "c9", "maven"), CoverageStatus::Partial);
    assert_eq!(
        outcome(&i, json!({"dependency": "org.x:y"}), Scope::Repository),
        Applicability::NeedsInformation
    );
}

#[test]
fn gradle_subprojects_fanning_out_stay_quick() {
    let dir = tempfile::tempdir().unwrap();
    let deps: String = (0..2_000)
        .map(|n| format!("    implementation 'g:a{n}:1'\n"))
        .collect();
    write(
        dir.path(),
        "build.gradle",
        &format!("subprojects {{\n  dependencies {{\n{deps}  }}\n}}\n"),
    );
    for n in 0..100 {
        write(dir.path(), &format!("s{n}/build.gradle"), "");
    }
    let started = Instant::now();
    let i = inspected(dir.path());
    assert!(
        started.elapsed() < Duration::from_secs(25),
        "{:?}",
        started.elapsed()
    );
    assert!(i.fact("dep:s99:gradle:g:a1999").is_some());
}

// Coverage notes.

#[test]
fn a_build_gradle_of_script_plugins_keeps_evaluations_small() {
    let i = reads_quickly("build.gradle", "apply from: x\n".repeat(140_000));
    let gradle = i.coverage.iter().find(|c| c.area == "gradle").unwrap();
    assert!(gradle.notes.len() <= 21, "{}", gradle.notes.len());
    let rule = Condition::parse(&json!({"dependency": "org.x:y"})).unwrap();
    for scope in [Scope::Module, Scope::Repository] {
        let result = assess(Some(&rule), None, scope, &i, &[]);
        assert_eq!(result.applicability, Applicability::NeedsInformation);
        let size = serde_json::to_string(&result).unwrap().len();
        assert!(size < 16 * 1024, "{size} bytes");
        assert!(result.reason.contains("more"), "{}", result.reason);
    }
}

// What is not established stays unknown.

fn assert_all_unknown(i: &ProjectInspection, rules: &[serde_json::Value]) {
    for rule in rules {
        for scope in [Scope::Module, Scope::Repository] {
            assert_eq!(
                outcome(i, rule.clone(), scope),
                Applicability::NeedsInformation,
                "{rule} in {scope:?}"
            );
        }
    }
}

fn absence_rules() -> Vec<serde_json::Value> {
    vec![
        json!({"dependency": "org.x:y"}),
        json!({"tag": "framework:spring-boot"}),
        json!({"not": {"dependency": "org.x:y"}}),
        json!({"not": {"tag": "framework:spring-boot"}}),
        json!({"file": "**/pom.xml"}),
    ]
}

#[test]
fn a_walk_stopped_by_a_limit_leaves_absence_unknown() {
    let dir = tempfile::tempdir().unwrap();
    for n in 0..5 {
        write(dir.path(), &format!("f{n}.txt"), "");
    }
    let options = WalkOptions {
        max_files: 2,
        ..Default::default()
    };
    let i = inspect(dir.path(), &options, &CancelToken::new()).unwrap();
    assert!(i.scan.truncated);
    assert_all_unknown(&i, &absence_rules());

    // A walk that finished can say a thing is absent.
    let i = inspected(dir.path());
    assert_eq!(
        outcome(&i, json!({"dependency": "org.x:y"}), Scope::Module),
        Applicability::DoesNotApply
    );
    assert_eq!(
        outcome(&i, json!({"tag": "framework:spring-boot"}), Scope::Module),
        Applicability::DoesNotApply
    );
    assert_eq!(
        outcome(&i, json!({"not": {"dependency": "org.x:y"}}), Scope::Module),
        Applicability::Applies
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_folder_leaves_absence_unknown() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "app.txt", "");
    write(dir.path(), "locked/pom.xml", "<project/>");
    let locked = dir.path().join("locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new());
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let i = i.unwrap();
    if i.files.iter().any(|f| f == "locked/pom.xml") {
        return; // running with privileges that read anything
    }
    assert_all_unknown(&i, &absence_rules());
    // A dependency with a manifest beside it is just as open.
    write(dir.path(), "package.json", "{}");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new());
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_all_unknown(&i.unwrap(), &absence_rules());
}

#[test]
fn an_ignore_file_not_applied_leaves_absence_unknown() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "app.txt", "");
    write(dir.path(), ".gitignore", &"# padding\n".repeat(120_000));
    let i = inspected(dir.path());
    assert_eq!(coverage(&i, ".", "files"), CoverageStatus::Partial);
    assert_all_unknown(&i, &absence_rules());
}

#[test]
fn setup_py_leaves_python_dependencies_unknown() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "setup.py",
        "from setuptools import setup\nsetup(install_requires=[\"django>=5\"])\n",
    );
    let i = inspected(dir.path());
    assert_eq!(coverage(&i, ".", "pypi"), CoverageStatus::Partial);
    let pypi = i.coverage.iter().find(|c| c.area == "pypi").unwrap();
    assert!(pypi.notes[0].contains("setup.py"), "{:?}", pypi.notes);
    assert_all_unknown(
        &i,
        &[
            json!({"dependency": "django"}),
            json!({"tag": "framework:django"}),
            json!({"not": {"dependency": "django"}}),
        ],
    );
    // Beside it, what is declared is still found.
    write(dir.path(), "requirements.txt", "flask\n");
    let i = inspected(dir.path());
    assert_eq!(coverage(&i, ".", "pypi"), CoverageStatus::Partial);
    assert_eq!(
        outcome(&i, json!({"dependency": "flask"}), Scope::Module),
        Applicability::Applies
    );
    assert_all_unknown(&i, &[json!({"dependency": "django"})]);
}

#[test]
fn a_requirements_file_that_includes_another_leaves_dependencies_unknown() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "requirements.txt", "-r deps/prod.in\n");
    write(dir.path(), "deps/prod.in", "django==5.0\n");
    let i = inspected(dir.path());
    assert_eq!(coverage(&i, ".", "pypi"), CoverageStatus::Partial);
    assert_all_unknown(
        &i,
        &[
            json!({"dependency": "django"}),
            json!({"tag": "framework:django"}),
        ],
    );

    // A `requirements/` folder is read for itself, so what it lists is known.
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "requirements.txt", "-r requirements/prod.txt\n");
    write(dir.path(), "requirements/prod.txt", "django==5.0\n");
    let i = inspected(dir.path());
    assert!(i.fact("dep:.:pypi:django").is_some());
    assert!(i.modules.iter().all(|m| m.id != "requirements"));
}

#[test]
fn a_direct_reference_and_a_byte_order_mark_are_read() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "requirements.txt",
        "\u{feff}flask==3.0\ndjango @ git+https://example.com/django/django\n",
    );
    let i = inspected(dir.path());
    assert_eq!(coverage(&i, ".", "pypi"), CoverageStatus::Complete);
    for rule in [
        json!({"dependency": "flask"}),
        json!({"dependency": "django"}),
        json!({"tag": "framework:django"}),
    ] {
        assert_eq!(
            outcome(&i, rule.clone(), Scope::Module),
            Applicability::Applies,
            "{rule}"
        );
    }
}

#[test]
fn a_large_openapi_document_is_still_probed() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "api/openapi.json",
        r#"{ "openapi": "3.0.3", "info": {}, "padding": ""#,
    );
    // Only the start of a file is read, however long the rest. Sparse where it can be.
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("api/openapi.json"))
        .unwrap();
    file.set_len(9 * 1024 * 1024).unwrap();
    drop(file);
    let i = inspected(dir.path());
    assert_eq!(coverage(&i, ".", "content"), CoverageStatus::Complete);
    assert_eq!(
        outcome(&i, json!({"tag": "api:openapi"}), Scope::Repository),
        Applicability::Applies
    );
}

#[test]
fn a_byte_order_mark_does_not_hide_a_recognized_document() {
    for (file, text, tag) in [
        (
            "openapi.yaml",
            "\u{feff}openapi: 3.0.3\ninfo: {}\n",
            "api:openapi",
        ),
        (
            "openapi.json",
            "\u{feff}{\"openapi\": \"3.1.0\"}",
            "api:openapi",
        ),
        ("swagger.yml", "\u{feff}swagger: \"2.0\"\n", "api:openapi"),
        (
            "db/changelog.yaml",
            "\u{feff}databaseChangeLog:\n  - changeSet: {}\n",
            "db:liquibase",
        ),
        (
            "db/changelog.sql",
            "\u{feff}-- liquibase formatted sql\n",
            "db:liquibase",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), file, text);
        let i = inspected(dir.path());
        assert_eq!(
            outcome(&i, json!({ "tag": tag }), Scope::Repository),
            Applicability::Applies,
            "{file}"
        );
    }
}
