# Product contract

## Problem

Engineering teams lack a straightforward way to share their practical AI expertise,
identify which skills and workflows apply to a particular repository, and keep that
knowledge useful as their projects evolve. A skill existing in a catalog does not establish
that it fits a project, that its prerequisites are present, or that it has been tested in a
relevant environment.

## Promise

Open a repository and discover the skills and workflows that fit it, understand why they
fit, and adopt them through the agent tools developers already use — and turn what you know
into skills your team can find the same way.

The journey: **open a project → discover existing knowledge → create or improve a skill →
preview where it applies → prepare it for an agent → share it when ready.** A team does not
need an organized skills library before Habi is useful; a repository and an idea are enough.

*Your team's know-how, matched to your codebase.*

The defining experience is **repository relevance**. Library management, Git
synchronization and agent configuration exist to serve it. Habi is not a marketplace, agent
launcher, chat application or configuration dashboard.

## Principles (and where they live in the code)

| Principle | How Habi keeps it |
|---|---|
| Repository first | The project is the home screen; recommendations come from inspection (`inspect`), not from browsing a catalog. With nothing to recommend, the project shows the skills and instructions already in it. |
| Explain relevance | Every result carries an evaluation tree with fact ids, files and lines (`matching::eval::EvalNode`). Unknown is a first-class outcome; there are no confidence percentages. |
| Create where the work is | `skills`: local drafts and imported copies as plain Agent Skills folders; a condition builder over the matching schema; an applicability preview across registered projects. No model, account or library required. |
| Share practical discoveries | `contribute`: explicit selection, preview of exactly what leaves the machine, reviewed branch or patch. A prepared branch, a pushed branch and an opened request are reported as different things. |
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
- **Evidence:** declared by author · checked here · check failed · check out of date · not evaluated.

They are never collapsed into a single "green" status.

## Validation target

A developer opens an unfamiliar repository and identifies an appropriate, maintained team
workflow faster, and with less guesswork, than by asking around or browsing a shared skills
folder. The defining demonstration — one library, three structurally different repositories,
meaningfully different and explainable recommendations — is automated in
`crates/habi-core/tests/matching_fixtures.rs` and `acceptance.rs`.

## Out of scope for this release

Generic workflow execution, marketplaces, model routing or proxies, centralized backends,
autonomous agents, semantic consolidation of similar skills, organization-wide adoption
reporting. See `docs/future.md`.
