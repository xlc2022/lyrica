import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A tool the test server offers, and what calling it answers. */
export interface TestTool { name: string; readOnly?: boolean; answer?: (args: Record<string, unknown>) => string }

/**
 * A tiny MCP server over streamable HTTP (JSON responses, no SSE), in this
 * process, for tests: `initialize`, `tools/list` and `tools/call`. With a
 * token, a request without `Authorization: Bearer <token>` gets 401.
 */
export async function testMcpServer(o: { tools?: TestTool[]; token?: string; instructions?: string; port?: number } = {}) {
  const tools = o.tools ?? [{ name: "get_status", readOnly: true }, { name: "turn_on" }];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const seen = { requests: 0 };
  const server: Server = createServer((req, res) => {
    seen.requests++;
    if (o.token && req.headers.authorization !== `Bearer ${o.token}`) { res.writeHead(401).end(); return; }
    if (req.method !== "POST") { res.writeHead(req.method === "DELETE" ? 200 : 405).end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const m = JSON.parse(body) as { id?: number | string; method: string; params?: Record<string, unknown> };
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown;
      if (m.method === "initialize") {
        result = { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" }, instructions: o.instructions ?? "Test tools for the house." };
      } else if (m.method === "tools/list") {
        result = { tools: tools.map((t) => ({ name: t.name, description: `${t.name} tool`, inputSchema: { type: "object", properties: { entity: { type: "string" } } }, annotations: { readOnlyHint: !!t.readOnly } })) };
      } else if (m.method === "tools/call") {
        const name = String(m.params?.name);
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        calls.push({ tool: name, args });
        const t = tools.find((x) => x.name === name);
        result = { content: [{ type: "text", text: t?.answer ? t.answer(args) : `${name} done` }] };
      } else if (m.method === "ping") {
        result = {};
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, calls, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
