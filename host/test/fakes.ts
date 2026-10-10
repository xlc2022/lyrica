// Fake GPUs and model servers, so host-api runs without a GPU.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Backend } from "../src/backends.ts";
import type { Gpu, GpuMonitor } from "../src/gpus.ts";
import type { TextModel } from "../src/library.ts";

export const GIB = 1024 ** 3;

/** GPUs whose used memory is a baseline plus what the fake backend loaded. */
export class FakeGpus implements GpuMonitor {
  readonly gpus: Gpu[];
  readonly loaded = new Map<string, { gpu: number; bytes: number }>();

  constructor(totals: number[], baseline = GIB) {
    this.gpus = totals.map((t, index) => ({ index, name: `Fake GPU ${index}`, vendor: "nvidia", total: t * GIB, used: baseline }));
  }

  async read(): Promise<Gpu[]> {
    return this.gpus.map((g) => ({ ...g, used: g.used + [...this.loaded.values()].filter((l) => l.gpu === g.index).reduce((n, l) => n + l.bytes, 0) }));
  }
}

/** A backend that "loads" a model by taking its size (plus 10%) on the fake GPU. */
export class FakeBackend implements Backend {
  readonly calls: string[] = [];
  readonly gpus: FakeGpus;
  loadMs = 0;
  slept = false;

  constructor(gpus: FakeGpus) {
    this.gpus = gpus;
  }

  async load(model: TextModel, gpu: number) {
    this.calls.push(`load ${model.id}@${gpu}`);
    await new Promise((r) => setTimeout(r, this.loadMs));
    this.gpus.loaded.set(model.id, { gpu, bytes: Math.round(model.size * 1.1) });
  }
  async unload(model: TextModel) {
    this.calls.push(`unload ${model.id}`);
    this.gpus.loaded.delete(model.id);
  }
  url() {
    return "http://fake";
  }
  async reset() {
    for (const id of [...this.gpus.loaded.keys()]) this.gpus.loaded.delete(id);
  }
  async sleep() {
    this.slept = true;
  }
  async wake() {
    this.slept = false;
  }
}

export function textModel(id: string, gb: number, over: Partial<TextModel> = {}): TextModel {
  return {
    id,
    kind: "chat",
    server: "llamacpp",
    format: "gguf",
    size: gb * GIB,
    identity: { basename: id, sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { tools: true, vision: false, embedding: false, reasoning: null },
    contextLength: 8192,
    mmproj: null,
    remoteCode: false,
    ...over,
  };
}

/**
 * A fake llama.cpp router: presets from the shared folder, /models, load and
 * unload, and chat completions that echo the last message.
 */
export async function fakeLlamaRouter() {
  const status = new Map<string, string>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://x");
    const json = (code: number, b: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === "/models") return json(200, { data: [...status].map(([id, value]) => ({ id, status: { value } })) });
    if (url.pathname === "/models/load") {
      status.set(body.model, "loaded");
      return json(200, { success: true });
    }
    if (url.pathname === "/models/unload") {
      status.set(body.model, "unloaded");
      return json(200, { success: true });
    }
    if (url.pathname === "/v1/chat/completions") {
      if (status.get(body.model) !== "loaded") return json(400, { error: { message: "model not loaded" } });
      const text = `echo: ${body.messages.at(-1).content}`;
      // Error paths: a server error that repeats the prompt, and a stream cut off half way.
      if (text.includes("FAIL")) return json(500, { error: { message: `failed on: ${text}` } });
      if (text.includes("BREAK")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        return void setTimeout(() => res.socket?.destroy(), 5);
      }
      const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
      if (!body.stream) return json(200, { choices: [{ message: { role: "assistant", content: text } }], usage });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const word of text.split(" ")) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word + " " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (url.pathname === "/v1/embeddings") return json(200, { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 } });
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, status, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
