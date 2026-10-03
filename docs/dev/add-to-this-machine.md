# Add to this machine

Status: built. Follows "On this machine" on the My skills page, which reads the
person's own skill folders and never writes to them. This page covers the write side: putting a
skill there on purpose. Where the built version differs from what was first proposed, it says so
under [What was built](#what-was-built). Client folders and precedence come from
[compatibility research](compatibility-research.md).

## Problem Statement

A skill from a library, or one of My skills, can only be added to a project. A person who wants it
for themselves, in every project, has to copy a folder into `~/.claude/skills` by hand. Habi then
neither knows about it nor can update or remove it. The person has no way to see that it was
installed from a library.

## Goal

From a library skill or a skill in My skills, "Add to this machine…" installs it into the person's
own skill folders through the same reviewed plan as a project install: every file listed, nothing
written until confirmed, never over anything. Habi remembers what it installed, so it can update
and remove it, and it says plainly what a global install changes.

## In Scope

- A second target next to "Add to a project…", for library skills and for My skills.
- Choosing the clients the skill is for, as a project install does. The folders written are
  `~/.claude/skills` (Claude Code, and Cursor when it is chosen with Claude Code) and
  `~/.agents/skills` (Codex, and Cursor on its own), using the same "smallest set of folders" rule
  as projects. `~/.cursor/skills` is read but never written.
- The reviewed plan, journal, atomic writes, restore and conflict handling that installs already have.
- A record of what Habi installed, in `~/.habi/lock.json`, so that update and remove work and a skill
  Habi did not install is never touched.
- Update and remove for skills Habi installed there, from the "On this machine" section.
- A conflict, not an overwrite, when a folder with that name already exists and Habi did not put it there.
- Warnings: a global copy wins over a project copy in Claude Code, the order is not documented for
  Cursor and Codex, and the library is "not audited" (see Risks).
- "On this machine" rows that Habi installed say so and name the library, like a project's installed skills do.

## Out of Scope

- Editing or deleting any skill Habi did not install, including everything already in those folders.
- MCP entries and instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`). Skills only.
- Enterprise or admin folders such as `/etc/codex/skills`, and plugin-provided skills.
- Gemini CLI and other clients, until their folders and precedence are verified.
- Syncing a global copy with a project copy, merging, or any git operation.
- Installing without the reviewed plan (no one-click install).

## Constraints

- Habi reads and writes files only; no git.
- Same safety rules as project installs: precondition checks, journal, atomic writes, restore.
  Nothing is run from the skill.
- The home folder is injectable, so tests never touch the real one.
- Every path written must resolve inside one of the three user skill folders. A symlink along the
  way is not followed for writing (see Decisions).
- The only files Habi writes in the home folder are the skill's own files and its record,
  `~/.habi/lock.json`. No other metadata.
- Client folders and precedence come from `crates/habi-core/src/clients/layout.rs`; undocumented
  behavior is labelled "not documented", not guessed.

## Risks

- **Shadowing.** In Claude Code the global copy beats a project copy, so a global install can
  silently override what a team ships in a repository. The review must show every project known to
  Habi that holds a skill of that name, and say which copy wins.
- **Blast radius.** One click affects every project on the machine, so the confirmation has to be
  stronger than for a project.
- **Unaudited content.** Many library skills are "not audited". A global install runs with the
  person's agent everywhere. The review should say so and require an explicit confirmation.
- **Dotfiles.** `~/.claude/skills` is often a link into a dotfiles repository. Writing through it
  puts an unreviewed skill into a repository the person may later commit and push.
- **Drift.** The library moves on and the global copy does not. Update and remove must be easy, and
  "On this machine" should show when the library has something newer.
- **Duplicates.** Cursor reads both `~/.claude/skills` and `~/.agents/skills`; installing for all
  three clients can show one skill twice, as it can in a project.
- **Lost record.** If `~/.habi/lock.json` is deleted, Habi forgets what it installed. Skills stay
  where they are and appear in "On this machine" as ordinary global skills.
- **A new folder in the home directory.** `~/.habi/` is created on the first machine install. It holds
  one small file, and is the price of reusing the project install machinery unchanged.

## Acceptance Criteria

1. A library skill and a skill in My skills each offer "Add to this machine…" beside "Add to a project…".
2. The review lists every file and folder that would be written under the home folder, with the
   client each serves, and nothing is written before confirmation.
3. After applying, the files are byte-identical to the source, and the skill appears in "On this
   machine" as installed by Habi from its library.
4. A folder of the same name that Habi did not install is reported as a conflict and left untouched.
5. The review names every project Habi knows that holds a skill of the same name, says whether it is
   identical, and says which copy Claude Code uses and that Cursor's and Codex's order is not documented.
6. For a library that is not the team's own (a community library, or one marked "not audited") the
   confirm button stays disabled until the person ticks a box saying they understand that.
7. Update shows what changed upstream and what the person changed locally in the global copy, as a
   project update does, and never overwrites a local change without a decision.
8. Remove deletes only the files Habi installed and recorded, and leaves a file the person added
   to that folder.
9. If the skills folder, or the skill folder, is a symlink, Habi refuses to write, explains why, and
   offers no override.
10. Restore (undo) works on a global install as it does on a project one.
11. No test reads or writes the real home folder.

## Implementation Notes

- `install::plan` plans against any root folder. A machine install passes the home folder as the root
  and gets the same plan, journal, conflict handling, status and restore as a project install.
  Project installs are unchanged.
- The folders written are the same relative paths as in a project (`.claude/skills`, `.agents/skills`),
  which at the home folder are the person's own skill folders.
- Instruction files are refused up front; MCP configuration is never written.
- `machine_skills` marks a skill as installed by Habi, and from which library, when the record owns it.
- The review for a machine install lists the projects that hold a skill of the same name, and uses
  the same wording for which copy wins as everywhere else (`lib/machine.ts`).

### Decisions

1. **Symlinked skill folders:** refuse, with no override. This falls out of the planner, which does
   not write through links; a link that leaves the home folder is refused too.
2. **Default clients:** the same default as projects, shown and changeable in the review.
3. **My skills as a source:** yes, from the Use dialog ("On this machine…").
4. **Libraries that are not the team's own:** an explicit checkbox that gates the confirm button.

## What was built

- Core: `plan_install_machine`, `plan_update_machine`, `plan_remove_machine`, `plan_restore_machine`,
  `machine_install_preview`, `machine_history` on `Habi`, and the matching Tauri commands.
- UI: "Add to this machine…" under a "More" menu beside "Add to a project…" on a library skill;
  "On this machine…" in the Use dialog for My skills; Update and Remove in a menu on skills Habi
  installed, in the "On this machine" section.
- **Differs from the first proposal:** the record is `~/.habi/lock.json`, not a file in Habi's data
  folder. The planner, journal, restore and status code all read and write the record inside the root
  folder, so keeping it elsewhere would have meant threading a second root through all of them. The
  cost is one hidden folder in the home directory.
- **Not surfaced:** restore and the machine history exist in core and as commands, but no screen
  offers them yet.

## Final AI Implementation Prompt

```
You are working in the Habi repo (Rust workspace under crates/, desktop app in apps/desktop).
Habi installs Agent Skills into projects through a reviewed plan. It reads and writes files
only; never git. "On this machine" (crates/habi-core/src/skills/machine.rs and
apps/desktop/src/views/skills/OnThisMachine.tsx) already reads the person's own skill folders.

TASK: add a second install target, "this machine": install a library skill or a skill from My
skills into the person's own skill folders, through the same reviewed plan, journal and restore.

TARGET FOLDERS (from crates/habi-core/src/clients/layout.rs USER_SKILL_DIRS, relative to an
injected home folder): ~/.claude/skills (Claude Code), ~/.agents/skills (Codex and Cursor),
~/.cursor/skills (Cursor). Choose the smallest set that serves the chosen clients, as
skill_dirs does for projects. Never write anywhere else.

CORE
- Parameterize install::plan::plan_install over its base folders so a machine install uses the
  injected home and USER_SKILL_DIRS, and project installs are unchanged (existing tests pass).
- Keep Habi's record of machine installs in `~/.habi/lock.json`, as a project keeps its own.
  Status, update, remove and restore read it. A skill not in the record is
  never modified or removed, and a same-named folder not in the record is a conflict, not an
  overwrite.
- Refuse to write if the skills folder or the skill folder is a symlink; say where it points.
- Add Habi::plan_install_machine(items, clients, decisions) and expose it as a Tauri command
  (register it; add it to ipc_tests). The plan must include, for review: every file written,
  the clients each serves, every known project holding a skill of the same name (identical or
  differs), and the precedence note from layout::precedence (Claude Code: personal wins; Cursor
  and Codex: not documented). Add the library's audit state to the plan so the UI can require
  confirmation.
- machine_skills marks skills in the record as installed by Habi from their library.

UI
- Library item page and the "Use" dialog offer "Add to this machine…" beside "Add to a project…".
- The review dialog takes a target (project or machine). For machine: show the shadowing note
  and the project copies; for an unaudited library, disable the confirm button until a checkbox
  is ticked. Wording for precedence comes from apps/desktop/src/lib/machine.ts only.
- "On this machine" rows installed by Habi say so and name the library; they offer update and
  remove. Other rows stay read-only.

TESTS
- Core tests with a fake home (see crates/habi-core/tests/machine_skills.rs): install writes
  byte-identical files; conflict with an unrecorded folder; remove leaves a file the person
  added; update with a local change needs a decision; symlinked folders are refused; restore
  works; no test touches the real home.
- Frontend tests beside apps/desktop/src/test/machine.test.tsx for the review dialog's target,
  the unaudited checkbox and the shadowing note.

OUT OF SCOPE: editing skills Habi did not install, MCP entries, instruction files, enterprise
or admin folders, plugin skills, Gemini CLI, syncing copies, one-click install.

Done when the acceptance criteria in docs/dev/add-to-this-machine.md pass, existing tests
pass, and the real home folder is never read or written by the test suite.
```
