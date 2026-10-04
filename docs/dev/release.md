# Building and releasing

Habi ships for **macOS and Windows**. Linux is not a release target. This page is the
procedure.

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

- **The application**: major for incompatible changes to the lock file or data directory;
  minor for features; patch for fixes. The version appears in four manifests, which
  must agree: `Cargo.toml` (workspace), `apps/desktop/src-tauri/tauri.conf.json`,
  `apps/desktop/package.json` and `website/package.json`. The release workflow refuses a tag
  that does not match them.
- **The metadata schema** (`habi: 1`) and **lock file** (`habi_lock: 1`): see the
  [migration policy](../library-authors/metadata-schema.md#versioning-and-migration-policy).
  The application version does not change the schema version.

## Release checklist

1. In `CHANGELOG.md`, rename "Unreleased" to `## X.Y.Z - YYYY-MM-DD`, start a new empty
   Unreleased above it, and set the version in the four manifests. The entry is what the
   GitHub release says, what running copies of Habi show as the update's notes, and what
   *About → What's new* lists, so it is written for the person using Habi: what they can now
   do, what got easier or was fixed, and anything they must do after updating. Lead a bullet
   with a **bold phrase**, keep it to a sentence or two, and leave out refactors,
   dependencies, internals and file names. Sections are Keep a Changelog's: Added, Changed,
   Deprecated, Removed, Fixed, Security.
2. Make sure CI is green on `main` (macOS and Windows).
3. Run the client [smoke tests](compatibility-research.md#6-smoke-test-procedure-does-the-client-actually-discover-it)
   with current builds of all seven agent tools, and record the versions and date in
   [the results](compatibility-research.md#smoke-test-results).
4. Tag `vX.Y.Z` and push the tag. The release workflow:
   - runs the same checks as CI, including `cargo deny`;
   - checks that the tag matches the four manifests and that `CHANGELOG.md` has its entry;
   - builds the macOS installer as one universal build (Apple Silicon and Intel), the
     Windows installers;
   - signs the update packages with the updater key (see [Updates](#updates));
   - writes `SHA256SUMS-macos.txt` and `SHA256SUMS-windows.txt` and a build provenance
     attestation for every artifact;
   - creates a **draft** release named *Habi vX.Y.Z*, laid out by `scripts/release-notes.mjs`
     (see [The release page](#the-release-page)), with `latest.json`, the manifest running
     copies of Habi ask for.
5. Install the draft's artifacts on macOS and Windows, then publish the release. Publishing
   is what offers it to people already running Habi: `latest.json` is fetched from the
   *latest published* release, so a draft, or a pre-release, is never offered.

6. Publishing also runs the **Homebrew** workflow, which writes the cask for the release
   (`scripts/homebrew-cask.mjs`) and commits it to the tap,
   [acltabontabon/homebrew-tap](https://github.com/acltabontabon/homebrew-tap). Check that it
   went green. A pre-release is skipped. To redo it, run *Actions → Homebrew → Run workflow*
   with the tag.

Anyone can check an artifact's provenance with
`gh attestation verify <file> --repo acltabontabon/habi`.

## The release page

The text of a GitHub release is not written by hand. `scripts/release-notes.mjs` builds it from
this version's section of `CHANGELOG.md` and the installers the build produced: a banner, the
film, a download table (macOS and Windows, with sizes), *What's new*, a look inside the app,
and the first-launch and verification notes. Its pictures are read from `docs/media/` at the
tag, so a published page never changes under a release.

- **Preview it** before tagging: `node scripts/release-notes.mjs --sample vX.Y.Z --ref main`
  prints the page with typical file names. Pasting that into a draft release shows exactly what
  GitHub makes of it. Release pages turn every line break into a hard one, which is why the
  generator joins the changelog's wrapped lines.
- **The banner** (`docs/media/release-banner.jpg`) is rendered from the app's own screenshots
  by `node scripts/release-banner.mjs` (headless Chrome; `pnpm install` in `website/` first). It
  carries no version, so retake it only when the app's look changes.
- **The film** shown on the page is `docs/media/demo.gif`; GitHub does not play an attached
  MP4 inline, so the GIF links to the full film on the site.
- **The site's Download buttons** (`website/src/scripts/download.ts`) ask GitHub for the latest
  published release and link the installer for the visitor's system, so they start working when
  a release is published, with no site change.

## Signing and notarization

Habi's installers are **not code-signed, by choice**: there is no Apple Developer ID and no
Windows Authenticode certificate, and the binaries are published on GitHub Releases only. The
first launch therefore meets Gatekeeper or SmartScreen once, and
[Getting started](../guide/getting-started.md#installing) says how to get past it. What protects
users after that is the updater's own signature (below), not the operating system's.

The release workflow signs nothing for Apple or Microsoft, and the draft release says so.
Should that change, Tauri reads the Apple
certificate and notarization credentials from `APPLE_*` environment variables during
`tauri build`, and a Windows Authenticode certificate from `bundle.windows`; see Tauri's
distribution guides. Never commit certificates or passwords.

## Homebrew

`brew install --cask acltabontabon/tap/habi` comes from a tap of our own, not the official
`homebrew/cask`: Homebrew disables casks that fail Gatekeeper there, and Habi is not notarized
(see above). The tap, [acltabontabon/homebrew-tap](https://github.com/acltabontabon/homebrew-tap),
holds one file, `Casks/habi.rb`, written by `.github/workflows/homebrew.yml` from the published
release's universal `.dmg` (its checksum is verified against `SHA256SUMS-macos.txt` first).

The workflow pushes to the tap with a **deploy key**, so it can change that one repository and
nothing else:

| What | Where |
|---|---|
| Public key | Deploy key *habi release workflow* (write access) on the tap repository |
| Private key | GitHub secret `HOMEBREW_TAP_DEPLOY_KEY` on this repository |

To rotate it, generate a new key (`ssh-keygen -t ed25519 -N "" -f key`), replace the deploy key
on the tap and the secret here, and delete the local copy. The tap needs no other upkeep. The
cask leaves Habi's data folder alone on `brew uninstall --zap`.

## Updates

Habi updates itself with Tauri's updater, run from Rust (`apps/desktop/src-tauri/src/updates.rs`);
the webview has no updater permission. While open, Habi asks for `latest.json` on the latest
GitHub release, at launch and every few hours (Settings → Updates → Check for new releases
turns that off). When a newer version exists, *About* and the sidebar's version mark say so, and it installs when the
person presses **Update and restart**, after pending edits are written. How a check, a
download and the signature fit together, and what leaves the machine, is in the
[security model](../project/security-model.md#network-requests-habi-makes-on-its-own).

**The updater key** has nothing to do with Apple or Windows code signing, and is needed for
every release:

| What | Where |
|---|---|
| Public key | `plugins.updater.pubkey` in `tauri.conf.json`, compiled into every build |
| Private key | GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if it has one). Keep a copy somewhere safe: **a build that is not signed with this key can never be installed by copies already out there**, so losing it means everyone reinstalls by hand |

Generate a replacement with `pnpm tauri signer generate -w ~/.tauri/habi-updater.key` in
`apps/desktop`, put the new public key in `tauri.conf.json`, and ship that as a manual
install before relying on updates again. Updater packages are built only by the release
workflow (`--config` adds `bundle.createUpdaterArtifacts`), so ordinary builds do not need the
key. The release fails early when the secret is missing.

Updating works without Apple or Windows code signing, but the first install of an unsigned
build still meets Gatekeeper and SmartScreen; the updater's own signature is what protects
later updates.
