# Architecture

```
                 ┌──────────────────────────┐      ┌──────────────────────┐
  React UI ────▶ │ apps/desktop/src-tauri   │      │ crates/habi-cli      │
 (TypeScript,    │ thin Tauri commands      │      │ `habi` command line  │
  no business    └────────────┬─────────────┘      └──────────┬───────────┘
  rules)                      │  same calls                   │
                              ▼                               ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ crates/habi-core :: service::Habi  (the only facade)    │
                 ├──────────┬──────────┬───────────┬──────────┬────────────┤
                 │ inspect  │ matching │ library   │ source   │ install    │
                 │ recommend│ checks   │ contribute│ review   │ clients    │
                 │ skills   │ catalog  │ browse    │ sample   │ maintenance│
                 ├──────────┴──────────┴───────────┴──────────┴────────────┤
                 │ store (SQLite, blobs, locks) · paths · process · redact │
                 └─────────────────────────────────────────────────────────┘
```

## Crates and directories

| Path | Role |
|---|---|
| `crates/habi-core` | Domain core. No UI dependency. Synchronous, blocking code with explicit cancellation tokens; front ends call it from worker threads. |
| `crates/habi-cli` | The `habi` command line, an internal tool that is not released ([cli.md](cli.md)). Formats output; contains no rules. |
| `apps/desktop/src-tauri` | Tauri 2 shell: commands, file watcher, native dialogs, updater, logging. |
| `apps/desktop/src` | React 19 + TypeScript (strict). Types in `src/bindings` are generated from Rust by `ts-rs`. |
| `schema/` | JSON Schemas for Habi metadata (compiled into the core). |
| `fixtures/` | Example libraries and repositories for tests, the sample workspace and UI fixtures ([test data](test-data.md)). |
| `website/` | The project site at acltabontabon.com/habi (Astro). `pnpm dev` in `website/`; it renders `docs/` and `docs/media/` ([website.md](website.md)). |

## Core modules

- **`inspect`**: bounded, ignore-aware traversal (`walk`), detectors (`maven`, `gradle`,
  `npm`, `golang`, `cargo`, `python`, `composer`, `files`), derived `tags`, Git metadata
  (`repo`). Produces `ProjectInspection`: facts with provenance, per-module `Coverage`, a scan
  report and a fingerprint. What each detector reads is in
  [Detectors](../library-authors/detectors.md).
- **`matching`**: `Condition` (all/any/not + dependency/file/tag), three-valued evaluation
  with explanation trees, user `Declaration`s, per-module assessment.
- **`library`**: reads a snapshot into a `LibraryIndex`: `SKILL.md` frontmatter, optional
  `habi.yaml`, `habi-library.yaml` instructions, diagnostics, provenance and the static
  `signals` read from a skill's files.
- **`source`**: registration, refresh (Git into a bare cache, or folder), release tags,
  moved-tag and rewritten-history warnings, offline cache, snapshot listings in SQLite,
  contents in the blob store.
- **`catalog`**: the built-in registry of public libraries (`catalog/sources.yaml`, format in
  [Library catalog](../library-authors/catalog.md)), hidden previews and repository facts
  from GitHub's public API.
- **`install`**: `plan` (install, update, remove, restore, three-way), `apply` (lock, journal,
  rollback, recovery), `lock` (portable `.habi/lock.json`), `status`, `diff`. Plans have a
  scope: a project, or this machine (see [Install scopes](#install-scopes)).
- **`clients`**: the seven agent tools (`ClientId`), which project and home folders each
  reads (`layout`), how a project or home folder shows which tools are in use, managed
  Markdown sections (`sections`), and the MCP writers for each tool's own file (`mcp`). The
  paths come from [compatibility research](compatibility-research.md).
- **`recommend`**: combines applicability, readiness, installation and evidence; ordering.
- **`skills`**: My skills. Package storage, document and applicability saving with
  external-edit detection, validation, zip export (`archive`), lineage and three-way library
  updates (`lineage`, `upstream`), the skills in your home folder (`machine`), and `intake`,
  which discovers skills and instruction files in a project and imports packages after
  inspecting them. Valid local skills are exposed as one more library index (source id
  `local`), so matching, planning and installation reuse the same code as library items.
- **`contribute`**: staging, form → `habi.yaml`, preview, plumbing commit, patch, publish,
  revisions. Origins: a project skill folder, a library item, or a local skill.
- **`review`**: pull and merge requests through the user's `gh` and `glab`: opening one,
  reading its state and comments as untrusted text.
- **`checks`**: previewed, user-run verification commands; recorded results.
- **`browse`**: the project chooser's read-only look at likely repository folders.
- **`sample`**: the labeled sample workspace.
- **`maintenance`**: pruning old journals, snapshots and unreferenced blobs (`habi gc`).
- **`service`**: the facade; projects, declarations, plans by id, overview.

## Install scopes

A plan is computed against a root folder. For a project, the root is the repository; for this
machine, it is the home folder. Both use the same planner, journal, conflict handling, status
and restore, with the same relative paths (`.claude/skills`, `.agents/skills`), which under the
home folder are the user's own skill folders.

- A machine plan installs skills only: instruction files are refused up front, and MCP
  configuration is never written.
- The machine record is `~/.habi/lock.json`, not a file in the data folder, because the
  planner, journal, restore and status code read the record inside the root they work on
  ([decision](decisions/0002-install-on-this-machine.md)).
- The home folder is injected into `Habi`, so tests never read or write the real one.
- `skills::machine` lists every skill in the tools' home folders, marks those the machine
  record owns, and finds projects that hold a skill of the same name.

## Contracts between Rust and TypeScript

All IPC request and response types derive `ts_rs::TS`; `cargo test` regenerates
`apps/desktop/src/bindings/*.ts`. CI fails if the generated files differ from the committed
ones, so the two sides cannot drift silently. Every command returns `Result<T, ErrorInfo>`
where `ErrorInfo { code, message }` has a stable code the UI maps to guidance.

## Concurrency and consistency

- Long work (inspection, Git, checks) runs on blocking worker threads with a `CancelToken`;
  the UI passes a job id and can cancel.
- SQLite runs in WAL mode with a busy timeout; connections are opened per operation, so the
  desktop app and the command line can be used at the same time. Migrations are versioned
  with `PRAGMA user_version`, and the previous database is copied first.
- Cross-process `ResourceLock`s (std `File::try_lock`) guard each project during apply and
  each source during refresh. A second writer gets a `busy` error instead of waiting forever.
- Plans record the digest each file had when previewed; apply re-checks under the lock and
  fails with `stalePlan` on any difference.

## Data locations

| What | Where | Portable? |
|---|---|---|
| Installed skills, `AGENTS.md` sections, imports, MCP entries | the project | yes (ordinary files) |
| `.habi/lock.json` | the project | yes: no absolute paths or secrets; commit it or ignore it |
| Skills installed on this machine, and their record | `~/.claude/skills`, `~/.agents/skills`, `~/.habi/lock.json` | personal to this machine |
| Sources, snapshots, projects, declarations, check runs, contributions, local skill records | `<data>/habi.db` | machine-local |
| Local skills (drafts, imported copies) | `<data>/skills/<id>/package/` | machine-local; each package is a portable Agent Skills folder |
| Library contents, backups, baselines | `<data>/blobs/sha256/…` | machine-local cache |
| Bare Git caches | `<data>/sources/<id>/repo.git` | machine-local cache |
| Operation journals | `<data>/journal/<id>/*.json` (one folder per project, one for this machine) | machine-local |
| Contribution staging | `<data>/contributions/` | machine-local |
| Sample workspace | `<data>/sample/` | machine-local |
| Logs (desktop app) | `<data>/logs/habi.*.log`, one per day, the last 7 kept | machine-local |

`<data>` is the platform data directory from `directories::ProjectDirs` with the qualifier in
`crates/habi-core/src/brand.rs` (`~/Library/Application Support/com.acltabontabon.Habi` on
macOS, `%APPDATA%\acltabontabon\Habi\data` on Windows), or `HABI_HOME` when it is set.
Credentials are never stored by Habi; Git authentication stays with Git.

## Working on the UI in a browser

### Development bridge

`crates/habi-core/examples/dev_bridge.rs` serves the real core over loopback HTTP, so you can
use browser dev tools against real inspection, drafts on disk, Git and install plans:

```sh
HABI_HOME=./.habi-dev cargo run -p habi-core --example dev_bridge   # terminal 1
VITE_HABI_BRIDGE=1 pnpm --dir apps/desktop dev                      # terminal 2
```

Then open http://127.0.0.1:1420. `HABI_HOME` keeps experiments away from your real Habi
data; `HABI_BRIDGE_PORT` and `HABI_UI_PORT` run a second pair side by side. Commands that
open a native picker ask for a path in a small prompt instead, and the tab title names the
mode. The bridge listens on loopback only, is an example target, and is not part of the app,
the command line or any build. It does not exercise the Tauri adapter itself; that is covered
by `apps/desktop/src-tauri/src/ipc_tests.rs`.

### Design preview

`pnpm dev` in `apps/desktop`, opened in a plain browser without the bridge, loads a dev-only
preview whose IPC answers come from JSON generated by the real core:

```sh
cargo test -p habi-core --test ui_fixtures -- --ignored   # writes apps/desktop/src/test/fixtures/
```

A tab title marks it as fixture data. It is excluded from production builds.

## Dependency choices

See [Reuse assessment](reuse-assessment.md) for what was adopted and why, and
[decisions](decisions/) for the larger choices behind the current design.
