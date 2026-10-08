import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupData, restoreData, verifyBackup } from "./data-backup.mjs";

function world(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "habi-backup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "original");
  mkdirSync(path.join(data, "skills", "draft", "package"), { recursive: true });
  mkdirSync(path.join(data, "contributions", "draft"), { recursive: true });
  mkdirSync(path.join(data, "empty"));
  const db = new DatabaseSync(path.join(data, "habi.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE skills (title TEXT); INSERT INTO skills VALUES ('Original work');");
  db.close();
  writeFileSync(path.join(data, "skills/draft/package/SKILL.md"), "Only copy of my draft");
  writeFileSync(path.join(data, "contributions/draft/change.patch"), "Only copy of a contribution");
  return { root, data, backup: path.join(root, "backup"), restored: path.join(root, "restored") };
}

test("full backup and restore preserve authored work, database, empty folders and executable modes", (t) => {
  const w = world(t);
  const script = path.join(w.data, "skills/draft/package/check.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
  backupData(w.data, w.backup, { closed: true });
  verifyBackup(w.backup);
  restoreData(w.backup, w.restored, { closed: true });
  assert.equal(readFileSync(path.join(w.restored, "skills/draft/package/SKILL.md"), "utf8"), "Only copy of my draft");
  assert.equal(readFileSync(path.join(w.restored, "contributions/draft/change.patch"), "utf8"), "Only copy of a contribution");
  assert.ok(statSync(path.join(w.restored, "empty")).isDirectory());
  const db = new DatabaseSync(path.join(w.restored, "habi.db"), { readOnly: true });
  assert.equal(db.prepare("SELECT title FROM skills").get().title, "Original work");
  db.close();
  if (process.platform !== "win32") assert.equal(statSync(path.join(w.restored, "skills/draft/package/check.sh")).mode & 0o777, 0o755);
  assert.doesNotMatch(readFileSync(path.join(w.backup, "manifest.json"), "utf8"), new RegExp(w.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("restore never overwrites existing data and backup cannot be nested inside source", (t) => {
  const w = world(t);
  assert.throws(() => backupData(w.data, path.join(w.data, "backup"), { closed: true }), /outside/);
  backupData(w.data, w.backup, { closed: true });
  assert.throws(() => restoreData(w.backup, w.data, { closed: true }), /already exists/);
  assert.equal(readFileSync(path.join(w.data, "skills/draft/package/SKILL.md"), "utf8"), "Only copy of my draft");
  assert.throws(() => backupData(w.data, w.backup, { closed: true }), /already exists/);
});

test("refuses live SQLite sidecars and requires explicit offline acknowledgement", (t) => {
  const w = world(t);
  assert.throws(() => backupData(w.data, w.backup), /Quit every Habi/);
  writeFileSync(path.join(w.data, "habi.db-wal"), "uncheckpointed data");
  assert.throws(() => backupData(w.data, w.backup, { closed: true }), /sidecars/);
  assert.ok(!existsSync(w.backup));
});

test("corrupt or missing database is refused before publishing a backup", (t) => {
  const w = world(t);
  writeFileSync(path.join(w.data, "habi.db"), "not sqlite");
  assert.throws(() => backupData(w.data, w.backup, { closed: true }));
  assert.ok(!existsSync(w.backup));
});

test("tampering, missing files and unexpected files prevent restore", (t) => {
  const w = world(t);
  backupData(w.data, w.backup, { closed: true });
  const skill = path.join(w.backup, "data/skills/draft/package/SKILL.md");
  writeFileSync(skill, "tampered");
  assert.throws(() => restoreData(w.backup, w.restored, { closed: true }), /verification failed/);
  writeFileSync(skill, "Only copy of my draft");
  writeFileSync(path.join(w.backup, "data/unexpected"), "extra");
  assert.throws(() => verifyBackup(w.backup), /verification failed/);
  rmSync(path.join(w.backup, "data/unexpected"));
  rmSync(skill);
  assert.throws(() => verifyBackup(w.backup), /verification failed/);
  assert.ok(!existsSync(w.restored));
});

test("manifest paths cannot escape the backup and case collisions are refused", (t) => {
  const w = world(t);
  backupData(w.data, w.backup, { closed: true });
  const file = path.join(w.backup, "manifest.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  for (const unsafe of ["../outside", "/outside", "C:/outside", "a\\b", "a//b"]) {
    const manifest = structuredClone(original);
    manifest.entries[0].path = unsafe;
    writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => restoreData(w.backup, w.restored, { closed: true }), /unsafe/);
  }
  original.entries.push({ ...original.entries[0], path: original.entries[0].path.toUpperCase() });
  writeFileSync(file, JSON.stringify(original));
  assert.throws(() => verifyBackup(w.backup), /case-colliding/);
  assert.ok(!existsSync(w.restored));
});

test("symlinks in data or a backup are refused", { skip: process.platform === "win32" }, (t) => {
  const w = world(t);
  symlinkSync(path.join(w.data, "habi.db"), path.join(w.data, "link"));
  assert.throws(() => backupData(w.data, w.backup, { closed: true }), /symbolic link/);
  rmSync(path.join(w.data, "link"));
  backupData(w.data, w.backup, { closed: true });
  const file = path.join(w.backup, "data/skills/draft/package/SKILL.md");
  rmSync(file);
  symlinkSync(path.join(w.data, "skills/draft/package/SKILL.md"), file);
  assert.throws(() => verifyBackup(w.backup), /symbolic link/);
});


test("read-only files remain readable and retain their permissions after restore", (t) => {
  const w = world(t);
  const relative = "skills/draft/package/SKILL.md";
  chmodSync(path.join(w.data, relative), 0o444);
  backupData(w.data, w.backup, { closed: true });
  restoreData(w.backup, w.restored, { closed: true });
  assert.equal(readFileSync(path.join(w.restored, relative), "utf8"), "Only copy of my draft");
  if (process.platform !== "win32") assert.equal(statSync(path.join(w.restored, relative)).mode & 0o777, 0o444);
});
