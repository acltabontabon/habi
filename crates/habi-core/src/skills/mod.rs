//! Local skills ("My skills"): drafts and imported, editable copies.
//!
//! Each local skill is a standard Agent Skills package — `SKILL.md` plus
//! optional references, scripts and assets, with an optional `habi.yaml` for
//! applicability — stored as ordinary files in `<data>/skills/<id>/package`.
//! The files are the content; the database row only records identity, the
//! display title, where the skill came from and whether it is in the trash.
//!
//! Ownership rules this module keeps:
//! - A skill discovered in a project or folder stays where it is; importing
//!   makes an independent copy here and never changes the original.
//! - Saving a draft never installs or publishes anything.
//! - Every save names the version of the file the editor loaded. If the file
//!   changed on disk since (another editor, the CLI), the save is refused with
//!   a `conflict` instead of overwriting.
//! - Nothing here executes package content.

pub mod intake;

use crate::contribute::{ShareForm, apply_form, form_from, slug};
use crate::error::{HabiError, Result};
use crate::fsutil::{Bounded, atomic_write_mode, read_bounded, sha256};
use crate::library::model::{
    Diagnostic, DiagnosticLevel, LibraryIndex, LibraryItem, MetadataStatus, SnapshotFile,
};
use crate::library::{self, SIDECAR_FILES, SKILL_FILE};
use crate::matching::Scope;
use crate::matching::condition::Condition;
use crate::paths::{RelPath, display_path, resolve_for_write};
use crate::store::{AppPaths, ResourceLock, Store};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

/// Source id under which local skills appear next to team libraries.
pub const LOCAL_SOURCE_ID: &str = "local";
pub const LOCAL_SOURCE_NAME: &str = "My skills";

pub(crate) const MAX_FILES: usize = 200;
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TEXT: usize = 512 * 1024;

/// Where a local skill came from. Attribution only; never used for matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum SkillOrigin {
    /// Written in Habi.
    Created,
    /// Written in Habi while looking at a project.
    #[serde(rename_all = "camelCase")]
    CreatedForProject { project_name: String },
    /// Copied from a folder on this machine.
    #[serde(rename_all = "camelCase")]
    Folder { path: String },
    /// Copied from a skill found in a project.
    #[serde(rename_all = "camelCase")]
    Project { project_name: String, path: String },
    /// Copied from a team library item, to edit and contribute back.
    #[serde(rename_all = "camelCase")]
    Library {
        source_name: String,
        source_identity: String,
        item_id: String,
        snapshot: String,
    },
    /// Started from text selected in a project's instruction file.
    #[serde(rename_all = "camelCase")]
    Instructions {
        project_name: String,
        path: String,
        start_line: u32,
        end_line: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SkillTemplate {
    #[default]
    Blank,
    ReviewProcedure,
    ImplementationGuide,
}

impl SkillTemplate {
    fn body(self) -> &'static str {
        match self {
            SkillTemplate::Blank => "",
            SkillTemplate::ReviewProcedure => {
                "## Before you start\n\n- \n\n## Review steps\n\n1. \n\n## Report\n\nSay what you checked, what you found, and what you could not verify.\n"
            }
            SkillTemplate::ImplementationGuide => {
                "## Context\n\n\n\n## Steps\n\n1. \n\n## Done when\n\n- \n"
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewSkill {
    pub title: String,
    pub description: String,
    pub template: SkillTemplate,
}

/// The parts of SKILL.md the editor works on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillDocument {
    /// The skill identifier (`name` in the Agent Skills format).
    pub name: String,
    pub description: String,
    /// Markdown instructions, without frontmatter.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalSkillSummary {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub origin: SkillOrigin,
    pub created_at: String,
    pub updated_at: String,
    /// Set while the skill is in the trash.
    pub deleted_at: Option<String>,
    /// Problems that block installing, exporting and sharing.
    pub errors: u32,
    pub warnings: u32,
    pub has_applicability: bool,
    pub file_count: u32,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillFileEntry {
    pub path: String,
    pub size: u32,
    pub digest: String,
    pub executable: bool,
    pub text: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillFileContent {
    pub path: String,
    pub text: Option<String>,
    pub size: u32,
    pub binary: bool,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalSkill {
    pub summary: LocalSkillSummary,
    pub document: SkillDocument,
    /// Digest of SKILL.md as loaded; saves must name it.
    pub document_digest: Option<String>,
    /// Set when SKILL.md cannot be read as frontmatter plus body. The file
    /// is then edited as plain text until it parses again.
    pub document_error: Option<String>,
    /// Applicability in the form the condition builder edits.
    pub form: ShareForm,
    /// `habi.yaml` exactly as stored, if present.
    pub metadata_text: Option<String>,
    pub metadata_digest: Option<String>,
    pub metadata_status: MetadataStatus,
    pub applies_when: Option<Condition>,
    pub excludes: Option<Condition>,
    pub scope: Scope,
    pub files: Vec<SkillFileEntry>,
    pub diagnostics: Vec<Diagnostic>,
    /// Display path of the package folder.
    pub location: String,
}

/// Files of a skill package (or any folder) read into memory.
#[derive(Debug, Clone, Default)]
pub(crate) struct Tree {
    pub files: BTreeMap<String, Vec<u8>>,
    pub executables: BTreeSet<String>,
    /// Entries that were not read (links, oversized files), by path.
    pub skipped: Vec<Diagnostic>,
}

impl Tree {
    /// The files under `prefix/`, with the prefix removed.
    pub fn subtree(&self, prefix: &str) -> Tree {
        if prefix.is_empty() {
            return self.clone();
        }
        let p = format!("{prefix}/");
        Tree {
            files: self
                .files
                .iter()
                .filter_map(|(k, v)| k.strip_prefix(&p).map(|r| (r.to_string(), v.clone())))
                .collect(),
            executables: self
                .executables
                .iter()
                .filter_map(|k| k.strip_prefix(&p).map(str::to_string))
                .collect(),
            skipped: self
                .skipped
                .iter()
                .filter_map(|d| {
                    let rel = d.path.as_deref()?.strip_prefix(&p)?;
                    Some(Diagnostic {
                        path: Some(rel.to_string()),
                        ..d.clone()
                    })
                })
                .collect(),
        }
    }
}

/// Limits for reading a folder that may hold several skills.
pub(crate) struct TreeLimits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

impl TreeLimits {
    pub const PACKAGE: TreeLimits = TreeLimits {
        max_files: MAX_FILES,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: 16 * 1024 * 1024,
    };
    pub const FOLDER: TreeLimits = TreeLimits {
        max_files: 5_000,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: 64 * 1024 * 1024,
    };
}

const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", ".venv", "__pycache__"];

/// Reads a folder without following symbolic links. Links and oversized
/// files are reported in `skipped` rather than read; exceeding the overall
/// limits is an error so a truncated package is never mistaken for a whole one.
pub(crate) fn read_tree(root: &Path, limits: &TreeLimits) -> Result<Tree> {
    let mut tree = Tree::default();
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| HabiError::io(format!("reading {}", display_path(&dir)), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| HabiError::io("reading the folder", e))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|e| HabiError::io(format!("reading {rel}"), e))?;
            if meta.file_type().is_symlink() {
                tree.skipped.push(Diagnostic::error(
                    "is a symbolic link, which Habi does not follow",
                    Some(&rel),
                ));
            } else if meta.is_dir() {
                let name = entry.file_name();
                if !SKIPPED_DIRS.iter().any(|s| name == *s) {
                    stack.push(path);
                }
            } else if meta.is_file() {
                if rel.starts_with(".habi-tmp-") || rel.contains("/.habi-tmp-") {
                    continue;
                }
                if RelPath::new(&rel).is_err() {
                    tree.skipped.push(Diagnostic::error(
                        "has a name Habi cannot store safely",
                        Some(&rel),
                    ));
                    continue;
                }
                if tree.files.len() >= limits.max_files {
                    return Err(HabiError::Unsupported(format!(
                        "{} holds more than {} files; choose a narrower folder",
                        display_path(root),
                        limits.max_files
                    )));
                }
                match read_bounded(&path, limits.max_file_bytes)? {
                    Bounded::Content(bytes) => {
                        total += bytes.len() as u64;
                        if total > limits.max_total_bytes {
                            return Err(HabiError::Unsupported(format!(
                                "{} is larger than {} MiB; choose a narrower folder",
                                display_path(root),
                                limits.max_total_bytes / 1024 / 1024
                            )));
                        }
                        if crate::fsutil::is_executable(&path) {
                            tree.executables.insert(rel.clone());
                        }
                        tree.files.insert(rel, bytes);
                    }
                    Bounded::TooLarge(n) => tree.skipped.push(Diagnostic::error(
                        format!(
                            "is {n} bytes, above the {}-byte limit for skill files",
                            limits.max_file_bytes
                        ),
                        Some(&rel),
                    )),
                }
            }
        }
    }
    Ok(tree)
}

/// Indexes a tree as a library whose files sit under `prefix` (empty for the
/// tree root), using the same reader as team libraries.
pub(crate) fn index_tree(tree: &Tree, prefix: &str, source_id: &str) -> LibraryIndex {
    let full = |rel: &str| {
        if prefix.is_empty() {
            rel.to_string()
        } else {
            format!("{prefix}/{rel}")
        }
    };
    let list: Vec<SnapshotFile> = tree
        .files
        .iter()
        .map(|(p, b)| SnapshotFile {
            path: full(p),
            digest: sha256(b),
            size: b.len() as u64,
            executable: tree.executables.contains(p),
        })
        .collect();
    let lead = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    library::build_index(source_id, "local", &list, &|path| {
        let rel = path.strip_prefix(&lead).unwrap_or(path);
        tree.files
            .get(rel)
            .cloned()
            .ok_or_else(|| format!("{path} missing"))
    })
}

/// A package indexed on its own: the skill item (if SKILL.md exists) and
/// every diagnostic, with paths relative to the package.
pub(crate) struct Described {
    pub item: Option<LibraryItem>,
    pub diagnostics: Vec<Diagnostic>,
    pub name: String,
    pub description: String,
}

pub(crate) fn describe_tree(tree: &Tree) -> Described {
    let front = tree
        .files
        .get(SKILL_FILE)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .and_then(|t| library::parse_frontmatter(&t).ok().map(|(fm, _)| fm));
    let name = front
        .as_ref()
        .and_then(|f| f.name.clone())
        .unwrap_or_default();
    let description = front
        .as_ref()
        .and_then(|f| f.description.clone())
        .unwrap_or_default();
    let valid_name = library::check_skill_name(&name).is_ok();
    // Index under the skill's own name, as it will sit when installed or
    // shared, so directory-name checks reflect that layout.
    let dir = if valid_name { name.as_str() } else { "skill" };
    let index = index_tree(tree, dir, LOCAL_SOURCE_ID);
    let lead = format!("{dir}/");
    let relative = |d: &Diagnostic| Diagnostic {
        path: d
            .path
            .as_deref()
            .map(|p| p.strip_prefix(&lead).unwrap_or(p).to_string()),
        ..d.clone()
    };
    let item = index.items.into_iter().next();
    let mut diagnostics: Vec<Diagnostic> = item
        .iter()
        .flat_map(|i| i.diagnostics.iter())
        .chain(index.diagnostics.iter())
        .filter(|d| valid_name || !d.message.contains("differs from the directory name"))
        .map(relative)
        .collect();
    if !tree.files.contains_key(SKILL_FILE) {
        diagnostics.push(Diagnostic::error(
            "SKILL.md is missing, so this is not a skill package",
            Some(SKILL_FILE),
        ));
    }
    diagnostics.extend(tree.skipped.iter().map(|d| {
        Diagnostic::error(
            format!(
                "`{}` {} (the package is incomplete)",
                d.path.as_deref().unwrap_or("a file"),
                d.message
            ),
            d.path.as_deref(),
        )
    }));
    Described {
        item,
        diagnostics,
        name,
        description,
    }
}

fn count(diags: &[Diagnostic], level: DiagnosticLevel) -> u32 {
    diags.iter().filter(|d| d.level == level).count() as u32
}

/// `<data>/skills/<id>/package`, after checking `id` is a plain identifier.
pub(crate) fn package_dir(paths: &AppPaths, id: &str) -> Result<PathBuf> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(HabiError::invalid("invalid skill id"));
    }
    Ok(paths.skills().join(id).join("package"))
}

/// Renders SKILL.md from a frontmatter mapping and a Markdown body.
pub(crate) fn render_skill_md(front: &Map<String, Value>, body: &str) -> Result<String> {
    let yaml = serde_saphyr::to_string(&Value::Object(front.clone()))
        .map_err(|e| HabiError::Internal(format!("could not write the frontmatter: {e}")))?;
    Ok(compose_skill_md(&yaml, body))
}

fn compose_skill_md(yaml: &str, body: &str) -> String {
    let body = body.trim_start_matches(['\n', '\r']);
    let mut out = String::with_capacity(yaml.len() + body.len() + 16);
    out.push_str("---\n");
    out.push_str(yaml.trim_end());
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body);
        if !body.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// Replaces `name` in a SKILL.md, keeping everything else.
pub(crate) fn rename_in_skill_md(text: &str, name: &str) -> Result<String> {
    let (front, body) = library::parse_frontmatter(text).map_err(HabiError::invalid)?;
    let mut raw = front.raw;
    raw.insert("name".into(), json!(name));
    // Keep `name` first, where readers expect it.
    let mut ordered = Map::new();
    ordered.insert("name".into(), json!(name));
    for (k, v) in raw {
        if k != "name" {
            ordered.insert(k, v);
        }
    }
    render_skill_md(&ordered, body)
}

struct Row {
    id: String,
    title: String,
    origin: SkillOrigin,
    origin_digest: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

pub struct Skills<'a> {
    pub paths: &'a AppPaths,
    pub store: &'a Store,
}

impl<'a> Skills<'a> {
    fn lock(&self, id: &str) -> Result<ResourceLock> {
        ResourceLock::acquire(self.paths, &format!("skill-{id}"), Duration::from_secs(3))
    }

    fn rows(&self) -> Result<Vec<Row>> {
        let conn = self.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, origin_json, origin_digest, created_at, updated_at, deleted_at
             FROM local_skills ORDER BY updated_at DESC, id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                title: r.get(1)?,
                origin: serde_json::from_str(&r.get::<_, String>(2)?)
                    .unwrap_or(SkillOrigin::Created),
                origin_digest: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                deleted_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn row(&self, id: &str) -> Result<Row> {
        self.rows()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| HabiError::NotFound(format!("skill {id}")))
    }

    fn touch(&self, id: &str) -> Result<()> {
        self.store.conn()?.execute(
            "UPDATE local_skills SET updated_at = ?2 WHERE id = ?1",
            params![id, crate::time::now()],
        )?;
        Ok(())
    }

    fn tree(&self, id: &str) -> Result<Tree> {
        let dir = package_dir(self.paths, id)?;
        if !dir.is_dir() {
            return Ok(Tree::default());
        }
        read_tree(&dir, &TreeLimits::PACKAGE)
    }

    /// Identifiers in use by skills that are not in the trash, by skill id.
    fn names(&self) -> Result<HashMap<String, String>> {
        let mut out = HashMap::new();
        for row in self.rows()?.into_iter().filter(|r| r.deleted_at.is_none()) {
            let path = package_dir(self.paths, &row.id)?.join(SKILL_FILE);
            if let Ok(Bounded::Content(bytes)) = read_bounded(&path, MAX_FILE_BYTES)
                && let Ok((front, _)) = library::parse_frontmatter(&String::from_utf8_lossy(&bytes))
                && let Some(name) = front.name
            {
                out.insert(row.id, name);
            }
        }
        Ok(out)
    }

    fn describe(&self, row: &Row, tree: &Tree, names: &HashMap<String, String>) -> LocalSkill {
        let described = describe_tree(tree);
        let mut diagnostics = described.diagnostics;
        let skill_md = tree.files.get(SKILL_FILE);
        let text = skill_md
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        let (document, document_error) = match library::parse_frontmatter(&text) {
            Ok((front, body)) => (
                SkillDocument {
                    name: front.name.unwrap_or_default(),
                    description: front.description.unwrap_or_default(),
                    body: body.trim_start_matches(['\n', '\r']).to_string(),
                },
                None,
            ),
            Err(e) => (
                SkillDocument {
                    body: text.clone(),
                    ..Default::default()
                },
                Some(if skill_md.is_none() {
                    "SKILL.md is missing from the package".to_string()
                } else {
                    e
                }),
            ),
        };
        if document_error.is_none() && document.body.trim().is_empty() {
            diagnostics.push(Diagnostic::warning(
                "The instructions are empty.",
                Some(SKILL_FILE),
            ));
        }
        if !document.name.is_empty()
            && row.deleted_at.is_none()
            && names
                .iter()
                .any(|(id, n)| id != &row.id && n == &document.name)
        {
            diagnostics.push(Diagnostic::error(
                format!(
                    "Another of your skills already uses the identifier `{}`. Identifiers must be unique.",
                    document.name
                ),
                Some(SKILL_FILE),
            ));
        }
        for (path, bytes) in &tree.files {
            if let Some(what) = crate::redact::looks_secret(&String::from_utf8_lossy(bytes)) {
                diagnostics.push(Diagnostic::warning(
                    format!("{path} appears to contain {what}. Remove it before sharing."),
                    Some(path),
                ));
            }
        }
        let sidecar_name = SIDECAR_FILES
            .iter()
            .find(|s| tree.files.contains_key(**s))
            .copied();
        let metadata_text =
            sidecar_name.map(|s| String::from_utf8_lossy(&tree.files[s]).into_owned());
        let sidecar = metadata_text
            .as_deref()
            .and_then(|t| library::parse_yaml(t).ok());
        let fallback_title = if row.title.trim().is_empty() {
            library::humanize(&document.name)
        } else {
            row.title.clone()
        };
        let mut form = form_from(sidecar.as_ref(), &fallback_title);
        if form.title.trim().is_empty() {
            form.title = fallback_title.clone();
        }
        let item = described.item.as_ref();
        let has_applicability =
            item.is_some_and(|i| i.applies_when.is_some() || i.excludes.is_some());
        let files: Vec<SkillFileEntry> = tree
            .files
            .iter()
            .map(|(path, bytes)| SkillFileEntry {
                path: path.clone(),
                size: bytes.len() as u32,
                digest: sha256(bytes),
                executable: tree.executables.contains(path),
                text: crate::fsutil::is_probably_text(bytes),
            })
            .collect();
        let content_digest = item.map(|i| i.content_digest.clone()).unwrap_or_else(|| {
            crate::fsutil::tree_digest(files.iter().map(|f| (f.path.as_str(), f.digest.as_str())))
        });
        let dir = package_dir(self.paths, &row.id).unwrap_or_default();
        LocalSkill {
            summary: LocalSkillSummary {
                id: row.id.clone(),
                name: document.name.clone(),
                title: form.title.clone(),
                description: document.description.clone(),
                origin: row.origin.clone(),
                created_at: row.created_at.clone(),
                updated_at: row.updated_at.clone(),
                deleted_at: row.deleted_at.clone(),
                errors: count(&diagnostics, DiagnosticLevel::Error),
                warnings: count(&diagnostics, DiagnosticLevel::Warning),
                has_applicability,
                file_count: files.len() as u32,
                content_digest,
            },
            document_digest: skill_md.map(|b| sha256(b)),
            document,
            document_error,
            form,
            metadata_digest: sidecar_name.map(|s| sha256(&tree.files[s])),
            metadata_text,
            metadata_status: item
                .map(|i| i.metadata_status)
                .unwrap_or(MetadataStatus::Undeclared),
            applies_when: item.and_then(|i| i.applies_when.clone()),
            excludes: item.and_then(|i| i.excludes.clone()),
            scope: item.map(|i| i.scope).unwrap_or_default(),
            files,
            diagnostics,
            location: display_path(&dir),
        }
    }

    /// Every local skill, most recently changed first (trash included, marked).
    pub fn list(&self) -> Result<Vec<LocalSkillSummary>> {
        let names = self.names()?;
        let mut out = Vec::new();
        for row in self.rows()? {
            let tree = match self.tree(&row.id) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(skill = %row.id, error = %e, "could not read a local skill");
                    Tree::default()
                }
            };
            out.push(self.describe(&row, &tree, &names).summary);
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<LocalSkill> {
        let row = self.row(id)?;
        let tree = self.tree(id)?;
        Ok(self.describe(&row, &tree, &self.names()?))
    }

    /// An identifier derived from `wanted` that no other local skill uses.
    pub(crate) fn free_name(&self, wanted: &str) -> Result<String> {
        let taken: BTreeSet<String> = self.names()?.into_values().collect();
        let base = if library::check_skill_name(wanted).is_ok() {
            wanted.to_string()
        } else {
            slug(wanted)
        };
        if base.is_empty() {
            return Ok(String::new());
        }
        if !taken.contains(&base) {
            return Ok(base);
        }
        for n in 2..1000 {
            let stem: String = base.chars().take(60).collect();
            let candidate = format!("{}-{n}", stem.trim_end_matches('-'));
            if !taken.contains(&candidate) {
                return Ok(candidate);
            }
        }
        Err(HabiError::Conflict(format!(
            "no free identifier like `{base}`"
        )))
    }

    /// Stores a package as a new local skill and returns its id.
    pub(crate) fn insert(
        &self,
        title: &str,
        origin: &SkillOrigin,
        origin_digest: Option<&str>,
        tree: &Tree,
    ) -> Result<String> {
        if tree.files.len() > MAX_FILES {
            return Err(HabiError::invalid(format!(
                "a skill may hold at most {MAX_FILES} files"
            )));
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let dir = package_dir(self.paths, &id)?;
        let written = (|| -> Result<()> {
            for (rel, bytes) in &tree.files {
                let rel_path = RelPath::new(rel)?;
                atomic_write_mode(
                    &resolve_for_write(&dir, &rel_path)?,
                    bytes,
                    Some(tree.executables.contains(rel)),
                )?;
            }
            Ok(())
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_dir_all(self.paths.skills().join(&id));
            return Err(e);
        }
        let now = crate::time::now();
        self.store.conn()?.execute(
            "INSERT INTO local_skills (id, title, origin_json, origin_digest, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id,
                title.trim().chars().take(120).collect::<String>(),
                serde_json::to_string(origin).map_err(|e| HabiError::Internal(e.to_string()))?,
                origin_digest,
                now
            ],
        )?;
        Ok(id)
    }

    /// Creates a draft. Nothing is required: an empty title is a valid start.
    pub fn create(&self, new: &NewSkill, origin: SkillOrigin) -> Result<LocalSkill> {
        self.create_with_body(new, origin, new.template.body(), None)
    }

    pub(crate) fn create_with_body(
        &self,
        new: &NewSkill,
        origin: SkillOrigin,
        body: &str,
        derived_from: Option<&str>,
    ) -> Result<LocalSkill> {
        let title: String = new.title.trim().chars().take(120).collect();
        let name = self.free_name(&title)?;
        let mut front = Map::new();
        if !name.is_empty() {
            front.insert("name".into(), json!(name));
        }
        let description = new.description.trim();
        if !description.is_empty() {
            front.insert("description".into(), json!(description));
        }
        if let Some(from) = derived_from {
            front.insert("metadata".into(), json!({ "derived-from": from }));
        }
        let mut tree = Tree::default();
        tree.files.insert(
            SKILL_FILE.into(),
            render_skill_md(&front, body)?.into_bytes(),
        );
        let id = self.insert(&title, &origin, None, &tree)?;
        self.get(&id)
    }

    /// Fails with `conflict` unless the file on disk is the version the
    /// caller loaded (`base`), or is absent when the caller expects that.
    fn check_base(path: &Path, base: Option<&str>, what: &str) -> Result<()> {
        let current = match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(HabiError::PathEscape(what.to_string()));
            }
            Ok(_) => match read_bounded(path, MAX_FILE_BYTES)? {
                Bounded::Content(bytes) => Some(sha256(&bytes)),
                Bounded::TooLarge(_) => Some(String::new()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(HabiError::io(format!("reading {what}"), e)),
        };
        if current.as_deref() == base {
            return Ok(());
        }
        Err(HabiError::Conflict(match (current, base) {
            (None, Some(_)) => format!(
                "{what} was removed outside Habi since you opened it. Reload to see the current state, or keep your version to write it again."
            ),
            _ => format!(
                "{what} was changed outside Habi since you opened it. Reload to see that version, or keep yours to replace it."
            ),
        }))
    }

    fn editable(&self, id: &str) -> Result<(Row, PathBuf)> {
        let row = self.row(id)?;
        if row.deleted_at.is_some() {
            return Err(HabiError::invalid(
                "this skill is in the trash; restore it to edit it",
            ));
        }
        Ok((row, package_dir(self.paths, id)?))
    }

    /// Saves the name, description, instructions and display title.
    /// Frontmatter the editor does not know about is kept.
    pub fn save_document(
        &self,
        id: &str,
        title: &str,
        document: &SkillDocument,
        base_digest: Option<&str>,
    ) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let path = dir.join(SKILL_FILE);
        Self::check_base(&path, base_digest, SKILL_FILE)?;
        if document.name.len() > 200
            || document.description.len() > 8 * 1024
            || document.body.len() > MAX_TEXT
        {
            return Err(HabiError::invalid("that is too long to save in SKILL.md"));
        }
        let existing = std::fs::read(&path)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let name = document.name.trim();
        let description = document.description.trim();
        let text = match library::split_frontmatter(&existing)
            .and_then(|(yaml, _)| library::parse_frontmatter(&existing).map(|(fm, _)| (yaml, fm)))
        {
            // Unchanged name and description: keep the frontmatter text as
            // written (comments, ordering, quoting) and replace only the body.
            Ok((yaml, front))
                if front.name.as_deref().unwrap_or("") == name
                    && front.description.as_deref().unwrap_or("") == description =>
            {
                compose_skill_md(yaml, &document.body)
            }
            Ok((_, front)) => {
                let mut ordered = Map::new();
                if !name.is_empty() {
                    ordered.insert("name".into(), json!(name));
                }
                if !description.is_empty() {
                    ordered.insert("description".into(), json!(description));
                }
                for (k, v) in front.raw {
                    if k != "name" && k != "description" {
                        ordered.insert(k, v);
                    }
                }
                render_skill_md(&ordered, &document.body)?
            }
            Err(_) if existing.trim().is_empty() => {
                let mut front = Map::new();
                if !name.is_empty() {
                    front.insert("name".into(), json!(name));
                }
                if !description.is_empty() {
                    front.insert("description".into(), json!(description));
                }
                render_skill_md(&front, &document.body)?
            }
            Err(e) => {
                return Err(HabiError::invalid(format!(
                    "{e}. Open SKILL.md under Files to repair it; nothing was overwritten."
                )));
            }
        };
        atomic_write_mode(&path, text.as_bytes(), None)?;
        self.store.conn()?.execute(
            "UPDATE local_skills SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                id,
                title.trim().chars().take(120).collect::<String>(),
                crate::time::now()
            ],
        )?;
        self.get(id)
    }

    fn sidecar_path(dir: &Path) -> PathBuf {
        SIDECAR_FILES
            .iter()
            .map(|s| dir.join(s))
            .find(|p| p.exists())
            .unwrap_or_else(|| dir.join(SIDECAR_FILES[0]))
    }

    /// Turns the condition builder's form into the sidecar value, keeping
    /// fields the form does not edit. `None` means no metadata is needed.
    pub(crate) fn form_to_sidecar(
        existing: Option<Value>,
        form: &ShareForm,
        name: &str,
    ) -> Result<Option<Value>> {
        let mut blank = form.clone();
        blank.title = String::new();
        let mut value = apply_form(existing, &blank);
        let only_version = value
            .as_object()
            .is_some_and(|m| m.keys().all(|k| k == "habi"));
        if only_version {
            return Ok(None);
        }
        // A display title is worth recording only next to other metadata, and
        // only when it says more than the identifier does.
        let title = form.title.trim();
        if !title.is_empty()
            && title != library::humanize(name)
            && let Some(map) = value.as_object_mut()
        {
            let mut ordered = Map::new();
            ordered.insert("habi".into(), json!(1));
            ordered.insert("title".into(), json!(title));
            for (k, v) in std::mem::take(map) {
                if k != "habi" && k != "title" {
                    ordered.insert(k, v);
                }
            }
            *map = ordered;
        }
        if let Err(errors) = library::schema::validate_skill(&value) {
            return Err(HabiError::invalid(errors.join("; ")));
        }
        for key in ["applies_when", "excludes"] {
            if let Some(c) = value.get(key) {
                Condition::parse(c).map_err(|e| HabiError::invalid(format!("`{key}`: {e}")))?;
            }
        }
        Ok(Some(value))
    }

    /// Saves applicability from the condition builder into `habi.yaml`.
    /// When the form is empty, no metadata file is kept: the skill stays a
    /// plain, portable package.
    pub fn save_applicability(
        &self,
        id: &str,
        form: &ShareForm,
        base_digest: Option<&str>,
    ) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let path = Self::sidecar_path(&dir);
        Self::check_base(&path, base_digest, "habi.yaml")?;
        let existing = std::fs::read(&path)
            .ok()
            .and_then(|b| library::parse_yaml(&String::from_utf8_lossy(&b)).ok());
        let name = self.names()?.remove(id).unwrap_or_default();
        match Self::form_to_sidecar(existing, form, &name)? {
            Some(value) => {
                let yaml = serde_saphyr::to_string(&value)
                    .map_err(|e| HabiError::Internal(e.to_string()))?;
                atomic_write_mode(
                    &path,
                    format!("# Habi metadata — optional; the skill works without it\n{yaml}")
                        .as_bytes(),
                    None,
                )?;
            }
            None => {
                if path.exists() {
                    std::fs::remove_file(&path)
                        .map_err(|e| HabiError::io("removing habi.yaml", e))?;
                }
            }
        }
        self.store.conn()?.execute(
            "UPDATE local_skills SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                id,
                form.title.trim().chars().take(120).collect::<String>(),
                crate::time::now()
            ],
        )?;
        self.get(id)
    }

    /// Saves `habi.yaml` exactly as typed (the advanced view). Invalid
    /// metadata is still saved — it is the author's draft — and reported.
    pub fn save_metadata_text(
        &self,
        id: &str,
        text: &str,
        base_digest: Option<&str>,
    ) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let path = Self::sidecar_path(&dir);
        Self::check_base(&path, base_digest, "habi.yaml")?;
        if text.len() > MAX_TEXT {
            return Err(HabiError::invalid("habi.yaml is too large"));
        }
        if text.trim().is_empty() {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| HabiError::io("removing habi.yaml", e))?;
            }
        } else {
            atomic_write_mode(&path, text.as_bytes(), None)?;
        }
        self.touch(id)?;
        self.get(id)
    }

    pub fn read_file(&self, id: &str, rel: &str) -> Result<SkillFileContent> {
        let dir = package_dir(self.paths, id)?;
        self.row(id)?;
        let rel = RelPath::new(rel)?;
        let path = crate::paths::resolve_for_read(&dir, &rel)?
            .filter(|p| p.is_file())
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))?;
        let bytes = match read_bounded(&path, MAX_FILE_BYTES)? {
            Bounded::Content(b) => b,
            Bounded::TooLarge(n) => {
                return Err(HabiError::invalid(format!("{rel} is {n} bytes; too large")));
            }
        };
        let binary = !crate::fsutil::is_probably_text(&bytes);
        Ok(SkillFileContent {
            path: rel.to_string(),
            size: bytes.len() as u32,
            digest: sha256(&bytes),
            text: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()),
            binary,
        })
    }

    /// Writes a text file in the package (a reference, a script, or SKILL.md
    /// as plain text). `base_digest` is `None` when creating a new file.
    pub fn write_file(
        &self,
        id: &str,
        rel: &str,
        text: &str,
        base_digest: Option<&str>,
    ) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let rel = RelPath::new(rel)?;
        if text.len() > MAX_TEXT {
            return Err(HabiError::invalid(format!("{rel} is too large to save")));
        }
        let path = resolve_for_write(&dir, &rel)?;
        if path.is_dir() {
            return Err(HabiError::Conflict(format!("`{rel}` is a folder")));
        }
        if base_digest.is_none() && path.exists() {
            return Err(HabiError::Conflict(format!(
                "`{rel}` already exists in this skill"
            )));
        }
        Self::check_base(&path, base_digest, rel.as_str())?;
        let tree = self.tree(id)?;
        if base_digest.is_none() && tree.files.len() >= MAX_FILES {
            return Err(HabiError::invalid(format!(
                "a skill may hold at most {MAX_FILES} files"
            )));
        }
        atomic_write_mode(&path, text.as_bytes(), None)?;
        self.touch(id)?;
        self.get(id)
    }

    /// Copies files chosen by the user into `folder` of the package
    /// (`references`, `scripts`, `assets`, or empty for the package root).
    /// Existing files are never replaced.
    pub fn add_files(&self, id: &str, folder: &str, sources: &[PathBuf]) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let existing = self.tree(id)?.files.len();
        if existing + sources.len() > MAX_FILES {
            return Err(HabiError::invalid(format!(
                "a skill may hold at most {MAX_FILES} files"
            )));
        }
        let mut planned = Vec::new();
        for source in sources {
            let meta = std::fs::symlink_metadata(source)
                .map_err(|e| HabiError::io(format!("reading {}", display_path(source)), e))?;
            if !meta.is_file() {
                return Err(HabiError::invalid(format!(
                    "{} is not a regular file",
                    display_path(source)
                )));
            }
            let name = source
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let rel = if folder.trim().is_empty() {
                RelPath::new(&name)?
            } else {
                RelPath::new(folder)?.join(&name)?
            };
            let target = resolve_for_write(&dir, &rel)?;
            if target.exists() {
                return Err(HabiError::Conflict(format!(
                    "`{rel}` already exists in this skill; rename or remove it first"
                )));
            }
            let bytes = match read_bounded(source, MAX_FILE_BYTES)? {
                Bounded::Content(b) => b,
                Bounded::TooLarge(n) => {
                    return Err(HabiError::invalid(format!(
                        "{name} is {n} bytes; skill files may be at most {MAX_FILE_BYTES} bytes"
                    )));
                }
            };
            planned.push((target, bytes, crate::fsutil::is_executable(source)));
        }
        for (target, bytes, executable) in planned {
            atomic_write_mode(&target, &bytes, Some(executable))?;
        }
        self.touch(id)?;
        self.get(id)
    }

    /// Removes a supporting file. SKILL.md cannot be removed.
    pub fn remove_file(&self, id: &str, rel: &str) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let rel = RelPath::new(rel)?;
        if rel.as_str() == SKILL_FILE {
            return Err(HabiError::invalid("a skill needs its SKILL.md"));
        }
        let path = crate::paths::resolve_for_read(&dir, &rel)?
            .filter(|p| p.is_file())
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))?;
        std::fs::remove_file(&path).map_err(|e| HabiError::io(format!("removing {rel}"), e))?;
        // Drop folders the removal left empty.
        let mut parent = path.parent();
        while let Some(p) = parent {
            if p == dir || std::fs::remove_dir(p).is_err() {
                break;
            }
            parent = p.parent();
        }
        self.touch(id)?;
        self.get(id)
    }

    /// Moves a skill to the trash. Its files stay on disk until purged.
    pub fn trash(&self, id: &str) -> Result<()> {
        self.row(id)?;
        self.store.conn()?.execute(
            "UPDATE local_skills SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, crate::time::now()],
        )?;
        Ok(())
    }

    pub fn restore(&self, id: &str) -> Result<LocalSkill> {
        self.row(id)?;
        self.store.conn()?.execute(
            "UPDATE local_skills SET deleted_at = NULL WHERE id = ?1",
            [id],
        )?;
        self.get(id)
    }

    /// Permanently removes a skill that is already in the trash.
    pub fn purge(&self, id: &str) -> Result<()> {
        let _lock = self.lock(id)?;
        let row = self.row(id)?;
        if row.deleted_at.is_none() {
            return Err(HabiError::invalid("move the skill to the trash first"));
        }
        package_dir(self.paths, id)?;
        let dir = self.paths.skills().join(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| HabiError::io("removing the skill", e))?;
        }
        self.store
            .conn()?
            .execute("DELETE FROM local_skills WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The skill as an installable library item with its files, after
    /// checking it is a valid standard package.
    pub(crate) fn installable(&self, id: &str) -> Result<(LibraryItem, Tree)> {
        let row = self.row(id)?;
        let tree = self.tree(id)?;
        let skill = self.describe(&row, &tree, &self.names()?);
        let errors: Vec<&Diagnostic> = skill
            .diagnostics
            .iter()
            .filter(|d| d.level == DiagnosticLevel::Error)
            .collect();
        if let Some(first) = errors.first() {
            return Err(HabiError::invalid(format!(
                "“{}” is not ready yet: {}{}",
                skill.summary.title,
                first.message,
                if errors.len() > 1 {
                    format!(" (and {} more)", errors.len() - 1)
                } else {
                    String::new()
                }
            )));
        }
        let mut item = describe_tree(&tree)
            .item
            .ok_or_else(|| HabiError::invalid("the skill has no SKILL.md"))?;
        item.title = skill.summary.title.clone();
        Ok((item, tree))
    }

    /// Writes the package as `<dest>/<name>/…`: a plain Agent Skills folder
    /// that works without Habi. Refuses to replace an existing folder.
    pub fn export(&self, id: &str, dest: &Path) -> Result<PathBuf> {
        let (item, tree) = self.installable(id)?;
        let dest = crate::paths::canonical_dir(dest)?;
        let target = dest.join(&item.name);
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(HabiError::Conflict(format!(
                "{} already exists; choose another folder or remove it first",
                display_path(&target)
            )));
        }
        for (rel, bytes) in &tree.files {
            let rel_path = RelPath::new(rel)?;
            atomic_write_mode(
                &resolve_for_write(&target, &rel_path)?,
                bytes,
                Some(tree.executables.contains(rel)),
            )?;
        }
        Ok(target)
    }

    /// Local skills that are valid packages, as one library index. Items
    /// are keyed by their identifier, so they can be matched to projects,
    /// installed and updated like team library items.
    pub fn library(&self) -> Result<(LibraryIndex, HashMap<String, String>)> {
        let names = self.names()?;
        let mut items: Vec<LibraryItem> = Vec::new();
        let mut ids = HashMap::new();
        for row in self.rows()?.into_iter().filter(|r| r.deleted_at.is_none()) {
            let Ok(tree) = self.tree(&row.id) else {
                continue;
            };
            let skill = self.describe(&row, &tree, &names);
            if skill.summary.errors > 0 {
                continue;
            }
            let Some(mut item) = describe_tree(&tree).item else {
                continue;
            };
            if items.iter().any(|i| i.id == item.id) {
                continue;
            }
            item.title = skill.summary.title.clone();
            ids.insert(item.id.clone(), row.id.clone());
            items.push(item);
        }
        items.sort_by_key(|i| i.title.to_lowercase());
        let snapshot = crate::fsutil::tree_digest(
            items
                .iter()
                .map(|i| (i.id.as_str(), i.content_digest.as_str())),
        );
        Ok((
            LibraryIndex {
                source_id: LOCAL_SOURCE_ID.into(),
                snapshot,
                name: Some(LOCAL_SOURCE_NAME.into()),
                owner: None,
                description: None,
                contact: None,
                items,
                diagnostics: Vec::new(),
            },
            ids,
        ))
    }

    /// Reads `<name>/<rel>` from the local library.
    pub fn read_library_file(&self, library_path: &str) -> Result<Vec<u8>> {
        let (name, rel) = library_path
            .split_once('/')
            .ok_or_else(|| HabiError::NotFound(library_path.to_string()))?;
        let (_, ids) = self.library()?;
        let id = ids
            .get(name)
            .ok_or_else(|| HabiError::NotFound(format!("skill `{name}`")))?;
        let dir = package_dir(self.paths, id)?;
        let rel = RelPath::new(rel)?;
        let path = crate::paths::resolve_for_read(&dir, &rel)?
            .filter(|p| p.is_file())
            .ok_or_else(|| HabiError::NotFound(library_path.to_string()))?;
        match read_bounded(&path, MAX_FILE_BYTES)? {
            Bounded::Content(b) => Ok(b),
            Bounded::TooLarge(_) => Err(HabiError::invalid(format!("{rel} is too large"))),
        }
    }

    pub(crate) fn origin_digests(&self) -> Result<Vec<(String, Option<String>)>> {
        Ok(self
            .rows()?
            .into_iter()
            .filter(|r| r.deleted_at.is_none())
            .map(|r| (r.id, r.origin_digest))
            .collect())
    }
}
