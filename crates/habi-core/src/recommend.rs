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
use crate::matching::condition::Condition;
use crate::matching::eval::Declaration;
use crate::matching::{Applicability, ApplicabilityResult, Views, assess_in};
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
    /// Readiness for each supported agent; configuration in one agent does
    /// not establish readiness in another.
    #[serde(default)]
    pub by_client: Vec<ClientReadiness>,
    /// Installed agents, or the supported agents detected in this project.
    #[serde(default)]
    pub assessed_clients: Vec<ClientId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientReadiness {
    pub client: ClientId,
    pub state: ReadinessState,
    pub prerequisites: Vec<Prerequisite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EvidenceState {
    /// Only the author's declared records exist.
    AuthorDeclared,
    /// Every declared check/module pair passed for this version and project state.
    LocallyChecked,
    /// The latest local check failed.
    Failed,
    /// A completed local result is out of date after an item or project change.
    Stale,
    /// Some pairs passed; others are unchecked or inspection was incomplete.
    Partial,
    NotEvaluated,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EvidenceSummary {
    pub state: EvidenceState,
    pub declared: Vec<DeclaredEvidence>,
    pub latest_run: Option<CheckRun>,
    #[serde(default)]
    pub coverage: CheckCoverage,
}

/// Latest completed result for every declared check and applicable module.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckCoverage {
    pub passed: u32,
    pub failed: u32,
    pub stale: u32,
    pub unchecked: u32,
    /// Whether inspection could index all non-ignored files. A truncated
    /// scan cannot establish freshness for files it never reached.
    pub inputs_complete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Group {
    /// Designated required by the team, and its conditions hold (or could
    /// not be established, or it declares none).
    Required,
    Relevant,
    NeedsInformation,
    /// No applicability declared; available for manual use.
    Available,
    NotApplicable,
}

/// Where an item's applicability rule comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Basis {
    /// The author declared it (`habi.yaml`), or declared none.
    #[default]
    Declared,
    /// The author declared nothing; Habi's catalog suggests this rule for a
    /// skill from a well-known library. It is Habi's judgement, not the
    /// author's, and says so wherever it is shown.
    CatalogHint,
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
    /// Who set the rule `applicability` evaluated.
    pub basis: Basis,
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

/// Whether the tools a skill needs are available here, without executing
/// anything: commands are looked up on PATH, `./` commands in the project
/// root and the given modules.
pub fn tool_prerequisites(
    root: &Path,
    tools: &[crate::library::model::ToolRequirement],
    applicable_modules: &[String],
) -> Vec<Prerequisite> {
    let mut prerequisites = Vec::new();
    for tool in tools {
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
    prerequisites
}

/// Checks prerequisites without executing anything: tools are looked up on
/// PATH or in the project, MCP servers in the project's client configuration.
fn readiness_state(prerequisites: &[Prerequisite]) -> ReadinessState {
    if prerequisites.is_empty() {
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
    }
}

pub fn readiness(root: &Path, item: &LibraryItem, applicable_modules: &[String]) -> Readiness {
    readiness_for_clients(
        root,
        item,
        applicable_modules,
        &crate::clients::in_project(root),
    )
}

/// Aggregate only the agents the user uses, while retaining per-agent facts
/// for choosing another agent in the UI. With no chosen agent, mixed MCP
/// configuration is unknown rather than universally ready.
pub fn readiness_for_clients(
    root: &Path,
    item: &LibraryItem,
    applicable_modules: &[String],
    clients: &[ClientId],
) -> Readiness {
    let tools = tool_prerequisites(root, &item.tools, applicable_modules);
    let supported: Vec<_> = ClientId::ALL
        .into_iter()
        .filter(|c| {
            item.clients
                .as_ref()
                .is_none_or(|allowed| allowed.contains(c))
        })
        .collect();
    let assessed_clients: Vec<_> = clients
        .iter()
        .copied()
        .filter(|c| supported.contains(c))
        .collect();
    let by_client: Vec<_> = supported.into_iter().map(|client| {
        let mut prerequisites = tools.clone();
        for requirement in &item.mcp {
            let file = mcp::config_path(client);
            let configured = read_project_file(root, file).and_then(|bytes| {
                mcp::is_configured(client, bytes.as_deref(), &requirement.name)
            });
            let (status, detail) = match configured {
                Ok(true) => (PrerequisiteStatus::Configured,
                    format!("Configured for {} ({file}). This only establishes an entry; server startup and authorization were not checked.", client.label())),
                Ok(false) => (PrerequisiteStatus::NotConfigured,
                    format!("Not configured for {} in {file}. User-level settings were not read.", client.label())),
                Err(_) => (PrerequisiteStatus::Unknown,
                    format!("Could not read {} configuration ({file}).", client.label())),
            };
            prerequisites.push(Prerequisite {
                kind: PrerequisiteKind::Mcp,
                name: requirement.name.clone(), status, detail,
                purpose: requirement.purpose.clone(),
                hint: requirement.server.as_ref().map(|_| "Habi can add the suggested configuration when you install this item.".into()),
            });
        }
        ClientReadiness { client, state: readiness_state(&prerequisites), prerequisites }
    }).collect();
    let relevant: Vec<_> = by_client
        .iter()
        .filter(|r| assessed_clients.is_empty() || assessed_clients.contains(&r.client))
        .collect();
    let state = if assessed_clients.is_empty()
        && relevant
            .first()
            .is_some_and(|first| relevant.iter().any(|r| r.state != first.state))
    {
        ReadinessState::Unknown
    } else if relevant.iter().any(|r| r.state == ReadinessState::Missing) {
        ReadinessState::Missing
    } else if relevant.iter().any(|r| r.state == ReadinessState::Unknown) {
        ReadinessState::Unknown
    } else {
        relevant
            .first()
            .map_or(readiness_state(&tools), |r| r.state)
    };
    // Prefer an agent that explains the aggregate status. The complete
    // agent-specific lists remain available in by_client.
    let representative = relevant
        .iter()
        .find(|r| r.state == state)
        .or_else(|| relevant.iter().find(|r| r.state == ReadinessState::Missing))
        .or_else(|| relevant.first());
    let prerequisites = representative.map_or(tools, |r| r.prerequisites.clone());
    Readiness {
        state,
        prerequisites,
        by_client,
        assessed_clients,
    }
}

pub fn evidence(
    item: &LibraryItem,
    runs: &[CheckRun],
    fingerprint: &str,
    modules: &[String],
    inputs_complete: bool,
) -> EvidenceSummary {
    let latest = runs.first().cloned();
    let mut coverage = CheckCoverage {
        inputs_complete,
        ..Default::default()
    };
    for check in &item.checks {
        for module in modules {
            // Cancellation does not erase the last completed result. Errors
            // to start a command still count as a failed verification attempt.
            let run = runs.iter().find(|r| {
                r.check_id == check.id && r.module == *module && r.status != CheckStatus::Cancelled
            });
            match run {
                Some(r)
                    if r.item_digest != item.content_digest
                        || r.project_fingerprint != fingerprint =>
                {
                    coverage.stale += 1
                }
                Some(r) if r.status == CheckStatus::Passed => coverage.passed += 1,
                Some(_) => coverage.failed += 1,
                None => coverage.unchecked += 1,
            }
        }
    }
    let state = if coverage.failed > 0 {
        EvidenceState::Failed
    } else if coverage.stale > 0 {
        EvidenceState::Stale
    } else if coverage.passed > 0 && (coverage.unchecked > 0 || !inputs_complete) {
        EvidenceState::Partial
    } else if coverage.passed > 0 {
        EvidenceState::LocallyChecked
    } else if !item.evidence.is_empty() {
        EvidenceState::AuthorDeclared
    } else {
        EvidenceState::NotEvaluated
    };
    EvidenceSummary {
        state,
        declared: item.evidence.clone(),
        latest_run: latest,
        coverage,
    }
}

/// Everything needed to rank one item.
pub struct Candidate<'a> {
    pub item: &'a LibraryItem,
    pub source_name: &'a str,
    pub source_identity: &'a str,
    pub snapshot: &'a str,
    pub runs: Vec<CheckRun>,
    /// A rule suggested by Habi's catalog for an item whose author declared
    /// none. Used only when the item has no `applies_when` of its own.
    pub hint: Option<&'a Condition>,
}

pub fn recommend(
    root: &Path,
    inspection: &ProjectInspection,
    declarations: &[Declaration],
    lock: &LockFile,
    installations: &[Installation],
    candidates: &[Candidate],
) -> Vec<Recommendation> {
    let views = Views::new(inspection, declarations);
    let mut out: Vec<Recommendation> = candidates
        .iter()
        .map(|c| {
            let item = c.item;
            let (applies_when, basis) = match (item.applies_when.as_ref(), c.hint) {
                (Some(own), _) => (Some(own), Basis::Declared),
                (None, Some(hint)) if item.metadata_status == MetadataStatus::Undeclared => {
                    (Some(hint), Basis::CatalogHint)
                }
                (None, _) => (None, Basis::Declared),
            };
            let applicability = assess_in(applies_when, item.excludes.as_ref(), item.scope, &views);
            let modules: Vec<String> = applicability
                .modules
                .iter()
                .filter(|m| m.applicability == Applicability::Applies && m.module != "*")
                .map(|m| m.module.clone())
                .collect();
            let key = lock_key(c.source_identity, &item.id);
            let installation = installations.iter().find(|i| i.key == key).cloned();
            let clients = installation
                .as_ref()
                .map(|i| i.clients.clone())
                .unwrap_or_else(|| crate::clients::in_project(root));
            let readiness = readiness_for_clients(root, item, &modules, &clients);
            let check_modules: Vec<String> = if modules.is_empty() {
                inspection.modules.iter().map(|m| m.id.clone()).collect()
            } else {
                modules.clone()
            };
            let install_state = installation
                .as_ref()
                .map(|i| i.state)
                .unwrap_or(InstallState::NotInstalled);
            // A team requirement whose conditions do not hold for this project
            // is listed with the other items that do not apply: a Java-only
            // rule is not a requirement for a React project.
            let group = match (item.requirement, applicability.applicability) {
                (_, Applicability::DoesNotApply) => Group::NotApplicable,
                (Requirement::Required, _) => Group::Required,
                (_, Applicability::Applies) => Group::Relevant,
                (_, Applicability::NeedsInformation) => Group::NeedsInformation,
                (_, Applicability::Undeclared) => Group::Available,
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
                evidence: evidence(
                    item,
                    &c.runs,
                    &inspection.fingerprint,
                    &check_modules,
                    !inspection.scan.truncated
                        && inspection.scan.unreadable.is_empty()
                        && inspection
                            .coverage
                            .iter()
                            .filter(|c| c.area == "files")
                            .all(|c| c.status == crate::inspect::model::CoverageStatus::Complete),
                ),
                applicability,
                basis,
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
