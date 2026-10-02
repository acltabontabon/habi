#!/usr/bin/env bash
# Runs every check CI runs. Usage: scripts/check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Rust format";   cargo fmt --all --check
echo "== Rust lint";     cargo clippy --workspace --all-targets -- -D warnings
echo "== Rust tests";    cargo test --workspace
echo "== Bindings are up to date"
if [ -n "$(git status --porcelain -- apps/desktop/src/bindings)" ]; then
  git status --short -- apps/desktop/src/bindings
  echo "TypeScript bindings changed: commit apps/desktop/src/bindings"; exit 1
fi

cd apps/desktop
echo "== Frontend install"; pnpm install --frozen-lockfile
echo "== Frontend lint";    pnpm lint
echo "== Type check";       pnpm typecheck
echo "== Frontend tests";   pnpm test
echo "== Frontend build";   pnpm build
cd ../..
echo "== Third-party notices are up to date"; node scripts/third-party-notices.mjs --check
echo "All checks passed."
