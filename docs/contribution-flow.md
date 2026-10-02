# Contributing back to a team library

Three different actions, never mixed:

1. **Refresh source** — discover new approved content (fetch only).
2. **Adopt update** — apply a reviewed change to a project, through a preview.
3. **Contribute** — prepare a change for a maintainer's review.

## Steps

1. **Choose explicitly.** A skill from My skills (*Share with team…* in the editor), a skill
   folder in one of your projects (for example the installed copy you improved), or an
   existing library item whose metadata you want to improve. Habi copies only that folder into a private staging area in its data directory.
   Nothing else is collected — no conversations, no other files; files the operating system
   leaves in folders (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are skipped. The contribution
   names its staging folder (`stagingPath`): a library-item contribution's files are edited
   there. If a skill you share under a new name matches a library skill it was not copied
   from, the preview warns that the contribution replaces that skill's files.
2. **Describe it.** A form covers title, owner, where it applies (tags, dependencies, file
   patterns, all/any), exclusions, prerequisite commands, examples and repository scope. Tags
   detected in your project are offered as suggestions; you decide. The form writes
   `habi.yaml` (or the skill's existing `habi.yml`). Only the parts you changed are written:
   saving an unchanged form leaves the file byte for byte as it was, and a change keeps key
   order, unknown keys, explicit defaults such as `scope: module`, the exclusion mode
   (`all`/`any`) and fields the form does not show (a tool's `purpose` and `install_hint`, an
   example's `path`). Comments other than the file's leading ones are lost when it is
   rewritten. Conditions richer than the form can express are kept unchanged.
3. **Review.** The whole package against the library: each file is *added*, *modified*,
   *renamed* (a removed and an added path with identical content), *removed* or *unchanged*.
   Changed files come first, beside the selected file's diff; unchanged files are one
   collapsed group. Any changed file can be **left out** (kept per contribution): it keeps
   the library's version, so a left-out addition is not added and a left-out removal stays.
   A new skill cannot leave out its SKILL.md. Validation covers exactly what would be sent:
   package format, Habi metadata, file references and a secret scan. A Markdown file that
   links to or names (in inline code, like `scripts/check.sh`) a package file the
   contribution leaves out, deletes or renames is an error naming both files. Errors block
   preparing a branch; warnings do not. Passing validation does not test what the skill
   does.
4. **Commit for review.** Habi commits only the included files on
   `habi/contrib/<name>-<id>` inside its own bare cache of the library, based on the snapshot
   you have. Your checkouts and branches are not touched; no hooks or filters run. Preparing
   again returns the same commit on the same branch.
5. **Share it:**
   - **Export patch** — a `git format-patch` file with every commit of the contribution since
     the library snapshot it started from (all revisions), so it applies to the tracked
     branch with `git am`. Large patches are written whole, never cut.
   - **Send** — the button names what happens: *Create pull request* (GitHub, `gh`
     installed), *Create merge request* (GitLab, `glab` installed), otherwise *Push branch*
     (and *Export patch…*). The confirmation shows the library, repository, host, target
     branch, contribution branch and visibility — "unknown" until the host reported it (Habi
     does not ask the network just to show the page). After an explicit confirmation
     Habi pushes the branch with your Git credentials. (For a library repository on this
     machine, Habi creates the branch there with a hook-free `git fetch` instead of a push.) If `gh` (GitHub) or `glab` (GitLab)
     is installed and authenticated, it can also open a pull/merge request against the
     tracked branch. Otherwise Habi says so and leaves the request to you.

Habi never merges, never pushes to the tracked branch, never overwrites commits on the
contribution branch, and never reports a remote success it did not observe. Pending
contributions are listed separately from approved library content.

## After sending: review, comments and revisions

6. **Check status** (only when you ask). Habi reads the request for the contribution branch
   through `gh api` (GitHub) or `glab api` (GitLab): open, draft, changes requested, approved,
   merged or closed; who approved; and the comments. The page says when it last checked.
   Nothing polls in the background, and a request opened by hand on the host is found too
   (by its source branch). Comments are read page by page up to 200 (all reviews are read to
   decide the state); beyond that the page says more exist on the host. `gh`/`glab` run in an
   empty folder in Habi's data directory, never in whatever repository Habi was started from.
   - Comments are written by other people and treated as untrusted: shown as plain text only
     (no Markdown, no HTML, no links followed), with control and bidirectional-override
     characters removed and lengths bounded. Comments on a line appear next to that file's
     diff. Replying, resolving and merging stay on the host.
   - "Approved" means a reviewer approved; merging is still up to the maintainers and the
     host's rules.
7. **Revise.** Reopens the contribution. If it was sent, Habi first checks the request on the
   host (when `gh`/`glab` can reach it): a merged or closed request cannot be revised. If the
   host cannot be asked, revising is allowed and the page says the request was not checked.
   Only a version that was sent counts: revising it makes revision *n* ("Revision *n* after
   review." in the commit message); reopening a prepared-but-unsent version does not.
   Skills from My skills or from a project are copied again from where they live, and again
   when you **Prepare**, so edits made there after "Revise" are included (form changes made in
   Habi since are reapplied). A library-item contribution reopens its form and staging
   folder. **Prepare** adds a commit on top of the one you sent, on the same branch; a
   revision that changes nothing is refused ("Nothing changed since the version you sent").
   **Cancel revision** returns to the version you had before "Revise" (same commit, state,
   title, message, form and staged files). **Send** pushes it; when the host showed the
   request open just before, the request shows the new commit and no second request is
   opened. When Habi could not check, it says the branch was pushed and that the request, if
   still open, shows it — never that it updated the request.
   - If someone else pushed to the branch since (for example a reviewer's suggestion), Habi
     stops and changes nothing. You can choose **Build on their commits**: their commits stay in
     the history, and the skill folder then holds exactly the files you staged.
   - Once the request is merged or closed, revising (and sending again) is refused; share
     again as a new contribution.
   - Before preparing a revision Habi fetches the contribution branch. Only a branch that no
     longer exists ("couldn't find remote ref", for example merged and deleted) lets the
     revision recreate it; network, sign-in and other failures stop with the error, because
     Habi cannot tell whether someone else pushed.
8. **Where it applies (optional).** In *For the reviewer*, **Add where it applies…** evaluates
   the staged rules against the projects you opened in Habi (sample projects are not counted)
   with the same matcher recommendations use, and appends a short summary to the message:
   which projects it applies to or needs information in, by **name only** (never paths), and
   how many it does not apply to. It is ordinary message text — edit or remove it before
   saving — and it leaves the machine only with the branch, like the rest of the message.

### Hosts

| | GitHub | GitLab |
|---|---|---|
| Open a request | `gh pr create --repo host/owner/repo` | `glab mr create --repo https://host/group/…/repo` (full URL, so nested groups work) |
| Status and comments | `gh api` REST: pulls, reviews, issue and review comments | `glab api` REST: merge requests, approvals, discussions |
| "Changes requested" | From each reviewer's latest review | Not reported (GitLab has no equivalent in the REST API Habi uses); approvals are |
| Self-hosted | Recognized when `gh auth status --hostname` succeeds | Recognized when `glab auth status --hostname` succeeds |

`github.com` and host names containing `github`/`gitlab` are recognized by name; other hosts
by whichever tool is signed in to them. The GitHub path is exercised end to end in
`tests/review_flow.rs` (real Git, stand-in `gh`); GitLab through stand-in `glab` in
`tests/review_requests.rs`. Neither has been run against a live host in this release.

A failed prepare or send is remembered ("Needs attention", with the message) until the
next attempt succeeds. Retrying is safe: the branch name is fixed per contribution, a push
never overwrites commits, and a request is opened only when the host does not already show
one for the branch.

## Sharing activity

One row per contribution with one state — *Draft*, *Ready to submit* (branch prepared, not
pushed), *Branch pushed* (no request), *Open PR/MR*, *Changes requested*, *Merged*, *Closed*,
*In the library* or *Needs attention* — "checked … ago" for states the host reported, the
destination (library and branch), the last update, and one next action: *Continue editing*,
*Review changes*, *Retry* or *Open PR/MR*.

## What the status means

| Status | What happened |
|---|---|
| Not prepared yet | A staged copy exists on this machine. Nothing else. |
| Prepared locally | A commit exists on a contribution branch in Habi's own cache. Nothing was sent. |
| Patch exported | A patch file was written where you chose. Sending it is up to you. |
| Discarded | The staged files and the local branch are removed. It can no longer be prepared, exported, sent or checked. |
| Branch pushed — no review request | The branch is on the remote; no pull/merge request was opened (the reason is shown). |
| Review requested | `gh`/`glab` opened a request and returned its URL. |
| In the library | After a refresh, the library's tracked ref contains exactly the contributed files. |

A contribution from My skills is a snapshot of the skill when sharing started. With no Git
library connected, the skill can be exported as a plain folder instead; the draft is kept
either way.

Git hosts — not Habi — decide who may push, whether branches are protected and who must
review. The configured source and ref are the team's chosen baseline; Habi does not label
every commit "approved". An `owner` field is attribution only.

## Requirements

- The library must be a Git source (remote or local clone). Folder sources cannot receive
  contributions (export the skill as a folder instead).
- Git must know your name and email (`git config --global user.name/user.email`).

## CLI

```sh
habi contribute start "Team" .claude/skills/my-skill -C path/to/project
habi contribute describe <id> --title "Liquibase review: concurrent indexes" --message "…"
habi contribute show <id>
habi contribute exclude <id> notes.md       # leave a changed file out (include puts it back)
habi contribute commit <id>
habi contribute export <id> ~/Desktop
habi contribute publish <id> --open-request
habi contribute status <id>                 # state and comments from the host
habi contribute revise <id>                 # then commit + publish again
habi contribute commit <id> --build-on-remote   # only if someone else pushed to the branch
habi contribute rehearse <id>               # where its rules apply, as text for reviewers
```
