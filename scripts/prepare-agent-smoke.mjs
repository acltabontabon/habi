#!/usr/bin/env node
/** Install a disposable compatibility fixture through the real Habi CLI. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function prepareSmoke(destination, executable) {
  const habi = realpathSync(executable);
  const root = path.resolve(destination);
  if (existsSync(root)) throw new Error("Choose a new, disposable folder; existing folders are never changed");
  mkdirSync(root, { mode: 0o700 });
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/agent-smoke");
  const project = path.join(root, "project");
  const library = path.join(root, "library");
  mkdirSync(project);
  mkdirSync(path.join(project, ".habi-smoke"));
  cpSync(path.join(fixtures, "library"), library, { recursive: true });
  cpSync(path.join(fixtures, "mcp-server.mjs"), path.join(project, ".habi-smoke/mcp-server.mjs"));
  writeFileSync(path.join(project, "README.md"), "# Disposable Habi compatibility project\n\nOpen this folder in the agent being tested.\n");
  // Absolute executable/script paths avoid depending on an agent's working directory or PATH.
  writeFileSync(path.join(library, "skills/habi-smoke-test/habi.yaml"), `habi: 1\ntitle: Habi smoke test\nowner: Habi maintainers\nscope: repository\napplies_when:\n  file: README.md\nrequires:\n  mcp:\n    - name: habi-smoke\n      purpose: Returns a test marker with no side effects.\n      server:\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(path.join(project, ".habi-smoke/mcp-server.mjs"))}]\n`);
  const env = { ...process.env, HABI_HOME: path.join(root, "data") };
  const run = (args) => execFileSync(habi, ["--json", ...args], { cwd: project, env, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  run(["validate", library]);
  run(["source", "add", "Smoke", library]);
  run(["source", "refresh", "Smoke"]);
  const clients = "claude-code,cursor,codex,gemini-cli,copilot,opencode,junie";
  writeFileSync(path.join(root, "skill-install.json"), run(["install", "Smoke/habi-smoke-test", "--client", clients, "--mcp", "--yes"]));
  writeFileSync(path.join(root, "instruction-install.json"), run(["install", "Smoke/habi-smoke-instructions", "--client", clients, "--yes"]));
  writeFileSync(path.join(root, "status.json"), run(["status"]));
  return { root, project };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [destination, executable] = process.argv.slice(2);
    if (!destination || !executable) throw new Error("Usage: node scripts/prepare-agent-smoke.mjs <new-folder> <habi-cli-binary>");
    const { project } = prepareSmoke(destination, executable);
    console.log(`Fixture installed through Habi in ${project}\nRun each agent there and record discovery, invocation, instructions, and MCP results. File generation alone is not a pass.`);
  } catch (e) { console.error(`prepare-agent-smoke: ${e.message}`); process.exitCode = 1; }
}
