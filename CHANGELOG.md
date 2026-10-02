# Changelog

All notable changes to Habi. Versions follow [semantic versioning](docs/dev/release.md#versioning).

## 0.1.0 — unreleased

First working version.

### Create, add and share skills
- **My skills:** write a skill in Habi — purpose, Markdown instructions, supporting files — or
  bring in the ones you already have. No project, library, account or model is needed, and a
  draft is an ordinary Agent Skills folder.
- **Applicability without YAML:** build "applies when / never applies when" conditions from
  technologies, dependencies and file patterns, with suggestions taken one by one from facts
  observed in a project. A YAML view keeps unknown keys and complex rules as written.
- **Where it applies:** a live preview evaluates the rules against every opened project and
  shows the evidence, keeping "does not apply" apart from "could not be established".
- **Already in this project:** opening a repository lists the skills and instruction files it
  already contains. Copy a skill to edit it, or turn a selected part of `AGENTS.md`/`CLAUDE.md`
  into a draft; the originals are never changed.
- **Add skills:** from a project, a folder or a Git repository, inspected before anything is
  copied, with duplicates and identifier collisions resolved without losing either version.
- **Use in a project:** pick the project and agents at the point of use; installation goes
  through the same reviewed plan as team items.
- **Share with team** from the skill itself; connect a library on the spot or export a plain
  folder. Sharing activity distinguishes a prepared branch, a pushed branch, an opened review
  request and content that reached the library.
- Drafts autosave with an honest save state, detect edits made outside Habi, and can be
  restored from the trash.
- Simpler first run: one primary action (*Open a project*), a shorter library connection form
  (URL first, name derived, branch and subfolder under advanced options).

### Discover
- Open a project folder; Habi reads Maven, Gradle (including version catalogs) and npm
  manifests and lockfiles, recognizes OpenAPI specs, Liquibase changelogs, CI and agent
  instruction files, and understands monorepos module by module.
- Recommendations grouped as team requirements, fits this project, needs information,
  available, and does not apply — each with the reasons and the exact files behind them.
- Skills without applicability rules are collapsed into a count per library, so connecting a
  large community library (hundreds of skills) does not bury what fits. Items that cannot be
  installed (incomplete, or an invalid SKILL.md name) no longer offer to install.
- Licences: each item shows its declared licence and the nearest licence file, including a
  repository's root `LICENSE`. Skills declared proprietary get a note in the install review
  and a warning before sharing.
- Tell Habi what it could not establish (for example, a dependency inherited from a company
  parent POM). Your answers are labeled as yours and can be undone.

### Community libraries
- A library is your team's own or a community one (`habi source add … --community`,
  `habi source role`, or *Whose library is this?* when connecting). Community libraries are
  listed separately and labeled as not reviewed by your team.
- Connecting offers a short list of well-known community libraries (Anthropic, Superpowers,
  Addy Osmani, wshobson, Vercel). Aggregators that re-host other people's skills are left out.
- A library page shows how many skills have rules, ship scripts, or are declared proprietary.

### The knowledge lifecycle
- Habi is framed around find → apply → refine → share → reuse: README, product contract, CLI
  help and the home screen tell the same story.
- *Sharing activity* is now **Contributions**, with one state per contribution (draft, ready,
  open request, merged, in the library, needs attention), per-file selection, and a reference
  check so leaving a file out cannot break the skill.
- Share actions name their destination ("Share back to Team library…", "Share my edits with
  Anthropic…").
- Copies of library skills (including installed copies with local edits) keep their origin;
  when the library changes, the copy shows the update and takes library-only changes while
  keeping yours, asking about files both sides changed.
- The package editor treats a skill as a complete package: instructions first, files beside
  them, scripts with templates, previews, validation next to each file.

### Libraries
- **Libraries** is a destination: what is connected, community libraries to discover (previewed
  before connecting), and your own (a Git repository or a folder, each on its own page).
- A library reads as an index of knowledge: skills as picks across the library's thread, with
  initials, a one-line purpose and quiet marks for rules and scripts. Type to filter, ↑/↓ or
  j/k to move, Enter to read; ⌘K lists the open library's skills first.
- A skill opens with what it is, one primary action and a one-line signature (scripts,
  files, languages, rules, lineage). Trigger instructions written for agents stay in
  *Details*, exactly as written; the document starts right below.
- The package is an inspector beside the document (*Contents* or ⌘I, remembered for the
  session): root files, language folders as an index line, other folders with counts, and
  the files an agent could run. The library's index folds into its spine while it is open.
  Files open in place of SKILL.md; ← or Esc returns to the same scroll position.
- Only code counts as a script (schemas and templates under `scripts/` do not), and titles
  derived from names keep initialisms (*Claude API*, *MCP builder*).
- Shared copies record their lineage (`metadata.based-on`) so knowledge keeps its origin.

### Design
- New visual language, *Loom*: Daylight and Graphite themes, IBM Plex Sans with a monospace
  voice for labels and counts, and one dye color per library that follows its items
  everywhere (solid for team, stitched for community). Each project gets a woven swatch from
  the libraries that fit it, with a composition strip under its header.
- Recommendation groups are sticky section bars with a tone mark and count.

### Adopt
- Install skills and workflows for Claude Code, Cursor and Codex into the current project,
  with a preview of every file and a diff.
- Team instructions go into a managed section of `AGENTS.md`; Claude Code is pointed at them
  with an `@AGENTS.md` import.
- Optional MCP server configuration for each client, without secrets.
- Updates are compared three ways, so your local edits are kept and conflicts are explained.
- Every operation can be restored. Interrupted operations are rolled back automatically.

### Team knowledge
- Connect a Git repository (or a subfolder, branch or tag) using your existing Git
  credentials, or a local folder. Refreshing never changes projects.
- Works offline from the last fetched copy and says how old it is. Warns when a tag moved or
  history was rewritten.

### Share
- Turn an improved skill into a contribution: describe where it applies, preview exactly what
  would be shared, then export a patch or push a branch for review (and open a pull request
  with `gh` or `glab` if installed).
- After sending: check the request's status and read reviewers' comments (plain text, next to
  the file they are about), then revise on the same branch — the open pull/merge request
  updates instead of a new one being opened. Habi will not overwrite commits someone else
  pushed to the branch unless you choose to build on them. GitHub and GitLab (including
  self-hosted instances and nested GitLab groups).
- Optionally add "where it applies" to the message for reviewers: the rules evaluated against
  your own projects, by name.
- Faster and more accurate matching on monorepos: repository-level facts (CI, agent files,
  Dockerfiles) count for every module; Gradle one-line blocks, `-jre`-style versions and
  unreadable folders are handled; results refresh when manifests change.
- Safer installs: line-ending differences (Windows `autocrlf`) are no longer reported as
  edits; shared MCP servers and same-named instructions from two libraries are handled; a
  restore keeps the lock file consistent; in-project symbolic links (`CLAUDE.md -> AGENTS.md`)
  are understood instead of refused.
- Command line: works from any subfolder of a project, `--json` always prints one JSON
  document, `install` defaults to the agent tools the project already uses, every command has
  help and examples, Ctrl-C cancels safely.
- Plainer questions when Habi cannot establish something ("Does api use jOOQ?"), and blocked
  install/share dialogs that say what to fix and take you there.

### Also
- Releases are built for macOS and Windows; Linux is not a release target.
- `habi` command-line tool with the same capabilities.
- Verification checks you can preview and run explicitly.
- Light and dark themes, keyboard navigation and a command palette (⌘K).
- Redacted diagnostic report you can review before saving.
