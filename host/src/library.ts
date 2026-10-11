// The text and speech models in the models folder: GGUF files for llama.cpp,
// safetensors folders for vLLM (Whisper and Voxtral among them, for
// dictation), and ONNX voice models for the speech server. Reads headers only.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readGguf, type GgufValue } from "./gguf.ts";

export interface Identity {
  basename: string | null;
  sizeLabel: string | null;
  finetune: string | null;
  baseModels: { name: string | null; organization: string | null; repoUrl: string | null }[];
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  embedding: boolean;
  reasoning: string[] | null;
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
  server: "llamacpp" | "vllm" | "comfyui" | "speech";
  format: "gguf" | "safetensors" | "onnx";
  size: number;
  identity: Identity;
  capabilities: Capabilities;
  /** The longest context the model was trained for, if known. */
  contextLength: number | null;
  /** KV-cache elements per token (keys and values, all layers), to size the cache; null if unknown. */
  kvPerToken: number | null;
  /** A vision projector next to a GGUF model, relative like `id`. */
  mmproj: string | null;
  /** A vLLM model whose config asks for remote code: never loaded. */
  remoteCode: boolean;
  /** A speech model's ONNX file, relative to its folder. */
  onnx?: string;
}

const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/;

function str(v: GgufValue | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

function templateCapabilities(template: string | null): Pick<Capabilities, "tools" | "reasoning"> {
  return {
    tools: !!template && /\btools\b/.test(template),
    reasoning: template && /enable_thinking|<think>/.test(template) ? ["off", "on"] : null,
  };
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
  if (shard) {
    const prefix = basename(path).slice(0, -shard[0].length);
    for (const s of siblings) if (s !== basename(path) && s.startsWith(prefix) && SHARD.test(s)) size += statSync(join(dirname(path), s)).size;
  }
  const mmproj = siblings.find((s) => s.toLowerCase().startsWith("mmproj") && s.endsWith(".gguf"));
  const context = meta[`${arch}.context_length`];
  return {
    id: relative(root, path).split("\\").join("/"),
    kind: embedding ? "embedding" : "chat",
    server: "llamacpp",
    format: "gguf",
    size,
    identity: {
      basename: str(meta["general.basename"]),
      sizeLabel: str(meta["general.size_label"]),
      finetune: str(meta["general.finetune"]),
      baseModels,
    },
    capabilities: { ...templateCapabilities(embedding ? null : str(meta["tokenizer.chat_template"])), vision: !!mmproj && !embedding, embedding },
    contextLength: context === undefined || context === null ? null : Number(context),
    kvPerToken: kvElements(
      Number(meta[`${arch}.block_count`]),
      Number(meta[`${arch}.embedding_length`]),
      Number(meta[`${arch}.attention.head_count`]),
      Number(meta[`${arch}.attention.head_count_kv`] ?? meta[`${arch}.attention.head_count`]),
    ),
    mmproj: mmproj ? relative(root, join(dirname(path), mmproj)).split("\\").join("/") : null,
    remoteCode: false,
  };
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
  return {
    id: relative(root, dir).split("\\").join("/"),
    kind: embedding ? "embedding" : "chat",
    server: "vllm",
    format: "safetensors",
    size,
    identity: { basename: basename(dir), sizeLabel: null, finetune: null, baseModels: [] },
    capabilities: { ...templateCapabilities(embedding ? null : template), vision: !!config.vision_config && !embedding, embedding },
    contextLength: typeof text.max_position_embeddings === "number" ? text.max_position_embeddings : null,
    kvPerToken: kvElements(text.num_hidden_layers, text.hidden_size, text.num_attention_heads, text.num_key_value_heads ?? text.num_attention_heads, text.head_dim),
    mmproj: null,
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
      else if ((st.isFile() || (st.isSymbolicLink() && existsSync(path) && statSync(path).isFile())) && e.endsWith(".gguf") && !e.toLowerCase().startsWith("mmproj")) {
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
      }
    }
  };
  walk(root, 0);
  return found;
}
