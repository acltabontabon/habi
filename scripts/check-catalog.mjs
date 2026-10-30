#!/usr/bin/env node
// Checks that the catalog's picks and hints still point at real skills. Upstream repositories
// rename and move skills, and the app would go on offering a pick it cannot install. For each
// entry of crates/habi-core/catalog/sources.yaml: finds the revision Habi reads, lists its files
// through the GitHub API, reads the SKILL.md of every pick, and compares what the pick says about
// itself (`tokens`, `scripts`) with what is there. `caution` comes from Habi's own scan and is not
// checked here.
//
// What counts as a release, a match or a skill folder follows Habi's own rules, which are named
// where they are used here: a change to one should change the other.
//
// Usage: GITHUB_TOKEN=... node scripts/check-catalog.mjs
// The token is optional: a run costs about 50 GitHub API requests, and 60 an hour are allowed
// without one. Exits 1 if a pick, hint or pattern no longer resolves, or if an entry could not
// be checked; the report says which.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = "crates/habi-core/catalog/sources.yaml";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const SKILL_FILE = "SKILL.md";
const SYMLINK_MODE = "120000";
const EXECUTABLE_MODE = "100755";
// `ItemFile::is_code` in library/model.rs.
const CODE_EXTENSIONS = ["py", "sh", "bash", "zsh", "fish", "js", "mjs", "cjs", "ts", "mts", "rb", "pl", "php", "ps1", "lua", "go", "rs", "swift", "kt", "kts"];
// A pick's `tokens` is an estimate, and descriptions get small edits: only a real change is news.
const TOKENS_TOLERANCE = 0.25;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 60_000;
// Before the second and third attempt at a request.
const RETRY_DELAYS_MS = [2_000, 8_000];

// The forms of YAML the catalog is written in, without a dependency. Anything else is refused
// rather than misread: the app's own parser is the one that defines the file.

const KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;
const isItem = (text) => text === "-" || text.startsWith("- ");
const isBlank = (text) => !text || text.startsWith("#");

function unsupported(number, message) {
  return new Error(`line ${number}: ${message}`);
}

function plainScalar(text) {
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  return /^-?\d+$/.test(text) ? Number(text) : text;
}

/** Reads one flow value (`[a, "b"]`, `{ a: b }`, a string) from `cursor.text` at `cursor.at`. */
function readFlow(cursor, number) {
  const skip = () => {
    while (cursor.text[cursor.at] === " ") cursor.at++;
  };
  const expect = (closer) => {
    skip();
    const next = cursor.text[cursor.at];
    if (next !== "," && next !== closer) throw unsupported(number, `expected , or ${closer}`);
    if (next === ",") cursor.at++;
    skip();
  };
  skip();
  const first = cursor.text[cursor.at];
  if (first === "[") {
    const list = [];
    cursor.at++;
    skip();
    while (cursor.text[cursor.at] !== "]") {
      if (cursor.at >= cursor.text.length) throw unsupported(number, "a list must close on its line");
      list.push(readFlow(cursor, number));
      expect("]");
    }
    cursor.at++;
    return list;
  }
  if (first === "{") {
    const map = {};
    cursor.at++;
    skip();
    while (cursor.text[cursor.at] !== "}") {
      if (cursor.at >= cursor.text.length) throw unsupported(number, "a mapping must close on its line");
      const key = /^[A-Za-z_][\w-]*(?=:\s)/.exec(cursor.text.slice(cursor.at));
      if (!key) throw unsupported(number, "expected key: value");
      cursor.at += key[0].length + 1;
      map[key[0]] = readFlow(cursor, number);
      expect("}");
    }
    cursor.at++;
    return map;
  }
  if (first === '"' || first === "'") return readQuoted(cursor, number);
  const plain = /^[^,\]}]*/.exec(cursor.text.slice(cursor.at))[0];
  cursor.at += plain.length;
  return plainScalar(plain.trim());
}

function readQuoted(cursor, number) {
  const rest = cursor.text.slice(cursor.at);
  const double = /^"(?:[^"\\]|\\.)*"/.exec(rest);
  const single = /^'(?:[^']|'')*'/.exec(rest);
  const quoted = double ?? single;
  if (!quoted) throw unsupported(number, "a quoted string must close on its line");
  cursor.at += quoted[0].length;
  if (!double) return single[0].slice(1, -1).replaceAll("''", "'");
  try {
    return JSON.parse(double[0].replaceAll("\n", "\\n"));
  } catch {
    throw unsupported(number, `unsupported escape in ${double[0].slice(0, 40)}`);
  }
}

/** The value after `key: ` or `- `, on one line. */
function readValue(text, number) {
  if (/^[&*!|>%@`]/.test(text)) throw unsupported(number, `unsupported YAML: ${text}`);
  if (/^["'[{]/.test(text)) {
    const cursor = { text, at: 0 };
    const value = readFlow(cursor, number);
    const after = text.slice(cursor.at).trim();
    if (!isBlank(after)) throw unsupported(number, `unexpected text after the value: ${after}`);
    return value;
  }
  const plain = text.replace(/\s#.*$/, "").trim();
  if (plain.includes(": ")) throw unsupported(number, `quote a value that contains ": ": ${plain}`);
  return plainScalar(plain);
}

function readMap(lines, at, indent) {
  const map = {};
  while (at.i < lines.length && lines[at.i].indent === indent) {
    const { number, text } = lines[at.i];
    const pair = KEY.exec(text);
    if (!pair) throw unsupported(number, `expected key: value, found ${text}`);
    if (Object.hasOwn(map, pair[1])) throw unsupported(number, `${pair[1]} appears twice`);
    at.i++;
    map[pair[1]] = isBlank(pair[2]) ? readNested(lines, at, indent) : readValue(pair[2], number);
  }
  if (at.i < lines.length && lines[at.i].indent > indent) {
    throw unsupported(lines[at.i].number, "unexpected indentation (values stay on one line)");
  }
  return map;
}

function readList(lines, at, indent) {
  const list = [];
  while (at.i < lines.length && lines[at.i].indent === indent && isItem(lines[at.i].text)) {
    const { number, text } = lines[at.i];
    const rest = text.slice(1).trimStart();
    if (isBlank(rest)) {
      at.i++;
      list.push(readNested(lines, at, indent));
    } else if (KEY.test(rest)) {
      // `- a: b` starts a mapping whose keys line up with `a`.
      const inner = indent + text.length - rest.length;
      lines[at.i] = { number, indent: inner, text: rest };
      list.push(readMap(lines, at, inner));
    } else {
      at.i++;
      list.push(readValue(rest, number));
    }
  }
  if (at.i < lines.length && lines[at.i].indent > indent) {
    throw unsupported(lines[at.i].number, "unexpected indentation (values stay on one line)");
  }
  return list;
}

/** What follows a `key:` with no value on its line. */
function readNested(lines, at, indent) {
  const next = lines[at.i];
  if (!next) return null;
  if (next.indent > indent) {
    return isItem(next.text) ? readList(lines, at, next.indent) : readMap(lines, at, next.indent);
  }
  return next.indent === indent && isItem(next.text) ? readList(lines, at, indent) : null;
}

export function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ number: index + 1, indent: raw.search(/\S/), text: raw.trim() }))
    .filter((line) => !isBlank(line.text));
  const at = { i: 0 };
  const value = lines.length === 0 ? null : readNested(lines, at, -1);
  if (at.i < lines.length) throw unsupported(lines[at.i].number, "unexpected indentation");
  return value;
}

// Habi's rules: source/release.rs, source/mod.rs (scope_globs, Scope) and library/mod.rs.

/** The version a tag names, as its numeric parts; null if it is not a plain version. */
function version(tag) {
  const parts = tag.replace(/^[vV]/, "").split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  // Digits only, and short: a long run of digits is a date or a hash.
  if (!parts.every((part) => /^\d{1,6}$/.test(part))) return null;
  const numbers = parts.map(Number);
  // 1.0 and 1.0.0 are one version.
  while (numbers.length > 2 && numbers.at(-1) === 0) numbers.pop();
  return numbers;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** The highest release among `tags`; of two names for one version, the one that sorts last. */
export function latestRelease(tags) {
  let best = null;
  for (const tag of tags) {
    const parsed = version(tag);
    if (!parsed) continue;
    const order = best ? compareVersions(parsed, best.parsed) : 1;
    if (order > 0 || (order === 0 && tag > best.tag)) best = { parsed, tag };
  }
  return best?.tag ?? null;
}

/** Each way a `{a,b}` pattern can be read, so a renamed `b` is not hidden by a surviving `a`. */
export function alternatives(glob) {
  const group = /\{([^{}]*)\}/.exec(glob);
  if (!group) return [glob];
  return group[1]
    .split(",")
    .flatMap((choice) =>
      alternatives(glob.slice(0, group.index) + choice + glob.slice(group.index + group[0].length)),
    );
}

function plainGlobMatcher(glob) {
  if (/[[\]{}\\]/.test(glob)) throw new Error(`pattern not supported here: ${glob}`);
  let source = "";
  for (let i = 0; i < glob.length; ) {
    const atSegmentStart = i === 0 || glob[i - 1] === "/";
    if (atSegmentStart && glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (atSegmentStart && glob.slice(i) === "**") {
      source += ".*";
      i += 2;
    } else {
      const char = glob[i++];
      if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^$()|]/g, "\\$&");
    }
  }
  const pattern = new RegExp(`^${source}$`);
  return (candidate) => pattern.test(candidate);
}

/** A test for one pattern: `*` stays within a folder, `**` crosses folders. */
export function globMatcher(glob) {
  const matchers = alternatives(glob).map(plainGlobMatcher);
  return (candidate) => matchers.some((matches) => matches(candidate));
}

const folderOf = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
const baseName = (folder) => folder.slice(folder.lastIndexOf("/") + 1);
const skillFile = (folder) => (folder ? `${folder}/${SKILL_FILE}` : SKILL_FILE);

/** A test for whether `discovery` reads a file. */
function scopeOf(discovery) {
  const include = (discovery.include ?? []).map(globMatcher);
  const exclude = (discovery.exclude ?? []).map(globMatcher);
  return (file) =>
    (include.length === 0 || include.some((matches) => matches(file))) &&
    !exclude.some((matches) => matches(file));
}

/** The skill folders Habi finds among `files`: read by `discovery`, and not inside another skill. */
export function skillFolders(files, discovery) {
  const admitted = scopeOf(discovery);
  const folders = [...files]
    .filter((file) => (file === SKILL_FILE || file.endsWith(`/${SKILL_FILE}`)) && admitted(file))
    .map(folderOf)
    .sort();
  const accepted = [];
  const known = new Set();
  for (const folder of folders) {
    const enclosed =
      (folder && known.has("")) ||
      folder.split("/").some((_, i, parts) => i > 0 && known.has(parts.slice(0, i).join("/")));
    if (enclosed) continue;
    known.add(folder);
    accepted.push(folder);
  }
  return accepted;
}

/** YAML's line folding: one line break is a space, and of several, the first is dropped. */
function fold(lines) {
  return lines
    .join("\n")
    .trim()
    .replace(/\n+/g, (breaks) => (breaks.length === 1 ? " " : breaks.slice(1)));
}

/** One top-level text value of a frontmatter, which may run over several lines; null if absent or not text. */
function frontmatterValue(lines, end, key) {
  for (let i = 1; i < end; i++) {
    if (!lines[i].startsWith(`${key}:`)) continue;
    const pair = /^[^:]+:(?:\s+(.*))?$/.exec(lines[i]);
    if (!pair) continue;
    const head = pair[1]?.trim();
    // It runs until the next line that starts at the left margin.
    let stop = i + 1;
    while (stop < end && (lines[stop].trim() === "" || /^\s/.test(lines[stop]))) stop++;
    const rest = lines.slice(i + 1, stop);
    if (head && /^[|>][-+\d]*(?:\s+#.*)?$/.test(head)) {
      const indent = rest.find((line) => line.trim())?.search(/\S/) ?? 0;
      const body = rest.map((line) => line.slice(indent));
      return (head[0] === "|" ? body.join("\n") : fold(body)).trim();
    }
    const folded = fold([isBlank(head) ? "" : head, ...rest.map((line) => line.trim())]);
    const value = isBlank(folded) ? null : readValue(folded, i + 1);
    return typeof value === "string" ? value.trim() : null;
  }
  return null;
}

/**
 * The `name` and `description` in a SKILL.md's frontmatter, each null if it has none. Only those
 * are read: the rest is the author's YAML, in forms this file's reader refuses. Throws if they
 * cannot be read.
 */
export function frontmatter(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("does not start with YAML frontmatter");
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (end < 0) throw new Error("frontmatter is not closed");
  return { name: frontmatterValue(lines, end, "name"), description: frontmatterValue(lines, end, "description") };
}

/** What a skill's name and description cost in every agent session (`suggest::tokens_of`). */
export function tokensOf(name, description) {
  return Math.ceil(([...name].length + [...description].length) / 4);
}

/** A file an agent could run: marked executable, or source code (`ItemFile::is_code`). */
export function isCode(file, mode) {
  const dot = file.lastIndexOf(".");
  return mode === EXECUTABLE_MODE || (dot >= 0 && CODE_EXTENSIONS.includes(file.slice(dot + 1).toLowerCase()));
}

/** `owner/repo` of a `https://github.com/<owner>/<repo>` address. */
export function repoOf(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`not a GitHub repository address: ${url}`);
  return `${match[1]}/${match[2]}`;
}

// GitHub.

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Requests to GitHub. Listings go through the API, with the token when there is one; file
 * contents come from raw.githubusercontent.com, which needs no token and spends no API quota.
 */
export function githubClient({ fetch: fetchFn = fetch, token, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  async function request(url, headers) {
    for (let attempt = 0; ; attempt++) {
      let response;
      let cause;
      try {
        response = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        cause = e;
      }
      if (response?.ok) return response;
      const status = response?.status;
      if ((status === 403 || status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
        throw new RequestError("GitHub's rate limit was reached; set GITHUB_TOKEN and run it again", status);
      }
      const transient = !response || status >= 500 || status === 429 || response.headers.has("retry-after");
      if (!transient || attempt >= RETRY_DELAYS_MS.length) {
        throw new RequestError(response ? `HTTP ${status} from ${url}` : `${cause.message} (${url})`, status);
      }
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
  const api = async (route) => {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "habi-check-catalog", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return (await request(`${API}${route}`, headers)).json();
  };
  return {
    repository: (repo) => api(`/repos/${repo}`),
    head: async (repo, branch) => (await api(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)).commit.sha,
    /** Every tag, as `{ name, commit: { sha } }`. Habi reads them all, so there is no stopping early. */
    tags: async (repo) => {
      const all = [];
      for (let page = 1; ; page++) {
        const tags = await api(`/repos/${repo}/tags?per_page=${PAGE_SIZE}&page=${page}`);
        all.push(...tags);
        if (tags.length < PAGE_SIZE) return all;
      }
    },
    tree: (repo, sha) => api(`/repos/${repo}/git/trees/${sha}?recursive=1`),
    file: async (repo, sha, file) => {
      const encoded = file.split("/").map(encodeURIComponent).join("/");
      const headers = { "User-Agent": "habi-check-catalog" };
      return (await request(`${RAW}/${repo}/${sha}/${encoded}`, headers)).text();
    },
  };
}

/**
 * Text from an upstream repository, as one printable line with nothing that could close the code
 * block the report sits in once it is an issue. Names, branches and paths are theirs to choose.
 */
function safe(text) {
  return String(text).slice(0, 120).replace(/[^\x20-\x7e]|`/g, "?");
}
const quoted = (text) => JSON.stringify(safe(text));

/** The revision Habi reads, as `{ sha, label }`. */
async function resolveRevision(entry, repo, defaultBranch, github) {
  const branch = safe(defaultBranch);
  if (entry.discovery.track === "latest-release") {
    const tags = await github.tags(repo);
    const tag = latestRelease(tags.map((t) => t.name));
    if (tag) return { sha: tags.find((t) => t.name === tag).commit.sha, label: `tag ${tag}` };
    return { sha: await github.head(repo, defaultBranch), label: `${branch}, no release tag` };
  }
  return { sha: await github.head(repo, defaultBranch), label: branch };
}

/** The measured facts a pick carries. `caution` is left out: only Habi's own scan can say it. */
function checkMeasured(pick, label, fields, code, result) {
  const tokens = tokensOf(fields.name ?? baseName(pick.skill), fields.description ?? "");
  if (pick.tokens !== undefined && Math.abs(tokens - pick.tokens) > pick.tokens * TOKENS_TOLERANCE) {
    result.problems.push(`${label}: tokens is ${pick.tokens} in the catalog, measured ${tokens}`);
  }
  if (pick.scripts && !code) result.problems.push(`${label}: scripts is true in the catalog, but it has no code`);
  if (!pick.scripts && code) result.problems.push(`${label}: has code (${quoted(code)}), but scripts is not set in the catalog`);
}

async function checkPick(pick, repo, sha, { files, folders, blobs, admitted }, github, result) {
  const label = `pick ${pick.skill}`;
  if (!folders.includes(pick.skill)) {
    const enclosing = folders.find((folder) => folder === "" || pick.skill.startsWith(`${folder}/`));
    const elsewhere = folders.filter((folder) => baseName(folder) === baseName(pick.skill));
    let reason = `no ${SKILL_FILE} there`;
    if (enclosing !== undefined) reason = `inside the skill ${quoted(enclosing)}, so read as part of it`;
    else if (files.has(skillFile(pick.skill))) reason = `has a ${SKILL_FILE}, but discovery does not read it`;
    else if (elsewhere.length) reason += `; a skill of that name is at ${elsewhere.map(quoted).join(", ")}`;
    result.problems.push(`${label}: ${reason}`);
    return;
  }
  let text;
  try {
    text = await github.file(repo, sha, skillFile(pick.skill));
  } catch (e) {
    result.unchecked.push(`${label}: ${e.message}`);
    return;
  }
  let fields;
  try {
    fields = frontmatter(text);
  } catch (e) {
    result.problems.push(`${label}: ${SKILL_FILE} ${e.message}`);
    return;
  }
  const expected = pick.name ?? baseName(pick.skill);
  const { name } = fields;
  if (name === null) result.problems.push(`${label}: ${SKILL_FILE} has no name, expected ${quoted(expected)}`);
  else if (name !== expected) result.problems.push(`${label}: ${SKILL_FILE} is named ${quoted(name)}, expected ${quoted(expected)}`);
  const prefix = `${pick.skill}/`;
  const code = blobs.find((blob) => blob.path.startsWith(prefix) && admitted(blob.path) && isCode(blob.path.slice(prefix.length), blob.mode));
  checkMeasured(pick, label, fields, code?.path, result);
}

/** Checks one catalog entry. A problem is the catalog being out of date; `unchecked` is something in the way of knowing. */
export async function checkEntry(entry, github) {
  const result = {
    id: entry.id,
    repo: null,
    revision: null,
    skills: 0,
    picks: entry.picks?.length ?? 0,
    hints: entry.hints?.length ?? 0,
    problems: [],
    unchecked: [],
  };
  try {
    const repo = repoOf(entry.url);
    result.repo = repo;
    let meta;
    try {
      meta = await github.repository(repo);
    } catch (e) {
      if (e.status !== 404) throw e;
      result.problems.push("repository not found: renamed, deleted or made private");
      return result;
    }
    if (meta.full_name.toLowerCase() !== repo.toLowerCase()) {
      result.problems.push(`repository moved to ${safe(meta.full_name)}`);
    }
    const revision = await resolveRevision(entry, repo, meta.default_branch, github);
    result.revision = revision;
    const tree = await github.tree(repo, revision.sha);
    // A partial listing would call skills missing that are not.
    if (tree.truncated) throw new Error("GitHub cut the file listing short: too large to check in one request");
    // Habi skips symbolic links, so a linked SKILL.md is not a skill.
    const blobs = tree.tree.filter((item) => item.type === "blob" && item.mode !== SYMLINK_MODE);
    const files = new Set(blobs.map((blob) => blob.path));
    const folders = skillFolders(files, entry.discovery);
    const admitted = scopeOf(entry.discovery);
    result.skills = folders.length;

    for (const pattern of entry.discovery.include ?? []) {
      for (const alternative of alternatives(pattern)) {
        const matches = globMatcher(alternative);
        if (!folders.some((folder) => matches(skillFile(folder)))) {
          result.problems.push(`discovery.include ${alternative}: matches no skill`);
        }
      }
    }
    // A hint names skill folders; each alternative of `{a,b}` is a skill someone chose.
    for (const hint of entry.hints ?? []) {
      for (const alternative of alternatives(hint.path)) {
        const matches = globMatcher(alternative);
        if (!folders.some((folder) => matches(folder))) {
          result.problems.push(`hint ${alternative}: matches no skill folder`);
        }
      }
    }
    for (const pick of entry.picks ?? []) {
      await checkPick(pick, repo, revision.sha, { files, folders, blobs, admitted }, github, result);
    }
  } catch (e) {
    result.unchecked.push(e.message);
  }
  return result;
}

export async function checkCatalog(catalog, github) {
  const results = [];
  for (const entry of catalog.sources) results.push(await checkEntry(entry, github));
  return results;
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const libraries = (n) => `${n} ${n === 1 ? "library" : "libraries"}`;

/** The report, and whether everything resolved. */
export function report(results) {
  const lines = [`Catalog check of ${CATALOG}`, ""];
  const width = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    const state = r.problems.length ? "FAILED" : r.unchecked.length ? "UNCHECKED" : "ok";
    const where = r.revision ? ` at ${r.revision.sha.slice(0, 7)} (${r.revision.label})` : "";
    const facts = r.revision ? `: ${count(r.skills, "skill")}, ${count(r.picks, "pick")}, ${count(r.hints, "hint")}` : "";
    lines.push(`${state.padEnd(9)} ${r.id.padEnd(width)}  ${r.repo ?? "?"}${where}${facts}`);
    for (const problem of r.problems) lines.push(`    - ${problem}`);
    for (const reason of r.unchecked) lines.push(`    ? could not check: ${reason}`);
  }
  const problems = results.reduce((sum, r) => sum + r.problems.length, 0);
  const failed = results.filter((r) => r.problems.length).length;
  const unchecked = results.filter((r) => r.unchecked.length).length;
  const ok = problems === 0 && unchecked === 0;
  lines.push("");
  if (ok) {
    const picks = results.reduce((sum, r) => sum + r.picks, 0);
    const hints = results.reduce((sum, r) => sum + r.hints, 0);
    lines.push(`All ${libraries(results.length)} resolve: ${count(picks, "pick")}, ${count(hints, "hint")}.`);
  } else {
    const parts = [];
    if (problems) parts.push(`${count(problems, "problem")} in ${failed} of ${libraries(results.length)}`);
    if (unchecked) parts.push(`${unchecked} of ${libraries(results.length)} could not be fully checked`);
    lines.push(`${parts.join("; ")}.`);
  }
  return { ok, text: lines.join("\n") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const catalog = parseYaml(readFileSync(path.join(root, CATALOG), "utf8"));
    const github = githubClient({ token: process.env.GITHUB_TOKEN || undefined });
    const { ok, text } = report(await checkCatalog(catalog, github));
    console.log(text);
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.error(`check-catalog: ${e.message}`);
    process.exitCode = 1;
  }
}
