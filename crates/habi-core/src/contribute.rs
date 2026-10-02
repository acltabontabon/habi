//! Preparing contributions back to a team library.
//!
//! The flow is explicit at every step:
//! 1. `start` copies a chosen skill (an installed copy with local edits, a
//!    skill folder in a project, or a library item) into an isolated staging
//!    area in Habi's data directory. Nothing else is collected.
//! 2. `update` applies the author's form (title, applicability, exclusions,
//!    prerequisites, examples) by writing `habi.yaml` in the staging area.
//! 3. `preview` lists exactly the files that would leave the machine, the
//!    diff against the library and validation results (including a secret scan).
//! 4. `commit` creates a commit on a contribution branch *inside Habi's own
//!    bare cache* using Git plumbing — the developer's checkout and branch are
//!    never touched, and no hook, filter or checkout runs.
//! 5. The author then exports a patch, or explicitly publishes: push the
//!    branch and, where `gh`/`glab` is installed and authenticated, open a
//!    pull/merge request. Habi never merges and never pushes to the tracked
//!    branch.

use crate::cancel::CancelToken;
use crate::error::{GitFailure, HabiError, Result};
use crate::fsutil::{Bounded, atomic_write, read_bounded, sha256};
use crate::install::diff::{TextDiff, diff};
use crate::library::model::{Diagnostic, DiagnosticLevel, SnapshotFile};
use crate::library::{self, SIDECAR_FILES, SKILL_FILE};
use crate::paths::{RelPath, display_path, resolve_for_read};
pub use crate::review::{RemoteRepo, remote_repo};
use crate::review::{ReviewHost, ReviewState, ReviewStatus, ReviewTools};
use crate::source::git::Git;
use crate::source::{SourceKind, Sources, TrackedRef};
use crate::store::{AppPaths, Store};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

const MAX_FILES: usize = 200;
/// A skill folder's files by path.
type Files = BTreeMap<String, Vec<u8>>;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum ContributionOrigin {
    /// A skill folder inside a project (installed by Habi or not).
    #[serde(rename_all = "camelCase")]
    ProjectSkill {
        project_id: String,
        /// Project-relative folder containing SKILL.md.
        path: String,
    },
    /// An existing library item, to improve its metadata.
    #[serde(rename_all = "camelCase")]
    LibraryItem { item_id: String },
    /// A skill from "My skills" (a local draft or imported copy).
    #[serde(rename_all = "camelCase")]
    LocalSkill { skill_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ContributionState {
    Draft,
    Committed,
    Exported,
    Published,
    Discarded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MatchMode {
    #[default]
    All,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolEntry {
    pub name: String,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExampleEntry {
    pub title: String,
    pub description: String,
}

/// The author-facing form. Turned into `habi.yaml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShareForm {
    pub title: String,
    pub owner: String,
    pub repository_scope: bool,
    /// False when the existing conditions are richer than this form can
    /// express; they are then kept unchanged.
    pub conditions_editable: bool,
    pub match_mode: MatchMode,
    pub applies_tags: Vec<String>,
    pub applies_dependencies: Vec<String>,
    pub applies_files: Vec<String>,
    pub exclude_tags: Vec<String>,
    pub exclude_dependencies: Vec<String>,
    pub tools: Vec<ToolEntry>,
    pub examples: Vec<ExampleEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DraftFileStatus {
    Added,
    Modified,
    /// Moved without changing its content (a removed and an added path with
    /// the same digest).
    Renamed,
    Removed,
    Unchanged,
}

/// One file of the package, compared with the library. Changed files come
/// first; unchanged files follow.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DraftFile {
    /// Path in the library repository (the new path of a renamed file).
    pub path: String,
    /// The path a renamed file had in the library.
    pub previous_path: Option<String>,
    pub status: DraftFileStatus,
    pub size: u32,
    pub diff: TextDiff,
    /// Part of what is shared. A changed file the author leaves out keeps the
    /// library's version (an added file is not added, a removed one stays).
    pub included: bool,
    /// Why this file cannot be left out, if so.
    pub required: Option<String>,
}

/// What went wrong the last time the author prepared or sent this
/// contribution. Cleared by the next success.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AttentionKind {
    /// Preparing the branch failed.
    Prepare,
    /// Pushing the branch (or asking the host before it) failed.
    Send,
    /// Someone else pushed to the contribution branch since it was sent.
    RemoteMoved,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Attention {
    pub kind: AttentionKind,
    pub message: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Contribution {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub title: String,
    pub message: String,
    /// Library-relative folder of the skill.
    pub item_path: String,
    pub base_commit: String,
    pub branch: String,
    pub state: ContributionState,
    pub origin: ContributionOrigin,
    pub form: ShareForm,
    pub files: Vec<DraftFile>,
    pub validation: Vec<Diagnostic>,
    /// Suggestions from the project's detected facts; the author decides.
    pub suggested_tags: Vec<String>,
    pub commit_id: Option<String>,
    pub published_url: Option<String>,
    /// Why no review request was opened when the branch was pushed, if so.
    pub published_note: Option<String>,
    pub patch_path: Option<String>,
    /// The library's current snapshot already contains exactly these files
    /// (the contribution was merged, or nothing differs yet).
    pub in_library: bool,
    /// Where "Send for review" pushes, as the user should see it.
    pub remote: Option<ContributionRemote>,
    /// The request on the Git host, as last read (only when the user asked).
    pub review: Option<ReviewStatus>,
    /// 0 for the first version; each "Revise" adds one.
    pub revision: u32,
    /// The commit last pushed to the contribution branch.
    pub pushed_commit: Option<String>,
    /// The private folder holding the files that would be shared, for
    /// display. Edit a library-item contribution's files here; skills from
    /// My skills or a project are copied again from where they live.
    pub staging_path: String,
    /// A revision is open: `cancel_revision` returns to the version before it.
    pub revising: bool,
    /// The last attempt to prepare or send failed, or someone else pushed to
    /// the branch.
    pub attention: Option<Attention>,
    /// When the branch was last pushed (and a request opened, if one was).
    pub published_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The library's remote, for the confirmation before anything is sent.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContributionRemote {
    /// URL or path, with any credentials removed.
    pub display: String,
    /// A repository on this machine (no Git host involved).
    pub on_this_machine: bool,
    /// GitHub or GitLab when the address says so; otherwise unknown until
    /// Habi asks `gh`/`glab`.
    pub host: Option<ReviewHost>,
    /// What the library follows: the branch a request targets (the
    /// repository's default branch when it follows `HEAD`).
    pub tracked: TrackedRef,
    /// Why no review request can be opened from here, if so.
    pub request_unavailable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublishOutcome {
    pub remote: String,
    pub branch: String,
    pub pull_request_url: Option<String>,
    /// Why no pull request was opened, if none was.
    pub pull_request_note: Option<String>,
    /// The branch already had an open request; it now shows this revision.
    pub updated_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    message: String,
    form: ShareForm,
    suggested_tags: Vec<String>,
    /// Repository path prefix (source subdirectory).
    prefix: String,
    #[serde(default)]
    publish_note: Option<String>,
    #[serde(default)]
    review: Option<ReviewStatus>,
    #[serde(default)]
    pushed_commit: Option<String>,
    /// While revising: the commit the next one builds on.
    #[serde(default)]
    parent_commit: Option<String>,
    #[serde(default)]
    revision: u32,
    /// Files that are executable, recorded when the files were copied (the
    /// staged copy cannot carry the bit on every platform). `None` for
    /// contributions saved before this was recorded.
    #[serde(default)]
    executables: Option<BTreeSet<String>>,
    /// While revising: what to return to if the revision is cancelled.
    #[serde(default)]
    before_revision: Option<RevisionBackup>,
    /// The form as it stood when the files were last copied from where the
    /// skill lives; later form changes are reapplied on a new copy.
    #[serde(default)]
    synced_form: Option<ShareForm>,
    /// Library path of an unrelated item of the same name that this
    /// contribution would replace.
    #[serde(default)]
    replaces: Option<String>,
    /// Changed files the author leaves out (paths in the skill folder; the
    /// new path of a renamed file). Kept in a column of its own
    /// (`excluded_json`), written only by `select_files`.
    #[serde(skip)]
    excluded: BTreeSet<String>,
    #[serde(default)]
    attention: Option<Attention>,
    #[serde(default)]
    published_at: Option<String>,
}

/// The contribution as it was before "Revise", to back out of a revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RevisionBackup {
    state: ContributionState,
    revision: u32,
    title: String,
    message: String,
    form: ShareForm,
    #[serde(default)]
    publish_note: Option<String>,
}

/// What the Git host said about the contribution's request just now.
enum HostCheck {
    /// The library is on this machine: there is no host to ask.
    NoHost,
    Found(ReviewStatus),
    NoRequest,
    /// Could not ask (tool missing, signed out, network); the reason.
    Unavailable(String),
}

fn is_finished(state: ReviewState) -> bool {
    matches!(state, ReviewState::Merged | ReviewState::Closed)
}

fn finished_message(review: &ReviewStatus) -> String {
    format!(
        "the request was {} on {}; start a new contribution to change it further",
        if review.state == ReviewState::Merged {
            "merged"
        } else {
            "closed"
        },
        review.host.name()
    )
}

pub struct Contributions<'a> {
    pub paths: &'a AppPaths,
    pub store: &'a Store,
    pub sources: &'a Sources,
    pub tools: &'a ReviewTools,
}

fn staging(paths: &AppPaths, id: &str) -> PathBuf {
    paths.contributions().join(id).join("files")
}

pub(crate) fn slug(text: &str) -> String {
    let s: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    s.chars().take(40).collect()
}

/// Files operating systems leave in folders on their own; never shared.
fn is_os_junk(name: &str) -> bool {
    name == ".DS_Store"
        || name == "Icon\r"
        || name.eq_ignore_ascii_case("Thumbs.db")
        || name.eq_ignore_ascii_case("ehthumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
}

/// Reads a skill folder from disk (no symlinks, bounded). Files the operating
/// system leaves behind (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are skipped.
pub(crate) fn read_folder(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .map_err(|e| HabiError::io(format!("reading {}", display_path(&dir)), e))?
        {
            let entry = entry.map_err(|e| HabiError::io("reading the skill folder", e))?;
            let meta = std::fs::symlink_metadata(entry.path())
                .map_err(|e| HabiError::io("reading the skill folder", e))?;
            let rel = entry
                .path()
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if meta.file_type().is_symlink() {
                return Err(HabiError::invalid(format!(
                    "`{rel}` is a symbolic link; contributions may not contain links"
                )));
            }
            if meta.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if is_os_junk(&entry.file_name().to_string_lossy()) {
                continue;
            }
            if out.len() >= MAX_FILES {
                return Err(HabiError::invalid(format!(
                    "the skill has more than {MAX_FILES} files"
                )));
            }
            RelPath::new(&rel)?;
            match read_bounded(&entry.path(), MAX_FILE_BYTES)? {
                Bounded::Content(b) => {
                    out.insert(rel, b);
                }
                Bounded::TooLarge(n) => {
                    return Err(HabiError::invalid(format!(
                        "`{rel}` is {n} bytes; the limit for contributions is {MAX_FILE_BYTES}"
                    )));
                }
            }
        }
    }
    Ok(out)
}

/// Where a skill named `name` lives (or would live) in the library: the
/// existing item of that name (and its id), else next to the library's other
/// skills.
fn library_path_for(
    index: &crate::library::model::LibraryIndex,
    name: &str,
) -> (String, Option<String>) {
    if let Some(item) = index
        .items
        .iter()
        .find(|i| i.name == name && i.kind != crate::library::model::ItemKind::Instructions)
    {
        return (item.path.clone(), Some(item.id.clone()));
    }
    let path = {
        let root = index
            .items
            .iter()
            .filter(|i| i.kind != crate::library::model::ItemKind::Instructions)
            .find_map(|i| i.path.rsplit_once('/').map(|(d, _)| d.to_string()))
            .unwrap_or_else(|| "skills".into());
        format!("{root}/{name}")
    };
    (path, None)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Prefills the form from an existing habi.yaml, if any.
pub(crate) fn form_from(sidecar: Option<&Value>, default_title: &str) -> ShareForm {
    let mut form = ShareForm {
        title: default_title.to_string(),
        conditions_editable: true,
        ..Default::default()
    };
    let Some(v) = sidecar else {
        return form;
    };
    if let Some(t) = v.get("title").and_then(Value::as_str) {
        form.title = t.to_string();
    }
    form.owner = v
        .get("owner")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    form.repository_scope = v.get("scope").and_then(Value::as_str) == Some("repository");
    let leaves = |cond: &Value,
                  tags: &mut Vec<String>,
                  deps: &mut Vec<String>,
                  files: &mut Vec<String>|
     -> Option<MatchMode> {
        let (mode, list): (MatchMode, Vec<Value>) =
            if let Some(a) = cond.get("all").and_then(Value::as_array) {
                (MatchMode::All, a.clone())
            } else if let Some(a) = cond.get("any").and_then(Value::as_array) {
                (MatchMode::Any, a.clone())
            } else {
                (MatchMode::All, vec![cond.clone()])
            };
        for leaf in list {
            if let Some(t) = leaf.get("tag").and_then(Value::as_str) {
                tags.push(t.to_string());
            } else if let Some(d) = leaf.get("dependency").and_then(Value::as_str) {
                deps.push(d.to_string());
            } else {
                let f = leaf.get("file").and_then(Value::as_str)?;
                files.push(f.to_string());
            }
        }
        Some(mode)
    };
    if let Some(c) = v.get("applies_when") {
        let (mut t, mut d, mut f) = (Vec::new(), Vec::new(), Vec::new());
        match leaves(c, &mut t, &mut d, &mut f) {
            Some(mode) => {
                form.match_mode = mode;
                form.applies_tags = t;
                form.applies_dependencies = d;
                form.applies_files = f;
            }
            None => form.conditions_editable = false,
        }
    }
    if let Some(c) = v.get("excludes") {
        let (mut t, mut d, mut f) = (Vec::new(), Vec::new(), Vec::new());
        match leaves(c, &mut t, &mut d, &mut f) {
            Some(MatchMode::Any) | Some(MatchMode::All) if f.is_empty() => {
                form.exclude_tags = t;
                form.exclude_dependencies = d;
            }
            _ => form.conditions_editable = false,
        }
    }
    if let Some(tools) = v
        .get("requires")
        .and_then(|r| r.get("tools"))
        .and_then(Value::as_array)
    {
        form.tools = tools
            .iter()
            .map(|t| ToolEntry {
                name: t
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                commands: strings(t.get("commands")),
            })
            .collect();
    }
    if let Some(ex) = v.get("examples").and_then(Value::as_array) {
        form.examples = ex
            .iter()
            .map(|e| ExampleEntry {
                title: e
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                description: e
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
            .collect();
    }
    form
}

fn leaf_list(tags: &[String], deps: &[String], files: &[String]) -> Vec<Value> {
    let clean = |v: &[String]| -> Vec<String> {
        v.iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut out = Vec::new();
    out.extend(clean(tags).into_iter().map(|t| json!({ "tag": t })));
    out.extend(clean(deps).into_iter().map(|d| json!({ "dependency": d })));
    out.extend(clean(files).into_iter().map(|f| json!({ "file": f })));
    out
}

/// The parts of `habi.yaml` the form edits, each written as a whole.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FormPart {
    Title,
    Owner,
    Scope,
    AppliesWhen,
    Excludes,
    Tools,
    Examples,
}

const FORM_PARTS: [FormPart; 7] = [
    FormPart::Title,
    FormPart::Owner,
    FormPart::Scope,
    FormPart::AppliesWhen,
    FormPart::Excludes,
    FormPart::Tools,
    FormPart::Examples,
];

impl FormPart {
    fn changed(self, a: &ShareForm, b: &ShareForm) -> bool {
        match self {
            FormPart::Title => a.title.trim() != b.title.trim(),
            FormPart::Owner => a.owner.trim() != b.owner.trim(),
            FormPart::Scope => a.repository_scope != b.repository_scope,
            FormPart::AppliesWhen => {
                a.conditions_editable != b.conditions_editable
                    || a.match_mode != b.match_mode
                    || a.applies_tags != b.applies_tags
                    || a.applies_dependencies != b.applies_dependencies
                    || a.applies_files != b.applies_files
            }
            FormPart::Excludes => {
                a.conditions_editable != b.conditions_editable
                    || a.exclude_tags != b.exclude_tags
                    || a.exclude_dependencies != b.exclude_dependencies
            }
            FormPart::Tools => a.tools != b.tools,
            FormPart::Examples => a.examples != b.examples,
        }
    }
}

/// Sets `key` in place (keeping its position) or removes it, keeping the
/// order of the other keys.
fn set_or_remove(v: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(x) => {
            v.insert(key.to_string(), x);
        }
        None => {
            v.shift_remove(key);
        }
    }
}

/// The existing entry a form row continues: the one with the same key, or a
/// renamed one in the same position.
fn matching_entry<'v>(
    existing: &'v [Value],
    field: &str,
    key: &str,
    position: usize,
    all_keys: &BTreeSet<&str>,
) -> Option<&'v Map<String, Value>> {
    fn key_of<'e>(e: &'e Value, field: &str) -> Option<&'e str> {
        e.get(field).and_then(Value::as_str).map(str::trim)
    }
    let key_of = |e: &'v Value| key_of(e, field);
    existing
        .iter()
        .find(|e| key_of(e) == Some(key))
        .or_else(|| {
            existing
                .get(position)
                .filter(|e| key_of(e).is_none_or(|k| !all_keys.contains(k)))
        })
        .and_then(Value::as_object)
}

fn apply_part(v: &mut Map<String, Value>, form: &ShareForm, part: FormPart) {
    match part {
        FormPart::Title => set_or_remove(
            v,
            "title",
            (!form.title.trim().is_empty()).then(|| json!(form.title.trim())),
        ),
        FormPart::Owner => set_or_remove(
            v,
            "owner",
            (!form.owner.trim().is_empty()).then(|| json!(form.owner.trim())),
        ),
        FormPart::Scope => {
            if form.repository_scope {
                v.insert("scope".into(), json!("repository"));
            } else if v.get("scope").and_then(Value::as_str) == Some("repository") {
                v.shift_remove("scope");
            }
            // Any other explicit scope (such as `module`, the default) stays.
        }
        FormPart::AppliesWhen if form.conditions_editable => {
            let applies = leaf_list(
                &form.applies_tags,
                &form.applies_dependencies,
                &form.applies_files,
            );
            let mode = if form.match_mode == MatchMode::Any {
                "any"
            } else {
                "all"
            };
            set_or_remove(
                v,
                "applies_when",
                match applies.len() {
                    0 => None,
                    1 => Some(applies[0].clone()),
                    _ => Some(json!({ mode: applies })),
                },
            );
        }
        FormPart::Excludes if form.conditions_editable => {
            let excludes = leaf_list(&form.exclude_tags, &form.exclude_dependencies, &[]);
            // The form has no mode for exclusions: keep the one written
            // (`all` excludes only when every condition holds), else `any`.
            let mode = if v.get("excludes").and_then(|e| e.get("all")).is_some() {
                "all"
            } else {
                "any"
            };
            set_or_remove(
                v,
                "excludes",
                match excludes.len() {
                    0 => None,
                    1 => Some(excludes[0].clone()),
                    _ => Some(json!({ mode: excludes })),
                },
            );
        }
        FormPart::AppliesWhen | FormPart::Excludes => {}
        FormPart::Tools => {
            let existing: Vec<Value> = v
                .get("requires")
                .and_then(|r| r.get("tools"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let rows: Vec<&ToolEntry> = form
                .tools
                .iter()
                .filter(|t| !t.name.trim().is_empty() && !t.commands.is_empty())
                .collect();
            let names: BTreeSet<&str> = rows.iter().map(|t| t.name.trim()).collect();
            let tools: Vec<Value> = rows
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    // Fields the form does not show (purpose, install_hint,
                    // anything else) are kept.
                    let mut entry = matching_entry(&existing, "name", t.name.trim(), i, &names)
                        .cloned()
                        .unwrap_or_default();
                    entry.insert("name".into(), json!(t.name.trim()));
                    entry.insert("commands".into(), json!(t.commands));
                    Value::Object(entry)
                })
                .collect();
            let had_requires = v.contains_key("requires");
            let mut requires = v
                .get("requires")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            set_or_remove(
                &mut requires,
                "tools",
                (!tools.is_empty()).then(|| json!(tools)),
            );
            if !requires.is_empty() {
                v.insert("requires".into(), Value::Object(requires));
            } else if had_requires {
                v.shift_remove("requires");
            }
        }
        FormPart::Examples => {
            let existing: Vec<Value> = v
                .get("examples")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let rows: Vec<&ExampleEntry> = form
                .examples
                .iter()
                .filter(|e| !e.title.trim().is_empty())
                .collect();
            let titles: BTreeSet<&str> = rows.iter().map(|e| e.title.trim()).collect();
            let examples: Vec<Value> = rows
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    // `path` and other fields the form does not show are kept.
                    let mut entry = matching_entry(&existing, "title", e.title.trim(), i, &titles)
                        .cloned()
                        .unwrap_or_default();
                    entry.insert("title".into(), json!(e.title.trim()));
                    if e.description.trim().is_empty() {
                        entry.shift_remove("description");
                    } else {
                        entry.insert("description".into(), json!(e.description.trim()));
                    }
                    Value::Object(entry)
                })
                .collect();
            set_or_remove(
                v,
                "examples",
                (!examples.is_empty()).then(|| json!(examples)),
            );
        }
    }
}

fn sidecar_map(existing: Option<Value>) -> Map<String, Value> {
    let v = match existing {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    if v.contains_key("habi") {
        return v;
    }
    let mut ordered = Map::new();
    ordered.insert("habi".into(), json!(1));
    ordered.extend(v);
    ordered
}

/// Merges the form into an existing sidecar value, keeping unknown fields,
/// key order, fields of each tool and example the form does not show, the
/// exclusion mode and explicit defaults. Every part the form edits is set
/// from the form.
pub(crate) fn apply_form(existing: Option<Value>, form: &ShareForm) -> Value {
    let mut v = sidecar_map(existing);
    for part in FORM_PARTS {
        apply_part(&mut v, form, part);
    }
    Value::Object(v)
}

/// Like `apply_form`, but only the parts where `form` differs from
/// `baseline` (what the existing file reads as) are written; everything else
/// stays exactly as it was.
pub(crate) fn merge_form(existing: Option<Value>, form: &ShareForm, baseline: &ShareForm) -> Value {
    let mut v = sidecar_map(existing);
    for part in FORM_PARTS {
        if part.changed(form, baseline) {
            apply_part(&mut v, form, part);
        }
    }
    Value::Object(v)
}

pub(crate) fn sidecar_is_empty(v: &Value) -> bool {
    v.as_object().is_some_and(|m| m.keys().all(|k| k == "habi"))
}

/// The metadata file in `dir` (`habi.yaml` or `habi.yml`, whichever exists)
/// and its text.
fn read_sidecar(dir: &Path) -> Result<(&'static str, Option<String>)> {
    for name in SIDECAR_FILES {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        return match read_bounded(&path, MAX_FILE_BYTES)? {
            Bounded::Content(bytes) => {
                Ok((name, Some(String::from_utf8_lossy(&bytes).into_owned())))
            }
            Bounded::TooLarge(n) => Err(HabiError::invalid(format!(
                "{name} is {n} bytes; the limit is {MAX_FILE_BYTES}"
            ))),
        };
    }
    Ok((SIDECAR_FILES[0], None))
}

/// The comment lines a metadata file starts with, kept when it is rewritten.
fn leading_comments(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        if !line.trim_start().starts_with('#') {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Writes the form into the staging folder's `habi.yaml` (or the existing
/// `habi.yml`). Only the parts that differ from `baseline` — by default,
/// what the file already says — are written; everything else (unknown keys,
/// key order, explicit defaults, fields the form does not show) stays. A
/// form that changes nothing leaves the file untouched.
fn write_sidecar(
    dir: &Path,
    form: &ShareForm,
    baseline: Option<&ShareForm>,
    fallback_title: &str,
) -> Result<()> {
    let (name, text) = read_sidecar(dir)?;
    let existing = match &text {
        Some(t) => Some(library::parse_yaml(t).map_err(|e| {
            HabiError::invalid(format!(
                "{name} could not be read ({e}); fix it before changing the form"
            ))
        })?),
        None => None,
    };
    let read_back = form_from(existing.as_ref(), fallback_title);
    let baseline = baseline.unwrap_or(&read_back);
    if form == baseline {
        return Ok(());
    }
    let value = merge_form(existing.clone(), form, baseline);
    if existing.as_ref() == Some(&value) || (existing.is_none() && sidecar_is_empty(&value)) {
        return Ok(());
    }
    let yaml = serde_saphyr::to_string(&value).map_err(|e| HabiError::Internal(e.to_string()))?;
    let header = match &text {
        Some(t) => leading_comments(t),
        None => "# Habi metadata — see schema/habi-skill.schema.json\n".into(),
    };
    atomic_write(&dir.join(name), format!("{header}{yaml}").as_bytes())
}

/// The form as the metadata in `dir` reads.
fn form_in(dir: &Path, fallback_title: &str) -> ShareForm {
    let sidecar = read_sidecar(dir)
        .ok()
        .and_then(|(_, text)| text)
        .and_then(|t| library::parse_yaml(&t).ok());
    form_from(sidecar.as_ref(), fallback_title)
}

fn sidecar_value(files: &BTreeMap<String, Vec<u8>>) -> Option<Value> {
    SIDECAR_FILES
        .iter()
        .find_map(|name| files.get(*name))
        .and_then(|b| library::parse_yaml(&String::from_utf8_lossy(b)).ok())
}

/// Executable files among `files` in `dir` (only observable on Unix).
fn executables_in(dir: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    for name in files.keys() {
        if crate::fsutil::is_executable(&RelPath::new(name)?.to_path(dir)) {
            out.insert(name.clone());
        }
    }
    Ok(out)
}

/// Replaces the staging folder with exactly `files`.
fn write_staging(
    dir: &Path,
    files: &BTreeMap<String, Vec<u8>>,
    executables: &BTreeSet<String>,
) -> Result<()> {
    let _ = std::fs::remove_dir_all(dir);
    for (rel, bytes) in files {
        crate::fsutil::atomic_write_mode(
            &RelPath::new(rel)?.to_path(dir),
            bytes,
            Some(executables.contains(rel)),
        )?;
    }
    std::fs::create_dir_all(dir).map_err(|e| HabiError::io("creating the staging folder", e))
}

/// Largest patch Habi writes (a contribution is at most 200 files of 1 MiB).
const PATCH_LIMIT: usize = 512 * 1024 * 1024;

/// The staged package compared with the library, and what would leave the
/// machine given the files the author left out. Paths are relative to the
/// skill folder.
struct Comparison {
    files: Vec<DraftFile>,
    /// Exactly what the contribution's skill folder holds.
    outgoing: BTreeMap<String, Vec<u8>>,
    /// Paths in `outgoing` that keep the library's version because the
    /// author left the change out.
    kept: BTreeSet<String>,
    /// Changed files that are left out (the new path of a renamed file).
    excluded: BTreeSet<String>,
    /// Old path -> new path of renamed files.
    renamed: BTreeMap<String, String>,
    /// Some changed file is part of the contribution.
    any_included_change: bool,
}

const NEW_SKILL_FILE: &str = "A new skill cannot be shared without its SKILL.md.";

fn compare(
    item_path: &str,
    base: &BTreeMap<String, Vec<u8>>,
    staged: &BTreeMap<String, Vec<u8>>,
    excluded: &BTreeSet<String>,
) -> Comparison {
    let lib = |name: &str| format!("{item_path}/{name}");
    // A removed and an added path with the same content is a rename. Each
    // removed path pairs with at most one added path, in path order.
    let mut added_by_digest: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for name in staged.keys().filter(|k| !base.contains_key(*k)) {
        added_by_digest
            .entry(sha256(&staged[name]))
            .or_default()
            .push(name);
    }
    let mut renamed: BTreeMap<String, String> = BTreeMap::new();
    for name in base.keys().filter(|k| !staged.contains_key(*k)) {
        if let Some(list) = added_by_digest.get_mut(&sha256(&base[name]))
            && !list.is_empty()
        {
            renamed.insert(name.clone(), list.remove(0).clone());
        }
    }
    let renamed_from: BTreeMap<&String, &String> = renamed.iter().map(|(o, n)| (n, o)).collect();

    let mut out = Comparison {
        files: Vec::new(),
        outgoing: staged.clone(),
        kept: BTreeSet::new(),
        excluded: BTreeSet::new(),
        renamed: renamed.clone(),
        any_included_change: false,
    };
    let names: BTreeSet<&String> = staged.keys().chain(base.keys()).collect();
    for name in names {
        if renamed.contains_key(name) {
            continue; // shown as the rename's previous path
        }
        let (old, new) = (base.get(name), staged.get(name));
        let previous = renamed_from.get(name).map(|p| (*p).clone());
        let status = match (old, new) {
            (None, Some(_)) if previous.is_some() => DraftFileStatus::Renamed,
            (None, Some(_)) => DraftFileStatus::Added,
            (Some(_), None) => DraftFileStatus::Removed,
            (Some(a), Some(b)) if a == b => DraftFileStatus::Unchanged,
            _ => DraftFileStatus::Modified,
        };
        let required = (name == SKILL_FILE && status == DraftFileStatus::Added)
            .then(|| NEW_SKILL_FILE.to_string());
        let changed = status != DraftFileStatus::Unchanged;
        let included = !changed || required.is_some() || !excluded.contains(name);
        if changed && included {
            out.any_included_change = true;
        }
        if !included {
            out.excluded.insert(name.clone());
            match status {
                DraftFileStatus::Added => {
                    out.outgoing.remove(name);
                }
                DraftFileStatus::Modified | DraftFileStatus::Removed => {
                    out.outgoing.insert(name.clone(), base[name].clone());
                    out.kept.insert(name.clone());
                }
                DraftFileStatus::Renamed => {
                    let prev = previous.clone().unwrap_or_default();
                    out.outgoing.remove(name);
                    out.outgoing.insert(prev.clone(), base[&prev].clone());
                    out.kept.insert(prev);
                }
                DraftFileStatus::Unchanged => {}
            }
        }
        out.files.push(DraftFile {
            path: lib(name),
            previous_path: previous.as_deref().map(lib),
            status,
            size: new.or(old).map(|b| b.len() as u32).unwrap_or(0),
            diff: if matches!(
                status,
                DraftFileStatus::Unchanged | DraftFileStatus::Renamed
            ) {
                TextDiff::default()
            } else {
                diff(old.map(|v| v.as_slice()), new.map(|v| v.as_slice()))
            },
            included,
            required,
        });
    }
    // Changed files first, each group in path order (the sort is stable).
    out.files
        .sort_by_key(|f| f.status == DraftFileStatus::Unchanged);
    out
}

/// Turns a reference into a path inside the package, relative to `dir`
/// (the referring file's folder, or "" for the package root). Addresses,
/// absolute paths and paths leaving the package are not package files.
fn package_path(reference: &str, dir: &str) -> Option<String> {
    let target = reference
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    let target = target.split(['#', '?']).next().unwrap_or_default();
    if target.is_empty()
        || target.starts_with(['/', '~', '$', '\\'])
        || target
            .split('/')
            .next()
            .is_some_and(|first| first.contains(':'))
    {
        return None;
    }
    let decoded = target.replace("%20", " ");
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() || decoded.ends_with('/') {
        return None;
    }
    Some(parts.join("/"))
}

/// Inline code that names a file, like `scripts/check.sh`.
fn names_a_file(code: &str) -> bool {
    !code.is_empty()
        && code.contains('/')
        && !code.chars().any(char::is_whitespace)
        && !code.contains(['*', '{', '}', '`'])
        && !code.contains("://")
        && !code.starts_with('-')
        && code
            .rsplit('/')
            .next()
            .is_some_and(|last| last.contains('.'))
}

/// Package files a Markdown file points at: link targets (relative to the
/// file) and inline code naming a path (relative to the package). Fenced
/// code blocks are skipped.
fn markdown_references(file: &str, text: &str) -> BTreeSet<String> {
    let dir = file.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut out = BTreeSet::new();
    let mut fenced = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        // `[label]: target` definitions.
        if trimmed.starts_with('[')
            && let Some((_, rest)) = trimmed.split_once("]:")
            && let Some(target) = rest.split_whitespace().next()
            && let Some(p) = package_path(target, dir)
        {
            out.insert(p);
        }
        // `[text](target "title")` links and images.
        let mut rest = line;
        while let Some(at) = rest.find("](") {
            let after = &rest[at + 2..];
            let end = after.find(')').unwrap_or(after.len());
            if let Some(target) = after[..end].split_whitespace().next()
                && let Some(p) = package_path(target, dir)
            {
                out.insert(p);
            }
            rest = &after[end..];
        }
        // `inline code` between single backticks.
        for (i, code) in line.split('`').enumerate() {
            if i % 2 == 1
                && names_a_file(code)
                && let Some(p) = package_path(code, "")
            {
                out.insert(p);
            }
        }
    }
    out
}

/// Markdown files in what would be shared that point at a file the
/// contribution leaves out, deletes or renames.
fn reference_problems(
    item_path: &str,
    cmp: &Comparison,
    base: &BTreeMap<String, Vec<u8>>,
    staged: &BTreeMap<String, Vec<u8>>,
) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (name, bytes) in &cmp.outgoing {
        if !name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        for target in markdown_references(name, &String::from_utf8_lossy(bytes)) {
            if cmp.outgoing.contains_key(&target) {
                continue;
            }
            let message = if cmp.excluded.contains(&target) {
                format!(
                    "{name} refers to {target}, which is left out of this contribution. Include {target}, or remove the reference."
                )
            } else if let Some(new) = cmp.renamed.get(&target) {
                format!(
                    "{name} refers to {target}, which this contribution renames to {new}. Update the reference."
                )
            } else if base.contains_key(&target) || staged.contains_key(&target) {
                format!(
                    "{name} refers to {target}, which this contribution deletes. Keep {target}, or remove the reference."
                )
            } else {
                continue;
            };
            out.push(Diagnostic::error(
                message,
                Some(&format!("{item_path}/{name}")),
            ));
        }
    }
    out
}

impl<'a> Contributions<'a> {
    fn git(&self) -> Result<Git> {
        Git::locate(&self.paths.empty_dir())
    }

    fn load_row(&self, id: &str) -> Result<(Contribution, Stored)> {
        let conn = self.store.conn()?;
        let row = conn
            .query_row(
                "SELECT c.id, c.source_id, s.name, c.item_path, c.title, c.base_commit, c.branch, c.commit_id, c.state,
                        c.origin_json, c.created_at, c.updated_at, c.published_url, c.patch_path,
                        c.excluded_json
                 FROM contributions c LEFT JOIN sources s ON s.id = c.source_id WHERE c.id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                        r.get::<_, String>(10)?,
                        r.get::<_, String>(11)?,
                        r.get::<_, Option<String>>(12)?,
                        r.get::<_, Option<String>>(13)?,
                        r.get::<_, String>(14)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| HabiError::NotFound(format!("contribution {id}")))?;
        let (
            id,
            source_id,
            source_name,
            item_path,
            title,
            base,
            branch,
            commit,
            state,
            origin_json,
            created,
            updated,
            url,
            patch,
            excluded,
        ) = row;
        let envelope: Value =
            serde_json::from_str(&origin_json).map_err(|e| HabiError::Internal(e.to_string()))?;
        let origin: ContributionOrigin = serde_json::from_value(envelope["origin"].clone())
            .map_err(|e| HabiError::Internal(e.to_string()))?;
        let mut stored: Stored = serde_json::from_value(envelope["stored"].clone())
            .map_err(|e| HabiError::Internal(e.to_string()))?;
        stored.excluded =
            serde_json::from_str(&excluded).map_err(|e| HabiError::Internal(e.to_string()))?;
        let state: ContributionState =
            serde_json::from_value(json!(state)).unwrap_or(ContributionState::Draft);
        Ok((
            Contribution {
                staging_path: display_path(&staging(self.paths, &id)),
                revising: state == ContributionState::Draft && stored.parent_commit.is_some(),
                id,
                source_id,
                source_name: source_name.unwrap_or_else(|| "(removed source)".into()),
                title,
                message: stored.message.clone(),
                item_path,
                base_commit: base,
                branch,
                state,
                origin,
                form: stored.form.clone(),
                files: Vec::new(),
                validation: Vec::new(),
                suggested_tags: stored.suggested_tags.clone(),
                commit_id: commit,
                published_url: url,
                published_note: stored.publish_note.clone(),
                patch_path: patch,
                in_library: false,
                remote: None,
                review: stored.review.clone(),
                revision: stored.revision,
                pushed_commit: stored.pushed_commit.clone(),
                attention: stored.attention.clone(),
                published_at: stored.published_at.clone(),
                created_at: created,
                updated_at: updated,
            },
            stored,
        ))
    }

    /// `load_row`, refusing a discarded contribution.
    fn load_active(&self, id: &str) -> Result<(Contribution, Stored)> {
        let (c, stored) = self.load_row(id)?;
        if c.state == ContributionState::Discarded {
            return Err(HabiError::invalid(
                "this contribution was discarded; start a new one to share the skill",
            ));
        }
        Ok((c, stored))
    }

    fn save_row(&self, c: &Contribution, stored: &Stored) -> Result<()> {
        let envelope = json!({ "origin": c.origin, "stored": stored });
        self.store.conn()?.execute(
            "INSERT INTO contributions (id, source_id, item_path, title, base_commit, branch, commit_id, state, origin_json,
                                        created_at, updated_at, published_url, patch_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, commit_id = excluded.commit_id, state = excluded.state,
                 origin_json = excluded.origin_json, updated_at = excluded.updated_at,
                 published_url = excluded.published_url, patch_path = excluded.patch_path",
            params![
                c.id,
                c.source_id,
                c.item_path,
                c.title,
                c.base_commit,
                c.branch,
                c.commit_id,
                serde_json::to_value(c.state).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
                envelope.to_string(),
                c.created_at,
                c.updated_at,
                c.published_url,
                c.patch_path
            ],
        )?;
        Ok(())
    }

    /// The skill's files in the library snapshot the contribution started
    /// from, and which of them are executable.
    fn base_files(&self, c: &Contribution) -> Result<(Files, BTreeSet<String>)> {
        let files: Vec<SnapshotFile> = self.sources.snapshot_files(&c.source_id, &c.base_commit)?;
        let prefix = format!("{}/", c.item_path);
        let mut out = BTreeMap::new();
        let mut executables = BTreeSet::new();
        for f in files.into_iter().filter(|f| f.path.starts_with(&prefix)) {
            let name = f.path[prefix.len()..].to_string();
            if f.executable {
                executables.insert(name.clone());
            }
            out.insert(name, self.sources.blobs().get(&f.digest)?);
        }
        Ok((out, executables))
    }

    /// The staged files compared with the library, with the author's
    /// selection applied.
    fn comparison(&self, c: &Contribution, stored: &Stored) -> Result<(Comparison, Files, Files)> {
        let staged = self.staged(&c.id).unwrap_or_default();
        let (base, _) = self.base_files(c)?;
        let cmp = compare(&c.item_path, &base, &staged, &stored.excluded);
        Ok((cmp, base, staged))
    }

    fn staged(&self, id: &str) -> Result<BTreeMap<String, Vec<u8>>> {
        read_folder(&staging(self.paths, id))
    }

    /// The skill's files and executable bits where they live now (My skills
    /// or the project), if that can be read.
    #[allow(clippy::type_complexity)]
    fn read_origin(
        &self,
        origin: &ContributionOrigin,
        project_root: Option<&Path>,
    ) -> Result<Option<(BTreeMap<String, Vec<u8>>, BTreeSet<String>)>> {
        let dir = match origin {
            ContributionOrigin::LocalSkill { skill_id } => {
                Some(crate::skills::package_dir(self.paths, skill_id)?)
            }
            ContributionOrigin::ProjectSkill { path, .. } => match project_root {
                Some(root) => resolve_for_read(root, &RelPath::new(path)?)?,
                None => None,
            },
            ContributionOrigin::LibraryItem { .. } => None,
        };
        let Some(dir) = dir.filter(|d| d.is_dir()) else {
            return Ok(None);
        };
        let files = read_folder(&dir)?;
        let executables = executables_in(&dir, &files)?;
        Ok(Some((files, executables)))
    }

    /// Copies a skill from My skills or a project into the staging folder
    /// again, then reapplies the form changes made since the last copy.
    /// Returns false when the skill could not be read where it lives (the
    /// staged copy is then kept).
    fn sync_from_origin(
        &self,
        c: &Contribution,
        stored: &mut Stored,
        project_root: Option<&Path>,
        reopening: bool,
    ) -> Result<bool> {
        let Some((files, executables)) = self.read_origin(&c.origin, project_root)? else {
            return Ok(false);
        };
        if !files.contains_key(SKILL_FILE) {
            return Err(HabiError::invalid(
                "the skill no longer has a SKILL.md, so it cannot be revised",
            ));
        }
        let dir = staging(self.paths, &c.id);
        write_staging(&dir, &files, &executables)?;
        let fallback = stored.form.title.clone();
        let baseline = if reopening {
            // A project skill's metadata comes from the form; a skill from
            // My skills brings its own (edited in My skills).
            match c.origin {
                ContributionOrigin::ProjectSkill { .. } => None,
                _ => Some(stored.form.clone()),
            }
        } else {
            // Only what the author changed in the form since the last copy;
            // edits made where the skill lives are kept.
            stored.synced_form.clone()
        };
        let reapply = match &baseline {
            Some(b) => b != &stored.form,
            None => true,
        };
        if reapply {
            write_sidecar(&dir, &stored.form, baseline.as_ref(), &fallback)?;
        }
        stored.form = form_in(&dir, &fallback);
        stored.synced_form = Some(stored.form.clone());
        stored.executables = Some(executables);
        Ok(true)
    }

    /// True when sharing `name` from `origin` replaces a library item that
    /// the skill was not copied from.
    fn replaces_unrelated_item(
        &self,
        origin: &ContributionOrigin,
        project_root: Option<&Path>,
        existing_item: &str,
        files: &BTreeMap<String, Vec<u8>>,
        item_files: &BTreeMap<String, String>,
    ) -> bool {
        let derived = match origin {
            ContributionOrigin::LibraryItem { .. } => true,
            ContributionOrigin::LocalSkill { skill_id } => self
                .store
                .conn()
                .ok()
                .and_then(|conn| {
                    conn.query_row(
                        "SELECT origin_json FROM local_skills WHERE id = ?1",
                        [skill_id],
                        |r| r.get::<_, String>(0),
                    )
                    .ok()
                })
                .and_then(|json| serde_json::from_str::<crate::skills::SkillOrigin>(&json).ok())
                .is_some_and(|o| {
                    matches!(o, crate::skills::SkillOrigin::Library { item_id, .. } if item_id == existing_item)
                }),
            ContributionOrigin::ProjectSkill { path, .. } => project_root
                .and_then(|root| {
                    match read_bounded(&root.join(crate::brand::LOCK_FILE), MAX_FILE_BYTES) {
                        Ok(Bounded::Content(b)) => crate::install::lock::LockFile::parse(&b).ok(),
                        _ => None,
                    }
                })
                .and_then(|lock| {
                    lock.owner_of(&format!("{path}/{SKILL_FILE}"))
                        .map(|i| i.id == existing_item)
                })
                .unwrap_or(false),
        };
        // A copy that still shares a file with the item continues it too.
        let shares_a_file = files
            .iter()
            .any(|(p, b)| item_files.get(p).is_some_and(|d| *d == sha256(b)));
        !derived && !shares_a_file
    }

    /// Starts a contribution from a skill folder or library item.
    pub fn start(
        &self,
        source_id: &str,
        origin: ContributionOrigin,
        project_root: Option<&Path>,
        project_tags: Vec<String>,
    ) -> Result<Contribution> {
        let source = self.sources.get(source_id)?;
        if source.kind != SourceKind::Git {
            return Err(HabiError::Unsupported(
                "contributions need a Git-backed library; this source is a plain folder".into(),
            ));
        }
        let base_commit = source
            .snapshot
            .clone()
            .ok_or_else(|| HabiError::invalid("fetch the library before contributing to it"))?;
        let index = self.sources.index(source_id)?;
        let (files, executables, item_path, default_title, existing) = match &origin {
            ContributionOrigin::ProjectSkill { path, .. } => {
                let root =
                    project_root.ok_or_else(|| HabiError::invalid("open the project first"))?;
                let rel = RelPath::new(path)?;
                let dir = resolve_for_read(root, &rel)?
                    .filter(|p| p.is_dir())
                    .ok_or_else(|| HabiError::NotFound(format!("folder {rel}")))?;
                let files = read_folder(&dir)?;
                let executables = executables_in(&dir, &files)?;
                let name = rel.file_name().to_string();
                let (item_path, existing) = library_path_for(&index, &name);
                (
                    files,
                    executables,
                    item_path,
                    library::humanize(&name),
                    existing,
                )
            }
            ContributionOrigin::LocalSkill { skill_id } => {
                let dir = crate::skills::package_dir(self.paths, skill_id)?;
                if !dir.is_dir() {
                    return Err(HabiError::NotFound(format!("skill {skill_id}")));
                }
                let files = read_folder(&dir)?;
                let executables = executables_in(&dir, &files)?;
                let name = files
                    .get(SKILL_FILE)
                    .and_then(|b| {
                        library::parse_frontmatter(&String::from_utf8_lossy(b))
                            .ok()
                            .and_then(|(fm, _)| fm.name)
                    })
                    .filter(|n| library::check_skill_name(n).is_ok())
                    .ok_or_else(|| {
                        HabiError::invalid("give the skill a valid identifier before sharing it")
                    })?;
                let title: Option<String> = self
                    .store
                    .conn()?
                    .query_row(
                        "SELECT title FROM local_skills WHERE id = ?1",
                        [skill_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let (item_path, existing) = library_path_for(&index, &name);
                (
                    files,
                    executables,
                    item_path,
                    title
                        .filter(|t| !t.trim().is_empty())
                        .unwrap_or_else(|| library::humanize(&name)),
                    existing,
                )
            }
            ContributionOrigin::LibraryItem { item_id } => {
                let item = index
                    .items
                    .iter()
                    .find(|i| &i.id == item_id)
                    .ok_or_else(|| HabiError::NotFound(format!("item `{item_id}`")))?;
                if item.kind == crate::library::model::ItemKind::Instructions {
                    return Err(HabiError::Unsupported(
                        "instructions are edited directly in the library repository".into(),
                    ));
                }
                let mut files = BTreeMap::new();
                let mut executables = BTreeSet::new();
                for f in &item.files {
                    files.insert(f.path.clone(), self.sources.blobs().get(&f.digest)?);
                    if f.executable {
                        executables.insert(f.path.clone());
                    }
                }
                (
                    files,
                    executables,
                    item.path.clone(),
                    item.title.clone(),
                    None,
                )
            }
        };
        if !files.contains_key(SKILL_FILE) {
            return Err(HabiError::invalid(
                "the folder has no SKILL.md, so it is not a skill",
            ));
        }
        RelPath::new(&item_path)?;
        let replaces = existing.and_then(|item_id| {
            let item = index.items.iter().find(|i| i.id == item_id)?;
            let item_files: BTreeMap<String, String> = item
                .files
                .iter()
                .map(|f| (f.path.clone(), f.digest.clone()))
                .collect();
            self.replaces_unrelated_item(&origin, project_root, &item_id, &files, &item_files)
                .then(|| item.path.clone())
        });

        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let dir = staging(self.paths, &id);
        write_staging(&dir, &files, &executables)?;
        let form = form_from(sidecar_value(&files).as_ref(), &default_title);
        let now = crate::time::now();
        let name = item_path
            .rsplit('/')
            .next()
            .unwrap_or(&item_path)
            .to_string();
        let contribution = Contribution {
            branch: format!(
                "{}/{}-{}",
                crate::brand::CONTRIBUTION_BRANCH_PREFIX,
                slug(&name),
                &id[..6]
            ),
            staging_path: display_path(&dir),
            revising: false,
            id: id.clone(),
            source_id: source_id.to_string(),
            source_name: source.name.clone(),
            title: format!("Share {}", form.title),
            message: String::new(),
            item_path,
            base_commit,
            state: ContributionState::Draft,
            origin,
            form: form.clone(),
            files: Vec::new(),
            validation: Vec::new(),
            suggested_tags: project_tags.clone(),
            commit_id: None,
            published_url: None,
            published_note: None,
            patch_path: None,
            in_library: false,
            remote: None,
            review: None,
            revision: 0,
            pushed_commit: None,
            attention: None,
            published_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let stored = Stored {
            message: String::new(),
            synced_form: Some(form.clone()),
            form,
            suggested_tags: project_tags,
            prefix: source.subdir.clone().unwrap_or_default(),
            publish_note: None,
            review: None,
            pushed_commit: None,
            parent_commit: None,
            revision: 0,
            executables: Some(executables),
            before_revision: None,
            replaces,
            excluded: BTreeSet::new(),
            attention: None,
            published_at: None,
        };
        self.save_row(&contribution, &stored)?;
        self.preview(&id)
    }

    /// Applies the form and message; writes habi.yaml into the staging area.
    /// Only the parts of the form that changed are written, so an unchanged
    /// form leaves the metadata file exactly as it was.
    pub fn update(
        &self,
        id: &str,
        title: &str,
        message: &str,
        form: &ShareForm,
    ) -> Result<Contribution> {
        let (mut c, mut stored) = self.load_active(id)?;
        if c.state != ContributionState::Draft {
            return Err(HabiError::invalid(
                "this contribution's branch is already prepared; choose Revise to change it",
            ));
        }
        let dir = staging(self.paths, id);
        let current = form_in(&dir, &stored.form.title);
        write_sidecar(&dir, form, Some(&current), &stored.form.title)?;
        c.title = title.trim().chars().take(120).collect();
        stored.message = message.chars().take(4000).collect();
        stored.form = form.clone();
        c.updated_at = crate::time::now();
        self.save_row(&c, &stored)?;
        self.preview(id)
    }

    /// The staged `habi.yaml` (or `habi.yml`), if the skill has one.
    pub fn staged_metadata(&self, id: &str) -> Result<Option<String>> {
        self.load_row(id)?;
        Ok(read_sidecar(&staging(self.paths, id))
            .ok()
            .and_then(|(_, text)| text))
    }

    /// Where this contribution would be sent, for the confirmation.
    fn remote_info(&self, c: &Contribution) -> Option<ContributionRemote> {
        let source = self.sources.get(&c.source_id).ok()?;
        let url = self.sources.fetch_url(&c.source_id).ok()?;
        let on_this_machine = Path::new(&url).is_absolute();
        let repo = if on_this_machine {
            None
        } else {
            remote_repo(&url)
        };
        let request_unavailable = if on_this_machine {
            Some("The library is a repository on this machine, so there is no Git host to open a request on.".into())
        } else if matches!(source.tracked, TrackedRef::Tag { .. }) {
            Some(
                "The library follows a tag, so there is no branch to open a request against."
                    .into(),
            )
        } else if repo.is_none() {
            Some("This address is not a recognizable GitHub or GitLab repository.".into())
        } else {
            None
        };
        Some(ContributionRemote {
            display: crate::redact::redact(&if on_this_machine {
                display_path(Path::new(&url))
            } else {
                url.clone()
            }),
            on_this_machine,
            host: repo.as_ref().and_then(RemoteRepo::known_host),
            tracked: source.tracked.clone(),
            request_unavailable,
        })
    }

    /// Every file of the package compared with the library (changed files
    /// first), what the author left out, and validation of exactly what
    /// would leave the machine.
    pub fn preview(&self, id: &str) -> Result<Contribution> {
        let (mut c, stored) = self.load_row(id)?;
        let (cmp, base, staged) = self.comparison(&c, &stored)?;
        c.validation = self.validate(&c, &stored, &cmp, &base, &staged);
        c.in_library = self.matches_library(&c, &cmp.outgoing, None);
        c.files = cmp.files;
        c.remote = self.remote_info(&c);
        Ok(c)
    }

    /// Leaves changed files out of the contribution, or puts them back:
    /// `excluded` lists every changed file to leave out, as library paths
    /// (or paths in the skill folder). A left-out file keeps the library's
    /// version. Only while the contribution is not prepared yet.
    pub fn select_files(&self, id: &str, excluded: &[String]) -> Result<Contribution> {
        let (mut c, stored) = self.load_active(id)?;
        if c.state != ContributionState::Draft {
            return Err(HabiError::invalid(
                "this contribution's branch is already prepared; choose Revise to change which files it includes",
            ));
        }
        let (all, _, _) = self.comparison(
            &c,
            &Stored {
                excluded: BTreeSet::new(),
                ..stored.clone()
            },
        )?;
        let prefix = format!("{}/", c.item_path);
        let mut chosen = BTreeSet::new();
        for path in excluded {
            let name = path.strip_prefix(&prefix).unwrap_or(path);
            let file = all
                .files
                .iter()
                .find(|f| {
                    f.path.strip_prefix(&prefix) == Some(name)
                        || f.previous_path
                            .as_deref()
                            .and_then(|p| p.strip_prefix(&prefix))
                            == Some(name)
                })
                .ok_or_else(|| {
                    HabiError::invalid(format!("{path} is not a file of this contribution"))
                })?;
            if file.status == DraftFileStatus::Unchanged {
                return Err(HabiError::invalid(format!(
                    "{path} does not differ from the library, so there is nothing to leave out"
                )));
            }
            if let Some(reason) = &file.required {
                return Err(HabiError::invalid(reason.clone()));
            }
            chosen.insert(file.path[prefix.len()..].to_string());
        }
        c.updated_at = crate::time::now();
        self.store.conn()?.execute(
            "UPDATE contributions SET excluded_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                c.id,
                serde_json::to_string(&chosen).map_err(|e| HabiError::Internal(e.to_string()))?,
                c.updated_at
            ],
        )?;
        self.preview(id)
    }

    /// True when the library's current snapshot holds exactly the staged
    /// files at the contribution's path (for example after it was merged).
    /// `snapshot` is the current snapshot and its files, when already known.
    fn matches_library(
        &self,
        c: &Contribution,
        staged: &BTreeMap<String, Vec<u8>>,
        snapshot: Option<&(String, Vec<SnapshotFile>)>,
    ) -> bool {
        if staged.is_empty() {
            return false;
        }
        let loaded;
        let (_, files) = match snapshot {
            Some(s) => s,
            None => {
                let Some(s) = self.current_snapshot(&c.source_id) else {
                    return false;
                };
                loaded = s;
                &loaded
            }
        };
        let prefix = format!("{}/", c.item_path);
        let current: BTreeMap<&str, (&str, u64)> = files
            .iter()
            .filter(|f| f.path.starts_with(&prefix))
            .map(|f| (&f.path[prefix.len()..], (f.digest.as_str(), f.size)))
            .collect();
        // Names and sizes first; content is hashed only when they all agree.
        current.len() == staged.len()
            && staged.iter().all(|(p, b)| {
                current
                    .get(p.as_str())
                    .is_some_and(|(_, size)| *size == b.len() as u64)
            })
            && staged.iter().all(|(p, b)| {
                current
                    .get(p.as_str())
                    .is_some_and(|(d, _)| *d == sha256(b))
            })
    }

    fn current_snapshot(&self, source_id: &str) -> Option<(String, Vec<SnapshotFile>)> {
        let snapshot = self.sources.get(source_id).ok()?.snapshot?;
        let files = self.sources.snapshot_files(source_id, &snapshot).ok()?;
        Some((snapshot, files))
    }

    /// Checks exactly what would leave the machine: the package format and
    /// Habi metadata, references between its files, and secrets.
    fn validate(
        &self,
        c: &Contribution,
        stored: &Stored,
        cmp: &Comparison,
        base: &Files,
        staged: &Files,
    ) -> Vec<Diagnostic> {
        let mut out = Vec::new();
        let outgoing = &cmp.outgoing;
        let list: Vec<SnapshotFile> = outgoing
            .iter()
            .map(|(p, b)| SnapshotFile {
                path: format!("{}/{}", c.item_path, p),
                digest: sha256(b),
                size: b.len() as u64,
                executable: false,
            })
            .collect();
        let index = library::build_index(&c.source_id, "draft", &list, &|path| {
            let rel = path
                .strip_prefix(&format!("{}/", c.item_path))
                .unwrap_or(path);
            outgoing
                .get(rel)
                .cloned()
                .ok_or_else(|| format!("{path} missing"))
        });
        for item in &index.items {
            out.extend(item.diagnostics.iter().cloned());
            if item.license_restricted {
                out.push(Diagnostic::warning(
                    format!(
                        "SKILL.md declares a proprietary licence (\u{201c}{}\u{201d}). Sharing it copies it into the library; make sure its terms allow that.",
                        item.license.as_deref().unwrap_or_default()
                    ),
                    Some("SKILL.md"),
                ));
            }
        }
        out.extend(index.diagnostics);
        for (path, bytes) in outgoing {
            if let Some(what) = crate::redact::looks_secret(&String::from_utf8_lossy(bytes)) {
                out.push(Diagnostic::error(
                    format!("{path} appears to contain {what}. Remove it before sharing."),
                    Some(path),
                ));
            }
        }
        if let Some(path) = &stored.replaces {
            let name = path.rsplit('/').next().unwrap_or(path);
            out.push(Diagnostic::warning(
                format!(
                    "A library skill named `{name}` already exists at {path}; this contribution replaces its files."
                ),
                None,
            ));
        }
        out.extend(reference_problems(&c.item_path, cmp, base, staged));
        if cmp
            .files
            .iter()
            .all(|f| f.status == DraftFileStatus::Unchanged)
        {
            out.push(Diagnostic::warning(
                "Nothing differs from the library yet.",
                None,
            ));
        } else if !cmp.any_included_change {
            out.push(Diagnostic::error(
                "Every changed file is left out, so there is nothing to share. Include at least one.",
                None,
            ));
        }
        out
    }

    pub fn list(&self) -> Result<Vec<Contribution>> {
        let ids: Vec<String> = {
            let conn = self.store.conn()?;
            let mut stmt = conn.prepare(
                "SELECT id FROM contributions WHERE state != 'discarded' ORDER BY updated_at DESC",
            )?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        // Each source's current snapshot is listed once, not per contribution.
        let mut snapshots: BTreeMap<String, Option<(String, Vec<SnapshotFile>)>> = BTreeMap::new();
        ids.iter()
            .map(|id| {
                self.load_row(id).map(|(mut c, stored)| {
                    if c.state != ContributionState::Draft {
                        let snapshot = snapshots
                            .entry(c.source_id.clone())
                            .or_insert_with(|| self.current_snapshot(&c.source_id));
                        // A library that has not moved since the contribution
                        // started cannot contain it yet.
                        if let Some(s) = snapshot.as_ref().filter(|s| s.0 != c.base_commit) {
                            let outgoing = if stored.excluded.is_empty() {
                                self.staged(id).unwrap_or_default()
                            } else {
                                self.comparison(&c, &stored)
                                    .map(|(cmp, _, _)| cmp.outgoing)
                                    .unwrap_or_default()
                            };
                            c.in_library = self.matches_library(&c, &outgoing, Some(s));
                        }
                    }
                    c.remote = self.remote_info(&c);
                    c
                })
            })
            .collect()
    }

    /// Creates the contribution commit on a branch in Habi's cache.
    pub fn commit(&self, id: &str, cancel: &CancelToken) -> Result<Contribution> {
        self.commit_with(id, false, cancel)
    }

    /// Like `commit`. For a revision whose branch someone else pushed to,
    /// `build_on_remote` (the user's explicit choice) builds on their commits;
    /// otherwise Habi stops with a `conflict` and changes nothing.
    pub fn commit_with(
        &self,
        id: &str,
        build_on_remote: bool,
        cancel: &CancelToken,
    ) -> Result<Contribution> {
        self.commit_inner(id, build_on_remote, cancel)
            .inspect_err(|e| self.record_attention(id, AttentionKind::Prepare, e))
    }

    /// Remembers that preparing or sending failed, so Sharing activity can
    /// say so until the next attempt succeeds. Problems the author fixes in
    /// the form (validation, nothing to share) and cancellation are not
    /// recorded; they are reported where the author acted.
    fn record_attention(&self, id: &str, kind: AttentionKind, error: &HabiError) {
        let kind = match error {
            HabiError::Cancelled | HabiError::InvalidInput(_) => return,
            HabiError::Conflict(_) => AttentionKind::RemoteMoved,
            _ => kind,
        };
        let Ok((mut c, mut stored)) = self.load_active(id) else {
            return;
        };
        let now = crate::time::now();
        stored.attention = Some(Attention {
            kind,
            message: error.to_info().message,
            at: now.clone(),
        });
        c.updated_at = now;
        let _ = self.save_row(&c, &stored);
    }

    fn commit_inner(
        &self,
        id: &str,
        build_on_remote: bool,
        cancel: &CancelToken,
    ) -> Result<Contribution> {
        self.load_active(id)?;
        let preview = self.preview(id)?;
        if preview
            .validation
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error)
        {
            return Err(HabiError::invalid(
                "fix the validation errors before committing",
            ));
        }
        if !preview
            .files
            .iter()
            .any(|f| f.status != DraftFileStatus::Unchanged && f.included)
        {
            return Err(HabiError::invalid(
                "nothing to contribute: the files that would be shared match the library",
            ));
        }
        let (mut c, mut stored) = self.load_row(id)?;
        if c.state != ContributionState::Draft {
            // Already prepared (a retry): the same branch and commit.
            return Ok(preview);
        }
        let git = self.git()?;
        let cache = self.sources.cache_dir(&c.source_id);
        let parent = match stored.parent_commit.clone() {
            None => c.base_commit.clone(),
            Some(previous) => {
                self.revision_parent(&c, &previous, build_on_remote, &git, &cache, cancel)?
            }
        };
        let identity = git
            .run(
                Some(&cache),
                &["config", "--get", "user.email"],
                Duration::from_secs(10),
                cancel,
            )
            .map(|o| o.stdout_text().trim().to_string())
            .unwrap_or_default();
        if identity.is_empty() {
            return Err(HabiError::invalid(
                "Git does not know your name and email. Run `git config --global user.name \"…\"` and `git config --global user.email \"…\"` so the contribution is attributed to you.",
            ));
        }
        let work = self.paths.contributions().join(&c.id);
        let index_file = work.join("index");
        let _ = std::fs::remove_file(&index_file);
        let index_env = index_file.to_string_lossy().to_string();
        let env = [("GIT_INDEX_FILE", index_env.as_str())];
        git.run_env(Some(&cache), &["read-tree", &parent], &env, cancel)?;
        let repo_path = |name: &str| -> String {
            let p = format!("{}/{}", c.item_path, name);
            if stored.prefix.is_empty() {
                p
            } else {
                format!("{}/{p}", stored.prefix)
            }
        };
        let dir = staging(self.paths, id);
        // Exactly what is shared: the staged files, except changes the
        // author left out, which keep the library's version.
        let (cmp, _, _) = self.comparison(&c, &stored)?;
        let (base, base_executables) = self.base_files(&c)?;
        let kept_dir = work.join("kept");
        let _ = std::fs::remove_dir_all(&kept_dir);
        for name in &cmp.kept {
            atomic_write(&RelPath::new(name)?.to_path(&kept_dir), &base[name])?;
        }
        let source_of = |name: &str| -> Result<PathBuf> {
            Ok(RelPath::new(name)?.to_path(if cmp.kept.contains(name) {
                &kept_dir
            } else {
                &dir
            }))
        };
        let staged = &cmp.outgoing;
        let folder = repo_path("");
        let folder = folder.trim_end_matches('/');
        // Path -> (mode, object id) of what the parent has in the folder.
        let in_parent: BTreeMap<String, (String, String)> = git
            .ls_tree(&cache, &parent, Some(folder), cancel)?
            .into_iter()
            .map(|e| (e.path, (e.mode, e.oid)))
            .collect();

        // All blobs in one `hash-object` process (no filters: the bytes are
        // stored exactly as staged).
        let mut oids: Vec<String> = Vec::new();
        if !staged.is_empty() {
            let mut list = String::new();
            for name in staged.keys() {
                list.push_str(&source_of(name)?.to_string_lossy());
                list.push('\n');
            }
            let out = git.run_with_input(
                Some(&cache),
                &["hash-object", "-w", "--no-filters", "--stdin-paths"],
                list.into_bytes(),
                staged.len() * 72 + 1024,
                cancel,
            )?;
            oids = out
                .stdout_text()
                .lines()
                .map(|l| l.trim().to_string())
                .collect();
            if oids.len() != staged.len()
                || oids
                    .iter()
                    .any(|o| o.len() < 40 || !o.chars().all(|ch| ch.is_ascii_hexdigit()))
            {
                return Err(HabiError::Internal(
                    "unexpected output from git hash-object".into(),
                ));
            }
        }
        // The skill folder becomes exactly the staged files: anything else
        // under it in the parent (removed here, or left by an earlier
        // revision) is dropped. One `update-index --index-info` adds and
        // removes; mode 0 removes an entry without a work tree (Habi's cache
        // is bare, where `--force-remove` is refused).
        let mut entries = Vec::new();
        for (name, oid) in staged.keys().zip(&oids) {
            let path = repo_path(name);
            // Keep executable scripts executable in the library. The bit was
            // recorded when the files were copied; where the file system
            // cannot show it, a file the parent has as executable stays so.
            let parent_exec = in_parent.get(&path).is_some_and(|(m, _)| m == "100755");
            let executable = if cmp.kept.contains(name) {
                base_executables.contains(name)
            } else {
                match &stored.executables {
                    Some(set) => set.contains(name) || (!cfg!(unix) && parent_exec),
                    None => {
                        crate::fsutil::is_executable(&RelPath::new(name)?.to_path(&dir))
                            || (!cfg!(unix) && parent_exec)
                    }
                }
            };
            let mode = if executable { "100755" } else { "100644" };
            entries.extend_from_slice(format!("{mode} {oid}\t{path}\0").as_bytes());
        }
        for (path, (_, oid)) in &in_parent {
            let Some(name) = path.strip_prefix(&format!("{folder}/")) else {
                continue;
            };
            if !staged.contains_key(name) {
                let zero = "0".repeat(oid.len());
                entries.extend_from_slice(format!("0 {zero}\t{path}\0").as_bytes());
            }
        }
        if !entries.is_empty() {
            git.run_env_with_input(
                Some(&cache),
                &["update-index", "-z", "--index-info"],
                &env,
                entries,
                cancel,
            )?;
        }
        let tree = git
            .run_env(Some(&cache), &["write-tree"], &env, cancel)?
            .stdout_text()
            .trim()
            .to_string();
        let _ = std::fs::remove_file(&index_file);
        let _ = std::fs::remove_dir_all(&kept_dir);
        if stored.parent_commit.is_some() {
            let parent_tree = git
                .run(
                    Some(&cache),
                    &["rev-parse", "--verify", &format!("{parent}^{{tree}}")],
                    Duration::from_secs(30),
                    cancel,
                )?
                .stdout_text()
                .trim()
                .to_string();
            if parent_tree == tree {
                return Err(HabiError::invalid(
                    "Nothing changed since the version you sent. Edit the skill, then prepare again.",
                ));
            }
        }
        let mut message = c.title.clone();
        if !stored.message.trim().is_empty() {
            message.push_str("\n\n");
            message.push_str(stored.message.trim());
        }
        if stored.revision > 0 {
            message.push_str(&format!("\n\nRevision {} after review.", stored.revision));
        }
        message.push_str("\n\nPrepared with Habi.");
        let commit = git
            .run_with_input(
                Some(&cache),
                &["commit-tree", &tree, "-p", &parent, "-F", "-"],
                message.into_bytes(),
                4096,
                cancel,
            )?
            .stdout_text()
            .trim()
            .to_string();
        git.update_ref(&cache, &format!("refs/heads/{}", c.branch), &commit, cancel)?;
        c.commit_id = Some(commit);
        c.state = ContributionState::Committed;
        c.updated_at = crate::time::now();
        stored.parent_commit = None;
        stored.before_revision = None;
        stored.attention = None;
        self.save_row(&c, &stored)?;
        self.preview(id)
    }

    /// The commit a revision builds on: the one Habi pushed last, unless the
    /// branch on the remote has moved past it.
    fn revision_parent(
        &self,
        c: &Contribution,
        previous: &str,
        build_on_remote: bool,
        git: &Git,
        cache: &Path,
        cancel: &CancelToken,
    ) -> Result<String> {
        if c.pushed_commit.is_none() {
            // Never sent: nobody else can have built on it.
            return Ok(previous.to_string());
        }
        let url = self.sources.fetch_url(&c.source_id)?;
        let tracking = format!("refs/habi/review/{}", c.id);
        match git.fetch(
            cache,
            &url,
            &format!("refs/heads/{}", c.branch),
            &tracking,
            cancel,
        ) {
            Ok(()) => {}
            // The branch is gone (merged and deleted, or removed by hand);
            // pushing the revision recreates it.
            Err(HabiError::Git {
                failure: GitFailure::NotFound,
                message,
            }) if message
                .to_ascii_lowercase()
                .contains("couldn't find remote ref") =>
            {
                return Ok(previous.to_string());
            }
            // Network, sign-in, a missing repository, cancellation: Habi
            // cannot tell whether someone else pushed, so it stops.
            Err(e) => return Err(e),
        }
        let remote = git.rev_parse_commit(cache, &tracking, cancel)?;
        if remote == previous || git.is_ancestor(cache, &remote, previous, cancel)? {
            return Ok(previous.to_string());
        }
        if build_on_remote {
            return Ok(remote);
        }
        Err(HabiError::Conflict(format!(
            "Someone else pushed to {} since you sent it (now at {}). Habi will not overwrite their commits. Choose to build on them, or start a new contribution.",
            c.branch,
            &remote[..remote.len().min(10)]
        )))
    }

    /// Asks the Git host about the request for this contribution's branch.
    fn check_host(&self, c: &Contribution, cancel: &CancelToken) -> HostCheck {
        let url = match self.sources.fetch_url(&c.source_id) {
            Ok(url) => url,
            Err(e) => return HostCheck::Unavailable(e.to_string()),
        };
        if Path::new(&url).is_absolute() {
            return HostCheck::NoHost;
        }
        let Some(repo) = remote_repo(&url) else {
            return HostCheck::Unavailable(
                "the remote is not a recognizable GitHub or GitLab address".into(),
            );
        };
        match crate::review::fetch_status(self.tools, &repo, &c.branch, cancel) {
            Ok(Some(status)) => HostCheck::Found(status),
            Ok(None) => HostCheck::NoRequest,
            Err(message) => HostCheck::Unavailable(message),
        }
    }

    /// Reopens a sent (or prepared) contribution so it can be changed after
    /// review. The next "Prepare branch" adds a commit to the same branch, and
    /// sending it updates the request that is already open. Skills from My
    /// skills and from a project are copied again from where they live.
    pub fn revise(&self, id: &str, project_root: Option<&Path>) -> Result<Contribution> {
        self.revise_with(id, project_root, &CancelToken::new())
    }

    /// `revise`, checking the request on the Git host first when the branch
    /// was sent: a merged or closed request cannot be revised. When the host
    /// cannot be asked, the revision is allowed and says so.
    pub fn revise_with(
        &self,
        id: &str,
        project_root: Option<&Path>,
        cancel: &CancelToken,
    ) -> Result<Contribution> {
        let (mut c, mut stored) = self.load_active(id)?;
        if c.state == ContributionState::Draft {
            // Already open for changes: nothing to reopen, no new revision.
            return self.preview(id);
        }
        let commit = c
            .commit_id
            .clone()
            .ok_or_else(|| HabiError::invalid("prepare the branch first"))?;
        let mut unchecked = None;
        if c.pushed_commit.is_some() {
            match self.check_host(&c, cancel) {
                HostCheck::Found(status) => {
                    if c.published_url.is_none() {
                        c.published_url = status.url.clone();
                    }
                    stored.review = Some(status);
                }
                HostCheck::NoRequest => stored.review = None,
                HostCheck::Unavailable(reason) => {
                    if cancel.is_cancelled() {
                        return Err(HabiError::Cancelled);
                    }
                    unchecked = Some(reason);
                }
                HostCheck::NoHost => {}
            }
        }
        if let Some(review) = &stored.review
            && is_finished(review.state)
        {
            let message = finished_message(review);
            c.updated_at = crate::time::now();
            self.save_row(&c, &stored)?;
            return Err(HabiError::invalid(message));
        }
        let backup = RevisionBackup {
            state: c.state,
            revision: stored.revision,
            title: c.title.clone(),
            message: stored.message.clone(),
            form: stored.form.clone(),
            publish_note: stored.publish_note.clone(),
        };
        self.sync_from_origin(&c, &mut stored, project_root, true)?;
        stored.before_revision = Some(backup);
        stored.parent_commit = Some(commit.clone());
        // Only a version that was sent gets a "Revision n after review".
        if c.pushed_commit.as_deref() == Some(commit.as_str()) {
            stored.revision += 1;
        }
        if let Some(reason) = unchecked {
            stored.publish_note = Some(format!(
                "Habi could not check the review request ({reason}). If it was merged or closed, this revision will not reach it; share the skill again as a new contribution instead."
            ));
        }
        c.commit_id = None;
        c.state = ContributionState::Draft;
        c.updated_at = crate::time::now();
        stored.attention = None;
        self.save_row(&c, &stored)?;
        self.preview(id)
    }

    /// While revising a skill from My skills or a project: copies it again
    /// from where it lives, keeping form changes made since. Called before
    /// preparing a revision so edits made after "Revise" are included.
    /// Anything else is returned unchanged.
    pub fn resync(&self, id: &str, project_root: Option<&Path>) -> Result<Contribution> {
        let (c, mut stored) = self.load_active(id)?;
        if c.state == ContributionState::Draft
            && stored.parent_commit.is_some()
            && self.sync_from_origin(&c, &mut stored, project_root, false)?
        {
            self.save_row(&c, &stored)?;
        }
        self.preview(id)
    }

    /// Backs out of a revision: the contribution returns to the version it
    /// was before "Revise" (same commit, state, title, message and form), and
    /// the staged files to that commit's.
    pub fn cancel_revision(&self, id: &str, cancel: &CancelToken) -> Result<Contribution> {
        let (mut c, mut stored) = self.load_active(id)?;
        let Some(previous) = stored
            .parent_commit
            .clone()
            .filter(|_| c.state == ContributionState::Draft)
        else {
            return Err(HabiError::invalid("no revision is in progress"));
        };
        self.restore_staging(&c, &mut stored, &previous, cancel)?;
        let backup = stored.before_revision.take();
        c.commit_id = Some(previous.clone());
        c.state = match &backup {
            Some(b) => b.state,
            None if c.pushed_commit.as_deref() == Some(previous.as_str()) => {
                ContributionState::Published
            }
            None => ContributionState::Committed,
        };
        if let Some(b) = backup {
            stored.revision = b.revision;
            c.title = b.title;
            stored.message = b.message;
            stored.form = b.form;
            stored.publish_note = b.publish_note;
        }
        stored.synced_form = Some(stored.form.clone());
        stored.parent_commit = None;
        stored.attention = None;
        c.updated_at = crate::time::now();
        self.save_row(&c, &stored)?;
        self.preview(id)
    }

    /// Makes the staging folder hold exactly the skill folder of `commit`.
    fn restore_staging(
        &self,
        c: &Contribution,
        stored: &mut Stored,
        commit: &str,
        cancel: &CancelToken,
    ) -> Result<()> {
        let git = self.git()?;
        let cache = self.sources.cache_dir(&c.source_id);
        let folder = if stored.prefix.is_empty() {
            c.item_path.clone()
        } else {
            format!("{}/{}", stored.prefix, c.item_path)
        };
        let entries: Vec<_> = git
            .ls_tree(&cache, commit, Some(&folder), cancel)?
            .into_iter()
            .filter(|e| e.kind == "blob")
            .collect();
        let oids: Vec<String> = entries.iter().map(|e| e.oid.clone()).collect();
        let total: u64 = entries.iter().filter_map(|e| e.size).sum();
        let blobs = git.read_blobs(&cache, &oids, total, cancel)?;
        let mut files = BTreeMap::new();
        let mut executables = BTreeSet::new();
        for (entry, bytes) in entries.iter().zip(blobs) {
            let Some(name) = entry.path.strip_prefix(&format!("{folder}/")) else {
                continue;
            };
            RelPath::new(name)?;
            if entry.mode == "100755" {
                executables.insert(name.to_string());
            }
            files.insert(name.to_string(), bytes);
        }
        write_staging(&staging(self.paths, &c.id), &files, &executables)?;
        stored.executables = Some(executables);
        Ok(())
    }

    /// Reads the request for this contribution's branch from the Git host.
    /// Only on request; the result is kept so the page can show when it was
    /// last checked.
    pub fn refresh_review(&self, id: &str, cancel: &CancelToken) -> Result<Contribution> {
        let (mut c, mut stored) = self.load_active(id)?;
        if c.pushed_commit.is_none() && c.state != ContributionState::Published {
            return Err(HabiError::invalid(
                "nothing was sent for review yet, so there is no request to check",
            ));
        }
        let url = self.sources.fetch_url(&c.source_id)?;
        if Path::new(&url).is_absolute() {
            return Err(HabiError::Unsupported(
                "this library is a repository on this machine; there is no Git host to ask".into(),
            ));
        }
        let repo = remote_repo(&url).ok_or_else(|| {
            HabiError::Unsupported(
                "this remote is not a recognizable GitHub or GitLab address".into(),
            )
        })?;
        match crate::review::fetch_status(self.tools, &repo, &c.branch, cancel) {
            Ok(Some(status)) => {
                if c.published_url.is_none() {
                    c.published_url = status.url.clone();
                }
                stored.review = Some(status);
                stored.publish_note = None;
            }
            Ok(None) => {
                stored.review = None;
                stored.publish_note = Some(format!(
                    "No request for {} exists on the host yet. Open one there, then check again.",
                    c.branch
                ));
            }
            Err(message) => return Err(HabiError::Unsupported(message)),
        }
        c.updated_at = crate::time::now();
        self.save_row(&c, &stored)?;
        self.preview(id)
    }

    /// Writes the contribution as a patch file (`git format-patch`): every
    /// commit from the library snapshot it started from, so the file applies
    /// to the tracked branch even after revisions.
    pub fn export_patch(&self, id: &str, dest_dir: &Path, cancel: &CancelToken) -> Result<PathBuf> {
        let (mut c, stored) = self.load_active(id)?;
        let commit = c
            .commit_id
            .clone()
            .ok_or_else(|| HabiError::invalid("commit the contribution first"))?;
        if !dest_dir.is_dir() {
            return Err(HabiError::invalid(format!(
                "{} is not a folder",
                display_path(dest_dir)
            )));
        }
        let git = self.git()?;
        let cache = self.sources.cache_dir(&c.source_id);
        let range = format!("{}..{commit}", c.base_commit);
        let out = git.run_limited(
            Some(&cache),
            &["format-patch", "--stdout", "--no-signature", &range],
            Duration::from_secs(300),
            PATCH_LIMIT,
            cancel,
        )?;
        if out.stdout.is_empty() {
            return Err(HabiError::Internal(
                "git format-patch produced no patch".into(),
            ));
        }
        let path = dest_dir.join(format!("{}.patch", c.branch.replace('/', "-")));
        atomic_write(&path, &out.stdout)?;
        c.patch_path = Some(display_path(&path));
        if c.state == ContributionState::Committed {
            c.state = ContributionState::Exported;
        }
        c.updated_at = crate::time::now();
        self.save_row(&c, &stored)?;
        Ok(path)
    }

    /// Pushes the contribution branch to the library's remote and, when
    /// possible, opens a pull/merge request. Never pushes to the tracked
    /// branch and never merges. When the branch was sent before, the request
    /// is checked first: a merged or closed request is not pushed to, and
    /// "updated the open request" is said only when the host showed it open.
    ///
    /// Sending again after a failure is safe: the branch name is fixed per
    /// contribution, a push never overwrites commits, and a request is opened
    /// only when the host does not already show one for the branch.
    pub fn publish(
        &self,
        id: &str,
        open_request: bool,
        cancel: &CancelToken,
    ) -> Result<PublishOutcome> {
        self.publish_inner(id, open_request, cancel)
            .inspect_err(|e| self.record_attention(id, AttentionKind::Send, e))
    }

    fn publish_inner(
        &self,
        id: &str,
        open_request: bool,
        cancel: &CancelToken,
    ) -> Result<PublishOutcome> {
        let (mut c, mut stored) = self.load_active(id)?;
        let commit = c
            .commit_id
            .clone()
            .ok_or_else(|| HabiError::invalid("commit the contribution first"))?;
        let source = self.sources.get(&c.source_id)?;
        let url = self.sources.fetch_url(&c.source_id)?;
        let git = self.git()?;
        let cache = self.sources.cache_dir(&c.source_id);
        let target = format!("refs/heads/{}", c.branch);
        if let TrackedRef::Branch { name } = &source.tracked
            && c.branch == *name
        {
            return Err(HabiError::invalid(
                "refusing to push to the library's tracked branch",
            ));
        }
        let local = Path::new(&url).is_absolute();
        let sent_before =
            stored.pushed_commit.is_some() || c.published_url.is_some() || stored.review.is_some();
        let check = if sent_before && !local {
            let check = self.check_host(&c, cancel);
            if cancel.is_cancelled() {
                return Err(HabiError::Cancelled);
            }
            match &check {
                HostCheck::Found(status) => {
                    stored.review = Some(status.clone());
                    if is_finished(status.state) {
                        let message = finished_message(status);
                        c.updated_at = crate::time::now();
                        self.save_row(&c, &stored)?;
                        return Err(HabiError::invalid(format!("{message}; nothing was pushed")));
                    }
                }
                HostCheck::NoRequest => stored.review = None,
                HostCheck::NoHost | HostCheck::Unavailable(_) => {}
            }
            Some(check)
        } else {
            None
        };
        if local {
            // A library on this machine: pushing would run that repository's
            // receive hooks with its own configuration. Instead, fetch the
            // branch into it; Git then runs inside the target with Habi's
            // hook-free configuration. Without `+`, an existing branch is not
            // overwritten.
            let cache_path = cache.to_string_lossy().to_string();
            git.run(
                None,
                &[
                    "-C",
                    &url,
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--quiet",
                    "--",
                    &cache_path,
                    &format!("{target}:{target}"),
                ],
                Duration::from_secs(300),
                cancel,
            )?;
        } else {
            git.run(
                Some(&cache),
                &[
                    "push",
                    "--porcelain",
                    "--",
                    &url,
                    &format!("{commit}:{target}"),
                ],
                Duration::from_secs(300),
                cancel,
            )?;
        }
        let mut outcome = PublishOutcome {
            remote: crate::redact::redact(&if url.starts_with('/') {
                display_path(Path::new(&url))
            } else {
                url.clone()
            }),
            branch: c.branch.clone(),
            pull_request_url: None,
            pull_request_note: None,
            updated_existing: false,
        };
        stored.pushed_commit = Some(commit.clone());
        let mut keep_url = false;
        match check {
            // Seen open on the host just now: it shows the new commit.
            Some(HostCheck::Found(status)) => {
                outcome.pull_request_url = status.url.clone().or_else(|| c.published_url.clone());
                outcome.updated_existing = true;
            }
            Some(HostCheck::Unavailable(reason)) => {
                keep_url = true;
                outcome.pull_request_note = Some(format!(
                    "The branch was pushed. Habi could not check the review request ({reason}); if it is still open, it now shows this commit."
                ));
            }
            _ if local => {
                outcome.pull_request_note = Some(
                    "The branch is in the library repository on this machine; review it there."
                        .into(),
                );
            }
            _ if open_request => {
                let base = match &source.tracked {
                    TrackedRef::Branch { name } => Some(name.clone()),
                    TrackedRef::Default => default_branch(&git, &url, cancel),
                    TrackedRef::Tag { .. } => None,
                };
                match (base, remote_repo(&url)) {
                    (None, _) => {
                        outcome.pull_request_note = Some("The library tracks a tag, so there is no branch to target. Open a request on your Git host from the pushed branch.".into());
                    }
                    (_, None) => {
                        outcome.pull_request_note = Some("This remote is not a recognizable GitHub or GitLab URL. Open a request on your Git host from the pushed branch.".into());
                    }
                    (Some(base), Some(repo)) => {
                        let body = if stored.message.trim().is_empty() {
                            "Prepared with Habi. Please review before merging.".to_string()
                        } else {
                            format!(
                                "{}\n\nPrepared with Habi. Please review before merging.",
                                stored.message.trim()
                            )
                        };
                        match crate::review::open_request(
                            self.tools, &repo, &c.branch, &base, &c.title, &body, cancel,
                        ) {
                            Ok(url) => outcome.pull_request_url = Some(url),
                            Err(note) => outcome.pull_request_note = Some(note),
                        }
                    }
                }
            }
            _ => {}
        }
        c.state = ContributionState::Published;
        if outcome.pull_request_url.is_some() || !keep_url {
            c.published_url = outcome.pull_request_url.clone();
        }
        stored.publish_note = match (&outcome.pull_request_url, &outcome.pull_request_note) {
            (Some(_), _) => None,
            (None, Some(note)) => Some(note.clone()),
            (None, None) => Some("The branch was pushed; no review request was opened.".into()),
        };
        stored.attention = None;
        stored.published_at = Some(crate::time::now());
        c.updated_at = crate::time::now();
        self.save_row(&c, &stored)?;
        Ok(outcome)
    }

    /// Discards the contribution: its staged files and local branch are
    /// removed. It can no longer be prepared, exported, sent or checked.
    pub fn discard(&self, id: &str) -> Result<()> {
        let (mut c, mut stored) = self.load_row(id)?;
        let _ = std::fs::remove_dir_all(self.paths.contributions().join(id));
        if c.commit_id.is_some()
            && let Ok(git) = self.git()
        {
            let cache = self.sources.cache_dir(&c.source_id);
            let _ = git.run(
                Some(&cache),
                &["update-ref", "-d", &format!("refs/heads/{}", c.branch)],
                Duration::from_secs(10),
                &CancelToken::new(),
            );
        }
        c.commit_id = None;
        c.state = ContributionState::Discarded;
        stored.parent_commit = None;
        stored.before_revision = None;
        stored.attention = None;
        c.updated_at = crate::time::now();
        self.save_row(&c, &stored)
    }
}

fn default_branch(git: &Git, url: &str, cancel: &CancelToken) -> Option<String> {
    let out = git
        .run(
            None,
            &["ls-remote", "--symref", "--", url, "HEAD"],
            Duration::from_secs(60),
            cancel,
        )
        .ok()?;
    out.stdout_text()
        .lines()
        .find_map(|l| l.strip_prefix("ref: refs/heads/"))
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_round_trip_keeps_unknown_fields() {
        let existing = json!({
            "habi": 1, "title": "Old", "x-team": "keep me",
            "applies_when": { "all": [{ "tag": "framework:spring-boot" }, { "dependency": "org.liquibase:liquibase-core" }] },
            "requires": { "mcp": [{ "name": "github" }] }
        });
        let form = form_from(Some(&existing), "Default");
        assert!(form.conditions_editable);
        assert_eq!(form.applies_tags, vec!["framework:spring-boot"]);
        let mut edited = form.clone();
        edited.title = "New".into();
        edited.exclude_tags = vec!["db:jooq".into()];
        let v = apply_form(Some(existing), &edited);
        assert_eq!(v["x-team"], "keep me");
        assert_eq!(v["title"], "New");
        assert_eq!(v["excludes"], json!({ "tag": "db:jooq" }));
        assert!(v["requires"]["mcp"].is_array());
        assert!(crate::library::schema::validate_skill(&v).is_ok());
    }

    #[test]
    fn complex_conditions_are_kept_not_flattened() {
        let existing = json!({ "habi": 1, "applies_when": { "all": [{ "not": { "tag": "x" } }] } });
        let form = form_from(Some(&existing), "T");
        assert!(!form.conditions_editable);
        let v = apply_form(Some(existing.clone()), &form);
        assert_eq!(v["applies_when"], existing["applies_when"]);
    }

    fn rich_sidecar() -> Value {
        json!({
            "habi": 1,
            "title": "Tooling",
            "scope": "module",
            "x-team": "keep",
            "applies_when": { "any": [{ "tag": "lang:java" }, { "tag": "lang:kotlin" }] },
            "excludes": { "all": [{ "tag": "db:jooq" }, { "dependency": "org.jooq:jooq" }] },
            "requires": { "tools": [{
                "name": "Maven", "commands": ["mvn", "./mvnw"],
                "purpose": "Builds the module", "install_hint": "brew install maven"
            }] },
            "examples": [{ "title": "First", "description": "One", "path": "examples/one.md" }]
        })
    }

    #[test]
    fn saving_the_form_keeps_what_it_does_not_show() {
        let existing = rich_sidecar();
        let form = form_from(Some(&existing), "Fallback");
        assert!(form.conditions_editable);
        // Saved as read: nothing changes, not even the meaning of `excludes`.
        let same = apply_form(Some(existing.clone()), &form);
        assert_eq!(same, existing);
        assert_eq!(
            same.as_object().unwrap().keys().collect::<Vec<_>>(),
            existing.as_object().unwrap().keys().collect::<Vec<_>>(),
            "key order is kept"
        );

        // Editing rows keeps each row's other fields.
        let mut edited = form.clone();
        edited.tools[0].commands = vec!["mvn".into()];
        edited.examples[0].description = "Changed".into();
        edited.exclude_tags.push("db:mybatis".into());
        let v = apply_form(Some(existing.clone()), &edited);
        assert_eq!(v["requires"]["tools"][0]["purpose"], "Builds the module");
        assert_eq!(
            v["requires"]["tools"][0]["install_hint"],
            "brew install maven"
        );
        assert_eq!(v["requires"]["tools"][0]["commands"], json!(["mvn"]));
        assert_eq!(v["examples"][0]["path"], "examples/one.md");
        assert_eq!(v["examples"][0]["description"], "Changed");
        assert!(
            v["excludes"]["all"].as_array().unwrap().len() == 3,
            "the exclusion mode stays `all`: {}",
            v["excludes"]
        );
        assert_eq!(v["scope"], "module", "an explicit default stays");
        assert_eq!(v["x-team"], "keep");
        assert!(crate::library::schema::validate_skill(&v).is_ok());

        // A renamed row keeps its other fields too.
        let mut renamed = form.clone();
        renamed.tools[0].name = "Apache Maven".into();
        let v = apply_form(Some(existing.clone()), &renamed);
        assert_eq!(v["requires"]["tools"][0]["name"], "Apache Maven");
        assert_eq!(v["requires"]["tools"][0]["purpose"], "Builds the module");

        // Turning repository scope on and off again.
        let mut repo = form.clone();
        repo.repository_scope = true;
        let v = apply_form(Some(existing.clone()), &repo);
        assert_eq!(v["scope"], "repository");
        repo.repository_scope = false;
        let v = apply_form(Some(v), &repo);
        assert!(v.get("scope").is_none());
    }

    #[test]
    fn merging_writes_only_the_parts_that_changed() {
        // Written in a shape the form would normalize differently.
        let existing = json!({
            "owner": "Data Guild",
            "habi": 1,
            "applies_when": { "all": [{ "tag": "lang:java" }] },
            "examples": [{ "title": "First" }]
        });
        let baseline = form_from(Some(&existing), "Fallback title");
        let mut form = baseline.clone();
        form.owner = "Platform".into();
        let v = merge_form(Some(existing.clone()), &form, &baseline);
        assert_eq!(v["owner"], "Platform");
        assert_eq!(
            v["applies_when"], existing["applies_when"],
            "untouched parts are not rewritten"
        );
        assert!(
            v.get("title").is_none(),
            "the fallback title is not written"
        );
        assert_eq!(
            v.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["owner", "habi", "applies_when", "examples"]
        );
        // A form that changes nothing merges to the same value.
        assert_eq!(
            merge_form(Some(existing.clone()), &baseline, &baseline),
            existing
        );
    }

    #[test]
    fn unchanged_form_leaves_the_metadata_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let text =
            "# Team notes\nowner:   Data Guild   # who answers questions\nhabi: 1\nscope: module\n";
        std::fs::write(dir.path().join("habi.yml"), text).unwrap();
        let form = form_in(dir.path(), "Fallback");
        write_sidecar(dir.path(), &form, None, "Fallback").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("habi.yml")).unwrap(),
            text
        );
        assert!(!dir.path().join("habi.yaml").exists());

        let mut changed = form.clone();
        changed.owner = "Platform".into();
        write_sidecar(dir.path(), &changed, None, "Fallback").unwrap();
        assert!(
            !dir.path().join("habi.yaml").exists(),
            "the existing habi.yml is updated, not shadowed"
        );
        let written = std::fs::read_to_string(dir.path().join("habi.yml")).unwrap();
        assert!(written.starts_with("# Team notes\n"), "{written}");
        assert!(written.contains("owner: Platform"), "{written}");
        assert!(written.contains("scope: module"), "{written}");
        assert!(
            written.find("owner").unwrap() < written.find("habi:").unwrap(),
            "{written}"
        );
    }

    #[test]
    fn os_junk_is_not_shared() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("SKILL.md"), "x").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        for junk in [".DS_Store", "sub/Thumbs.db", "sub/desktop.ini"] {
            std::fs::write(dir.path().join(junk), "junk").unwrap();
        }
        let files = read_folder(dir.path()).unwrap();
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["SKILL.md"]);
    }

    fn files(list: &[(&str, &str)]) -> Files {
        list.iter()
            .map(|(p, t)| (p.to_string(), t.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn renames_pair_identical_content_and_a_new_skill_keeps_its_skill_md() {
        let base = files(&[("SKILL.md", "a"), ("old/x.md", "same"), ("y.md", "y")]);
        let staged = files(&[
            ("SKILL.md", "b"),
            ("new/x.md", "same"),
            ("copy.md", "same"),
            ("y.md", "y"),
        ]);
        let cmp = compare("skills/s", &base, &staged, &BTreeSet::new());
        let got: Vec<(&str, DraftFileStatus, Option<&str>)> = cmp
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.previous_path.as_deref()))
            .collect();
        // One removed path pairs with one added path; the other copy is new.
        assert_eq!(
            got,
            vec![
                ("skills/s/SKILL.md", DraftFileStatus::Modified, None),
                (
                    "skills/s/copy.md",
                    DraftFileStatus::Renamed,
                    Some("skills/s/old/x.md")
                ),
                ("skills/s/new/x.md", DraftFileStatus::Added, None),
                ("skills/s/y.md", DraftFileStatus::Unchanged, None),
            ]
        );
        // Leaving the rename out keeps the old path.
        let left_out = compare(
            "skills/s",
            &base,
            &staged,
            &BTreeSet::from(["copy.md".to_string()]),
        );
        assert!(left_out.outgoing.contains_key("old/x.md"));
        assert!(!left_out.outgoing.contains_key("copy.md"));

        // A new skill cannot leave its SKILL.md out.
        let fresh = compare(
            "skills/n",
            &Files::new(),
            &files(&[("SKILL.md", "x"), ("notes.md", "n")]),
            &BTreeSet::from(["SKILL.md".to_string(), "notes.md".to_string()]),
        );
        let skill = &fresh.files[0];
        assert!(skill.included);
        assert_eq!(skill.required.as_deref(), Some(NEW_SKILL_FILE));
        assert!(!fresh.files[1].included);
        assert_eq!(fresh.outgoing.keys().collect::<Vec<_>>(), vec!["SKILL.md"]);
    }

    #[test]
    fn markdown_names_package_files_in_links_and_inline_code() {
        let text = "\
See [the checklist](references/checklist.md#top) and ![img](./assets/a%20b.png \"t\").
Run `scripts/check.sh` but not `npm test`, `-v`, `src/**/*.ts` or `scripts/`.
[def]: ../escape.md
Visit [site](https://example.invalid/x.md) or [mail](mailto:a@b) or [abs](/etc/x.md).
```
`scripts/in-fence.sh`
```
";
        let refs = markdown_references("SKILL.md", text);
        assert_eq!(
            refs.into_iter().collect::<Vec<_>>(),
            vec![
                "assets/a b.png",
                "references/checklist.md",
                "scripts/check.sh"
            ]
        );
        // Links resolve from the file's folder; inline code from the package.
        let nested = markdown_references(
            "references/a.md",
            "[b](b.md) [up](../SKILL.md) `scripts/x.sh`",
        );
        assert_eq!(
            nested.into_iter().collect::<Vec<_>>(),
            vec!["SKILL.md", "references/b.md", "scripts/x.sh"]
        );
    }
}
