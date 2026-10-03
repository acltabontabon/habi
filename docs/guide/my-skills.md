# My skills

My skills is where you write skills and keep your own copies of others'. You need only a
repository and an idea: no library, account or model. When a skill is ready, you use it in a
project or on this machine, and share it when it is worth sharing.

Shortcuts are written for macOS; on Windows, use Ctrl where this page says ⌘.

## What is where, and who owns it

| Thing | Where it lives | What Habi does with it |
|---|---|---|
| A skill **in a project** (`.claude/skills/…`, `.agents/skills/…`, any folder with `SKILL.md`) | The project, untouched | Lists it under *Already here* and lets you read it, copy it or turn part of it into a skill. |
| An **instruction file** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor and Claude rules, Copilot instructions) | The project, untouched | Lists it with its sections. You can copy a part into a draft; the file is never rewritten by this. |
| A skill **on this machine** (`~/.claude/skills`, `~/.agents/skills` and each tool's own folder) | Your home folder | Lists it under *On this machine*. Habi changes only the skills it installed there. |
| A skill in **My skills** (a draft, or a copy) | `<data>/skills/<id>/package/`, a plain Agent Skills folder | Yours to edit. Not installed or shared until you choose. |
| A skill in a **library** | Habi's read-only copy of the library | Never edited in place. *Edit a copy…* makes an attributed copy in My skills; your edits go back through a reviewed contribution. |
| An **installed copy** | The project, or your home folder | Written only through a reviewed plan. Editing your skill afterwards does not change it; the change shows as an update. |

`<data>` is Habi's data folder; Settings → This machine → Data folder shows where it is.

## Creating a skill

**New skill** (in My skills, *Create a skill* in the command palette, or ⌘N) opens an empty page with the cursor in
it. There is no form and nothing to decide first.

While the skill is a fresh draft of yours, Habi names it from what you write: the first heading
becomes the title until you type one, and the title becomes the identifier (the Agent Skills
`name`) until you change it or install the skill. With no purpose yet, *Use the opening line*
takes the first sentence of the instructions.

## The Skill Studio

![The Skill Studio with a new skill, Review a pull request: its purpose under the title, when to use it and what it comes with, and the instructions as a document, with Ready, Share and Use at the top.](../media/skill-studio.jpg)

A skill opens as one document: the title, the **purpose** (the `description` agents read to
decide when to load it), where it came from, and the instructions. The other parts are layers
of the same skill:

- **Instructions** (⌘1). Markdown, shown as the document it is: away from the cursor, headings
  read as headings, code is highlighted, and links or backticked paths to the package's own
  files read as references (⌘-click opens one). An empty skill offers starters. The outline
  sits in the margin; ⌘⇧O opens it.
- **When to use** (⌘2). Signals, written as facts about a project: *Playwright is used*,
  *Depends on `@playwright/test`*, a file pattern. *Add signal* proposes what Habi could look
  for, and what it saw in your most recent project. Then *Avoid when* (exceptions), *Check
  within* (each module, or the whole repository) and the tools the skill needs, looked up on
  PATH and never run. These write the `habi.yaml` conditions that recommendations use
  ([Habi metadata](../library-authors/metadata-schema.md)). *Edit When to use as YAML*, in
  the command palette, edits the file directly and shows how Habi reads it.
- **Materials** (⌘3). What the skill brings with it, by kind: scripts, examples, references,
  assets. Each says what it is for, in the instructions' own words. A material the
  instructions never mention says so, with *Reference it* to add a line for it. *Add
  material* places files by type (code in `scripts/`, writing in `references/`, the rest in
  `assets/`); pasted code and dropped files are placed the same way. Scripts are stored and
  shown, never run; *Open in your text editor* opens one as text.

A skill without signals is used by hand: it is available when you choose it and never
recommended. Habi never adds a signal on its own. When the instructions keep naming a
technology, it offers the signal, and adds it only when you click.

The bar above the skill shows **Ready** or **Draft**, **Use**, the share action, and **•••**
for the rest: *Test against a project…*, *Where it came from*, *View source*, *View package
source*, *Export as zip…*, *Show the package folder* and *Move to trash*. Everything is also in
the command palette (⌘K).

### Readiness

**Ready** or **Draft** opens what is left to do, each item with the way to it: a title, a
purpose, a valid identifier. The identifier is changed deliberately, with *Change the
identifier*.

### Saving

Drafts save as you type, on ⌘S, when the window loses focus and when you leave the skill.
Saving is silent while it succeeds: the bar says *Saving…* during a write, and *Couldn’t save*
with a retry when one failed, and keeps your text on screen.

Every save names the version of the file it started from. If the file changed outside Habi in
the meantime, saving pauses and you choose: **Show the other version** or **Keep mine**.
Neither is overwritten silently.

*Move to trash* can be undone from My skills → Trash → Restore; *Delete permanently…* is a
separate, confirmed step.

## Testing against a project

*Test against a project…* evaluates the skill's signals in a project you choose, with the
same matcher recommendations use, and says why:

- *Would be suggested here*, with the facts and files behind each signal.
- *Would not be suggested here*: a signal does not hold in a complete inspection, or an
  exception does.
- *Can’t tell yet*: something could not be established, for example a dependency inherited from
  a parent build file outside the repository. Missing evidence is never treated as absence.

The tools the skill needs are looked up, never run, and do not change the verdict. A verdict
is about the rules only: it says nothing about the skill's quality or what an agent will do
with it.

## Checks

Habi runs the same checks on every package it reads: library items, My skills, contributions
and `habi validate`. Each problem has a level:

- **Error.** Blocks installing, exporting and sharing a skill from My skills, and preparing a
  contribution. A library item with errors stays listed, with its problems shown.
- **Warning.** Should be fixed; nothing is blocked.
- **Info.** A suggestion, or something that was not checked (and why).

| Check | Level |
|---|---|
| `SKILL.md` exists and starts with YAML frontmatter that parses | error |
| `name` is present and valid (lowercase letters, digits, hyphens; 1–64 characters) | error |
| `description` is present | error |
| `name` matches the folder name; `description` is at most 1,024 characters | warning |
| `habi.yaml` parses, matches the schema, has valid conditions, and its checks use declared bindings (otherwise the metadata is ignored as a whole) | error |
| Files named in `workflow.steps[].references` exist | warning |
| Relative links and images in `SKILL.md` and the other `.md` files (except under `assets/`, where Markdown is usually a template) point to a file or folder in the skill. Targets resolve from the folder of the file that contains them; `#fragment` and `?query` are ignored. | warning, naming the file and the missing path |
| A relative link that climbs out of the skill (`../shared/README.md`) | warning: it will not resolve once the skill is installed or shared on its own |
| Inline code that is plainly a package path (`scripts/…`, `references/…` or `assets/…`, with no spaces, wildcards, placeholders or line numbers) names a file in the skill | warning |
| `.json` files parse (comments and trailing commas, as in `tsconfig.json`, are accepted) | warning, with the parser's message |
| `.yaml` and `.yml` files other than `habi.yaml` parse, with the same limits as `habi.yaml`; several documents in one file are fine | warning, with the parser's message |
| A text file too large to scan (over 512 KiB; YAML over 256 KiB), or a `.json` or `.yaml` file that is not UTF-8 | info (not checked) or warning |
| The `SKILL.md` body is very long | info |
| Symbolic links or oversized files (the package would be incomplete) | error |
| My skills only: another of your skills uses the same identifier | error |
| My skills only: the instructions are empty, or a file looks like it contains a secret (an error when sharing) | warning |

The link check is deliberately conservative: URLs (`https:`, `mailto:` and any other scheme),
`#anchors`, absolute and home paths, templated targets (`{{…}}`, `*`, `$`), fenced code
blocks, inline code containing link syntax, HTML comments and footnotes are never reported.

**Scripts are not checked.** Habi does not parse, lint or run them, not even with a syntax check
such as `bash -n`, because that would execute or interpret package content.

Passing every check proves neither security nor correctness. The checks catch structural
mistakes before someone else trips over them.

## Adding existing skills

**Add skills** lists where skills can come from. Habi inspects first and writes nothing until
you choose.

1. **A project you opened.** The skill folders found there.
2. **A folder on this machine.** One skill, or a folder of skills such as your personal ones.
3. **A Git repository**, two different ways:
   - *Make my own copy* reads the repository once, copies what you choose, and connects
     nothing. Each copy remembers the repository and the version.
   - *Connect as a library* keeps it to browse and update from. Nothing is copied.
4. **A library you connected.** Copies stay linked to it, so you can review its updates.

The inspection lists each package with its origin, files, license, whether it has rules for
when it applies, and any problems. Importing copies packages byte for byte (references,
scripts with their executable bit, assets and unknown frontmatter included) and records where
each came from. Originals are never changed.

- **Same content already imported:** not selected by default. You can still add a second copy
  under a new identifier.
- **Same identifier, different content:** imported only under a new identifier, so both are
  kept.
- **Incomplete packages** (symbolic links, oversized files): shown, not importable. A partial
  copy would silently lose content.

### Turning instructions into a skill

In a project, *Already here* lists the instruction files. *Turn part into a skill…* shows a
file with its sections: select a section or a range of lines, and the draft's body is that
text, with its origin (file, lines, project) recorded in the draft and in
`metadata.derived-from`. The instruction file stays exactly as it is.

Rules every change must follow belong in the instruction file, where agents always read them.
A skill is loaded only when it is relevant.

## Where it came from, and updates

A copy keeps its files as they were when it was copied, or when it last took an update. Once
it differs, the head says *changed here*. *Where it came from* opens the original, when it was
imported, what you changed (as parts of the skill: *Instructions*, *When to use*, a file), a
newer version in the library if there is one, the projects it is installed in, and the ways to
pass it on. This keeps working after the repository or library is gone.

When the library's version changes, My skills and the skill say so. **Review the update…**
compares three versions of every file: as copied, the library's now, and yours. Files only the
library changed are taken, files only you changed are kept, and a file changed on both sides
needs your choice (*Keep mine* or *Take the library's*) before anything is written. If the item
was removed, the library is not connected, or the copied version is no longer cached, the skill
says so and offers nothing.

## Using a skill

**Use** chooses where the skill goes:

- **In a project.** Habi lists your projects with what the skill's rules say about each, then
  opens the usual review: check the agent tools Habi preselected, see every file that would be
  created or changed, and confirm. Notes for the chosen tools appear in the review.
- **On this machine.** The same review, for your own skill folders (see below).

Valid skills in My skills also appear in each project's recommendations, with *My skills* as
the source, matched by their rules like library items.

Installed means the files are where the agent looks. It does not mean the agent loaded or
followed them.

## On this machine

*On this machine*, in My skills, lists the skills in your own skill folders (`~/.claude/skills`,
`~/.agents/skills`, and each tool's own folder such as `~/.cursor/skills`), with which tools
read each one and, where a project holds a copy too, which copy a tool uses. A skill in
several of those folders (installed for Claude Code and Codex, say, it is in both
`~/.claude/skills` and `~/.agents/skills`) is one entry: its folders are listed together, and
a row of agent tools lights up the ones that read it. Habi only reads
skills it did not install: *Add to My skills* copies one in, and *Use in a project…* installs
it in a project. The original is never touched.

To install a skill there on purpose, choose *Add to this machine…* on a library skill, or **Use
→ On this machine…** on one of yours. The review lists every file under your home folder
before anything is written. Skills Habi installed say so and name their library, with
*Update…* and *Remove from this machine…*. Each of these is journaled like a project install,
but no screen offers to restore one yet. [Agent tools](agent-tools.md#where-files-go-on-this-machine)
lists the folders, the record Habi keeps and which copy each tool uses.

## Sharing

The share action on a skill is **Share…** for a skill you wrote, **Share your version…** for a
copy, and **Contribute to *library*…** for a skill copied from a connected library. It sends
the skill to a library as a reviewed contribution: choose the library (or connect one), review
exactly the files that would leave this machine, prepare a branch in Habi's own copy of the
library, then push it and open a pull or merge request. With no Git library connected, *Export
as zip…* writes the skill as a file you can send or commit anywhere.

[Sharing](sharing.md) covers every step, and what each status means.

## Not included

- Running a skill, or watching an agent use it.
- AI-assisted drafting. Editing, matching and testing are deterministic and work offline.
- Command-line commands for My skills. The command line covers libraries, recommendations,
  installs and contributions.
