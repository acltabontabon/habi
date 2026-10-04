#!/usr/bin/env node
// Renders the film (docs/media/demo.mp4, with a poster, a GIF and the chapter times) from
// scripts/film/: the scenes in film.js are a function of time, so this steps through them frame by
// frame in headless Chrome and encodes what it sees. The screens it films are the app's own,
// photographed by scripts/marketing-shots.mjs into scripts/film/shots/dark/ (run that first); the
// sound is scripts/film/score.mjs.
//
//   node scripts/render-film.mjs                       # the whole film
//   node scripts/render-film.mjs --stills 3,9.6,20     # one picture per time (seconds), to look at
//   node scripts/render-film.mjs --poster               # only the poster (timeline.json says which moment)
//
// Needs ffmpeg on the PATH, and `pnpm install` in website/ (the film uses its fonts and tokens).
// CHROME_PATH chooses another Chrome or Chromium. No dependency beyond Node 24 and ffmpeg.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const film = join(root, "scripts/film");
const out = join(root, "docs/media");
const args = process.argv.slice(2);
const posterOnly = args.includes("--poster");
const stills = args.includes("--stills") ? args[args.indexOf("--stills") + 1].split(",").map(Number) : null;
const timeline = JSON.parse(readFileSync(join(film, "timeline.json"), "utf8"));
const { fps, width, height } = timeline;

/* ── Serve the film page: its own files, the site's tokens and fonts, and the photographed screens ── */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff" };
const files = {
  "/": join(film, "index.html"),
  "/ad.js": join(film, "ad.js"),
  "/film.css": join(film, "film.css"),
  "/timeline.json": join(film, "timeline.json"),
  "/tokens.css": join(root, "website/src/styles/tokens.css"),
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = files[path];
  if (!file && path.startsWith("/npm/")) file = join(root, "website/node_modules", path.slice(5));
  if (!file && path.startsWith("/shots/")) file = join(film, "shots/dark", path.slice(7));
  if (!file && path.startsWith("/docs-media/")) file = join(root, "docs/media", path.slice(12));
  if (!file || path.includes("..") || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/`;

const { send, page, until, close } = await openBrowser({ out, width, height, scale: 1, motion: true, scheme: "dark" });
const frame = async (t, quality = 92) => {
  await page(`window.film.seek(${t})`);
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality });
  return Buffer.from(data, "base64");
};

try {
  await send("Page.navigate", { url });
  await until(`window.film && window.film.ready`, "the film page");
  await page(`window.film.ready.then(() => true)`);

  if (posterOnly) {
    await page("window.film.poster()");
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    writeFileSync(join(out, "demo-poster.jpg"), Buffer.from(data, "base64"));
    console.log("docs/media/demo-poster.jpg");
  } else if (stills) {
    const dir = join(process.env.TMPDIR ?? tmpdir(), "habi-film-stills");
    mkdirSync(dir, { recursive: true });
    for (const t of stills) {
      const file = join(dir, `t${String(t).replace(".", "_").padStart(5, "0")}.jpg`);
      writeFileSync(file, await frame(t));
      console.log(file);
    }
  } else {
    const dir = mkdtempSync(join(tmpdir(), "habi-film-"));
    const total = Math.round(timeline.duration * fps);
    for (let n = 0; n < total; n++) {
      writeFileSync(join(dir, `f${String(n).padStart(5, "0")}.jpg`), await frame(n / fps));
      if (n % 60 === 0) console.log(`frame ${n}/${total}`);
    }
    mkdirSync(out, { recursive: true });
    const ff = (...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { stdio: "inherit" });
    const frames = ["-framerate", String(fps), "-i", join(dir, "f%05d.jpg")];

    // The sound, if the score has been made (node scripts/film/score.mjs).
    const score = join(film, "score.wav");
    const sound = existsSync(score) ? ["-i", score, "-c:a", "aac", "-b:a", "160k", "-shortest"] : ["-an"];
    // Flat colour and hard edges: x264's animation tuning, at full size and a high quality.
    ff(...frames, ...sound, "-c:v", "libx264", "-preset", "slower", "-tune", "animation", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(out, "demo.mp4"));
    console.log("docs/media/demo.mp4");

// A GIF for places that cannot play video (the README): a teaser, the opening seconds, silent.
    const [g0, g1] = timeline.gif ?? [0, 10];
    ff("-ss", String(g0), "-t", String(g1 - g0), ...frames, "-vf", "fps=12,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", join(out, "demo.gif"));
    console.log("docs/media/demo.gif");

    // The poster: the hero frame of the film (timeline.json says when).
    await page("window.film.poster()");
    writeFileSync(join(out, "demo-poster.jpg"), Buffer.from((await send("Page.captureScreenshot", { format: "jpeg", quality: 92 })).data, "base64"));
    console.log("docs/media/demo-poster.jpg");

    // The chapters, for the page that plays it, each with the moment its still is taken from.
    const chapters = timeline.scenes.filter((s) => s.chapter).map((s) => ({ title: s.chapter, at: s.start, still: s.still ?? s.start + 2 }));
    writeFileSync(join(out, "demo.json"), `${JSON.stringify({ seconds: timeline.duration, chapters }, null, 2)}\n`);
    console.log("docs/media/demo.json");
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  await close();
  server.close();
}
