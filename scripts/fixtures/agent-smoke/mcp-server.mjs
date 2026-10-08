#!/usr/bin/env node
// Disposable stdio MCP fixture (2025-06-18); no filesystem or network access.
// https://modelcontextprotocol.io/specification/2025-06-18/server/tools
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); }
  catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } })}\n`); continue; }
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "habi-smoke", version: "1.0.0" } }; break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: [{ name: "habi_ping", description: "Returns the Habi MCP test marker without side effects", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }; break;
    case "tools/call":
      if (request.params?.name === "habi_ping") result = { content: [{ type: "text", text: "HABI-MCP-PONG" }] };
      break;
  }
  const response = result === undefined
    ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method or tool" } }
    : { jsonrpc: "2.0", id: request.id, result };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
