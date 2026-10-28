// Image model parts: what each file in the models folder is, read from its
// safetensors header (tensor names, shapes and types, never the weights) or
// GGUF metadata. A part has a role, a slot for text encoders, an
// architecture and a precision.
import { closeSync, lstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { readGguf } from "./gguf.ts";

export type Role = "checkpoint" | "diffusion" | "text_encoder" | "vae" | "lora" | "upscaler" | "latent_upscaler" | "unknown";

export interface Part {
  /** Path relative to the models folder. */
  file: string;
  size: number;
  format: "safetensors" | "gguf";
  role: Role;
  /**
   * For text encoders: clip_l, clip_g, t5, umt5, qwen3, qwen2.5vl, qwen3vl (4B), qwen3vl_8b,
   * qwen3vl_32b, gemma4_12b. For a video model's two experts and their LoRAs: high, low (from
   * the file name); a speed LoRA: speed. An audio VAE: audio.
   */
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

const PRECISION: Record<string, string> = { F32: "fp32", BF16: "bf16", F16: "fp16", F8_E4M3: "fp8", F8_E5M2: "fp8", F8_E4M3FN: "fp8", I8: "int8" };

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

  // A video model's two experts (Wan 2.2 14B), and the speed LoRAs made for each, are told apart by name.
  const expert = /high[_-]?noise/.test(name) ? "high" : /low[_-]?noise/.test(name) ? "low" : null;

  if (has(/lora_(up|down|A|B)\b|\.lora_(up|down|A|B)\.|^lora_(unet|te)/)) {
    const slot = expert ?? (/turbo|lightning|lightx2v|\d+[_-]?steps?/.test(name) ? "speed" : null);
    const arch = /minimax[_-]?h3/.test(name) ? "minimax-h3"
      : has(/blocks[._]\d+[._](self|cross)[._]attn[._][qkvo]\b/) ? "wan"
      : has(/double_blocks|single_blocks/) ? "flux"
      : has(/img_mod|txt_mod/) ? "qwen-image"
      : has(/noise_refiner|context_refiner|cap_embedder|layers[._]\d+[._]attention/) ? "z-image"
      : has(/txtfusion|blocks[._]\d+[._]attn[._]w[qkvo]\b/) ? "krea2"
      : has(/input_blocks|down_blocks|lora_te2/) ? "sdxl"
      : null;
    return { role: "lora", slot, arch };
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
  if (hasBare(/^txt_in\.text_norm\.weight$/) && hasBare(/^modulation\.1\.weight$/)) return { role: "diffusion", slot: null, arch: "qwen-image-2.1" };
  if (hasBare(/^cap_embedder\./) && hasBare(/^(noise_refiner|context_refiner)\./)) return { role: "diffusion", slot: null, arch: "z-image" };
  if (hasBare(/^txtfusion\.projector\.weight$/)) return { role: "diffusion", slot: null, arch: "krea2" };
  if (hasBare(/^input_blocks\.0\.0\./) && hasBare(/^label_emb\./)) return { role: "diffusion", slot: null, arch: "sdxl" };
  // Video models, by the keys ComfyUI's model detection reads.
  if (hasBare(/^video_patch_proj\.weight$/) && hasBare(/^audio_patch_proj\.weight$/)) return { role: "diffusion", slot: null, arch: "minimax-h3" };
  if (hasBare(/^adaln_single\.emb\.timestep_embedder\.linear_1\.bias$/) && hasBare(/^audio_adaln_single\.linear\.weight$/)) return { role: "diffusion", slot: null, arch: "ltx2" };
  if (hasBare(/^head\.modulation$/)) {
    // Wan: the 5B takes 48 latent channels; the 14B experts 16 (text to video) or 36 (image to video).
    const patch = Object.entries(shapes).find(([n]) => /(^|\.)patch_embedding\.weight$/.test(n))?.[1];
    const arch = patch?.[1] === 48 ? "wan2.2-5b" : patch?.[1] === 16 ? "wan2.2-t2v-14b" : patch?.[1] === 36 && !hasBare(/^img_emb\./) ? "wan2.2-i2v-14b" : null;
    return arch ? { role: "diffusion", slot: arch.endsWith("14b") ? expert : null, arch } : unknown;
  }

  const clipEmbed = names.find((n) => /text_model\.embeddings\.token_embedding\.weight$/.test(n));
  if (clipEmbed) {
    const width = shapes[clipEmbed]?.[1];
    const slot = width === 768 ? "clip_l" : width === 1280 ? "clip_g" : null;
    return slot ? { role: "text_encoder", slot, arch: slot } : unknown;
  }
  if (has(/encoder\.block\.0\.layer\.0\.SelfAttention\.q\.weight$/)) {
    // UMT5 (Wan's) has T5's layout with a 256k vocabulary.
    const embed = Object.entries(shapes).find(([n]) => /(^|\.)(shared|encoder\.embed_tokens)\.weight$/.test(n))?.[1];
    return (embed?.[0] ?? 0) > 200_000 ? { role: "text_encoder", slot: "umt5", arch: "umt5" } : { role: "text_encoder", slot: "t5", arch: "t5" };
  }
  if (has(/(^|\.)layers\.0\.post_feedforward_layernorm\.weight$/)) {
    // Gemma, which also has Qwen3's q_norm. Gemma 4 12B (LTX-2.5's): 48 layers, and global layers without v_proj.
    const gemma4 = has(/(^|\.)layers\.47\.self_attn\.q_norm\.weight$/) && !has(/(^|\.)layers\.5\.self_attn\.v_proj\.weight$/) && !has(/(^|\.)layers\.59\./);
    return gemma4 ? { role: "text_encoder", slot: "gemma4_12b", arch: "gemma4" } : unknown;
  }
  if (has(/(^|\.)layers\.0\.self_attn\.q_proj\.weight$/)) {
    // Qwen3-VL 32B (MiniMax H3's), by its 64 layers: quantized weights don't keep their shapes.
    if (has(/(^|\.)layers\.63\.self_attn\./)) return { role: "text_encoder", slot: "qwen3vl_32b", arch: "qwen3vl" };
    // Qwen3-VL 4B (Krea 2's) and 8B (Qwen-Image 2.1's), told apart by the merger's width.
    const merger = names.find((n) => /(^|\.)visual\.merger\.linear_fc2\.weight$/.test(n));
    if (merger) return shapes[merger]?.[0] === 4096 ? { role: "text_encoder", slot: "qwen3vl_8b", arch: "qwen3vl" } : { role: "text_encoder", slot: "qwen3vl", arch: "qwen3vl" };
    if (has(/(^|\.)visual\.blocks\.0\./)) return { role: "text_encoder", slot: "qwen2.5vl", arch: "qwen2.5vl" };
    if (has(/(^|\.)layers\.0\.self_attn\.q_norm\.weight$/)) return { role: "text_encoder", slot: "qwen3", arch: "qwen3" };
  }

  // Video VAEs, by the keys ComfyUI's VAE loader reads; an audio VAE takes the audio slot.
  if (has(/^decoder\.transformer_blocks\.0\.scale1$/) && has(/^encoder\.down\.5\.block\.0\.conv1\.weight$/)) return { role: "vae", slot: null, arch: "minimax-h3" };
  if (has(/^pre_block\.attn\.zero_k_bias$/)) return { role: "vae", slot: "audio", arch: "minimax-h3" };
  if (has(/^decoder\.up_blocks\.0\.res_blocks\.0\.conv1\.conv\.weight$/) || has(/^decoder\.conv_in_x_t\.weight$/)) return { role: "vae", slot: null, arch: "ltx2" };
  if (has(/^(vocoder\.)?vocoder\.resblocks\.0\.convs1\.0\.weight$/)) return { role: "vae", slot: "audio", arch: "ltx2" };
  // LTX-2's latent upscaler.
  if (/latent[_-]?(spatial[_-]?)?upscaler/.test(name)) return { role: "latent_upscaler", slot: null, arch: "ltx2" };
  if (has(/^decoder\.conv_in\.weight$/) && has(/^encoder\.conv_in\.weight$/)) {
    const channels = shapes["decoder.conv_in.weight"]?.[1];
    return { role: "vae", slot: null, arch: channels === 4 ? "sdxl" : channels === 16 ? "flux" : null };
  }
  if (has(/^decoder\.conv1\.weight$/) && has(/^encoder\.conv1\.weight$/)) {
    // Wan 2.1's layout is Qwen-Image's (and Wan 2.2 14B's VAE); Wan 2.2's with 48 latent channels is the 5B's,
    // and with a flat (2D) head Qwen-Image 2.1's.
    if (!has(/^decoder\.upsamples\.0\.upsamples\./)) return { role: "vae", slot: null, arch: "qwen-image" };
    if (shapes["decoder.conv1.weight"]?.[1] === 48) return { role: "vae", slot: null, arch: "wan2.2" };
    const head = shapes["decoder.head.2.weight"];
    return { role: "vae", slot: null, arch: head?.length === 5 && head[2] === 1 ? "qwen-image-2.1" : null };
  }
  return unknown;
}

const GGUF_ARCH: Record<string, Kind> = {
  flux: { role: "diffusion", slot: null, arch: "flux" },
  krea2: { role: "diffusion", slot: null, arch: "krea2" },
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
    // A text model, except Qwen3-VL 4B, which is also Krea 2's text encoder.
    const vl4b = meta["general.architecture"] === "qwen3vl" && Number(meta["qwen3vl.embedding_length"]) === 2560;
    if (meta["tokenizer.ggml.model"] !== undefined && !vl4b) return null;
    const kind: Kind = vl4b ? { role: "text_encoder", slot: "qwen3vl", arch: "qwen3vl" } : /seedvr2/i.test(basename(path)) ? classify([], {}, path) : GGUF_ARCH[String(meta["general.architecture"])] ?? unknown;
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
