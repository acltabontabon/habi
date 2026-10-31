//! Human-readable terminal output. Every enum is shown in plain words (the
//! same words the desktop app uses); JSON output keeps the stable values.

use habi_core::contribute::{Contribution, ContributionState, DraftFileStatus};
use habi_core::fsutil::short;
use habi_core::inspect::model::{
    CoverageStatus, FactSubject, ProjectInspection, RepositoryKind, VersionState,
};
use habi_core::install::apply::{JournalState, OperationSummary};
use habi_core::install::diff::LineTag;
use habi_core::install::plan::{ChangeOp, Plan, PlanAction};
use habi_core::install::status::{FileState, InstallState};
use habi_core::library::model::{
    DiagnosticLevel, ItemKind, LibraryIndex, LibraryItem, Requirement,
};
use habi_core::library::signals::SignalSeverity;
use habi_core::maintenance::PruneReport;
use habi_core::matching::Applicability;
use habi_core::matching::eval::{Declaration, DeclaredSubject, EvalNode, Tri};
use habi_core::recommend::{
    Basis, EvidenceState, Group, NextAction, PrerequisiteKind, PrerequisiteStatus, ReadinessState,
    Recommendation,
};
use habi_core::review::ReviewState;
use habi_core::service::ProjectOverview;
use habi_core::source::{Freshness, RefreshOutcome, Source, SourceRole};
use std::collections::BTreeMap;

// ----- plain-language labels -------------------------------------------------

pub fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// Whose rule a fit rests on, when it is not the author's. A skill left
/// unmatched says so in its reason already.
fn whose_rule(r: &Recommendation) -> Option<&'static str> {
    if r.applicability.applicability == Applicability::Undeclared {
        return None;
    }
    match r.basis {
        Basis::Declared => None,
        Basis::CatalogHint => Some("by Habi's catalog rule, not the author's"),
        Basis::Described => Some("from its description: Habi's reading, not the author's rule"),
    }
}

pub fn applicability(a: Applicability) -> &'static str {
    match a {
        Applicability::Applies => "applies",
        Applicability::DoesNotApply => "does not apply",
        Applicability::NeedsInformation => "needs information",
        Applicability::Undeclared => "not specified",
    }
}

pub fn readiness(r: ReadinessState) -> &'static str {
    match r {
        ReadinessState::Ready => "ready",
        ReadinessState::Missing => "prerequisite missing",
        ReadinessState::Unknown => "prerequisites not established",
        ReadinessState::NoRequirements => "no prerequisites",
    }
}

pub fn install_state(s: InstallState) -> &'static str {
    match s {
        InstallState::NotInstalled => "not installed",
        InstallState::Current => "installed",
        InstallState::UpdateAvailable => "update available",
        InstallState::LocallyModified => "edited locally",
        InstallState::Conflict => "edited locally, update conflicts",
        InstallState::SourceUnavailable => "source not connected",
    }
}

pub fn evidence(e: EvidenceState) -> &'static str {
    match e {
        EvidenceState::AuthorDeclared => "declared by author",
        EvidenceState::LocallyChecked => "checked here",
        EvidenceState::Partial => "partially checked",
        EvidenceState::Failed => "check failed",
        EvidenceState::Stale => "check out of date",
        EvidenceState::NotEvaluated => "not evaluated",
    }
}

/// The next step as a short phrase, or `None` when there is nothing to do.
pub fn next_action(n: NextAction) -> Option<&'static str> {
    match n {
        NextAction::Install => Some("install"),
        NextAction::Update => Some("update"),
        NextAction::ResolveConflict => Some("resolve the conflict"),
        NextAction::ProvideInformation => Some("confirm facts with `habi declare`"),
        NextAction::SetUpPrerequisites => Some("set up prerequisites"),
        NextAction::None => None,
    }
}

fn prerequisite_status(s: PrerequisiteStatus) -> &'static str {
    match s {
        PrerequisiteStatus::Present => "found",
        PrerequisiteStatus::Missing => "missing",
        PrerequisiteStatus::Configured => "configured",
        PrerequisiteStatus::NotConfigured => "not configured here",
        PrerequisiteStatus::Unknown => "not established",
    }
}

fn prerequisite_kind(k: PrerequisiteKind) -> &'static str {
    match k {
        PrerequisiteKind::Tool => "tool",
        PrerequisiteKind::Mcp => "MCP server",
    }
}

fn file_state(s: FileState) -> &'static str {
    match s {
        FileState::Unchanged => "unchanged",
        FileState::Modified => "edited locally",
        FileState::Missing => "missing",
        FileState::Added => "added, not installed by Habi",
    }
}

pub fn journal_state(s: JournalState) -> &'static str {
    match s {
        JournalState::Applying => "interrupted (run `habi recover`)",
        JournalState::Committed => "done",
        JournalState::RolledBack => "rolled back",
        JournalState::NeedsAttention => "needs attention",
    }
}

pub fn contribution_state(s: ContributionState) -> &'static str {
    match s {
        ContributionState::Draft => "draft",
        ContributionState::Committed => "committed",
        ContributionState::Exported => "exported",
        ContributionState::Published => "sent for review",
        ContributionState::Discarded => "discarded",
    }
}

fn draft_file_status(s: DraftFileStatus) -> &'static str {
    match s {
        DraftFileStatus::Added => "added",
        DraftFileStatus::Modified => "changed",
        DraftFileStatus::Renamed => "renamed",
        DraftFileStatus::Unchanged => "unchanged",
        DraftFileStatus::Removed => "removed",
    }
}

pub fn diagnostic_level(l: DiagnosticLevel) -> &'static str {
    match l {
        DiagnosticLevel::Error => "error",
        DiagnosticLevel::Warning => "warning",
        DiagnosticLevel::Info => "note",
    }
}

fn freshness(f: Freshness) -> &'static str {
    match f {
        Freshness::NeverFetched => "not fetched yet",
        Freshness::FetchFailed => "first fetch failed",
        Freshness::Current => "up to date",
        Freshness::Stale => "offline copy (last refresh failed)",
    }
}

fn coverage(c: CoverageStatus) -> &'static str {
    match c {
        CoverageStatus::Complete => "complete",
        CoverageStatus::Partial => "partial",
        CoverageStatus::Failed => "failed",
    }
}

fn version_state(v: VersionState) -> &'static str {
    match v {
        VersionState::Resolved => "resolved",
        VersionState::Range => "version range",
        VersionState::Managed => "managed version",
        VersionState::Unresolved => "version not resolved",
    }
}

fn item_kind(k: ItemKind) -> &'static str {
    match k {
        // One concept: a workflow is a skill with steps.
        ItemKind::Skill | ItemKind::Workflow => "skill",
        ItemKind::Instructions => "instructions",
    }
}

fn repository_kind(k: RepositoryKind) -> &'static str {
    match k {
        RepositoryKind::Git => "Git repository",
        RepositoryKind::Worktree => "Git worktree",
        RepositoryKind::GitSubdirectory => "folder inside a Git repository",
        RepositoryKind::Plain => "plain folder (no Git)",
    }
}

fn review_state(s: ReviewState) -> &'static str {
    match s {
        ReviewState::Draft => "draft",
        ReviewState::Open => "open",
        ReviewState::ChangesRequested => "changes requested",
        ReviewState::Approved => "approved",
        ReviewState::Merged => "merged",
        ReviewState::Closed => "closed",
    }
}

pub fn subject(s: &DeclaredSubject) -> String {
    match s {
        DeclaredSubject::Tag { tag } => format!("tag {tag}"),
        DeclaredSubject::Dependency { name } => format!("dependency {name}"),
    }
}

/// `*` and `.` are the two module ids people see most; say what they mean.
pub fn module(m: &str) -> String {
    match m {
        "*" => "every module".into(),
        "." => "the repository root module".into(),
        other => format!("module {other}"),
    }
}

/// Replaces wording that only makes sense in the desktop app.
pub fn cli_wording(text: &str) -> String {
    text.replace(
        "Restore them from the project's history, or with habi restore.",
        "Run `habi history` and `habi restore <operation>` to restore them.",
    )
}

// ----- catalog -----------------------------------------------------------------

pub fn catalog_list(entries: &[habi_core::catalog::CatalogEntry]) {
    use habi_core::catalog::CatalogAvailability::*;
    use habi_core::catalog::registry::PublisherKind;
    for group in [PublisherKind::Builder, PublisherKind::Community] {
        println!(
            "{}",
            match group {
                PublisherKind::Builder => "From the builders",
                PublisherKind::Community => "From the community",
            }
        );
        for e in entries.iter().filter(|e| e.publisher.kind == group) {
            let state = match e.availability {
                NotFetched => "not fetched".to_string(),
                Previewed => "previewed".to_string(),
                Connected => "connected".to_string(),
            };
            let count = e
                .contents
                .as_ref()
                .map(|c| format!(", {} skills", c.items))
                .unwrap_or_default();
            println!("  {:<12} {}  ({state}{count})", e.id, e.repo);
        }
        println!();
    }
}

pub fn catalog_entry(
    e: &habi_core::catalog::CatalogEntry,
    index: Option<&habi_core::library::model::LibraryIndex>,
) {
    println!("{}  {}", e.name, e.url);
    match &e.ownership {
        Some(o) => println!("  official: {} (checked {})", o.evidence, o.checked),
        None => println!("  community: maintained independently"),
    }
    match &e.review {
        Some(r) => println!(
            "  reviewed: {} at {} by {}{}",
            r.scope,
            r.revision,
            r.by,
            if r.current {
                ""
            } else {
                " (the library has changed since)"
            }
        ),
        None => println!("  reviewed: no. Habi has not inspected this library."),
    }
    for note in &e.notes {
        println!("  note: {note}");
    }
    if let Some(f) = &e.fetched {
        println!(
            "  fetched: {} {}{}",
            match &f.release {
                Some(tag) => format!("release {tag}"),
                None if e.follows_releases => "default branch (no release published)".to_string(),
                None => f.branch.clone().unwrap_or_else(|| "default branch".into()),
            },
            short(&f.snapshot),
            f.updated
                .as_deref()
                .map(|d| format!(", last change {d}"))
                .unwrap_or_default()
        );
    }
    if let Some(c) = &e.contents {
        println!(
            "  contents: {} skills; {} with scripts ({} script files), {} with references, {} with assets",
            c.items, c.with_scripts, c.script_files, c.with_references, c.with_assets
        );
        println!(
            "  signals: {} caution, {} notice (static reading; not a guarantee)",
            c.signals.caution, c.signals.notice
        );
        if let Some(l) = &c.license {
            println!(
                "  licence: {} ({})",
                l.spdx.as_deref().unwrap_or("see the file"),
                l.file
            );
        }
        if !c.groups.is_empty() {
            let names: Vec<String> = c
                .groups
                .iter()
                .take(8)
                .map(|g| format!("{} ({})", g.name, g.items))
                .collect();
            println!(
                "  groups: {}{}",
                names.join(", "),
                if c.groups.len() > 8 { ", …" } else { "" }
            );
        }
    }
    if let Some(p) = &e.problem {
        println!("  problem: {}", p.message);
    }
    if let Some(index) = index {
        println!();
        for item in &index.items {
            let marks = item
                .signals
                .iter()
                .map(|s| s.severity)
                .max()
                .map(|s| format!("  [{s:?}]"))
                .unwrap_or_default();
            println!("  {}{marks}", item.path);
        }
    }
}

// ----- sources -----------------------------------------------------------------

pub fn sources(list: &[Source]) {
    if list.is_empty() {
        println!(
            "No libraries connected. Add one with: habi source add <name> <git-url-or-folder>"
        );
        return;
    }
    for s in list {
        let snapshot = s.snapshot.as_deref().map(short).unwrap_or("not fetched");
        println!(
            "{}  ({}{}, {})",
            s.name,
            if s.role == SourceRole::Community {
                "community, not reviewed by your team; "
            } else {
                ""
            },
            freshness(s.freshness),
            s.tracked.label()
        );
        println!(
            "    {}{}",
            s.location,
            s.subdir
                .as_ref()
                .map(|d| format!(" › {d}"))
                .unwrap_or_default()
        );
        println!(
            "    snapshot {snapshot}{}",
            s.snapshot_at
                .as_ref()
                .map(|t| format!(", refreshed {t}"))
                .unwrap_or_default()
        );
        if let Some(e) = &s.last_error {
            println!("    last refresh failed: {}", e.message);
        }
        if let Some(w) = &s.warning {
            println!("    ⚠ {w}");
        }
    }
}

pub fn refresh(r: &RefreshOutcome) {
    if !r.changed {
        println!("{}: up to date at {}.", r.source.name, short(&r.current));
    } else {
        println!(
            "{}: now at {} ({} new, {} updated, {} removed). Installed copies were not changed.",
            r.source.name,
            short(&r.current),
            r.added.len(),
            r.updated.len(),
            r.removed.len()
        );
        for id in &r.updated {
            println!("    updated: {id}");
        }
        for id in &r.added {
            println!("    new: {id}");
        }
    }
    if let Some(w) = &r.source.warning {
        println!("    ⚠ {w}");
    }
}

pub fn items(s: &Source, index: &LibraryIndex) {
    println!(
        "{} — {}",
        index.name.as_deref().unwrap_or(&s.name),
        short(&index.snapshot)
    );
    for item in &index.items {
        println!(
            "  {:<32} {:<12} {}",
            item.id,
            item_kind(item.kind),
            item.title
        );
    }
    for d in &index.diagnostics {
        println!("  {}: {}", diagnostic_level(d.level), d.message);
    }
    if !index.items.is_empty() {
        println!("\nSee how one fits a project: habi explain <item> -C <project>");
    }
}

// ----- projects ------------------------------------------------------------------

pub fn inspection(i: &ProjectInspection) {
    println!("{}  ({})", i.name, i.root);
    println!(
        "repository: {}{}",
        repository_kind(i.repository.kind),
        i.repository
            .branch
            .as_ref()
            .map(|b| format!(" on {b}"))
            .unwrap_or_default()
    );
    if i.repository.is_monorepo {
        if i.repository.workspace_signals.is_empty() {
            let manifests = i
                .modules
                .iter()
                .filter(|m| !m.ecosystems.is_empty())
                .count();
            println!("monorepo: {manifests} modules with their own manifests");
        } else {
            println!("monorepo: {}", i.repository.workspace_signals.join(", "));
        }
    }
    for m in &i.modules {
        let tags: Vec<String> = i
            .facts
            .iter()
            .filter(|f| f.module == m.id)
            .filter_map(|f| f.tag().map(habi_core::inspect::tags::label))
            .collect();
        println!("\nmodule {} ({})  {}", m.id, m.name, tags.join(" · "));
        for f in i.facts.iter().filter(|f| f.module == m.id) {
            if let FactSubject::Dependency {
                name,
                version,
                scope,
                ..
            } = &f.subject
            {
                let v = match version.state {
                    VersionState::Resolved => version.resolved.clone().unwrap_or_default(),
                    other => version_state(other).to_string(),
                };
                let at = f
                    .evidence
                    .first()
                    .map(|e| format!("{}:{}", e.file, e.line.unwrap_or(0)))
                    .unwrap_or_default();
                println!(
                    "    {name} {v} [{}]  {at}",
                    scope.clone().unwrap_or_default()
                );
            }
        }
        for c in i
            .coverage
            .iter()
            .filter(|c| c.module == m.id && c.status != CoverageStatus::Complete)
        {
            println!(
                "    ⚠ {} coverage {}: {}",
                c.area,
                coverage(c.status),
                c.notes.join(" ")
            );
        }
    }
    println!(
        "\nscanned {} in {} ms{}",
        plural(i.scan.files_seen as usize, "file"),
        i.scan.elapsed_ms,
        if i.scan.truncated {
            " (incomplete)"
        } else {
            ""
        }
    );
}

fn group_label(g: Group) -> &'static str {
    match g {
        Group::Required => "Team requirements",
        Group::Relevant => "Fits this project",
        Group::NeedsInformation => "Needs information",
        Group::Available => "Available to use manually (no applicability declared)",
        Group::NotApplicable => "Does not apply",
    }
}

pub fn recommendations(o: &ProjectOverview, all: bool) {
    if o.sources.is_empty() {
        println!(
            "No fetched library. Add one with: habi source add <name> <git-url-or-folder>, then: habi source refresh"
        );
        return;
    }
    let order = [
        Group::Required,
        Group::Relevant,
        Group::NeedsInformation,
        Group::Available,
        Group::NotApplicable,
    ];
    let mut shown = 0;
    for group in order {
        if group == Group::NotApplicable && !all {
            continue;
        }
        // Items without applicability rules are not recommendations: only
        // installed ones (which may need an update) are listed by default.
        let members: Vec<&Recommendation> = o
            .recommendations
            .iter()
            .filter(|r| r.group == group)
            .filter(|r| {
                all || group != Group::Available || r.install_state != InstallState::NotInstalled
            })
            .collect();
        if members.is_empty() {
            continue;
        }
        println!("\n{}", group_label(group));
        let tops = members.iter().filter(|r| r.top).count();
        if tops > 0 {
            println!("  Start with these");
        }
        let last_top = members.iter().rposition(|r| r.top);
        for (at, r) in members.iter().enumerate() {
            shown += 1;
            let required =
                if r.item.requirement == Requirement::Required && group != Group::Required {
                    " (team requirement)"
                } else {
                    ""
                };
            println!(
                "  {}  [{}/{}]{required}",
                r.item.title, r.item.source_name, r.item.id
            );
            match whose_rule(r) {
                Some(whose) => println!("      {} ({whose})", r.applicability.reason),
                None => println!("      {}", r.applicability.reason),
            }
            let mut line = format!(
                "      {} · {} · evidence: {}",
                install_state(r.install_state),
                readiness(r.readiness.state),
                evidence(r.evidence.state)
            );
            if group != Group::NotApplicable
                && let Some(next) = next_action(r.next_action)
            {
                line.push_str(&format!(" · next: {next}"));
            }
            println!("{line}");
            if last_top == Some(at) && at + 1 < members.len() {
                println!("  Also fits ({})", members.len() - at - 1);
            }
        }
    }
    let hidden = o
        .recommendations
        .iter()
        .filter(|r| r.group == Group::NotApplicable)
        .count();
    // What Habi read a rule from and did not find here is not the same as what
    // says nothing Habi can read.
    let mut unmatched: BTreeMap<&str, usize> = BTreeMap::new();
    let mut absent = 0usize;
    for r in o
        .recommendations
        .iter()
        .filter(|r| r.group == Group::Available && r.install_state == InstallState::NotInstalled)
    {
        if r.basis == Basis::Described {
            absent += 1;
        } else {
            *unmatched.entry(r.item.source_name.as_str()).or_default() += 1;
        }
    }
    if !all && absent > 0 {
        println!(
            "\n{} Habi did not find here.",
            if absent == 1 {
                "1 item is for a technology".to_string()
            } else {
                format!("{absent} items are for technologies")
            },
        );
    }
    if !all && !unmatched.is_empty() {
        let total: usize = unmatched.values().sum();
        let mut by_library: Vec<(&str, usize)> = unmatched.into_iter().collect();
        by_library.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        let libraries: Vec<String> = by_library
            .iter()
            .map(|(name, n)| format!("{name} {n}"))
            .collect();
        println!(
            "\n{} no applicability rules, so Habi does not match {} to projects ({}).\nList them with --all, or browse a library with: habi source items <library>",
            if total == 1 {
                "1 item has".to_string()
            } else {
                format!("{total} items have")
            },
            if total == 1 { "it" } else { "them" },
            libraries.join(", ")
        );
    }
    if !all && hidden > 0 {
        println!(
            "\n{} not apply (show with --all).",
            if hidden == 1 {
                "1 item does".to_string()
            } else {
                format!("{hidden} items do")
            }
        );
    }
    if shown > 0 {
        println!(
            "\nWhy: habi explain <item>    Install: habi install <item> --client claude-code (or cursor, codex)"
        );
    }
}

fn mark(t: Tri) -> &'static str {
    match t {
        Tri::True => "✓",
        Tri::False => "✗",
        Tri::Unknown => "?",
    }
}

fn tree(node: &EvalNode, depth: usize) {
    println!(
        "{}{} {} — {}",
        "  ".repeat(depth + 2),
        mark(node.outcome),
        node.summary,
        node.reason
    );
    for c in &node.children {
        tree(c, depth + 1);
    }
}

/// What the author declared and where the terms are; never an interpretation.
fn licence(item: &LibraryItem) -> String {
    match (&item.license, &item.license_file) {
        (Some(declared), Some(file)) => format!("{declared} (terms: {file})"),
        (Some(declared), None) => declared.clone(),
        (None, Some(file)) => format!("not declared in SKILL.md; terms in {file}"),
        (None, None) => "none found in the skill or its library".to_string(),
    }
}

pub fn explain(r: &Recommendation, item: Option<&LibraryItem>) {
    println!("{} ({}/{})", r.item.title, r.item.source_name, r.item.id);
    println!("{}\n", r.item.description);
    println!(
        "Applicability: {} — {}",
        applicability(r.applicability.applicability),
        r.applicability.reason
    );
    if let Some(whose) = whose_rule(r) {
        println!("Rule: {whose}");
    }
    for m in &r.applicability.modules {
        println!(
            "  {} → {}",
            module(&m.module),
            applicability(m.applicability)
        );
        if let Some(a) = &m.applies {
            println!("   applies when:");
            tree(a, 1);
        }
        if let Some(e) = &m.excludes {
            println!("   excluded when:");
            tree(e, 1);
        }
    }
    println!("\nReadiness: {}", readiness(r.readiness.state));
    for p in &r.readiness.prerequisites {
        println!(
            "  {} {} — {}: {}",
            prerequisite_kind(p.kind),
            p.name,
            prerequisite_status(p.status),
            p.detail
        );
    }
    println!("Installation: {}", install_state(r.install_state));
    if !r.item.installable {
        println!(
            "  Cannot be installed: {}",
            match item {
                Some(i) if !i.complete =>
                    "some of its files were skipped while reading the library",
                _ => "its SKILL.md name is not a valid skill folder name",
            }
        );
    }
    println!("Evidence: {}", evidence(r.evidence.state));
    for e in &r.evidence.declared {
        println!(
            "  declared {} {}: {}",
            e.date,
            e.result,
            e.summary.clone().unwrap_or_default()
        );
    }
    if let Some(item) = item {
        println!("Licence: {}", licence(item));
        if item.license_restricted {
            println!("  Declared proprietary: check the terms before copying or sharing it.");
        }
    }
    if let Some(item) = item
        && !item.checks.is_empty()
    {
        println!("\nChecks:");
        for c in &item.checks {
            println!("  {:<28} {}", c.id, c.title);
        }
    }
    if let Some(next) = next_action(r.next_action)
        && r.applicability.applicability != Applicability::DoesNotApply
    {
        println!("\nNext: {next}");
    }
}

pub fn plan(p: &Plan) {
    println!("{}", p.title);
    for item in &p.items {
        println!("  • {} from {} ({})", item.title, item.source, item.version);
    }
    plan_trust(p);
    if p.changes.is_empty() {
        println!("\nNothing to change: the project already matches.");
    }
    for c in &p.changes {
        let op = match c.op {
            ChangeOp::Create => "create",
            ChangeOp::Modify => "modify",
            ChangeOp::Delete => "delete",
        };
        println!(
            "\n  {op} {}  (+{} −{})",
            c.path, c.diff.added, c.diff.removed
        );
        if !c.explanation.is_empty() {
            println!("    {}", c.explanation);
        }
        // What will run is shown, not only counted: a new script as much as a changed one.
        if c.op == ChangeOp::Modify || (c.op == ChangeOp::Create && runs(&c.path)) {
            let (shown_hunks, shown_lines) = if c.op == ChangeOp::Create {
                (1, 60)
            } else {
                (3, 20)
            };
            let mut left_out = 0usize;
            for (at, h) in c.diff.hunks.iter().enumerate() {
                if at >= shown_hunks {
                    left_out += h.lines.len();
                    continue;
                }
                println!("    {}", h.header);
                for l in h.lines.iter().take(shown_lines) {
                    let sign = match l.tag {
                        LineTag::Added => "+",
                        LineTag::Removed => "-",
                        LineTag::Context => " ",
                    };
                    println!("    {sign}{}", l.text);
                }
                left_out += h.lines.len().saturating_sub(shown_lines);
            }
            if left_out > 0 {
                println!("    … and {} not shown", plural(left_out, "more line"));
            }
        }
    }
    for n in &p.notes {
        println!("\n  note: {}", cli_wording(n));
    }
    for s in p.mcp_suggestions.iter().filter(|s| !s.added) {
        println!(
            "\n  note: `{}` now suggests the `{}` MCP server. Add it with `habi update --mcp`.",
            s.item, s.server
        );
    }
    for c in &p.conflicts {
        println!("\n  CONFLICT {} — {}", c.path, c.message);
        if !c.options.is_empty() {
            println!(
                "    resolve with --keep {} or --overwrite {}",
                c.path, c.path
            );
        }
    }
    if !p.changes.is_empty() {
        println!("\n{}", cli_wording(&p.recovery));
    }
}

/// A file an agent or a tool could run, by its name.
fn runs(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let file = habi_core::library::model::ItemFile {
        path: name.to_string(),
        digest: String::new(),
        size: 0,
        executable: false,
    };
    file.is_code()
        || path.contains("/scripts/")
        || path.contains("/hooks/")
        || name == "hooks.json"
        || name == "settings.json"
}

/// Where each item comes from and what its scan found, ahead of the file list: this
/// is what a person decides on. Popularity is not in it, on purpose.
fn plan_trust(p: &Plan) {
    for i in &p.items {
        let cautions = i.cautions(p.action);
        let listed = match p.action {
            PlanAction::Update => &i.new_signals,
            PlanAction::Install => &i.signals,
            _ => continue,
        };
        if let (Some(origin), Some(summary)) = (&i.origin, &i.provenance_summary) {
            println!("\n  {}", i.title);
            println!("    from {origin} at {}", i.version);
            println!("    {summary}");
        }
        if !listed.is_empty() && p.action == PlanAction::Update {
            println!("    New in this update:");
        }
        for s in listed {
            let mark = match s.severity {
                SignalSeverity::Caution => "CAUTION",
                SignalSeverity::Notice => "notice ",
                SignalSeverity::Info => "info   ",
            };
            let place = match s.line {
                Some(line) => format!("{}:{line}", s.path),
                None => s.path.clone(),
            };
            println!("    {mark} {} ({place})", s.summary);
            if let Some(detail) = &s.detail {
                println!("            {detail}");
            }
            if s.more > 0 {
                println!("            and {} more", s.more);
            }
        }
        if !cautions.is_empty() {
            println!(
                "    {} to accept before this can be applied.",
                plural(cautions.len(), "caution")
            );
        }
    }
}

pub fn status(o: &ProjectOverview) {
    let installed: Vec<_> = o
        .recommendations
        .iter()
        .filter_map(|r| r.installation.as_ref())
        .chain(o.orphaned.iter())
        .collect();
    if installed.is_empty() {
        println!("Nothing installed by Habi in this project. See what fits with: habi recommend");
        return;
    }
    let mut updates = 0;
    for i in installed {
        if matches!(
            i.state,
            InstallState::UpdateAvailable | InstallState::Conflict
        ) {
            updates += 1;
        }
        let clients: Vec<&str> = i.clients.iter().map(|c| c.label()).collect();
        println!(
            "{}  {}  ({} · {} · {})",
            i.title,
            install_state(i.state),
            i.source_name,
            short(&i.snapshot),
            clients.join(", ")
        );
        if !i.source_identity.is_empty() {
            match &i.provenance {
                Some(provenance) => {
                    println!("    from {}: {}", i.source_identity, provenance.summary());
                }
                None => println!("    from {}", i.source_identity),
            }
        }
        for warning in &i.warnings {
            println!("    WARNING {warning}");
        }
        for f in &i.files {
            if !matches!(f.state, FileState::Unchanged) || f.upstream_changed {
                println!(
                    "    {} {}{}",
                    f.path,
                    file_state(f.state),
                    if f.upstream_changed {
                        " (changed upstream)"
                    } else {
                        ""
                    }
                );
            }
        }
    }
    if updates > 0 {
        println!(
            "\n{} available. Preview with: habi update",
            if updates == 1 {
                "1 update".to_string()
            } else {
                format!("{updates} updates")
            }
        );
    }
}

pub fn history(ops: &[OperationSummary]) {
    if ops.is_empty() {
        println!("No operations yet.");
    }
    for o in ops {
        println!(
            "{}  {}  {}  {}  ({})",
            // An unreadable journal is listed under its file name.
            o.id.get(..8).unwrap_or(&o.id),
            o.created_at,
            journal_state(o.state),
            o.title,
            plural(o.files.len(), "file")
        );
        for p in &o.problems {
            println!("    ! {p}");
        }
    }
    if !ops.is_empty() {
        println!("\nUndo one with: habi restore <operation>");
    }
}

/// Bytes in a short human form (1 decimal for MB and above).
pub fn size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    match bytes {
        b if b >= MB => format!("{:.1} MB", b as f64 / MB as f64),
        b if b >= KB => format!("{} KB", b / KB),
        b => format!("{b} bytes"),
    }
}

pub fn prune_report(r: &PruneReport) {
    let removed = r.operations_removed + r.snapshots_removed + r.objects_removed;
    if removed == 0 && r.bytes_freed == 0 {
        println!("Nothing to remove.");
    } else {
        println!(
            "Removed {}, {} and {} ({} freed).",
            plural(r.operations_removed as usize, "old operation record"),
            plural(r.snapshots_removed as usize, "old library snapshot"),
            plural(r.objects_removed as usize, "stored file version"),
            size(r.bytes_freed)
        );
    }
    if r.skipped_busy > 0 {
        println!(
            "{} in use by another Habi operation and skipped; run `habi gc` again later.",
            if r.skipped_busy == 1 {
                "1 project or library was".to_string()
            } else {
                format!("{} projects or libraries were", r.skipped_busy)
            }
        );
    }
}

pub fn declarations(list: &[Declaration], c_flag: &str) {
    if list.is_empty() {
        println!(
            "No declarations in this project. Add one with: habi declare tag <tag> --present{c_flag}"
        );
        return;
    }
    for d in list {
        println!(
            "{}  {} {} in {}{}",
            &d.id[..8.min(d.id.len())],
            subject(&d.subject),
            if d.present { "present" } else { "absent" },
            module(&d.module),
            d.note
                .as_ref()
                .map(|n| format!(" — {n}"))
                .unwrap_or_default()
        );
    }
    println!("\nRemove one with: habi undeclare <id>{c_flag}");
}

// ----- contributions -------------------------------------------------------------

/// The review request as last read from the host. Comments are plain text
/// written by other people; they are printed, never interpreted.
pub fn review(c: &Contribution) {
    let Some(r) = &c.review else {
        println!(
            "{}",
            c.published_note
                .as_deref()
                .unwrap_or("No review request was found for this branch.")
        );
        return;
    };
    println!(
        "{} #{}: {} (checked {})",
        r.host.name(),
        r.number,
        review_state(r.state),
        r.checked_at
    );
    if let Some(url) = &r.url {
        println!("{url}");
    }
    if !r.approved_by.is_empty() {
        println!("Approved by {}", r.approved_by.join(", "));
    }
    for comment in &r.comments {
        let place = match (&comment.path, comment.line) {
            (Some(p), Some(l)) => format!(
                " on {p}:{l}{}",
                if comment.outdated { " (outdated)" } else { "" }
            ),
            (Some(p), None) => format!(" on {p}"),
            _ => String::new(),
        };
        let verdict = match comment.verdict {
            Some(habi_core::review::ReviewVerdict::Approved) => " approved",
            Some(habi_core::review::ReviewVerdict::ChangesRequested) => " requested changes",
            None => "",
        };
        println!("\n— {}{verdict}{place}:", comment.author);
        for line in comment.body.lines() {
            println!("  {line}");
        }
    }
    if r.comments_truncated {
        println!("\n(More comments exist; open the request to see all.)");
    }
}

pub fn contribution_line(c: &Contribution) {
    println!(
        "{}  {:<16} {}  ({})",
        c.id,
        contribution_state(c.state),
        c.title,
        c.source_name
    );
}

pub fn contribution(c: &Contribution, staging: &str) {
    println!("{}  [{}]  {}", c.id, contribution_state(c.state), c.title);
    println!(
        "to {} › {} (base {}, branch {})",
        c.source_name,
        c.item_path,
        short(&c.base_commit),
        c.branch
    );
    if !c.message.is_empty() {
        println!("\n{}", c.message);
    }
    println!(
        "\nTo {} ({}), branch {}",
        c.source_name,
        c.remote
            .as_ref()
            .map(|r| r.display.as_str())
            .unwrap_or("remote unknown"),
        c.branch
    );
    println!("\nChanged files (only included ones leave this machine):");
    let mut any = false;
    for f in &c.files {
        if f.status == DraftFileStatus::Unchanged {
            continue;
        }
        any = true;
        let what = match (&f.previous_path, f.status) {
            (Some(prev), DraftFileStatus::Renamed) => format!("{prev} → {}", f.path),
            _ => format!("{} (+{} −{})", f.path, f.diff.added, f.diff.removed),
        };
        println!(
            "  {} {:<9} {what}",
            if f.included { "[x]" } else { "[ ]" },
            draft_file_status(f.status),
        );
    }
    if !any {
        println!("  (none yet: nothing differs from the library)");
    }
    let unchanged = c
        .files
        .iter()
        .filter(|f| f.status == DraftFileStatus::Unchanged)
        .count();
    if unchanged > 0 {
        println!("  … and {unchanged} unchanged file(s)");
    }
    let (errors, warnings): (Vec<_>, Vec<_>) = c
        .validation
        .iter()
        .partition(|d| d.level == habi_core::library::model::DiagnosticLevel::Error);
    if errors.is_empty() && warnings.is_empty() {
        println!(
            "\nChecked: package format, Habi metadata, file references, secrets — nothing to fix.\nThis does not test what the skill does."
        );
    }
    if !errors.is_empty() {
        println!("\nBlocking (fix before preparing a branch):");
        for d in errors {
            println!("  {}", d.message);
        }
    }
    if !warnings.is_empty() {
        println!("\nWarnings (do not block):");
        for d in warnings {
            println!("  {}: {}", diagnostic_level(d.level), d.message);
        }
    }
    println!("\nEdit files in: {staging}");
}
