# Client compatibility reference

**Research date:** 2026-10-02. Every fact below comes from the official documentation as fetched on
that date, and each one links to its source. These clients change often, so check the docs again
before relying on a detail that is close to an edge case.

Note: the `developers.openai.com/codex/*` URLs now redirect to `learn.chatgpt.com/docs/*`. The
pages cited below are the redirect targets (or their `.md` variants).

## 1. Shared formats

### Agent Skills (`SKILL.md`), from <https://agentskills.io/specification>

- A skill is a directory that contains at least a `SKILL.md`: YAML frontmatter followed by Markdown.
- Optional subdirectories (conventions, not requirements): `scripts/`, `references/`, `assets/`. Other files are allowed.
- Frontmatter fields:

| Field | Req. | Constraint |
|---|---|---|
| `name` | yes | 1–64 chars; `a-z`, `0-9` and `-` only; may not start or end with `-`; no `--`; **must match the parent directory name** |
| `description` | yes | 1–1024 chars, non-empty; says what the skill does and when to use it |
| `license` | no | License name, or a reference to a bundled license file |
| `compatibility` | no | Max 500 chars; environment requirements |
| `metadata` | no | Map from string to string |
| `allowed-tools` | no | Space-separated string of pre-approved tools (experimental) |

The spec recommends keeping the `SKILL.md` body under 5000 tokens.

### AGENTS.md, from <https://agents.md/>

- Plain Markdown with no required fields. Nested files are supported: "the closest AGENTS.md to the edited file wins; explicit user chat prompts override everything."
- The agents.md site lists Codex, Cursor, VS Code, Jules, Aider, Zed and others. It does **not** list Claude Code, but Claude Code's own docs now document native support (§2).

### MCP, from <https://modelcontextprotocol.io/specification/versioning>

- The current protocol version is **`2026-07-28`**. `/specification/latest` redirects there. Earlier versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05.

## 2. Per-client discovery paths

| | Claude Code | Cursor | Codex (CLI / IDE ext. / ChatGPT desktop) |
|---|---|---|---|
| Project skills | `.claude/skills/<name>/SKILL.md`, read from the start dir and every parent up to the repo root. Nested `<subdir>/.claude/skills` load on demand | `.agents/skills/`, `.cursor/skills/`, plus nested copies of either anywhere in the repo. Compat paths: `.claude/skills/`, `.codex/skills/` | `.agents/skills` in every dir from CWD up to the repo root |
| User skills | `~/.claude/skills/<name>/` | `~/.agents/skills/`, `~/.cursor/skills/`. Compat paths: `~/.claude/skills/`, `~/.codex/skills/` | `$HOME/.agents/skills`. Admin: `/etc/codex/skills` |
| Skill `name` | Optional (defaults to the dir name). `description` is recommended; `description` + `when_to_use` are truncated at 1,536 chars in the listing | Required, lowercase/digits/hyphens, **must match the folder name**; `description` is required | `name` and `description` are required |
| Instruction files | `CLAUDE.md` or `.claude/CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `~/.claude/rules/`. **AGENTS.md is read natively from v2.1.277**, but only when there is no CLAUDE.md (see §4) | `AGENTS.md` at the root and in subdirectories. `.cursor/rules/*.mdc`. User Rules live in the app settings | `~/.codex/AGENTS.override.md` or `AGENTS.md`, then each dir from the project root to CWD: `AGENTS.override.md` > `AGENTS.md` > `project_doc_fallback_filenames` |
| Project MCP file | `.mcp.json` (project root) | `.cursor/mcp.json`. User file: `~/.cursor/mcp.json` | `.codex/config.toml`, **trusted projects only**. User file: `~/.codex/config.toml` |
| MCP format | JSON `{"mcpServers": {name: {...}}}` | JSON `{"mcpServers": {name: {...}}}` | TOML `[mcp_servers.<name>]` |
| Env-var syntax | `${VAR}`, `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers` | `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}` / `${/}` in `command`, `args`, `env`, `url`, `headers`. `envFile` (stdio only) | No `${}` interpolation for MCP is documented. Instead use `env_vars = ["NAME"]` (forward), `bearer_token_env_var`, or `env_http_headers` (header→env-var map) |

Sources:
- Claude Code: <https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/memory>, <https://code.claude.com/docs/en/mcp>
- Cursor: <https://cursor.com/docs/skills>, <https://cursor.com/docs/rules>, <https://cursor.com/docs/mcp> (redirected from `/docs/context/mcp`)
- Codex: <https://learn.chatgpt.com/docs/build-skills>, <https://developers.openai.com/codex/guides/agents-md>, <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>, `config-basic`, `config-advanced` and `config-reference` under <https://learn.chatgpt.com/docs/config-file/>

### Client-specific details

**Claude Code**
- Skill frontmatter: the six spec fields are accepted. `license` and `compatibility` are accepted but have no effect. Extensions such as `when_to_use`, invocation control and subagent execution are Claude Code-only.
- Symlinked skill folders: a symlinked skill folder works. Several locations that point at the same target load once.
- Skill directories are watched for changes, so no restart is needed.
- Skill name precedence: enterprise > personal > project.
- `.mcp.json` entry with no `type`: treated as **stdio** (`command`, `args`, `env`).
- Remote `.mcp.json` entries need a `type`: `"http"` (`"streamable-http"` is an alias), `"sse"` or `"ws"`, together with `url` and optionally `headers`.
- If `${VAR}` is unset and has no default, the config still loads with the literal text and Claude Code shows a warning.
- Credential variables such as `ANTHROPIC_AUTH_TOKEN` expand to empty in a remote `url` or `headers`.
- Project `.mcp.json` servers need **interactive approval** and show as `⏸ Pending approval` until approved.
- An approval committed in the repo's `.claude/settings.json` (`enableAllProjectMcpServers` / `enabledMcpjsonServers`) is ignored until the workspace trust dialog has been accepted.
- To clear MCP approvals: `claude mcp reset-project-choices`.

**Cursor**
- Rules must be `.mdc` files in `.cursor/rules/`. **A plain `.md` file there is ignored.**
- Rule frontmatter: `description`, `globs` (comma-separated), `alwaysApply`.
- Rule precedence: Team Rules → Project Rules → User Rules.
- Nested AGENTS.md files combine with their parents, and the more specific one wins.
- Optional skill fields: `paths`, `disable-model-invocation`, `icon`, `color`, `metadata`.
- Nested `.cursor/skills` and `.agents/skills` directories are automatically scoped to their subtree.
- STDIO MCP fields: `type` (documented as required: `"stdio"`), `command`, `args`, `env`, `envFile`.
- Remote MCP examples use `url` and `headers` with no `type`.
- MCP tools ask for approval by default.

**Codex**
- Combined AGENTS.md content is capped by `project_doc_max_bytes`, default **32 KiB**. Empty files are skipped.
- At most one instruction file per directory. Files are concatenated root→CWD, so later files win.
- Skills that share a `name` are not merged; both can appear.
- Symlinked skill folders are followed.
- Disable a skill with `[[skills.config]] path=…, enabled=false` in `~/.codex/config.toml`.
- Optional `agents/openai.yaml` in a skill holds UI and policy metadata.
- Stdio MCP keys: `command` (required), `args`, `env`, `env_vars`, `cwd`, `experimental_environment`.
- HTTP MCP keys: `url` (required), `auth`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`.
- Common MCP keys: `enabled`, `required`, `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60), `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.approval_mode`.
- Project `.codex/config.toml` files load from the project root down to CWD (closest wins), and **only when the project is trusted**. The user sets this with `projects.<path>.trust_level = "trusted" | "untrusted"` in `~/.codex/config.toml`.
- Untrusted projects skip every project `.codex/` layer (config, hooks, rules).
- Project config may not set `model_provider(s)`, `openai_base_url`, `chatgpt_base_url`, `notify`, `profile(s)`, `otel` and similar keys. They are ignored with a warning.

## 3. What Habi writes per client (recommendation)

**Skills: install one canonical copy, with as few mirrors as possible.**
- `.agents/skills/<name>/` is read by **both Codex and Cursor**. It is the canonical location.
- `.claude/skills/<name>/` is needed only for **Claude Code**. Cursor also reads it.
- By selected clients:

| Selected clients | Write |
|---|---|
| Codex and/or Cursor only | `.agents/skills/<name>/` |
| Claude Code only | `.claude/skills/<name>/` |
| Claude Code + Cursor only | `.claude/skills/<name>/` (Cursor reads it) |
| Claude Code + Codex (± Cursor) | `.agents/skills/<name>/`, plus `.claude/skills/<name>` as a **symlink** to `../../.agents/skills/<name>` (documented for Claude Code). Fall back to a copy if symlinks are unavailable (e.g. Windows without dev mode) |

- Directory name must equal `name`. Enforce the strictest common rules: spec charset, ≤64 chars, `description` ≤1024 chars, required in all three clients.
- Write only the six spec frontmatter fields, so skills stay portable.
- Caveat: with all three clients selected, Cursor sees the same skill through both `.agents/skills` and `.claude/skills`. How Cursor handles duplicates is **not documented**; check it with the smoke test.

**Instructions**
- Write or merge `AGENTS.md` at the project root. Codex and Cursor read it natively. Keep it under 32 KiB in total for Codex.
- For Claude Code, make sure a root `CLAUDE.md` contains the line `@AGENTS.md`. Create the file if it is missing; if it exists, add the line once (idempotently).
  - This works on versions older than 2.1.277 and when a CLAUDE.md already exists, which would otherwise suppress native AGENTS.md loading.
  - The docs say the import never causes AGENTS.md to be read twice.
- Do not write Cursor `.mdc` rules unless the user needs per-glob scoping.

**MCP: each client needs its own file, because the env syntax differs.**
- Claude Code → `.mcp.json`.
  - stdio: `{command, args, env}` (no `type`, or `"type": "stdio"`).
  - remote: `{"type": "http", url, headers}`.
  - Secrets: `${VAR}`.
- Cursor → `.cursor/mcp.json`.
  - stdio: `{"type": "stdio", command, args, env}`.
  - remote: `{url, headers}`.
  - Secrets: `${env:VAR}`.
- Codex → `.codex/config.toml` `[mcp_servers.<name>]`.
  - Secrets: `env_vars = ["VAR"]` / `bearer_token_env_var` / `env_http_headers`. Never inline values.
  - Tell the user the project must be **trusted** in Codex. The alternative is a user-level `~/.codex/config.toml` entry.
- Merge into existing files by server name. Never clobber unrelated servers or keys.

## 4. Precedence caveats

- **Claude Code AGENTS.md suppression.** By default (`claude-md-or-agents-md`), any `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in CWD or above stops AGENTS.md from loading.
  - `~/.claude/CLAUDE.md` and `.claude/rules/` do not count toward this check.
  - Claude Code never reads `AGENTS.override.md`, `AGENTS.local.md`, or anything under `.agents/`.
  - The `@AGENTS.md` import avoids all of this.
- **Codex override files.** An `AGENTS.override.md` (global or per directory) replaces the `AGENTS.md` in that directory. Habi should warn when one exists.
- **Truncation.** Codex stops adding instruction files once 32 KiB is reached (configurable).
- **Skill name collisions.**
  - Claude Code: enterprise > personal > project.
  - Codex: no merge; both skills appear.
  - Cursor: undocumented.
- **Codex trust.** Project MCP config does nothing silently in untrusted projects.
- **Claude Code approval.** `.mcp.json` servers stay pending until the user approves them interactively.
- **Cursor rule files.** `.md` files in `.cursor/rules` are ignored; only `.mdc` counts.

## 5. Unverified / could not fetch

- How Cursor behaves when the same skill `name` is found in two directories (e.g. `.agents/skills` and `.claude/skills`). Not documented.
- Whether Cursor accepts `"type": "http"` on remote `mcp.json` entries. The docs only show `url` without `type`.
- Whether Cursor reads `CLAUDE.md`. The rules page does not mention it, so don't rely on it.
- Codex: no length limits for skill `name` and `description` are stated (it defers to the agentskills.io standard). No `${VAR}` interpolation for MCP is documented.
- The Codex skills page does not document `~/.codex/skills` or `.codex/skills` as Codex discovery paths. Only Cursor's docs mention them, as compat paths.
- All pages were fetched successfully. Nothing was inferred from memory.

## 6. Smoke-test procedure (does the client actually discover it?)

These are **discovery tests**. They are separate from **file-format tests** (schema or frontmatter
validation, JSON/TOML parsing, name/dir-match checks, which Habi runs offline in CI). For each
client, install a fixture skill `habi-smoke-test` whose description is "Use when the user says
'habi ping'. Reply with HABI-PONG", plus a one-line AGENTS.md marker and a no-op MCP server. Then:

**Claude Code** (v2.1.277+ recommended)
1. Start `claude` in the project root and accept the workspace trust dialog.
2. Run `/skills`. `habi-smoke-test` should be listed under the project scope. Also try typing `/habi-smoke-test`.
3. Type "habi ping". The reply should be HABI-PONG, which shows the model can invoke the skill.
4. Run `/context` and check **Memory files** for `CLAUDE.md` and the imported `AGENTS.md`.
5. Run `claude mcp list`. The server shows `⏸ Pending approval` until it is approved. Approve it in the session, then confirm in `/mcp` that it is connected.

**Cursor**
1. Open the folder and open **Customize → Skills**. `habi-smoke-test` should appear, under *Agent Decides*.
2. In Agent chat, type "habi ping" and expect HABI-PONG. Also try `/habi-smoke-test`.
3. In **Customize → Rules**, check that AGENTS.md is in effect: ask the agent to quote the marker line.
4. Check that the server appears in Customize (MCP) and is enabled, and that tools prompt for approval on first use.

**Codex**
1. Mark the project as trusted (needed for `.codex/config.toml`). Run `codex` from the repo root.
2. Run `/skills` (or type `$`). `habi-smoke-test` should be listed. Type "habi ping" and expect HABI-PONG.
3. Run `codex --ask-for-approval never "Summarize the current instructions."` The output should quote the AGENTS.md marker.
4. Run `/mcp` in the TUI, or `codex mcp list`. The project server should be listed.
5. Mark the project untrusted and repeat step 4. The server should now be absent, which confirms the trust gating.

## 7. Tauri (Habi's own desktop shell)

Versions checked on 2026-10-02 via `npm view` and the crates.io API (stable tags; 3.0.0-alpha builds are on `next`):

| Package | Version |
|---|---|
| `tauri` | 2.12.1 |
| `tauri-build` | 2.7.1 |
| `@tauri-apps/cli` | 2.12.1 |
| `@tauri-apps/api` | 2.12.1 |
| `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` | 2.8.1 |

- **Capabilities** (<https://v2.tauri.app/security/capabilities/>)
  - JSON (or TOML) files in `src-tauri/capabilities/`. "All capabilities inside the capabilities directory are automatically enabled by default."
  - Shape: `{"$schema": "../gen/schemas/desktop-schema.json", "identifier": "...", "windows": ["main"], "permissions": [...]}`, with optional `platforms`.
  - Capabilities can also be inlined in `tauri.conf.json` under `app.security.capabilities`.
- **Core permissions** (<https://v2.tauri.app/reference/acl/core-permissions/>): `core:default` expands to the app, event, image, menu, path, resources, tray, webview and window defaults.
- **Dialog plugin** (<https://v2.tauri.app/plugin/dialog/>)
  - Install with `tauri add dialog` (or `cargo add tauri-plugin-dialog`), then register `tauri_plugin_dialog::init()`.
  - `dialog:default` grants `allow-message`, `allow-save`, `allow-open`.
  - Fine-grained permissions: `dialog:allow-open`, `dialog:allow-save`, `dialog:allow-message`, `dialog:allow-confirm`. `dialog:allow-ask` is deprecated and is an alias of `allow-message`.
- **CSP** (<https://v2.tauri.app/security/csp/>, <https://v2.tauri.app/reference/config/>)
  - Set in `tauri.conf.json` under `app.security.csp`, as a string or an object of directives. The default is `null`.
  - The docs say CSP protection "is only enabled if set on the Tauri configuration file".
  - Avoid remote/CDN scripts.

## 8. Implementation decisions in Habi 0.1 (differences from §3)

- **Copies, not symlinks.** When both `.agents/skills` and `.claude/skills` are needed
  (Claude Code + Codex), Habi writes two ordinary copies. Habi refuses to write through or
  create symbolic links (see `docs/project/security-model.md`), symlinks are unreliable on Windows, and a
  copy keeps each client's files independently editable. The lock file tracks both copies;
  drift in either is detected separately. If the project already links one skills folder
  to the other, Habi writes a single copy instead (see *Symbolic links in the project*).
- **Skill files are copied verbatim.** Habi does not rewrite SKILL.md frontmatter, so
  third-party fields, licensing and unknown keys are preserved exactly. The optional
  `habi.yaml` sidecar is copied too; clients ignore unknown files in a skill folder.
- **Duplicate discovery in Cursor** (all three clients selected) is reported in the install
  preview as a note, because Cursor's behaviour is not documented.
- **Cursor `.mdc` rules are not written** in this release. Portable instructions go to
  `AGENTS.md` only.
- **MCP:** Habi adds a server entry only when the item declares a suggested definition, the
  user enables "Add suggested MCP configuration", and the client's project file lacks an
  entry with that name. Codex project config is noted as requiring a trusted project.
  - Several installed items can need the same server. Habi adds it once and records it for
    each of them; it is removed only when no installed item needs it any more.
  - An update replaces an entry Habi wrote with the library's new definition, in place. An
    entry someone edited is left alone and the preview says so.
  - A configuration file Habi created is deleted when its last server is removed. A file
    that existed before is kept, even if empty.
  - A UTF-8 byte order mark and CRLF line endings in an MCP file are kept when Habi
    rewrites it. JSON files are rewritten with standard formatting, and the preview notes it.
- **Line endings.** Habi writes library content as it is (normally LF). A checkout with
  `core.autocrlf=true` turns those files into CRLF; Habi compares installed files and
  sections without regard to line endings, so that is not a local edit. A section added to a
  CRLF `AGENTS.md` or `CLAUDE.md` uses CRLF too.
- **AGENTS.md size.** Habi appends its sections at the end of `AGENTS.md`. When the file
  would be larger than Codex's default 32 KiB limit, the preview says so: Codex ignores
  what comes after the limit, so Habi's sections are the first to be cut.
- **Instructions ids.** A section's marker is the item id. Two sources that ship
  instructions with the same id cannot both be installed in one project; the second is
  reported as a collision that names both sources.

### Symbolic links in the project

Habi never writes through a symbolic link, and refuses any link that leads outside the
project (or into `.git`). Links that stay inside the project are common layouts, and Habi
recognizes them:

| Layout | What Habi does |
|---|---|
| `CLAUDE.md -> AGENTS.md` | Claude Code already reads the instructions through the link, so Habi adds no `@AGENTS.md` import. Sections are written to `AGENTS.md`. |
| `CLAUDE.md` -> another file in the project | A *symbolic link* conflict: add `@AGENTS.md` to the link's target yourself (or replace the link with a regular file) and preview again, or keep it as it is (Claude Code then does not read `AGENTS.md` through it). |
| `.claude/skills -> ../.agents/skills` (or a link per skill folder, as in §3) | One copy, written in the real folder (`.agents/skills/<name>`) and recorded for the clients both folders serve. Copies Habi wrote under `.claude/skills` before the link existed are no longer tracked and are never deleted through the link. The same applies in the other direction. |
| A skills folder linked anywhere else in the project | A *symbolic link* conflict: point the link at `.agents/skills` (or `.claude/skills`), or replace it with a regular folder, then preview again. |
| Any other file reached through a link | The preview stops and names the link and its target; replace the link with a regular file or folder. |

## 9. What is verified, and what is not

| Claim | How it is checked |
|---|---|
| Files are written to the documented paths and formats | Automated tests (`crates/habi-core/tests/install_lifecycle.rs`, `clients::mcp` unit tests) |
| Existing JSON/TOML keys and formatting are preserved | Unit tests with representative files |
| A client actually discovers and loads the skill | **Not automated.** Use the smoke tests in §6 with an installed client |
| An agent follows the instructions | Not claimed by Habi |

As of 2026-10-02 the smoke tests have **not** been run against installed copies of Claude
Code, Cursor or Codex as part of this release; treat client discovery as unverified until
they are.
