#!/usr/bin/env node
// A tiny MCP server over stdio for tests: `initialize`, `tools/list` and
// `tools/call`, newline-delimited JSON-RPC. Its one tool, `whoami`, answers
// with the WHO variable of its environment and whether it sees the PATH it
// was started with, so a test can check what reaches a local server. With
// MCP_TEST_FAIL set it writes that to stderr and exits at once, as a program
// missing its keys would. It logs each request to stderr, as servers do.
const readline = require("node:readline");

if (process.env.MCP_TEST_FAIL) {
  process.stderr.write(`${process.env.MCP_TEST_FAIL}\n`);
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  process.stderr.write(`request ${m.method}\n`);
  if (m.id === undefined) return;
  let result;
  if (m.method === "initialize") {
    result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio-test", version: "1" }, instructions: "A test server on stdio." };
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "started" } });
  } else if (m.method === "tools/list") {
    result = { tools: [{ name: "whoami", description: "who", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] };
  } else if (m.method === "tools/call") {
    result = { content: [{ type: "text", text: JSON.stringify({ who: process.env.WHO ?? null, home: process.env.HOME ?? null, secret: process.env.MCP_TEST_SECRET ?? null, cwd: process.cwd(), ...process.env.BASH_ENV ? { bashEnv: process.env.BASH_ENV } : {} }) }] };
  } else if (m.method === "ping") {
    result = {};
  } else {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
    return;
  }
  send({ jsonrpc: "2.0", id: m.id, result });
});
rl.on("close", () => process.exit(0));
