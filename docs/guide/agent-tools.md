# Agent tools: what Habi writes for Claude Code, Cursor and Codex

When you install an item, you choose the agent tools it is for. Habi writes ordinary files
in the project, where each tool looks for them, and the review shows every file before
anything is written. Nothing needs Habi running afterwards.

The paths below come from each tool's own documentation; the dated research, with sources,
is in [compatibility research](../dev/compatibility-research.md).

## Where files go

| | Claude Code | Cursor | Codex |
|---|---|---|---|
| Skills | `.claude/skills/<name>/` | `.agents/skills/<name>/` (also reads `.claude/skills/`) | `.agents/skills/<name>/` |
| Instructions | A managed section in `AGENTS.md`, and an `@AGENTS.md` line in `CLAUDE.md` | A managed section in `AGENTS.md` | A managed section in `AGENTS.md` |
| MCP servers (optional) | `.mcp.json`, secrets as `${VAR}` | `.cursor/mcp.json`, secrets as `${env:VAR}` | `.codex/config.toml`, secrets as `env_vars` |

Habi writes as few skill copies as it can:

| Agent tools selected | Skill written to |
|---|---|
| Codex and/or Cursor | `.agents/skills/<name>/` |
| Claude Code, with or without Cursor | `.claude/skills/<name>/` |
| Claude Code and Codex (with or without Cursor) | Both folders, as two ordinary copies |

## What you may need to do in the tool

- **Claude Code** asks you to approve the servers in a project's `.mcp.json`; until then they
  show as pending. A `CLAUDE.md` normally stops Claude Code from reading `AGENTS.md`; the
  `@AGENTS.md` line Habi adds makes it read the instructions anyway.
- **Codex** reads a project's `.codex/config.toml` only when you mark the project as
  trusted, and an `AGENTS.override.md` replaces `AGENTS.md` in its folder.
- **Cursor**, with all three tools selected, finds the same skill in both `.agents/skills`
  and `.claude/skills`. Its documentation does not say what happens then; the install review
  notes it.

## How Habi writes

- **Copies, not symlinks.** When both `.agents/skills` and `.claude/skills` are needed
  (Claude Code + Codex), Habi writes two ordinary copies. Habi refuses to write through or
  create symbolic links (see the [security model](../project/security-model.md)), symlinks
  are unreliable on Windows, and a copy keeps each client's files independently editable.
  The lock file tracks both copies; drift in either is detected separately. If the project
  already links one skills folder to the other, Habi writes a single copy instead (see
  [Symbolic links in the project](#symbolic-links-in-the-project)).
- **Skill files are copied verbatim.** Habi does not rewrite SKILL.md frontmatter, so
  third-party fields, licensing and unknown keys are preserved exactly. The optional
  `habi.yaml` sidecar is copied too; clients ignore unknown files in a skill folder.
- **Cursor `.mdc` rules are not written** in this release. Portable instructions go to
  `AGENTS.md` only.
- **MCP:** Habi adds a server entry only when the item declares a suggested definition, you
  enable "Add suggested MCP configuration", and the client's project file lacks an entry
  with that name. Codex project config is noted as requiring a trusted project.
  - Several installed items can need the same server. Habi adds it once and records it for
    each of them; it is removed only when no installed item needs it any more.
  - An update replaces an entry Habi wrote with the library's new definition, in place. An
    entry someone edited is left alone and the preview says so.
  - A configuration file Habi created is deleted when its last server is removed. A file
    that existed before is kept, even if empty.
  - A UTF-8 byte order mark and CRLF line endings in an MCP file are kept when Habi
    rewrites it. JSON files are rewritten with standard formatting, and the preview notes it.
  - Other servers and keys in the file are never changed.
- **Line endings.** Habi writes library content as it is (normally LF). A checkout with
  `core.autocrlf=true` turns those files into CRLF; Habi compares installed files and
  sections without regard to line endings, so that is not a local edit. A section added to a
  CRLF `AGENTS.md` or `CLAUDE.md` uses CRLF too.
- **AGENTS.md size.** Habi appends its sections at the end of `AGENTS.md`. When the file
  would be larger than Codex's default 32 KiB limit, the preview says so: Codex ignores
  what comes after the limit, so Habi's sections are the first to be cut.
- **Instructions ids.** A section's marker is the item id. Two sources that ship
  instructions with the same id cannot both be installed in one project; the second is
  reported as a collision that names both sources.

## Symbolic links in the project

Habi never writes through a symbolic link, and refuses any link that leads outside the
project (or into `.git`). Links that stay inside the project are common layouts, and Habi
recognizes them:

| Layout | What Habi does |
|---|---|
| `CLAUDE.md -> AGENTS.md` | Claude Code already reads the instructions through the link, so Habi adds no `@AGENTS.md` import. Sections are written to `AGENTS.md`. |
| `CLAUDE.md` -> another file in the project | A *symbolic link* conflict: add `@AGENTS.md` to the link's target yourself (or replace the link with a regular file) and preview again, or keep it as it is (Claude Code then does not read `AGENTS.md` through it). |
| `.claude/skills -> ../.agents/skills` (or a link per skill folder) | One copy, written in the real folder (`.agents/skills/<name>`) and recorded for the clients both folders serve. Copies Habi wrote under `.claude/skills` before the link existed are no longer tracked and are never deleted through the link. The same applies in the other direction. |
| A skills folder linked anywhere else in the project | A *symbolic link* conflict: point the link at `.agents/skills` (or `.claude/skills`), or replace it with a regular folder, then preview again. |
| Any other file reached through a link | The preview stops and names the link and its target; replace the link with a regular file or folder. |

## What is verified

| Claim | How it is checked |
|---|---|
| Files are written to the documented paths and formats | Automated tests (`crates/habi-core/tests/install_lifecycle.rs`, `clients::mcp` unit tests) |
| Existing JSON/TOML keys and formatting are preserved | Unit tests with representative files |
| A client actually discovers and loads the skill | **Not automated.** Checked by hand with the [smoke tests](../dev/compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it) |
| An agent follows the instructions | Not claimed by Habi |

Installed means the files are where the agent looks. Whether the smoke tests have been run
for this release is tracked in [Project status](../project/status.md#known-limitations).
