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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/media");
const url = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 9337;

const chromes = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  win32: [`${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`],
};
const chrome =
  process.env.CHROME_PATH ?? (chromes[process.platform] ?? []).find((p) => existsSync(p)) ?? "google-chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "habi-shots-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((ok, fail) => {
        socket.onopen = ok;
        socket.onerror = fail;
      });
      return socket;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Chrome did not start (${chrome}). Set CHROME_PATH.`);
}

let next = 0;
const waiting = new Map();
function send(method, params = {}) {
  if (!ws.onmessage) {
    ws.onmessage = (e) => {
      const message = JSON.parse(e.data);
      const done = waiting.get(message.id);
      if (!done) return;
      waiting.delete(message.id);
      if (message.error) done.fail(new Error(`${method}: ${message.error.message}`));
      else done.ok(message.result);
    };
  }
  const id = ++next;
  return new Promise((ok, fail) => {
    waiting.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Runs `expression` in the page and returns its value. */
async function page(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/** Waits until `expression` is true in the page, saying what it waited for if it never is. */
async function until(expression, what, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page(`Boolean(${expression})`)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Clicks the first visible control whose text starts with `text` (or holds it, for sidebar
 * rows, whose text starts with a project's initials).
 */
async function click(text, selector = "button, a, [role=menuitem], [role=option]") {
  const contains = selector === ".sidebar-item";
  const found = await page(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.offsetParent !== null && (${contains}
        ? e.textContent.includes(${JSON.stringify(text)})
        : e.textContent.trim().startsWith(${JSON.stringify(text)})));
    if (!el) return false;
    el.scrollIntoView({ block: "nearest" });
    el.click();
    return true;
  })()`);
  if (!found) throw new Error(`Nothing to click that says "${text}"`);
}

/** Types into the focused field, as a keyboard would. */
async function type(text) {
  await send("Input.insertText", { text });
}

/**
 * Takes away what only a development setup shows, and any toast still on screen. Runs in the
 * page, so it is passed there as source.
 */
function tidyPage(home) {
  for (const b of document.querySelectorAll(".toasts [aria-label=Dismiss]")) b.click();
  const shown = "~/Library/Application Support/com.acltabontabon.Habi";
  const homes = home ? [home, home.replace(/^\/private/, "")] : [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    let text = n.nodeValue.replace(/(\d+\.\d+\.\d+)-bridge/, "$1");
    for (const h of homes) text = text.replaceAll(h, shown);
    if (text !== n.nodeValue) n.nodeValue = text;
  }
  return true;
}

async function tidy() {
  await page(`(${tidyPage.toString()})(${JSON.stringify(process.env.HABI_HOME ?? "")})`);
}

async function shot(name) {
  await tidy();
  // Fonts, images and the last frame of anything that eased in.
  await page("document.fonts.ready.then(() => true)");
  await sleep(600);
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
  writeFileSync(join(out, name), Buffer.from(data, "base64"));
  console.log(`docs/media/${name}`);
}

async function run() {
  mkdirSync(out, { recursive: true });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
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

let ws;
try {
  ws = await connect();
  await run();
} finally {
  ws?.close();
  browser.kill();
  // Chrome may still be writing its profile as it exits.
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
