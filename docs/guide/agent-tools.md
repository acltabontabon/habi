# Agent tools

Habi installs for: **Claude Code · Cursor · Codex · Gemini CLI · GitHub Copilot · OpenCode · Junie**

It writes to standard folders, shows you every change first, and needs nothing running after.

(Details & sources in [compatibility research](../dev/compatibility-research.md).)

## Choosing which tools

When you install, Habi preselects tools the project already uses (detected by what's at the root).
You can change the selection in the review.

**Detection signals:**

| Claude Code | `.claude/`, `CLAUDE.md` |
| Cursor | `.cursor/`, `.cursorrules` |
| Codex | `.codex/` |
| Gemini CLI | `.gemini/`, `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/skills/` |
| OpenCode | `.opencode/`, `opencode.json`, `opencode.jsonc` |
| Junie | `.junie/` |

Shared folders (`AGENTS.md`, `.agents/`, `.mcp.json`) are detected separately. If no signs are
found, the desktop app defaults to Claude Code (CLI asks via `--client`).

## Where skills go

Habi writes to **one or both** of two shared folders (`.claude/skills/` and `.agents/skills/`).
It never writes into tool-specific folders (`.cursor/skills`, `.gemini/skills`, etc.) but reads
them, so existing skills are found.

**Which tools read which folders:**

| Folder | Readers |
|--------|---------|
| `.claude/skills/` | Claude Code, Cursor, GitHub Copilot, OpenCode |
| `.agents/skills/` | Cursor, Codex, Gemini CLI, GitHub Copilot, OpenCode, Junie |

**Habi writes as few copies as it can:**

- **Without Claude Code** → `.agents/skills/<name>/`
- **Claude Code + Cursor/Copilot/OpenCode only** → `.claude/skills/<name>/`
- **Claude Code + Codex/Gemini/Junie** → Both folders (two copies)

## Instructions

Go into a managed section of `AGENTS.md`. Most tools read it directly. Claude Code and Gemini
CLI get a one-line import instead (`@AGENTS.md`), which Habi adds when installing instructions.

## MCP servers (optional)

Each tool stores servers in its own file. Secrets use the tool's expansion format—never written
literally.

| Tool | File | Secret format |
|------|------|---|
| Claude Code, GitHub Copilot | `.mcp.json` | `${VAR}` |
| Cursor | `.cursor/mcp.json` | `${env:VAR}` |
| Codex | `.codex/config.toml` | `env_vars` |
| Gemini CLI | `.gemini/settings.json` | `${VAR}` in `env` |
| OpenCode | `opencode.json` | `{env:VAR}` |
| Junie | `.junie/mcp/mcp.json` | `${VAR}` |

**`.habi/lock.json`** — records all installs. Commit to share with your team, or ignore.

## Install on your machine

Install skills into `~/.claude/skills` or `~/.agents/skills` to use them in *all* your projects.
Same folder rules apply. Instructions & MCP servers aren't installed this way.

**Key details:**
- Habi tracks installs in `~/.habi/lock.json` for updates & removal later
- Skills you didn't install are never changed (name conflicts are flagged, not overwritten)
- If a skill exists in both personal and project folders: Claude Code uses personal; Gemini CLI
  uses project; others are unspecified (review notes it)
- Community libraries show a warning that skills aren't audited (agents read them all)

## Tool-specific notes

| Tool | What to know |
|------|---|
| **Claude Code** | Approves MCP servers in `.mcp.json` (show as pending until approved). `@AGENTS.md` import makes it read instructions. |
| **Codex** | Config only loads in trusted projects. Uses `AGENTS.override.md` to replace `AGENTS.md`. |
| **GitHub Copilot** | Trusts MCP servers on first use. Secret var expansion unclear—check it receives secrets. |
| **Gemini CLI** | May not apply settings outside trusted folders. Habi never edits other settings. |
| **OpenCode** | Reads both `opencode.json` & `opencode.jsonc`. Habi writes JSON only (skips files with comments). |
| **Junie** | No documented var expansion—verify servers receive secrets. |
| **Cursor + Copilot + OpenCode** | When paired with Claude Code and one of Codex/Gemini/Junie, tools see the same skill in both folders. Behavior undocumented; review flags it. |

## How Habi writes files

**Copies, not links.** Two ordinary copies when both folders needed (more reliable on Windows,
independently editable, tracked separately). Existing links are detected—[see
Symbolic links](#symbolic-links).

**Skill files as-is.** `SKILL.md` and `habi.yaml` are copied unchanged; frontmatter fields,
licensing, and unknown keys are preserved. Agent tools ignore unknown files.

**MCP servers** — added only when suggested and you opt in. One server per project even if
multiple items need it. Updates replace Habi's entries only; hand-edited entries stay untouched.
Formatting (UTF-8 BOM, CRLF) preserved; JSON reformatted with note in review.

**Line endings.** Library content copied as-is (usually LF). Checkouts with `core.autocrlf=true`
convert to CRLF; Habi ignores this in comparisons. New sections match the file's existing
endings.

**`AGENTS.md` size.** Appended at the end. If it would exceed Codex's 32 KiB limit, the review
warns—Codex ignores content past the limit.

**Instruction IDs.** Section marker = item ID. Two libraries with the same instruction ID can't
both install in one project (collision warning).

## Symbolic links

Habi never writes through links or creates them. Links inside the project are recognized:

| Situation | What Habi does |
|-----------|---|
| `CLAUDE.md → AGENTS.md` | Recognized; Habi writes to `AGENTS.md` (no import added). |
| `CLAUDE.md → other file` | Conflict; add `@AGENTS.md` to the target or replace with a file. |
| `.claude/skills → ../.agents/skills` | One copy in real folder; recorded for both tools. |
| Skills folder linked elsewhere | Conflict; point to `.agents/skills` / `.claude/skills` or replace. |
| Other files via links | Stops; replace link with regular file/folder. |

## Limitations

**Not supported:**
- Windsurf (Devin Desktop) — paths documented but MCP config unconfirmed
- Antigravity CLI — paths only in third-party posts
- Tool extensions, plugins, subagents, hooks, or settings beyond MCP

## Verification

| What's tested | How |
|---|---|
| Files written to correct paths & formats | Automated (`tests/install_lifecycle.rs`, `machine_install.rs`) |
| JSON/TOML formatting & keys preserved | Unit tests |
| Agent discovers & loads the skill | Hand-verified via [smoke tests](../dev/compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it) |
| Agent actually follows instructions | Not Habi's claim |
