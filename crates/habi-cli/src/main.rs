//! `habi` — the command-line interface. Every command calls the same
//! `habi_core::service::Habi` methods as the desktop app.
//!
//! Output contract: with `--json`, every command prints exactly one JSON
//! document on stdout — the result, or `{"error": {"code", "message"}}` with
//! a nonzero exit status. Prompts and notes always go to stderr.

mod output;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use habi_core::cancel::CancelToken;
use habi_core::clients::ClientId;
use habi_core::contribute::{Contribution, ContributionOrigin};
use habi_core::error::HabiError;
use habi_core::install::plan::{Decisions, Plan, Resolution};
use habi_core::install::status::InstallState;
use habi_core::library::model::LibraryItem;
use habi_core::matching::eval::{Declaration, DeclaredSubject};
use habi_core::paths::display_path;
use habi_core::service::{Habi, ItemRef, ProjectRecord};
use habi_core::source::{NewSource, SourceRole, TrackedRef};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

const QUICK_START: &str = "\
Quick start:
  habi source add Team https://github.com/your-team/skills.git   # or a local folder
  habi source refresh
  habi recommend                     # in your project folder (or pass -C <project>)";

#[derive(Parser)]
#[command(
    name = "habi",
    version,
    about = "Find what applies. Improve what works. Share what you learn.",
    after_help = QUICK_START
)]
struct Cli {
    /// Print exactly one JSON document on stdout (errors too). Commands that
    /// change files then need --yes (or --dry-run).
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage libraries: your team's and community ones (sources of skills and workflows).
    #[command(subcommand)]
    Source(SourceCmd),
    /// Public skill libraries Habi suggests: look inside before you connect one.
    #[command(subcommand)]
    Catalog(CatalogCmd),
    /// Show what Habi detects in a project, with evidence.
    Inspect(ProjectArg),
    /// List the skills and workflows that fit a project, from every library and My skills.
    Recommend {
        #[command(flatten)]
        project: ProjectArg,
        /// Also list items that do not apply, and items without applicability
        /// rules that are not installed.
        #[arg(long)]
        all: bool,
    },
    /// Explain why an item fits (or does not fit) a project.
    Explain {
        /// Item id (see `habi recommend`), or `<library>/<id>` when several
        /// libraries have it.
        item: String,
        #[command(flatten)]
        project: ProjectArg,
    },
    /// Preview and install items into a project.
    #[command(after_help = "\
Examples:
  habi install liquibase-migration-review --client claude-code
  habi install Team/jpa-entity-review --client claude-code,cursor -C ~/code/billing
  habi install jpa-entity-review --client codex --dry-run     # preview only")]
    Install {
        /// Item ids (see `habi recommend`), or `<library>/<id>`.
        #[arg(required = true)]
        items: Vec<String>,
        #[command(flatten)]
        project: ProjectArg,
        /// Agent tools to install for (comma-separated): claude-code, cursor, codex, gemini-cli, copilot, opencode, junie.
        /// Default: the tools this project already uses, judged by its root: .claude/ or CLAUDE.md,
        /// .cursor/ or .cursorrules, .codex/, .gemini/ or GEMINI.md,
        /// .github/copilot-instructions.md or .github/skills/, .opencode/, opencode.json or
        /// opencode.jsonc, .junie/.
        #[arg(long, value_delimiter = ',')]
        client: Vec<String>,
        /// Also add suggested MCP server configuration.
        #[arg(long)]
        mcp: bool,
        #[command(flatten)]
        apply: ApplyArgs,
    },
    /// Show installed items, local edits and available updates.
    Status(ProjectArg),
    /// Preview and adopt library updates for installed items.
    Update {
        /// Installed item ids to update (default: every item with an update).
        items: Vec<String>,
        /// Also add MCP servers an item suggests now but did not when it was installed.
        #[arg(long)]
        mcp: bool,
        #[command(flatten)]
        project: ProjectArg,
        #[command(flatten)]
        apply: ApplyArgs,
    },
    /// Preview and remove installed items.
    Remove {
        /// Installed item ids to remove (see `habi status`).
        #[arg(required = true)]
        items: Vec<String>,
        #[command(flatten)]
        project: ProjectArg,
        #[command(flatten)]
        apply: ApplyArgs,
    },
    /// List operations Habi performed in a project.
    History(ProjectArg),
    /// Restore the files an operation changed.
    Restore {
        /// Operation id from `habi history` (the first 8 characters are enough).
        operation: String,
        #[command(flatten)]
        project: ProjectArg,
        #[command(flatten)]
        apply: ApplyArgs,
    },
    /// Roll back operations that were interrupted (a crash, or the process
    /// being killed); files changed since are left as they are and reported.
    Recover(ProjectArg),
    /// Correct a detected fact for a project (reversible with `habi undeclare`).
    #[command(after_help = "\
Examples:
  habi declare tag framework:spring-boot --present
  habi declare dependency org.liquibase:liquibase-core --absent --note \"removed last sprint\"
  habi declarations          # list them, with ids for `habi undeclare`")]
    Declare {
        /// What to declare: `tag` or `dependency`.
        kind: String,
        /// The tag (e.g. framework:spring-boot) or dependency (e.g. org.liquibase:liquibase-core).
        name: String,
        /// The fact holds for this project.
        #[arg(long, conflicts_with = "absent")]
        present: bool,
        /// The fact does not hold, whatever was detected.
        #[arg(long)]
        absent: bool,
        /// Which module the declaration is about: `*` = every module (default),
        /// `.` = the repository root module, or a module id from `habi inspect`.
        #[arg(long, default_value = "*")]
        module: String,
        /// Why (shown next to the declaration).
        #[arg(long)]
        note: Option<String>,
        #[command(flatten)]
        project: ProjectArg,
    },
    /// List a project's declarations.
    Declarations(ProjectArg),
    /// Remove a declaration (see `habi declarations` for ids).
    Undeclare {
        /// Declaration id from `habi declarations` (the first 8 characters are enough).
        id: String,
        #[command(flatten)]
        project: ProjectArg,
    },
    /// Preview or run an item's verification check (running executes repository code).
    Check {
        /// Item id (see `habi recommend`), or `<library>/<id>`.
        item: String,
        /// Check id (listed by `habi explain <item>`).
        check: String,
        /// Module to run the check in: `.` = the repository root module
        /// (default), or a module id from `habi inspect`.
        #[arg(long, default_value = ".")]
        module: String,
        /// Binding values, `name=value` (must be one of the listed candidates).
        #[arg(long = "bind")]
        bindings: Vec<String>,
        /// Run after showing the preview (asks for confirmation unless --yes).
        #[arg(long)]
        run: bool,
        /// Run without asking for confirmation.
        #[arg(long)]
        yes: bool,
        #[command(flatten)]
        project: ProjectArg,
    },
    /// Share what you improved back to a library, as a reviewed branch or request.
    #[command(subcommand)]
    Contribute(ContributeCmd),
    /// Validate a library folder (for maintainers).
    Validate {
        /// The library's root folder (the one containing skill folders with SKILL.md).
        path: PathBuf,
    },
    /// Write a redacted diagnostic report.
    Diagnostics {
        /// Write the report to this file instead of printing it.
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Free disk space: remove operation records and library snapshots
    /// beyond the newest 20 of each, and stored file versions nothing kept
    /// refers to. Unfinished operations and ones needing attention are kept.
    Gc,
}

#[derive(Args, Clone)]
struct ProjectArg {
    /// Project folder (default: the project containing the current folder —
    /// nearest `.habi/lock.json`, else the Git root, else the current folder).
    #[arg(long = "path", short = 'C')]
    path: Option<PathBuf>,
}

#[derive(Args, Clone)]
struct ApplyArgs {
    /// Apply without asking for confirmation.
    #[arg(long)]
    yes: bool,
    /// Keep the file on disk for a conflict (repeatable).
    #[arg(long)]
    keep: Vec<String>,
    /// Use Habi's version for a conflict (repeatable; previous content is journaled).
    #[arg(long)]
    overwrite: Vec<String>,
    /// Only show the preview; change nothing.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Subcommand)]
enum CatalogCmd {
    /// List the catalog, with what is known of each library.
    List,
    /// Fetch a library so you can see what is in it. Nothing is connected,
    /// installed or run. Opening one you fetched before downloads nothing.
    Preview {
        /// Catalog id (see `habi catalog list`).
        id: String,
        /// Check the repository for changes even if it was fetched before.
        #[arg(long)]
        refresh: bool,
        /// List every skill, with what Habi noticed in it.
        #[arg(long)]
        skills: bool,
    },
    /// Connect a catalog library as a community library (nothing is installed).
    Connect {
        /// Catalog id (see `habi catalog list`).
        id: String,
    },
    /// Discard a fetched preview. A connected library is not touched.
    Forget {
        /// Catalog id (see `habi catalog list`).
        id: String,
    },
}

#[derive(Subcommand)]
enum SourceCmd {
    /// Connect a library (does not fetch; run `habi source refresh` next).
    Add {
        /// A short name to refer to the library by (e.g. Team).
        name: String,
        /// Git URL (https/ssh) or a folder on this machine (relative paths are fine).
        location: String,
        /// Only use this folder inside the repository.
        #[arg(long)]
        subdir: Option<String>,
        /// Track this branch (default: the repository's default branch).
        #[arg(long, conflicts_with = "tag")]
        branch: Option<String>,
        /// Track this tag instead of a branch.
        #[arg(long)]
        tag: Option<String>,
        /// A community library (published by others, not reviewed by your team).
        #[arg(long)]
        community: bool,
    },
    /// Mark a library as your team's own or as a community library.
    Role {
        /// Library name (see `habi source list`).
        name: String,
        /// `team` or `community`.
        #[arg(value_parser = ["team", "community"])]
        role: String,
    },
    /// List connected libraries.
    List,
    /// Fetch new content (never changes projects).
    Refresh {
        /// Library name (default: all).
        name: Option<String>,
    },
    /// Disconnect a library (installed copies in projects are kept).
    Remove {
        /// Library name (see `habi source list`).
        name: String,
    },
    /// List the items in a library.
    Items {
        /// Library name (see `habi source list`).
        name: String,
    },
}

#[derive(Subcommand)]
enum ContributeCmd {
    /// Start a contribution from a skill folder in a project, or `--item` from the library.
    #[command(after_help = "\
Examples:
  habi contribute start Team .claude/skills/my-skill        # a skill in this project
  habi contribute start Team --item jpa-entity-review       # improve a library item
Then: habi contribute show <id>  →  edit the files  →  habi contribute commit <id>
      →  habi contribute publish <id> --open-request")]
    Start {
        /// Library to contribute to (see `habi source list`).
        source: String,
        /// Project-relative skill folder (e.g. .claude/skills/my-skill).
        folder: Option<String>,
        /// Library item id to improve, instead of a project folder.
        #[arg(long)]
        item: Option<String>,
        #[command(flatten)]
        project: ProjectArg,
    },
    /// List contributions.
    List,
    /// Show a contribution: what would leave this machine and where to edit it.
    Show {
        /// Contribution id (see `habi contribute list`).
        id: String,
    },
    /// Set the title and/or message (unchanged when omitted).
    Describe {
        /// Contribution id.
        id: String,
        /// New title.
        #[arg(long)]
        title: Option<String>,
        /// New message for reviewers.
        #[arg(long)]
        message: Option<String>,
    },
    /// Leave changed files out of the contribution; they keep the library's
    /// version.
    Exclude {
        /// Contribution id.
        id: String,
        /// Paths in the skill folder (or library paths), as `show` lists them.
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Put files left out with `exclude` back into the contribution.
    Include {
        /// Contribution id.
        id: String,
        /// Paths in the skill folder (or library paths).
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Commit the contribution on a branch in Habi's cache (nothing is pushed).
    Commit {
        /// Contribution id.
        id: String,
        /// For a revision whose branch someone else pushed to: build on their
        /// commits instead of stopping.
        #[arg(long)]
        build_on_remote: bool,
    },
    /// Read the review request's state and comments from the Git host
    /// (through `gh` or `glab`).
    Status {
        /// Contribution id.
        id: String,
    },
    /// Show where the contribution's rules apply among your projects, as
    /// text you can add to the message for reviewers. Nothing is sent.
    Rehearse {
        /// Contribution id.
        id: String,
    },
    /// Reopen a sent contribution to change it after review. For a skill from
    /// a project or My skills, edit it there first: revise copies it again.
    /// The next commit and publish update the same branch and request.
    Revise {
        /// Contribution id.
        id: String,
    },
    /// Undo `revise`: go back to the version you sent, as if you had not
    /// started a revision.
    CancelRevision {
        /// Contribution id.
        id: String,
    },
    /// Write the committed contribution as a patch file.
    Export {
        /// Contribution id.
        id: String,
        /// Folder to write the patch into (created if missing).
        dir: PathBuf,
    },
    /// Push the contribution branch (and open a PR/MR with --open-request).
    Publish {
        /// Contribution id.
        id: String,
        /// Also open a pull/merge request (through `gh` or `glab`).
        #[arg(long)]
        open_request: bool,
        /// Push without asking for confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// Delete a contribution draft and its staging files.
    Discard {
        /// Contribution id.
        id: String,
    },
}

// ----- errors ---------------------------------------------------------------------

/// An error with a stable code, extra JSON fields, and an exit status.
#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
    data: Vec<(&'static str, Value)>,
    exit: i32,
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

fn fail(code: &str, message: impl Into<String>) -> anyhow::Error {
    CliError {
        code: code.into(),
        message: message.into(),
        data: Vec::new(),
        exit: 1,
    }
    .into()
}

fn fail_with(
    code: &str,
    message: impl Into<String>,
    key: &'static str,
    data: Value,
) -> anyhow::Error {
    CliError {
        code: code.into(),
        message: message.into(),
        data: vec![(key, data)],
        exit: 1,
    }
    .into()
}

/// Reports an error (as JSON on stdout in JSON mode) and returns the exit status.
fn report(e: &anyhow::Error, json_mode: bool) -> i32 {
    let (code, message, data, exit) = if let Some(c) = e.downcast_ref::<CliError>() {
        (c.code.clone(), c.message.clone(), c.data.clone(), c.exit)
    } else if let Some(h) = e.downcast_ref::<HabiError>() {
        let exit = if matches!(h, HabiError::Cancelled) {
            130
        } else {
            1
        };
        (h.code().to_string(), h.to_info().message, Vec::new(), exit)
    } else {
        (
            "error".to_string(),
            habi_core::redact::redact(&format!("{e:#}")),
            Vec::new(),
            1,
        )
    };
    let message = output::cli_wording(&message);
    if json_mode {
        let mut doc = serde_json::Map::new();
        for (k, v) in data {
            doc.insert(k.to_string(), v);
        }
        doc.insert("error".into(), json!({ "code": code, "message": message }));
        print_json(&Value::Object(doc));
    } else {
        eprintln!("error: {message}");
    }
    exit
}

fn print_json(value: &Value) {
    match serde_json::to_string_pretty(value) {
        Ok(s) => println!("{s}"),
        Err(e) => println!("{{\"error\":{{\"code\":\"internal\",\"message\":\"{e}\"}}}}"),
    }
}

// ----- entry point ------------------------------------------------------------------

/// Set while an operation is being applied. Ctrl-C then waits for it to
/// finish: stopping part-way would leave the project half changed until the
/// next `habi recover`.
static APPLYING: AtomicBool = AtomicBool::new(false);
static INTERRUPTED: AtomicBool = AtomicBool::new(false);
/// Projects registered only for the running command (see `ProjectHandle`).
/// They are forgotten when the command ends, after Ctrl-C too.
static TEMPORARY: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn install_interrupt_handler(cancel: CancelToken) {
    let _ = ctrlc::set_handler(move || {
        if APPLYING.load(Ordering::SeqCst) {
            eprintln!(
                "\nFinishing the change in progress first: stopping part-way would leave the project half changed."
            );
            return;
        }
        if INTERRUPTED.swap(true, Ordering::SeqCst) {
            exit_interrupted();
        }
        eprintln!("\nInterrupted.");
        cancel.cancel();
        // Cancellable work stops at its next check; anything else (a prompt,
        // a blocking read) is ended shortly after.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            exit_interrupted();
        });
    });
}

/// Ends the process after Ctrl-C: once a change being applied is complete,
/// and after forgetting projects registered only for this command.
fn exit_interrupted() -> ! {
    while APPLYING.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let ids = std::mem::take(&mut *TEMPORARY.lock().unwrap_or_else(PoisonError::into_inner));
    if !ids.is_empty()
        && let Ok(habi) = Habi::from_env()
    {
        for id in ids {
            let _ = habi.forget_project(&id);
        }
    }
    std::process::exit(130);
}

fn init_logging() {
    // Quiet by default: people read messages, not logs. HABI_LOG overrides.
    let filter = std::env::var("HABI_LOG").unwrap_or_else(|_| "error".into());
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_target(false)
        .init();
}

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let json_requested = args.iter().any(|a| a == "--json");
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        Err(e) => {
            use clap::error::ErrorKind;
            let informational = matches!(
                e.kind(),
                ErrorKind::DisplayHelp
                    | ErrorKind::DisplayVersion
                    | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
            );
            if json_requested && !informational {
                let text = e.render().to_string();
                // The error and its details, without the usage and help lines.
                let message = text
                    .split("\n\n")
                    .next()
                    .unwrap_or("invalid arguments")
                    .trim_start_matches("error: ")
                    .lines()
                    .map(str::trim)
                    .collect::<Vec<_>>()
                    .join(" ");
                print_json(&json!({ "error": { "code": "usage", "message": message } }));
                eprint!("{text}");
                std::process::exit(2);
            }
            e.exit();
        }
    };
    init_logging();
    let cancel = CancelToken::new();
    install_interrupt_handler(cancel.clone());
    let json_mode = cli.json;
    let result = Habi::from_env()
        .context("opening Habi's local data")
        .and_then(|habi| {
            let ctx = Ctx {
                habi,
                json: json_mode,
                cancel,
            };
            run(&ctx, cli.command)
        });
    match result {
        Ok(value) => {
            if json_mode {
                print_json(&value);
            }
        }
        Err(e) => std::process::exit(report(&e, json_mode)),
    }
}

struct Ctx {
    habi: Habi,
    json: bool,
    cancel: CancelToken,
}

/// In JSON mode returns `value`; otherwise prints with `human` and returns null.
fn emit<T: Serialize + ?Sized>(ctx: &Ctx, value: &T, human: impl FnOnce()) -> Result<Value> {
    if ctx.json {
        Ok(serde_json::to_value(value)?)
    } else {
        human();
        Ok(Value::Null)
    }
}

/// A note for people (stderr, so JSON on stdout stays clean).
fn note(text: impl AsRef<str>) {
    eprintln!("{}", text.as_ref());
}

// ----- projects ----------------------------------------------------------------------

/// The project folder for a command. Without `-C`, the nearest folder (from
/// the current one upwards, up to the Git root) with `.habi/lock.json`, else
/// the Git root, else the current folder.
fn locate_project(arg: &ProjectArg) -> Result<PathBuf> {
    if let Some(p) = &arg.path {
        return Ok(p.clone());
    }
    let cwd = std::env::current_dir().context("reading the current folder")?;
    let cwd = habi_core::paths::canonical(&cwd).unwrap_or(cwd);
    let mut chosen = None;
    for dir in cwd.ancestors() {
        if dir.join(habi_core::brand::LOCK_FILE).is_file() {
            chosen = Some(dir.to_path_buf());
            break;
        }
        if dir.join(".git").exists() {
            chosen = Some(dir.to_path_buf());
            break;
        }
    }
    let root = chosen.unwrap_or_else(|| cwd.clone());
    if root != cwd {
        note(format!("Using project {}", display_path(&root)));
    }
    Ok(root)
}

/// A project for one command. Read-only commands on a folder Habi does not
/// know yet use it without adding it to the project list.
struct ProjectHandle<'a> {
    habi: &'a Habi,
    record: ProjectRecord,
    temporary: bool,
}

impl std::ops::Deref for ProjectHandle<'_> {
    type Target = ProjectRecord;
    fn deref(&self) -> &ProjectRecord {
        &self.record
    }
}

impl Drop for ProjectHandle<'_> {
    fn drop(&mut self) {
        if self.temporary {
            let _ = self.habi.forget_project(&self.record.id);
            self.keep();
        }
    }
}

impl ProjectHandle<'_> {
    /// ` -C <path>` for follow-up commands.
    fn flag(&self) -> String {
        c_flag(&self.record.root)
    }

    /// Keeps the project in Habi's project list after the command.
    fn keep(&mut self) {
        self.temporary = false;
        TEMPORARY
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|id| *id != self.record.id);
    }
}

fn c_flag(root: &Path) -> String {
    let shown = display_path(root);
    if shown.contains(|c: char| c.is_whitespace() || "'\"$`\\".contains(c)) {
        format!(" -C '{}'", shown.replace('\'', "'\\''"))
    } else {
        format!(" -C {shown}")
    }
}

/// `register`: the command changes the project (or records something about
/// it), so it is added to Habi's project list.
fn project<'a>(ctx: &'a Ctx, arg: &ProjectArg, register: bool) -> Result<ProjectHandle<'a>> {
    let root = locate_project(arg)?;
    let known = ctx.habi.find_project(&root)?;
    let (record, temporary) = match known {
        Some(_) if register => (ctx.habi.open_project(&root)?, false),
        Some(p) => (p, false),
        None => (ctx.habi.open_project(&root)?, !register),
    };
    if temporary {
        TEMPORARY
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(record.id.clone());
    }
    Ok(ProjectHandle {
        habi: &ctx.habi,
        record,
        temporary,
    })
}

// ----- lookups ------------------------------------------------------------------------

fn parse_clients(values: &[String]) -> Result<Vec<ClientId>> {
    values
        .iter()
        .map(|v| {
            ClientId::from_slug(v.trim()).ok_or_else(|| {
                fail(
                    "invalidInput",
                    format!(
                        "unknown client `{v}` (use claude-code, cursor, codex, gemini-cli, copilot, opencode or junie)"
                    ),
                )
            })
        })
        .collect()
}

fn source_by_name(habi: &Habi, name: &str) -> Result<habi_core::source::Source> {
    habi.sources()
        .list()?
        .into_iter()
        .find(|s| s.name.eq_ignore_ascii_case(name) || s.id == name)
        .ok_or_else(|| {
            fail(
                "notFound",
                format!("No library named `{name}`. List them with `habi source list`."),
            )
        })
}

fn not_fetched(name: &str) -> anyhow::Error {
    fail(
        "notFetched",
        format!("`{name}` hasn't been fetched yet. Run: habi source refresh {name}"),
    )
}

fn resolve_item(habi: &Habi, spec: &str) -> Result<(ItemRef, LibraryItem)> {
    let (source_filter, id) = match spec.split_once('/') {
        Some((s, i)) => (Some(s), i),
        None => (None, spec),
    };
    if let Some(f) = source_filter {
        let s = source_by_name(habi, f)?;
        if s.snapshot.is_none() {
            return Err(not_fetched(&s.name));
        }
    }
    let mut found = Vec::new();
    for (source, index) in habi.libraries()? {
        if let Some(f) = source_filter
            && !source.name.eq_ignore_ascii_case(f)
            && source.id != f
        {
            continue;
        }
        if let Some(item) = index.items.iter().find(|i| i.id == id) {
            found.push((source.name.clone(), source.id.clone(), item.clone()));
        }
    }
    match found.len() {
        0 => {
            let unfetched: Vec<String> = habi
                .sources()
                .list()?
                .into_iter()
                .filter(|s| s.snapshot.is_none())
                .map(|s| s.name)
                .collect();
            let mut message = format!(
                "No item `{spec}` in the connected libraries. List items with `habi source items <name>` or `habi recommend`."
            );
            if let Some(first) = unfetched.first() {
                message.push_str(&format!(
                    " (`{first}` hasn't been fetched yet. Run: habi source refresh {first})"
                ));
            }
            Err(fail("notFound", message))
        }
        1 => {
            let (_, source_id, item) = found.remove(0);
            Ok((
                ItemRef {
                    source_id,
                    item_id: id.to_string(),
                },
                item,
            ))
        }
        _ => Err(fail(
            "ambiguous",
            format!(
                "`{id}` exists in several libraries; use one of: {}",
                found
                    .iter()
                    .map(|(n, _, _)| format!("{n}/{id}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

fn decisions(args: &ApplyArgs) -> Decisions {
    let mut d = HashMap::new();
    for p in &args.keep {
        d.insert(p.clone(), Resolution::Keep);
    }
    for p in &args.overwrite {
        d.insert(p.clone(), Resolution::Overwrite);
    }
    d
}

/// Asks on the terminal. `action` names what is refused without a terminal.
fn confirm(question: &str, action: &str) -> Result<bool> {
    if !std::io::stdin().is_terminal() {
        return Err(fail(
            "confirmationRequired",
            format!("refusing to {action} without --yes (no terminal to ask on)"),
        ));
    }
    eprint!("{question} [y/N] ");
    std::io::stderr().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes"))
}

/// In JSON mode nothing is asked: changing files needs --yes.
fn require_yes(ctx: &Ctx, yes: bool, preview_only: bool, action: &str) -> Result<()> {
    if ctx.json && !yes && !preview_only {
        return Err(fail(
            "confirmationRequired",
            format!(
                "--json does not ask for confirmation: pass --yes to {action}, or --dry-run to preview only"
            ),
        ));
    }
    Ok(())
}

fn review_and_apply(
    ctx: &Ctx,
    plan: Plan,
    args: &ApplyArgs,
    project: &ProjectHandle,
    action: &str,
) -> Result<Value> {
    if !ctx.json {
        output::plan(&plan);
    }
    let plan_value = serde_json::to_value(&plan)?;
    if plan.is_blocked() {
        return Err(fail_with(
            "conflict",
            "resolve the conflicts with --keep <path> or --overwrite <path>, then run the command again",
            "plan",
            plan_value,
        ));
    }
    if plan.is_empty() || args.dry_run {
        return Ok(json!({ "plan": plan_value, "operation": null, "applied": false }));
    }
    if !args.yes && !confirm(&format!("{}?", plan.title), action)? {
        note("Nothing changed.");
        return Ok(json!({ "plan": plan_value, "operation": null, "applied": false }));
    }
    APPLYING.store(true, Ordering::SeqCst);
    let applied = ctx.habi.apply(&plan.id);
    APPLYING.store(false, Ordering::SeqCst);
    let op = applied?;
    if !ctx.json {
        println!(
            "Done. Operation {} ({}). Undo with: habi restore {}{}",
            &op.id[..8.min(op.id.len())],
            output::plural(op.files.len(), "file"),
            &op.id[..8.min(op.id.len())],
            project.flag()
        );
    }
    Ok(json!({ "plan": plan_value, "operation": op, "applied": true }))
}

/// (item id, lock key, state) of everything installed in the project.
fn installed(ctx: &Ctx, project: &ProjectRecord) -> Result<Vec<(String, String, InstallState)>> {
    let overview = ctx.habi.overview(&project.id, true, &ctx.cancel)?;
    let mut installed: Vec<(String, String, InstallState)> = overview
        .recommendations
        .iter()
        .filter_map(|r| {
            r.installation
                .as_ref()
                .map(|i| (r.item.id.clone(), i.key.clone(), i.state))
        })
        .collect();
    installed.extend(
        overview
            .orphaned
            .iter()
            .map(|i| (i.id.clone(), i.key.clone(), i.state)),
    );
    Ok(installed)
}

fn pick_installed<'a>(
    installed: &'a [(String, String, InstallState)],
    spec: &str,
) -> Result<&'a (String, String, InstallState)> {
    let id = spec.rsplit('/').next().unwrap_or(spec);
    installed
        .iter()
        .find(|(i, k, _)| i == id || k == spec)
        .ok_or_else(|| {
            fail(
                "notFound",
                format!(
                    "`{spec}` is not installed in this project. See what is with `habi status`."
                ),
            )
        })
}

fn has_update(state: InstallState) -> bool {
    matches!(
        state,
        InstallState::UpdateAvailable | InstallState::Conflict
    )
}

// ----- commands -------------------------------------------------------------------------

fn run(ctx: &Ctx, command: Command) -> Result<Value> {
    let habi = &ctx.habi;
    match command {
        Command::Source(cmd) => source(ctx, cmd),
        Command::Catalog(cmd) => catalog(ctx, cmd),
        Command::Inspect(p) => {
            let project = project(ctx, &p, false)?;
            let inspection = habi.inspect(&project.id, true, &ctx.cancel)?;
            emit(ctx, &inspection, || output::inspection(&inspection))
        }
        Command::Recommend { project: p, all } => {
            let project = project(ctx, &p, false)?;
            let overview = habi.overview(&project.id, true, &ctx.cancel)?;
            emit(ctx, &overview.recommendations, || {
                output::recommendations(&overview, all)
            })
        }
        Command::Explain { item, project: p } => {
            let project = project(ctx, &p, false)?;
            let (r, library_item) = resolve_item(habi, &item)?;
            let overview = habi.overview(&project.id, true, &ctx.cancel)?;
            let rec = overview
                .recommendations
                .iter()
                .find(|x| x.item.source_id == r.source_id && x.item.id == r.item_id)
                .ok_or_else(|| fail("notFound", format!("No item `{item}` for this project.")))?;
            emit(ctx, rec, || output::explain(rec, Some(&library_item)))
        }
        Command::Install {
            items,
            project: p,
            client,
            mcp,
            apply,
        } => {
            require_yes(ctx, apply.yes, apply.dry_run, "install")?;
            let refs = items
                .iter()
                .map(|i| resolve_item(habi, i).map(|(r, _)| r))
                .collect::<Result<Vec<_>>>()?;
            let project = project(ctx, &p, !apply.dry_run)?;
            let clients = if client.is_empty() {
                let found = habi_core::clients::in_project(&project.root);
                if found.is_empty() {
                    return Err(fail(
                        "invalidInput",
                        format!(
                            "Which agent tools should get it? Habi found none set up in this project.\nAdd --client with one or more of: claude-code, cursor, codex, gemini-cli, copilot, opencode, junie (e.g. `habi install {} --client claude-code`).",
                            items.join(" ")
                        ),
                    ));
                }
                note(format!(
                    "Installing for {} (already set up in this project). Choose others with --client.",
                    found
                        .iter()
                        .map(|c| c.label())
                        .collect::<Vec<_>>()
                        .join(" and ")
                ));
                found
            } else {
                parse_clients(&client)?
            };
            let plan = habi.plan_install(&project.id, &refs, &clients, mcp, &decisions(&apply))?;
            review_and_apply(ctx, plan, &apply, &project, "install")
        }
        Command::Status(p) => {
            let project = project(ctx, &p, false)?;
            let overview = habi.overview(&project.id, true, &ctx.cancel)?;
            let installed: Vec<_> = overview
                .recommendations
                .iter()
                .filter_map(|r| r.installation.clone())
                .chain(overview.orphaned.iter().cloned())
                .collect();
            emit(ctx, &installed, || output::status(&overview))
        }
        Command::Update {
            items,
            mcp,
            project: p,
            apply,
        } => {
            require_yes(ctx, apply.yes, apply.dry_run, "update")?;
            let mut project = project(ctx, &p, false)?;
            let installed = installed(ctx, &project)?;
            if installed.is_empty() {
                return emit(
                    ctx,
                    &json!({ "plan": null, "operation": null, "applied": false, "upToDate": true }),
                    || println!("Nothing is installed by Habi in this project."),
                );
            }
            let mut keys = Vec::new();
            if items.is_empty() {
                keys.extend(
                    installed
                        .iter()
                        .filter(|(_, _, s)| has_update(*s))
                        .map(|(_, k, _)| k.clone()),
                );
            } else {
                for spec in &items {
                    let (id, key, state) = pick_installed(&installed, spec)?;
                    if has_update(*state) {
                        keys.push(key.clone());
                    } else {
                        note(format!(
                            "`{id}` has no update ({}).",
                            output::install_state(*state)
                        ));
                    }
                }
            }
            if keys.is_empty() {
                return emit(
                    ctx,
                    &json!({ "plan": null, "operation": null, "applied": false, "upToDate": true }),
                    || println!("Everything is up to date."),
                );
            }
            // Applying changes the project: keep it in Habi's project list.
            if !apply.dry_run {
                project.keep();
            }
            let plan = habi.plan_update(&project.id, &keys, mcp, &decisions(&apply))?;
            review_and_apply(ctx, plan, &apply, &project, "update")
        }
        Command::Remove {
            items,
            project: p,
            apply,
        } => {
            require_yes(ctx, apply.yes, apply.dry_run, "remove")?;
            let project = project(ctx, &p, !apply.dry_run)?;
            let installed = installed(ctx, &project)?;
            let keys = items
                .iter()
                .map(|spec| pick_installed(&installed, spec).map(|(_, k, _)| k.clone()))
                .collect::<Result<Vec<_>>>()?;
            let plan = habi.plan_remove(&project.id, &keys, &decisions(&apply))?;
            review_and_apply(ctx, plan, &apply, &project, "remove")
        }
        Command::History(p) => {
            let project = project(ctx, &p, false)?;
            let history = habi.history(&project.id)?;
            emit(ctx, &history, || output::history(&history))
        }
        Command::Restore {
            operation,
            project: p,
            apply,
        } => {
            require_yes(ctx, apply.yes, apply.dry_run, "restore")?;
            let wanted = operation.trim();
            if wanted.len() < 4 {
                return Err(fail(
                    "invalidInput",
                    "give at least the first 4 characters of the operation id (see `habi history`)",
                ));
            }
            let project = project(ctx, &p, !apply.dry_run)?;
            let matches: Vec<_> = habi
                .history(&project.id)?
                .into_iter()
                .filter(|o| o.id.starts_with(wanted))
                .collect();
            let full = match matches.len() {
                0 => {
                    return Err(fail(
                        "notFound",
                        format!(
                            "No operation `{wanted}` in {}. List them with `habi history{}`.",
                            project.path,
                            project.flag()
                        ),
                    ));
                }
                1 => &matches[0],
                _ => {
                    return Err(fail(
                        "ambiguous",
                        format!("`{wanted}` matches several operations; give more characters"),
                    ));
                }
            };
            let plan = habi.plan_restore(&project.id, &full.id, &decisions(&apply))?;
            review_and_apply(ctx, plan, &apply, &project, "restore")
        }
        Command::Recover(p) => {
            let project = project(ctx, &p, true)?;
            let recovered = habi.recover(&project.id)?;
            emit(ctx, &recovered, || {
                if recovered.is_empty() {
                    println!("No interrupted operations.");
                }
                for op in &recovered {
                    println!("{} → {}", op.title, output::journal_state(op.state));
                    for problem in &op.problems {
                        println!("  ! {problem}");
                    }
                }
            })
        }
        Command::Declare {
            kind,
            name,
            present,
            absent,
            module,
            note: why,
            project: p,
        } => {
            if present == absent {
                return Err(fail(
                    "invalidInput",
                    "pass exactly one of --present or --absent",
                ));
            }
            let subject = match kind.as_str() {
                "tag" => DeclaredSubject::Tag { tag: name },
                "dependency" | "dep" => DeclaredSubject::Dependency { name },
                other => {
                    return Err(fail(
                        "invalidInput",
                        format!("unknown kind `{other}` (use tag or dependency)"),
                    ));
                }
            };
            let project = project(ctx, &p, true)?;
            let d = habi.declare(&project.id, &module, subject, present, why)?;
            emit(ctx, &d, || {
                println!(
                    "Declared {} {} for {} in {}.\nRemove with: habi undeclare {}{}",
                    output::subject(&d.subject),
                    if present { "present" } else { "absent" },
                    output::module(&d.module),
                    project.path,
                    &d.id[..8.min(d.id.len())],
                    project.flag()
                )
            })
        }
        Command::Declarations(p) => {
            let root = locate_project(&p)?;
            let list = match habi.find_project(&root)? {
                Some(project) => habi.declarations(&project.id)?,
                None => Vec::new(),
            };
            emit(ctx, &list, || output::declarations(&list, &c_flag(&root)))
        }
        Command::Undeclare { id, project: p } => {
            let root = locate_project(&p)?;
            let wanted = id.trim();
            let found = match habi.find_project(&root)? {
                Some(project) => find_declaration(habi, &project.id, wanted)?.map(|d| (project, d)),
                None => None,
            };
            let Some((project, d)) = found else {
                return Err(missing_declaration(habi, wanted, &root));
            };
            habi.retract(&project.id, &d.id)?;
            emit(ctx, &json!({ "removed": d }), || {
                println!(
                    "Removed the declaration ({} {} for {}).",
                    output::subject(&d.subject),
                    if d.present { "present" } else { "absent" },
                    output::module(&d.module)
                )
            })
        }
        Command::Check {
            item,
            check,
            module,
            bindings,
            run,
            yes,
            project: p,
        } => {
            if run {
                require_yes(ctx, yes, false, "run the check")?;
            }
            let (r, library_item) = resolve_item(habi, &item)?;
            if !library_item.checks.iter().any(|c| c.id == check) {
                let ids: Vec<&str> = library_item.checks.iter().map(|c| c.id.as_str()).collect();
                return Err(fail(
                    "notFound",
                    if ids.is_empty() {
                        format!("`{}` has no checks.", library_item.title)
                    } else {
                        format!(
                            "`{}` has no check `{check}`. Available checks: {}",
                            library_item.title,
                            ids.join(", ")
                        )
                    },
                ));
            }
            let mut values = HashMap::new();
            for b in bindings {
                let (k, v) = b.split_once('=').ok_or_else(|| {
                    fail(
                        "invalidInput",
                        format!("`--bind {b}`: bindings look like name=value"),
                    )
                })?;
                values.insert(k.to_string(), v.to_string());
            }
            let project = project(ctx, &p, run)?;
            let key = format!("{}/{}", r.source_id, r.item_id);
            let preview = habi.prepare_check(&project.id, &key, &check, &module, &values)?;
            if !ctx.json {
                output::check_preview(&preview);
            }
            if !run {
                return emit(ctx, &json!({ "preview": preview, "run": null }), || {
                    let module_flag = if module == "." {
                        String::new()
                    } else {
                        format!(" --module {module}")
                    };
                    println!(
                        "\nRun it with: habi check {item} {check}{module_flag} --run{}",
                        project.flag()
                    )
                });
            }
            if !preview.ready {
                return Err(fail_with(
                    "notReady",
                    "the check is not ready to run: pass --bind <name>=<value> for every binding and make sure the program is installed",
                    "preview",
                    serde_json::to_value(&preview)?,
                ));
            }
            if !yes && !confirm("Run this command?", "run the check")? {
                note("Nothing was run.");
                return Ok(Value::Null);
            }
            let result = habi.run_check(&project.id, &preview.preview_id, &ctx.cancel)?;
            emit(ctx, &json!({ "preview": preview, "run": result }), || {
                output::check_run(&result)
            })
        }
        Command::Contribute(cmd) => contribute(ctx, cmd),
        Command::Validate { path } => validate(ctx, &path),
        Command::Diagnostics { output: out } => {
            let bundle = habi_core::diagnostics::bundle(habi, env!("CARGO_PKG_VERSION"))?;
            match out {
                Some(path) => {
                    std::fs::write(&path, &bundle.text)
                        .with_context(|| format!("writing {}", path.display()))?;
                    emit(ctx, &json!({ "path": path }), || {
                        println!("Wrote {}", path.display())
                    })
                }
                None => emit(ctx, &bundle, || print!("{}", bundle.text)),
            }
        }
        Command::Gc => {
            let report = habi.prune()?;
            emit(ctx, &report, || output::prune_report(&report))
        }
    }
}

/// A declaration by id or unambiguous id prefix (at least 4 characters).
fn find_declaration(habi: &Habi, project: &str, wanted: &str) -> Result<Option<Declaration>> {
    if wanted.len() < 4 {
        return Ok(None);
    }
    let mut matches: Vec<Declaration> = habi
        .declarations(project)?
        .into_iter()
        .filter(|d| d.id.starts_with(wanted))
        .collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => Err(fail(
            "ambiguous",
            format!("`{wanted}` matches several declarations; give more characters"),
        )),
    }
}

fn missing_declaration(habi: &Habi, wanted: &str, root: &Path) -> anyhow::Error {
    let mut message = format!(
        "No declaration `{wanted}` in {}. Declarations are per project; pass -C <project>.",
        display_path(root)
    );
    // Say where it is, if it belongs to another project Habi knows.
    if let Ok(projects) = habi.recent_projects() {
        for p in projects {
            if let Ok(Some(_)) = find_declaration(habi, &p.id, wanted) {
                message.push_str(&format!(
                    " It belongs to {}: habi undeclare {wanted}{}",
                    p.path,
                    c_flag(&p.root)
                ));
                break;
            }
        }
    }
    fail("notFound", message)
}

/// A folder given on the command line as an absolute path. URLs and
/// `host:path` locations are passed through unchanged.
fn local_location(location: &str) -> Result<String> {
    let looks_remote = location.contains("://")
        || location
            .split_once(':')
            .is_some_and(|(host, _)| host.len() > 1 && !host.contains('/') && !host.contains('\\'));
    let path = Path::new(location);
    if looks_remote || path.is_absolute() || location.starts_with("~/") {
        return Ok(location.to_string());
    }
    habi_core::paths::canonical(path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| {
            let cwd = std::env::current_dir().unwrap_or_default();
            fail(
                "notFound",
                format!(
                    "No folder `{location}` (looked in {}). Give a Git URL or a folder path.",
                    display_path(&cwd)
                ),
            )
        })
}

fn catalog(ctx: &Ctx, cmd: CatalogCmd) -> Result<Value> {
    let habi = &ctx.habi;
    match cmd {
        CatalogCmd::List => {
            let entries = habi.catalog().entries()?;
            emit(ctx, &entries, || output::catalog_list(&entries))
        }
        CatalogCmd::Preview {
            id,
            refresh,
            skills,
        } => {
            let entry = habi.catalog().preview(&id, refresh, &ctx.cancel)?;
            if ctx.json && skills {
                let index = match &entry.source_id {
                    Some(source) => Some(habi.sources().index(source)?),
                    None => None,
                };
                return Ok(json!({ "entry": entry, "library": index }));
            }
            let index = match (&entry.source_id, skills) {
                (Some(source), true) => Some(habi.sources().index(source)?),
                _ => None,
            };
            emit(ctx, &entry, || {
                output::catalog_entry(&entry, index.as_ref())
            })
        }
        CatalogCmd::Connect { id } => {
            let source = habi.catalog().connect(&id, &ctx.cancel)?;
            emit(ctx, &source, || {
                println!(
                    "Connected `{}` as a community library. Nothing was installed.",
                    source.name
                )
            })
        }
        CatalogCmd::Forget { id } => {
            habi.catalog().forget(&id)?;
            emit(ctx, &json!({ "forgotten": id }), || {
                println!("Discarded the fetched copy of `{id}`.")
            })
        }
    }
}

fn source(ctx: &Ctx, cmd: SourceCmd) -> Result<Value> {
    let habi = &ctx.habi;
    match cmd {
        SourceCmd::Add {
            name,
            location,
            subdir,
            branch,
            tag,
            community,
        } => {
            let tracked = match (branch, tag) {
                (Some(b), _) => TrackedRef::Branch { name: b },
                (_, Some(t)) => TrackedRef::Tag { name: t },
                _ => TrackedRef::Default,
            };
            let s = habi.sources().add(&NewSource {
                name,
                location: local_location(&location)?,
                subdir,
                tracked,
            })?;
            let s = if community {
                habi.sources().set_role(&s.id, SourceRole::Community)?
            } else {
                s
            };
            emit(ctx, &s, || {
                println!(
                    "Connected `{}`. Fetch it with: habi source refresh {}",
                    s.name,
                    shell_word(&s.name)
                )
            })
        }
        SourceCmd::List => {
            let list = habi.sources().list()?;
            emit(ctx, &list, || output::sources(&list))
        }
        SourceCmd::Refresh { name } => {
            let targets = match name {
                Some(n) => vec![source_by_name(habi, &n)?],
                None => habi.sources().list()?,
            };
            if targets.is_empty() {
                return emit(ctx, &json!({ "refreshed": [], "failed": [] }), || {
                    println!("No libraries connected. Add one with: habi source add <name> <url>")
                });
            }
            let mut refreshed = Vec::new();
            let mut failed = Vec::new();
            for s in targets {
                match habi.sources().refresh(&s.id, &ctx.cancel) {
                    Ok(r) => {
                        if !ctx.json {
                            output::refresh(&r);
                        }
                        refreshed.push(r);
                    }
                    Err(HabiError::Cancelled) => return Err(HabiError::Cancelled.into()),
                    Err(e) => {
                        let info = e.to_info();
                        if !ctx.json {
                            eprintln!(
                                "{}: refresh failed: {} — the cached copy is kept.",
                                s.name, info.message
                            );
                        }
                        failed.push(json!({ "source": s.name, "error": info }));
                    }
                }
            }
            let doc = json!({ "refreshed": refreshed, "failed": failed });
            if !failed.is_empty() {
                let mut e = CliError {
                    code: "refreshFailed".into(),
                    message: "some libraries could not be refreshed".into(),
                    data: Vec::new(),
                    exit: 1,
                };
                e.data.push(("refreshed", doc["refreshed"].clone()));
                e.data.push(("failed", doc["failed"].clone()));
                return Err(e.into());
            }
            Ok(if ctx.json { doc } else { Value::Null })
        }
        SourceCmd::Remove { name } => {
            let s = source_by_name(habi, &name)?;
            habi.sources().remove(&s.id)?;
            emit(ctx, &json!({ "removed": s }), || {
                println!(
                    "Removed `{}`. Installed content in projects was not changed.",
                    s.name
                )
            })
        }
        SourceCmd::Role { name, role } => {
            let s = source_by_name(habi, &name)?;
            let role = if role == "community" {
                SourceRole::Community
            } else {
                SourceRole::Team
            };
            let s = habi.sources().set_role(&s.id, role)?;
            emit(ctx, &s, || {
                println!(
                    "`{}` is now {}.",
                    s.name,
                    match s.role {
                        SourceRole::Team => "a team library",
                        SourceRole::Community => "a community library (not reviewed by your team)",
                    }
                )
            })
        }
        SourceCmd::Items { name } => {
            let s = source_by_name(habi, &name)?;
            if s.snapshot.is_none() {
                return Err(not_fetched(&s.name));
            }
            let index = habi.sources().index(&s.id)?;
            emit(ctx, &index, || output::items(&s, &index))
        }
    }
}

fn shell_word(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\\\""))
    }
}

// ----- contributions ---------------------------------------------------------------------

/// Where a contribution's files are staged for editing.
fn staging_path(habi: &Habi, id: &str) -> String {
    habi.contributions()
        .preview(id)
        .map(|c| c.staging_path)
        .unwrap_or_else(|_| display_path(&habi.paths.contributions().join(id).join("files")))
}

/// Where the skill a contribution was made from lives, if it is on this machine.
fn origin_location(habi: &Habi, c: &Contribution) -> Option<String> {
    match &c.origin {
        ContributionOrigin::ProjectSkill { project_id, path } => habi
            .project(project_id)
            .ok()
            .map(|p| display_path(&p.root.join(path))),
        ContributionOrigin::LocalSkill { skill_id } => Some(display_path(
            &habi.paths.skills().join(skill_id).join("package"),
        )),
        ContributionOrigin::LibraryItem { .. } => None,
    }
}

/// Core messages written for the desktop app, in command-line terms.
fn contribution_wording(message: &str, id: &str) -> String {
    let commit = format!("nothing is committed yet; run `habi contribute commit {id}` first");
    message
        .replace(
            "choose Revise to change it",
            &format!("run `habi contribute revise {id}` to change it"),
        )
        .replace("commit the contribution first", &commit)
        .replace("prepare the branch first", &commit)
}

fn contribute(ctx: &Ctx, cmd: ContributeCmd) -> Result<Value> {
    let id = match &cmd {
        ContributeCmd::Show { id }
        | ContributeCmd::Describe { id, .. }
        | ContributeCmd::Exclude { id, .. }
        | ContributeCmd::Include { id, .. }
        | ContributeCmd::Commit { id, .. }
        | ContributeCmd::Status { id }
        | ContributeCmd::Rehearse { id }
        | ContributeCmd::Revise { id }
        | ContributeCmd::CancelRevision { id }
        | ContributeCmd::Export { id, .. }
        | ContributeCmd::Publish { id, .. }
        | ContributeCmd::Discard { id } => id.clone(),
        ContributeCmd::Start { .. } | ContributeCmd::List => "<id>".into(),
    };
    contribute_inner(ctx, cmd).map_err(|e| match e.downcast_ref::<HabiError>() {
        Some(h) => CliError {
            code: h.code().into(),
            message: contribution_wording(&h.to_info().message, &id),
            data: Vec::new(),
            exit: if matches!(h, HabiError::Cancelled) {
                130
            } else {
                1
            },
        }
        .into(),
        None => e,
    })
}

/// Leaves files out of a contribution (`exclude`) or puts them back.
fn select_files(ctx: &Ctx, id: &str, paths: &[String], exclude: bool) -> Result<Value> {
    let habi = &ctx.habi;
    let current = habi.contributions().preview(id)?;
    let prefix = format!("{}/", current.item_path);
    let wanted: Vec<String> = paths
        .iter()
        .map(|p| {
            let p = p.trim_end_matches('/');
            if p.starts_with(&prefix) {
                p.to_string()
            } else {
                format!("{prefix}{p}")
            }
        })
        .collect();
    let mut excluded: Vec<String> = current
        .files
        .iter()
        .filter(|f| !f.included)
        .map(|f| f.path.clone())
        .filter(|p| exclude || !wanted.contains(p))
        .collect();
    if exclude {
        excluded.extend(wanted);
    }
    let c = habi.select_contribution_files(id, &excluded)?;
    emit(ctx, &c, || {
        output::contribution(&c, &staging_path(habi, &c.id))
    })
}

fn contribute_inner(ctx: &Ctx, cmd: ContributeCmd) -> Result<Value> {
    let habi = &ctx.habi;
    let cancel = &ctx.cancel;
    match cmd {
        ContributeCmd::Start {
            source,
            folder,
            item,
            project: p,
        } => {
            let s = source_by_name(habi, &source)?;
            let origin = match (folder, item) {
                (Some(folder), None) => {
                    let project = project(ctx, &p, true)?;
                    ContributionOrigin::ProjectSkill {
                        project_id: project.id.clone(),
                        path: folder.trim_end_matches('/').to_string(),
                    }
                }
                (None, Some(item_id)) => ContributionOrigin::LibraryItem { item_id },
                (Some(_), Some(_)) => {
                    return Err(fail(
                        "invalidInput",
                        "give either a project skill folder or --item <id>, not both",
                    ));
                }
                (None, None) => {
                    return Err(fail(
                        "invalidInput",
                        "give a project skill folder (e.g. .claude/skills/my-skill) or --item <id>",
                    ));
                }
            };
            let c = habi.start_contribution(&s.id, origin)?;
            emit(ctx, &c, || {
                output::contribution(&c, &staging_path(habi, &c.id));
                println!(
                    "\nNext: habi contribute describe {id} --title \"…\" --message \"…\"\n      habi contribute commit {id}\n      habi contribute publish {id} --open-request",
                    id = c.id
                );
            })
        }
        ContributeCmd::List => {
            let list = habi.contributions().list()?;
            emit(ctx, &list, || {
                if list.is_empty() {
                    println!(
                        "No contributions yet. Start one with: habi contribute start <library> <skill-folder>"
                    );
                }
                for c in &list {
                    output::contribution_line(c);
                }
            })
        }
        ContributeCmd::Show { id } => {
            let c = habi.contributions().preview(&id)?;
            emit(ctx, &c, || {
                output::contribution(&c, &staging_path(habi, &c.id))
            })
        }
        ContributeCmd::Describe { id, title, message } => {
            if title.is_none() && message.is_none() {
                return Err(fail("invalidInput", "pass --title and/or --message"));
            }
            let current = habi.contributions().preview(&id)?;
            let title = title.unwrap_or_else(|| current.title.clone());
            let message = message.unwrap_or_else(|| current.message.clone());
            let c = habi.update_contribution(&id, &title, &message, &current.form)?;
            emit(ctx, &c, || {
                output::contribution(&c, &staging_path(habi, &c.id))
            })
        }
        ContributeCmd::Exclude { id, paths } => select_files(ctx, &id, &paths, true),
        ContributeCmd::Include { id, paths } => select_files(ctx, &id, &paths, false),
        ContributeCmd::Commit {
            id,
            build_on_remote,
        } => {
            let c = habi.commit_contribution_with(&id, build_on_remote, cancel)?;
            emit(ctx, &c, || {
                println!(
                    "Committed {} on branch {} (in Habi's cache; nothing was pushed).\nNext: habi contribute publish {id} --open-request   (or: habi contribute export {id} <folder>)",
                    c.commit_id
                        .as_deref()
                        .map(habi_core::fsutil::short)
                        .unwrap_or(""),
                    c.branch
                )
            })
        }
        ContributeCmd::Status { id } => {
            let c = habi.refresh_contribution_review(&id, cancel)?;
            emit(ctx, &c, || output::review(&c))
        }
        ContributeCmd::Rehearse { id } => {
            let r = habi.contribution_rehearsal(&id, cancel)?;
            emit(ctx, &r, || {
                if r.text.is_empty() {
                    println!(
                        "No projects to check against (sample projects are not counted). Run `habi recommend -C <project>` or `habi install` in your projects first."
                    );
                } else {
                    println!("{}", r.text);
                }
            })
        }
        ContributeCmd::Revise { id } => {
            let before = habi.contributions().preview(&id)?;
            let origin = origin_location(habi, &before);
            let c = habi.revise_contribution_with(&id, cancel)?;
            emit(ctx, &c, || {
                println!("Reopened for a revision.");
                match &origin {
                    // Commit copies the skill again from where it lives, so
                    // edits belong there, not in the staging folder.
                    Some(at) => println!("Edit the skill in {at}; `commit` copies it again."),
                    None => println!("Edit the files in: {}", c.staging_path),
                }
                println!(
                    "Then `habi contribute commit {id}` and `habi contribute publish {id}` update the same branch and request.\nChanged your mind? `habi contribute cancel-revision {id}`."
                );
            })
        }
        ContributeCmd::CancelRevision { id } => {
            let c = habi.cancel_contribution_revision_with(&id, cancel)?;
            emit(ctx, &c, || {
                println!("Back to the version you sent. Nothing was pushed.")
            })
        }
        ContributeCmd::Export { id, dir } => {
            std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
            let path = habi.contributions().export_patch(&id, &dir, cancel)?;
            emit(ctx, &json!({ "path": path }), || {
                println!("Wrote {}", path.display())
            })
        }
        ContributeCmd::Publish {
            id,
            open_request,
            yes,
        } => {
            let c = habi.contributions().preview(&id)?;
            if c.commit_id.is_none() {
                return Err(fail(
                    "notCommitted",
                    format!("Nothing is committed yet. Run `habi contribute commit {id}` first."),
                ));
            }
            require_yes(ctx, yes, false, "publish")?;
            if !yes && !std::io::stdin().is_terminal() {
                return Err(fail(
                    "confirmationRequired",
                    "refusing to publish without --yes (no terminal to ask on)",
                ));
            }
            if !ctx.json {
                let remote = c
                    .remote
                    .as_ref()
                    .map(|r| r.display.clone())
                    .unwrap_or_else(|| "the library's remote".into());
                let updates = c
                    .review
                    .as_ref()
                    .and_then(|r| r.url.clone())
                    .or(c.published_url.clone());
                println!(
                    "This pushes branch {} to {remote}{}.",
                    c.branch,
                    if updates.is_some() {
                        " and updates the open request"
                    } else if open_request {
                        " and opens a pull/merge request"
                    } else {
                        ""
                    }
                );
            }
            if !yes && !confirm("Publish?", "publish")? {
                note("Nothing was pushed.");
                return Ok(Value::Null);
            }
            let out = habi.publish_contribution(&id, open_request, cancel)?;
            emit(ctx, &out, || {
                println!("Pushed {} to {}.", out.branch, out.remote);
                if let Some(url) = &out.pull_request_url {
                    if out.updated_existing {
                        println!("The open request now shows this revision: {url}");
                    } else {
                        println!("Request: {url}");
                    }
                }
                if let Some(n) = &out.pull_request_note {
                    println!("{n}");
                }
            })
        }
        ContributeCmd::Discard { id } => {
            habi.contributions().discard(&id)?;
            emit(ctx, &json!({ "discarded": id }), || println!("Discarded."))
        }
    }
}

// ----- validate ------------------------------------------------------------------------------

fn validate(ctx: &Ctx, path: &Path) -> Result<Value> {
    use habi_core::library::model::{DiagnosticLevel, SnapshotFile};
    let root = habi_core::paths::canonical(path)
        .map_err(|e| fail("notFound", format!("cannot open {}: {e}", path.display())))?;
    if !root.is_dir() {
        return Err(fail(
            "invalidInput",
            format!("{} is not a folder", path.display()),
        ));
    }
    let mut files = Vec::new();
    let mut content = HashMap::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let entries =
            std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))?;
        for entry in entries {
            let entry = entry?;
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.is_dir() {
                if entry.file_name() != ".git" {
                    stack.push(entry.path());
                }
            } else if meta.is_file() {
                let rel = entry
                    .path()
                    .strip_prefix(&root)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = std::fs::read(entry.path())
                    .with_context(|| format!("reading {}", entry.path().display()))?;
                files.push(SnapshotFile {
                    path: rel.clone(),
                    digest: habi_core::fsutil::sha256(&bytes),
                    size: bytes.len() as u64,
                    executable: false,
                });
                content.insert(rel, bytes);
            }
        }
    }
    let has_skill = files
        .iter()
        .any(|f| f.path == "SKILL.md" || f.path.ends_with("/SKILL.md"));
    let index = habi_core::library::build_index("local", "working-tree", &files, &|p| {
        content
            .get(p)
            .cloned()
            .ok_or_else(|| format!("missing {p}"))
    });
    let diagnostics: Vec<_> = index
        .diagnostics
        .iter()
        .chain(index.items.iter().flat_map(|i| i.diagnostics.iter()))
        .collect();
    let errors = diagnostics
        .iter()
        .filter(|d| d.level == DiagnosticLevel::Error)
        .count();
    let index_value = serde_json::to_value(&index)?;
    if !has_skill && index.items.is_empty() {
        return Err(fail_with(
            "noSkills",
            format!(
                "No SKILL.md found under {} — is this the library root?",
                display_path(&root)
            ),
            "index",
            index_value,
        ));
    }
    if !ctx.json {
        for d in &diagnostics {
            println!(
                "{}: {}{}",
                output::diagnostic_level(d.level),
                d.path
                    .as_ref()
                    .map(|p| format!("{p}: "))
                    .unwrap_or_default(),
                d.message
            );
        }
        println!(
            "{}, {}.",
            output::plural(index.items.len(), "item"),
            output::plural(errors, "error")
        );
    }
    if errors > 0 {
        return Err(fail_with(
            "invalidLibrary",
            format!("the library has {}", output::plural(errors, "error")),
            "index",
            index_value,
        ));
    }
    Ok(if ctx.json { index_value } else { Value::Null })
}
