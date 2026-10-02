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

## Development bridge

`crates/habi-core/examples/dev_bridge.rs` serves the service over loopback HTTP so the UI can
be exercised in a plain browser against the real core (`VITE_HABI_BRIDGE=1 pnpm dev`). It is
an example target — not part of the app or CLI — and replaces native dialogs with a path
prompt. See `docs/dev/test-data.md`.

## Dependency choices

See `docs/dev/reuse-assessment.md` for what was adopted and why.
