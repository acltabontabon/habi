#!/usr/bin/env node
// The screenshots in docs/media/, taken from the running app with headless Chrome.
//
// It walks through the sample workspace the way a first-time user would: the welcome, the
// sample project, an item that fits, its install review, a library, and a new skill. So the
// pictures in the docs are the app as it is, and redoing them after a change is one command.
//
// Start the development bridge on an empty HABI_HOME, and the UI against it, then run this
// with the same HABI_HOME:
//
//   export HABI_HOME=$(mktemp -d)
//   HABI_USER_HOME=$(mktemp -d) cargo run -p habi-core --example dev_bridge
//   cd apps/desktop && VITE_HABI_BRIDGE=1 pnpm dev
//   node scripts/docs-screenshots.mjs [http://127.0.0.1:1420]
//
// The pages are captured at 1440×900 and twice that resolution, in the light theme, with motion
// reduced. What only the development setup shows is tidied first: the bridge's version suffix,
// and the throwaway HABI_HOME, written as the data folder a Mac really uses. CHROME_PATH chooses
// another Chrome or Chromium. No dependency beyond Node 24.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "http://127.0.0.1:1420";

const { send, page, until, click, type, shot, close } = await openBrowser({ out: join(root, "docs/media") });

async function run() {
  await send("Page.navigate", { url });

  // The welcome, as a first start shows it.
  await until(`document.querySelectorAll(".welcome .ws-tool").length >= 3`, "the welcome");
  await shot("welcome.jpg");
  await click("Get started");

  // The sample workspace opens its first project.
  await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("try the sample workspace"))`, "the start screen");
  await click("try the sample workspace");
  await until(`document.querySelector(".rec-row")`, "the sample project", 120000);
  await click("Liquibase migration review", ".rec-row");
  await until(`document.querySelector("#detail-title")?.textContent === "Liquibase migration review"`, "the item");
  await shot("project.jpg");

  // Its install review, once the plan is ready; then installed.
  await click("Review and install");
  await until(
    `document.querySelector("[role=dialog]") && !document.querySelector("[role=dialog]").textContent.includes("Preparing the preview")`,
    "the install review",
    60000,
  );
  await shot("install-review.jpg");
  await click("Install", "[role=dialog] button");
  await until(`!document.querySelector("[role=dialog]") && document.querySelector(".facet-detail .reach")`, "the install", 60000);
  await shot("installed.jpg");

  // Home: the projects woven with the libraries that fit them, once a few have been opened.
  for (const name of ["storefront-web", "platform-monorepo", "orders-api"]) {
    await click(name, ".sidebar-item");
    await until(
      `document.querySelector(".project-head h1")?.textContent.startsWith(${JSON.stringify(name)}) && document.querySelector(".rec-row")`,
      name,
      60000,
    );
  }
  await page(`document.querySelector(".sidebar-brand").click()`);
  await until(`document.querySelectorAll(".loom-row-label").length >= 7 && document.querySelector(".loom-float")`, "the loom");
  await shot("home.jpg");

  // A library, reading its first skill.
  await click("Sample team library", ".sidebar-item");
  await until(`document.querySelector(".skill-title-row")`, "the library");
  await shot("library.jpg");

  // A new skill in the Skill Studio, from one of the starter ideas, given its purpose.
  await click("My skills", ".sidebar-item");
  await until(`document.querySelector(".skills-idea")`, "the starter ideas");
  await page(`document.querySelector(".skills-idea").click()`);
  await until(`document.querySelector(".cm-editor")`, "the Skill Studio");
  await page(`document.querySelector("[placeholder^='What it helps with']")?.focus()`);
  await type("Reviews a pull request for correctness, risk and fit. Use when asked to review a change or a PR.");
  await until(`!document.body.textContent.includes("thing to finish")`, "the skill to be ready", 20000);
  await shot("skill-studio.jpg");
}

try {
  await run();
} finally {
  await close();
}
