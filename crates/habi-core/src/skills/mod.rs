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

mod archive;
pub mod intake;
pub mod lineage;
pub mod machine;
pub mod upstream;

use crate::contribute::{ShareForm, apply_form, form_from, slug};
use crate::error::{HabiError, Result};
use crate::fsutil::{Bounded, atomic_write_mode, read_bounded, sha256};
use crate::library::model::{
    Diagnostic, DiagnosticCode, DiagnosticLevel, LibraryIndex, LibraryItem, MetadataStatus,
    SnapshotFile,
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
pub(crate) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEXT: usize = 512 * 1024;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

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
    /// Copied from a library item, to edit and contribute back.
    #[serde(rename_all = "camelCase")]
    Library {
        source_name: String,
        source_identity: String,
        item_id: String,
        snapshot: String,
        /// Where the original lives and who stands behind it, as it was when
        /// the copy was made. Absent on copies made before Habi recorded it.
        #[serde(default)]
        upstream: Option<Upstream>,
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

/// The original of an adopted skill, kept with the copy so it can always be
/// traced back, credited, and (if its owner allows) shared back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Upstream {
    /// The repository it came from (a web address), when it has one.
    pub url: Option<String>,
    /// The skill's folder in that repository.
    pub path: String,
    /// The licence the skill declares, else the repository's when known.
    pub license: Option<String>,
    /// Who publishes the repository, as the catalog names them.
    pub publisher: Option<String>,
    /// The catalog entry it came from, if any.
    pub catalog_id: Option<String>,
}

/// Optional starting structures for the instructions. Each is a shape that
/// works for an agent as written; the author fills in what is specific to
/// their code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SkillTemplate {
    #[default]
    Blank,
    /// A step-by-step procedure with a definition of done.
    Workflow,
    /// Narrowing a problem down from symptom to cause.
    Troubleshooting,
    /// Shown as "Code review".
    ReviewProcedure,
    /// A procedure built around scripts in the package.
    ToolAssisted,
    /// Still accepted for drafts made before the starters above; no longer offered.
    ImplementationGuide,
}

/// A line of a package file that matched a search.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileMatch {
    pub path: String,
    /// 1-based.
    pub line: u32,
    /// The line, trimmed and shortened.
    pub text: String,
}

/// A starter as the editor offers it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TemplateInfo {
    pub template: SkillTemplate,
    pub label: String,
    /// One line on when this shape fits.
    pub summary: String,
    pub body: String,
}

const WORKFLOW_BODY: &str = "\
## When to use this

Use this when …

## Steps

1. Read the relevant code before changing anything, and say which files you looked at.
2. 
3. 

## Done when

- The change builds and the existing tests pass.
- 

## Never

- Skip a step because it seems unnecessary — say why instead.
";

const TROUBLESHOOTING_BODY: &str = "\
## Symptoms

What the person sees: error messages, failing commands, wrong output.

- 

## First, gather facts

1. Reproduce the problem and record the exact command and output.
2. Note what changed recently (dependencies, configuration, environment).
3. 

## Likely causes, most common first

| Cause | How to confirm | Fix |
| --- | --- | --- |
|  |  |  |

## Report

Say which cause you confirmed and how, what you changed, and anything you ruled out.
Do not guess: if nothing was confirmed, say what to check next.
";

const REVIEW_BODY: &str = "\
## Before you start

- Read the change as a whole first; note its stated purpose.
- 

## Check

1. **Correctness** — does it do what it says, including edge cases and failure paths?
2. **Risk** — data loss, security, concurrency, compatibility.
3. **Fit** — follows this codebase's conventions: 
4. **Tests** — the behaviour that changed is covered.

## Report

List findings by severity, each with the file and line and why it matters.
Say what you checked, what you found, and what you could not verify.
";

const TOOL_ASSISTED_BODY: &str = "\
## Tools this uses

- `scripts/…` — what it does, what it reads and writes.

Read a script before running it. Run scripts only from this skill's folder.

## Steps

1. 
2. Run the script and read its output before acting on it.
3. 

## Never without asking

- Run anything that writes outside the project, deletes data, or uses the network.
- 

## Report

Say which commands you ran, what they printed, and what you concluded.
";

const IMPLEMENTATION_BODY: &str = "## Context\n\n\n\n## Steps\n\n1. \n\n## Done when\n\n- \n";

impl SkillTemplate {
    fn body(self) -> &'static str {
        match self {
            SkillTemplate::Blank => "",
            SkillTemplate::Workflow => WORKFLOW_BODY,
            SkillTemplate::Troubleshooting => TROUBLESHOOTING_BODY,
            SkillTemplate::ReviewProcedure => REVIEW_BODY,
            SkillTemplate::ToolAssisted => TOOL_ASSISTED_BODY,
            SkillTemplate::ImplementationGuide => IMPLEMENTATION_BODY,
        }
    }

    /// The starters the editor offers, in order.
    pub fn offered() -> Vec<TemplateInfo> {
        [
            (SkillTemplate::Blank, "Blank", "Start from an empty page."),
            (
                SkillTemplate::Workflow,
                "Step by step",
                "A procedure the agent follows step by step, with a clear finish.",
            ),
            (
                SkillTemplate::Troubleshooting,
                "Troubleshooting",
                "From a symptom to a confirmed cause, without guessing.",
            ),
            (
                SkillTemplate::ReviewProcedure,
                "Code review",
                "What to check in a change and how to report it.",
            ),
            (
                SkillTemplate::ToolAssisted,
                "Tool-assisted",
                "Steps built around scripts that ship with the skill.",
            ),
        ]
        .into_iter()
        .map(|(template, label, summary)| TemplateInfo {
            template,
            label: label.into(),
            summary: summary.into(),
            body: template.body().into(),
        })
        .collect()
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
    /// For an imported copy, whether its files differ from what was copied
    /// (or from the library version it last took). `None` for skills
    /// written here.
    pub modified_locally: Option<bool>,
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
    /// A `data:` URL for images Habi can show (PNG, JPEG, GIF, WebP, SVG
    /// under 2 MB). Shown in an `<img>`, where SVG scripts never run.
    pub preview: Option<String>,
}

const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;

/// The media type of an image Habi previews, by file extension.
fn image_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Where a file brought into a package belongs, from what it is: code an
/// agent runs goes in `scripts/`, writing an agent reads in `references/`,
/// a licence or notice at the root, and everything else (images, templates,
/// data) in `assets/`. Deterministic, so the author can predict it.
pub fn material_folder(name: &str, bytes: &[u8], executable: bool) -> &'static str {
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    if matches!(stem, "license" | "licence" | "notice" | "copying") {
        return "";
    }
    if executable || bytes.starts_with(b"#!") {
        return "scripts";
    }
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or_default();
    match ext {
        "py" | "sh" | "bash" | "zsh" | "js" | "mjs" | "cjs" | "ts" | "rb" | "pl" | "ps1" | "go"
        | "java" | "kt" | "groovy" | "gradle" | "sql" => "scripts",
        "md" | "markdown" | "txt" | "rst" | "adoc" | "pdf" | "html" | "htm" => "references",
        _ => "assets",
    }
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

/// Limits for reading a folder.
pub(crate) struct TreeLimits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    /// The folder may hold anything: build and dependency folders that are not
    /// part of a skill are not worth walking.
    pub discovery: bool,
    /// Stop at the limits and return what was read, instead of failing. For
    /// a caller that says the package is over its limits by itself.
    pub keep_partial: bool,
}

impl TreeLimits {
    pub const PACKAGE: TreeLimits = TreeLimits {
        max_files: MAX_FILES,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: MAX_TOTAL_BYTES,
        discovery: false,
        keep_partial: false,
    };
    pub const FOLDER: TreeLimits = TreeLimits {
        max_files: 5_000,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: 64 * 1024 * 1024,
        discovery: true,
        keep_partial: false,
    };
    /// A skill in My skills is opened even when it is over the package limits,
    /// or its files could never be removed to bring it back under them.
    const OPENING: TreeLimits = TreeLimits {
        max_files: 5_000,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: 64 * 1024 * 1024,
        discovery: false,
        keep_partial: true,
    };
}

/// Not walked when looking for skills in a folder. Inside a skill they are
/// content like any other, and Habi will not create them there (see
/// [`build_folder_in`]): the next read of a folder of skills would pass them by.
const BUILD_FOLDERS: &[&str] = &["node_modules", "target", ".venv", "__pycache__"];

fn inside_a_skill(root: &Path, dir: &Path) -> bool {
    dir.ancestors()
        .take_while(|d| d.starts_with(root))
        .any(|d| d.join(SKILL_FILE).is_file())
}

/// The build or dependency folder `rel` would create, if any. `is_folder` says
/// whether its last component is a folder too.
fn build_folder_in(rel: &RelPath, is_folder: bool) -> Option<&str> {
    let parts: Vec<&str> = rel.components().collect();
    let folders = parts.len() - usize::from(!is_folder);
    parts
        .into_iter()
        .take(folders)
        .find(|part| BUILD_FOLDERS.iter().any(|b| part.eq_ignore_ascii_case(b)))
}

fn refuse_build_folder(rel: &RelPath, name: &str) -> HabiError {
    HabiError::invalid(format!(
        "`{rel}` would put files in a folder named `{name}`, which Habi passes by when it reads a folder of skills, so they could go missing. Choose another name."
    ))
}

/// A path as a case-insensitive volume sees it.
fn fold(path: &str) -> String {
    crate::paths::fold_path(path)
}

/// Two of `paths` that would be one file on macOS and Windows, if any.
pub(crate) fn case_collision<'p>(
    paths: impl IntoIterator<Item = &'p String>,
) -> Option<(&'p str, &'p str)> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    for path in paths {
        if let Some(other) = seen.insert(fold(path), path) {
            return Some((other, path));
        }
    }
    None
}

pub(crate) fn collision_message(a: &str, b: &str) -> String {
    format!(
        "`{a}` and `{b}` differ only by upper and lower case, so they would be one file on macOS and Windows"
    )
}

/// Reports files that would overwrite each other on macOS and Windows. They
/// stay in the tree, so a package holding them can still be opened and fixed.
pub(crate) fn note_collisions(tree: &mut Tree) {
    let mut seen: HashMap<String, String> = HashMap::new();
    for path in tree.files.keys() {
        if let Some(other) = seen.insert(fold(path), path.clone())
            && !tree.skipped.iter().any(|d| d.path.as_deref() == Some(path))
        {
            tree.skipped.push(Diagnostic::error(
                format!(
                    "differs from `{other}` only by upper and lower case, so the two would be one file on macOS and Windows"
                ),
                Some(path),
            ));
        }
    }
}

fn total_bytes(tree: &Tree) -> u64 {
    tree.files.values().map(|b| b.len() as u64).sum()
}

/// Refuses a change that takes a package over its size limit. One that makes
/// an oversized package smaller is how it gets fixed, so it passes.
fn check_total(before: u64, after: u64) -> Result<()> {
    if after > MAX_TOTAL_BYTES && after > before {
        return Err(HabiError::invalid(format!(
            "that would take this skill to {} MiB; a skill may hold at most {} MiB. Remove some files first.",
            after.div_ceil(1024 * 1024),
            MAX_TOTAL_BYTES / 1024 / 1024
        )));
    }
    Ok(())
}

/// Reads a folder without following symbolic links. Links and oversized
/// files are reported in `skipped` rather than read; exceeding the overall
/// limits is an error so a truncated package is never mistaken for a whole one.
pub(crate) fn read_tree(root: &Path, limits: &TreeLimits) -> Result<Tree> {
    let mut tree = Tree::default();
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    let too_many = || {
        HabiError::Unsupported(format!(
            "{} holds more than {} files; choose a narrower folder",
            display_path(root),
            limits.max_files
        ))
    };
    let too_large = || {
        HabiError::Unsupported(format!(
            "{} is larger than {} MiB; choose a narrower folder",
            display_path(root),
            limits.max_total_bytes / 1024 / 1024
        ))
    };
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
                // Repository data, never content, and `RelPath` refuses it.
                if name == ".git" {
                    continue;
                }
                if !limits.discovery || !BUILD_FOLDERS.iter().any(|b| name == *b) {
                    stack.push(path);
                    continue;
                }
                if !inside_a_skill(root, &dir) {
                    continue;
                }
                // A skill's own: read it, but on its own limits, so one huge
                // folder marks that skill and does not stop the whole read.
                let Ok(inner) = read_tree(&path, &TreeLimits::PACKAGE) else {
                    tree.skipped.push(Diagnostic::error(
                        "is a build or dependency folder too large to copy; remove it to import this skill",
                        Some(&rel),
                    ));
                    continue;
                };
                total += total_bytes(&inner);
                tree.files.extend(
                    inner
                        .files
                        .into_iter()
                        .map(|(p, b)| (format!("{rel}/{p}"), b)),
                );
                tree.executables
                    .extend(inner.executables.iter().map(|p| format!("{rel}/{p}")));
                tree.skipped.extend(inner.skipped.into_iter().map(|d| {
                    let inside = d.path.as_deref().unwrap_or_default();
                    Diagnostic {
                        path: Some(format!("{rel}/{inside}")),
                        ..d
                    }
                }));
                if tree.files.len() > limits.max_files {
                    return Err(too_many());
                }
                if total > limits.max_total_bytes {
                    return Err(too_large());
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
                    if limits.keep_partial {
                        return Ok(tree);
                    }
                    return Err(too_many());
                }
                match read_bounded(&path, limits.max_file_bytes)? {
                    Bounded::Content(bytes) => {
                        total += bytes.len() as u64;
                        if total > limits.max_total_bytes {
                            if limits.keep_partial {
                                return Ok(tree);
                            }
                            return Err(too_large());
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
            } else {
                tree.skipped.push(Diagnostic::error(
                    "is not a regular file (a pipe, socket or device), which Habi does not read",
                    Some(&rel),
                ));
            }
        }
    }
    note_collisions(&mut tree);
    Ok(tree)
}

/// A package that could not be read within its limits, as far as it can be
/// said: its SKILL.md, for its name, and why the rest is not there. It reads
/// as incomplete, so it is shown and not imported.
pub(crate) fn unread_package(dir: &Path, why: &HabiError) -> Tree {
    let mut tree = Tree::default();
    if let Ok(Bounded::Content(bytes)) = read_bounded(&dir.join(SKILL_FILE), MAX_FILE_BYTES) {
        tree.files.insert(SKILL_FILE.into(), bytes);
    }
    tree.skipped
        .push(Diagnostic::error(format!("Not read: {why}."), None));
    tree
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
    let relative = |d: &Diagnostic| {
        let path = d
            .path
            .as_deref()
            .map(|p| p.strip_prefix(&lead).unwrap_or(p).to_string());
        // Rule problems are all fixed in one place.
        let code = d.code.or_else(|| {
            (d.level == DiagnosticLevel::Error
                && path.as_deref().is_some_and(|p| SIDECAR_FILES.contains(&p)))
            .then_some(DiagnosticCode::InvalidMetadata)
        });
        Diagnostic {
            path,
            code,
            ..d.clone()
        }
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
        let message = match d.path.as_deref() {
            Some(path) => format!("`{path}` {} (the package is incomplete)", d.message),
            // About the package as a whole.
            None => d.message.clone(),
        };
        Diagnostic::error(message, d.path.as_deref()).with_code(DiagnosticCode::UnreadableFile)
    }));
    Described {
        item,
        diagnostics,
        name,
        description,
    }
}

/// Why Habi will not edit a file: saving would replace what it cannot read.
fn not_utf8(file: &str) -> String {
    format!(
        "{file} is not UTF-8 text, and saving it here would replace the characters Habi cannot read. Convert it to UTF-8 in a text editor"
    )
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

/// `yaml` with the top-level `key` set to `value` (or gone, if it is empty).
/// Only that key's lines change. `None` if it cannot be written.
fn set_frontmatter_key(yaml: &str, key: &str, value: &str) -> Option<String> {
    let newline = if yaml.contains("\r\n") { "\r\n" } else { "\n" };
    let entry = if value.is_empty() {
        String::new()
    } else {
        let mut one = Map::new();
        one.insert(key.to_string(), json!(value));
        let written = serde_saphyr::to_string(&Value::Object(one)).ok()?;
        format!("{}{newline}", written.trim_end().replace('\n', newline))
    };
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let starts =
        |line: &&str, key: &str| line.strip_prefix(key).is_some_and(|r| r.starts_with(':'));
    let (from, to) = match lines.iter().position(|l| starts(l, key)) {
        Some(at) => {
            // Its value may go on, indented, on the lines below.
            let mut end = at + 1;
            for (i, line) in lines.iter().enumerate().skip(at + 1) {
                if line.trim().is_empty() {
                    continue;
                }
                if !line.starts_with([' ', '\t']) {
                    break;
                }
                end = i + 1;
            }
            (at, end)
        }
        // Where readers expect it: `name` first, `description` next.
        None => {
            let after = lines
                .iter()
                .position(|l| key != "name" && starts(l, "name"))
                .map_or(0, |at| at + 1);
            (after, after)
        }
    };
    let mut out: String = lines.iter().take(from).copied().collect();
    out.push_str(&entry);
    out.extend(lines.iter().skip(to).copied());
    Some(out)
}

/// The frontmatter text with some keys changed, leaving every other line as
/// written: comments, ordering, quoting and values such as `version: 1.10`,
/// which would not survive being parsed and written again. `None` if the
/// result would not read back as exactly `raw` with those changes.
fn edit_frontmatter(
    yaml: &str,
    raw: &Map<String, Value>,
    changes: &[(&str, &str)],
) -> Option<String> {
    let mut text = yaml.to_string();
    let mut expected = raw.clone();
    for (key, value) in changes {
        let current = raw.get(*key).and_then(Value::as_str).map(str::trim);
        if current.unwrap_or_default() == *value {
            continue;
        }
        text = set_frontmatter_key(&text, key, value)?;
        if value.is_empty() {
            expected.shift_remove(*key);
        } else {
            expected.insert((*key).to_string(), json!(value));
        }
    }
    let intact = if text.trim().is_empty() {
        expected.is_empty()
    } else {
        library::parse_yaml(&text).ok()?.as_object() == Some(&expected)
    };
    intact.then_some(text)
}

/// Edits changed top-level metadata entries without rewriting unrelated text.
fn edit_sidecar(text: &str, old: &Value, new: &Value) -> Result<String> {
    let mut out = text.to_string();
    let empty = Map::new();
    let old = old.as_object().unwrap_or(&empty);
    let new = new.as_object().unwrap_or(&empty);
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    for key in old
        .keys()
        .chain(new.keys().filter(|key| !old.contains_key(*key)))
    {
        if old.get(key) == new.get(key) {
            continue;
        }
        let lines: Vec<&str> = out.split_inclusive('\n').collect();
        let prefix = format!("{key}:");
        let start = lines.iter().position(|line| line.starts_with(&prefix));
        let mut end = start.map_or(lines.len(), |i| i + 1);
        if let Some(start) = start {
            while let Some(line) = lines.get(end) {
                // A list under a key may sit at the key's own indent.
                let nested = line.starts_with([' ', '\t'])
                    || line.starts_with("- ")
                    || line.trim_end() == "-";
                if !nested || line.trim_start().starts_with('#') {
                    break;
                }
                end += 1;
            }
            // A comment attached to a changed value needs the source editor. Only a `#` that
            // starts a word is a comment: `C#` and URL fragments are values.
            if lines.iter().take(end).skip(start).any(|line| {
                line.trim_start().starts_with('#') || line.contains(" #") || line.contains("\t#")
            }) {
                return Err(HabiError::invalid(
                    "Edit this habi.yaml value in the source view to keep its comments; nothing was overwritten.",
                ));
            }
        } else if old.contains_key(key) {
            return Err(HabiError::invalid(
                "Edit habi.yaml in the source view; Habi could not safely change its keys.",
            ));
        }
        let mut edited: String = lines
            .iter()
            .take(start.unwrap_or(lines.len()))
            .copied()
            .collect();
        if let Some(value) = new.get(key) {
            if !edited.is_empty() && !edited.ends_with('\n') {
                edited.push_str(newline);
            }
            let mut entry = Map::new();
            entry.insert(key.clone(), value.clone());
            let yaml = serde_saphyr::to_string(&Value::Object(entry))
                .map_err(|e| HabiError::Internal(e.to_string()))?;
            edited.push_str(&yaml.replace('\n', newline));
        }
        edited.extend(lines.iter().skip(end).copied());
        out = edited;
    }
    if library::parse_yaml(&out).ok().as_ref() != Some(&Value::Object(new.clone())) {
        return Err(HabiError::invalid(
            "Edit habi.yaml in the source view; Habi could not safely change its keys.",
        ));
    }
    Ok(out)
}

/// Replaces the YAML and the visible body, preserving the original envelope.
#[allow(
    clippy::string_slice,
    reason = "slices returned by split_frontmatter and trim_start_matches belong to text"
)]
fn splice_skill_md(text: &str, yaml: &str, body: &str) -> Result<String> {
    let (old_yaml, old_body) = library::split_frontmatter(text).map_err(HabiError::invalid)?;
    let yaml_start = old_yaml.as_ptr() as usize - text.as_ptr() as usize;
    let yaml_end = yaml_start + old_yaml.len();
    let visible_body = old_body.trim_start_matches(['\n', '\r']);
    let body_start = text.len() - visible_body.len();
    Ok(format!(
        "{}{yaml}{}{body}",
        &text[..yaml_start],
        &text[yaml_end..body_start]
    ))
}

fn frontmatter_source_error() -> HabiError {
    HabiError::invalid(
        "Habi could not safely change this frontmatter. Edit the frontmatter in the source view; nothing was overwritten.",
    )
}

/// Replaces `name` in a SKILL.md, keeping everything else.
pub(crate) fn rename_in_skill_md(text: &str, name: &str) -> Result<String> {
    let (front, body) = library::parse_frontmatter(text).map_err(HabiError::invalid)?;
    let (yaml, _) = library::split_frontmatter(text).map_err(HabiError::invalid)?;
    let edited = edit_frontmatter(yaml, &front.raw, &[("name", name)])
        .ok_or_else(frontmatter_source_error)?;
    splice_skill_md(text, &edited, body.trim_start_matches(['\n', '\r']))
}

/// One file of an imported copy as it was when Habi made it (or when it last
/// took an update from its library). The bytes are in the blob store, so the
/// copy's own changes stay inspectable even after its source is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaselineFile {
    pub path: String,
    pub digest: String,
    #[serde(default)]
    pub executable: bool,
}

/// Stores every file of `tree` in the blob store and lists them.
pub(crate) fn keep_baseline(paths: &AppPaths, tree: &Tree) -> Result<Vec<BaselineFile>> {
    let blobs = crate::store::cas::Blobs::new(&paths.blobs());
    tree.files
        .iter()
        .map(|(path, bytes)| {
            Ok(BaselineFile {
                path: path.clone(),
                digest: blobs.put(bytes)?,
                executable: tree.executables.contains(path),
            })
        })
        .collect()
}

/// Whether a package differs from its baseline, file by file.
fn differs_from(baseline: &[BaselineFile], files: &[SkillFileEntry]) -> bool {
    baseline.len() != files.len()
        || baseline.iter().any(|b| {
            !files
                .iter()
                .any(|f| f.path == b.path && f.digest == b.digest && f.executable == b.executable)
        })
}

/// Whether two existing paths are one file.
#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Whether two existing paths are one file. Canonical paths carry the name
/// as it is stored, however it was spelled here.
#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

struct Row {
    id: String,
    title: String,
    origin: SkillOrigin,
    origin_digest: Option<String>,
    baseline: Option<Vec<BaselineFile>>,
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
            "SELECT id, title, origin_json, origin_digest, created_at, updated_at, deleted_at,
                    baseline_json
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
                baseline: r
                    .get::<_, Option<String>>(7)?
                    .and_then(|json| serde_json::from_str(&json).ok()),
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
        let mut tree = read_tree(&dir, &TreeLimits::OPENING)?;
        // Over the limits it still opens, so its files can be removed; the
        // diagnostic keeps it from being installed, exported or shared meanwhile.
        let total = total_bytes(&tree);
        if tree.files.len() > MAX_FILES || total > MAX_TOTAL_BYTES {
            tree.skipped.push(Diagnostic::error(
                format!(
                    "This skill holds {} files and {} MiB; a skill may hold at most {MAX_FILES} files and {} MiB. Remove some of them to install, export or share it.",
                    tree.files.len(),
                    total.div_ceil(1024 * 1024),
                    MAX_TOTAL_BYTES / 1024 / 1024
                ),
                None,
            ));
        }
        Ok(tree)
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
        let not_text = skill_md.is_some_and(|b| std::str::from_utf8(b).is_err());
        if not_text {
            diagnostics.push(
                Diagnostic::error(not_utf8(SKILL_FILE), Some(SKILL_FILE))
                    .with_code(DiagnosticCode::UnreadableFile),
            );
        }
        let (document, document_error) = match library::parse_frontmatter(&text) {
            Ok((front, body)) => (
                SkillDocument {
                    name: front.name.unwrap_or_default(),
                    description: front.description.unwrap_or_default(),
                    body: body.trim_start_matches(['\n', '\r']).to_string(),
                },
                not_text.then(|| not_utf8(SKILL_FILE)),
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
            diagnostics.push(
                Diagnostic::warning("The instructions are empty.", Some(SKILL_FILE))
                    .with_code(DiagnosticCode::EmptyInstructions),
            );
        }
        if !document.name.is_empty()
            && row.deleted_at.is_none()
            && names
                .iter()
                .any(|(id, n)| id != &row.id && n == &document.name)
        {
            diagnostics.push(
                Diagnostic::error(
                    format!(
                        "Another of your skills already uses the identifier `{}`. Identifiers must be unique.",
                        document.name
                    ),
                    Some(SKILL_FILE),
                )
                .with_code(DiagnosticCode::DuplicateName),
            );
        }
        for (path, bytes) in &tree.files {
            if let Some(what) = crate::redact::looks_secret(&String::from_utf8_lossy(bytes)) {
                diagnostics.push(
                    Diagnostic::warning(
                        format!("{path} appears to contain {what}. Remove it before sharing."),
                        Some(path),
                    )
                    .with_code(DiagnosticCode::PossibleSecret),
                );
            }
        }
        let sidecar_name = SIDECAR_FILES
            .iter()
            .find(|s| tree.files.contains_key(**s))
            .copied();
        // "Exactly as stored" cannot be shown for bytes that are not text, and
        // what could be shown must not be saved back over them.
        let metadata_bytes = sidecar_name.and_then(|s| tree.files.get(s));
        let metadata_not_text = metadata_bytes.is_some_and(|b| std::str::from_utf8(b).is_err());
        if metadata_not_text {
            let name = sidecar_name.unwrap_or(SIDECAR_FILES[0]);
            diagnostics.push(
                Diagnostic::error(not_utf8(name), Some(name))
                    .with_code(DiagnosticCode::InvalidMetadata),
            );
        }
        let metadata_text = metadata_bytes
            .and_then(|b| std::str::from_utf8(b).ok())
            .map(str::to_string);
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
                modified_locally: match (&row.baseline, &row.origin_digest) {
                    (Some(baseline), _) => Some(differs_from(baseline, &files)),
                    (None, Some(origin)) => Some(origin != &content_digest),
                    (None, None) => None,
                },
                content_digest,
            },
            document_digest: skill_md.map(|b| sha256(b)),
            document,
            document_error,
            form,
            metadata_digest: sidecar_name
                .and_then(|s| tree.files.get(s))
                .map(|b| sha256(b)),
            metadata_text,
            metadata_status: if metadata_not_text {
                MetadataStatus::Invalid
            } else {
                item.map(|i| i.metadata_status)
                    .unwrap_or(MetadataStatus::Undeclared)
            },
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
        baseline: Option<&[BaselineFile]>,
    ) -> Result<String> {
        if tree.files.len() > MAX_FILES {
            return Err(HabiError::invalid(format!(
                "a skill may hold at most {MAX_FILES} files"
            )));
        }
        if let Some((a, b)) = case_collision(tree.files.keys()) {
            return Err(HabiError::invalid(collision_message(a, b)));
        }
        let id: String = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(12)
            .collect();
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
            "INSERT INTO local_skills (id, title, origin_json, origin_digest, created_at, updated_at,
                                       baseline_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
            params![
                id,
                title.trim().chars().take(120).collect::<String>(),
                serde_json::to_string(origin).map_err(|e| HabiError::Internal(e.to_string()))?,
                origin_digest,
                now,
                baseline
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|e| HabiError::Internal(e.to_string()))?,
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
        let id = self.insert(&title, &origin, None, &tree, None)?;
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
        let existing = match std::fs::read(&path) {
            Ok(bytes) => String::from_utf8(bytes)
                .map_err(|_| HabiError::invalid(format!("{}.", not_utf8(SKILL_FILE))))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(HabiError::io(format!("reading {SKILL_FILE}"), e)),
        };
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
                splice_skill_md(&existing, yaml, &document.body)?
            }
            Ok((yaml, front)) => {
                let changes = [("name", name), ("description", description)];
                match edit_frontmatter(yaml, &front.raw, &changes) {
                    Some(edited) => splice_skill_md(&existing, &edited, &document.body)?,
                    None => return Err(frontmatter_source_error()),
                }
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
    /// An empty form removes the file unless comments or unknown keys need
    /// keeping.
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
        // A file that does not read as metadata is the author's, half-written
        // perhaps. Taken for empty, it would be replaced or removed.
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut existing_text = None;
        let existing = match std::fs::read(&path) {
            Ok(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|_| HabiError::invalid(format!("{}.", not_utf8(&file))))?;
                let value = library::parse_yaml(&text).map_err(|e| {
                    HabiError::invalid(format!(
                        "{file} could not be read ({e}); fix it in {file} before changing the form"
                    ))
                })?;
                if !value.is_object() && !value.is_null() {
                    return Err(HabiError::invalid(format!(
                        "{file} does not hold a mapping of keys and values; fix it in {file} before changing the form"
                    )));
                }
                existing_text = Some(text);
                Some(value)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(HabiError::io(format!("reading {file}"), e)),
        };
        let name = self.names()?.remove(id).unwrap_or_default();
        let value = Self::form_to_sidecar(existing.clone(), form, &name)?;
        match value {
            Some(value) => {
                let yaml = match (&existing_text, &existing) {
                    (Some(text), Some(old)) => edit_sidecar(text, old, &value)?,
                    _ => {
                        let yaml = serde_saphyr::to_string(&value)
                            .map_err(|e| HabiError::Internal(e.to_string()))?;
                        format!("# Habi metadata — optional; the skill works without it\n{yaml}")
                    }
                };
                atomic_write_mode(&path, yaml.as_bytes(), None)?;
            }
            None => {
                if let (Some(text), Some(old)) = (&existing_text, &existing)
                    && text.contains('#')
                {
                    let yaml = edit_sidecar(text, old, &json!({"habi": 1}))?;
                    atomic_write_mode(&path, yaml.as_bytes(), None)?;
                } else if path.exists() {
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
        if let Ok(bytes) = std::fs::read(&path)
            && std::str::from_utf8(&bytes).is_err()
        {
            let file = path.file_name().unwrap_or_default().to_string_lossy();
            return Err(HabiError::invalid(format!("{}.", not_utf8(&file))));
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

    /// Lines of the package's text files that contain `query` (ignoring
    /// case), in path order, at most `MAX_MATCHES`. Reads only; nothing runs.
    pub fn search_files(&self, id: &str, query: &str) -> Result<Vec<FileMatch>> {
        const MAX_MATCHES: usize = 200;
        let needle = query.trim().to_lowercase();
        if needle.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let tree = self.tree(id)?;
        let mut out = Vec::new();
        for (path, bytes) in &tree.files {
            if !crate::fsutil::is_probably_text(bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(bytes);
            for (index, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    out.push(FileMatch {
                        path: path.clone(),
                        line: u32::try_from(index + 1).unwrap_or(u32::MAX),
                        text: line.trim().chars().take(160).collect(),
                    });
                    if out.len() >= MAX_MATCHES {
                        return Ok(out);
                    }
                }
            }
        }
        Ok(out)
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
        let preview = image_type(rel.as_str())
            .filter(|_| bytes.len() <= PREVIEW_LIMIT)
            .map(|mime| format!("data:{mime};base64,{}", crate::fsutil::base64(&bytes)));
        Ok(SkillFileContent {
            path: rel.to_string(),
            size: bytes.len() as u32,
            digest: sha256(&bytes),
            text: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()),
            binary,
            preview,
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
        if base_digest.is_none()
            && let Some(name) = build_folder_in(&rel, false)
        {
            return Err(refuse_build_folder(&rel, name));
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
        if base_digest.is_none()
            && let Some(other) = tree.files.keys().find(|p| fold(p) == fold(rel.as_str()))
        {
            return Err(HabiError::Conflict(format!(
                "{}; rename it, or choose another name",
                collision_message(other, rel.as_str())
            )));
        }
        let before = total_bytes(&tree);
        let replaced = tree.files.get(rel.as_str()).map_or(0, |b| b.len() as u64);
        check_total(before, before - replaced + text.len() as u64)?;
        atomic_write_mode(&path, text.as_bytes(), None)?;
        self.touch(id)?;
        self.get(id)
    }

    /// Copies files chosen by the user into `folder` of the package
    /// (`references`, `scripts`, `assets`, or empty for the package root).
    /// `auto` places each file by what it is (see [`material_folder`]).
    /// Existing files are never replaced.
    pub fn add_files(&self, id: &str, folder: &str, sources: &[PathBuf]) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let tree = self.tree(id)?;
        if tree.files.len() + sources.len() > MAX_FILES {
            return Err(HabiError::invalid(format!(
                "a skill may hold at most {MAX_FILES} files"
            )));
        }
        // By their folded names: two files that differ only by case would
        // overwrite each other on macOS and Windows.
        let mut taken: HashMap<String, String> =
            tree.files.keys().map(|p| (fold(p), p.clone())).collect();
        let before = total_bytes(&tree);
        let mut after = before;
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
            let bytes = match read_bounded(source, MAX_FILE_BYTES)? {
                Bounded::Content(b) => b,
                Bounded::TooLarge(n) => {
                    return Err(HabiError::invalid(format!(
                        "{name} is {n} bytes; skill files may be at most {MAX_FILE_BYTES} bytes"
                    )));
                }
            };
            let executable = crate::fsutil::is_executable(source);
            let into = if folder == "auto" {
                material_folder(&name, &bytes, executable)
            } else {
                folder.trim()
            };
            let rel = if into.is_empty() {
                RelPath::new(&name)?
            } else {
                RelPath::new(into)?.join(&name)?
            };
            if let Some(name) = build_folder_in(&rel, false) {
                return Err(refuse_build_folder(&rel, name));
            }
            let target = resolve_for_write(&dir, &rel)?;
            if let Some(other) = taken.get(&fold(rel.as_str()))
                && other != rel.as_str()
            {
                return Err(HabiError::Conflict(format!(
                    "{}; rename one first",
                    collision_message(other, rel.as_str())
                )));
            }
            if target.exists() || taken.contains_key(&fold(rel.as_str())) {
                return Err(HabiError::Conflict(format!(
                    "`{rel}` already exists in this skill; rename or remove it first"
                )));
            }
            taken.insert(fold(rel.as_str()), rel.to_string());
            after += bytes.len() as u64;
            planned.push((target, bytes, executable));
        }
        check_total(before, after)?;
        for (target, bytes, executable) in planned {
            atomic_write_mode(&target, &bytes, Some(executable))?;
        }
        self.touch(id)?;
        self.get(id)
    }

    /// Removes a supporting file, or a folder with everything in it.
    /// SKILL.md (and so the package root) cannot be removed.
    pub fn remove_path(&self, id: &str, rel: &str) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let rel = RelPath::new(rel)?;
        if rel.as_str().eq_ignore_ascii_case(SKILL_FILE) {
            return Err(HabiError::invalid("a skill needs its SKILL.md"));
        }
        let path = crate::paths::resolve_for_read(&dir, &rel)?
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))?;
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| HabiError::io(format!("removing {rel}"), e))?;
        } else {
            std::fs::remove_file(&path).map_err(|e| HabiError::io(format!("removing {rel}"), e))?;
        }
        Self::prune_empty_parents(&dir, &path);
        self.touch(id)?;
        self.get(id)
    }

    /// Renames or moves a file or folder inside the package. Nothing is
    /// replaced: the destination must not exist. SKILL.md stays where it is.
    pub fn rename_path(&self, id: &str, from: &str, to: &str) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let from = RelPath::new(from)?;
        let to = RelPath::new(to)?;
        if from.as_str().eq_ignore_ascii_case(SKILL_FILE)
            || to.as_str().eq_ignore_ascii_case(SKILL_FILE)
        {
            return Err(HabiError::invalid("SKILL.md keeps its name and place"));
        }
        let case_only = fold(from.as_str()) == fold(to.as_str());
        if to.starts_with(&from)
            || (!case_only && fold(to.as_str()).starts_with(&format!("{}/", fold(from.as_str()))))
        {
            return Err(HabiError::invalid(format!(
                "`{from}` cannot move into itself"
            )));
        }
        let source = crate::paths::resolve_for_read(&dir, &from)?
            .ok_or_else(|| HabiError::NotFound(from.to_string()))?;
        if let Some(name) = build_folder_in(&to, source.is_dir())
            && !from.components().any(|part| part == name)
        {
            return Err(refuse_build_folder(&to, name));
        }
        let target = resolve_for_write(&dir, &to)?;
        // `notes.md` to `Notes.md`: on a case-insensitive volume the destination
        // "exists" because it is the file being renamed.
        if std::fs::symlink_metadata(&target).is_ok() && !(case_only && same_file(&source, &target))
        {
            return Err(HabiError::Conflict(format!(
                "`{to}` already exists in this skill"
            )));
        }
        if let Some(other) = self
            .tree(id)?
            .files
            .keys()
            .find(|p| fold(p) == fold(to.as_str()) && p.as_str() != from.as_str())
        {
            return Err(HabiError::Conflict(format!(
                "{}; choose another name",
                collision_message(other, to.as_str())
            )));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| HabiError::io(format!("creating {}", display_path(parent)), e))?;
        }
        std::fs::rename(&source, &target)
            .map_err(|e| HabiError::io(format!("renaming {from} to {to}"), e))?;
        Self::prune_empty_parents(&dir, &source);
        self.touch(id)?;
        self.get(id)
    }

    /// Marks a file as executable (scripts the agent runs directly) or not.
    pub fn set_executable(&self, id: &str, rel: &str, executable: bool) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let rel = RelPath::new(rel)?;
        let path = crate::paths::resolve_for_read(&dir, &rel)?
            .filter(|p| p.is_file())
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))?;
        crate::fsutil::set_executable(&path, executable)?;
        self.touch(id)?;
        self.get(id)
    }

    /// Replaces a file's content with a file the user picked (a new version
    /// of an image, say). Its executable bit is kept.
    pub fn replace_file(&self, id: &str, rel: &str, source: &Path) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let (_, dir) = self.editable(id)?;
        let rel = RelPath::new(rel)?;
        if rel.as_str().eq_ignore_ascii_case(SKILL_FILE) {
            return Err(HabiError::invalid("edit SKILL.md in the editor instead"));
        }
        let target = crate::paths::resolve_for_read(&dir, &rel)?
            .filter(|p| p.is_file())
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))?;
        let meta = std::fs::symlink_metadata(source)
            .map_err(|e| HabiError::io(format!("reading {}", display_path(source)), e))?;
        if !meta.is_file() {
            return Err(HabiError::invalid(format!(
                "{} is not a regular file",
                display_path(source)
            )));
        }
        let bytes = match read_bounded(source, MAX_FILE_BYTES)? {
            Bounded::Content(b) => b,
            Bounded::TooLarge(n) => {
                return Err(HabiError::invalid(format!(
                    "{} is {n} bytes; skill files may be at most {MAX_FILE_BYTES} bytes",
                    display_path(source)
                )));
            }
        };
        let tree = self.tree(id)?;
        let before = total_bytes(&tree);
        let replaced = tree.files.get(rel.as_str()).map_or(0, |b| b.len() as u64);
        check_total(before, before - replaced + bytes.len() as u64)?;
        atomic_write_mode(&target, &bytes, Some(crate::fsutil::is_executable(&target)))?;
        self.touch(id)?;
        self.get(id)
    }

    /// The package path of a file, for opening it in a text editor.
    pub fn file_path(&self, id: &str, rel: &str) -> Result<PathBuf> {
        let dir = package_dir(self.paths, id)?;
        self.row(id)?;
        let rel = RelPath::new(rel)?;
        crate::paths::resolve_for_read(&dir, &rel)?
            .filter(|p| p.is_file())
            .ok_or_else(|| HabiError::NotFound(rel.to_string()))
    }

    /// Drops folders a removal or move left empty, up to the package root.
    fn prune_empty_parents(root: &Path, removed: &Path) {
        let mut parent = removed.parent();
        while let Some(p) = parent {
            if p == root || std::fs::remove_dir(p).is_err() {
                break;
            }
            parent = p.parent();
        }
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

    /// Takes a skill out of the trash. If another skill took its identifier
    /// meanwhile, this one comes back under a free one: two skills with one
    /// identifier would both stop being installable.
    pub fn restore(&self, id: &str) -> Result<LocalSkill> {
        let _lock = self.lock(id)?;
        let row = self.row(id)?;
        if row.deleted_at.is_some() {
            self.free_identifier(id)?;
        }
        self.store.conn()?.execute(
            "UPDATE local_skills SET deleted_at = NULL WHERE id = ?1",
            [id],
        )?;
        self.get(id)
    }

    /// Renames a skill in the trash if its identifier is in use by another.
    fn free_identifier(&self, id: &str) -> Result<()> {
        let path = package_dir(self.paths, id)?.join(SKILL_FILE);
        let Ok(Bounded::Content(bytes)) = read_bounded(&path, MAX_FILE_BYTES) else {
            return Ok(());
        };
        let text = String::from_utf8_lossy(&bytes);
        let Some(name) = library::parse_frontmatter(&text)
            .ok()
            .and_then(|(front, _)| front.name)
        else {
            return Ok(());
        };
        if !self.names()?.values().any(|n| n == &name) {
            return Ok(());
        }
        let free = self.free_name(&name)?;
        if free.is_empty() {
            return Ok(());
        }
        if std::str::from_utf8(&bytes).is_err() {
            return Err(HabiError::invalid(format!(
                "Another skill uses the identifier `{name}`, and {}. Rename the other skill first, or convert this one.",
                not_utf8(SKILL_FILE)
            )));
        }
        atomic_write_mode(&path, rename_in_skill_md(&text, &free)?.as_bytes(), None)
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

    /// The package as one zip archive at `dest` (replaced if it is there),
    /// its files under a folder named by the identifier. Only a skill that
    /// is ready can be exported.
    pub fn export_zip(&self, id: &str, dest: &Path) -> Result<PathBuf> {
        let (item, tree) = self.installable(id)?;
        let bytes = archive::zip(
            &item.name,
            &tree.files,
            &tree.executables,
            archive::local_now(),
        )?;
        atomic_write_mode(dest, &bytes, Some(false))?;
        Ok(dest.to_path_buf())
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
