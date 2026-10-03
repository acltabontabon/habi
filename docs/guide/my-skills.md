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

*New skill* (welcome screen, My skills, ⌘N, or *Create a skill for this project*) opens an
empty page with the caret in it — no form, nothing to decide first. It works offline and
without a project, library, account or model.

While the skill is a fresh draft of yours, Habi names it from what you write: the first
heading becomes the title (until you type one), and the title becomes the identifier (the
Agent Skills `name`) until you change it, install the skill, or it came from elsewhere. When
there is no purpose yet, *Use the opening line* takes the first sentence of the instructions.

## The Skill Studio

A skill opens inside its knowledge: the title, the **purpose** (the `description` agents read
to decide when to load it), where it came from (for a skill that came from a library, a folder
or a project; one written here needs no line), and the instructions. Everything else is a
layer of the same skill, named in one line each under the purpose:

- **Instructions** (⌘1) — Markdown, written as the document it is. Away from the caret the
  markup steps aside: headings read as headings, code blocks are highlighted in their
  language, and links or backticked paths to the package's own files read as references
  (⌘-click opens one). The line being edited shows its markup in full. ⌘B/⌘I/⌘E format,
  ⌘⇧8/⌘⇧7 make lists, ⌘⇧L a link; package paths complete after `](` or inside backticks.
  An empty skill offers starters: Workflow, Troubleshooting, Code review, Tool-assisted. The
  outline is a spine of ticks in the margin that opens into the headings when pointed at, or
  with ⌘⇧O.
- **When to use** (⌘2) — signals, said as facts about a project: *Playwright is used*,
  *Depends on `@playwright/test`*, *Has files matching `playwright.config.*`*. *Add signal*
  takes a few words and proposes what Habi could look for (a technology it detects, a
  dependency, a file pattern), plus what it actually saw in your most recent project, with
  the file it came from. A technology the instructions keep naming waits as a faint row, added
  with one click. Then *Avoid when* (exceptions), *Check within* (each module or
  the whole repository), and *Needs* (tools, looked up on PATH, never run). These write the
  same `habi.yaml` conditions the matcher evaluates. For precision, *Edit When to use as YAML* (⌘K) or the package source edits `habi.yaml`
  directly, saves it exactly as typed and shows what Habi reads from it; rules the sentences
  cannot express are read out and kept as written.
- **Materials** (⌘3) — what the skill brings with it, by kind: scripts, examples, references,
  assets, other. Each says what it is for in the instructions' own words (the line that
  mentions it), else from its first comment. A material the instructions never mention says so
  once, with *Reference it*, which adds a line for it at the end of the instructions. *Add*
  brings in files and places each by what it is (code in `scripts/`, writing in
  `references/`, the rest in `assets/`), or starts a new script, reference or example; pasted
  code is offered as a script or an example; files dropped on the window are placed the same
  way and can be undone. Opening a material turns the layer into an editor, with the other
  materials beside it when there is room. Scripts are stored and shown, never run.

**Test against a project** (in ••• or the palette) slides in a sheet: whether Habi
would suggest the skill in a chosen project, and because of what — each signal with the file
it was decided on. Nothing runs until asked, and the sheet leaves when you are done.

**Where it came from** opens from the thread under the purpose (*Anthropic ──● changed
here*): the original, when it was imported, your version and what you changed here (as parts
of the skill: *Instructions*, *When to use*, a file), a newer version in the library if there
is one, the projects it is installed in, and the ways to pass it on — *Contribute
improvement* and *Share your version* for an imported skill, *Share to a library* for one
written here, *Export as zip*.

The bar above the skill holds only where you are, **Ready** or **Draft**, **Use** and •••
— with **Share** (a skill you wrote) or **Contribute** (a library's skill you changed) beside
Use when there is something of yours to pass on. A draft shows its next step instead of Use.
The same actions appear on a row in My skills when it is pointed at.
*Ready* opens what readiness is made of: what still needs doing (each with the way to it),
what is done — including the identifier, changed deliberately with *Change* — and what is
optional. *Use* chooses a project (each with why the skill fits it, or not), says what Habi
will bring, and continues to the reviewed install plan. *View source* and *View package
source* (in ••• and the palette) show the package as files — `SKILL.md` with its frontmatter,
`habi.yaml`, every folder — opened and edited as written.

A skill without signals is **used by hand**: it stays available for deliberate use
everywhere and is never recommended. Habi never adds a signal on its own: when the
instructions keep naming a technology, it offers *Suggest it there*, and adds it only when
clicked (with *Undo*).

### Saving

Drafts save as you type (and on ⌘S, when the window loses focus, and when you leave the
screen). Saving is silent while it succeeds: the bar says *Saving…* during a write and
*Couldn’t save* with *Retry* when one failed, and keeps your text on screen.

Every save names the version of the file it started from. If the file changed outside Habi in
the meantime, saving pauses and you choose: **Show the other version** or **Keep mine**.
Neither is overwritten silently.

*Move to trash* is reversible from My skills; *Delete permanently* is a separate, confirmed
step.

## Checks

The head says whether the skill is ready ("Ready to use", or "2 things to finish"); *Use &
share* lists each problem with a link to the field, line or file that fixes it. They come
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

## Would Habi suggest it?

While you edit rules, the panel evaluates them in one project at a time (the one the skill
was written for or copied from, else your most recent), with the same matcher recommendations
use:

- *Habi would suggest it here* — with the facts and file locations behind each condition
  (click one to see the lines).
- *Habi would not suggest it here* — a condition does not hold in a complete inspection, or
  an exception does.
- *Habi can't tell yet* — something could not be established (for example, dependencies
  inherited from a parent build file outside the repository). Missing evidence in an
  incomplete inspection is never treated as absence.

The tools the skill needs are looked up on PATH and in the project (nothing is run) and shown
as available or missing; they never change the verdict. *Check all projects* evaluates the rest.

This previews the **rules**. It says nothing about the skill's quality or what an agent will
do with it; "would suggest" does not mean tried or verified, and it is not whether an agent
loads the skill.

## Adding existing skills

**Add skills** lists where skills can come from. Habi inspects first and writes nothing until
you choose.

1. **A project you opened** — the skill folders found there.
2. **A folder on this machine** — one skill, or a folder of skills.
3. **A Git repository** — two different things:
   - *Make my own copy* reads the repository once, shows what it found, copies what you
     choose, and connects nothing. Each copy remembers the repository and the version.
   - *Connect as a library* keeps it to browse and update from (it stays current when you
     refresh). Nothing is copied.
4. **A library you connected** — copies stay linked to it, so you can review its updates.

The inspection lists each package with its origin, files, license, whether it has
rules for when it applies, and any problems. Importing copies packages byte for byte — references,
scripts (with their executable bit), assets and unknown frontmatter included — and records
where each came from. Originals are never changed.

- **Same content already imported:** not selected by default; you may still add a second copy
  under a new identifier.
- **Same identifier, different content:** imported only under a new identifier, so both are kept.
- **Incomplete packages** (symbolic links, oversized files): shown, not importable — a partial
  copy would silently lose content.

### Lineage: what a copy changed, and updates from its library

An imported copy keeps its files as they were when it was copied (or last took an update).
The head says *changed here* once it differs; the lineage panel (click the line above the
title) shows the original, your copy, every file you changed with its diff, the library's
state, and *Prepare a contribution…* to offer improvements back. This works whatever the copy
came from, and keeps working after the repository or library is gone.

### Updates from the library a copy came from

A skill copied from a team library remembers the library, the item and the snapshot it was
copied at. When that item changes in the library, the lineage panel and My skills say so;
**Review the update…** compares three versions of every file — as copied, the
library's now, and yours. Files only the library changed are taken; files only you changed
are kept; a file changed on both sides needs your choice (*Keep mine* or *Take the
library's*) before anything is written. After the update, later comparisons start from the
library version you just reviewed. If the item was removed, the library is not connected, or
the copied version is no longer cached, the editor says so and offers nothing.

## Using a skill

*Use in a project…* lists your projects with what the skill's rules say about each, then opens
the usual review: check the agent tools Habi preselected, see every file that would be created
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
