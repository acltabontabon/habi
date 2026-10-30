import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  alternatives,
  checkCatalog,
  checkEntry,
  frontmatter,
  githubClient,
  globMatcher,
  isCode,
  latestRelease,
  parseYaml,
  repoOf,
  report,
  skillFolders,
  tokensOf,
} from "./check-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "a".repeat(40);
const TAG_SHA = "b".repeat(40);

const skillMd = (name) => `---\nname: ${name}\ndescription: A skill.\n---\n\nBody.\n`;
const blobs = (...paths) => paths.map((p) => ({ path: p, mode: "100644", type: "blob" }));

/**
 * A fictitious GitHub: `routes` maps a URL's path to a JSON body, or to a function of the request
 * for anything else; `files` maps a raw path to its text. Everything else is a 404. Records requests.
 */
function fakeGitHub({ routes = {}, files = {} } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const { hostname, pathname, search } = new URL(url);
    requests.push({ url, hostname, headers: options.headers });
    if (hostname === "raw.githubusercontent.com") {
      const text = files[pathname.slice(1)];
      return text === undefined ? new Response("", { status: 404 }) : new Response(text);
    }
    const route = routes[pathname + search] ?? routes[pathname];
    if (route === undefined) return new Response("{}", { status: 404 });
    return typeof route === "function" ? route() : new Response(JSON.stringify(route));
  };
  return { fetch, requests, github: githubClient({ fetch, token: "test-token", wait: async () => {} }) };
}

/** A repository at SHA on `main`, with the given files. */
function repoRoutes(repo, tree, extra = {}) {
  return {
    [`/repos/${repo}`]: { full_name: repo, default_branch: "main" },
    [`/repos/${repo}/branches/main`]: { commit: { sha: SHA } },
    [`/repos/${repo}/git/trees/${SHA}`]: { sha: SHA, tree, truncated: false },
    ...extra,
  };
}

function entry(extra = {}) {
  return {
    id: "example",
    url: "https://github.com/example-org/skills",
    discovery: { include: ["skills/**"] },
    ...extra,
  };
}

const raw = (file) => `example-org/skills/${SHA}/${file}`;

test("reads the forms the catalog is written in", () => {
  const text = [
    "# A comment",
    "version: 1",
    "",
    "sources:",
    "  - id: one  # trailing comment",
    '    summary: "With: a colon and a # hash"',
    "    note: It's plain, with an apostrophe",
    '    publisher: { name: "@scope/thing", kind: builder, checked: "2026-10-03" }',
    '    discovery:',
    '      include: ["skills/**", ".github/skills/**"]',
    "      group: 1",
    "    empty:",
    "    picks:",
    "      - skill: skills/a",
    "        applies_when:",
    "          any:",
    '            - tag: "framework:react"',
    '            - dependency: { name: "x", ecosystem: npm }',
    "    notes:",
    '      - "Quoted."',
    "      - 'It''s single-quoted.'",
    "      - plain",
    "    same-level:",
    "    - a",
    "    - b",
  ].join("\r\n");
  assert.deepEqual(parseYaml(text), {
    version: 1,
    sources: [
      {
        id: "one",
        summary: "With: a colon and a # hash",
        note: "It's plain, with an apostrophe",
        publisher: { name: "@scope/thing", kind: "builder", checked: "2026-10-03" },
        discovery: { include: ["skills/**", ".github/skills/**"], group: 1 },
        empty: null,
        picks: [
          {
            skill: "skills/a",
            applies_when: {
              any: [{ tag: "framework:react" }, { dependency: { name: "x", ecosystem: "npm" } }],
            },
          },
        ],
        notes: ["Quoted.", "It's single-quoted.", "plain"],
        "same-level": ["a", "b"],
      },
    ],
  });
});

test("refuses YAML it does not read rather than misreading it", () => {
  for (const text of [
    "a: |\n  block\n",
    "a: >\n  folded\n",
    "a: &anchor b\n",
    "a: *alias\n",
    "a: !tag b\n",
    'a: ["open\n',
    "a: [one,\n  two]\n",
    "a: { b: c\n",
    'a: "open\n',
    "a: b\n  continued\n",
    "a: b: c\n",
    "a: b\na: c\n",
    "---\na: b\n",
    "a: b\n  - c\n",
  ]) {
    assert.throws(() => parseYaml(text), /line \d+/, text);
  }
});

test("reads every entry of the real catalog", () => {
  const text = readFileSync(path.join(root, "crates/habi-core/catalog/sources.yaml"), "utf8");
  const { sources } = parseYaml(text);
  const lines = (pattern) => text.split(/\r?\n/).filter((line) => pattern.test(line)).length;
  assert.equal(sources.length, lines(/^ {2}- id: /));
  assert.equal(sources.flatMap((s) => s.picks ?? []).length, lines(/^ {6}- skill: /));
  assert.equal(sources.flatMap((s) => s.hints ?? []).length, lines(/^ {6}- path: /));
  for (const source of sources) {
    assert.ok(repoOf(source.url), source.id);
    assert.ok(source.discovery.include.length > 0, source.id);
    assert.ok(["latest-release", "default", undefined].includes(source.discovery.track), source.id);
    for (const pick of source.picks ?? []) {
      assert.ok(!/[*?{]/.test(pick.skill), pick.skill);
      assert.ok(Number.isInteger(pick.tokens) && pick.tokens > 0, pick.skill);
      assert.ok(pick.scripts === undefined || typeof pick.scripts === "boolean", pick.skill);
    }
    // Every pattern is one the checker understands.
    for (const pattern of [...source.discovery.include, ...(source.discovery.exclude ?? []), ...(source.hints ?? []).map((h) => h.path)]) {
      assert.equal(typeof globMatcher(pattern)("skills/a/SKILL.md"), "boolean");
    }
  }
});

test("the latest release is the one Habi would read", () => {
  // The cases of crates/habi-core/src/source/release.rs.
  assert.equal(latestRelease(["v1.9.0", "v1.10.0", "v1.2.0"]), "v1.10.0");
  assert.equal(latestRelease(["0.6.9", "0.6.11", "0.6.10"]), "0.6.11");
  assert.equal(
    latestRelease(["agent-skills-dd089a8c752c966dee8bf0f27cb625ba193ffd9e", "nightly", "v2.0.0-rc1", "20260102", "v1.2.3.4.5"]),
    null,
  );
  assert.equal(latestRelease(["v1.0.0", "v2.0.0-rc1"]), "v1.0.0");
  assert.equal(latestRelease(["v1.0", "1.0.0"]), "v1.0");
  assert.equal(latestRelease(["1.0.0", "v1.0"]), "v1.0");
  assert.equal(latestRelease([]), null);
});

test("patterns match as Habi's do: * within a folder, ** across", () => {
  const cases = [
    ["skills/**", "skills/a/SKILL.md", true],
    ["skills/**", "skills/a/b/SKILL.md", true],
    ["skills/**", "skills", false],
    ["skills/**", "other/skills/a/SKILL.md", false],
    ["plugins/*/skills/**", "plugins/p/skills/a/SKILL.md", true],
    ["plugins/*/skills/**", "plugins/p/q/skills/a/SKILL.md", false],
    ["skills/cloud/bigquery-*", "skills/cloud/bigquery-basics", true],
    ["skills/cloud/bigquery-*", "skills/cloud/bigquery-x/deep", false],
    ["skills/cloud/bigquery-*", "skills/cloud/gcloud", false],
    [".github/skills/**", ".github/skills/a/SKILL.md", true],
    [".github/skills/**", "xgithub/skills/a/SKILL.md", false],
    ["**/SKILL.md", "SKILL.md", true],
    ["**/SKILL.md", "a/b/SKILL.md", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["skills/{a,b}", "skills/a", true],
    ["skills/{a,b}", "skills/b", true],
    ["skills/{a,b}", "skills/c", false],
    ["**/wrangler.{toml,json}", "wrangler.json", true],
    ["s?ills/a", "skills/a", true],
    ["s?ills/a", "s/ills/a", false],
  ];
  for (const [glob, candidate, expected] of cases) {
    assert.equal(globMatcher(glob)(candidate), expected, `${glob} on ${candidate}`);
  }
  assert.deepEqual(alternatives("x/{a,b}/{c,d}"), ["x/a/c", "x/a/d", "x/b/c", "x/b/d"]);
  assert.throws(() => globMatcher("skills/[ab]"), /not supported/);
});

test("skill folders are those Habi finds: in scope, outermost, at any depth", () => {
  const files = [
    "skills/a/SKILL.md",
    "skills/a/nested/SKILL.md",
    "skills/a-b/SKILL.md",
    "skills/c/deep/SKILL.md",
    "skills/fixtures/x/SKILL.md",
    "other/d/SKILL.md",
    "skills/README.md",
    "skills/NOT_SKILL.md",
  ];
  assert.deepEqual(skillFolders(files, { include: ["skills/**"], exclude: ["skills/fixtures/**"] }), [
    "skills/a",
    "skills/a-b",
    "skills/c/deep",
  ]);
  // No include reads everything; a skill at the root encloses the rest.
  assert.deepEqual(skillFolders(["a/SKILL.md"], {}), ["a"]);
  assert.deepEqual(skillFolders(["SKILL.md", "a/SKILL.md"], {}), [""]);
});

test("reads a SKILL.md's name the way Habi does", () => {
  const nameOf = (text) => frontmatter(text).name;
  assert.equal(nameOf(skillMd("my-skill")), "my-skill");
  assert.equal(nameOf("\uFEFF---\r\nname: my-skill\r\n---\r\n"), "my-skill");
  assert.equal(nameOf('---\nname: "my-skill"\n---\n'), "my-skill");
  assert.equal(nameOf("---\nname: 'my-skill'  # why\n---\n"), "my-skill");
  assert.equal(nameOf("---\nname: my-skill # why\n---\n"), "my-skill");
  // The rest of the frontmatter is the author's: this reader's limits do not apply to it.
  assert.equal(nameOf("---\ndescription: |\n  name: not-this\n  has: colons\nname: real\n---\n"), "real");
  assert.equal(nameOf("---\nallowed-tools: { a: b: c\nname: real\n---\n"), "real");
  assert.equal(nameOf("---\nmetadata:\n  name: nested\n---\n"), null);
  assert.equal(nameOf("---\nnames: other\n---\n"), null);
  assert.equal(nameOf("---\nname:\n---\n"), null);
  assert.equal(nameOf("---\nname: 12\n---\n"), null);
  assert.equal(nameOf("---\ndescription: none\n---\nname: body\n"), null);
  assert.throws(() => frontmatter("# No frontmatter\nname: x\n"), /does not start/);
  assert.throws(() => frontmatter("---\nname: x\n"), /not closed/);
});

test("reads a SKILL.md's description in each form YAML writes it", () => {
  const described = (...lines) => frontmatter(["---", "name: a", ...lines, "license: MIT", "---", ""].join("\n")).description;
  assert.equal(described("description: One line."), "One line.");
  assert.equal(described('description: "Quoted: with a colon."'), "Quoted: with a colon.");
  assert.equal(described("description: 'It''s single-quoted.'"), "It's single-quoted.");
  assert.equal(described("description: Plain # and a comment"), "Plain");
  assert.equal(described("description: Plain,", "  over two", "  lines."), "Plain, over two lines.");
  assert.equal(described('description: "Quoted,', '  over two lines."'), "Quoted, over two lines.");
  assert.equal(described('description: "With\\nan escape."'), "With\nan escape.");
  assert.equal(described("description: |", "  Line one.", "    Indented.", "", "  Line three."), "Line one.\n  Indented.\n\nLine three.");
  assert.equal(described("description: >-", "  Folded", "  together.", "", "  New paragraph."), "Folded together.\nNew paragraph.");
  assert.equal(described("description: >", "  Trailing newline dropped.", ""), "Trailing newline dropped.");
  assert.equal(described("description:", "  Starts on the next line."), "Starts on the next line.");
  assert.equal(described(), null);
  assert.equal(described("description:"), null);
  assert.equal(described("description: 12"), null);
  // A bare colon is what a YAML parser refuses, and then Habi reads no description at all.
  assert.throws(() => described("description: Use when: reviewing"), /line 3/);
  assert.throws(() => described('description: "Bad \\q escape"'), /unsupported escape/);
});

test("counts tokens and recognises code as Habi does", () => {
  // The rule of suggest::tokens_of: characters, not bytes, and rounded up.
  assert.equal(tokensOf("abcd", ""), 1);
  assert.equal(tokensOf("abcd", "e"), 2);
  assert.equal(tokensOf("ab", "cdefgh"), 2);
  assert.equal(tokensOf("\uD83D\uDE42\uD83D\uDE42", "\u00E9\u00E9"), 1);

  for (const file of ["scripts/run.py", "run.SH", "a/b.mjs", "tool.kts", ".sh"]) assert.ok(isCode(file, "100644"), file);
  for (const file of ["SKILL.md", "scripts/schema.json", "Makefile", "x.py/readme", "templates/a.html"]) assert.ok(!isCode(file, "100644"), file);
  assert.ok(isCode("bin/tool", "100755"));
});

test("reads the address of a repository", () => {
  assert.equal(repoOf("https://github.com/o/r"), "o/r");
  assert.equal(repoOf("https://github.com/o/r.git"), "o/r");
  assert.equal(repoOf("https://github.com/o/r/"), "o/r");
  assert.throws(() => repoOf("https://example.com/o/r"), /not a GitHub/);
  assert.throws(() => repoOf("https://github.com/o"), /not a GitHub/);
});

test("a catalog entry that still resolves has no problems", async () => {
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/a/SKILL.md", "skills/b-one/SKILL.md", "skills/b-two/SKILL.md", "README.md")),
    files: { [raw("skills/a/SKILL.md")]: skillMd("a"), [raw("skills/b-one/SKILL.md")]: skillMd("renamed-upstream") },
  });
  const result = await checkEntry(
    entry({
      picks: [{ skill: "skills/a" }, { skill: "skills/b-one", name: "renamed-upstream" }],
      hints: [{ path: "skills/b-*" }, { path: "skills/{a,b-two}" }],
    }),
    github,
  );
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unchecked, []);
  assert.equal(result.skills, 3);
  assert.deepEqual(result.revision, { sha: SHA, label: "main" });
});

test("a pick is checked at the release Habi reads, not the default branch", async () => {
  const repo = "example-org/skills";
  const { github, requests } = fakeGitHub({
    routes: {
      [`/repos/${repo}`]: { full_name: repo, default_branch: "main" },
      [`/repos/${repo}/tags?per_page=100&page=1`]: [
        { name: "v1.2.0", commit: { sha: SHA } },
        { name: "v1.10.0", commit: { sha: TAG_SHA } },
        { name: "v2.0.0-rc1", commit: { sha: "c".repeat(40) } },
      ],
      [`/repos/${repo}/git/trees/${TAG_SHA}`]: { tree: blobs("skills/a/SKILL.md"), truncated: false },
    },
    files: { [`${repo}/${TAG_SHA}/skills/a/SKILL.md`]: skillMd("a") },
  });
  const result = await checkEntry(
    entry({ discovery: { include: ["skills/**"], track: "latest-release" }, picks: [{ skill: "skills/a" }] }),
    github,
  );
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unchecked, []);
  assert.deepEqual(result.revision, { sha: TAG_SHA, label: "tag v1.10.0" });
  assert.ok(!requests.some((r) => r.url.includes("/branches/")));
});

test("every page of tags is read, and no release tag means the default branch", async () => {
  const repo = "example-org/skills";
  const pageOne = Array.from({ length: 100 }, (_, i) => ({ name: `nightly-${i}`, commit: { sha: SHA } }));
  const paged = fakeGitHub({
    routes: {
      [`/repos/${repo}`]: { full_name: repo, default_branch: "main" },
      [`/repos/${repo}/tags?per_page=100&page=1`]: pageOne,
      [`/repos/${repo}/tags?per_page=100&page=2`]: [{ name: "v3.0.0", commit: { sha: TAG_SHA } }],
      [`/repos/${repo}/git/trees/${TAG_SHA}`]: { tree: blobs("skills/a/SKILL.md"), truncated: false },
    },
  });
  const tracked = entry({ discovery: { include: ["skills/**"], track: "latest-release" } });
  assert.equal((await checkEntry(tracked, paged.github)).revision.label, "tag v3.0.0");

  const untagged = fakeGitHub({
    routes: repoRoutes(repo, blobs("skills/a/SKILL.md"), { [`/repos/${repo}/tags?per_page=100&page=1`]: [] }),
  });
  assert.deepEqual((await checkEntry(tracked, untagged.github)).revision, { sha: SHA, label: "main, no release tag" });
});

test("reports each way a pick stops resolving", async () => {
  const { github } = fakeGitHub({
    routes: repoRoutes(
      "example-org/skills",
      [
        ...blobs(
          "skills/new-home/moved/SKILL.md",
          "skills/wrong-name/SKILL.md",
          "skills/named/SKILL.md",
          "skills/nameless/SKILL.md",
          "skills/no-frontmatter/SKILL.md",
          "skills/outer/SKILL.md",
          "skills/outer/inner/SKILL.md",
          "skills/empty/README.md",
          "elsewhere/out-of-scope/SKILL.md",
        ),
        { path: "skills/linked/SKILL.md", mode: "120000", type: "blob" },
      ],
    ),
    files: {
      [raw("skills/wrong-name/SKILL.md")]: skillMd("something-else"),
      [raw("skills/named/SKILL.md")]: skillMd("named"),
      [raw("skills/nameless/SKILL.md")]: "---\ndescription: No name.\n---\n",
      [raw("skills/no-frontmatter/SKILL.md")]: "# Just text\n",
    },
  });
  const result = await checkEntry(
    entry({
      picks: [
        { skill: "skills/moved" },
        { skill: "skills/gone" },
        { skill: "skills/empty" },
        { skill: "skills/linked" },
        { skill: "skills/wrong-name" },
        { skill: "skills/named", name: "the-old-name" },
        { skill: "skills/nameless" },
        { skill: "skills/no-frontmatter" },
        { skill: "skills/outer/inner" },
        { skill: "elsewhere/out-of-scope" },
      ],
    }),
    github,
  );
  assert.deepEqual(result.unchecked, []);
  assert.deepEqual(result.problems, [
    'pick skills/moved: no SKILL.md there; a skill of that name is at "skills/new-home/moved"',
    "pick skills/gone: no SKILL.md there",
    "pick skills/empty: no SKILL.md there",
    "pick skills/linked: no SKILL.md there",
    'pick skills/wrong-name: SKILL.md is named "something-else", expected "wrong-name"',
    'pick skills/named: SKILL.md is named "named", expected "the-old-name"',
    'pick skills/nameless: SKILL.md has no name, expected "nameless"',
    "pick skills/no-frontmatter: SKILL.md does not start with YAML frontmatter",
    'pick skills/outer/inner: inside the skill "skills/outer", so read as part of it',
    "pick elsewhere/out-of-scope: has a SKILL.md, but discovery does not read it",
  ]);
});

test("tokens is reported only past the tolerance, in either direction", async () => {
  // 4 characters of name and 396 of description: 100 tokens.
  const description = "x".repeat(396);
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/abcd/SKILL.md")),
    files: { [raw("skills/abcd/SKILL.md")]: `---\nname: abcd\ndescription: ${description}\n---\n` },
  });
  const problemsWith = async (tokens) =>
    (await checkEntry(entry({ picks: [{ skill: "skills/abcd", tokens }] }), github)).problems;
  // 25% of the catalog's number: 100 is within it of 80 and of 133, not of 79 or 134.
  for (const close of [100, 80, 125, 133]) assert.deepEqual(await problemsWith(close), [], `${close}`);
  for (const far of [79, 134, 40, 200]) {
    assert.deepEqual(await problemsWith(far), [`pick skills/abcd: tokens is ${far} in the catalog, measured 100`]);
  }
});

test("a pick with no name in its SKILL.md is measured by its folder's name, as Habi does", async () => {
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/abcdefgh/SKILL.md")),
    files: { [raw("skills/abcdefgh/SKILL.md")]: "---\ndescription: abcd\n---\n" },
  });
  const result = await checkEntry(entry({ picks: [{ skill: "skills/abcdefgh", tokens: 3 }] }), github);
  assert.deepEqual(result.problems, ['pick skills/abcdefgh: SKILL.md has no name, expected "abcdefgh"']);
});

test("scripts is compared with the code the skill comes with", async () => {
  const tree = [
    ...blobs(
      "skills/with-code/SKILL.md",
      "skills/with-code/scripts/run.py",
      "skills/plain/SKILL.md",
      "skills/plain/scripts/schema.json",
      "skills/plain/reference.md",
      // Files of other folders, and code the discovery patterns do not read, are not its code.
      "skills/plain-other/SKILL.md",
      "skills/plain-other/run.py",
      "skills/scoped/SKILL.md",
      "skills/scoped/fixtures/run.py",
    ),
    { path: "skills/with-bit/SKILL.md", mode: "100644", type: "blob" },
    { path: "skills/with-bit/tool", mode: "100755", type: "blob" },
    // Habi skips symbolic links.
    { path: "skills/linked/SKILL.md", mode: "100644", type: "blob" },
    { path: "skills/linked/run.py", mode: "120000", type: "blob" },
  ];
  const named = (...names) => Object.fromEntries(names.map((name) => [raw(`skills/${name}/SKILL.md`), skillMd(name)]));
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", tree),
    files: named("with-code", "plain", "plain-other", "scoped", "with-bit", "linked"),
  });
  const problems = async (picks) =>
    (await checkEntry(entry({ discovery: { include: ["skills/**"], exclude: ["skills/scoped/fixtures/**"] }, picks }), github)).problems;

  assert.deepEqual(
    await problems([
      { skill: "skills/with-code", scripts: true },
      { skill: "skills/with-bit", scripts: true },
      { skill: "skills/plain" },
      { skill: "skills/scoped" },
      { skill: "skills/linked" },
    ]),
    [],
  );
  assert.deepEqual(await problems([{ skill: "skills/with-code" }]), [
    'pick skills/with-code: has code ("skills/with-code/scripts/run.py"), but scripts is not set in the catalog',
  ]);
  assert.deepEqual(await problems([{ skill: "skills/plain", scripts: true }]), [
    "pick skills/plain: scripts is true in the catalog, but it has no code",
  ]);
});

test("caution is left to Habi's own scan", async () => {
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/a/SKILL.md")),
    files: { [raw("skills/a/SKILL.md")]: skillMd("a") },
  });
  const result = await checkEntry(entry({ picks: [{ skill: "skills/a", caution: "Contains a compiled program" }] }), github);
  assert.deepEqual(result.problems, []);
});

test("reports hints and discovery patterns that no longer match a skill", async () => {
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/a/SKILL.md", "skills/fixtures/x/SKILL.md", "notes/guide.txt")),
  });
  const result = await checkEntry(
    entry({
      discovery: { include: ["skills/**", ".github/skills/**", "notes/**"], exclude: ["skills/fixtures/**"] },
      hints: [{ path: "skills/a" }, { path: "skills/gone-*" }, { path: "skills/{a,renamed}" }, { path: "skills/fixtures/*" }],
    }),
    github,
  );
  assert.deepEqual(result.problems, [
    "discovery.include .github/skills/**: matches no skill",
    "discovery.include notes/**: matches no skill",
    "hint skills/gone-*: matches no skill folder",
    "hint skills/renamed: matches no skill folder",
    "hint skills/fixtures/*: matches no skill folder",
  ]);
});

test("a repository that is gone or moved is reported; the moved one is still checked", async () => {
  const gone = await checkEntry(entry(), fakeGitHub().github);
  assert.deepEqual(gone.problems, ["repository not found: renamed, deleted or made private"]);
  assert.deepEqual(gone.unchecked, []);

  const { github } = fakeGitHub({
    routes: {
      ...repoRoutes("example-org/skills", blobs("skills/a/SKILL.md")),
      "/repos/example-org/skills": { full_name: "new-org/skills", default_branch: "main" },
    },
  });
  const moved = await checkEntry(entry({ hints: [{ path: "skills/gone" }] }), github);
  assert.deepEqual(moved.problems, ["repository moved to new-org/skills", "hint skills/gone: matches no skill folder"]);

  const { github: cased } = fakeGitHub({
    routes: {
      ...repoRoutes("example-org/skills", blobs("skills/a/SKILL.md")),
      "/repos/example-org/skills": { full_name: "Example-Org/Skills", default_branch: "main" },
    },
  });
  assert.deepEqual((await checkEntry(entry(), cased)).problems, []);
});

test("a listing cut short is not read as skills having gone missing", async () => {
  const { github } = fakeGitHub({
    routes: {
      ...repoRoutes("example-org/skills", []),
      [`/repos/example-org/skills/git/trees/${SHA}`]: { tree: [], truncated: true },
    },
  });
  const result = await checkEntry(entry({ picks: [{ skill: "skills/a" }] }), github);
  assert.deepEqual(result.problems, []);
  assert.match(result.unchecked[0], /cut the file listing short/);
});

test("a passing failure is retried, and one that stays is not called rot", async () => {
  const repo = "example-org/skills";
  let attempts = 0;
  const flaky = fakeGitHub({
    routes: {
      ...repoRoutes(repo, blobs("skills/a/SKILL.md")),
      [`/repos/${repo}`]: () => {
        attempts++;
        if (attempts === 1) return new Response("", { status: 502 });
        if (attempts === 2) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ full_name: repo, default_branch: "main" }));
      },
    },
  });
  const recovered = await checkEntry(entry(), flaky.github);
  assert.equal(attempts, 3);
  assert.deepEqual([recovered.problems, recovered.unchecked], [[], []]);

  let calls = 0;
  const down = fakeGitHub({
    routes: {
      [`/repos/${repo}`]: () => {
        calls++;
        return new Response("", { status: 503 });
      },
    },
  });
  const result = await checkEntry(entry(), down.github);
  assert.equal(calls, 3);
  assert.deepEqual(result.problems, []);
  assert.match(result.unchecked[0], /HTTP 503/);
});

test("a rate limit says what to do and is not retried", async () => {
  let calls = 0;
  const { github } = fakeGitHub({
    routes: {
      "/repos/example-org/skills": () => {
        calls++;
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      },
    },
  });
  const result = await checkEntry(entry(), github);
  assert.equal(calls, 1);
  assert.deepEqual(result.problems, []);
  assert.match(result.unchecked[0], /rate limit.*GITHUB_TOKEN/);
});

test("a SKILL.md that cannot be read leaves that pick unchecked, not the rest", async () => {
  const { github } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/a/SKILL.md", "skills/b/SKILL.md")),
    files: { [raw("skills/b/SKILL.md")]: skillMd("not-b") },
  });
  const result = await checkEntry(entry({ picks: [{ skill: "skills/a" }, { skill: "skills/b" }] }), github);
  assert.deepEqual(result.problems, ['pick skills/b: SKILL.md is named "not-b", expected "b"']);
  assert.equal(result.unchecked.length, 1);
  assert.match(result.unchecked[0], /^pick skills\/a: HTTP 404/);
});

test("the token goes to the API and nowhere else", async () => {
  const { github, requests } = fakeGitHub({
    routes: repoRoutes("example-org/skills", blobs("skills/a/SKILL.md")),
    files: { [raw("skills/a/SKILL.md")]: skillMd("a") },
  });
  await checkEntry(entry({ picks: [{ skill: "skills/a" }] }), github);
  const api = requests.filter((r) => r.hostname === "api.github.com");
  const others = requests.filter((r) => r.hostname !== "api.github.com");
  assert.ok(api.length > 0 && others.length > 0);
  assert.ok(api.every((r) => r.headers.Authorization === "Bearer test-token"));
  assert.ok(others.every((r) => !("Authorization" in r.headers)));
});

test("text from upstream cannot break out of the report", async () => {
  const hostile = "x\n```\n@someone <img src=x>\n::error::y";
  const { github } = fakeGitHub({
    routes: {
      ...repoRoutes("example-org/skills", blobs("skills/a/SKILL.md", `moved${"`"}\n@someone/b/SKILL.md`)),
      "/repos/example-org/skills": { full_name: "example-org/skills", default_branch: "main" },
    },
    files: { [raw("skills/a/SKILL.md")]: `---\nname: "${hostile.replaceAll("\n", "\\n")}"\n---\n` },
  });
  const result = await checkEntry(
    entry({ discovery: { include: ["**"] }, picks: [{ skill: "skills/a" }, { skill: "skills/b" }] }),
    github,
  );
  const { text } = report([result]);
  assert.ok(!text.includes("`"), text);
  for (const line of text.split("\n")) assert.ok(!/^\s*(@|::)/.test(line), line);
  assert.equal(text.split("\n").length, 7, text);
});

test("the report says what passed, what failed and what could not be checked", async () => {
  const healthy = { id: "good", repo: "o/good", revision: { sha: SHA, label: "main" }, skills: 3, picks: 2, hints: 1, problems: [], unchecked: [] };
  const passing = report([healthy]);
  assert.equal(passing.ok, true);
  assert.match(passing.text, /^ok +good +o\/good at aaaaaaa \(main\): 3 skills, 2 picks, 1 hint$/m);
  assert.match(passing.text, /All 1 library resolve: 2 picks, 1 hint\.$/);

  const rotten = { ...healthy, id: "rotten", repo: "o/rotten", problems: ["pick x: no SKILL.md there"] };
  const blocked = { ...healthy, id: "blocked", repo: "o/blocked", revision: null, unchecked: ["HTTP 503"] };
  const failing = report([healthy, rotten, blocked]);
  assert.equal(failing.ok, false);
  assert.match(failing.text, /^FAILED +rotten/m);
  assert.match(failing.text, /^ {4}- pick x: no SKILL\.md there$/m);
  assert.match(failing.text, /^UNCHECKED +blocked +o\/blocked$/m);
  assert.match(failing.text, /^ {4}\? could not check: HTTP 503$/m);
  assert.match(failing.text, /1 problem in 1 of 3 libraries; 1 of 3 libraries could not be fully checked\.$/);
  assert.equal(report([blocked]).ok, false);
});

test("the whole catalog is checked, in order", async () => {
  const repoOne = "example-org/one";
  const { github } = fakeGitHub({ routes: repoRoutes(repoOne, blobs("skills/a/SKILL.md")) });
  const results = await checkCatalog(
    {
      sources: [
        { id: "one", url: `https://github.com/${repoOne}`, discovery: { include: ["skills/**"] } },
        { id: "two", url: "https://github.com/example-org/two", discovery: { include: ["skills/**"] } },
      ],
    },
    github,
  );
  assert.deepEqual(results.map((r) => [r.id, r.problems.length]), [["one", 0], ["two", 1]]);
});
