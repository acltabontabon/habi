//! The inspection result: what Habi knows about a project, and how it knows.
//!
//! Every `Fact` carries provenance (which detector produced it, from which
//! file and line) and every module carries `Coverage` describing whether the
//! evidence for an ecosystem is complete. Matching relies on coverage to tell
//! "confirmed absent" apart from "not established".

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Ecosystem {
    Maven,
    Gradle,
    Npm,
}

impl Ecosystem {
    pub fn label(self) -> &'static str {
        match self {
            Ecosystem::Maven => "Maven",
            Ecosystem::Gradle => "Gradle",
            Ecosystem::Npm => "npm",
        }
    }

    pub fn is_jvm(self) -> bool {
        matches!(self, Ecosystem::Maven | Ecosystem::Gradle)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RepositoryKind {
    /// A Git repository whose root is the selected directory.
    Git,
    /// A linked Git worktree (`.git` is a file pointing elsewhere).
    Worktree,
    /// The selected directory is inside a Git repository but is not its root.
    GitSubdirectory,
    /// No Git metadata was found.
    Plain,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepositoryInfo {
    pub kind: RepositoryKind,
    /// Current branch, read from Git metadata files without running Git.
    pub branch: Option<String>,
    /// Display form of the enclosing repository root when it differs from the
    /// selected directory.
    pub repository_root: Option<String>,
    pub is_monorepo: bool,
    /// Workspace tooling that declares multiple packages (npm workspaces,
    /// pnpm, Maven modules, Gradle includes, ...).
    pub workspace_signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Module {
    /// Repository-relative directory, `.` for the root.
    pub id: String,
    pub name: String,
    pub ecosystems: Vec<Ecosystem>,
    /// Enclosing module, if any.
    pub parent: Option<String>,
}

/// Where a fact came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FactOrigin {
    /// Read directly from a manifest or file.
    Direct,
    /// Concluded from other facts (for example a framework from a dependency).
    Derived,
    /// Inherited from a parent build file inside the repository.
    Inherited,
    /// Stated by the user as a correction.
    Declared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VersionState {
    /// A concrete version is established (exact pin, lockfile, resolved property).
    Resolved,
    /// A range is declared (for example `^18.2.0`) but no lockfile pins it.
    Range,
    /// No version is declared here; a parent or BOM manages it.
    Managed,
    /// A version expression could not be resolved statically.
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VersionInfo {
    pub state: VersionState,
    /// What the manifest says, e.g. `${liquibase.version}` or `^18.2.0`.
    pub declared: Option<String>,
    /// The concrete version, when established.
    pub resolved: Option<String>,
    /// Why the version is not resolved, or where it was resolved from.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum FactSubject {
    /// A declared library dependency or build plugin.
    #[serde(rename_all = "camelCase")]
    Dependency {
        ecosystem: Ecosystem,
        /// `group:artifact` for JVM, the package name for npm.
        name: String,
        /// `compile`, `test`, `dev`, `plugin`, ...
        scope: Option<String>,
        version: VersionInfo,
    },
    /// A characteristic such as `framework:spring-boot`.
    #[serde(rename_all = "camelCase")]
    Tag { tag: String },
    /// A file with a recognized role, such as an OpenAPI document.
    #[serde(rename_all = "camelCase")]
    File { path: String, role: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Evidence {
    /// Repository-relative file.
    pub file: String,
    pub line: Option<u32>,
    /// A short, non-sensitive excerpt (a coordinate or key, never file bodies).
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Fact {
    /// Stable within one inspection; used to link explanations to facts.
    pub id: String,
    pub module: String,
    pub subject: FactSubject,
    pub origin: FactOrigin,
    pub detector: String,
    pub evidence: Vec<Evidence>,
    /// Facts this one was derived from.
    pub derived_from: Vec<String>,
    pub note: Option<String>,
}

impl Fact {
    pub fn tag(&self) -> Option<&str> {
        match &self.subject {
            FactSubject::Tag { tag } => Some(tag),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CoverageStatus {
    /// Every declaration of this kind in the module was read.
    Complete,
    /// Some declarations could not be evaluated statically.
    Partial,
    /// The file could not be read or parsed.
    Failed,
}

/// What Habi was able to establish for one evidence area of one module.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Coverage {
    pub module: String,
    /// `maven`, `gradle`, `npm` or `files`.
    pub area: String,
    pub status: CoverageStatus,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanReport {
    pub files_seen: u32,
    pub directories_skipped: Vec<String>,
    /// True if a traversal limit stopped the scan early. File-pattern absence
    /// is then unknown rather than false.
    pub truncated: bool,
    pub limits_hit: Vec<String>,
    pub unreadable: Vec<String>,
    pub symlinks_skipped: u32,
    pub large_files_skipped: u32,
    pub elapsed_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectInspection {
    pub root: String,
    pub name: String,
    pub repository: RepositoryInfo,
    pub modules: Vec<Module>,
    pub facts: Vec<Fact>,
    pub coverage: Vec<Coverage>,
    pub scan: ScanReport,
    /// Changes when any manifest or recognized file changes.
    pub fingerprint: String,
    pub inspected_at: String,
    /// All non-ignored file paths (repository-relative). Used for file-pattern
    /// predicates; not sent to the UI.
    #[serde(skip)]
    #[ts(skip)]
    pub files: Vec<String>,
    /// Facts, coverage and files grouped by module, built once per inspection
    /// and shared by every evaluation against it.
    #[serde(skip)]
    #[ts(skip)]
    pub(crate) index: OnceLock<Arc<ModuleIndex>>,
    /// What to re-check cheaply to tell whether this inspection is out of date.
    #[serde(skip)]
    #[ts(skip)]
    pub(crate) freshness: Option<Arc<Freshness>>,
}

impl ProjectInspection {
    pub fn module(&self, id: &str) -> Option<&Module> {
        self.modules.iter().find(|m| m.id == id)
    }

    pub fn fact(&self, id: &str) -> Option<&Fact> {
        self.facts.iter().find(|f| f.id == id)
    }

    /// The deepest module whose directory contains `path`.
    pub fn owning_module(&self, path: &str) -> String {
        self.index().lookup.owner(path).to_string()
    }

    /// Per-module groupings of facts, coverage and files. Computed on first
    /// use and cached with the inspection (clones share it).
    pub fn index(&self) -> &ModuleIndex {
        self.index
            .get_or_init(|| Arc::new(ModuleIndex::build(self)))
    }

    /// Files owned by module `id` (not by a nested module).
    pub fn module_files(&self, id: &str) -> impl Iterator<Item = &str> {
        self.index()
            .files
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|&i| self.files.get(i as usize).map(String::as_str))
    }

    /// Facts recorded for module `id`.
    pub fn module_facts(&self, id: &str) -> impl Iterator<Item = &Fact> {
        self.index()
            .facts
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|&i| self.facts.get(i as usize))
    }

    /// Coverage recorded for module `id`.
    pub fn module_coverage(&self, id: &str) -> impl Iterator<Item = &Coverage> {
        self.index()
            .coverage
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|&i| self.coverage.get(i as usize))
    }

    /// Enclosing modules of `id`, nearest first, ending with the root.
    pub fn ancestors(&self, id: &str) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        let mut current = self.module(id).and_then(|m| m.parent.as_deref());
        while let Some(p) = current {
            if out.contains(&p) || out.len() > 64 {
                break;
            }
            out.push(p);
            current = self.module(p).and_then(|m| m.parent.as_deref());
        }
        out
    }

    /// True when a cheap re-check of what this inspection depended on
    /// (manifests, lockfiles, directory listings) shows a change since it ran.
    /// An inspection without freshness data is never reported stale.
    pub fn is_stale(&self) -> bool {
        self.freshness.as_ref().is_some_and(|f| f.is_stale())
    }
}

/// Resolves a repository-relative path to the deepest enclosing module in
/// time proportional to the path depth, not to the number of modules.
#[derive(Debug, Default, Clone)]
pub struct ModuleLookup {
    ids: HashSet<String>,
}

impl ModuleLookup {
    pub fn new<'a>(ids: impl IntoIterator<Item = &'a str>) -> Self {
        ModuleLookup {
            ids: ids
                .into_iter()
                .filter(|id| *id != ".")
                .map(str::to_string)
                .collect(),
        }
    }

    /// The deepest module containing `path`, or `.` for the root.
    pub fn owner<'p>(&self, path: &'p str) -> &'p str {
        let mut candidate = path;
        loop {
            if self.ids.contains(candidate) {
                return candidate;
            }
            match candidate.rsplit_once('/') {
                Some((dir, _)) => candidate = dir,
                None => return ".",
            }
        }
    }
}

/// Facts, coverage and files of an inspection grouped by module id (as
/// indices into the inspection's vectors).
#[derive(Debug, Default)]
pub struct ModuleIndex {
    lookup: ModuleLookup,
    files: HashMap<String, Vec<u32>>,
    facts: HashMap<String, Vec<u32>>,
    coverage: HashMap<String, Vec<u32>>,
}

impl ModuleIndex {
    fn build(inspection: &ProjectInspection) -> Self {
        let lookup = ModuleLookup::new(inspection.modules.iter().map(|m| m.id.as_str()));
        let mut files: HashMap<String, Vec<u32>> = HashMap::new();
        for (i, path) in inspection.files.iter().enumerate() {
            let owner = lookup.owner(path);
            match files.get_mut(owner) {
                Some(v) => v.push(i as u32),
                None => {
                    files.insert(owner.to_string(), vec![i as u32]);
                }
            }
        }
        let mut facts: HashMap<String, Vec<u32>> = HashMap::new();
        for (i, f) in inspection.facts.iter().enumerate() {
            facts.entry(f.module.clone()).or_default().push(i as u32);
        }
        let mut coverage: HashMap<String, Vec<u32>> = HashMap::new();
        for (i, c) in inspection.coverage.iter().enumerate() {
            coverage.entry(c.module.clone()).or_default().push(i as u32);
        }
        ModuleIndex {
            lookup,
            files,
            facts,
            coverage,
        }
    }
}

/// Size and modification time of one path, as seen at inspection time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
    is_dir: bool,
}

impl Stamp {
    pub(crate) fn of(path: &Path) -> Option<Stamp> {
        let m = std::fs::symlink_metadata(path).ok()?;
        Some(Stamp {
            // A directory's size is platform noise; its modification time
            // changes when entries are added, removed or renamed.
            size: if m.is_dir() { 0 } else { m.len() },
            modified: m.modified().ok(),
            is_dir: m.is_dir(),
        })
    }
}

/// Paths whose size and modification time are compared to detect that a
/// cached inspection is out of date: build manifests and lockfiles (content
/// edits, branch switches) and the walked directories (files added, removed
/// or renamed).
#[derive(Debug, Default)]
pub(crate) struct Freshness {
    pub(crate) root: PathBuf,
    pub(crate) stamps: Vec<(String, Option<Stamp>)>,
}

impl Freshness {
    pub(crate) fn capture<'a>(root: &Path, paths: impl IntoIterator<Item = &'a str>) -> Self {
        let stamps = paths
            .into_iter()
            .map(|rel| (rel.to_string(), Stamp::of(&Self::full(root, rel))))
            .collect();
        Freshness {
            root: root.to_path_buf(),
            stamps,
        }
    }

    fn full(root: &Path, rel: &str) -> PathBuf {
        if rel == "." {
            root.to_path_buf()
        } else {
            root.join(rel)
        }
    }

    pub(crate) fn is_stale(&self) -> bool {
        self.stamps
            .iter()
            .any(|(rel, stamp)| Stamp::of(&Self::full(&self.root, rel)) != *stamp)
    }
}

pub(crate) fn owning_module<'a>(modules: impl Iterator<Item = &'a str>, path: &str) -> String {
    ModuleLookup::new(modules).owner(path).to_string()
}
