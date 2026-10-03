//! Bounded, read-only traversal of a project directory.
//!
//! Respects `.gitignore`, `.ignore` and `.habiignore`, never follows symbolic
//! links, skips dependency and build-output directories, and stops at
//! explicit limits. When a limit stops the walk the report says so, and
//! matching then treats "no file matched" as unknown.

use super::model::ScanReport;
use crate::cancel::CancelToken;
use crate::error::Result;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// Directory names skipped by default: dependencies, build output, VCS data.
pub const DEFAULT_SKIPPED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "target",
    "build",
    "dist",
    "out",
    ".gradle",
    ".idea",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".pnpm-store",
    ".yarn",
    "coverage",
    ".terraform",
];

/// Skipped names that are also ordinary directory names (a Java package
/// `com/acme/build`, a `docs/out` folder). These are only skipped where they
/// are build output: at the project root, or directly inside a directory
/// that has a build manifest. Every other name in `DEFAULT_SKIPPED_DIRS` is
/// skipped at any depth.
pub const OUTPUT_DIR_NAMES: &[&str] = &[
    "target", "build", "dist", "out", "vendor", "venv", "coverage",
];

/// Files whose presence marks a directory as a build root, so that its
/// `OUTPUT_DIR_NAMES` children are treated as build output.
const BUILD_MANIFESTS: &[&str] = &[
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "composer.json",
    "Gemfile",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "build.sbt",
    "build.xml",
];

/// Whether a directory named `name` whose parent is `parent` is skipped.
pub fn skipped_dir(name: &str, parent: &Path, root: &Path) -> bool {
    if !DEFAULT_SKIPPED_DIRS.contains(&name) {
        return false;
    }
    if !OUTPUT_DIR_NAMES.contains(&name) {
        return true;
    }
    parent == root || BUILD_MANIFESTS.iter().any(|m| parent.join(m).is_file())
}

/// A chosen folder at a glance, before it is opened as a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FolderShape {
    /// `SKILL.md` files near the top (the folder itself and three levels
    /// down, hidden and dependency directories left out).
    pub skills: u32,
    /// Whether the folder itself has a build manifest.
    pub build_manifest: bool,
}

impl FolderShape {
    /// Skills and no build files: a library or a skill, not code to work on.
    pub fn is_skills(&self) -> bool {
        self.skills > 0 && !self.build_manifest
    }
}

/// Looks at the top of `root` only: a few hundred directories at most.
pub fn folder_shape(root: &Path) -> FolderShape {
    folder_shape_within(root, 3, 400)
}

/// `folder_shape`, at most `depth` levels down and `max_dirs` directories in.
pub fn folder_shape_within(root: &Path, depth_limit: usize, max_dirs: usize) -> FolderShape {
    let build_manifest = BUILD_MANIFESTS.iter().any(|m| root.join(m).is_file());
    let mut skills = 0;
    let mut visited = 0;
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0)]);
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > max_dirs {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Never follows symbolic links: `file_type` does not.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_file() && name == crate::library::SKILL_FILE {
                skills += 1;
            } else if kind.is_dir()
                && depth < depth_limit
                && !name.starts_with('.')
                && !DEFAULT_SKIPPED_DIRS.contains(&name.as_ref())
            {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
    FolderShape {
        skills,
        build_manifest,
    }
}

/// File names that may hold secrets. They are left out of the file index so
/// no pattern can surface them, and their contents are never read.
const SECRET_FILE_PATTERNS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    ".npmrc",
    ".netrc",
    ".pgpass",
];

/// True if a file name looks like it may hold secrets (never read or shown).
pub fn is_secret_name(name: &str) -> bool {
    static SET: std::sync::LazyLock<GlobSet> =
        std::sync::LazyLock::new(|| globset(SECRET_FILE_PATTERNS));
    SET.is_match(name)
}

#[derive(Debug, Clone)]
pub struct WalkOptions {
    pub max_files: u32,
    pub max_depth: usize,
    /// User exclusions: globs relative to the project root.
    pub exclusions: Vec<String>,
}

impl Default for WalkOptions {
    fn default() -> Self {
        WalkOptions {
            max_files: 50_000,
            max_depth: 24,
            exclusions: Vec::new(),
        }
    }
}

pub struct WalkResult {
    /// Repository-relative paths with their sizes, sorted.
    pub files: Vec<(String, u64)>,
    /// Repository-relative directories that were listed (`.` for the root),
    /// at most `MAX_TRACKED_DIRS`. Used to notice added or removed files.
    pub dirs: Vec<String>,
    /// Directories or entries that could not be read. When non-zero, the file
    /// listing is incomplete.
    pub errors: u32,
    pub report: ScanReport,
}

/// Upper bound on directories remembered for staleness checks.
pub const MAX_TRACKED_DIRS: usize = 20_000;

fn globset(patterns: &[&str]) -> GlobSet {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        b.add(Glob::new(p).expect("built-in pattern"));
    }
    b.build().expect("built-in patterns")
}

pub fn walk(root: &Path, options: &WalkOptions, cancel: &CancelToken) -> Result<WalkResult> {
    let started = Instant::now();
    let mut report = ScanReport::default();

    let mut exclusions = GlobSetBuilder::new();
    for pattern in &options.exclusions {
        match Glob::new(pattern) {
            Ok(g) => {
                exclusions.add(g);
            }
            Err(_) => report
                .limits_hit
                .push(format!("ignored invalid exclusion pattern `{pattern}`")),
        }
    }
    let exclusions = exclusions.build().unwrap_or_else(|_| GlobSet::empty());
    let secrets = globset(SECRET_FILE_PATTERNS);

    let root_owned = root.to_path_buf();
    let skip_exclusions = exclusions.clone();
    // The depth limit is enforced here rather than with `max_depth`, which
    // stops silently: anything below the limit marks the scan truncated.
    let max_depth = options.max_depth;
    let too_deep = Arc::new(AtomicBool::new(false));
    let too_deep_flag = Arc::clone(&too_deep);
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .add_custom_ignore_filename(".habiignore")
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir {
                let name = entry.file_name().to_string_lossy();
                let parent = entry.path().parent().unwrap_or(&root_owned);
                if skipped_dir(&name, parent, &root_owned) {
                    return false;
                }
            }
            let excluded = match entry.path().strip_prefix(&root_owned) {
                Ok(rel) => skip_exclusions.is_match(rel),
                Err(_) => false,
            };
            if excluded {
                return false;
            }
            if entry.depth() > max_depth {
                too_deep_flag.store(true, Ordering::Relaxed);
                return false;
            }
            true
        })
        .build();

    let mut files = Vec::new();
    let mut dirs = vec![".".to_string()];
    let mut errors = 0u32;
    for entry in walker {
        cancel.check()?;
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                // Unreadable directories or entries leave the listing
                // incomplete; problems in ignore files do not.
                if err.io_error().is_some() || err.is_io() {
                    errors += 1;
                }
                if report.unreadable.len() < 100 {
                    report
                        .unreadable
                        .push(crate::redact::redact(&err.to_string()));
                }
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            report.symlinks_skipped += 1;
            continue;
        }
        if file_type.is_dir() {
            if dirs.len() < MAX_TRACKED_DIRS {
                dirs.push(rel);
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if secrets.is_match(entry.file_name()) {
            continue;
        }
        if files.len() as u32 >= options.max_files {
            report.truncated = true;
            report.limits_hit.push(format!(
                "stopped after {} files; file-pattern checks are incomplete",
                options.max_files
            ));
            break;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push((rel, size));
    }

    // Record which default-skipped directories exist at the top levels so the
    // UI can explain what was not looked at.
    for name in DEFAULT_SKIPPED_DIRS {
        if root.join(name).is_dir() {
            report.directories_skipped.push((*name).to_string());
        }
    }
    for pattern in &options.exclusions {
        report
            .directories_skipped
            .push(format!("{pattern} (your exclusion)"));
    }
    if too_deep.load(Ordering::Relaxed) {
        report.truncated = true;
        report.limits_hit.push(format!(
            "directories deeper than {} levels were not listed; file-pattern checks are incomplete",
            options.max_depth
        ));
    }

    files.sort();
    report.files_seen = files.len() as u32;
    report.elapsed_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    Ok(WalkResult {
        files,
        dirs,
        errors,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn skips_dependencies_ignored_paths_and_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("node_modules/react")).unwrap();
        fs::write(root.join("node_modules/react/package.json"), "{}").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.ts"), "").unwrap();
        fs::write(root.join("generated.ts"), "").unwrap();
        fs::write(root.join(".gitignore"), "generated.ts\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(root.join("private")).unwrap();
        fs::write(root.join("private/notes.md"), "").unwrap();

        let opts = WalkOptions {
            exclusions: vec!["private".into()],
            ..Default::default()
        };
        let result = walk(root, &opts, &CancelToken::new()).unwrap();
        let names: Vec<&str> = result.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, vec![".gitignore", "src/app.ts"]);
        assert!(!result.report.truncated);
    }

    #[test]
    fn reports_truncation() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("f{i}.txt")), "").unwrap();
        }
        let opts = WalkOptions {
            max_files: 3,
            ..Default::default()
        };
        let result = walk(dir.path(), &opts, &CancelToken::new()).unwrap();
        assert!(result.report.truncated);
        assert_eq!(result.files.len(), 3);
    }

    #[test]
    fn depth_limit_marks_the_scan_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("a/b/c/d");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("Dockerfile"), "").unwrap();
        fs::write(dir.path().join("a/top.txt"), "").unwrap();
        let opts = WalkOptions {
            max_depth: 3,
            ..Default::default()
        };
        let result = walk(dir.path(), &opts, &CancelToken::new()).unwrap();
        let names: Vec<&str> = result.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, vec!["a/top.txt"]);
        assert!(result.report.truncated, "{:?}", result.report);
        assert!(
            result
                .report
                .limits_hit
                .iter()
                .any(|l| l.contains("deeper")),
            "{:?}",
            result.report.limits_hit
        );

        // Within the limit nothing is reported.
        let result = walk(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert!(!result.report.truncated);
    }

    #[test]
    fn output_names_are_skipped_only_where_they_are_build_output() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A Java package named `build`, `out` and `dist` is source code.
        let pkg = root.join("api/src/main/java/com/acme/build");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(pkg.join("Builder.java"), "").unwrap();
        fs::create_dir_all(root.join("docs/out")).unwrap();
        fs::write(root.join("docs/out/guide.md"), "").unwrap();
        // Build output next to a manifest, and at the root, is skipped.
        fs::write(root.join("api/pom.xml"), "<project/>").unwrap();
        fs::create_dir_all(root.join("api/target/classes")).unwrap();
        fs::write(root.join("api/target/classes/A.class"), "").unwrap();
        fs::create_dir_all(root.join("api/build")).unwrap();
        fs::write(root.join("api/build/out.txt"), "").unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/app.js"), "").unwrap();
        // Unambiguous names are skipped anywhere.
        fs::create_dir_all(root.join("docs/node_modules/x")).unwrap();
        fs::write(root.join("docs/node_modules/x/index.js"), "").unwrap();

        let result = walk(root, &WalkOptions::default(), &CancelToken::new()).unwrap();
        let names: Vec<&str> = result.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "api/pom.xml",
                "api/src/main/java/com/acme/build/Builder.java",
                "docs/out/guide.md",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn folder_shape_tells_a_skills_folder_from_a_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("skills/review-a-pull-request")).unwrap();
        fs::write(root.join("skills/review-a-pull-request/SKILL.md"), "").unwrap();
        let shape = folder_shape(root);
        assert_eq!(shape.skills, 1);
        assert!(shape.is_skills());

        // A single skill folder, chosen directly.
        assert!(folder_shape(&root.join("skills/review-a-pull-request")).is_skills());

        // A project with skills installed for its agents is still a project.
        fs::write(root.join("package.json"), "{}").unwrap();
        assert!(!folder_shape(root).is_skills());

        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join(".claude/skills/x")).unwrap();
        fs::write(project.path().join(".claude/skills/x/SKILL.md"), "").unwrap();
        fs::create_dir_all(project.path().join("node_modules/y")).unwrap();
        fs::write(project.path().join("node_modules/y/SKILL.md"), "").unwrap();
        assert_eq!(folder_shape(project.path()).skills, 0);
    }

    #[test]
    fn unreadable_directories_are_counted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("Dockerfile"), "").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let result = walk(dir.path(), &WalkOptions::default(), &CancelToken::new());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let result = result.unwrap();
        // Running as root can read anything; nothing to check then.
        if result.files.iter().any(|(p, _)| p == "locked/Dockerfile") {
            return;
        }
        assert_eq!(result.errors, 1, "{:?}", result.report.unreadable);
        assert!(!result.report.unreadable.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("pom.xml"), "<project/>").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
        let result = walk(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert!(result.files.is_empty());
        assert_eq!(result.report.symlinks_skipped, 1);
    }
}
