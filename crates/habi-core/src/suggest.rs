//! The kit: a short, opinionated answer to "what should my agents have
//! here?", for every project, before anything is connected.
//!
//! It draws on two places. Connected libraries contribute what fits by
//! their author's rule or the catalog's (the same recommendations the
//! workbench lists), and the team's own skills by what they say they are
//! for. Libraries in the catalog that are not connected contribute Habi's
//! picks, evaluated against the project from the catalog alone: nothing is
//! fetched to make a suggestion.
//!
//! Ordering is stated, not scored: team requirements, then skills for this
//! stack (the author's rule before Habi's, Habi's picks before its other
//! rules, one technology before many, what the project is built on before
//! how it is shipped, a framework before a language), then a few practices
//! that fit any codebase, from libraries the kit already uses where it can.
//! Each list is capped, and a rule Habi did not pick fills one place per
//! library. What the project already has stays listed and takes no place.

use crate::catalog::registry::{Entry, Pick, PublisherKind, StatusState};
use crate::install::lock::lock_key;
use crate::install::status::SkillFolders;
use crate::library::model::{ItemFile, LibraryIndex, LibraryItem};
use crate::library::signals::SignalSeverity;
use crate::matching::condition::Condition;
use crate::matching::{Applicability, ApplicabilityResult, Scope, Views, assess_in};
use crate::recommend::{Basis, Group, Recommendation};
use crate::service::ItemRef;
use crate::source::{Source, SourceRole, portable_identity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use ts_rs::TS;

/// Team requirements shown at most.
const MAX_REQUIRED: usize = 4;
/// Skills for the project's stack shown at most.
const MAX_STACK: usize = 6;
/// Skills one library contributes by a rule Habi suggests (its own words, or
/// a catalog hint) without being one of Habi's picks.
const MAX_UNPICKED_PER_LIBRARY: usize = 1;
/// Practices that fit any codebase shown at most.
const MAX_PRACTICE: usize = 3;
/// Skills for the stack, of Habi's choosing, that start chosen. Every skill an
/// agent carries costs context in every session, so the list is longer than
/// what starts ticked: the strongest few, the rest a tick away.
const MAX_TICKED_STACK: usize = 3;
/// Practices that start chosen, unless the person's other projects use them.
const MAX_TICKED_PRACTICE: usize = 1;
/// A rule accepting more alternatives than this is too broad to start chosen.
const MAX_TICKED_BREADTH: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KitGroup {
    /// The team requires it, and its conditions do not rule it out.
    Required,
    /// A rule about the project's technologies holds here.
    Stack,
    /// Habi's pick for any codebase: a way of working, not a technology.
    Practice,
}

/// Where a suggested skill comes from.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SuggestedLibrary {
    pub name: String,
    /// The catalog entry, for a library Habi's catalog lists.
    pub entry_id: Option<String>,
    /// The connected library, once it is connected.
    pub source_id: Option<String>,
    /// Published by others, not reviewed by the team.
    pub community: bool,
    /// The organisation behind the tools the skills are about.
    pub builder: bool,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Suggestion {
    /// The same before and after its library is connected:
    /// `catalog:<entry>/<folder>` for a catalog library, the item key otherwise.
    pub key: String,
    pub group: KitGroup,
    pub title: String,
    /// The skill's folder name.
    pub name: String,
    /// What it does: Habi's words for a pick, the author's description otherwise.
    pub gist: String,
    pub library: SuggestedLibrary,
    /// What to install, once the library is connected.
    pub item: Option<ItemRef>,
    /// The project already has it: installed by Habi, or a copy of the same name.
    pub installed: bool,
    /// Whose rule decided that it fits.
    pub basis: Basis,
    /// Habi's reason, when the skill is one of Habi's picks.
    pub pick: Option<String>,
    /// How its rule held here: the evaluation the workbench explains. `None` for a practice.
    pub applicability: Option<ApplicabilityResult>,
    /// The person's other projects that have it, installed by Habi.
    pub elsewhere: Vec<String>,
    /// What its name and description cost in every agent session, in tokens.
    pub tokens: u32,
    /// It comes with code an agent could run.
    pub scripts: bool,
    /// What the scan of its files flags as caution, in plain sentences.
    pub caution: Vec<String>,
    /// Whether it starts ticked: team requirements and rules, what the
    /// person's other projects use, then the strongest few. Never a skill the
    /// scan flags, nor community code to run; those are a choice to make.
    pub chosen: bool,
}

/// What a skill's name and description cost in every agent session, in tokens,
/// about 4 characters each. Agents load these at the start of a session to know
/// the skill exists; the instructions load only when it is used.
pub fn tokens_of(name: &str, description: &str) -> u32 {
    let chars = name.chars().count() + description.chars().count();
    u32::try_from(chars.div_ceil(4)).unwrap_or(u32::MAX)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Kit {
    pub suggestions: Vec<Suggestion>,
    /// Further skills from connected libraries that fit and are not in the kit.
    pub more: u32,
}

impl Kit {
    /// Catalog libraries the kit draws on that are not connected yet.
    pub fn unconnected_entries(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in &self.suggestions {
            if let (false, Some(id)) = (s.library.connected, &s.library.entry_id)
                && !out.contains(id)
            {
                out.push(id.clone());
            }
        }
        out
    }
}

/// A connected library, with the catalog entry it is the repository of.
pub struct Connected<'a> {
    pub source: &'a Source,
    pub index: &'a LibraryIndex,
    pub entry: Option<&'a Entry>,
}

/// Everything the kit is drawn from.
pub struct KitInput<'a> {
    pub root: &'a Path,
    /// The skill folders the project has, listed once.
    pub folders: &'a SkillFolders,
    pub views: &'a Views<'a>,
    pub recommendations: &'a [Recommendation],
    pub connected: &'a [Connected<'a>],
    /// Every catalog entry; those not connected contribute their picks.
    pub catalog: &'a [Entry],
    /// What the person's other projects have installed, by lock key, with their names.
    pub elsewhere: &'a HashMap<String, Vec<String>>,
}

struct Candidate {
    suggestion: Suggestion,
    /// Its rule names only languages: true of many projects, so said last.
    broad: bool,
    /// How many alternatives its rule accepts: "uses React" is one, "any
    /// web framework" five. The narrower rule is the stronger reason.
    breadth: usize,
    /// Its rule is about how the project is built and shipped (CI,
    /// containers, build tools), not what it is built on: said after.
    tooling: bool,
    specificity: u32,
    /// Position among the catalog's picks: Habi's own order.
    order: usize,
}

pub fn kit(input: &KitInput) -> Kit {
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut fitting = 0usize;
    let items: HashMap<&str, &LibraryItem> = input
        .connected
        .iter()
        .flat_map(|c| c.index.items.iter())
        .map(|i| (i.key.as_str(), i))
        .collect();

    for r in input.recommendations {
        let Some(library) = input
            .connected
            .iter()
            .find(|c| c.source.id == r.item.source_id)
        else {
            continue;
        };
        let elsewhere = input
            .elsewhere
            .get(&lock_key(&portable_identity(library.source), &r.item.id))
            .cloned()
            .unwrap_or_default();
        // A skill with no rule is still worth offering when Habi picks it for
        // any codebase, or when the person's other projects already use it.
        let anywhere = r.pick.as_ref().is_some_and(|p| p.anywhere);
        let kind = match (r.group, r.applicability.applicability) {
            (Group::Required, _) => KitGroup::Required,
            (Group::Relevant, _) => KitGroup::Stack,
            (_, Applicability::Undeclared) if anywhere || !elsewhere.is_empty() => {
                KitGroup::Practice
            }
            _ => continue,
        };
        let installed = r.installation.is_some() || input.folders.has(input.root, &r.item.name);
        // `more` says what fits and is not shown; an installed skill is neither
        // counted as shown nor something more to find.
        if kind != KitGroup::Practice && !installed {
            fitting += 1;
        }
        if !r.item.installable && !installed {
            continue;
        }
        let found = items.get(r.item.key.as_str()).copied();
        let path = found.map(|i| i.path.as_str());
        let (key, order) = match (library.entry, path) {
            (Some(entry), Some(path)) => (
                catalog_key(&entry.id, path),
                entry
                    .picks
                    .iter()
                    .position(|p| p.skill == path)
                    .map_or(usize::MAX, |at| catalog_order(input.catalog, &entry.id, at)),
            ),
            _ => (r.item.key.clone(), usize::MAX),
        };
        let practice = kind == KitGroup::Practice;
        let broad = !practice && names_only_languages(&r.applicability);
        // What a skill's own words name is a pointer, not a pick: the kit
        // takes it from the team's own libraries, and never for a language
        // alone. The rest stays under every skill, explained.
        if r.basis == Basis::Described
            && !installed
            && (broad || library.source.role == SourceRole::Community)
        {
            continue;
        }
        let mut caution: Vec<String> = Vec::new();
        for signal in found
            .map_or(&[][..], |i| i.signals.as_slice())
            .iter()
            .filter(|s| s.severity == SignalSeverity::Caution)
        {
            if !caution.contains(&signal.summary) {
                caution.push(signal.summary.clone());
            }
        }
        candidates.push(Candidate {
            broad,
            breadth: rule_of(&r.applicability).map_or(0, breadth),
            tooling: rule_of(&r.applicability).is_some_and(is_tooling),
            specificity: r.applicability.specificity,
            order,
            suggestion: Suggestion {
                key,
                group: kind,
                title: r
                    .pick
                    .as_ref()
                    .map_or_else(|| r.item.title.clone(), |p| p.title.clone()),
                name: r.item.name.clone(),
                gist: r
                    .pick
                    .as_ref()
                    .map_or_else(|| r.item.description.clone(), |p| p.gist.clone()),
                library: SuggestedLibrary {
                    name: r.item.source_name.clone(),
                    entry_id: library.entry.map(|e| e.id.clone()),
                    source_id: Some(library.source.id.clone()),
                    community: library.source.role == SourceRole::Community,
                    builder: library
                        .entry
                        .is_some_and(|e| e.publisher.kind == PublisherKind::Builder),
                    connected: true,
                },
                item: Some(ItemRef {
                    source_id: r.item.source_id.clone(),
                    item_id: r.item.id.clone(),
                }),
                installed,
                basis: r.basis,
                pick: r.pick.as_ref().map(|p| p.why.clone()),
                applicability: (!practice).then(|| r.applicability.clone()),
                elsewhere,
                tokens: tokens_of(&r.item.name, &r.item.description),
                scripts: found.is_some_and(|i| i.files.iter().any(ItemFile::is_code)),
                caution,
                chosen: false,
            },
        });
    }

    // Libraries in the catalog that are not connected: Habi's picks, judged
    // from the catalog alone.
    for entry in input.catalog {
        if entry.status.state != StatusState::Active
            || input
                .connected
                .iter()
                .any(|c| c.entry.is_some_and(|e| e.id == entry.id))
        {
            continue;
        }
        for (order, pick) in entry.picks.iter().enumerate() {
            let (kind, applicability) = match &pick.applies_when {
                Some(rule) => {
                    let a = assess_in(Some(rule), None, Scope::Module, input.views);
                    if a.applicability != Applicability::Applies {
                        continue;
                    }
                    (KitGroup::Stack, Some(a))
                }
                None => (KitGroup::Practice, None),
            };
            candidates.push(Candidate {
                broad: applicability.as_ref().is_some_and(names_only_languages),
                breadth: pick.applies_when.as_ref().map_or(0, breadth),
                tooling: pick.applies_when.as_ref().is_some_and(is_tooling),
                specificity: applicability.as_ref().map_or(0, |a| a.specificity),
                order: catalog_order(input.catalog, &entry.id, order),
                suggestion: from_pick(input, entry, pick, kind, applicability),
            });
        }
    }

    // One order, stated: the group; within it what could be added before
    // what the project has; what the person's other projects use; whose rule
    // it is (the author's, Habi's pick, Habi's other rules, the skill's own
    // words); one technology before a few before many; what the project is
    // built on before how it is shipped; then Habi's order in the catalog.
    candidates.sort_by_cached_key(|c| {
        (
            (
                c.suggestion.group,
                c.suggestion.installed,
                c.suggestion.elsewhere.is_empty(),
                basis_rank(c.suggestion.basis),
                c.suggestion.pick.is_none(),
                c.broad,
            ),
            (
                match c.breadth {
                    0 | 1 => 0,
                    2 | 3 => 1,
                    _ => 2,
                },
                c.tooling,
                c.breadth,
                std::cmp::Reverse(c.specificity),
            ),
            (
                c.order,
                !c.suggestion.library.connected,
                !c.suggestion.library.builder,
                c.suggestion.title.to_lowercase(),
            ),
        )
    });

    // Each list is capped. A rule Habi suggests without standing behind the
    // skill fills one place per library. What the project already has stays
    // listed, as done, and takes no place. One suggestion per skill name.
    let (mut practices, candidates): (Vec<Candidate>, Vec<Candidate>) = candidates
        .into_iter()
        .partition(|c| c.suggestion.group == KitGroup::Practice);
    // Skills whose rule is narrow enough to start chosen.
    let narrow: Vec<String> = candidates
        .iter()
        .filter(|c| !c.broad && c.breadth <= MAX_TICKED_BREADTH)
        .map(|c| c.suggestion.key.clone())
        .collect();
    let mut out: Vec<Suggestion> = Vec::new();
    let named = |out: &[Suggestion], s: &Suggestion| {
        out.iter().any(|o| o.name.eq_ignore_ascii_case(&s.name))
    };
    let (mut required, mut stack) = (0usize, 0usize);
    let mut unpicked: HashMap<String, usize> = HashMap::new();
    for c in candidates {
        let s = c.suggestion;
        if named(&out, &s) {
            continue;
        }
        if !s.installed {
            let room = match s.group {
                KitGroup::Required => {
                    required += 1;
                    required <= MAX_REQUIRED
                }
                _ => {
                    if s.basis != Basis::Declared && s.pick.is_none() {
                        let n = unpicked.entry(library_key(&s.library)).or_default();
                        *n += 1;
                        if *n > MAX_UNPICKED_PER_LIBRARY {
                            continue;
                        }
                    }
                    stack += 1;
                    stack <= MAX_STACK
                }
            };
            if !room {
                continue;
            }
        }
        out.push(s);
    }
    // Practices: those already here, then up to a few more — what other
    // projects use first, then from libraries the kit already uses, so adding
    // it connects as few libraries as it must, then Habi's order.
    practices.retain(|c| !named(&out, &c.suggestion));
    let (here, mut practices): (Vec<Candidate>, Vec<Candidate>) =
        practices.into_iter().partition(|c| c.suggestion.installed);
    let mut added = 0usize;
    while added < MAX_PRACTICE {
        let uses = |c: &Candidate| {
            out.iter()
                .any(|s| library_key(&s.library) == library_key(&c.suggestion.library))
        };
        let Some(at) = (0..practices.len()).min_by_key(|&i| {
            practices.get(i).map(|c| {
                (
                    std::cmp::Reverse(c.suggestion.elsewhere.len()),
                    !uses(c),
                    c.order,
                )
            })
        }) else {
            break;
        };
        let s = practices.remove(at).suggestion;
        if !named(&out, &s) {
            out.push(s);
            added += 1;
        }
    }
    for c in here {
        if !named(&out, &c.suggestion) {
            out.push(c.suggestion);
        }
    }
    tick(&mut out, &narrow);
    let shown = out
        .iter()
        .filter(|s| s.library.connected && s.group != KitGroup::Practice && !s.installed)
        .count();
    Kit {
        more: u32::try_from(fitting.saturating_sub(shown)).unwrap_or(u32::MAX),
        suggestions: out,
    }
}

/// Sets what starts ticked, walking the list in its order.
fn tick(out: &mut [Suggestion], narrow: &[String]) {
    let (mut stack, mut practice) = (0usize, 0usize);
    for s in out.iter_mut() {
        let flagged = !s.caution.is_empty() || (s.library.community && s.scripts);
        let team_rule = !s.library.community && s.basis == Basis::Declared;
        s.chosen = !s.installed
            && match s.group {
                _ if flagged => false,
                KitGroup::Required => true,
                _ if !s.elsewhere.is_empty() => true,
                KitGroup::Stack if team_rule => true,
                KitGroup::Stack
                    if s.pick.is_some() && stack < MAX_TICKED_STACK && narrow.contains(&s.key) =>
                {
                    stack += 1;
                    true
                }
                KitGroup::Practice if practice < MAX_TICKED_PRACTICE => {
                    practice += 1;
                    true
                }
                _ => false,
            };
    }
}

/// One library, however it is reached: its catalog entry, else its source.
fn library_key(library: &SuggestedLibrary) -> String {
    library
        .entry_id
        .clone()
        .or_else(|| library.source_id.clone())
        .unwrap_or_else(|| library.name.clone())
}

/// `catalog:<entry>/<folder>`: one key for a catalog skill, connected or not.
pub fn catalog_key(entry_id: &str, path: &str) -> String {
    format!("catalog:{entry_id}/{path}")
}

/// Habi's order across the catalog: entries as listed, picks as listed in each.
fn catalog_order(catalog: &[Entry], entry_id: &str, pick: usize) -> usize {
    let entry = catalog
        .iter()
        .position(|e| e.id == entry_id)
        .unwrap_or(catalog.len());
    entry.saturating_mul(1000).saturating_add(pick)
}

/// The rule an evaluation held: the first module's, where every module has the same.
fn rule_of(a: &ApplicabilityResult) -> Option<&Condition> {
    a.modules
        .iter()
        .find_map(|m| m.applies.as_ref())
        .map(|n| &n.condition)
}

/// Whether every tag a rule names is about building and shipping the
/// project (`ci:`, `container:`, `build:`) rather than what it is built on.
fn is_tooling(rule: &Condition) -> bool {
    fn walk(c: &Condition, tooling: &mut bool, other: &mut bool) {
        match c {
            Condition::All { items } | Condition::Any { items } => {
                for i in items {
                    walk(i, tooling, other);
                }
            }
            Condition::Not { .. } => {}
            Condition::Tag { tag }
                if ["ci:", "container:", "build:"]
                    .iter()
                    .any(|p| tag.starts_with(p)) =>
            {
                *tooling = true
            }
            _ => *other = true,
        }
    }
    let (mut tooling, mut other) = (false, false);
    walk(rule, &mut tooling, &mut other);
    tooling && !other
}

/// How many alternatives a rule accepts: one for a single fact, the sum for
/// "any of", the narrowest for "all of".
fn breadth(rule: &Condition) -> usize {
    match rule {
        Condition::Any { items } => items.iter().map(breadth).sum(),
        Condition::All { items } => items.iter().map(breadth).min().unwrap_or(1),
        _ => 1,
    }
}

fn basis_rank(basis: Basis) -> u8 {
    match basis {
        Basis::Declared => 0,
        Basis::CatalogHint => 1,
        Basis::Described => 2,
    }
}

fn from_pick(
    input: &KitInput,
    entry: &Entry,
    pick: &Pick,
    kind: KitGroup,
    applicability: Option<ApplicabilityResult>,
) -> Suggestion {
    let installed = input.folders.has(input.root, pick.name());
    Suggestion {
        key: catalog_key(&entry.id, &pick.skill),
        group: kind,
        title: pick.title.clone(),
        name: pick.name().to_string(),
        gist: pick.gist.clone(),
        library: SuggestedLibrary {
            name: entry.name.clone(),
            entry_id: Some(entry.id.clone()),
            source_id: None,
            community: true,
            builder: entry.publisher.kind == PublisherKind::Builder,
            connected: false,
        },
        item: None,
        installed,
        basis: Basis::CatalogHint,
        pick: Some(pick.why.clone()),
        applicability,
        // Nothing of a library that is not connected is installed through Habi.
        elsewhere: Vec::new(),
        tokens: pick.tokens,
        scripts: pick.scripts,
        caution: pick.caution.iter().cloned().collect(),
        chosen: false,
    }
}

/// Whether every condition that held names a language only (`lang:python`):
/// true of many projects, so a weaker reason than a framework or a file.
fn names_only_languages(a: &ApplicabilityResult) -> bool {
    fn walk(c: &Condition, langs: &mut bool, other: &mut bool) {
        match c {
            Condition::All { items } | Condition::Any { items } => {
                for i in items {
                    walk(i, langs, other);
                }
            }
            Condition::Not { .. } => {}
            Condition::Tag { tag } if tag.starts_with("lang:") => *langs = true,
            _ => *other = true,
        }
    }
    let (mut langs, mut other) = (false, false);
    for m in &a.modules {
        if let Some(node) = &m.applies {
            walk(&node.condition, &mut langs, &mut other);
        }
    }
    langs && !other
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancel::CancelToken;
    use crate::catalog::registry::Registry;

    /// A project folder with these files, as `(path, contents)`.
    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let at = dir.path().join(path);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, text).unwrap();
        }
        dir
    }

    const REACT: &[(&str, &str)] = &[
        (
            "package.json",
            r#"{"name":"web","dependencies":{"react":"19.0.0"}}"#,
        ),
        ("src/App.tsx", "export const App = () => null;"),
    ];
    const DJANGO: &[(&str, &str)] = &[
        (
            "pyproject.toml",
            "[project]\nname = \"shop\"\ndependencies = [\"django>=5\"]\n",
        ),
        ("shop/views.py", "x = 1"),
    ];

    fn catalog(yaml: &str) -> Vec<Entry> {
        Registry::parse(yaml).unwrap().entries
    }

    const CATALOG: &str = r#"version: 1
sources:
  - id: makers
    name: Makers
    url: https://github.com/makers/skills
    summary: Skills.
    publisher: { name: Makers, kind: builder, owner: makers }
    ownership: { method: github-verified-org, checked: "2026-10-03" }
    picks:
      - { skill: skills/react-rules, title: React rules, gist: Rules for React., tokens: 10, why: React apps, applies_when: { tag: "framework:react" } }
      - { skill: skills/django-rules, name: makers-django, title: Django rules, gist: Rules for Django., tokens: 10, why: Django apps, applies_when: { tag: "framework:django" } }
      - { skill: skills/ts-style, title: TypeScript style, gist: Style., tokens: 10, why: TypeScript, applies_when: { tag: "lang:typescript" } }
      - { skill: skills/web-any, title: Any web, gist: Web., tokens: 10, why: Web apps, applies_when: { any: [ { tag: "framework:vue" }, { tag: "framework:svelte" }, { tag: "framework:react" } ] } }
      - { skill: skills/makers-way, title: Makers way, gist: How makers work., tokens: 10, why: Any codebase }
  - id: crowd
    name: Crowd
    url: https://github.com/crowd/skills
    summary: Skills.
    publisher: { name: Crowd, kind: community, owner: crowd }
    picks:
      - { skill: skills/debugging, title: Debugging, gist: Find the cause first., tokens: 10, why: Any codebase }
      - { skill: skills/planning, title: Planning, gist: "Plan, then build.", tokens: 10, why: Any codebase }
      - { skill: skills/review, title: Review, gist: Review the diff., tokens: 10, why: Any codebase }
      - { skill: skills/verify, title: Verify, gist: Check before saying done., tokens: 10, why: Any codebase }
      - { skill: other/react-rules, title: React rules again, gist: Same name., tokens: 10, why: React apps, applies_when: { tag: "framework:react" } }
"#;

    fn run(root: &Path) -> Kit {
        run_with(CATALOG, root)
    }

    fn run_with(yaml: &str, root: &Path) -> Kit {
        let inspection =
            crate::inspect::inspect(root, &Default::default(), &CancelToken::new()).unwrap();
        let views = Views::new(&inspection, &[]);
        let entries = catalog(yaml);
        kit(&KitInput {
            root,
            folders: &SkillFolders::of(root),
            views: &views,
            recommendations: &[],
            connected: &[],
            catalog: &entries,
            elsewhere: &HashMap::new(),
        })
    }

    #[test]
    fn a_project_with_nothing_connected_gets_picks_for_its_stack_and_a_few_practices() {
        let dir = project(REACT);
        let k = run(dir.path());
        let titles: Vec<&str> = k.suggestions.iter().map(|s| s.title.as_str()).collect();
        // The narrow rule before the broad one and the framework before the
        // language, the makers' copy of a shared name; then three practices,
        // a library the kit already uses first, then the catalog's order.
        assert_eq!(
            titles,
            [
                "React rules",
                "Any web",
                "TypeScript style",
                "Makers way",
                "Debugging",
                "Planning"
            ]
        );
        assert!(
            k.suggestions
                .iter()
                .all(|s| !s.library.connected && s.item.is_none())
        );
        assert_eq!(k.suggestions[0].key, "catalog:makers/skills/react-rules");
        assert!(k.suggestions[0].applicability.is_some());
        assert!(k.suggestions[3].applicability.is_none());
        assert_eq!(k.unconnected_entries(), ["makers", "crowd"]);
        assert_eq!(k.more, 0);
    }

    #[test]
    fn rules_that_do_not_hold_are_not_suggested() {
        let dir = project(DJANGO);
        let k = run(dir.path());
        let titles: Vec<&str> = k.suggestions.iter().map(|s| s.title.as_str()).collect();
        assert!(titles.contains(&"Django rules"));
        assert!(!titles.contains(&"React rules"));
        assert!(!titles.contains(&"TypeScript style"));
    }

    #[test]
    fn a_skill_already_in_the_project_is_marked_and_kept() {
        let dir = project(&[(
            ".claude/skills/debugging/SKILL.md",
            "---\nname: debugging\n---\n",
        )]);
        let k = run(dir.path());
        let debugging = k
            .suggestions
            .iter()
            .find(|s| s.name == "debugging")
            .unwrap();
        assert!(debugging.installed);
    }

    #[test]
    fn a_pick_is_known_by_the_name_it_installs_under() {
        let mut files = DJANGO.to_vec();
        files.push((
            ".claude/skills/makers-django/SKILL.md",
            "---\nname: makers-django\n---\n",
        ));
        let dir = project(&files);
        let k = run(dir.path());
        let django = k
            .suggestions
            .iter()
            .find(|s| s.title == "Django rules")
            .unwrap();
        assert!(django.installed);
        assert_eq!(django.name, "makers-django");
    }

    #[test]
    fn practices_already_here_take_no_place() {
        let mut files = REACT.to_vec();
        for name in ["debugging", "planning", "makers-way"] {
            files.push(match name {
                "debugging" => (
                    ".claude/skills/debugging/SKILL.md",
                    "---\nname: debugging\n---\n",
                ),
                "planning" => (
                    ".agents/skills/planning/SKILL.md",
                    "---\nname: planning\n---\n",
                ),
                _ => (
                    ".claude/skills/makers-way/SKILL.md",
                    "---\nname: makers-way\n---\n",
                ),
            });
        }
        let dir = project(&files);
        let k = run(dir.path());
        let practices: Vec<(&str, bool)> = k
            .suggestions
            .iter()
            .filter(|s| s.group == KitGroup::Practice)
            .map(|s| (s.title.as_str(), s.installed))
            .collect();
        // The two not yet here, then the three that are.
        assert_eq!(
            practices,
            [
                ("Review", false),
                ("Verify", false),
                ("Makers way", true),
                ("Debugging", true),
                ("Planning", true),
            ]
        );
    }

    #[test]
    fn the_strongest_few_start_ticked_and_flagged_skills_never_do() {
        let yaml = r#"version: 1
sources:
  - id: makers
    name: Makers
    url: https://github.com/makers/skills
    summary: Skills.
    publisher: { name: Makers, kind: builder, owner: makers }
    ownership: { method: github-verified-org, checked: "2026-10-03" }
    picks:
      - { skill: skills/one, title: One, gist: G, tokens: 10, why: W, applies_when: { tag: "framework:react" } }
      - { skill: skills/two, title: Two, gist: G, tokens: 20, why: W, applies_when: { tag: "framework:react" } }
      - { skill: skills/code, title: Code, gist: G, tokens: 5, scripts: true, why: W, applies_when: { tag: "framework:react" } }
      - { skill: skills/flag, title: Flag, gist: G, tokens: 5, caution: "Contains a compiled program", why: W, applies_when: { tag: "framework:react" } }
      - { skill: skills/three, title: Three, gist: G, tokens: 30, why: W, applies_when: { dependency: { name: react, ecosystem: npm } } }
      - { skill: skills/four, title: Four, gist: G, tokens: 40, why: W, applies_when: { tag: "lang:typescript" } }
      - { skill: skills/five, title: Five, gist: G, tokens: 50, why: W, applies_when: { dependency: { name: react-dom, ecosystem: npm } } }
      - { skill: skills/wide, title: Wide, gist: G, tokens: 60, why: W, applies_when: { any: [ { tag: "framework:vue" }, { tag: "framework:svelte" }, { tag: "framework:angular" }, { tag: "framework:next" }, { tag: "framework:react" } ] } }
      - { skill: skills/way, title: Way, gist: G, tokens: 70, why: W }
      - { skill: skills/other, title: Other way, gist: G, tokens: 80, why: W }
"#;
        let dir = project(&[
            (
                "package.json",
                r#"{"name":"web","dependencies":{"react":"19.0.0"}}"#,
            ),
            ("src/App.tsx", "export const App = () => null;"),
        ]);
        let k = run_with(yaml, dir.path());
        let ticked: Vec<&str> = k
            .suggestions
            .iter()
            .filter(|s| s.chosen)
            .map(|s| s.title.as_str())
            .collect();
        // Three narrow rules for the stack and one practice. What the scan
        // flags, community code to run and broad rules wait for a tick.
        assert_eq!(ticked, ["One", "Two", "Three", "Way"]);
        let code = k.suggestions.iter().find(|s| s.title == "Code").unwrap();
        assert!(code.scripts && !code.chosen);
        let flag = k.suggestions.iter().find(|s| s.title == "Flag").unwrap();
        assert_eq!(flag.caution, ["Contains a compiled program"]);
        assert!(!flag.chosen);
    }

    #[test]
    fn a_flagged_team_requirement_waits_for_a_tick_too() {
        let yaml = r#"version: 1
sources:
  - id: makers
    name: Makers
    url: https://github.com/makers/skills
    summary: Skills.
    publisher: { name: Makers, kind: builder, owner: makers }
    ownership: { method: github-verified-org, checked: "2026-10-03" }
    picks:
      - { skill: skills/way, title: Way, gist: G, tokens: 70, why: W }
"#;
        let dir = project(&[("src/App.tsx", "export const App = () => null;")]);
        let mut k = run_with(yaml, dir.path());
        k.suggestions[0].group = KitGroup::Required;
        tick(&mut k.suggestions, &[]);
        assert!(k.suggestions[0].chosen);
        k.suggestions[0].caution = vec!["Contains a compiled program".to_string()];
        tick(&mut k.suggestions, &[]);
        assert!(!k.suggestions[0].chosen);
    }
}
