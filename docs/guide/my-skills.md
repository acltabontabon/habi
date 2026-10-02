# My skills: creating, adding and using skills locally

Habi is useful with only a repository and an idea. A team library is optional.

**Open a project → discover existing knowledge → create or improve a skill → preview where it
applies → prepare it for an agent → share it when ready.**

## What is where, and who owns it

| Thing | Where it lives | What Habi does with it |
|---|---|---|
| A skill **found in a project** (`.claude/skills/…`, `.agents/skills/…`, any folder with `SKILL.md`) | In the project, untouched | Lists it, lets you read it. It keeps working for the agents that read that folder. |
| An **instruction file** (`AGENTS.md`, `CLAUDE.md`, Cursor/Claude rules, Copilot instructions) | In the project, untouched | Lists it with its sections. You may copy a selected part into a draft. The file is never rewritten by this. |
| A skill in **My skills** (a draft, or an imported copy) | `<data>/skills/<id>/package/` — a plain Agent Skills folder | Yours to edit. Not installed or shared until you choose. |
| A skill in a **team library** | Habi's read-only cache of the Git repository | Never edited in place. *Copy to My skills to edit* makes an attributed copy; your edits go back through a reviewed contribution. |
| An **installed copy** in a project | The project (`.claude/skills/<name>` or `.agents/skills/<name>`) | Written only through a reviewed plan. Editing the draft afterwards does not change it; it shows as an available update. |

Discovery looks only inside the project you opened. Personal and global agent folders are not
scanned; bring skills in from them with **Add skills → From a folder**.

## Creating a skill

*Create a skill* (welcome screen, sidebar, ⌘N, or *Create a skill for this project*) needs
only a title. It works offline and without a project, library, account or model.

The editor has three connected parts, with the applicability preview beside them:

- **Purpose** — the description agents read to decide when to load the skill, and the
  identifier (the Agent Skills `name`: lowercase letters, digits, hyphens).
- **Instructions** — Markdown with a preview. ⌘B/⌘I/⌘E format; Tab moves focus. Two optional
  starting structures (review procedure, implementation guide) are offered while it is empty.
- **Applicability** — a condition builder: *applies when* (technology, dependency, file
  pattern; all or any), *never applies when*, required tools, and module or repository scope.
  It writes the same `habi.yaml` conditions the matcher evaluates. A YAML view edits the file
  directly and saves it exactly as typed, including keys Habi does not know; rules the builder
  cannot express are kept as written.
- **Files** — the package as real files: `SKILL.md`, optional `habi.yaml`, `references/`,
  `scripts/`, `assets/`. Text files can be edited; scripts are stored, never run.

When a skill is written for a project, or you choose a project under *Suggest from*, the
builder offers facts observed there (with the file and line they came from). Each is added
only when you click it.

A skill without rules has **applicability not specified**: it stays available for deliberate
use everywhere and is never recommended. Habi does not infer rules from a title.

### Saving

Drafts save as you type (and on ⌘S, when the window loses focus, and when you leave the
screen). The indicator says *Saved* only after the write succeeded; a failed write says *Not
saved* and keeps your text on screen.

Every save names the version of the file it started from. If the file changed outside Habi in
the meantime, saving pauses and you choose: **Show the other version** or **Keep mine**.
Neither is overwritten silently.

*Move to trash* is reversible from My skills; *Delete permanently* is a separate, confirmed
step.

## Checks

The editor lists problems as you work ("Draft — 2 things to finish…", "3 notes"). They come
from the same checks Habi runs on every package it reads — library items, My skills,
contributions before a branch is prepared, and `habi validate`. Each problem has a level:

- **Error** — blocks installing, exporting and sharing a skill from My skills, and preparing a
  contribution. A library item with errors stays listed, with its problems shown.
- **Warning** — should be fixed; nothing is blocked.
- **Info** — a suggestion, or something that was not checked (and why).

What is checked, exactly:

| Check | Level |
|---|---|
| `SKILL.md` exists and starts with YAML frontmatter that parses | error |
| `name` is present and valid (lowercase letters, digits, hyphens; 1–64) | error |
| `description` is present | error |
| `name` matches the folder name; `description` is at most 1024 characters | warning |
| `habi.yaml` parses, matches the schema, has valid conditions, and its checks use declared bindings (otherwise the metadata is ignored as a whole) | error |
| Files named in `workflow.steps[].references` exist | warning |
| **Links and images** in `SKILL.md` (body) and the other `.md` files — except under `assets/`, where Markdown is usually a template — whose target is a relative path point to a file or folder in the skill. Targets resolve from the folder of the file that contains them; `#fragment` and `?query` are ignored. | warning, naming the file with the link and the missing path |
| A relative link that climbs out of the skill (`../shared/README.md`) | warning: it will not resolve once the skill is installed or shared on its own |
| **Inline code** that is plainly a package path — `scripts/…`, `references/…` or `assets/…` with no spaces, wildcards, placeholders or line numbers — names a file in the skill | warning |
| `.json` files parse (JSON with comments and trailing commas, as `tsconfig.json` uses, is accepted) | warning with the parser's message |
| `.yaml` / `.yml` files (other than `habi.yaml`) parse, with the same size and complexity limits as `habi.yaml`; several documents in one file are fine | warning with the parser's message |
| A text file too large to scan (over 512 KiB; YAML over 256 KiB), or a non-UTF-8 `.json`/`.yaml` | info (not checked) / warning |
| The `SKILL.md` body is very long | info |
| Symbolic links or oversized files (the package would be incomplete) | error |
| My skills only: another of your skills uses the same identifier | error |
| My skills only: the instructions are empty; a file looks like it contains a secret (an **error** when sharing) | warning |

The link check is deliberately conservative: URLs (`https:`, `mailto:` and any other scheme),
`#anchors`, absolute and home paths, templated targets (`{{…}}`, `*`, `$`), fenced code
blocks, inline code containing link syntax, HTML comments and footnotes are never reported.

**Not checked:** scripts. Shell, Python and other scripts are stored as files; Habi does not
parse, lint or run them (not even a syntax check such as `bash -n`), because that would
execute or interpret package content.

Passing every check proves neither **security** nor **correctness**: a package with no
problems can still be wrong, unsafe, or not do what its description says. The checks only
catch structural mistakes before someone else trips over them.

## Turning instructions into a skill

In a project's **In this project** tab, *Turn part into a skill…* shows the instruction file
with its sections. Select a section or a line range; the draft's body is that text, and its
origin (file, lines, project) is recorded in the draft and in `metadata.derived-from`.

The instruction file stays exactly as it is. Rules every change must follow belong there,
where agents always read them; a skill is loaded only when relevant.

## Previewing where it applies

While you edit rules, **Where it applies** evaluates them against every project you have
opened, with the same matcher recommendations use:

- *Applies* — with the facts and file locations behind each condition (click one to see the lines).
- *Does not apply* — a condition does not hold in a complete inspection, or an exclusion does.
- *Needs information* — something could not be established (for example, dependencies
  inherited from a parent build file outside the repository). Missing evidence in an
  incomplete inspection is never treated as absence.

This previews the **rules**. It says nothing about the skill's quality or what an agent will
do with it; "Applies" does not mean tried or verified.

## Adding existing skills

**Add skills** has three sources. Habi inspects first and writes nothing until you choose.

1. **From a project** — the skill folders found there.
2. **From a folder** — one skill, or a folder of skills.
3. **From a Git repository** — connects it as a team library (it stays current when you
   refresh). To edit one of its skills, copy it to My skills.

The inspection lists each package with its origin, files, license, whether it has
applicability rules, and any problems. Importing copies packages byte for byte — references,
scripts (with their executable bit), assets and unknown frontmatter included — and records
where each came from. Originals are never changed.

- **Same content already imported:** not selected by default; you may still add a second copy
  under a new identifier.
- **Same identifier, different content:** imported only under a new identifier, so both are kept.
- **Incomplete packages** (symbolic links, oversized files): shown, not importable — a partial
  copy would silently lose content.

### Updates from the library a copy came from

A skill copied from a team library remembers the library, the item and the snapshot it was
copied at. When that item changes in the library, the editor says *Updated in <library> since
you copied it*; **Review update…** compares three versions of every file — as copied, the
library's now, and yours. Files only the library changed are taken; files only you changed
are kept; a file changed on both sides needs your choice (*Keep mine* or *Take the
library's*) before anything is written. After the update, later comparisons start from the
library version you just reviewed. If the item was removed, the library is not connected, or
the copied version is no longer cached, the editor says so and offers nothing.

## Using a skill

*Use in a project…* lists your projects with what the skill's rules say about each, then opens
the usual review: choose Claude Code, Cursor or Codex, see every file that would be created
or changed, and confirm. Compatibility notes for the chosen agents appear in that review.

Installed means the files are where the agent looks. It does not mean the agent loaded or
followed them.

Valid skills in My skills also appear in each project's recommendations (source: *My skills*),
matched by their rules like library items.

## Sharing

*Share with team…* on a skill:

1. Choose the team library — or connect one right there. With no library, *Export as a
   folder…* writes a plain skill folder you can send or commit anywhere.
2. Review exactly the files that would leave the machine, with diffs against the library, and
   validation (format, metadata, a secret scan).
3. **Prepare branch** — a commit on a separate branch in Habi's own copy of the library.
   Nothing is sent.
4. **Send for review** — after confirming, Habi pushes that branch and, where `gh` or `glab`
   is installed and signed in, opens a pull or merge request. **Export patch** is the fallback
   when you cannot push.

Contributions reports what actually happened: *Prepared locally*, *Patch exported*, *Branch
pushed — no review request*, *Review requested*, and *In the library* once a refresh shows the
library contains those files. Habi never merges and never reports a submission it did not make.

See also [Sharing](sharing.md).

## Not included

- Running a skill or observing an agent using it.
- AI-assisted drafting. Editing, matching and preview are deterministic and work offline.
- User-level (global) installation; installs target the selected project.
- `habi` CLI commands for local skills (the CLI covers libraries, recommendations and
  installs; local skills are managed in the desktop app).
