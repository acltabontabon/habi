# 2. Installing on this machine

Date: 2026-10-03. Status: accepted, built.

## Context

A skill from a library or from My skills could only be added to a project. Someone who
wanted it in every project copied the folder into `~/.claude/skills` by hand, and Habi then
could neither update nor remove it, nor tell that it came from a library. Habi already read
those folders (*On this machine* in My skills) but never wrote to them.

## Decision

- Add a second install target, this machine, for library skills (*Add to this machine…*) and
  for My skills (**Use → On this machine…**), through the same reviewed plan as a project
  install.
- Reuse the project machinery unchanged by planning against the home folder as the root. The
  folders written are the same relative paths, `.claude/skills` and `.agents/skills`, chosen
  by the same rule.
- Keep the record in `~/.habi/lock.json`. The planner, journal, restore and status code all
  read the record inside the root they work on; keeping it in Habi's data folder would have
  meant threading a second root through all of them. The cost is one small hidden folder in
  the home directory.
- Skills only. Instruction files are refused up front and MCP configuration is never written.
- Never touch a skill Habi did not install: a folder of the same name is a conflict, and a
  symbolic link along the path is refused with no override (a personal skills folder is often
  a link into a dotfiles repository).
- Show, in the review, every known project that holds a skill of the same name and which copy
  each tool uses (Claude Code: the personal one; Gemini CLI: the project's; the others do not
  document it). For a community or catalog library, warn that the skill is not audited. The
  first proposal gated the confirm button behind a checkbox; the built version warns without
  blocking.

## Consequences

- A personal install can silently shadow what a team ships in a repository for Claude Code;
  the review is where the person learns that.
- If `~/.habi/lock.json` is deleted, Habi forgets what it installed. The skills stay and show
  as ordinary personal skills.
- Machine operations are journaled, but restoring one is available only in the core: no
  screen offers it yet, and the command line has no machine commands. Both are listed in
  [known limitations](../../project/security-model.md#known-limitations).
- Tests inject a fake home folder (`tests/machine_install.rs`, `tests/machine_skills.rs`) and
  never touch the real one.
