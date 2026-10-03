# More agent clients

Status: built (skills, MCP and the GEMINI.md import). The clients preselected in an install come
from what the project already uses, not from a setting. Adds Gemini CLI, GitHub Copilot, OpenCode and Junie next to Claude Code, Cursor and
Codex. Folders, file formats and the pages they come from are in
[compatibility research §8](compatibility-research.md#8-gemini-cli-copilot-opencode-and-junie).

## Problem Statement

Habi installs a skill, an MCP server and an instruction file for three clients, and the three are
hardcoded: `ClientId` has three variants and `skill_dirs` in `clients/layout.rs` tests three booleans.
Most other common agents read the same `SKILL.md` folders, so a person using Gemini CLI, Copilot,
OpenCode or Junie gets nothing from Habi, or has to copy folders by hand.

## Goal

A person can pick any of seven clients when they add a skill to a project or to the machine. Habi
writes the smallest set of folders that serves the chosen clients, and for the clients that have a
project MCP file it writes the MCP entry in that client's own format. Nothing Habi writes is claimed
to have been loaded by a client.

## In Scope

- Four new clients: Gemini CLI, GitHub Copilot, OpenCode, Junie.
- Skills for all four. Every one reads `.agents/skills`, so no new folder is written for any of them.
- MCP for all four, one writer each:
  - Copilot: the portable `.mcp.json`, the file Claude Code already uses, so one write serves both.
  - Junie: `.junie/mcp/mcp.json`, the same `mcpServers` shape without a `type`.
  - Gemini CLI: `.gemini/settings.json`, merged into the existing file, `httpUrl` for remote servers.
  - OpenCode: `opencode.json`, under `mcp`, with `type: local | remote` and `{env:VAR}`.
- Instructions: `AGENTS.md` serves OpenCode, Junie and Copilot unchanged. For Gemini CLI, which reads
  only `GEMINI.md` by default, a `GEMINI.md` that imports `AGENTS.md`.
- Replace the three hardcoded booleans in `skill_dirs`, `readers_of`, `precedence` and
  `USER_SKILL_DIRS` with one table: for each client, the project folders and home folders it reads.
  The rule stays "the fewest folders that serve every chosen client", now as a small cover problem
  instead of a special case.
- "On this machine" and the project page read the new clients' own folders (`~/.gemini/skills`,
  `~/.copilot/skills`, `~/.config/opencode/skills`, `~/.junie/skills`) so a skill there is seen.
  Habi never writes to them, as with `~/.cursor/skills` today.
- The review dialog and the CLI list the new clients. The install review preselects the clients
  the project already uses (the files at its root), or Claude Code when it shows none; the
  "preselected clients" setting is removed.

## Out of Scope

- **Windsurf (Devin Desktop).** Its skills folders are documented, but no project MCP file could be
  confirmed, so it is left out entirely rather than half supported.
- **Antigravity CLI**, which replaces Gemini CLI for free-tier users. Its paths come only from
  third-party posts. Add it after reading Google's own documentation.
- Hooks, subagents, plugins and extensions of any client.
- Writing a client's own config beyond the MCP entry (`settings.json` keys other than `mcpServers`,
  `opencode.json` keys other than `mcp`).
- Per-client frontmatter extensions. Only the six spec fields are written, as now.
- Cursor `.mdc` rules, Copilot `.github/copilot-instructions.md`, and other client-specific rule files.

## Constraints

- Same safety rules as every install: reviewed plan, journal, atomic writes, restore, conflicts,
  nothing written before confirmation, no network, no git.
- Existing config files are merged by server name. Unrelated keys, key order, comments where the
  format allows them, a byte-order mark and CRLF line endings are kept, as in `clients/mcp.rs`.
- A file Habi cannot parse without losing something (for example `opencode.jsonc` with comments) is
  a conflict that is shown, never rewritten.
- Secrets are never written inline. Each client gets its own reference syntax or none; where none is
  documented, the review says so and asks for a value to be set in the environment.
- Undocumented behavior is labelled "not documented", not guessed.
- Existing installs, locks and the on-disk lock format keep working. Client slugs are kebab-case
  (`gemini-cli`, `copilot`, `opencode`, `junie`) and the existing three do not change.

## Risks

- **Duplicates.** With Claude Code chosen together with Copilot, OpenCode or Cursor, the same skill
  is found through `.claude/skills` and `.agents/skills`. None of them documents what it does with a
  repeated name. The current Cursor-only note becomes a general one that names the clients affected.
- **Gemini's settings file.** `.gemini/settings.json` also holds unrelated settings, and a
  project's settings may be ignored in a folder Gemini does not trust. Whether that applies to
  `mcpServers` is not documented in the pages read. Say so in the review.
- **Gemini's import syntax.** Gemini CLI documents `@file.md` imports in `GEMINI.md`, with relative
  paths; Habi writes `@./AGENTS.md`. Whether the import is followed from inside Habi's marker
  comments is checked by the smoke test.
- **OpenCode config format.** `opencode.json` may be `.jsonc`; a file with comments or trailing
  commas needs a different merge than plain JSON.
- **Copilot is a family.** VS Code, Copilot CLI, the desktop app and the cloud agent read different
  files. Only the portable ones are written; the deprecated `.vscode/mcp.json` is not.
- **Env syntax.** Gemini expands `$VAR` only inside `env`, not in `httpUrl` or `headers`; OpenCode uses
  `{env:VAR}`; Junie documents none. A remote server that needs a secret in a header cannot be written
  safely for Gemini or Junie and must be reported as such.
- **Docs move fast.** Gemini CLI is already being retired in favour of Antigravity. Every path here
  carries a research date, and the smoke tests are rerun before release.

## Acceptance Criteria

1. Seven clients can be chosen when adding a skill to a project and to the machine.
2. Choosing any of the four new clients alone writes only `.agents/skills/<name>/`.
3. Choosing Claude Code with any of them writes `.claude/skills/<name>/` and `.agents/skills/<name>/`
   and the review names each client that will find two copies.
4. Choosing Copilot with Claude Code writes one `.mcp.json` entry, not two.
5. Each MCP writer, given a stdio and a remote spec, produces the documented shape for its client, keeps
   unrelated content, and is removed again by a digest check that leaves a person's edits alone.
6. Gemini receives no `$VAR` in `httpUrl` or `headers`; the review lists what could not be written and why.
7. A `GEMINI.md` is created or extended with one import line, idempotently, and a file that already
   contains it is left as it is.
8. "On this machine" lists skills found in the new clients' own folders and never writes there.
9. A project with a lock written before this change opens, shows its installs, and updates and
   removes them unchanged.
10. No test reads or writes the real home folder.

## Implementation Notes

- Replace `ClientId::ALL: [ClientId; 3]` consumers that assume three. TypeScript bindings are
  generated by `ts_rs`, so the UI picks the new variants up after regenerating them.
- `layout.rs`: one `ClientFolders` table (`project: &[&str]`, `home: &[&str]`, `writes_to`). Keep the
  existing unit tests as the first cases; add one per new client and one for the all-seven case.
- `mcp.rs`: `config_path`, `json_entry`, `translation_notes`, `entry_digest`, `insert`, `replace`,
  `is_empty_config` and `remove` each match on `ClientId`. Add the arms; Copilot shares Claude Code's
  path and shape, so it adds no writer. Gemini and OpenCode nest under `mcpServers` / `mcp` inside a
  file that has other keys, so `is_empty_config` must treat "only that key, empty" as empty and
  anything else as not.
- Order of work: layout table and skills for all four, then MCP in this order: Copilot, Junie, Gemini,
  OpenCode, then `GEMINI.md`.
- Update `docs/guide/agent-tools.md`, `CHANGELOG.md` and the smoke-test list in the research doc.

## Open questions

- Does Gemini CLI read project `mcpServers` in an untrusted folder?
- Does Junie expand any variable syntax in `mcp.json`?
- Does Copilot read `AGENTS.md` in every surface Habi cares about, or only in VS Code?
