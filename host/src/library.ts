// The text and speech models in the models folder: GGUF files for llama.cpp,
// safetensors folders for vLLM (Whisper and Voxtral among them, for
// dictation), whisper.cpp files for dictation on a CMP 100-210, and ONNX
// voice models for the speech server. Reads headers only.
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readGguf, readGgufTensorBytes, type GgufValue } from "./gguf.ts";

export interface Identity {
  basename: string | null;
  sizeLabel: string | null;
  finetune: string | null;
  baseModels: { name: string | null; organization: string | null; repoUrl: string | null }[];
  /** The repository a GGUF was converted from, when its header says. */
  sourceRepo?: string | null;
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  embedding: boolean;
  reasoning: string[] | null;
  /** The chat template writes `<think>` itself, so a reply can start mid-thought with only `</think>`. */
  opensThinking?: boolean;
  /** Dictation: speech to text on /v1/audio/transcriptions. */
  transcribe?: boolean;
  /** Text to speech on /v1/audio/speech, with the voices it has. */
  speak?: { voices: Voice[] };
}

export interface Voice {
  id: string;
  /** "en" or "zh": the languages the speech server reads. */
  language: "en" | "zh";
}

export interface TextModel {
  /** Path relative to the models folder, with `/`. */
  id: string;
  kind: "chat" | "embedding" | "image" | "transcribe" | "speak";
  /** ComfyUI runs image recipes, which the scheduler places like models. */
  server: "llamacpp" | "vllm" | "comfyui" | "speech" | "whispercpp";
  format: "gguf" | "safetensors" | "onnx" | "ggml";
  size: number;
  identity: Identity;
  capabilities: Capabilities;
  /** The longest context the model was trained for, if known. */
  contextLength: number | null;
  /** KV-cache elements per token (keys and values, every layer that holds a cache), to size the cache; null if unknown. */
  kvPerToken: number | null;
  /** A vision projector next to a GGUF model, or the one picked in its settings, relative like `id`. */
  mmproj: string | null;
  /** A GGUF model's MTP draft file (`mtp-…`, beside it or in an `MTP` folder), relative like `id`. */
  mtp?: string | null;
  /** The GGUF carries its own MTP layers, so llama.cpp can draft with no second file. */
  builtInMtp?: boolean;
  /**
   * A GGUF model's layers, the bytes of each layer's experts (a mixture of
   * experts; 0 for a dense layer) and of its output layer (`output.weight`,
   * else the tied `token_embd.weight`), for keeping part of it in system RAM.
   */
  layers?: number;
  expertLayers?: number[];
  outputBytes?: number;
  /** The sizes of the projector and the MTP file, counted when they're used. */
  mmprojSize?: number;
  mtpSize?: number;
  /** A vLLM model whose config asks for remote code: never loaded. */
  remoteCode: boolean;
  /** A speech model's ONNX file, relative to its folder. */
  onnx?: string;
  toolCallParser?: string;
  reasoningParser?: string;
  /** The sampling its publisher recommends, which its server uses when a request sets none: a GGUF's `general.sampling.*`, a folder's generation_config.json. */
  sampling?: Sampling;
}

export interface Sampling { temperature?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number }

/** Only the numbers present, under Lyrica's names; undefined when there are none. */
function sampling(read: (key: keyof Sampling) => unknown): Sampling | undefined {
  const out: Sampling = {};
  for (const k of ["temperature", "topP", "topK", "minP", "repeatPenalty"] as const) {
    const v = read(k);
    // A GGUF holds float32, so 0.7 reads 0.699999988: six figures give back what was written.
    if ((typeof v === "number" || typeof v === "bigint") && Number.isFinite(Number(v))) out[k] = Number(Number(v).toPrecision(6));
  }
  return Object.keys(out).length ? out : undefined;
}
const GGUF_SAMPLING: Record<keyof Sampling, string> = { temperature: "temp", topP: "top_p", topK: "top_k", minP: "min_p", repeatPenalty: "penalty_repeat" };
const CONFIG_SAMPLING: Record<keyof Sampling, string> = { temperature: "temperature", topP: "top_p", topK: "top_k", minP: "min_p", repeatPenalty: "repetition_penalty" };

const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/;

/**
 * A GGUF that only helps another model, never a model of its own: a vision
 * projector (`mmproj` in its name), or an MTP draft (`mtp-…`, or anything in
 * an `MTP` folder). `path` is relative, with `/`.
 */
export function isCompanion(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!.toLowerCase();
  return name.includes("mmproj") || /^mtp[-_.]/.test(name) || parts.slice(0, -1).some((p) => p.toLowerCase() === "mtp");
}

const ggufs = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((e) => e.toLowerCase().endsWith(".gguf")).sort();
  } catch {
    return [];
  }
};

/**
 * A model's companions, found beside it or, for a model in a quant's folder,
 * in its repository's folder one or two levels up: the vision projector
 * (F16 or BF16 first), and the MTP draft whose name is closest to the model's.
 */
function companions(root: string, path: string): { mmproj: string | null; mtp: string | null } {
  const stem = basename(path).toLowerCase().replace(SHARD, "").replace(/\.gguf$/, "");
  const rel = (p: string) => relative(root, p).split("\\").join("/");
  let mmproj: string | null = null, mtp: string | null = null;
  for (let dir = dirname(path), up = 0; up <= 2 && !relative(root, dir).startsWith(".."); dir = dirname(dir), up++) {
    const here = ggufs(dir);
    const proj = here.filter((e) => e.toLowerCase().includes("mmproj"));
    const best = proj.find((e) => /bf16|f16/i.test(e)) ?? proj[0];
    if (!mmproj && best) mmproj = rel(join(dir, best));
    const drafts = [...here.filter((e) => /^mtp[-_.]/i.test(e)).map((e) => join(dir, e)),
      ...readdirSafe(dir).filter((e) => e.toLowerCase() === "mtp").flatMap((d) => ggufs(join(dir, d)).map((e) => join(dir, d, e)))];
    if (!mtp && drafts.length) {
      const score = (p: string) => common(basename(p).toLowerCase().replace(/^mtp[-_.]/, "").replace(/\.gguf$/, ""), stem);
      mtp = rel(drafts.sort((a, b) => score(b) - score(a))[0]!);
    }
    if (dir === root) break;
  }
  return { mmproj, mtp };
}

/** Every vision projector under the models folder, relative with `/`, with its size: what a model's projector may be picked from. */
export function projectorFiles(root: string): { path: string; size: number }[] {
  const found: { path: string; size: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    for (const e of readdirSafe(dir).filter((x) => !x.startsWith(".")).sort()) {
      const path = join(dir, e);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (st.isFile() && e.toLowerCase().endsWith(".gguf") && e.toLowerCase().includes("mmproj")) found.push({ path: relative(root, path).split("\\").join("/"), size: st.size });
    }
  };
  walk(root, 0);
  return found;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** How many characters two names share, from the start and from the end (a quant's suffix). */
function common(a: string, b: string): number {
  let head = 0, tail = 0;
  while (head < a.length && a[head] === b[head]) head++;
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return head + tail;
}

function str(v: GgufValue | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

export function templateCapabilities(template: string | null): Pick<Capabilities, "tools" | "reasoning" | "opensThinking"> {
  return {
    ...(template?.includes("<think>") ? { opensThinking: true } : {}),
    tools: !!template && /\btools\b/.test(template),
    // Only `enable_thinking` can be driven. A template that opens <think> without it always thinks: no switch.
    reasoning: template && /\benable_thinking\b/.test(template) ? ["off", "on"] : null,
  };
}

/** Parsers for families whose tool format the host can serve. */
export function familyParsers(family: string, name = ""): { toolCallParser?: string; reasoningParser?: string } {
  const f = family.toLowerCase().replace(/[_ .-]/g, "");
  if (f.startsWith("qwen3")) return { toolCallParser: "hermes", reasoningParser: "qwen3" };
  if (f.startsWith("qwen2")) return { toolCallParser: "hermes" };
  // Llama 3's config says only "llama", like Llama 2's: the name tells them apart.
  if (f.startsWith("llama") && /llama[\s._-]*3/i.test(`${family} ${name}`)) return { toolCallParser: "llama3_json" };
  if (f.startsWith("mistral") || f.startsWith("mixtral")) return { toolCallParser: "mistral" };
  if (f.startsWith("deepseek")) return { toolCallParser: "deepseek_v3", ...(/r1/i.test(`${family} ${name}`) ? { reasoningParser: "deepseek_r1" } : {}) };
  return {};
}

function ggufModel(root: string, path: string, siblings: string[]): TextModel | null {
  const meta = readGguf(path);
  if (meta["tokenizer.ggml.model"] === undefined) return null; // an image model's GGUF
  const arch = str(meta["general.architecture"]) ?? "";
  const count = Number(meta["general.base_model.count"] ?? 0);
  const baseModels = Array.from({ length: count }, (_, i) => ({
    name: str(meta[`general.base_model.${i}.name`]),
    organization: str(meta[`general.base_model.${i}.organization`]),
    repoUrl: str(meta[`general.base_model.${i}.repo_url`]),
  }));
  const pooling = meta[`${arch}.pooling_type`];
  const embedding = pooling !== undefined && Number(pooling) !== 0;
  let size = statSync(path).size;
  const shard = basename(path).match(SHARD);
  const shards = [path];
  if (shard) {
    const prefix = basename(path).slice(0, -shard[0].length);
    for (const s of siblings) {
      if (s === basename(path) || !s.startsWith(prefix) || !SHARD.test(s)) continue;
      size += statSync(join(dirname(path), s)).size;
      shards.push(join(dirname(path), s));
    }
  }
  const layers = Number(meta[`${arch}.block_count`]);
  const { mmproj, mtp } = embedding ? { mmproj: null, mtp: null } : companions(root, path);
  const builtInMtp = Number(meta[`${arch}.nextn_predict_layers`] ?? 0) > 0;
  const context = meta[`${arch}.context_length`];
  const recommended = embedding ? undefined : sampling((k) => meta[`general.sampling.${GGUF_SAMPLING[k]}`]);
  return {
    id: relative(root, path).split("\\").join("/"),
    kind: embedding ? "embedding" : "chat",
    server: "llamacpp",
    ...familyParsers(arch, str(meta["general.name"]) ?? basename(path)),
    format: "gguf",
    size,
    identity: {
      basename: str(meta["general.basename"]),
      sizeLabel: str(meta["general.size_label"]),
      finetune: str(meta["general.finetune"]),
      baseModels,
      sourceRepo: str(meta["general.source.huggingface.repository"]) ?? str(meta["general.source.url"]),
    },
    capabilities: { ...templateCapabilities(embedding ? null : str(meta["tokenizer.chat_template"])), vision: !!mmproj, embedding },
    contextLength: context === undefined || context === null ? null : Number(context),
    kvPerToken: kvElements(
      ggufKvLayers(meta, arch),
      Number(meta[`${arch}.embedding_length`]),
      Number(meta[`${arch}.attention.head_count`]),
      Number(meta[`${arch}.attention.head_count_kv`] ?? meta[`${arch}.attention.head_count`]),
      meta[`${arch}.attention.key_length`] === undefined ? undefined : Number(meta[`${arch}.attention.key_length`]),
    ),
    mmproj,
    mtp,
    ...(builtInMtp ? { builtInMtp } : {}),
    ...(mmproj ? { mmprojSize: statSync(join(root, mmproj)).size } : {}),
    ...(mtp ? { mtpSize: statSync(join(root, mtp)).size } : {}),
    ...(recommended ? { sampling: recommended } : {}),
    ...(Number.isInteger(layers) && layers > 0 ? { layers, ...expertsOf(shards, layers) } : {}),
    remoteCode: false,
  };
}

/** The bytes of a mixture of experts' expert weights in each layer, over all its shards: what llama.cpp's n-cpu-moe keeps in system RAM. */
function expertsOf(shards: string[], layers: number): { expertLayers?: number[]; outputBytes?: number } {
  const per = Array.from({ length: layers }, () => 0);
  let output = 0, embed = 0;
  for (const path of shards) {
    try {
      for (const [name, bytes] of Object.entries(readGgufTensorBytes(path))) {
        const m = /^blk\.(\d+)\.ffn_(up|down|gate|gate_up)_exps\./.exec(name);
        if (m && Number(m[1]) < layers) per[Number(m[1])]! += bytes;
        else if (name === "output.weight") output = bytes;
        else if (name === "token_embd.weight") embed = bytes;
      }
    } catch {
      return {};
    }
  }
  return per.some((n) => n > 0) ? { expertLayers: per, ...(output || embed ? { outputBytes: output || embed } : {}) } : {};
}

/**
 * The GGUF's layers that hold a KV cache: all of them, less the linear
 * attention layers of a hybrid (Qwen3.5 and later: one attention layer in
 * every `full_attention_interval`).
 */
function ggufKvLayers(meta: Record<string, GgufValue>, arch: string): number {
  const layers = Number(meta[`${arch}.block_count`]);
  const interval = Number(meta[`${arch}.full_attention_interval`]);
  return Number.isInteger(interval) && interval > 1 ? Math.floor(layers / interval) : layers;
}

/**
 * A config.json's layers that hold a KV cache: `layer_types` counted for
 * attention (not linear attention), else one in every
 * `full_attention_interval`, else `num_hidden_layers`.
 */
export function configKvLayers(text: any): number {
  const layers = text.num_hidden_layers;
  if (Array.isArray(text.layer_types) && text.layer_types.length) {
    return text.layer_types.filter((t: unknown) => typeof t === "string" && /attention/.test(t) && !/linear/.test(t)).length;
  }
  if (Number.isInteger(text.full_attention_interval) && text.full_attention_interval > 1) return Math.floor(layers / text.full_attention_interval);
  return layers;
}

/** 2 × layers × KV heads × head size, or null when the header doesn't say. */
function kvElements(layers: number, width: number, heads: number, kvHeads: number, headDim?: number): number | null {
  const dim = headDim ?? width / heads;
  const n = 2 * layers * kvHeads * dim;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function vllmModel(root: string, dir: string, files: string[]): TextModel | null {
  const config = readJson(join(dir, "config.json"));
  if (!config || !Array.isArray(config.architectures)) return null;
  // A sharded model is offered only once every shard is here (they appear only once checked).
  if (files.includes("model.safetensors.index.json")) {
    const index = readJson(join(dir, "model.safetensors.index.json"));
    const shards = new Set(Object.values(index?.weight_map ?? {}) as string[]);
    if (!shards.size || [...shards].some((f) => !files.includes(f))) return null;
  }
  const size = files.filter((f) => f.endsWith(".safetensors")).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  const tokenizer = readJson(join(dir, "tokenizer_config.json"));
  const template = files.includes("chat_template.jinja") ? readFileSync(join(dir, "chat_template.jinja"), "utf8") : typeof tokenizer?.chat_template === "string" ? tokenizer.chat_template : null;
  const embedding = files.includes("modules.json");
  if (config.architectures.some((a: unknown) => TRANSCRIBE.includes(a as string))) return transcribeModel(root, dir, config, size);
  const text = config.text_config ?? config;
  const parsers = familyParsers(text.model_type ?? config.model_type ?? config.architectures[0] ?? "", basename(dir));
  const caps = templateCapabilities(embedding ? null : template);
  const generation = embedding ? null : readJson(join(dir, "generation_config.json"));
  const recommended = generation ? sampling((k) => generation[CONFIG_SAMPLING[k]]) : undefined;
  return {
    id: relative(root, dir).split("\\").join("/"),
    kind: embedding ? "embedding" : "chat",
    server: "vllm",
    ...parsers,
    format: "safetensors",
    size,
    identity: { basename: basename(dir), sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { ...caps, tools: caps.tools && !!parsers.toolCallParser, vision: !!config.vision_config && !embedding, embedding },
    contextLength: typeof text.max_position_embeddings === "number" ? text.max_position_embeddings : null,
    kvPerToken: kvElements(configKvLayers(text), text.hidden_size, text.num_attention_heads, text.num_key_value_heads ?? text.num_attention_heads, text.head_dim),
    mmproj: null,
    ...(recommended ? { sampling: recommended } : {}),
    remoteCode: !!config.auto_map,
  };
}

/** Architectures vLLM serves on /v1/audio/transcriptions. */
const TRANSCRIBE = ["WhisperForConditionalGeneration", "VoxtralForConditionalGeneration"];

/** Whisper or Voxtral: dictation, on vLLM. Its context is the decoder's, which is short (448 for Whisper). */
function transcribeModel(root: string, dir: string, config: any, size: number): TextModel {
  const text = config.text_config ?? config;
  const context = config.max_target_positions ?? text.max_position_embeddings;
  return {
    id: relative(root, dir).split("\\").join("/"),
    kind: "transcribe",
    server: "vllm",
    format: "safetensors",
    size,
    identity: { basename: basename(dir), sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { tools: false, vision: false, embedding: false, reasoning: null, transcribe: true },
    contextLength: typeof context === "number" ? context : null,
    kvPerToken: config.decoder_layers
      ? kvElements(config.decoder_layers, config.d_model, config.decoder_attention_heads, config.decoder_attention_heads)
      : kvElements(text.num_hidden_layers, text.hidden_size, text.num_attention_heads, text.num_key_value_heads ?? text.num_attention_heads, text.head_dim),
    mmproj: null,
    remoteCode: !!config.auto_map,
  };
}

/** A whisper.cpp model: `ggml-….bin` starting with ggml's magic (0x67676d6c, little-endian). */
export const WHISPER_FILE = /^ggml-[\w.-]+\.bin$/;

function whisperModel(root: string, path: string): TextModel | null {
  const head = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32LE(0) !== 0x67676d6c) return null;
  return {
    id: relative(root, path).split("\\").join("/"),
    kind: "transcribe",
    server: "whispercpp",
    format: "ggml",
    size: statSync(path).size,
    identity: { basename: basename(path, ".bin").slice(5), sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { tools: false, vision: false, embedding: false, reasoning: null, transcribe: true },
    contextLength: null,
    kvPerToken: null,
    mmproj: null,
    remoteCode: false,
  };
}

/** The languages the speech server reads, by a Kokoro voice's first letter (a, b: English; z: Mandarin). */
const VOICE_LANGUAGES: Record<string, Voice["language"]> = { a: "en", b: "en", z: "zh" };

/**
 * A voice model for the speech server (Kokoro's ONNX export): an `.onnx`
 * file, its vocabulary in config.json or tokenizer.json, and voices/*.bin,
 * one raw float32 style table per voice. Voices in other languages are left
 * out. Null if it isn't one.
 */
function speechModel(root: string, dir: string, entries: string[]): TextModel | null {
  const onnxDir = entries.includes("onnx") ? join(dir, "onnx") : dir;
  let onnxFiles: string[] = [];
  let voiceFiles: string[] = [];
  try {
    onnxFiles = readdirSync(onnxDir).filter((f) => f.endsWith(".onnx")).sort();
    voiceFiles = readdirSync(join(dir, "voices")).filter((f) => f.endsWith(".bin")).sort();
  } catch {
    return null;
  }
  // The full-precision export where there are several.
  const file = onnxFiles.includes("model.onnx") ? "model.onnx" : onnxFiles.includes("model_fp16.onnx") ? "model_fp16.onnx" : onnxFiles[0];
  const vocab = readJson(join(dir, "config.json"))?.vocab ?? readJson(join(dir, "tokenizer.json"))?.model?.vocab;
  if (!file || !vocab || typeof vocab !== "object") return null;
  const voices = voiceFiles
    .map((f) => ({ id: f.slice(0, -4), language: VOICE_LANGUAGES[f[0]!] }))
    .filter((v): v is Voice => !!v.language && /^[a-z]{2}_[\w-]+$/.test(v.id));
  if (!voices.length) return null;
  const onnx = relative(dir, join(onnxDir, file)).split("\\").join("/");
  const size = statSync(join(onnxDir, file)).size + voiceFiles.reduce((n, f) => n + statSync(join(dir, "voices", f)).size, 0);
  return {
    id: relative(root, dir).split("\\").join("/"),
    kind: "speak",
    server: "speech",
    format: "onnx",
    size,
    identity: { basename: basename(dir), sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { tools: false, vision: false, embedding: false, reasoning: null, speak: { voices } },
    contextLength: null,
    kvPerToken: null,
    mmproj: null,
    remoteCode: false,
    onnx,
  };
}

/** Every text and speech model under `root`. Unreadable files are skipped. */
export function scanTextModels(root: string): TextModel[] {
  const found: TextModel[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !e.startsWith("."));
    } catch {
      return;
    }
    if (entries.includes("voices") && (entries.includes("onnx") || entries.some((e) => e.endsWith(".onnx")))) {
      const model = speechModel(root, dir, entries);
      if (model) {
        found.push(model);
        return;
      }
    }
    if (entries.includes("config.json") && !entries.includes("model_index.json") && entries.some((e) => e.endsWith(".safetensors"))) {
      const model = vllmModel(root, dir, entries);
      if (model) found.push(model);
      return;
    }
    for (const e of entries.sort()) {
      const path = join(dir, e);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if ((st.isFile() || (st.isSymbolicLink() && existsSync(path) && statSync(path).isFile())) && e.endsWith(".gguf") && !isCompanion(relative(root, path).split("\\").join("/"))) {
        const shard = e.match(SHARD);
        if (shard && shard[1] !== "00001") continue;
        // Split GGUF: only once every part is here.
        if (shard) {
          const prefix = e.slice(0, -shard[0].length);
          const total = Number(shard[2]);
          const present = entries.filter((x) => x.startsWith(prefix) && SHARD.test(x)).length;
          if (present < total) continue;
        }
        try {
          const model = ggufModel(root, path, entries);
          if (model) found.push(model);
        } catch {}
      } else if (st.isFile() && WHISPER_FILE.test(e)) {
        try {
          const model = whisperModel(root, path);
          if (model) found.push(model);
        } catch {}
      }
    }
  };
  walk(root, 0);
  return found;
}
