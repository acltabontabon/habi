# Product contract

## Problem

Developers who work with AI coding agents keep learning useful things: a skill that needed one
more instruction, a script that makes a migration safe, a convention a repository depends on.
That knowledge fragments. One developer improves a skill and nobody else sees it. A better
workflow stays on one machine. Community skills are easy to find and install; what happens
afterwards is the hard part — keeping knowledge useful, improving it, and letting the next
developer benefit.

A skill existing in a catalog also does not establish that it fits a project, that its
prerequisites are present, or that it has been tried anywhere relevant.

## Promise

*Knowledge should not stop with the developer who learned it.*

Habi is a local knowledge layer around engineering work. It brings the knowledge that exists —
yours, your team's, the community's — into the project you are working on, shows why it
applies, and carries what you refine there back to where the next developer will find it.

**Find** what applies here → **apply** it through the agent tools you already use → **refine**
it through real work → **share** what you learned as a reviewed change → teammates **reuse** it,
and the loop starts again.

## Knowledge model

| | Where it lives | Who stands behind it |
|---|---|---|
| **My skills** | Plain Agent Skills folders on this machine | You |
| **Team libraries** | Git repositories (or folders) the team curates | The team, through review |
| **Community libraries** | Git repositories published by others | Their authors — not reviewed by your team |
| **The project** | The repository you opened | Context: what is already there, and which of the above applies |

These are not one physical repository. Habi presents them as one layer and keeps provenance:
a copy remembers the library item and version it came from (and the project, when it was an
installed copy with local edits), a contribution names the library it is for, and updates
compare against the recorded version so local adaptations are never overwritten silently.

The defining experience is still **repository relevance** — opening a project answers "what
helps here?" with evidence — but a repository is context for knowledge, not the whole product.
Habi is not a marketplace, agent launcher, chat application or configuration dashboard.

## Principles (and where they live in the code)

| Principle | How Habi keeps it |
|---|---|
| Repository first | Opening a project is the primary action; recommendations come from inspection (`inspect`), not from browsing a catalog. A project opens on **Suggested** (`suggest`): a short, capped answer to "what should my agents have here?" — team requirements, skills for its stack, a few practices — from connected libraries and from Habi's catalog picks, judged from the catalog alone before anything is connected. What the person's other projects already use comes first: each project they open informs the next. |
| Explain relevance | Every result carries an evaluation tree with fact ids, files and lines (`matching::eval::EvalNode`). Unknown is a first-class outcome; there are no confidence percentages. A rule has one of three authors and says which: the skill's author (`habi.yaml`), Habi's catalog (a hint or a pick), or the skill's own description (`matching::described`: the technologies its name and description name, read with a fixed lexicon — Habi's reading of the author's words, never presented as the author's rule). |
| Create where the work is | `skills`: local drafts and imported copies as plain Agent Skills folders; a condition builder over the matching schema; an applicability preview across registered projects. No model, account or library required. |
| Pay it forward | `contribute`: refinements go back to the library they came from (or any connected library) with an explicit file selection, a preview of exactly what leaves the machine, and a reviewed branch, request or patch. A prepared branch, a pushed branch and an opened request are reported as different things. Copies keep their origin (`SkillOrigin`), and library updates to a copy are reviewed three ways (`skills::upstream`). |
| Allow justified differences | Local edits to installed files are detected and kept; updates are three-way; users can declare facts per project (`Declaration`). |
| Use existing standards | Agent Skills (`SKILL.md`), `AGENTS.md`, native MCP config files, Git. Habi metadata is an optional sidecar. |
| Remain portable | Installed content is plain files. Nothing needs Habi running. The lock file is optional bookkeeping. |
| Be precise about evidence | Applicability, readiness, installation and evidence are four separate fields; "configured" never means "working". |
| Work locally | No account, no telemetry, no model calls. Git uses the user's own credentials. |
| Preserve developer control | Refresh never touches projects. Every change is a previewed plan with preconditions, a journal and restore. |
| Make complexity approachable | Plain-language labels, keyboard access, progressive disclosure (full evaluation trees and file excerpts on demand). |

## Four independent dimensions

- **Applicability:** applies · does not apply · needs information · not matched (no metadata).
- **Readiness:** ready · prerequisite missing · not established · no prerequisites.
- **Installation:** not installed · installed · update available · edited locally · edited with conflicting update · source not connected.
- **Evidence:** declared by author · checked here · partially checked · check failed · check out of date · not evaluated.

They are never collapsed into a single "green" status.

**Use** sits beside them and feeds none of them: *Used 12× in 30 days* or *Not used in 30 days* on
an installed skill, counted from Claude Code's history on this machine when the list opens. It
helps a person prune what they no longer need; it does not rank or recommend anything, and says
nothing when there is nothing to go on.

Readiness is reported per compatible agent and installation previews assess the selected
agents. A project MCP entry establishes configuration only, not startup or authentication.
Evidence summarizes the latest completed results across declared checks and applicable
modules, with explicit failed, stale and unchecked counts. Incomplete inspection cannot
produce a fully checked summary.

## Validation target

A developer opens an unfamiliar repository and identifies an appropriate, maintained team
workflow faster, and with less guesswork, than by asking around or browsing a shared skills
folder. The defining demonstration — one library, three structurally different repositories,
meaningfully different and explainable recommendations — is automated in
`crates/habi-core/tests/matching_fixtures.rs` and `acceptance.rs`.

Known gaps are listed in one place:
[security model](security-model.md#known-limitations).

## Out of scope by design

A workflow execution engine, model routing or proxies, a marketplace, conversation
monitoring, autonomous agents, LLM-generated applicability presented as fact, and
effectiveness scores without evidence.

Counting skill use is not conversation monitoring, and it stays that way: it runs when a person
opens a list, takes only skill names and times from an agent's local history, and keeps nothing
([exactly what is read](security-model.md#claude-code-session-history)). A count is not an
effectiveness score, and is not presented as one.

## Future direction

Not in this release. Habi keeps provenance and evidence so these can be built later without
reworking the core:

- **Similar contributions.** Compare incoming contributions with existing items (content
  digests, shared conditions) to suggest consolidation — always as a suggestion to
  maintainers, never an automatic merge.
- **Repeated corrections.** Surface skills that are frequently edited locally in the same way
  (lock-file drift across projects a team chooses to share), as candidates for upstream fixes.
- **Rehearsal at scale.** Evaluate a new skill's conditions against a set of representative
  repositories before publishing. Today a contribution can summarize where its rules apply
  among the projects you opened.
- **Centralized evaluations and adoption reporting** — only with explicit, opt-in team
  infrastructure; never background collection from developers' machines.
- **More detectors** (.NET, Terraform) using the same coverage discipline.
- **Instructions and MCP servers on this machine.** Installing on this machine covers skills
  only.
- **Cursor `.mdc` rules** for glob-scoped instructions where AGENTS.md is too coarse.
