# Building and releasing

Habi ships for **macOS and Windows**. Linux is not a release target. This page is the
procedure; what still blocks the first release is tracked in
[Project status](../project/status.md#release-blockers).

## Toolchain (pinned)

| Tool | Version | Where pinned |
|---|---|---|
| Rust | 1.98.1 | `rust-toolchain.toml` |
| Node.js | ≥ 24 (developed on 26.8) | `apps/desktop/package.json` `engines` |
| pnpm | 12.4.2 | `packageManager` |
| Tauri | 2.12.1 (crate, CLI, API) | `Cargo.toml`, `package.json` |
| Dependencies | exact | `Cargo.lock`, `apps/desktop/pnpm-lock.yaml` |

Build and check commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md#set-up). Installers
for the current platform: `pnpm tauri build` in `apps/desktop`.

## Versioning

Semantic versioning, separately for:

- **The application**: major for incompatible changes to the lock file, data directory or
  CLI; minor for features; patch for fixes. The version appears in four manifests, which
  must agree: `Cargo.toml` (workspace), `apps/desktop/src-tauri/tauri.conf.json`,
  `apps/desktop/package.json` and `website/package.json`. The release workflow refuses a tag
  that does not match them.
- **The metadata schema** (`habi: 1`) and **lock file** (`habi_lock: 1`): see the
  [migration policy](../library-authors/metadata-schema.md#versioning-and-migration-policy).
  The application version does not change the schema version.

## Release checklist

1. Move the `CHANGELOG.md` entries under "Unreleased" to a new version heading, and set the
   version in the four manifests.
2. Make sure CI is green on `main` (macOS, Windows and Linux).
3. Run the client [smoke tests](compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it)
   with current Claude Code, Cursor and Codex builds; record the client versions and date
   there.
4. Tag `vX.Y.Z` and push the tag. The release workflow:
   - runs the same checks as CI, including `cargo deny`;
   - checks that the tag matches the four manifests;
   - builds the macOS installer as one universal build (Apple Silicon and Intel), the
     Windows installers, and the `habi` command-line tool for each;
   - writes `SHA256SUMS-macos.txt` and `SHA256SUMS-windows.txt` and a build provenance
     attestation for every artifact;
   - creates a **draft** release.
5. Install the draft's artifacts on macOS and Windows, then publish the release.

Anyone can check an artifact's provenance with
`gh attestation verify <file> --repo acltabontabon/habi`.

## Signing and notarization

The release workflow passes these secrets to `tauri build` only when they exist. **None are
configured in this repository.**

| What | Secrets / settings | State |
|---|---|---|
| macOS signing | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (`bundle.macOS.signingIdentity`) | Wired up; no credentials |
| macOS notarization | `APPLE_API_ISSUER`, `APPLE_API_KEY` (key id) and `APPLE_API_PRIVATE_KEY` (contents of the `.p8` file; the workflow writes it to a temporary file and sets `APPLE_API_KEY_PATH`) | Wired up; no credentials. Runs during `tauri build` |
| Windows signing | Authenticode certificate (`bundle.windows.certificateThumbprint` or a `signCommand`) | Not implemented |
| `habi` command-line binary | — | Not signed or notarized on either platform |

Without these, the workflow produces **unsigned** artifacts and the draft release says so.
Never commit certificates or passwords.

## Updates

Habi has **no auto-updater**. Users install new versions manually from the release page.
An updater would require signed update manifests (Tauri updater with a public key) and is
deliberately not shipped until signing exists.
