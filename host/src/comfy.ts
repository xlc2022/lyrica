// ComfyUI, reached only from host-api. Results come back over its websocket
// (SaveImageWebsocket, and our SaveVideoWebsocket for clips), nothing is saved, and its history is cleared after
// every job. One job at a time, so uploads can't mix. It runs only while a
// recipe is loaded (host/comfyui/gate.py reads serving/comfyui.json), since
// its process holds GPU memory for as long as it lives.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HostError } from "./http.ts";
import { poll, writeAtomic, type Backend } from "./backends.ts";
import type { TextModel } from "./library.ts";

/** A 1×1 PNG, written over each upload after its job. */
const BLANK = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** The websocket's binary messages: event 1 (a preview image), then a format. PNG is ComfyUI's; MP4 is SaveVideoWebsocket's. */
const PNG = 2;
const MP4 = 16;

const unavailable = () => new HostError(503, "model_unavailable", "ComfyUI didn't answer.");
/** How long one request to ComfyUI may take, outside the job itself: a ComfyUI that hangs fails the job rather than the queue. */
const CALL_MS = 30_000;
/** How long after its last recipe unloads ComfyUI stops, unless another loads. */
const STOP_AFTER_MS = 2_000;

export class Comfy implements Backend {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly callMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** The recipes loaded; ComfyUI runs while there is one. */
  private readonly loaded = new Set<string>();
  /** Where host-api asks for ComfyUI to run, and where gate.py says it has; without them, ComfyUI is taken to run always. */
  private readonly gate?: { state: string; status: string };
  private stopping: NodeJS.Timeout | null = null;
  private readonly startMs: number;

  constructor(base: string, timeoutMs = 30 * 60_000, callMs = CALL_MS, gate?: { serving: string; status: string }, startMs = 5 * 60_000) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.callMs = callMs;
    this.startMs = startMs;
    if (gate) this.gate = { state: join(gate.serving, "comfyui.json"), status: gate.status };
    this.ask(null);
  }

  /** Asks for ComfyUI to run (this attempt) or to stop (null). */
  private ask(attempt: string | null): void {
    if (this.stopping) clearTimeout(this.stopping);
    this.stopping = null;
    if (this.gate) writeAtomic(this.gate.state, JSON.stringify(attempt ? { run: true, attempt } : { run: false }));
  }

  /** What gate.py says: the attempt it runs, and why ComfyUI can't run on this GPU. */
  private status(): { attempt?: string; unsupported?: string } {
    try {
      return this.gate ? JSON.parse(readFileSync(this.gate.status, "utf8")) : {};
    } catch {
      return {};
    }
  }

  /** gate.py has a ComfyUI running for this attempt (one it started since any stop). */
  private started(attempt: string): boolean {
    if (!this.gate) return true;
    const { attempt: running, unsupported } = this.status();
    if (unsupported) throw new HostError(503, "model_unavailable", unsupported);
    return running === attempt;
  }

  /** Why ComfyUI can't run on its GPU (its PyTorch has no kernels for it), or null. */
  get problem(): string | null {
    return this.status().unsupported ?? null;
  }

  /** Runs jobs one after another. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async upload(name: string, png: Buffer): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([png]), name);
    form.append("overwrite", "true");
    const res = await fetch(`${this.base}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(this.callMs) }).catch(() => {
      throw unavailable();
    });
    if (!res.ok) throw new HostError(400, "invalid", "ComfyUI couldn't read that image.");
    return ((await res.json()) as { name: string }).name;
  }

  /**
   * Uploads the images (each under a fixed name), runs the workflow made by
   * `build` from their names, and returns the PNGs. Afterwards the uploads are
   * overwritten with a blank image and the history is cleared; a job that
   * fails, times out or is cancelled is interrupted and taken off the queue.
   */
  async run(images: Record<string, Buffer>, build: (names: Record<string, string>) => object, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<Buffer[]> {
    return (await this.job(images, build, "image", this.timeoutMs, signal, onProgress)).pngs;
  }

  /** Like `run`, for a video workflow: its MP4 and its poster (the first frame, a PNG). */
  async runVideo(images: Record<string, Buffer>, build: (names: Record<string, string>) => object, timeoutMs: number, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<{ video: Buffer; poster: Buffer | null }> {
    const { pngs, videos } = await this.job(images, build, "video", timeoutMs, signal, onProgress);
    if (!videos[0]) throw new HostError(503, "model_unavailable", "ComfyUI returned no video.");
    return { video: videos[0], poster: pngs[0] ?? null };
  }

  private job(images: Record<string, Buffer>, build: (names: Record<string, string>) => object, what: "image" | "video", timeoutMs: number, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<{ pngs: Buffer[]; videos: Buffer[] }> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const names: Record<string, string> = {};
      const pngs: Buffer[] = [];
      const videos: Buffer[] = [];
      let promptId: string | null = null;
      let finished = false;
      let ws: WebSocket | null = null;
      try {
        for (const [key, data] of Object.entries(images)) names[key] = await this.upload(`lyrica-${key}.png`, data);
        const prompt = build(names);
        const progress = onProgress && samplingProgress(prompt, onProgress);
        const clientId = randomUUID();
        const socket = new WebSocket(`${this.base.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
        ws = socket;
        socket.binaryType = "arraybuffer";
        await new Promise<void>((resolve, reject) => {
          const opening = setTimeout(() => reject(unavailable()), this.callMs);
          socket.onopen = () => { clearTimeout(opening); resolve(); };
          socket.onerror = () => { clearTimeout(opening); reject(unavailable()); };
        });
        let timer: NodeJS.Timeout | undefined;
        let onAbort = () => {};
        const done = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new HostError(503, "busy", `The ${what} took too long.`)), timeoutMs);
          onAbort = () => reject(new HostError(503, "model_unavailable", "The request was cancelled."));
          signal?.addEventListener("abort", onAbort, { once: true });
          socket.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
              // 4 bytes event type, 4 bytes format (2 = PNG, 16 = MP4), then the image or clip.
              const view = Buffer.from(e.data);
              if (view.length > 8 && view.readUInt32BE(0) === 1 && view.readUInt32BE(4) === PNG) pngs.push(view.subarray(8));
              if (view.length > 8 && view.readUInt32BE(0) === 1 && view.readUInt32BE(4) === MP4) videos.push(view.subarray(8));
              return;
            }
            let msg: { type?: string; data?: { prompt_id?: string; node?: unknown; node_type?: unknown; exception_type?: unknown; value?: unknown; max?: unknown } };
            try {
              msg = JSON.parse(String(e.data));
            } catch {
              return;
            }
            // Only this client's messages arrive here; skip any for another prompt.
            if (promptId && msg.data?.prompt_id && msg.data.prompt_id !== promptId) return;
            // The node and the exception's type name what broke; the exception's message can carry the prompt, so it stays out.
            if (msg.type === "execution_error") reject(new HostError(503, "model_unavailable", `ComfyUI failed to make the ${what} (${String(msg.data?.node_type ?? "a node")}: ${String(msg.data?.exception_type ?? "error")}).`));
            else if (msg.type === "executing" && msg.data?.node === null) resolve();
            else if (msg.type === "progress" && msg.data) progress?.(String(msg.data.node), Number(msg.data.value), Number(msg.data.max));
          };
          socket.onclose = () => reject(unavailable());
        });
        done.catch(() => {});
        try {
          // The listener is attached now; an abort during the uploads or the
          // websocket's opening is caught here, before anything is queued.
          signal?.throwIfAborted();
          const res = await fetch(`${this.base}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt, client_id: clientId }), signal: AbortSignal.timeout(this.callMs),
          }).catch(() => {
            throw unavailable();
          });
          if (!res.ok) throw new HostError(503, "model_unavailable", "ComfyUI refused the workflow.");
          promptId = ((await res.json()) as { prompt_id: string }).prompt_id;
          await done;
          finished = true;
          return { pngs, videos };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      } finally {
        if (ws) {
          ws.onclose = null;
          ws.close();
        }
        // A job that didn't finish stops now, and doesn't run later.
        if (promptId && !finished) {
          await this.post("/interrupt", { prompt_id: promptId });
          await this.post("/queue", { delete: [promptId] });
        }
        // Nothing of what was asked stays: the uploads become blank, and the history goes.
        for (const key of Object.keys(names)) await this.upload(`lyrica-${key}.png`, BLANK).catch(() => {});
        await this.post("/history", { clear: true });
      }
    });
  }

  private async post(path: string, body: object): Promise<void> {
    await fetch(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.callMs) }).catch(() => {});
  }

  // As a scheduler backend: ComfyUI starts for a recipe, loads its parts during the job, and stops once no recipe is loaded.
  async load(model: TextModel): Promise<void> {
    this.loaded.add(model.id);
    const attempt = randomUUID();
    this.ask(attempt);
    try {
      await poll(async () => this.started(attempt) && (await fetch(`${this.base}/system_stats`, { signal: AbortSignal.timeout(5_000) })).ok, this.startMs, "ComfyUI");
    } catch (e) {
      // A start that failed doesn't keep it asked for.
      this.loaded.delete(model.id);
      if (!this.loaded.size) this.ask(null);
      throw e;
    }
  }
  async unload(model: TextModel): Promise<void> {
    this.loaded.delete(model.id);
    await this.post("/free", { unload_models: true, free_memory: true });
    if (this.loaded.size || !this.gate) return;
    // Stopped a moment later, so switching recipes doesn't restart it.
    this.stopping = setTimeout(() => this.ask(null), STOP_AFTER_MS);
    this.stopping.unref?.();
  }
  url(): string {
    return this.base;
  }
  async reset(): Promise<void> {
    this.loaded.clear();
    this.ask(null);
  }
}

/** Width and height of a PNG, JPEG or WebP, from its header. */
export function imageSize(b: Buffer): { width: number; height: number; type: "png" | "jpeg" | "webp" } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: "png" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), type: "jpeg" };
      }
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), type: "webp" };
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, type: "webp" };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: "webp" };
    }
  }
  return null;
}

/** The nodes that sample, whose steps ComfyUI reports as `progress`. */
const SAMPLER = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced|LanPaint_SamplerCustomAdvanced|SeedVR2VideoUpscaler)$/;

/**
 * Turns ComfyUI's per-node step counts into the job's fraction: each sampler that leads to an output counts
 * equally, and sampling is 95% of the job, since decoding and encoding the result follow it. A workflow with
 * no sampler reports nothing.
 */
export function samplingProgress(prompt: object, report: (fraction: number) => void): ((node: string, value: number, max: number) => void) | undefined {
  const nodes = prompt as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  // ComfyUI runs only what an output needs: start from the save nodes, and walk their inputs back.
  const needed = new Set<string>();
  const walk = (id: string) => {
    if (needed.has(id) || !nodes[id]) return;
    needed.add(id);
    for (const v of Object.values(nodes[id]!.inputs ?? {})) if (Array.isArray(v) && typeof v[0] === "string") walk(v[0]);
  };
  for (const [id, n] of Object.entries(nodes)) if (/^(Save|Preview)/.test(n.class_type ?? "")) walk(id);
  const samplers = [...needed].filter((id) => SAMPLER.test(nodes[id]!.class_type ?? ""));
  if (!samplers.length) return undefined;
  const done = new Map<string, number>();
  return (node, value, max) => {
    if (!samplers.includes(node) || !(max > 0) || !Number.isFinite(value)) return;
    done.set(node, Math.min(1, Math.max(done.get(node) ?? 0, value / max)));
    report(0.95 * [...done.values()].reduce((a, b) => a + b, 0) / samplers.length);
  };
}
