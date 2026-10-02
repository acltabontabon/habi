# Contributing to Habi

Thanks for helping. This page gets you from a fresh clone to a passing check in a few
minutes, and explains the few rules that keep Habi trustworthy.

## Ground rules

Habi's promise is *honest, local, previewed*. Changes are reviewed against
[docs/project/product.md](docs/project/product.md). In short:

- **Unknown is a valid answer.** Never turn missing evidence into "applies" or "does not
  apply". No confidence percentages.
- **Every change to a user's project is a previewed plan** that can be restored. Never
  overwrite a user's edit silently.
- **Local first.** No telemetry, no accounts, no background network calls. Anything that
  leaves the machine is shown first and happens only when the user asks.
- **Plain words** in the interface and CLI. If a newcomer would need to ask what it means,
  rephrase it.

## Set up

Prerequisites:

- [Rust](https://rustup.rs) — the exact toolchain is pinned in `rust-toolchain.toml` and
  installed automatically by `rustup`.
- [Node.js](https://nodejs.org) 24 or newer, with `corepack enable` (provides pnpm 12).
- Git.
- For the desktop app: the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your platform (Xcode Command Line Tools on macOS; Microsoft C++ Build Tools and
  WebView2 on Windows). Linux is not supported.

```sh
git clone https://github.com/acltabontabon/habi.git
cd habi
corepack enable
scripts/check.sh        # everything CI runs: format, lint, tests, bindings, build
```

The first build takes a few minutes.

## Run it

```sh
# Desktop app (native window)
cd apps/desktop && pnpm install && pnpm tauri dev

# Command line
cargo run -p habi-cli -- --help
```

### Working on the UI in a browser

The development bridge serves the real core over loopback HTTP, so you can use browser
dev tools against real inspection, Git and plans:

```sh
HABI_HOME=/tmp/habi-dev cargo run -p habi-core --example dev_bridge
cd apps/desktop && VITE_HABI_BRIDGE=1 pnpm dev      # http://127.0.0.1:1420
```

Use `HABI_BRIDGE_PORT` and `HABI_UI_PORT` to run a second pair side by side.
`HABI_HOME` keeps your experiments away from your real Habi data.

## Repository layout

| Path | What lives there |
|---|---|
| `crates/habi-core` | Everything that matters: inspection, matching, libraries, installs, contributions. Pure Rust, no UI. |
| `crates/habi-cli` | The `habi` command. |
| `apps/desktop` | React UI (`src/`) and the thin Tauri shell (`src-tauri/`). |
| `schema/` | JSON Schemas for `habi.yaml` and `habi-library.yaml`. |
| `fixtures/` | Example libraries and repositories used by tests and the sample workspace. |
| `docs/` | Product contract, architecture, security, formats. |

See [docs/dev/architecture.md](docs/dev/architecture.md) for the module map.

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
- A maintainer reviews every change; expect questions about edge cases and wording.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project (inbound = outbound).

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
problems privately as described in [SECURITY.md](SECURITY.md) — not in public issues.
