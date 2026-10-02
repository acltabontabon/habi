# Security and privacy boundaries

Library content and repositories are **untrusted input**. The webview is treated as
untrusted too, even though it renders Habi's own UI.

## What never happens implicitly

- Discovery, matching, previewing and refreshing never execute scripts, hooks, templates or
  commands from libraries or projects.
- Habi never runs builds, package managers or Git inside a project during inspection.
- Verification checks run only after the user previews the exact program, arguments,
  folder and environment policy and clicks "Run". The preview says plainly that the command
  executes repository code and is **not sandboxed**.
- MCP servers are never launched or contacted by Habi. "Configured" means an entry exists.

## Git

Habi uses the system `git` with:
`core.hooksPath=<empty dir>`, `core.fsmonitor=false`, `protocol.ext.allow=never`,
`GIT_ALLOW_PROTOCOL=file:git:http:https:ssh`, submodule recursion off, `diff.external=`
cleared, `GIT_TERMINAL_PROMPT=0`, no askpass, and repository-redirecting environment
variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …) removed. Arguments are arrays;
URLs and refs are validated (no leading `-`, no `<transport>::` helpers, no embedded
passwords) and passed after `--`.

Library caches are **bare** repositories read with `ls-tree`/`cat-file`, so checkouts,
smudge/clean filters, `.gitattributes` conversions and hooks never run on library content.
Symlinks and submodules in libraries are skipped and reported. Contributions are committed
with plumbing (`hash-object --no-filters`, `update-index`, `commit-tree`) into a private
index; the developer's checkout is never touched.

Publishing a contribution to a library that lives on this machine does not `push` (a local
push runs the target repository's receive hooks with its own configuration). Habi instead runs
`git fetch` *inside* the target, with Habi's hook-free configuration, to create the
contribution branch; an existing branch is never overwritten.

Source URLs may not carry credentials: any user information on http(s)/git URLs is rejected
(tokens are often passed as the user name), and the portable identity written to
`.habi/lock.json` never contains user information.

A contribution revision is built on the commit Habi last pushed. Before preparing it, Habi
fetches the contribution branch; if it moved (someone else pushed), Habi stops unless the
user explicitly chooses to build on those commits. Pushes are never forced.

### Review requests on GitHub and GitLab

Habi reads and opens review requests only through the user's own `gh`/`glab` (no tokens are
stored), only when asked, and only for the library's own remote. Everything the host returns
is untrusted: comment bodies and author names are reduced to plain text (control and
bidirectional-override characters removed, lengths bounded), paths are validated as relative
repository paths, and a request URL is kept only when it is `https://` on the library's own
host. The UI renders comments as text — no Markdown, HTML or automatic links.

**Residual trust:** the user's own Git configuration is honored (credential helpers,
`url.*.insteadOf`, `core.sshCommand`, SSH config). It is user-owned, not repository-supplied,
and it is what makes authentication work without Habi handling secrets.

## File system

- All relative paths from content, lock files and IPC go through `RelPath` (no absolute
  paths, `..`, backslashes, drive prefixes, control characters).
- Writes resolve each existing path component and refuse symbolic links anywhere along the
  path (`resolve_for_write`); this is re-checked at apply time, not just at preview.
- Reads are bounded; parsers have size/depth/node limits (YAML budgets, XML without DTDs,
  bounded globs and conditions).
- Writes are atomic (temp file + fsync + rename) and journaled; see `docs/recovery.md`.
  Existing files keep their permissions; new files get 0644; skill scripts that are executable
  in the library (Git mode 100755) stay executable, and contributions preserve the bit.
- Paths may not contain a `.git` component, so library content cannot plant a nested
  repository (with its own hooks) inside a project.
- Apply verifies each file's digest before backing it up, and again immediately before
  writing it; a journal that cannot be saved rolls the operation back.
- `.habi/lock.json` is untrusted too: entries may only name files under `.agents/skills/` or
  `.claude/skills/`, sections in `AGENTS.md`/`CLAUDE.md`, and MCP entries in each client's own
  configuration file. Anything else makes Habi refuse the lock file instead of deleting files.
- Managed-section bodies may not contain Habi markers, and every write is re-parsed to confirm
  exactly one well-formed section results.
- MCP JSON files are only rewritten if the rewrite cannot change them in meaning (no
  duplicate keys, numbers that re-serialize identically); the preview notes reformatting.
- Habi only deletes files it wrote and whose content is unchanged, unless the user explicitly
  chooses otherwise for a specific file (the previous content stays in the journal).

## Local skills, discovery and import

- Discovering skills and instruction files in a project, inspecting a folder or library before
  import, saving a draft and previewing applicability never execute anything. Scripts in a
  package are stored and shown as text.
- Discovery is scoped to the opened project. Global and personal agent folders are read only
  when the user picks one in the native folder dialog; the desktop adapter refuses to inspect
  or import from a folder that was not picked in the same session.
- Folder reads do not follow symbolic links and are bounded (file count, file size, total
  size). A package with links or oversized files is reported as incomplete and is not
  imported, so content is never silently dropped.
- Package paths go through `RelPath` and `resolve_for_write`: writing a file in a draft cannot
  leave the package folder or pass through a link, and `.git` components are refused.
- Every draft save names the digest of the file it was based on; a file changed outside Habi
  produces a `conflict` instead of an overwrite. Saves take a per-skill lock shared by the
  desktop app and other Habi processes.
- Instruction files are read only if inspection recognized them as agent instructions, never
  by arbitrary path, and files with secret-like names are not read.
- Draft Markdown is previewed through the same sanitizing renderer as library content.
- Deleting a draft moves it to the trash (a flag); its files are removed only by an explicit,
  separate "Delete permanently".
- Sharing a local skill goes through the contribution pipeline unchanged: explicit file list,
  secret scan, isolated branch, explicit push.

## Desktop shell

- Tauri capability: `core:default` only. No filesystem, shell, dialog or opener permission
  is granted to the webview; folder pickers, saving and link opening run in Rust.
- Content Security Policy: `default-src 'self'`; no remote scripts, frames or form actions;
  `connect-src` limited to Tauri IPC. Fonts are bundled.
- Plans are applied **by id**; the webview never supplies file contents or target paths.
- Checks run only by a single-use **preview id** returned when the user previewed the command;
  the command is prepared again and must match what was shown (program, arguments, folder,
  item version) or nothing runs. Binding values must be discovered candidates.
- Local library folders (including `file://` URLs in any letter case) and folders to import
  skills from must come from the native picker in the same session. Export destinations and
  files added to a draft are likewise chosen in native dialogs, never named by the webview.
- `open_external` accepts only `https://` URLs.
- Skill Markdown is rendered with raw HTML skipped and `rehype-sanitize`; images are not
  loaded; links open in the system browser only after a click.

## Secrets and privacy

- No account, telemetry or cloud service. Inspection and matching are local.
- Source URLs with embedded credentials are rejected. MCP suggestions must use `${VAR}`
  references; literal values fail schema validation.
- Errors, logs and diagnostic bundles pass through `redact` (credential URLs, common token
  shapes, private keys, `key=value` secrets). Logs never include file bodies or environment
  values. Diagnostic bundles are previewed before saving and omit project paths and
  repository paths (host only).
- Contributions are scanned for high-signal secrets (private keys, cloud/API tokens) and
  blocked if any are found. Only the files shown in the preview leave the machine, and only
  on explicit export or publish.

## Independent review

Before this release an independent review of the install pipeline, Git handling,
contributions, client configuration and IPC found thirteen issues (credential-bearing URLs,
case-only renames on case-insensitive file systems, a `FILE://` picker bypass, lost executable
bits, hooks on local publish, checks runnable without a preview, apply-time races, marker
injection, partial snapshots, lock-file path confinement, per-section decisions, lossy JSON
rewrites, silent re-creation of deleted files). All were fixed, with regression tests. One
residual risk remains: a concurrent process running as the same user could race between path
validation and directory creation during apply.

## Known limitations

- Habi cannot see what an agent does with installed content and does not claim to.
- The secret scan is pattern-based; it reduces, not eliminates, the risk of sharing secrets.
- Running a check executes code with the user's privileges. There is no sandbox.
