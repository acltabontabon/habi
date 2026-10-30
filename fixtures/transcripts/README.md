# Synthetic Claude Code transcripts

Written by hand in the shape of real ones (see
[compatibility research](../../docs/dev/compatibility-research.md#9-what-agents-record-about-skill-use));
no real session is copied here. `crates/habi-core/tests/skill_usage.rs` copies them under a
temporary home folder, filling in `{{project}}`, `{{lookalike}}`, and `{{days_ago:N}}`.

| Folder | Goes to | What it exercises |
|---|---|---|
| `project/` | the project's own transcript folder | A listing, Skill calls, a typed slash command, a failed call, and what must not count: a mention of the tag, a plugin's skill of the same name, another tool, an old call, a truncated line. A subagent's calls and a resumed session repeating records. |
| `worktree/` | `<folder>--claude-worktrees-feature` | A session in a worktree under the project. |
| `sibling/` | `<folder>-two` | A folder that starts alike, for a project next to this one. |
| `lookalike/` | the project's own transcript folder | A session from another folder that encodes to the same name. |
