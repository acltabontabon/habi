import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GALLERY, buildReleaseNotes, size } from "./release-notes.mjs";

const MB = 1024 ** 2;
const input = {
  version: "0.2.0",
  date: "2026-11-03",
  repo: "acltabontabon/habi",
  notes: "### Added\n\n- **Something.** It does a thing.",
  files: {
    "Habi_0.2.0_universal.dmg": 41 * MB,
    "Habi_0.2.0_x64-setup.exe": 19 * MB,
    "Habi_0.2.0_x64_en-US.msi": 20 * MB,
    "SHA256SUMS-macos.txt": 300,
  },
  previous: "0.1.0",
};

test("the download table links each installer on the tag, with its size", () => {
  const body = buildReleaseNotes(input);
  assert.match(body, /href="https:\/\/github\.com\/acltabontabon\/habi\/releases\/download\/v0\.2\.0\/Habi_0\.2\.0_universal\.dmg"/);
  assert.match(body, /<td align="right">41 MB<\/td>/);
  assert.match(body, /Habi_0\.2\.0_x64-setup\.exe/);
  assert.match(body, /Habi_0\.2\.0_x64_en-US\.msi/);
});

test("the changelog entry is the page's notes, and the pictures are read at the tag", () => {
  const body = buildReleaseNotes(input);
  assert.ok(body.includes("## What's new in 0.2.0\n\n### Added\n\n- **Something.** It does a thing."));
  assert.match(body, /github\.com\/acltabontabon\/habi\/raw\/v0\.2\.0\/docs\/media\/release-banner\.jpg/);
  assert.equal(buildReleaseNotes({ ...input, ref: "main" }).includes("/raw/main/docs/media/demo.gif"), true);
});

test("only a release with a predecessor links the comparison", () => {
  assert.match(buildReleaseNotes(input), /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  const first = buildReleaseNotes({ ...input, version: "0.1.0", previous: undefined });
  assert.doesNotMatch(first, /compare\//);
  assert.match(first, /The first release of Habi/);
});

test("a missing installer is left out instead of leaving a broken row", () => {
  const { "Habi_0.2.0_x64_en-US.msi": _msi, ...files } = input.files;
  const body = buildReleaseNotes({ ...input, files });
  assert.doesNotMatch(body, /\.msi/);
});

test("file names are escaped in the table", () => {
  const body = buildReleaseNotes({ ...input, files: { ...input.files, "Habi_0.2.0_universal.dmg": MB } });
  assert.match(body, /<td align="right">1 MB<\/td>/);
  assert.equal(size(2 * 1024 ** 3), "2.0 GB");
});

test("every picture on the page exists in docs/media", () => {
  const media = fileURLToPath(new URL("../docs/media/", import.meta.url));
  for (const file of [...GALLERY.map(([f]) => f), "release-banner.jpg", "demo.gif"]) {
    assert.ok(existsSync(media + file), `docs/media/${file} is missing`);
  }
});

test("the changelog is joined into long lines, with a gap between bullets", async () => {
  const { reflow } = await import("./release-notes.mjs");
  assert.equal(
    reflow("### Added\n\n- **One.** First line\n  and its wrap.\n- **Two.** Second."),
    "### Added\n\n- **One.** First line and its wrap.\n\n- **Two.** Second.",
  );
});

test("the links at the foot are one line, which a release page would otherwise break", () => {
  const body = buildReleaseNotes(input);
  const foot = body.split("\n").find((l) => l.includes("Documentation</a>"));
  assert.match(foot, /Report an issue<\/a> · .*All changes since 0\.1\.0/);
});
