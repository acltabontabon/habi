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
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

type CmdResult<T> = Result<T, ErrorInfo>;

/// How long a check may take before the person is told it could not finish.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

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

/// Downloads and installs the update the last check found, reporting progress as
/// `update-progress` events. On Windows the installer closes Habi itself; elsewhere the
/// new version starts at the next launch, or at once with `restart_app`.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let update = {
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
    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = progress_app.emit("update-progress", UpdateProgress { downloaded, total });
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

/// Quits and starts Habi again, which is how an installed update takes effect.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart()
}
