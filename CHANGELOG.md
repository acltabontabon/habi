# Changelog

All notable changes to Habi are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html); how Habi applies it is in
[docs/dev/release.md](docs/dev/release.md#versioning).

## Unreleased

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
