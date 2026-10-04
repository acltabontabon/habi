#!/usr/bin/env node
// Renders the banner at the top of every GitHub release (docs/media/release-banner.jpg) from the
// app's own screenshots in docs/media/, in headless Chrome. It carries no version, so one
// picture serves every release; scripts/release-notes.mjs links to it.
//
//   node scripts/release-banner.mjs
//
// Needs `pnpm install` in website/ for the font. CHROME_PATH chooses another Chrome or Chromium.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/media");
const mark = readFileSync(join(root, "design/habi-mark.svg"), "utf8");

const WIDTH = 1280;
const HEIGHT = 480;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: "Plex"; font-weight: 100 700; src: url(/npm/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2); }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #1f1c19; }
  body { position: relative; font-family: "Plex", "Helvetica Neue", sans-serif; color: #efe8d8; }
  /* A warm light behind the screens, the thread colour of the mark. */
  .glow { position: absolute; inset: 0;
    background: radial-gradient(60% 90% at 78% 55%, rgba(217, 145, 63, 0.30), transparent 70%),
                radial-gradient(40% 60% at 0% 0%, rgba(239, 232, 216, 0.06), transparent 70%); }
  .copy { position: absolute; left: 72px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 22px; }
  .brand svg { width: 84px; height: 84px; flex: none; filter: drop-shadow(0 10px 24px rgba(0, 0, 0, 0.45)); }
  .brand b { font-size: 76px; font-weight: 700; letter-spacing: -0.035em; line-height: 1; }
  .tag { margin-top: 30px; font-size: 31px; line-height: 1.22; font-weight: 600; letter-spacing: -0.015em; }
  .tag span { display: block; }
  .tag span:nth-child(2) { color: #d9913f; }
  .tag span:nth-child(3) { color: rgba(239, 232, 216, 0.62); }
  .sub { margin-top: 26px; font-size: 17px; line-height: 1.45; color: rgba(239, 232, 216, 0.66); max-width: 440px; }
  .win { position: absolute; border-radius: 14px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 40px 90px rgba(0, 0, 0, 0.55), 0 8px 24px rgba(0, 0, 0, 0.35); background: #f6f5f1; }
  .win img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: left top; }
  .back { left: 690px; top: 62px; width: 640px; height: 400px; opacity: 0.92; }
  .front { left: 640px; top: 118px; width: 640px; height: 400px; }
</style>
<div class="glow"></div>
<div class="win back"><img src="/media/project.jpg"></div>
<div class="win front"><img src="/media/home.jpg"></div>
<div class="copy">
  <div class="brand">${mark.replace(/<title>.*?<\/title>/s, "").replace(/<!--.*?-->/gs, "")}<b>Habi</b></div>
  <p class="tag"><span>Find what applies.</span><span>Improve what works.</span><span>Share what you learn.</span></p>
  <p class="sub">The skills and instructions you give your AI coding agents, matched to your repository.</p>
</div>`;

const TYPES = { ".woff2": "font/woff2", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file;
  if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html" }).end(html);
    return;
  }
  if (path.startsWith("/npm/")) file = join(root, "website/node_modules", path.slice(5));
  if (path.startsWith("/media/")) file = join(out, path.slice(7));
  if (!file || path.includes("..") || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));

const { send, page, close } = await openBrowser({ out, width: WIDTH, height: HEIGHT, scale: 2 });
try {
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await page(`(document.readyState === "complete" ? Promise.resolve() : new Promise((ok) => addEventListener("load", ok))).then(() => document.fonts.ready).then(() => true)`);
  await page(`Promise.all([...document.images].map((i) => i.decode())).then(() => true)`);
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
  writeFileSync(join(out, "release-banner.jpg"), Buffer.from(data, "base64"));
  console.log("docs/media/release-banner.jpg");
} finally {
  await close();
  server.close();
}
