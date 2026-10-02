# Habi metadata (schema version 1)

Habi reads standard Agent Skills (`SKILL.md`) as they are. It adds only what that format
does not express — where a skill applies, what it needs, how a workflow proceeds, and what
evidence exists — in **optional** files that are easy to author in Git. This is Habi
metadata, not a new industry standard.

- `habi.yaml` — sidecar next to a `SKILL.md`. Schema: [`schema/habi-skill.schema.json`](../schema/habi-skill.schema.json)
- `habi-library.yaml` — at the library root (or configured subfolder). Schema: [`schema/habi-library.schema.json`](../schema/habi-library.schema.json)

Skills without `habi.yaml` remain listed, searchable and installable. Their applicability is
shown as *not matched*: Habi never infers rules from a title or prose. Because they are not
recommendations, a project's list collapses them into a count per library (installed ones stay
listed); `habi recommend --all` and *Show* list them. This keeps a large community library from
burying what actually fits.

Licences are reported, not interpreted: Habi shows the SKILL.md `license` as written and the
nearest licence file in the skill's folder or one of its parents (`LICENSE`, `LICENSE.txt`,
`COPYING`, `LICENSE-MIT`, …). A `license` that says *proprietary* adds a note to the install
review and a warning before sharing. A library narrowed to a subfolder only sees licence files
inside it.

Examples that the test suite validates: [`schema/examples/valid`](../schema/examples/valid)
and [`schema/examples/invalid`](../schema/examples/invalid).

## Skill sidecar fields

| Field | Meaning |
|---|---|
| `habi` | **Required.** Schema version (`1`). |
| `id` | Stable identifier within the library. Defaults to the SKILL.md `name`. |
| `title`, `owner` | Display title and maintainer (attribution only — not access control). |
| `kind` | `skill` or `workflow` (a skill that also describes an ordered procedure). |
| `requirement` | `recommended` (default) or `required` — a team designation. Required items are always listed and never filtered out. Habi does not claim to enforce Markdown guidance. |
| `priority` | −100…100. Explicit team ordering among relevant items. |
| `scope` | `module` (default: evaluate per module) or `repository`. |
| `applies_when`, `excludes` | Conditions (below). |
| `requires.tools` | `{name, commands[], purpose?, install_hint?}`. Any command satisfies it. Bare names are looked up on `PATH`, `./name` in the project. **Nothing is executed** to check. |
| `requires.mcp` | `{name, purpose?, server?}`. `server` is a suggested configuration: `{command, args[], env{VAR: "${VAR}"}}` or `{url, bearer_token_env}`. Literal secrets are rejected by the schema. |
| `requires.clients` | Clients the content is known to work with (`claude-code`, `cursor`, `codex`). |
| `workflow.steps[]` | `{title, detail?, references[]?, expected?}` — guidance shown in order, not enforced. |
| `workflow.artifacts[]` | What following the workflow produces. |
| `bindings[]` | Repository-specific values checks need: `{name, kind: file|module, glob?}`. Habi offers discovered candidates; the user chooses. |
| `checks[]` | `{id, title, run[], cwd: module|repository, timeout_seconds}`. `run` is an argument array; items may be `{binding: name}`. Never a shell string. |
| `evidence[]` | Author-declared records `{date, result, environment?, summary?, by?}`. Shown as declared, not verified. |
| `examples[]` | `{title, description?, path?}`. |

Unknown top-level keys are allowed and preserved (prefix custom keys with `x-`).

## Conditions

Each condition object has exactly one key:

```yaml
applies_when:
  all:                                   # every item must hold
    - tag: framework:spring-boot         # a derived characteristic (see docs/detectors.md)
    - any:                               # at least one item must hold
        - dependency: org.liquibase:liquibase-core
        - file: "**/db/changelog/**"     # glob relative to the module (or repository)
excludes:
  not:                                   # negation
    dependency:
      name: "org.jooq:*"                 # `*` wildcards, at most three
      ecosystem: jvm                     # maven | gradle | npm | jvm
      version: ">=3.18, <4"              # semver requirement
```

Evaluation is three-valued — **true, false, unknown**:

- A dependency/tag/file that is found is *true* (with its evidence).
- Absence is *false* only when the relevant evidence is complete (e.g. every Maven POM in the
  module was read and its parent chain is local). Otherwise it is *unknown*.
- `all`: any false → false; else any unknown → unknown. `any`: any true → true; else any
  unknown → unknown. `not` flips true/false and keeps unknown.
- A confirmed exclusion → *does not apply*. An unknown exclusion or requirement →
  *needs information*. The user can answer with a reversible declaration.
- Ranking (requirement, priority, specificity, readiness) never changes eligibility.

Limits: depth 8, 64 nodes, globs ≤ 256 characters. There is no scripting and no regular
expressions from content.

## Library manifest

```yaml
habi: 1
name: Platform team know-how
owner: Developer Experience
description: …
contact: "#platform (chat channel)"
skills_root: skills            # optional: only look for skills here
instructions:                  # Markdown installed as managed sections of AGENTS.md
  - id: java-conventions
    title: Java conventions
    path: instructions/java.md
    requirement: required
    scope: repository
    applies_when: { tag: lang:java }
```

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
  explains how to migrate (`habi validate <folder>` reports outdated files).
- A file with a newer version than Habi understands is reported as invalid metadata and
  ignored — the skill itself stays usable.
- The lock file (`habi_lock: 1`) follows the same policy; Habi refuses to rewrite a lock
  file written by a newer version.

## Validation

`habi validate <folder>`, the library listing, My skills and contributions run the same
checks on each skill package: the frontmatter and `habi.yaml` rules above, plus static checks
of the package's own files — relative links and images in Markdown (and inline code such as
`scripts/check.py`) must name files in the skill, links must not climb out of it, and `.json`
and `.yaml` files must parse. **Errors** block installing and sharing from My skills and
preparing a contribution; **warnings** should be fixed; **info** is a suggestion or says what
was not checked. Scripts are never parsed or run. The full list, with levels, is in
[My skills → Checks](local-skills.md#checks).

Validation proves neither security nor correctness: it finds structural mistakes, not
whether the guidance is right or the scripts are safe.

## Authoring tips

- Prefer tags (`framework:spring-boot`) over raw dependency names where a tag exists: tags
  cover Maven, Gradle and npm declarations at once.
- Use `excludes` for "does not fit if …" rules; they are reported separately.
- Run `habi validate path/to/library` before publishing.
