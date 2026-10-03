# Habi

**Find what applies. Improve what works. Share what you learn.**

[![CI](https://github.com/acltabontabon/habi/actions/workflows/ci.yml/badge.svg)](https://github.com/acltabontabon/habi/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Developers who work with AI coding agents keep learning useful things: a review checklist
that catches what the old one missed, a script that makes a migration safe, the instruction a
skill was lacking. Most of it stays on one machine. Habi is a local knowledge layer for that
work. It brings the skills and instructions that already exist — yours, your team's, the
community's — into the project you are working on, and carries what you refine there back to
where the next developer will find it.

![Habi showing which team skills fit a Spring Boot service, and why, down to the file and line](docs/screenshots/02-project-recommendations.jpg)

Knowledge lives in several places; Habi keeps them apart and presents them as one layer:

| | |
|---|---|
| **My skills** | Yours, on this machine: drafts, experiments, edited copies. |
| **Team libraries** | Git repositories your team curates and reviews. |
| **Community libraries** | Published by others and not reviewed by your team. |
| **The project** | The repository you are working in: what it already contains, and which of the above applies to it. |

- **Find.** Open a repository; Habi shows which skills and instructions apply and *why*, down
  to the file and line. It reads build files and structure only — nothing is built or run.
- **Apply.** Install for the agent tools you already use (Claude Code, Cursor, Codex, Gemini CLI, GitHub
  Copilot, OpenCode, Junie) with a
  preview of every file. Every install, update or removal is a reviewed plan that can be
  restored.
- **Refine.** Edit a copy as a complete package — instructions, scripts, references, assets.
  It remembers where it came from, so your changes stay connected to the original.
- **Share.** Send the refinement to a team library as a pull or merge request, read the
  review in Habi, and revise on the same request. Without a host integration, export a patch.
- **Reuse.** Teammates get it when they refresh. Installed copies update three ways, so local
  adaptations are kept and conflicts are explained.

Principles:

- **Honest about evidence.** "Applies", "needs information" and "does not apply" are kept
  apart, and so are readiness, installation and evidence. Unknown is a valid answer.
- **Standard formats.** Skills are ordinary [Agent Skills](https://agentskills.io) folders;
  shared instructions go into `AGENTS.md`. Habi metadata is an optional sidecar; everything
  keeps working without Habi.
- **Local.** No account, no telemetry, no cloud service, no model calls. Git uses your existing
  credentials.

A repository and an idea are enough to start; libraries are optional.

## Status and platforms

**Pre-release (0.1.0).** There are no prebuilt downloads yet; build from source (below).
[Project status](docs/project/status.md) lists what is verified, the known limitations and
the release blockers.

| Platform | |
|---|---|
| macOS 11 or later | Supported, Apple Silicon and Intel (one universal build) |
| Windows | Supported |
| Linux | Not supported |

## Build from source

You need [Rust](https://rustup.rs) (the exact version installs itself from
`rust-toolchain.toml`), [Node.js](https://nodejs.org) 24 or newer, Git, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system: on macOS,
`xcode-select --install`; on Windows, the Microsoft C++ Build Tools and WebView2.

```sh
git clone https://github.com/acltabontabon/habi.git
cd habi/apps/desktop
corepack enable          # provides the pinned pnpm version
pnpm install
pnpm tauri dev           # the first build takes a few minutes
```

[Getting started](docs/guide/getting-started.md) walks through the sample workspace and your
first project. Nothing in your project changes until you review and confirm a plan.

### Command line

```sh
cargo install --path crates/habi-cli       # puts `habi` on your PATH

habi source add Team git@github.com:your-team/skills.git --branch main
# …or a library folder on this machine (relative paths are fine):
habi source add Local ./fixtures/libraries/example-team-library
# …or a community library (published by others, not reviewed by your team):
habi source add Superpowers https://github.com/obra/superpowers --community
habi source refresh

cd path/to/project                         # any folder inside it works
habi recommend                             # what fits, and why in one line
habi explain liquibase-migration-review    # the full reasoning, and its checks
habi install liquibase-migration-review --client claude-code,cursor
habi status                                # local edits, updates
habi update                                # three-way, previewed
```

Commands find the project from the current folder (nearest `.habi/lock.json`, else the Git
root); `-C <folder>` names it explicitly. Every change is previewed and asks first; `--yes`
skips the question and `--dry-run` only previews. With `--json`, each command prints exactly
one JSON document (errors as `{"error": {"code", "message"}}` with a nonzero exit) and
changes need `--yes`.

Correct what Habi detected, and verify an item with its own check:

```sh
habi declare tag db:jooq --absent --note "migrated away"   # reversible
habi declarations                                          # ids for `habi undeclare <id>`
habi check liquibase-migration-review changelog-is-wellformed        # preview the command
habi check liquibase-migration-review changelog-is-wellformed --run  # run it (asks first)
```

Share an improvement with the library's maintainers:

```sh
habi contribute start Team .claude/skills/my-skill   # or: --item <library item>
habi contribute show <id>                            # what would leave this machine, where to edit
habi contribute describe <id> --title "…" --message "…"
habi contribute commit <id>                          # a branch in Habi's cache; nothing is pushed
habi contribute publish <id> --open-request          # push and open a pull/merge request
```

## For library authors

A library is a Git repository (or a subfolder of one) containing skill folders with
`SKILL.md`. To make a skill match projects, add an optional `habi.yaml` next to it:

```yaml
habi: 1
title: Liquibase migration review
applies_when:
  all:
    - tag: framework:spring-boot
    - dependency: org.liquibase:liquibase-core
excludes:
  tag: db:jooq
requires:
  tools:
    - name: Maven
      commands: [./mvnw, mvn]
```

Validate with `habi validate path/to/library`. See [Habi metadata](docs/library-authors/metadata-schema.md)
and the [example library](fixtures/libraries/example-team-library).

## Documentation

**Using Habi** ([docs/guide](docs/guide))

- [Getting started](docs/guide/getting-started.md): the sample workspace, your first project, what Habi changes
- [My skills](docs/guide/my-skills.md): creating, importing, previewing and using your own skills
- [Sharing](docs/guide/sharing.md): sending improvements to a library for review
- [Agent tools](docs/guide/agent-tools.md): what Habi writes for each supported agent tool
- [Recovery](docs/guide/recovery.md): journals, rollback, restore, stale caches

**Writing libraries** ([docs/library-authors](docs/library-authors))

- [Metadata schema](docs/library-authors/metadata-schema.md): `habi.yaml`, `habi-library.yaml`, conditions, versioning
- [Detectors](docs/library-authors/detectors.md): what inspection recognizes, and its limits

**The project** ([docs/project](docs/project))

- [Product contract](docs/project/product.md): principles, what Habi is not, future direction
- [Status](docs/project/status.md): what is verified, known limitations, release blockers
- [Security model](docs/project/security-model.md): threat boundaries and residual trust

**Working on Habi** ([docs/dev](docs/dev))

- [Architecture](docs/dev/architecture.md): crates, modules, data locations, the development bridge
- [Release](docs/dev/release.md): versioning, signing, the release procedure
- [Test data](docs/dev/test-data.md): fixtures, the sample workspace, the seed script
- [Design](docs/dev/design.md): visual direction and accessibility
- [Reuse assessment](docs/dev/reuse-assessment.md): dependencies, and why custom logic exists
- [Compatibility research](docs/dev/compatibility-research.md): client documentation and smoke tests
- [Website](website/): the site at acltabontabon.com/habi. `pnpm dev` in `website/`; its data
  comes from `pnpm snapshot` and `website/scripts/journey.sh`

## Contributing

Bug reports, ideas and pull requests are welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md).
Questions go to [SUPPORT.md](SUPPORT.md). Please report security problems privately as
described in [SECURITY.md](SECURITY.md).

## Maintenance

Habi is maintained by one developer (Alvin Cris Tabontabon) in their own time. Issues and
pull requests are read, but responses are best effort; security reports come first. See
[SUPPORT.md](SUPPORT.md).

## License

Habi is licensed under the [Apache License 2.0](LICENSE). It bundles third-party software and
fonts under their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
