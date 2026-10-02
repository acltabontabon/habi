//! Keeping a My skills copy of a library item in step with the library.
//!
//! A skill copied from a library records the library's identity, the item
//! id and the snapshot it was copied at. Comparing three versions of each
//! file — the item at that snapshot (*origin*), the item now (*library*) and
//! the package in My skills (*yours*) — separates what the library changed
//! from what you changed:
//!
//! - changed only in the library → taken;
//! - changed only by you → kept;
//! - changed on both sides, differently → a conflict that needs an explicit
//!   choice per file (keep mine / take the library's).
//!
//! A file you edited is never replaced without that choice. After an update
//! the origin moves to the library's current snapshot, so the next
//! comparison starts from what was just reviewed. Nothing here executes
//! package content.

use super::{MAX_FILES, SkillOrigin, Skills, Tree};
use crate::error::{HabiError, Result};
use crate::fsutil::{atomic_write_mode, sha256, short, tree_digest};
use crate::install::diff::{TextDiff, diff};
use crate::library::model::LibraryItem;
use crate::paths::{RelPath, resolve_for_read, resolve_for_write};
use crate::source::{Sources, portable_identity};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

/// How a library copy relates to its library now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UpstreamState {
    /// The library item is as it was when you copied it.
    Unchanged,
    /// The library item changed since the version you copied.
    Changed,
    /// The item is no longer in the library.
    Removed,
    /// Habi cannot compare: the library is not connected here, or the
    /// version you copied is no longer cached.
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpstreamStatus {
    pub skill_id: String,
    pub state: UpstreamState,
    /// The library's name as recorded when the skill was copied.
    pub source_name: String,
    /// The connected source it was matched to, if any.
    pub source_id: Option<String>,
    pub item_id: String,
    /// Snapshot the copy was made from (or last updated to).
    pub origin_snapshot: String,
    /// The library's current snapshot, when known.
    pub current_snapshot: Option<String>,
    /// One plain sentence for `removed` and `unavailable`.
    pub detail: Option<String>,
}

/// What happens to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UpstreamFileStatus {
    /// Changed only in the library: the library's version is taken.
    Library,
    /// Changed only by you: your version is kept.
    Yours,
    /// Changed on both sides, differently: you choose.
    Conflict,
}

/// A change on one side, relative to the version you copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SideChange {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpstreamFile {
    pub path: String,
    pub status: UpstreamFileStatus,
    pub library_change: Option<SideChange>,
    pub your_change: Option<SideChange>,
    /// From the version you copied to the library's version.
    pub library_diff: Option<TextDiff>,
    /// From the version you copied to yours.
    pub your_diff: Option<TextDiff>,
    /// Set when the executable bit differs (contents may be identical).
    pub note: Option<String>,
}

/// A per-file choice for a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UpstreamChoice {
    KeepMine,
    TakeLibrary,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpstreamPlan {
    pub status: UpstreamStatus,
    /// Files that differ on at least one side (unchanged files are counted).
    pub files: Vec<UpstreamFile>,
    pub unchanged: u32,
    pub take: u32,
    pub keep: u32,
    pub conflicts: u32,
    /// Names exactly what was reviewed; applying refuses if the skill or
    /// the library changed since.
    pub token: String,
    /// Why the update cannot be applied as it stands, if it cannot.
    pub blocked: Option<String>,
}

/// One version of a file: content and executable bit.
type Version<'a> = Option<(&'a [u8], bool)>;

fn same(a: Version, b: Version) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some((x, xe)), Some((y, ye))) => xe == ye && x == y,
        _ => false,
    }
}

fn change(from: Version, to: Version) -> Option<SideChange> {
    match (from, to) {
        (None, None) => None,
        (None, Some(_)) => Some(SideChange::Added),
        (Some(_), None) => Some(SideChange::Removed),
        (Some(a), Some(b)) if same(Some(a), Some(b)) => None,
        _ => Some(SideChange::Modified),
    }
}

fn version<'a>(tree: &'a Tree, path: &str) -> Version<'a> {
    tree.files
        .get(path)
        .map(|b| (b.as_slice(), tree.executables.contains(path)))
}

fn tag(v: Version) -> String {
    match v {
        None => "-".into(),
        Some((b, x)) => format!("{}{}", sha256(b), if x { "+x" } else { "" }),
    }
}

/// The three versions, once the library could be read.
struct Sides {
    base: Tree,
    theirs: Tree,
    theirs_digest: String,
}

struct Resolved {
    status: UpstreamStatus,
    sides: Option<Sides>,
}

fn item_tree(sources: &Sources, item: &LibraryItem) -> Result<Tree> {
    let mut tree = Tree::default();
    for f in &item.files {
        tree.files
            .insert(f.path.clone(), sources.blobs().get(&f.digest)?);
        if f.executable {
            tree.executables.insert(f.path.clone());
        }
    }
    Ok(tree)
}

/// Three-way classification of every file.
fn classify(sides: &Sides, ours: &Tree) -> (Vec<UpstreamFile>, u32) {
    let paths: BTreeSet<&String> = sides
        .base
        .files
        .keys()
        .chain(sides.theirs.files.keys())
        .chain(ours.files.keys())
        .collect();
    let mut files = Vec::new();
    let mut unchanged = 0;
    for path in paths {
        let b = version(&sides.base, path);
        let t = version(&sides.theirs, path);
        let o = version(ours, path);
        let status = if same(t, b) {
            if same(o, b) {
                None
            } else {
                Some(UpstreamFileStatus::Yours)
            }
        } else if same(o, b) {
            Some(UpstreamFileStatus::Library)
        } else if same(o, t) {
            // Both sides made the same change.
            None
        } else {
            Some(UpstreamFileStatus::Conflict)
        };
        let Some(status) = status else {
            unchanged += 1;
            continue;
        };
        let library_change = change(b, t);
        let your_change = change(b, o);
        let note = match (o, t) {
            (Some((_, ox)), Some((_, tx))) if ox != tx => Some(if tx {
                "The library's version is executable; yours is not.".to_string()
            } else {
                "Your version is executable; the library's is not.".to_string()
            }),
            _ => None,
        };
        files.push(UpstreamFile {
            path: path.clone(),
            status,
            library_diff: library_change.map(|_| diff(b.map(|v| v.0), t.map(|v| v.0))),
            your_diff: your_change.map(|_| diff(b.map(|v| v.0), o.map(|v| v.0))),
            library_change,
            your_change,
            note,
        });
    }
    (files, unchanged)
}

impl Skills<'_> {
    /// Finds the library a copy came from and the two library versions.
    fn resolve_upstream(&self, id: &str, sources: &Sources) -> Result<Option<Resolved>> {
        let row = self.row(id)?;
        let SkillOrigin::Library {
            source_name,
            source_identity,
            item_id,
            snapshot,
        } = row.origin
        else {
            return Ok(None);
        };
        let mut status = UpstreamStatus {
            skill_id: id.to_string(),
            state: UpstreamState::Unavailable,
            source_name: source_name.clone(),
            source_id: None,
            item_id: item_id.clone(),
            origin_snapshot: snapshot.clone(),
            current_snapshot: None,
            detail: None,
        };
        let unavailable = |mut status: UpstreamStatus, detail: String| {
            status.state = UpstreamState::Unavailable;
            status.detail = Some(detail);
            Ok(Some(Resolved {
                status,
                sides: None,
            }))
        };
        let candidates: Vec<_> = sources
            .list()?
            .into_iter()
            .filter(|s| portable_identity(s) == source_identity)
            .collect();
        if candidates.is_empty() {
            return unavailable(
                status,
                format!(
                    "{source_name} is not connected on this machine, so Habi cannot check it for updates."
                ),
            );
        }
        // Prefer a connection that still has the copied version cached.
        let source = candidates
            .iter()
            .find(|s| sources.snapshot_files(&s.id, &snapshot).is_ok())
            .or_else(|| candidates.iter().find(|s| s.snapshot.is_some()))
            .unwrap_or(&candidates[0]);
        status.source_id = Some(source.id.clone());
        status.current_snapshot = source.snapshot.clone();
        let Some(current) = source.snapshot.clone() else {
            return unavailable(
                status,
                format!(
                    "{} has not been fetched yet; refresh it to check for updates.",
                    source.name
                ),
            );
        };
        let base_index = match sources.index_at(&source.id, &snapshot) {
            Ok(i) => i,
            Err(HabiError::NotFound(_)) => {
                return unavailable(
                    status,
                    format!(
                        "The version you copied ({}) is no longer in Habi's cache, so your edits cannot be told apart from library changes.",
                        short(&snapshot)
                    ),
                );
            }
            Err(e) => return Err(e),
        };
        let Some(base_item) = base_index.items.iter().find(|i| i.id == item_id) else {
            return unavailable(
                status,
                format!(
                    "The version you copied ({}) does not contain this item, so there is nothing to compare with.",
                    short(&snapshot)
                ),
            );
        };
        let current_index = sources.index_at(&source.id, &current)?;
        let Some(item) = current_index.items.iter().find(|i| i.id == item_id) else {
            status.state = UpstreamState::Removed;
            status.detail = Some(format!(
                "“{}” is no longer in {}. Your copy stays as it is.",
                base_item.title, source.name
            ));
            return Ok(Some(Resolved {
                status,
                sides: None,
            }));
        };
        if !item.complete || !base_item.complete {
            return unavailable(
                status,
                "Some of the library's files were skipped when it was fetched, so an update could lose content.".into(),
            );
        }
        status.state = if item.content_digest == base_item.content_digest {
            UpstreamState::Unchanged
        } else {
            UpstreamState::Changed
        };
        let sides = if status.state == UpstreamState::Changed {
            Some(Sides {
                base: item_tree(sources, base_item)?,
                theirs: item_tree(sources, item)?,
                theirs_digest: item.content_digest.clone(),
            })
        } else {
            None
        };
        Ok(Some(Resolved { status, sides }))
    }

    /// Whether the library a copy came from has changed since. `None` for
    /// skills that were not copied from a library.
    pub fn upstream_status(&self, id: &str, sources: &Sources) -> Result<Option<UpstreamStatus>> {
        Ok(self.resolve_upstream(id, sources)?.map(|r| r.status))
    }

    fn plan_with(
        &self,
        id: &str,
        sources: &Sources,
    ) -> Result<(UpstreamPlan, Option<Sides>, Tree)> {
        let resolved = self.resolve_upstream(id, sources)?.ok_or_else(|| {
            HabiError::invalid("this skill was not copied from a library, so it has no updates")
        })?;
        let ours = self.tree(id)?;
        let (files, unchanged) = match &resolved.sides {
            Some(sides) => classify(sides, &ours),
            None => (Vec::new(), 0),
        };
        let count = |s: UpstreamFileStatus| files.iter().filter(|f| f.status == s).count() as u32;
        let blocked = if !ours.skipped.is_empty() {
            Some(
                "Some files in this skill are symbolic links or too large to read; remove them before updating."
                    .to_string(),
            )
        } else {
            None
        };
        let token = match &resolved.sides {
            Some(sides) => tree_digest(
                files
                    .iter()
                    .map(|f| {
                        (
                            f.path.clone(),
                            format!(
                                "{}|{}|{}",
                                tag(version(&sides.base, &f.path)),
                                tag(version(&sides.theirs, &f.path)),
                                tag(version(&ours, &f.path))
                            ),
                        )
                    })
                    .chain(std::iter::once((
                        "\u{0}snapshot".to_string(),
                        resolved.status.current_snapshot.clone().unwrap_or_default(),
                    )))
                    .collect::<Vec<_>>()
                    .iter()
                    .map(|(p, d)| (p.as_str(), d.as_str())),
            ),
            None => String::new(),
        };
        let plan = UpstreamPlan {
            take: count(UpstreamFileStatus::Library),
            keep: count(UpstreamFileStatus::Yours),
            conflicts: count(UpstreamFileStatus::Conflict),
            status: resolved.status,
            files,
            unchanged,
            token,
            blocked,
        };
        Ok((plan, resolved.sides, ours))
    }

    /// Compares the copy with the library, file by file. Writes nothing.
    pub fn plan_upstream_sync(&self, id: &str, sources: &Sources) -> Result<UpstreamPlan> {
        Ok(self.plan_with(id, sources)?.0)
    }

    /// Takes the library's changes that do not touch your edits, applies
    /// your choice for each conflict, and moves the copy's origin to the
    /// library's current snapshot. `token` must name the reviewed plan.
    pub fn apply_upstream_sync(
        &self,
        id: &str,
        sources: &Sources,
        token: &str,
        decisions: &BTreeMap<String, UpstreamChoice>,
    ) -> Result<super::LocalSkill> {
        let _lock = self.lock(id)?;
        let (row, dir) = self.editable(id)?;
        let (plan, sides, ours) = self.plan_with(id, sources)?;
        let (Some(sides), UpstreamState::Changed) = (sides, plan.status.state) else {
            return Err(HabiError::invalid(match plan.status.state {
                UpstreamState::Unchanged => "the library has no changes to take".to_string(),
                _ => plan
                    .status
                    .detail
                    .unwrap_or_else(|| "this update cannot be applied".into()),
            }));
        };
        if plan.token != token {
            return Err(HabiError::Conflict(
                "The skill or the library changed since you reviewed this update. Review it again."
                    .into(),
            ));
        }
        if let Some(reason) = plan.blocked {
            return Err(HabiError::invalid(reason));
        }
        let mut take: Vec<&str> = Vec::new();
        for f in &plan.files {
            match f.status {
                UpstreamFileStatus::Library => take.push(&f.path),
                UpstreamFileStatus::Yours => {}
                UpstreamFileStatus::Conflict => match decisions.get(&f.path) {
                    Some(UpstreamChoice::TakeLibrary) => take.push(&f.path),
                    Some(UpstreamChoice::KeepMine) => {}
                    None => {
                        return Err(HabiError::invalid(format!(
                            "choose whether to keep your version of {} or take the library's",
                            f.path
                        )));
                    }
                },
            }
        }
        let mut after: BTreeSet<&str> = ours.files.keys().map(String::as_str).collect();
        for path in &take {
            if sides.theirs.files.contains_key(*path) {
                after.insert(path);
            } else {
                after.remove(path);
            }
        }
        if after.len() > MAX_FILES {
            return Err(HabiError::invalid(format!(
                "the updated skill would hold more than {MAX_FILES} files"
            )));
        }
        if !after.contains(super::SKILL_FILE) {
            return Err(HabiError::invalid(
                "the updated skill would have no SKILL.md",
            ));
        }
        for path in &take {
            let rel = RelPath::new(path)?;
            match version(&sides.theirs, path) {
                Some((bytes, executable)) => {
                    atomic_write_mode(&resolve_for_write(&dir, &rel)?, bytes, Some(executable))?;
                }
                None => {
                    if let Some(file) = resolve_for_read(&dir, &rel)?.filter(|p| p.is_file()) {
                        std::fs::remove_file(&file)
                            .map_err(|e| HabiError::io(format!("removing {rel}"), e))?;
                        let mut parent = file.parent();
                        while let Some(p) = parent {
                            if p == dir || std::fs::remove_dir(p).is_err() {
                                break;
                            }
                            parent = p.parent();
                        }
                    }
                }
            }
        }
        let SkillOrigin::Library {
            source_name,
            source_identity,
            item_id,
            ..
        } = row.origin
        else {
            return Err(HabiError::Internal(
                "origin changed during the update".into(),
            ));
        };
        let origin = SkillOrigin::Library {
            source_name,
            source_identity,
            item_id,
            snapshot: plan.status.current_snapshot.clone().unwrap_or_default(),
        };
        self.store.conn()?.execute(
            "UPDATE local_skills SET origin_json = ?2, origin_digest = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                id,
                serde_json::to_string(&origin).map_err(|e| HabiError::Internal(e.to_string()))?,
                sides.theirs_digest,
                crate::time::now()
            ],
        )?;
        self.get(id)
    }
}
