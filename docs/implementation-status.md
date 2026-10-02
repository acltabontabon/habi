# Project status

Habi is **pre-release (0.1.0)**. This page says what works today, how it is checked, and
what is known not to be verified yet. Product principles live in
[product.md](product.md); release requirements in [release.md](release.md).

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
| Review lifecycle (status, approvals, plain-text comments, revise on the same branch, refuse to overwrite others' commits, where-it-applies summary) | Done; not run against a live host | `tests/review_flow.rs`, `tests/review_requests.rs`, `review.rs` unit tests, `tests/contribution.rs` |
| Local skills (create, save with conflict detection, files, trash, export, validity) | Done | `tests/local_skills.rs`; `ipc_tests.rs` |
| Project discovery (skills, instruction files) and instructions → draft | Done | `tests/local_skills.rs` (agent-ready-service fixture) |
| Import (project, folder, library; duplicates, collisions, incomplete packages) | Done | `tests/local_skills.rs` |
| Applicability preview across projects, condition suggestions | Done | `tests/local_skills.rs` (applies / does not apply / needs information) |
| Local skills in recommendations and install/update plans | Done | `tests/local_skills.rs` (install, update available, conflict) |
| Sharing a local skill; honest status (`in_library`, publish note) | Done; PR creation not exercised | `tests/local_skills.rs` (push and merge on a temporary Git remote) |
| Diagnostics bundle | Done | CLI smoke run |
| CLI | Done | `crates/habi-cli/tests/cli.rs` (JSON output, exit codes, project detection, next-step messages, install defaults) plus manual runs |
| Desktop adapter (commands, jobs/cancel, watcher, dialogs in Rust, logging) | Done | `src-tauri/src/ipc_tests.rs` (mock runtime, real JSON arguments) |
| Desktop UI (welcome, project discovery, workbench, My skills, skill editor with autosave and preview, add skills, use/share dialogs, library connection, sharing activity, review, evidence, installed/history, settings, palette, themes) | Done | Vitest + Testing Library + axe (`src/test`), and manual runs against the real core through the development bridge |
| Acceptance scenario (10 steps) | Passes | `tests/acceptance.rs` |
| Docs, CI, release scaffolding | Done | — |

## Known limitations and not yet verified

- **Agent tools loading what Habi installs.** Habi writes skills and instructions to the
  documented locations for Claude Code, Cursor and Codex; whether a given client version
  discovers them is checked with the smoke tests in [compatibility.md](compatibility.md) §6,
  which have not yet been run for this release.
- **Live Git hosts.** Opening pull/merge requests, reading status and comments, and updating
  a request with a revision are tested against programs that answer like the GitHub and GitLab
  REST APIs, not against live hosts. GitLab is the less exercised of the two.
- **Windows and Linux.** CI builds and tests all three platforms; the desktop app has mainly
  been used on macOS so far.
- **Native window.** Most screens were exercised through the development bridge in a browser;
  native file dialogs and window behavior have had less use.
- **Signing.** Release artifacts are unsigned until signing credentials exist (see
  [release.md](release.md)).
- Smaller documented gaps: an update does not add an MCP server an item newly suggests
  ([recovery.md](recovery.md)); turning an existing file into an OpenAPI specification is
  noticed after a rescan ([detectors.md](detectors.md)); comments inside `habi.yaml` are not
  kept when the share form rewrites it ([contribution-flow.md](contribution-flow.md)).

## Next

1. Run the client smoke tests and record versions in [compatibility.md](compatibility.md).
2. Exercise sharing against live GitHub and GitLab repositories.
3. User-scope installation and Cursor `.mdc` rules (see [future.md](future.md)).
4. `habi skill …` commands for local skills (list, export, import); the core supports them.
