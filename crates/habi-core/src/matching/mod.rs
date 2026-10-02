//! Deterministic, explainable matching of library items to a project.
//!
//! Eligibility (does it apply?) is decided here from conditions and facts.
//! Ranking is separate (see `recommend`), so ordering never changes whether
//! something applies.

pub mod condition;
pub mod eval;
pub mod version;

use crate::inspect::model::ProjectInspection;
use condition::Condition;
use eval::{Declaration, EvalNode, Tri, View, evaluate, specificity};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Scope {
    /// Conditions are evaluated for each module separately.
    #[default]
    Module,
    /// Conditions are evaluated against the whole repository at once.
    Repository,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Applicability {
    Applies,
    DoesNotApply,
    /// Something required (or an exclusion) could not be established.
    NeedsInformation,
    /// The item declares no applicability; it is available but not matched.
    Undeclared,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModuleMatch {
    /// Module id, or `*` for repository scope.
    pub module: String,
    pub module_name: String,
    pub applicability: Applicability,
    pub applies: Option<EvalNode>,
    pub excludes: Option<EvalNode>,
    pub specificity: u32,
    /// One-line, plain-language reason.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplicabilityResult {
    pub applicability: Applicability,
    pub scope: Scope,
    /// Per-module results, most relevant first.
    pub modules: Vec<ModuleMatch>,
    pub reason: String,
    pub specificity: u32,
}

/// First leaf (depth-first) whose outcome is `want`, for one-line reasons.
fn decisive_leaf(node: &EvalNode, want: Tri) -> Option<&EvalNode> {
    if node.outcome != want {
        return None;
    }
    if node.children.is_empty() {
        return Some(node);
    }
    // Under `not`, the child's outcome is inverted.
    if matches!(node.condition, Condition::Not { .. }) {
        return node
            .children
            .first()
            .and_then(|c| decisive_leaf(c, want.negate()));
    }
    node.children.iter().find_map(|c| decisive_leaf(c, want))
}

fn leaf_reason(node: &EvalNode, want: Tri) -> String {
    match decisive_leaf(node, want) {
        Some(leaf) => format!("{}: {}", leaf.summary, leaf.reason),
        None => node.reason.clone(),
    }
}

fn decide(applies: Option<&EvalNode>, excludes: Option<&EvalNode>) -> (Applicability, String) {
    if let Some(ex) = excludes
        && ex.outcome == Tri::True
    {
        return (
            Applicability::DoesNotApply,
            format!("Excluded — {}", leaf_reason(ex, Tri::True)),
        );
    }
    if let Some(a) = applies
        && a.outcome == Tri::False
    {
        return (
            Applicability::DoesNotApply,
            format!("Conditions not met — {}", leaf_reason(a, Tri::False)),
        );
    }
    if let Some(ex) = excludes
        && ex.outcome == Tri::Unknown
    {
        return (
            Applicability::NeedsInformation,
            format!(
                "Exclusion not ruled out — {}",
                leaf_reason(ex, Tri::Unknown)
            ),
        );
    }
    if let Some(a) = applies
        && a.outcome == Tri::Unknown
    {
        return (
            Applicability::NeedsInformation,
            format!("Not established — {}", leaf_reason(a, Tri::Unknown)),
        );
    }
    let reason = match applies {
        Some(a) => {
            let mut leaves = true_leaves(a);
            leaves.dedup();
            if leaves.is_empty() {
                "Conditions hold".to_string()
            } else {
                capitalize(&leaves.join(" · "))
            }
        }
        None => "No exclusion applies".to_string(),
    };
    (Applicability::Applies, reason)
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn true_leaves(node: &EvalNode) -> Vec<String> {
    match &node.condition {
        Condition::All { .. } | Condition::Any { .. } => node
            .children
            .iter()
            .filter(|c| c.outcome == Tri::True)
            .flat_map(true_leaves)
            .collect(),
        Condition::Not { .. } => Vec::new(),
        _ if node.outcome == Tri::True => vec![match &node.location {
            // File name and line only; the full path is in the evidence.
            Some(loc) => format!(
                "{} ({})",
                node.summary,
                loc.rsplit('/').next().unwrap_or(loc)
            ),
            None => node.summary.clone(),
        }],
        _ => Vec::new(),
    }
}

/// Number of predicates in a tree that rest on concrete evidence.
fn evidence_leaves(node: &EvalNode) -> u32 {
    let own = u32::from(
        node.children.is_empty()
            && (!node.facts.is_empty() || !node.files.is_empty() || !node.declarations.is_empty()),
    );
    own + node.children.iter().map(evidence_leaves).sum::<u32>()
}

fn rank(a: Applicability) -> u8 {
    match a {
        Applicability::Applies => 0,
        Applicability::NeedsInformation => 1,
        Applicability::Undeclared => 2,
        Applicability::DoesNotApply => 3,
    }
}

/// What conditions are evaluated against in one project: the repository as
/// a whole and each module. Built once and shared by every item assessed
/// against the project (see `assess_in`).
pub struct Views<'a> {
    inspection: &'a ProjectInspection,
    repository: View<'a>,
    modules: Vec<View<'a>>,
}

impl<'a> Views<'a> {
    pub fn new(inspection: &'a ProjectInspection, declarations: &'a [Declaration]) -> Self {
        Views {
            inspection,
            repository: View::repository(inspection, declarations),
            modules: inspection
                .modules
                .iter()
                .map(|m| View::module(inspection, &m.id, declarations))
                .collect(),
        }
    }
}

/// Evaluates an item's conditions against a project.
pub fn assess(
    applies_when: Option<&Condition>,
    excludes: Option<&Condition>,
    scope: Scope,
    inspection: &ProjectInspection,
    declarations: &[Declaration],
) -> ApplicabilityResult {
    assess_in(
        applies_when,
        excludes,
        scope,
        &Views::new(inspection, declarations),
    )
}

/// `assess` with views built beforehand, for assessing many items.
pub fn assess_in(
    applies_when: Option<&Condition>,
    excludes: Option<&Condition>,
    scope: Scope,
    views: &Views,
) -> ApplicabilityResult {
    let inspection = views.inspection;
    if applies_when.is_none() && excludes.is_none() {
        return ApplicabilityResult {
            applicability: Applicability::Undeclared,
            scope,
            modules: Vec::new(),
            reason: "No applicability is declared, so Habi does not match it to projects. It remains available to use manually.".into(),
            specificity: 0,
        };
    }

    let evaluate_view = |view: &View, module: &str, name: String| {
        let a = applies_when.map(|c| evaluate(c, view));
        let e = excludes.map(|c| evaluate(c, view));
        let (applicability, reason) = decide(a.as_ref(), e.as_ref());
        let spec = a.as_ref().map(specificity).unwrap_or(0);
        ModuleMatch {
            module: module.to_string(),
            module_name: name,
            applicability,
            applies: a,
            excludes: e,
            specificity: spec,
            reason,
        }
    };

    let mut modules: Vec<ModuleMatch> = match scope {
        Scope::Repository => vec![evaluate_view(
            &views.repository,
            "*",
            inspection.name.clone(),
        )],
        Scope::Module => inspection
            .modules
            .iter()
            .zip(&views.modules)
            .map(|(m, view)| evaluate_view(view, &m.id, m.name.clone()))
            .collect(),
    };
    modules.sort_by(|a, b| {
        rank(a.applicability)
            .cmp(&rank(b.applicability))
            .then(b.specificity.cmp(&a.specificity))
            .then(a.module.cmp(&b.module))
    });

    let best = modules
        .first()
        .map(|m| m.applicability)
        .unwrap_or(Applicability::DoesNotApply);
    let applying: Vec<&ModuleMatch> = modules
        .iter()
        .filter(|m| m.applicability == Applicability::Applies)
        .collect();
    // `best` is `Applies` only when some module applies.
    let first_reason = applying
        .first()
        .map(|m| m.reason.clone())
        .unwrap_or_default();
    let reason = match best {
        Applicability::Applies if scope == Scope::Repository => first_reason,
        Applicability::Applies if inspection.modules.len() == 1 => first_reason,
        Applicability::Applies => {
            let names: Vec<&str> = applying.iter().map(|m| m.module_name.as_str()).collect();
            format!(
                "Applies to {} of {} modules ({}) — {}",
                applying.len(),
                inspection.modules.len(),
                names.join(", "),
                first_reason
            )
        }
        Applicability::DoesNotApply if modules.len() > 1 => {
            // Cite the most informative module: an exclusion, then the module
            // whose evaluation rests on the most evidence (facts, files or
            // declarations anywhere in the tree, including under `not`), then
            // the closest miss. A module with no evidence at all (an empty
            // aggregator root, say) is cited only when nothing else is.
            let near_miss = |m: &&ModuleMatch| {
                let tree = m.applies.as_ref();
                (
                    tree.map(evidence_leaves).unwrap_or(0),
                    tree.map(specificity).unwrap_or(0),
                )
            };
            let pick = modules
                .iter()
                .find(|m| m.reason.starts_with("Excluded"))
                .or_else(|| {
                    modules
                        .iter()
                        .filter(|m| near_miss(m) > (0, 0))
                        // Earliest (by module id) wins ties.
                        .rev()
                        .max_by_key(near_miss)
                })
                .or(modules.first());
            match pick {
                Some(m) => format!(
                    "Does not apply to any of the {} modules — in {}: {}",
                    modules.len(),
                    m.module_name,
                    m.reason
                ),
                None => String::new(),
            }
        }
        _ => modules
            .first()
            .map(|m| m.reason.clone())
            .unwrap_or_default(),
    };
    let specificity = modules.first().map(|m| m.specificity).unwrap_or(0);
    ApplicabilityResult {
        applicability: best,
        scope,
        modules,
        reason,
        specificity,
    }
}
