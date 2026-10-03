# Habi

**Find what applies. Improve what works. Share what you learn.**

[![CI](https://github.com/acltabontabon/habi/actions/workflows/ci.yml/badge.svg)](https://github.com/acltabontabon/habi/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Habi is a local desktop app for the skills and instructions you give AI
coding agents. Open a repository and Habi shows which skills fit it, and why, down to the file
and line. Install them for the agent tools you already use, improve them as you work, and send
the improvement back to your team's library as a pull request.

![Habi showing which team skills fit a Spring Boot service, and why, down to the file and line](docs/media/project.jpg)

## What it does

- **Find.** Habi reads a repository's build files and structure (nothing is built or run) and
  sorts every skill from your libraries into *fits this project*, *needs information* and
  *does not apply*, each with its evidence.
- **Apply.** Install for Claude Code, Cursor, Codex, Gemini CLI, GitHub Copilot, OpenCode and
  Junie, in a project or on this machine. You see every file before anything is written, and
  every change to a project can be restored.
- **Refine.** Edit a copy as a complete package: instructions, scripts, references, assets.
  The copy remembers where it came from, so library updates arrive as a three-way review.
- **Share.** Send your improvement to a team library as a branch, a pull or merge request, or a
  patch. Read the review in Habi and revise on the same request.

Skills are ordinary [Agent Skills](https://agentskills.io) folders and shared instructions go
into `AGENTS.md`, so everything keeps working without Habi. There is no account, telemetry,
cloud service or model call; Git uses your existing credentials.

## Status and platforms

**0.1.0.** Installers for macOS and Windows are on the
[Releases page](https://github.com/acltabontabon/habi/releases). They are not signed by Apple or
Microsoft, so the first launch asks you to confirm once
([how](docs/guide/getting-started.md#installing)); updates are signed with Habi's own key. You
can also build from source. What is verified, the known limitations and what is left before the
release are in [Project status](docs/project/status.md).

| Platform | |
|---|---|
| macOS 11 or later | Supported, Apple Silicon and Intel (one universal build) |
| Windows | Supported |
| Linux | Not supported |

## Build from source

You need [Rust](https://rustup.rs) (the pinned version in `rust-toolchain.toml` installs
itself), [Node.js](https://nodejs.org) 24 or later, Git, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system: on macOS,
`xcode-select --install`; on Windows, the Microsoft C++ Build Tools and WebView2.

```sh
git clone https://github.com/acltabontabon/habi.git
cd habi/apps/desktop
corepack enable          # provides the pinned pnpm version
pnpm install
pnpm tauri dev           # the first build takes a few minutes
```

[Getting started](docs/guide/getting-started.md) walks you through the sample workspace and
your first project.

## Documentation

Read it on the site at [acltabontabon.com/habi/docs](https://acltabontabon.com/habi/docs/), or
here in [`docs/`](docs/README.md); both are the same pages.

- **Using Habi:** [getting started](docs/guide/getting-started.md),
  [My skills](docs/guide/my-skills.md), [sharing](docs/guide/sharing.md),
  [agent tools](docs/guide/agent-tools.md), [recovery](docs/guide/recovery.md)
- **Writing libraries:** [Habi metadata](docs/library-authors/metadata-schema.md),
  [detectors](docs/library-authors/detectors.md), [library catalog](docs/library-authors/catalog.md)
- **The project:** [status](docs/project/status.md), [product contract](docs/project/product.md),
  [security model](docs/project/security-model.md)

The [documentation index](docs/README.md) lists every page, including those for working on
Habi itself.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md);
questions go to [SUPPORT.md](SUPPORT.md). Report security problems privately as described in
[SECURITY.md](SECURITY.md).

Habi is maintained by one developer, Alvin Cris Tabontabon, in their own time. Issues and pull
requests are read, but responses are best effort, and security reports come first. If Habi saves
you time, you can [buy me a coffee](https://ko-fi.com/aclt_attic).

## License

Habi is licensed under the [Apache License 2.0](LICENSE). It bundles third-party software and
fonts under their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
