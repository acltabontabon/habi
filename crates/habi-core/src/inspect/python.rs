//! Python projects: `pyproject.toml` (PEP 621 and Poetry), `requirements*.txt`
//! and `Pipfile`, with versions pinned by `uv.lock`, `poetry.lock` or
//! `Pipfile.lock`.
//!
//! Package names are compared in their normalized form (PEP 503): lower
//! case, runs of `-`, `_` and `.` as one `-`. A requirement pinned with `==`
//! is a resolved version; anything else is a range until a lockfile pins it.

use super::Collector;
use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use std::collections::HashMap;

const DETECTOR: &str = "python";

#[derive(Debug, Clone)]
pub struct PythonManifest {
    pub path: String,
    pub module: String,
    pub name: Option<String>,
    /// `(normalized name, specifier, section, line)`.
    pub dependencies: Vec<(String, Option<String>, String, Option<u32>)>,
}

#[derive(Debug, Clone)]
pub struct PythonLock {
    pub path: String,
    /// Normalized name → version.
    pub versions: HashMap<String, String>,
}

/// PEP 503: `Great_Expectations` → `great-expectations`.
pub fn normalize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut dash = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            dash = true;
        } else {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.extend(c.to_lowercase());
        }
    }
    out
}

/// A PEP 508 requirement: `fastapi[all]>=0.110; python_version >= "3.10"` →
/// `("fastapi", Some(">=0.110"))`. `None` for URLs, options and blanks.
pub fn requirement(text: &str) -> Option<(String, Option<String>)> {
    let text = text.split(';').next()?.trim();
    if text.is_empty() || text.starts_with('-') || text.contains("://") {
        return None;
    }
    let end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(text.len());
    let (name, rest) = text.split_at_checked(end)?;
    if name.is_empty() {
        return None;
    }
    let rest = rest.trim_start();
    // Extras, then the version specifier.
    let rest = match rest.strip_prefix('[') {
        Some(r) => r
            .split_once(']')
            .map(|(_, after)| after)
            .unwrap_or("")
            .trim(),
        None => rest,
    };
    let spec = rest.trim_start_matches('(').trim_end_matches(')').trim();
    Some((
        normalize(name),
        (!spec.is_empty()).then(|| spec.replace(' ', "")),
    ))
}

fn line_of(text: &str, needle: &str) -> Option<u32> {
    let needle = needle.to_lowercase();
    text.lines()
        .position(|l| l.to_lowercase().contains(&needle))
        .map(|i| i as u32 + 1)
}

pub fn parse_pyproject(path: &str, module: &str, text: &str) -> Result<PythonManifest, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("{path} could not be read: {e}"))?;
    let mut deps = Vec::new();
    let mut add = |raw: &str, section: &str| {
        if let Some((name, spec)) = requirement(raw) {
            let line = line_of(
                text,
                raw.split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                    .next()
                    .unwrap_or(raw),
            );
            deps.push((name, spec, section.to_string(), line));
        }
    };
    let project = doc.get("project");
    for d in project
        .and_then(|p| p.get("dependencies"))
        .and_then(|d| d.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(s) = d.as_str() {
            add(s, "dependencies");
        }
    }
    if let Some(optional) = project
        .and_then(|p| p.get("optional-dependencies"))
        .and_then(|o| o.as_table())
    {
        for (extra, list) in optional {
            for d in list.as_array().into_iter().flatten() {
                if let Some(s) = d.as_str() {
                    add(s, &format!("optional:{extra}"));
                }
            }
        }
    }
    // PEP 735 dependency groups.
    if let Some(groups) = doc.get("dependency-groups").and_then(|g| g.as_table()) {
        for (group, list) in groups {
            for d in list.as_array().into_iter().flatten() {
                if let Some(s) = d.as_str() {
                    add(s, &format!("group:{group}"));
                }
            }
        }
    }
    // Poetry: `name = "^1.2"` or `name = { version = "^1.2" }`.
    let poetry = doc.get("tool").and_then(|t| t.get("poetry"));
    let mut poetry_table = |table: Option<&toml::Value>, section: &str| {
        for (name, spec) in table.and_then(|t| t.as_table()).into_iter().flatten() {
            if name.eq_ignore_ascii_case("python") {
                continue;
            }
            let spec = match spec {
                toml::Value::String(s) => Some(s.clone()),
                toml::Value::Table(t) => t
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                _ => None,
            };
            deps.push((
                normalize(name),
                spec.filter(|s| s != "*"),
                section.to_string(),
                line_of(text, name),
            ));
        }
    };
    poetry_table(poetry.and_then(|p| p.get("dependencies")), "dependencies");
    poetry_table(poetry.and_then(|p| p.get("dev-dependencies")), "dev");
    if let Some(groups) = poetry
        .and_then(|p| p.get("group"))
        .and_then(|g| g.as_table())
    {
        for (group, g) in groups {
            poetry_table(g.get("dependencies"), &format!("group:{group}"));
        }
    }
    let name = project
        .and_then(|p| p.get("name"))
        .or_else(|| poetry.and_then(|p| p.get("name")))
        .and_then(|n| n.as_str())
        .map(str::to_string);
    Ok(PythonManifest {
        path: path.to_string(),
        module: module.to_string(),
        name,
        dependencies: deps,
    })
}

pub fn parse_requirements(path: &str, module: &str, text: &str) -> PythonManifest {
    let section = if path.contains("dev") || path.contains("test") {
        "dev"
    } else {
        "dependencies"
    };
    let dependencies = text
        .lines()
        .enumerate()
        .filter_map(|(i, raw)| {
            let line = raw.split(" #").next().unwrap_or(raw).trim();
            if line.starts_with('#') {
                return None;
            }
            requirement(line).map(|(n, s)| (n, s, section.to_string(), Some(i as u32 + 1)))
        })
        .collect();
    PythonManifest {
        path: path.to_string(),
        module: module.to_string(),
        name: None,
        dependencies,
    }
}

pub fn parse_pipfile(path: &str, module: &str, text: &str) -> Result<PythonManifest, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("{path} could not be read: {e}"))?;
    let mut dependencies = Vec::new();
    for (table, section) in [("packages", "dependencies"), ("dev-packages", "dev")] {
        for (name, spec) in doc
            .get(table)
            .and_then(|t| t.as_table())
            .into_iter()
            .flatten()
        {
            let spec = match spec {
                toml::Value::String(s) => Some(s.clone()),
                toml::Value::Table(t) => t
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                _ => None,
            };
            dependencies.push((
                normalize(name),
                spec.filter(|s| s != "*"),
                section.to_string(),
                line_of(text, name),
            ));
        }
    }
    Ok(PythonManifest {
        path: path.to_string(),
        module: module.to_string(),
        name: None,
        dependencies,
    })
}

/// `uv.lock` and `poetry.lock` (`[[package]] name, version`), or `Pipfile.lock` (JSON).
pub fn parse_lock(path: &str, text: &str) -> Result<PythonLock, String> {
    let mut versions = HashMap::new();
    if path.ends_with("Pipfile.lock") {
        let doc: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("{path} could not be read: {e}"))?;
        for section in ["default", "develop"] {
            for (name, entry) in doc
                .get(section)
                .and_then(|s| s.as_object())
                .into_iter()
                .flatten()
            {
                if let Some(v) = entry.get("version").and_then(|v| v.as_str()) {
                    versions.insert(normalize(name), v.trim_start_matches("==").to_string());
                }
            }
        }
    } else {
        let doc: toml::Table = text
            .parse()
            .map_err(|e| format!("{path} could not be read: {e}"))?;
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
                    .entry(normalize(name))
                    .or_insert_with(|| version.to_string());
            }
        }
    }
    Ok(PythonLock {
        path: path.to_string(),
        versions,
    })
}

pub fn collect(manifests: &[PythonManifest], locks: &[PythonLock], out: &mut Collector) {
    for m in manifests {
        let lock = locks
            .iter()
            .filter(|l| {
                let dir = l.path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
                dir == "." || m.module == dir || m.module.starts_with(&format!("{dir}/"))
            })
            .max_by_key(|l| l.path.len());
        let mut notes = Vec::new();
        for (name, spec, section, line) in &m.dependencies {
            let pinned = spec
                .as_deref()
                .and_then(|s| s.strip_prefix("=="))
                .filter(|v| !v.contains(['*', ',']));
            let locked =
                lock.and_then(|l| l.versions.get(name).map(|v| (v.clone(), l.path.clone())));
            let version = match (locked, pinned) {
                (Some((v, from)), _) => VersionInfo {
                    state: VersionState::Resolved,
                    declared: spec.clone(),
                    resolved: Some(v),
                    note: Some(format!("locked in {from}")),
                },
                (None, Some(v)) => VersionInfo {
                    state: VersionState::Resolved,
                    declared: spec.clone(),
                    resolved: Some(v.to_string()),
                    note: Some("exact version pin".into()),
                },
                (None, None) => VersionInfo {
                    state: VersionState::Range,
                    declared: spec.clone(),
                    resolved: None,
                    note: Some("declared range; no lockfile pins the installed version".into()),
                },
            };
            out.dependency(
                &m.module,
                Ecosystem::Pypi,
                name,
                Some(section.clone()),
                version,
                FactOrigin::Direct,
                DETECTOR,
                Evidence {
                    file: m.path.clone(),
                    line: *line,
                    excerpt: Some(format!("{name}{}", spec.as_deref().unwrap_or(""))),
                },
            );
        }
        if lock.is_none()
            && m.dependencies
                .iter()
                .any(|(_, s, _, _)| !s.as_deref().is_some_and(|s| s.starts_with("==")))
        {
            notes.push("No uv.lock, poetry.lock or Pipfile.lock was found; installed versions are not established.".into());
        }
        out.coverage(&m.module, "pypi", CoverageStatus::Complete, notes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requirements_read_like_pip_reads_them() {
        assert_eq!(normalize("Great_Expectations"), "great-expectations");
        assert_eq!(
            requirement("Django==5.0.6"),
            Some(("django".into(), Some("==5.0.6".into())))
        );
        assert_eq!(
            requirement("fastapi[all] >= 0.110 ; python_version >= '3.10'"),
            Some(("fastapi".into(), Some(">=0.110".into())))
        );
        assert_eq!(
            requirement("apache-airflow"),
            Some(("apache-airflow".into(), None))
        );
        assert_eq!(requirement("-r base.txt"), None);
        assert_eq!(requirement("git+https://github.com/a/b"), None);

        let reqs = parse_requirements(
            "requirements.txt",
            ".",
            "# pinned\npandas==2.2.2\n-r dev.txt\npyspark>=3.5  # spark\n",
        );
        let names: Vec<&str> = reqs.dependencies.iter().map(|d| d.0.as_str()).collect();
        assert_eq!(names, vec!["pandas", "pyspark"]);
    }

    #[test]
    fn pyproject_poetry_and_locks() {
        let pep621 = parse_pyproject(
            "pyproject.toml",
            ".",
            r#"
[project]
name = "pipelines"
dependencies = ["dagster>=1.7", "dbt-core==1.8.2"]

[project.optional-dependencies]
dev = ["pytest"]

[dependency-groups]
lint = ["ruff"]
"#,
        )
        .unwrap();
        assert_eq!(pep621.name.as_deref(), Some("pipelines"));
        let poetry = parse_pyproject(
            "svc/pyproject.toml",
            "svc",
            r#"
[tool.poetry]
name = "svc"

[tool.poetry.dependencies]
python = "^3.11"
FastAPI = "^0.110"
SQLAlchemy = { version = "^2.0", extras = ["asyncio"] }

[tool.poetry.group.test.dependencies]
pytest = "^8"
"#,
        )
        .unwrap();
        let lock = parse_lock(
            "uv.lock",
            "[[package]]\nname = \"dagster\"\nversion = \"1.7.9\"\n",
        )
        .unwrap();
        let mut out = Collector::default();
        collect(&[pep621, poetry], &[lock], &mut out);
        assert_eq!(
            out.find_dependency(".", "dagster")
                .unwrap()
                .resolved
                .as_deref(),
            Some("1.7.9")
        );
        assert_eq!(
            out.find_dependency(".", "dbt-core")
                .unwrap()
                .resolved
                .as_deref(),
            Some("1.8.2")
        );
        assert!(out.find_dependency(".", "ruff").is_some());
        assert_eq!(
            out.find_dependency("svc", "sqlalchemy").unwrap().state,
            VersionState::Range
        );
        assert!(out.find_dependency("svc", "python").is_none());
        assert!(out.find_dependency("svc", "pytest").is_some());
    }
}
