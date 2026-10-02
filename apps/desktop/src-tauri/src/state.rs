//! Shared desktop state: the core service, running jobs, and local folders
//! the user picked through a native dialog during this session.

use habi_core::cancel::CancelToken;
use habi_core::error::ErrorInfo;
use habi_core::service::Habi;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

pub struct AppState {
    pub habi: Option<Arc<Habi>>,
    /// Why the core could not start (shown by the UI instead of crashing).
    pub startup_error: Option<ErrorInfo>,
    jobs: Mutex<HashMap<String, CancelToken>>,
    /// Local library folders chosen with the native picker. `add_source`
    /// accepts local paths only from this set, so a compromised webview
    /// cannot make Habi ingest arbitrary folders.
    pub picked_folders: Mutex<HashSet<PathBuf>>,
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
            watcher: Mutex::new(None),
            _log_guard: guard,
        }
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
