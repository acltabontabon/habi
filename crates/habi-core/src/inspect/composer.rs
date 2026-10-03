//! PHP projects: `composer.json` and `composer.lock`.
//!
//! Platform requirements (`php`, `ext-*`, `lib-*`, `composer-*`) describe
//! the runtime, not packages, and are left out.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use std::collections::HashMap;

const DETECTOR: &str = "composer";

#[derive(Debug, Clone)]
pub struct ComposerJson {
    pub path: String,
    pub module: String,
    /// `vendor/package`.
    pub name: Option<String>,
    /// `(name, constraint, section, line)`.
    pub dependencies: Vec<(String, String, &'static str, Option<u32>)>,
}

#[derive(Debug, Clone)]
pub struct ComposerLock {
    pub path: String,
    pub versions: HashMap<String, String>,
}

fn platform(name: &str) -> bool {
    name == "php"
        || name.starts_with("ext-")
        || name.starts_with("lib-")
        || name.starts_with("composer-")
        || !name.contains('/')
}

pub fn parse(path: &str, module: &str, text: &str) -> Result<ComposerJson, String> {
    let doc: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{path} could not be read: {e}"))?;
    let mut dependencies = Vec::new();
    for (key, section) in [("require", "require"), ("require-dev", "require-dev")] {
        for (name, constraint) in doc
            .get(key)
            .and_then(|r| r.as_object())
            .into_iter()
            .flatten()
        {
            if platform(name) {
                continue;
            }
            let line = text
                .lines()
                .position(|l| l.contains(&format!("\"{name}\"")))
                .map(|i| i as u32 + 1);
            dependencies.push((
                name.to_lowercase(),
                constraint.as_str().unwrap_or("*").to_string(),
                section,
                line,
            ));
        }
    }
    Ok(ComposerJson {
        path: path.to_string(),
        module: module.to_string(),
        name: doc.get("name").and_then(|n| n.as_str()).map(str::to_string),
        dependencies,
    })
}

pub fn parse_lock(path: &str, text: &str) -> Result<ComposerLock, String> {
    let doc: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{path} could not be read: {e}"))?;
    let mut versions = HashMap::new();
    for key in ["packages", "packages-dev"] {
        for p in doc
            .get(key)
            .and_then(|p| p.as_array())
            .into_iter()
            .flatten()
        {
            if let (Some(name), Some(version)) = (
                p.get("name").and_then(|n| n.as_str()),
                p.get("version").and_then(|v| v.as_str()),
            ) {
                versions.insert(
                    name.to_lowercase(),
                    version.trim_start_matches('v').to_string(),
                );
            }
        }
    }
    Ok(ComposerLock {
        path: path.to_string(),
        versions,
    })
}

pub fn collect(packages: &[ComposerJson], locks: &[ComposerLock], out: &mut Collector) {
    for p in packages {
        // composer.lock sits beside its composer.json.
        let dir_lock = if p.module == "." {
            "composer.lock".to_string()
        } else {
            format!("{}/composer.lock", p.module)
        };
        let lock = locks.iter().find(|l| l.path == dir_lock);
        let mut notes = Vec::new();
        if lock.is_none() && !p.dependencies.is_empty() {
            notes
                .push("No composer.lock was found; installed versions are not established.".into());
        }
        for (name, constraint, section, line) in &p.dependencies {
            let version = match lock.and_then(|l| l.versions.get(name)) {
                Some(v) => VersionInfo {
                    state: VersionState::Resolved,
                    declared: Some(constraint.clone()),
                    resolved: Some(v.clone()),
                    note: Some(format!("locked in {dir_lock}")),
                },
                None => VersionInfo {
                    state: VersionState::Range,
                    declared: Some(constraint.clone()),
                    resolved: None,
                    note: Some(
                        "declared constraint; no lockfile pins the installed version".into(),
                    ),
                },
            };
            out.dependency(
                &p.module,
                Ecosystem::Composer,
                name,
                Some((*section).to_string()),
                version,
                FactOrigin::Direct,
                DETECTOR,
                Evidence {
                    file: p.path.clone(),
                    line: *line,
                    excerpt: Some(format!("\"{name}\": \"{constraint}\"")),
                },
            );
        }
        out.coverage(&p.module, "composer", CoverageStatus::Complete, notes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_packages_and_leaves_the_platform_out() {
        let json = parse(
            "composer.json",
            ".",
            r#"{ "name": "acme/shop",
                 "require": { "php": "^8.2", "ext-json": "*", "laravel/framework": "^11.0" },
                 "require-dev": { "phpunit/phpunit": "^11" } }"#,
        )
        .unwrap();
        assert_eq!(json.name.as_deref(), Some("acme/shop"));
        let names: Vec<&str> = json.dependencies.iter().map(|d| d.0.as_str()).collect();
        assert_eq!(names, vec!["laravel/framework", "phpunit/phpunit"]);
        let lock = parse_lock(
            "composer.lock",
            r#"{ "packages": [{ "name": "laravel/framework", "version": "v11.9.2" }], "packages-dev": [] }"#,
        )
        .unwrap();
        let mut out = Collector::default();
        collect(&[json], &[lock], &mut out);
        let laravel = out.find_dependency(".", "laravel/framework").unwrap();
        assert_eq!(laravel.resolved.as_deref(), Some("11.9.2"));
        assert_eq!(
            out.find_dependency(".", "phpunit/phpunit").unwrap().state,
            VersionState::Range
        );
    }
}
