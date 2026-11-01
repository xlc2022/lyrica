import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { McpClient } from "@earendil-works/pi-mcp";
import { mcpCommand, mcpCommandLine, mcpEnv, mcpPlace, mcpStdioTransport, probeMcpCommand, shellWords, type McpProcess } from "../src/index.ts";

// A local MCP server (docs/briefs/mcp-local.md): started by whoever hands the
// transport a process (the thread's sandbox, in lyricad), spoken to on its
// pipes, with its stderr held in memory only for the line that says why it
// didn't answer.

const SCRIPT = new URL("./mcp-stdio.cjs", import.meta.url).pathname;
const start = (env: Record<string, string> = {}) => async () => spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }) as McpProcess;

describe("a local MCP server's command and environment", () => {
  it("splits a command line like a shell, without expanding anything, and keeps the program a name or a path", () => {
    expect(shellWords(`ebay-mcp-server --env "production mode" 'it''s' a\\ b`)).toEqual(["ebay-mcp-server", "--env", "production mode", "its", "a b"]);
    expect(mcpCommand("  node  /srv/mcp/server.js  ")).toEqual(["node", "/srv/mcp/server.js"]);
    expect(mcpCommand("npx -y @ebay/npm-public-api-mcp")).toEqual(["npx", "-y", "@ebay/npm-public-api-mcp"]);
    expect(() => mcpCommand("")).toThrow(/program and its arguments/);
    expect(() => mcpCommand("$HOME/bin/server")).toThrow(/name on the sandbox's PATH/);
    expect(() => mcpCommand("-x")).toThrow(/name on the sandbox's PATH/);
    expect(() => mcpCommand("server 'unclosed")).toThrow(/isn't closed/);
    expect(() => mcpCommand("server\nrm -rf /")).toThrow(/one line/);
    expect(mcpCommandLine(["node", "my server.js", "it's"])).toBe(`node 'my server.js' 'it'\\''s'`);
    expect(mcpCommand(mcpCommandLine(["node", "my server.js", "it's"]))).toEqual(["node", "my server.js", "it's"]);
  });

  it("reads KEY=value lines as they are, and refuses what isn't one", () => {
    expect(mcpEnv("EBAY_CLIENT_ID=abc\n\n# a comment\nEBAY_CLIENT_SECRET=\"s=cr=et\"\nEMPTY=")).toEqual({ EBAY_CLIENT_ID: "abc", EBAY_CLIENT_SECRET: "s=cr=et", EMPTY: "" });
    expect(() => mcpEnv("not a variable")).toThrow(/isn't a variable name/);
    expect(() => mcpEnv("KEY")).toThrow(/needs a value/);
    expect(() => mcpEnv("1KEY=x")).toThrow(/isn't a variable name/);
    expect(mcpPlace({ url: "", command: ["ebay-mcp-server"] })).toBe("this machine");
    expect(mcpPlace({ url: "https://mcp.example.com/mcp", command: [] })).toBe("mcp.example.com");
  });
});

describe("a local MCP server's transport", () => {
  it("answers initialize and tools/list through the probe, and says what a program that stops at once wrote", async () => {
    expect(await probeMcpCommand(start())).toEqual({ tools: 1, description: "A test server on stdio." });
    await expect(probeMcpCommand(start({ MCP_TEST_FAIL: "EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required" }))).rejects.toThrow(/the program didn't answer as an MCP server: .*it said: EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required/);
    await expect(probeMcpCommand(async () => { throw new Error("this thread already has 4 background commands running"); })).rejects.toThrow(/4 background commands/);
  });

  it("drops the server's log notifications, hands its results on, records its state, and stops the process when closed", async () => {
    const states: string[] = [];
    let child: McpProcess | undefined;
    const transport = mcpStdioTransport({ start: async () => { child = await start({ WHO: "ada" })(); return child; }, state: (k) => states.push(k) });
    const logs: string[] = [];
    transport.onMessage((m) => { if ("method" in m && m.method === "notifications/message") logs.push(m.method); });
    const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 5000 });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["whoami"]);
    const result = await client.callTool("whoami", {});
    const text = (result.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ who: "ada" });
    expect(logs).toEqual([]);
    expect(states).toEqual(["online"]);
    await client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(child!.exitCode).not.toBeNull();
  });

  it("records unreachable when the program can't start", async () => {
    const states: string[] = [];
    const transport = mcpStdioTransport({ start: async () => { throw new Error("no such program"); }, state: (k) => states.push(k) });
    await expect(transport.start()).rejects.toThrow(/no such program/);
    expect(states).toEqual(["unreachable"]);
  });
});
