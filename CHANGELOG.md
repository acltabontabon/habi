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
- Libraries are grouped by who stands behind them: *From the builders* (Anthropic, OpenAI,
  Microsoft, Google, GitHub, Cloudflare, Vercel, Sentry), *From the community* (Superpowers,
  Addy Osmani, wshobson), *Connected* and *Bring your own*. The catalog is a registry file, not UI code, and every
  count, licence and date shown comes from the repository itself. Aggregators that re-host
  other people's skills are left out.
- One verb: **Connect**. Choosing a library opens its page (publisher, how ownership was
  checked, notes; nothing is fetched to show it) with a single Connect button. Pressing it
  reads the newest commit while a small loom weaves (with a cancel, and a clear stopped or
  failed state), then opens the connected library: its skills grouped by plugin or category,
  with their files, scripts and licence. Connecting installs, copies and runs nothing; a
  cancelled or failed connection leaves nothing behind. (`habi catalog preview` still reads a
  library without connecting it.)
- A library's page shows GitHub's stars, forks, last push and start year as context, and warns
  when a repository is archived. It is one anonymous request to GitHub's public API when the
  page is opened, kept for a day and absent when unavailable; it never ranks or recommends.
- Source trust is three separate facts: *official* (the owner is who the entry says, with the
  evidence), *community*, and *reviewed* (only when an inspection is recorded; none is).
  Skills get *signals* from a bounded static reading of their files (download-and-run
  commands, credential access, compiled files, invisible characters). Nothing is executed.
- Skills from catalog libraries can fit a project through catalog hints (a file, a dependency
  or a detected tag), labelled as Habi's suggestion; the author's own rules always win.
- A copy of a library skill remembers its original: repository, path, commit, licence and
  publisher.
- Refreshing a library asks the remote what it has first and fetches nothing when unchanged.
- Connecting your own repository or folder is one page of three stations on a thread (*Where is
  it kept? · How to read it · What it becomes*) that lights as each is reached, with the whole
  form said back as a sentence built from what you typed ("Habi will read acme/skills on
  github.com at its newest release, and list it as skills, a team library"). The name is the
  word in that sentence you write over; *Your team's / Community* is two tiles of cloth, solid
  threads for your team's and stitched for a community's, as they look everywhere in Habi; a subfolder is an optional link, not a field. The address is read back as host and
  `owner/repo`, and *Follow* is one control (default branch, latest release, a branch, a tag).
  Choosing a folder opens it in place: how many skills Habi finds, each by name, and the
  folder's own tree, read-only and before anything is connected. The fetch weaves on a loom
  along the foot, with a cancel.
- **Updating is your choice.** Habi only asks whether a repository has something newer (one
  small request, nothing downloaded) and says so: *v6.4.2 is out. You are reading v6.4.1.* The
  library moves when you press **Update**, never on its own. Afterwards it says what changed,
  by name (*2 new · 3 changed · 1 removed*), and marks those skills in the index until you
  mark them as seen. The scheduled check in Settings now only asks; a local folder, which has
  no remote, is still simply read again.
- Libraries whose repository publishes version tags (Superpowers, Addy Osmani) are read at
  their newest release, and the page shows the version (`v6.4.2`), not just a commit. A tag
  that is not a version (a pre-release, a date, a commit hash) is never taken for a release,
  and a repository with no release is read at its default branch and says so. A release tag
  that later points somewhere else is flagged.
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
- **The Skill Studio:** a skill opens inside its knowledge — title, purpose, where it came
  from, and the instructions — with only *Ready*, *Use* and ••• above it. When to use and
  Materials are layers of the same skill (⌘1–3), named in a line each under the purpose;
  testing and provenance slide in as sheets and leave again. *New skill* opens an empty page:
  the first heading names it, the title names its identifier, and the opening line can become
  its purpose. Saving is silent unless it fails.
- **Writing:** Markdown steps aside away from the caret — headings, emphasis, highlighted code
  blocks, and references to the package's own files (⌘-click opens one) — while the line
  being edited shows its markup. Package paths complete after `](` and in backticks; problems
  are marked on their line; an outline spine in the margin (⌘⇧O); optional starters on an
  empty page.
- **When to use, as facts:** "Playwright is used", "Depends on …" — added from a few words,
  with Habi proposing what it could look for and what it saw in a project. *Avoid when*,
  *Check within*, *Needs*. When the instructions keep naming a technology, Habi offers it as a
  signal (one click, undoable). The YAML is one link away and rules the sentences cannot
  express are read out and kept as written.
- **Test against a project:** on request, a plain verdict and each signal with its evidence,
  what could not be established, and whether the tools it needs are on PATH (looked up, never
  run).
- **Materials:** scripts, examples, references and assets by kind, each with what it is for in
  the instructions' words; a gentle *Reference it* for one the instructions never mention.
  *Add* places files by what they are; pasted code becomes a script or an example; dropped
  files are placed the same way, with *Undo*. A file opens as a focused editor. The package
  source (the literal tree, `SKILL.md` and `habi.yaml` included) is one step away. Scripts are
  shown with the command to run them yourself — Habi never runs them.
- **An index of what you know:** My skills lists each skill's purpose, its thread (where it
  came from, in its library's dye, and whether it was changed here), and one word for where it
  stands — Ready, or Draft and what is missing. Facets, `/` to find, j/k to move.
- **Lineage:** an imported copy keeps its original files, so what you changed is shown file by
  file whatever it came from, even after the source is gone; library updates are reviewed
  against it, and a contribution can be prepared from the same place.
- **Add skills** from a project, a folder, a Git repository or a connected library,
  inspected before anything is copied, with duplicates and identifier collisions resolved
  without losing either version. From Git, *make my own copy* reads the repository once and
  connects nothing; *connect as a library* keeps it to browse and update from.
- **Already in this project:** opening a repository lists the skills and instruction files it
  already contains. Copy a skill to edit it, or turn a selected part of `AGENTS.md`/`CLAUDE.md`
  into a draft; the originals are never changed.
- **Use in a project:** pick the project and agents at the point of use; installation goes
  through the same reviewed plan as team items.
- Drafts autosave with an honest save state (leaving a screen writes pending edits first),
  detect edits made outside Habi, and can be restored from the trash. Changing the
  identifier is deliberate and warns where the skill is installed under the old one.
- Validation names the kind of each problem and leads to the field, line or file that fixes
  it; errors that block installing are kept apart from notes.

### Share
- *Share with team* from a skill, or turn an improved installed skill into a contribution.
  Share actions name their destination ("Share back to Team library…"). With no library,
  connect one on the spot or export a zip (the package under a folder named by its identifier).
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
