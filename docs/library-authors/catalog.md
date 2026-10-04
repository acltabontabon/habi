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
| `status` | Marks `deprecated` or `archived`; includes `successor`. Habi can't auto-detect. |
