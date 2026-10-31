#!/usr/bin/env node
/**
 * Writes the text of a GitHub release: the release's one line, a table of downloads, pictures of its
 * key features, the changelog entry, and how to verify a download. The release workflow runs it, so
 * every release page has the same layout; the words that change are the changelog's.
 *
 * Usage: node scripts/release-notes.mjs <tag> <folder> [owner/repo] > body.md
 *        node scripts/release-notes.mjs --sample [tag]   a preview with typical file names
 *
 * `folder` holds the installers the build jobs collected (only their names and sizes are read).
 * scripts/release-pictures.json names each version's pictures: the changelog can't hold them, since
 * the app renders it too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "./changelog.mjs";

const SITE = "https://acltabontabon.com/habi/";

export function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The installers people choose between, in the order they are listed. */
const INSTALLERS = [
  { match: /\.dmg$/, system: "**macOS** 11 or later, Apple Silicon and Intel" },
  { match: /-setup\.exe$/, system: "**Windows** 64-bit" },
  { match: /\.msi$/, system: "**Windows** 64-bit, MSI for managed installs" },
];

/** More fixes than this fold away, so a long list doesn't bury what follows it. */
const FIXES_SHOWN = 6;

const ABOUT = "a local desktop app for the skills and instructions you give AI coding agents";
const PROMISE = "No account, no telemetry, no model calls. Your repository is inspected without executing its code.";

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

/** Splits a changelog entry into its opening line, which leads the page, and its sections. */
export function splitEntry(markdown) {
  const start = markdown.search(/^### /m);
  if (start < 0) return { opening: "", sections: markdown };
  return { opening: markdown.slice(0, start).trim().replace(/\s*\n\s*/g, " "), sections: markdown.slice(start) };
}

/** Folds a long Fixed section. The other sections stay open: they are what a reader came for. */
export function foldFixes(markdown) {
  return markdown.replace(/^### Fixed\n+([\s\S]*?)(?=\n+### |\s*$(?![\s\S]))/m, (section, list) => {
    const count = list.match(/^- /gm)?.length ?? 0;
    if (count <= FIXES_SHOWN) return section;
    return `### Fixed\n\n<details>\n<summary>Show all ${count} fixes</summary>\n\n${list.trim()}\n\n</details>`;
  });
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A gallery two pictures wide, laid out like the README's. Each picture comes from the release's own
 * tag, so a page keeps showing the app as it was in that version.
 * @param {{ file: string, caption: string, alt: string }[]} pictures
 */
export function gallery(pictures, repo, tag) {
  const cell = ({ file, caption, alt }, width) =>
    `<td ${width} valign="top"><strong>${escapeHtml(caption)}</strong><br><img src="https://raw.githubusercontent.com/${repo}/${tag}/${file}" alt="${escapeHtml(alt)}" width="100%"></td>`;
  const rows = [];
  for (let i = 0; i < pictures.length; i += 2) {
    const pair = pictures.slice(i, i + 2);
    const width = pair.length === 2 ? 'width="50%"' : 'colspan="2"';
    rows.push("<tr>", ...pair.map((p) => cell(p, width)), "</tr>");
  }
  return ["<table>", ...rows, "</table>"].join("\n");
}

/**
 * @param {{ version: string, repo: string, notes: string, files: Record<string, number>, previous?: string, pictures?: { file: string, caption: string, alt: string }[] }} input
 *   `files` maps each installer's name to its size in bytes.
 */
export function buildReleaseNotes({ version, repo, notes, files, previous, pictures = [] }) {
  const tag = `v${version}`;
  const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const names = Object.keys(files);

  const rows = INSTALLERS.flatMap(({ match, system }) => {
    const name = names.find((n) => match.test(n));
    return name ? [`| ${system} | [\`${name}\`](${download(name)}) | ${size(files[name])} |`] : [];
  });

  const { opening, sections } = splitEntry(notes);
  const lead = previous
    ? [opening && `**${opening}**`]
    : [`**The first release of Habi, ${ABOUT}.**`, PROMISE];

  const checksums = names.some((n) => /^SHA256SUMS/.test(n));
  const more = names.some((n) => !INSTALLERS.some((i) => i.match.test(n)));

  const verify = [
    checksums ? "Every file is listed with its SHA-256 in `SHA256SUMS-macos.txt` and `SHA256SUMS-windows.txt`, and carries" : "Every file carries",
    "a build provenance attestation that ties it to this repository's release workflow:",
  ].join(" ");

  return `${lead.filter(Boolean).map((p) => `${p}\n\n`).join("")}## Download

| System | Installer | Size |
|:---|:---|---:|
${rows.join("\n")}

> [!NOTE]
> **First launch:** the installers are not signed by Apple or Microsoft, so your system asks you to confirm once ([how](${SITE}docs/getting-started/#installing)). Updates after that are signed with Habi's own key.

## What's new in ${version}

${pictures.length ? `${gallery(pictures, repo, tag)}\n\n` : ""}${foldFixes(reflow(sections))}

---

<details>
<summary><strong>Verify your download</strong></summary>

${verify}

\`\`\`sh
gh attestation verify <file> --repo ${repo}
\`\`\`
${more ? "\nThe other attachments are the checksums, and the update packages that a copy of Habi already running downloads when you press Update.\n" : ""}
</details>

${previous ? `**Habi** is ${ABOUT}. ${PROMISE}\n\n` : ""}${[
    `[Documentation](${SITE}docs/)`,
    `[Security model](${SITE}docs/security-model/)`,
    `[Changelog](https://github.com/${repo}/blob/${tag}/CHANGELOG.md)`,
    `[Report an issue](https://github.com/${repo}/issues/new/choose)`,
    ...(previous ? [`[All changes since ${previous}](https://github.com/${repo}/compare/v${previous}...${tag})`] : []),
  ].join(" · ")}

If Habi saves you time, [buy me a coffee](https://ko-fi.com/aclt_attic).
`;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

  const pictures = JSON.parse(readFileSync(path.join(root, "scripts/release-pictures.json"), "utf8"))[version] ?? [];
  // A preview may be of an older version; the real page must not publish a broken picture.
  const missing = sample ? [] : pictures.filter((p) => !existsSync(path.join(root, p.file)));
  if (missing.length) throw new Error(`release-pictures.json: no such file: ${missing.map((p) => p.file).join(", ")}`);

  process.stdout.write(buildReleaseNotes({ version, repo, notes: release.markdown, files, previous, pictures }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-notes: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
