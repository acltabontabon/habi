//! Shared desktop state: the core service, running jobs, and local folders
//! the user picked through a native dialog during this session.

use habi_core::cancel::CancelToken;
use habi_core::error::ErrorInfo;
use habi_core::service::Habi;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long a dropped file stays importable.
const DROP_WINDOW: Duration = Duration::from_secs(120);

pub struct AppState {
    pub habi: Option<Arc<Habi>>,
    /// Why the core could not start (shown by the UI instead of crashing).
    pub startup_error: Option<ErrorInfo>,
    jobs: Mutex<HashMap<String, CancelToken>>,
    /// Local library folders chosen with the native picker. `add_source`
    /// accepts local paths only from this set, so a compromised webview
    /// cannot make Habi ingest arbitrary folders.
    pub picked_folders: Mutex<HashSet<PathBuf>>,
    /// Folders Habi's own project chooser listed. Only these can be browsed
    /// into or opened from it; the chooser stays inside the home folder.
    pub browsed_folders: Mutex<HashSet<PathBuf>>,
    /// Files dropped onto the window, with when. Importing a dropped file
    /// accepts only paths the person dropped in the last few minutes, for
    /// the same reason as `picked_folders`.
    dropped: Mutex<HashMap<PathBuf, Instant>>,
    pub watcher: Mutex<Option<crate::watch::ProjectWatcher>>,
    _log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

impl AppState {
    pub fn new(
        habi: Option<Habi>,
        startup_error: Option<ErrorInfo>,
        guard: Option<tracing_appender::non_blocking::WorkerGuard>,
    ) -> Self {
        AppState {
            habi: habi.map(Arc::new),
            startup_error,
            jobs: Mutex::new(HashMap::new()),
            picked_folders: Mutex::new(HashSet::new()),
            browsed_folders: Mutex::new(HashSet::new()),
            dropped: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            _log_guard: guard,
        }
    }

    /// Remembers files the person dropped onto the window.
    pub fn remember_dropped(&self, paths: &[PathBuf]) {
        let mut dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        dropped.retain(|_, at| now.duration_since(*at) < DROP_WINDOW);
        for p in paths {
            dropped.insert(p.clone(), now);
        }
    }

    /// Takes the given paths if every one was dropped recently; each can be
    /// taken once. `None` when any of them was not dropped (or too long ago).
    pub fn take_dropped(&self, paths: &[PathBuf]) -> Option<Vec<PathBuf>> {
        let mut dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        dropped.retain(|_, at| now.duration_since(*at) < DROP_WINDOW);
        if paths.is_empty() || !paths.iter().all(|p| dropped.contains_key(p)) {
            return None;
        }
        for p in paths {
            dropped.remove(p);
        }
        Some(paths.to_vec())
    }

    pub fn habi(&self) -> Result<Arc<Habi>, ErrorInfo> {
        self.habi.clone().ok_or_else(|| {
            self.startup_error.clone().unwrap_or(ErrorInfo {
                code: "internal".into(),
                message: "Habi's local data could not be opened.".into(),
            })
        })
    }

    /// Registers a cancellable job. The returned guard unregisters it.
    pub fn job(&self, id: Option<String>) -> (CancelToken, JobGuard<'_>) {
        let token = CancelToken::new();
        let id = id.filter(|i| !i.is_empty() && i.len() <= 64);
        if let Some(id) = &id {
            self.jobs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id.clone(), token.clone());
        }
        (token, JobGuard { state: self, id })
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self
            .jobs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
        {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) {
        for token in self
            .jobs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            token.cancel();
        }
    }
}

pub struct JobGuard<'a> {
    state: &'a AppState,
    id: Option<String>,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.state
                .jobs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(id);
        }
    }
}
