import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCask, sha256Of } from "./homebrew-cask.mjs";

const input = { version: "0.2.0", sha256: "a".repeat(64), repo: "acltabontabon/habi" };

test("the cask points at the universal installer on the tag, with its checksum", () => {
  const cask = buildCask(input);
  assert.match(cask, /^cask "habi" do$/m);
  assert.match(cask, /version "0\.2\.0"/);
  assert.match(cask, new RegExp(`sha256 "${"a".repeat(64)}"`));
  assert.match(cask, /releases\/download\/v#\{version\}\/Habi_#\{version\}_universal\.dmg/);
  assert.doesNotMatch(cask, /verified:/);
});

test("the cask defers to Habi's own updater and says the app is unsigned", () => {
  const cask = buildCask(input);
  assert.match(cask, /auto_updates true/);
  assert.match(cask, /not signed or notarized by Apple/);
});

test("zap leaves the data folder alone", () => {
  const cask = buildCask(input);
  assert.doesNotMatch(cask, /Application Support/);
  assert.match(cask, /~\/Library\/Caches\/com\.acltabontabon\.habi/);
});

test("the checksum is the installer's SHA-256", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "habi-cask-")), "x.dmg");
  writeFileSync(file, "abc");
  assert.equal(sha256Of(file), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
