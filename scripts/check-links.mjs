#!/usr/bin/env node
// Checks that relative links in the repository's Markdown resolve: the file or folder
// exists, and a `#fragment` names a heading (or an explicit anchor) in the target file.
// Also checks that every `docs/….md` path named in Markdown, workflows, the website and
// Rust comments exists. No network access; external URLs are not checked.
//
// Usage: node scripts/check-links.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Test data may contain broken links on purpose; generated files are not ours to fix.
const skipped = [/^fixtures\//, /^THIRD_PARTY_NOTICES\.md$/, /\/node_modules\//];

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path && existsSync(join(root, path)) && !skipped.some((re) => re.test(path)));

const markdown = tracked.filter((path) => path.endsWith(".md"));
const problems = [];

/** Markdown text with fenced code blocks and HTML comments blanked out (line numbers kept). */
function prose(text) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[`~]*[ \t]*$/gm, blank);
}

/** GitHub's heading anchors for a Markdown file. */
const anchorCache = new Map();
function anchors(path) {
  if (anchorCache.has(path)) return anchorCache.get(path);
  const text = prose(readFileSync(join(root, path), "utf8"));
  const seen = new Map();
  const result = new Set();
  for (const [, heading] of text.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const plain = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*]/g, "");
    const base = plain
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const [, id] of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) result.add(id);
  anchorCache.set(path, result);
  return result;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function checkTarget(source, line, target) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
  const [rawPath, fragment] = target.split("#", 2);
  const path = decodeURIComponent(rawPath.split("?")[0]);
  if (path.startsWith("/")) {
    problems.push(`${source}:${line}: absolute link ${target} (use a relative path)`);
    return;
  }
  const resolved = path === "" ? join(root, source) : resolve(join(root, dirname(source)), path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || !existsSync(resolved)) {
    problems.push(`${source}:${line}: ${target} does not exist`);
    return;
  }
  if (fragment && rel.endsWith(".md") && statSync(resolved).isFile()) {
    if (!anchors(rel).has(decodeURIComponent(fragment).toLowerCase())) {
      problems.push(`${source}:${line}: ${target} — no heading #${fragment} in ${rel}`);
    }
  }
}

for (const source of markdown) {
  const text = prose(readFileSync(join(root, source), "utf8"));
  // Inline links and images: [text](target "title") and ![alt](<target>).
  for (const match of text.matchAll(/!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1].replace(/^<|>$/g, "");
    checkTarget(source, lineOf(text, match.index), target);
  }
  // Reference definitions: [label]: target
  for (const match of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)) {
    checkTarget(source, lineOf(text, match.index), match[1].replace(/^<|>$/g, ""));
  }
}

// Paths to docs named in prose, comments and configuration: `docs/guide/recovery.md`.
const mentionFiles = tracked.filter(
  (path) =>
    path.endsWith(".md") ||
    path.startsWith(".github/") ||
    (path.startsWith("website/") && /\.(astro|ts|mjs|json|sh)$/.test(path)) ||
    path.startsWith("schema/") ||
    path.startsWith("scripts/") ||
    (path.startsWith("crates/") && path.endsWith(".rs")) ||
    (path.startsWith("apps/desktop/src-tauri/") && path.endsWith(".rs")),
);
for (const source of mentionFiles) {
  let text = readFileSync(join(root, source), "utf8");
  // Markdown links were checked above; look only at the prose around them.
  if (source.endsWith(".md")) text = prose(text).replace(/\]\([^)]*\)/g, "]");
  const rust = source.endsWith(".rs");
  text.split("\n").forEach((line, index) => {
    // In Rust, only comments name documentation; string literals are test data.
    const scope = rust ? (line.match(/\/\/.*$/)?.[0] ?? "") : line;
    for (const [, path] of scope.matchAll(/(?<![\w./-])(docs\/[\w./-]+\.md)/g)) {
      if (!existsSync(join(root, path))) problems.push(`${source}:${index + 1}: ${path} does not exist`);
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken link(s).`);
  process.exit(1);
}
console.log(`Links OK (${markdown.length} Markdown files).`);
