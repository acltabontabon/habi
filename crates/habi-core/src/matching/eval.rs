//! Three-valued evaluation of conditions against inspection facts.
//!
//! `True` and `False` require evidence; anything Habi could not establish is
//! `Unknown`. In particular, absence is only `False` when the relevant
//! coverage is complete: an incomplete scan never satisfies "not present".

use super::condition::Condition;
use super::version;
use crate::inspect::model::{
    Coverage, CoverageStatus, Ecosystem, Fact, FactOrigin, FactSubject, ProjectInspection,
    VersionState,
};
use crate::inspect::tags::{self, TagBasis, wildcard_match};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Tri {
    True,
    False,
    Unknown,
}

impl Tri {
    pub fn negate(self) -> Tri {
        match self {
            Tri::True => Tri::False,
            Tri::False => Tri::True,
            Tri::Unknown => Tri::Unknown,
        }
    }
}

/// A user's explicit correction of detected facts. Stored per project,
/// reversible, and shown with `Declared` provenance.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Declaration {
    pub id: String,
    /// Module id, or `*` for the whole repository.
    pub module: String,
    pub subject: DeclaredSubject,
    pub present: bool,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum DeclaredSubject {
    Tag { tag: String },
    Dependency { name: String },
}

/// One node of an explanation tree.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EvalNode {
    pub condition: Condition,
    pub summary: String,
    pub outcome: Tri,
    /// Why this outcome, in plain language.
    pub reason: String,
    /// Facts that support the outcome (ids into the inspection).
    pub facts: Vec<String>,
    /// Declarations that decided the outcome.
    pub declarations: Vec<String>,
    /// Files that matched a file pattern (repository-relative).
    pub files: Vec<String>,
    /// Compact location of the decisive evidence, e.g. `pom.xml:31`.
    pub location: Option<String>,
    pub children: Vec<EvalNode>,
}

/// The part of an inspection a condition is evaluated against: one module,
/// or the whole repository.
pub struct View<'a> {
    pub module: Option<&'a str>,
    pub facts: Vec<&'a Fact>,
    pub files: Vec<&'a str>,
    pub coverage: Vec<&'a Coverage>,
    pub ecosystems: BTreeSet<Ecosystem>,
    pub declarations: Vec<&'a Declaration>,
}

/// Whether a fact describes the repository as a whole rather than the module
/// whose directory holds it: CI configuration, agent instructions and skills,
/// MCP configuration, container builds and build wrappers. Nested modules
/// inherit these from their enclosing modules (in particular the root), so a
/// module-scoped condition on `ci:github-actions` sees the repository's CI.
///
/// Build-manifest facts are never inherited this way: Maven and Gradle
/// inheritance is modelled by their detectors (parent POMs, `subprojects`).
pub fn repository_level(fact: &Fact) -> bool {
    const ROLE_PREFIXES: &[&str] = &[
        "ci:",
        "agent-instructions:",
        "agent-skill:",
        "mcp-config:",
        "container:",
        "build-wrapper:",
    ];
    match &fact.subject {
        FactSubject::File { role, .. } => ROLE_PREFIXES.iter().any(|p| role.starts_with(p)),
        FactSubject::Tag { tag } => {
            tag.starts_with("ci:") || tag.starts_with("agents:") || tag == "container:docker"
        }
        FactSubject::Dependency { .. } => false,
    }
}

impl<'a> View<'a> {
    /// One module: its own facts and files, plus repository-level facts of
    /// its enclosing modules (see `repository_level`).
    pub fn module(
        inspection: &'a ProjectInspection,
        id: &'a str,
        declarations: &'a [Declaration],
    ) -> Self {
        let mut facts: Vec<&Fact> = inspection.module_facts(id).collect();
        for ancestor in inspection.ancestors(id) {
            facts.extend(
                inspection
                    .module_facts(ancestor)
                    .filter(|f| repository_level(f)),
            );
        }
        View {
            module: Some(id),
            facts,
            files: inspection.module_files(id).collect(),
            coverage: inspection.module_coverage(id).collect(),
            ecosystems: inspection
                .module(id)
                .map(|m| m.ecosystems.iter().copied().collect())
                .unwrap_or_default(),
            declarations: declarations
                .iter()
                .filter(|d| d.module == id || d.module == "*")
                .collect(),
        }
    }

    /// Whether declaration `d` speaks about fact `f` in this view. In a module
    /// view every visible declaration does; in the repository view a
    /// module-specific declaration only speaks about that module's facts.
    fn covers(&self, d: &Declaration, f: &Fact) -> bool {
        self.module.is_some() || d.module == "*" || d.module == f.module
    }

    /// The declaration that decides a subject nothing was detected for. A
    /// module-specific declaration wins over a repository-wide one. In the
    /// repository view only repository-wide declarations decide absence; a
    /// module-specific "present" still establishes presence somewhere.
    fn deciding<'d>(&self, candidates: &[&'d Declaration]) -> Option<&'d Declaration> {
        match self.module {
            Some(m) => candidates
                .iter()
                .find(|d| d.module == m)
                .or_else(|| candidates.iter().find(|d| d.module == "*"))
                .copied(),
            None => candidates
                .iter()
                .find(|d| d.module == "*")
                .or_else(|| candidates.iter().find(|d| d.present))
                .copied(),
        }
    }

    /// "from X" phrase for a fact found in an enclosing module.
    fn inherited_from(&self, f: &Fact) -> Option<String> {
        match self.module {
            Some(m) if f.module != m => Some(if f.module == "." {
                "the repository root".to_string()
            } else {
                format!("enclosing module {}", f.module)
            }),
            _ => None,
        }
    }

    pub fn repository(inspection: &'a ProjectInspection, declarations: &'a [Declaration]) -> Self {
        View {
            module: None,
            facts: inspection.facts.iter().collect(),
            files: inspection.files.iter().map(String::as_str).collect(),
            coverage: inspection.coverage.iter().collect(),
            ecosystems: inspection
                .modules
                .iter()
                .flat_map(|m| m.ecosystems.iter().copied())
                .collect(),
            declarations: declarations.iter().collect(),
        }
    }

    fn incomplete(&self, areas: &[&str]) -> Vec<String> {
        let mut notes = Vec::new();
        for c in &self.coverage {
            if areas.contains(&c.area.as_str()) && c.status != CoverageStatus::Complete {
                if c.notes.is_empty() {
                    notes.push(format!(
                        "{} evidence for {} is incomplete",
                        c.area, c.module
                    ));
                } else {
                    notes.extend(c.notes.iter().cloned());
                }
            }
        }
        notes.sort();
        notes.dedup();
        notes
    }

    fn relative<'p>(&self, path: &'p str) -> &'p str {
        match self.module {
            Some(".") | None => path,
            Some(m) => path
                .strip_prefix(m)
                .and_then(|r| r.strip_prefix('/'))
                .unwrap_or(path),
        }
    }

    fn where_(&self) -> String {
        match self.module {
            Some(".") => "the root module".into(),
            Some(m) => format!("module {m}"),
            None => "this repository".into(),
        }
    }
}

fn eco_area(e: Ecosystem) -> &'static str {
    match e {
        Ecosystem::Maven => "maven",
        Ecosystem::Gradle => "gradle",
        Ecosystem::Npm => "npm",
    }
}

fn node(condition: &Condition, outcome: Tri, reason: String) -> EvalNode {
    EvalNode {
        summary: condition.describe(),
        condition: condition.clone(),
        outcome,
        reason,
        facts: Vec::new(),
        declarations: Vec::new(),
        files: Vec::new(),
        location: None,
        children: Vec::new(),
    }
}

/// " in module api" when a repository-scope result rests on a declaration
/// the user made for one module; empty otherwise.
fn declared_place(view: &View, d: &Declaration) -> String {
    match view.module {
        None if d.module != "*" => {
            if d.module == "." {
                " for the root module".into()
            } else {
                format!(" for module {}", d.module)
            }
        }
        _ => String::new(),
    }
}

fn evidence_location(f: &Fact) -> String {
    match f.evidence.first() {
        Some(e) => match e.line {
            Some(l) => format!("{}:{}", e.file, l),
            None => e.file.clone(),
        },
        None => "inspection".into(),
    }
}

pub fn evaluate(condition: &Condition, view: &View) -> EvalNode {
    match condition {
        Condition::All { items } => {
            let children: Vec<EvalNode> = items.iter().map(|c| evaluate(c, view)).collect();
            let outcome = if children.iter().any(|c| c.outcome == Tri::False) {
                Tri::False
            } else if children.iter().any(|c| c.outcome == Tri::Unknown) {
                Tri::Unknown
            } else {
                Tri::True
            };
            let reason = match outcome {
                Tri::True => "every condition holds".into(),
                Tri::False => "at least one condition does not hold".into(),
                Tri::Unknown => "no condition fails, but some could not be established".into(),
            };
            EvalNode {
                children,
                ..node(condition, outcome, reason)
            }
        }
        Condition::Any { items } => {
            let children: Vec<EvalNode> = items.iter().map(|c| evaluate(c, view)).collect();
            let outcome = if children.iter().any(|c| c.outcome == Tri::True) {
                Tri::True
            } else if children.iter().any(|c| c.outcome == Tri::Unknown) {
                Tri::Unknown
            } else {
                Tri::False
            };
            let reason = match outcome {
                Tri::True => "at least one alternative holds".into(),
                Tri::False => "none of the alternatives hold".into(),
                Tri::Unknown => {
                    "no alternative is confirmed, and some could not be established".into()
                }
            };
            EvalNode {
                children,
                ..node(condition, outcome, reason)
            }
        }
        Condition::Not { item } => {
            let child = evaluate(item, view);
            let outcome = child.outcome.negate();
            let reason = match outcome {
                Tri::True => "the negated condition is confirmed false".into(),
                Tri::False => "the negated condition holds".into(),
                Tri::Unknown => "the negated condition could not be established, so its absence is not confirmed".into(),
            };
            EvalNode {
                children: vec![child],
                ..node(condition, outcome, reason)
            }
        }
        Condition::Dependency {
            name,
            ecosystem,
            version,
        } => eval_dependency(condition, name, *ecosystem, version.as_deref(), view),
        Condition::File { glob } => eval_file(condition, glob, view),
        Condition::Tag { tag } => eval_tag(condition, tag, view),
    }
}

#[allow(
    clippy::indexing_slicing,
    reason = "lists are indexed only when they are known to be non-empty"
)]
fn eval_dependency(
    condition: &Condition,
    pattern: &str,
    filter: Option<super::condition::EcosystemFilter>,
    requirement: Option<&str>,
    view: &View,
) -> EvalNode {
    let candidates: Vec<&Fact> = view
        .facts
        .iter()
        .copied()
        .filter(|f| match &f.subject {
            FactSubject::Dependency {
                name, ecosystem, ..
            } => wildcard_match(pattern, name) && filter.is_none_or(|flt| flt.accepts(*ecosystem)),
            _ => false,
        })
        .collect();
    let declarations: Vec<&Declaration> = view
        .declarations
        .iter()
        .copied()
        .filter(|d| match &d.subject {
            DeclaredSubject::Dependency { name } => {
                wildcard_match(pattern, name) || name == pattern
            }
            _ => false,
        })
        .collect();
    let denial = |f: &Fact| {
        declarations
            .iter()
            .copied()
            .find(|d| !d.present && view.covers(d, f))
    };

    if !candidates.is_empty() {
        let all_ids: Vec<String> = candidates.iter().map(|f| f.id.clone()).collect();
        // Facts the user declared absent (for their module) do not count.
        let uncontested: Vec<&Fact> = candidates
            .iter()
            .copied()
            .filter(|f| denial(f).is_none())
            .collect();
        if uncontested.is_empty() {
            let d = denial(candidates[0]).expect("contested fact has a denial");
            let mut n = node(
                condition,
                Tri::Unknown,
                format!(
                    "conflict: found in {} but you declared it absent",
                    evidence_location(candidates[0])
                ),
            );
            n.facts = all_ids;
            n.declarations = vec![d.id.clone()];
            return n;
        }
        let candidates = uncontested;
        let ids: Vec<String> = candidates.iter().map(|f| f.id.clone()).collect();
        let Some(req_text) = requirement else {
            let f = candidates[0];
            let how = if f.origin == FactOrigin::Inherited {
                "inherited via"
            } else {
                "declared in"
            };
            let mut n = node(
                condition,
                Tri::True,
                format!("{how} {}", evidence_location(f)),
            );
            n.facts = ids;
            n.location = Some(evidence_location(f));
            return n;
        };
        let req = match version::parse_requirement(req_text) {
            Ok(r) => r,
            Err(e) => return node(condition, Tri::Unknown, e),
        };
        let mut best = Tri::False;
        let mut reasons = Vec::new();
        for f in &candidates {
            let FactSubject::Dependency {
                name, version: v, ..
            } = &f.subject
            else {
                continue;
            };
            let parsed = match v.state {
                VersionState::Resolved => v.resolved.as_deref().and_then(version::lenient),
                _ => None,
            };
            match parsed {
                Some(p) if req.matches(&p) => {
                    best = Tri::True;
                    reasons.push(format!(
                        "{name} {p} satisfies {req_text} ({})",
                        evidence_location(f)
                    ));
                }
                Some(p) => reasons.push(format!("{name} {p} does not satisfy {req_text}")),
                None => {
                    if best == Tri::False {
                        best = Tri::Unknown;
                    }
                    let detail = v
                        .note
                        .clone()
                        .unwrap_or_else(|| "version not established".into());
                    reasons.push(format!(
                        "{name} is present but its version is not established: {detail}"
                    ));
                }
            }
        }
        let mut n = node(condition, best, reasons.join("; "));
        n.location = Some(evidence_location(candidates[0]));
        n.facts = ids;
        return n;
    }

    if let Some(d) = view.deciding(&declarations) {
        let place = declared_place(view, d);
        let mut n = if d.present {
            if requirement.is_some() {
                node(
                    condition,
                    Tri::Unknown,
                    format!("you declared it present{place}, but its version is not established"),
                )
            } else {
                node(
                    condition,
                    Tri::True,
                    format!("you declared it present{place}"),
                )
            }
        } else {
            node(condition, Tri::False, "you declared it absent".into())
        };
        n.declarations = vec![d.id.clone()];
        return n;
    }

    let relevant: Vec<Ecosystem> = view
        .ecosystems
        .iter()
        .copied()
        .filter(|e| filter.is_none_or(|flt| flt.accepts(*e)))
        .collect();
    if relevant.is_empty() {
        let what = match filter {
            Some(f) => f
                .ecosystems()
                .iter()
                .map(|e| e.label())
                .collect::<Vec<_>>()
                .join(" or "),
            None => "supported".into(),
        };
        return node(
            condition,
            Tri::False,
            format!(
                "{} has no {what} build manifest that could declare it",
                view.where_()
            ),
        );
    }
    let areas: Vec<&str> = relevant.iter().map(|e| eco_area(*e)).collect();
    let gaps = view.incomplete(&areas);
    if gaps.is_empty() {
        let manifests = relevant
            .iter()
            .map(|e| e.label())
            .collect::<Vec<_>>()
            .join(", ");
        node(
            condition,
            Tri::False,
            format!(
                "not declared in the {manifests} manifests of {}",
                view.where_()
            ),
        )
    } else {
        node(
            condition,
            Tri::Unknown,
            format!(
                "not found, but absence is not established: {}",
                gaps.join(" ")
            ),
        )
    }
}

/// Compiled file patterns, reused across modules and items: compiling a glob
/// costs far more than matching a module's files against it.
fn compiled_glob(glob: &str) -> Result<globset::GlobMatcher, String> {
    static CACHE: LazyLock<Mutex<HashMap<String, globset::GlobMatcher>>> =
        LazyLock::new(Default::default);
    if let Some(m) = CACHE.lock().ok().and_then(|c| c.get(glob).cloned()) {
        return Ok(m);
    }
    let matcher = globset::GlobBuilder::new(glob)
        .literal_separator(true)
        .build()
        .map_err(|e| e.to_string())?
        .compile_matcher();
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= 512 {
            cache.clear();
        }
        cache.insert(glob.to_string(), matcher.clone());
    }
    Ok(matcher)
}

#[allow(
    clippy::indexing_slicing,
    reason = "lists are indexed only when they are known to be non-empty"
)]
fn eval_file(condition: &Condition, glob: &str, view: &View) -> EvalNode {
    let matcher = match compiled_glob(glob) {
        Ok(m) => m,
        Err(e) => return node(condition, Tri::Unknown, format!("invalid pattern: {e}")),
    };
    let matched: Vec<String> = view
        .files
        .iter()
        .filter(|p| matcher.is_match(view.relative(p)))
        .take(20)
        .map(|p| p.to_string())
        .collect();
    if !matched.is_empty() {
        let mut n = node(
            condition,
            Tri::True,
            format!(
                "{} matching file{} (first: {})",
                matched.len(),
                if matched.len() == 1 { "" } else { "s" },
                matched[0]
            ),
        );
        n.location = matched.first().cloned();
        n.files = matched;
        return n;
    }
    let gaps = view.incomplete(&["files"]);
    if gaps.is_empty() {
        node(
            condition,
            Tri::False,
            format!("no file in {} matches", view.where_()),
        )
    } else {
        node(
            condition,
            Tri::Unknown,
            format!(
                "no file matched, but the scan was incomplete: {}",
                gaps.join(" ")
            ),
        )
    }
}

#[allow(
    clippy::indexing_slicing,
    reason = "lists are indexed only when they are known to be non-empty"
)]
fn eval_tag(condition: &Condition, tag: &str, view: &View) -> EvalNode {
    let mut found: Vec<&Fact> = view
        .facts
        .iter()
        .copied()
        .filter(|f| f.tag() == Some(tag))
        .collect();
    // The module's own evidence first; inherited evidence explains only when
    // there is nothing closer.
    found.sort_by_key(|f| view.inherited_from(f).is_some());
    let declarations: Vec<&Declaration> = view
        .declarations
        .iter()
        .copied()
        .filter(|d| matches!(&d.subject, DeclaredSubject::Tag { tag: t } if t == tag))
        .collect();
    let denial = |f: &Fact| {
        declarations
            .iter()
            .copied()
            .find(|d| !d.present && view.covers(d, f))
    };
    let fact_ids = |facts: &[&Fact]| {
        let mut ids: Vec<String> = facts.iter().map(|f| f.id.clone()).collect();
        for f in facts {
            ids.extend(f.derived_from.iter().take(3).cloned());
        }
        ids
    };
    if !found.is_empty() {
        let uncontested: Vec<&Fact> = found
            .iter()
            .copied()
            .filter(|f| denial(f).is_none())
            .collect();
        if uncontested.is_empty() {
            let d = denial(found[0]).expect("contested fact has a denial");
            let mut n = node(
                condition,
                Tri::Unknown,
                format!(
                    "conflict: detected from {} but you declared it absent",
                    evidence_location(found[0])
                ),
            );
            n.facts = fact_ids(&found);
            n.declarations = vec![d.id.clone()];
            return n;
        }
        let first = uncontested[0];
        let reason = match view.inherited_from(first) {
            Some(place) => format!(
                "detected at {place} from {}, which covers this module",
                evidence_location(first)
            ),
            None => format!("detected from {}", evidence_location(first)),
        };
        let mut n = node(condition, Tri::True, reason);
        n.location = Some(evidence_location(first));
        n.facts = fact_ids(&uncontested);
        return n;
    }
    if let Some(d) = view.deciding(&declarations) {
        let mut n = if d.present {
            node(
                condition,
                Tri::True,
                format!("you declared this{}", declared_place(view, d)),
            )
        } else {
            node(condition, Tri::False, "you declared this absent".into())
        };
        n.declarations = vec![d.id.clone()];
        return n;
    }
    let Some(basis) = tags::basis(tag) else {
        return node(
            condition,
            Tri::Unknown,
            format!("Habi cannot detect `{tag}`; declare whether it applies to this project"),
        );
    };
    let mut areas: Vec<&str> = match basis {
        TagBasis::Manifest => vec!["maven", "gradle", "npm"],
        TagBasis::Files => vec!["files"],
        TagBasis::Both => vec!["maven", "gradle", "npm", "files"],
    };
    // OpenAPI documents and Liquibase changelogs are recognized by content,
    // so their absence also depends on every candidate file having been read.
    if tags::needs_content(tag) {
        areas.push("content");
    }
    let gaps = view.incomplete(&areas);
    if gaps.is_empty() {
        node(
            condition,
            Tri::False,
            format!("not detected in {}", view.where_()),
        )
    } else {
        node(
            condition,
            Tri::Unknown,
            format!(
                "not detected, but the evidence is incomplete: {}",
                gaps.join(" ")
            ),
        )
    }
}

/// Number of positive predicates that hold: a measure of how specific a
/// match is. Predicates under `not` do not count.
pub fn specificity(node: &EvalNode) -> u32 {
    match &node.condition {
        Condition::All { .. } | Condition::Any { .. } => {
            node.children.iter().map(specificity).sum()
        }
        Condition::Not { .. } => 0,
        _ => u32::from(node.outcome == Tri::True),
    }
}
