//! Leftovers of the sample workspace, which earlier versions could create.
//!
//! It lived under `<data>/sample`: two example libraries (flagged `sample`
//! in the store) and seven example projects. Habi no longer offers it, so on
//! startup whatever is left of it is removed. Nothing here touches the
//! user's own libraries, projects or skills.

use crate::error::{HabiError, Result};
use crate::service::Habi;
use std::path::PathBuf;

/// Where the sample workspace lived (canonical when it exists, so it
/// compares equal to registered project paths).
fn root(habi: &Habi) -> PathBuf {
    let root = habi.paths.root.join("sample");
    crate::paths::canonical(&root).unwrap_or(root)
}

/// Removes the sample libraries, forgets the sample projects (with their
/// operation history) and deletes `<data>/sample`. A no-op once done.
pub(crate) fn remove_leftovers(habi: &Habi) -> Result<()> {
    let root = root(habi);
    for id in habi.sources().sample_ids(&root)? {
        habi.sources().remove(&id)?;
    }
    let projects: Vec<(String, String)> = {
        let conn = habi.store.conn()?;
        let mut stmt = conn.prepare("SELECT id, path FROM projects")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (id, path) in projects {
        if PathBuf::from(path).starts_with(&root) {
            habi.forget_project(&id)?;
            let journal = crate::install::apply::journal_dir(&habi.paths, &id);
            if journal.exists() {
                std::fs::remove_dir_all(&journal)
                    .map_err(|e| HabiError::io("removing the sample projects' history", e))?;
            }
        }
    }
    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|e| HabiError::io("removing the sample workspace", e))?;
    }
    Ok(())
}
