// Image model parts: what each file in the models folder is, read from its
// safetensors header (tensor names, shapes and types, never the weights) or
// GGUF metadata. A part has a role, a slot for text encoders, an
// architecture and a precision.
import { closeSync, lstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { readGguf } from "./gguf.ts";

export type Role = "checkpoint" | "diffusion" | "text_encoder" | "vae" | "lora" | "upscaler" | "unknown";

export interface Part {
  /** Path relative to the models folder. */
  file: string;
  size: number;
  format: "safetensors" | "gguf";
  role: Role;
  /** For text encoders: clip_l, clip_g, t5, qwen3, qwen2.5vl. */
  slot: string | null;
  /** The architecture it belongs to; for text encoders, the encoder's own (same as the slot). */
  arch: string | null;
  precision: string | null;
}

interface Tensor {
  dtype: string;
  shape: number[];
}

/** The tensors listed in a safetensors header. */
export function readSafetensorsHeader(path: string): Record<string, Tensor> {
  const fd = openSync(path, "r");
  try {
    const len = Buffer.alloc(8);
    if (readSync(fd, len, 0, 8, 0) !== 8) throw new Error("too short");
    const n = Number(len.readBigUInt64LE());
    if (n <= 0 || n > 100 * 1024 * 1024) throw new Error("bad safetensors header");
    const buf = Buffer.alloc(n);
    if (readSync(fd, buf, 0, n, 8) !== n) throw new Error("too short");
    const header = JSON.parse(buf.toString("utf8"));
    delete header.__metadata__;
    return header;
  } finally {
    closeSync(fd);
  }
}

const PRECISION: Record<string, string> = { F32: "fp32", BF16: "bf16", F16: "fp16", F8_E4M3: "fp8", F8_E5M2: "fp8", F8_E4M3FN: "fp8" };

function precisionOf(tensors: Tensor[]): string | null {
  const count = new Map<string, number>();
  for (const t of tensors) {
    const p = PRECISION[t.dtype] ?? t.dtype.toLowerCase();
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [p, n] of count) if (best === null || n > count.get(best)!) best = p;
  return best;
}

type Kind = Pick<Part, "role" | "slot" | "arch">;
const unknown: Kind = { role: "unknown", slot: null, arch: null };

/** What a set of tensor names (and the file's name) is. */
export function classify(names: string[], shapes: Record<string, number[]>, file: string): Kind {
  const has = (re: RegExp) => names.some((n) => re.test(n));
  const name = basename(file).toLowerCase();

  // SeedVR2 ships its own file names; its loaders find them by name.
  if (/seedvr2/.test(name)) return { role: "upscaler", slot: null, arch: "seedvr2" };
  if (/^ema_vae/.test(name)) return { role: "vae", slot: null, arch: "seedvr2" };

  if (has(/lora_(up|down|A|B)\b|\.lora_(up|down|A|B)\.|^lora_(unet|te)/)) {
    const arch = has(/double_blocks|single_blocks/) ? "flux"
      : has(/img_mod|txt_mod/) ? "qwen-image"
      : has(/noise_refiner|context_refiner|cap_embedder|layers[._]\d+[._]attention/) ? "z-image"
      : has(/input_blocks|down_blocks|lora_te2/) ? "sdxl"
      : null;
    return { role: "lora", slot: null, arch };
  }

  const dm = "model.diffusion_model.";
  if (has(/^model\.diffusion_model\./) && has(/^(first_stage_model|vae)\./)) {
    if (has(/^conditioner\.embedders\.1\./)) return { role: "checkpoint", slot: null, arch: "sdxl" };
    if (has(/^model\.diffusion_model\.double_blocks\./)) return { role: "checkpoint", slot: null, arch: "flux" };
    if (has(/^cond_stage_model\./)) return { role: "checkpoint", slot: null, arch: "sd15" };
    return { role: "checkpoint", slot: null, arch: null };
  }

  const bare = names.map((n) => (n.startsWith(dm) ? n.slice(dm.length) : n));
  const hasBare = (re: RegExp) => bare.some((n) => re.test(n));
  if (hasBare(/^double_blocks\.0\.img_attn/) && hasBare(/^single_blocks\./)) return { role: "diffusion", slot: null, arch: "flux" };
  if (hasBare(/^transformer_blocks\.0\.img_mod/) && hasBare(/^txt_norm\./)) return { role: "diffusion", slot: null, arch: "qwen-image" };
  if (hasBare(/^cap_embedder\./) && hasBare(/^(noise_refiner|context_refiner)\./)) return { role: "diffusion", slot: null, arch: "z-image" };
  if (hasBare(/^input_blocks\.0\.0\./) && hasBare(/^label_emb\./)) return { role: "diffusion", slot: null, arch: "sdxl" };

  const clipEmbed = names.find((n) => /text_model\.embeddings\.token_embedding\.weight$/.test(n));
  if (clipEmbed) {
    const width = shapes[clipEmbed]?.[1];
    const slot = width === 768 ? "clip_l" : width === 1280 ? "clip_g" : null;
    return slot ? { role: "text_encoder", slot, arch: slot } : unknown;
  }
  if (has(/encoder\.block\.0\.layer\.0\.SelfAttention\.q\.weight$/)) return { role: "text_encoder", slot: "t5", arch: "t5" };
  if (has(/(^|\.)layers\.0\.self_attn\.q_proj\.weight$/)) {
    if (has(/(^|\.)visual\.blocks\.0\./)) return { role: "text_encoder", slot: "qwen2.5vl", arch: "qwen2.5vl" };
    if (has(/(^|\.)layers\.0\.self_attn\.q_norm\.weight$/)) return { role: "text_encoder", slot: "qwen3", arch: "qwen3" };
  }

  if (has(/^decoder\.conv_in\.weight$/) && has(/^encoder\.conv_in\.weight$/)) {
    const channels = shapes["decoder.conv_in.weight"]?.[1];
    return { role: "vae", slot: null, arch: channels === 4 ? "sdxl" : channels === 16 ? "flux" : null };
  }
  if (has(/^decoder\.conv1\.weight$/) && has(/^encoder\.conv1\.weight$/)) return { role: "vae", slot: null, arch: "qwen-image" };
  return unknown;
}

const GGUF_ARCH: Record<string, Kind> = {
  flux: { role: "diffusion", slot: null, arch: "flux" },
  lumina2: { role: "diffusion", slot: null, arch: "z-image" },
  qwen_image: { role: "diffusion", slot: null, arch: "qwen-image" },
  sdxl: { role: "diffusion", slot: null, arch: "sdxl" },
  t5encoder: { role: "text_encoder", slot: "t5", arch: "t5" },
};
const GGUF_TYPES: Record<number, string> = {
  0: "fp32", 1: "fp16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M",
  13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 32: "bf16",
};

function readPart(root: string, path: string): Part | null {
  const file = relative(root, path).split("\\").join("/");
  const size = statSync(path).size;
  if (path.endsWith(".gguf")) {
    const meta = readGguf(path);
    if (meta["tokenizer.ggml.model"] !== undefined) return null; // a text model
    const kind = /seedvr2/i.test(basename(path)) ? classify([], {}, path) : GGUF_ARCH[String(meta["general.architecture"])] ?? unknown;
    const ft = meta["general.file_type"];
    return { file, size, format: "gguf", ...kind, precision: ft === undefined ? "gguf" : GGUF_TYPES[Number(ft)] ?? "gguf" };
  }
  const header = readSafetensorsHeader(path);
  const names = Object.keys(header);
  const shapes = Object.fromEntries(names.map((n) => [n, header[n]!.shape]));
  return { file, size, format: "safetensors", ...classify(names, shapes, path), precision: precisionOf(Object.values(header)) };
}

const cache = new Map<string, { key: string; part: Part | null }>();

/** Every image part under `root`, skipping text-model folders (vLLM's) and hidden files. */
export function scanParts(root: string): Part[] {
  const parts: Part[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !e.startsWith("."));
    } catch {
      return;
    }
    if (entries.includes("config.json") && !entries.includes("model_index.json") && entries.some((e) => e.endsWith(".safetensors"))) return;
    for (const e of entries.sort()) {
      const path = join(dir, e);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (st.isFile() && (e.endsWith(".safetensors") || e.endsWith(".gguf")) && !e.toLowerCase().startsWith("mmproj")) {
        const key = `${st.size}:${st.mtimeMs}`;
        let hit = cache.get(path);
        if (!hit || hit.key !== key) {
          let part: Part | null = null;
          try {
            part = readPart(root, path);
          } catch {}
          hit = { key, part };
          cache.set(path, hit);
        }
        if (hit.part) parts.push(hit.part);
      }
    }
  };
  walk(root, 0);
  return parts;
}
