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
- **Local first.** No telemetry, no accounts, no background network calls. Anything that
  leaves the machine is shown first and happens only when the user asks.
- **Plain words** in the interface and CLI. If a newcomer would need to ask what it means,
  rephrase it.

## Set up

Install the prerequisites listed in the README under
[Build from source](README.md#build-from-source) (Rust, Node.js 24+, Git and the Tauri
prerequisites; Linux is not supported for the desktop app). Then:

```sh
git clone https://github.com/acltabontabon/habi.git
cd habi
corepack enable                                   # provides the pinned pnpm
scripts/check.sh                                  # the checks CI runs (see below)

cd apps/desktop && pnpm install && pnpm tauri dev # the desktop app
cargo run -p habi-cli -- --help                   # the command line
```

The first build takes a few minutes.

`scripts/check.sh` runs, on your machine, what CI checks: Rust format, lint and tests, the
TypeScript bindings, `cargo deny` (skipped with a note if
[cargo-deny](https://github.com/EmbarkStudios/cargo-deny) is not installed), frontend lint,
type check, tests and build, third-party notices, documentation links and the website build.
CI also runs these on macOS, Windows and Linux, and builds the desktop installers.

[Architecture](docs/dev/architecture.md) explains the repository layout and modules, and how
to work on the UI in a browser against the real core or against fixture data.

## Making a change

1. Open an issue first for anything larger than a bug fix, so we can agree on the
   approach.
2. Add or update tests. Core behavior is tested in `crates/habi-core/tests`; UI behavior in
   `apps/desktop/src/test` (Vitest + Testing Library).
3. `cargo test` regenerates the TypeScript bindings in `apps/desktop/src/bindings` from
   Rust types. **Commit them** with your change.
4. If you add or update a dependency, run `node scripts/third-party-notices.mjs` and commit
   `THIRD_PARTY_NOTICES.md`. Dependencies must be under a permissive license (MIT,
   Apache-2.0, BSD, ISC, Zlib, Unicode) — see `deny.toml`.
5. Fixtures must stay fictitious: no real company names, people, tokens or internal hosts.
   Use `example.com` / `example.invalid`.
6. Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.
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
