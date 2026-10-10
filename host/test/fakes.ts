// Fake GPUs and model servers, so host-api runs without a GPU.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Backend } from "../src/backends.ts";
import type { Gpu, GpuMonitor } from "../src/gpus.ts";
import { makeIdentity } from "../src/identity.ts";
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

export const TOKEN = "hf_marker_token_8812";
export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const gitSha1 = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

/** A fake Hugging Face over HTTPS on localhost. */
export async function fakeHub(opts: { lie?: boolean; redirectTo?: string; gated?: boolean } = {}) {
  const id = makeIdentity("hub", ["localhost"]);
  const files: Record<string, Buffer> = {
    "model-Q4_K_M.gguf": Buffer.alloc(300_000, 7),
    "config.json": Buffer.from('{"architectures":["X"]}'),
    "pytorch_model.bin": Buffer.alloc(10, 1),
  };
  const seen: string[] = [];
  const server = https.createServer({ key: id.key, cert: id.cert }, (req, res) => {
    seen.push(req.headers.authorization ?? "");
    const url = new URL(req.url!, "https://localhost");
    if (opts.gated && req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const json = (v: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/api/models/org/repo/revision/main") return json({ sha: "abc123", gated: !!opts.gated, cardData: { base_model: "org/base", base_model_relation: "quantized" } });
    if (url.pathname === "/api/models/org/repo/tree/abc123") {
      return json(Object.entries(files).map(([path, b]) =>
        path.endsWith(".json") ? { type: "file", path, size: b.length, oid: gitSha1(b) } : { type: "file", path, size: b.length, oid: "x", lfs: { oid: opts.lie ? "0".repeat(64) : sha256(b), size: b.length } }));
    }
    const file = url.pathname.match(/^\/org\/repo\/resolve\/abc123\/(.+)$/);
    if (file && opts.redirectTo) return void res.writeHead(302, { location: opts.redirectTo }).end();
    const body = file ? files[decodeURIComponent(file[1]!)] : undefined;
    if (!body) return void res.writeHead(404).end();
    const range = req.headers.range?.match(/^bytes=(\d+)-$/);
    if (range) {
      const from = Number(range[1]);
      res.writeHead(206, { "content-length": body.length - from });
      return void res.end(body.subarray(from));
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { base: `https://localhost:${(server.address() as AddressInfo).port}`, files, seen, ca: id.cert, close };
}

