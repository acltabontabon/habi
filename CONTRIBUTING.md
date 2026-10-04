# Contributing to Habi

Thanks for helping. This page gets you from a fresh clone to a passing check in a few
minutes, and explains the few rules that keep Habi trustworthy.

## Ground rules

Habi's promise is *honest, local, previewed*. Changes are reviewed against the
[product contract](docs/project/product.md). In short:

- **Unknown is a valid answer.** Never turn missing evidence into "applies" or "does not
  apply". No confidence percentages.
- **Every change to a user's project is a previewed plan** that can be restored. Never
  overwrite a user's edit silently.
- **Local first.** No telemetry and no accounts. The only requests Habi makes on its own are
  the ones the [security model](docs/project/security-model.md#network-requests-habi-makes-on-its-own)
  lists, and none carries anything about the user. Everything else leaves the machine only
  when the user asks, and is shown first.
- **Plain words** in the interface. If a newcomer would need to ask what it means,
  rephrase it.

## Set up

You need [Rust](https://rustup.rs) (the pinned version in `rust-toolchain.toml` installs
itself), [Node.js](https://nodejs.org) 24 or later, Git, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system: on macOS,
`xcode-select --install`; on Windows, the Microsoft C++ Build Tools and WebView2. Linux is not
supported for the desktop app. Then:

```sh
git clone https://github.com/acltabontabon/habi.git
cd habi
corepack enable                                   # provides the pinned pnpm
scripts/check.sh                                  # the checks CI runs (see below)

cd apps/desktop && pnpm install && pnpm tauri dev # the desktop app
cargo run -p habi-cli -- --help                   # the internal command line (docs/dev/cli.md)
```

The first build takes a few minutes.

`scripts/check.sh` runs, on your machine, what CI checks: Rust format, lint and tests, the
TypeScript bindings, `cargo deny` (skipped with a note if
[cargo-deny](https://github.com/EmbarkStudios/cargo-deny) is not installed), frontend lint,
type check, tests and build, the script tests, third-party notices, documentation links and
the website build.
CI runs the Rust checks on macOS and Windows and the others once on Linux, each only when a
change touches what it checks. Installers are built only for a release, from a `v*` tag.

[Architecture](docs/dev/architecture.md) explains the repository layout and modules, and how
to work on the UI in a browser against the real core or against fixture data. The
[documentation index](docs/README.md) lists the other pages for working on Habi.

## Making a change

1. Open an issue first for anything larger than a bug fix, so we can agree on the
   approach.
2. Add or update tests. Core behavior is tested in `crates/habi-core/tests`; UI behavior in
   `apps/desktop/src/test` (Vitest + Testing Library).
3. `cargo test` regenerates the TypeScript bindings in `apps/desktop/src/bindings` from
   Rust types. **Commit them** with your change.
4. If you add or update a dependency, run `node scripts/third-party-notices.mjs` and commit
   `THIRD_PARTY_NOTICES.md`. Dependencies must be under a permissive license (MIT, Apache-2.0,
   BSD, ISC, Zlib, Unicode, CC0, Unlicense; MPL-2.0 only when used unmodified), as listed in
   `deny.toml`.
5. Fixtures must stay fictitious: no real company names, people, tokens or internal hosts.
   Use `example.com` / `example.invalid`.
6. Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice, written
   for the person using Habi ([how](docs/dev/release.md#release-checklist)). Update the
   guides in `docs/` when you change what a user sees or does.
7. Run `scripts/check.sh` before opening the pull request.

## Commit and review

- Small, focused pull requests with a clear description of *why*.
- UI changes: include a before/after screenshot.
- The maintainer reviews every change; expect questions about edge cases and wording. Habi
  has one maintainer working in their own time, so reviews are best effort (see
  [SUPPORT.md](SUPPORT.md)).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project (inbound = outbound).

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
problems privately as described in [SECURITY.md](SECURITY.md) — not in public issues.
