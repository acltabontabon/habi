#!/usr/bin/env node
// The screenshots in docs/media/, and the dark ones the film and the landing page use: the app on a
// workspace that reads like a real team's (two libraries, seven projects, a few skills installed, an
// update waiting), photographed with headless Chrome at twice the resolution.
//
// Seed a workspace, run the development bridge on it and the UI against the bridge, then run this
// with HABI_SHOTS_ROOT set to the folder you seeded (a fresh one each time: the walk writes a skill):
//
//   export HABI_SHOTS_ROOT=$(mktemp -d)
//   scripts/film/seed.sh "$HABI_SHOTS_ROOT"
//   export HABI_HOME="$HABI_SHOTS_ROOT/habi-home"
//   HABI_USER_HOME=$(mktemp -d) HABI_BRIDGE_PORT=1440 cargo run -p habi-core --example dev_bridge
//   cd apps/desktop && VITE_HABI_BRIDGE=1 HABI_BRIDGE_PORT=1440 HABI_UI_PORT=1441 pnpm dev
//   node scripts/docs-screenshots.mjs http://127.0.0.1:1441 http://127.0.0.1:1440                       # light
//   HABI_SHOTS_SCHEME=dark node scripts/docs-screenshots.mjs http://127.0.0.1:1441 http://127.0.0.1:1440 # dark
//
// Light pictures go to docs/media/. Dark ones go to scripts/film/shots/dark/, which Git ignores: the film
// (scripts/render-film.mjs) films them and `pnpm media` in website/ shrinks them for the page. The
// sharing guide's pictures come from docs-screenshots-sharing.mjs and stay as they are.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "http://127.0.0.1:1420";
const bridge = process.argv[3] ?? "http://127.0.0.1:1430";
const work = process.env.HABI_SHOTS_ROOT;
if (!work) throw new Error("Set HABI_SHOTS_ROOT to the folder scripts/film/seed.sh made.");
const scheme = process.env.HABI_SHOTS_SCHEME === "dark" ? "dark" : "light";

const { send, page, until, click, type, shot, close } = await openBrowser({
  out: scheme === "dark" ? join(root, "scripts/film/shots/dark") : join(root, "docs/media"),
  scheme,
});

/** Opens the seeded projects, the way the app's own chooser does, so they are in the sidebar. */
async function openProjects() {
  for (const name of ["legacy-scripts", "agent-ready-service", "inventory-gradle-multi", "platform-monorepo", "orders-api", "storefront-web", "billing-service"]) {
    const reply = await fetch(`${bridge}/invoke`, {
      method: "POST",
      headers: { "X-Habi-Bridge": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "open_browsed_project", args: { path: join(work, "projects", name) } }),
    });
    const body = await reply.json();
    if (body.err) throw new Error(`${name}: ${body.err.message}`);
  }
}

async function run() {
  await openProjects();
  await send("Page.navigate", { url });

  // The welcome, as a first start shows it, then on to the workspace.
  await until(`document.querySelectorAll(".welcome .ws-tool").length >= 3`, "the welcome");
  await shot("welcome.jpg");
  await click("Get started");
  await until(`document.querySelector(".sidebar-item")`, "the sidebar");

  // My skills, empty: the page that says what a skill is.
  await click("My skills", ".sidebar-item");
  await until(`document.querySelector(".skills-idea")`, "the starter ideas");
  await shot("my-skills.jpg");

  // The Skill Studio, from a starter idea, given its purpose.
  await page(`document.querySelector(".skills-idea").click()`);
  await until(`document.querySelector(".cm-editor")`, "the Skill Studio");
  await page(`document.querySelector("[placeholder^='What it helps with']")?.focus()`);
  await type("Reviews a pull request for correctness, risk and fit. Use when asked to review a change or a PR.");
  await until(`!document.body.textContent.includes("thing to finish")`, "the skill to be ready", 20000);
  await shot("skill-studio.jpg");

  // A project: what fits, and why.
  await click("billing-service", ".sidebar-item");
  await until(`document.querySelector(".project-head h1")?.textContent.startsWith("billing-service") && document.querySelector(".rec-row")`, "billing-service", 90000);
  await click("Liquibase migration review", ".rec-row");
  await until(`document.querySelector("#detail-title")?.textContent === "Liquibase migration review"`, "the item");
  await shot("project.jpg");

  // Its install review, for a skill that is not installed yet.
  await click("JPA entity review", ".rec-row");
  await until(`document.querySelector("#detail-title")?.textContent === "JPA entity review"`, "the item");
  await click("Review and install");
  await until(
    `document.querySelector("[role=dialog]") && !document.querySelector("[role=dialog]").textContent.includes("Preparing the preview")`,
    "the install review",
    60000,
  );
  await shot("install-review.jpg");
  // ...and install it, so the project has three.
  await click("Install", "[role=dialog] button");
  await until(`!document.querySelector("[role=dialog]") && document.querySelector(".facet-detail .reach")`, "the install", 60000);

  // An update waiting: what changed upstream, before anything is written.
  await click("Liquibase migration review", ".rec-row");
  await until(`document.querySelector("#detail-title")?.textContent === "Liquibase migration review"`, "the item");
  await click("Review update…");
  await until(
    `document.querySelector("[role=dialog]") && !document.querySelector("[role=dialog]").textContent.includes("Preparing the preview")`,
    "the update review",
    60000,
  );
  // Opened on what changed in the skill itself.
  await page(`[...document.querySelectorAll("[role=dialog] .change-head")].find((b) => b.textContent.includes("SKILL.md"))?.click()`);
  await until(`document.querySelector("[role=dialog] .change-head[aria-expanded=true]")`, "the diff");
  await shot("update-review.jpg");
  await click("Cancel", "[role=dialog] button");
  await until(`!document.querySelector("[role=dialog]")`, "the review to close");

  // Home: every project woven with the libraries that fit it.
  for (const name of ["storefront-web", "platform-monorepo", "orders-api"]) {
    await click(name, ".sidebar-item");
    await until(`document.querySelector(".project-head h1")?.textContent.startsWith(${JSON.stringify(name)}) && document.querySelector(".rec-row")`, name, 90000);
  }
  await page(`document.querySelector(".sidebar-brand").click()`);
  await until(`document.querySelectorAll(".loom-row-label").length >= 7 && document.querySelector(".loom-float")`, "the loom");
  await shot("home.jpg");

  // Where all libraries come from.
  await click("team-skills", ".sidebar-item");
  await until(`document.querySelector(".skill-title-row")`, "the library");
  await click("Explore libraries", "button, a, [role=link]");
  await until(`document.body.textContent.includes("From the builders")`, "the catalog");
  await shot("explore.jpg");
}

try {
  await run();
} finally {
  await close();
}
