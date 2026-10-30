# Library catalog

Habi suggests public libraries on the Libraries page.

**To propose your library:** Open a PR adding an entry to `crates/habi-core/catalog/sources.yaml`.
(Embedded in app, validated on load via `cargo test -p habi-core catalog`.)

**What's dynamic:** Skill counts, licenses, groups, dates read fresh from the repo (never cached
in the registry). Nothing is fetched until preview.

## Entry template

```yaml
- id: openai                                # lowercase, digits, hyphens (used in routes)
  name: OpenAI
  url: https://github.com/openai/plugins    # public HTTPS repo
  summary: "One-line description."
  publisher: { name: OpenAI, kind: builder, owner: openai, domain: openai.com }
  ownership: { method: github-verified-org, checked: "2026-10-03" }
  discovery:
    include: ["plugins/*/skills/**"]         # globs: * = within folder, ** = across
    exclude: ["plugins/plugin-eval/fixtures/**"]
    group: 1                                 # segment for grouping skills
    track: latest-release                    # default: the default branch
  notes: ["Deprecation notice, etc."]
  hints:
    - path: "skills/wrangler"
      applies_when: { file: "**/wrangler.{toml,json,jsonc}" }
  picks:
    - skill: skills/wrangler                 # one skill folder, exact
      name: wrangler                         # optional: the SKILL.md name, when it is not the folder's
      title: Wrangler
      gist: "Configure, run and deploy Workers with Wrangler."   # Habi's words, 100 characters at most
      why: "Projects with a Wrangler config"                    # 60 characters at most
      tokens: 74                             # measured: its name and description, about 4 characters each
      scripts: true                          # measured: it comes with code an agent could run (omit if not)
      caution: "Contains a compiled program" # measured: what Habi's scan flags as caution (omit if nothing)
      applies_when: { file: "**/wrangler.{toml,json,jsonc}" }  # omit for a practice that fits any codebase
  status: { state: deprecated, successor: "org/new-lib" }
```

## Fields explained

| Field | Rules |
|-------|-------|
| `id` | Lowercase, digits, hyphens; used in routes |
| `publisher.kind` | `builder` (needs `ownership` proof, org owner match) or `community` (no ownership claim) |
| `ownership.method` | `github-verified-org` (GitHub verifies) or `org-site-matches-domain` (website = domain) |
| `discovery` | Applied before size limits (large repos only need to be small *where skills are*). Top-level license always read. |
| `track: latest-release` | Reads newest semantic version tag (`v1.4.0`, `0.6.11`); skips pre-releases, dates, commit hashes. Falls back to default branch. Users choose when to update. |
| `review` | Absent for all entries (official/popular ≠ reviewed). Records inspection only if present. |
| `hints` | Author-declared skills use them as default. Habi's judgment; never override author rules. |
| `picks` | Skills Habi stands behind, offered in a project's **Suggested** list before the library is connected, so the catalog carries the title and gist. A pick's `applies_when` is also its rule once connected (taking precedence over `hints`); without one it is a practice for any codebase. Keep them few: at most five per library, and verify each folder at the revision Habi reads. |
| `status` | Marks `deprecated` or `archived`; includes `successor`. Habi can't auto-detect. |

## Catalog check

Upstream repositories rename and move skills, and Habi would go on offering a pick it can't
install. So once a week, `.github/workflows/catalog-check.yml` runs `scripts/check-catalog.mjs`
against GitHub. For each entry it finds the revision Habi reads (the default branch, or the newest
version tag for `track: latest-release`) and checks that, at that revision:

- each `picks[].skill` folder holds a skill Habi would find, with a `SKILL.md` whose `name` is
  `picks[].name`, or the folder's name when the pick has none;
- each pick's `tokens` is within 25% of what its `SKILL.md` measures now: the characters in `name`
  and `description`, divided by 4 and rounded up. Small edits upstream aren't worth an issue;
- each pick's `scripts` is true exactly when the skill has an executable file or a code file;
- each `hints[].path` matches at least one skill folder, and so does every alternative of a
  `{a,b}` pattern, so one renamed skill isn't hidden by the others;
- each `discovery.include` pattern matches at least one skill;
- the repository is still at the address in `url`.

A pick's `caution` is not checked. It comes from Habi's own scan of the skill's files, which this
script can't repeat, so re-measure it in the app when you update a pick.

A failure opens one issue titled "Catalog check failed", or updates the one already open, with the
report. Close it once the catalog is fixed.

To run it yourself, or after changing an entry (without a token, GitHub allows about one run an
hour):

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/check-catalog.mjs
```

The report marks each library `ok`, `FAILED` or `UNCHECKED`:

- **`FAILED`** means the catalog is out of date. Look at the repository, then correct the path, set
  or remove `name`, update `tokens` or `scripts`, or remove the pick; a pick whose folder moved is
  reported with where a skill of that name now is. Update the `Picks checked at` comment above the
  entry as you do.
- **`UNCHECKED`** means something got in the way, such as a rate limit or GitHub being down, and
  says nothing about the catalog. Run it again.

The check needs the network, so it isn't part of `scripts/check.sh` or CI; only its tests are.
