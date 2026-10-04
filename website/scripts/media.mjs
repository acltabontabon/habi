#!/usr/bin/env node
/**
 * The pictures and the film on the landing page, made from the ones the screenshot script took.
 *
 * Light pictures are the docs' (docs/media/); dark ones are scripts/film/shots/dark/, which Git
 * ignores, so take them with `scripts/docs-screenshots.mjs` (HABI_SHOTS_SCHEME=dark) first. Both are
 * shrunk to public/media/<scheme>/ (width 1800, JPEG), and the page shows whichever the visitor's
 * system theme asks for. The film (docs/media/demo.mp4, from scripts/render-film.mjs), its poster and
 * its chapter times are copied beside them, and a still of each chapter is cut from it for the
 * filmstrip in the hero (public/media/film/). Run this after retaking either. Needs ffmpeg.
 *
 *   pnpm media
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, "../../docs/media");
const dark = resolve(here, "../../scripts/film/shots/dark");
const to = resolve(here, "../public/media");

// What each step of the tour shows. The sharing picture has no dark twin: it needs a GitHub repository.
const SHOTS = ["explore", "project", "install-review", "skill-studio", "update-review"];
const LIGHT_ONLY = ["share-review-status"];

const shrink = (from, name, scheme) => {
  mkdirSync(join(to, scheme), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", from, "-vf", "scale=1800:-2:flags=lanczos", "-q:v", "4", join(to, scheme, `${name}.jpg`)], { stdio: "inherit" });
  console.log(`public/media/${scheme}/${name}.jpg`);
};

for (const name of SHOTS) {
  shrink(join(docs, `${name}.jpg`), name, "light");
  if (existsSync(join(dark, `${name}.jpg`))) shrink(join(dark, `${name}.jpg`), name, "dark");
  else console.warn(`  no dark ${name}: the page will show the light one`);
}
for (const name of LIGHT_ONLY) {
  shrink(join(docs, `${name}.jpg`), name, "light");
  shrink(join(docs, `${name}.jpg`), name, "dark");
}

mkdirSync(to, { recursive: true });
for (const file of ["demo.mp4", "demo-poster.jpg"]) {
  copyFileSync(join(docs, file), join(to, file));
  console.log(`public/media/${file}`);
}

// The chapters of the film, which the page reads at build time.
copyFileSync(join(docs, "demo.json"), resolve(here, "../src/data/demo.json"));
console.log("src/data/demo.json");

// A still of each chapter, for the filmstrip.
const { chapters } = JSON.parse(readFileSync(join(docs, "demo.json"), "utf8"));
mkdirSync(join(to, "film"), { recursive: true });
chapters.forEach((c, i) => {
  const name = `${String(i + 1).padStart(2, "0")}.jpg`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(c.still), "-i", join(docs, "demo.mp4"), "-frames:v", "1", "-vf", "scale=960:-2:flags=lanczos", "-q:v", "4", join(to, "film", name)], { stdio: "inherit" });
  console.log(`public/media/film/${name}`);
});
