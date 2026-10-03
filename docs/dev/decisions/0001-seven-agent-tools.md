# 1. Seven agent tools, two skill folders

Date: 2026-10-04. Status: accepted, built.

## Context

Habi first installed for Claude Code, Cursor and Codex, with the three hardcoded in the
client layout. Most other agent tools read the same `SKILL.md` folders, so people using
Gemini CLI, GitHub Copilot, OpenCode or Junie got nothing from Habi, or copied folders by
hand. Each of these tools also has a folder of its own, its own MCP file and its own syntax
for secrets ([compatibility research §8](../compatibility-research.md#8-gemini-cli-copilot-opencode-and-junie)).

## Decision

- Support Gemini CLI, GitHub Copilot, OpenCode and Junie next to the first three. Their slugs
  are `gemini-cli`, `copilot`, `opencode` and `junie`; the existing slugs do not change, so
  older lock files keep working.
- Describe each tool by the project and home folders it reads, in one table
  (`clients/layout.rs`), and write the fewest of the two shared folders, `.agents/skills` and
  `.claude/skills`, that serve every chosen tool. Never write a folder only one tool owns; read
  it, so skills already there are found.
- Write one MCP entry per tool in that tool's own file and syntax. Copilot shares Claude
  Code's `.mcp.json`, so one entry serves both. Where a tool documents no secret syntax
  (Junie), or does not expand variables where a secret would go (Gemini CLI headers), the
  review says so instead of guessing.
- Give Gemini CLI the `AGENTS.md` instructions through an `@./AGENTS.md` import in
  `GEMINI.md`, as Claude Code gets `@AGENTS.md` in `CLAUDE.md`.
- Preselect the tools a project already shows signs of using, instead of a global
  "preselected tools" setting, which was removed.
- Leave out Windsurf (no project MCP file could be confirmed) and Antigravity CLI (paths only
  in third-party posts) rather than support them halfway.

## Consequences

- A skill chosen for Claude Code together with Codex, Gemini CLI or Junie is written twice,
  as two ordinary copies. Cursor, Copilot and OpenCode then find it in both folders; none
  documents what it does with a repeated name, so the review names the tools affected.
- A file Habi cannot rewrite without losing something, such as an `opencode.jsonc` with
  comments, is a conflict to resolve by hand.
- Open questions are recorded as unverified in the research: whether Gemini CLI reads project
  MCP servers in an untrusted folder, whether Junie expands any variable syntax, and whether
  every Copilot surface reads `AGENTS.md`. The smoke tests cover them before a release.
- What Habi writes for each tool is documented for users in
  [Agent tools](../../guide/agent-tools.md).
