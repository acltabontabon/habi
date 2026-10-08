import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENTS, PLATFORM_CHECKS, checkReadiness, verifyArtifacts } from "./release-readiness.mjs";

const options = { tag: "v0.2.0", revision: "a".repeat(40), now: Date.parse("2026-10-08T12:00:00Z") };
const sha256 = createHash("sha256").update("artifact").digest("hex");
function complete() {
  return {
    version: "0.2.0", revision: options.revision,
    agents: AGENTS.map((agent) => ({ agent, version: "test-version", checkedAt: "2026-10-08T00:00:00Z", evidence: "Captured discovery output", skillFound: true, skillInvoked: true, instructionsRead: true, mcpListed: true, mcpResponds: true })),
    platforms: ["macos", "windows"].map((platform) => ({ platform, osVersion: "test-os", upgradedFrom: "0.1.0", checkedAt: "2026-10-08T00:00:00Z", evidence: "Recorded test log", checks: Object.fromEntries(PLATFORM_CHECKS.map((c) => [c, true])), artifacts: (platform === "macos" ? ["Habi.dmg", "Habi.app.tar.gz"] : ["Habi.msi", "Habi-setup.exe"]).map((name) => ({ name, sha256 })) })),
  };
}

test("complete unsigned release evidence passes; missing, failed or duplicate results fail", () => {
  assert.deepEqual(checkReadiness(complete(), options), []);
  for (const mutation of [(r) => r.agents.pop(), (r) => r.agents.push(r.agents[0]), (r) => { r.agents[0].skillFound = false; }, (r) => { r.platforms[1].checks.diskFullRecovery = false; }, (r) => { r.platforms[0].upgradedFrom = r.version; }, (r) => { r.platforms[0].artifacts = []; }]) {
    const record = complete(); mutation(record);
    assert.ok(checkReadiness(record, options).length > 0);
  }
});

test("stale, future, unversioned or wrong-revision evidence cannot bless a release", () => {
  for (const date of ["", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"]) {
    const record = complete(); record.agents[0].checkedAt = date;
    assert.ok(checkReadiness(record, options).some((e) => e.includes("30 days")));
  }
  const record = complete(); record.revision = "b".repeat(40);
  assert.ok(checkReadiness(record, options).some((e) => e.includes("commit")));
  record.version = "0.1.0";
  assert.ok(checkReadiness(record, options).some((e) => e.includes("version")));
  assert.ok(checkReadiness({}, options).length > 0);
});

test("checks actual artifact hashes, rejects tampering and unsafe paths", (t) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "habi-artifacts-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const record = complete();
  for (const platform of record.platforms) for (const artifact of platform.artifacts) writeFileSync(path.join(folder, artifact.name), "artifact");
  verifyArtifacts(record, folder);
  writeFileSync(path.join(folder, "Habi.dmg"), "changed");
  assert.throws(() => verifyArtifacts(record, folder), /differs/);
  record.platforms[0].artifacts[0].name = "../outside";
  assert.throws(() => verifyArtifacts(record, folder), /Unsafe/);
  assert.ok(checkReadiness(record, options).some((e) => e.includes("invalid artifact")));
});
