//! Static reading of `package.json` files and lockfiles.
//!
//! A declared range such as `^18.2.0` is not a runtime version. Habi resolves
//! concrete versions only from `package-lock.json` or `pnpm-lock.yaml` (or an
//! exact pin); otherwise the version stays a range.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use serde_json::Value;
use std::collections::HashMap;

const DETECTOR: &str = "npm";

#[derive(Debug, Clone)]
pub struct PackageJson {
    pub path: String,
    pub module: String,
    pub name: Option<String>,
    /// (name, declared range, section, line)
    pub dependencies: Vec<(String, String, &'static str, Option<u32>)>,
    pub workspaces: Vec<String>,
    pub package_manager: Option<String>,
}

const SECTIONS: &[(&str, &str)] = &[
    ("dependencies", "prod"),
    ("devDependencies", "dev"),
    ("peerDependencies", "peer"),
    ("optionalDependencies", "optional"),
];

/// Finds the 1-based line of `"key"` after `section` appears, for evidence.
fn line_of_key(text: &str, section: &str, key: &str) -> Option<u32> {
    let section_pos = text.find(&format!("\"{section}\""))?;
    let needle = format!("\"{key}\"");
    let rel = text[section_pos..].find(&needle)?;
    let pos = section_pos + rel;
    Some(text[..pos].matches('\n').count() as u32 + 1)
}

pub fn parse(path: &str, module: &str, text: &str) -> Result<PackageJson, String> {
    let json: Value =
        serde_json::from_str(text).map_err(|e| format!("could not parse {path}: {e}"))?;
    let obj = json
        .as_object()
        .ok_or_else(|| format!("{path} is not a JSON object"))?;
    let mut dependencies = Vec::new();
    for (section, label) in SECTIONS {
        if let Some(map) = obj.get(*section).and_then(Value::as_object) {
            for (name, range) in map {
                let range = range.as_str().unwrap_or("").to_string();
                dependencies.push((
                    name.clone(),
                    range,
                    *label,
                    line_of_key(text, section, name),
                ));
            }
        }
    }
    let workspaces = match obj.get("workspaces") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(Value::Object(o)) => o
            .get("packages")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(PackageJson {
        path: path.to_string(),
        module: module.to_string(),
        name: obj.get("name").and_then(Value::as_str).map(str::to_string),
        dependencies,
        workspaces,
        package_manager: obj
            .get("packageManager")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Concrete versions from a lockfile, keyed by (module dir, package name).
#[derive(Debug, Default)]
pub struct Lockfile {
    pub path: String,
    pub versions: HashMap<(String, String), String>,
}

/// Reads `package-lock.json` (lockfileVersion 2 or 3). `lock_dir` is the
/// directory containing the lockfile, relative to the repository.
pub fn parse_package_lock(path: &str, lock_dir: &str, text: &str) -> Result<Lockfile, String> {
    let json: Value =
        serde_json::from_str(text).map_err(|e| format!("could not parse {path}: {e}"))?;
    let packages = json
        .get("packages")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!("{path} has no `packages` map (lockfileVersion 1 is not supported)")
        })?;
    let mut lock = Lockfile {
        path: path.to_string(),
        ..Default::default()
    };
    for (key, entry) in packages {
        let Some(version) = entry.get("version").and_then(Value::as_str) else {
            continue;
        };
        // Keys look like "node_modules/react" or "packages/web/node_modules/react".
        let Some(idx) = key.rfind("node_modules/") else {
            continue;
        };
        let name = &key[idx + "node_modules/".len()..];
        let owner = key[..idx].trim_end_matches('/');
        let module = join_dir(lock_dir, owner);
        lock.versions
            .insert((module, name.to_string()), version.to_string());
    }
    Ok(lock)
}

/// Reads `pnpm-lock.yaml` importers (lockfile v6 and later).
pub fn parse_pnpm_lock(path: &str, lock_dir: &str, text: &str) -> Result<Lockfile, String> {
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_nodes: 2_000_000,
            max_events: 6_000_000,
            max_depth: 64,
        },
    };
    let yaml: Value = serde_saphyr::from_str_with_options(text, options)
        .map_err(|e| format!("could not parse {path}: {e}"))?;
    let mut lock = Lockfile {
        path: path.to_string(),
        ..Default::default()
    };
    let Some(importers) = yaml.get("importers").and_then(Value::as_object) else {
        return Ok(lock);
    };
    for (importer, sections) in importers {
        let module = join_dir(lock_dir, if importer == "." { "" } else { importer });
        for section in ["dependencies", "devDependencies", "optionalDependencies"] {
            let Some(map) = sections.get(section).and_then(Value::as_object) else {
                continue;
            };
            for (name, spec) in map {
                let version = match spec {
                    Value::String(s) => s.clone(),
                    Value::Object(o) => o
                        .get("version")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    _ => continue,
                };
                // "18.2.0(react@18.2.0)" -> "18.2.0"; links are not versions.
                let version = version.split('(').next().unwrap_or("").to_string();
                if version.is_empty()
                    || version.starts_with("link:")
                    || version.starts_with("file:")
                {
                    continue;
                }
                lock.versions
                    .insert((module.clone(), name.clone()), version);
            }
        }
    }
    Ok(lock)
}

fn join_dir(base: &str, rel: &str) -> String {
    match (base, rel) {
        (".", "") | ("", "") => ".".into(),
        (".", r) | ("", r) => r.to_string(),
        (b, "") => b.to_string(),
        (b, r) => format!("{b}/{r}"),
    }
}

fn is_exact(range: &str) -> bool {
    semver::Version::parse(range).is_ok()
}

pub fn collect(packages: &[PackageJson], locks: &[Lockfile], out: &mut Collector) {
    for pkg in packages {
        let mut notes = Vec::new();
        // The nearest lockfile at or above the module.
        let lock = locks
            .iter()
            .filter(|l| {
                let dir = l.path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
                dir == "." || pkg.module == dir || pkg.module.starts_with(&format!("{dir}/"))
            })
            .max_by_key(|l| l.path.len());
        if lock.is_none() && !pkg.dependencies.is_empty() {
            notes.push("No package-lock.json or pnpm-lock.yaml was found; installed versions are not established.".into());
        }
        for (name, range, section, line) in &pkg.dependencies {
            let locked = lock.and_then(|l| {
                l.versions
                    .get(&(pkg.module.clone(), name.clone()))
                    .or_else(|| l.versions.get(&(".".to_string(), name.clone())))
                    .map(|v| (v.clone(), l.path.clone()))
            });
            let version = if let Some((v, from)) = locked {
                VersionInfo {
                    state: VersionState::Resolved,
                    declared: Some(range.clone()),
                    resolved: Some(v),
                    note: Some(format!("locked in {from}")),
                }
            } else if is_exact(range) {
                VersionInfo {
                    state: VersionState::Resolved,
                    declared: Some(range.clone()),
                    resolved: Some(range.clone()),
                    note: Some("exact version pin".into()),
                }
            } else if range.starts_with("workspace:")
                || range.starts_with("file:")
                || range.starts_with("link:")
            {
                VersionInfo {
                    state: VersionState::Resolved,
                    declared: Some(range.clone()),
                    resolved: None,
                    note: Some("local workspace package".into()),
                }
            } else {
                VersionInfo {
                    state: VersionState::Range,
                    declared: Some(range.clone()),
                    resolved: None,
                    note: Some(
                        "declared range; no lockfile entry pins the installed version".into(),
                    ),
                }
            };
            out.dependency(
                &pkg.module,
                Ecosystem::Npm,
                name,
                Some((*section).to_string()),
                version,
                FactOrigin::Direct,
                DETECTOR,
                Evidence {
                    file: pkg.path.clone(),
                    line: *line,
                    excerpt: Some(format!("\"{name}\": \"{range}\"")),
                },
            );
        }
        // Dependency presence is fully visible in package.json even without a
        // lockfile; only versions are affected, so coverage stays complete.
        out.coverage(&pkg.module, "npm", CoverageStatus::Complete, notes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_not_runtime_versions_without_a_lockfile() {
        let pkg = parse(
            "package.json",
            ".",
            r#"{ "name": "web", "dependencies": { "react": "^18.2.0", "zod": "3.23.8" },
                 "devDependencies": { "vitest": "^2.0.0" } }"#,
        )
        .unwrap();
        let mut out = Collector::default();
        collect(&[pkg], &[], &mut out);
        let react = out.find_dependency(".", "react").unwrap();
        assert_eq!(react.state, VersionState::Range);
        let zod = out.find_dependency(".", "zod").unwrap();
        assert_eq!(zod.resolved.as_deref(), Some("3.23.8"));
    }

    #[test]
    fn package_lock_pins_versions_per_workspace() {
        let lock = parse_package_lock(
            "package-lock.json",
            ".",
            r#"{ "lockfileVersion": 3, "packages": {
                "": {}, "node_modules/react": { "version": "18.3.1" },
                "packages/web/node_modules/react": { "version": "19.0.0" } } }"#,
        )
        .unwrap();
        let root = parse("package.json", ".", r#"{"dependencies":{"react":"^18"}}"#).unwrap();
        let web = parse(
            "packages/web/package.json",
            "packages/web",
            r#"{"dependencies":{"react":"^19"}}"#,
        )
        .unwrap();
        let mut out = Collector::default();
        collect(&[root, web], &[lock], &mut out);
        assert_eq!(
            out.find_dependency(".", "react")
                .unwrap()
                .resolved
                .as_deref(),
            Some("18.3.1")
        );
        assert_eq!(
            out.find_dependency("packages/web", "react")
                .unwrap()
                .resolved
                .as_deref(),
            Some("19.0.0")
        );
    }

    #[test]
    fn pnpm_lock_importers() {
        let lock = parse_pnpm_lock(
            "pnpm-lock.yaml",
            ".",
            "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^5.5.0\n        version: 5.5.4\n  apps/web:\n    dependencies:\n      react:\n        specifier: ^18.2.0\n        version: 18.3.1(react-dom@18.3.1)\n",
        )
        .unwrap();
        assert_eq!(
            lock.versions
                .get(&("apps/web".to_string(), "react".to_string()))
                .map(String::as_str),
            Some("18.3.1")
        );
        assert_eq!(
            lock.versions
                .get(&(".".to_string(), "typescript".to_string()))
                .map(String::as_str),
            Some("5.5.4")
        );
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse("package.json", ".", "{ not json").is_err());
        assert!(parse("package.json", ".", "[1,2]").is_err());
    }
}
