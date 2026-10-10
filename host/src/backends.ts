// The model servers, driven through their own APIs: llama.cpp's router mode
// (a preset file plus /models/load and /models/unload), and vLLM through a
// small supervisor that starts and stops one server per GPU as a file says.
// Never the Docker socket.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostError } from "./http.ts";
import type { TextModel } from "./library.ts";
import { contextOf, type ModelSettings, type Option } from "./placement.ts";

export interface Backend {
  /** Loads the model on the placement's GPUs with its settings, and resolves when it answers. */
  load(model: TextModel, placement: Option, settings: ModelSettings): Promise<void>;
  unload(model: TextModel): Promise<void>;
  /** Base URL for the model's OpenAI-compatible API. */
  url(model: TextModel): string;
  /** Unloads everything; throws if something couldn't be, which then stays counted. */
  reset(): Promise<void>;
}

const unavailable = (what: string) => new HostError(503, "unavailable", `${what} didn't answer.`);

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

async function poll(check: () => Promise<boolean>, timeoutMs: number, what: string, intervalMs = 500): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw unavailable(what);
}

/** A chat template override, written once to the serving folder by its hash; returns its path there. */
function templateFile(serving: string, template: string): string {
  const name = `${createHash("sha256").update(template).digest("hex").slice(0, 16)}.jinja`;
  mkdirSync(join(serving, "templates"), { recursive: true });
  writeAtomic(join(serving, "templates", name), template);
  return join(serving, "templates", name);
}

export interface LlamaCppOptions {
  url: string; // the router, e.g. http://llamacpp:8080
  serving: string; // folder shared read-only with the router
  models: string; // the models folder as the router sees it
  device: (gpu: number) => string; // CUDA0, ROCm0, Vulkan0
  loadTimeoutMs?: number;
}

export class LlamaCpp implements Backend {
  private readonly o: Required<LlamaCppOptions>;
  private readonly placed = new Map<string, { model: TextModel; at: Option; settings: ModelSettings }>();

  constructor(o: LlamaCppOptions) {
    this.o = { loadTimeoutMs: 10 * 60_000, ...o };
    this.writePreset();
  }

  get presetPath(): string {
    return join(this.o.serving, "llamacpp.ini");
  }

  /** One section per placed model: its file, GPUs and serving settings. */
  private writePreset(): void {
    const lines = ["version = 1", "", "[*]", "jinja = true", "no-webui = true", ""];
    for (const { model, at, settings: s } of this.placed.values()) {
      lines.push(`[${model.id}]`, `model = ${this.o.models}/${model.id}`, `device = ${at.gpus.map(this.o.device).join(",")}`);
      if (at.split) lines.push("split-mode = layer", `tensor-split = ${at.split.map((r) => +r.toFixed(3)).join(",")}`);
      else lines.push("split-mode = none");
      lines.push(`c = ${contextOf(model, s)}`, `n-gpu-layers = ${s.gpuLayers ?? 999}`, `flash-attn = ${s.flashAttention ?? "auto"}`);
      if (s.kvCacheType) lines.push(`cache-type-k = ${s.kvCacheType}`, `cache-type-v = ${s.kvCacheType}`);
      if (s.parallel) lines.push(`parallel = ${s.parallel}`);
      if (s.batchSize) lines.push(`batch-size = ${s.batchSize}`);
      if (s.chatTemplate) lines.push(`chat-template-file = ${templateFile(this.o.serving, s.chatTemplate)}`);
      if (model.kind === "embedding") lines.push("embeddings = true");
      if (model.mmproj) lines.push(`mmproj = ${this.o.models}/${model.mmproj}`);
      lines.push("");
    }
    writeAtomic(this.presetPath, lines.join("\n"));
  }
  private async status(id: string): Promise<{ value: string; failed?: boolean } | null> {
    const res = await fetch(`${this.o.url}/models`);
    const body = (await res.json()) as { data: { id: string; status: { value: string; failed?: boolean } }[] };
    return body.data.find((m) => m.id === id)?.status ?? null;
  }

  /** POSTs to the router. A 400 saying the model is already in that state is fine; any other is an error. */
  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.o.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
      throw unavailable("llama.cpp");
    });
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    if (res.status === 400 && /already (loaded|running)|not (loaded|running)/i.test(text)) return;
    throw new HostError(503, "unavailable", res.status === 400 ? "llama.cpp doesn't know this model." : "llama.cpp didn't answer.");
  }

  async load(model: TextModel, at: Option, settings: ModelSettings): Promise<void> {
    this.placed.set(model.id, { model, at, settings });
    this.writePreset();
    try {
      // ?reload=1 makes the router read the preset file again.
      await fetch(`${this.o.url}/models?reload=1`).catch(() => {
        throw unavailable("llama.cpp");
      });
      await this.post("/models/load", { model: model.id });
      let failed = false;
      await poll(async () => {
        const s = await this.status(model.id);
        if (s?.failed) failed = true;
        return s?.value === "loaded" || failed;
      }, this.o.loadTimeoutMs, "llama.cpp");
      if (failed) throw new HostError(503, "unavailable", "llama.cpp couldn't load this model.");
    } catch (e) {
      // Leave nothing half-loaded behind.
      await this.post("/models/unload", { model: model.id }).catch(() => {});
      this.placed.delete(model.id);
      this.writePreset();
      throw e;
    }
  }

  async unload(model: TextModel): Promise<void> {
    await this.post("/models/unload", { model: model.id });
    await poll(async () => (await this.status(model.id))?.value !== "loaded", 60_000, "llama.cpp");
    this.placed.delete(model.id);
    this.writePreset();
  }

  url(): string {
    return this.o.url;
  }

  async reset(): Promise<void> {
    let failed = 0;
    for (const { model } of [...this.placed.values()]) await this.unload(model).catch(() => failed++);
    if (failed) throw new HostError(503, "unavailable", `llama.cpp couldn't unload ${failed} model${failed > 1 ? "s" : ""}.`);
  }
}

export interface VllmOptions {
  /** Base URL with a {port} placeholder, e.g. http://vllm:{port} */
  url: string;
  serving: string;
  models: string;
  basePort?: number;
  loadTimeoutMs?: number;
}

/**
 * vLLM: each model is its own server process, started by
 * host/vllm/supervisor.py on the GPUs of its placement with its memory
 * share, so one GPU can hold several.
 */
export class Vllm implements Backend {
  private readonly o: Required<VllmOptions>;
  private readonly placed = new Map<string, { model: TextModel; at: Option; settings: ModelSettings; port: number }>();
  private generation = 0;

  constructor(o: VllmOptions) {
    this.o = { basePort: 8000, loadTimeoutMs: 30 * 60_000, ...o };
    this.write();
  }

  get statePath(): string {
    return join(this.o.serving, "vllm.json");
  }

  private freePort(): number {
    const used = new Set([...this.placed.values()].map((p) => p.port));
    let port = this.o.basePort;
    while (used.has(port)) port++;
    return port;
  }

  private write(placed: typeof this.placed = this.placed): void {
    const servers: Record<string, unknown> = {};
    for (const { model: m, at, settings: s, port } of placed.values()) {
      servers[m.id] = {
        model: `${this.o.models}/${m.id}`, name: m.id, port, gpus: at.gpus, embedding: m.kind === "embedding",
        tensorParallel: at.parallel === "tensor" ? at.gpus.length : 1,
        pipelineParallel: at.parallel === "pipeline" ? at.gpus.length : 1,
        memoryShare: at.share, maxModelLen: contextOf(m, s),
        maxNumSeqs: s.maxSeqs ?? null, maxNumBatchedTokens: s.batchSize ?? null, dtype: s.dtype ?? null,
        chatTemplate: s.chatTemplate ? templateFile(this.o.serving, s.chatTemplate) : null,
      };
    }
    writeAtomic(this.statePath, JSON.stringify({ generation: this.generation, servers }, null, 2));
  }

  private base(port: number): string {
    return this.o.url.replace("{port}", String(port));
  }

  async load(model: TextModel, at: Option, settings: ModelSettings): Promise<void> {
    if (model.remoteCode) throw new HostError(403, "refused", "This model needs trust_remote_code, which the host never allows.");
    const port = this.freePort();
    this.placed.set(model.id, { model, at, settings, port });
    this.write();
    try {
      await poll(async () => {
        const res = await fetch(`${this.base(port)}/v1/models`);
        const body = (await res.json()) as { data: { id: string }[] };
        return body.data.some((m) => m.id === model.id);
      }, this.o.loadTimeoutMs, "vLLM", 2000);
    } catch (e) {
      // Take it out of the supervisor's file, so it stops retrying.
      this.placed.delete(model.id);
      this.write();
      throw e;
    }
  }

  async unload(model: TextModel): Promise<void> {
    const p = this.placed.get(model.id);
    if (!p) return;
    this.placed.delete(model.id);
    this.write();
    await poll(async () => !(await fetch(`${this.base(p.port)}/v1/models`).then(() => true, () => false)), 120_000, "vLLM");
  }

  url(model: TextModel): string {
    const p = this.placed.get(model.id);
    if (!p) throw unavailable("vLLM");
    return this.base(p.port);
  }

  /** Stops every server and waits until each is gone. */
  async reset(): Promise<void> {
    const ports = [...this.placed.values()].map((p) => p.port);
    this.generation++;
    this.write(new Map());
    // Forget them only once each server is gone, so a failure stays counted.
    for (const port of ports) await poll(async () => !(await fetch(`${this.base(port)}/v1/models`).then(() => true, () => false)), 120_000, "vLLM");
    this.placed.clear();
  }
}
