# Getting started

Habi shows which skills and instructions fit the repository you are working in, installs
them for the agent tools you use, and carries what you improve back to the library it came
from. It runs on macOS 11 or later and on Windows.

There are no prebuilt downloads yet. Build Habi from source as described in the
[README](../../README.md#build-from-source); the first build takes a few minutes.

## Try the sample workspace

On the start screen, choose **Try the sample workspace**. Habi creates two example libraries and
seven example projects in its own data folder, all labeled as samples, so you can see
recommendations, installs and updates without touching your own repositories.

## Your first project

1. **Open a project…** (⌘O on macOS, Ctrl+O on Windows) and pick a repository folder. Habi
   reads its build files and structure. Nothing is built or run.
2. Without a library, the project shows the skills and instruction files it already
   contains. To get recommendations, **Connect a library**: a Git repository your team
   curates (Habi uses your existing Git credentials), a community library, or a folder on
   this machine.
3. Read the recommendations. Each item says why it fits, down to the file and line, and is
   grouped as *Team requirements*, *Fits this project*, *Needs information*, *Available to
   use manually* or *Does not apply*. When Habi could not establish something (for example, a dependency
   inherited from a parent build file outside the repository), you can answer the question;
   your answer is labeled as yours and can be undone.
4. Install an item: choose the agent tools (Claude Code, Cursor, Codex), review every file
   that would be created or changed, and confirm.

From there, [My skills](my-skills.md) covers writing and editing your own skills, and
[Sharing](sharing.md) covers sending an improvement back for review.

## What Habi changes, and what it does not

In your project, only after you confirm a plan:

- skill folders under `.claude/skills/` or `.agents/skills/`;
- a managed section in `AGENTS.md`, and an `@AGENTS.md` line in `CLAUDE.md`;
- MCP server entries, only if you ask for them;
- `.habi/lock.json`, which records what Habi installed. Commit it or ignore it.

[Agent tools](agent-tools.md) lists exactly where each file goes. Every install, update or
removal is journaled and can be restored; see [Recovery](recovery.md).

Habi never:

- runs builds, package managers, scripts or Git inside your project to inspect it;
- changes your checkout or branches (contributions are prepared in Habi's own copy of the
  library);
- sends anything off your machine unless you share, push or open a request and confirm it;
- uses an account, telemetry or a cloud service.

Refreshing a library never changes a project. Habi's own data (library caches, journals,
logs, its database and My skills) lives in its data folder; Settings → About shows where.

## Removing Habi

Removing the app does not touch projects: installed skills, `AGENTS.md` sections, MCP
entries and `.habi/lock.json` are ordinary files that stay and keep working. The OS
uninstaller does not remove Habi's data folder on macOS; delete it by hand if you want to.
