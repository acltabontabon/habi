//! Watches the open project for relevant changes (debounced) and tells the
//! UI, which re-inspects. One project is watched at a time; the watcher is
//! dropped when the project closes or the window goes away.

use crate::state::AppState;
use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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

const IGNORED: &[&str] = &[
    "/.git/",
    "/node_modules/",
    "/target/",
    "/build/",
    "/dist/",
    "/.gradle/",
    "/.idea/",
    "/.next/",
    "/coverage/",
];

fn relevant(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let text = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
    if IGNORED.iter().any(|i| text.contains(i))
        || text.ends_with(".habi-tmp")
        || text.contains("/.habi-tmp-")
    {
        return None;
    }
    Some(text.trim_start_matches('/').to_string())
}

pub fn start(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    root: &Path,
) -> notify_debouncer_mini::notify::Result<()> {
    let mut guard = state.watcher.lock().expect("watcher");
    if guard.as_ref().is_some_and(|w| w.project_id == project_id) {
        return Ok(());
    }
    *guard = None;
    let app = app.clone();
    let id = project_id.to_string();
    let root_owned = root.to_path_buf();
    let mut debouncer = new_debouncer(
        Duration::from_millis(900),
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut paths: Vec<String> = events
                .iter()
                .filter_map(|e| relevant(&root_owned, &e.path))
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

pub fn stop(state: &AppState) {
    if let Ok(mut guard) = state.watcher.lock() {
        *guard = None;
    }
}
