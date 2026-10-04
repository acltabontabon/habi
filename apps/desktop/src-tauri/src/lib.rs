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
mod updates;
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

/// Apps opened from the Finder get launchd's minimal PATH, so `gh`, `glab`
/// and a Homebrew `git` are not found. Adds the login shell's PATH (waiting
/// at most a moment for it) and the usual Homebrew folders. Returns what was
/// added, for the log.
#[cfg(target_os = "macos")]
fn merge_login_path() -> Vec<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| "/bin/zsh".into());
    let login = Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .and_then(|mut child| {
            let mut stdout = child.stdout.take()?;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stdout.read_to_string(&mut text);
                let _ = tx.send(text);
            });
            let text = rx.recv_timeout(Duration::from_millis(1500)).ok();
            let _ = child.kill();
            let _ = child.wait();
            text
        })
        .unwrap_or_default();

    let current = std::env::var("PATH").unwrap_or_default();
    let mut entries: Vec<String> = current
        .split(':')
        .filter(|e| !e.is_empty())
        .map(String::from)
        .collect();
    let mut added = Vec::new();
    // Anything a profile prints comes before the PATH, which is printed last.
    for entry in login
        .lines()
        .last()
        .unwrap_or_default()
        .split(':')
        .chain(["/opt/homebrew/bin", "/usr/local/bin"])
    {
        if entry.starts_with('/') && !entries.iter().any(|e| e == entry) {
            entries.push(entry.to_string());
            added.push(entry.to_string());
        }
    }
    if !added.is_empty() {
        // SAFETY: called first thing in `run`, before Habi starts any other
        // thread that could read the environment (the reader thread above
        // only reads a pipe).
        #[allow(unsafe_code)] // Setting the environment is unsafe since Rust 2024.
        unsafe {
            std::env::set_var("PATH", entries.join(":"))
        };
    }
    added
}

/// Whether the webview may load `url`: only Habi's own pages (the `tauri`
/// scheme on macOS and Linux, `tauri.localhost` on Windows), the blank page a
/// webview starts from, and, in debug builds, the dev server (`devUrl`).
fn is_app_page(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    let own = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        "about" => url.as_str() == "about:blank",
        _ => false,
    };
    own || (cfg!(debug_assertions) && dev_url.is_some_and(|dev| url.origin() == dev.origin()))
}

/// Defense in depth: a link, redirect or script that tries to take the main
/// window to another page is refused (links open in the system browser
/// through `open_external`). Habi's CSP and the lack of remote IPC
/// capabilities already limit what such a page could do.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = is_app_page(url, webview.app_handle().config().build.dev_url.as_ref());
            if !allowed {
                tracing::warn!(url = %url, "refused navigation away from Habi");
            }
            allowed
        })
        .build()
}

/// The window opens at its designed size (`tauri.conf.json`, which also sets
/// the 1024×700 minimum repeated below). A smaller
/// screen — a 1366×768 laptop, or 1920×1080 at 125% — would put part of it
/// out of reach, so there the size, and the minimum if it too is larger,
/// shrink to the screen's work area; the layout adapts down to 720 px.
fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::LogicalSize;
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    // Room for the title bar and the window frame, which the inner size leaves out.
    let fits = LogicalSize::new(
        size.width.min(area.width - 16.0).max(720.0),
        size.height.min(area.height - 48.0).max(560.0),
    );
    if fits.width < size.width || fits.height < size.height {
        tracing::info!(
            width = fits.width,
            height = fits.height,
            "fitting the window to a small screen"
        );
        // The configured minimum, lowered only as far as the screen needs.
        let (min_width, min_height) = (1024.0_f64, 700.0_f64);
        if fits.width < min_width || fits.height < min_height {
            window.set_min_size(Some(LogicalSize::new(
                fits.width.min(min_width),
                fits.height.min(min_height),
            )))?;
        }
        window.set_size(fits)?;
        window.center()?;
    }
    Ok(())
}

pub fn run() {
    #[cfg(target_os = "macos")]
    let added_to_path = merge_login_path();
    // Without a home folder there is nowhere to keep data or logs: the UI
    // explains that instead of the app failing to open.
    let (paths, paths_error) = match AppPaths::from_env() {
        Ok(paths) => (Some(paths), None),
        Err(e) => (None, Some(e.to_info())),
    };
    let guard = paths.as_ref().and_then(|p| {
        let _ = p.ensure();
        init_logging(p)
    });
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting Habi");
    #[cfg(target_os = "macos")]
    if !added_to_path.is_empty() {
        tracing::info!(added = ?added_to_path, "added login shell folders to PATH");
    }

    tauri::Builder::default()
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let state = match (paths, paths_error) {
                (Some(paths), _) => match Habi::open(paths) {
                    Ok(habi) => AppState::new(Some(habi), None, guard),
                    Err(e) => {
                        tracing::error!(error = %e, "could not open local data");
                        AppState::new(None, Some(e.to_info()), guard)
                    }
                },
                (None, error) => AppState::new(None, error, guard),
            };
            app.manage(state);
            if let Some(window) = app.get_webview_window("main")
                && let Err(e) = fit_to_screen(&window)
            {
                tracing::warn!(error = %e, "could not fit the window to the screen");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Files dropped onto the window may be imported, and only those.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<AppState>().remember_dropped(paths);
            }
            if let tauri::WindowEvent::Destroyed = event {
                // Stop background work and file watching when the window closes.
                let state = window.state::<AppState>();
                state.cancel_all();
                watch::stop(&state, None);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            updates::check_for_update,
            updates::install_update,
            updates::restart_app,
            commands::get_settings,
            commands::set_settings,
            commands::cancel_job,
            commands::log_ui_error,
            commands::pick_project,
            commands::open_picked_project,
            commands::project_places,
            commands::browse_folder,
            commands::open_browsed_project,
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
            commands::get_source,
            commands::pick_library_folder,
            commands::add_source,
            commands::remove_source,
            commands::set_source_role,
            commands::refresh_source,
            commands::check_source_update,
            commands::source_updates,
            commands::source_update_report,
            commands::dismiss_update_report,
            commands::catalog,
            commands::catalog_repo_facts,
            commands::preview_catalog_entry,
            commands::connect_catalog_entry,
            commands::forget_catalog_preview,
            commands::catalog_fits,
            commands::library,
            commands::item_detail,
            commands::item_file,
            commands::plan_install,
            commands::plan_update,
            commands::plan_remove,
            commands::plan_restore,
            commands::plan_install_machine,
            commands::plan_update_machine,
            commands::plan_remove_machine,
            commands::plan_restore_machine,
            commands::machine_install_preview,
            commands::detected_clients,
            commands::machine_history,
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
            commands::record_contribution_lineage,
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
            commands::skills_overview,
            commands::machine_skills,
            commands::open_git_copy,
            commands::forget_git_copy,
            commands::search_skill_files,
            commands::add_dropped_skill_files,
            commands::skill_local_changes,
            commands::skill_templates,
            commands::skill_upstream,
            commands::plan_upstream_sync,
            commands::apply_upstream_sync,
            commands::diagnostics_preview,
            commands::diagnostics_save,
            commands::create_sample_workspace,
            commands::remove_sample_workspace,
            commands::free_up_space,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Habi");
}

#[cfg(test)]
mod navigation_tests {
    use super::is_app_page;

    fn url(text: &str) -> tauri::Url {
        text.parse().expect("a valid URL")
    }

    #[test]
    fn only_habis_own_pages_load() {
        for own in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "about:blank",
        ] {
            assert!(is_app_page(&url(own), None), "{own}");
        }
        for other in [
            "https://example.com/",
            "http://example.com/tauri.localhost",
            "http://tauri.localhost.evil.test/",
            "http://tauri.localhost:8080/",
            "tauri://evil/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:srcdoc",
        ] {
            assert!(!is_app_page(&url(other), None), "{other}");
        }
    }

    #[test]
    fn the_dev_server_loads_only_in_debug_builds() {
        let dev = url("http://127.0.0.1:1420");
        assert_eq!(
            is_app_page(&url("http://127.0.0.1:1420/src/main.tsx"), Some(&dev)),
            cfg!(debug_assertions)
        );
        assert!(!is_app_page(&url("http://127.0.0.1:1421/"), Some(&dev)));
        assert!(!is_app_page(&url("http://127.0.0.1:1420/"), None));
    }
}
