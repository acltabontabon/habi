# Changelog

All notable changes to Habi. Versions follow [semantic versioning](docs/dev/release.md#versioning).

## Unreleased

The first version, 0.1.0, is not released yet. It will contain the following.

### Discover
- Open a project folder; Habi reads Maven, Gradle (including version catalogs) and npm
  manifests and lockfiles, recognizes OpenAPI specs, Liquibase changelogs, CI and agent
  instruction files, and understands monorepos module by module. Repository-level facts (CI,
  agent files, Dockerfiles) count for every module, and results refresh when manifests change.
- Recommendations grouped as team requirements, fits this project, needs information,
  available, and does not apply — each with the reasons and the exact files behind them.
- Skills without applicability rules are collapsed into a count per library, so connecting a
  large community library (hundreds of skills) does not bury what fits. Items that cannot be
  installed (incomplete, or an invalid SKILL.md name) do not offer to install.
- Licenses: each item shows its declared license and the nearest license file, including a
  repository's root `LICENSE`. Skills declared proprietary get a note in the install review
  and a warning before sharing.
- Tell Habi what it could not establish (for example, a dependency inherited from a company
  parent POM). Questions are asked in plain words ("Does api use jOOQ?"), and your answers
  are labeled as yours and can be undone.

### Libraries
- Connect a Git repository (or a subfolder, branch or tag) using your existing Git
  credentials, or a local folder. The connection form asks for the URL first; the name is
  derived, and branch and subfolder are advanced options. Refreshing never changes projects.
- Works offline from the last fetched copy and says how old it is. Warns when a tag moved or
  history was rewritten.
- A library is your team's own or a community one (`habi source add … --community`,
  `habi source role`, or *Whose library is this?* when connecting). Community libraries are
  listed separately and labeled as not reviewed by your team.
- Connecting offers a short list of well-known community libraries (Anthropic, Superpowers,
  Addy Osmani, wshobson, Vercel), previewed before connecting. Aggregators that re-host other
  people's skills are left out.
- A library page lists its skills with a one-line purpose and marks for rules and scripts,
  and says how many skills have rules, ship scripts, or are declared proprietary. Type to
  filter, ↑/↓ or j/k to move, Enter to read; ⌘K lists the open library's skills first. Each
  library has its own color, used wherever its items appear.
- A skill opens with what it is, one primary action and a one-line summary of its scripts,
  files, languages, rules and lineage. Trigger instructions written for agents stay under
  *Details*, exactly as written.
- *Contents* (⌘I) shows a skill's files beside its document; files open in place of
  SKILL.md, and ← or Esc returns to the same scroll position. Only code counts as a script;
  schemas and templates under `scripts/` do not.

### Adopt
- Install skills and workflows for Claude Code, Cursor and Codex into the current project,
  with a preview of every file and a diff.
- Team instructions go into a managed section of `AGENTS.md`; Claude Code is pointed at them
  with an `@AGENTS.md` import.
- Optional MCP server configuration for each client, without secrets. A server several items
  need is added once.
- Updates are compared three ways, so your local edits are kept and conflicts are explained.
- Every operation can be restored, and a restore keeps the lock file consistent. Interrupted
  operations are rolled back automatically.
- Line-ending differences (Windows `autocrlf`) are not reported as edits; same-named
  instructions from two libraries are reported as a collision; in-project symbolic links
  such as `CLAUDE.md -> AGENTS.md` are understood instead of refused.

### My skills
- Write a skill in Habi — purpose, Markdown instructions, supporting files — or bring in the
  ones you already have. No project, library, account or model is needed, and a draft is an
  ordinary Agent Skills folder.
- **Applicability without YAML:** build "applies when / never applies when" conditions from
  technologies, dependencies and file patterns, with suggestions taken one by one from facts
  observed in a project. A YAML view keeps unknown keys and complex rules as written.
- **Where it applies:** a live preview evaluates the rules against every opened project and
  shows the evidence, keeping "does not apply" apart from "could not be established".
- **Already in this project:** opening a repository lists the skills and instruction files it
  already contains. Copy a skill to edit it, or turn a selected part of `AGENTS.md`/`CLAUDE.md`
  into a draft; the originals are never changed.
- **Add skills** from a project, a folder or a Git repository, inspected before anything is
  copied, with duplicates and identifier collisions resolved without losing either version.
- **Use in a project:** pick the project and agents at the point of use; installation goes
  through the same reviewed plan as team items.
- The editor treats a skill as a complete package: instructions first, files beside them,
  scripts with templates, previews, and validation next to each file.
- Drafts autosave with an honest save state, detect edits made outside Habi, and can be
  restored from the trash.
- Copies of library skills (including installed copies with local edits) keep their origin;
  when the library changes, the copy shows the update and takes library-only changes while
  keeping yours, asking about files both sides changed.

### Share
- *Share with team* from a skill, or turn an improved installed skill into a contribution.
  Share actions name their destination ("Share back to Team library…"). With no library,
  connect one on the spot or export a plain folder.
- Describe where it applies, preview exactly what would be shared (with per-file selection
  and a reference check, so leaving a file out cannot break the skill), then export a patch
  or push a branch for review, and open a pull or merge request with `gh` or `glab` if
  installed.
- **Contributions** lists every contribution with one state: draft, ready, open request,
  merged, in the library, or needs attention. A prepared branch, a pushed branch, an opened
  request and content that reached the library are never confused.
- After sending: check the request's status and read reviewers' comments (plain text, next to
  the file they are about), then revise on the same branch — the open pull/merge request
  updates instead of a new one being opened. Habi will not overwrite commits someone else
  pushed to the branch unless you choose to build on them. GitHub and GitLab (including
  self-hosted instances and nested GitLab groups).
- Optionally add "where it applies" to the message for reviewers: the rules evaluated against
  your own projects, by name.
- Shared copies record their lineage (`metadata.based-on`), so knowledge keeps its origin.
- Install and share dialogs that are blocked say what to fix and take you there.

### Also
- Builds for macOS 11 or later (one universal build for Apple Silicon and Intel) and
  Windows. Linux is not supported.
- `habi` command-line tool with the same capabilities. It works from any subfolder of a
  project, `--json` always prints one JSON document, `install` defaults to the agent tools
  the project already uses, every command has help and examples, and Ctrl-C cancels safely.
- Verification checks you can preview and run explicitly.
- Light and dark themes, keyboard navigation and a command palette (⌘K).
- Redacted diagnostic report you can review before saving.
