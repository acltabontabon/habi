//! Habi desktop: a thin Tauri adapter over `habi_core::service::Habi`.
//!
//! Commands validate their input, run core work on blocking worker threads
//! (never the UI thread), and return structured errors. The webview gets no
//! filesystem, shell, dialog or opener permission: folder pickers, file
//! saving and link opening happen here, in Rust.

mod commands;
#[cfg(test)]
mod ipc_tests;
mod state;
mod watch;

use habi_core::service::Habi;
use habi_core::store::AppPaths;
use state::AppState;
use tauri::Manager;

fn init_logging(paths: &AppPaths) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::prelude::*;
    let appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("habi")
        .filename_suffix("log")
        .max_log_files(7)
        .build(paths.logs())
        .ok()?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = tracing_subscriber::EnvFilter::try_from_env("HABI_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(false);
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .try_init();
    Some(guard)
}

pub fn run() {
    let paths = AppPaths::from_env().expect("Habi needs a home directory for its data");
    let _ = paths.ensure();
    let guard = init_logging(&paths);
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting Habi");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let state = match Habi::open(paths.clone()) {
                Ok(habi) => AppState::new(Some(habi), None, guard),
                Err(e) => {
                    tracing::error!(error = %e, "could not open local data");
                    AppState::new(None, Some(e.to_info()), guard)
                }
            };
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Stop background work and file watching when the window closes.
                let state = window.state::<AppState>();
                state.cancel_all();
                watch::stop(&state);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::set_settings,
            commands::cancel_job,
            commands::pick_project,
            commands::open_recent_project,
            commands::recent_projects,
            commands::forget_project,
            commands::set_exclusions,
            commands::project_overview,
            commands::watch_project,
            commands::unwatch_project,
            commands::read_project_excerpt,
            commands::reveal_project_path,
            commands::open_external,
            commands::declare,
            commands::retract,
            commands::list_sources,
            commands::pick_library_folder,
            commands::add_source,
            commands::remove_source,
            commands::set_source_role,
            commands::refresh_source,
            commands::library,
            commands::item_detail,
            commands::item_file,
            commands::plan_install,
            commands::plan_update,
            commands::plan_remove,
            commands::plan_restore,
            commands::apply_plan,
            commands::history,
            commands::recover,
            commands::prepare_check,
            commands::run_check,
            commands::check_runs,
            commands::start_contribution,
            commands::contribution,
            commands::list_contributions,
            commands::update_contribution,
            commands::select_contribution_files,
            commands::commit_contribution,
            commands::revise_contribution,
            commands::cancel_contribution_revision,
            commands::refresh_contribution_review,
            commands::contribution_rehearsal,
            commands::export_contribution,
            commands::publish_contribution,
            commands::discard_contribution,
            commands::list_skills,
            commands::get_skill,
            commands::create_skill,
            commands::save_skill_document,
            commands::save_skill_applicability,
            commands::save_skill_metadata,
            commands::read_skill_file,
            commands::write_skill_file,
            commands::remove_skill_path,
            commands::rename_skill_path,
            commands::set_skill_file_executable,
            commands::replace_skill_file,
            commands::open_skill_file,
            commands::add_skill_files,
            commands::trash_skill,
            commands::restore_skill,
            commands::purge_skill,
            commands::export_skill,
            commands::reveal_skill,
            commands::preview_skill,
            commands::suggest_conditions,
            commands::discover_project,
            commands::read_instructions,
            commands::create_skill_from_instructions,
            commands::pick_import_folder,
            commands::inspect_import,
            commands::import_skills,
            commands::skill_upstream,
            commands::plan_upstream_sync,
            commands::apply_upstream_sync,
            commands::diagnostics_preview,
            commands::diagnostics_save,
            commands::create_sample_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Habi");
}
