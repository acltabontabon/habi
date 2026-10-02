# Reuse assessment

## Adopted

| Need | Choice | License | Why |
|---|---|---|---|
| Desktop shell | Tauri 2.12 (+ dialog, opener plugins) | Apache-2.0 OR MIT | Small, native webview, capability-based permissions, Rust backend. |
| UI | React 19, Vite 8, TypeScript 7 (strict) | MIT / Apache-2.0 | Requested stack; mature tooling. |
| Accessible primitives | Radix Dialog, cmdk | MIT | Focus management and keyboard behavior done right; visually unstyled, so Habi's design is its own. |
| Data fetching | TanStack Query | MIT | Loading/error/caching states without hand-rolled stores. |
| Markdown | react-markdown, remark-gfm, rehype-sanitize | MIT | Renders skills without raw HTML; sanitization on top. |
| Fonts | IBM Plex Sans, IBM Plex Mono via Fontsource | OFL-1.1 | Bundled, no runtime CDN. |
| SQLite | rusqlite (bundled SQLite) | MIT | Simple, synchronous, WAL for concurrent desktop + CLI. |
| YAML | serde-saphyr | MIT OR Apache-2.0 | Pure Rust, maintained, explicit resource budgets (anti-YAML-bomb). `serde_yaml` is archived. |
| JSON Schema | jsonschema (no default features) | MIT | Draft 2020-12, offline (no remote `$ref` fetching). |
| XML | roxmltree | MIT OR Apache-2.0 | Read-only, rejects DTDs, node limits. |
| TOML | toml, toml_edit | MIT OR Apache-2.0 | `toml_edit` preserves formatting when adding Codex MCP entries. |
| Ignore rules / globs | ignore, globset | Unlicense OR MIT | ripgrep's battle-tested `.gitignore` semantics. |
| Diffs | similar | Apache-2.0 | Line diffs for previews. |
| Versions | semver | MIT OR Apache-2.0 | Constraint syntax for conditions. |
| TS contracts | ts-rs | MIT | Generates TypeScript from Rust types; CI detects drift. |
| File watching | notify-debouncer-mini | MIT OR Apache-2.0 | Debounced cross-platform watching. |
| Logging | tracing, tracing-appender | MIT | Structured logs with rotation. |
| Git | the user's `git` binary | — | Reuses credential helpers and SSH agents; Habi never handles passwords. libgit2 would need its own credential plumbing. |
| PR creation | `gh` / `glab` if installed | — | Uses the user's existing host authentication. |

Transitive dependencies are mostly MIT/Apache-2.0; a few are MPL-2.0 (file-level copyleft,
compatible with distribution; their sources are already public), BSD, ISC, Zlib and
Unicode-3.0. A generated third-party notice file is a release blocker (`docs/dev/release.md`).

## Built here, and why

- **Inspection detectors.** Existing tools either execute builds (Maven/Gradle dependency
  plugins, `npm ls`) — not acceptable for passive inspection — or do not report *what they
  could not see*. Habi's value depends on honest coverage (partial, unresolved, inherited).
- **Three-valued matching with explanations.** No general rule engine offers unknown-aware
  evaluation with evidence trees and no scripting; the language is intentionally tiny.
- **Plan/apply with journal.** Installing into someone's repository needs previews,
  precondition digests, three-way updates, managed sections and crash recovery. Generic
  package managers overwrite or refuse; none track Markdown sections or MCP entries.
- **Client layouts.** Small, documented mapping tables; no library covers Claude Code,
  Cursor and Codex discovery rules.

## Existing skill managers

Skill installers and catalogs (CLI "add a skill" tools, marketplace plugins, editor
extensions) focus on fetching named skills. Habi deliberately interoperates instead of
competing:

- It installs to the same standard directories, so skills installed by other tools are
  recognized as *existing copies* (shown as "not managed by Habi") and never overwritten
  without an explicit decision.
- It reads any plain `SKILL.md` library, so content authored for other tools works without
  conversion.
- It does not copy marketplace UI patterns (stars, download counts, trending) because they
  are not evidence that a skill fits a repository.

No third-party code has been copied into this repository; there are no vendored sources to
attribute beyond package dependencies.
