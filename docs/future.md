# Future direction (not in this release)

Habi keeps provenance and evidence so these can be built later without reworking the core:

- **Similar contributions.** Compare incoming contributions with existing items (content
  digests, shared conditions) to suggest consolidation — always as a suggestion to
  maintainers, never an automatic merge.
- **Repeated corrections.** Surface skills that are frequently edited locally in the same way
  (lock-file drift across projects a team chooses to share), as candidates for upstream fixes.
- **Rehearsal.** Evaluate a new skill's conditions against a set of representative
  repositories before publishing, showing where it would and would not apply.
- **Centralized evaluations and adoption reporting** — only with explicit, opt-in team
  infrastructure; never background collection from developers' machines.
- **More detectors** (Python, Go, .NET, Terraform) using the same coverage discipline.
- **User-scope installation** (`~/.claude/skills`, `~/.agents/skills`) behind an explicit
  scope choice, with the same plan/journal guarantees.
- **Cursor `.mdc` rules** for glob-scoped instructions where AGENTS.md is too coarse.

Out of scope by design: a workflow execution engine, model routing/proxies, a marketplace,
conversation monitoring, LLM-generated applicability presented as fact, and effectiveness
scores without evidence.
