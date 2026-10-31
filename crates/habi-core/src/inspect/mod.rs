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
mod ignores;
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
use crate::redact::redact;
use model::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

pub use walk::WalkOptions;

const MANIFEST_LIMIT: u64 = 2 * 1024 * 1024;
const LOCKFILE_LIMIT: u64 = 48 * 1024 * 1024;
/// Manifests and lockfiles read in one inspection, together. Git stores
/// identical files once, so a small repository can hold thousands of copies of
/// the largest lockfile allowed.
const MANIFEST_BUDGET: u64 = 128 * 1024 * 1024;
/// Modules kept, shallowest first. Each one costs an evaluation per skill.
const MAX_MODULES: usize = 2_000;
/// Dependency facts kept. A parent build fans out to every module below it.
const MAX_FACTS: usize = 250_000;
/// A dependency name longer than this is not a real one.
const MAX_NAME: usize = 512;
/// Excerpts, scopes, versions and version notes are cut or refused at this.
const MAX_TEXT: usize = 256;
/// Notes kept per coverage entry, and the length of each. Every evaluation that
/// ends in "not established" can quote them.
const MAX_NOTES: usize = 20;
const MAX_NOTE: usize = 512;
/// Facts derived from one other fact are never all shown.
const MAX_DERIVED_FROM: usize = 16;

/// At most `max` bytes of `text`, cut where a character ends.
pub(crate) fn clip(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.get(..end).unwrap_or(text)
}

/// Where each line of a text starts, so that a byte offset's line is a binary
/// search away instead of a scan from the top for every dependency.
pub(crate) struct LineStarts(Vec<usize>);

impl LineStarts {
    pub(crate) fn new(text: &str) -> Self {
        let breaks = text.match_indices('\n').map(|(at, _)| at + 1);
        LineStarts(std::iter::once(0).chain(breaks).collect())
    }

    /// The 1-based line of a byte offset.
    pub(crate) fn line_at(&self, offset: usize) -> u32 {
        self.0.partition_point(|start| *start <= offset) as u32
    }
}

/// Every string in a JSON text and where it opens, found once. A `package.json`
/// with 100,000 dependencies would otherwise be searched as many times.
pub(crate) struct JsonStrings<'a> {
    at: HashMap<&'a str, Vec<usize>>,
    lines: LineStarts,
}

impl<'a> JsonStrings<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        let mut at: HashMap<&'a str, Vec<usize>> = HashMap::new();
        let mut open = None;
        let mut escaped = false;
        for (i, byte) in text.bytes().enumerate() {
            match (open, byte) {
                (None, b'"') => open = Some(i),
                (None, _) => {}
                (Some(_), _) if escaped => escaped = false,
                (Some(_), b'\\') => escaped = true,
                (Some(start), b'"') => {
                    if let Some(string) = text.get(start + 1..i) {
                        at.entry(string).or_default().push(start);
                    }
                    open = None;
                }
                (Some(_), _) => {}
            }
        }
        JsonStrings {
            at,
            lines: LineStarts::new(text),
        }
    }

    /// Where `string` first opens.
    pub(crate) fn first(&self, string: &str) -> Option<usize> {
        self.at.get(string).and_then(|at| at.first()).copied()
    }

    /// The line where `string` first opens at or after `from`.
    pub(crate) fn line_after(&self, from: usize, string: &str) -> Option<u32> {
        let at = self.at.get(string)?;
        let found = at.get(at.partition_point(|opens| *opens < from))?;
        Some(self.lines.line_at(*found))
    }
}

/// Whether a module is in `dir` or below it.
pub(crate) fn is_within(module: &str, dir: &str) -> bool {
    dir == "."
        || module == dir
        || module
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// What a detector notes when the fact limit stopped it.
const FACTS_NOTE: &str =
    "This project declares more dependencies than Habi records, so some were not looked at.";

/// A version that long is not one; what follows from it is not established.
/// A manifest's version can be a URL, and a URL can carry a token: what is kept
/// is what could be shown to anyone. Redaction comes first: cut short, a URL no
/// longer looks like one that holds a credential.
fn bounded_version(mut version: VersionInfo) -> VersionInfo {
    version.declared = version.declared.map(|d| redact(&d));
    version.resolved = version.resolved.map(|r| redact(&r));
    version.note = version.note.map(|n| redact(&n));
    let long = |text: &Option<String>| text.as_ref().is_some_and(|t| t.len() > MAX_TEXT);
    if long(&version.declared) || long(&version.resolved) {
        version.state = VersionState::Unresolved;
        version.resolved = None;
        version.declared = version.declared.map(|d| clip(&d, MAX_TEXT).to_string());
        version.note = Some("the declared version is too long to be read".into());
    }
    version.note = version.note.map(|n| clip(&n, MAX_TEXT).to_string());
    version
}

/// Accumulates facts and coverage while detectors run.
#[derive(Default)]
pub struct Collector {
    pub facts: Vec<Fact>,
    pub coverage: Vec<Coverage>,
    file_notes: Vec<String>,
    /// Content-probe candidates per module that were not read (limit or
    /// read error).
    pub content_skipped: BTreeMap<String, u32>,
    /// Positions by fact id, and by module and area: every detector looks
    /// these up once per declaration, and a manifest can hold 100,000.
    fact_at: HashMap<String, usize>,
    coverage_at: HashMap<(String, String), usize>,
    /// Notes left out, by position in `coverage`.
    notes_left_out: HashMap<usize, usize>,
    cancel: Option<CancelToken>,
}

impl Collector {
    /// Whether a detector should give up on what is left: the person cancelled,
    /// or there is no room for more facts.
    pub(crate) fn stopped(&self) -> bool {
        self.facts.len() >= MAX_FACTS || self.cancel.as_ref().is_some_and(CancelToken::is_cancelled)
    }

    fn push_or_merge(&mut self, fact: Fact) -> String {
        let at = self.fact_at.get(&fact.id).copied();
        if let Some(existing) = at.and_then(|at| self.facts.get_mut(at)) {
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
                if existing.derived_from.len() < MAX_DERIVED_FROM
                    && !existing.derived_from.contains(&d)
                {
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
        self.fact_at.insert(id.clone(), self.facts.len());
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
        mut evidence: Evidence,
    ) -> String {
        let area = ecosystem.label().to_lowercase();
        // Left out, and said to be: absence stops being established.
        if self.facts.len() >= MAX_FACTS {
            self.coverage(
                module,
                &area,
                CoverageStatus::Partial,
                vec![FACTS_NOTE.into()],
            );
            return String::new();
        }
        if name.len() > MAX_NAME {
            self.coverage(
                module,
                &area,
                CoverageStatus::Partial,
                vec![format!(
                    "A dependency name in {} is too long to be read.",
                    evidence.file
                )],
            );
            return String::new();
        }
        // A URL read as a coordinate: split at its colons, a password in it would
        // read as a version, past what any redaction can recognise.
        if name.contains("://") {
            self.coverage(
                module,
                &area,
                CoverageStatus::Partial,
                vec![format!(
                    "A dependency in {} is given as a URL and was not read.",
                    evidence.file
                )],
            );
            return String::new();
        }
        evidence.excerpt = evidence
            .excerpt
            .map(|e| clip(&redact(&e), MAX_TEXT).to_string());
        let redacted_name = redact(name);
        let name = redacted_name.as_str();
        let id = format!("dep:{module}:{area}:{name}");
        self.push_or_merge(Fact {
            id,
            module: module.to_string(),
            subject: FactSubject::Dependency {
                ecosystem,
                name: name.to_string(),
                scope: scope.map(|s| clip(&redact(&s), MAX_TEXT).to_string()),
                version: bounded_version(version),
            },
            origin,
            detector: detector.to_string(),
            evidence: vec![evidence],
            derived_from: Vec::new(),
            note: None,
            incidental: false,
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
            incidental: false,
        });
    }

    /// Adds (or extends) a derived tag in `module` based on fact `from`.
    pub fn tag(&mut self, module: &str, tag: &str, from: &str) {
        let evidence = self
            .fact_at
            .get(from)
            .and_then(|at| self.facts.get(*at))
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
            incidental: false,
        });
    }

    pub fn language(
        &mut self,
        module: &str,
        tag: &str,
        example: &str,
        count: u32,
        incidental: bool,
    ) {
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
            incidental,
        });
    }

    pub fn coverage(
        &mut self,
        module: &str,
        area: &str,
        status: CoverageStatus,
        notes: Vec<String>,
    ) {
        let key = (module.to_string(), area.to_string());
        let at = match self.coverage_at.get(&key) {
            Some(at) => *at,
            None => {
                self.coverage_at.insert(key, self.coverage.len());
                self.coverage.push(Coverage {
                    module: module.to_string(),
                    area: area.to_string(),
                    status,
                    notes: Vec::new(),
                });
                self.coverage.len() - 1
            }
        };
        let Some(entry) = self.coverage.get_mut(at) else {
            return;
        };
        // Keep the weakest status.
        let rank = |s: CoverageStatus| match s {
            CoverageStatus::Complete => 0,
            CoverageStatus::Partial => 1,
            CoverageStatus::Failed => 2,
        };
        if rank(status) > rank(entry.status) {
            entry.status = status;
        }
        for note in notes {
            let note = redact(&note);
            let note = if note.len() > MAX_NOTE {
                clip(&note, MAX_NOTE).to_string()
            } else {
                note
            };
            if entry.notes.contains(&note) {
                continue;
            }
            if entry.notes.len() < MAX_NOTES {
                entry.notes.push(note);
                continue;
            }
            // Past the limit one last note says how many more there were.
            let left_out = self.notes_left_out.entry(at).or_insert(0);
            if *left_out > 0 {
                entry.notes.pop();
            }
            *left_out += 1;
            entry.notes.push(format!("and {left_out} more"));
        }
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

/// Reads manifests and lockfiles against `MANIFEST_BUDGET`, adding each one read
/// to the fingerprint.
struct ManifestReader<'a> {
    root: &'a Path,
    sizes: HashMap<&'a str, u64>,
    left: u64,
    fingerprint: Vec<(String, String)>,
}

enum Unread {
    /// The budget ran out. The file may be fine; it was not looked at.
    Spent(String),
    Failed(String),
}

impl ManifestReader<'_> {
    fn read(&mut self, rel: &str, limit: u64) -> std::result::Result<String, Unread> {
        // A file above its own limit is refused unread, and costs nothing.
        let size = self.sizes.get(rel).copied().unwrap_or(0);
        if size <= limit && size > self.left {
            return Err(Unread::Spent(format!(
                "{rel} was not read: Habi reads a limited amount of manifests in one inspection, and this project's went past it."
            )));
        }
        let text = read_text(self.root, rel, limit).map_err(Unread::Failed)?;
        self.left = self.left.saturating_sub(text.len() as u64);
        self.fingerprint
            .push((rel.to_string(), sha256(text.as_bytes())));
        Ok(text)
    }

    /// A manifest's text. One that is not read marks its module's `area`: it
    /// may declare anything.
    fn manifest(
        &mut self,
        rel: &str,
        area: &str,
        out: &mut Collector,
        report: &mut ScanReport,
    ) -> Option<String> {
        match self.read(rel, MANIFEST_LIMIT) {
            Ok(text) => Some(text),
            Err(Unread::Spent(note)) => {
                out.coverage(
                    &python::module_dir(rel),
                    area,
                    CoverageStatus::Partial,
                    vec![note],
                );
                None
            }
            Err(Unread::Failed(note)) => {
                if report.unreadable.len() < 100 {
                    report.unreadable.push(rel.to_string());
                }
                out.coverage(
                    &python::module_dir(rel),
                    area,
                    CoverageStatus::Failed,
                    vec![note],
                );
                None
            }
        }
    }

    /// A lockfile's text. One that cannot be read leaves versions unpinned,
    /// which versions already say; one the budget refused marks `area` too.
    fn lockfile(&mut self, rel: &str, area: &str, out: &mut Collector) -> Option<String> {
        match self.read(rel, LOCKFILE_LIMIT) {
            Ok(text) => Some(text),
            Err(Unread::Spent(note)) => {
                out.coverage(&dir_of(rel), area, CoverageStatus::Partial, vec![note]);
                None
            }
            Err(Unread::Failed(note)) => {
                not_pinned(rel, area, note, out);
                None
            }
        }
    }
}

fn not_pinned(rel: &str, area: &str, why: String, out: &mut Collector) {
    out.coverage(
        &dir_of(rel),
        area,
        CoverageStatus::Complete,
        vec![format!("Versions not pinned: {why}")],
    );
}

pub fn inspect(
    root: &Path,
    options: &WalkOptions,
    cancel: &CancelToken,
) -> Result<ProjectInspection> {
    inspect_within(root, options, cancel, MANIFEST_BUDGET)
}

/// `inspect`, reading at most `budget` bytes of manifests and lockfiles.
fn inspect_within(
    root: &Path,
    options: &WalkOptions,
    cancel: &CancelToken,
    budget: u64,
) -> Result<ProjectInspection> {
    let root = crate::paths::canonical_dir(root)?;
    let walked = walk::walk(&root, options, cancel)?;
    let files = walked.files;
    let walked_dirs = walked.dirs;
    let walk_errors = walked.errors;
    let ignore_gaps = walked.ignore_gaps;
    let mut report = walked.report;
    let mut out = Collector {
        cancel: Some(cancel.clone()),
        ..Default::default()
    };
    let mut reader = ManifestReader {
        root: &root,
        sizes: files.iter().map(|(p, size)| (p.as_str(), *size)).collect(),
        left: budget,
        fingerprint: Vec::new(),
    };

    // Paths by file name, built once: looked up for every manifest kind.
    // A test's sample project is not a module of this one.
    let mut by_name: HashMap<&str, Vec<&str>> = HashMap::new();
    for (p, _) in files.iter().filter(|(p, _)| !files::in_fixture(p)) {
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
        .filter(|p| !gradle::in_convention_build(p))
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
        .filter(|(n, _)| n.ends_with(".txt"))
        .flat_map(|(_, paths)| paths.iter().map(|p| p.to_string()))
        .filter(|p| python::is_requirements_file(p))
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
                .entry(python::module_dir(p))
                .or_default()
                .insert(ecosystem);
        }
    }
    // Past the limit the shallowest modules stay. A manifest of a module that
    // was dropped is not read, and the scan says it stopped early.
    let capped = module_ecosystems.len() > MAX_MODULES;
    if capped {
        let mut ids: Vec<String> = module_ecosystems.keys().cloned().collect();
        ids.sort_by_key(|id| (id.matches('/').count(), id.clone()));
        for id in ids.iter().skip(MAX_MODULES) {
            module_ecosystems.remove(id);
        }
        report.truncated = true;
        report.limits_hit.push(format!(
            "only the first {MAX_MODULES} modules were read; what the others declare is not established"
        ));
    }
    let kept = |paths: Vec<String>| -> Vec<String> {
        paths
            .into_iter()
            .filter(|p| !capped || module_ecosystems.contains_key(&python::module_dir(p)))
            .collect()
    };
    let poms = kept(poms);
    let gradle_builds = kept(gradle_builds);
    let package_jsons = kept(package_jsons);
    let go_mods = kept(go_mods);
    let cargo_tomls = kept(cargo_tomls);
    let composer_jsons = kept(composer_jsons);
    let pyprojects = kept(pyprojects);
    let pipfiles = kept(pipfiles);
    let requirement_files = kept(requirement_files);
    let setup_pys = kept(setup_pys);
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
        let Some(text) = reader.manifest(p, "maven", &mut out, &mut report) else {
            continue;
        };
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
    cancel.check()?;
    maven::collect(&parsed_poms, &mut out);

    // Gradle. A repository can hold several builds side by side (`backend/`
    // beside `frontend/`): each has its own settings, catalog and conventions.
    let settings_files: Vec<String> = names("settings.gradle")
        .into_iter()
        .chain(names("settings.gradle.kts"))
        .filter(|p| !gradle::in_convention_build(p))
        .collect();
    let catalog_files: Vec<String> = names("libs.versions.toml")
        .into_iter()
        .filter(|p| p == "gradle/libs.versions.toml" || p.ends_with("/gradle/libs.versions.toml"))
        .filter(|p| !gradle::in_convention_build(p))
        .collect();
    let mut gradle_roots: BTreeSet<String> = settings_files.iter().map(|p| dir_of(p)).collect();
    gradle_roots.extend(catalog_files.iter().map(|p| {
        p.strip_suffix("/gradle/libs.versions.toml")
            .unwrap_or(".")
            .to_string()
    }));
    gradle_roots.insert(".".to_string());
    let root_of = |module: &str| -> String {
        gradle_roots
            .iter()
            .filter(|root| is_within(module, root))
            .max_by_key(|root| if *root == "." { 0 } else { root.len() })
            .cloned()
            .unwrap_or_else(|| ".".to_string())
    };
    let mut parsed_gradle: BTreeMap<String, Vec<gradle::GradleBuild>> = BTreeMap::new();
    for p in &gradle_builds {
        cancel.check()?;
        let module = dir_of(p);
        if let Some(text) = reader.manifest(p, "gradle", &mut out, &mut report) {
            parsed_gradle
                .entry(root_of(&module))
                .or_default()
                .push(gradle::parse_build(p, &module, &text));
        }
    }
    cancel.check()?;
    for (build_root, builds) in &parsed_gradle {
        let here = |p: &String| root_of(&dir_of(p)) == *build_root;
        let settings = settings_files
            .iter()
            .find(|p| dir_of(p) == *build_root && here(p))
            .and_then(|p| {
                let text = reader.read(p, MANIFEST_LIMIT).ok()?;
                Some(gradle::parse_settings(p, &text))
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
        let catalog_path = gradle::catalog_path(build_root);
        let catalog = if catalog_files.contains(&catalog_path) {
            match reader.read(&catalog_path, MANIFEST_LIMIT) {
                Ok(text) => match gradle::parse_catalog(&catalog_path, &text) {
                    Ok(c) => Some(c),
                    Err(e) => {
                        out.coverage(build_root, "gradle", CoverageStatus::Partial, vec![e]);
                        None
                    }
                },
                Err(_) => None,
            }
        } else {
            None
        };
        let has_convention_sources = files
            .iter()
            .any(|(p, _)| gradle::is_convention_source(p, build_root))
            || settings
                .as_ref()
                .is_some_and(|s| s.notes.iter().any(|n| n.contains("Included builds")));
        gradle::collect(
            builds,
            build_root,
            catalog.as_ref(),
            settings.as_ref(),
            has_convention_sources,
            &mut out,
        );
    }

    // npm.
    let mut packages = Vec::new();
    for p in &package_jsons {
        cancel.check()?;
        let module = dir_of(p);
        let Some(text) = reader.manifest(p, "npm", &mut out, &mut report) else {
            continue;
        };
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
    let mut locks = Vec::new();
    let lockfiles = kept(
        names("package-lock.json")
            .into_iter()
            .chain(names("pnpm-lock.yaml"))
            .collect(),
    );
    for p in &lockfiles {
        cancel.check()?;
        let dir = dir_of(p);
        // Lockfile contents decide resolved versions, so they are part of the
        // fingerprint (a version bump keeps the size more often than not).
        let Some(text) = reader.lockfile(p, "npm", &mut out) else {
            continue;
        };
        let parsed = if p.ends_with("pnpm-lock.yaml") {
            npm::parse_pnpm_lock(p, &dir, &text)
        } else {
            npm::parse_package_lock(p, &dir, &text)
        };
        match parsed {
            Ok(l) => locks.push(l),
            Err(e) => not_pinned(p, "npm", e, &mut out),
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
    let mut go = Vec::new();
    for p in &go_mods {
        cancel.check()?;
        if let Some(text) = reader.manifest(p, "go", &mut out, &mut report) {
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
        if let Some(text) = reader.manifest(p, "cargo", &mut out, &mut report) {
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
    let mut cargo_locks = Vec::new();
    for p in &kept(names("Cargo.lock")) {
        cancel.check()?;
        if let Some(text) = reader.lockfile(p, "cargo", &mut out) {
            match cargo::parse_lock(p, &text) {
                Ok(lock) => cargo_locks.push(lock),
                Err(e) => not_pinned(p, "cargo", e, &mut out),
            }
        }
    }
    cargo::collect(&crates, &cargo_locks, &mut out);

    let mut python_manifests = Vec::new();
    for p in pyprojects.iter().chain(&pipfiles).chain(&requirement_files) {
        cancel.check()?;
        let module = python::module_dir(p);
        let Some(text) = reader.manifest(p, "pypi", &mut out, &mut report) else {
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
    let mut python_locks = Vec::new();
    let python_lockfiles = names("uv.lock")
        .into_iter()
        .chain(names("poetry.lock"))
        .chain(names("Pipfile.lock"))
        .collect();
    for p in &kept(python_lockfiles) {
        cancel.check()?;
        if let Some(text) = reader.lockfile(p, "pypi", &mut out) {
            match python::parse_lock(p, &text) {
                Ok(lock) => python_locks.push(lock),
                Err(e) => not_pinned(p, "pypi", e, &mut out),
            }
        }
    }
    python::collect(&python_manifests, &python_locks, &mut out);
    // A `setup.py` makes a Python module, but what it declares is only known by
    // running it. The module's dependencies are therefore never all seen.
    for p in &setup_pys {
        out.coverage(
            &dir_of(p),
            "pypi",
            CoverageStatus::Partial,
            vec![format!(
                "{p} is a program and is not run, so the dependencies it declares are not established."
            )],
        );
    }

    let mut composers = Vec::new();
    for p in &composer_jsons {
        cancel.check()?;
        if let Some(text) = reader.manifest(p, "composer", &mut out, &mut report) {
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
    let mut composer_locks = Vec::new();
    for p in &kept(names("composer.lock")) {
        cancel.check()?;
        if let Some(text) = reader.lockfile(p, "composer", &mut out) {
            match composer::parse_lock(p, &text) {
                Ok(lock) => composer_locks.push(lock),
                Err(e) => not_pinned(p, "composer", e, &mut out),
            }
        }
    }
    composer::collect(&composers, &composer_locks, &mut out);

    // Recognized files and derived tags.
    cancel.check()?;
    files::collect(&root, &files, &mut out, &module_of);
    cancel.check()?;
    tags::derive(&mut out, &files, &module_of, &module_ecosystems);

    // File coverage per module: the listing is incomplete when a traversal
    // limit stopped the walk or some directories could not be read.
    let mut file_notes = std::mem::take(&mut out.file_notes);
    if report.truncated {
        file_notes.extend(report.limits_hit.iter().cloned());
    }
    file_notes.extend(ignore_gaps);
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
                Some(lookup.parent(id).to_string())
            };
            let name = module_names.get(id).map(|n| redact(n)).unwrap_or_else(|| {
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
    watched.extend(catalog_files.iter().cloned());
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
    let mut fingerprint_parts = reader.fingerprint;
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
    // What the authors wrote is shown as written, short of a credential in it.
    let description = describe::describe(&root, &name, &files).map(|d| redact(&d));

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
    fn an_installed_skills_scripts_and_instructions_say_nothing_about_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(".claude/skills/debug");
        std::fs::create_dir_all(skill.join("scripts")).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: debug\n---\n").unwrap();
        std::fs::write(skill.join("scripts/loop.py"), "print(1)\n").unwrap();
        std::fs::write(skill.join("AGENTS.md"), "# Notes\n").unwrap();
        std::fs::write(dir.path().join("main.go"), "package main\n").unwrap();
        let i = inspect(dir.path(), &WalkOptions::default(), &CancelToken::new()).unwrap();
        let tags: Vec<&str> = i.facts.iter().filter_map(|f| f.tag()).collect();
        assert!(tags.contains(&"lang:go"), "{tags:?}");
        assert!(tags.contains(&"agents:skills"), "{tags:?}");
        assert!(!tags.contains(&"lang:python"), "{tags:?}");
        assert!(!tags.contains(&"agents:agents-md"), "{tags:?}");
    }

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
        for i in 0..files::MAX_CONTENT_CHECKS + 50 {
            std::fs::write(dir.path().join(format!("data/f{i:05}.json")), "{}").unwrap();
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
    fn manifests_past_the_budget_are_not_read_and_coverage_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let write = |path: &str, text: &str| {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let manifest = r#"{"dependencies":{"react":"^18.2.0"}}"#;
        write("a/package.json", manifest);
        write("b/package.json", manifest);
        let budget = manifest.len() as u64 + 1;
        let i = inspect_within(
            dir.path(),
            &WalkOptions::default(),
            &CancelToken::new(),
            budget,
        )
        .unwrap();
        assert_eq!(coverage_of(&i, "a", "npm"), CoverageStatus::Complete);
        assert_eq!(coverage_of(&i, "b", "npm"), CoverageStatus::Partial);
        assert!(i.fact("dep:a:npm:react").is_some());
        assert!(i.fact("dep:b:npm:react").is_none());
        // Not read is not unreadable: the file may be fine.
        assert!(i.scan.unreadable.is_empty(), "{:?}", i.scan.unreadable);

        // Lockfiles draw on the same budget, and what they would pin stays open.
        write("a/package-lock.json", r#"{"packages":{}}"#);
        let i = inspect_within(
            dir.path(),
            &WalkOptions::default(),
            &CancelToken::new(),
            manifest.len() as u64 * 2,
        )
        .unwrap();
        assert_eq!(coverage_of(&i, "a", "npm"), CoverageStatus::Partial);
        assert_eq!(coverage_of(&i, "b", "npm"), CoverageStatus::Complete);
    }

    #[test]
    fn past_the_fact_limit_a_dependency_is_left_out_and_coverage_says_so() {
        let mut out = Collector::default();
        let add = |out: &mut Collector, module: &str, name: &str| {
            out.dependency(
                module,
                Ecosystem::Npm,
                name,
                None,
                VersionInfo {
                    state: VersionState::Range,
                    declared: None,
                    resolved: None,
                    note: None,
                },
                FactOrigin::Direct,
                "test",
                Evidence {
                    file: "package.json".into(),
                    line: None,
                    excerpt: None,
                },
            );
        };
        for i in 0..MAX_FACTS {
            add(&mut out, "a", &i.to_string());
        }
        assert!(out.coverage.is_empty());
        assert!(out.stopped());
        add(&mut out, "b", "one-too-many");
        assert_eq!(out.facts.len(), MAX_FACTS);
        assert_eq!(
            out.coverage_status("b", "npm"),
            Some(CoverageStatus::Partial)
        );
    }

    #[test]
    fn overlong_names_and_versions_are_refused_not_copied() {
        let mut out = Collector::default();
        let evidence = || Evidence {
            file: "pom.xml".into(),
            line: None,
            excerpt: Some("x".repeat(100_000)),
        };
        let version = |v: &str| VersionInfo {
            state: VersionState::Resolved,
            declared: Some(v.to_string()),
            resolved: Some(v.to_string()),
            note: None,
        };
        out.dependency(
            ".",
            Ecosystem::Maven,
            &"n".repeat(100_000),
            None,
            version("1"),
            FactOrigin::Direct,
            "test",
            evidence(),
        );
        assert!(out.facts.is_empty());
        assert_eq!(
            out.coverage_status(".", "maven"),
            Some(CoverageStatus::Partial)
        );

        out.dependency(
            ".",
            Ecosystem::Maven,
            "g:a",
            Some("s".repeat(100_000)),
            version(&"9".repeat(100_000)),
            FactOrigin::Direct,
            "test",
            evidence(),
        );
        let found = out.find_dependency(".", "g:a").unwrap();
        // A version cut short would read as another version.
        assert_eq!(found.state, VersionState::Unresolved);
        assert_eq!(found.resolved, None);
        assert!(serde_json::to_string(&out.facts).unwrap().len() < 4096);
    }

    #[test]
    fn coverage_notes_are_capped_and_the_rest_counted() {
        let mut out = Collector::default();
        for i in 0..1000 {
            out.coverage(
                ".",
                "gradle",
                CoverageStatus::Partial,
                vec![format!("line {i}: something")],
            );
        }
        // A repeat takes no room.
        out.coverage(
            ".",
            "gradle",
            CoverageStatus::Partial,
            vec!["line 0: something".into()],
        );
        out.coverage(
            ".",
            "gradle",
            CoverageStatus::Partial,
            vec!["x".repeat(MAX_NOTE * 4)],
        );
        let notes = &out.coverage[0].notes;
        assert_eq!(notes.len(), MAX_NOTES + 1);
        assert_eq!(notes.last().unwrap(), "and 981 more");
        assert!(notes.iter().all(|n| n.len() <= MAX_NOTE));
    }

    #[test]
    fn detectors_stop_once_cancelled() {
        let cancel = CancelToken::new();
        cancel.cancel();
        let mut out = Collector {
            cancel: Some(cancel),
            ..Default::default()
        };
        let pom = maven::parse(
            "pom.xml",
            ".",
            "<project><artifactId>a</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency></dependencies></project>",
        )
        .unwrap();
        maven::collect(&[pom], &mut out);
        let build = gradle::parse_build(
            "build.gradle",
            ".",
            "dependencies { implementation 'g:b:1' }\n",
        );
        gradle::collect(&[build], ".", None, None, false, &mut out);
        assert!(out.facts.is_empty());
    }

    #[test]
    fn line_starts_and_json_strings_find_what_a_scan_would() {
        let lines = LineStarts::new("a\nbb\n\nc");
        let offsets: Vec<u32> = (0..7).map(|at| lines.line_at(at)).collect();
        assert_eq!(offsets, vec![1, 1, 2, 2, 2, 3, 4]);

        let text = "{\n \"a\": \"x\\\"y\",\n \"deps\": {\n  \"a\": 1\n }\n}\n";
        let strings = JsonStrings::new(text);
        assert_eq!(strings.line_after(0, "a"), Some(2));
        let deps = strings.first("deps").unwrap();
        assert_eq!(strings.line_after(deps, "a"), Some(4));
        assert_eq!(strings.line_after(deps, "deps"), Some(3));
        assert_eq!(strings.line_after(deps, "absent"), None);
        // An escaped quote does not end a string.
        assert_eq!(strings.line_after(0, "y"), None);
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
