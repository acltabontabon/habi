#!/usr/bin/env node
/**
 * Writes what a release needs for Habi to update itself, from the installers the build jobs
 * collected into one folder:
 *
 *   latest.json        the manifest the app asks for (tauri.conf.json → plugins.updater.endpoints):
 *                      version, notes, date and, per platform, the installer's URL and signature
 *   release-notes.md   the release's section of CHANGELOG.md, for the GitHub release's text
 *
 * Usage: node scripts/updater-manifest.mjs <tag> <folder> [owner/repo]
 *        node scripts/updater-manifest.mjs --check <tag>     only that CHANGELOG.md has the entry
 *
 * The signatures are the `.sig` files `tauri build` writes when TAURI_SIGNING_PRIVATE_KEY is set.
 * It fails when a platform's installer or signature is missing, or the changelog has no entry for
 * the version, so a release never goes out that people cannot update to.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "./changelog.mjs";

/**
 * Each platform key the updater asks for, and the installer that serves it. macOS ships one
 * universal build, so both architectures point at it. Windows updates through the NSIS installer.
 */
export const PLATFORMS = [
  { keys: ["darwin-aarch64", "darwin-x86_64"], installer: /\.app\.tar\.gz$/ },
  { keys: ["windows-x86_64"], installer: /-setup\.exe$/ },
];

/**
 * @param {{ version: string, notes: string, date: string, repo: string, files: Record<string, string> }} input
 *   `files` maps each file name in the folder to its text for `.sig` files (others are ignored).
 */
export function buildManifest({ version, notes, date, repo, files }) {
  const names = Object.keys(files);
  const platforms = {};
  for (const { keys, installer } of PLATFORMS) {
    const found = names.filter((n) => installer.test(n));
    if (found.length !== 1) {
      throw new Error(`expected one installer matching ${installer}, found ${found.length}: ${found.join(", ") || "none"}`);
    }
    const name = found[0];
    const signature = files[`${name}.sig`]?.trim();
    if (!signature) throw new Error(`${name} has no signature (${name}.sig): was TAURI_SIGNING_PRIVATE_KEY set for the build?`);
    const url = `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`;
    for (const key of keys) platforms[key] = { signature, url };
  }
  return { version, notes, pub_date: `${date}T00:00:00Z`, platforms };
}

/** The changelog entry for a version, or an error that says what to add. */
export function releaseNotes(changelog, version) {
  const release = parseChangelog(changelog).releases.find((r) => r.version === version);
  if (!release) throw new Error(`CHANGELOG.md has no “## ${version} - YYYY-MM-DD” entry`);
  return release;
}

function main(argv) {
  const check = argv[0] === "--check";
  const [tag, folder, repo = "acltabontabon/habi"] = check ? argv.slice(1) : argv;
  if (!tag?.startsWith("v") || (!check && !folder)) {
    throw new Error("usage: node scripts/updater-manifest.mjs <tag> <folder> [owner/repo]");
  }
  const version = tag.slice(1);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const release = releaseNotes(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
  if (check) {
    console.log(`CHANGELOG.md has an entry for ${version} (${release.date})`);
    return;
  }
  const files = {};
  for (const name of readdirSync(folder)) {
    if (/\.app\.tar\.gz(\.sig)?$|-setup\.exe(\.sig)?$/.test(name)) {
      files[name] = name.endsWith(".sig") ? readFileSync(path.join(folder, name), "utf8") : "";
    }
  }
  const manifest = buildManifest({ version, notes: release.markdown, date: release.date, repo, files });
  writeFileSync(path.join(folder, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(folder, "release-notes.md"), `${release.markdown}\n`);
  console.log(`latest.json for ${version}: ${Object.keys(manifest.platforms).join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`updater-manifest: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
