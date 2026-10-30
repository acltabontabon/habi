# Changelog

All notable changes to Habi are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html); how Habi applies it is in
[docs/dev/release.md](docs/dev/release.md#versioning).

## Unreleased

Every project gets Habi's answer to "what should my agents have here?", before a library is connected.

### Added

- **Suggested, for every project.** A project opens on a short, opinionated list of skills for
  it: the team's requirements, skills for its stack, and a few practices for any codebase, each
  with the reason it fits (*Uses React · package.json:5*) and whose word that is. The strongest
  few start ticked, since every skill costs context in every agent session: each row and the total
  say about how much. **Review and add…** connects the libraries they come from (read only, nothing
  runs) and opens the usual review. **All skills** keeps the full workbench one tab away.
- **What a skill brings, said up front.** A row says when a skill comes with code an agent could
  run, and what Habi's scan of its files flags as caution. Those from community libraries start
  unticked, so running someone else's code is a choice.
- **Skills that call each other.** The install review lists skills the chosen ones call by name
  (`superpowers:writing-plans`), which would otherwise break, and adds them in one click.
- **Habi's picks.** The catalog names the skills Habi stands behind in each library, with when
  each fits, so suggestions work before anything is connected. A catalog library's page lists
  its picks; Explore puts the libraries with something for your projects first and says which.
- **Projects learn from each other.** A skill one of your projects already uses comes first in
  the next project's suggestions, marked *Also in nextshop*, so every project you open makes the
  others' suggestions better. A skill already on this machine starts unticked (*On this
  machine*): your agents read it in every project already.
- **Matching by what a skill says it is for.** A skill with no rules of its own fits a project
  when its description names a technology the project uses (*From its description*). It is
  listed under All skills, said as Habi's reading; the team's own libraries also feed Suggested.

### Fixed

- **Opening Habi twice at once no longer fails.** The desktop app and the command line opening the
  data folder at the same moment could stop one of them with "restricting …-journal".
- **A project's page opens faster** with many libraries connected: what a skill says it is for is
  read once, and a project's skill folders are listed once instead of probed per skill.
- **Installed skills no longer change what a project is.** Scripts and instruction files inside
  a skill folder no longer count as the project's languages or agent instructions.
- **Next.js on Cloudflare** fits Next.js apps deployed with Wrangler, not every Next.js app, and
  **BigQuery basics** also fits Python code using the BigQuery client.

## 0.4.0 - 2026-10-30

Explore the catalog on a page of its own, keep many libraries in view at a glance, and reach your skills from their own place in the sidebar.

### Added

- **Three more community libraries in the catalog.** Trail of Bits' security and audit skills,
  UI/UX Pro Max's design skills, and Impeccable's design vocabulary can be previewed and
  connected from Explore.

### Changed

- **Libraries scale to many.** Your libraries are one line each, with those that need you (an
  update waiting, offline, a failed fetch) first and filters for where they come from. The
  catalog has its own Explore page, as cards filtered by builders and community. **Add a
  library** brings in a Git repository, a folder or a catalog library from one menu, and the
  sidebar shows eight libraries before "Show all".
- **Skills have their own place in the sidebar.** **My skills** and **On this machine** sit
  under a Skills heading instead of tabs, each with a count of skills that have a newer version
  in their library. On this machine lists those first and can show only them.
- **A quieter My skills page before your first skill.** Starter ideas are simple rows, and the
  decorative threads beneath them are gone.

### Removed

- **The sample workspace.** Habi no longer offers example libraries and projects; open one of
  your own projects and connect a library instead. A sample workspace made by an earlier
  version is removed on startup, with nothing of your own touched.

### Fixed

- **Back says where it goes.** From Explore, a catalog library, the pages for connecting your own,
  or a skill opened from On this machine, the Back link names the page it returns to.
- **Builder libraries are called builders.** Hovering a library from Anthropic, Google, Sentry
  and the other tool builders in the sidebar no longer labels it community.
- **Clearer Libraries pages when nothing matches.** A filter with no results offers a way to clear
  it, and Explore with every catalog library connected says so without an empty filter bar.

## 0.3.0 - 2026-10-26

Find the skills already on your machine, check your libraries when you need to, and reach personal installs and recovery history more easily.

### Added

- **Check a library for updates whenever you need to.** A visible **Check for updates**
  button reports progress, results, and failures without waiting for the automatic check.
  Folder libraries offer **Refresh library** to read their latest contents.
- **See skills already installed on this machine.** Library lists and skill pages mark
  machine installations, show the agent tools that read them, and link to their management
  controls. The status refreshes after installing, removing, or updating a library.

### Changed

- **Reach global skills without scrolling past the creation guide.** My skills has
  Drafts & copies and On this machine collections, with counts and global skill search.
- **Find the history you need.** Restore and attention filters narrow the list, file paths
  expand when you need them, and recovery results stay inside the dialog.

### Fixed

- **Global skill badges reflect your choices.** Skills Habi installed highlight only the
  selected agents. Other agents that can read the same folders are explained separately.

## 0.2.0 - 2026-10-08

Find the right skill faster, see what has actually been checked, and keep a way back—from personal installs to your original drafts and contributions.

### Added

- **Back up original work.** A verified offline backup and restore tool preserves your local
  drafts, contributions and history together. Follow the recovery guide before upgrading;
  the tool requires Node.js 24 or later and a copy of the source checkout.
- **Focus recommendations on your work.** Filter by module, library, compatible agent, or
  items needing attention. Habi remembers the filters separately for each project, and a
  scan-gap notice links directly to what could not be inspected.
- **Restore changes on this machine.** My skills → On this machine → History and restore
  lists personal skill installs, updates and removals, previews restores, and checks for
  interrupted operations. History stays available after the last skill is removed.
- **A route for contributors without write access.** Prepared contributions explain how to
  fork the library, export the reviewed patch, and submit it through the Git host.

### Changed

- **Readiness is specific to the agent.** Choose an agent in Prerequisites to see its own
  MCP configuration. Install review points out missing prerequisites for the agents selected;
  configuration for another agent no longer makes an item ready.
- **Check evidence shows its coverage.** The latest completed result for each declared check
  and applicable module contributes to the summary: passed, failed, out of date, or unchecked.
  One pass cannot hide another failure. Passing results with unchecked pairs or an incomplete
  scan are labeled *Partially checked*.

### Fixed

- **Storage failures are reported.** A failed storage flush on macOS no longer looks like
  a successful change. Installation recovery handles a failed flush after a file is replaced.
- **Checks notice more edits.** Source and script edits that keep the same file size now
  invalidate earlier inspection and passing check evidence when their modification time
  changes, so those results are shown as out of date.

## 0.1.0 - 2026-10-04

### Added

- **See what fits your project, and why.** Open a repository and Habi reads its stack (Java,
  Kotlin, JavaScript and TypeScript, Go, Rust, Python, PHP and common data tools, monorepos
  module by module), then shows which skills fit, which your team requires and which do not
  apply, each with the files and lines behind it. When something cannot be known from the
  files, Habi asks instead of guessing. Nothing in your project is built or run.
- **Your team's and the community's skills in one place.** Connect a Git repository or a
  folder, or pick from a catalog of well-known public libraries. Habi works offline, tells you
  when a library has something newer, and updates it only when you say so.
- **Install for the agents you use, with a preview.** Claude Code, Cursor, Codex, Gemini CLI,
  GitHub Copilot, OpenCode and Junie, preselected from what the project already uses. You see
  every file first, your own edits survive updates, and any change can be restored. Team
  instructions go into a managed section of `AGENTS.md`, and MCP servers a skill suggests are
  added only if you opt in, with secrets by reference and never written out.
- **Skills for every project on this machine.** Add a skill to your own skill folders instead
  of one project, and update or remove it later. Skills already in those folders are listed,
  with a way to copy them into My skills or a project.
- **Write and improve skills in the Skill Studio.** A skill is one document: its purpose, when
  Habi should suggest it, the instructions, and the scripts and references it brings. Start
  from nothing, from part of an instruction file, or from skills you already have, and test
  when a skill would be suggested in a real project. No account, model or library needed.
- **Share what you learn.** Send an improved skill back to the library it came from as a pull
  or merge request, a branch or a patch, after previewing exactly what leaves your machine.
  Read the review in Habi and revise on the same request.
- **Know what you are trusting.** Every skill shows its author, license and origin; community
  libraries are marked as not reviewed by your team, and anything that downloads code or
  touches credentials is pointed out. Habi never runs a skill's scripts. A Privacy and security
  page lists everything that stays on your machine and the few requests that do not.
- **Run a check, after reading it.** A skill's checks show the exact command and what it
  reaches for, and run only when you press *Run this command*. Habi does not sandbox them, and
  says so.
- **Answer what Habi cannot tell.** When the files do not settle a question, such as whether a
  project uses something, you answer it for that project. Your answer is labeled as yours, listed
  in the project's settings, and can be undone.
- **Put things right.** History lists what Habi changed and restores any of it, and a check for
  interrupted operations finishes or undoes them. Settings can free up space and preview a
  redacted troubleshooting report, which is saved only if you save it.
- **Everything from the keyboard.** The command palette (⌘K on a Mac, Ctrl+K on Windows) reaches
  every screen and action.
- **Updates you choose.** Habi checks for a newer version, shows what changed in *What's new*,
  and installs it only when you press Update. Updates are signed, and the check can be turned
  off in Settings.
- **For macOS 11 or later and Windows.** One universal build covers Apple Silicon and Intel
  Macs, and the app follows your system's light or dark setting.
- **A welcome that says what Habi is for**, under a headline that changes each time, and
  checks the one thing Habi needs: Git. The GitHub and GitLab command-line tools, for pull and
  merge requests, are optional; Settings shows whether each is installed and how to add it.
- **A sample workspace** of example libraries and projects to try everything on, clearly
  labeled and removable in one step.
- **Documentation on the site**, at [acltabontabon.com/habi/docs](https://acltabontabon.com/habi/docs/):
  the guides, writing libraries, and what Habi promises and trusts. Open it from About or the
  command palette.
