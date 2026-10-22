// The model servers, driven through their own APIs: llama.cpp's router mode
// (a preset file plus /models/load and /models/unload), and vLLM through a
// small supervisor that starts and stops one server per GPU as a file says.
// Never the Docker socket.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalmem } from "node:os";
import { HostError } from "./http.ts";
import type { TextModel } from "./library.ts";
import { concurrentOf, contextOf, usesMtp, usesVision, type ModelSettings, type Option } from "./placement.ts";

export interface Backend {
  /** Loads the model on the placement's GPUs with its settings, and resolves when it answers. */
  load(model: TextModel, placement: Option, settings: ModelSettings): Promise<void>;
  unload(model: TextModel): Promise<void>;
  /** Base URL for the model's OpenAI-compatible API. */
  url(model: TextModel): string;
  /** Unloads everything; throws if something couldn't be, which then stays counted. */
  reset(): Promise<void>;
}

const unavailable = (what: string) => new HostError(503, "model_unavailable", `${what} didn't answer.`);

export function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

export async function poll(check: () => Promise<boolean>, timeoutMs: number, what: string, intervalMs = 500): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // A HostError from the check is a definite answer; anything else means "not yet".
    const ok = await check().catch((e) => {
      if (e instanceof HostError) throw e;
      return false;
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw unavailable(what);
}

/**
 * The chat template overrides a server uses, each written once by its hash to
 * templates/<server>/ in the serving folder. `write` returns a template's
 * path; `prune` removes the ones no longer used.
 */
class Templates {
  private readonly dir: string;
  private used = new Set<string>();

  constructor(serving: string, server: string) {
    this.dir = join(serving, "templates", server);
  }

  write(template: string): string {
    const name = `${createHash("sha256").update(template).digest("hex").slice(0, 16)}.jinja`;
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(join(this.dir, name), template);
    this.used.add(name);
    return join(this.dir, name);
  }

  /** Call before writing a server's config; then `done` removes what it didn't use. */
  begin(): void {
    this.used = new Set();
  }

  done(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {}
    for (const name of names) if (!this.used.has(name)) unlinkSync(join(this.dir, name));
  }
}

export interface LlamaCppOptions {
  url: string; // the router, e.g. http://llamacpp:8080
  serving: string; // folder shared read-only with the router
  models: string; // the models folder as the router sees it
  device: (gpu: number) => string; // CUDA0, ROCm0, Vulkan0
  loadTimeoutMs?: number;
  /** The machine's memory in bytes, for the prompt cache each loaded model keeps in it. */
  memoryBytes?: number;
}

/** llama.cpp's own prompt cache in host memory, per loaded model, in MiB. */
const CACHE_RAM_DEFAULT = 8192;
const CACHE_RAM_MOST = 65536;

export class LlamaCpp implements Backend {
  private readonly o: Required<LlamaCppOptions>;
  private readonly placed = new Map<string, { model: TextModel; at: Option; settings: ModelSettings }>();
  private readonly templates: Templates;

  constructor(o: LlamaCppOptions) {
    this.o = { loadTimeoutMs: 10 * 60_000, memoryBytes: totalmem(), ...o };
    this.templates = new Templates(o.serving, "llamacpp");
    this.writePreset();
  }

  get presetPath(): string {
    return join(this.o.serving, "llamacpp.ini");
  }

  /** One section per placed model: its file, GPUs and serving settings. */
  private writePreset(): void {
    // Prompts kept in host memory, so threads taking turns on a model don't each re-read their whole conversation: an eighth of memory, where that is more than llama.cpp's own 8 GiB.
    const cacheRam = Math.min(CACHE_RAM_MOST, Math.floor(this.o.memoryBytes / 8 / 2 ** 20));
    const lines = ["version = 1", "", "[*]", "jinja = true", "no-webui = true", ...(cacheRam > CACHE_RAM_DEFAULT ? [`cache-ram = ${cacheRam}`] : []), ""];
    this.templates.begin();
    for (const { model, at, settings: s } of this.placed.values()) {
      lines.push(`[${model.id}]`, `model = ${this.o.models}/${model.id}`, `device = ${at.gpus.map(this.o.device).join(",")}`);
      if (at.split) lines.push("split-mode = layer", `tensor-split = ${at.split.map((r) => +r.toFixed(3)).join(",")}`);
      else lines.push("split-mode = none");
      lines.push(`c = ${contextOf(model, s)}`);
      // YaRN, as the publisher's card gives it for llama-server.
      if (s.stretch) lines.push("rope-scaling = yarn", `rope-scale = ${s.stretch.factor}`, `yarn-orig-ctx = ${s.stretch.originalContext}`);
      lines.push(`n-gpu-layers = ${s.gpuLayers ?? 999}`, `flash-attn = ${s.flashAttention ?? "auto"}`);
      if (s.kvCacheType) lines.push(`cache-type-k = ${s.kvCacheType}`, `cache-type-v = ${s.kvCacheType}`);
      // One cache of the whole context, shared by the requests it serves at once, as the daemon plans.
      const parallel = concurrentOf(model, s);
      if (parallel) lines.push(`parallel = ${parallel}`, "kv-unified = true");
      if (s.batchSize) lines.push(`batch-size = ${s.batchSize}`);
      if (s.chatTemplate) lines.push(`chat-template-file = ${this.templates.write(s.chatTemplate)}`);
      if (model.kind === "embedding") lines.push("embeddings = true");
      if (usesVision(model, s)) lines.push(`mmproj = ${this.o.models}/${model.mmproj}`);
      // Multi-token prediction: llama.cpp drafts with the model's MTP layers, or with its MTP file.
      if (usesMtp(model, s)) {
        if (model.mtp) lines.push(`model-draft = ${this.o.models}/${model.mtp}`);
        lines.push("spec-type = draft-mtp", `spec-draft-n-max = ${s.draftMax ?? 2}`);
      }
      lines.push("");
    }
    writeAtomic(this.presetPath, lines.join("\n"));
    this.templates.done();
  }
  private async status(id: string): Promise<{ value: string; failed?: boolean } | null> {
    const res = await fetch(`${this.o.url}/models`);
    const body = (await res.json()) as { data: { id: string; status: { value: string; failed?: boolean } }[] };
    return body.data.find((m) => m.id === id)?.status ?? null;
  }

  /** Models the router has loaded or is loading that this host-api didn't place. */
  private async held(): Promise<string[]> {
    const res = await fetch(`${this.o.url}/models`);
    const body = (await res.json()) as { data: { id: string; status: { value: string } }[] };
    return body.data.filter((m) => m.status.value !== "unloaded" && !this.placed.has(m.id)).map((m) => m.id);
  }

  /** POSTs to the router. A 400 saying the model is already in that state is fine; any other is an error. */
  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.o.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
      throw unavailable("llama.cpp");
    });
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    if (res.status === 400 && /already (loaded|running)|not (loaded|running)/i.test(text)) return;
    throw new HostError(503, "model_unavailable", res.status === 400 ? "llama.cpp doesn't know this model." : "llama.cpp didn't answer.");
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
        if (!s || s.failed || s.value === "unloaded") failed = true;
        return s?.value === "loaded" || failed;
      }, this.o.loadTimeoutMs, "llama.cpp");
      if ((await this.status(model.id))?.value !== "loaded") failed = true;
      if (failed) throw new HostError(503, "model_unavailable", "llama.cpp couldn't load this model.");
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
    // What the router still holds that host-api didn't place: models loaded before host-api last restarted.
    for (const id of await this.held().catch(() => [])) {
      await this.post("/models/unload", { model: id })
        .then(() => poll(async () => (await this.status(id))?.value !== "loaded", 60_000, "llama.cpp"))
        .catch(() => failed++);
    }
    if (failed) throw new HostError(503, "model_unavailable", `llama.cpp couldn't unload ${failed} model${failed > 1 ? "s" : ""}.`);
  }
}

export interface VllmOptions {
  /** Base URL with a {port} placeholder, e.g. http://vllm:{port} */
  url: string;
  serving: string;
  models: string;
  basePort?: number;
  loadTimeoutMs?: number;
  /** The supervisor's report of servers that exited. */
  statusPath?: string;
}

/**
 * vLLM: each model is its own server process, started by
 * host/vllm/supervisor.py on the GPUs of its placement with its memory
 * share, so one GPU can hold several.
 */
export class Vllm implements Backend {
  private readonly o: Required<VllmOptions>;
  private readonly placed = new Map<string, { model: TextModel; at: Option; settings: ModelSettings; port: number; attempt: string }>();
  private generation = 0;
  private readonly templates: Templates;

  constructor(o: VllmOptions) {
    this.o = { basePort: 8000, loadTimeoutMs: 30 * 60_000, statusPath: "/vllm-status/vllm.json", ...o };
    this.templates = new Templates(o.serving, "vllm");
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
    this.templates.begin();
    for (const { model: m, at, settings: s, port, attempt } of placed.values()) {
      servers[m.id] = {
        model: `${this.o.models}/${m.id}`, name: m.id, attempt, port, gpus: at.gpus, embedding: m.kind === "embedding",
        toolCallParser: m.kind === "chat" ? m.toolCallParser ?? null : null,
        reasoningParser: m.kind === "chat" ? m.reasoningParser ?? null : null,
        tensorParallel: at.parallel === "tensor" ? at.gpus.length : 1,
        pipelineParallel: at.parallel === "pipeline" ? at.gpus.length : 1,
        memoryShare: at.share, maxModelLen: contextOf(m, s),
        maxNumSeqs: concurrentOf(m, s) ?? s.maxSeqs ?? null, maxNumBatchedTokens: s.batchSize ?? null, dtype: s.dtype ?? null,
        chatTemplate: s.chatTemplate ? this.templates.write(s.chatTemplate) : null,
        // The supervisor merges these into the model's own RoPE settings.
        ropeOverride: s.stretch ? { factor: s.stretch.factor, originalContext: s.stretch.originalContext } : null,
      };
    }
    writeAtomic(this.statePath, JSON.stringify({ generation: this.generation, servers }, null, 2));
    this.templates.done();
  }

  private base(port: number): string {
    return this.o.url.replace("{port}", String(port));
  }

  async load(model: TextModel, at: Option, settings: ModelSettings): Promise<void> {
    if (model.remoteCode) throw new HostError(403, "refused", "This model needs trust_remote_code, which the host never allows.");
    const port = this.freePort();
    const attempt = randomUUID();
    this.placed.set(model.id, { model, at, settings, port, attempt });
    this.write();
    try {
      await poll(async () => {
        // A server that exited while starting won't come up: stop waiting.
        if (this.failed(model.id, attempt)) {
          throw new HostError(503, "model_unavailable", `vLLM couldn't start ${model.id} with these settings; try a lower context length or a larger memory share.`);
        }
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

  private failed(id: string, attempt: string): boolean {
    try {
      const status = JSON.parse(readFileSync(this.o.statusPath, "utf8")) as { failed?: Record<string, { attempt?: string }> };
      return status.failed?.[id]?.attempt === attempt;
    } catch {
      return false;
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
