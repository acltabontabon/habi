#!/usr/bin/env bash
# Seeds a self-contained Habi test workspace with every state worth looking at:
# two libraries (one later goes offline), seven projects, installed items with
# upstream updates, local edits and conflicts, a declaration, an unmanaged copy,
# and a contribution draft.
#
# Usage:   scripts/seed-test-data.sh [output-dir]      (default: ./habi-test-data)
# Then:    HABI_HOME=<output-dir>/habi-home pnpm --dir apps/desktop tauri dev
#    or:   HABI_HOME=<output-dir>/habi-home target/debug/habi recommend -C <output-dir>/projects/billing-service
#
# Everything lives under the output directory; your own Habi data is not touched.
# All content is fictitious example data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/habi-test-data}" && cd "${1:-$ROOT/habi-test-data}" && pwd)"
export HABI_HOME="$OUT/habi-home"

if [ -e "$HABI_HOME" ] || [ -e "$OUT/projects" ] || [ -e "$OUT/libraries" ]; then
  echo "$OUT already contains test data. Remove it first: rm -rf '$OUT'" >&2
  exit 1
fi

echo "Building the habi CLI…"
cargo build --quiet -p habi-cli --manifest-path "$ROOT/Cargo.toml"
HABI="$ROOT/target/debug/habi"

g() { git -c user.name="Example Maintainer" -c user.email="maintainer@example.invalid" \
        -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }

step() { printf '\n== %s\n' "$*"; }

step "Libraries (local Git repositories)"
mkdir -p "$OUT/libraries" "$OUT/projects"
cp -R "$ROOT/fixtures/libraries/example-team-library" "$OUT/libraries/team-skills"
cp -R "$ROOT/fixtures/libraries/security-guild-library" "$OUT/libraries/security-skills"
for lib in team-skills security-skills; do
  (cd "$OUT/libraries/$lib" && g init -q && g add -A && g commit -qm "Initial library" && g tag v1)
done

step "Projects"
for repo in billing-service orders-api storefront-web platform-monorepo \
            inventory-gradle-multi legacy-scripts agent-ready-service; do
  cp -R "$ROOT/fixtures/repos/$repo" "$OUT/projects/$repo"
  (cd "$OUT/projects/$repo" && g init -q && g add -A && g commit -qm "Project")
done
P="$OUT/projects"

step "Connect and fetch the libraries"
"$HABI" source add "Team library" "$OUT/libraries/team-skills" --branch main
"$HABI" source add "Security guild" "$OUT/libraries/security-skills" --tag v1
"$HABI" source refresh

step "Install items (the 'Installed' state)"
"$HABI" install "Team library/liquibase-migration-review" "Team library/java-service-conventions" \
  --client claude-code,codex -C "$P/billing-service" --yes
"$HABI" install "Team library/react-component-review" "Team library/frontend-test-practices" \
  --client cursor -C "$P/storefront-web" --yes
"$HABI" install "Team library/api-contract-review" "Team library/jooq-query-review" \
  --client codex -C "$P/orders-api" --yes
"$HABI" install "Team library/github-pr-summary" --client claude-code --mcp \
  -C "$P/agent-ready-service" --yes

step "Publish library updates (the 'Update available' state)"
cd "$OUT/libraries/team-skills"
printf '\n7. For PostgreSQL, build large indexes CONCURRENTLY in their own changeset.\n' \
  >> skills/liquibase-migration-review/SKILL.md
printf '\n- Prefer the platform pagination component for lists longer than 50 items.\n' \
  >> skills/react-component-review/SKILL.md
printf '\n- Note deprecations with a sunset date in the description.\n' \
  >> skills/api-contract-review/references/breaking-changes.md
g commit -qam "Review guidance updates"
cd "$ROOT"
"$HABI" source refresh "Team library"

step "Local edits (the 'Edited locally' and 'Conflict' states)"
# Conflict: edited locally AND changed upstream.
printf '\nLocal note: the billing DBA reviews every changeset.\n' \
  >> "$P/billing-service/.claude/skills/liquibase-migration-review/SKILL.md"
# Edited locally, upstream unchanged for that file (update still available elsewhere).
printf '\n- Check colour contrast in dark mode too.\n' \
  >> "$P/storefront-web/.agents/skills/react-component-review/references/a11y.md"
# Edited locally only.
printf '\n- Also check generated code is committed.\n' \
  >> "$P/orders-api/.agents/skills/jooq-query-review/SKILL.md"

step "A declaration (answering what Habi could not establish)"
"$HABI" declare tag db:jooq --absent --note "No jOOQ in the inventory services" \
  -C "$P/inventory-gradle-multi"

step "A contribution draft (Share with your team)"
"$HABI" contribute start "Team library" .claude/skills/liquibase-migration-review \
  -C "$P/billing-service" > /dev/null
echo "Draft created from billing-service's edited Liquibase review."

step "Take the security library offline (the 'stale' state)"
mv "$OUT/libraries/security-skills" "$OUT/libraries/security-skills.offline"
"$HABI" source refresh "Security guild" || true
echo "(The refresh failure above is expected: the cached copy stays browsable.)"

cat <<EOF

Done. Test workspace: $OUT

  Desktop:  HABI_HOME="$HABI_HOME" pnpm --dir "$ROOT/apps/desktop" tauri dev
            (then open a project from the sidebar)
  CLI:      HABI_HOME="$HABI_HOME" "$HABI" status -C "$P/billing-service"

What to look at:
  billing-service         installed items, an update that conflicts with a local edit
  storefront-web          update available alongside a locally edited reference file
  orders-api              api-contract-review from two libraries; a locally edited skill
  platform-monorepo       per-module matches, a jOOQ exclusion, partial Maven evidence
  inventory-gradle-multi  partial Gradle evidence; a declaration you can undo
  legacy-scripts          no supported manifests, nothing matched from README text
  agent-ready-service     an unmanaged skill copy; MCP config added beside an existing server
  Security guild          stale (offline) library with invalid and undeclared items

To bring the security library back online:
  mv "$OUT/libraries/security-skills.offline" "$OUT/libraries/security-skills"
EOF
