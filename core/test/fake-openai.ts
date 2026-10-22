import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

/** What the fake answers to one chat request: text, streamed deltas, a tool call, or an HTTP error. */
export type Reply = { text: string; slowMs?: number } | { tools: { name: string; args: unknown; id?: string }[] } | { status: number; message?: string } | { deltas: { content?: string; reasoning_content?: string }[] };
/** Picks the reply from the request, and may take its time. */
export type Responder = (chat: ChatRequest) => Reply | Promise<Reply>;

export interface ChatRequest { model: string; messages: { role: string; content?: unknown; tool_calls?: unknown }[]; tools?: { function: { name: string } }[]; stream?: boolean }

const servers: Server[] = [];
// A test may leave a request unanswered on purpose; close() would wait for it forever.
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))); });

/**
 * A small OpenAI-compatible server on 127.0.0.1: GET /v1/models and streaming
 * POST /v1/chat/completions, with `lmStudio` LM Studio's GET /api/v1/models, and with `props` llama-server's GET /props. It records every chat request. Replies come from
 * the queue, then the responder, then a default text.
 */
export async function fakeOpenAI(opts: { models?: Record<string, unknown>[]; label?: string; port?: number; lmStudio?: Record<string, unknown>[]; props?: Record<string, Record<string, unknown>> } = {}) {
  const requests: ChatRequest[] = [];
  const queue: (Reply | Responder)[] = [];
  let responder: Responder | undefined;
  const label = opts.label ?? "fake";
  let modelLists = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        modelLists++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: opts.models ?? [{ id: "m1", object: "model" }] }));
      }
      // LM Studio's own API, when it plays LM Studio.
      if (req.method === "GET" && req.url === "/api/v1/models" && opts.lmStudio) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: opts.lmStudio }));
      }
      // llama-server's /props, when it plays llama-server: by model in router mode (`?model=`), else the "" entry.
      if (req.method === "GET" && req.url?.startsWith("/props") && opts.props) {
        const props = opts.props[new URL(req.url, "http://x").searchParams.get("model") ?? ""];
        if (!props) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(props));
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
      const chat = JSON.parse(body) as ChatRequest;
      requests.push(chat);
      const next = queue.shift() ?? responder ?? { text: `ok from ${label}` };
      const reply = typeof next === "function" ? await next(chat) : next;
      if ("status" in reply) { res.writeHead(reply.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: reply.message ?? "scripted failure" } })); }
      const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: chat.model };
      const delta = "text" in reply
        ? { role: "assistant", content: reply.text }
        : "deltas" in reply ? {} : { role: "assistant", tool_calls: reply.tools.map((t, index) => ({ index, id: t.id ?? `call_${index + 1}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) };
      const finish = "tools" in reply ? "tool_calls" : "stop";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if ("deltas" in reply) {
        for (const delta of reply.deltas) send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
      } else if ("text" in reply && reply.slowMs) {
        // A model that takes its time: the first word, a pause, then the rest.
        const [head, ...rest] = reply.text.split(" ");
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: head }, finish_reason: null }] });
        await new Promise((r) => setTimeout(r, reply.slowMs));
        send({ ...base, choices: [{ index: 0, delta: { content: rest.length ? ` ${rest.join(" ")}` : "" }, finish_reason: null }] });
      } else send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      // About a token per four characters of the request, as a real server would count it.
      const prompt = Math.ceil(body.length / 4);
      send({ ...base, choices: [], usage: { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  // A port given back: the same machine, switched on again.
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    reply: (...r: (Reply | Responder)[]) => { queue.push(...r); },
    /** Answers every request the queue doesn't. */
    respond: (fn: Responder) => { responder = fn; },
    get modelLists() { return modelLists; },
    /** Goes away, as a machine that was switched off. */
    stop: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
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
