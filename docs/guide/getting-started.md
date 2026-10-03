# Getting started

Habi shows which skills fit your repository, installs them for your agent tools, and carries
improvements back to the library. It runs on macOS 11+ and Windows.

## Installing

Download the installer for your system from the
[Releases page](https://github.com/acltabontabon/habi/releases): the `universal.dmg` for macOS
(Apple Silicon and Intel), or the `.msi` or `-setup.exe` for Windows.

The installers are not signed by Apple or Microsoft, so the first launch asks you to confirm:

- **macOS:** open Habi once. When macOS says it cannot check it, go to **System Settings →
  Privacy & Security** and choose **Open Anyway** next to Habi. (Or, in Terminal:
  `xattr -dr com.apple.quarantine /Applications/Habi.app`.)
- **Windows:** when SmartScreen says *Windows protected your PC*, choose **More info**, then
  **Run anyway**.

You confirm once. Updates after that are signed with Habi's own key, and checked before they
install. To build Habi yourself instead, see the [README](../../README.md#build-from-source).

## The welcome

The welcome screen checks your setup. It requires Git (for pulling libraries) and optionally
detects GitHub/GitLab CLI for opening pull and merge requests. Disable it anytime in
Settings → This machine → Welcome.

![The welcome: a headline beside the three threads, find, improve and share, and a card of what Habi works with: Git found, the project stacks it reads, and the seven agent tools.](../media/welcome.jpg)

## Try the sample workspace

Try the sample workspace to explore without touching your repos. Habi creates two example
libraries and seven example projects—all isolated and labeled as samples.

The home page shows your projects as rows, with library skills woven across them: solid lines
show installed skills, faded lines show skills that fit but aren't installed yet.

![The home page with the sample workspace: seven projects as rows crossing two libraries. billing-service has a solid float on the team library, where a skill is installed; the other opened projects show washed-out floats where skills fit.](../media/home.jpg)

When you are done, choose **Remove sample workspace** on the banner in any sample project or
library, in Settings → Storage, or in the command palette. It removes only the examples.

## Your first project

1. **Open a project** and pick a repository. Habi reads build files and structure (no execution).

2. **Connect a library** to get recommendations. Choose from:
   - A Git repository (team-curated or public)
   - A public library from the catalog
   - A folder on your machine

3. **Read the recommendations.** Each shows why it fits, down to the file and line. Missing info
   (e.g., dependencies inherited from outside the repo) can be answered by you.

4. **Install:** Review preselected agent tools, check the files that will change, and confirm.
   You see every file before anything is written.

Next: [My skills](my-skills.md) (write and edit skills) or [Sharing](sharing.md) (send improvements back).

## What Habi writes

In your project (only after you confirm):
- Skill folders in `.claude/skills/` or `.agents/skills/`
- A managed section in `AGENTS.md` with import line in `CLAUDE.md` or `GEMINI.md`
- MCP server entries (optional)
- `.habi/lock.json` to track installations

On your machine:
- Skill folders in `~/.claude/skills/` or `~/.agents/skills/`
- `~/.habi/lock.json`

See [Agent tools](agent-tools.md) for exact file locations. Every change is journaled and can be restored via [Recovery](recovery.md).

## What Habi never does

- Runs builds, package managers, scripts or Git to inspect your repo
- Changes your checkout or branches
- Sends data off-machine unless you explicitly share/push
- Uses accounts, telemetry or cloud services

**Removing Habi:** The app can be uninstalled safely—installed skills and `.habi/lock.json` remain as ordinary files.
