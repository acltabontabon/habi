# Security model

Library content and repositories are **untrusted input**. The webview is treated as
untrusted too, even though it renders Habi's own UI.

## What never happens implicitly

- Discovery, matching, previewing and refreshing never execute scripts, hooks, templates or
  commands from libraries or projects.
- Habi never runs builds, package managers or Git inside a project during inspection.
- Verification checks run only after the user previews the exact program, arguments,
  folder and environment policy and clicks "Run". The preview says plainly that the command
  executes repository code and is **not sandboxed**. The preview also reads the command line,
  and the one `./script` it runs if there is one, with the same patterns as signals (below),
  and lists what stands out: the command's own notices and cautions, and the script's
  cautions only (a project's build wrapper legitimately downloads and installs). These are
  warnings, not blocks and not a second confirmation; scripts the script calls are not read.
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
- Writes are atomic (temp file + fsync + rename) and journaled; see [Recovery](../guide/recovery.md).
  Existing files keep their permissions; new files get 0644; skill scripts that are executable
  in the library (Git mode 100755) stay executable, and contributions preserve the bit.
- Paths may not contain a `.git` component, so library content cannot plant a nested
  repository (with its own hooks) inside a project.
- Apply verifies each file's digest before backing it up, and again immediately before
  writing it; a journal that cannot be saved rolls the operation back.
- `.habi/lock.json` is untrusted too: entries may only name files under `.agents/skills/` or
  `.claude/skills/`, sections in `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` or `GEMINI.md`,
  and MCP entries in each client's own configuration file. Anything else makes Habi refuse the lock file instead of deleting files.
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
- Images in a package (PNG, JPEG, GIF, WebP, SVG up to 2 MB) are previewed as `data:` URLs
  inside an `<img>`, where SVG scripts and external references never load.
- *Open in your text editor* opens a package file explicitly in a text editor (`open -t` on macOS,
  Notepad on Windows) — never with the file's default application, which for a script could
  be a terminal that runs it. Where no text editor can be named (Linux), the file is revealed
  in the file manager instead.
- Renaming, moving, replacing and removing package files go through `RelPath` and
  `resolve_for_write`/`resolve_for_read`: nothing can leave the package, follow a link, or
  replace an existing file by renaming onto it. SKILL.md keeps its name and place.
- Deleting a draft moves it to the trash (a flag); its files are removed only by an explicit,
  separate "Delete permanently".
- Sharing a local skill goes through the contribution pipeline unchanged: explicit file list,
  secret scan, isolated branch, explicit push.
- Installing on this machine uses the same planner with the home folder as its root: it writes
  only skill folders under `~/.claude/skills` and `~/.agents/skills` and its record,
  `~/.habi/lock.json`; it never writes instructions or MCP configuration there, never through
  a symbolic link, and never over a folder it did not install.

## Desktop shell

- Tauri capability: only what the window uses — listening for the events Habi sends it
  (`core:event:allow-listen`, `allow-unlisten`) and closing itself once pending edits are
  saved (`core:window:allow-destroy`). The devtools toggle exists only in development builds.
  No window, menu, tray, image, path, filesystem, shell, dialog, opener or updater permission
  is granted to the webview; folder pickers, saving, link opening and updates run in Rust.
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

## Library catalog and previews

- A catalog entry is a *suggestion of a repository*, not an endorsement. **Official** means the
  repository's owner matches the publisher the entry names, with the evidence recorded (a
  GitHub-verified organisation, or an unverified one whose website is the publisher's domain)
  and shown. It says nothing about the content. **Reviewed** is a separate fact that is only
  shown when the catalog records an inspection (revision, date, who, what it covered); no
  entry has one. Habi never shows a "safe" or "trusted" badge.
- Pressing Connect on a catalog library's page connects it: the repository is read into the
  cache, and nothing is installed, copied to My skills or run. A connection that is cancelled
  or fails leaves no source behind. Adopting a skill is a separate, explicit step per project. The core can also
  read a library as a hidden preview (`habi catalog preview`): previews stay out of every
  list, recommendation and installation, cannot be installed from, copied from or contributed
  to, and are discarded after 60 days.
- Catalog sources fetch only the newest commit and skip blobs above Habi's own per-file limit;
  paths are narrowed by the entry's include/exclude globs *before* the file-count and size
  limits apply. Symlinks, submodules, unsafe paths and oversized files are skipped and make the
  skill incomplete (so it cannot be installed). Fetching never uses lazy network access.
- **Signals** are a bounded static reading of a skill's files as data: commands that download
  and run code, broad deletes, credential files (SSH, cloud and container logins, keychains,
  browser profiles, shell history; an `.env` file is a notice), elevated permissions, compiled or opaque
  files, invisible characters. Nothing is executed, imported or followed. Matches in reference
  documents are capped at a notice, because documentation about an attack is not an attack.
  The wording is "found by reading the files"; a skill with no signals is not called safe.
- A rule suggested by the catalog for a skill whose author declared none is labelled as Habi's
  judgement wherever it is shown, never overrides the author's own rules, and uses only
  specific, checkable project features (a file, a dependency, a detected tag).

## Network requests Habi makes on its own

Everything else that reaches the network (connecting, refreshing or updating a library,
pushing a contribution, reading a review) happens only when you ask.

- **Checking a library for updates.** When you open a Git library, and on the schedule set in
  Settings → Updates → Check libraries (every 12 hours by default), Habi asks whether the
  library has something newer. That is one `git ls-remote` against the library's own repository (the
  same access its fetch uses); it downloads no objects and changes nothing. A library moves only when the user presses Update, which
  fetches and records a new snapshot exactly as before; installed skills and adopted copies
  never change because a library did.
- **Catalog facts.** Opening the page of a catalog library you have not connected asks
  GitHub's public API for that repository's stars, forks, last push and archived flag
  (`GET https://api.github.com/repos/<owner>/<repo>`, through the system `curl`, anonymous,
  HTTPS only, 10 seconds). The address is built from the built-in catalog, never from text a
  person typed. The answer is kept for a day, so the page works offline afterwards; if GitHub
  cannot be reached the figures are simply not shown. They are context beside the Connect
  button: they never rank, filter or recommend anything, and the page says that how many
  people use a library is not evidence that it is safe. GitHub sees the request's IP address
  and Habi's name; no account, token or project data is sent.
- **Checking for a newer Habi.** While Habi is open, at launch and every few hours (unless
  Settings → Updates → Check for new releases is set to Manual), it asks
  `https://github.com/acltabontabon/habi/releases/latest/download/latest.json` for the newest
  version, from Rust, through the updater plugin. The request carries no identifier and nothing
  about the machine or its projects; GitHub sees an IP address, as with any download. Finding
  a newer version changes nothing. Installing happens only when the person presses Update:
  Habi downloads the installer named in `latest.json` and installs it only if its signature
  verifies against the public key compiled into the app (`plugins.updater.pubkey`), so a
  tampered file or a compromised download host cannot install anything. The private key is
  held by the maintainer and a CI secret (`TAURI_SIGNING_PRIVATE_KEY`); losing it means
  installed copies can only be replaced by hand. The webview has no updater permission: it can
  only ask Rust to install the update Rust itself found, after pending edits are written.

## Internal review

Habi has not had an independent security audit. An internal review by the project itself
(recorded here since the initial commit, 2026-10-02) covered the install pipeline, Git
handling, contributions, client configuration and IPC, and found thirteen issues:
credential-bearing URLs, case-only renames on case-insensitive file systems, a `FILE://`
picker bypass, lost executable bits, hooks on local publish, checks runnable without a preview, apply-time races, marker injection, partial
snapshots, lock-file path confinement, per-section decisions, lossy JSON rewrites, and silent
re-creation of deleted files. All were fixed, with regression tests.

## Known limitations

By design, or not solved yet:

- **What an agent does** with installed content is invisible to Habi, and Habi does not claim
  to know.
- **Running a check** executes code with your privileges. There is no sandbox. The preview
  lists what a pattern reading of the command and its script finds (credential files,
  download-and-run, broad deletes); that is a warning, and it misses anything obfuscated.
- **The secret scan** before sharing is pattern-based. It reduces the risk of sharing a
  secret; it does not remove it.
- **Another process running as you** could race between path validation and directory
  creation while a plan is applied.
- **Community libraries** usually need push access (or a fork) that you do not have. Habi
  prepares the branch and offers *Export patch*; it does not create forks.
- **Unsigned installers, by choice.** Habi ships on GitHub Releases only, without Apple or
  Microsoft code signing, so the first launch needs one confirmation
  ([how](../guide/getting-started.md#installing)). Updates are signed with Habi's own updater key
  and verified before they install.
- Smaller gaps: an update does not add an MCP server an item newly suggests, and restoring a
  case-only rename keeps the new letter case
  ([recovery](../guide/recovery.md#known-limitations)); an install on this machine is journaled
  but no screen offers to restore it; turning an existing file into an
  OpenAPI specification is noticed after a rescan ([detectors](../library-authors/detectors.md));
  comments inside `habi.yaml` are not kept when the share form rewrites it
  ([sharing](../guide/sharing.md)).
