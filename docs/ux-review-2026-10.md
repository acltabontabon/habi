# UX walkthrough — October 2026

A first-time-user pass over the desktop app (development bridge, sample workspace, 1280×800 and
800×600 windows). Five tasks: understand what fits a project, resolve "needs information",
install, create a skill, share it with the team. Severity: **blocks** (cannot finish the task),
**confuses** (finishes, but with guesswork), **slows** (extra steps), **minor**.

What already works well and should not regress: the project header's one-line stack summary,
the four facets, the install review dialog (names the action, lists every file with a plain
explanation, restore promise), the skill editor's live "Where it applies" preview across known
projects, and the three-step sharing thread.

## Findings

| # | Where | Severity | Finding | Status |
|---|---|---|---|---|
| 1 | Item detail, needs information | blocks | The primary button "Answer what Habi couldn't establish" only selects the *Why this fits* tab, which is already selected — it does nothing visible. The questions sit far below the fold. | Fixed: scrolls to and focuses the questions. |
| 2 | Item detail, questions | confuses | Questions use raw tags and a run-on sentence: "Habi could not establish **db:jooq** in api. not detected, but the evidence is incomplete: …". The same explanation repeats under every question. | Fixed: "Does **api** use **jOOQ**?" with *Yes / No*; the shared reason is shown once. |
| 3 | Item detail, module headings | minor | Module name and path are printed twice when equal ("api api"). | Fixed. |
| 4 | Item detail, prerequisite missing | slows | The notice says "A prerequisite is missing — see below" without naming it, and does not say that installing can add the suggested MCP configuration. | Fixed: names what is missing and what installing can do. |
| 5 | Share dialog | confuses | The blocker is raw validator output ("SKILL.md: SKILL.md has no \`description\`") with no way to go and fix it. | Fixed: plain wording and a button that opens the field to fix. |
| 6 | Send for review dialog | confuses | Does not name the remote it pushes to (docs/contribution-flow.md promises a confirmation "naming the remote and branch"). Lists both GitHub and GitLab CLI availability regardless of where the library lives, and offers to open a request even for a library on this machine, where none can be opened. | Fixed: names the remote and host; offers only what applies. |
| 7 | Contribution page after preparing | confuses | "For the reviewer" still looks editable once a branch is prepared. | Fixed: read-only summary once prepared. |
| 8 | Contribution page after sending | blocks (for iteration) | After "Branch pushed" the trail ends: no review status, no reviewer comments, and "start again to share a newer version" — which opens a second request instead of updating the first. | Fixed: Review panel (status, comments), Revise on the same branch and request. |
| 9 | Sharing status | confuses | "Review requested — A review request is open on your Git host" is stated without ever checking the host. | Fixed: says a request was opened; state is shown only as observed, with when it was checked. |
| 10 | Sample workspace | blocks (dev only) | With a relative `HABI_HOME` (as in `.claude/launch.json`), "Explore a sample workspace" fails with "local folders must be absolute paths". | Fixed: `HABI_HOME` is made absolute. |
| 11 | Sidebar at ~800 px | minor | "sample" badges are clipped and the sidebar scrolls horizontally. | Fixed: names end in an ellipsis. |
| 12 | After install | minor | The only action left is "Remove…"; nothing says how to use what was installed. | Fixed: says which agent gets it, where it was installed, and that a new session picks it up. |
| 13 | Contribution files | minor | "UNCHANGED" ran into the file path. | Fixed. |
| 14 | Contribution diff of `habi.yaml` | confuses (reviewers) | Saving the share form rewrites `habi.yaml` in a different key order and drops `scope: module`, so reviewers see a noisy diff for a one-field change. | Fixed: only changed parts are written; order, defaults and unknown keys are kept. |

## Production-readiness review (same day)

A second pass by six parallel reviewers (contributions, install pipeline, inspection and
matching, desktop UI, CLI hands-on, open-source readiness) found about 80 further issues;
the fixes are in the history under "production-readiness review". Highlights: matching on
large monorepos (one assessment took 142 s at 200 modules; now milliseconds), Windows line
endings making every install look edited, truncated patch exports, busy buttons that could
be clicked twice, check results that disappeared, and a CLI whose `--json` output was not
always JSON. Remaining known limitations are listed in `docs/recovery.md`,
`docs/detectors.md` and `docs/release.md`.

## Not verified in this pass

Opening a real pull/merge request was not exercised against GitHub or GitLab (no scratch
repository was available to this pass). The request, status and revision paths are covered by
tests that run stand-in `gh`/`glab` programs (`crates/habi-core/tests/review_flow.rs`,
`review_requests.rs`) and were walked through in the browser against a GitHub-shaped local
remote with a stand-in `gh`.
