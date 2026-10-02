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
    LOCAL_SOURCE_ID, LOCAL_SOURCE_NAME, LocalSkill, NewSkill, SkillOrigin, Skills, Tree, TreeLimits,
};
use crate::source::{Freshness, Source, SourceKind, Sources, TrackedRef, portable_identity};
use crate::store::{AppPaths, Store};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use ts_rs::TS;

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
    pub at: String,
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
    check_previews: Mutex<HashMap<String, StoredCheck>>,
    /// `gh`/`glab` for review requests; tests point these at stand-ins.
    pub review_tools: ReviewTools,
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
            check_previews: Mutex::new(HashMap::new()),
            review_tools,
        })
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
        let sample_root = crate::paths::canonical(self.paths.root.join("sample"))
            .unwrap_or_else(|_| self.paths.root.join("sample"));
        conn.query_row(
            "SELECT id, path, name, last_opened_at, exclusions_json FROM projects WHERE id = ?1",
            [id],
            |r| {
                let path: String = r.get(1)?;
                let root = PathBuf::from(&path);
                Ok(ProjectRecord {
                    summary: None,
                    sample: root.starts_with(&sample_root),
                    id: r.get(0)?,
                    name: r.get(2)?,
                    path: crate::paths::display_path(&root),
                    exists: root.is_dir(),
                    last_opened_at: r.get(3)?,
                    exclusions: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                    root,
                })
            },
        )
        .optional()?
        .ok_or_else(|| HabiError::NotFound(format!("project {id}")))
        .map(|mut p| {
            p.summary = self
                .store
                .setting(&summary_key(id))
                .ok()
                .flatten()
                .and_then(|json| serde_json::from_str(&json).ok());
            p
        })
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
        // Cloned out first: the staleness check reads the file system, and
        // the cache stays available to other threads meanwhile.
        let cached = (!rescan)
            .then(|| {
                self.inspections
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(id)
                    .cloned()
            })
            .flatten();
        // A cheap re-check (sizes and modification times of manifests,
        // lockfiles and listed directories) catches edits, added or removed
        // files and branch switches since the last scan.
        if let Some(cached) = cached
            && !cached.is_stale()
        {
            return Ok(cached);
        }
        let project = self.existing_project(id)?;
        let options = WalkOptions {
            exclusions: project.exclusions.clone(),
            ..Default::default()
        };
        let inspection = inspect(&project.root, &options, cancel)?;
        self.inspections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_string(), inspection.clone());
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
                out.push((self.local_source(&index.snapshot), index))
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "could not read local skills"),
        }
        Ok(out)
    }

    pub fn skills(&self) -> Skills<'_> {
        Skills {
            paths: &self.paths,
            store: &self.store,
        }
    }

    fn local_source(&self, snapshot: &str) -> Source {
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
        }
    }

    fn source_of(&self, source_id: &str) -> Result<Source> {
        if source_id == LOCAL_SOURCE_ID {
            let (index, _) = self.skills().library()?;
            return Ok(self.local_source(&index.snapshot));
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
                String::from_utf8_lossy(&bytes[..bytes.len().min(512 * 1024)]).into_owned()
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
        let libraries = self.libraries()?;
        let installations = self.installations(&project.root, &lock, &libraries);
        let mut candidates = Vec::new();
        let identities: Vec<String> = libraries
            .iter()
            .map(|(s, _)| portable_identity(s))
            .collect();
        for ((source, index), identity) in libraries.iter().zip(&identities) {
            for item in &index.items {
                candidates.push(Candidate {
                    item,
                    source_name: &source.name,
                    source_identity: identity,
                    snapshot: &index.snapshot,
                    runs: checks::runs(&self.store, id, &item.key)?,
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
            ProjectSummary {
                fits,
                needs_information,
                sources: by_source.into_iter().map(|(s, _)| s).collect(),
                installed: recommendations
                    .iter()
                    .filter(|r| r.installation.is_some())
                    .count() as u32,
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
        decisions: &Decisions,
    ) -> Result<Plan> {
        let p = self.existing_project(project)?;
        let libraries = self.libraries()?;
        let payloads = keys
            .iter()
            .map(|k| self.payload_for_key(k, &libraries))
            .collect::<Result<Vec<_>>>()?;
        Ok(self.keep(plan::plan_update(&p.root, &payloads, decisions)?))
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
        result
    }

    pub fn apply_plan(&self, plan: &Plan) -> Result<OperationSummary> {
        let result = self.applier().apply(plan);
        self.invalidate_for_root(&plan.root);
        result
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

    fn packages(&self, from: &ImportFrom, cancel: &CancelToken) -> Result<(String, Vec<Package>)> {
        match from {
            ImportFrom::Project { project_id } => {
                let p = self.existing_project(project_id)?;
                let knowledge = self.discover(project_id, cancel)?;
                // A skill Habi installed from a library keeps that library and
                // the installed version as its origin, so edits can go back
                // to it (and later library changes can be compared).
                let lock = crate::install::plan::read_lock(&p.root).unwrap_or_default();
                let mine = portable_identity(&self.local_source(""));
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
            ImportFrom::Library { source_id } => {
                if source_id == LOCAL_SOURCE_ID {
                    return Err(HabiError::invalid("those skills are already yours"));
                }
                let source = self.sources.get(source_id)?;
                let index = self.sources.index(source_id)?;
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
                            source_name: source.name.clone(),
                            source_identity: portable_identity(&source),
                            item_id: item.id.clone(),
                            snapshot: index.snapshot.clone(),
                        },
                        title: Some(item.title.clone()),
                    });
                }
                Ok((source.name, packages))
            }
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

    fn preview_conditions(
        &self,
        request: &PreviewRequest,
    ) -> Result<(Option<Condition>, Option<Condition>, Scope)> {
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
            Ok((parse("applies_when")?, parse("excludes")?, scope))
        };
        if let Some(text) = &request.metadata_text {
            if text.trim().is_empty() {
                return Ok((None, None, Scope::Module));
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
                None => Ok((None, None, Scope::Module)),
            };
        }
        match stored {
            Some(s) => Ok((s.applies_when, s.excludes, s.scope)),
            None => Ok((None, None, Scope::Module)),
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
        let (applies_when, excludes, scope) = match self.preview_conditions(request) {
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
        for project in self.recent_projects()?.into_iter().filter(|p| p.exists) {
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
                    ProjectPreview {
                        result: Some(assess(
                            applies_when.as_ref(),
                            excludes.as_ref(),
                            scope,
                            &inspection,
                            &declarations,
                        )),
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
        self.contributions()
            .cancel_revision(id, &CancelToken::new())
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
