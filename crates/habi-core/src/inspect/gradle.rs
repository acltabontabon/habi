//! Static reading of Gradle build scripts (Groovy and Kotlin DSL).
//!
//! Gradle builds are programs, so a static reader can only see the plain
//! declarations. Habi recognizes the common declaration forms, resolves
//! version-catalog aliases, and marks a module's coverage as partial whenever
//! it sees something it cannot evaluate: script plugins, convention plugins
//! from `buildSrc` or included builds, conditional logic in `dependencies`,
//! interpolated coordinates, or unrecognized declaration forms.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const DETECTOR: &str = "gradle";

#[derive(Debug, Clone)]
pub struct GradleDep {
    pub configuration: String,
    pub name: String,
    pub version: Option<String>,
    pub line: u32,
    /// Declared in a `subprojects {}` / `allprojects {}` block of this script.
    pub shared: Option<SharedScope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SharedScope {
    Subprojects,
    AllProjects,
}

#[derive(Debug, Clone)]
pub struct GradlePlugin {
    pub id: String,
    pub version: Option<String>,
    pub line: u32,
    /// Applied in a `subprojects {}` / `allprojects {}` block of this script.
    pub shared: Option<SharedScope>,
}

#[derive(Debug, Clone, Default)]
pub struct GradleBuild {
    pub path: String,
    pub module: String,
    pub plugins: Vec<GradlePlugin>,
    pub dependencies: Vec<GradleDep>,
    pub partial: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub path: String,
    /// accessor (dot-separated, lowercase) -> (group:name, version)
    pub libraries: HashMap<String, (String, Option<String>)>,
    pub bundles: HashMap<String, Vec<String>>,
    pub plugins: HashMap<String, (String, Option<String>)>,
}

#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub path: String,
    pub includes: Vec<String>,
    pub notes: Vec<String>,
}

/// Removes `//` and `/* */` comments, leaving string literals intact and
/// preserving line breaks so line numbers stay correct.
pub fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(n) = next {
                    out.push(n);
                    i += 2;
                    continue;
                }
            } else if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match (c, next) {
            ('"', _) | ('\'', _) => {
                quote = Some(c);
                out.push(c);
                i += 1;
            }
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                i += 2;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn normalize_alias(alias: &str) -> String {
    alias
        .chars()
        .map(|c| {
            if c == '-' || c == '_' {
                '.'
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect()
}

static STRING_DEP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*([A-Za-z][A-Za-z0-9]*)\s*\(?\s*(?:(?:enforced)?[Pp]latform\s*\(\s*)?["']([^"']+)["']"#)
        .unwrap()
});
static MAP_DEP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*([A-Za-z][A-Za-z0-9]*)\s*\(?\s*group\s*[:=]\s*["']([^"']+)["']\s*,\s*name\s*[:=]\s*["']([^"']+)["'](?:\s*,\s*version\s*[:=]\s*["']([^"']+)["'])?"#)
        .unwrap()
});
static CATALOG_DEP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*([A-Za-z][A-Za-z0-9]*)\s*\(?\s*(?:(?:enforced)?[Pp]latform\s*\(\s*)?libs\.([A-Za-z0-9_.\-]+)"#)
        .unwrap()
});
static PROJECT_DEP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*[A-Za-z][A-Za-z0-9]*\s*\(?\s*(project\s*\(|files\s*\(|fileTree\s*\(|gradleApi|localGroovy|testFixtures\s*\(\s*project)"#).unwrap()
});
static PLUGIN_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*id\s*\(?\s*["']([^"']+)["']\s*\)?(?:\s*version\s*\(?\s*["']([^"']+)["'])?"#)
        .unwrap()
});
static PLUGIN_KOTLIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*kotlin\s*\(\s*["']([^"']+)["']\s*\)(?:\s*version\s*["']([^"']+)["'])?"#)
        .unwrap()
});
static PLUGIN_ALIAS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*alias\s*\(\s*libs\.plugins\.([A-Za-z0-9_.\-]+)\s*\)"#).unwrap()
});
static PLUGIN_CORE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*`?(java|java-library|application|war|groovy|java-platform|java-test-fixtures|java-gradle-plugin|kotlin-dsl|maven-publish|ivy-publish|jacoco|jacoco-report-aggregation|test-report-aggregation|jvm-test-suite|checkstyle|pmd|codenarc|idea|eclipse|base|distribution|version-catalog|signing|antlr|scala|ear|project-report|build-dashboard)`?\s*$"#).unwrap()
});
static APPLY_PLUGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"apply\s*\(?\s*plugin\s*[:=]\s*["']([^"']+)["']"#).unwrap());
static APPLY_FROM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"apply\s*\(?\s*from\s*[:=]"#).unwrap());
/// Name of the block opened by `{` at the end of a text segment:
/// `dependencies`, `subprojects`, `named` (for `tasks.named("x")`), ...
static BLOCK_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*$"#).unwrap());

/// A piece of one line of a build script, split at block braces.
#[derive(Debug, PartialEq)]
enum Piece<'a> {
    /// Text between braces. `header` is true when a `{` follows it (the text
    /// names the block being opened, e.g. `dependencies `).
    Text {
        text: &'a str,
        header: bool,
    },
    Open(String),
    Close,
}

/// Splits a line at `{` and `}` outside string literals, so declarations on
/// the same line as a block's braces (`plugins { id("x") }`) are seen in the
/// right block.
fn pieces(line: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '{' => {
                let text = &line[start..i];
                out.push(Piece::Text { text, header: true });
                let name = BLOCK_NAME
                    .captures(text)
                    .map(|c| c[1].to_string())
                    .unwrap_or_else(|| "{".to_string());
                out.push(Piece::Open(name));
                start = i + 1;
            }
            '}' => {
                out.push(Piece::Text {
                    text: &line[start..i],
                    header: false,
                });
                out.push(Piece::Close);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(Piece::Text {
        text: &line[start..],
        header: false,
    });
    out
}
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["']([^"']+)["']"#).unwrap());

/// Parses a build.gradle / build.gradle.kts file.
pub fn parse_build(path: &str, module: &str, text: &str) -> GradleBuild {
    let clean = strip_comments(text);
    let mut build = GradleBuild {
        path: path.to_string(),
        module: module.to_string(),
        ..Default::default()
    };
    // Stack of open block names.
    let mut stack: Vec<String> = Vec::new();
    let mut unrecognized = Vec::new();
    let mut unrecognized_plugins = Vec::new();
    let mut conditional = false;

    for (index, line) in clean.lines().enumerate() {
        let line_no = index as u32 + 1;
        let whole = line.trim();

        if APPLY_FROM.is_match(whole) {
            build
                .partial
                .push(format!("line {line_no}: applies a script plugin (`apply from`) whose contents are not evaluated"));
        }
        if whole.starts_with("configure(") || whole.starts_with("configure (") {
            build.partial.push(format!(
                "line {line_no}: `configure(...)` applies settings to a computed set of projects"
            ));
        }

        // Each piece is read in the block it is in, so declarations sharing a
        // line with braces are not skipped.
        for piece in pieces(line) {
            let (trimmed, header) = match piece {
                Piece::Open(name) => {
                    stack.push(name);
                    continue;
                }
                Piece::Close => {
                    stack.pop();
                    continue;
                }
                Piece::Text { text, header } => (text.trim(), header),
            };
            if trimmed.is_empty() {
                continue;
            }
            let in_block = |name: &str, stack: &[String]| stack.iter().any(|s| s == name);
            let top = stack.last().map(String::as_str);
            let shared = if in_block("subprojects", &stack) {
                Some(SharedScope::Subprojects)
            } else if in_block("allprojects", &stack) {
                Some(SharedScope::AllProjects)
            } else {
                None
            };

            if let Some(c) = APPLY_PLUGIN.captures(trimmed) {
                build.plugins.push(GradlePlugin {
                    id: c[1].to_string(),
                    version: None,
                    line: line_no,
                    shared,
                });
            }

            if top == Some("plugins") {
                if let Some(c) = PLUGIN_ID.captures(trimmed) {
                    build.plugins.push(GradlePlugin {
                        id: c[1].to_string(),
                        version: c.get(2).map(|m| m.as_str().to_string()),
                        line: line_no,
                        shared,
                    });
                } else if let Some(c) = PLUGIN_KOTLIN.captures(trimmed) {
                    build.plugins.push(GradlePlugin {
                        id: format!("org.jetbrains.kotlin.{}", &c[1]),
                        version: c.get(2).map(|m| m.as_str().to_string()),
                        line: line_no,
                        shared,
                    });
                } else if let Some(c) = PLUGIN_ALIAS.captures(trimmed) {
                    build.plugins.push(GradlePlugin {
                        id: format!("libs.plugins.{}", normalize_alias(&c[1])),
                        version: None,
                        line: line_no,
                        shared,
                    });
                } else if let Some(c) = PLUGIN_CORE.captures(trimmed) {
                    build.plugins.push(GradlePlugin {
                        id: c[1].to_string(),
                        version: None,
                        line: line_no,
                        shared,
                    });
                } else if !header {
                    unrecognized_plugins.push(line_no);
                }
            }

            if top == Some("dependencies") && !in_block("buildscript", &stack) {
                if trimmed.starts_with("if ")
                    || trimmed.starts_with("if(")
                    || trimmed.contains(".forEach")
                    || trimmed.starts_with("for ")
                    || trimmed.starts_with("for(")
                {
                    conditional = true;
                }
                if let Some(c) = MAP_DEP.captures(trimmed) {
                    build.dependencies.push(GradleDep {
                        configuration: c[1].to_string(),
                        name: format!("{}:{}", &c[2], &c[3]),
                        version: c.get(4).map(|m| m.as_str().to_string()),
                        line: line_no,
                        shared,
                    });
                } else if let Some(c) = CATALOG_DEP.captures(trimmed) {
                    build.dependencies.push(GradleDep {
                        configuration: c[1].to_string(),
                        name: format!("libs.{}", normalize_alias(&c[2])),
                        version: None,
                        line: line_no,
                        shared,
                    });
                } else if let Some(c) = STRING_DEP.captures(trimmed) {
                    let coordinate = &c[2];
                    let parts: Vec<&str> = coordinate.split(':').collect();
                    if parts.len() >= 2 && !parts[0].contains('$') && !parts[1].contains('$') {
                        build.dependencies.push(GradleDep {
                            configuration: c[1].to_string(),
                            name: format!("{}:{}", parts[0], parts[1]),
                            version: parts
                                .get(2)
                                .map(|v| v.split('@').next().unwrap_or(v).to_string()),
                            line: line_no,
                            shared,
                        });
                    } else {
                        unrecognized.push(line_no);
                    }
                } else if PROJECT_DEP.is_match(trimmed) {
                    // Project and file dependencies are internal; nothing to record.
                } else if trimmed
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_alphabetic())
                    && !header
                    && !trimmed.starts_with("if")
                {
                    unrecognized.push(line_no);
                }
            }
        }
    }

    if !unrecognized_plugins.is_empty() {
        let shown: Vec<String> = unrecognized_plugins
            .iter()
            .take(5)
            .map(|l| l.to_string())
            .collect();
        build.partial.push(format!(
            "{} plugin declaration(s) use a form Habi does not evaluate (line {})",
            unrecognized_plugins.len(),
            shown.join(", ")
        ));
    }
    if conditional {
        build
            .partial
            .push("`dependencies` contains conditional or computed declarations".into());
    }
    if !unrecognized.is_empty() {
        let shown: Vec<String> = unrecognized.iter().take(5).map(|l| l.to_string()).collect();
        build.partial.push(format!(
            "{} dependency declaration(s) use a form Habi does not evaluate (line {})",
            unrecognized.len(),
            shown.join(", ")
        ));
    }
    build
}

/// Parses settings.gradle(.kts) for included projects.
pub fn parse_settings(path: &str, text: &str) -> Settings {
    let clean = strip_comments(text);
    let mut settings = Settings {
        path: path.to_string(),
        ..Default::default()
    };
    for line in clean.lines() {
        let t = line.trim();
        if t.starts_with("include(") || t.starts_with("include ") || t.starts_with("include\t") {
            for c in QUOTED.captures_iter(t) {
                let project = c[1].trim_start_matches(':').replace(':', "/");
                if !project.is_empty() {
                    settings.includes.push(project);
                }
            }
        }
        if t.starts_with("includeBuild") {
            settings.notes.push(
                "Included builds may contribute convention plugins that add dependencies.".into(),
            );
        }
        if t.contains(".projectDir") {
            settings.notes.push(
                "Some project directories are remapped in settings; module paths may differ."
                    .into(),
            );
        }
    }
    settings
}

/// Parses gradle/libs.versions.toml.
pub fn parse_catalog(path: &str, text: &str) -> Result<Catalog, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("could not parse {path}: {e}"))?;
    let versions: HashMap<String, String> = doc
        .get("versions")
        .and_then(|v| v.as_table())
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| {
                    let s = v.as_str().map(str::to_string).or_else(|| {
                        v.get("strictly")
                            .or(v.get("require"))
                            .and_then(|x| x.as_str())
                            .map(str::to_string)
                    })?;
                    Some((k.clone(), s))
                })
                .collect()
        })
        .unwrap_or_default();
    let version_of = |v: &toml::Value| -> Option<String> {
        match v.get("version") {
            Some(toml::Value::String(s)) => Some(s.clone()),
            Some(t @ toml::Value::Table(_)) => t
                .get("ref")
                .and_then(|r| r.as_str())
                .and_then(|r| versions.get(r).cloned())
                .or_else(|| {
                    t.get("strictly")
                        .or(t.get("require"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                }),
            _ => None,
        }
    };
    let mut catalog = Catalog {
        path: path.to_string(),
        ..Default::default()
    };
    if let Some(libs) = doc.get("libraries").and_then(|v| v.as_table()) {
        for (alias, value) in libs {
            let entry = match value {
                toml::Value::String(s) => {
                    let parts: Vec<&str> = s.split(':').collect();
                    (parts.len() >= 2).then(|| {
                        (
                            format!("{}:{}", parts[0], parts[1]),
                            parts.get(2).map(|v| v.to_string()),
                        )
                    })
                }
                toml::Value::Table(_) => {
                    let module = value
                        .get("module")
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                        .or_else(|| {
                            Some(format!(
                                "{}:{}",
                                value.get("group")?.as_str()?,
                                value.get("name")?.as_str()?
                            ))
                        });
                    module.map(|m| (m, version_of(value)))
                }
                _ => None,
            };
            if let Some(entry) = entry {
                catalog.libraries.insert(normalize_alias(alias), entry);
            }
        }
    }
    if let Some(bundles) = doc.get("bundles").and_then(|v| v.as_table()) {
        for (alias, value) in bundles {
            if let Some(list) = value.as_array() {
                catalog.bundles.insert(
                    normalize_alias(alias),
                    list.iter()
                        .filter_map(|x| x.as_str().map(normalize_alias))
                        .collect(),
                );
            }
        }
    }
    if let Some(plugins) = doc.get("plugins").and_then(|v| v.as_table()) {
        for (alias, value) in plugins {
            let entry = match value {
                toml::Value::String(s) => {
                    let mut parts = s.splitn(2, ':');
                    let id = parts.next().unwrap_or_default().to_string();
                    Some((id, parts.next().map(str::to_string)))
                }
                toml::Value::Table(_) => value
                    .get("id")
                    .and_then(|i| i.as_str())
                    .map(|id| (id.to_string(), version_of(value))),
                _ => None,
            };
            if let Some(entry) = entry {
                catalog.plugins.insert(normalize_alias(alias), entry);
            }
        }
    }
    Ok(catalog)
}

fn version_info(raw: Option<&str>, via: Option<&str>) -> VersionInfo {
    match raw {
        None => VersionInfo {
            state: VersionState::Managed,
            declared: None,
            resolved: None,
            note: Some("no version declared; a platform, plugin or convention manages it".into()),
        },
        Some(v) if v.contains('$') => VersionInfo {
            state: VersionState::Unresolved,
            declared: Some(v.to_string()),
            resolved: None,
            note: Some("the version is computed from a build-script variable".into()),
        },
        Some(v)
            if v.contains('+')
                || v.contains('[')
                || v.contains('(')
                || v.starts_with("latest.") =>
        {
            VersionInfo {
                state: VersionState::Range,
                declared: Some(v.to_string()),
                resolved: None,
                note: Some("dynamic version; the selected version is decided at build time".into()),
            }
        }
        Some(v) => VersionInfo {
            state: VersionState::Resolved,
            declared: Some(v.to_string()),
            resolved: Some(v.to_string()),
            note: via.map(|c| format!("from version catalog {c}")),
        },
    }
}

/// Records facts for all Gradle builds. `module_parents` maps each Gradle
/// module to the root module whose `subprojects {}` blocks apply to it.
pub fn collect(
    builds: &[GradleBuild],
    catalog: Option<&Catalog>,
    settings: Option<&Settings>,
    has_convention_sources: bool,
    out: &mut Collector,
) {
    let root_build = builds.iter().find(|b| b.module == ".");
    for build in builds {
        let mut notes = build.partial.clone();
        if has_convention_sources {
            notes.push(
                "Convention plugins from buildSrc or included builds may add dependencies that are not visible."
                    .into(),
            );
        }
        if let Some(s) = settings {
            notes.extend(s.notes.iter().cloned());
        }

        let mut record =
            |dep: &GradleDep, file: &str, origin: FactOrigin, notes: &mut Vec<String>| {
                let (name, version, via) = if let Some(alias) = dep.name.strip_prefix("libs.") {
                    let alias = alias.trim_start_matches("bundles.").to_string();
                    let lookup = catalog.and_then(|c| c.libraries.get(&alias).cloned());
                    match lookup {
                        Some((coordinate, version)) => {
                            (coordinate, version, catalog.map(|c| c.path.clone()))
                        }
                        None => {
                            let bundle = catalog.and_then(|c| c.bundles.get(&alias).cloned());
                            if let (Some(members), Some(c)) = (bundle, catalog) {
                                for member in members {
                                    if let Some((coordinate, version)) = c.libraries.get(&member) {
                                        out.dependency(
                                            &build.module,
                                            Ecosystem::Gradle,
                                            coordinate,
                                            Some(dep.configuration.clone()),
                                            version_info(version.as_deref(), Some(&c.path)),
                                            origin,
                                            DETECTOR,
                                            Evidence {
                                                file: file.to_string(),
                                                line: Some(dep.line),
                                                excerpt: Some(format!("libs.bundles.{alias}")),
                                            },
                                        );
                                    }
                                }
                            } else {
                                notes.push(format!(
                                    "line {}: version-catalog alias `{}` was not found",
                                    dep.line, dep.name
                                ));
                            }
                            return;
                        }
                    }
                } else {
                    (dep.name.clone(), dep.version.clone(), None)
                };
                out.dependency(
                    &build.module,
                    Ecosystem::Gradle,
                    &name,
                    Some(dep.configuration.clone()),
                    version_info(version.as_deref(), via.as_deref()),
                    origin,
                    DETECTOR,
                    Evidence {
                        file: file.to_string(),
                        line: Some(dep.line),
                        excerpt: Some(format!("{} {}", dep.configuration, name)),
                    },
                );
            };

        for dep in &build.dependencies {
            match dep.shared {
                None => record(dep, &build.path, FactOrigin::Direct, &mut notes),
                // Shared blocks apply to the root only for allprojects.
                Some(SharedScope::AllProjects) if build.module == "." => {
                    record(dep, &build.path, FactOrigin::Direct, &mut notes)
                }
                _ => {}
            }
        }
        if build.module != "."
            && let Some(root) = root_build
        {
            for dep in root.dependencies.iter().filter(|d| d.shared.is_some()) {
                record(dep, &root.path, FactOrigin::Inherited, &mut notes);
            }
            if !root.partial.is_empty() {
                notes.push(
                    "The root build script contains declarations Habi does not evaluate.".into(),
                );
            }
        }

        // Plugins applied here, plus those the root applies to subprojects.
        let own = build
            .plugins
            .iter()
            .filter(|p| match p.shared {
                None => true,
                Some(SharedScope::AllProjects) => build.module == ".",
                Some(SharedScope::Subprojects) => false,
            })
            .map(|p| (p, &build.path, FactOrigin::Direct));
        let inherited = root_build
            .filter(|_| build.module != ".")
            .into_iter()
            .flat_map(|root| {
                root.plugins
                    .iter()
                    .filter(|p| p.shared.is_some())
                    .map(move |p| (p, &root.path, FactOrigin::Inherited))
            });
        for (plugin, file, origin) in own.chain(inherited) {
            let (id, version) = match plugin.id.strip_prefix("libs.plugins.") {
                Some(alias) => match catalog.and_then(|c| c.plugins.get(alias)) {
                    Some((id, v)) => (id.clone(), v.clone()),
                    None => {
                        notes.push(format!(
                            "line {}: plugin alias `{}` was not found",
                            plugin.line, plugin.id
                        ));
                        continue;
                    }
                },
                None => (plugin.id.clone(), plugin.version.clone()),
            };
            out.dependency(
                &build.module,
                Ecosystem::Gradle,
                &id,
                Some("plugin".into()),
                version_info(version.as_deref(), None),
                origin,
                DETECTOR,
                Evidence {
                    file: file.clone(),
                    line: Some(plugin.line),
                    excerpt: Some(format!("plugin {id}")),
                },
            );
        }

        let status = if notes.is_empty() {
            CoverageStatus::Complete
        } else {
            CoverageStatus::Partial
        };
        notes.dedup();
        out.coverage(&build.module, "gradle", status, notes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_common_declaration_forms() {
        let text = r#"
plugins {
    id("org.springframework.boot") version "3.3.2"
    id 'io.spring.dependency-management' version '1.1.6'
    `java-library`
    kotlin("jvm") version "2.0.0"
}
// implementation("commented:out:1.0")
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-jooq")
    implementation 'org.liquibase:liquibase-core:4.29.1'
    testImplementation(group = "org.junit.jupiter", name = "junit-jupiter", version = "5.10.0")
    implementation(project(":shared"))
    implementation("org.example:lib:$libVersion")
    /* runtimeOnly("hidden:x:1") */
}
"#;
        let build = parse_build("build.gradle.kts", ".", text);
        let names: Vec<&str> = build.dependencies.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "org.springframework.boot:spring-boot-starter-jooq",
                "org.liquibase:liquibase-core",
                "org.junit.jupiter:junit-jupiter",
                "org.example:lib",
            ]
        );
        let plugin_ids: Vec<&str> = build.plugins.iter().map(|p| p.id.as_str()).collect();
        assert!(plugin_ids.contains(&"org.springframework.boot"));
        assert!(plugin_ids.contains(&"java-library"));
        assert!(plugin_ids.contains(&"org.jetbrains.kotlin.jvm"));
        assert!(build.partial.is_empty(), "{:?}", build.partial);
    }

    #[test]
    fn marks_dynamic_configuration_as_partial() {
        let text = r#"
apply from: "gradle/extra.gradle"
dependencies {
    if (useJooq) {
        implementation("org.jooq:jooq:3.19.0")
    }
    implementation(someDependencyVariable)
}
"#;
        let build = parse_build("build.gradle", ".", text);
        assert_eq!(build.partial.len(), 3, "{:?}", build.partial);
    }

    #[test]
    fn resolves_version_catalog_aliases() {
        let catalog = parse_catalog(
            "gradle/libs.versions.toml",
            r#"
[versions]
liquibase = "4.29.1"
[libraries]
liquibase-core = { module = "org.liquibase:liquibase-core", version.ref = "liquibase" }
jooq = { group = "org.jooq", name = "jooq", version = "3.19.10" }
[bundles]
db = ["liquibase-core", "jooq"]
[plugins]
spring-boot = { id = "org.springframework.boot", version = "3.3.2" }
"#,
        )
        .unwrap();
        let build = parse_build(
            "build.gradle.kts",
            ".",
            "plugins {\n alias(libs.plugins.spring.boot)\n}\ndependencies {\n implementation(libs.liquibase.core)\n implementation(libs.bundles.db)\n}\n",
        );
        let mut out = Collector::default();
        collect(&[build], Some(&catalog), None, false, &mut out);
        let lq = out
            .find_dependency(".", "org.liquibase:liquibase-core")
            .unwrap();
        assert_eq!(lq.resolved.as_deref(), Some("4.29.1"));
        assert!(out.find_dependency(".", "org.jooq:jooq").is_some());
        assert!(
            out.find_dependency(".", "org.springframework.boot")
                .is_some()
        );
        assert_eq!(
            out.coverage_status(".", "gradle"),
            Some(CoverageStatus::Complete)
        );
    }

    #[test]
    fn shared_root_blocks_apply_to_subprojects() {
        let root = parse_build(
            "build.gradle",
            ".",
            "subprojects {\n  dependencies {\n    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'\n  }\n}\n",
        );
        let child = parse_build("api/build.gradle", "api", "dependencies {\n}\n");
        let mut out = Collector::default();
        collect(&[root, child], None, None, false, &mut out);
        assert!(
            out.find_dependency("api", "org.junit.jupiter:junit-jupiter")
                .is_some()
        );
        assert!(
            out.find_dependency(".", "org.junit.jupiter:junit-jupiter")
                .is_none()
        );
    }

    #[test]
    fn declarations_on_the_same_line_as_braces_are_read() {
        let text = r#"
plugins { id("org.springframework.boot") version "3.2.0" }
dependencies { implementation("org.liquibase:liquibase-core:4.29.1") }
dependencies {
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0") }
subprojects { dependencies { implementation 'org.jooq:jooq:3.19.0' } }
"#;
        let build = parse_build("build.gradle.kts", ".", text);
        let ids: Vec<&str> = build.plugins.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["org.springframework.boot"]);
        assert_eq!(build.plugins[0].version.as_deref(), Some("3.2.0"));
        let deps: Vec<(&str, Option<SharedScope>)> = build
            .dependencies
            .iter()
            .map(|d| (d.name.as_str(), d.shared))
            .collect();
        assert_eq!(
            deps,
            vec![
                ("org.liquibase:liquibase-core", None),
                ("org.junit.jupiter:junit-jupiter", None),
                ("org.jooq:jooq", Some(SharedScope::Subprojects)),
            ]
        );
        assert!(build.partial.is_empty(), "{:?}", build.partial);
    }

    #[test]
    fn unreadable_plugin_forms_make_coverage_partial() {
        let build = parse_build(
            "build.gradle.kts",
            ".",
            "plugins { pluginFromSomewhere(\"x\") }\n",
        );
        assert_eq!(build.partial.len(), 1, "{:?}", build.partial);
        assert!(build.partial[0].contains("plugin"));
    }

    #[test]
    fn braces_inside_strings_do_not_open_blocks() {
        let build = parse_build(
            "build.gradle",
            ".",
            "dependencies {\n  implementation \"org.example:lib:${libVersion}\"\n  implementation 'org.liquibase:liquibase-core:4.29.1'\n}\n",
        );
        let names: Vec<&str> = build.dependencies.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["org.example:lib", "org.liquibase:liquibase-core"]
        );
    }

    #[test]
    fn plugins_applied_to_subprojects_belong_to_the_subprojects() {
        let root = parse_build(
            "build.gradle",
            ".",
            "subprojects {\n  apply plugin: 'org.springframework.boot'\n}\nallprojects { apply plugin: 'jacoco' }\n",
        );
        let child = parse_build("api/build.gradle", "api", "dependencies {\n}\n");
        let mut out = Collector::default();
        collect(&[root, child], None, None, false, &mut out);
        assert!(
            out.find_dependency("api", "org.springframework.boot")
                .is_some()
        );
        assert!(
            out.find_dependency(".", "org.springframework.boot")
                .is_none()
        );
        assert!(out.find_dependency(".", "jacoco").is_some());
        assert!(out.find_dependency("api", "jacoco").is_some());
        let inherited = out
            .facts
            .iter()
            .find(|f| f.module == "api" && f.id.ends_with(":org.springframework.boot"))
            .unwrap();
        assert_eq!(inherited.origin, FactOrigin::Inherited);
        assert_eq!(inherited.evidence[0].file, "build.gradle");
    }

    #[test]
    fn settings_includes() {
        let s = parse_settings(
            "settings.gradle",
            "rootProject.name = 'x'\ninclude ':api', ':libs:common'\ninclude(\"web\")\n",
        );
        assert_eq!(s.includes, vec!["api", "libs/common", "web"]);
    }
}
