import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReleaseNotes, size } from "./release-notes.mjs";

const MB = 1024 ** 2;
const input = {
  version: "0.2.0",
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
  assert.match(body, /\(https:\/\/github\.com\/acltabontabon\/habi\/releases\/download\/v0\.2\.0\/Habi_0\.2\.0_universal\.dmg\) \| 41 MB \|/);
  assert.match(body, /Habi_0\.2\.0_x64-setup\.exe/);
  assert.match(body, /Habi_0\.2\.0_x64_en-US\.msi/);
});

test("the changelog entry is the page's notes", () => {
  const body = buildReleaseNotes(input);
  assert.ok(body.includes("## What's new in 0.2.0\n\n### Added\n\n- **Something.** It does a thing."));
});

test("the page is plain text: no pictures, badges or layout tables", () => {
  const body = buildReleaseNotes(input);
  assert.doesNotMatch(body, /<img|<table|<div|!\[|shields\.io/);
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

test("sizes are in megabytes, or gigabytes when large", () => {
  const body = buildReleaseNotes({ ...input, files: { ...input.files, "Habi_0.2.0_universal.dmg": MB } });
  assert.match(body, /\| 1 MB \|/);
  assert.equal(size(2 * 1024 ** 3), "2.0 GB");
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
  const foot = body.split("\n").find((l) => l.includes("[Documentation]"));
  assert.match(foot, /\[Report an issue\]\(.*\) · .*All changes since 0\.1\.0/);
});

test("upgrade guidance uses this release's tag", () => {
  const body = buildReleaseNotes(input);
  assert.match(body, /Upgrading from 0\.1\.0/);
  assert.match(body, /blob\/v0\.2\.0\/docs\/guide\/recovery\.md#back-up-and-restore-all-local-data/);
  assert.doesNotMatch(buildReleaseNotes({ ...input, previous: undefined }), /Upgrading from/);
});
