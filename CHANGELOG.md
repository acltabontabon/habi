# Changelog

All notable changes to Habi are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html); how Habi applies it is in
[docs/dev/release.md](docs/dev/release.md#versioning).

## Unreleased

### Added

- **Find what applies to your project.** Open a repository and Habi reads its stack (Java,
  Kotlin, JavaScript and TypeScript, Go, Rust, Python, PHP, monorepos module by module), then
  shows which skills and instructions fit, which your team requires and which do not apply,
  each with the reasons and the files behind them.
- **One place for your team's and the community's knowledge.** Connect a Git repository or a
  folder, or pick from a catalog of well-known skill libraries. Habi works offline, tells you
  when a library has something newer, and only updates when you say so.
- **Install for the agents you use, with a preview.** Claude Code, Cursor, Codex, Gemini CLI,
  GitHub Copilot, OpenCode and Junie. Every file is shown first, your local edits survive
  updates, and any change can be restored.
- **Write and improve skills.** A skill is a page to write on, with no account, model or project
  needed. Bring in the ones you already have, and test a skill against a real project.
- **Share what you learn.** Send an improved skill back to the library it came from as a patch,
  a branch or a pull request, after previewing exactly what leaves your machine.
- **Know what you are trusting.** Every item shows its author, license and origin; community
  libraries are marked as not reviewed by your team, and anything that downloads code or touches
  credentials is flagged. Habi never runs a skill's scripts.
- **A `habi` command-line tool** with the same abilities, for terminals and scripts.
