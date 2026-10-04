#!/usr/bin/env node
/**
 * The pictures and the film on the landing page, made from the ones the screenshot script took.
 *
 * The site is dark only. Its pictures are scripts/film/shots/dark/, which Git ignores, so take them
 * with `scripts/docs-screenshots.mjs` (HABI_SHOTS_SCHEME=dark) first; a picture with no dark twin
 * falls back to the docs' light one (docs/media/). They are shrunk to public/media/dark/ (width
 * 1800, JPEG). The film (docs/media/demo.mp4, from scripts/render-film.mjs), its poster and its
 * chapter times are copied beside them, unchanged. Run this after retaking either. Needs ffmpeg.
 *
 *   pnpm media
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, "../../docs/media");
const dark = resolve(here, "../../scripts/film/shots/dark");
const to = resolve(here, "../public/media");

// What each step of the tour shows. The sharing picture has no dark twin: it needs a GitHub repository.
const SHOTS = ["explore", "project", "install-review", "skill-studio", "update-review", "share-review-status"];

const shrink = (from, name) => {
  mkdirSync(join(to, "dark"), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", from, "-vf", "scale=1800:-2:flags=lanczos", "-q:v", "4", join(to, "dark", `${name}.jpg`)], { stdio: "inherit" });
  console.log(`public/media/dark/${name}.jpg`);
};

// The sharing picture has no dark twin: it needs a GitHub repository.
for (const name of SHOTS) {
  const twin = join(dark, `${name}.jpg`);
  if (existsSync(twin)) shrink(twin, name);
  else {
    console.warn(`  no dark ${name}: the page will show the docs' light one`);
    shrink(join(docs, `${name}.jpg`), name);
  }
}

mkdirSync(to, { recursive: true });
copyFileSync(join(docs, "demo-poster.jpg"), join(to, "demo-poster.jpg"));
console.log("public/media/demo-poster.jpg");

// The film is served as it was made: its quality is the point, and the loom on the page covers the wait.
copyFileSync(join(docs, "demo.mp4"), join(to, "demo.mp4"));
console.log("public/media/demo.mp4");

// The chapters of the film, which the page reads at build time.
copyFileSync(join(docs, "demo.json"), resolve(here, "../src/data/demo.json"));
console.log("src/data/demo.json");
