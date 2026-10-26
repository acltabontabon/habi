#!/usr/bin/env node
// Photograph the machine collections, history and library status against the real core.
// Start with a fresh scripts/film/seed.sh workspace and a bridge using
// HABI_USER_HOME="$HABI_SHOTS_ROOT/user-home"; create that folder first.
// Never run this against your personal data or skill folders.
//
// HABI_SHOTS_ROOT=/tmp/your-seeded-workspace \
//   node scripts/docs-screenshots-machine.mjs http://127.0.0.1:1441 http://127.0.0.1:1440

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.HABI_SHOTS_ROOT) throw new Error("Set HABI_SHOTS_ROOT to a fresh workspace from scripts/film/seed.sh.");
const work = realpathSync(process.env.HABI_SHOTS_ROOT);
// Canonical paths let the shared screenshot helper tidy macOS's /private/tmp alias cleanly.
process.env.HABI_SHOTS_ROOT = work;
process.env.HABI_HOME = realpathSync(join(work, "habi-home"));
const url = process.argv[2] ?? "http://127.0.0.1:1441";
const bridge = process.argv[3] ?? "http://127.0.0.1:1440";
const expected = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;

async function invoke(cmd, args = {}) {
  const reply = await fetch(`${bridge}/invoke`, {
    method: "POST",
    headers: { "X-Habi-Bridge": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, args }),
  });
  const body = await reply.json();
  if (body.err) throw new Error(`${cmd}: ${body.err.message}`);
  return body.ok;
}

const info = await invoke("app_info");
assert.equal(info.version, `${expected}-bridge`, "Build the bridge at the current version first.");
assert.equal(realpathSync(info.dataDir), realpathSync(join(work, "habi-home")), "Use the isolated screenshot data folder.");
const sources = await invoke("list_sources");
const source = sources.find((s) => s.name === "team-skills");
assert.ok(source, "Seed the team-skills library first.");
const history = await invoke("machine_history");
assert.ok(history.length === 0 || history.length === 3, "Use fresh disposable skill folders.");

if (history.length === 0) for (const [itemId, clients] of [
  ["liquibase-migration-review", ["claude-code"]],
  ["api-contract-review", ["codex"]],
  ["react-component-review", ["cursor"]],
]) {
  const plan = await invoke("plan_install_machine", {
    items: [{ sourceId: source.id, itemId }], clients, decisions: {},
  });
  assert.equal(realpathSync(plan.project), realpathSync(join(work, "user-home")), "Machine installs must stay in the disposable home folder.");
  assert.equal(plan.conflicts.length, 0);
  await invoke("apply_plan", { planId: plan.id });
}
// Give the local library a genuine newer revision, without fetching it into Habi yet.
const library = join(work, "libraries/team-skills");
assert.equal(realpathSync(source.location), realpathSync(library));
const skillFile = join(library, "skills/liquibase-migration-review/SKILL.md");
if (!readFileSync(skillFile, "utf8").includes("Record the migration's expected lock duration")) {
  appendFileSync(skillFile, "\n7. Record the migration's expected lock duration before deployment.\n");
  execFileSync("git", ["-c", "user.name=Platform Team", "-c", "user.email=platform@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qam", "Document migration lock duration"], { cwd: library });
}
await invoke("check_source_update", { sourceId: source.id });
await invoke("set_settings", { settings: { ...await invoke("get_settings"), showWelcome: false } });
for (const name of ["legacy-scripts", "agent-ready-service", "inventory-gradle-multi", "platform-monorepo", "orders-api", "storefront-web", "billing-service"]) {
  await invoke("open_browsed_project", { path: join(work, "projects", name) });
}

const { send, page, until, click, type, shot, close } = await openBrowser({
  out: join(root, "docs/media"), width: 1440, height: 900, scale: 1,
});

try {
  await send("Page.navigate", { url });
  await until(`document.querySelector(".sidebar-item")`, "sidebar");
  await click("My skills", ".sidebar-item");
  await until(`document.querySelectorAll(".mach-item").length === 3`, "three machine skills");
  assert.equal(await page(`document.querySelector('[role=tab][aria-selected=true]').textContent.includes('On this machine')`), true);
  assert.equal(await page(`document.querySelectorAll('.mach-shared').length`), 3);
  await page(`document.querySelector('[aria-label="Find a global skill"]').focus()`);
  await type("liquibase");
  await until(`document.querySelectorAll('.mach-item').length === 1`, "global skill search");
  await page(`document.querySelector('[aria-label="Find a global skill"]').select()`);
  await page(`document.execCommand('delete')`);
  await until(`document.querySelectorAll('.mach-item').length === 3`, "all machine skills");
  await page(`document.activeElement.blur()`);
  await shot("my-skills-refresh/after-skills.jpg");

  await click("History and restore");
  await until(`document.querySelectorAll('[role=dialog] .history-row').length === 3`, "machine history");
  await click("Can restore", "[role=dialog] button");
  await until(`document.querySelectorAll('[role=dialog] .history-row').length === 3`, "restorable changes");
  await page(`document.querySelector('[role=dialog] .history-files').open = true`);
  await click("Check for interrupted operations", "[role=dialog] button");
  await until(`document.querySelector('.history-checked')?.textContent.includes('No interrupted operations.')`, "recovery result");
  await shot("my-skills-refresh/after-history.jpg");
  await click("Close", "[role=dialog] button");

  await click("team-skills", ".sidebar-item");
  await until(`document.querySelector('.skill-title-row')`, "library");
  await page(`document.querySelector('[data-key="liquibase-migration-review"]').click()`);
  await until(`document.body.textContent.includes('Installed on this machine') && document.body.textContent.includes('Manage installation')`, "library machine status");
  await shot("pr-library-status/after.jpg");
  await page(`document.querySelector('.sidebar-version').click()`);
  await until(`document.querySelector('#whatsnew') && document.querySelector('.timeline-version')?.textContent === ${JSON.stringify(expected)}`, "current What's new version");
  await until(`document.querySelector('.about-notes')?.textContent.includes('Check a library for updates whenever you need to.') && document.querySelector('.about-notes')?.textContent.includes('Global skill badges reflect your choices.')`, "current release notes");
  console.log(`Verified Habi ${expected}: machine collection default, three selected-agent installs, shared-folder explanations, global search, history filters, expanded paths, recovery result, library management link.`);
} finally {
  await close();
}
