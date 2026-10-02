#!/bin/sh
# Re-runs the lesson's journey shown in "Receipts" (src/data/journey.ts) and
# prints each command's real output, for comparison after Habi changes.
# Uses throwaway copies of the fixtures; nothing outside a temp folder changes.
#
#   cargo build -p habi-cli && sh website/scripts/journey.sh
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
habi=${HABI_BIN:-$root/target/debug/habi}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export HABI_HOME="$work/home"
git_init() { (cd "$1" && git init -q -b main && git add -A && git -c user.email=a@example.invalid -c user.name=demo commit -qm init); }
step() { printf '\n$ %s\n' "$*"; "$habi" "$@"; }

cp -R "$root/fixtures/libraries/example-team-library" "$work/lib" && git_init "$work/lib"
for repo in billing-service platform-monorepo; do cp -R "$root/fixtures/repos/$repo" "$work/$repo" && git_init "$work/$repo"; done
"$habi" source add "Platform team" "$work/lib" >/dev/null
"$habi" source refresh >/dev/null

(cd "$work/platform-monorepo" && "$habi" install liquibase-migration-review --client claude-code --yes >/dev/null)

cd "$work/billing-service"
step recommend
step install liquibase-migration-review --client claude-code,cursor --yes
skill=.claude/skills/liquibase-migration-review/SKILL.md
python3 - "$skill" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("""   indexes on large tables without `CONCURRENTLY` (PostgreSQL), renames.
6. Summarize""", """   indexes on large tables without `CONCURRENTLY` (PostgreSQL), renames.
6. On MySQL, check the table's size first: an `ALTER TABLE` that copies
   the table blocks writes until it finishes. Say roughly how long.
7. Summarize""")
open(p, "w").write(s)
PY
step status
step contribute start "Platform team" .claude/skills/liquibase-migration-review
id=$("$habi" contribute list --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
"$habi" contribute describe "$id" --title "Check table size before ALTER TABLE on MySQL" \
  --message "An ALTER TABLE that copies a large table blocked orders for six minutes." >/dev/null
step contribute commit "$id"
"$habi" contribute publish "$id" --yes >/dev/null
branch=$(git -C "$work/lib" branch --format='%(refname:short)' | grep habi/contrib)
git -C "$work/lib" merge -q --no-ff -m "Merge: check table size before ALTER TABLE on MySQL" "$branch"

cd "$work/platform-monorepo"
step source refresh
step update --dry-run
