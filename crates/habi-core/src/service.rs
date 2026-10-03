//! The application service: one entry point for the desktop app and the CLI.
//!
//! Both front ends call these methods, so inspection, matching, planning and
//! synchronization rules exist only here. Projects are addressed by id after
//! being opened; plans are kept server-side and applied by id, so a front end
//! never supplies file content or target paths to write.

use crate::cancel::CancelToken;
use crate::checks::{self, CheckPreview, CheckRun};
use crate::clients::ClientId;
use crate::contribute::ShareForm as ApplicabilityForm;
use crate::contribute::{
    Contribution, ContributionOrigin, Contributions, PublishOutcome, ShareForm,
};
use crate::error::ErrorInfo;
use crate::error::{HabiError, Result};
use crate::inspect::model::ProjectInspection;
use crate::inspect::model::{CoverageStatus, FactOrigin, FactSubject};
use crate::inspect::{WalkOptions, inspect};
use crate::install::apply::{Applier, OperationSummary, project_id};
use crate::install::lock::{LockFile, LockedSource};
use crate::install::plan::{self, Decisions, Payload, Plan, read_lock};
use crate::install::status::{self, Installation};
use crate::library::model::{LibraryIndex, LibraryItem};
use crate::matching::condition::Condition;
use crate::matching::eval::{Declaration, DeclaredSubject};
use crate::matching::{Applicability, ApplicabilityResult, Scope, assess};
use crate::recommend::{self, Candidate, Recommendation};
use crate::review::ReviewTools;
use crate::skills::intake::{
    self, ImportInspection, ImportOutcome, ImportSelection, InstructionDocument, Package,
    ProjectKnowledge,
};
use crate::skills::{
    LOCAL_SOURCE_ID, LOCAL_SOURCE_NAME, LocalSkill, NewSkill, SkillOrigin, Skills, Tree,
    TreeLimits, Upstream,
};
use crate::source::{Freshness, Source, SourceKind, Sources, TrackedRef, portable_identity};
use crate::store::{AppPaths, Store};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;
use ts_rs::TS;

/// A project one of My skills is installed in.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledIn {
    pub project_id: String,
    pub project_name: String,
    pub clients: Vec<ClientId>,
    /// Whether the installed copy is the skill as it is now.
    pub current: bool,
}

/// Where one of My skills stands outside its own files.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillStanding {
    pub skill_id: String,
    pub installed_in: Vec<InstalledIn>,
    /// For a library copy: how the library's version compares.
    pub upstream: Option<crate::skills::upstream::UpstreamState>,
}

impl SkillStanding {
    fn new(skill_id: &str) -> Self {
        SkillStanding {
            skill_id: skill_id.to_string(),
            installed_in: Vec::new(),
            upstream: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    /// Display path (home abbreviated).
    pub path: String,
    pub exists: bool,
    pub last_opened_at: String,
    pub exclusions: Vec<String>,
    /// Part of the explicitly labeled sample workspace.
    pub sample: bool,
    /// What fit when the project was last looked at; `None` until then.
    pub summary: Option<ProjectSummary>,
    #[serde(skip)]
    #[ts(skip)]
    pub root: PathBuf,
}

/// What came of choosing a folder to open as a project.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ProjectPick {
    /// Boxed: a record dwarfs the other variant, and more so on Windows,
    /// where `PathBuf` is larger (clippy's `large_enum_variant`). The JSON
    /// and the TypeScript type are the same as unboxed.
    Opened { project: Box<ProjectRecord> },
    /// Skills and no build files: likely a library chosen by mistake.
    /// Nothing was registered.
    Skills {
        /// Full path, as chosen.
        path: String,
        name: String,
        skills: u32,
    },
}

/// A small record of a project's last overview, so lists can say what fits
/// without inspecting every project again.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectSummary {
    /// Items that apply (team requirements included).
    pub fits: u32,
    /// Items whose applicability could not be established.
    pub needs_information: u32,
    /// Libraries those items come from (source ids), most items first.
    pub sources: Vec<String>,
    /// Items installed in the project by Habi.
    pub installed: u32,
    /// Language tags (`lang:rust`), the most used first: the project's colors in lists.
    #[serde(default)]
    pub languages: Vec<String>,
    /// Per library, what it brings to the project: the home page's weave draws a library's
    /// thread solid where something from it is installed, and loose where it only fits.
    #[serde(default)]
    pub tally: Vec<SourceTally>,
    pub at: String,
}

/// One library's part in a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceTally {
    pub source_id: String,
    /// Its items that apply to the project (team requirements included).
    pub fits: u32,
    /// Titles of its items installed in the project, whatever their fit.
    pub installed: Vec<String>,
}

fn summary_key(project_id: &str) -> String {
    format!("project-summary:{project_id}")
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ItemRef {
    pub source_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectOverview {
    pub project: ProjectRecord,
    pub inspection: ProjectInspection,
    pub declarations: Vec<Declaration>,
    pub recommendations: Vec<Recommendation>,
    pub sources: Vec<Source>,
    /// Installed items whose source or item is not available on this machine.
    pub orphaned: Vec<Installation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ItemDetail {
    pub item: LibraryItem,
    pub source: Source,
    pub library_name: Option<String>,
    /// SKILL.md (or instructions) Markdown body, without frontmatter.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileContent {
    pub path: String,
    pub text: Option<String>,
    pub size: u32,
    pub binary: bool,
}

/// Where "Add skills" looks for packages.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum ImportFrom {
    /// Skill folders found in an opened project.
    #[serde(rename_all = "camelCase")]
    Project { project_id: String },
    /// A folder on this machine: one skill, or a folder of skills.
    #[serde(rename_all = "camelCase")]
    Folder { path: String },
    /// Items of a connected team library, to copy for editing.
    #[serde(rename_all = "camelCase")]
    Library { source_id: String },
    /// A Git repository fetched only to copy from (`open_git_copy`): it is
    /// not connected, and is forgotten afterwards.
    #[serde(rename_all = "camelCase")]
    GitCopy { source_id: String },
    /// A skill in one of the person's own skill folders (`~/.claude/skills`
    /// and the like), named by a `MachineSkill` id. Resolved here, so the
    /// webview never supplies a path.
    #[serde(rename_all = "camelCase")]
    Machine { id: String },
}

/// A repository fetched to copy skills from, without connecting it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitCopy {
    pub source_id: String,
    /// The repository, as people say it ("acme/skills").
    pub label: String,
    /// The commit that was read.
    pub snapshot: Option<String>,
}

/// Name prefix of sources fetched only to copy from. Like catalog previews
/// they are hidden, never connected, and discarded by maintenance.
const COPY_PREFIX: &str = "~copy:";

fn is_copy_source(source: &Source) -> bool {
    source.preview && source.name.starts_with(COPY_PREFIX)
}

/// "https://github.com/acme/skills" → "acme/skills".
fn repository_label(source: &Source) -> String {
    if crate::source::is_local_location(&source.location) {
        return source
            .location
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&source.location)
            .trim_end_matches(".git")
            .to_string();
    }
    let identity = portable_identity(source);
    let trimmed = identity
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches(".git");
    trimmed
        .strip_prefix("github.com/")
        .or_else(|| trimmed.strip_prefix("gitlab.com/"))
        .or_else(|| trimmed.strip_prefix("codeberg.org/"))
        .unwrap_or(trimmed)
        .to_string()
}

/// The applicability rules to preview: an unsaved form, unsaved raw
/// metadata, or (with neither) what the skill has stored.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreviewRequest {
    pub skill_id: Option<String>,
    pub form: Option<ApplicabilityForm>,
    pub metadata_text: Option<String>,
    /// Evaluate only this project (otherwise every recent one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectPreview {
    pub project: ProjectRecord,
    /// `None` when the project could not be inspected (see `error`).
    pub result: Option<ApplicabilityResult>,
    pub error: Option<ErrorInfo>,
    pub inspected_at: Option<String>,
    /// Why the inspection is incomplete, if it is. Absence of evidence in an
    /// incomplete inspection is "not established", never "does not apply".
    pub incomplete: Vec<String>,
    /// The tools the rules say the skill needs, looked up here (PATH and the
    /// project; nothing is run). They never change whether it applies.
    pub prerequisites: Vec<recommend::Prerequisite>,
}

/// The rules a preview evaluates, and the tools they say are needed.
struct PreviewRules {
    applies_when: Option<Condition>,
    excludes: Option<Condition>,
    scope: Scope,
    tools: Vec<crate::library::model::ToolRequirement>,
}

impl PreviewRules {
    fn none() -> Self {
        PreviewRules {
            applies_when: None,
            excludes: None,
            scope: Scope::Module,
            tools: Vec::new(),
        }
    }
}

/// `requires.tools` of a habi.yaml value, as far as it is well formed.
fn required_tools(value: &serde_json::Value) -> Vec<crate::library::model::ToolRequirement> {
    let text = |v: &serde_json::Value, key: &str| {
        v.get(key)
            .and_then(|s| s.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };
    value
        .get("requires")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| {
                    Some(crate::library::model::ToolRequirement {
                        name: text(t, "name")?,
                        commands: t
                            .get("commands")
                            .and_then(|c| c.as_array())
                            .map(|c| {
                                c.iter()
                                    .filter_map(|s| s.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        purpose: text(t, "purpose"),
                        install_hint: text(t, "install_hint"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// How the rules being edited evaluate against registered projects. This
/// previews the rules only — not the skill's quality or an agent's behavior.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillPreview {
    pub applies_when: Option<Condition>,
    pub excludes: Option<Condition>,
    pub scope: Scope,
    /// Why the rules could not be evaluated (invalid metadata).
    pub problem: Option<String>,
    pub projects: Vec<ProjectPreview>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SuggestionKind {
    Tag,
    Dependency,
}

/// For reviewers: where a contribution's rules apply among the author's own
/// projects (sample projects are not counted). Plain text, inserted into the
/// message only when the author chooses; it names projects, never paths.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Rehearsal {
    /// Empty when there was nothing to check against.
    pub text: String,
    /// Projects the rules were evaluated against.
    pub projects: u32,
    pub samples_skipped: u32,
}

/// A fact observed in a project that could become a condition. Suggestions
/// are offered one by one; none is applied unless the author adds it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConditionSuggestion {
    pub kind: SuggestionKind,
    pub value: String,
    pub label: String,
    pub module: String,
    /// `file:line` the fact was read from, if any.
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Excerpt {
    pub path: String,
    pub start_line: u32,
    pub lines: Vec<String>,
    pub highlight: Option<u32>,
    pub total_lines: u32,
}

pub struct Habi {
    pub paths: AppPaths,
    pub store: Store,
    sources: Sources,
    plans: Mutex<HashMap<String, Plan>>,
    inspections: Mutex<HashMap<String, ProjectInspection>>,
    /// One inspection walk at a time per project (see `inspect`), each with
    /// when its last walk started.
    inspecting: Mutex<HashMap<String, Arc<Mutex<Option<Instant>>>>>,
    check_previews: Mutex<HashMap<String, StoredCheck>>,
    /// `gh`/`glab` for review requests; tests point these at stand-ins.
    pub review_tools: ReviewTools,
    /// The person's home folder, where their own skill folders are read.
    user_home: PathBuf,
}

/// A check preview the user has seen; running requires its id.
struct StoredCheck {
    project: String,
    module: String,
    bindings: HashMap<String, String>,
    preview: CheckPreview,
}

impl Habi {
    pub fn open(paths: AppPaths) -> Result<Habi> {
        paths.ensure()?;
        let store = Store::open(&paths.db())?;
        let sources = Sources::new(&paths, &store);
        // Sample libraries created before libraries carried a sample flag.
        if let Err(e) = sources.mark_samples_under(&crate::sample::root(&paths)) {
            tracing::warn!(error = %e, "could not mark the sample libraries");
        }
        // Snapshots fetched before item counts were recorded.
        if let Err(e) = sources.count_uncounted() {
            tracing::warn!(error = %e, "could not count library items");
        }
        // `gh`/`glab` run in an empty folder of Habi's own, never in whatever
        // repository Habi was started from.
        let review_tools = ReviewTools {
            cwd: Some(paths.empty_dir()),
            ..ReviewTools::from_path()
        };
        Ok(Habi {
            paths,
            store,
            sources,
            plans: Mutex::new(HashMap::new()),
            inspections: Mutex::new(HashMap::new()),
            inspecting: Mutex::new(HashMap::new()),
            check_previews: Mutex::new(HashMap::new()),
            review_tools,
            user_home: directories::BaseDirs::new()
                .map(|b| b.home_dir().to_path_buf())
                .unwrap_or_default(),
        })
    }

    /// Reads the person's own skill folders under `home` instead of the real
    /// home folder (tests use this so they never look at the real one).
    #[must_use]
    pub fn with_user_home(mut self, home: PathBuf) -> Habi {
        self.user_home = home;
        self
    }

    pub fn from_env() -> Result<Habi> {
        Habi::open(AppPaths::from_env()?)
    }

    pub fn sources(&self) -> &Sources {
        &self.sources
    }

    fn applier(&self) -> Applier<'_> {
        Applier {
            paths: &self.paths,
            store: &self.store,
        }
    }

    // ----- projects ---------------------------------------------------------

    /// A folder the user just chose: opened as a project, unless it holds
    /// skills and no build files — then nothing is registered, so the UI can
    /// offer to connect it as a library instead.
    pub fn pick_project(&self, path: &Path) -> Result<ProjectPick> {
        let root = crate::paths::canonical_dir(path)?;
        let shape = crate::inspect::walk::folder_shape(&root);
        if shape.is_skills() {
            return Ok(ProjectPick::Skills {
                path: root.to_string_lossy().into_owned(),
                name: root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "folder".into()),
                skills: shape.skills,
            });
        }
        self.open_project(&root).map(|project| ProjectPick::Opened {
            project: Box::new(project),
        })
    }

    /// Registers (or re-opens) a project directory and returns its record.
    pub fn open_project(&self, path: &Path) -> Result<ProjectRecord> {
        let root = crate::paths::canonical_dir(path)?;
        let id = project_id(&root);
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".into());
        self.store.conn()?.execute(
            "INSERT INTO projects (id, path, name, last_opened_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET last_opened_at = excluded.last_opened_at, name = excluded.name",
            params![id, root.to_string_lossy(), name, crate::time::now()],
        )?;
        self.project(&id)
    }

    /// The registered project at `path`, if there is one. Unlike
    /// `open_project`, this never registers the folder.
    pub fn find_project(&self, path: &Path) -> Result<Option<ProjectRecord>> {
        let Ok(root) = crate::paths::canonical(path) else {
            return Ok(None);
        };
        match self.project(&project_id(&root)) {
            Ok(p) => Ok(Some(p)),
            Err(HabiError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn project(&self, id: &str) -> Result<ProjectRecord> {
        let conn = self.store.conn()?;
        let sample_root = crate::sample::root(&self.paths);
        let (mut record, exclusions) = conn
            .query_row(
                "SELECT id, path, name, last_opened_at, exclusions_json FROM projects WHERE id = ?1",
                [id],
                |r| {
                    let path: String = r.get(1)?;
                    let root = PathBuf::from(&path);
                    Ok((
                        ProjectRecord {
                            summary: None,
                            sample: root.starts_with(&sample_root),
                            id: r.get(0)?,
                            name: r.get(2)?,
                            path: crate::paths::display_path(&root),
                            exists: root.is_dir(),
                            last_opened_at: r.get(3)?,
                            exclusions: Vec::new(),
                            root,
                        },
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| HabiError::NotFound(format!("project {id}")))?;
        // Read as "no exclusions", a damaged list would let the next scan
        // into folders the user excluded.
        record.exclusions = serde_json::from_str(&exclusions).map_err(|e| {
            HabiError::Conflict(format!(
                "the folders excluded from scanning in {} could not be read ({e}); set them again",
                record.name
            ))
        })?;
        record.summary = self
            .store
            .setting(&summary_key(id))
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok());
        Ok(record)
    }

    fn existing_project(&self, id: &str) -> Result<ProjectRecord> {
        let p = self.project(id)?;
        if !p.exists {
            return Err(HabiError::NotFound(format!(
                "the project folder {} (it was moved or deleted)",
                p.path
            )));
        }
        Ok(p)
    }

    pub fn recent_projects(&self) -> Result<Vec<ProjectRecord>> {
        let ids: Vec<String> = {
            let conn = self.store.conn()?;
            let mut stmt =
                conn.prepare("SELECT id FROM projects ORDER BY last_opened_at DESC LIMIT 20")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        ids.iter().map(|id| self.project(id)).collect()
    }

    pub fn forget_project(&self, id: &str) -> Result<()> {
        self.store
            .conn()?
            .execute("DELETE FROM projects WHERE id = ?1", [id])?;
        self.store
            .conn()?
            .execute("DELETE FROM settings WHERE key = ?1", [summary_key(id)])?;
        self.inspections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        Ok(())
    }

    pub fn set_exclusions(&self, id: &str, exclusions: Vec<String>) -> Result<ProjectRecord> {
        for e in &exclusions {
            if e.len() > 256 || e.starts_with('/') || e.contains("..") {
                return Err(HabiError::invalid(format!("invalid exclusion `{e}`")));
            }
            globset::Glob::new(e)
                .map_err(|err| HabiError::invalid(format!("invalid exclusion `{e}`: {err}")))?;
        }
        self.store.conn()?.execute(
            "UPDATE projects SET exclusions_json = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(&exclusions).unwrap_or_default()],
        )?;
        self.inspections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        self.project(id)
    }

    /// A few lines of a project file around `line`, for evidence. Refuses
    /// files that may hold secrets and anything outside the project.
    pub fn project_excerpt(&self, project: &str, path: &str, line: Option<u32>) -> Result<Excerpt> {
        let project = self.project(project)?;
        let rel = crate::paths::RelPath::new(path)?;
        if crate::inspect::walk::is_secret_name(rel.file_name()) {
            return Err(HabiError::invalid(
                "Habi does not display files that may contain secrets",
            ));
        }
        let bytes = plan::read_project_file(&project.root, rel.as_str())?
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))?;
        if !crate::fsutil::is_probably_text(&bytes) {
            return Err(HabiError::invalid("this file is not text"));
        }
        let text = String::from_utf8_lossy(&bytes);
        let all: Vec<&str> = text.lines().collect();
        let center = line.unwrap_or(1).max(1) as usize;
        let (start, end) = match line {
            Some(_) => (
                center.saturating_sub(12).max(1),
                (center + 12).min(all.len()),
            ),
            None => (1, all.len().min(80)),
        };
        let lines = all
            .get(start.saturating_sub(1)..end)
            .unwrap_or_default()
            .iter()
            .map(|l| crate::redact::redact(&l.chars().take(400).collect::<String>()))
            .collect();
        Ok(Excerpt {
            path: rel.to_string(),
            start_line: start as u32,
            lines,
            highlight: line,
            total_lines: all.len() as u32,
        })
    }

    // ----- inspection and declarations ------------------------------------

    pub fn inspect(
        &self,
        id: &str,
        rescan: bool,
        cancel: &CancelToken,
    ) -> Result<ProjectInspection> {
        let asked = Instant::now();
        let cached = || {
            self.inspections
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(id)
                .cloned()
        };
        // Cloned out first: the staleness check reads the file system, and
        // the cache stays available to other threads meanwhile. A cheap
        // re-check (sizes and modification times of manifests, lockfiles and
        // listed directories) catches edits, added or removed files and
        // branch switches since the last scan.
        if !rescan
            && let Some(cached) = cached()
            && !cached.is_stale()
        {
            return Ok(cached);
        }
        // The overview, a plan and the watcher's refresh often ask at once,
        // and each would walk the whole repository. One walks; the others
        // wait for it and take its result, if it is fresh enough for them.
        let gate = self
            .inspecting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(id.to_string())
            .or_default()
            .clone();
        let mut last_walk = gate.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = cached() {
            // A walk that started after this request saw everything this one
            // would; otherwise the cached result must pass the re-check.
            let walked_since = last_walk.is_some_and(|started| started >= asked);
            if walked_since || (!rescan && !cached.is_stale()) {
                return Ok(cached);
            }
        }
        let project = self.existing_project(id)?;
        let options = WalkOptions {
            exclusions: project.exclusions.clone(),
            ..Default::default()
        };
        let started = Instant::now();
        let inspection = inspect(&project.root, &options, cancel)?;
        self.inspections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_string(), inspection.clone());
        *last_walk = Some(started);
        Ok(inspection)
    }

    /// Drops the cached inspection of a project; the next request re-inspects.
    pub fn invalidate_inspection(&self, project: &str) {
        self.inspections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(project);
    }

    /// Invalidates the cached inspection of the project a plan changed.
    fn invalidate_for_root(&self, root: &Path) {
        if let Ok(canonical) = crate::paths::canonical_dir(root) {
            self.invalidate_inspection(&project_id(&canonical));
        }
        self.invalidate_inspection(&project_id(root));
    }

    pub fn declarations(&self, project: &str) -> Result<Vec<Declaration>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, module, subject_json, present, note, created_at FROM declarations WHERE project_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map([project], |r| {
            Ok(Declaration {
                id: r.get(0)?,
                module: r.get(1)?,
                subject: serde_json::from_str(&r.get::<_, String>(2)?)
                    .unwrap_or(DeclaredSubject::Tag { tag: String::new() }),
                present: r.get::<_, i64>(3)? != 0,
                note: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn declare(
        &self,
        project: &str,
        module: &str,
        subject: DeclaredSubject,
        present: bool,
        note: Option<String>,
    ) -> Result<Declaration> {
        self.project(project)?;
        let valid = match &subject {
            DeclaredSubject::Tag { tag } => !tag.is_empty() && tag.len() <= 80,
            DeclaredSubject::Dependency { name } => !name.is_empty() && name.len() <= 200,
        };
        if !valid || module.is_empty() || module.len() > 512 {
            return Err(HabiError::invalid("invalid declaration"));
        }
        let declaration = Declaration {
            id: uuid::Uuid::new_v4().to_string(),
            module: module.to_string(),
            subject,
            present,
            note: note.map(|n| n.chars().take(500).collect()),
            created_at: crate::time::now(),
        };
        // One declaration per subject and module: replace the previous one.
        let subject_json = serde_json::to_string(&declaration.subject).unwrap_or_default();
        let conn = self.store.conn()?;
        conn.execute(
            "DELETE FROM declarations WHERE project_id = ?1 AND module = ?2 AND subject_json = ?3",
            params![project, module, subject_json],
        )?;
        conn.execute(
            "INSERT INTO declarations (id, project_id, module, subject_json, present, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                declaration.id,
                project,
                declaration.module,
                subject_json,
                declaration.present as i64,
                declaration.note,
                declaration.created_at
            ],
        )?;
        Ok(declaration)
    }

    /// Removes a declaration. Fails with `NotFound` when the project has no
    /// declaration with that id (declarations are per project).
    pub fn retract(&self, project: &str, declaration_id: &str) -> Result<()> {
        let removed = self.store.conn()?.execute(
            "DELETE FROM declarations WHERE project_id = ?1 AND id = ?2",
            params![project, declaration_id],
        )?;
        if removed == 0 {
            return Err(HabiError::NotFound(format!(
                "declaration `{declaration_id}` in this project"
            )));
        }
        Ok(())
    }

    // ----- libraries ---------------------------------------------------------

    /// Current indexes of all fetched sources, with their records.
    pub fn libraries(&self) -> Result<Vec<(Source, LibraryIndex)>> {
        let mut out = Vec::new();
        for source in self.sources.list()? {
            if source.snapshot.is_none() {
                continue;
            }
            match self.sources.index(&source.id) {
                Ok(index) => out.push((source, index)),
                Err(e) => {
                    tracing::warn!(source = %source.id, error = %e, "could not read cached library")
                }
            }
        }
        // Valid local skills take part like a library, so they are matched,
        // installed and updated through the same code as team items.
        match self.skills().library() {
            Ok((index, _)) if !index.items.is_empty() => {
                out.push((self.local_source(&index.snapshot, index.items.len()), index))
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "could not read local skills"),
        }
        Ok(out)
    }

    /// Skills of catalog libraries that fit a project, from libraries already
    /// fetched or connected (nothing is downloaded). Only skills with a rule
    /// to evaluate are considered: their author's, or the catalog's hint.
    pub fn catalog_fits(
        &self,
        project_id: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<crate::catalog::CatalogFit>> {
        let project = self.existing_project(project_id)?;
        if project.sample {
            return Ok(Vec::new());
        }
        let inspection = self.inspect(project_id, false, cancel)?;
        let declarations = self.declarations(project_id)?;
        let lock = read_lock(&project.root)?;
        let mut out = Vec::new();
        for entry in self.catalog().entries()? {
            let (Some(source_id), Some(_)) = (&entry.source_id, &entry.fetched) else {
                continue;
            };
            let source = self.sources.get(source_id)?;
            let index = self.sources.index(source_id)?;
            let hints = crate::catalog::hints_for_source(&source);
            let identity = portable_identity(&source);
            let candidates: Vec<Candidate> = index
                .items
                .iter()
                .map(|item| (item, hints.as_ref().and_then(|h| h.find(&item.path))))
                .filter(|(item, hint)| item.applies_when.is_some() || hint.is_some())
                .map(|(item, hint)| Candidate {
                    item,
                    source_name: &source.name,
                    source_identity: &identity,
                    snapshot: &index.snapshot,
                    runs: Vec::new(),
                    hint,
                })
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let libraries = vec![(source.clone(), index.clone())];
            let installations = self.installations(&project.root, &lock, &libraries);
            let fits: Vec<recommend::Recommendation> = recommend::recommend(
                &project.root,
                &inspection,
                &declarations,
                &lock,
                &installations,
                &candidates,
            )
            .into_iter()
            .filter(|r| r.applicability.applicability == Applicability::Applies)
            .collect();
            if !fits.is_empty() {
                out.push(crate::catalog::CatalogFit {
                    entry_id: entry.id,
                    source_id: source_id.clone(),
                    connected: entry.availability == crate::catalog::CatalogAvailability::Connected,
                    fits,
                });
            }
        }
        Ok(out)
    }

    /// The catalog of public libraries Habi suggests.
    pub fn catalog(&self) -> crate::catalog::Catalog<'_> {
        crate::catalog::Catalog::new(&self.sources)
    }

    pub fn skills(&self) -> Skills<'_> {
        Skills {
            paths: &self.paths,
            store: &self.store,
        }
    }

    fn local_source(&self, snapshot: &str, items: usize) -> Source {
        Source {
            id: LOCAL_SOURCE_ID.into(),
            name: LOCAL_SOURCE_NAME.into(),
            kind: SourceKind::Directory,
            role: crate::source::SourceRole::Team,
            location: crate::paths::display_path(&self.paths.skills()),
            subdir: None,
            tracked: TrackedRef::Default,
            created_at: String::new(),
            snapshot: Some(snapshot.to_string()),
            snapshot_at: None,
            commit_summary: None,
            last_attempt_at: None,
            last_error: None,
            warning: None,
            freshness: Freshness::Current,
            sample: false,
            skill_count: u32::try_from(items).unwrap_or(u32::MAX),
            preview: false,
            catalog_id: None,
            include: Vec::new(),
            exclude: Vec::new(),
            default_branch: None,
        }
    }

    fn source_of(&self, source_id: &str) -> Result<Source> {
        if source_id == LOCAL_SOURCE_ID {
            let (index, _) = self.skills().library()?;
            return Ok(self.local_source(&index.snapshot, index.items.len()));
        }
        self.sources.get(source_id)
    }

    fn index_of(&self, source_id: &str) -> Result<LibraryIndex> {
        if source_id == LOCAL_SOURCE_ID {
            return Ok(self.skills().library()?.0);
        }
        self.sources.index(source_id)
    }

    fn read_library_file(&self, source_id: &str, snapshot: &str, path: &str) -> Result<Vec<u8>> {
        if source_id == LOCAL_SOURCE_ID {
            return self.skills().read_library_file(path);
        }
        self.sources.read_file(source_id, snapshot, path)
    }

    pub fn item_detail(&self, source_id: &str, item_id: &str) -> Result<ItemDetail> {
        let source = self.source_of(source_id)?;
        let index = self.index_of(source_id)?;
        let item = index
            .items
            .iter()
            .find(|i| i.id == item_id)
            .cloned()
            .ok_or_else(|| HabiError::NotFound(format!("item `{item_id}`")))?;
        let main = match item.kind {
            crate::library::model::ItemKind::Instructions => item.path.clone(),
            _ => join(&item.path, crate::library::SKILL_FILE),
        };
        let bytes = self
            .read_library_file(source_id, &index.snapshot, &main)
            .unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = match crate::library::parse_frontmatter(&text) {
            Ok((_, body)) => body.to_string(),
            Err(_) => text,
        };
        Ok(ItemDetail {
            library_name: index.name.clone(),
            item,
            source,
            body,
        })
    }

    pub fn read_item_file(&self, source_id: &str, item_id: &str, rel: &str) -> Result<FileContent> {
        let index = self.index_of(source_id)?;
        let item = index
            .items
            .iter()
            .find(|i| i.id == item_id)
            .ok_or_else(|| HabiError::NotFound(format!("item `{item_id}`")))?;
        let rel = crate::paths::RelPath::new(rel)?.to_string();
        if !item.files.iter().any(|f| f.path == rel) {
            return Err(HabiError::NotFound(format!("{rel} in `{}`", item.title)));
        }
        let library_path = match item.kind {
            crate::library::model::ItemKind::Instructions => item.path.clone(),
            _ => join(&item.path, &rel),
        };
        let bytes = self.read_library_file(source_id, &index.snapshot, &library_path)?;
        let binary = !crate::fsutil::is_probably_text(&bytes);
        Ok(FileContent {
            path: rel,
            size: bytes.len() as u32,
            text: (!binary).then(|| {
                String::from_utf8_lossy(bytes.get(..512 * 1024).unwrap_or(&bytes)).into_owned()
            }),
            binary,
        })
    }

    fn payload(
        &self,
        source: &Source,
        index: &LibraryIndex,
        item: &LibraryItem,
    ) -> Result<Payload> {
        let mut files = Vec::new();
        for f in &item.files {
            let library_path = match item.kind {
                crate::library::model::ItemKind::Instructions => item.path.clone(),
                _ => join(&item.path, &f.path),
            };
            files.push(plan::PayloadFile {
                path: f.path.clone(),
                bytes: self.read_library_file(&source.id, &index.snapshot, &library_path)?,
                executable: f.executable,
            });
        }
        Ok(Payload {
            item: item.clone(),
            source: LockedSource {
                identity: portable_identity(source),
                name: source.name.clone(),
                subdir: source.subdir.clone(),
            },
            snapshot: index.snapshot.clone(),
            files,
        })
    }

    fn payload_for_ref(&self, r: &ItemRef) -> Result<Payload> {
        if r.source_id != LOCAL_SOURCE_ID {
            self.sources.connected(&r.source_id)?;
        }
        let source = self.source_of(&r.source_id)?;
        let index = self.index_of(&r.source_id)?;
        let item = index
            .items
            .iter()
            .find(|i| i.id == r.item_id)
            .ok_or_else(|| {
                HabiError::NotFound(format!("item `{}` in {}", r.item_id, source.name))
            })?;
        self.payload(&source, &index, item)
    }

    fn payload_for_key(&self, key: &str, libraries: &[(Source, LibraryIndex)]) -> Result<Payload> {
        let (identity, id) = key
            .rsplit_once('#')
            .ok_or_else(|| HabiError::invalid(format!("invalid item key {key}")))?;
        for (source, index) in libraries {
            if portable_identity(source) == identity
                && let Some(item) = index.items.iter().find(|i| i.id == id)
            {
                return self.payload(source, index, item);
            }
        }
        Err(HabiError::NotFound(format!(
            "the source of `{id}` ({identity}) on this machine; connect it to update"
        )))
    }

    // ----- overview ----------------------------------------------------------

    pub fn installations(
        &self,
        root: &Path,
        lock: &LockFile,
        libraries: &[(Source, LibraryIndex)],
    ) -> Vec<Installation> {
        lock.items
            .iter()
            .filter(|i| i.source.identity != "habi:internal")
            .map(|locked| {
                let upstream = libraries.iter().find_map(|(s, idx)| {
                    (portable_identity(s) == locked.source.identity)
                        .then(|| {
                            idx.items
                                .iter()
                                .find(|i| i.id == locked.id)
                                .map(|i| (i, idx.snapshot.as_str()))
                        })
                        .flatten()
                });
                status::installation(root, locked, upstream)
            })
            .collect()
    }

    pub fn overview(
        &self,
        id: &str,
        rescan: bool,
        cancel: &CancelToken,
    ) -> Result<ProjectOverview> {
        let project = self.existing_project(id)?;
        let inspection = self.inspect(id, rescan, cancel)?;
        let declarations = self.declarations(id)?;
        let lock = read_lock(&project.root)?;
        let mut libraries = self.libraries()?;
        // The sample workspace's libraries are for its sample projects only;
        // they never show up in the user's own projects.
        libraries.retain(|(source, _)| project.sample || !source.sample);
        let installations = self.installations(&project.root, &lock, &libraries);
        let mut candidates = Vec::new();
        let identities: Vec<String> = libraries
            .iter()
            .map(|(s, _)| portable_identity(s))
            .collect();
        // Rules Habi's catalog suggests for skills whose authors declared none.
        let hint_sets: Vec<Option<crate::catalog::Hints>> = libraries
            .iter()
            .map(|(s, _)| crate::catalog::hints_for_source(s))
            .collect();
        for (((source, index), identity), hints) in
            libraries.iter().zip(&identities).zip(&hint_sets)
        {
            for item in &index.items {
                candidates.push(Candidate {
                    item,
                    source_name: &source.name,
                    source_identity: identity,
                    snapshot: &index.snapshot,
                    runs: checks::runs(&self.store, id, &item.key)?,
                    hint: hints.as_ref().and_then(|h| h.find(&item.path)),
                });
            }
        }
        let recommendations = recommend::recommend(
            &project.root,
            &inspection,
            &declarations,
            &lock,
            &installations,
            &candidates,
        );
        let orphaned = installations
            .iter()
            .filter(|i| {
                !recommendations
                    .iter()
                    .any(|r| r.installation.as_ref().is_some_and(|x| x.key == i.key))
            })
            .cloned()
            .collect();
        // Remembered for lists (best effort: a failure here changes nothing else).
        let summary = {
            let mut by_source: Vec<(String, u32)> = Vec::new();
            let mut fits = 0;
            let mut needs_information = 0;
            for r in &recommendations {
                match r.applicability.applicability {
                    Applicability::Applies => {
                        fits += 1;
                        match by_source.iter_mut().find(|(s, _)| *s == r.item.source_id) {
                            Some((_, n)) => *n += 1,
                            None => by_source.push((r.item.source_id.clone(), 1)),
                        }
                    }
                    Applicability::NeedsInformation => needs_information += 1,
                    _ => {}
                }
            }
            by_source.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            let mut tally: Vec<SourceTally> = Vec::new();
            for r in &recommendations {
                let applies = r.applicability.applicability == Applicability::Applies;
                if !applies && r.installation.is_none() {
                    continue;
                }
                let at = match tally.iter().position(|t| t.source_id == r.item.source_id) {
                    Some(at) => at,
                    None => {
                        tally.push(SourceTally {
                            source_id: r.item.source_id.clone(),
                            fits: 0,
                            installed: Vec::new(),
                        });
                        tally.len() - 1
                    }
                };
                if let Some(t) = tally.get_mut(at) {
                    if applies {
                        t.fits += 1;
                    }
                    if r.installation.is_some() {
                        t.installed.push(r.item.title.clone());
                    }
                }
            }
            ProjectSummary {
                fits,
                needs_information,
                sources: by_source.into_iter().map(|(s, _)| s).collect(),
                installed: recommendations
                    .iter()
                    .filter(|r| r.installation.is_some())
                    .count() as u32,
                languages: {
                    let mut counts: Vec<(String, u32)> = Vec::new();
                    for tag in inspection.facts.iter().filter_map(|f| f.tag()) {
                        if !tag.starts_with("lang:") {
                            continue;
                        }
                        match counts.iter_mut().find(|(t, _)| t == tag) {
                            Some((_, n)) => *n += 1,
                            None => counts.push((tag.to_string(), 1)),
                        }
                    }
                    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                    let mut languages: Vec<String> = counts.into_iter().map(|(t, _)| t).collect();
                    // No source file seen yet: the build ecosystems say what it is written in.
                    if languages.is_empty() {
                        for e in inspection.modules.iter().flat_map(|m| &m.ecosystems) {
                            let tag = e.language().to_string();
                            if !languages.contains(&tag) {
                                languages.push(tag);
                            }
                        }
                    }
                    languages
                },
                tally,
                at: crate::time::now(),
            }
        };
        if let Ok(json) = serde_json::to_string(&summary) {
            let _ = self.store.set_setting(&summary_key(&project.id), &json);
        }
        let project = ProjectRecord {
            summary: Some(summary),
            ..project
        };
        Ok(ProjectOverview {
            project,
            inspection,
            declarations,
            recommendations,
            sources: libraries.into_iter().map(|(s, _)| s).collect(),
            orphaned,
        })
    }

    // ----- plans ---------------------------------------------------------------

    fn keep(&self, plan: Plan) -> Plan {
        let mut plans = self.plans.lock().unwrap_or_else(PoisonError::into_inner);
        if plans.len() > 32 {
            let oldest = plans
                .values()
                .min_by(|a, b| a.created_at.cmp(&b.created_at))
                .map(|p| p.id.clone());
            if let Some(id) = oldest {
                plans.remove(&id);
            }
        }
        plans.insert(plan.id.clone(), plan.clone());
        plan
    }

    pub fn plan_install(
        &self,
        project: &str,
        items: &[ItemRef],
        clients: &[ClientId],
        include_mcp: bool,
        decisions: &Decisions,
    ) -> Result<Plan> {
        let p = self.existing_project(project)?;
        let payloads = items
            .iter()
            .map(|r| self.payload_for_ref(r))
            .collect::<Result<Vec<_>>>()?;
        Ok(self.keep(plan::plan_install(
            &p.root,
            &payloads,
            clients,
            include_mcp,
            decisions,
        )?))
    }

    pub fn plan_update(
        &self,
        project: &str,
        keys: &[String],
        add_mcp: bool,
        decisions: &Decisions,
    ) -> Result<Plan> {
        let p = self.existing_project(project)?;
        let libraries = self.libraries()?;
        let payloads = keys
            .iter()
            .map(|k| self.payload_for_key(k, &libraries))
            .collect::<Result<Vec<_>>>()?;
        Ok(self.keep(plan::plan_update(&p.root, &payloads, add_mcp, decisions)?))
    }

    pub fn plan_remove(
        &self,
        project: &str,
        keys: &[String],
        decisions: &Decisions,
    ) -> Result<Plan> {
        let p = self.existing_project(project)?;
        Ok(self.keep(plan::plan_remove(&p.root, keys, decisions)?))
    }

    pub fn plan_restore(
        &self,
        project: &str,
        operation_id: &str,
        decisions: &Decisions,
    ) -> Result<Plan> {
        let p = self.existing_project(project)?;
        let (title, steps) = self.applier().restore_steps(&p.root, operation_id)?;
        Ok(self.keep(plan::plan_restore(&p.root, &steps, &title, decisions)?))
    }

    pub fn plan(&self, plan_id: &str) -> Result<Plan> {
        self.plans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(plan_id)
            .cloned()
            .ok_or_else(|| {
                HabiError::NotFound("that preview (it expired); create a new one".into())
            })
    }

    /// Applies a previously computed plan by id.
    pub fn apply(&self, plan_id: &str) -> Result<OperationSummary> {
        let plan = self.plan(plan_id)?;
        let result = self.applier().apply(&plan);
        // A plan is single-use whatever the outcome.
        self.plans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(plan_id);
        // Installs, updates, removals and restores change the project (skills,
        // AGENTS.md, MCP config), even when they fail part-way and roll back.
        self.invalidate_for_root(&plan.root);
        self.tidy_after(&plan.root, &result);
        result
    }

    pub fn apply_plan(&self, plan: &Plan) -> Result<OperationSummary> {
        let result = self.applier().apply(plan);
        self.invalidate_for_root(&plan.root);
        self.tidy_after(&plan.root, &result);
        result
    }

    /// Prunes old records after a successful apply. Best effort: the
    /// operation itself already succeeded.
    fn tidy_after(&self, root: &Path, result: &Result<OperationSummary>) {
        if result.is_ok()
            && let Err(e) =
                crate::maintenance::after_apply(&self.paths, &self.store, &project_id(root))
        {
            tracing::warn!(error = %e, "could not prune old records");
        }
    }

    /// Frees disk space: old operation records and library snapshots beyond
    /// the newest of each, and stored content nothing kept refers to.
    pub fn prune(&self) -> Result<crate::maintenance::PruneReport> {
        crate::maintenance::prune(&self.paths, &self.store)
    }

    pub fn history(&self, project: &str) -> Result<Vec<OperationSummary>> {
        let p = self.project(project)?;
        self.applier().history(&p.root)
    }

    pub fn recover(&self, project: &str) -> Result<Vec<OperationSummary>> {
        let p = self.existing_project(project)?;
        let result = self.applier().recover(&p.root);
        self.invalidate_inspection(project);
        result
    }

    // ----- checks --------------------------------------------------------------

    fn find_item(&self, key: &str) -> Result<LibraryItem> {
        let (source_id, id) = key
            .split_once('/')
            .ok_or_else(|| HabiError::invalid(format!("invalid item key {key}")))?;
        self.index_of(source_id)?
            .items
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| HabiError::NotFound(format!("item {key}")))
    }

    pub fn prepare_check(
        &self,
        project: &str,
        item_key: &str,
        check_id: &str,
        module: &str,
        bindings: &HashMap<String, String>,
    ) -> Result<CheckPreview> {
        let p = self.existing_project(project)?;
        let inspection = self.inspect(project, false, &CancelToken::new())?;
        let item = self.find_item(item_key)?;
        let mut preview = checks::prepare(&p.root, &inspection, &item, check_id, module, bindings)?;
        preview.preview_id = uuid::Uuid::new_v4().to_string();
        let mut stored = self
            .check_previews
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if stored.len() > 32 {
            stored.clear();
        }
        stored.insert(
            preview.preview_id.clone(),
            StoredCheck {
                project: project.to_string(),
                module: module.to_string(),
                bindings: bindings.clone(),
                preview: preview.clone(),
            },
        );
        Ok(preview)
    }

    /// Runs a check the user previewed. The preview id is single-use, and the
    /// command is prepared again and compared with what was shown: if the
    /// program, arguments or folder would differ, nothing runs.
    pub fn run_check(
        &self,
        project: &str,
        preview_id: &str,
        cancel: &CancelToken,
    ) -> Result<CheckRun> {
        let stored = self
            .check_previews
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(preview_id)
            .ok_or_else(|| {
                HabiError::NotFound(
                    "that check preview (it expired); preview the command again".into(),
                )
            })?;
        if stored.project != project {
            return Err(HabiError::invalid(
                "the check preview belongs to another project",
            ));
        }
        let p = self.existing_project(project)?;
        let inspection = self.inspect(project, true, cancel)?;
        let item = self.find_item(&stored.preview.item_key)?;
        let now = checks::prepare(
            &p.root,
            &inspection,
            &item,
            &stored.preview.check_id,
            &stored.module,
            &stored.bindings,
        )?;
        let shown = &stored.preview;
        if now.program != shown.program
            || now.args != shown.args
            || now.cwd != shown.cwd
            || now.resolved_program != shown.resolved_program
            || now.item_digest != shown.item_digest
        {
            return Err(HabiError::StalePlan(
                "the command changed since you previewed it; preview it again".into(),
            ));
        }
        checks::run(
            &p.root,
            &self.store,
            project,
            &inspection.fingerprint,
            &now,
            cancel,
        )
    }

    pub fn check_runs(&self, project: &str, item_key: &str) -> Result<Vec<CheckRun>> {
        checks::runs(&self.store, project, item_key)
    }

    // ----- local skills ----------------------------------------------------------

    /// Creates a draft in My skills. With a project, the origin records
    /// which project it was written for; nothing is derived from it silently.
    pub fn create_skill(&self, new: &NewSkill, project: Option<&str>) -> Result<LocalSkill> {
        let origin = match project {
            Some(id) => SkillOrigin::CreatedForProject {
                project_name: self.project(id)?.name,
            },
            None => SkillOrigin::Created,
        };
        self.skills().create(new, origin)
    }

    /// Skills and instruction files that already exist in a project.
    pub fn discover(&self, project: &str, cancel: &CancelToken) -> Result<ProjectKnowledge> {
        let p = self.existing_project(project)?;
        let inspection = self.inspect(project, false, cancel)?;
        let lock = read_lock(&p.root)?;
        let skills = self.skills();
        Ok(intake::discover(
            &p.root,
            &inspection,
            &lock,
            &skills.list()?,
            &skills.origin_digests()?,
        ))
    }

    pub fn read_instructions(&self, project: &str, path: &str) -> Result<InstructionDocument> {
        let p = self.existing_project(project)?;
        let inspection = self.inspect(project, false, &CancelToken::new())?;
        intake::read_instructions(&p.root, &inspection, path)
    }

    /// Starts a draft from lines the author selected in an instruction file.
    /// The file itself is left as it is.
    pub fn create_skill_from_instructions(
        &self,
        project: &str,
        path: &str,
        start_line: u32,
        end_line: u32,
        title: &str,
    ) -> Result<LocalSkill> {
        let p = self.existing_project(project)?;
        let document = self.read_instructions(project, path)?;
        let body = intake::select_lines(&document, start_line, end_line)?;
        let origin = SkillOrigin::Instructions {
            project_name: p.name.clone(),
            path: document.path.clone(),
            start_line,
            end_line,
        };
        self.skills().create_with_body(
            &NewSkill {
                title: title.to_string(),
                ..Default::default()
            },
            origin,
            &body,
            Some(&if start_line == end_line {
                format!("{} (line {start_line}) in {}", document.path, p.name)
            } else {
                format!(
                    "{} (lines {start_line}-{end_line}) in {}",
                    document.path, p.name
                )
            }),
        )
    }

    /// Where an item of a library lives and who publishes it, recorded with
    /// a copy so the copy can be traced back to it.
    fn upstream_of(&self, source: &Source, item: &crate::library::model::LibraryItem) -> Upstream {
        let url = (source.kind == SourceKind::Git
            && !crate::source::is_local_location(&source.location))
        .then(|| crate::source::remote_identity(&source.location))
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"));
        let path = match &source.subdir {
            Some(sub) if !item.path.is_empty() => format!("{sub}/{}", item.path),
            Some(sub) => sub.clone(),
            None => item.path.clone(),
        };
        let entry = self.catalog().entries().ok().and_then(|all| {
            all.into_iter()
                .find(|e| e.source_id.as_deref() == Some(source.id.as_str()))
        });
        let library_license = entry
            .as_ref()
            .and_then(|e| e.contents.as_ref())
            .and_then(|c| c.license.as_ref())
            .map(|l| l.spdx.clone().unwrap_or_else(|| format!("see {}", l.file)));
        Upstream {
            url,
            path,
            license: item.license.clone().or(library_license),
            publisher: entry.as_ref().map(|e| e.publisher.name.clone()),
            catalog_id: source.catalog_id.clone().or(entry.map(|e| e.id)),
        }
    }

    /// `upstream_of` for a skill Habi installed into a project: found through
    /// the connected library it came from, if that library is still here.
    fn upstream_of_installed(&self, identity: &str, item_id: &str) -> Option<Upstream> {
        let source = self
            .sources
            .list()
            .ok()?
            .into_iter()
            .find(|s| portable_identity(s) == identity)?;
        let index = self.sources.index(&source.id).ok()?;
        let item = index.items.iter().find(|i| i.id == item_id)?;
        Some(self.upstream_of(&source, item))
    }

    fn packages(&self, from: &ImportFrom, cancel: &CancelToken) -> Result<(String, Vec<Package>)> {
        match from {
            ImportFrom::Project { project_id } => {
                let p = self.existing_project(project_id)?;
                let knowledge = self.discover(project_id, cancel)?;
                // A skill Habi installed from a library keeps that library and
                // the installed version as its origin, so edits can go back
                // to it (and later library changes can be compared).
                let lock = crate::install::plan::read_lock(&p.root).unwrap_or_default();
                let mine = portable_identity(&self.local_source("", 0));
                let mut packages = Vec::new();
                for found in knowledge.skills {
                    cancel.check()?;
                    let rel = crate::paths::RelPath::new(&found.path)?;
                    let Some(dir) = crate::paths::resolve_for_read(&p.root, &rel)? else {
                        continue;
                    };
                    let skill_md = format!("{}/{}", found.path, crate::library::SKILL_FILE);
                    let installed = lock.items.iter().find(|i| {
                        i.source.identity != mine && i.files.iter().any(|f| f.path == skill_md)
                    });
                    packages.push(Package {
                        tree: crate::skills::read_tree(&dir, &TreeLimits::PACKAGE)?,
                        origin: match installed {
                            Some(i) => SkillOrigin::Library {
                                source_name: i.source.name.clone(),
                                source_identity: i.source.identity.clone(),
                                item_id: i.id.clone(),
                                snapshot: i.snapshot.clone(),
                                upstream: self.upstream_of_installed(&i.source.identity, &i.id),
                            },
                            None => SkillOrigin::Project {
                                project_name: p.name.clone(),
                                path: found.path.clone(),
                            },
                        },
                        path: found.path,
                        title: None,
                    });
                }
                Ok((p.name, packages))
            }
            ImportFrom::Folder { path } => {
                let dir = crate::paths::canonical_dir(Path::new(path))?;
                let shown = crate::paths::display_path(&dir);
                let tree = crate::skills::read_tree(&dir, &TreeLimits::FOLDER)?;
                cancel.check()?;
                let packages = intake::packages_in(&tree, |rel| SkillOrigin::Folder {
                    path: if rel.is_empty() {
                        shown.clone()
                    } else {
                        format!("{shown}/{rel}")
                    },
                });
                Ok((shown.clone(), packages))
            }
            ImportFrom::Machine { id } => {
                let found = crate::skills::machine::locate(&self.user_home, id)?;
                cancel.check()?;
                let tree = crate::skills::read_tree(&found.path, &TreeLimits::PACKAGE)?;
                let packages = intake::packages_in(&tree, |_| SkillOrigin::Folder {
                    path: found.location.clone(),
                });
                Ok((found.location, packages))
            }
            ImportFrom::GitCopy { source_id } => {
                let source = self.sources.get(source_id)?;
                if !is_copy_source(&source) {
                    return Err(HabiError::invalid(
                        "that is not a repository opened for copying; open it again",
                    ));
                }
                let label = repository_label(&source);
                let packages = self.library_packages(&source, &label, cancel)?;
                Ok((label, packages))
            }
            ImportFrom::Library { source_id } => {
                if source_id == LOCAL_SOURCE_ID {
                    return Err(HabiError::invalid("those skills are already yours"));
                }
                let source = self.sources.connected(source_id)?;
                let packages = self.library_packages(&source, &source.name, cancel)?;
                Ok((source.name, packages))
            }
        }
    }

    /// The skills of a fetched library as packages to copy, each remembering
    /// the library (`source_name`), the item and the version it came from.
    fn library_packages(
        &self,
        source: &Source,
        source_name: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<Package>> {
        {
            {
                let index = self.sources.index(&source.id)?;
                let mut packages = Vec::new();
                for item in index
                    .items
                    .iter()
                    .filter(|i| i.kind != crate::library::model::ItemKind::Instructions)
                {
                    cancel.check()?;
                    let mut tree = Tree::default();
                    for f in &item.files {
                        tree.files
                            .insert(f.path.clone(), self.sources.blobs().get(&f.digest)?);
                        if f.executable {
                            tree.executables.insert(f.path.clone());
                        }
                    }
                    if !item.complete {
                        tree.skipped.push(crate::library::model::Diagnostic::error(
                            "was skipped when the library was fetched",
                            Some("a file"),
                        ));
                    }
                    packages.push(Package {
                        path: item.id.clone(),
                        tree,
                        origin: SkillOrigin::Library {
                            source_name: source_name.to_string(),
                            source_identity: portable_identity(source),
                            item_id: item.id.clone(),
                            snapshot: index.snapshot.clone(),
                            upstream: Some(self.upstream_of(source, item)),
                        },
                        title: Some(item.title.clone()),
                    });
                }
                Ok(packages)
            }
        }
    }

    /// Fetches a Git repository so its skills can be copied into My skills,
    /// without connecting it as a library: it stays hidden, is never
    /// refreshed on its own, and is discarded with `forget_git_copy` (or by
    /// maintenance). Copies remember the repository, so connecting it later
    /// lets them follow its updates. Nothing in it is run.
    pub fn open_git_copy(&self, location: &str, cancel: &CancelToken) -> Result<GitCopy> {
        let location = location.trim();
        let name = format!(
            "{COPY_PREFIX}{}",
            crate::fsutil::short(&crate::fsutil::sha256(location.as_bytes()))
        );
        let existing = self
            .sources
            .list_previews()?
            .into_iter()
            .find(|s| s.name == name);
        let source = match existing {
            Some(s) => s,
            None => {
                let added = self.sources.add_with(
                    &crate::source::NewSource {
                        name,
                        location: location.to_string(),
                        subdir: None,
                        tracked: TrackedRef::Default,
                    },
                    &crate::source::CatalogBinding {
                        catalog_id: None,
                        include: Vec::new(),
                        exclude: Vec::new(),
                        preview: true,
                    },
                )?;
                // Published by others until someone decides otherwise.
                self.sources
                    .set_role(&added.id, crate::source::SourceRole::Community)?
            }
        };
        if let Err(e) = self.sources.refresh(&source.id, cancel) {
            // A repository that could not be read is not left behind.
            let _ = self.sources.remove(&source.id);
            return Err(e);
        }
        let source = self.sources.get(&source.id)?;
        Ok(GitCopy {
            label: repository_label(&source),
            snapshot: source.snapshot.clone(),
            source_id: source.id,
        })
    }

    /// Discards a repository opened for copying (copies already made keep
    /// their own record of their original). Anything else is left alone.
    pub fn forget_git_copy(&self, source_id: &str) -> Result<()> {
        match self.sources.get(source_id) {
            Ok(source) if is_copy_source(&source) => self.sources.remove(source_id),
            Ok(_) | Err(HabiError::NotFound(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Looks at a source and reports the packages in it. Writes nothing.
    pub fn inspect_import(
        &self,
        from: &ImportFrom,
        cancel: &CancelToken,
    ) -> Result<ImportInspection> {
        let (origin, packages) = self.packages(from, cancel)?;
        let candidates = self.skills().inspect_packages(&packages)?;
        let mut notes = Vec::new();
        if candidates.is_empty() {
            notes.push(match from {
                ImportFrom::Project { .. } => {
                    "No skill folders (a folder with SKILL.md) were found in this project.".into()
                }
                ImportFrom::Folder { .. } => {
                    "No SKILL.md was found in this folder or the folders inside it.".to_string()
                }
                ImportFrom::Library { .. } => "This library has no skills yet.".into(),
                ImportFrom::GitCopy { .. } => {
                    "No SKILL.md was found in this repository.".to_string()
                }
                ImportFrom::Machine { .. } => "No SKILL.md was found in this skill folder.".into(),
            });
        }
        Ok(ImportInspection {
            origin,
            candidates,
            notes,
        })
    }

    /// Copies the selected packages into My skills as independent copies.
    pub fn import_skills(
        &self,
        from: &ImportFrom,
        selections: &[ImportSelection],
        cancel: &CancelToken,
    ) -> Result<ImportOutcome> {
        let (_, packages) = self.packages(from, cancel)?;
        self.skills().import_packages(packages, selections)
    }

    /// For a skill copied from a library: whether that library item changed,
    /// was removed, or cannot be compared. `None` for other skills.
    pub fn skill_upstream(
        &self,
        id: &str,
    ) -> Result<Option<crate::skills::upstream::UpstreamStatus>> {
        self.skills().upstream_status(id, &self.sources)
    }

    /// Skills in the person's own folders (`~/.claude/skills`, `~/.agents/skills`,
    /// `~/.cursor/skills`), with what they share with My skills and with the
    /// projects Habi knows. Reads only; links are followed to read.
    pub fn machine_skills(&self) -> Result<Vec<crate::skills::machine::MachineSkill>> {
        use crate::skills::machine::{self, ProjectRef};
        let mut found = machine::scan(&self.user_home);
        if found.is_empty() {
            return Ok(found);
        }
        let skills = self.skills();
        let local = skills.list()?;
        let digests = skills.origin_digests()?;
        let projects: Vec<ProjectRecord> = self
            .all_project_ids()?
            .iter()
            .filter_map(|id| self.project(id).ok())
            .filter(|p| p.exists)
            .collect();
        let refs: Vec<ProjectRef> = projects
            .iter()
            .map(|p| ProjectRef {
                id: &p.id,
                name: &p.name,
                root: &p.root,
            })
            .collect();
        // What Habi itself installed here, from its record under the home folder.
        let lock = read_lock(&self.user_home).unwrap_or_default();
        let installs = if lock.items.is_empty() {
            Vec::new()
        } else {
            self.installations(
                &self.user_home,
                &lock,
                &self.libraries().unwrap_or_default(),
            )
        };
        for skill in &mut found {
            skill.imported_as = intake::already_imported(&skill.digest, &local, &digests);
            skill.in_projects =
                machine::project_copies(&skill.folder, &skill.digest, &skill.readers, &refs);
            skill.managed = machine::skill_file(&skill.id)
                .and_then(|file| lock.owner_of(&file))
                .and_then(|owner| {
                    installs.iter().find(|i| i.key == owner.key()).map(|i| {
                        machine::ManagedInstall {
                            key: i.key.clone(),
                            library: i.source_name.clone(),
                            state: i.state,
                        }
                    })
                });
        }
        Ok(found)
    }

    /// The folder machine installs write under: the home folder, which must exist.
    fn machine_root(&self) -> Result<&Path> {
        if self.user_home.as_os_str().is_empty() || !self.user_home.is_dir() {
            return Err(HabiError::NotFound("your home folder".into()));
        }
        Ok(&self.user_home)
    }

    /// What installing these skills on this machine would sit next to: the
    /// projects that hold a skill of the same name, and whether it matches.
    /// The clients to preselect: those a project already uses, or, with no
    /// project, those set up in the home folder. Empty when there is no sign.
    pub fn detected_clients(&self, project_id: Option<&str>) -> Result<Vec<ClientId>> {
        Ok(match project_id {
            Some(id) => crate::clients::in_project(&self.project(id)?.root),
            None => crate::clients::on_machine(&self.user_home),
        })
    }

    pub fn machine_install_preview(
        &self,
        items: &[ItemRef],
        clients: &[ClientId],
    ) -> Result<Vec<crate::skills::machine::InstallShadow>> {
        use crate::skills::machine::{self, ProjectRef};
        let readers = machine::readers_for(clients);
        let projects: Vec<ProjectRecord> = self
            .all_project_ids()?
            .iter()
            .filter_map(|id| self.project(id).ok())
            .filter(|p| p.exists)
            .collect();
        let refs: Vec<ProjectRef> = projects
            .iter()
            .map(|p| ProjectRef {
                id: &p.id,
                name: &p.name,
                root: &p.root,
            })
            .collect();
        items
            .iter()
            .map(|r| {
                let payload = self.payload_for_ref(r)?;
                Ok(machine::InstallShadow {
                    name: payload.item.name.clone(),
                    title: payload.item.title.clone(),
                    copies: machine::project_copies(
                        &payload.item.name,
                        &payload.item.content_digest,
                        &readers,
                        &refs,
                    ),
                })
            })
            .collect()
    }

    fn all_project_ids(&self) -> Result<Vec<String>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare("SELECT id FROM projects ORDER BY last_opened_at DESC")?;
        Ok(stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// `plan_install` for the person's own skill folders. Skills only.
    pub fn plan_install_machine(
        &self,
        items: &[ItemRef],
        clients: &[ClientId],
        decisions: &Decisions,
    ) -> Result<Plan> {
        let home = self.machine_root()?;
        let payloads = items
            .iter()
            .map(|r| self.payload_for_ref(r))
            .collect::<Result<Vec<_>>>()?;
        Ok(self.keep(plan::plan_install_on_machine(
            home, &payloads, clients, decisions,
        )?))
    }

    pub fn plan_update_machine(&self, keys: &[String], decisions: &Decisions) -> Result<Plan> {
        let home = self.machine_root()?;
        let libraries = self.libraries()?;
        let payloads = keys
            .iter()
            .map(|k| self.payload_for_key(k, &libraries))
            .collect::<Result<Vec<_>>>()?;
        Ok(self.keep(plan::plan_update_on_machine(home, &payloads, decisions)?))
    }

    pub fn plan_remove_machine(&self, keys: &[String], decisions: &Decisions) -> Result<Plan> {
        let home = self.machine_root()?;
        Ok(self.keep(plan::plan_remove_on_machine(home, keys, decisions)?))
    }

    pub fn plan_restore_machine(&self, operation_id: &str, decisions: &Decisions) -> Result<Plan> {
        let home = self.machine_root()?;
        let (title, steps) = self.applier().restore_steps(home, operation_id)?;
        Ok(self.keep(plan::plan_restore_on_machine(
            home, &steps, &title, decisions,
        )?))
    }

    /// What Habi has done on this machine, newest first.
    pub fn machine_history(&self) -> Result<Vec<OperationSummary>> {
        self.applier().history(self.machine_root()?)
    }

    /// Finishes or undoes a machine operation that was interrupted.
    pub fn machine_recover(&self) -> Result<Vec<OperationSummary>> {
        self.applier().recover(self.machine_root()?)
    }

    /// Where each of My skills stands beyond its own files: which projects
    /// have it installed (from their lock files) and whether its library has
    /// a newer version (from what is cached — nothing is fetched). Kept apart
    /// from `list_skills` because it reads every project's lock file.
    pub fn skills_overview(&self) -> Result<Vec<SkillStanding>> {
        let skills = self.skills();
        let (index, ids) = skills.library()?;
        let identity = portable_identity(&self.local_source(&index.snapshot, index.items.len()));
        let digests: HashMap<&str, &str> = index
            .items
            .iter()
            .map(|i| (i.id.as_str(), i.content_digest.as_str()))
            .collect();
        let mut standing: HashMap<String, SkillStanding> = HashMap::new();
        let project_ids: Vec<String> = {
            let conn = self.store.conn()?;
            let mut stmt = conn.prepare("SELECT id FROM projects ORDER BY last_opened_at DESC")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for project_id in project_ids {
            let Ok(project) = self.project(&project_id) else {
                continue;
            };
            let Ok(lock) = read_lock(&project.root) else {
                continue;
            };
            for item in lock.items.iter().filter(|i| i.source.identity == identity) {
                let Some(skill_id) = ids.get(&item.id) else {
                    continue;
                };
                standing
                    .entry(skill_id.clone())
                    .or_insert_with(|| SkillStanding::new(skill_id))
                    .installed_in
                    .push(InstalledIn {
                        project_id: project.id.clone(),
                        project_name: project.name.clone(),
                        clients: item.clients.clone(),
                        current: digests.get(item.id.as_str())
                            == Some(&item.content_digest.as_str()),
                    });
            }
        }
        for summary in skills.list()? {
            if summary.deleted_at.is_some()
                || !matches!(summary.origin, SkillOrigin::Library { .. })
            {
                continue;
            }
            let state = match skills.upstream_status(&summary.id, &self.sources) {
                Ok(status) => status.map(|s| s.state),
                Err(e) => {
                    tracing::warn!(skill = %summary.id, error = %e, "could not compare a copy with its library");
                    None
                }
            };
            standing
                .entry(summary.id.clone())
                .or_insert_with(|| SkillStanding::new(&summary.id))
                .upstream = state;
        }
        let mut out: Vec<SkillStanding> = standing.into_values().collect();
        out.sort_by(|a, b| a.skill_id.cmp(&b.skill_id));
        Ok(out)
    }

    /// What a copy changed since it was made or last updated. Writes nothing.
    pub fn skill_local_changes(&self, id: &str) -> Result<crate::skills::lineage::LocalChanges> {
        self.skills().local_changes(id, &self.sources)
    }

    /// Lines in a skill's text files that contain `query`.
    pub fn search_skill_files(
        &self,
        id: &str,
        query: &str,
    ) -> Result<Vec<crate::skills::FileMatch>> {
        self.skills().search_files(id, query)
    }

    /// The starters the skill editor offers.
    pub fn skill_templates(&self) -> Vec<crate::skills::TemplateInfo> {
        crate::skills::SkillTemplate::offered()
    }

    /// File-by-file comparison of a library copy with the library. Writes nothing.
    pub fn plan_upstream_sync(&self, id: &str) -> Result<crate::skills::upstream::UpstreamPlan> {
        self.skills().plan_upstream_sync(id, &self.sources)
    }

    /// Takes the reviewed library changes; conflicts follow `decisions`.
    pub fn apply_upstream_sync(
        &self,
        id: &str,
        token: &str,
        decisions: &std::collections::BTreeMap<String, crate::skills::upstream::UpstreamChoice>,
    ) -> Result<LocalSkill> {
        self.skills()
            .apply_upstream_sync(id, &self.sources, token, decisions)
    }

    fn preview_conditions(&self, request: &PreviewRequest) -> Result<PreviewRules> {
        let stored = match &request.skill_id {
            Some(id) => Some(self.skills().get(id)?),
            None => None,
        };
        let from_value = |value: &serde_json::Value| -> Result<_> {
            if let Err(errors) = crate::library::schema::validate_skill(value) {
                return Err(HabiError::invalid(errors.join("; ")));
            }
            let parse = |key: &str| -> Result<Option<Condition>> {
                value
                    .get(key)
                    .map(|c| {
                        Condition::parse(c).map_err(|e| HabiError::invalid(format!("`{key}`: {e}")))
                    })
                    .transpose()
            };
            let scope = if value.get("scope").and_then(|s| s.as_str()) == Some("repository") {
                Scope::Repository
            } else {
                Scope::Module
            };
            Ok(PreviewRules {
                applies_when: parse("applies_when")?,
                excludes: parse("excludes")?,
                scope,
                tools: required_tools(value),
            })
        };
        if let Some(text) = &request.metadata_text {
            if text.trim().is_empty() {
                return Ok(PreviewRules::none());
            }
            let value = crate::library::parse_yaml(text)
                .map_err(|e| HabiError::invalid(format!("habi.yaml is not valid YAML: {e}")))?;
            return from_value(&value);
        }
        if let Some(form) = &request.form {
            let existing = stored
                .as_ref()
                .and_then(|s| s.metadata_text.as_deref())
                .and_then(|t| crate::library::parse_yaml(t).ok());
            let name = stored
                .as_ref()
                .map(|s| s.summary.name.clone())
                .unwrap_or_default();
            return match Skills::form_to_sidecar(existing, form, &name)? {
                Some(value) => from_value(&value),
                None => Ok(PreviewRules::none()),
            };
        }
        match stored {
            Some(s) => Ok(PreviewRules {
                tools: s
                    .metadata_text
                    .as_deref()
                    .and_then(|t| crate::library::parse_yaml(t).ok())
                    .map(|v| required_tools(&v))
                    .unwrap_or_default(),
                applies_when: s.applies_when,
                excludes: s.excludes,
                scope: s.scope,
            }),
            None => Ok(PreviewRules::none()),
        }
    }

    /// Evaluates applicability rules against every registered project with
    /// the same matcher recommendations use. Inspections are reused when
    /// cached; a project that cannot be inspected is reported, not guessed.
    pub fn preview_skill(
        &self,
        request: &PreviewRequest,
        cancel: &CancelToken,
    ) -> Result<SkillPreview> {
        let PreviewRules {
            applies_when,
            excludes,
            scope,
            tools,
        } = match self.preview_conditions(request) {
            Ok(c) => c,
            Err(HabiError::InvalidInput(problem)) => {
                return Ok(SkillPreview {
                    applies_when: None,
                    excludes: None,
                    scope: Scope::Module,
                    problem: Some(problem),
                    projects: Vec::new(),
                });
            }
            Err(e) => return Err(e),
        };
        let mut projects = Vec::new();
        let candidates = match &request.project_id {
            Some(id) => vec![self.project(id)?],
            None => self.recent_projects()?,
        };
        for project in candidates.into_iter().filter(|p| p.exists) {
            cancel.check()?;
            let inspected = self
                .inspect(&project.id, false, cancel)
                .and_then(|i| Ok((self.declarations(&project.id)?, i)));
            projects.push(match inspected {
                Ok((declarations, inspection)) => {
                    let mut incomplete = Vec::new();
                    if inspection.scan.truncated {
                        incomplete.push(format!(
                            "The scan stopped early: {}",
                            inspection.scan.limits_hit.join(" ")
                        ));
                    }
                    for c in inspection
                        .coverage
                        .iter()
                        .filter(|c| c.status != CoverageStatus::Complete)
                        .take(4)
                    {
                        incomplete.push(format!(
                            "{} in {}: {}",
                            c.area,
                            if c.module == "." {
                                "the root"
                            } else {
                                &c.module
                            },
                            c.notes
                                .first()
                                .cloned()
                                .unwrap_or_else(|| "not fully read".into())
                        ));
                    }
                    let result = assess(
                        applies_when.as_ref(),
                        excludes.as_ref(),
                        scope,
                        &inspection,
                        &declarations,
                    );
                    let modules: Vec<String> =
                        result.modules.iter().map(|m| m.module.clone()).collect();
                    ProjectPreview {
                        prerequisites: recommend::tool_prerequisites(
                            &project.root,
                            &tools,
                            &modules,
                        ),
                        result: Some(result),
                        error: None,
                        inspected_at: Some(inspection.inspected_at.clone()),
                        incomplete,
                        project,
                    }
                }
                Err(HabiError::Cancelled) => return Err(HabiError::Cancelled),
                Err(e) => ProjectPreview {
                    project,
                    result: None,
                    error: Some(e.to_info()),
                    inspected_at: None,
                    incomplete: Vec::new(),
                    prerequisites: Vec::new(),
                },
            });
        }
        Ok(SkillPreview {
            applies_when,
            excludes,
            scope,
            problem: None,
            projects,
        })
    }

    /// Evaluates a contribution's staged rules against the author's projects
    /// with the same matcher recommendations use, and summarizes the result
    /// for reviewers. Nothing is stored or sent.
    pub fn contribution_rehearsal(&self, id: &str, cancel: &CancelToken) -> Result<Rehearsal> {
        let no_rules = || {
            Rehearsal {
            text: "Where it applies: no applicability rules are declared, so Habi does not match this skill to projects; teams use it deliberately.".into(),
            projects: 0,
            samples_skipped: 0,
        }
        };
        let Some(text) = self.contributions().staged_metadata(id)? else {
            return Ok(no_rules());
        };
        let preview = self.preview_skill(
            &PreviewRequest {
                skill_id: None,
                form: None,
                metadata_text: Some(text),
                project_id: None,
            },
            cancel,
        )?;
        if let Some(problem) = preview.problem {
            return Err(HabiError::invalid(format!(
                "the rules could not be evaluated: {problem}"
            )));
        }
        if preview.applies_when.is_none() {
            return Ok(no_rules());
        }
        let (mut applies, mut needs) = (Vec::new(), Vec::new());
        let (mut not, mut unreadable, mut samples) = (0u32, 0u32, 0u32);
        for p in &preview.projects {
            if p.project.sample {
                samples += 1;
                continue;
            }
            match p.result.as_ref().map(|r| r.applicability) {
                Some(Applicability::Applies) => applies.push(p.project.name.clone()),
                Some(Applicability::NeedsInformation) => needs.push(p.project.name.clone()),
                Some(Applicability::DoesNotApply) => not += 1,
                Some(Applicability::Undeclared) => {}
                None => unreadable += 1,
            }
        }
        let total = applies.len() as u32 + needs.len() as u32 + not + unreadable;
        if total == 0 {
            return Ok(Rehearsal {
                text: String::new(),
                projects: 0,
                samples_skipped: samples,
            });
        }
        let projects = |n: u32| format!("{n} project{}", if n == 1 { "" } else { "s" });
        let mut lines = vec![format!(
            "Where it applies — checked by Habi against {} on the author's machine (the rules only, not the skill's quality):",
            projects(total)
        )];
        if !applies.is_empty() {
            lines.push(format!("- Applies: {}", applies.join(", ")));
        }
        if !needs.is_empty() {
            lines.push(format!(
                "- Needs information (Habi could not establish everything): {}",
                needs.join(", ")
            ));
        }
        if not > 0 {
            lines.push(format!("- Does not apply: {}", projects(not)));
        }
        if unreadable > 0 {
            lines.push(format!(
                "- Could not be inspected: {}",
                projects(unreadable)
            ));
        }
        Ok(Rehearsal {
            text: lines.join("\n"),
            projects: total,
            samples_skipped: samples,
        })
    }

    /// Facts observed in a project that an author may turn into conditions.
    pub fn suggest_conditions(&self, project: &str) -> Result<Vec<ConditionSuggestion>> {
        let inspection = self.inspect(project, false, &CancelToken::new())?;
        let mut out: Vec<ConditionSuggestion> = Vec::new();
        let evidence = |f: &crate::inspect::model::Fact| {
            f.evidence.first().map(|e| match e.line {
                Some(line) => format!("{}:{line}", e.file),
                None => e.file.clone(),
            })
        };
        for f in &inspection.facts {
            let suggestion = match &f.subject {
                FactSubject::Tag { tag } if !tag.starts_with("agents:") => ConditionSuggestion {
                    kind: SuggestionKind::Tag,
                    value: tag.clone(),
                    label: crate::inspect::tags::label(tag),
                    module: f.module.clone(),
                    evidence: evidence(f),
                },
                FactSubject::Dependency { name, .. } if f.origin == FactOrigin::Direct => {
                    ConditionSuggestion {
                        kind: SuggestionKind::Dependency,
                        value: name.clone(),
                        label: name.clone(),
                        module: f.module.clone(),
                        evidence: evidence(f),
                    }
                }
                _ => continue,
            };
            if !out
                .iter()
                .any(|s| s.kind == suggestion.kind && s.value == suggestion.value)
            {
                out.push(suggestion);
            }
        }
        out.sort_by(|a, b| {
            (a.kind != SuggestionKind::Tag)
                .cmp(&(b.kind != SuggestionKind::Tag))
                .then(a.label.to_lowercase().cmp(&b.label.to_lowercase()))
        });
        out.truncate(240);
        Ok(out)
    }

    // ----- contributions -------------------------------------------------------

    pub fn contributions(&self) -> Contributions<'_> {
        Contributions {
            paths: &self.paths,
            store: &self.store,
            sources: &self.sources,
            tools: &self.review_tools,
        }
    }

    pub fn start_contribution(
        &self,
        source_id: &str,
        origin: ContributionOrigin,
    ) -> Result<Contribution> {
        let (root, tags) = match &origin {
            ContributionOrigin::ProjectSkill { project_id, .. } => {
                let project = self.existing_project(project_id)?;
                let inspection = self.inspect(project_id, false, &CancelToken::new())?;
                let mut tags: Vec<String> = inspection
                    .facts
                    .iter()
                    .filter_map(|f| f.tag().map(str::to_string))
                    .collect();
                tags.sort();
                tags.dedup();
                (Some(project.root), tags)
            }
            ContributionOrigin::LibraryItem { .. } | ContributionOrigin::LocalSkill { .. } => {
                (None, Vec::new())
            }
        };
        self.contributions()
            .start(source_id, origin, root.as_deref(), tags)
    }

    pub fn update_contribution(
        &self,
        id: &str,
        title: &str,
        message: &str,
        form: &ShareForm,
    ) -> Result<Contribution> {
        self.contributions().update(id, title, message, form)
    }

    /// Leaves changed files out of a contribution (or puts them back).
    pub fn select_contribution_files(&self, id: &str, excluded: &[String]) -> Result<Contribution> {
        self.contributions().select_files(id, excluded)
    }

    pub fn record_contribution_lineage(&self, id: &str, record: bool) -> Result<Contribution> {
        self.contributions().record_lineage(id, record)
    }

    pub fn commit_contribution(&self, id: &str, cancel: &CancelToken) -> Result<Contribution> {
        self.commit_contribution_with(id, false, cancel)
    }

    /// The project folder a contribution's skill lives in, if it came from
    /// a project that is still registered.
    fn contribution_project_root(&self, origin: &ContributionOrigin) -> Option<PathBuf> {
        match origin {
            ContributionOrigin::ProjectSkill { project_id, .. } => {
                self.existing_project(project_id).ok().map(|p| p.root)
            }
            _ => None,
        }
    }

    /// Prepares the branch. For a revision of a skill from My skills or a
    /// project, the skill is first copied again from where it lives, so edits
    /// made after "Revise" are included. `build_on_remote` is the user's
    /// choice to build on commits someone else pushed to the branch.
    pub fn commit_contribution_with(
        &self,
        id: &str,
        build_on_remote: bool,
        cancel: &CancelToken,
    ) -> Result<Contribution> {
        let c = self.contributions().preview(id)?;
        if c.revising {
            let root = self.contribution_project_root(&c.origin);
            self.contributions().resync(id, root.as_deref())?;
        }
        self.contributions()
            .commit_with(id, build_on_remote, cancel)
    }

    /// Reopens a sent contribution for changes after review. When the branch
    /// was sent, the request is checked on the host first; a merged or closed
    /// one cannot be revised.
    pub fn revise_contribution(&self, id: &str) -> Result<Contribution> {
        self.revise_contribution_with(id, &CancelToken::new())
    }

    /// `revise_contribution` with cancellation of the host check.
    pub fn revise_contribution_with(&self, id: &str, cancel: &CancelToken) -> Result<Contribution> {
        let c = self.contributions().preview(id)?;
        let root = self.contribution_project_root(&c.origin);
        self.contributions()
            .revise_with(id, root.as_deref(), cancel)
    }

    /// Backs out of a revision: back to the version that was prepared or
    /// sent before "Revise".
    pub fn cancel_contribution_revision(&self, id: &str) -> Result<Contribution> {
        self.cancel_contribution_revision_with(id, &CancelToken::new())
    }

    /// `cancel_contribution_revision` with cancellation of the Git reads that
    /// restore the earlier version (nothing is written until they finish).
    pub fn cancel_contribution_revision_with(
        &self,
        id: &str,
        cancel: &CancelToken,
    ) -> Result<Contribution> {
        self.contributions().cancel_revision(id, cancel)
    }

    /// Reads the review request's state and comments from the Git host.
    pub fn refresh_contribution_review(
        &self,
        id: &str,
        cancel: &CancelToken,
    ) -> Result<Contribution> {
        self.contributions().refresh_review(id, cancel)
    }

    pub fn publish_contribution(
        &self,
        id: &str,
        open_request: bool,
        cancel: &CancelToken,
    ) -> Result<PublishOutcome> {
        self.contributions().publish(id, open_request, cancel)
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}
