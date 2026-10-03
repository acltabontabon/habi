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
use std::path::Path;
use std::sync::LazyLock;

const DETECTOR: &str = "files";
const PREFIX_BYTES: usize = 4096;
const MAX_CONTENT_CHECKS: usize = 600;
const MAX_CANDIDATE_SIZE: u64 = 8 * 1024 * 1024;

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
];

fn content_candidate(path: &str) -> bool {
    let ext = extension(path);
    let name = file_name(path);
    if NOT_SPEC_NAMES.contains(&name)
        || (name.starts_with("tsconfig.") && ext == "json")
        || path.starts_with(".github/")
        || path.starts_with(".vscode/")
        || path.contains("/.vscode/")
    {
        return false;
    }
    matches!(ext, "yaml" | "yml" | "json" | "xml" | "sql")
}

/// File roles that can only be recognized by reading content. Tags built on
/// them depend on the `content` coverage area as well as `files`.
pub const CONTENT_ROLES: &[&str] = &["openapi", "liquibase-changelog"];

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
    {
        2
    } else if extension(path) == "sql" || extension(path) == "xml" {
        0
    } else {
        1
    }
}

pub fn collect(
    root: &Path,
    files: &[(String, u64)],
    out: &mut Collector,
    module_of: &dyn Fn(&str) -> String,
) {
    let (set, roles) = &*NAME_SET;
    let mut matched = Vec::new();
    for (path, _) in files {
        for idx in set.matches(path) {
            matched.extend(roles.get(idx).map(|role| (path.clone(), *role)));
        }
    }
    matched.sort();
    matched.dedup();
    for (path, role) in matched {
        out.file(&module_of(&path), &path, role, DETECTOR, None);
    }

    // Content checks for OpenAPI documents and Liquibase changelogs.
    let mut candidates: Vec<&(String, u64)> = files
        .iter()
        .filter(|(p, size)| content_candidate(p) && *size <= MAX_CANDIDATE_SIZE)
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
        let Ok(prefix) = read_prefix(&full, PREFIX_BYTES) else {
            *out.content_skipped.entry(module_of(path)).or_insert(0) += 1;
            continue;
        };
        let text = String::from_utf8_lossy(&prefix);
        let ext = extension(path);
        let is_openapi = match ext {
            "yaml" | "yml" => OPENAPI_YAML.is_match(&text),
            "json" => OPENAPI_JSON.is_match(&text),
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
        if matches!(ext, "xml" | "yaml" | "yml" | "json" | "sql") && LIQUIBASE.is_match(&text) {
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
        "{skipped} YAML/JSON/XML/SQL file{} in this module {} not checked for OpenAPI or Liquibase content (Habi reads at most {MAX_CONTENT_CHECKS} per project, and skips files it cannot read).",
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
    fn liquibase_detection() {
        assert!(LIQUIBASE.is_match("<?xml?>\n<databaseChangeLog xmlns=\"x\">"));
        assert!(LIQUIBASE.is_match("databaseChangeLog:\n  - changeSet:"));
        assert!(LIQUIBASE.is_match("--liquibase formatted sql\n"));
        assert!(!LIQUIBASE.is_match("# We should adopt Liquibase databaseChangeLog someday"));
    }
}
