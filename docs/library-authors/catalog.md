# The library catalog

Habi suggests a short list of public skill libraries. The list is data, in
`crates/habi-core/catalog/sources.yaml`, embedded in the app and validated when it loads
(`cargo test -p habi-core catalog`). Nothing is fetched until a person opens a preview.

Skill counts, licences, groups and dates are never written in the registry. They are read from
the repository.

```yaml
- id: openai                       # lower-case letters, digits, hyphens; used in routes
  name: OpenAI
  url: https://github.com/openai/plugins     # public https repository
  summary: "One line on what it is."
  publisher: { name: OpenAI, kind: builder, owner: openai, domain: openai.com }
  ownership: { method: github-verified-org, checked: "2026-10-03" }
  discovery:
    include: ["plugins/*/skills/**"]         # globs: * stays in a folder, ** crosses folders
    exclude: ["plugins/plugin-eval/fixtures/**"]
    group: 1                                 # path segment whose folders group the skills
    track: latest-release                    # read the newest release tag (default: the default branch)
  notes: ["Replaces openai/skills, which OpenAI has deprecated."]
  hints:
    - path: "skills/wrangler"
      applies_when: { file: "**/wrangler.{toml,json,jsonc}" }
```

- `kind: builder` needs `ownership` evidence and the repository's owner must equal
  `publisher.owner`. `github-verified-org` means GitHub verifies the organisation;
  `org-site-matches-domain` means it does not, but its website is `publisher.domain`.
  `kind: community` has no ownership claim.
- `discovery` is applied before Habi's size limits, so a large repository only needs to be
  small where its skills are. A top-level licence file is always read.
- `track: latest-release` reads the newest tag that is a plain version number (`v1.4.0`, `0.6.11`)
  and falls back to the default branch while the repository has none. Pre-releases
  (`-rc1`), dates and tags named by commit hash are not releases. Use it only for a repository
  whose tags are versions; most are not, and stay on the default branch. Either way a library
  moves to a newer version only when the user presses Update.
- `review` records that Habi inspected a library at a commit (`revision`, `date`, `by`,
  `scope`). It is absent for every entry, because being official or popular is not a review.
- `hints` give a rule, in the `habi.yaml` condition language, for skills whose authors declared
  none. They are shown as Habi's judgement and never override an author's rules.
- `status: { state: deprecated | archived, note, successor }` marks a repository that has been
  superseded. Habi cannot detect this from Git alone.
