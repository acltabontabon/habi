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

## Known limitations

Not verified yet:

- **Agent tools loading what Habi installs.** Habi writes skills and instructions to the
  documented locations for Claude Code, Cursor and Codex
  ([agent tools](../guide/agent-tools.md)). Whether a given client version discovers and
  loads them is checked by hand with the
  [smoke tests](../dev/compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it),
  which have not been run for this release. Habi does not claim that an agent follows the
  instructions.
- **Live Git hosts.** Opening pull/merge requests, reading status and comments, and updating
  a request with a revision are tested against programs that answer like the GitHub and GitLab
  REST APIs, not against live hosts. GitLab is the less exercised of the two.
- **Windows.** CI builds and tests on Windows, but Habi has mainly been used on macOS.
- **Native window.** Most screens were exercised through the development bridge in a browser;
  native file dialogs and window behavior have had less use.

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
- **Unsigned releases.** See [release blockers](#release-blockers).
- Smaller gaps: an update does not add an MCP server an item newly suggests, and restoring a
  case-only rename keeps the new letter case
  ([recovery](../guide/recovery.md#known-limitations)); turning an existing file into an
  OpenAPI specification is noticed after a rescan ([detectors](../library-authors/detectors.md));
  comments inside `habi.yaml` are not kept when the share form rewrites it
  ([sharing](../guide/sharing.md)).

## Release blockers

Open:

- **Repository is public.** It is private until the first release. Going public also needs
  these GitHub settings, done by hand: private vulnerability reporting, a ruleset on `main`
  (required checks `core`, `frontend` and `licenses`; no force-push), HTTPS on the Pages
  site, and Discussions.
- **Name availability.** Trademark and domain availability for "Habi" has not been checked.
- **Signing.** There are no macOS signing or notarization credentials, and Windows signing is
  not implemented. Until both exist, installers are unsigned and users see Gatekeeper or
  SmartScreen warnings. The `habi` command-line binary is not signed or notarized on either
  platform.
- **Client smoke tests** have not been run against installed Claude Code, Cursor and Codex.
- **Manual Windows smoke test.** The Windows installers are built in CI but have not been
  installed and used by hand.
- **Live Git hosts.** Pull/merge request creation, status and revisions are tested against
  stand-in `gh`/`glab` programs, not live GitHub or GitLab.

Resolved:

- **License:** Apache-2.0 (`LICENSE`, `NOTICE`, `license` in every manifest and the desktop
  bundle). Third-party notices are generated by `node scripts/third-party-notices.mjs`,
  checked in CI, and bundled with the app; dependency licenses are enforced by `deny.toml`.
- **Identifiers:** bundle identifier `com.acltabontabon.habi`; data directory qualifier
  `("com", "acltabontabon", "Habi")` in `crates/habi-core/src/brand.rs`. Changing either later
  moves users' local data.

## Next

1. Run the client smoke tests and record versions in
   [compatibility research](../dev/compatibility-research.md).
2. Exercise sharing against live GitHub and GitLab repositories.
3. User-scope installation and Cursor `.mdc` rules (see
   [future direction](product.md#future-direction)).
4. `habi skill …` commands for local skills (list, export, import); the core supports them.
