//! Python projects: `pyproject.toml` (PEP 621 and Poetry), `requirements*.txt`
//! and `Pipfile`, with versions pinned by `uv.lock`, `poetry.lock` or
//! `Pipfile.lock`.
//!
//! Package names are compared in their normalized form (PEP 503): lower
//! case, runs of `-`, `_` and `.` as one `-`. A requirement pinned with `==`
//! is a resolved version; anything else is a range until a lockfile pins it.

use super::model::{CoverageStatus, Ecosystem, Evidence, FactOrigin, VersionInfo, VersionState};
use super::{Collector, is_within};
use std::collections::HashMap;

const DETECTOR: &str = "python";

#[derive(Debug, Clone)]
pub struct PythonManifest {
    pub path: String,
    pub module: String,
    pub name: Option<String>,
    /// `(normalized name, specifier, section, line)`.
    pub dependencies: Vec<(String, Option<String>, String, Option<u32>)>,
    /// Why the list above may not be all of them.
    pub gaps: Vec<String>,
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
/// `("fastapi", Some(">=0.110"))`, and `django @ git+https://...` → `("django",
/// None)`. `None` for bare URLs, options and blanks.
pub fn requirement(text: &str) -> Option<(String, Option<String>)> {
    // `django==5.0 --hash=...`, and the `\\` that continues one to the next line.
    let text = text.split(';').next()?.split(" --").next()?;
    let text = text.trim().trim_end_matches('\\').trim();
    if text.is_empty() || text.starts_with('-') {
        return None;
    }
    // A direct reference says where a package comes from, not which version.
    if let Some((head, _)) = text.split_once('@') {
        let name = head.split('[').next().unwrap_or(head).trim();
        let is_name = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if is_name {
            return Some((normalize(name), None));
        }
    }
    // A URL or a path to an archive names no package that can be told from here.
    if text.contains("://")
        || [".whl", ".zip", ".tar.gz"]
            .iter()
            .any(|e| text.ends_with(e))
    {
        return None;
    }
    let end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(text.len());
    let (name, rest) = text.split_at_checked(end)?;
    let rest = rest.trim_start();
    // Names start with a letter or digit, and only extras or a version follow.
    let starts_well = name.starts_with(|c: char| c.is_ascii_alphanumeric());
    if !starts_well || !(rest.is_empty() || rest.starts_with(['[', '(', '<', '>', '=', '!', '~'])) {
        return None;
    }
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

/// A package name's characters. A line is split at everything else.
fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// The first line each lower-case word of a manifest appears on, found once: a
/// manifest can list 100,000 dependencies, some of them on a single line.
struct WordLines(HashMap<String, u32>);

impl WordLines {
    fn new(text: &str) -> Self {
        let mut first = HashMap::new();
        for (i, line) in text.lines().enumerate() {
            for word in line.split(|c| !name_char(c)).filter(|w| !w.is_empty()) {
                first
                    .entry(word.to_ascii_lowercase())
                    .or_insert(i as u32 + 1);
            }
        }
        WordLines(first)
    }

    /// Where the name that starts `text` first appears.
    fn line_of(&self, text: &str) -> Option<u32> {
        let word = text.split(|c| !name_char(c)).next()?;
        self.0.get(&word.to_ascii_lowercase()).copied()
    }
}

pub fn parse_pyproject(path: &str, module: &str, text: &str) -> Result<PythonManifest, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("{path} could not be read: {e}"))?;
    let lines = WordLines::new(text);
    let mut deps = Vec::new();
    let mut add = |raw: &str, section: &str| {
        if let Some((name, spec)) = requirement(raw) {
            deps.push((name, spec, section.to_string(), lines.line_of(raw)));
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
                lines.line_of(name),
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
    // PEP 621: a build backend decides these when it runs, and Habi runs nothing.
    let dynamic = project
        .and_then(|p| p.get("dynamic"))
        .and_then(|d| d.as_array())
        .into_iter()
        .flatten()
        .filter_map(|d| d.as_str())
        .any(|field| matches!(field, "dependencies" | "optional-dependencies"));
    let gaps = dynamic
        .then(|| format!("{path} leaves its dependencies to the build backend (`dynamic`)."))
        .into_iter()
        .collect();
    Ok(PythonManifest {
        path: path.to_string(),
        module: module.to_string(),
        name,
        dependencies: deps,
        gaps,
    })
}

/// A requirements line that was not read as a requirement but may stand for
/// some: another file (`-r`), constraints (`-c`), an editable install (`-e`), a
/// bare URL or path. Other options (`--hash`, `--index-url`) name no package.
fn stands_for_requirements(line: &str) -> bool {
    !line.starts_with('-')
        || [
            "-r",
            "-c",
            "-e",
            "--requirement",
            "--constraint",
            "--editable",
        ]
        .iter()
        .any(|option| line.starts_with(option))
}

pub fn parse_requirements(path: &str, module: &str, text: &str) -> PythonManifest {
    let section = if path.contains("dev") || path.contains("test") {
        "dev"
    } else {
        "dependencies"
    };
    let mut dependencies = Vec::new();
    let mut gaps = Vec::new();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for (i, raw) in text.lines().enumerate() {
        let line = raw.split(" #").next().unwrap_or(raw).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let number = i as u32 + 1;
        match requirement(line) {
            Some((n, s)) => dependencies.push((n, s, section.to_string(), Some(number))),
            None if stands_for_requirements(line) => gaps.push(format!(
                "{path}, line {number}: `{}` may stand for requirements Habi does not read.",
                super::clip(line, 80)
            )),
            None => {}
        }
    }
    PythonManifest {
        path: path.to_string(),
        module: module.to_string(),
        name: None,
        dependencies,
        gaps,
    }
}

pub fn parse_pipfile(path: &str, module: &str, text: &str) -> Result<PythonManifest, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e| format!("{path} could not be read: {e}"))?;
    let lines = WordLines::new(text);
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
                lines.line_of(name),
            ));
        }
    }
    Ok(PythonManifest {
        path: path.to_string(),
        module: module.to_string(),
        name: None,
        dependencies,
        gaps: Vec::new(),
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
                is_within(&m.module, dir)
            })
            .max_by_key(|l| l.path.len());
        let mut notes = m.gaps.clone();
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
        let status = if m.gaps.is_empty() {
            CoverageStatus::Complete
        } else {
            CoverageStatus::Partial
        };
        out.coverage(&m.module, "pypi", status, notes);
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
        assert_eq!(reqs.gaps.len(), 1, "{:?}", reqs.gaps);
        assert!(reqs.gaps[0].contains("line 3"), "{:?}", reqs.gaps);
    }

    #[test]
    fn a_direct_reference_names_its_package() {
        assert_eq!(
            requirement("django @ git+https://github.com/example/django"),
            Some(("django".into(), None))
        );
        assert_eq!(
            requirement(
                "Great_Expectations[sql]@https://example.com/ge.whl ; python_version > '3'"
            ),
            Some(("great-expectations".into(), None))
        );
        // The `@` of a URL's user is no direct reference.
        assert_eq!(requirement("git+ssh://git@example.com/a/b"), None);
    }

    #[test]
    fn only_a_name_and_a_version_make_a_requirement() {
        for text in [
            "./local/x",
            "../x",
            "local/x",
            "x-1.0-py3-none-any.whl",
            "a b",
        ] {
            assert_eq!(requirement(text), None, "{text}");
        }
        for (text, spec) in [
            ("django==5.0 \\", "==5.0"),
            ("django==5.0 --hash=sha256:abc", "==5.0"),
            ("django (>=5)", ">=5"),
            ("django ~= 5.0", "~=5.0"),
            ("django != 5.0", "!=5.0"),
        ] {
            assert_eq!(
                requirement(text),
                Some(("django".into(), Some(spec.into()))),
                "{text}"
            );
        }
    }

    #[test]
    fn lines_that_stand_for_requirements_leave_the_list_open() {
        let gaps = |text: &str| parse_requirements("requirements.txt", ".", text).gaps.len();
        for line in [
            "-r requirements/prod.txt",
            "-rprod.txt",
            "--requirement prod.txt",
            "--requirement=prod.txt",
            "-c constraints.txt",
            "--constraint constraints.txt",
            "-e .",
            "--editable ./lib",
            "git+https://example.com/a/b",
            "./local/package.whl",
        ] {
            assert_eq!(gaps(line), 1, "{line}");
        }
        for line in [
            "# -r not.txt",
            "",
            "   ",
            "--hash=sha256:abc",
            "--index-url https://example.com/simple",
            "-i https://example.com/simple",
            "django==5.0",
        ] {
            assert_eq!(gaps(line), 0, "{line}");
        }
    }

    #[test]
    fn a_byte_order_mark_does_not_hide_the_first_requirement() {
        let reqs = parse_requirements("requirements.txt", ".", "\u{feff}django==5.0\nflask\n");
        let names: Vec<&str> = reqs.dependencies.iter().map(|d| d.0.as_str()).collect();
        assert_eq!(names, vec!["django", "flask"]);
        assert!(reqs.gaps.is_empty(), "{:?}", reqs.gaps);
    }

    #[test]
    fn dynamic_dependencies_are_a_gap() {
        let dynamic = parse_pyproject(
            "pyproject.toml",
            ".",
            "[project]\nname = \"x\"\ndynamic = [\"dependencies\", \"version\"]\n",
        )
        .unwrap();
        assert_eq!(dynamic.gaps.len(), 1);
        let version_only = parse_pyproject(
            "pyproject.toml",
            ".",
            "[project]\nname = \"x\"\ndynamic = [\"version\"]\ndependencies = []\n",
        )
        .unwrap();
        assert!(version_only.gaps.is_empty());
    }

    #[test]
    fn evidence_lines_are_those_of_the_first_mention() {
        let text = "[project]\nname = \"x\"\ndependencies = [\n  \"My-Pkg>=1\",\n  \"zope.interface\",\n]\n";
        let m = parse_pyproject("pyproject.toml", ".", text).unwrap();
        let line = |name: &str| m.dependencies.iter().find(|d| d.0 == name).unwrap().3;
        assert_eq!(line("my-pkg"), Some(4));
        assert_eq!(line("zope-interface"), Some(5));
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
