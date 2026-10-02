//! What a copy changed since it was made.
//!
//! An imported copy keeps its files as they were when Habi copied them (its
//! *baseline*, in the blob store; see migration v8), and moves the baseline
//! forward when it takes an update from its library. Comparing the package
//! with that baseline shows the copy's own improvements, whatever it came
//! from — a library, a folder, a project or a Git repository. Copies made
//! before Habi kept baselines fall back to the library snapshot they were
//! copied at, when it is still cached. Nothing here executes package content.

use super::{BaselineFile, SkillOrigin, Skills, Tree};
use crate::error::{HabiError, Result};
use crate::install::diff::{TextDiff, diff};
use crate::skills::upstream::SideChange;
use crate::source::{Sources, portable_identity};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalChange {
    pub path: String,
    pub change: SideChange,
    /// From the original to the copy as it is now.
    pub diff: TextDiff,
    /// Set when only (or also) the executable bit changed.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalChanges {
    pub skill_id: String,
    /// Whether Habi has the original to compare with.
    pub known: bool,
    /// One plain sentence when it does not.
    pub detail: Option<String>,
    pub files: Vec<LocalChange>,
    pub unchanged: u32,
}

impl Skills<'_> {
    /// The files a baseline lists, read back from the blob store.
    pub(crate) fn baseline_tree(&self, baseline: &[BaselineFile]) -> Result<Tree> {
        let blobs = crate::store::cas::Blobs::new(&self.paths.blobs());
        let mut tree = Tree::default();
        for f in baseline {
            tree.files.insert(f.path.clone(), blobs.get(&f.digest)?);
            if f.executable {
                tree.executables.insert(f.path.clone());
            }
        }
        Ok(tree)
    }

    /// The copy's original: its baseline, or else the library version it was
    /// copied from while that is still cached. `Err(sentence)` when neither
    /// is known.
    fn original(&self, id: &str, sources: &Sources) -> Result<std::result::Result<Tree, String>> {
        let row = self.row(id)?;
        if let Some(baseline) = &row.baseline {
            return match self.baseline_tree(baseline) {
                Ok(tree) => Ok(Ok(tree)),
                Err(HabiError::NotFound(_)) => Ok(Err(
                    "The copy's original files are no longer in Habi's store.".into(),
                )),
                Err(e) => Err(e),
            };
        }
        match &row.origin {
            SkillOrigin::Library {
                source_identity,
                item_id,
                snapshot,
                ..
            } => {
                for source in sources
                    .list()?
                    .into_iter()
                    .filter(|s| portable_identity(s) == *source_identity)
                {
                    let Ok(index) = sources.index_at(&source.id, snapshot) else {
                        continue;
                    };
                    if let Some(item) = index.items.iter().find(|i| &i.id == item_id) {
                        let mut tree = Tree::default();
                        for f in &item.files {
                            tree.files
                                .insert(f.path.clone(), sources.blobs().get(&f.digest)?);
                            if f.executable {
                                tree.executables.insert(f.path.clone());
                            }
                        }
                        return Ok(Ok(tree));
                    }
                }
                Ok(Err(
                    "The library version this was copied from is no longer cached, so its local changes cannot be shown."
                        .into(),
                ))
            }
            SkillOrigin::Created
            | SkillOrigin::CreatedForProject { .. }
            | SkillOrigin::Instructions { .. } => Ok(Err(
                "This skill was written here; there is no original to compare with.".into(),
            )),
            _ => Ok(Err(
                "Habi did not keep the original of copies made before this version.".into(),
            )),
        }
    }

    /// What the copy changed since it was made (or last took an update).
    pub fn local_changes(&self, id: &str, sources: &Sources) -> Result<LocalChanges> {
        let ours = self.tree(id)?;
        let original = match self.original(id, sources)? {
            Ok(tree) => tree,
            Err(detail) => {
                return Ok(LocalChanges {
                    skill_id: id.to_string(),
                    known: false,
                    detail: Some(detail),
                    files: Vec::new(),
                    unchanged: 0,
                });
            }
        };
        let paths: BTreeSet<&String> = original.files.keys().chain(ours.files.keys()).collect();
        let mut files = Vec::new();
        let mut unchanged = 0;
        for path in paths {
            let before = original.files.get(path);
            let after = ours.files.get(path);
            let was_x = original.executables.contains(path);
            let is_x = ours.executables.contains(path);
            let change = match (before, after) {
                (None, Some(_)) => SideChange::Added,
                (Some(_), None) => SideChange::Removed,
                (Some(a), Some(b)) if a == b && was_x == is_x => {
                    unchanged += 1;
                    continue;
                }
                _ => SideChange::Modified,
            };
            let note = (before.is_some() && after.is_some() && was_x != is_x).then(|| {
                if is_x {
                    "Now executable.".to_string()
                } else {
                    "No longer executable.".to_string()
                }
            });
            files.push(LocalChange {
                path: path.clone(),
                change,
                diff: diff(before.map(Vec::as_slice), after.map(Vec::as_slice)),
                note,
            });
        }
        Ok(LocalChanges {
            skill_id: id.to_string(),
            known: true,
            detail: None,
            files,
            unchanged,
        })
    }
}
