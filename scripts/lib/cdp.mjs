// Drives the running app in headless Chrome over the DevTools protocol, for the scripts that take
// the screenshots in docs/media/. No dependency beyond Node 24.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const PORT = 9337;

const chromes = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  win32: [`${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`],
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Takes away what only a development setup shows, and any toast still on screen. Runs in the
 * page, so it is passed there as source.
 */
function tidyPage(home, work) {
  for (const b of document.querySelectorAll(".toasts [aria-label=Dismiss]")) b.click();
  const shown = "~/Library/Application Support/com.acltabontabon.Habi";
  // The data folder is shown as a Mac's real one; the folder holding libraries and projects beside it
  // (HABI_SHOTS_ROOT) as a plain `~/work`. The data folder comes first, as it is inside the other.
  const homes = [];
  for (const [path, as] of [[home, shown], [work, "~/work"]])
    if (path) homes.push([path, as], [path.replace(/^\/private/, ""), as]);
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    let text = n.nodeValue.replace(/(\d+\.\d+\.\d+)-bridge/, "$1");
    for (const [path, as] of homes) text = text.replaceAll(path, as);
    if (text !== n.nodeValue) n.nodeValue = text;
  }
  return true;
}

/**
 * Starts Chrome and returns the helpers that drive it: `page`, `until`, `click`, `type`, `shot` and
 * `close`. Pictures are written to `out`.
 */
export async function openBrowser({ out, width = 1440, height = 900, scale = 2, motion = false, scheme = "light" }) {
  const chrome =
    process.env.CHROME_PATH ?? (chromes[process.platform] ?? []).find((p) => existsSync(p)) ?? "google-chrome";

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

  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((ok, fail) => {
        socket.onopen = ok;
        socket.onerror = fail;
      });
      ws = socket;
    } catch {
      await sleep(200);
    }
  }
  if (!ws) {
    browser.kill();
    throw new Error(`Chrome did not start (${chrome}). Set CHROME_PATH.`);
  }

  let next = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const message = JSON.parse(e.data);
    const done = waiting.get(message.id);
    if (!done) return;
    waiting.delete(message.id);
    if (message.error) done.fail(new Error(`${done.method}: ${message.error.message}`));
    else done.ok(message.result);
  };
  function send(method, params = {}) {
    const id = ++next;
    return new Promise((ok, fail) => {
      waiting.set(id, { ok, fail, method });
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

  /** Scrolls the first element matching `selector` whose text starts with `text` to the top. */
  async function scrollTo(selector, text = "") {
    const found = await page(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!el) return false;
      el.scrollIntoView({ block: "start" });
      return true;
    })()`);
    if (!found) throw new Error(`Nothing to scroll to: ${selector} "${text}"`);
  }

  async function shot(name) {
    await page(`(${tidyPage.toString()})(${JSON.stringify(process.env.HABI_HOME ?? "")}, ${JSON.stringify(process.env.HABI_SHOTS_ROOT ?? "")})`);
    // Fonts, images and the last frame of anything that eased in.
    await page("document.fonts.ready.then(() => true)");
    await sleep(600);
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
    writeFileSync(join(out, name), Buffer.from(data, "base64"));
    console.log(relative(process.cwd(), join(out, name)));
  }

  async function close() {
    ws.close();
    browser.kill();
    // Chrome may still be writing its profile as it exits.
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }

  mkdirSync(out, { recursive: true });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: motion ? "no-preference" : "reduce" },
    ],
  });

  return { send, page, until, click, type, scrollTo, shot, close };
}
