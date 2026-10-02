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
                 ├──────────┬──────────┬──────────┬──────────┬────────────┤
                 │ inspect  │ matching │ library  │ source   │ install    │
                 │ recommend│ checks   │ contribute│ clients │ diagnostics│
                 ├──────────┴──────────┴──────────┴──────────┴────────────┤
                 │ store (SQLite, blobs, locks) · paths · process · redact │
                 └─────────────────────────────────────────────────────────┘
```

## Crates and directories

| Path | Role |
|---|---|
| `crates/habi-core` | Domain core. No UI dependency. Synchronous, blocking code with explicit cancellation tokens; front ends call it from worker threads. |
| `crates/habi-cli` | The `habi` CLI. Formats output; contains no rules. |
| `apps/desktop/src-tauri` | Tauri 2 shell: commands, file watcher, native dialogs, logging. |
| `apps/desktop/src` | React 19 + TypeScript (strict). Types in `src/bindings` are generated from Rust by `ts-rs`. |
| `schema/` | JSON Schemas for Habi metadata (compiled into the core). |
| `fixtures/` | Example library and repositories for tests, the sample workspace and UI fixtures. |

## Core modules

- **`inspect`** — bounded, ignore-aware traversal (`walk`), detectors (`maven`, `gradle`, `npm`,
  `files`), derived `tags`, Git metadata (`repo`). Produces `ProjectInspection`: facts with
  provenance, per-module `Coverage`, a scan report and a fingerprint.
- **`matching`** — `Condition` (all/any/not + dependency/file/tag), three-valued evaluation
  with explanation trees, user `Declaration`s, per-module assessment.
- **`library`** — reads a snapshot into a `LibraryIndex`: SKILL.md frontmatter, optional
  `habi.yaml`, `habi-library.yaml` instructions, diagnostics.
- **`source`** — registration, refresh (Git into a bare cache, or folder), moved-tag and
  rewritten-history warnings, offline cache, snapshot listings in SQLite, contents in the blob store.
- **`install`** — `plan` (install/update/remove/restore, three-way), `apply` (lock, journal,
  rollback, recovery), `lock` (portable `.habi/lock.json`), `status`, `diff`.
- **`clients`** — client ids, skill directory layout, managed Markdown sections, MCP config
  merging for `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`.
- **`recommend`** — combines applicability, readiness, installation and evidence; ordering.
- **`skills`** — local skills ("My skills"): package storage, document and applicability
  saving with external-edit detection, validation, export; `skills::intake` discovers skills
  and instruction files in a project and imports packages (project, folder, library) after
  inspecting them. Valid local skills are exposed as one more library index (source id
  `local`), so matching, planning and installation reuse the same code as team items.
- **`contribute`** — staging, form → `habi.yaml`, preview, plumbing commit, patch, publish.
  Origins: a project skill folder, a library item, or a local skill.
- **`checks`** — previewed, user-run verification commands; recorded results.
- **`service`** — the facade; projects, declarations, plans by id, overview.

## Contracts between Rust and TypeScript

All IPC request/response types derive `ts_rs::TS`; `cargo test` regenerates
`apps/desktop/src/bindings/*.ts`. CI fails if the generated files differ from the committed
ones, so the two sides cannot drift silently. Every command returns `Result<T, ErrorInfo>`
where `ErrorInfo { code, message }` has a stable code the UI maps to guidance.

## Concurrency and consistency

- Long work (inspection, Git, checks) runs on blocking worker threads with a `CancelToken`;
  the UI passes a job id and can cancel.
- SQLite runs in WAL mode with a busy timeout; connections are opened per operation, so the
  desktop app and CLI can be used at the same time.
- Cross-process `ResourceLock`s (std `File::try_lock`) guard each project during apply and
  each source during refresh. A second writer gets a `busy` error instead of waiting forever.
- Plans record the digest each file had when previewed; apply re-checks under the lock and
  fails with `stalePlan` on any difference.

## Data locations

| What | Where | Portable? |
|---|---|---|
| Installed skills, AGENTS.md sections, MCP entries | the project | yes (ordinary files) |
| `.habi/lock.json` | the project | yes — no absolute paths or secrets; commit it or ignore it |
| Sources, snapshots, projects, declarations, check runs, contributions | `<data>/habi.db` | machine-local |
| Local skills (drafts, imported copies) | `<data>/skills/<id>/package/` (files) and `habi.db` (title, origin, trash) | machine-local; each package is a portable Agent Skills folder |
| Library contents, backups, baselines | `<data>/blobs/sha256/..` | machine-local cache |
| Bare Git caches | `<data>/sources/<id>/repo.git` | machine-local cache |
| Operation journals | `<data>/journal/<project-id>/*.json` | machine-local |
| Logs | `<data>/logs/habi.*.log` (7 days) | machine-local |

`<data>` is the platform data directory (`directories::ProjectDirs`), or `HABI_HOME`.
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
the CLI or any build. It does not exercise the Tauri adapter itself; that is covered by
`apps/desktop/src-tauri/src/ipc_tests.rs`.

### Design preview

`pnpm dev` in `apps/desktop`, opened in a plain browser without the bridge, loads a dev-only
preview whose IPC answers come from JSON generated by the real core:

```sh
cargo test -p habi-core --test ui_fixtures -- --ignored   # writes apps/desktop/src/test/fixtures/
```

A tab title marks it as fixture data. It is excluded from production builds.

## Dependency choices

See [Reuse assessment](reuse-assessment.md) for what was adopted and why.
