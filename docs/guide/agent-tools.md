# Agent tools

Habi installs skills and instructions for Claude Code, Cursor, Codex, Gemini CLI, GitHub
Copilot, OpenCode and Junie. It writes ordinary files where each tool looks for them, shows you
every file before anything is written, and needs nothing running afterwards.

The paths on this page come from each tool's own documentation. The dated research, with
sources, is in [compatibility research](../dev/compatibility-research.md).

## Choosing agent tools

When you install an item, you choose the agent tools it is for. Habi preselects the ones the
project already uses, judged by what is at its root:

| Tool | Signs Habi looks for |
|---|---|
| Claude Code | `.claude/`, `CLAUDE.md` |
| Cursor | `.cursor/`, `.cursorrules` |
| Codex | `.codex/` |
| Gemini CLI | `.gemini/`, `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/skills/` |
| OpenCode | `.opencode/`, `opencode.json`, `opencode.jsonc` |
| Junie | `.junie/` |

`AGENTS.md`, `.agents/` and `.mcp.json` are shared by several tools, so they name none. When
the desktop app finds no signs, it preselects Claude Code; the command line asks you to name
the tools with `--client`. You can change the choice in the review.

## Where files go in a project

**Skills.** Habi writes into one or both of two folders. It never writes into a folder that
only one tool owns (`.cursor/skills`, `.gemini/skills`, `.github/skills`, `.opencode/skills`,
`.junie/skills`); it reads those, so a skill already there is found.

| | Claude Code | Cursor | Codex | Gemini CLI | GitHub Copilot | OpenCode | Junie |
|---|---|---|---|---|---|---|---|
| Reads `.agents/skills` | no | yes | yes | yes | yes | yes | yes |
| Reads `.claude/skills` | yes | yes | no | no | yes | yes | no |

Habi writes as few copies as it can:

| Agent tools selected | Skill written to |
|---|---|
| Any of Codex, Gemini CLI, Junie, Cursor, GitHub Copilot and OpenCode, without Claude Code | `.agents/skills/<name>/` |
| Claude Code, with or without Cursor, GitHub Copilot and OpenCode | `.claude/skills/<name>/` |
| Claude Code and any of Codex, Gemini CLI and Junie | Both folders, as two ordinary copies |

**Instructions** go into a managed section of `AGENTS.md`. Codex, Cursor, GitHub Copilot,
OpenCode and Junie read it directly. Claude Code and Gemini CLI read their own files, so Habi
adds a one-line import when instructions are installed for them, and removes it with the last
one:

| Tool | File | Line |
|---|---|---|
| Claude Code | `CLAUDE.md`, or `.claude/CLAUDE.md` when only that one exists | `@AGENTS.md` (`@../AGENTS.md` from `.claude/`) |
| Gemini CLI | `GEMINI.md` | `@./AGENTS.md` |

**MCP servers** (optional, never with secrets) go into the file each tool reads:

| Tool | File | Secrets are written as |
|---|---|---|
| Claude Code, GitHub Copilot | `.mcp.json` (one entry serves both) | `${VAR}` |
| Cursor | `.cursor/mcp.json` | `${env:VAR}` |
| Codex | `.codex/config.toml` | `env_vars` |
| Gemini CLI | `.gemini/settings.json` | `${VAR}` in `env`. A bearer token for a remote server is not written, because Gemini CLI does not expand variables in headers. |
| OpenCode | `opencode.json`, under `mcp` | `{env:VAR}` |
| Junie | `.junie/mcp/mcp.json` | `${VAR}`. Junie does not document expansion; the review says so. |

`.habi/lock.json` records what Habi installed. Commit it to share that record with your team,
or ignore it.

## Where files go on this machine

You can also install a skill into your own skill folders, so every project on this machine
gets it ([My skills](my-skills.md#on-this-machine) shows how). The same rule picks the folders,
relative to your home folder: `~/.claude/skills` and `~/.agents/skills`. Instructions and MCP
servers are never installed this way.

- Habi records what it installed in `~/.habi/lock.json`, so it can update and remove those
  skills later. A skill it did not install is never changed or removed, and a folder of the
  same name that it did not install is a conflict, not an overwrite.
- Habi preselects the tools you have set up, judged by their folders in your home folder
  (`~/.claude`, `~/.cursor`, `~/.codex`, `~/.gemini`, `~/.copilot`, `~/.config/opencode`,
  `~/.junie`), and Claude Code when it finds none.
- A personal skill and a project skill can share a name. Claude Code uses the personal copy;
  Gemini CLI uses the project's; the other tools do not document an order. The review says
  which, and lists the projects Habi knows that hold a skill of the same name.
- For a community library, or one from the [catalog](../library-authors/catalog.md), the
  review warns that the skill is not audited: every project's agents will read it.

## What you may need to do in the tool

- **Claude Code** asks you to approve the servers in a project's `.mcp.json`; until then they
  show as pending. A `CLAUDE.md` normally stops Claude Code from reading `AGENTS.md`; the
  `@AGENTS.md` line makes it read the instructions anyway.
- **Codex** reads a project's `.codex/config.toml` only when you mark the project as
  trusted, and an `AGENTS.override.md` replaces `AGENTS.md` in its folder.
- **GitHub Copilot** in VS Code asks you to trust an MCP server before it starts. Its
  documentation does not say whether it expands `${VAR}` in `.mcp.json`, so check that a
  server that needs a secret receives it. Habi writes only the portable files; it does not
  write the deprecated `.vscode/mcp.json`.
- **Gemini CLI**: its documentation does not say whether `.gemini/settings.json` applies in a
  folder you have not trusted. Habi never edits other settings in that file.
- **OpenCode** also reads `opencode.jsonc`. Habi writes `opencode.json` and does not edit a
  file that has comments; the review names it as a conflict instead.
- **Junie** documents no variable expansion in `mcp.json`: check that a server that needs a
  secret receives it.
- **Cursor, GitHub Copilot and OpenCode**, selected together with Claude Code and one of Codex,
  Gemini CLI and Junie, find the same skill in both `.agents/skills` and `.claude/skills`.
  Their documentation does not say what happens then; the review names the tools affected.

## How Habi writes

- **Copies, not symbolic links.** When both skill folders are needed, Habi writes two ordinary
  copies. Habi refuses to write through or create symbolic links (see the
  [security model](../project/security-model.md)), links are unreliable on Windows, and a
  copy keeps each tool's files independently editable. The lock file tracks both copies, and
  edits to either are detected separately. If the project already links one skills folder to
  the other, Habi writes a single copy (see [Symbolic links](#symbolic-links-in-the-project)).
- **Skill files are copied as they are.** Habi does not rewrite `SKILL.md` frontmatter, so
  third-party fields, licensing and unknown keys are kept exactly. The optional `habi.yaml`
  is copied too; agent tools ignore unknown files in a skill folder.
- **No Cursor `.mdc` rules** in this release. Shared instructions go to `AGENTS.md` only.
- **MCP entries.** Habi adds a server only when the item suggests one, you turn on *Add
  suggested MCP configuration* (`--mcp` on the command line), and the tool's file has no entry
  with that name.
  - Several installed items can need the same server. Habi adds it once and records it for
    each; it is removed only when no installed item needs it.
  - An update replaces an entry Habi wrote with the library's new definition, in place. An
    entry someone edited is left alone, and the review says so.
  - A configuration file Habi created is deleted when its last server is removed. A file that
    existed before is kept, even if empty.
  - A UTF-8 byte order mark and CRLF line endings are kept. JSON files are rewritten with
    standard formatting, and the review notes it. Other servers and keys are never changed.
- **Line endings.** Habi writes library content as it is (normally LF). A checkout with
  `core.autocrlf=true` turns those files into CRLF; Habi compares files and sections without
  regard to line endings, so that is not a local edit. A section added to a CRLF `AGENTS.md`
  or `CLAUDE.md` uses CRLF too.
- **`AGENTS.md` size.** Habi appends its sections at the end. When the file would grow past
  Codex's default 32 KiB limit, the review says so: Codex ignores what comes after the limit,
  so Habi's sections are the first to be cut.
- **Instruction ids.** A section's marker is the item id. Two libraries that ship instructions
  with the same id cannot both be installed in one project; the second is reported as a
  collision that names both.

## Symbolic links in the project

Habi never writes through a symbolic link, and refuses any link that leads outside the
project (or into `.git`). Links that stay inside the project are common layouts, and Habi
recognizes them:

| Layout | What Habi does |
|---|---|
| `CLAUDE.md -> AGENTS.md` | Claude Code already reads the instructions through the link, so Habi adds no import. Sections are written to `AGENTS.md`. |
| `CLAUDE.md` -> another file in the project | A *symbolic link* conflict: add `@AGENTS.md` to the link's target yourself (or replace the link with a regular file) and preview again, or keep it as it is (Claude Code then does not read `AGENTS.md` through it). |
| `.claude/skills -> ../.agents/skills` (or a link per skill folder) | One copy, written in the real folder (`.agents/skills/<name>`) and recorded for the tools both folders serve. Copies Habi wrote under `.claude/skills` before the link existed are no longer tracked and are never deleted through the link. The same applies in the other direction. |
| A skills folder linked anywhere else in the project | A *symbolic link* conflict: point the link at `.agents/skills` (or `.claude/skills`), or replace it with a regular folder, then preview again. |
| Any other file reached through a link | The preview stops and names the link and its target; replace the link with a regular file or folder. |

## Not supported

- **Windsurf (Devin Desktop).** Its skill folders are documented, but no project MCP file
  could be confirmed, so it is left out rather than half supported.
- **Antigravity CLI**, which replaces Gemini CLI for some users. Its paths appear only in
  third-party posts so far.
- Hooks, subagents, plugins and extensions of any tool, and tool settings beyond the MCP entry.

## What is verified

| Claim | How it is checked |
|---|---|
| Files are written to the documented paths and formats | Automated tests (`crates/habi-core/tests/install_lifecycle.rs`, `machine_install.rs`, `clients::mcp` unit tests) |
| Existing JSON and TOML keys and formatting are kept | Unit tests with representative files |
| An agent tool discovers and loads the skill | **Not automated.** Checked by hand with the [smoke tests](../dev/compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it) |
| An agent follows the instructions | Not claimed by Habi |

Installed means the files are where the agent looks. Whether the smoke tests have been run
for this release is tracked in [Project status](../project/status.md#known-limitations).
