import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

/** What the fake answers to one chat request: text, a tool call, or an HTTP error. */
export type Reply = { text: string } | { tool: { name: string; args: unknown } } | { status: number };

export interface ChatRequest { model: string; messages: { role: string; content?: unknown; tool_calls?: unknown }[]; tools?: { function: { name: string } }[]; stream?: boolean }

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });

/**
 * A small OpenAI-compatible server on 127.0.0.1: GET /v1/models and streaming
 * POST /v1/chat/completions. It records every chat request. Replies come from
 * the queue, then `fallback`.
 */
export async function fakeOpenAI(opts: { models?: Record<string, unknown>[]; label?: string } = {}) {
  const requests: ChatRequest[] = [];
  const queue: Reply[] = [];
  const label = opts.label ?? "fake";
  let modelLists = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        modelLists++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: opts.models ?? [{ id: "m1", object: "model" }] }));
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
      const chat = JSON.parse(body) as ChatRequest;
      requests.push(chat);
      const reply = queue.shift() ?? { text: `ok from ${label}` };
      if ("status" in reply) { res.writeHead(reply.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "scripted failure" } })); }
      const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: chat.model };
      const delta = "text" in reply
        ? { role: "assistant", content: reply.text }
        : { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] };
      const finish = "text" in reply ? "stop" : "tool_calls";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    reply: (...r: Reply[]) => { queue.push(...r); },
    get modelLists() { return modelLists; },
  };
}

/** A base URL nothing listens on. */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}/v1`;
}
