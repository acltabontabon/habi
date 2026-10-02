//! Watches the open project for relevant changes (debounced) and tells the
//! UI, which re-inspects. One project is watched at a time; the watcher is
//! dropped when the project closes or the window goes away.

use crate::state::AppState;
use habi_core::inspect::walk::skipped_dir;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::PoisonError;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub struct ProjectWatcher {
    pub project_id: String,
    _debouncer: Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectChanged {
    project_id: String,
    paths: Vec<String>,
}

/// The project's own ignore files, as the inspection reads them. Nested
/// ignore files are not consulted; they only make the filter less strict.
fn ignore_rules(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    for name in [".gitignore", ".habiignore"] {
        let file = root.join(name);
        if file.is_file() {
            let _ = builder.add(file);
        }
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// The project-relative path of a change the inspection would see, or
/// `None` for changes in skipped or ignored folders and Habi's temp files.
fn relevant(root: &Path, rules: &Gitignore, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parent = root.to_path_buf();
    let mut dirs = rel.components().peekable();
    while let Some(part) = dirs.next() {
        let name = part.as_os_str().to_string_lossy();
        // Every component but the last is a directory; the last may be one too.
        let is_dir = dirs.peek().is_some() || path.is_dir();
        if is_dir && skipped_dir(&name, &parent, root) {
            return None;
        }
        parent.push(part);
    }
    if rules
        .matched_path_or_any_parents(rel, path.is_dir())
        .is_ignore()
    {
        return None;
    }
    let text = rel.to_string_lossy().replace('\\', "/");
    if text.is_empty() || text.ends_with(".habi-tmp") || text.contains(".habi-tmp-") {
        return None;
    }
    Some(text)
}

/// Starts watching `root`, replacing any other project's watcher. Setting up
/// a recursive watch can take a while on large trees: call it off the async
/// runtime.
pub fn start(
    app: &AppHandle,
    project_id: &str,
    root: &Path,
) -> notify_debouncer_mini::notify::Result<()> {
    let state = app.state::<AppState>();
    let mut guard = state.watcher.lock().unwrap_or_else(PoisonError::into_inner);
    if guard.as_ref().is_some_and(|w| w.project_id == project_id) {
        return Ok(());
    }
    *guard = None;
    let app = app.clone();
    let id = project_id.to_string();
    let root_owned: PathBuf = root.to_path_buf();
    let rules = ignore_rules(root);
    let mut debouncer = new_debouncer(
        Duration::from_millis(900),
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut paths: Vec<String> = events
                .iter()
                .filter_map(|e| relevant(&root_owned, &rules, &e.path))
                .collect();
            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                paths.truncate(20);
                let _ = app.emit(
                    "project-changed",
                    ProjectChanged {
                        project_id: id.clone(),
                        paths,
                    },
                );
            }
        },
    )?;
    debouncer.watcher().watch(root, RecursiveMode::Recursive)?;
    *guard = Some(ProjectWatcher {
        project_id: project_id.to_string(),
        _debouncer: debouncer,
    });
    Ok(())
}

/// Stops watching. With a project id, only that project's watcher stops, so
/// a late "stop" from a screen that closed cannot end the next one's watch.
pub fn stop(state: &AppState, project_id: Option<&str>) {
    let mut guard = state.watcher.lock().unwrap_or_else(PoisonError::into_inner);
    if project_id.is_none_or(|id| guard.as_ref().is_some_and(|w| w.project_id == id)) {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_dependency_build_and_ignored_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "generated/\n*.log\n").unwrap();
        std::fs::write(root.join("pom.xml"), "<project/>").unwrap();
        std::fs::create_dir_all(root.join("src/com/acme/build")).unwrap();
        let rules = ignore_rules(root);
        let check = |rel: &str| relevant(root, &rules, &root.join(rel));

        assert_eq!(check("pom.xml").as_deref(), Some("pom.xml"));
        assert_eq!(
            check("src/com/acme/build/Main.java").as_deref(),
            Some("src/com/acme/build/Main.java"),
            "a package named build is source, not output"
        );
        assert_eq!(check(".git/index"), None);
        assert_eq!(check("web/node_modules/x/package.json"), None);
        assert_eq!(check("target/classes/A.class"), None);
        assert_eq!(check("generated/api.ts"), None);
        assert_eq!(check("debug.log"), None);
        assert_eq!(check("pom.xml.habi-tmp"), None);
    }
}
