#!/usr/bin/env bash
# A workspace to photograph: the example team and security libraries connected as ordinary
# (not "sample") libraries, seven projects opened, a few skills installed, and newer versions of
# them waiting in the library. It is scripts/seed-test-data.sh without the broken states (an
# offline library, a conflict), so every screen reads as a team that has it together.
#
# Usage:   scripts/film/seed.sh <output-dir>
# Then run the development bridge on <output-dir>/habi-home (see scripts/docs-screenshots.mjs).
#
# Everything lives under the output directory; your own Habi data is not touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mkdir -p "${1:?usage: seed.sh <output-dir>}" && cd "$1" && pwd)"
export HABI_HOME="$OUT/habi-home"

if [ -e "$HABI_HOME" ] || [ -e "$OUT/projects" ] || [ -e "$OUT/libraries" ]; then
  echo "$OUT already holds a workspace. Use an empty folder." >&2
  exit 1
fi

cargo build --quiet -p habi-cli --manifest-path "$ROOT/Cargo.toml"
HABI="$ROOT/target/debug/habi"

g() { git -c user.name="Platform Team" -c user.email="platform@example.invalid" \
        -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }

mkdir -p "$OUT/libraries" "$OUT/projects"
cp -R "$ROOT/fixtures/libraries/example-team-library" "$OUT/libraries/team-skills"
cp -R "$ROOT/fixtures/libraries/security-guild-library" "$OUT/libraries/security-guild"
# The fixtures say "(example)" after every owner and library name; a real team's would not.
find "$OUT/libraries" -name '*.yaml' -exec perl -pi -e 's/ \(example\)//g' {} +
for lib in team-skills security-guild; do
  (cd "$OUT/libraries/$lib" && g init -q && g add -A && g commit -qm "Initial library" && g tag v1)
done

P="$OUT/projects"
for repo in billing-service orders-api storefront-web platform-monorepo \
            inventory-gradle-multi agent-ready-service legacy-scripts; do
  cp -R "$ROOT/fixtures/repos/$repo" "$P/$repo"
  (cd "$P/$repo" && g init -q && g add -A && g commit -qm "Project")
done

"$HABI" source add "team-skills" "$OUT/libraries/team-skills" --branch main
"$HABI" source add "security-guild" "$OUT/libraries/security-guild" --branch main
"$HABI" source refresh

"$HABI" install "team-skills/liquibase-migration-review" "team-skills/java-service-conventions" \
  --client claude-code,cursor -C "$P/billing-service" --yes
"$HABI" install "team-skills/react-component-review" --client cursor -C "$P/storefront-web" --yes
"$HABI" install "team-skills/api-contract-review" --client codex -C "$P/orders-api" --yes

# A better version of the Liquibase review, published to the library: the "update available".
cd "$OUT/libraries/team-skills"
printf '\n6. On MySQL, check the table'"'"'s size first: an `ALTER TABLE` that copies the table blocks writes.\n' \
  >> skills/liquibase-migration-review/SKILL.md
g commit -qam "Liquibase review: check table size on MySQL"
cd "$ROOT"
"$HABI" source refresh "team-skills"

echo "$OUT"
