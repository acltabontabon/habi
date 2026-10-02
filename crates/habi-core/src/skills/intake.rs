//! Finding knowledge that already exists, and bringing copies of it into
//! "My skills".
//!
//! Discovery and inspection only read. Importing copies the selected
//! packages byte for byte (references, scripts, assets, unknown metadata and
//! licence fields included) and never modifies or removes the original.
//! Nothing found here is executed.

use super::{
    Skills, Tree, TreeLimits, describe_tree, keep_baseline, read_tree, rename_in_skill_md,
};
use crate::clients::{ClientId, layout};
use crate::error::{HabiError, Result};
use crate::fsutil::{Bounded, read_bounded};
use crate::inspect::model::{FactSubject, ProjectInspection};
use crate::install::lock::LockFile;
use crate::library::model::{Diagnostic, DiagnosticLevel};
use crate::library::{self, SIDECAR_FILES, SKILL_FILE};
use crate::paths::{RelPath, resolve_for_read};
use crate::skills::{LocalSkillSummary, SkillOrigin};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use ts_rs::TS;

const MAX_INSTRUCTIONS_BYTES: u64 = 512 * 1024;
const MAX_DISCOVERED: usize = 200;

/// A skill folder found in a project. It stays where it is.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiscoveredSkill {
    /// Project-relative folder containing SKILL.md.
    pub path: String,
    pub name: String,
    pub description: String,
    /// Clients that look in this location; empty when none does.
    pub readers: Vec<ClientId>,
    /// Name of the library Habi installed it from, if it manages this copy.
    pub managed_by: Option<String>,
    /// Habi applicability metadata sits next to it.
    pub has_metadata: bool,
    pub file_count: u32,
    pub problems: Vec<Diagnostic>,
    pub digest: String,
    /// Id of the local skill with the same content, if already imported.
    pub imported_as: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstructionSection {
    pub title: String,
    pub level: u8,
    /// 1-based, inclusive.
    pub start_line: u32,
    pub end_line: u32,
}

/// A file of standing instructions (AGENTS.md, CLAUDE.md, rules).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstructionFile {
    pub path: String,
    /// Which convention the file follows, in plain words.
    pub convention: String,
    pub lines: u32,
    pub sections: Vec<InstructionSection>,
    /// Problem reading the file, if any.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectKnowledge {
    pub skills: Vec<DiscoveredSkill>,
    pub instructions: Vec<InstructionFile>,
    /// Why the picture may be incomplete (truncated scan, unreadable folders).
    pub limits: Vec<String>,
    pub inspected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstructionDocument {
    pub path: String,
    pub convention: String,
    pub lines: Vec<String>,
    pub sections: Vec<InstructionSection>,
}

fn convention(role: &str) -> &'static str {
    match role {
        "agent-instructions:agents-md" => "AGENTS.md — read by Codex, Cursor and others",
        "agent-instructions:claude-md" => "CLAUDE.md — read by Claude Code",
        "agent-instructions:claude-rules" => "Claude Code rule",
        "agent-instructions:cursor-rules" => "Cursor rule",
        "agent-instructions:copilot" => "GitHub Copilot instructions",
        _ => "Agent instructions",
    }
}

/// Headings of a Markdown document, each spanning up to the next heading of
/// the same or a higher level. Fenced code is skipped.
#[allow(
    clippy::indexing_slicing,
    clippy::string_slice,
    reason = "heading positions and `#` counts come from the same lines"
)]
pub fn sections(lines: &[&str]) -> Vec<InstructionSection> {
    let mut headings: Vec<(usize, u8, String)> = Vec::new();
    let mut fence: Option<&str> = None;
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            let title = trimmed[hashes..].trim().trim_end_matches('#').trim();
            if !title.is_empty() {
                headings.push((i, hashes as u8, title.chars().take(160).collect()));
            }
        }
    }
    headings
        .iter()
        .enumerate()
        .map(|(n, (start, level, title))| {
            let end = headings[n + 1..]
                .iter()
                .find(|(_, l, _)| l <= level)
                .map(|(i, _, _)| *i)
                .unwrap_or(lines.len());
            // Trailing blank lines belong to nobody.
            let mut last = end;
            while last > start + 1 && lines[last - 1].trim().is_empty() {
                last -= 1;
            }
            InstructionSection {
                title: title.clone(),
                level: *level,
                start_line: *start as u32 + 1,
                end_line: last as u32,
            }
        })
        .collect()
}

fn instruction_roles(inspection: &ProjectInspection) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = inspection
        .facts
        .iter()
        .filter_map(|f| match &f.subject {
            FactSubject::File { path, role } if role.starts_with("agent-instructions:") => {
                Some((path.clone(), role.clone()))
            }
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup_by(|a, b| a.0 == b.0);
    out
}

fn read_text(root: &Path, rel: &str) -> std::result::Result<String, String> {
    let rel_path = RelPath::new(rel).map_err(|e| e.to_string())?;
    if crate::inspect::walk::is_secret_name(rel_path.file_name()) {
        return Err("not read: the file name suggests it holds secrets".into());
    }
    let path = resolve_for_read(root, &rel_path)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "the file no longer exists".to_string())?;
    match read_bounded(&path, MAX_INSTRUCTIONS_BYTES).map_err(|e| e.to_string())? {
        Bounded::Content(bytes) => {
            String::from_utf8(bytes).map_err(|_| "the file is not UTF-8 text".to_string())
        }
        Bounded::TooLarge(n) => Err(format!("the file is {n} bytes; too large to show")),
    }
}

/// What already exists in a project: skill folders and instruction files.
/// Read-only; nothing is adopted, installed or imported.
pub fn discover(
    root: &Path,
    inspection: &ProjectInspection,
    lock: &LockFile,
    local: &[LocalSkillSummary],
    origin_digests: &[(String, Option<String>)],
) -> ProjectKnowledge {
    let mut limits: Vec<String> = Vec::new();
    if inspection.scan.truncated {
        limits.push(format!(
            "The scan stopped early ({}), so skills or instructions deeper in the project may be missing here.",
            inspection.scan.limits_hit.join(" ")
        ));
    }
    if !inspection.scan.unreadable.is_empty() {
        limits.push(format!(
            "{} could not be read.",
            inspection
                .scan
                .unreadable
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let mut dirs: Vec<String> = inspection
        .files
        .iter()
        .filter_map(|p| {
            p.strip_suffix(&format!("/{SKILL_FILE}"))
                .map(str::to_string)
        })
        .collect();
    dirs.sort();
    let mut accepted: Vec<String> = Vec::new();
    for dir in dirs {
        if !accepted.iter().any(|o| dir.starts_with(&format!("{o}/"))) {
            accepted.push(dir);
        }
    }
    if accepted.len() > MAX_DISCOVERED {
        limits.push(format!(
            "Showing the first {MAX_DISCOVERED} of {} skill folders.",
            accepted.len()
        ));
        accepted.truncate(MAX_DISCOVERED);
    }

    let mut skills = Vec::new();
    for dir in accepted {
        let tree = RelPath::new(&dir)
            .and_then(|rel| resolve_for_read(root, &rel))
            .and_then(|p| match p {
                Some(p) if p.is_dir() => read_tree(&p, &TreeLimits::PACKAGE),
                _ => Err(HabiError::NotFound(dir.clone())),
            });
        let tree = match tree {
            Ok(t) => t,
            Err(e) => {
                skills.push(DiscoveredSkill {
                    name: dir.rsplit('/').next().unwrap_or(&dir).to_string(),
                    description: String::new(),
                    readers: layout::readers_of(&format!("{dir}/")),
                    managed_by: None,
                    has_metadata: false,
                    file_count: 0,
                    problems: vec![Diagnostic::error(e.to_string(), None)],
                    digest: String::new(),
                    imported_as: None,
                    path: dir,
                });
                continue;
            }
        };
        let described = describe_tree(&tree);
        let digest = described
            .item
            .as_ref()
            .map(|i| i.content_digest.clone())
            .unwrap_or_default();
        let skill_md = format!("{dir}/{SKILL_FILE}");
        let dir_name = dir.rsplit('/').next().unwrap_or(&dir);
        let mut problems = described.diagnostics;
        if !described.name.is_empty() && described.name != dir_name {
            problems.push(Diagnostic::warning(
                format!(
                    "`name` ({}) differs from the folder name ({dir_name}); some clients require them to match",
                    described.name
                ),
                Some(SKILL_FILE),
            ));
        }
        skills.push(DiscoveredSkill {
            name: if described.name.is_empty() {
                dir_name.to_string()
            } else {
                described.name
            },
            description: described.description,
            readers: layout::readers_of(&format!("{dir}/")),
            managed_by: lock.owner_of(&skill_md).map(|i| i.source.name.clone()),
            has_metadata: SIDECAR_FILES.iter().any(|s| tree.files.contains_key(*s)),
            file_count: tree.files.len() as u32,
            problems,
            imported_as: already_imported(&digest, local, origin_digests),
            digest,
            path: dir,
        });
    }

    let instructions = instruction_roles(inspection)
        .into_iter()
        .map(|(path, role)| match read_text(root, &path) {
            Ok(text) => {
                let lines: Vec<&str> = text.lines().collect();
                InstructionFile {
                    convention: convention(&role).to_string(),
                    lines: lines.len() as u32,
                    sections: sections(&lines),
                    problem: None,
                    path,
                }
            }
            Err(problem) => InstructionFile {
                convention: convention(&role).to_string(),
                lines: 0,
                sections: Vec::new(),
                problem: Some(problem),
                path,
            },
        })
        .collect();

    ProjectKnowledge {
        skills,
        instructions,
        limits,
        inspected_at: inspection.inspected_at.clone(),
    }
}

fn already_imported(
    digest: &str,
    local: &[LocalSkillSummary],
    origin_digests: &[(String, Option<String>)],
) -> Option<String> {
    if digest.is_empty() {
        return None;
    }
    local
        .iter()
        .filter(|s| s.deleted_at.is_none())
        .find(|s| s.content_digest == digest)
        .map(|s| s.id.clone())
        .or_else(|| {
            origin_digests
                .iter()
                .find(|(_, d)| d.as_deref() == Some(digest))
                .map(|(id, _)| id.clone())
        })
}

/// Reads one of the project's recognized instruction files for selection.
pub fn read_instructions(
    root: &Path,
    inspection: &ProjectInspection,
    rel: &str,
) -> Result<InstructionDocument> {
    let role = instruction_roles(inspection)
        .into_iter()
        .find(|(p, _)| p == rel)
        .map(|(_, r)| r)
        .ok_or_else(|| {
            HabiError::NotFound(format!("{rel} among this project's instruction files"))
        })?;
    let text = read_text(root, rel).map_err(HabiError::invalid)?;
    let lines: Vec<&str> = text.lines().collect();
    Ok(InstructionDocument {
        path: rel.to_string(),
        convention: convention(&role).to_string(),
        sections: sections(&lines),
        lines: lines.iter().map(|l| l.to_string()).collect(),
    })
}

/// The selected lines of an instruction file (1-based, inclusive), with a
/// leading heading demoted out of the way: the draft has its own title.
pub fn select_lines(document: &InstructionDocument, start: u32, end: u32) -> Result<String> {
    let total = document.lines.len() as u32;
    if start == 0 || end < start || end > total {
        return Err(HabiError::invalid("select lines inside the file"));
    }
    let chosen = document
        .lines
        .get((start - 1) as usize..end as usize)
        .unwrap_or_default();
    let text = chosen.join("\n");
    if text.trim().is_empty() {
        return Err(HabiError::invalid("the selection is empty"));
    }
    Ok(format!("{}\n", text.trim_end()))
}

// ----- importing ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DuplicateKind {
    /// The same content is already in My skills.
    SameContent,
    /// A different skill in My skills uses this identifier.
    SameName,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Duplicate {
    pub kind: DuplicateKind,
    pub skill_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportCandidate {
    /// Where the package is inside the inspected source ("" for its root).
    pub path: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub license: Option<String>,
    pub has_metadata: bool,
    /// Package-relative file paths.
    pub files: Vec<String>,
    pub size: u32,
    pub problems: Vec<Diagnostic>,
    /// False when files would be lost (links, oversized files).
    pub complete: bool,
    pub digest: String,
    pub duplicate: Option<Duplicate>,
    /// A free identifier to use when the name is taken.
    pub suggested_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportInspection {
    /// Where the candidates were found, for display.
    pub origin: String,
    pub candidates: Vec<ImportCandidate>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportSelection {
    pub path: String,
    /// Import under this identifier instead of the package's own.
    pub rename: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportOutcome {
    pub imported: Vec<LocalSkillSummary>,
    pub skipped: Vec<ImportSkip>,
}

/// One package found in a source, ready to describe or copy.
pub(crate) struct Package {
    pub path: String,
    pub tree: Tree,
    pub origin: SkillOrigin,
    /// Display title known from the source (a library's metadata), if any.
    pub title: Option<String>,
}

/// Splits a folder into the skill packages it contains. A folder that is
/// itself a skill yields one package with an empty path.
pub(crate) fn packages_in(tree: &Tree, origin: impl Fn(&str) -> SkillOrigin) -> Vec<Package> {
    let index = super::index_tree(tree, "", "import");
    index
        .items
        .iter()
        .filter(|i| i.kind != crate::library::model::ItemKind::Instructions)
        .map(|i| Package {
            path: i.path.clone(),
            tree: if i.path.is_empty() {
                // A root-level skill owns only what the index assigned to it.
                Tree {
                    files: i
                        .files
                        .iter()
                        .filter_map(|f| {
                            tree.files.get(&f.path).map(|b| (f.path.clone(), b.clone()))
                        })
                        .collect(),
                    executables: i
                        .files
                        .iter()
                        .filter(|f| f.executable)
                        .map(|f| f.path.clone())
                        .collect(),
                    skipped: tree.skipped.clone(),
                }
            } else {
                tree.subtree(&i.path)
            },
            origin: origin(&i.path),
            title: None,
        })
        .collect()
}

impl Skills<'_> {
    fn candidate(
        &self,
        package: &Package,
        local: &[LocalSkillSummary],
        origin_digests: &[(String, Option<String>)],
    ) -> Result<ImportCandidate> {
        let described = describe_tree(&package.tree);
        let item = described.item.as_ref();
        let digest = item.map(|i| i.content_digest.clone()).unwrap_or_default();
        let active = || local.iter().filter(|s| s.deleted_at.is_none());
        let duplicate = already_imported(&digest, local, origin_digests)
            .and_then(|id| active().find(|s| s.id == id))
            .map(|s| Duplicate {
                kind: DuplicateKind::SameContent,
                skill_id: s.id.clone(),
                title: s.title.clone(),
            })
            .or_else(|| {
                active()
                    .find(|s| !described.name.is_empty() && s.name == described.name)
                    .map(|s| Duplicate {
                        kind: DuplicateKind::SameName,
                        skill_id: s.id.clone(),
                        title: s.title.clone(),
                    })
            });
        let name_taken = active().any(|s| !s.name.is_empty() && s.name == described.name);
        let suggested_name = if name_taken {
            Some(self.free_name(&described.name)?)
        } else {
            None
        };
        Ok(ImportCandidate {
            path: package.path.clone(),
            title: package
                .title
                .clone()
                .or_else(|| item.map(|i| i.title.clone()))
                .unwrap_or_else(|| library::humanize(&described.name)),
            name: described.name,
            description: described.description,
            license: item.and_then(|i| i.license.clone()),
            has_metadata: SIDECAR_FILES
                .iter()
                .any(|s| package.tree.files.contains_key(*s)),
            files: package.tree.files.keys().cloned().collect(),
            size: package.tree.files.values().map(|b| b.len() as u32).sum(),
            complete: package.tree.skipped.is_empty(),
            problems: described.diagnostics,
            digest,
            duplicate,
            suggested_name,
        })
    }

    /// Describes packages before anything is written.
    pub(crate) fn inspect_packages(&self, packages: &[Package]) -> Result<Vec<ImportCandidate>> {
        let local = self.list()?;
        let digests = self.origin_digests()?;
        let mut out = packages
            .iter()
            .map(|p| self.candidate(p, &local, &digests))
            .collect::<Result<Vec<_>>>()?;
        out.sort_by_key(|a| a.title.to_lowercase());
        Ok(out)
    }

    /// Copies the selected packages into My skills. Each becomes an
    /// independent, editable copy; the originals are not touched. A package
    /// whose identifier is taken is imported only under a new one.
    pub(crate) fn import_packages(
        &self,
        packages: Vec<Package>,
        selections: &[ImportSelection],
    ) -> Result<ImportOutcome> {
        let by_path: HashMap<&str, &Package> =
            packages.iter().map(|p| (p.path.as_str(), p)).collect();
        let mut outcome = ImportOutcome {
            imported: Vec::new(),
            skipped: Vec::new(),
        };
        for selection in selections {
            let mut skip = |reason: String| {
                outcome.skipped.push(ImportSkip {
                    path: selection.path.clone(),
                    reason,
                })
            };
            let Some(package) = by_path.get(selection.path.as_str()) else {
                skip("it is no longer at the source".into());
                continue;
            };
            if !package.tree.skipped.is_empty() {
                skip("some of its files cannot be copied (links or oversized files), so importing would lose content".into());
                continue;
            }
            if !package.tree.files.contains_key(SKILL_FILE) {
                skip("it has no SKILL.md".into());
                continue;
            }
            let described = describe_tree(&package.tree);
            let digest = described
                .item
                .as_ref()
                .map(|i| i.content_digest.clone())
                .unwrap_or_default();
            let wanted = selection
                .rename
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(&described.name)
                .to_string();
            let taken: Vec<String> = self.names()?.into_values().collect();
            if !wanted.is_empty() && taken.contains(&wanted) {
                skip(format!(
                    "the identifier `{wanted}` is already used in My skills; choose another to keep both"
                ));
                continue;
            }
            let mut tree = package.tree.clone();
            if wanted != described.name {
                if let Err(e) = library::check_skill_name(&wanted) {
                    skip(format!("the identifier `{wanted}` {e}"));
                    continue;
                }
                let text = tree
                    .files
                    .get(SKILL_FILE)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                match rename_in_skill_md(&text, &wanted) {
                    Ok(renamed) => {
                        tree.files.insert(SKILL_FILE.into(), renamed.into_bytes());
                    }
                    Err(e) => {
                        skip(format!("it could not be renamed: {e}"));
                        continue;
                    }
                }
            }
            let title = package
                .title
                .clone()
                .or_else(|| described.item.as_ref().map(|i| i.title.clone()))
                .filter(|_| wanted == described.name)
                .unwrap_or_else(|| library::humanize(&wanted));
            // The copy as written (renamed, if it was) is what local changes
            // are measured against.
            let baseline = keep_baseline(self.paths, &tree)?;
            let id = self.insert(
                &title,
                &package.origin,
                (!digest.is_empty()).then_some(digest.as_str()),
                &tree,
                Some(&baseline),
            )?;
            outcome.imported.push(self.get(&id)?.summary);
        }
        Ok(outcome)
    }
}

/// True if any diagnostic is an error.
pub fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|d| d.level == DiagnosticLevel::Error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_span_to_the_next_peer_and_skip_code() {
        let text = "# Project\n\nIntro.\n\n## Releases\n\n1. Tag\n2. Push\n\n```sh\n# not a heading\n```\n\n### Hotfixes\n\nCherry-pick.\n\n## Style\n\nTabs.\n";
        let lines: Vec<&str> = text.lines().collect();
        let s = sections(&lines);
        let titles: Vec<&str> = s.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, ["Project", "Releases", "Hotfixes", "Style"]);
        assert_eq!((s[0].start_line, s[0].end_line), (1, 20));
        // "Releases" includes its nested "Hotfixes" and stops before "Style".
        assert_eq!((s[1].start_line, s[1].end_line), (5, 16));
        assert_eq!((s[2].start_line, s[2].end_line), (14, 16));
        assert_eq!((s[3].start_line, s[3].end_line), (18, 20));
    }
}
