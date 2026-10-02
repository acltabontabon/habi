//! Library items as Habi understands them.

use crate::clients::ClientId;
use crate::matching::Scope;
use crate::matching::condition::Condition;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ItemKind {
    Skill,
    Workflow,
    /// Portable project instructions installed into AGENTS.md.
    Instructions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Requirement {
    #[default]
    Recommended,
    /// Designated by the team as required. Always listed; never filtered out.
    Required,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetadataStatus {
    /// A valid habi.yaml (or manifest entry) declares metadata.
    Declared,
    /// No Habi metadata; the item is a plain skill.
    Undeclared,
    /// Habi metadata exists but is invalid; it is ignored.
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DiagnosticLevel {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub message: String,
    /// Library-relative file the diagnostic is about.
    pub path: Option<String>,
}

impl Diagnostic {
    pub fn error(message: impl Into<String>, path: Option<&str>) -> Self {
        Diagnostic {
            level: DiagnosticLevel::Error,
            message: message.into(),
            path: path.map(str::to_string),
        }
    }
    pub fn warning(message: impl Into<String>, path: Option<&str>) -> Self {
        Diagnostic {
            level: DiagnosticLevel::Warning,
            message: message.into(),
            path: path.map(str::to_string),
        }
    }
    pub fn info(message: impl Into<String>, path: Option<&str>) -> Self {
        Diagnostic {
            level: DiagnosticLevel::Info,
            message: message.into(),
            path: path.map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolRequirement {
    pub name: String,
    pub commands: Vec<String>,
    pub purpose: Option<String>,
    pub install_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "transport")]
#[ts(export)]
pub enum McpServerSpec {
    Stdio {
        command: String,
        args: Vec<String>,
        /// Variable name -> `${VAR}` reference. Never literal secrets.
        env: BTreeMap<String, String>,
    },
    #[serde(rename_all = "camelCase")]
    Http {
        url: String,
        bearer_token_env: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct McpRequirement {
    pub name: String,
    pub purpose: Option<String>,
    pub server: Option<McpServerSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkflowStep {
    pub title: String,
    pub detail: Option<String>,
    pub references: Vec<String>,
    pub expected: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkflowSpec {
    pub steps: Vec<WorkflowStep>,
    pub artifacts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BindingKind {
    File,
    Module,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BindingSpec {
    pub name: String,
    pub kind: BindingKind,
    pub glob: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum CheckArg {
    Literal { value: String },
    Binding { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CheckCwd {
    #[default]
    Module,
    Repository,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckSpec {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub run: Vec<CheckArg>,
    pub cwd: CheckCwd,
    pub timeout_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeclaredEvidence {
    pub date: String,
    pub result: String,
    pub environment: Option<String>,
    pub summary: Option<String>,
    pub by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Example {
    pub title: String,
    pub description: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ItemFile {
    /// Relative to the item directory (or the file name for instructions).
    pub path: String,
    pub digest: String,
    pub size: u64,
    /// The file is executable (e.g. a script under `scripts/`).
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryItem {
    /// `<source id>/<item id>`: unique across sources.
    pub key: String,
    pub source_id: String,
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    /// SKILL.md `name` (the directory name clients use).
    pub name: String,
    pub description: String,
    /// Library-relative directory (skills) or file (instructions).
    pub path: String,
    pub owner: Option<String>,
    /// SKILL.md `license`, as the author wrote it.
    pub license: Option<String>,
    /// Library-relative path of the nearest licence file in the item's folder
    /// or one of its parents (a repository's root `LICENSE`, say). Habi points
    /// at the terms; it does not interpret them.
    #[serde(default)]
    pub license_file: Option<String>,
    /// The author declared the item proprietary (in `license`). Copying or
    /// sharing it may not be permitted.
    #[serde(default)]
    pub license_restricted: bool,
    /// What this skill was refined from (`metadata.based-on`):
    /// `<library>#<item>@<version>`. Recorded by Habi when sharing a copy.
    #[serde(default)]
    pub based_on: Option<String>,
    pub compatibility: Option<String>,
    pub requirement: Requirement,
    pub priority: i32,
    pub scope: Scope,
    pub applies_when: Option<Condition>,
    pub excludes: Option<Condition>,
    pub tools: Vec<ToolRequirement>,
    pub mcp: Vec<McpRequirement>,
    /// `None` when not restricted.
    pub clients: Option<Vec<ClientId>>,
    pub workflow: Option<WorkflowSpec>,
    pub bindings: Vec<BindingSpec>,
    pub checks: Vec<CheckSpec>,
    pub evidence: Vec<DeclaredEvidence>,
    pub examples: Vec<Example>,
    pub files: Vec<ItemFile>,
    pub content_digest: String,
    pub metadata_status: MetadataStatus,
    pub diagnostics: Vec<Diagnostic>,
    /// False if some of the item's files were skipped while reading the
    /// library (too large, symbolic links). Incomplete items are not installable.
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryIndex {
    pub source_id: String,
    pub snapshot: String,
    pub name: Option<String>,
    pub owner: Option<String>,
    pub description: Option<String>,
    pub contact: Option<String>,
    pub items: Vec<LibraryItem>,
    pub diagnostics: Vec<Diagnostic>,
}

/// A file in a library snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotFile {
    /// Relative to the library root (the source subdirectory, if any).
    pub path: String,
    pub digest: String,
    pub size: u64,
    /// Git mode 100755, or an executable bit on a folder source.
    #[serde(default)]
    pub executable: bool,
}
