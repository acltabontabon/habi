//! Recommendations: applicability, readiness, installation and evidence,
//! kept as separate facts and combined only for ordering and the next action.
//!
//! Ordering is transparent: team requirements first, then relevant items by
//! explicit team priority, specificity of the match, and readiness. There are
//! no popularity signals and no confidence percentages.

use crate::checks::{CheckRun, CheckStatus};
use crate::clients::{ClientId, mcp};
use crate::inspect::model::ProjectInspection;
use crate::install::lock::{LockFile, lock_key};
use crate::install::plan::read_project_file;
use crate::install::status::{InstallState, Installation};
use crate::library::model::{DeclaredEvidence, ItemKind, LibraryItem, MetadataStatus, Requirement};
use crate::matching::eval::Declaration;
use crate::matching::{Applicability, ApplicabilityResult, assess};
use crate::paths::display_path;
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PrerequisiteKind {
    Tool,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PrerequisiteStatus {
    Present,
    Missing,
    /// Found in a project's client configuration (not proof it works).
    Configured,
    /// Not in this project's client configuration; user-level settings were not read.
    NotConfigured,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Prerequisite {
    pub kind: PrerequisiteKind,
    pub name: String,
    pub status: PrerequisiteStatus,
    pub detail: String,
    pub purpose: Option<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReadinessState {
    Ready,
    Missing,
    Unknown,
    NoRequirements,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Readiness {
    pub state: ReadinessState,
    pub prerequisites: Vec<Prerequisite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EvidenceState {
    /// Only the author's declared records exist.
    AuthorDeclared,
    /// A check passed here for this version and project state.
    LocallyChecked,
    /// The latest local check failed.
    Failed,
    /// A local check passed, but the item or project changed since.
    Stale,
    NotEvaluated,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EvidenceSummary {
    pub state: EvidenceState,
    pub declared: Vec<DeclaredEvidence>,
    pub latest_run: Option<CheckRun>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Group {
    /// Designated required by the team.
    Required,
    Relevant,
    NeedsInformation,
    /// No applicability declared; available for manual use.
    Available,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NextAction {
    Install,
    Update,
    ResolveConflict,
    ProvideInformation,
    SetUpPrerequisites,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ItemSummary {
    pub key: String,
    pub source_id: String,
    pub source_name: String,
    pub id: String,
    pub title: String,
    pub name: String,
    pub description: String,
    pub kind: ItemKind,
    pub owner: Option<String>,
    pub requirement: Requirement,
    pub priority: i32,
    pub snapshot: String,
    pub metadata_status: MetadataStatus,
    pub diagnostics: u32,
    pub clients: Option<Vec<ClientId>>,
    pub has_checks: bool,
    pub has_workflow: bool,
    /// False when installing would be refused (an incomplete package, or a
    /// SKILL.md name clients cannot use as a folder name).
    pub installable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Recommendation {
    pub item: ItemSummary,
    pub group: Group,
    pub applicability: ApplicabilityResult,
    pub readiness: Readiness,
    pub install_state: InstallState,
    pub installation: Option<Installation>,
    pub evidence: EvidenceSummary,
    pub next_action: NextAction,
    /// Copies of this skill in the project that Habi does not manage.
    pub unmanaged_copies: Vec<String>,
}

pub fn summarize(item: &LibraryItem, source_name: &str, snapshot: &str) -> ItemSummary {
    ItemSummary {
        key: item.key.clone(),
        source_id: item.source_id.clone(),
        source_name: source_name.to_string(),
        id: item.id.clone(),
        title: item.title.clone(),
        name: item.name.clone(),
        description: item.description.clone(),
        kind: item.kind,
        owner: item.owner.clone(),
        requirement: item.requirement,
        priority: item.priority,
        snapshot: snapshot.to_string(),
        metadata_status: item.metadata_status,
        diagnostics: item.diagnostics.len() as u32,
        clients: item.clients.clone(),
        has_checks: !item.checks.is_empty(),
        has_workflow: item.workflow.is_some(),
        installable: installable(item),
    }
}

/// Mirrors the refusals in install planning, so an item that cannot be
/// installed is never offered for installation.
pub fn installable(item: &LibraryItem) -> bool {
    item.complete
        && (item.kind == ItemKind::Instructions
            || crate::library::check_skill_name(&item.name).is_ok())
}

/// Checks prerequisites without executing anything: tools are looked up on
/// PATH or in the project, MCP servers in the project's client configuration.
pub fn readiness(root: &Path, item: &LibraryItem, applicable_modules: &[String]) -> Readiness {
    let mut prerequisites = Vec::new();
    for tool in &item.tools {
        let mut found = None;
        for command in &tool.commands {
            if let Some(local) = command.strip_prefix("./") {
                let mut dirs = vec![".".to_string()];
                dirs.extend(
                    applicable_modules
                        .iter()
                        .filter(|m| *m != "." && *m != "*")
                        .cloned(),
                );
                for dir in dirs {
                    let rel = if dir == "." {
                        local.to_string()
                    } else {
                        format!("{dir}/{local}")
                    };
                    if matches!(read_project_file(root, &rel), Ok(Some(_))) {
                        found = Some(format!(
                            "{command} found in {}",
                            if dir == "." {
                                "the project root".into()
                            } else {
                                dir.clone()
                            }
                        ));
                        break;
                    }
                }
            } else if let Ok(path) = which::which(command) {
                found = Some(format!("{command} at {}", display_path(&path)));
            }
            if found.is_some() {
                break;
            }
        }
        prerequisites.push(Prerequisite {
            kind: PrerequisiteKind::Tool,
            name: tool.name.clone(),
            status: if found.is_some() {
                PrerequisiteStatus::Present
            } else {
                PrerequisiteStatus::Missing
            },
            detail: found.unwrap_or_else(|| {
                format!(
                    "none of {} found on PATH or in the project",
                    tool.commands.join(", ")
                )
            }),
            purpose: tool.purpose.clone(),
            hint: tool.install_hint.clone(),
        });
    }
    for requirement in &item.mcp {
        let mut configured = Vec::new();
        let mut unreadable = Vec::new();
        for client in ClientId::ALL {
            let file = mcp::config_path(client);
            match read_project_file(root, file) {
                Ok(bytes) => {
                    match mcp::is_configured(client, bytes.as_deref(), &requirement.name) {
                        Ok(true) => configured.push(format!("{} ({file})", client.label())),
                        Ok(false) => {}
                        Err(_) => unreadable.push(file),
                    }
                }
                Err(_) => unreadable.push(file),
            }
        }
        let (status, detail) = if !configured.is_empty() {
            (
                PrerequisiteStatus::Configured,
                format!(
                    "Configured for {}. This shows an entry exists; it does not check that the server starts or is authorized.",
                    configured.join(", ")
                ),
            )
        } else if !unreadable.is_empty() {
            (
                PrerequisiteStatus::Unknown,
                format!("Could not read {}", unreadable.join(", ")),
            )
        } else {
            (
                PrerequisiteStatus::NotConfigured,
                "Not configured in this project's client settings. User-level settings were not read.".to_string(),
            )
        };
        prerequisites.push(Prerequisite {
            kind: PrerequisiteKind::Mcp,
            name: requirement.name.clone(),
            status,
            detail,
            purpose: requirement.purpose.clone(),
            hint: requirement.server.as_ref().map(|_| {
                "Habi can add the suggested configuration when you install this item.".to_string()
            }),
        });
    }
    let state = if prerequisites.is_empty() {
        ReadinessState::NoRequirements
    } else if prerequisites.iter().any(|p| {
        matches!(
            p.status,
            PrerequisiteStatus::Missing | PrerequisiteStatus::NotConfigured
        )
    }) {
        ReadinessState::Missing
    } else if prerequisites
        .iter()
        .any(|p| p.status == PrerequisiteStatus::Unknown)
    {
        ReadinessState::Unknown
    } else {
        ReadinessState::Ready
    };
    Readiness {
        state,
        prerequisites,
    }
}

pub fn evidence(item: &LibraryItem, runs: &[CheckRun], fingerprint: &str) -> EvidenceSummary {
    let latest = runs.first().cloned();
    let state = match &latest {
        Some(run) if run.status == CheckStatus::Passed => {
            if run.item_digest == item.content_digest && run.project_fingerprint == fingerprint {
                EvidenceState::LocallyChecked
            } else {
                EvidenceState::Stale
            }
        }
        Some(run) if matches!(run.status, CheckStatus::Failed | CheckStatus::TimedOut) => {
            EvidenceState::Failed
        }
        _ if !item.evidence.is_empty() => EvidenceState::AuthorDeclared,
        _ => EvidenceState::NotEvaluated,
    };
    EvidenceSummary {
        state,
        declared: item.evidence.clone(),
        latest_run: latest,
    }
}

/// Everything needed to rank one item.
pub struct Candidate<'a> {
    pub item: &'a LibraryItem,
    pub source_name: &'a str,
    pub source_identity: &'a str,
    pub snapshot: &'a str,
    pub runs: Vec<CheckRun>,
}

pub fn recommend(
    root: &Path,
    inspection: &ProjectInspection,
    declarations: &[Declaration],
    lock: &LockFile,
    installations: &[Installation],
    candidates: &[Candidate],
) -> Vec<Recommendation> {
    let mut out: Vec<Recommendation> = candidates
        .iter()
        .map(|c| {
            let item = c.item;
            let applicability = assess(
                item.applies_when.as_ref(),
                item.excludes.as_ref(),
                item.scope,
                inspection,
                declarations,
            );
            let modules: Vec<String> = applicability
                .modules
                .iter()
                .filter(|m| m.applicability == Applicability::Applies)
                .map(|m| m.module.clone())
                .collect();
            let readiness = readiness(root, item, &modules);
            let key = lock_key(c.source_identity, &item.id);
            let installation = installations.iter().find(|i| i.key == key).cloned();
            let install_state = installation
                .as_ref()
                .map(|i| i.state)
                .unwrap_or(InstallState::NotInstalled);
            let group = match (item.requirement, applicability.applicability) {
                (Requirement::Required, _) => Group::Required,
                (_, Applicability::Applies) => Group::Relevant,
                (_, Applicability::NeedsInformation) => Group::NeedsInformation,
                (_, Applicability::Undeclared) => Group::Available,
                (_, Applicability::DoesNotApply) => Group::NotApplicable,
            };
            let next_action = match install_state {
                InstallState::NotInstalled if !installable(item) => NextAction::None,
                InstallState::Conflict => NextAction::ResolveConflict,
                InstallState::UpdateAvailable => NextAction::Update,
                InstallState::NotInstalled => match applicability.applicability {
                    Applicability::NeedsInformation => NextAction::ProvideInformation,
                    Applicability::Applies if readiness.state == ReadinessState::Missing => {
                        NextAction::SetUpPrerequisites
                    }
                    Applicability::Applies | Applicability::Undeclared => NextAction::Install,
                    Applicability::DoesNotApply if item.requirement == Requirement::Required => {
                        NextAction::None
                    }
                    Applicability::DoesNotApply => NextAction::None,
                },
                _ => NextAction::None,
            };
            let unmanaged_copies = if item.kind == ItemKind::Instructions {
                Vec::new()
            } else {
                crate::install::status::unmanaged_copies(root, &item.name, lock)
            };
            Recommendation {
                item: summarize(item, c.source_name, c.snapshot),
                group,
                evidence: evidence(item, &c.runs, &inspection.fingerprint),
                applicability,
                readiness,
                install_state,
                installation,
                next_action,
                unmanaged_copies,
            }
        })
        .collect();
    let readiness_rank = |r: ReadinessState| match r {
        ReadinessState::Ready | ReadinessState::NoRequirements => 0,
        ReadinessState::Unknown => 1,
        ReadinessState::Missing => 2,
    };
    out.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then(b.item.priority.cmp(&a.item.priority))
            .then(
                b.applicability
                    .specificity
                    .cmp(&a.applicability.specificity),
            )
            .then(readiness_rank(a.readiness.state).cmp(&readiness_rank(b.readiness.state)))
            .then(b.item.installable.cmp(&a.item.installable))
            .then(
                a.item
                    .title
                    .to_lowercase()
                    .cmp(&b.item.title.to_lowercase()),
            )
    });
    out
}
