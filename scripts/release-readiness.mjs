#!/usr/bin/env node
/** Validate recorded agent discovery and packaged-app checks for one exact release. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS = ["claude-code", "cursor", "codex", "gemini-cli", "copilot", "opencode", "junie"];
export const PLATFORM_CHECKS = ["cleanInstall", "launch", "upgradePreservesData", "updaterRejectsTampering", "offlineEditing", "interruptedInstallRecovery", "diskFullRecovery", "permissionFailureRecovery", "concurrentOperations", "backupRestore", "largeRepository"];
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const TAG = /^v\d+\.\d+\.\d+$/;

export function checkReadiness(record, { tag, revision, now = Date.now() }) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  function fresh(value, label) {
    const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
    require(Number.isFinite(date) && date <= now && now - date <= MAX_AGE, `${label}: checks must be dated within the last 30 days, never in the future`);
  }
  require(TAG.test(tag), "A stable vX.Y.Z tag is required");
  require(record?.version === tag?.slice(1), "Evidence version does not match the release tag");
  require(/^[a-f0-9]{40}$/.test(record?.revision ?? "") && record?.revision === revision, "Evidence revision does not match the tagged commit");
  for (const agent of AGENTS) {
    const matches = Array.isArray(record?.agents) ? record.agents.filter((r) => r.agent === agent) : [];
    require(matches.length === 1, `${agent}: exactly one result is required`);
    const result = matches[0];
    if (!result) continue;
    require(text(result.version) && text(result.evidence), `${agent}: record the installed tool version and evidence`);
    fresh(result.checkedAt, agent);
    for (const check of ["skillFound", "skillInvoked", "instructionsRead", "mcpListed", "mcpResponds"]) require(result[check] === true, `${agent}: ${check} has not passed`);
  }
  for (const platform of ["macos", "windows"]) {
    const matches = Array.isArray(record?.platforms) ? record.platforms.filter((r) => r.platform === platform) : [];
    require(matches.length === 1, `${platform}: exactly one packaged-app result is required`);
    const result = matches[0];
    if (!result) continue;
    require(text(result.osVersion) && text(result.evidence), `${platform}: record the OS version and evidence`);
    require(text(result.upgradedFrom) && result.upgradedFrom !== record.version, `${platform}: record a previous version used for the upgrade test`);
    fresh(result.checkedAt, platform);
    for (const check of PLATFORM_CHECKS) require(result.checks?.[check] === true, `${platform}: ${check} has not passed`);
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const patterns = platform === "macos" ? [/\.dmg$/, /\.app\.tar\.gz$/] : [/\.msi$/, /-setup\.exe$/];
    for (const pattern of patterns) require(artifacts.filter((a) => typeof a.name === "string" && pattern.test(a.name)).length === 1, `${platform}: record exactly one artifact matching ${pattern}`);
    for (const artifact of artifacts) require(/^[a-zA-Z0-9_.-]+$/.test(artifact.name ?? "") && /^[a-f0-9]{64}$/.test(artifact.sha256 ?? ""), `${platform}: invalid artifact name or SHA-256`);
  }
  const names = (record?.platforms ?? []).flatMap((p) => (p.artifacts ?? []).map((a) => a.name));
  require(new Set(names).size === names.length, "Artifact names must be unique");
  return errors;
}

export function verifyArtifacts(record, folder) {
  for (const platform of record.platforms) {
    for (const artifact of platform.artifacts) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(artifact.name)) throw new Error("Unsafe artifact name");
      const file = path.join(folder, artifact.name);
      if (!lstatSync(file).isFile()) throw new Error(`${artifact.name}: expected an ordinary artifact file`);
      const hash = createHash("sha256");
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(128 * 1024);
        let n;
        while ((n = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, n));
      } finally { closeSync(fd); }
      if (hash.digest("hex") !== artifact.sha256) throw new Error(`${artifact.name}: the downloaded artifact differs from the tested one`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [tag, evidence, artifacts] = process.argv.slice(2);
    if (!TAG.test(tag ?? "") || !evidence || !artifacts) throw new Error("Usage: node scripts/release-readiness.mjs vX.Y.Z <evidence.json> <downloaded-artifact-folder>");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const revision = execFileSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
    const record = JSON.parse(readFileSync(evidence, "utf8"));
    const errors = checkReadiness(record, { tag, revision });
    if (errors.length) throw new Error(errors.join("\n"));
    verifyArtifacts(record, artifacts);
    console.log(`${tag}: agent discovery, packaged-app evidence and artifact hashes verified. Installers remain unsigned; this check does not require OS code signing.`);
  } catch (e) { console.error(`release-readiness: ${e.message}`); process.exitCode = 1; }
}
