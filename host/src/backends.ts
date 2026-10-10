// The model servers, driven through their own APIs: llama.cpp's router mode
// (a preset file plus /models/load and /models/unload), and vLLM through a
// small supervisor that reads the wanted models from a file, with vLLM's own
// sleep and wake. Never the Docker socket.
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HostError } from "./http.ts";
import type { TextModel } from "./library.ts";

export interface Backend {
  /** Loads the model on the GPU and resolves when it answers. */
  load(model: TextModel, gpu: number): Promise<void>;
  unload(model: TextModel): Promise<void>;
  /** Base URL for the model's OpenAI-compatible API. */
  url(model: TextModel): string;
  /** Unloads everything. */
  reset(): Promise<void>;
  /** Frees the GPU memory of what's loaded without forgetting it (pause). */
  sleep(): Promise<void>;
  wake(): Promise<void>;
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

export interface LlamaCppOptions {
  url: string; // the router, e.g. http://llamacpp:8080
  serving: string; // folder shared read-only with the router
  models: string; // the models folder as the router sees it
  device: (gpu: number) => string; // CUDA0, ROCm0, Vulkan0
  contextCap?: number;
  loadTimeoutMs?: number;
}

export class LlamaCpp implements Backend {
  private readonly o: Required<LlamaCppOptions>;
  private readonly placed = new Map<string, { model: TextModel; gpu: number }>();

  constructor(o: LlamaCppOptions) {
    this.o = { contextCap: 32768, loadTimeoutMs: 10 * 60_000, ...o };
    this.writePreset();
  }

  get presetPath(): string {
    return join(this.o.serving, "llamacpp.ini");
  }

  /** One section per placed model: its file, GPU and settings. */
  private writePreset(): void {
    const lines = ["version = 1", "", "[*]", "n-gpu-layers = 999", "split-mode = none", "jinja = true", "flash-attn = auto", "no-webui = true", ""];
    for (const { model, gpu } of this.placed.values()) {
      lines.push(`[${model.id}]`, `model = ${this.o.models}/${model.id}`, `device = ${this.o.device(gpu)}`);
      lines.push(`c = ${Math.min(model.contextLength ?? 8192, this.o.contextCap)}`);
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

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.o.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok && res.status !== 400) throw unavailable("llama.cpp");
  }

  async load(model: TextModel, gpu: number): Promise<void> {
    this.placed.set(model.id, { model, gpu });
    this.writePreset();
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
    if (failed) {
      this.placed.delete(model.id);
      this.writePreset();
      throw new HostError(503, "unavailable", "llama.cpp couldn't load this model.");
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
    for (const { model } of [...this.placed.values()]) await this.unload(model).catch(() => {});
    this.placed.clear();
    this.writePreset();
  }

  async sleep(): Promise<void> {
    await this.reset();
  }

  async wake(): Promise<void> {}
}

export interface VllmOptions {
  /** Base URL with a {port} placeholder, e.g. http://vllm:{port} */
  url: string;
  serving: string;
  models: string;
  basePort?: number;
  loadTimeoutMs?: number;
}

/** vLLM: one server per GPU with the vllm role, started by host/vllm/supervisor.py. */
export class Vllm implements Backend {
  private readonly o: Required<VllmOptions>;
  private readonly placed = new Map<number, TextModel>();
  private generation = 0;

  constructor(o: VllmOptions) {
    this.o = { basePort: 8000, loadTimeoutMs: 30 * 60_000, ...o };
    this.write();
  }

  get statePath(): string {
    return join(this.o.serving, "vllm.json");
  }

  private port(gpu: number): number {
    return this.o.basePort + gpu;
  }

  private gpuOf(model: TextModel): number | undefined {
    for (const [gpu, m] of this.placed) if (m.id === model.id) return gpu;
    return undefined;
  }

  private write(): void {
    const gpus: Record<string, unknown> = {};
    for (const [gpu, m] of this.placed) {
      gpus[gpu] = { model: `${this.o.models}/${m.id}`, name: m.id, port: this.port(gpu), embedding: m.kind === "embedding", maxModelLen: m.contextLength };
    }
    writeAtomic(this.statePath, JSON.stringify({ generation: this.generation, gpus }, null, 2));
  }

  private base(gpu: number): string {
    return this.o.url.replace("{port}", String(this.port(gpu)));
  }

  async load(model: TextModel, gpu: number): Promise<void> {
    if (model.remoteCode) throw new HostError(403, "refused", "This model needs trust_remote_code, which the host never allows.");
    this.placed.set(gpu, model);
    this.write();
    await poll(async () => {
      const res = await fetch(`${this.base(gpu)}/v1/models`);
      const body = (await res.json()) as { data: { id: string }[] };
      return body.data.some((m) => m.id === model.id);
    }, this.o.loadTimeoutMs, "vLLM", 2000);
  }

  async unload(model: TextModel): Promise<void> {
    const gpu = this.gpuOf(model);
    if (gpu === undefined) return;
    this.placed.delete(gpu);
    this.write();
    await poll(async () => !(await fetch(`${this.base(gpu)}/v1/models`).then(() => true, () => false)), 120_000, "vLLM");
  }

  url(model: TextModel): string {
    const gpu = this.gpuOf(model);
    if (gpu === undefined) throw unavailable("vLLM");
    return this.base(gpu);
  }

  async reset(): Promise<void> {
    this.placed.clear();
    this.generation++;
    this.write();
  }

  async sleep(): Promise<void> {
    for (const gpu of this.placed.keys()) await fetch(`${this.base(gpu)}/sleep?level=2`, { method: "POST" }).catch(() => {});
  }

  async wake(): Promise<void> {
    for (const gpu of this.placed.keys()) await fetch(`${this.base(gpu)}/wake_up`, { method: "POST" }).catch(() => {});
  }
}
