#!/usr/bin/env node
/** Offline, verified backups of the entire Habi data directory. Node.js 24+. */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const FORMAT = "habi-data-backup-1";
const MAX_MANIFEST = 64 * 1024 * 1024;

function digest(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    let n;
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":") || /[\x00-\x1f\x7f]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Backup contains an unsafe relative path");
  }
  return value;
}

function pathExists(value) {
  try { lstatSync(value); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

function directory(value) {
  if (!lstatSync(value).isDirectory()) throw new Error("Expected an ordinary directory, not a link");
  return realpathSync(value);
}

function scan(root) {
  const entries = [];
  function walk(dir, prefix) {
    for (const name of readdirSync(dir).sort()) {
      const relative = safeRelative(prefix ? `${prefix}/${name}` : name);
      const file = path.join(dir, name);
      const info = lstatSync(file);
      if (info.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode: info.mode & 0o777 });
        walk(file, relative);
      } else if (info.isFile()) {
        entries.push({ path: relative, kind: "file", mode: info.mode & 0o777, size: info.size, sha256: digest(file) });
      } else throw new Error(`Refusing a symbolic link or special file: ${relative}`);
    }
  }
  walk(root, "");
  return entries;
}

function checkDatabase(root) {
  // A sidecar can contain committed data absent from habi.db. Never copy a live
  // WAL piecemeal; quit all Habi processes and let SQLite checkpoint first.
  if (existsSync(path.join(root, "habi.db-wal")) || existsSync(path.join(root, "habi.db-shm"))) {
    throw new Error("SQLite sidecars exist. Quit every Habi app/CLI process; open and close Habi cleanly before backing up.");
  }
  const file = path.join(root, "habi.db");
  if (!existsSync(file)) throw new Error("No habi.db found; choose Habi's data folder");
  if (!lstatSync(file).isFile()) throw new Error("habi.db must be an ordinary file");
  // Opening a WAL-mode database, even read-only, can create sidecars.
  // Validate a disposable copy so neither the original nor the backup changes.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "habi-integrity-"));
  let db;
  try {
    const copy = path.join(scratch, "habi.db");
    copyFileSync(file, copy);
    db = new DatabaseSync(copy, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new Error("Database integrity check failed; preserve the original data for recovery");
  } finally { db?.close(); rmSync(scratch, { recursive: true, force: true }); }
}

function matches(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function copyEntries(from, to, entries) {
  for (const entry of entries) {
    const target = path.join(to, entry.path);
    if (entry.kind === "directory") mkdirSync(target, { mode: 0o700 });
    else {
      copyFileSync(path.join(from, entry.path), target);
      // copyFile preserves read-only modes; temporarily permit the flush handle.
      chmodSync(target, entry.mode | 0o600);
      const fd = openSync(target, "r+");
      try { fchmodSync(fd, entry.mode); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  // Apply restrictive directory modes only once their children are copied.
  for (const entry of entries.toReversed()) {
    if (entry.kind === "directory") chmodSync(path.join(to, entry.path), entry.mode);
  }
}

function publishDirectory(destination, source, action) {
  const parent = directory(path.dirname(path.resolve(destination)));
  const target = path.join(parent, path.basename(destination));
  if (pathExists(target)) {
    throw new Error("Destination already exists; choose a new folder");
  }
  if (target === source || target.startsWith(`${source}${path.sep}`)) throw new Error("Destination must be outside the source folder");
  const stage = mkdtempSync(path.join(parent, ".habi-backup-"));
  try {
    action(stage);
    // Recheck before publishing. This tool requires an offline, user-owned
    // destination; it is not designed for hostile concurrent directory edits.
    if (pathExists(target)) throw new Error("Destination appeared while copying; nothing was replaced");
    renameSync(stage, target);
    return target;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function backupData(source, destination, { closed = false } = {}) {
  if (!closed) throw new Error("Quit every Habi process first, then pass --closed");
  const root = directory(source);
  checkDatabase(root);
  const entries = scan(root);
  return publishDirectory(destination, root, (stage) => {
    const payload = path.join(stage, "data");
    mkdirSync(payload, { mode: 0o700 });
    copyEntries(root, payload, entries);
    checkDatabase(payload);
    checkDatabase(root);
    if (!matches(entries, scan(payload)) || !matches(entries, scan(root))) throw new Error("Data changed during backup, or the copy does not match; quit Habi and retry");
    writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify({ format: FORMAT, createdAt: new Date().toISOString(), entries }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    verifyBackup(stage);
  });
}

export function verifyBackup(folder) {
  const root = directory(folder);
  const manifestPath = path.join(root, "manifest.json");
  if (!lstatSync(manifestPath).isFile() || statSync(manifestPath).size > MAX_MANIFEST) throw new Error("Invalid or oversized backup manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.entries)) throw new Error("Unsupported backup format");
  const seen = new Set();
  for (const entry of manifest.entries) {
    const relative = safeRelative(entry.path);
    const folded = relative.toLowerCase();
    if (seen.has(folded)) throw new Error("Duplicate or case-colliding backup path");
    seen.add(folded);
    if (!["file", "directory"].includes(entry.kind) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error("Invalid backup entry");
    if (entry.kind === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error("Invalid file checksum or size");
  }
  const payload = directory(path.join(root, "data"));
  if (!matches(manifest.entries, scan(payload))) throw new Error("Backup verification failed: missing, changed, or unexpected files");
  checkDatabase(payload);
  return { root, payload, entries: manifest.entries };
}

export function restoreData(folder, destination, { closed = false } = {}) {
  if (!closed) throw new Error("Quit every Habi process first, then pass --closed");
  const verified = verifyBackup(folder);
  return publishDirectory(destination, verified.root, (stage) => {
    copyEntries(verified.payload, stage, verified.entries);
    checkDatabase(stage);
    if (!matches(verified.entries, scan(stage))) throw new Error("Restored copy does not match the backup");
  });
}

function main([command, source, destination, ...flags]) {
  const closed = flags.length === 1 && flags[0] === "--closed";
  if (command === "verify" && source && !destination) {
    const { entries } = verifyBackup(source);
    console.log(`Verified ${entries.filter((e) => e.kind === "file").length} files`);
  } else if (["backup", "restore"].includes(command) && source && destination && closed) {
    const result = command === "backup" ? backupData(source, destination, { closed }) : restoreData(source, destination, { closed });
    console.log(`${command === "backup" ? "Verified backup" : "Verified restore"}: ${result}`);
  } else throw new Error("Usage: node scripts/data-backup.mjs backup|restore <source> <new-folder> --closed\n       node scripts/data-backup.mjs verify <backup-folder>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`data-backup: ${e.message}`); process.exitCode = 1; }
}
