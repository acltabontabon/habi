//! Development-only bridge: serves the core service over loopback HTTP so the
//! desktop UI can be exercised in a plain browser against the *real* core
//! (real inspection, drafts, Git, plans) instead of static fixtures.
//!
//!     HABI_HOME=/tmp/habi-dev cargo run -p habi-core --example dev_bridge
//!     cd apps/desktop && VITE_HABI_BRIDGE=1 pnpm dev
//!
//! It is an example target, so it is never part of the application or the
//! CLI. It listens on 127.0.0.1 only and requires a custom request header,
//! which browsers refuse to send cross-origin without a CORS grant this
//! server never gives. Native dialogs do not exist here: commands that open a
//! picker in the desktop app take the chosen path as `__path` instead.
//!
//! The command names and argument shapes mirror `apps/desktop/src-tauri`;
//! the Tauri adapter itself is covered by its own IPC tests.

use habi_core::cancel::CancelToken;
use habi_core::error::{ErrorInfo, HabiError, Result};
use habi_core::service::Habi;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct Bridge {
    habi: Habi,
    jobs: Mutex<HashMap<String, CancelToken>>,
    samples: PathBuf,
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| HabiError::invalid(format!("argument `{key}`: {e}")))
}

fn out<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| HabiError::Internal(e.to_string()))
}

fn picked(args: &Value) -> Result<Option<PathBuf>> {
    Ok(arg::<Option<String>>(args, "__path")?
        .filter(|p| !p.trim().is_empty())
        .map(|p| match p.strip_prefix("~/") {
            Some(rest) => directories::BaseDirs::new()
                .map(|b| b.home_dir().join(rest))
                .unwrap_or_else(|| PathBuf::from(&p)),
            None => PathBuf::from(p.trim()),
        }))
}

fn on_path(program: &str) -> bool {
    which::which(program).is_ok()
}

impl Bridge {
    fn job(&self, args: &Value) -> (CancelToken, Option<String>) {
        let token = CancelToken::new();
        let id = args
            .get("jobId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(id) = &id {
            self.jobs
                .lock()
                .expect("jobs")
                .insert(id.clone(), token.clone());
        }
        (token, id)
    }

    fn dispatch(&self, cmd: &str, a: &Value) -> Result<Value> {
        let h = &self.habi;
        let (cancel, job) = self.job(a);
        let result = self.run(h, cmd, a, &cancel);
        if let Some(id) = job {
            self.jobs.lock().expect("jobs").remove(&id);
        }
        result
    }

    fn run(&self, h: &Habi, cmd: &str, a: &Value, cancel: &CancelToken) -> Result<Value> {
        let s = |key: &str| arg::<String>(a, key);
        let version = env!("CARGO_PKG_VERSION");
        match cmd {
            "app_info" => Ok(json!({
                "version": format!("{version}-bridge"),
                "dataDir": habi_core::paths::display_path(&h.paths.root),
                "platform": std::env::consts::OS,
                "gitAvailable": on_path("git"),
                "ghAvailable": on_path("gh"),
                "glabAvailable": on_path("glab"),
                "startupError": null,
            })),
            "get_settings" => Ok(h
                .store
                .setting("desktop")?
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(json!({ "autoRefreshHours": 12, "defaultClients": ["claude-code"] }))),
            "set_settings" => {
                let settings: Value = arg(a, "settings")?;
                h.store.set_setting("desktop", &settings.to_string())?;
                Ok(settings)
            }
            "cancel_job" => Ok(json!(
                self.jobs
                    .lock()
                    .expect("jobs")
                    .get(&s("jobId")?)
                    .map(|t| t.cancel())
                    .is_some()
            )),

            "pick_project" => match picked(a)? {
                Some(path) => out(h.open_project(&path)?),
                None => Ok(Value::Null),
            },
            "open_recent_project" => {
                let p = h.project(&s("projectId")?)?;
                out(h.open_project(&p.root)?)
            }
            "recent_projects" => out(h.recent_projects()?),
            "forget_project" => out(h.forget_project(&s("projectId")?)?),
            "set_exclusions" => out(h.set_exclusions(&s("projectId")?, arg(a, "exclusions")?)?),
            "project_overview" => out(h.overview(&s("projectId")?, arg(a, "rescan")?, cancel)?),
            "watch_project"
            | "unwatch_project"
            | "reveal_project_path"
            | "open_external"
            | "reveal_skill" => Ok(Value::Null),
            "read_project_excerpt" => {
                out(h.project_excerpt(&s("projectId")?, &s("path")?, arg(a, "line")?)?)
            }
            "declare" => out(h.declare(
                &s("projectId")?,
                &s("module")?,
                arg(a, "subject")?,
                arg(a, "present")?,
                arg(a, "note")?,
            )?),
            "retract" => out(h.retract(&s("projectId")?, &s("declarationId")?)?),

            "list_sources" => out(h.sources().list()?),
            "pick_library_folder" | "pick_import_folder" => Ok(match picked(a)? {
                Some(path) => json!(
                    std::fs::canonicalize(&path)
                        .map_err(|e| HabiError::io("opening the folder", e))?
                        .to_string_lossy()
                ),
                None => Value::Null,
            }),
            "add_source" => out(h.sources().add(&arg(a, "source")?)?),
            "remove_source" => out(h.sources().remove(&s("sourceId")?)?),
            "set_source_role" => out(h.sources().set_role(&s("sourceId")?, arg(a, "role")?)?),
            "refresh_source" => out(h.sources().refresh(&s("sourceId")?, cancel)?),
            "library" => out(h.sources().index(&s("sourceId")?)?),
            "item_detail" => out(h.item_detail(&s("sourceId")?, &s("itemId")?)?),
            "item_file" => out(h.read_item_file(&s("sourceId")?, &s("itemId")?, &s("path")?)?),

            "plan_install" => out(h.plan_install(
                &s("projectId")?,
                &arg::<Vec<_>>(a, "items")?,
                &arg::<Vec<_>>(a, "clients")?,
                arg(a, "includeMcp")?,
                &arg(a, "decisions")?,
            )?),
            "plan_update" => out(h.plan_update(
                &s("projectId")?,
                &arg::<Vec<String>>(a, "keys")?,
                &arg(a, "decisions")?,
            )?),
            "plan_remove" => out(h.plan_remove(
                &s("projectId")?,
                &arg::<Vec<String>>(a, "keys")?,
                &arg(a, "decisions")?,
            )?),
            "plan_restore" => {
                out(h.plan_restore(&s("projectId")?, &s("operationId")?, &arg(a, "decisions")?)?)
            }
            "apply_plan" => out(h.apply(&s("planId")?)?),
            "history" => out(h.history(&s("projectId")?)?),
            "recover" => out(h.recover(&s("projectId")?)?),

            "prepare_check" => out(h.prepare_check(
                &s("projectId")?,
                &s("itemKey")?,
                &s("checkId")?,
                &s("module")?,
                &arg(a, "bindings")?,
            )?),
            "run_check" => out(h.run_check(&s("projectId")?, &s("previewId")?, cancel)?),
            "check_runs" => out(h.check_runs(&s("projectId")?, &s("itemKey")?)?),

            "start_contribution" => out(h.start_contribution(&s("sourceId")?, arg(a, "origin")?)?),
            "contribution" => out(h.contributions().preview(&s("id")?)?),
            "list_contributions" => out(h.contributions().list()?),
            "update_contribution" => out(h.update_contribution(
                &s("id")?,
                &s("title")?,
                &s("message")?,
                &arg(a, "form")?,
            )?),
            "select_contribution_files" => {
                out(h.select_contribution_files(&s("id")?, &arg::<Vec<String>>(a, "excluded")?)?)
            }
            "record_contribution_lineage" => {
                out(h.record_contribution_lineage(&s("id")?, arg(a, "record")?)?)
            }
            "commit_contribution" => out(h.commit_contribution_with(
                &s("id")?,
                a.get("buildOnRemote")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                cancel,
            )?),
            "revise_contribution" => out(h.revise_contribution_with(&s("id")?, cancel)?),
            "cancel_contribution_revision" => out(h.cancel_contribution_revision(&s("id")?)?),
            "refresh_contribution_review" => out(h.refresh_contribution_review(&s("id")?, cancel)?),
            "contribution_rehearsal" => out(h.contribution_rehearsal(&s("id")?, cancel)?),
            "export_contribution" => match picked(a)? {
                Some(dir) => {
                    let path = h.contributions().export_patch(&s("id")?, &dir, cancel)?;
                    Ok(json!(habi_core::paths::display_path(&path)))
                }
                None => Ok(Value::Null),
            },
            "publish_contribution" => {
                out(h.publish_contribution(&s("id")?, arg(a, "openRequest")?, cancel)?)
            }
            "discard_contribution" => out(h.contributions().discard(&s("id")?)?),

            "list_skills" => out(h.skills().list()?),
            "get_skill" => out(h.skills().get(&s("id")?)?),
            "create_skill" => out(h.create_skill(
                &arg(a, "skill")?,
                arg::<Option<String>>(a, "projectId")?.as_deref(),
            )?),
            "save_skill_document" => out(h.skills().save_document(
                &s("id")?,
                &s("title")?,
                &arg(a, "document")?,
                arg::<Option<String>>(a, "baseDigest")?.as_deref(),
            )?),
            "save_skill_applicability" => out(h.skills().save_applicability(
                &s("id")?,
                &arg(a, "form")?,
                arg::<Option<String>>(a, "baseDigest")?.as_deref(),
            )?),
            "save_skill_metadata" => out(h.skills().save_metadata_text(
                &s("id")?,
                &s("text")?,
                arg::<Option<String>>(a, "baseDigest")?.as_deref(),
            )?),
            "read_skill_file" => out(h.skills().read_file(&s("id")?, &s("path")?)?),
            "write_skill_file" => out(h.skills().write_file(
                &s("id")?,
                &s("path")?,
                &s("text")?,
                arg::<Option<String>>(a, "baseDigest")?.as_deref(),
            )?),
            "remove_skill_path" => out(h.skills().remove_path(&s("id")?, &s("path")?)?),
            "rename_skill_path" => {
                out(h.skills().rename_path(&s("id")?, &s("from")?, &s("to")?)?)
            }
            "set_skill_file_executable" => {
                out(h
                    .skills()
                    .set_executable(&s("id")?, &s("path")?, arg(a, "executable")?)?)
            }
            "replace_skill_file" => match picked(a)? {
                Some(file) => out(Some(h.skills().replace_file(
                    &s("id")?,
                    &s("path")?,
                    &file,
                )?)),
                None => Ok(Value::Null),
            },
            "open_skill_file" => out(h.skills().file_path(&s("id")?, &s("path")?).map(|_| ())?),
            "add_skill_files" => match picked(a)? {
                Some(file) => out(Some(h.skills().add_files(
                    &s("id")?,
                    &s("folder")?,
                    &[file],
                )?)),
                None => Ok(Value::Null),
            },
            "trash_skill" => out(h.skills().trash(&s("id")?)?),
            "restore_skill" => out(h.skills().restore(&s("id")?)?),
            "purge_skill" => out(h.skills().purge(&s("id")?)?),
            "export_skill" => match picked(a)? {
                Some(dir) => {
                    let path = h.skills().export(&s("id")?, &dir)?;
                    Ok(json!(habi_core::paths::display_path(&path)))
                }
                None => Ok(Value::Null),
            },
            "preview_skill" => out(h.preview_skill(&arg(a, "request")?, cancel)?),
            "suggest_conditions" => out(h.suggest_conditions(&s("projectId")?)?),
            "discover_project" => out(h.discover(&s("projectId")?, cancel)?),
            "read_instructions" => out(h.read_instructions(&s("projectId")?, &s("path")?)?),
            "create_skill_from_instructions" => out(h.create_skill_from_instructions(
                &s("projectId")?,
                &s("path")?,
                arg(a, "startLine")?,
                arg(a, "endLine")?,
                &s("title")?,
            )?),
            "inspect_import" => out(h.inspect_import(&arg(a, "from")?, cancel)?),
            "import_skills" => {
                out(h.import_skills(&arg(a, "from")?, &arg::<Vec<_>>(a, "selections")?, cancel)?)
            }
            "skill_upstream" => out(h.skill_upstream(&s("id")?)?),
            "plan_upstream_sync" => out(h.plan_upstream_sync(&s("id")?)?),
            "apply_upstream_sync" => {
                out(h.apply_upstream_sync(&s("id")?, &s("token")?, &arg(a, "decisions")?)?)
            }

            "diagnostics_preview" => out(habi_core::diagnostics::bundle(h, version)?),
            "diagnostics_save" => Ok(Value::Null),
            "create_sample_workspace" => out(habi_core::sample::create(h, &self.samples)?),
            "remove_sample_workspace" => out(habi_core::sample::remove(h)?),
            "free_up_space" => out(h.prune()?),
            other => Err(HabiError::Unsupported(format!(
                "“{other}” is not available through the development bridge"
            ))),
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn handle(bridge: &Bridge, mut stream: TcpStream) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut length = 0usize;
    let mut trusted = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("x-habi-bridge:") {
            trusted = true;
        }
    }
    if !request_line.starts_with("POST /invoke") || !trusted || length > 8 * 1024 * 1024 {
        respond(&mut stream, "403 Forbidden", "{}");
        return;
    }
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let reply = match serde_json::from_slice::<Value>(&body) {
        Ok(request) => {
            let cmd = request.get("cmd").and_then(Value::as_str).unwrap_or("");
            let args = request.get("args").cloned().unwrap_or(json!({}));
            match bridge.dispatch(cmd, &args) {
                Ok(value) => json!({ "ok": value }),
                Err(e) => json!({ "err": e.to_info() }),
            }
        }
        Err(e) => {
            json!({ "err": ErrorInfo { code: "invalidInput".into(), message: e.to_string() } })
        }
    };
    respond(&mut stream, "200 OK", &reply.to_string());
}

fn main() {
    let port = std::env::var("HABI_BRIDGE_PORT").unwrap_or_else(|_| "1430".into());
    let habi = Habi::from_env().expect("could not open Habi's data directory");
    let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    println!(
        "Habi development bridge on http://127.0.0.1:{port} — data in {}",
        habi.paths.root.display()
    );
    let bridge = Arc::new(Bridge {
        habi,
        jobs: Mutex::new(HashMap::new()),
        samples,
    });
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("could not bind");
    for stream in listener.incoming().flatten() {
        let bridge = bridge.clone();
        std::thread::spawn(move || handle(&bridge, stream));
    }
}
