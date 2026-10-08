import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareSmoke } from "./prepare-agent-smoke.mjs";

const server = fileURLToPath(new URL("./fixtures/agent-smoke/mcp-server.mjs", import.meta.url));
test("MCP fixture negotiates, lists and calls its no-op tool without extra stdout", () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "habi_ping", arguments: {} } },
  ];
  const result = spawnSync(process.execPath, [server], { input: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map((r) => JSON.parse(r));
  assert.equal(replies.length, 3);
  assert.equal(replies[0].result.protocolVersion, "2025-06-18");
  assert.equal(replies[1].result.tools[0].name, "habi_ping");
  assert.equal(replies[2].result.content[0].text, "HABI-MCP-PONG");
});

test("preparation refuses existing folders before making changes", (t) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "habi-smoke-existing-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.throws(() => prepareSmoke(folder, process.execPath), /existing folders/);
});

// CI opts in after building the CLI. This verifies the real installer, not agent discovery.
test("real CLI prepares the seven-agent fixture with all configuration files", { skip: !process.env.HABI_SMOKE_CLI }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "habi-smoke-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { project } = prepareSmoke(path.join(root, "test"), process.env.HABI_SMOKE_CLI);
  for (const file of [".claude/skills/habi-smoke-test/SKILL.md", ".agents/skills/habi-smoke-test/SKILL.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".mcp.json", ".cursor/mcp.json", ".codex/config.toml", ".gemini/settings.json", "opencode.json", ".junie/mcp/mcp.json"]) {
    assert.ok(readFileSync(path.join(project, file), "utf8").length > 0, file);
  }
});
