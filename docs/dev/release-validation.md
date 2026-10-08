# Release validation

Habi's tests prove its own behavior. Production readiness also requires evidence that the
packaged app works on supported machines and that actual agents discover what it writes.
Unsigned distribution remains supported and intentional. This procedure requires no Apple
or Microsoft certificate, paid signing service, or paid security audit.

## Record one exact candidate

1. Build a draft using the release workflow. Download the draft's installers and updater
   archive. Keep the exact files tested; do not rebuild them and reuse the old result.
2. Copy `docs/dev/release-evidence.template.json` to a versioned file such as
   `docs/dev/release-evidence/0.2.0.json`. Set `version` and `revision` (the full commit from
   `git rev-parse v0.2.0^{commit}`). Leave any unperformed check `false`.
3. Record each agent version, OS version, date/time in ISO 8601 UTC, and evidence (saved
   logs, screenshots, reproduction notes). Do not include credentials or private project
   content. Results must be no more than 30 days old when validated.
4. Record SHA-256 for the exact macOS `.dmg` and `.app.tar.gz`, and Windows `.msi` and
   `-setup.exe`. The readiness tool compares them with the downloaded candidate.
5. Run **Actions → Release readiness → Run workflow** from the branch containing the
   completed evidence, with the release tag and evidence file path. It validates only;
   publishing is a separate action. GitHub's UI does not enforce this check automatically.

You can run the same check locally:

```sh
node scripts/release-readiness.mjs v0.2.0 docs/dev/release-evidence/0.2.0.json /path/to/candidate-artifacts
```

The empty template deliberately fails. A passed file-generation test, mock UI test or
checkmark without an actual observation is not release evidence.

## Agent discovery

Use the [prepared smoke workspace](compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it).
For every supported agent, record all five observations:

- The skill appears in the tool's own skill listing.
- `habi ping` invokes the skill and returns `HABI-PONG`.
- Asking for the Habi instruction marker returns `HABI-INSTRUCTIONS-LOADED`.
- The tool lists the configured MCP server, with the expected approval/trust state.
- Invoking its `habi_ping` tool returns `HABI-MCP-PONG`.

Test in a scratch project, never a real repository. Missing tools or authentication are
**not run**. Update the human-readable results table as well as the evidence JSON.
The automated fixture test only proves Habi produced files and the test server responds.

## Packaged app on macOS and Windows

Use disposable user data and projects. Test both installer formats on Windows, and the
universal macOS build on Apple Silicon and Intel machines before claiming both architectures
validated. Describe those machine details in the evidence. OS signing is not a criterion:
follow the documented first-launch steps for unsigned builds.

| Evidence field | Required observation |
|---|---|
| `cleanInstall` | Install each recorded installer on a clean machine/profile. Uninstall and reinstall without losing data. |
| `launch` | The packaged app opens, native folder/save dialogs work, the sample works, and errors are readable. |
| `upgradePreservesData` | Upgrade from the recorded previous release with existing drafts, contributions, history, installs and local edits. Verify content and modes after restart. |
| `updaterRejectsTampering` | In a disposable build/profile with a local test update endpoint, alter one byte in the update payload while retaining its original signature. Update must fail without replacing the app. Then install the unmodified signed update. Habi updater signatures remain separate from OS signing. |
| `offlineEditing` | Disconnect networking; create/edit/import/install/export a skill. Failed network operations must leave drafts and the last good snapshot intact. |
| `interruptedInstallRecovery` | Force-terminate while installing/updating, restart and recover; compare original content and executable modes. Repeat during draft saving and verify the last successful save survives. |
| `diskFullRecovery` | In an isolated quota/size-limited test volume, exhaust space during apply and draft saving. Recover after freeing space; no unreported overwrite or corrupted lock/database. Never fill your normal system disk. |
| `permissionFailureRecovery` | Deny writes to a target and to the Habi journal/data location in separate runs. Confirm errors, preserved edits and successful retry after permissions return. |
| `concurrentOperations` | Run desktop and CLI writes against the same project/draft. A second writer must report busy/conflict or safely serialize; preserve external edits. |
| `backupRestore` | Back up the whole closed data directory, restore to a new location, and open it with the tested app. Verify original drafts, contributions, history and database state. |
| `largeRepository` | Use a representative large monorepo and library; record file counts, sizes, scan duration, memory and UI responsiveness. Cancellation must work and limits must be explained. |

Do not mark a row passed from a simulated failure alone. Real-process termination is tested
in `install_lifecycle`; disk-full, OS permission behavior, installer launches and actual
updates still need observations on the packaged application.

## Automated checks

CI runs Rust tests on macOS and Windows, including abrupt child-process termination after
each install write before journal completion. A fresh service must restore the original
files and repeated recovery must do nothing. CI also installs the compatibility fixture
through the actual CLI on both platforms.

Backup and release tools run on both supported platforms: whole-state restore, database
integrity, checksum damage, missing/extra files, destination protection and unsafe paths.
Symlink-specific Node tests run on macOS; Windows CI does not assume symlink privileges.
These checks complement the existing conflict, stale-plan, executable-mode and IPC tests.

Remaining checks cannot be inferred from CI being green. Keep their results pending until
the relevant machine and agent have actually been tested.


## Current partial observations (2026-10-08)

These observations were made against a working checkout, not a release candidate. They
cannot satisfy the release gate or replace the seven-agent results table.

- Claude Code 2.1.293: `claude mcp list` recognized Habi's installed `habi-smoke` project
  server and reported pending approval, matching the intended trust boundary. Invocation
  and instruction reading are still pending.
- Codex CLI 0.160.0: standalone `mcp list` did not list the project server, including with a
  scratch-project trust override. This is unresolved; verify with `/mcp` in the actual
  trusted project session. Habi's TOML matches the
  [official project MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
  but documentation alone is not a passing runtime result.
- The real Habi CLI installed the prepared fixture, created a complete offline backup,
  restored it into a new folder, and successfully reopened the restored database and library
  registration. Original-work and tamper cases are also covered by the backup tests.
- A real CLI update with a write-denied skill folder failed, preserved both installed
  copies and the lock file, and succeeded after permissions were restored.
- A real CLI update on a disposable 32 MB HFS+ volume failed after verified `ENOSPC`,
  preserved both installed copies and the lock file, then recovered and updated successfully
  after space was freed. These observations cover core/CLI behavior, not the editor's
  unsaved-text behavior or the Windows storage stack.
- The unsigned macOS app bundle built and its process started against the restored test
  database (confirmed by the startup log). Computer Use permissions were unavailable, so
  window rendering, native dialogs and interactive desktop flows are **not verified**.
- The automated suites passed locally on macOS. Windows runs and packaged installer/update
  observations remain pending until the corresponding CI and machine tests run.
