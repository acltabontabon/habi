#!/usr/bin/env node
/**
 * Writes the text of a GitHub release: a table of downloads, the changelog entry, and how to verify
 * a download. The release workflow runs it, so every release page has the same layout; the words
 * that change are the changelog's.
 *
 * Usage: node scripts/release-notes.mjs <tag> <folder> [owner/repo] > body.md
 *        node scripts/release-notes.mjs --sample [tag]   a preview with typical file names
 *
 * `folder` holds the installers the build jobs collected (only their names and sizes are read).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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
  { match: /\.dmg$/, system: "macOS 11 or later, Apple Silicon and Intel" },
  { match: /-setup\.exe$/, system: "Windows, 64-bit" },
  { match: /\.msi$/, system: "Windows, 64-bit, MSI for managed installs" },
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

/**
 * @param {{ version: string, repo: string, notes: string, files: Record<string, number>, previous?: string }} input
 *   `files` maps each installer's name to its size in bytes.
 */
export function buildReleaseNotes({ version, repo, notes, files, previous }) {
  const tag = `v${version}`;
  const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const names = Object.keys(files);

  const rows = INSTALLERS.flatMap(({ match, system }) => {
    const name = names.find((n) => match.test(n));
    return name ? [`| ${system} | [\`${name}\`](${download(name)}) | ${size(files[name])} |`] : [];
  });

  const lede = previous
    ? "Habi is a local desktop app for the skills and instructions you give AI coding agents."
    : "The first release of Habi, a local desktop app for the skills and instructions you give AI coding agents.";

  const checksums = names.some((n) => /^SHA256SUMS/.test(n));
  const more = names.some((n) => !INSTALLERS.some((i) => i.match.test(n)));

  const verify = [
    checksums ? "Every file is listed with its SHA-256 in `SHA256SUMS-macos.txt` and `SHA256SUMS-windows.txt`, and carries" : "Every file carries",
    "a build provenance attestation that ties it to this repository's release workflow:",
  ].join(" ");

  return `${lede} No account, no telemetry, no model calls. Your repository is inspected without executing its code.

## Download

| System | Installer | Size |
|---|---|---|
${rows.join("\n")}

**First launch:** the installers are not signed by Apple or Microsoft, so your system asks you to confirm once ([how](${SITE}docs/getting-started/#installing)). Updates after that are signed with Habi's own key.
${previous ? `
**Upgrading from ${previous}?** Back up your original drafts and contributions before installing ([how](https://github.com/${repo}/blob/${tag}/docs/guide/recovery.md#back-up-and-restore-all-local-data)).
` : ""}
## What's new in ${version}

${reflow(notes)}

## Verify your download

${verify}

\`\`\`sh
gh attestation verify <file> --repo ${repo}
\`\`\`
${more ? "\nThe other attachments are the checksums, and the update packages that a copy of Habi already running downloads when you press Update.\n" : ""}
---

${[
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

  process.stdout.write(buildReleaseNotes({ version, repo, notes: release.markdown, files, previous }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-notes: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
