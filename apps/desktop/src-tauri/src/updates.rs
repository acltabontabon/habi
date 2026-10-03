//! Habi's own updates: asking GitHub whether a newer release exists, and installing it.
//!
//! The release workflow signs each installer with Habi's updater key and publishes a
//! `latest.json` beside them; the endpoint in `tauri.conf.json` is that file. The updater
//! plugin checks the download against the public key compiled into the app, so a release
//! only installs if it was signed by the key held by the maintainer.
//!
//! This runs here, in Rust, like every other link or file operation: the webview is not
//! given the updater permission, and can only ask for the update this module found.
//! Nothing is downloaded until `install_update`, and a check sends no identifier: GitHub
//! sees an anonymous request for a small JSON file (see docs/project/security-model.md).

use crate::state::AppState;
use habi_core::error::ErrorInfo;
use serde::{Deserialize, Serialize};
use std::sync::PoisonError;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

type CmdResult<T> = Result<T, ErrorInfo>;

/// How long a check may take before the person is told it could not finish.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the whole installer download may take. The updater copies the check's
/// timeout into the update it returns and applies it to the entire response body, so
/// left alone a download on a slow link would be cut off after `CHECK_TIMEOUT` every
/// time. This is generous enough for a slow connection (an installer of tens of
/// megabytes at a few dozen kilobytes a second) while a stalled one still ends in an
/// error the person can retry, rather than a progress bar that never moves again.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The least time between two `update-progress` events. The download arrives in small
/// chunks, and the UI re-renders on every event; a few updates a second read as smooth.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// A newer release, as the UI shows it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// When it was published (RFC 3339), if the release says.
    pub date: Option<String>,
    /// What changed, as Markdown: the release's section of the changelog.
    pub notes: Option<String>,
}

/// How much of the update has arrived, sent as the `update-progress` event.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateProgress {
    pub downloaded: u64,
    /// `None` when the server did not say how large the download is.
    pub total: Option<u64>,
}

/// The update found by the last check, and whether it is being installed.
#[derive(Default)]
pub struct UpdateSlot {
    found: Option<Update>,
    installing: bool,
}

fn failure(code: &str, message: String) -> ErrorInfo {
    ErrorInfo {
        code: code.into(),
        message,
    }
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.and_then(|d| d.format(&Rfc3339).ok()),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
    }
}

/// Asks GitHub whether a newer release exists. `None` means this is the newest.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<UpdateInfo>> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(before_exit(app.clone()))
        .build()
        .map_err(|e| {
            failure(
                "update_check",
                format!("Updates are not set up in this build: {e}"),
            )
        })?;
    let found = updater.check().await.map_err(|e| {
        tracing::info!(error = %e, "update check failed");
        failure(
            "update_check",
            "Habi could not check for updates. Check your connection and try again.".into(),
        )
    })?;
    let result = found.as_ref().map(info);
    if let Some(update) = &found {
        tracing::info!(version = %update.version, "an update is available");
    }
    let mut slot = state.update.lock().unwrap_or_else(PoisonError::into_inner);
    // A check during an install must not drop the update being installed.
    if !slot.installing {
        slot.found = found;
    }
    Ok(result)
}

/// What the updater runs on Windows just before it starts the installer and ends Habi with
/// `std::process::exit`. That skips the window's `Destroyed` handler, so this does its work
/// (see `lib.rs`): running jobs are told to stop and the project watcher is let go. The
/// updater never calls it elsewhere.
fn before_exit<R: Runtime>(app: AppHandle<R>) -> impl Fn() + Send + Sync + 'static {
    move || {
        if let Some(state) = app.try_state::<AppState>() {
            state.cancel_all();
            crate::watch::stop(&state, None);
        }
    }
}

/// Downloads and installs the update the last check found, reporting progress as
/// `update-progress` events. On Windows this never returns: the updater starts the
/// installer and ends Habi (after `before_exit`), so the UI writes pending edits before
/// asking. Elsewhere the new version starts at the next launch, or at once with
/// `restart_app`.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let mut update = {
        let mut slot = state.update.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.installing {
            return Err(failure(
                "update_install",
                "An update is already being installed.".into(),
            ));
        }
        let Some(update) = slot.found.clone() else {
            return Err(failure(
                "update_install",
                "There is no update to install. Check for updates first.".into(),
            ));
        };
        slot.installing = true;
        update
    };
    // The check's short timeout must not bound the download (see `DOWNLOAD_TIMEOUT`).
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut progress = ProgressThrottle::default();
    let progress_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                if let Some(event) = progress.advance(chunk as u64, total) {
                    let _ = progress_app.emit("update-progress", event);
                }
            },
            || {},
        )
        .await;
    let mut slot = state.update.lock().unwrap_or_else(PoisonError::into_inner);
    slot.installing = false;
    match result {
        Ok(()) => {
            slot.found = None;
            tracing::info!(version = %update.version, "update installed");
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "update failed");
            Err(failure(
                "update_install",
                "The update could not be installed. Nothing was changed; try again, or download it from the release page.".into(),
            ))
        }
    }
}

/// Thins the updater's per-chunk callbacks into `update-progress` events: one when the
/// download has moved on by at least a percent, or `PROGRESS_INTERVAL` has passed, since
/// the last event, and always the first and the last, so the UI starts and ends exact.
#[derive(Default)]
struct ProgressThrottle {
    downloaded: u64,
    /// What the last event said had arrived, and when it was sent.
    last: Option<(u64, Instant)>,
}

impl ProgressThrottle {
    fn advance(&mut self, chunk: u64, total: Option<u64>) -> Option<UpdateProgress> {
        self.advance_at(chunk, total, Instant::now())
    }

    fn advance_at(
        &mut self,
        chunk: u64,
        total: Option<u64>,
        now: Instant,
    ) -> Option<UpdateProgress> {
        self.downloaded = self.downloaded.saturating_add(chunk);
        let downloaded = self.downloaded;
        let due = match self.last {
            None => true,
            Some((sent, at)) => {
                let finished = total.is_some_and(|t| downloaded >= t);
                // A percent of the whole; with no size given, time alone decides.
                let step = total.map_or(u64::MAX, |t| (t / 100).max(1));
                finished
                    || downloaded.saturating_sub(sent) >= step
                    || now.saturating_duration_since(at) >= PROGRESS_INTERVAL
            }
        };
        if !due {
            return None;
        }
        self.last = Some((downloaded, now));
        Some(UpdateProgress { downloaded, total })
    }
}

/// Quits and starts Habi again, which is how an installed update takes effect.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_sent_per_percent_and_always_at_the_start_and_end() {
        let mut throttle = ProgressThrottle::default();
        let start = Instant::now();
        let total = Some(10_000);
        // The first chunk is always reported.
        assert!(throttle.advance_at(10, total, start).is_some());
        // Less than a percent more, moments later: held back.
        assert!(throttle.advance_at(10, total, start).is_none());
        // A full percent since the last event: reported.
        let event = throttle
            .advance_at(100, total, start)
            .expect("a percent more");
        assert_eq!(event.downloaded, 120);
        // Less than a percent, but a while since the last event: reported.
        let later = start + PROGRESS_INTERVAL;
        assert!(throttle.advance_at(1, total, later).is_some());
        // The last chunk is always reported, however small.
        assert!(throttle.advance_at(9_000, total, later).is_some());
        let last = throttle.advance_at(879, total, later).expect("the end");
        assert_eq!(last.downloaded, 10_000);
    }

    /// The hook only ever runs on Windows, as the installer starts; this is its one rehearsal.
    #[test]
    fn before_exit_stops_running_jobs() {
        let app = tauri::test::mock_app();
        app.manage(AppState::new(None, None, None));
        let state = app.state::<AppState>();
        let (job, _guard) = state.job(Some("apply".into()));
        before_exit(app.handle().clone())();
        assert!(job.is_cancelled());
    }

    #[test]
    fn progress_without_a_size_is_paced_by_time() {
        let mut throttle = ProgressThrottle::default();
        let start = Instant::now();
        assert!(throttle.advance_at(1, None, start).is_some());
        assert!(throttle.advance_at(1_000_000, None, start).is_none());
        let event = throttle
            .advance_at(1, None, start + PROGRESS_INTERVAL)
            .expect("interval passed");
        assert_eq!(event.downloaded, 1_000_002);
    }
}
