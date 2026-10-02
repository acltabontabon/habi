# Implementation status

Working notes so implementation can continue across sessions. Product principles live in
`docs/product.md`; the guiding question is: *does this help a developer discover,
understand, and adopt their team's relevant expertise for the repository they are working in?*

Last updated: 2026-10-02.

## What works

| Area | State | Verified by |
|---|---|---|
| Inspection (Maven, Gradle + catalogs, npm + lockfiles, recognized files, tags, monorepos, Git metadata) | Done | Unit tests per detector; `tests/matching_fixtures.rs` |
| Matching (three-valued, explanations, declarations, module scope, exclusions) | Done | Unit tests; fixture tests incl. misleading README, unresolved parents |
| Library index (SKILL.md, `habi.yaml`, manifest instructions, diagnostics, schema) | Done | `library/tests.rs`, schema example validation |
| Sources (Git remote/local, folder, subdir, branch/tag, moved tags, stale cache) | Done | `tests/sources.rs` with temporary local repositories |
| Install / update / remove / restore (journal, locks, preconditions, recovery, sections, MCP) | Done | `tests/install_lifecycle.rs` (incl. simulated crash and failure) |
| Recommendations (four dimensions, grouping, ordering, next action) | Done | Fixture and acceptance tests |
| Verification checks (preview, bindings, run, record, staleness) | Done | `tests/checks.rs` (runs a harmless `git hash-object`) |
| Contributions (staging, form, preview, secret scan, plumbing commit, patch, push, `gh`/`glab`) | Done; not run against a live host | `tests/contribution.rs` (push to local remote); `tests/review_flow.rs` (GitHub-shaped remote via `insteadOf`, stand-in `gh`); `tests/review_requests.rs` (stand-in `glab`, host detection) |
| Review lifecycle (status, approvals, plain-text comments, revise on the same branch, refuse to overwrite others' commits, where-it-applies summary) | Done; not run against a live host | `tests/review_flow.rs`, `tests/review_requests.rs`, `review.rs` unit tests, `tests/contribution.rs` (rehearsal); browser walkthrough through the development bridge with a stand-in `gh` |
| Local skills (create, save with conflict detection, files, trash, export, validity) | Done | `tests/local_skills.rs`; `ipc_tests.rs` |
| Project discovery (skills, instruction files) and instructions → draft | Done | `tests/local_skills.rs` (agent-ready-service fixture) |
| Import (project, folder, library; duplicates, collisions, incomplete packages) | Done | `tests/local_skills.rs` |
| Applicability preview across projects, condition suggestions | Done | `tests/local_skills.rs` (applies / does not apply / needs information) |
| Local skills in recommendations and install/update plans | Done | `tests/local_skills.rs` (install, update available, conflict) |
| Sharing a local skill; honest status (`in_library`, publish note) | Done; PR creation not exercised | `tests/local_skills.rs` (push and merge on a temporary Git remote) |
| Diagnostics bundle | Done | CLI smoke run |
| CLI | Done | `crates/habi-cli/tests/cli.rs` (JSON output, exit codes, project detection, next-step messages, install defaults) plus manual runs |
| Desktop adapter (commands, jobs/cancel, watcher, dialogs in Rust, logging) | Done | `src-tauri/src/ipc_tests.rs` (mock runtime, real JSON arguments) |
| Desktop UI (welcome, project discovery, workbench, My skills, skill editor with autosave and preview, add skills, use/share dialogs, library connection, sharing activity, review, evidence, installed/history, settings, palette, themes) | Done | Vitest + Testing Library + axe (`src/test`); end-to-end walkthrough in a browser against the real core through the development bridge (see below) |
| Acceptance scenario (10 steps) | Passes | `tests/acceptance.rs` |
| Docs, CI, release scaffolding | Done | — |

## Verified end to end on 2026-10-02 (browser + development bridge, real core)

Driven in a browser against `dev_bridge` with a fresh data directory, copies of the fixture
repositories and a temporary local Git remote. Screenshots in `docs/screenshots/` were
retaken after the production-readiness review (headless Chrome against the development bridge,
1280×800 at 2×; the review screen uses a stand-in `gh`).

1. Fresh data, no library: opened `agent-ready-service`; the project listed its skill and three
   instruction files; turned line 5 of `AGENTS.md` into a draft; `AGENTS.md` unchanged.
2. Created and edited drafts with no project selected; restarted the core; drafts intact.
3. Added conditions from observed facts; the preview showed *Applies* (billing-service, with
   `pom.xml` lines), *Does not apply* (storefront-web, agent-ready-service) and *Needs
   information* (a service with an external parent POM).
4. Imported plain skills from a folder; they stayed "applicability not specified".
5. Imported a package with a script; structure and executable bit preserved.
6. Re-imported the same folder: duplicates detected, not preselected, second copy imported
   under a new identifier.
7. Installed a local skill for Claude Code and Codex through the review dialog; only the
   previewed files were written; `CLAUDE.md` untouched.
8. Started sharing with no library, connected one inline; the draft was unchanged.
9. Prepared a branch (status *Prepared locally*), pushed it to the temporary remote (status
   *Branch pushed — no review request*).
10. Merged on the remote and refreshed: *In the library*; installed copies unchanged.
11. Edited a draft's `SKILL.md` outside the app while it was open: saving paused with a
    conflict; *Show the other version* loaded the file from disk.
12. Connected an unreachable repository: specific network error, form kept, *Try again* and
    *Remove and start over* available. Light and dark themes and an 860×600 window inspected.

The same behaviors are asserted automatically in `crates/habi-core/tests/local_skills.rs`.

## Not verified in this environment

- The new screens were exercised through the development bridge, not inside the native Tauri
  window: native folder/file dialogs, the opener (*Show the folder*) and window-level behavior
  of the new flows were not driven by hand. The Tauri commands themselves are covered by
  `ipc_tests.rs` with the mock runtime.
- Opening a pull/merge request from a shared local skill (`gh`/`glab`), and authentication
  failures against a real Git host.
- The native desktop window was launched (`pnpm tauri dev`, clean logs), but screenshots of
  the native window were not possible here (no screen-recording permission). Screens were
  inspected in Chrome through the dev-only design preview fed by core-generated fixtures.
- Client discovery (Claude Code, Cursor, Codex actually loading installed skills) — use the
  smoke tests in `docs/compatibility.md` §6.
- Windows and Linux builds and tests (CI is configured; not run locally).
- Pull/merge requests against a live GitHub or GitLab: opening, reading status and comments
  and updating with a revision are tested with stand-in `gh`/`glab` programs that answer like
  the REST APIs, not against real hosts. GitLab's `glab api` output in particular has not been
  checked against a live instance.
- A macOS `.app` bundle was built (`pnpm tauri build --bundles app`, arm64, 20 MB) with the
  sample resources included. It is ad-hoc signed only (no Developer ID, not notarized). DMG,
  MSI and Linux packages were not built here.

## Next steps (suggested)

1. Run the client smoke tests and record versions in `docs/compatibility.md`.
2. Decide license and identifiers (`docs/release.md` → blockers).
3. Run CI on all three platforms; fix any Windows path issues.
4. User-scope installation and Cursor `.mdc` rules (see `docs/future.md`).
5. `habi skill …` CLI commands for local skills (list, export, import); the core supports them.
6. Split the desktop bundle (CodeMirror is loaded with the main chunk).
