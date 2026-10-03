//! Rust crates: `Cargo.toml` and the workspace's `Cargo.lock`.
//!
//! A manifest's version requirement (`1.0` means `^1.0`) is a range; the
//! lockfile pins what is built. A workspace shares one lockfile at its root,
//! and a member's `dep = { workspace = true }` takes its requirement from
//! the root's `[workspace.dependencies]`.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use std::collections::HashMap;

const DETECTOR: &str = "cargo";

#[derive(Debug, Clone)]
pub struct CargoToml {
    pub path: String,
    pub module: String,
    /// `[package] name`.
    pub name: Option<String>,
    /// `(name, requirement, section, line)`; a workspace dependency's
    /// requirement is filled in by `collect`.
    pub dependencies: Vec<(String, Option<String>, &'static str, Option<u32>)>,
    /// `[workspace.dependencies]`, for members that inherit.
    pub workspace_dependencies: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct CargoLock {
    pub path: String,
    /// Crate name → version (the first listed when several are built).
    pub versions: HashMap<String, String>,
}

pub fn parse(path: &str, module: &str, text: &str) -> Result<CargoToml, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("{path} could not be read: {e}"))?;
    let name = doc
        .get("package")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .map(str::to_string);
    let line_of = |dep: &str| {
        text.lines()
            .position(|l| {
                let t = l.trim_start();
                t.strip_prefix(dep)
                    .is_some_and(|rest| rest.trim_start().starts_with(['=', '.']))
            })
            .map(|i| i as u32 + 1)
    };
    let mut dependencies = Vec::new();
    let mut push_section = |table: Option<&toml::Value>, section: &'static str| {
        let Some(table) = table.and_then(|t| t.as_table()) else {
            return;
        };
        for (dep, spec) in table {
            // `package = "real-name"` renames a crate; the real name is what matches.
            let real = spec
                .get("package")
                .and_then(|p| p.as_str())
                .unwrap_or(dep)
                .to_string();
            dependencies.push((real, requirement(spec), section, line_of(dep)));
        }
    };
    push_section(doc.get("dependencies"), "dependencies");
    push_section(doc.get("dev-dependencies"), "dev-dependencies");
    push_section(doc.get("build-dependencies"), "build-dependencies");
    if let Some(targets) = doc.get("target").and_then(|t| t.as_table()) {
        for target in targets.values() {
            push_section(target.get("dependencies"), "dependencies");
            push_section(target.get("dev-dependencies"), "dev-dependencies");
        }
    }
    let workspace_dependencies = doc
        .get("workspace")
        .and_then(|w| w.get("dependencies"))
        .and_then(|d| d.as_table())
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| requirement(v).map(|r| (k.clone(), r)))
                .collect()
        })
        .unwrap_or_default();
    Ok(CargoToml {
        path: path.to_string(),
        module: module.to_string(),
        name,
        dependencies,
        workspace_dependencies,
    })
}

/// `"1.0"` or `{ version = "1.0" }`; `None` for path, git or workspace dependencies.
fn requirement(spec: &toml::Value) -> Option<String> {
    match spec {
        toml::Value::String(s) => Some(s.clone()),
        toml::Value::Table(t) => t
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ => None,
    }
}

pub fn parse_lock(path: &str, text: &str) -> Result<CargoLock, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("{path} could not be read: {e}"))?;
    let mut versions = HashMap::new();
    for package in doc
        .get("package")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
    {
        if let (Some(name), Some(version)) = (
            package.get("name").and_then(|n| n.as_str()),
            package.get("version").and_then(|v| v.as_str()),
        ) {
            versions
                .entry(name.to_string())
                .or_insert_with(|| version.to_string());
        }
    }
    Ok(CargoLock {
        path: path.to_string(),
        versions,
    })
}

pub fn collect(crates: &[CargoToml], locks: &[CargoLock], out: &mut Collector) {
    // A member inherits from the nearest workspace root above it.
    let root_of = |module: &str| {
        crates
            .iter()
            .filter(|c| !c.workspace_dependencies.is_empty())
            .filter(|c| {
                c.module == "."
                    || module == c.module
                    || module.starts_with(&format!("{}/", c.module))
            })
            .max_by_key(|c| c.module.len())
    };
    let lock_of = |module: &str| {
        locks
            .iter()
            .filter(|l| {
                let dir = l.path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
                dir == "." || module == dir || module.starts_with(&format!("{dir}/"))
            })
            .max_by_key(|l| l.path.len())
    };
    for c in crates {
        let lock = lock_of(&c.module);
        let mut notes = Vec::new();
        if lock.is_none() && !c.dependencies.is_empty() {
            notes.push("No Cargo.lock was found; built versions are not established.".into());
        }
        for (name, req, section, line) in &c.dependencies {
            let declared = req.clone().or_else(|| {
                root_of(&c.module).and_then(|r| r.workspace_dependencies.get(name).cloned())
            });
            let locked =
                lock.and_then(|l| l.versions.get(name).map(|v| (v.clone(), l.path.clone())));
            let version = match (locked, &declared) {
                (Some((v, from)), _) => VersionInfo {
                    state: VersionState::Resolved,
                    declared: declared.clone(),
                    resolved: Some(v),
                    note: Some(format!("locked in {from}")),
                },
                (None, Some(d)) => VersionInfo {
                    state: VersionState::Range,
                    declared: Some(d.clone()),
                    resolved: None,
                    note: Some("declared requirement; no lockfile pins the built version".into()),
                },
                (None, None) => VersionInfo {
                    state: VersionState::Resolved,
                    declared: None,
                    resolved: None,
                    note: Some("a path or Git dependency".into()),
                },
            };
            out.dependency(
                &c.module,
                Ecosystem::Cargo,
                name,
                Some((*section).to_string()),
                version,
                FactOrigin::Direct,
                DETECTOR,
                Evidence {
                    file: c.path.clone(),
                    line: *line,
                    excerpt: Some(match &declared {
                        Some(d) => format!("{name} = \"{d}\""),
                        None => name.clone(),
                    }),
                },
            );
        }
        out.coverage(&c.module, "cargo", CoverageStatus::Complete, notes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_crates_workspaces_and_the_lockfile() {
        let root = parse(
            "Cargo.toml",
            ".",
            r#"
[workspace]
members = ["app"]

[workspace.dependencies]
serde = { version = "1.0", features = ["derive"] }
"#,
        )
        .unwrap();
        let app = parse(
            "app/Cargo.toml",
            "app",
            r#"
[package]
name = "draft"

[dependencies]
axum = "0.7"
serde = { workspace = true }
local = { path = "../local" }
http_types = { package = "http", version = "1" }

[dev-dependencies]
tokio = { version = "1", features = ["full"] }
"#,
        )
        .unwrap();
        assert_eq!(app.name.as_deref(), Some("draft"));
        let lock = parse_lock(
            "Cargo.lock",
            r#"
[[package]]
name = "axum"
version = "0.7.5"

[[package]]
name = "serde"
version = "1.0.203"
"#,
        )
        .unwrap();
        let mut out = Collector::default();
        collect(&[root, app], &[lock], &mut out);
        let axum = out.find_dependency("app", "axum").unwrap();
        assert_eq!(axum.resolved.as_deref(), Some("0.7.5"));
        let serde = out.find_dependency("app", "serde").unwrap();
        assert_eq!(serde.declared.as_deref(), Some("1.0"));
        assert_eq!(serde.resolved.as_deref(), Some("1.0.203"));
        // A renamed crate matches by its real name.
        assert!(out.find_dependency("app", "http").is_some());
        let tokio = out.find_dependency("app", "tokio").unwrap();
        assert_eq!(tokio.state, VersionState::Range);
    }
}
