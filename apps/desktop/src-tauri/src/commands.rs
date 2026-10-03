//! Tauri commands. Each one is a thin wrapper: validate, run the core
//! service on a blocking worker thread, return data or a structured error.
//! Incoming arguments are treated as untrusted even though they come from
//! Habi's own UI.

use crate::state::AppState;
use habi_core::cancel::CancelToken;
use habi_core::catalog::github::RepoFacts;
use habi_core::catalog::{CatalogEntry, CatalogFit};
use habi_core::checks::{CheckPreview, CheckRun};
use habi_core::clients::ClientId;
use habi_core::contribute::{Contribution, ContributionOrigin, PublishOutcome, ShareForm};
use habi_core::diagnostics::DiagnosticBundle;
use habi_core::error::{ErrorInfo, HabiError};
use habi_core::install::apply::OperationSummary;
use habi_core::install::plan::{Decisions, Plan};
use habi_core::library::model::LibraryIndex;
use habi_core::matching::eval::{Declaration, DeclaredSubject};
use habi_core::paths::RelPath;
use habi_core::sample::SampleWorkspace;
use habi_core::service::{
    ConditionSuggestion, Excerpt, FileContent, Habi, ImportFrom, ItemDetail, ItemRef,
    PreviewRequest, ProjectOverview, ProjectRecord, Rehearsal, SkillPreview,
};
use habi_core::skills::intake::{
    ImportInspection, ImportOutcome, ImportSelection, InstructionDocument, ProjectKnowledge,
};
use habi_core::skills::{LocalSkill, LocalSkillSummary, NewSkill, SkillDocument, SkillFileContent};
use habi_core::source::{
    NewSource, RefreshOutcome, Source, SourceRole, SourceUpdate, UpdateReport,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, PoisonError};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

type CmdResult<T> = Result<T, ErrorInfo>;

fn internal(message: impl Into<String>) -> ErrorInfo {
    ErrorInfo {
        code: "internal".into(),
        message: message.into(),
    }
}

/// Runs `f` on a blocking worker thread.
async fn blocking<T, F>(habi: Arc<Habi>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Habi) -> habi_core::error::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&habi).map_err(|e| e.to_info()))
        .await
        .map_err(|e| internal(format!("background task failed: {e}")))?
}

// ----- app ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
    pub git_available: bool,
    pub gh_available: bool,
    pub glab_available: bool,
    pub startup_error: Option<ErrorInfo>,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> CmdResult<AppInfo> {
    // Looking up tools spawns processes; keep that off the async runtime.
    let (git_available, gh_available, glab_available) =
        tauri::async_runtime::spawn_blocking(|| (which("git"), which("gh"), which("glab")))
            .await
            .map_err(|e| internal(format!("background task failed: {e}")))?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: state
            .habi
            .as_ref()
            .map(|h| habi_core::paths::display_path(&h.paths.root))
            .unwrap_or_default(),
        platform: std::env::consts::OS.to_string(),
        git_available,
        gh_available,
        glab_available,
        startup_error: state.startup_error.clone(),
    })
}

fn which(program: &str) -> bool {
    std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(program)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    /// 0 disables scheduled refresh.
    pub auto_refresh_hours: u32,
    pub default_clients: Vec<ClientId>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_refresh_hours: 12,
            default_clients: vec![ClientId::ClaudeCode],
        }
    }
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    let habi = state.habi()?;
    blocking(habi, |h| {
        Ok(h.store
            .setting("desktop")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn set_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    if settings.auto_refresh_hours > 24 * 30 {
        return Err(HabiError::invalid("choose at most 720 hours").to_info());
    }
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.store.set_setting(
            "desktop",
            &serde_json::to_string(&settings).unwrap_or_default(),
        )?;
        Ok(settings)
    })
    .await
}

#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, job_id: String) -> CmdResult<bool> {
    Ok(state.cancel(&job_id))
}

/// Records an error the UI could not handle in Habi's log, so a saved
/// diagnostic report includes it. Lengths are capped; the log is redacted
/// when a report is made.
#[tauri::command]
pub async fn log_ui_error(message: String, detail: Option<String>) -> CmdResult<()> {
    let message: String = message.chars().take(2_000).collect();
    let detail: String = detail.unwrap_or_default().chars().take(8_000).collect();
    tracing::error!(%message, %detail, "ui error");
    Ok(())
}

// ----- projects ------------------------------------------------------------------

#[tauri::command]
pub async fn pick_project(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<ProjectRecord>> {
    let habi = state.habi()?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Open a project folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|e| internal(e.to_string()))?;
    blocking(habi, move |h| h.open_project(&path))
        .await
        .map(Some)
}

#[tauri::command]
pub async fn open_recent_project(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<ProjectRecord> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        let p = h.project(&project_id)?;
        if !p.exists {
            return Err(HabiError::NotFound(format!(
                "the folder {} (moved or deleted)",
                p.path
            )));
        }
        h.open_project(&p.root)
    })
    .await
}

#[tauri::command]
pub async fn recent_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectRecord>> {
    let habi = state.habi()?;
    blocking(habi, |h| h.recent_projects()).await
}

#[tauri::command]
pub async fn forget_project(state: State<'_, AppState>, project_id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.forget_project(&project_id)).await
}

#[tauri::command]
pub async fn set_exclusions(
    state: State<'_, AppState>,
    project_id: String,
    exclusions: Vec<String>,
) -> CmdResult<ProjectRecord> {
    if exclusions.len() > 100 {
        return Err(HabiError::invalid("too many exclusions").to_info());
    }
    let habi = state.habi()?;
    blocking(habi, move |h| h.set_exclusions(&project_id, exclusions)).await
}

#[tauri::command]
pub async fn project_overview(
    state: State<'_, AppState>,
    project_id: String,
    rescan: bool,
    job_id: Option<String>,
) -> CmdResult<ProjectOverview> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.overview(&project_id, rescan, &cancel)).await
}

#[tauri::command]
pub async fn watch_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<()> {
    let habi = state.habi()?;
    let project = blocking(habi, move |h| h.project(&project_id)).await?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::watch::start(&app, &project.id, &project.root)
    })
    .await
    .map_err(|e| internal(format!("background task failed: {e}")))?
    .map_err(|e| internal(format!("could not watch the project for changes: {e}")))
}

#[tauri::command]
pub async fn unwatch_project(state: State<'_, AppState>, project_id: String) -> CmdResult<()> {
    crate::watch::stop(&state, Some(&project_id));
    Ok(())
}

/// A few lines of a project file around `line`, for evidence. Refuses
/// files that may hold secrets and anything outside the project.
#[tauri::command]
pub async fn read_project_excerpt(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    line: Option<u32>,
) -> CmdResult<Excerpt> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.project_excerpt(&project_id, &path, line)).await
}

#[tauri::command]
pub async fn reveal_project_path(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> CmdResult<()> {
    let habi = state.habi()?;
    let target: PathBuf = blocking(habi, move |h| {
        let project = h.project(&project_id)?;
        Ok(match path {
            Some(p) => RelPath::new(&p)?.to_path(&project.root),
            None => project.root.clone(),
        })
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| internal(format!("could not reveal the file: {e}")))
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> CmdResult<()> {
    let ok = url.starts_with("https://")
        && url.len() < 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    if !ok {
        return Err(HabiError::invalid("only https links can be opened").to_info());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| internal(format!("could not open the link: {e}")))
}

#[tauri::command]
pub async fn declare(
    state: State<'_, AppState>,
    project_id: String,
    module: String,
    subject: DeclaredSubject,
    present: bool,
    note: Option<String>,
) -> CmdResult<Declaration> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.declare(&project_id, &module, subject, present, note)
    })
    .await
}

#[tauri::command]
pub async fn retract(
    state: State<'_, AppState>,
    project_id: String,
    declaration_id: String,
) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.retract(&project_id, &declaration_id)).await
}

// ----- sources ---------------------------------------------------------------------

#[tauri::command]
pub async fn list_sources(state: State<'_, AppState>) -> CmdResult<Vec<Source>> {
    let habi = state.habi()?;
    blocking(habi, |h| h.sources().list()).await
}

/// One source by id, including a library that is only being previewed.
#[tauri::command]
pub async fn get_source(state: State<'_, AppState>, source_id: String) -> CmdResult<Source> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().get(&source_id)).await
}

#[tauri::command]
pub async fn pick_library_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a library folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|e| internal(e.to_string()))?;
    let canonical = habi_core::paths::canonical(&path).map_err(|e| internal(e.to_string()))?;
    state
        .picked_folders
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(canonical.clone());
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn add_source(state: State<'_, AppState>, source: NewSource) -> CmdResult<Source> {
    // Local folders (including file:// URLs in any letter case) must come
    // from the native picker in this session.
    use habi_core::source::{Location, parse_location};
    match parse_location(&source.location).map_err(|e| e.to_info())? {
        Location::LocalGit(path) | Location::LocalDir(path) => {
            let picked = state
                .picked_folders
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if !picked.contains(&path) {
                return Err(HabiError::invalid(
                    "choose local library folders with the folder picker",
                )
                .to_info());
            }
        }
        Location::Remote(_) => {}
    }
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().add(&source)).await
}

#[tauri::command]
pub async fn remove_source(state: State<'_, AppState>, source_id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().remove(&source_id)).await
}

#[tauri::command]
pub async fn set_source_role(
    state: State<'_, AppState>,
    source_id: String,
    role: SourceRole,
) -> CmdResult<Source> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().set_role(&source_id, role)).await
}

#[tauri::command]
pub async fn refresh_source(
    state: State<'_, AppState>,
    source_id: String,
    job_id: Option<String>,
) -> CmdResult<RefreshOutcome> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.sources().refresh(&source_id, &cancel)).await
}

/// Asks whether a library's repository has something newer than what the
/// library reads. Downloads nothing and changes nothing: updating is a
/// separate act (`refresh_source`). `None` for a folder.
#[tauri::command]
pub async fn check_source_update(
    state: State<'_, AppState>,
    source_id: String,
    job_id: Option<String>,
) -> CmdResult<Option<SourceUpdate>> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.sources().check_update(&source_id, &cancel)).await
}

/// What the last checks found, judged against what each library reads now.
#[tauri::command]
pub async fn source_updates(state: State<'_, AppState>) -> CmdResult<Vec<SourceUpdate>> {
    let habi = state.habi()?;
    blocking(habi, |h| h.sources().updates()).await
}

/// What the last update changed in a library, until it is dismissed.
#[tauri::command]
pub async fn source_update_report(
    state: State<'_, AppState>,
    source_id: String,
) -> CmdResult<Option<UpdateReport>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().last_update(&source_id)).await
}

/// The user has read what an update changed.
#[tauri::command]
pub async fn dismiss_update_report(state: State<'_, AppState>, source_id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().dismiss_update_report(&source_id)).await
}

// ----- catalog ---------------------------------------------------------------------

/// The public libraries Habi suggests, with what is known of each.
#[tauri::command]
pub async fn catalog(state: State<'_, AppState>) -> CmdResult<Vec<CatalogEntry>> {
    let habi = state.habi()?;
    blocking(habi, |h| h.catalog().entries()).await
}

/// Fetches a catalog library so it can be inspected (nothing is connected,
/// installed or run). Opening one fetched before downloads nothing, unless
/// `refresh` asks for a check.
#[tauri::command]
pub async fn preview_catalog_entry(
    state: State<'_, AppState>,
    entry_id: String,
    refresh: bool,
    job_id: Option<String>,
) -> CmdResult<CatalogEntry> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| {
        h.catalog().preview(&entry_id, refresh, &cancel)
    })
    .await
}

/// Connects a catalog library as a community library.
#[tauri::command]
pub async fn connect_catalog_entry(
    state: State<'_, AppState>,
    entry_id: String,
    job_id: Option<String>,
) -> CmdResult<Source> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.catalog().connect(&entry_id, &cancel)).await
}

/// What GitHub says about a catalog repository (stars, forks, last push,
/// archived), for the page of a library not yet connected. Kept for a day;
/// absent when it cannot be had. Never an error.
#[tauri::command]
pub async fn catalog_repo_facts(
    state: State<'_, AppState>,
    entry_id: String,
    job_id: Option<String>,
) -> CmdResult<Option<RepoFacts>> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.catalog().repo_facts(&entry_id, &cancel)).await
}

/// Discards a fetched preview. A connected library is not touched.
#[tauri::command]
pub async fn forget_catalog_preview(state: State<'_, AppState>, entry_id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.catalog().forget(&entry_id)).await
}

/// Skills of already fetched catalog libraries that fit a project.
#[tauri::command]
pub async fn catalog_fits(
    state: State<'_, AppState>,
    project_id: String,
    job_id: Option<String>,
) -> CmdResult<Vec<CatalogFit>> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.catalog_fits(&project_id, &cancel)).await
}

#[tauri::command]
pub async fn library(state: State<'_, AppState>, source_id: String) -> CmdResult<LibraryIndex> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.sources().index(&source_id)).await
}

#[tauri::command]
pub async fn item_detail(
    state: State<'_, AppState>,
    source_id: String,
    item_id: String,
) -> CmdResult<ItemDetail> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.item_detail(&source_id, &item_id)).await
}

#[tauri::command]
pub async fn item_file(
    state: State<'_, AppState>,
    source_id: String,
    item_id: String,
    path: String,
) -> CmdResult<FileContent> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.read_item_file(&source_id, &item_id, &path)).await
}

// ----- plans ---------------------------------------------------------------------------

fn check_decisions(d: &Decisions) -> CmdResult<()> {
    if d.len() > 500 || d.keys().any(|k| RelPath::new(k).is_err()) {
        return Err(HabiError::invalid("invalid conflict decisions").to_info());
    }
    Ok(())
}

#[tauri::command]
pub async fn plan_install(
    state: State<'_, AppState>,
    project_id: String,
    items: Vec<ItemRef>,
    clients: Vec<ClientId>,
    include_mcp: bool,
    decisions: Decisions,
) -> CmdResult<Plan> {
    check_decisions(&decisions)?;
    if items.is_empty() || items.len() > 100 {
        return Err(HabiError::invalid("choose between 1 and 100 items").to_info());
    }
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.plan_install(&project_id, &items, &clients, include_mcp, &decisions)
    })
    .await
}

#[tauri::command]
pub async fn plan_update(
    state: State<'_, AppState>,
    project_id: String,
    keys: Vec<String>,
    decisions: Decisions,
) -> CmdResult<Plan> {
    check_decisions(&decisions)?;
    let habi = state.habi()?;
    blocking(habi, move |h| h.plan_update(&project_id, &keys, &decisions)).await
}

#[tauri::command]
pub async fn plan_remove(
    state: State<'_, AppState>,
    project_id: String,
    keys: Vec<String>,
    decisions: Decisions,
) -> CmdResult<Plan> {
    check_decisions(&decisions)?;
    let habi = state.habi()?;
    blocking(habi, move |h| h.plan_remove(&project_id, &keys, &decisions)).await
}

#[tauri::command]
pub async fn plan_restore(
    state: State<'_, AppState>,
    project_id: String,
    operation_id: String,
    decisions: Decisions,
) -> CmdResult<Plan> {
    check_decisions(&decisions)?;
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.plan_restore(&project_id, &operation_id, &decisions)
    })
    .await
}

/// Applies a plan computed earlier in this session. The UI passes only the id.
#[tauri::command]
pub async fn apply_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> CmdResult<OperationSummary> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.apply(&plan_id)).await
}

#[tauri::command]
pub async fn history(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Vec<OperationSummary>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.history(&project_id)).await
}

#[tauri::command]
pub async fn recover(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Vec<OperationSummary>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.recover(&project_id)).await
}

// ----- checks --------------------------------------------------------------------------

#[tauri::command]
pub async fn prepare_check(
    state: State<'_, AppState>,
    project_id: String,
    item_key: String,
    check_id: String,
    module: String,
    bindings: HashMap<String, String>,
) -> CmdResult<CheckPreview> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.prepare_check(&project_id, &item_key, &check_id, &module, &bindings)
    })
    .await
}

/// Runs a previously previewed check by its single-use preview id.
#[tauri::command]
pub async fn run_check(
    state: State<'_, AppState>,
    project_id: String,
    preview_id: String,
    job_id: Option<String>,
) -> CmdResult<CheckRun> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| {
        h.run_check(&project_id, &preview_id, &cancel)
    })
    .await
}

#[tauri::command]
pub async fn check_runs(
    state: State<'_, AppState>,
    project_id: String,
    item_key: String,
) -> CmdResult<Vec<CheckRun>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.check_runs(&project_id, &item_key)).await
}

// ----- contributions ---------------------------------------------------------------------

#[tauri::command]
pub async fn start_contribution(
    state: State<'_, AppState>,
    source_id: String,
    origin: ContributionOrigin,
) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.start_contribution(&source_id, origin)).await
}

#[tauri::command]
pub async fn contribution(state: State<'_, AppState>, id: String) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.contributions().preview(&id)).await
}

#[tauri::command]
pub async fn list_contributions(state: State<'_, AppState>) -> CmdResult<Vec<Contribution>> {
    let habi = state.habi()?;
    blocking(habi, |h| h.contributions().list()).await
}

#[tauri::command]
pub async fn update_contribution(
    state: State<'_, AppState>,
    id: String,
    title: String,
    message: String,
    form: ShareForm,
) -> CmdResult<Contribution> {
    let too_long = form.applies_tags.len()
        + form.applies_dependencies.len()
        + form.applies_files.len()
        + form.tools.len()
        + form.examples.len()
        > 60;
    if too_long {
        return Err(HabiError::invalid("the form has too many entries").to_info());
    }
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.update_contribution(&id, &title, &message, &form)
    })
    .await
}

/// Leaves changed files out of a contribution (or puts them back).
#[tauri::command]
pub async fn select_contribution_files(
    state: State<'_, AppState>,
    id: String,
    excluded: Vec<String>,
) -> CmdResult<Contribution> {
    if excluded.len() > 200 {
        return Err(HabiError::invalid("too many files").to_info());
    }
    let habi = state.habi()?;
    blocking(habi, move |h| h.select_contribution_files(&id, &excluded)).await
}

/// Records (or stops recording) where the skill came from in the shared SKILL.md.
#[tauri::command]
pub async fn record_contribution_lineage(
    state: State<'_, AppState>,
    id: String,
    record: bool,
) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.record_contribution_lineage(&id, record)).await
}

#[tauri::command]
pub async fn commit_contribution(
    state: State<'_, AppState>,
    id: String,
    build_on_remote: Option<bool>,
    job_id: Option<String>,
) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| {
        h.commit_contribution_with(&id, build_on_remote.unwrap_or(false), &cancel)
    })
    .await
}

#[tauri::command]
pub async fn revise_contribution(
    state: State<'_, AppState>,
    id: String,
    job_id: Option<String>,
) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.revise_contribution_with(&id, &cancel)).await
}

#[tauri::command]
pub async fn cancel_contribution_revision(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.cancel_contribution_revision(&id)).await
}

#[tauri::command]
pub async fn contribution_rehearsal(
    state: State<'_, AppState>,
    id: String,
    job_id: Option<String>,
) -> CmdResult<Rehearsal> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.contribution_rehearsal(&id, &cancel)).await
}

#[tauri::command]
pub async fn refresh_contribution_review(
    state: State<'_, AppState>,
    id: String,
    job_id: Option<String>,
) -> CmdResult<Contribution> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.refresh_contribution_review(&id, &cancel)).await
}

#[tauri::command]
pub async fn export_contribution(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<String>> {
    let habi = state.habi()?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose where to save the patch")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let dir = folder.into_path().map_err(|e| internal(e.to_string()))?;
    blocking(habi, move |h| {
        let path = h
            .contributions()
            .export_patch(&id, &dir, &CancelToken::new())?;
        Ok(Some(habi_core::paths::display_path(&path)))
    })
    .await
}

#[tauri::command]
pub async fn publish_contribution(
    state: State<'_, AppState>,
    id: String,
    open_request: bool,
    job_id: Option<String>,
) -> CmdResult<PublishOutcome> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| {
        h.publish_contribution(&id, open_request, &cancel)
    })
    .await
}

#[tauri::command]
pub async fn discard_contribution(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.contributions().discard(&id)).await
}

// ----- local skills ------------------------------------------------------------------------

fn check_form(form: &ShareForm) -> CmdResult<()> {
    let entries = form.applies_tags.len()
        + form.applies_dependencies.len()
        + form.applies_files.len()
        + form.exclude_tags.len()
        + form.exclude_dependencies.len()
        + form.tools.len()
        + form.examples.len();
    if entries > 60 {
        return Err(HabiError::invalid("the form has too many entries").to_info());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> CmdResult<Vec<LocalSkillSummary>> {
    let habi = state.habi()?;
    blocking(habi, |h| h.skills().list()).await
}

#[tauri::command]
pub async fn get_skill(state: State<'_, AppState>, id: String) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().get(&id)).await
}

#[tauri::command]
pub async fn create_skill(
    state: State<'_, AppState>,
    skill: NewSkill,
    project_id: Option<String>,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.create_skill(&skill, project_id.as_deref())).await
}

#[tauri::command]
pub async fn save_skill_document(
    state: State<'_, AppState>,
    id: String,
    title: String,
    document: SkillDocument,
    base_digest: Option<String>,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.skills()
            .save_document(&id, &title, &document, base_digest.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn save_skill_applicability(
    state: State<'_, AppState>,
    id: String,
    form: ShareForm,
    base_digest: Option<String>,
) -> CmdResult<LocalSkill> {
    check_form(&form)?;
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.skills()
            .save_applicability(&id, &form, base_digest.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn save_skill_metadata(
    state: State<'_, AppState>,
    id: String,
    text: String,
    base_digest: Option<String>,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.skills()
            .save_metadata_text(&id, &text, base_digest.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn read_skill_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<SkillFileContent> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().read_file(&id, &path)).await
}

#[tauri::command]
pub async fn write_skill_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
    text: String,
    base_digest: Option<String>,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.skills()
            .write_file(&id, &path, &text, base_digest.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn remove_skill_path(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().remove_path(&id, &path)).await
}

#[tauri::command]
pub async fn rename_skill_path(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().rename_path(&id, &from, &to)).await
}

#[tauri::command]
pub async fn set_skill_file_executable(
    state: State<'_, AppState>,
    id: String,
    path: String,
    executable: bool,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.skills().set_executable(&id, &path, executable)
    })
    .await
}

/// Replaces a file in the package with one the user picks in a native dialog.
#[tauri::command]
pub async fn replace_skill_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<Option<LocalSkill>> {
    let habi = state.habi()?;
    let title = format!("Replace {path}");
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title(title).blocking_pick_file()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let source = file.into_path().map_err(|e| internal(e.to_string()))?;
    blocking(habi, move |h| {
        h.skills().replace_file(&id, &path, &source).map(Some)
    })
    .await
}

/// Opens a package file in the system's text editor. Never with the file's
/// default application: for a script that could be a terminal that runs it.
/// Where no text editor can be named (Linux), the file is revealed instead.
#[tauri::command]
pub async fn open_skill_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<()> {
    let habi = state.habi()?;
    let file: PathBuf = blocking(habi, move |h| h.skills().file_path(&id, &path)).await?;
    let spawned = if cfg!(target_os = "macos") {
        Some(
            std::process::Command::new("/usr/bin/open")
                .arg("-t")
                .arg(&file)
                .spawn(),
        )
    } else if cfg!(target_os = "windows") {
        Some(std::process::Command::new("notepad.exe").arg(&file).spawn())
    } else {
        None
    };
    match spawned {
        Some(Ok(_)) => Ok(()),
        Some(Err(e)) => Err(internal(format!("could not open a text editor: {e}"))),
        None => app
            .opener()
            .reveal_item_in_dir(&file)
            .map_err(|e| internal(format!("could not reveal the file: {e}"))),
    }
}

/// Copies files the user picks in a native dialog into the skill package.
#[tauri::command]
pub async fn add_skill_files(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    folder: String,
) -> CmdResult<Option<LocalSkill>> {
    if !matches!(folder.as_str(), "" | "references" | "scripts" | "assets") {
        return Err(HabiError::invalid("choose references, scripts or assets").to_info());
    }
    let habi = state.habi()?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Add files to this skill")
            .blocking_pick_files()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(files) = picked else {
        return Ok(None);
    };
    let mut paths = Vec::new();
    for f in files {
        paths.push(f.into_path().map_err(|e| internal(e.to_string()))?);
    }
    blocking(habi, move |h| {
        h.skills().add_files(&id, &folder, &paths).map(Some)
    })
    .await
}

/// Copies files dropped onto the window into a skill. Only paths the person
/// actually dropped (recently) are accepted; nothing is overwritten.
#[tauri::command]
pub async fn add_dropped_skill_files(
    state: State<'_, AppState>,
    id: String,
    folder: String,
    paths: Vec<String>,
) -> CmdResult<LocalSkill> {
    if !matches!(folder.as_str(), "" | "references" | "scripts" | "assets") {
        return Err(HabiError::invalid("choose references, scripts or assets").to_info());
    }
    let wanted: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
    let Some(paths) = state.take_dropped(&wanted) else {
        return Err(HabiError::invalid(
            "only files dropped onto this window can be added this way; drop them again",
        )
        .to_info());
    };
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().add_files(&id, &folder, &paths)).await
}

#[tauri::command]
pub async fn trash_skill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().trash(&id)).await
}

#[tauri::command]
pub async fn restore_skill(state: State<'_, AppState>, id: String) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().restore(&id)).await
}

#[tauri::command]
pub async fn purge_skill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills().purge(&id)).await
}

/// Writes the skill as a plain Agent Skills folder inside a folder the user picks.
#[tauri::command]
pub async fn export_skill(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<String>> {
    let habi = state.habi()?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose where to put the skill folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let dir = folder.into_path().map_err(|e| internal(e.to_string()))?;
    blocking(habi, move |h| {
        let path = h.skills().export(&id, &dir)?;
        Ok(Some(habi_core::paths::display_path(&path)))
    })
    .await
}

#[tauri::command]
pub async fn reveal_skill(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    let target: PathBuf = blocking(habi, move |h| {
        h.skills().get(&id)?;
        Ok(h.paths.skills().join(&id).join("package"))
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(target.join("SKILL.md"))
        .map_err(|e| internal(format!("could not reveal the skill: {e}")))
}

#[tauri::command]
pub async fn preview_skill(
    state: State<'_, AppState>,
    request: PreviewRequest,
    job_id: Option<String>,
) -> CmdResult<SkillPreview> {
    if let Some(form) = &request.form {
        check_form(form)?;
    }
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.preview_skill(&request, &cancel)).await
}

#[tauri::command]
pub async fn suggest_conditions(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Vec<ConditionSuggestion>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.suggest_conditions(&project_id)).await
}

#[tauri::command]
pub async fn discover_project(
    state: State<'_, AppState>,
    project_id: String,
    job_id: Option<String>,
) -> CmdResult<ProjectKnowledge> {
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.discover(&project_id, &cancel)).await
}

#[tauri::command]
pub async fn read_instructions(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> CmdResult<InstructionDocument> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.read_instructions(&project_id, &path)).await
}

#[tauri::command]
pub async fn create_skill_from_instructions(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    start_line: u32,
    end_line: u32,
    title: String,
) -> CmdResult<LocalSkill> {
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.create_skill_from_instructions(&project_id, &path, start_line, end_line, &title)
    })
    .await
}

/// Lets the user choose a folder to look for skills in. Only folders
/// chosen this way can be inspected or imported from.
#[tauri::command]
pub async fn pick_import_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a skill folder, or a folder of skills")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|e| internal(e.to_string()))?;
    let canonical = habi_core::paths::canonical(&path).map_err(|e| internal(e.to_string()))?;
    state
        .picked_folders
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(canonical.clone());
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

fn check_import_source(state: &AppState, from: &ImportFrom) -> CmdResult<()> {
    if let ImportFrom::Folder { path } = from {
        let canonical = habi_core::paths::canonical(path).map_err(|_| {
            HabiError::invalid("choose the folder with the folder picker").to_info()
        })?;
        if !state
            .picked_folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&canonical)
        {
            return Err(HabiError::invalid("choose the folder with the folder picker").to_info());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn inspect_import(
    state: State<'_, AppState>,
    from: ImportFrom,
    job_id: Option<String>,
) -> CmdResult<ImportInspection> {
    check_import_source(&state, &from)?;
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.inspect_import(&from, &cancel)).await
}

/// Fetches a Git repository to copy skills from, without connecting it.
/// Only remote addresses: a local folder is chosen with the folder picker
/// (Add skills → a folder), so the webview cannot name arbitrary paths.
#[tauri::command]
pub async fn open_git_copy(
    state: State<'_, AppState>,
    location: String,
    job_id: Option<String>,
) -> CmdResult<habi_core::service::GitCopy> {
    if habi_core::source::is_local_location(location.trim()) {
        return Err(HabiError::invalid(
            "that is a folder on this machine; choose it with Add skills → A folder",
        )
        .to_info());
    }
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.open_git_copy(&location, &cancel)).await
}

#[tauri::command]
pub async fn forget_git_copy(state: State<'_, AppState>, source_id: String) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.forget_git_copy(&source_id)).await
}

#[tauri::command]
pub async fn import_skills(
    state: State<'_, AppState>,
    from: ImportFrom,
    selections: Vec<ImportSelection>,
    job_id: Option<String>,
) -> CmdResult<ImportOutcome> {
    check_import_source(&state, &from)?;
    if selections.is_empty() || selections.len() > 200 {
        return Err(HabiError::invalid("choose between 1 and 200 skills").to_info());
    }
    let habi = state.habi()?;
    let (cancel, _guard) = state.job(job_id);
    blocking(habi, move |h| h.import_skills(&from, &selections, &cancel)).await
}

// ----- standing and lineage -------------------------------------------------------------

/// Installed-in and upstream state for every skill; reads project lock files.
#[tauri::command]
pub async fn skills_overview(
    state: State<'_, AppState>,
) -> CmdResult<Vec<habi_core::service::SkillStanding>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skills_overview()).await
}

#[tauri::command]
pub async fn skill_local_changes(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<habi_core::skills::lineage::LocalChanges> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skill_local_changes(&id)).await
}

#[tauri::command]
pub async fn skill_templates(
    state: State<'_, AppState>,
) -> CmdResult<Vec<habi_core::skills::TemplateInfo>> {
    let habi = state.habi()?;
    blocking(habi, move |h| Ok(h.skill_templates())).await
}

#[tauri::command]
pub async fn search_skill_files(
    state: State<'_, AppState>,
    id: String,
    query: String,
) -> CmdResult<Vec<habi_core::skills::FileMatch>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.search_skill_files(&id, &query)).await
}

// ----- updates for library copies --------------------------------------------------------

#[tauri::command]
pub async fn skill_upstream(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<Option<habi_core::skills::upstream::UpstreamStatus>> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.skill_upstream(&id)).await
}

#[tauri::command]
pub async fn plan_upstream_sync(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<habi_core::skills::upstream::UpstreamPlan> {
    let habi = state.habi()?;
    blocking(habi, move |h| h.plan_upstream_sync(&id)).await
}

#[tauri::command]
pub async fn apply_upstream_sync(
    state: State<'_, AppState>,
    id: String,
    token: String,
    decisions: std::collections::BTreeMap<String, habi_core::skills::upstream::UpstreamChoice>,
) -> CmdResult<LocalSkill> {
    // A skill holds at most 200 files, so there are never more decisions.
    if decisions.len() > 200 || decisions.keys().any(|k| k.len() > 1024) {
        return Err(HabiError::invalid("too many decisions").to_info());
    }
    let habi = state.habi()?;
    blocking(habi, move |h| {
        h.apply_upstream_sync(&id, &token, &decisions)
    })
    .await
}

// ----- diagnostics and sample ------------------------------------------------------------

#[tauri::command]
pub async fn diagnostics_preview(state: State<'_, AppState>) -> CmdResult<DiagnosticBundle> {
    let habi = state.habi()?;
    blocking(habi, |h| {
        habi_core::diagnostics::bundle(h, env!("CARGO_PKG_VERSION"))
    })
    .await
}

#[tauri::command]
pub async fn diagnostics_save(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let habi = state.habi()?;
    let bundle = blocking(habi, |h| {
        habi_core::diagnostics::bundle(h, env!("CARGO_PKG_VERSION"))
    })
    .await?;
    let name = bundle.file_name.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Save diagnostic report")
            .set_file_name(&name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    let Some(target) = picked else {
        return Ok(None);
    };
    let path = target.into_path().map_err(|e| internal(e.to_string()))?;
    habi_core::fsutil::atomic_write(&path, bundle.text.as_bytes()).map_err(|e| e.to_info())?;
    Ok(Some(habi_core::paths::display_path(&path)))
}

#[tauri::command]
pub async fn create_sample_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<SampleWorkspace> {
    let habi = state.habi()?;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| internal(format!("bundled samples not found: {e}")))?
        .join("samples");
    blocking(habi, move |h| habi_core::sample::create(h, &bundled)).await
}

/// Removes the sample libraries and projects and `<data>/sample`.
#[tauri::command]
pub async fn remove_sample_workspace(state: State<'_, AppState>) -> CmdResult<()> {
    let habi = state.habi()?;
    blocking(habi, habi_core::sample::remove).await
}

// ----- maintenance -------------------------------------------------------------------

/// Removes old operation records and library snapshots, and stored content
/// nothing kept refers to.
#[tauri::command]
pub async fn free_up_space(
    state: State<'_, AppState>,
) -> CmdResult<habi_core::maintenance::PruneReport> {
    let habi = state.habi()?;
    blocking(habi, |h| h.prune()).await
}
