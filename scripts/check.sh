#!/usr/bin/env bash
# Runs the checks CI runs, on this machine. CI runs the Rust checks on macOS and Windows and
# the others on Linux, each only when a change touches what it checks; installers are built
# only by the release workflow, from a tag. Usage: scripts/check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Rust format";   cargo fmt --all --check
echo "== Rust lint";     cargo clippy --workspace --all-targets -- -D warnings
# The bindings are generated; regenerating them from scratch catches files for removed types.
rm -rf apps/desktop/src/bindings
echo "== Rust tests";    cargo test --workspace
echo "== Bindings are up to date"
if [ -n "$(git status --porcelain --untracked-files=all -- apps/desktop/src/bindings)" ]; then
  git status --short -- apps/desktop/src/bindings
  echo "TypeScript bindings changed: commit apps/desktop/src/bindings"; exit 1
fi
echo "== Dependency licenses, advisories and sources"
if cargo deny --version >/dev/null 2>&1; then
  cargo deny check licenses advisories sources
else
  echo "cargo-deny is not installed; skipped (CI runs it). Install: cargo install --locked cargo-deny"
fi

cd apps/desktop
echo "== Frontend install"; pnpm install --frozen-lockfile
echo "== Frontend lint";    pnpm lint
echo "== Type check";       pnpm typecheck
echo "== Frontend tests";   pnpm test
echo "== Frontend build";   pnpm build
cd ../..
echo "== Third-party notices are up to date"; node scripts/third-party-notices.mjs --check
echo "== Documentation links";                node scripts/check-links.mjs
echo "== Script tests";                       node --test scripts/*.test.mjs
echo "== Agent smoke fixture through the real CLI"
cargo build -p habi-cli --locked
habi_test_cli="$(node -e 'console.log(require("node:path").resolve("target/debug", process.platform === "win32" ? "habi.exe" : "habi"))')"
HABI_SMOKE_CLI="$habi_test_cli" node --test scripts/agent-smoke.test.mjs

cd website
echo "== Website install"; pnpm install --frozen-lockfile
echo "== Website build";   pnpm build
cd ..
echo "All checks passed."
