# Project status

Habi is **pre-release (0.1.0)**. This page is the one place that says what works today, how
it is checked, what is known not to work or not to be verified, and what still blocks the
first release. Product principles live in [product.md](product.md); the release procedure in
[release.md](../dev/release.md).

Habi runs on macOS 11 or later (Apple Silicon and Intel) and on Windows. Linux is not
supported, and CI does not test it.

## What works

| Area | State | Verified by |
|---|---|---|
| Inspection (Maven, Gradle + catalogs, npm + lockfiles, Go, Cargo, Python, Composer, recognized files, tags, monorepos, Git metadata) | Done | Unit tests per detector; `tests/matching_fixtures.rs` |
| Matching (three-valued, explanations, declarations, module scope, exclusions) | Done | Unit tests; fixture tests incl. misleading README, unresolved parents |
| Library index (SKILL.md, `habi.yaml`, manifest instructions, diagnostics, schema) | Done | `library/tests.rs`, schema example validation |
| Sources (Git remote/local, folder, subdir, branch/tag, moved tags, stale cache) | Done | `tests/sources.rs` with temporary local repositories |
| Install / update / remove / restore (journal, locks, preconditions, recovery, sections, MCP) | Done | `tests/install_lifecycle.rs` (incl. simulated crash and failure), `tests/install_edge_cases.rs` |
| Agent tools (Claude Code, Cursor, Codex, Gemini CLI, GitHub Copilot, OpenCode, Junie: skill folders, instruction imports, MCP files, preselection) | Done; loading not verified (see below) | `clients` unit tests, `tests/install_lifecycle.rs` |
| Install on this machine (plan, record in `~/.habi/lock.json`, update, remove, conflicts, shadowing note) | Done; restore not offered in the app | `tests/machine_install.rs`, `tests/machine_skills.rs`, `src/test/machineInstall.test.tsx` |
| Library catalog (previews, connect, update checks you act on, catalog facts) | Done | `tests/catalog.rs`, `src/test/libraries.test.tsx` |
| Recommendations (four dimensions, grouping, ordering, next action) | Done | Fixture and acceptance tests |
| Verification checks (preview, bindings, run, record, staleness) | Done | `tests/checks.rs` (runs a harmless `git hash-object`) |
| Contributions (staging, form, preview, secret scan, plumbing commit, patch, push, `gh`/`glab`) | Done; GitHub run live once (2026-10-04), GitLab not | `tests/contribution.rs` (push to local remote); `tests/review_flow.rs` (GitHub-shaped remote via `insteadOf`, stand-in `gh`); `tests/review_requests.rs` (stand-in `glab`, host detection) |
| Review lifecycle (status, approvals, plain-text comments, revise on the same branch, refuse to overwrite others' commits, where-it-applies summary) | Done; GitHub run live once (2026-10-04), GitLab not | `tests/review_flow.rs`, `tests/review_requests.rs`, `review.rs` unit tests, `tests/contribution.rs` |
| Local skills (create, save with conflict detection, files, trash, export, validity) | Done | `tests/local_skills.rs`; `ipc_tests.rs` |
| Project discovery (skills, instruction files) and instructions → draft | Done | `tests/local_skills.rs` (agent-ready-service fixture) |
| Import (project, folder, library; duplicates, collisions, incomplete packages) | Done | `tests/local_skills.rs` |
| Applicability preview across projects, condition suggestions | Done | `tests/local_skills.rs` (applies / does not apply / needs information) |
| Local skills in recommendations and install/update plans | Done | `tests/local_skills.rs` (install, update available, conflict) |
| Sharing a local skill; honest status (`in_library`, publish note) | Done; PR creation not exercised | `tests/local_skills.rs` (push and merge on a temporary Git remote) |
| Diagnostics bundle | Done | Smoke run with the internal CLI |
| App updates (signed updater, What's new from the changelog) | Done; not exercised end to end, since no release is published | `src/test/updates.test.tsx`, `scripts/changelog.test.mjs` |
| Internal CLI (dev harness, not released) | Done | `crates/habi-cli/tests/cli.rs` (JSON output, exit codes, project detection, next-step messages, install defaults) plus manual runs |
| Desktop adapter (commands, jobs/cancel, watcher, dialogs in Rust, logging) | Done | `src-tauri/src/ipc_tests.rs` (mock runtime, real JSON arguments) |
| Desktop UI (welcome and setup check, home, project page, My skills, Skill Studio with autosave and testing, add skills, use and share dialogs, libraries, contributions, review, evidence, history, settings, privacy page, palette, themes) | Done | Vitest + Testing Library + axe (`src/test`), and manual runs against the real core through the development bridge |
| Acceptance scenario (10 steps) | Passes | `tests/acceptance.rs` |
| Docs, CI, release scaffolding | Done | — |

## Known limitations

By design, or not solved yet:

- **What an agent does** with installed content is invisible to Habi, and Habi does not claim
  to know.
- **Running a check** executes code with your privileges. There is no sandbox.
- **The secret scan** before sharing is pattern-based. It reduces the risk of sharing a
  secret; it does not remove it.
- **Another process running as you** could race between path validation and directory
  creation while a plan is applied.
- **Community libraries** usually need push access (or a fork) that you do not have. Habi
  prepares the branch and offers *Export patch*; it does not create forks.
- **Unsigned installers, by choice.** Habi ships on GitHub Releases only, without Apple or
  Microsoft code signing, so the first launch needs one confirmation
  ([how](../guide/getting-started.md#installing)). Updates are signed with Habi's own updater key
  and verified before they install.
- Smaller gaps: an update does not add an MCP server an item newly suggests, and restoring a
  case-only rename keeps the new letter case
  ([recovery](../guide/recovery.md#known-limitations)); an install on this machine is journaled
  but no screen offers to restore it; turning an existing file into an
  OpenAPI specification is noticed after a rescan ([detectors](../library-authors/detectors.md));
  comments inside `habi.yaml` are not kept when the share form rewrites it
  ([sharing](../guide/sharing.md)).

## Next

1. Run the client smoke tests and record versions in
   [compatibility research](../dev/compatibility-research.md).
2. Exercise sharing's remaining review states on GitHub, and all of it on GitLab, against live repositories.
3. Restore for installs on this machine.
4. Cursor `.mdc` rules (see [future direction](product.md#future-direction)).
5. `habi skill …` commands for My skills (list, export, import); the core supports them.
