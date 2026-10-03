import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "./changelog.mjs";
import { buildManifest, releaseNotes } from "./updater-manifest.mjs";

const sample = `# Changelog

Intro.

<!-- maintainers: keep this out of the app -->

## Unreleased

### Next
- Not shipped yet.

## 0.2.0 - 2026-11-03

### Discover
- Reads **more** projects, see [the guide](https://example.com).
  A wrapped line.

### Fixed
- A fix.

## [0.2.0-rc.1] - 2026-10-20

- A candidate.
`;

test("splits releases and keeps their notes as Markdown", () => {
  const { unreleased, releases } = parseChangelog(sample);
  assert.match(unreleased, /Not shipped yet/);
  assert.deepEqual(
    releases.map((r) => [r.version, r.date, r.prerelease]),
    [
      ["0.2.0", "2026-11-03", false],
      ["0.2.0-rc.1", "2026-10-20", true],
    ],
  );
  assert.match(releases[0].markdown, /^### Discover\n- Reads \*\*more\*\* projects/);
  assert.doesNotMatch(releases[0].markdown, /Not shipped|maintainers|Next/);
});

test("refuses what it cannot place", () => {
  assert.throws(() => parseChangelog("# Changelog\n\n## Soon\n- x\n"), /unexpected heading/);
  assert.throws(() => parseChangelog("# Changelog\n\n## 1.0.0\n- x\n"), /needs a release date/);
  assert.throws(() => parseChangelog("# Changelog\n\n## 1.0.0 - 2026-02-31\n- x\n"), /needs a release date/);
  assert.throws(() => parseChangelog("# Changelog\n\n## 1.0.0 - 2026-01-01\n"), /lists no changes/);
  assert.throws(
    () => parseChangelog("# Changelog\n\n## 1.0.0 - 2026-01-01\n- a\n\n## 1.0.0 - 2026-01-02\n- b\n"),
    /appears twice/,
  );
  assert.throws(() => parseChangelog("Changes\n"), /start with/);
});

test("the repository's own changelog parses", () => {
  const text = readFileSync(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), "utf8");
  assert.doesNotThrow(() => parseChangelog(text));
});

test("the update manifest names every platform's installer and signature", () => {
  const files = {
    "Habi_0.2.0_universal.app.tar.gz": "",
    "Habi_0.2.0_universal.app.tar.gz.sig": "MAC-SIG\n",
    "Habi_0.2.0_x64-setup.exe": "",
    "Habi_0.2.0_x64-setup.exe.sig": "WIN-SIG\n",
  };
  const m = buildManifest({ version: "0.2.0", notes: "n", date: "2026-11-03", repo: "o/r", files });
  assert.equal(m.version, "0.2.0");
  assert.equal(m.pub_date, "2026-11-03T00:00:00Z");
  assert.deepEqual(Object.keys(m.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
  assert.equal(m.platforms["darwin-aarch64"].signature, "MAC-SIG");
  assert.equal(
    m.platforms["windows-x86_64"].url,
    "https://github.com/o/r/releases/download/v0.2.0/Habi_0.2.0_x64-setup.exe",
  );
  assert.throws(() => buildManifest({ version: "0.2.0", notes: "", date: "2026-11-03", repo: "o/r", files: {} }), /expected one installer/);
  const { "Habi_0.2.0_x64-setup.exe.sig": _drop, ...unsigned } = files;
  assert.throws(() => buildManifest({ version: "0.2.0", notes: "", date: "2026-11-03", repo: "o/r", files: unsigned }), /no signature/);
});

test("a version with no changelog entry is refused", () => {
  assert.throws(() => releaseNotes(sample, "9.9.9"), /no “## 9.9.9/);
  assert.equal(releaseNotes(sample, "0.2.0").date, "2026-11-03");
});
