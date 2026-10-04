# Habi metadata

Habi reads `SKILL.md` as-is. Optional metadata files layer on **where it applies, what it needs,
workflows, and evidence**—in standard YAML, easy to version in Git.

**Two files:**
- `habi.yaml` — sidecar next to `SKILL.md`
- `habi-library.yaml` — at library root

## Skills without metadata

Skills stay listed and installable, under *Available to use manually* (Habi doesn't guess
from titles). Large community libraries won't bury applicable skills: in a project that group
is collapsed until you press *Show*.

## Licenses

Reported as-is: `SKILL.md` license field + nearest license file in the skill's folder or parents
(`LICENSE`, `LICENSE.txt`, `COPYING`, `LICENSE-MIT`, etc.). "Proprietary" triggers a note on
install and warning on share. Subfolders only see licenses inside them.

## Quick start

A library is a Git repo (or a folder in one) with `SKILL.md` files. Add `habi.yaml` to make
skills match projects:

```yaml
habi: 1
title: Liquibase migration review
applies_when:
  all:
    - tag: framework:spring-boot
    - dependency: org.liquibase:liquibase-core
excludes:
  tag: db:jooq
requires:
  tools:
    - name: Maven
      commands: [./mvnw, mvn]
```

**Validate before sharing:** connect the folder as a library in Habi; each item shows its
problems. Contributors working from a clone can also run
`cargo run -p habi-cli -- validate path/to/library`.

See [example library](../../fixtures/libraries/example-team-library) (uses all features) and
[valid](../../schema/examples/valid) / [invalid](../../schema/examples/invalid) examples.

## Skill metadata fields

| Field | What it does |
|-------|---|
| `habi` | **Required.** Schema version (`1`). |
| `id` | Stable ID in the library (defaults to SKILL.md `name`). |
| `title`, `owner` | Display name & maintainer (attribution only, not access control). |
| `kind` | `skill` (default) or `workflow` (ordered procedure). |
| `requirement` | `recommended` (default) or `required` (team-level; always shown, never filtered). |
| `priority` | −100…100 (explicit team ordering). |
| `scope` | `module` (default) or `repository` (evaluate-once flag). |
| `applies_when`, `excludes` | Matching conditions ([below](#conditions)). |
| `requires.tools` | Tools needed: `{name, commands[], purpose?, install_hint?}`. Commands looked up on PATH or as `./name`. Not executed. |
| `requires.mcp` | MCP server: `{name, purpose?, server?}` where server is config (`{command, args[], env}` or `{url, bearer_token_env}`). No literal secrets. |
| `requires.clients` | Agent tools this works with: `claude-code`, `cursor`, `codex`, `gemini-cli`, `copilot`, `opencode`, `junie`. Omit if unrestricted. |
| `workflow.steps[]` | Guidance: `{title, detail?, references[]?, expected?}` (shown in order, not enforced). |
| `workflow.artifacts[]` | What the workflow produces. |
| `bindings[]` | User inputs: `{name, kind: file|module, glob?}` (Habi offers candidates). |
| `checks[]` | QA checks: `{id, title, description?, run[], cwd: module|repository, timeout_seconds}` (arg arrays, no shell strings). |
| `evidence[]` | Author records: `{date, result, environment?, summary?, by?}` (shown as-is, not verified). |
| `examples[]` | `{title, description?, path?}`. |

**Custom fields** allowed; prefix with `x-` to preserve them.

## Conditions

Each condition object has one key. Example:

```yaml
applies_when:
  all:                               # all must hold
    - tag: framework:spring-boot
    - any:                           # or at least one
        - dependency: org.liquibase:liquibase-core
        - file: "**/db/changelog/**"
excludes:
  not:                               # negation
    dependency:
      name: "org.jooq:*"             # wildcards (≤3)
      ecosystem: jvm                 # maven|gradle|npm|go|cargo|pypi|composer|jvm
      version: ">=3.18, <4"          # semver requirement
```

**Three-valued logic** (true / false / unknown):
- Found → *true* (with evidence)
- Absence (complete evidence) → *false*; otherwise *unknown*
- `all`: false anywhere → false; unknown → unknown
- `any`: true anywhere → true; unknown → unknown
- `not`: flips true/false, keeps unknown

**Results:**
- Confirmed exclusion → *does not apply*
- Unknown exclusion/requirement → *needs information* (user can answer)
- Ranking (requirement, priority, specificity) never changes eligibility

**Limits:** depth 8, max 64 nodes, globs ≤256 chars. No scripting or regexes.

## Library manifest (`habi-library.yaml`)

```yaml
habi: 1
name: Platform team know-how
owner: Developer Experience
description: …
contact: "#platform (chat channel)"
skills_root: skills             # optional; default: find SKILL.md anywhere
instructions:                   # Markdown → managed sections in AGENTS.md
  - id: java-conventions
    title: Java conventions
    path: instructions/java.md
    requirement: required
    scope: repository
    applies_when: { tag: lang:java }
```

**Fields:**
- `habi`: schema version (required)
- `name`, `owner`, `description`, `contact`: metadata
- `skills_root`: subfolder to search (optional; default searches everywhere)
- `instructions[]`: shared instructions, each with condition (same format as skills)

## Lineage

When a copy of a library skill is shared into a *different* library, Habi records where it was
refined from in the shared SKILL.md, under the Agent Skills `metadata` map (which agents
ignore):

```yaml
metadata:
  based-on: "github.com/obra/superpowers#brainstorming@8ca22db"
```

The value is `<library identity>#<item id>@<version>` and names the immediate parent only.
It is shown in the contribution review, where the author can leave it out. Habi never records
machine-local sources, never writes a team library's address into a contribution to a
community library, and edits only that line (the rest of SKILL.md keeps its bytes). Who refined
it is in the Git commit's author, not in the file.

## Identity

An item is identified by its source plus its declared `id` (or path when ids collide), and
pinned by the snapshot commit/digest and a content digest — never by display name alone.
Two libraries may contain different skills with the same name; Habi shows both and reports
install-path collisions.

## Versioning and migration policy

- `habi: 1` is the schema version. Additive, optional fields keep version 1.
- A change that alters the meaning of existing fields, or makes something required, bumps
  the version. Habi then reads version *n* and *n−1* for at least one minor release and
  explains how to migrate.
- A file with a newer version than Habi understands is reported as invalid metadata and
  ignored — the skill itself stays usable.
- The lock file (`habi_lock: 1`) follows the same policy; Habi refuses to rewrite a lock
  file written by a newer version.

## Validation

The library listing, My skills and contributions run the same checks on each skill package:
the frontmatter and `habi.yaml` rules above, plus static checks
of the package's own files — relative links and images in Markdown (and inline code such as
`scripts/check.py`) must name files in the skill, links must not climb out of it, and `.json`
and `.yaml` files must parse. **Errors** block installing and sharing from My skills and
preparing a contribution; **warnings** should be fixed; **info** is a suggestion or says what
was not checked. Scripts are never parsed or run. The full list, with levels, is in
[My skills → Checks](../guide/my-skills.md#checks).

Validation proves neither security nor correctness: it finds structural mistakes, not
whether the guidance is right or the scripts are safe.

## Authoring tips

- Prefer tags (`framework:spring-boot`) over raw dependency names where a tag exists: tags
  cover Maven, Gradle and npm declarations at once.
- Use `excludes` for "does not fit if …" rules; they are reported separately.
- Connect the folder as a library and read each item's problems before publishing.
- To have a public library suggested in Habi, see the [library catalog](catalog.md).
