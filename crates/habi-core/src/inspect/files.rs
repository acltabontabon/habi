//! Recognition of files with a meaningful role: API specifications, database
//! changelogs, agent instructions, CI and test configuration.
//!
//! Recognition looks at file names first and, where names are ambiguous,
//! at the first few kilobytes of content. A README that mentions a technology
//! is never evidence for it.

use super::Collector;
use super::model::Evidence;
use crate::fsutil::read_prefix;
use globset::{GlobSet, GlobSetBuilder};
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

const DETECTOR: &str = "files";
const PREFIX_BYTES: usize = 4096;
/// Enough to tell a Databricks notebook by its first line, and no more of a source file.
const NOTEBOOK_PREFIX_BYTES: usize = 64;
pub(crate) const MAX_CONTENT_CHECKS: usize = 5_000;

/// Roles recognized purely from the path.
const NAME_ROLES: &[(&str, &str)] = &[
    ("**/AGENTS.md", "agent-instructions:agents-md"),
    ("AGENTS.md", "agent-instructions:agents-md"),
    ("**/AGENTS.override.md", "agent-instructions:agents-md"),
    ("CLAUDE.md", "agent-instructions:claude-md"),
    ("**/CLAUDE.md", "agent-instructions:claude-md"),
    ("CLAUDE.local.md", "agent-instructions:claude-md"),
    (".claude/rules/**/*.md", "agent-instructions:claude-rules"),
    (".cursor/rules/**/*.mdc", "agent-instructions:cursor-rules"),
    (".cursorrules", "agent-instructions:cursor-rules"),
    (
        ".github/copilot-instructions.md",
        "agent-instructions:copilot",
    ),
    (".claude/skills/*/SKILL.md", "agent-skill:claude-code"),
    (".agents/skills/*/SKILL.md", "agent-skill:agents"),
    (".cursor/skills/*/SKILL.md", "agent-skill:cursor"),
    (".gemini/skills/*/SKILL.md", "agent-skill:gemini-cli"),
    (".github/skills/*/SKILL.md", "agent-skill:copilot"),
    (".opencode/skills/*/SKILL.md", "agent-skill:opencode"),
    (".junie/skills/*/SKILL.md", "agent-skill:junie"),
    ("GEMINI.md", "agent-instructions:gemini-md"),
    (".mcp.json", "mcp-config:claude-code"),
    (".cursor/mcp.json", "mcp-config:cursor"),
    (".codex/config.toml", "mcp-config:codex"),
    (".gemini/settings.json", "mcp-config:gemini-cli"),
    ("opencode.json", "mcp-config:opencode"),
    (".junie/mcp/mcp.json", "mcp-config:junie"),
    ("**/tsconfig.json", "typescript-config"),
    ("tsconfig.json", "typescript-config"),
    ("**/jest.config.*", "test-config:jest"),
    ("jest.config.*", "test-config:jest"),
    ("**/vitest.config.*", "test-config:vitest"),
    ("vitest.config.*", "test-config:vitest"),
    ("**/playwright.config.*", "test-config:playwright"),
    ("playwright.config.*", "test-config:playwright"),
    ("**/cypress.config.*", "test-config:cypress"),
    ("cypress.config.*", "test-config:cypress"),
    (".github/workflows/*.yml", "ci:github-actions"),
    (".github/workflows/*.yaml", "ci:github-actions"),
    (".gitlab-ci.yml", "ci:gitlab"),
    ("dbt_project.yml", "data:dbt-project"),
    ("**/dbt_project.yml", "data:dbt-project"),
    ("**/Dockerfile", "container:dockerfile"),
    ("Dockerfile", "container:dockerfile"),
    ("**/mvnw", "build-wrapper:maven"),
    ("mvnw", "build-wrapper:maven"),
    ("**/gradlew", "build-wrapper:gradle"),
    ("gradlew", "build-wrapper:gradle"),
    ("**/db/migration/V*__*.sql", "flyway-migration"),
    ("**/*.tf", "infra:terraform-config"),
    ("**/.terraform.lock.hcl", "infra:terraform-config"),
    ("**/terragrunt.hcl", "infra:terragrunt-config"),
    ("**/Chart.yaml", "infra:helm-chart"),
    ("**/helmfile.yaml", "infra:helm-chart"),
    ("**/helmfile.yaml.gotmpl", "infra:helm-chart"),
    ("**/kustomization.yaml", "infra:kustomization"),
    ("**/kustomization.yml", "infra:kustomization"),
    ("**/ansible.cfg", "infra:ansible-config"),
    ("**/playbook.yml", "infra:ansible-config"),
    ("**/playbook.yaml", "infra:ansible-config"),
    ("**/Pulumi.yaml", "infra:pulumi-project"),
    ("**/Pulumi.yml", "infra:pulumi-project"),
    ("**/databricks.yml", "data:databricks-bundle"),
    ("**/databricks.yaml", "data:databricks-bundle"),
    ("**/*.ipynb", "data:notebook"),
    ("**/*.bats", "test-config:bats"),
    ("**/*.cpt", "test-config:gauge"),
    ("**/*.robot", "test-config:robot"),
    ("**/*.feature", "test-config:gherkin"),
    ("**/testng.xml", "test-config:testng"),
    ("**/*.jmx", "test-config:jmeter"),
    ("**/karma.conf.*", "test-config:karma"),
    ("**/*.postman_collection.json", "test-config:postman"),
];

/// Roles told by where a file sits. Plain comparisons: a pattern with a folder in
/// its middle turns every path of the project into a regular expression match.
fn role_by_place(path: &str) -> Option<&'static str> {
    let (dirs, name) = path.rsplit_once('/')?;
    let dirs_end = |folder: &str| {
        dirs == folder
            || dirs
                .strip_suffix(folder)
                .is_some_and(|above| above.ends_with('/'))
    };
    let yaml = name.ends_with(".yml") || name.ends_with(".yaml");
    if yaml && dirs_end("playbooks") {
        return Some("infra:ansible-config");
    }
    if (name == "main.yml" || name == "main.yaml")
        && let Some(above) = dirs.strip_suffix("/tasks")
        && above
            .rsplit('/')
            .nth(1)
            .is_some_and(|parent| parent == "roles")
    {
        return Some("infra:ansible-config");
    }
    // `.spec` alone is also an RPM recipe; Gauge keeps its own in `specs/`.
    if name.ends_with(".spec") && dirs.split('/').any(|d| d == "specs") {
        return Some("test-config:gauge");
    }
    if dirs.contains("META-INF/native-image") {
        return Some("graalvm-config");
    }
    None
}

/// Roles a project can hold thousands of files in, and that one file establishes:
/// the first in each module stands for the rest.
const ONE_PER_MODULE: &[&str] = &[
    "infra:terraform-config",
    "infra:terragrunt-config",
    "infra:helm-chart",
    "infra:kustomization",
    "infra:ansible-config",
    "data:notebook",
    "data:databricks-notebook",
    "test-config:bats",
    "test-config:gauge",
    "test-config:robot",
    "test-config:gherkin",
    "test-config:jmeter",
    "test-config:postman",
    "graalvm-config",
    "kubernetes-manifest",
];

static NAME_SET: LazyLock<(GlobSet, Vec<&'static str>)> = LazyLock::new(|| {
    let mut b = GlobSetBuilder::new();
    let mut roles = Vec::new();
    for (pattern, role) in NAME_ROLES {
        b.add(
            globset::GlobBuilder::new(pattern)
                .literal_separator(true)
                .build()
                .expect("built-in pattern"),
        );
        roles.push(*role);
    }
    (b.build().expect("built-in patterns"), roles)
});

static OPENAPI_YAML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^(openapi:\s*['"]?3\.|swagger:\s*['"]?2\.0)"#).unwrap());
static OPENAPI_JSON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""(openapi"\s*:\s*"3\.|swagger"\s*:\s*"2\.0)"#).unwrap());
static LIQUIBASE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(<databaseChangeLog|(?m)^databaseChangeLog:|"databaseChangeLog"\s*:|(?mi)^--\s*liquibase formatted sql)"#)
        .unwrap()
});

/// A Kubernetes resource names its API and its kind at the top level.
static KUBERNETES_API: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^apiVersion:\s*\S+\s*$").unwrap());
static KUBERNETES_KIND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^kind:\s*[A-Z][A-Za-z0-9]+\s*$").unwrap());
static DATABRICKS_NOTEBOOK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#|//|--)\s*Databricks notebook source").unwrap());

fn extension(path: &str) -> &str {
    path.rsplit_once('.').map(|(_, e)| e).unwrap_or("")
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Well-known files that are never an OpenAPI document or a Liquibase
/// changelog: build manifests, lockfiles, tool and logging configuration.
/// They are not content-probed, so they cannot use up the probe limit.
const NOT_SPEC_NAMES: &[&str] = &[
    "pom.xml",
    "settings.xml",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "composer.json",
    "composer.lock",
    "tsconfig.json",
    "jsconfig.json",
    "renovate.json",
    ".eslintrc.json",
    ".prettierrc.json",
    ".babelrc.json",
    "biome.json",
    "deno.json",
    "angular.json",
    "project.json",
    "nx.json",
    "lerna.json",
    "turbo.json",
    "vercel.json",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    ".gitlab-ci.yml",
    ".pre-commit-config.yaml",
    "mkdocs.yml",
    "logback.xml",
    "logback-spring.xml",
    "logback-test.xml",
    "log4j2.xml",
    "log4j2-test.xml",
    "checkstyle.xml",
    "spotbugs-exclude.xml",
    "AndroidManifest.xml",
    "Chart.yaml",
    "helmfile.yaml",
    "kustomization.yaml",
    "kustomization.yml",
    "databricks.yml",
    "databricks.yaml",
    "dbt_project.yml",
];

/// Whether a file is a test's input: a sample project inside a project. A
/// `pom.xml` in `src/test/resources` is what a test reads, and says nothing about
/// what the project is built on.
pub(crate) fn in_fixture(path: &str) -> bool {
    const FIXTURE_DIRS: &[&str] = &[
        "fixtures",
        "__fixtures__",
        "test-fixtures",
        "testdata",
        "archetype-resources",
    ];
    let Some((dirs, _)) = path.rsplit_once('/') else {
        return false;
    };
    let mut parts = dirs.split('/').peekable();
    while let Some(part) = parts.next() {
        if FIXTURE_DIRS.contains(&part) {
            return true;
        }
        if part == "src" && matches!(parts.peek(), Some(&"it")) {
            return true;
        }
    }
    dirs.contains("src/test/resources")
}

/// A Python, Scala or R file that may be an exported notebook. Only these source
/// files are opened, and only for their first line.
fn notebook_source(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    matches!(extension(path), "py" | "scala" | "r")
        && (lower.contains("notebook") || lower.contains("databricks"))
}

/// Helm templates and values are never specifications: a chart repository can
/// hold thousands, and the chart itself says what they are.
fn chart_material(path: &str) -> bool {
    let name = file_name(path);
    path.starts_with("templates/")
        || path.contains("/templates/")
        || path.contains("META-INF/native-image/")
        || ((name.starts_with("values-") || name.starts_with("values."))
            && matches!(extension(path), "yaml" | "yml"))
        || name == "values.yaml"
}

fn content_candidate(path: &str) -> bool {
    let ext = extension(path);
    let name = file_name(path);
    if NOT_SPEC_NAMES.contains(&name)
        || (name.starts_with("tsconfig.") && ext == "json")
        || path.starts_with(".github/")
        || path.starts_with(".vscode/")
        || path.contains("/.vscode/")
        || chart_material(path)
        || in_fixture(path)
    {
        return false;
    }
    matches!(ext, "yaml" | "yml" | "json" | "xml" | "sql") || notebook_source(path)
}

/// File roles that can only be recognized by reading content. Tags built on
/// them depend on the `content` coverage area as well as `files`.
pub const CONTENT_ROLES: &[&str] = &[
    "openapi",
    "liquibase-changelog",
    "kubernetes-manifest",
    "data:databricks-notebook",
];

/// Higher score = checked first, so specs and changelogs in conventional
/// places are found even in large repositories.
fn candidate_score(path: &str) -> u8 {
    let lower = path.to_ascii_lowercase();
    if lower.contains("openapi") || lower.contains("swagger") || lower.contains("changelog") {
        3
    } else if lower.contains("api")
        || lower.contains("spec")
        || lower.contains("/db/")
        || lower.contains("contract")
        || lower.contains("k8s")
        || lower.contains("kube")
        || lower.contains("manifest")
        || lower.contains("deploy")
        || lower.contains("notebook")
    {
        2
    } else if extension(path) == "sql" || extension(path) == "xml" {
        0
    } else {
        1
    }
}

/// Whether a file is part of a skill package in an agent's skill folder
/// (`.claude/skills/review/scripts/check.py`), other than its `SKILL.md`.
/// A skill's own scripts, instructions and manifests are its material, not
/// the project's: they say nothing about what the project is written in or
/// how it is instructed.
pub fn inside_skill_package(path: &str) -> bool {
    crate::clients::layout::PROJECT_SKILL_DIRS
        .iter()
        .any(|base| {
            path.strip_prefix(base)
                .and_then(|rest| rest.strip_prefix('/'))
                .and_then(|rest| rest.split_once('/'))
                .is_some_and(|(_, inside)| inside != "SKILL.md")
        })
}

pub fn collect(
    root: &Path,
    files: &[(String, u64)],
    out: &mut Collector,
    module_of: &dyn Fn(&str) -> String,
) {
    let (set, roles) = &*NAME_SET;
    let mut matched = Vec::new();
    for (path, _) in files
        .iter()
        .filter(|(p, _)| !inside_skill_package(p) && !in_fixture(p))
    {
        for idx in set.matches(path) {
            matched.extend(roles.get(idx).map(|role| (path.clone(), *role)));
        }
        matched.extend(role_by_place(path).map(|role| (path.clone(), role)));
    }
    matched.sort();
    matched.dedup();
    let mut stands_for: HashSet<(String, &str)> = HashSet::new();
    let mut record = |out: &mut Collector, module: String, path: &str, role: &'static str, line| {
        if !ONE_PER_MODULE.contains(&role) || stands_for.insert((module.clone(), role)) {
            out.file(&module, path, role, DETECTOR, line);
        }
    };
    for (path, role) in matched {
        record(out, module_of(&path), &path, role, None);
    }

    // Content checks for OpenAPI documents and Liquibase changelogs.
    let mut candidates: Vec<&(String, u64)> = files
        .iter()
        .filter(|(p, _)| content_candidate(p) && !inside_skill_package(p))
        .collect();
    candidates.sort_by(|a, b| {
        candidate_score(&b.0)
            .cmp(&candidate_score(&a.0))
            .then(a.0.cmp(&b.0))
    });
    // Candidates beyond the limit are attributed to their modules: only those
    // modules' content-based conditions become unknown.
    for (path, _) in candidates.iter().skip(MAX_CONTENT_CHECKS) {
        *out.content_skipped.entry(module_of(path)).or_insert(0) += 1;
    }
    for (path, _) in candidates.into_iter().take(MAX_CONTENT_CHECKS) {
        let full = root.join(path);
        // The walk refused symlinks; re-check in case the tree changed since.
        match std::fs::symlink_metadata(&full) {
            Ok(m) if m.is_file() => {}
            _ => continue,
        }
        let source = notebook_source(path);
        let limit = if source {
            NOTEBOOK_PREFIX_BYTES
        } else {
            PREFIX_BYTES
        };
        let Ok(prefix) = read_prefix(&full, limit) else {
            *out.content_skipped.entry(module_of(path)).or_insert(0) += 1;
            continue;
        };
        let text = String::from_utf8_lossy(&prefix);
        // Some editors start a file with a byte order mark.
        let text = text.trim_start_matches('\u{feff}');
        let ext = extension(path);
        if (source || ext == "sql") && DATABRICKS_NOTEBOOK.is_match(text) {
            record(
                out,
                module_of(path),
                path,
                "data:databricks-notebook",
                Some(1),
            );
        }
        if source {
            continue;
        }
        if matches!(ext, "yaml" | "yml")
            && KUBERNETES_API.is_match(text)
            && KUBERNETES_KIND.is_match(text)
        {
            record(out, module_of(path), path, "kubernetes-manifest", None);
        }
        let is_openapi = match ext {
            "yaml" | "yml" => OPENAPI_YAML.is_match(text),
            "json" => OPENAPI_JSON.is_match(text),
            _ => false,
        };
        if is_openapi {
            let first = text
                .lines()
                .position(|l| OPENAPI_YAML.is_match(l) || OPENAPI_JSON.is_match(l));
            out.file(
                &module_of(path),
                path,
                "openapi",
                DETECTOR,
                first.map(|l| l as u32 + 1),
            );
        }
        if matches!(ext, "xml" | "yaml" | "yml" | "json" | "sql") && LIQUIBASE.is_match(text) {
            out.file(
                &module_of(path),
                path,
                "liquibase-changelog",
                DETECTOR,
                None,
            );
        }
    }
}

/// Coverage note for a module whose content probes were cut by the limit.
pub fn content_note(skipped: u32) -> String {
    format!(
        "{skipped} YAML/JSON/XML/SQL file{} in this module {} not checked for OpenAPI, Liquibase, Kubernetes or Databricks content (Habi reads at most {MAX_CONTENT_CHECKS} per project, and skips files it cannot read).",
        if skipped == 1 { "" } else { "s" },
        if skipped == 1 { "was" } else { "were" },
    )
}

/// Evidence helper used by tag derivation for language detection.
pub fn language_of(path: &str) -> Option<&'static str> {
    match extension(path) {
        "java" => Some("lang:java"),
        "kt" | "kts" if !path.ends_with(".gradle.kts") => Some("lang:kotlin"),
        "ts" | "tsx" | "mts" | "cts" if !path.ends_with(".d.ts") => Some("lang:typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("lang:javascript"),
        "py" => Some("lang:python"),
        "go" => Some("lang:go"),
        "rs" => Some("lang:rust"),
        "cs" => Some("lang:csharp"),
        "php" => Some("lang:php"),
        "scala" => Some("lang:scala"),
        "sh" | "bash" | "zsh" | "ksh" | "bats" => Some("lang:shell"),
        "tf" | "hcl" => Some("lang:hcl"),
        _ => None,
    }
}

pub fn evidence(path: &str, line: Option<u32>) -> Evidence {
    Evidence {
        file: path.to_string(),
        line,
        excerpt: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skill_packages_own_files_are_its_material_not_the_projects() {
        for p in [
            ".claude/skills/review/scripts/check.py",
            ".claude/skills/review/AGENTS.md",
            ".agents/skills/plan/package.json",
            ".github/skills/x/references/openapi.yaml",
        ] {
            assert!(inside_skill_package(p), "{p}");
        }
        for p in [
            ".claude/skills/review/SKILL.md",
            ".claude/settings.json",
            ".github/workflows/ci.yml",
            "skills/review/scripts/check.py",
            "AGENTS.md",
        ] {
            assert!(!inside_skill_package(p), "{p}");
        }
    }

    #[test]
    fn openapi_detection_reads_content_not_names() {
        assert!(OPENAPI_YAML.is_match("openapi: 3.0.3\ninfo:\n"));
        assert!(OPENAPI_YAML.is_match("# comment\nopenapi: \"3.1.0\"\n"));
        assert!(!OPENAPI_YAML.is_match("description: we use openapi: 3 here"));
        assert!(OPENAPI_JSON.is_match(r#"{ "openapi": "3.1.0", "info": {} }"#));
    }

    #[test]
    fn manifests_and_tool_configs_are_not_content_probed() {
        for p in [
            "pom.xml",
            "api/pom.xml",
            "web/tsconfig.app.json",
            "src/main/resources/logback-spring.xml",
            ".vscode/settings.json",
            "web/package.json",
        ] {
            assert!(!content_candidate(p), "{p}");
        }
        for p in [
            "api/openapi.yaml",
            "src/main/resources/db/changelog/db.changelog-master.xml",
            "db/V1__init.sql",
        ] {
            assert!(content_candidate(p), "{p}");
        }
    }

    #[test]
    fn probe_limit_is_attributed_to_modules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("data")).unwrap();
        for i in 0..(MAX_CONTENT_CHECKS + 5) {
            std::fs::write(root.join(format!("data/f{i:04}.json")), "{}").unwrap();
        }
        let files: Vec<(String, u64)> = (0..(MAX_CONTENT_CHECKS + 5))
            .map(|i| (format!("data/f{i:04}.json"), 2))
            .chain([("api/pom.xml".to_string(), 10)])
            .collect();
        let mut out = Collector::default();
        let module_of = |p: &str| {
            if p.starts_with("api/") {
                "api".to_string()
            } else {
                ".".to_string()
            }
        };
        collect(root, &files, &mut out, &module_of);
        assert_eq!(out.content_skipped.get("."), Some(&5));
        assert_eq!(out.content_skipped.get("api"), None);
    }

    #[test]
    fn kubernetes_detection_needs_a_kind_and_an_api() {
        let both = |t| KUBERNETES_API.is_match(t) && KUBERNETES_KIND.is_match(t);
        assert!(both("apiVersion: apps/v1\nkind: Deployment\n"));
        assert!(both("# c\nkind: ConfigMap\napiVersion: v1\nmetadata: {}\n"));
        assert!(!both("apiVersion: v2\nname: chart\n"));
        assert!(!both("kind: string\nversion: 1\n"));
        assert!(!both("docs: |\n  apiVersion: v1\n  kind: Pod\n"));
    }

    #[test]
    fn roles_by_place() {
        for p in [
            "playbooks/site.yml",
            "ansible/playbooks/site.yaml",
            "ansible/roles/web/tasks/main.yml",
            "roles/web/tasks/main.yaml",
        ] {
            assert_eq!(role_by_place(p), Some("infra:ansible-config"), "{p}");
        }
        assert_eq!(
            role_by_place("src/main/resources/META-INF/native-image/a/b/reflect-config.json"),
            Some("graalvm-config")
        );
        for p in [
            "site.yml",
            "myplaybooks/site.yml",
            "playbooks/notes.md",
            "tasks/main.yml",
            "src/roles/x.yml",
            "packaging/app.spec",
        ] {
            assert_eq!(role_by_place(p), None, "{p}");
        }
        assert_eq!(
            role_by_place("e2e/specs/login.spec"),
            Some("test-config:gauge")
        );
    }

    #[test]
    fn test_inputs_are_told_from_the_project() {
        for p in [
            "src/test/resources/projects/a/pom.xml",
            "api/src/test/resources/pom.xml",
            "src/it/simple/pom.xml",
            "testdata/chart/Chart.yaml",
            "pkg/testdata/main.tf",
            "fixtures/repos/x/package.json",
            "src/main/resources/archetype-resources/pom.xml",
        ] {
            assert!(in_fixture(p), "{p}");
        }
        for p in [
            "pom.xml",
            "services/fixtures.py",
            "src/main/resources/application.yml",
            "src/test/java/ATest.java",
            "src/iterate/pom.xml",
        ] {
            assert!(!in_fixture(p), "{p}");
        }
    }

    #[test]
    fn only_notebook_folders_open_source_files() {
        assert!(content_candidate("notebooks/ingest.py"));
        assert!(content_candidate("src/databricks/job.scala"));
        assert!(!content_candidate("src/app.py"));
        assert!(!content_candidate("charts/a/templates/deploy.yaml"));
        assert!(!content_candidate("charts/a/values-prod.yaml"));
        assert!(content_candidate("k8s/deployment.yaml"));
        assert!(DATABRICKS_NOTEBOOK.is_match("# Databricks notebook source\nx = 1"));
        assert!(!DATABRICKS_NOTEBOOK.is_match("x = 1  # Databricks notebook source"));
    }

    #[test]
    fn liquibase_detection() {
        assert!(LIQUIBASE.is_match("<?xml?>\n<databaseChangeLog xmlns=\"x\">"));
        assert!(LIQUIBASE.is_match("databaseChangeLog:\n  - changeSet:"));
        assert!(LIQUIBASE.is_match("--liquibase formatted sql\n"));
        assert!(!LIQUIBASE.is_match("# We should adopt Liquibase databaseChangeLog someday"));
    }
}
