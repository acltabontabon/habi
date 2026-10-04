//! Read-only repository inspection.
//!
//! `inspect` walks a project (bounded, ignore-aware), reads build manifests
//! and recognized files, and returns facts with provenance plus coverage
//! describing what could not be established. It never runs builds, Git,
//! package managers or hooks.

pub mod cargo;
pub mod composer;
mod describe;
pub mod files;
pub mod golang;
pub mod gradle;
pub mod maven;
pub mod model;
pub mod npm;
pub mod python;
pub mod repo;
pub mod tags;
pub mod walk;

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::fsutil::{Bounded, read_bounded, sha256, tree_digest};
use model::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

pub use walk::WalkOptions;

const MANIFEST_LIMIT: u64 = 2 * 1024 * 1024;
const LOCKFILE_LIMIT: u64 = 48 * 1024 * 1024;

/// Accumulates facts and coverage while detectors run.
#[derive(Default)]
pub struct Collector {
    pub facts: Vec<Fact>,
    pub coverage: Vec<Coverage>,
    file_notes: Vec<String>,
    /// Content-probe candidates per module that were not read (limit or
    /// read error).
    pub content_skipped: BTreeMap<String, u32>,
}

impl Collector {
    fn push_or_merge(&mut self, fact: Fact) -> String {
        if let Some(existing) = self.facts.iter_mut().find(|f| f.id == fact.id) {
            for e in fact.evidence {
                let duplicate = existing
                    .evidence
                    .iter()
                    .any(|x| x.file == e.file && x.line == e.line);
                if !duplicate && existing.evidence.len() < 8 {
                    existing.evidence.push(e);
                }
            }
            for d in fact.derived_from {
                if !existing.derived_from.contains(&d) {
                    existing.derived_from.push(d);
                }
            }
            // A direct declaration is stronger evidence than an inherited one.
            if existing.origin == FactOrigin::Inherited && fact.origin == FactOrigin::Direct {
                existing.origin = FactOrigin::Direct;
                existing.subject = fact.subject;
            }
            return existing.id.clone();
        }
        let id = fact.id.clone();
        self.facts.push(fact);
        id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dependency(
        &mut self,
        module: &str,
        ecosystem: Ecosystem,
        name: &str,
        scope: Option<String>,
        version: VersionInfo,
        origin: FactOrigin,
        detector: &str,
        evidence: Evidence,
    ) -> String {
        let id = format!("dep:{module}:{}:{name}", ecosystem.label().to_lowercase());
        self.push_or_merge(Fact {
            id,
            module: module.to_string(),
            subject: FactSubject::Dependency {
                ecosystem,
                name: name.to_string(),
                scope,
                version,
            },
            origin,
            detector: detector.to_string(),
            evidence: vec![evidence],
            derived_from: Vec::new(),
            note: None,
        })
    }

    pub fn file(
        &mut self,
        module: &str,
        path: &str,
        role: &str,
        detector: &str,
        line: Option<u32>,
    ) {
        self.push_or_merge(Fact {
            id: format!("file:{path}:{role}"),
            module: module.to_string(),
            subject: FactSubject::File {
                path: path.to_string(),
                role: role.to_string(),
            },
            origin: FactOrigin::Direct,
            detector: detector.to_string(),
            evidence: vec![files::evidence(path, line)],
            derived_from: Vec::new(),
            note: None,
        });
    }

    /// Adds (or extends) a derived tag in `module` based on fact `from`.
    pub fn tag(&mut self, module: &str, tag: &str, from: &str) {
        let evidence = self
            .facts
            .iter()
            .find(|f| f.id == from)
            .map(|f| f.evidence.iter().take(1).cloned().collect())
            .unwrap_or_default();
        self.push_or_merge(Fact {
            id: format!("tag:{module}:{tag}"),
            module: module.to_string(),
            subject: FactSubject::Tag {
                tag: tag.to_string(),
            },
            origin: FactOrigin::Derived,
            detector: "tags".into(),
            evidence,
            derived_from: vec![from.to_string()],
            note: None,
        });
    }

    pub fn language(&mut self, module: &str, tag: &str, example: &str, count: u32) {
        self.push_or_merge(Fact {
            id: format!("tag:{module}:{tag}"),
            module: module.to_string(),
            subject: FactSubject::Tag {
                tag: tag.to_string(),
            },
            origin: FactOrigin::Derived,
            detector: "languages".into(),
            evidence: vec![files::evidence(example, None)],
            derived_from: Vec::new(),
            note: Some(format!(
                "{count} source file{} in this module",
                if count == 1 { "" } else { "s" }
            )),
        });
    }

    pub fn coverage(
        &mut self,
        module: &str,
        area: &str,
        status: CoverageStatus,
        notes: Vec<String>,
    ) {
        if let Some(existing) = self
            .coverage
            .iter_mut()
            .find(|c| c.module == module && c.area == area)
        {
            // Keep the weakest status.
            let rank = |s: CoverageStatus| match s {
                CoverageStatus::Complete => 0,
                CoverageStatus::Partial => 1,
                CoverageStatus::Failed => 2,
            };
            if rank(status) > rank(existing.status) {
                existing.status = status;
            }
            existing.notes.extend(notes);
            return;
        }
        self.coverage.push(Coverage {
            module: module.to_string(),
            area: area.to_string(),
            status,
            notes,
        });
    }

    pub fn global_file_note(&mut self, note: String) {
        self.file_notes.push(note);
    }

    #[cfg(test)]
    pub fn find_dependency(&self, module: &str, name: &str) -> Option<VersionInfo> {
        self.facts.iter().find_map(|f| match &f.subject {
            FactSubject::Dependency {
                name: n, version, ..
            } if n == name && f.module == module => Some(version.clone()),
            _ => None,
        })
    }

    #[cfg(test)]
    pub fn coverage_status(&self, module: &str, area: &str) -> Option<CoverageStatus> {
        self.coverage
            .iter()
            .find(|c| c.module == module && c.area == area)
            .map(|c| c.status)
    }
}

fn dir_of(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((d, _)) => d.to_string(),
        None => ".".to_string(),
    }
}

fn read_text(root: &Path, rel: &str, limit: u64) -> std::result::Result<String, String> {
    let full = root.join(rel);
    match std::fs::symlink_metadata(&full) {
        Ok(m) if m.is_file() => {}
        Ok(_) => return Err(format!("{rel} is not a regular file")),
        Err(e) => return Err(format!("{rel} could not be read: {e}")),
    }
    match read_bounded(&full, limit) {
        Ok(Bounded::Content(bytes)) => {
            String::from_utf8(bytes).map_err(|_| format!("{rel} is not valid UTF-8"))
        }
        Ok(Bounded::TooLarge(size)) => Err(format!(
            "{rel} is {size} bytes, above the {limit}-byte limit for parsing"
        )),
        Err(e) => Err(e.to_string()),
    }
}

pub fn inspect(
    root: &Path,
    options: &WalkOptions,
    cancel: &CancelToken,
) -> Result<ProjectInspection> {
    let root = crate::paths::canonical_dir(root)?;
    let walked = walk::walk(&root, options, cancel)?;
    let files = walked.files;
    let walked_dirs = walked.dirs;
    let walk_errors = walked.errors;
    let mut report = walked.report;
    let mut out = Collector::default();
    let mut fingerprint_parts: Vec<(String, String)> = Vec::new();

    // Paths by file name, built once: looked up for every manifest kind.
    let mut by_name: HashMap<&str, Vec<&str>> = HashMap::new();
    for (p, _) in &files {
        let name = p.rsplit('/').next().unwrap_or(p);
        by_name.entry(name).or_default().push(p);
    }
    let names = |name: &str| -> Vec<String> {
        by_name
            .get(name)
            .map(|paths| paths.iter().map(|p| p.to_string()).collect())
            .unwrap_or_default()
    };
    let poms = names("pom.xml");
    let gradle_builds: Vec<String> = names("build.gradle")
        .into_iter()
        .chain(names("build.gradle.kts"))
        .filter(|p| !p.starts_with("buildSrc/") && !p.starts_with("build-logic/"))
        .collect();
    let package_jsons = names("package.json");
    let go_mods = names("go.mod");
    let cargo_tomls = names("Cargo.toml");
    let composer_jsons = names("composer.json");
    // Python declares dependencies in several files; any of them makes a module.
    let pyprojects = names("pyproject.toml");
    let pipfiles = names("Pipfile");
    let mut requirement_files: Vec<String> = by_name
        .iter()
        .filter(|(n, _)| n.starts_with("requirements") && n.ends_with(".txt"))
        .flat_map(|(_, paths)| paths.iter().map(|p| p.to_string()))
        .collect();
    requirement_files.sort();
    let setup_pys = names("setup.py");

    // Modules: every directory with a build manifest, plus the root.
    let mut module_ecosystems: BTreeMap<String, BTreeSet<Ecosystem>> = BTreeMap::new();
    module_ecosystems.insert(".".into(), BTreeSet::new());
    for p in &poms {
        module_ecosystems
            .entry(dir_of(p))
            .or_default()
            .insert(Ecosystem::Maven);
    }
    for p in &gradle_builds {
        module_ecosystems
            .entry(dir_of(p))
            .or_default()
            .insert(Ecosystem::Gradle);
    }
    for p in &package_jsons {
        module_ecosystems
            .entry(dir_of(p))
            .or_default()
            .insert(Ecosystem::Npm);
    }
    let other_manifests = [
        (&go_mods, Ecosystem::Go),
        (&cargo_tomls, Ecosystem::Cargo),
        (&composer_jsons, Ecosystem::Composer),
        (&pyprojects, Ecosystem::Pypi),
        (&pipfiles, Ecosystem::Pypi),
        (&requirement_files, Ecosystem::Pypi),
        (&setup_pys, Ecosystem::Pypi),
    ];
    for (paths, ecosystem) in other_manifests {
        for p in paths {
            module_ecosystems
                .entry(dir_of(p))
                .or_default()
                .insert(ecosystem);
        }
    }
    let module_ids: Vec<String> = module_ecosystems.keys().cloned().collect();
    let lookup = model::ModuleLookup::new(module_ids.iter().map(String::as_str));
    let module_of = |path: &str| lookup.owner(path).to_string();

    let mut module_names: BTreeMap<String, String> = BTreeMap::new();
    let mut signals: Vec<String> = Vec::new();

    // Maven.
    let mut parsed_poms = Vec::new();
    for p in &poms {
        cancel.check()?;
        let module = dir_of(p);
        match read_text(&root, p, MANIFEST_LIMIT) {
            Ok(text) => {
                fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
                match maven::parse(p, &module, &text) {
                    Ok(pom) => {
                        if let Some(a) = &pom.artifact {
                            module_names.insert(module.clone(), a.clone());
                        }
                        if !pom.modules.is_empty() {
                            signals.push(format!("Maven modules in {p} ({})", pom.modules.len()));
                        }
                        parsed_poms.push(pom);
                    }
                    Err(e) => out.coverage(&module, "maven", CoverageStatus::Failed, vec![e]),
                }
            }
            Err(e) => {
                report.unreadable.push(p.clone());
                out.coverage(&module, "maven", CoverageStatus::Failed, vec![e]);
            }
        }
    }
    maven::collect(&parsed_poms, &mut out);

    // Gradle.
    let settings = names("settings.gradle")
        .into_iter()
        .chain(names("settings.gradle.kts"))
        .find(|p| !p.contains('/'))
        .and_then(|p| {
            let text = read_text(&root, &p, MANIFEST_LIMIT).ok()?;
            fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
            Some(gradle::parse_settings(&p, &text))
        });
    if let Some(s) = &settings
        && !s.includes.is_empty()
    {
        signals.push(format!(
            "Gradle includes in {} ({})",
            s.path,
            s.includes.len()
        ));
    }
    let catalog = match read_text(&root, "gradle/libs.versions.toml", MANIFEST_LIMIT) {
        Ok(text) if files.iter().any(|(p, _)| p == "gradle/libs.versions.toml") => {
            fingerprint_parts.push(("gradle/libs.versions.toml".into(), sha256(text.as_bytes())));
            match gradle::parse_catalog("gradle/libs.versions.toml", &text) {
                Ok(c) => Some(c),
                Err(e) => {
                    out.coverage(".", "gradle", CoverageStatus::Partial, vec![e]);
                    None
                }
            }
        }
        _ => None,
    };
    let has_convention_sources = files
        .iter()
        .any(|(p, _)| p.starts_with("buildSrc/") || p.starts_with("build-logic/"))
        || settings
            .as_ref()
            .is_some_and(|s| s.notes.iter().any(|n| n.contains("Included builds")));
    let mut parsed_gradle = Vec::new();
    for p in &gradle_builds {
        cancel.check()?;
        let module = dir_of(p);
        match read_text(&root, p, MANIFEST_LIMIT) {
            Ok(text) => {
                fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
                parsed_gradle.push(gradle::parse_build(p, &module, &text));
            }
            Err(e) => {
                report.unreadable.push(p.clone());
                out.coverage(&module, "gradle", CoverageStatus::Failed, vec![e]);
            }
        }
    }
    gradle::collect(
        &parsed_gradle,
        catalog.as_ref(),
        settings.as_ref(),
        has_convention_sources,
        &mut out,
    );

    // npm.
    let mut packages = Vec::new();
    for p in &package_jsons {
        cancel.check()?;
        let module = dir_of(p);
        match read_text(&root, p, MANIFEST_LIMIT) {
            Ok(text) => {
                fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
                match npm::parse(p, &module, &text) {
                    Ok(pkg) => {
                        if let Some(n) = &pkg.name {
                            module_names
                                .entry(module.clone())
                                .or_insert_with(|| n.clone());
                        }
                        if !pkg.workspaces.is_empty() {
                            signals.push(format!("npm workspaces in {p}"));
                        }
                        packages.push(pkg);
                    }
                    Err(e) => out.coverage(&module, "npm", CoverageStatus::Failed, vec![e]),
                }
            }
            Err(e) => {
                report.unreadable.push(p.clone());
                out.coverage(&module, "npm", CoverageStatus::Failed, vec![e]);
            }
        }
    }
    let mut locks = Vec::new();
    let lockfiles: Vec<String> = names("package-lock.json")
        .into_iter()
        .chain(names("pnpm-lock.yaml"))
        .collect();
    for p in &lockfiles {
        cancel.check()?;
        let dir = dir_of(p);
        // Lockfile contents decide resolved versions, so they are part of the
        // fingerprint (a version bump keeps the size more often than not).
        let parsed = read_text(&root, p, LOCKFILE_LIMIT).and_then(|text| {
            fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
            if p.ends_with("pnpm-lock.yaml") {
                npm::parse_pnpm_lock(p, &dir, &text)
            } else {
                npm::parse_package_lock(p, &dir, &text)
            }
        });
        match parsed {
            Ok(l) => locks.push(l),
            Err(e) => out.coverage(
                &dir,
                "npm",
                CoverageStatus::Complete,
                vec![format!("Versions not pinned: {e}")],
            ),
        }
    }
    if files.iter().any(|(p, _)| p == "pnpm-workspace.yaml") {
        signals.push("pnpm workspace".into());
    }
    for marker in ["lerna.json", "nx.json", "turbo.json"] {
        if files.iter().any(|(p, _)| p == marker) {
            signals.push(marker.to_string());
        }
    }
    npm::collect(&packages, &locks, &mut out);

    // Go, Rust, Python and PHP: a manifest per module, a lockfile where the
    // ecosystem has one. A file that cannot be read marks its area failed.
    let read_manifest = |p: &str,
                         area: &str,
                         out: &mut Collector,
                         report: &mut ScanReport,
                         fingerprint: &mut Vec<(String, String)>| {
        match read_text(&root, p, MANIFEST_LIMIT) {
            Ok(text) => {
                fingerprint.push((p.to_string(), sha256(text.as_bytes())));
                Some(text)
            }
            Err(e) => {
                report.unreadable.push(p.to_string());
                out.coverage(&dir_of(p), area, CoverageStatus::Failed, vec![e]);
                None
            }
        }
    };

    let mut go = Vec::new();
    for p in &go_mods {
        cancel.check()?;
        if let Some(text) = read_manifest(p, "go", &mut out, &mut report, &mut fingerprint_parts) {
            let m = golang::parse(p, &dir_of(p), &text);
            if let Some(name) = m.name.as_deref().and_then(golang::display_name) {
                module_names.entry(m.module.clone()).or_insert(name);
            }
            go.push(m);
        }
    }
    golang::collect(&go, &mut out);

    let mut crates = Vec::new();
    for p in &cargo_tomls {
        cancel.check()?;
        if let Some(text) = read_manifest(p, "cargo", &mut out, &mut report, &mut fingerprint_parts)
        {
            match cargo::parse(p, &dir_of(p), &text) {
                Ok(c) => {
                    if let Some(n) = &c.name {
                        module_names
                            .entry(c.module.clone())
                            .or_insert_with(|| n.clone());
                    }
                    crates.push(c);
                }
                Err(e) => out.coverage(&dir_of(p), "cargo", CoverageStatus::Failed, vec![e]),
            }
        }
    }
    let cargo_locks: Vec<cargo::CargoLock> = names("Cargo.lock")
        .iter()
        .filter_map(|p| {
            let text = read_text(&root, p, LOCKFILE_LIMIT).ok()?;
            fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
            cargo::parse_lock(p, &text).ok()
        })
        .collect();
    cargo::collect(&crates, &cargo_locks, &mut out);

    let mut python_manifests = Vec::new();
    for p in pyprojects.iter().chain(&pipfiles).chain(&requirement_files) {
        cancel.check()?;
        let module = dir_of(p);
        let Some(text) = read_manifest(p, "pypi", &mut out, &mut report, &mut fingerprint_parts)
        else {
            continue;
        };
        let parsed = if p.ends_with("pyproject.toml") {
            python::parse_pyproject(p, &module, &text)
        } else if p.ends_with("Pipfile") {
            python::parse_pipfile(p, &module, &text)
        } else {
            Ok(python::parse_requirements(p, &module, &text))
        };
        match parsed {
            Ok(m) => {
                if let Some(n) = &m.name {
                    module_names
                        .entry(module.clone())
                        .or_insert_with(|| n.clone());
                }
                python_manifests.push(m);
            }
            Err(e) => out.coverage(&module, "pypi", CoverageStatus::Failed, vec![e]),
        }
    }
    let python_locks: Vec<python::PythonLock> = names("uv.lock")
        .into_iter()
        .chain(names("poetry.lock"))
        .chain(names("Pipfile.lock"))
        .filter_map(|p| {
            let text = read_text(&root, &p, LOCKFILE_LIMIT).ok()?;
            fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
            python::parse_lock(&p, &text).ok()
        })
        .collect();
    python::collect(&python_manifests, &python_locks, &mut out);

    let mut composers = Vec::new();
    for p in &composer_jsons {
        cancel.check()?;
        if let Some(text) =
            read_manifest(p, "composer", &mut out, &mut report, &mut fingerprint_parts)
        {
            match composer::parse(p, &dir_of(p), &text) {
                Ok(c) => {
                    if let Some(n) = c.name.as_deref().and_then(|n| n.rsplit('/').next()) {
                        module_names
                            .entry(c.module.clone())
                            .or_insert_with(|| n.to_string());
                    }
                    composers.push(c);
                }
                Err(e) => out.coverage(&dir_of(p), "composer", CoverageStatus::Failed, vec![e]),
            }
        }
    }
    let composer_locks: Vec<composer::ComposerLock> = names("composer.lock")
        .iter()
        .filter_map(|p| {
            let text = read_text(&root, p, LOCKFILE_LIMIT).ok()?;
            fingerprint_parts.push((p.clone(), sha256(text.as_bytes())));
            composer::parse_lock(p, &text).ok()
        })
        .collect();
    composer::collect(&composers, &composer_locks, &mut out);

    // Recognized files and derived tags.
    cancel.check()?;
    files::collect(&root, &files, &mut out, &module_of);
    tags::derive(&mut out, &files, &module_of);

    // File coverage per module: the listing is incomplete when a traversal
    // limit stopped the walk or some directories could not be read.
    let mut file_notes = std::mem::take(&mut out.file_notes);
    if report.truncated {
        file_notes.extend(report.limits_hit.iter().cloned());
    }
    if walk_errors > 0 {
        file_notes.push(format!(
            "{walk_errors} director{} or entr{} could not be read; files in them were not listed.",
            if walk_errors == 1 { "y" } else { "ies" },
            if walk_errors == 1 { "y" } else { "ies" },
        ));
    }
    let content_skipped = std::mem::take(&mut out.content_skipped);
    for module in &module_ids {
        let status = if file_notes.is_empty() {
            CoverageStatus::Complete
        } else {
            CoverageStatus::Partial
        };
        out.coverage(module, "files", status, file_notes.clone());
        // Content probes (OpenAPI, Liquibase) have their own area so that a
        // probe limit only affects the tags that need file content.
        match content_skipped.get(module) {
            Some(&n) if n > 0 => out.coverage(
                module,
                "content",
                CoverageStatus::Partial,
                vec![files::content_note(n)],
            ),
            _ => out.coverage(module, "content", CoverageStatus::Complete, Vec::new()),
        }
    }

    // Modules.
    let modules: Vec<Module> = module_ecosystems
        .iter()
        .map(|(id, ecosystems)| {
            let parent = if id == "." {
                None
            } else {
                Some(model::owning_module(
                    module_ids.iter().map(String::as_str).filter(|m| m != id),
                    id,
                ))
            };
            let name = module_names.get(id).cloned().unwrap_or_else(|| {
                if id == "." {
                    root.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "project".into())
                } else {
                    id.rsplit('/').next().unwrap_or(id).to_string()
                }
            });
            Module {
                id: id.clone(),
                name,
                ecosystems: ecosystems.iter().copied().collect(),
                parent,
            }
        })
        .collect();

    let mut repository = repo::describe(&root);
    signals.sort();
    signals.dedup();
    let modules_with_manifests = modules.iter().filter(|m| !m.ecosystems.is_empty()).count();
    repository.is_monorepo = modules_with_manifests > 2
        || (modules_with_manifests == 2
            && modules
                .iter()
                .any(|m| m.id != "." && !m.ecosystems.is_empty())
            && !signals.is_empty());
    repository.workspace_signals = signals;

    // What a cached copy re-checks to notice edits, new or removed files and
    // branch switches: indexed files, ignore files, Git's HEAD and the
    // listed directories.
    let mut watched: Vec<String> = Vec::new();
    watched.extend(poms.iter().cloned());
    watched.extend(gradle_builds.iter().cloned());
    watched.extend(package_jsons.iter().cloned());
    watched.extend(lockfiles.iter().cloned());
    for paths in [
        &go_mods,
        &cargo_tomls,
        &composer_jsons,
        &pyprojects,
        &pipfiles,
        &requirement_files,
        &setup_pys,
    ] {
        watched.extend(paths.iter().cloned());
    }
    for lock in [
        "Cargo.lock",
        "uv.lock",
        "poetry.lock",
        "Pipfile.lock",
        "composer.lock",
    ] {
        watched.extend(names(lock));
    }
    for name in [
        "settings.gradle",
        "settings.gradle.kts",
        ".gitignore",
        ".ignore",
        ".habiignore",
    ] {
        watched.extend(names(name));
    }
    watched.extend(describe::readme_of(&files).map(str::to_string));
    watched.push("gradle/libs.versions.toml".into());
    watched.push(".git/HEAD".into());
    // Content probes and check freshness also depend on ordinary files.
    watched.extend(files.iter().map(|(path, _)| path.clone()));
    watched.extend(walked_dirs);
    watched.sort();
    watched.dedup();
    let freshness = model::Freshness::capture(&root, watched.iter().map(String::as_str));

    // Include file modification times: checks may depend on source or script
    // contents, even when an edit leaves the file size unchanged. Source bodies
    // stay unread. Unchanged files keep the same fingerprint across rescans.
    let file_stamps: HashMap<_, _> = freshness
        .stamps
        .iter()
        .map(|(p, stamp)| (p.as_str(), stamp))
        .collect();
    let listing = sha256(
        files
            .iter()
            .map(|(p, s)| {
                let stamp = file_stamps
                    .get(p.as_str())
                    .and_then(|s| s.as_ref())
                    .map(|s| s.fingerprint())
                    .unwrap_or_else(|| "unreadable".into());
                format!("{p}\t{s}\t{stamp}\n")
            })
            .collect::<String>()
            .as_bytes(),
    );
    fingerprint_parts.push(("<tree>".into(), listing));
    let fingerprint = tree_digest(
        fingerprint_parts
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str())),
    );

    let mut facts = out.facts;
    facts.sort_by(|a, b| a.module.cmp(&b.module).then(a.id.cmp(&b.id)));
    let name = modules
        .iter()
        .find(|m| m.id == ".")
        .map(|m| m.name.clone())
        .unwrap_or_default();
    let description = describe::describe(&root, &name, &files);

    let inspection = ProjectInspection {
        root: crate::paths::display_path(&root),
        name,
        description,
        repository,
        modules,
        facts,
        coverage: out.coverage,
        scan: report,
        fingerprint,
        inspected_at: crate::time::now(),
        files: files.into_iter().map(|(p, _)| p).collect(),
        index: Default::default(),
        freshness: Some(std::sync::Arc::new(freshness)),
    };
    // Build the per-module index now so every copy of a cached inspection
    // shares it.
    inspection.index();
    Ok(inspection)
}

/// Inspects the project at `root`.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_and_malformed_manifests_are_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let huge = format!("<project>{}</project>", "<!-- padding -->".repeat(200_000));
        std::fs::write(dir.path().join("pom.xml"), huge).unwrap();
        std::fs::create_dir_all(dir.path().join("web")).unwrap();
        std::fs::write(dir.path().join("web/package.json"), "{ \"dependencies\": ").unwrap();
        let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        let maven = i
            .coverage
            .iter()
            .find(|c| c.module == "." && c.area == "maven")
            .unwrap();
        assert_eq!(maven.status, CoverageStatus::Failed);
        assert!(maven.notes[0].contains("limit"), "{:?}", maven.notes);
        let npm = i
            .coverage
            .iter()
            .find(|c| c.module == "web" && c.area == "npm")
            .unwrap();
        assert_eq!(npm.status, CoverageStatus::Failed);
    }

    #[test]
    fn go_rust_python_and_php_modules_are_read_with_their_frameworks() {
        let dir = tempfile::tempdir().unwrap();
        let write = |path: &str, text: &str| {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write(
            "api/go.mod",
            "module github.com/acme/api\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
        );
        write("api/main.go", "package main\n");
        write(
            "desktop/Cargo.toml",
            "[package]\nname = \"desktop\"\n\n[dependencies]\ntauri = \"2\"\n",
        );
        write(
            "desktop/Cargo.lock",
            "[[package]]\nname = \"tauri\"\nversion = \"2.0.6\"\n",
        );
        write(
            "pipelines/pyproject.toml",
            "[project]\nname = \"pipelines\"\ndependencies = [\"apache-airflow>=2.9\", \"dbt-postgres==1.8.2\"]\n",
        );
        write("pipelines/dbt_project.yml", "name: warehouse\n");
        write(
            "shop/composer.json",
            r#"{"name":"acme/shop","require":{"php":"^8.2","laravel/framework":"^11"}}"#,
        );
        write("shop/app/Http/Kernel.php", "<?php\n");

        let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        let ecosystems = |id: &str| {
            i.modules
                .iter()
                .find(|m| m.id == id)
                .unwrap()
                .ecosystems
                .clone()
        };
        assert_eq!(ecosystems("api"), vec![Ecosystem::Go]);
        assert_eq!(ecosystems("desktop"), vec![Ecosystem::Cargo]);
        assert_eq!(ecosystems("pipelines"), vec![Ecosystem::Pypi]);
        assert_eq!(ecosystems("shop"), vec![Ecosystem::Composer]);
        let name = |id: &str| i.modules.iter().find(|m| m.id == id).unwrap().name.clone();
        assert_eq!(name("api"), "api");
        assert_eq!(name("shop"), "shop");

        let tags = |module: &str| -> Vec<&str> {
            i.facts
                .iter()
                .filter(|f| f.module == module)
                .filter_map(|f| f.tag())
                .collect()
        };
        assert!(tags("api").contains(&"framework:gin"), "{:?}", tags("api"));
        assert!(tags("api").contains(&"lang:go"));
        assert!(tags("desktop").contains(&"framework:tauri"));
        assert!(tags("pipelines").contains(&"data:airflow"));
        assert!(tags("pipelines").contains(&"data:dbt"));
        assert!(tags("shop").contains(&"framework:laravel"));
        assert!(tags("shop").contains(&"lang:php"));
        assert_eq!(
            coverage_of(&i, "desktop", "cargo"),
            CoverageStatus::Complete
        );

        // An edited go.mod is noticed by a cached inspection.
        let before = i.fingerprint.clone();
        write(
            "api/go.mod",
            "module github.com/acme/api\n\nrequire github.com/gin-gonic/gin v1.10.1\n",
        );
        let after = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert_ne!(before, after.fingerprint);
    }

    fn coverage_of(i: &ProjectInspection, module: &str, area: &str) -> CoverageStatus {
        i.coverage
            .iter()
            .find(|c| c.module == module && c.area == area)
            .map(|c| c.status)
            .unwrap_or_else(|| panic!("no {area} coverage for {module}"))
    }

    #[test]
    fn lockfile_contents_change_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"react":"^18.2.0"}}"#,
        )
        .unwrap();
        let lock = |v: &str| {
            format!(
                r#"{{"lockfileVersion":3,"packages":{{"":{{"dependencies":{{"react":"^18.2.0"}}}},"node_modules/react":{{"version":"{v}"}}}}}}"#
            )
        };
        std::fs::write(dir.path().join("package-lock.json"), lock("18.2.0")).unwrap();
        let a = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        // Same size, different pinned version.
        std::fs::write(dir.path().join("package-lock.json"), lock("18.3.1")).unwrap();
        let b = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        assert!(
            a.is_stale(),
            "the lockfile edit is noticed on a cached copy"
        );
        assert!(!b.is_stale());
    }

    #[test]
    fn content_probe_limit_does_not_make_file_absence_unknown() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        for i in 0..650 {
            std::fs::write(dir.path().join(format!("data/f{i:04}.json")), "{}").unwrap();
        }
        std::fs::write(dir.path().join("pom.xml"), "<project/>").unwrap();
        let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        assert_eq!(coverage_of(&i, ".", "files"), CoverageStatus::Complete);
        assert_eq!(coverage_of(&i, ".", "content"), CoverageStatus::Partial);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_directories_make_file_coverage_partial() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("Dockerfile"), "FROM scratch\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let i = i.unwrap();
        if i.files.iter().any(|f| f == "locked/Dockerfile") {
            return; // running with privileges that read anything
        }
        assert_eq!(coverage_of(&i, ".", "files"), CoverageStatus::Partial);
    }

    #[test]
    fn cancellation_stops_inspection() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "").unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        assert!(matches!(
            inspect(dir.path(), &WalkOptions::default(), &cancel),
            Err(crate::error::HabiError::Cancelled)
        ));
    }
}
