# Project status

Habi is **pre-release (0.1.0)**. This page says what is known not to work or not to be verified, and what is
planned next. Product principles live in [product.md](product.md); the release procedure in
[release.md](../dev/release.md).

Habi runs on macOS 11 or later (Apple Silicon and Intel) and on Windows. Linux is not
supported, and CI does not test it.

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

## Next

1. Run the client smoke tests and record versions in
   [compatibility research](../dev/compatibility-research.md).
2. Exercise sharing's remaining review states on GitHub, and all of it on GitLab, against live repositories.
3. Restore for installs on this machine.
4. Cursor `.mdc` rules (see [future direction](product.md#future-direction)).
5. `habi skill …` commands for My skills (list, export, import); the core supports them.
