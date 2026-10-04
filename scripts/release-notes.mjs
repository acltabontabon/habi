#!/usr/bin/env node
/**
 * Writes the text of a GitHub release: a banner, the film, a table of downloads, the changelog
 * entry, a look inside the app, and the things people ask before they install. The release
 * workflow runs it, so every release page has the same layout; the words that change are the
 * changelog's.
 *
 * Usage: node scripts/release-notes.mjs <tag> <folder> [owner/repo] > body.md
 *        node scripts/release-notes.mjs --sample [tag] [--ref main]   a preview with typical file names
 *
 * `folder` holds the installers the build jobs collected (only their names and sizes are read).
 * The pictures are the repository's own, at the tag, so the page never changes under a release.
 * GitHub allows a few HTML elements in release text, which is what gives the page its alignment:
 * `align` on a div, tables for the download and the gallery, and `<details>` for the long parts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "./changelog.mjs";

const SITE = "https://acltabontabon.com/habi/";

/** What a first look at the app shows, in the order a person meets it. Pictures are in docs/media. */
export const GALLERY = [
  ["project.jpg", "Fits, and why", "Every skill matched to the repository, with the files and lines behind it."],
  ["explore.jpg", "Every library in one place", "Your team's, the community's and the tool builders'."],
  ["install-review.jpg", "See every file first", "Install for seven agent tools; nothing is written until you say so."],
  ["update-review.jpg", "Updates you choose", "Review exactly what changes, per agent tool, before it is written."],
  ["skill-studio.jpg", "The Skill Studio", "Write a skill as one document and test when it would be suggested."],
  ["share-review.jpg", "Send it back", "Preview what leaves your machine, then open a pull request."],
];

export function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The installers people choose between, in the order they are listed. */
const INSTALLERS = [
  { match: /\.dmg$/, system: "macOS", detail: "11 or later · Apple Silicon and Intel", note: "Recommended" },
  { match: /-setup\.exe$/, system: "Windows", detail: "64-bit · installer", note: "Recommended" },
  { match: /\.msi$/, system: "Windows", detail: "64-bit · MSI, for managed installs", note: "" },
];

/**
 * The changelog is wrapped by hand for the editor; a release page turns every line break into a
 * hard one, so continuation lines are joined, and bullets are spaced apart to breathe.
 */
export function reflow(markdown) {
  const out = [];
  for (const line of markdown.split("\n")) {
    const last = out.at(-1);
    if (/^ {2,}\S/.test(line) && last?.trim() && !/^\s*[-*] /.test(line)) out[out.length - 1] = `${last} ${line.trim()}`;
    else {
      if (/^[-*] /.test(line) && /^[-*] /.test(last ?? "")) out.push("");
      out.push(line);
    }
  }
  return out.join("\n");
}

const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * @param {{ version: string, date: string, repo: string, notes: string, files: Record<string, number>,
 *           previous?: string, ref?: string }} input  `files` maps each installer's name to its size in
 *   bytes; `ref` is the Git ref the pictures are read from (the tag, unless previewing before it exists).
 */
export function buildReleaseNotes({ version, date, repo, notes, files, previous, ref }) {
  const tag = `v${version}`;
  const raw = (file) => `https://github.com/${repo}/raw/${ref ?? tag}/docs/media/${file}`;
  const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const names = Object.keys(files);
  const badge = (label, message, color = "d9913f") =>
    `<img alt="${label} ${message}" src="https://img.shields.io/badge/${encodeURIComponent(label).replace(/-/g, "--")}-${encodeURIComponent(message).replace(/-/g, "--")}-${color}?style=flat-square&labelColor=1f1c19">`;

  const rows = INSTALLERS.flatMap(({ match, system, detail, note }) => {
    const name = names.find((n) => match.test(n));
    if (!name) return [];
    return [
      `<tr>
<td><b>${system}</b><br><sub>${detail}</sub></td>
<td><a href="${download(name)}"><code>${esc(name)}</code></a>${note ? `<br><sub>${note}</sub>` : ""}</td>
<td align="right">${size(files[name])}</td>
</tr>`,
    ];
  });

  const lede = previous
    ? "Habi is a local desktop app for the skills and instructions you give AI coding agents."
    : "The first release of Habi, a local desktop app for the skills and instructions you give AI coding agents.";

  const gallery = [];
  for (let i = 0; i < GALLERY.length; i += 2) {
    const cells = GALLERY.slice(i, i + 2).map(
      ([file, title, line]) =>
        `<td width="50%" valign="top"><img src="${raw(file)}" alt="${esc(title)}" width="100%"><br><b>${esc(title)}</b><br><sub>${esc(line)}</sub></td>`,
    );
    gallery.push(`<tr>\n${cells.join("\n")}\n</tr>`);
  }

  const checksums = names.some((n) => /^SHA256SUMS/.test(n));
  const more = names.filter((n) => !INSTALLERS.some((i) => i.match.test(n)));

  return `<div align="center">

<img src="${raw("release-banner.jpg")}" alt="Habi. Find what applies. Improve what works. Share what you learn." width="100%">

# Habi ${version}

${lede}<br>No account, no telemetry, no model calls. Your repository is read, never run.

${badge("macOS", "11+")} ${badge("Windows", "64-bit")} ${badge("agents", "7 tools")} ${badge("license", "Apache-2.0")}

&nbsp;

<a href="${SITE}#demo"><img src="${raw("demo.gif")}" alt="The Habi film: skills stuck on one laptop, then Habi shows what fits a repository and why, installs for seven agents, and sends fixes back as pull requests." width="86%"></a>

<sub>The whole film, with sound, is <a href="${SITE}#demo">on the site</a>.</sub>

&nbsp;

## Download

<table>
<tr><th align="left">Your system</th><th align="left">Installer</th><th align="right">Size</th></tr>
${rows.join("\n")}
</table>

<sub>Not signed by Apple or Microsoft, so the first launch asks you to confirm once; <a href="#first-launch">how</a>. Updates after that are signed with Habi's own key.</sub>

&nbsp;

</div>

## What's new in ${version}

${reflow(notes)}

<br>

<div align="center">

## A look inside

<table>
${gallery.join("\n")}
</table>

</div>

<br>

## Before you install

<details id="first-launch">
<summary><b>First launch on macOS and Windows</b></summary>
<br>

The installers are not signed by Apple or Microsoft, by choice: Habi is published on GitHub only. You confirm once.

- **macOS:** open Habi. When macOS says it cannot check it, go to **System Settings → Privacy & Security** and choose **Open Anyway** next to Habi. Or, in Terminal: \`xattr -dr com.apple.quarantine /Applications/Habi.app\`
- **Windows:** when SmartScreen says *Windows protected your PC*, choose **More info**, then **Run anyway**.

Updates after that are signed with Habi's own key and checked before they install. Full walkthrough: [Getting started](${SITE}docs/getting-started/#installing).

</details>

<details>
<summary><b>Verify your download</b></summary>
<br>

${checksums ? "Every file is listed with its SHA-256 in `SHA256SUMS-macos.txt` and `SHA256SUMS-windows.txt` below.\n\n" : ""}Every file also carries a build provenance attestation that ties it to this repository's release workflow:

\`\`\`sh
gh attestation verify <file> --repo ${repo}
\`\`\`

</details>

<details>
<summary><b>Build from source instead</b></summary>
<br>

You need Rust (the pinned version installs itself), Node.js 24 or later, Git and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

\`\`\`sh
git clone https://github.com/${repo}.git
cd habi/apps/desktop
corepack enable
pnpm install
pnpm tauri dev
\`\`\`

</details>
${
  more.length
    ? `
<sub>Also attached: the checksums, and the update packages that a copy of Habi already running downloads when you press Update.</sub>
`
    : ""
}
<br>

<div align="center">

${[
    `<a href="${SITE}docs/">Documentation</a>`,
    `<a href="${SITE}docs/security-model/">Security model</a>`,
    `<a href="https://github.com/${repo}/blob/${tag}/CHANGELOG.md">Changelog</a>`,
    `<a href="https://github.com/${repo}/issues/new/choose">Report an issue</a>`,
    ...(previous ? [`<a href="https://github.com/${repo}/compare/v${previous}...${tag}">All changes since ${previous}</a>`] : []),
  ].join(" · ")}

<sub>Habi ${version}, released ${date}. Made by <a href="https://github.com/acltabontabon">Alvin Cris Tabontabon</a> in their own time. If it saves you some, <a href="https://ko-fi.com/aclt_attic">buy them a coffee</a>.</sub>

</div>
`;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const refAt = argv.indexOf("--ref");
  const ref = refAt >= 0 ? argv.splice(refAt, 2)[1] : undefined;
  const sample = argv[0] === "--sample";
  const [tag, folder, repo = "acltabontabon/habi"] = sample ? [argv[1] ?? "v0.1.0"] : argv;
  if (!tag?.startsWith("v") || (!sample && !folder)) {
    throw new Error("usage: node scripts/release-notes.mjs <tag> <folder> [owner/repo]");
  }
  const version = tag.slice(1);
  const { releases } = parseChangelog(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  const index = releases.findIndex((r) => r.version === version);
  if (index < 0) throw new Error(`CHANGELOG.md has no “## ${version} - YYYY-MM-DD” entry`);
  const release = releases[index];
  const previous = releases.slice(index + 1).find((r) => !r.prerelease)?.version;

  const files = sample
    ? {
        [`Habi_${version}_universal.dmg`]: 41 * 1024 ** 2,
        [`Habi_${version}_x64-setup.exe`]: 19 * 1024 ** 2,
        [`Habi_${version}_x64_en-US.msi`]: 20 * 1024 ** 2,
        "SHA256SUMS-macos.txt": 400,
        "SHA256SUMS-windows.txt": 400,
        "latest.json": 900,
      }
    : Object.fromEntries(readdirSync(folder).map((n) => [n, statSync(path.join(folder, n)).size]));

  process.stdout.write(
    buildReleaseNotes({ version, date: release.date, repo, notes: release.markdown, files, previous, ref }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-notes: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
