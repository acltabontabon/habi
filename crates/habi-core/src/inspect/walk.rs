//! Bounded, read-only traversal of a project directory.
//!
//! Respects `.gitignore`, `.ignore`, `.habiignore` and `.git/info/exclude` (see
//! `ignores`), never follows symbolic links, skips dependency and build-output
//! directories, and stops at explicit limits. When a limit stops the walk the
//! report says so, and matching then treats "no file matched" as unknown.

use super::ignores::IgnoreStack;
use super::model::ScanReport;
use crate::cancel::CancelToken;
use crate::error::Result;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
    ".terragrunt-cache",
    ".databricks",
    ".angular",
    ".nx",
    ".parcel-cache",
    ".vite",
    ".kotlin",
    ".m2",
    ".tox",
    ".nox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
    "site-packages",
    ".serverless",
    ".aws-sam",
    "cdk.out",
    // Credential stores, should a project or a home folder hold one.
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".gnupg",
    ".password-store",
];

/// Skipped names that are also ordinary directory names (a Java package
/// `com/acme/build`, a `docs/out` folder). These are only skipped where they
/// are build output: at the project root, or directly inside a directory
/// that has a build manifest. Every other name in `DEFAULT_SKIPPED_DIRS` is
/// skipped at any depth. A root with no manifest keeps the names in
/// `SOURCE_AT_A_BARE_ROOT`.
pub const OUTPUT_DIR_NAMES: &[&str] = &[
    "target", "build", "dist", "out", "vendor", "venv", "coverage",
];

/// Output names that hold sources in a repository with no build of its own:
/// `build/Dockerfile` in a Terraform repository, `vendor/` in a folder of scripts.
const SOURCE_AT_A_BARE_ROOT: &[&str] = &["build", "out", "vendor"];

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
    "CMakeLists.txt",
    "meson.build",
];

/// Files listed even past the file limit, so that a tree full of data does not
/// hide what the project is. They stay bounded by `MAX_LISTED_PAST_LIMIT`.
const LISTED_PAST_LIMIT: &[&str] = &[
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "libs.versions.toml",
    "package.json",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "pyproject.toml",
    "Pipfile",
    "requirements.txt",
    "setup.py",
    "Dockerfile",
    "Chart.yaml",
    "kustomization.yaml",
    "databricks.yml",
];
/// Files kept past the file limit.
const MAX_LISTED_PAST_LIMIT: usize = 5_000;
/// Entries looked at in all, as a multiple of the file limit: past it the walk
/// stops, however little it has found.
const WALK_ENTRIES_PER_FILE: usize = 8;

/// Whether a directory named `name` whose parent is `parent` is skipped.
pub fn skipped_dir(name: &str, parent: &Path, root: &Path) -> bool {
    if !DEFAULT_SKIPPED_DIRS.contains(&name) {
        return false;
    }
    if !OUTPUT_DIR_NAMES.contains(&name) {
        return true;
    }
    let beside_a_manifest = BUILD_MANIFESTS.iter().any(|m| parent.join(m).is_file());
    beside_a_manifest || (parent == root && !SOURCE_AT_A_BARE_ROOT.contains(&name))
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
    ".git-credentials",
    ".dockercfg",
    "credentials",
    "credentials.json",
    "*.tfvars",
    "*.tfvars.json",
    // Terraform state and plans hold every secret a run touched, in clear text.
    "*.tfstate",
    "*.tfstate.*",
    "*.tfplan",
    "tfplan",
    "tfplan.*",
    ".terraformrc",
    "terraform.rc",
    "kubeconfig",
    "kubeconfig.*",
    "service-account*.json",
    "service_account*.json",
    "application_default_credentials.json",
    "client_secret*.json",
    ".databrickscfg",
    ".pypirc",
    ".boto",
    ".s3cfg",
    ".htpasswd",
    ".dockerconfigjson",
    ".vault-token",
    ".vault_pass*",
    ".vault-password*",
    "vault.yml",
    "vault.yaml",
    // Kubernetes secrets and encrypted or plain values files.
    "secret.yaml",
    "secret.yml",
    "secrets.yaml",
    "secrets.yml",
    "secrets.json",
    "secrets.toml",
    "secrets.properties",
    "*-secret.yaml",
    "*-secret.yml",
    "*-secrets.yaml",
    "*-secrets.yml",
    "*.secret.yaml",
    "*.secrets.yaml",
    "values-secret*",
    "values.secret*",
    "*.sops.yaml",
    "*.sops.yml",
    "*.sops.json",
    "*.kdbx",
    "*.ppk",
    "*.ovpn",
];

/// A path that holds credentials under a name that is ordinary elsewhere.
const SECRET_PATHS: &[&str] = &[".docker/config.json"];

fn is_secret_path(rel: &str) -> bool {
    SECRET_PATHS
        .iter()
        .any(|p| rel == *p || rel.strip_suffix(p).is_some_and(|d| d.ends_with('/')))
}

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
    /// Ignore files that could not be applied. The listing may hold files they
    /// would leave out, so what it says is not established either.
    pub ignore_gaps: Vec<String>,
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

/// The skill folders directly in `base`, a folder an agent reads whatever Git
/// tracks. A repository often ignores `.claude`, and what is in it still reaches
/// the agent. Only Git's say is set aside: `.habiignore`, `.ignore` and the
/// project's exclusions hold, and links are not entered, as in a walk. Rules that
/// could not all be applied find nothing. Nothing else ignored is looked at, and
/// what this finds is no part of a walk, so it says nothing of the project's stack.
pub fn skill_folders_in(
    root: &Path,
    base: &str,
    file: &str,
    exclusions: &[String],
    cancel: &CancelToken,
) -> Vec<String> {
    let mut excluded = GlobSetBuilder::new();
    for glob in exclusions.iter().filter_map(|p| Glob::new(p).ok()) {
        excluded.add(glob);
    }
    let excluded = excluded.build().unwrap_or_else(|_| GlobSet::empty());
    let mut rules = IgnoreStack::new(root, cancel.clone());
    let mut left_out = |rel: &str, depth: usize, is_dir: bool| {
        excluded.is_match(rel) || rules.asked_to_skip(&root.join(rel), depth, is_dir)
    };

    let mut depth = 0;
    let mut here = String::new();
    for part in base.split('/') {
        here = if here.is_empty() {
            part.to_string()
        } else {
            format!("{here}/{part}")
        };
        depth += 1;
        let real = std::fs::symlink_metadata(root.join(&here)).is_ok_and(|m| m.is_dir());
        if !real || left_out(&here, depth, true) {
            return Vec::new();
        }
    }
    let Ok(listing) = std::fs::read_dir(root.join(base)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = listing
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    let parent = root.join(base);
    let found: Vec<String> = names
        .into_iter()
        .filter(|name| !skipped_dir(name, &parent, root))
        .filter_map(|name| {
            let dir = format!("{base}/{name}");
            let skill = format!("{dir}/{file}");
            let is_skill = std::fs::symlink_metadata(root.join(&skill)).is_ok_and(|m| m.is_file());
            (is_skill && !left_out(&dir, depth + 1, true) && !left_out(&skill, depth + 2, false))
                .then_some(dir)
        })
        .collect();
    if rules.take_gaps().is_empty() {
        found
    } else {
        Vec::new()
    }
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
    let ignores = Arc::new(Mutex::new(IgnoreStack::new(root, cancel.clone())));
    let filter_ignores = Arc::clone(&ignores);
    let filter_cancel = cancel.clone();
    // Every ignore file option is off: the crate opens those files with no
    // limit, and follows links to do so. `IgnoreStack` reads them instead.
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .git_global(false)
        .ignore(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            // In a tree where everything is ignored nothing reaches the loop
            // below, so this is the only place to notice.
            if filter_cancel.is_cancelled() {
                return false;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            let ignored = filter_ignores
                .lock()
                .is_ok_and(|mut rules| rules.ignored(entry.path(), entry.depth(), is_dir));
            if ignored {
                return false;
            }
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
    let mut past_limit = 0usize;
    let mut entries = 0usize;
    let max_entries = (options.max_files as usize).saturating_mul(WALK_ENTRIES_PER_FILE);
    let walk_limit =
        |max: u32| format!("stopped after {max} files; file-pattern checks are incomplete");
    for entry in walker {
        cancel.check()?;
        entries += 1;
        if entries > max_entries {
            if !report.truncated {
                report.truncated = true;
                report.limits_hit.push(walk_limit(options.max_files));
            }
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                // Unreadable directories or entries leave the listing incomplete.
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
        if secrets.is_match(entry.file_name()) || is_secret_path(&rel) {
            continue;
        }
        // Past the limit only what says what the project is stays listed.
        if files.len() as u32 >= options.max_files {
            if !report.truncated {
                report.truncated = true;
                report.limits_hit.push(walk_limit(options.max_files));
            }
            let name = entry.file_name().to_string_lossy();
            if past_limit >= MAX_LISTED_PAST_LIMIT || !LISTED_PAST_LIMIT.contains(&name.as_ref()) {
                continue;
            }
            past_limit += 1;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push((rel, size));
    }

    // Cancelled while everything was being left out: the loop saw nothing.
    cancel.check()?;
    let (ignore_gaps, ignore_problems) = match ignores.lock() {
        Ok(mut rules) => (rules.take_gaps(), rules.take_problems()),
        Err(_) => (Vec::new(), Vec::new()),
    };
    for shown in ignore_gaps.iter().chain(&ignore_problems) {
        if report.unreadable.len() < 100 {
            report.unreadable.push(crate::redact::redact(shown));
        }
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
        ignore_gaps,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn credential_file_names_are_secret_names() {
        for name in [
            ".env",
            ".env.production",
            "server.pem",
            "tls.key",
            "credentials",
            "credentials.json",
            ".git-credentials",
            "prod.tfvars",
            "prod.auto.tfvars.json",
            "kubeconfig",
            "kubeconfig.yaml",
            "service-account.json",
            "service-account-prod.json",
            "terraform.tfstate",
            "terraform.tfstate.backup",
            ".terraform.tfstate.lock.info",
            "prod.tfplan",
            "tfplan.json",
            ".terraformrc",
            ".databrickscfg",
            ".pypirc",
            ".vault-token",
            "vault.yml",
            "secrets.yaml",
            "db-secret.yaml",
            "values-secrets.yaml",
            "prod.sops.yaml",
        ] {
            assert!(is_secret_name(name), "{name}");
        }
        for name in [
            "credentials.md",
            "README.md",
            "config.yaml",
            "keys.md",
            "env.ts",
            "main.tf",
            "values.yaml",
            "values-prod.yaml",
            "secrets.go",
            "secrets.py",
            "databricks.yml",
            "terraform.md",
        ] {
            assert!(!is_secret_name(name), "{name}");
        }
        assert!(is_secret_path(".docker/config.json"));
        assert!(is_secret_path("deploy/.docker/config.json"));
        assert!(!is_secret_path(".docker/Dockerfile"));
        assert!(!is_secret_path("x.docker/config.json"));
        assert!(!is_secret_path("config.json"));
    }

    #[test]
    fn tool_caches_and_credential_stores_are_not_listed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for path in [
            ".angular/cache/a.json",
            ".databricks/bundle/dev/terraform/terraform.tfstate",
            "live/.terragrunt-cache/x/main.tf",
            ".aws/config",
            ".kube/config",
            ".docker/config.json",
            "infra/terraform.tfstate",
            ".docker/Dockerfile",
            "infra/main.tf",
        ] {
            let at = root.join(path);
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            fs::write(at, "x").unwrap();
        }
        let result = walk(root, &WalkOptions::default(), &CancelToken::new()).unwrap();
        let names: Vec<&str> = result.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, vec![".docker/Dockerfile", "infra/main.tf"]);
    }

    #[test]
    fn a_bare_root_keeps_build_and_vendor_and_a_built_root_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for path in ["build/Dockerfile", "vendor/x.sh", "dist/app.js"] {
            let at = root.join(path);
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            fs::write(at, "x").unwrap();
        }
        let listed = || -> Vec<String> {
            walk(root, &WalkOptions::default(), &CancelToken::new())
                .unwrap()
                .files
                .into_iter()
                .map(|(p, _)| p)
                .collect()
        };
        assert_eq!(listed(), vec!["build/Dockerfile", "vendor/x.sh"]);
        fs::write(root.join("go.mod"), "module x\n").unwrap();
        assert_eq!(listed(), vec!["go.mod"]);
    }

    #[test]
    fn past_the_file_limit_what_says_what_the_project_is_stays_listed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Whatever order the walk takes, the data takes up the limit.
        for name in ["a-data", "z-data"] {
            fs::create_dir_all(root.join(name)).unwrap();
            for i in 0..20 {
                fs::write(root.join(name).join(format!("{i}.csv")), "1").unwrap();
            }
        }
        let api = root.join("m/api");
        fs::create_dir_all(&api).unwrap();
        fs::write(api.join("pom.xml"), "<project/>").unwrap();
        fs::write(api.join("App.java"), "").unwrap();
        let opts = WalkOptions {
            max_files: 10,
            ..Default::default()
        };
        let result = walk(root, &opts, &CancelToken::new()).unwrap();
        assert!(result.report.truncated);
        assert_eq!(result.report.limits_hit.len(), 1);
        assert!(result.files.iter().any(|(p, _)| p == "m/api/pom.xml"));
        assert!(result.files.len() <= 11, "{:?}", result.files);
    }

    #[test]
    fn the_walk_gives_up_on_a_tree_far_past_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..100 {
            fs::write(dir.path().join(format!("{i}.csv")), "1").unwrap();
        }
        let opts = WalkOptions {
            max_files: 2,
            ..Default::default()
        };
        let result = walk(dir.path(), &opts, &CancelToken::new()).unwrap();
        assert!(result.report.truncated);
        assert_eq!(result.files.len(), 2);
    }

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

    /// What the `ignore` crate lists when it reads the ignore files itself.
    fn listed_by_the_crate(root: &Path) -> Vec<String> {
        let mut out: Vec<String> = ignore::WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(false)
            .ignore(true)
            .parents(false)
            .require_git(false)
            .follow_links(false)
            .add_custom_ignore_filename(".habiignore")
            .filter_entry(|e| e.file_name() != ".git")
            .build()
            .flatten()
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .map(|e| {
                e.path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn nested_ignore_files_decide_what_the_crate_would_have() {
        const PATTERNS: &[&str] = &[
            "*.log",
            "!keep.log",
            "x.txt",
            "!x.txt",
            "/y.log",
            "c/",
            "!c/",
            "d/*",
            "!d/keep.log",
            "**/z.md",
            "!z.md",
            "c/*.txt",
            "/a/c/*.md",
            "e",
            "# a comment",
            "\\!odd",
        ];
        const DIRS: &[&str] = &[".", "a", "b", "a/c", "a/c/d", "b/e"];
        const FILES: &[&str] = &["x.txt", "y.log", "z.md", "keep.log"];
        let mut seed = 0x2545_f491_u64;
        let mut next = move |n: usize| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n
        };
        for _ in 0..60 {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            fs::create_dir_all(root.join(".git/info")).unwrap();
            for d in DIRS {
                fs::create_dir_all(root.join(d)).unwrap();
                for f in FILES {
                    fs::write(root.join(d).join(f), "").unwrap();
                }
                // Every kind of ignore file, in a few places each.
                for name in [".gitignore", ".ignore", ".habiignore"] {
                    if next(3) == 0 {
                        let lines: Vec<&str> = (0..1 + next(4))
                            .map(|_| *PATTERNS.get(next(PATTERNS.len())).unwrap())
                            .collect();
                        fs::write(root.join(d).join(name), lines.join("\n")).unwrap();
                    }
                }
            }
            let lines: Vec<&str> = (0..next(3))
                .map(|_| *PATTERNS.get(next(PATTERNS.len())).unwrap())
                .collect();
            fs::write(root.join(".git/info/exclude"), lines.join("\n")).unwrap();

            let walked = walk(root, &WalkOptions::default(), &CancelToken::new()).unwrap();
            let names: Vec<String> = walked.files.into_iter().map(|(p, _)| p).collect();
            assert_eq!(names, listed_by_the_crate(root));
            assert!(walked.ignore_gaps.is_empty(), "{:?}", walked.ignore_gaps);
        }
    }

    #[test]
    fn ignore_files_above_the_repository_have_no_say() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path();
        fs::write(outer.join(".gitignore"), "*\n").unwrap();
        fs::write(outer.join(".ignore"), "*\n").unwrap();
        fs::write(outer.join(".habiignore"), "*\n").unwrap();
        let repo = outer.join("repo");
        fs::create_dir_all(repo.join(".git/info")).unwrap();
        fs::write(repo.join("app.txt"), "").unwrap();
        fs::write(repo.join("noisy.log"), "").unwrap();
        fs::write(repo.join(".gitignore"), "*.log\n").unwrap();
        fs::write(repo.join(".git/info/exclude"), "*.tmp\n").unwrap();

        // Opened at its root: the `*` above it is someone's home folder.
        let listed = |folder: &Path| -> Vec<String> {
            walk(folder, &WalkOptions::default(), &CancelToken::new())
                .unwrap()
                .files
                .into_iter()
                .map(|(p, _)| p)
                .collect()
        };
        assert_eq!(listed(&repo), vec![".gitignore", "app.txt"]);

        // Opened below its root: the repository's rules hold, the outer ones still do not.
        let api = repo.join("svc/api");
        fs::create_dir_all(&api).unwrap();
        fs::write(repo.join("svc/.ignore"), "*.bak\n").unwrap();
        for f in ["a.log", "b.bak", "c.tmp", "d.txt"] {
            fs::write(api.join(f), "").unwrap();
        }
        assert_eq!(listed(&api), vec!["d.txt"]);
        // The nearer `!` wins, as it would one level further down.
        fs::write(api.join(".gitignore"), "!a.log\n").unwrap();
        assert_eq!(listed(&api), vec![".gitignore", "a.log", "d.txt"]);

        // No repository at all: nothing above the folder counts.
        let plain = outer.join("plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("kept.txt"), "").unwrap();
        // A temp dir could be inside a repo on some machines; only assert when not.
        if crate::inspect::repo::enclosing_root(&plain).is_none() {
            assert_eq!(listed(&plain), vec!["kept.txt"]);
        }
    }

    #[test]
    fn an_oversized_ignore_file_is_reported_and_not_applied() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/noise.log"), "").unwrap();
        let mut rules = "*.log\n".to_string();
        rules.push_str(&"# padding\n".repeat(120_000));
        fs::write(root.join("sub/.gitignore"), rules).unwrap();
        let result = walk(root, &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert!(result.files.iter().any(|(p, _)| p == "sub/noise.log"));
        assert_eq!(result.ignore_gaps.len(), 1, "{:?}", result.ignore_gaps);
        assert!(result.ignore_gaps[0].contains("sub/.gitignore"));
        assert!(result.ignore_gaps[0].contains("limit"));
    }

    #[test]
    fn a_bad_pattern_costs_only_itself() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "a{b\n*.log\n").unwrap();
        fs::write(dir.path().join("x.log"), "").unwrap();
        fs::write(dir.path().join("y.txt"), "").unwrap();
        let result = walk(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        let names: Vec<&str> = result.files.iter().map(|(p, _)| p.as_str()).collect();
        // `a{b` is an error to the glob parser. The next line still counts.
        assert_eq!(names, vec![".gitignore", "y.txt"]);
        assert!(result.ignore_gaps.is_empty());
        assert!(!result.report.unreadable.is_empty());
    }

    #[test]
    fn a_folder_named_like_an_ignore_file_is_not_one() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".ignore")).unwrap();
        fs::write(dir.path().join(".ignore/notes.txt"), "").unwrap();
        let result = walk(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert_eq!(result.files.len(), 1);
        assert!(result.ignore_gaps.is_empty());
    }

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

    #[cfg(unix)]
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
