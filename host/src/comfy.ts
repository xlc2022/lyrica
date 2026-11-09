// ComfyUI, reached only from host-api. Results come back over its websocket
// (SaveImageWebsocket, and our SaveVideoWebsocket for clips), nothing is saved, and its history is cleared after
// every job. One job at a time, so uploads can't mix. There is one per image
// GPU (ComfyGpus). Each runs only while a recipe is loaded on it
// (host/comfyui/gate.py reads serving/comfyui-<gpu>.json), since its
// process holds GPU memory for as long as it lives.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HostError } from "./http.ts";
import { poll, writeAtomic, type Backend } from "./backends.ts";
import type { TextModel } from "./library.ts";
import type { Option } from "./placement.ts";

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
  /** Given ComfyUI's node types (`/object_info`) each time it starts, for checking custom workflows. */
  onNodes?: (info: Record<string, never>) => void;

  constructor(base: string, timeoutMs = 30 * 60_000, callMs = CALL_MS, gate?: { state: string; status: string }, startMs = 5 * 60_000) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.callMs = callMs;
    this.startMs = startMs;
    if (gate) this.gate = gate;
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
  async run(images: Record<string, Buffer>, build: (names: Record<string, string>) => object, signal?: AbortSignal, onProgress?: (fraction: number, stage?: Stage) => void): Promise<{ pngs: Buffer[]; sampling?: Sampling }> {
    const { pngs, sampling } = await this.job(images, build, "image", this.timeoutMs, signal, onProgress);
    return { pngs, ...(sampling ? { sampling } : {}) };
  }

  /** Like `run`, for a video workflow: its MP4 and its poster (the first frame, a PNG). */
  async runVideo(images: Record<string, Buffer>, build: (names: Record<string, string>) => object, timeoutMs: number, signal?: AbortSignal, onProgress?: (fraction: number, stage?: Stage) => void): Promise<{ video: Buffer; poster: Buffer | null; sampling?: Sampling }> {
    const { pngs, videos, sampling } = await this.job(images, build, "video", timeoutMs, signal, onProgress);
    if (!videos[0]) throw new HostError(503, "model_unavailable", "ComfyUI returned no video.");
    return { video: videos[0], poster: pngs[0] ?? null, ...(sampling ? { sampling } : {}) };
  }

  private job(images: Record<string, Buffer>, build: (names: Record<string, string>) => object, what: "image" | "video", timeoutMs: number, signal?: AbortSignal, onProgress?: (fraction: number, stage?: Stage) => void): Promise<{ pngs: Buffer[]; videos: Buffer[]; sampling?: Sampling }> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const names: Record<string, string> = {};
      const pngs: Buffer[] = [];
      const videos: Buffer[] = [];
      let promptId: string | null = null;
      let finished = false;
      let ws: WebSocket | null = null;
      try {
        for (const [key, data] of Object.entries(images)) names[key] = await this.upload(uploadName(key, data), data);
        const prompt = build(names);
        const progress = onProgress && samplingProgress(prompt, onProgress);
        const timing = samplingTime(prompt);
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
            let msg: { type?: string; data?: { prompt_id?: string; node?: unknown; nodes?: unknown; node_type?: unknown; exception_type?: unknown; value?: unknown; max?: unknown } };
            try {
              msg = JSON.parse(String(e.data));
            } catch {
              return;
            }
            // Only this client's messages arrive here; skip any for another prompt.
            if (promptId && msg.data?.prompt_id && msg.data.prompt_id !== promptId) return;
            // The node and the exception's type name what broke; the exception's message can carry the prompt, so it stays out.
            // Out of GPU memory mid-job is about this job's size, not the recipe: say what to lower.
            if (msg.type === "execution_error") {
              const node = String(msg.data?.node_type ?? "a node"), type = String(msg.data?.exception_type ?? "error");
              reject(new HostError(503, "model_unavailable", /OutOfMemory/i.test(type)
                ? `ComfyUI ran out of GPU memory making the ${what} (${node}). A smaller size, scale or maxSize fits.`
                : `ComfyUI failed to make the ${what} (${node}: ${type}).`));
            }
            else if (msg.type === "executing" && msg.data?.node === null) resolve();
            else if (msg.type === "executing" && typeof msg.data?.node === "string") {
              progress?.started(msg.data.node);
              timing?.started(msg.data.node);
            } else if (msg.type === "execution_cached" && Array.isArray(msg.data?.nodes)) progress?.cached(msg.data.nodes.map(String));
            else if (msg.type === "progress" && msg.data) {
              progress?.stepped(String(msg.data.node), Number(msg.data.value), Number(msg.data.max));
              timing?.stepped(String(msg.data.node), Number(msg.data.max));
            }
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
          if (!res.ok) throw new HostError(503, "model_unavailable", `ComfyUI refused the workflow${await refusal(res, prompt)}.`);
          promptId = ((await res.json()) as { prompt_id: string }).prompt_id;
          await done;
          finished = true;
          const sampling = timing?.result();
          return { pngs, videos, ...(sampling ? { sampling } : {}) };
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
        for (const [key, data] of Object.entries(images)) if (names[key]) await this.upload(uploadName(key, data), BLANK).catch(() => {});
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
      // Read before the first job, so a custom workflow is checked against the nodes of this start.
      if (this.onNodes) await this.readNodes(this.onNodes);
    } catch (e) {
      // A start that failed doesn't keep it asked for.
      this.loaded.delete(model.id);
      if (!this.loaded.size) this.ask(null);
      throw e;
    }
  }
  /** ComfyUI's node types, read after it starts; a failed read leaves the last list as it was. */
  private async readNodes(onNodes: (info: Record<string, never>) => void): Promise<void> {
    try {
      const res = await fetch(`${this.base}/object_info`, { signal: AbortSignal.timeout(this.callMs) });
      if (res.ok) onNodes((await res.json()) as Record<string, never>);
    } catch {}
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

/**
 * The ComfyUIs of a host with several image GPUs, as one scheduler backend:
 * a recipe loads on the GPU its placement names (Images gives each GPU's
 * copy of a recipe its own ID), and unloads from where it loaded.
 */
export class ComfyGpus implements Backend {
  readonly byGpu: Map<number, Comfy>;
  private readonly where = new Map<string, number>();

  constructor(byGpu: Map<number, Comfy>) {
    this.byGpu = byGpu;
  }

  /** The image GPUs, in the order given. */
  get gpus(): number[] {
    return [...this.byGpu.keys()];
  }

  private on(gpu: number | undefined): Comfy {
    const comfy = gpu === undefined ? undefined : this.byGpu.get(gpu);
    if (!comfy) throw new HostError(503, "model_unavailable", `GPU ${gpu} has no ComfyUI.`);
    return comfy;
  }

  async load(model: TextModel, placement: Option): Promise<void> {
    const gpu = placement.gpus[0];
    await this.on(gpu).load(model);
    this.where.set(model.id, gpu!);
  }
  async unload(model: TextModel): Promise<void> {
    const gpu = this.where.get(model.id);
    this.where.delete(model.id);
    if (gpu !== undefined) await this.on(gpu).unload(model);
  }
  url(model: TextModel): string {
    return this.on(this.where.get(model.id)).url();
  }
  async reset(): Promise<void> {
    this.where.clear();
    for (const comfy of this.byGpu.values()) await comfy.reset();
  }
  /** Why ComfyUI can't run on each GPU where it can't. */
  get problems(): { gpu: number; problem: string }[] {
    return [...this.byGpu].flatMap(([gpu, c]) => (c.problem ? [{ gpu, problem: c.problem }] : []));
  }
}

/** An upload's fixed name: a clip (its `ftyp` box first) keeps its kind, so ComfyUI's LoadVideo lists it. */
const uploadName = (key: string, data: Buffer) => `lyrica-${key}.${data.length > 12 && data.toString("latin1", 4, 8) === "ftyp" ? "mp4" : "png"}`;

/**
 * How long an MP4 or QuickTime clip runs, from its movie header (`moov` › `mvhd`), or null when
 * `b` isn't one. Only the top-level boxes and the movie header are read.
 */
export function mp4Seconds(b: Buffer): number | null {
  const moov = mp4Moov(b);
  const mvhd = moov && mp4Box(b, moov[0], moov[1], "mvhd");
  if (!mvhd || mvhd[1] - mvhd[0] < 32) return null;
  const v1 = b[mvhd[0]] === 1;
  const scale = b.readUInt32BE(mvhd[0] + (v1 ? 20 : 12));
  const length = v1 ? Number(b.readBigUInt64BE(mvhd[0] + 24)) : b.readUInt32BE(mvhd[0] + 16);
  return scale > 0 && length > 0 ? length / scale : null;
}

/** An MP4's video track: its size, frame count and frame rate, from its headers. */
export function mp4Video(b: Buffer): { width: number; height: number; frames: number; fps: number } | null {
  const moov = mp4Moov(b);
  for (let at = moov?.[0] ?? 0; moov;) {
    const trak = mp4Box(b, at, moov[1], "trak");
    if (!trak) return null;
    at = trak[1];
    const inside = (from: [number, number] | null, ...path: string[]) => path.reduce<[number, number] | null>((r, type) => r && mp4Box(b, r[0], r[1], type), from);
    const mdia = inside(trak, "mdia");
    const hdlr = inside(mdia, "hdlr");
    if (!hdlr || hdlr[1] - hdlr[0] < 12 || b.toString("latin1", hdlr[0] + 8, hdlr[0] + 12) !== "vide") continue;
    const tkhd = inside(trak, "tkhd");
    const mdhd = inside(mdia, "mdhd");
    const stts = inside(mdia, "minf", "stbl", "stts");
    // Version 1 headers carry 64-bit times, so they are longer.
    const v1 = !!mdhd && b[mdhd[0]] === 1;
    if (!tkhd || tkhd[1] - tkhd[0] < (b[tkhd[0]] === 1 ? 96 : 84) || !mdhd || mdhd[1] - mdhd[0] < (v1 ? 32 : 24) || !stts || stts[1] - stts[0] < 8) return null;
    const scale = b.readUInt32BE(mdhd[0] + (v1 ? 20 : 12));
    const length = v1 ? Number(b.readBigUInt64BE(mdhd[0] + 24)) : b.readUInt32BE(mdhd[0] + 16);
    let frames = 0;
    const entries = b.readUInt32BE(stts[0] + 4);
    for (let i = 0; i < entries && stts[0] + 16 + i * 8 <= stts[1]; i++) frames += b.readUInt32BE(stts[0] + 8 + i * 8);
    if (!scale || !length || !frames) return null;
    // Width and height are 16.16 fixed point, the header's last eight bytes.
    return { width: b.readUInt32BE(tkhd[1] - 8) >>> 16, height: b.readUInt32BE(tkhd[1] - 4) >>> 16, frames, fps: frames * scale / length };
  }
  return null;
}

/** Whether an MP4 has a sound track (a `trak` whose handler is `soun`). */
export function mp4Sound(b: Buffer): boolean {
  const moov = mp4Moov(b);
  for (let at = moov?.[0] ?? 0; moov;) {
    const trak = mp4Box(b, at, moov[1], "trak");
    if (!trak) return false;
    at = trak[1];
    const mdia = mp4Box(b, trak[0], trak[1], "mdia");
    const hdlr = mdia && mp4Box(b, mdia[0], mdia[1], "hdlr");
    if (hdlr && hdlr[1] - hdlr[0] >= 12 && b.toString("latin1", hdlr[0] + 8, hdlr[0] + 12) === "soun") return true;
  }
  return false;
}

/** The payload of the first `type` box between `from` and `to`, or null. */
function mp4Box(b: Buffer, from: number, to: number, type: string): [number, number] | null {
  for (let i = from; i + 8 <= to;) {
    let size = b.readUInt32BE(i);
    let head = 8;
    if (size === 1) {
      if (i + 16 > to) return null;
      size = Number(b.readBigUInt64BE(i + 8));
      head = 16;
    } else if (size === 0) size = to - i;
    if (size < head || i + size > to) return null;
    if (b.toString("latin1", i + 4, i + 8) === type) return [i + head, i + size];
    i += size;
  }
  return null;
}

const mp4Moov = (b: Buffer) => b.length < 16 || b.toString("latin1", 4, 8) !== "ftyp" ? null : mp4Box(b, 0, b.length, "moov");

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
 * Whether a node samples: one of ComfyUI's own samplers, or a custom node named a sampler that takes a latent (RES4LYF's
 * ClownsharKSampler_Beta, say), never a node that only picks a sampler (KSamplerSelect, ClownSampler_Beta).
 */
function isSampler(n: { class_type?: string; inputs?: Record<string, unknown> }): boolean {
  const type = n.class_type ?? "";
  return SAMPLER.test(type) || (/sampler/i.test(type) && !/select/i.test(type) && !!n.inputs && ("latent_image" in n.inputs || "latent" in n.inputs));
}

/** How long a job's samplers ran, over every sampler that leads to its output, and how many steps they took in all. */
export interface Sampling { ms: number; steps: number }

type Nodes = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

/** The nodes a workflow's outputs need: ComfyUI runs only what an output needs, so the walk starts from the save nodes. */
function neededOf(prompt: object): Set<string> {
  const nodes = prompt as Nodes;
  const needed = new Set<string>();
  const walk = (id: string) => {
    if (needed.has(id) || !nodes[id]) return;
    needed.add(id);
    for (const v of Object.values(nodes[id]!.inputs ?? {})) if (Array.isArray(v) && typeof v[0] === "string") walk(v[0]);
  };
  for (const [id, n] of Object.entries(nodes)) if (/^(Save|Preview)/.test(n.class_type ?? "")) walk(id);
  return needed;
}

/** The samplers a workflow's outputs need. */
function samplersOf(prompt: object): string[] {
  const nodes = prompt as Nodes;
  return [...neededOf(prompt)].filter((id) => isSampler(nodes[id]!));
}

/** What a job does once sampling has begun, when it isn't sampling: shown beside the percent (API.md, "Job progress"). */
export type Stage = "decoding" | "upscaling" | "encoding";

/** The stage a node's type names, or none for one that doesn't name one (it keeps the stage before it). */
function stageOf(type: string): Stage | undefined {
  if (/upscale|seedvr2/i.test(type)) return "upscaling";
  if (/decode/i.test(type)) return "decoding";
  if (/video|vhs_|animated|webm/i.test(type)) return "encoding";
  return undefined;
}

/** Reads a job's progress from ComfyUI's messages. */
export interface ProgressReader {
  /** An `executing` message: the node that runs now. */
  started(node: string): void;
  /** An `execution_cached` message: nodes whose cached output stands in, so they won't run. */
  cached(nodes: string[]): void;
  /** A `progress` message: a node's steps so far. */
  stepped(node: string, value: number, max: number): void;
}

/**
 * Turns ComfyUI's messages into the job's fraction and stage. Each sampler that leads to an output counts by its
 * steps (one without a `steps` input as the average of those with one), and sampling is 95% of the job; a sampler
 * whose output was cached counts as done. Once every sampler is done, a later node that reports steps (a tiled
 * decode, a model upscale) fills the rest up to 99%. While a node that decodes, upscales or encodes runs after
 * sampling began, the stage says so; a sampler clears it. A workflow with no sampler reports nothing.
 */
export function samplingProgress(prompt: object, report: (fraction: number, stage?: Stage) => void): ProgressReader | undefined {
  const nodes = prompt as Nodes;
  const samplers = samplersOf(prompt);
  if (!samplers.length) return undefined;
  const needed = neededOf(prompt);
  const given = new Map(samplers.map((id) => [id, Number(nodes[id]!.inputs?.steps)] as const).filter(([, s]) => Number.isFinite(s) && s > 0));
  const average = given.size ? [...given.values()].reduce((a, b) => a + b, 0) / given.size : 1;
  const weight = new Map(samplers.map((id) => [id, given.get(id) ?? average]));
  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  const done = new Map<string, number>();
  let began = false;
  let stage: Stage | undefined;
  let tail = 0;
  const sampled = () => [...done.entries()].reduce((a, [id, f]) => a + f * weight.get(id)!, 0) / total;
  const send = () => report(Math.min(0.99, 0.95 * sampled() + (samplers.every((id) => done.get(id) === 1) ? 0.04 * tail : 0)), stage);
  return {
    started: (node) => {
      if (!needed.has(node)) return;
      if (samplers.includes(node)) {
        began = true;
        if (stage) { stage = undefined; send(); }
        return;
      }
      const next = began ? stageOf(nodes[node]!.class_type ?? "") : undefined;
      if (next && next !== stage) { stage = next; send(); }
    },
    cached: (list) => {
      const hit = list.filter((id) => samplers.includes(id));
      if (!hit.length) return;
      for (const id of hit) done.set(id, 1);
      began = true;
      send();
    },
    stepped: (node, value, max) => {
      if (!needed.has(node) || !(max > 0) || !Number.isFinite(value)) return;
      if (samplers.includes(node)) {
        began = true;
        done.set(node, Math.min(1, Math.max(done.get(node) ?? 0, value / max)));
      } else if (samplers.every((id) => done.get(id) === 1)) tail = Math.min(1, Math.max(0, value / max));
      else return;
      send();
    },
  };
}

/**
 * Times a job's sampling from ComfyUI's own events: a sampler runs from its `executing` message to its last
 * `progress`, so the queue, model loading, encoding and decoding stay out, and each sampler's `max` is its steps.
 * The result is the sum over the output's samplers; none, or one that never stepped, gives nothing. A workflow
 * with no sampler (an upscaler's plain pass) times nothing.
 */
export function samplingTime(prompt: object, now: () => number = Date.now): { started(node: string): void; stepped(node: string, max: number): void; result(): Sampling | undefined } | undefined {
  const samplers = samplersOf(prompt);
  if (!samplers.length) return undefined;
  const began = new Map<string, number>(), ended = new Map<string, number>(), steps = new Map<string, number>();
  return {
    started: (node) => { if (samplers.includes(node) && !began.has(node)) began.set(node, now()); },
    stepped: (node, max) => {
      if (!samplers.includes(node) || !(max > 0)) return;
      // A sampler whose start went unseen counts from its first step.
      if (!began.has(node)) began.set(node, now());
      ended.set(node, now());
      steps.set(node, Math.max(steps.get(node) ?? 0, Math.round(max)));
    },
    result: () => {
      let ms = 0, total = 0;
      for (const [node, end] of ended) { ms += end - began.get(node)!; total += steps.get(node) ?? 0; }
      return ended.size && total > 0 ? { ms, steps: total } : undefined;
    },
  };
}

/**
 * Why ComfyUI refused a workflow, as " (<error type>: <node types>)": the types of the nodes it
 * names (a custom node that didn't load, a node with a bad input), never an input's value, which can be the prompt.
 */
async function refusal(res: Response, prompt: object): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { type?: unknown; extra_info?: { class_type?: unknown } }; node_errors?: Record<string, unknown> };
    const graph = prompt as Record<string, { class_type?: unknown }>;
    const word = (v: unknown) => (typeof v === "string" && /^[\w .-]{1,80}$/.test(v) ? v : null);
    const types = [body.error?.extra_info?.class_type, ...Object.keys(body.node_errors ?? {}).map((id) => graph[id]?.class_type)].map(word).filter((t): t is string => !!t);
    const type = word(body.error?.type);
    const named = [...new Set(types)].join(", ");
    return type || named ? ` (${[type, named].filter(Boolean).join(": ")})` : "";
  } catch {
    return "";
  }
}
