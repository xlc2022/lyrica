// Fake GPUs and model servers, so host-api runs without a GPU.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Backend } from "../src/backends.ts";
import type { Gpu, GpuMonitor } from "../src/gpus.ts";
import { makeIdentity } from "../src/identity.ts";
import type { TextModel } from "../src/library.ts";
import type { Option } from "../src/placement.ts";

export const GIB = 1024 ** 3;

/** GPUs whose used memory is a baseline plus what the fake backend loaded on each. */
export class FakeGpus implements GpuMonitor {
  readonly gpus: Gpu[];
  readonly loaded = new Map<string, Record<number, number>>();

  constructor(totals: number[], baseline = GIB, names?: string[]) {
    this.gpus = totals.map((t, index) => ({ index, name: names?.[index] ?? `Fake GPU ${index}`, vendor: "nvidia", total: t * GIB, used: baseline }));
  }

  async read(): Promise<Gpu[]> {
    return this.gpus.map((g) => ({ ...g, used: g.used + [...this.loaded.values()].reduce((n, l) => n + (l[g.index] ?? 0), 0) }));
  }

  /** The GPUs a model is on. */
  on(id: string): number[] {
    return Object.keys(this.loaded.get(id) ?? {}).map(Number);
  }
}

/** A backend that "loads" a model by taking what its placement expects on each of its GPUs. */
export class FakeBackend implements Backend {
  readonly calls: string[] = [];
  readonly gpus: FakeGpus;
  loadMs = 0;
  slept = false;

  constructor(gpus: FakeGpus) {
    this.gpus = gpus;
  }

  readonly placements = new Map<string, Option>();

  async load(model: TextModel, at: Option) {
    this.calls.push(`load ${model.id}@${at.gpus.join("+")}`);
    await new Promise((r) => setTimeout(r, this.loadMs));
    this.placements.set(model.id, at);
    this.gpus.loaded.set(model.id, { ...at.need });
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
    kvPerToken: null,
    mmproj: null,
    remoteCode: false,
    ...over,
  };
}

/**
 * A fake llama.cpp router: presets from the shared folder, /models, load and
 * unload, and chat completions that echo the last message.
 */
export async function fakeLlamaRouter(loadState = "loaded") {
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
      status.set(body.model, loadState);
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

export const TOKEN = "hf_marker_token_8812";
export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const gitSha1 = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

/** A fake Hugging Face over HTTPS on localhost. */
/**
 * opts.readme: org/repo's README.md (a model card); opts.base: an org/base
 * repository (revision def456) with its own config.json and README.md, for
 * a card that names its base model.
 */
export async function fakeHub(opts: { lie?: boolean; redirectTo?: string; gated?: boolean; oversend?: boolean; readme?: string; base?: { config: string; readme: string } } = {}) {
  const id = makeIdentity("hub", ["localhost"]);
  const files: Record<string, Buffer> = {
    "model-Q4_K_M.gguf": Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(299_996, 7)]),
    "fake.gguf": Buffer.alloc(1000, 7),
    "nosize.gguf": Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(996, 7)]),
    "config.json": Buffer.from('{"architectures":["X"]}'),
    "pytorch_model.bin": Buffer.alloc(10, 1),
    // A voice model: ONNX starts with its IR version; voices are plain float32.
    "onnx/model.onnx": Buffer.concat([Buffer.from([0x08, 0x08]), Buffer.alloc(998, 7)]),
    "fake.onnx": Buffer.alloc(1000, 7),
    "voices/af_heart.bin": Buffer.alloc(1024, 0),
    "voices/zf_pickled.bin": Buffer.concat([Buffer.from([0x80, 0x04]), Buffer.alloc(1022, 0)]),
    ...(opts.readme !== undefined ? { "README.md": Buffer.from(opts.readme) } : {}),
  };
  const base: Record<string, Buffer> = opts.base ? { "config.json": Buffer.from(opts.base.config), "README.md": Buffer.from(opts.base.readme) } : {};
  const seen: string[] = [];
  const server = https.createServer({ key: id.key, cert: id.cert }, (req, res) => {
    seen.push(req.headers.authorization ?? "");
    const url = new URL(req.url!, "https://localhost");
    if (opts.gated && req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const json = (v: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/api/models/org/repo/revision/main" || url.pathname === "/api/models/org/repo/revision/abc123") return json({ sha: "abc123", gated: !!opts.gated, cardData: { base_model: "org/base", base_model_relation: "quantized" } });
    if (opts.base && url.pathname === "/api/models/org/base/revision/main") return json({ sha: "def456", gated: false, cardData: {} });
    if (opts.base && url.pathname === "/api/models/org/base/tree/def456") return json(Object.entries(base).map(([path, b]) => ({ type: "file", path, size: b.length, oid: gitSha1(b) })));
    const fromBase = url.pathname.match(/^\/org\/base\/resolve\/def456\/(.+)$/);
    if (fromBase && base[fromBase[1]!]) return void res.writeHead(200, { "content-length": base[fromBase[1]!]!.length }).end(base[fromBase[1]!]);
    if (url.pathname === "/api/models/org/repo/tree/abc123") {
      return json(Object.entries(files).map(([path, b]) =>
        path.endsWith(".json") || path.endsWith(".md") ? { type: "file", path, size: b.length, oid: gitSha1(b) } : { type: "file", path, size: b.length, oid: "x", lfs: { oid: opts.lie ? "0".repeat(64) : sha256(b), size: b.length } }));
    }
    const file = url.pathname.match(/^\/org\/repo\/resolve\/abc123\/(.+)$/);
    if (file && opts.redirectTo) return void res.writeHead(302, { location: opts.redirectTo }).end();
    const body = file ? files[decodeURIComponent(file[1]!)] : undefined;
    if (!body) return void res.writeHead(404).end();
    // A link served without its size.
    if (url.pathname.endsWith("/nosize.gguf")) {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      return void res.end(body);
    }
    if (opts.oversend) {
      // Says one size, sends more.
      res.writeHead(200);
      return void res.end(Buffer.concat([body, Buffer.alloc(5000, 1)]));
    }
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


/** A safetensors file with just a header: tensor names, types and shapes. */
export function safetensors(tensors: Record<string, { dtype?: string; shape?: number[] }>): Buffer {
  const header: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tensors)) header[name] = { dtype: t.dtype ?? "BF16", shape: t.shape ?? [1], data_offsets: [0, 0] };
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json]);
}

/** A 1×1 PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/**
 * A fake ComfyUI: /upload/image, /prompt, /history, /free, and a websocket
 * that sends one PNG per batch item and then "executing" with node null.
 */
export async function fakeComfy(o: { hang?: boolean } = {}) {
  const { createHash } = await import("node:crypto");
  const seen = { uploads: [] as string[], uploadBodies: [] as Buffer[], prompts: [] as any[], historyCleared: 0, freed: 0, interrupted: [] as string[], deleted: [] as string[] };
  const sockets = new Map<string, import("node:net").Socket>();
  const frame = (op: number, data: Buffer) => {
    const head = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 0xff]);
    return Buffer.concat([head, data]);
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/upload/image") {
      const name = body.toString("latin1").match(/filename="([^"]+)"/)?.[1] ?? "x.png";
      seen.uploads.push(name);
      seen.uploadBodies.push(body);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name }));
    }
    if (url.pathname === "/history") {
      if (JSON.parse(body.toString()).clear) seen.historyCleared++;
      return res.writeHead(200).end();
    }
    if (url.pathname === "/interrupt") {
      seen.interrupted.push(JSON.parse(body.toString()).prompt_id);
      return res.writeHead(200).end();
    }
    if (url.pathname === "/queue") {
      seen.deleted.push(...JSON.parse(body.toString()).delete);
      return res.writeHead(200).end();
    }
    if (url.pathname === "/free") {
      seen.freed++;
      return res.writeHead(200).end();
    }
    if (url.pathname === "/prompt") {
      const { prompt, client_id } = JSON.parse(body.toString());
      seen.prompts.push(prompt);
      const id = `p${seen.prompts.length}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ prompt_id: id }));
      if (o.hang) return;
      const ws = sockets.get(client_id);
      const latent = Object.values(prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>).find((n) => /Latent/.test(n.class_type) && ("batch_size" in n.inputs || "amount" in n.inputs));
      const count = Number(latent?.inputs.batch_size ?? latent?.inputs.amount ?? 1);
      setTimeout(() => {
        for (let i = 0; i < count; i++) {
          const head = Buffer.alloc(8);
          head.writeUInt32BE(1, 0);
          head.writeUInt32BE(2, 4);
          ws?.write(frame(2, Buffer.concat([head, PNG])));
        }
        ws?.write(frame(1, Buffer.from(JSON.stringify({ type: "executing", data: { node: null, prompt_id: id } }))));
      }, 5);
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"]!;
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.set(new URL(req.url!, "http://x").searchParams.get("clientId")!, socket as import("node:net").Socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = () => new Promise<void>((r) => { for (const s of sockets.values()) s.destroy(); server.closeAllConnections(); server.close(() => r()); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close };
}
