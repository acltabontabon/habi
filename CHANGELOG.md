# Changelog

All notable changes to Habi are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html); how Habi applies it is in
[docs/dev/release.md](docs/dev/release.md#versioning).

<!-- The first release. Before tagging, rename "Unreleased" to "0.1.0 - YYYY-MM-DD" and start a
new empty "Unreleased" above it (docs/dev/release.md, step 1). -->

## Unreleased

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
  every file first, your own edits survive updates, and any change can be restored.
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
- **Updates you choose.** Habi checks for a newer version, shows what changed in *What's new*,
  and installs it only when you press Update. Updates are signed, and the check can be turned
  off in Settings.
- **A welcome that says what Habi is for**, under a headline that changes each time, and
  checks the one thing Habi needs: Git. The GitHub and GitLab command-line tools, for pull and
  merge requests, are optional; Settings shows whether each is installed and how to add it.
- **A sample workspace** of example libraries and projects to try everything on, clearly
  labeled and removable in one step.
- **Documentation on the site**, at [acltabontabon.com/habi/docs](https://acltabontabon.com/habi/docs/):
  the guides, writing libraries, and what Habi promises and trusts. Open it from About or the
  command palette.
