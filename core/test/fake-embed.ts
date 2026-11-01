import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

/**
 * A fixed, meaning-free vector for a text: words about food point one way,
 * words about trains another, so a test can tell "related" from "not".
 * Fakes a model; never an embedding of anything real.
 */
export function toyVector(text: string): number[] {
  const t = text.toLowerCase();
  const food = /recipe|cook|cilantro|coriander|thyme|dinner|mushroom|eat|food/.test(t) ? 1 : 0;
  const trains = /train|railway|station|locomotive/.test(t) ? 1 : 0;
  const code = /code|branch|repo|commit/.test(t) ? 1 : 0;
  return [food, trains, code, food || trains || code ? 0 : 1];
}

/**
 * A small OpenAI-compatible embedding server on 127.0.0.1: GET /v1/models
 * and POST /v1/embeddings, answering `vectorFor` each input (toyVector by
 * default). It records every request's model and inputs.
 */
export async function fakeEmbed(opts: { models?: Record<string, unknown>[]; label?: string; vectorFor?: (text: string) => number[] } = {}) {
  const heard: { model: string; input: string[] }[] = [];
  let fail: { status: number } | undefined;
  let refuse: ((text: string) => boolean) | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: opts.models ?? [{ id: "Qwen3-Embedding-0.6B-Q8_0.gguf" }] }));
      }
      if (req.method !== "POST" || req.url !== "/v1/embeddings") { res.writeHead(404); return res.end(); }
      if (fail) { res.writeHead(fail.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "scripted failure" } })); }
      const asked = JSON.parse(body) as { model: string; input: string[] | string };
      const input = Array.isArray(asked.input) ? asked.input : [asked.input];
      // A model that can't take one of the inputs refuses the whole request, as llama-server does.
      if (refuse && input.some(refuse)) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "input too long" } })); }
      heard.push({ model: asked.model, input });
      res.writeHead(200, { "content-type": "application/json" });
      // Answered in reverse order with indexes, as a server may.
      const data = input.map((text, index) => ({ object: "embedding", index, embedding: (opts.vectorFor ?? toyVector)(text) })).reverse();
      res.end(JSON.stringify({ object: "list", data, model: asked.model, usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    heard,
    failWith: (status: number | undefined) => { fail = status === undefined ? undefined : { status }; },
    /** Refuses (400) any request holding an input the predicate matches. */
    refuse: (pred: ((text: string) => boolean) | undefined) => { refuse = pred; },
    stop: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
