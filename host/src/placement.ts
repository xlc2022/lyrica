// Where a model runs, and how (DESIGN, "The host manages each GPU's VRAM").
// Each model has a placement and serving settings; each GPU says which
// servers it allows, how much to keep free, or that it's left out. A
// placement that can't work is refused when saved, with the reason.
import { HostError, invalid } from "./http.ts";
import type { Gpu } from "./gpus.ts";
import type { TextModel } from "./library.ts";

export type Server = "llamacpp" | "vllm" | "images" | "speech";
export const SERVERS: Server[] = ["llamacpp", "vllm", "images", "speech"];
export const SERVER_NAMES: Record<Server, string> = { llamacpp: "llama.cpp", vllm: "vLLM", images: "images", speech: "speech" };

export type Placement =
  | { mode: "auto" }
  | { mode: "gpus"; gpus: number[]; split?: number[]; parallel?: "tensor" | "pipeline" };

export interface ModelSettings {
  placement: Placement;
  contextLength?: number;
  /** llama.cpp */
  kvCacheType?: "f16" | "q8_0" | "q4_0";
  flashAttention?: "auto" | "on" | "off";
  /** Layers on the GPUs, set by hand; the rest, with their cache, stay in system RAM. All unless set. */
  gpuLayers?: number;
  /** llama.cpp: false keeps the model on the GPUs only, never in the host's system RAM allowance. */
  systemRam?: false;
  /** llama.cpp: "ram" loads a per-layer embedding table over 4 GiB into system RAM, instead of reading its rows from the file as needed. */
  layerTable?: "ram";
  parallel?: number;
  /** llama.cpp's batch size, or vLLM's batched tokens. */
  batchSize?: number;
  /** vLLM */
  memoryShare?: number;
  maxSeqs?: number;
  dtype?: "auto" | "bfloat16" | "float16";
  /** A Jinja chat template used instead of the model's own. */
  chatTemplate?: string;
  /** YaRN: raises the context's limit to the trained length times the factor. Off unless set. */
  stretch?: Stretch;
  /** llama.cpp: false leaves the vision projector out (less memory, no images). On when the model has one. */
  vision?: boolean;
  /** llama.cpp: a projector picked by hand, relative to the models folder, instead of the one its name matches. */
  mmproj?: string;
  /** llama.cpp: false turns off drafting with MTP. On when the model has an MTP file or its own MTP layers. */
  mtp?: boolean;
  /** llama.cpp: tokens MTP drafts ahead, 1 to 6; 2 unless set. */
  draftMax?: number;
}

/** Whether a model runs with its projector and with MTP, under its settings. */
export const usesVision = (model: TextModel, s: ModelSettings) => !!model.mmproj && s.vision !== false;
export const usesMtp = (model: TextModel, s: ModelSettings) => (!!model.mtp || !!model.builtInMtp) && s.mtp !== false;

export interface Stretch {
  type: "yarn";
  factor: number;
  /** The context the model was trained for, as the recipe names it. */
  originalContext: number;
}

export interface GpuSettings {
  servers: Server[];
  /** Bytes always left free on this GPU. */
  keepFree: number;
  excluded: boolean;
}

/**
 * The most of the machine's memory the system RAM allowance may give models:
 * all of it less llama.cpp's prompt cache (an eighth, from 8 to 64 GiB) and
 * 8 GiB for the system.
 */
export const ramMost = (total: number) => Math.max(0, total - Math.min(64 * 1024 ** 3, Math.max(8 * 1024 ** 3, total / 8)) - 8 * 1024 ** 3);

export const DEFAULT_CONTEXT = 32768;
const GIB = 1024 ** 3;
/** llama.cpp reads a per-layer embedding table larger than this from the file as needed, unless it is kept in RAM. */
export const LAZY_TABLE = 4 * GIB;

/**
 * What a model keeps in system RAM under its settings for its per-layer embedding table, in bytes; 0 when it doesn't.
 * Loaded without mmap, the input embeddings llama.cpp keeps on the CPU become resident with it.
 */
export const tableInRam = (model: TextModel, s: ModelSettings) => (s.layerTable === "ram" ? tableBytes(model) : 0);

/** What `layerTable: "ram"` would keep in system RAM: a per-layer embedding table over 4 GiB and the input embeddings; 0 for a model without one. */
export const tableBytes = (model: TextModel) =>
  model.server === "llamacpp" && (model.layerTable ?? 0) > LAZY_TABLE ? model.layerTable! + (model.inputBytes ?? 0) : 0;
/** Each GPU a model uses needs room for the server's own buffers. */
const OVERHEAD = GIB / 2;
const KV_BYTES = { f16: 2, q8_0: 1.0625, q4_0: 0.5625 };

export const defaultGpu = (): GpuSettings => ({ servers: [...SERVERS], keepFree: GIB / 2, excluded: false });

/** The GPU setting a model's server falls under: whisper.cpp's dictation is speech. */
export function serverOf(model: TextModel): Server {
  return model.server === "comfyui" ? "images" : model.server === "whispercpp" ? "speech" : model.server;
}

/** The longest context a model may be served with: what it was trained for, times its stretch. */
export function maxContextOf(model: TextModel, s: ModelSettings): number | null {
  const base = model.contextLength ?? s.stretch?.originalContext ?? null;
  return base === null ? null : base * (s.stretch?.factor ?? 1);
}

/**
 * The context for a chat model with no saved one: the largest that fits some
 * way it may run with its GPUs as given, in steps of 1024 from 4096 up to its
 * maximum. With no maximum, or when nothing fits, 32k (never past its maximum),
 * so a load that can't work fails with the usual reason.
 */
export function autoContext(model: TextModel, s: ModelSettings, gpus: Gpu[], settings: (i: number) => GpuSettings): number {
  const max = maxContextOf(model, s);
  const fallback = Math.min(DEFAULT_CONTEXT, max ?? Infinity);
  if (max === null || model.kind !== "chat") return fallback;
  const fits = (context: number) => {
    const at = { ...s, contextLength: context };
    return options(model, at, gpus, settings).some((o) => !neverFits(model, at, o, gpus, settings));
  };
  if (fits(max)) return max;
  // Steps of 1024: lo fits, hi doesn't.
  let lo = 4, hi = Math.ceil(max / 1024);
  if (hi <= lo || !fits(lo * 1024)) return fallback;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid * 1024)) lo = mid; else hi = mid;
  }
  return lo * 1024;
}

/** The context the model is served with: its setting, else 32k, never past its maximum. */
export function contextOf(model: TextModel, s: ModelSettings): number {
  return Math.min(s.contextLength ?? DEFAULT_CONTEXT, maxContextOf(model, s) ?? Infinity);
}

/**
 * Requests a chat model serves at once, sharing one cache of its context:
 * its setting (llama.cpp's parallel, vLLM's maxSeqs), else by its context:
 * 1 below 200k, 2 from 200k, 4 from 500k, the host's own default when unset.
 * Lyrica sends no more at once than this reports. Null for other models.
 */
export function concurrentOf(model: TextModel, s: ModelSettings): number | null {
  if (model.kind !== "chat") return null;
  const set = model.server === "vllm" ? s.maxSeqs : s.parallel;
  if (set) return set;
  const context = contextOf(model, s);
  return context >= 500_000 ? 4 : context >= 200_000 ? 2 : 1;
}

/** Bytes for the weights, and for the KV cache at the model's context. */
export function sizes(model: TextModel, s: ModelSettings): { weights: number; kv: number } {
  if (model.kind === "image" || model.kind === "speak") return { weights: Math.round(model.size * 1.1), kv: 0 };
  // whisper.cpp: its file, and about half a gigabyte of buffers for the audio.
  if (model.server === "whispercpp") return { weights: Math.round(model.size * 1.1) + GIB / 2, kv: 0 };
  const context = model.kind === "embedding" ? Math.min(contextOf(model, s), 8192) : contextOf(model, s);
  const perToken = model.kvPerToken !== null ? model.kvPerToken * KV_BYTES[s.kvCacheType ?? "f16"] : (2 * GIB) / DEFAULT_CONTEXT;
  const extras = (usesVision(model, s) ? model.mmprojSize ?? 0 : 0) + (usesMtp(model, s) ? model.mtpSize ?? 0 : 0);
  // llama.cpp never puts a per-layer embedding table on the GPUs.
  const table = model.server === "llamacpp" ? model.layerTable ?? 0 : 0;
  return { weights: Math.round((model.size - table + extras) * 1.05), kv: Math.round(perToken * context) };
}

/** One way to run a model: its GPUs, and what it takes on each. */
export interface Option {
  gpus: number[];
  /** llama.cpp's tensor split, as ratios. */
  split: number[] | null;
  parallel: "tensor" | "pipeline" | null;
  /** vLLM's memory share on each of its GPUs. */
  share: number | null;
  need: Record<number, number>;
  /** Bytes kept in system RAM instead of on the GPUs (llama.cpp). */
  ram?: number;
  /** llama.cpp: the first N layers keep their experts in system RAM. */
  cpuMoe?: number;
  /** llama.cpp: layers on the GPUs, the rest in system RAM. */
  gpuLayers?: number;
}

const room = (g: Gpu, gs: GpuSettings) => g.total - gs.keepFree;
const matching = (gpus: Gpu[]) => gpus.every((g) => g.name === gpus[0]!.name && g.total === gpus[0]!.total);
const powerOfTwo = (n: number) => (n & (n - 1)) === 0;

function option(model: TextModel, s: ModelSettings, gpus: Gpu[], settings: (i: number) => GpuSettings, split?: number[], parallel?: "tensor" | "pipeline"): Option {
  const { weights, kv } = sizes(model, s);
  const total = weights + kv;
  const ids = gpus.map((g) => g.index);
  if (serverOf(model) === "vllm") {
    const par = gpus.length === 1 ? null : parallel ?? (matching(gpus) && powerOfTwo(gpus.length) ? "tensor" : "pipeline");
    // vLLM reserves a share of each GPU: the one set, or what the model needs, in steps of 5%.
    const smallest = Math.min(...gpus.map((g) => g.total));
    const share = s.memoryShare ?? Math.min(0.95, Math.max(0.1, Math.ceil(((total / gpus.length + OVERHEAD) / smallest) * 20) / 20));
    return { gpus: ids, split: null, parallel: par, share, need: Object.fromEntries(gpus.map((g) => [g.index, Math.round(share * g.total)])) };
  }
  // llama.cpp splits by ratio: the one set, or by each GPU's room.
  const ratios = split ?? gpus.map((g) => room(g, settings(g.index)));
  const sum = ratios.reduce((a, b) => a + b, 0);
  // Layers left off the GPUs by hand take their share of the weights and cache to system RAM.
  const off = s.gpuLayers !== undefined && model.layers && s.gpuLayers < model.layers ? Math.round((total * (model.layers - s.gpuLayers)) / model.layers) : 0;
  // A per-layer embedding table kept in RAM takes from the allowance, though it was never on the GPUs.
  const ram = off + tableInRam(model, s);
  return {
    gpus: ids,
    split: gpus.length > 1 ? ratios : null,
    parallel: null,
    share: null,
    need: Object.fromEntries(gpus.map((g, i) => [g.index, Math.round(((total - off) * ratios[i]!) / sum + OVERHEAD)])),
    ...(ram ? { ram } : {}),
    ...(off ? { gpuLayers: s.gpuLayers } : {}),
  };
}

/** Whether a model may keep part of itself in the host's system RAM allowance. */
const spills = (model: TextModel, s: ModelSettings) => model.server === "llamacpp" && !!model.layers && s.systemRam !== false && s.gpuLayers === undefined;

/**
 * An option that doesn't fit its GPUs (`used`: what other programs hold), with
 * what they lack moved to system RAM: the experts of its first layers, the
 * cheapest to run from RAM, else whole layers with their cache. Null when it
 * would leave no layer on the GPUs.
 */
export function spill(model: TextModel, s: ModelSettings, o: Option, gpus: Gpu[], settings: (i: number) => GpuSettings): Option | null {
  const layers = model.layers!;
  const avail = o.gpus.map((i) => { const g = gpus.find((x) => x.index === i)!; return room(g, settings(i)) - Math.max(0, g.used) - OVERHEAD; });
  const { weights, kv } = sizes(model, s);
  const experts = model.expertLayers ?? [];
  const expertSum = experts.reduce((a, b) => a + b, 0);
  if (expertSum > 0) {
    // With every layer offloaded, llama.cpp splits layers + 1 slots: the last is the output layer, on the last GPU.
    const out = Math.min(model.outputBytes ?? 0, weights);
    // Each layer's bytes on a GPU: its share of everything but the experts and the output layer, plus its own experts unless kept in RAM.
    const base = (weights + kv - expertSum - out) / layers;
    const bytes = (n: number) => Array.from({ length: layers }, (_, l) => base + (l < n ? 0 : experts[l] ?? 0));
    // A split set by hand keeps its layers on each GPU; else the layers left are shared out to fit.
    const fixed = s.placement.mode === "gpus" && !!s.placement.split;
    const slots = layersBySplit(layers + 1, fixed ? o.split ?? [1] : [1]);
    const outOn = fixed ? slots.findLastIndex((c) => c > 0) : o.gpus.length - 1;
    for (let n = 1; n <= layers; n++) {
      const b = bytes(n);
      const counts = fixed || o.gpus.length === 1 ? slots.map((c, k) => c - (k === outOn ? 1 : 0)) : layersToFit(b, avail.map((a, k) => a - (k === outOn ? out : 0)));
      if (!counts) continue;
      const held = heldBy(b, counts).map((x, k) => x + (k === outOn ? out : 0));
      if (held.some((x, k) => x > avail[k]!)) continue;
      const ram = Math.round(experts.slice(0, n).reduce((a, x) => a + x, 0)) + (o.ram ?? 0);
      return {
        ...o,
        need: Object.fromEntries(o.gpus.map((i, k) => [i, Math.round(held[k]! + OVERHEAD)])),
        // In slots, the output layer's on the last GPU, so llama.cpp gives each GPU the layers planned for it.
        ...(o.gpus.length > 1 && !fixed ? { split: counts.map((c, k) => c + (k === outOn ? 1 : 0)) } : {}),
        ram, cpuMoe: n,
      };
    }
  }
  // Whole layers: llama.cpp spreads the layers left on the GPUs by the split, so each GPU sheds its share.
  const sum = Object.values(o.need).reduce((a, b) => a + b, 0);
  const lack = Math.max(0, ...o.gpus.map((i, k) => ((o.need[i]! - OVERHEAD - avail[k]!) * sum) / o.need[i]!));
  if (lack <= 0) return null;
  const perLayer = (weights + kv) / layers;
  const n = Math.ceil(lack / perLayer);
  if (n >= layers) return null;
  return { ...o, need: Object.fromEntries(o.gpus.map((i) => [i, Math.round(o.need[i]! - (n * perLayer * o.need[i]!) / sum)])), ram: Math.round(n * perLayer) + (o.ram ?? 0), gpuLayers: layers - n };
}

/**
 * How many of `layers` slots llama.cpp gives each GPU under a split: slot l
 * goes to the first GPU whose share of the ratios reaches past l / layers.
 * With every layer offloaded it splits a model's layers + 1, the output layer
 * being the last.
 */
export function layersBySplit(layers: number, split: number[]): number[] {
  const total = split.reduce((a, b) => a + b, 0);
  const counts = split.map(() => 0);
  for (let l = 0; l < layers; l++) {
    let acc = 0, k = 0;
    for (; k < split.length - 1; k++) { acc += split[k]! / total; if (l / layers < acc) break; }
    counts[k]!++;
  }
  return counts;
}

/** Layers in order, as many to each GPU as fit it; null when they don't all fit. */
function layersToFit(bytes: number[], avail: number[]): number[] | null {
  const counts = avail.map(() => 0);
  let k = 0, used = 0;
  for (const b of bytes) {
    while (k < avail.length && used + b > avail[k]!) { k++; used = 0; }
    if (k === avail.length) return null;
    counts[k]!++;
    used += b;
  }
  return counts;
}

/** The bytes of the layers each GPU holds, given how many it has, in order. */
function heldBy(bytes: number[], counts: number[]): number[] {
  let l = 0;
  return counts.map((c) => { let n = 0; for (let i = 0; i < c; i++) n += bytes[l++] ?? 0; return n; });
}

/**
 * The ways a model may run, in order of preference. A chosen placement has
 * one; Auto tries each GPU that allows its server, largest first, then all
 * of them together. With an allowance, a way that can't fit `gpus` (their
 * `used` being what other programs hold) keeps what doesn't in system RAM.
 */
export function options(model: TextModel, s: ModelSettings, gpus: Gpu[], settings: (i: number) => GpuSettings, allowance = 0): Option[] {
  const found = gpuOptions(model, s, gpus, settings);
  if (!allowance || !spills(model, s)) return found;
  // Only a way that can't fit even once the host's other models are unloaded keeps part of the model in system RAM.
  return found.map((o) => (neverFits(model, s, o, gpus, settings) ? spill(model, s, o, gpus, settings) ?? o : o));
}

function gpuOptions(model: TextModel, s: ModelSettings, gpus: Gpu[], settings: (i: number) => GpuSettings): Option[] {
  const server = serverOf(model);
  const allowed = gpus.filter((g) => !settings(g.index).excluded && settings(g.index).servers.includes(server));
  const p = s.placement;
  if (p.mode === "gpus") {
    const chosen = p.gpus.map((i) => allowed.find((g) => g.index === i)).filter((g): g is Gpu => !!g);
    return chosen.length === p.gpus.length ? [option(model, s, chosen, settings, p.split, p.parallel)] : [];
  }
  const singles = [...allowed].sort((a, b) => room(b, settings(b.index)) - room(a, settings(a.index))).map((g) => option(model, s, [g], settings));
  // The speech server runs a voice model on one GPU.
  return allowed.length > 1 && server !== "speech" ? [...singles, option(model, s, allowed, settings)] : singles;
}

/** Why an option can never fit, even with its GPUs empty and the system RAM allowance unused; null if it can. */
export function neverFits(model: TextModel, s: ModelSettings, o: Option, gpus: Gpu[], settings: (i: number) => GpuSettings, allowance = Infinity): string | null {
  const gb = (n: number) => (n / GIB).toFixed(1);
  if (o.ram && o.ram > allowance) {
    return `This model needs about ${gb(o.ram)} GB of system RAM besides its GPUs, more than the host's allowance of ${gb(allowance)} GB.`;
  }
  if (serverOf(model) === "vllm") {
    // vLLM must fit the weights and the KV cache for its context inside its share of each GPU.
    const { weights, kv } = sizes(model, s);
    for (const i of o.gpus) {
      const g = gpus.find((x) => x.index === i)!;
      const share = o.share! * g.total;
      if (weights / o.gpus.length + OVERHEAD > share) {
        return `This model's weights need about ${gb(weights / o.gpus.length + OVERHEAD)} GB on GPU ${i}, more than vLLM's share of ${gb(share)} GB; raise the memory share or use more GPUs.`;
      }
      if ((weights + kv) / o.gpus.length + OVERHEAD > share) {
        return `A context of ${contextOf(model, s)} tokens needs about ${gb((weights + kv) / o.gpus.length + OVERHEAD - share)} GB more than vLLM's share of GPU ${i}; lower the context length.`;
      }
    }
  }
  for (const i of o.gpus) {
    const g = gpus.find((x) => x.index === i)!;
    const has = room(g, settings(i)) - Math.max(0, g.used);
    if (o.need[i]! <= has) continue;
    const { kv } = sizes(model, s);
    const withoutKv = o.need[i]! - (kv * o.need[i]!) / Object.values(o.need).reduce((a, b) => a + b, 0);
    if (serverOf(model) !== "vllm" && withoutKv <= has) {
      return `A context of ${contextOf(model, s)} tokens needs about ${gb(o.need[i]! - has)} GB more than GPU ${i} has; lower the context length.`;
    }
    return `This model needs about ${gb(o.need[i]!)} GB on GPU ${i}, which has ${gb(has)} GB to give.`;
  }
  return null;
}

const int = (v: unknown, min: number, max: number, what: string) => {
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(`${what} must be a whole number from ${min} to ${max}.`);
};
const oneOf = (v: unknown, values: readonly string[], what: string) => {
  if (v !== undefined && !values.includes(v as string)) throw invalid(`${what} must be one of ${values.join(", ")}.`);
};

const LLAMA_ONLY = ["kvCacheType", "flashAttention", "gpuLayers", "systemRam", "layerTable", "parallel", "vision", "mmproj", "mtp", "draftMax"] as const;
const VLLM_ONLY = ["memoryShare", "maxSeqs", "dtype"] as const;
const KEYS = ["placement", "contextLength", "batchSize", "chatTemplate", "stretch", ...LLAMA_ONLY, ...VLLM_ONLY];

const MAX_CONTEXT = 1_048_576;

/**
 * A stretch as saved: YaRN, a factor from 1 to 8 (whole for llama.cpp's
 * rope-scale), and the original context, which defaults to the trained
 * length. Only for chat models whose trained length the host read.
 */
function checkStretch(model: TextModel, server: Server, v: unknown): Stretch {
  if (model.kind !== "chat") throw invalid("Only chat models can be stretched.");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("stretch is { type: \"yarn\", factor, originalContext }.");
  const o = v as Record<string, unknown>;
  if (!model.contextLength && o.originalContext === undefined) throw invalid("The host couldn't read how long a context this model was trained for: give the original context to stretch from.");
  for (const k of Object.keys(o)) if (!["type", "factor", "originalContext"].includes(k)) throw invalid(`Unknown stretch field: ${k}.`);
  if (o.type !== "yarn") throw invalid("stretch.type must be yarn.");
  const whole = server === "llamacpp";
  if (typeof o.factor !== "number" || !Number.isFinite(o.factor) || o.factor < 1 || o.factor > 8 || (whole && !Number.isInteger(o.factor))) {
    throw invalid(whole ? "stretch.factor must be a whole number from 1 to 8 for llama.cpp." : "stretch.factor must be from 1 to 8.");
  }
  int(o.originalContext, 512, MAX_CONTEXT, "stretch.originalContext");
  return { type: "yarn", factor: o.factor, originalContext: (o.originalContext as number | undefined) ?? model.contextLength! };
}

/** The one way to run a server on the CPU: no GPUs, nothing counted against them. */
export const CPU_OPTION: Option = { gpus: [], split: null, parallel: null, share: null, need: {} };

/**
 * Checks settings as they are saved: their shape, and that the placement can
 * work on these GPUs. `onCpu`: the server runs on the CPU here (speech on a
 * host without CUDA), so only Auto is taken.
 */
export function validate(model: TextModel, body: Record<string, unknown>, gpus: Gpu[], settings: (i: number) => GpuSettings, onCpu = false, allowance = 0): ModelSettings {
  for (const k of Object.keys(body)) if (!KEYS.includes(k)) throw invalid(`Unknown setting: ${k}.`);
  const server = serverOf(model);
  if (server === "images") throw invalid("Image recipes run on ComfyUI's GPU and have no settings here.");
  if (server === "speech") {
    const extra = Object.keys(body).find((k) => k !== "placement");
    if (extra) throw invalid(`${extra} isn't a setting for a ${model.kind === "speak" ? "voice" : "dictation"} model; it has a placement only.`);
    if (onCpu && (body.placement as Placement | undefined)?.mode !== "auto") throw invalid("Voice models run on the CPU on this host: the placement is { mode: \"auto\" }.");
    if (onCpu) return body as unknown as ModelSettings;
  }
  for (const k of server === "vllm" ? LLAMA_ONLY : VLLM_ONLY) {
    if (body[k] !== undefined) throw invalid(`${k} is for ${server === "vllm" ? "llama.cpp" : "vLLM"} models.`);
  }
  int(body.contextLength, 512, MAX_CONTEXT, "contextLength");
  if (body.stretch !== undefined) body.stretch = checkStretch(model, server, body.stretch);
  // A factor of 1 is no stretch: nothing is passed to the server.
  if ((body.stretch as Stretch | undefined)?.factor === 1) delete body.stretch;
  const max = maxContextOf(model, body as unknown as ModelSettings);
  if (typeof body.contextLength === "number" && max && body.contextLength > max) {
    const stretch = (body.stretch as Stretch | undefined)?.factor;
    throw invalid(stretch && stretch > 1
      ? `This model was trained for ${model.contextLength} tokens; with a stretch of ${stretch} it serves ${max} at most.`
      : `This model was trained for ${model.contextLength} tokens of context at most.`);
  }
  oneOf(body.kvCacheType, ["f16", "q8_0", "q4_0"], "kvCacheType");
  oneOf(body.flashAttention, ["auto", "on", "off"], "flashAttention");
  // llama.cpp needs flash attention for a quantized V cache.
  if ((body.kvCacheType === "q8_0" || body.kvCacheType === "q4_0") && body.flashAttention !== "on") {
    throw invalid("A q8_0 or q4_0 KV cache needs flashAttention set to on.");
  }
  int(body.gpuLayers, 0, 999, "gpuLayers");
  if (body.systemRam !== undefined && body.systemRam !== false) throw invalid("systemRam is false, or left out for Auto.");
  if (body.layerTable !== undefined) {
    if (body.layerTable !== "ram") throw invalid("layerTable is \"ram\", or left out to read it from the file.");
    if (!tableBytes(model)) throw invalid("This model has no per-layer embedding table over 4 GiB.");
    if (!allowance) throw invalid("Keeping the embedding table in RAM takes from the host's system RAM allowance, which is off.");
  }
  for (const k of ["vision", "mtp"] as const) if (body[k] !== undefined && typeof body[k] !== "boolean") throw invalid(`${k} is true or false.`);
  if (body.mmproj !== undefined && (typeof body.mmproj !== "string" || model.kind !== "chat")) throw invalid("mmproj is a projector's path, for a chat model.");
  if (body.vision !== undefined && !model.mmproj) throw invalid("This model has no vision projector.");
  if (body.mtp !== undefined && !model.mtp && !model.builtInMtp) throw invalid("This model has no MTP file or layers.");
  int(body.draftMax, 1, 6, "draftMax");
  int(body.parallel, 1, 64, "parallel");
  int(body.batchSize, 32, 65536, "batchSize");
  int(body.maxSeqs, 1, 1024, "maxSeqs");
  oneOf(body.dtype, ["auto", "bfloat16", "float16"], "dtype");
  if (body.memoryShare !== undefined && (typeof body.memoryShare !== "number" || body.memoryShare < 0.05 || body.memoryShare > 0.95)) {
    throw invalid("memoryShare must be from 0.05 to 0.95.");
  }
  if (body.chatTemplate !== undefined && (typeof body.chatTemplate !== "string" || body.chatTemplate.length > 64 * 1024)) {
    throw invalid("chatTemplate must be text, at most 64 kB.");
  }

  const p = body.placement as Placement | undefined;
  if (!p || typeof p !== "object") throw invalid("placement is needed: { mode: \"auto\" } or { mode: \"gpus\", gpus: [...] }.");
  if (p.mode === "gpus") {
    const chosen = p.gpus;
    if (!Array.isArray(chosen) || !chosen.length || chosen.some((i) => !Number.isInteger(i)) || new Set(chosen).size !== chosen.length) {
      throw invalid("gpus must list one or more GPUs, each once.");
    }
    for (const i of chosen) {
      const g = gpus.find((x) => x.index === i);
      if (!g) throw invalid(`There's no GPU ${i}.`);
      const gs = settings(i);
      if (gs.excluded) throw invalid(`GPU ${i} is left out.`);
      if (!gs.servers.includes(server)) throw invalid(`GPU ${i} doesn't allow ${SERVER_NAMES[server]}.`);
    }
    if (p.split !== undefined) {
      if (server !== "llamacpp") throw invalid("split is for llama.cpp; vLLM splits evenly.");
      if (!Array.isArray(p.split) || p.split.length !== chosen.length || p.split.some((r) => typeof r !== "number" || !Number.isFinite(r) || r < 0.01 || r > 1000)) {
        throw invalid("split must give a ratio from 0.01 to 1000 for each GPU.");
      }
    }
    if (p.parallel !== undefined) {
      if (server !== "vllm") throw invalid("parallel is for vLLM; llama.cpp splits by ratio.");
      oneOf(p.parallel, ["tensor", "pipeline"], "parallel");
      const picked = chosen.map((i) => gpus.find((x) => x.index === i)!);
      if (p.parallel === "tensor" && (!matching(picked) || !powerOfTwo(picked.length))) {
        throw invalid("Tensor parallel needs matching GPUs, two, four or eight of them; use pipeline parallel.");
      }
    }
    if (server === "speech" && chosen.length > 1) throw invalid(`A ${model.kind === "speak" ? "voice" : "dictation"} model runs on one GPU.`);
    for (const k of Object.keys(p)) if (!["mode", "gpus", "split", "parallel"].includes(k)) throw invalid(`Unknown placement field: ${k}.`);
  } else if (p.mode !== "auto" || Object.keys(p).length !== 1) {
    throw invalid("placement is { mode: \"auto\" } or { mode: \"gpus\", gpus: [...] }.");
  }

  const s = body as unknown as ModelSettings;
  // With no context saved, it is checked at the one it would be served with.
  const at = s.contextLength === undefined && model.kind === "chat" ? { ...s, contextLength: autoContext(model, s, gpus, settings) } : s;
  const opts = options(model, at, gpus, settings, allowance);
  if (!opts.length) throw invalid(`No GPU allows ${SERVER_NAMES[server]}.`);
  // Auto needs one way that can work; a chosen placement must work as chosen.
  const reasons = opts.map((o) => neverFits(model, at, o, gpus, settings, allowance));
  if (reasons.every((r) => r !== null)) throw new HostError(400, "too_big", reasons.at(-1)!);
  return s;
}

/** A key for remembering measured VRAM per placement. */
export const placementKey = (o: Option) =>
  `${o.gpus.join("+")}${o.split ? `:${o.split.join(",")}` : ""}${o.share ? `@${o.share}` : ""}${o.cpuMoe ? `/moe${o.cpuMoe}` : ""}${o.gpuLayers !== undefined ? `/ngl${o.gpuLayers}` : ""}`;
