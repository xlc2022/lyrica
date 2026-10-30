import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Comfy, ComfyGpus, mp4Seconds, mp4Video, samplingProgress } from "../src/comfy.ts";
import { clipPlan, Images, inputImage, recipeSize, videoValues } from "../src/images.ts";
import { ggufBytes } from "../src/gguf.ts";
import { scanParts } from "../src/parts.ts";
import { present, RecipeBook, loadStarters, type Recipe } from "../src/recipes.ts";
import { Runtime } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fill, loadTemplates } from "../src/templates.ts";
import { SdCpp, sdcppArgs, sdcppJob } from "../src/sdcpp.ts";
import { FakeBackend, FakeGpus, MP4, PNG, fakeComfy, fakeSdServer, safetensors } from "./fakes.ts";
import { call, lyrica, pair, startHost } from "./helpers.ts";

const host = new URL("..", import.meta.url).pathname;
const TEMPLATES = loadTemplates(new URL("../workflows/", import.meta.url).pathname);
const STARTERS = loadStarters(new URL("../recipes/", import.meta.url).pathname);
const MARKER = "violet-anchovy-5531";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

// Headers that look like each kind of part.
const Z_DIFFUSION = safetensors({ "cap_embedder.0.weight": {}, "noise_refiner.0.attention.qkv.weight": {}, "layers.0.attention.qkv.weight": {} });
const QWEN3 = safetensors({ "model.layers.0.self_attn.q_proj.weight": {}, "model.layers.0.self_attn.q_norm.weight": {} });
const QWEN25VL = safetensors({ "model.layers.0.self_attn.q_proj.weight": {}, "visual.blocks.0.attn.qkv.weight": {} });
const KREA2_DIFFUSION = safetensors({ "txtfusion.projector.weight": {}, "first.weight": {}, "blocks.0.attn.wq.weight": {} });
const QWEN3VL = safetensors({ "model.language_model.layers.0.self_attn.q_proj.weight": {}, "model.language_model.layers.0.self_attn.q_norm.weight": {}, "model.visual.blocks.0.attn.qkv.weight": {}, "model.visual.merger.linear_fc2.weight": {} });
const QWEN3VL_8B = safetensors({ "model.language_model.layers.0.self_attn.q_proj.weight": { dtype: "I8" }, "model.visual.merger.linear_fc2.weight": { shape: [4096, 4608], dtype: "I8" } });
const QI21_DIFFUSION = safetensors({ "txt_in.text_norm.weight": {}, "modulation.1.weight": {}, "transformer_blocks.0.attn.norm_q.weight": {}, "img_in.weight": {}, "transformer_blocks.0.img_mlp.gate_up.weight": {} });
const QWEN_VAE = safetensors({ "decoder.conv1.weight": {}, "encoder.conv1.weight": {}, "decoder.upsamples.0.residual.0.gamma": {}, "decoder.head.2.weight": { shape: [3, 96, 3, 3, 3] } });
const QI21_VAE = safetensors({ "decoder.conv1.weight": {}, "encoder.conv1.weight": {}, "decoder.upsamples.0.upsamples.0.residual.2.weight": {}, "decoder.head.2.weight": { shape: [4, 256, 1, 3, 3] } });
const KREA2_LORA = safetensors({ "diffusion_model.blocks.0.attn.wq.lora_A.weight": {}, "diffusion_model.blocks.0.attn.wq.lora_B.weight": {} });
const FLUX_VAE = safetensors({ "decoder.conv_in.weight": { shape: [512, 16, 3, 3] }, "encoder.conv_in.weight": { shape: [128, 3, 3, 3] } });
const SDXL_VAE = safetensors({ "decoder.conv_in.weight": { shape: [512, 4, 3, 3] }, "encoder.conv_in.weight": { shape: [128, 3, 3, 3] } });
const Z_LORA = safetensors({ "diffusion_model.layers.0.attention.qkv.lora_A.weight": {}, "diffusion_model.layers.0.attention.qkv.lora_B.weight": {} });
const FLUX_CKPT = safetensors({ "model.diffusion_model.double_blocks.0.img_attn.qkv.weight": {}, "vae.decoder.conv_in.weight": {}, "text_encoders.t5xxl.x": {} });
const SD15_CKPT = safetensors({ "model.diffusion_model.input_blocks.0.0.weight": {}, "first_stage_model.decoder.conv_in.weight": {}, "cond_stage_model.transformer.x": {} });
const CLIP_L = safetensors({ "text_model.embeddings.token_embedding.weight": { shape: [49408, 768], dtype: "F16" } });
const T5 = safetensors({ "encoder.block.0.layer.0.SelfAttention.q.weight": { dtype: "F8_E4M3" } });
// Video parts, by the keys ComfyUI's own detection reads.
const wan = (channels: number, dim: number) => safetensors({ "head.modulation": { shape: [1, 6, dim] }, "patch_embedding.weight": { shape: [dim, channels, 1, 2, 2] }, "blocks.0.ffn.0.weight": {} });
const WAN_5B = wan(48, 3072);
const WAN_T2V = wan(16, 5120);
const WAN_I2V = wan(36, 5120);
// Wan GGUF experts. QuantStack's carry three keys of metadata and the 5-D patch embedding as it is;
// ComfyUI-GGUF's converter flattens it to fit four dimensions and records its true shape.
const WAN_GGUF_META = { "general.architecture": "wan", "general.quantization_version": 2, "general.file_type": 17 };
const wanGguf = (channels: number, flattened = false) => ggufBytes(
  flattened ? { ...WAN_GGUF_META, "comfy.gguf.orig_shape.patch_embedding.weight": [5120, channels, 1, 2, 2] } : WAN_GGUF_META,
  { "head.modulation": [1, 6, 5120], "patch_embedding.weight": flattened ? [5120 * channels * 2, 2] : [5120, channels, 1, 2, 2], "blocks.0.ffn.0.weight": [13824, 5120] });
// SCAIL-2 is Wan 2.1 I2V 14B with pose and mask patch embeddings; it needs CLIP ViT-H's image half and SAM 3.1.
const SCAIL2 = safetensors({ "head.modulation": { shape: [1, 6, 5120] }, "patch_embedding.weight": { shape: [5120, 20, 1, 2, 2] }, "patch_embedding_pose.weight": { shape: [5120, 20, 1, 2, 2] }, "img_emb.proj.0.weight": {} });
const CLIP_VISION_H = safetensors({ "vision_model.embeddings.patch_embedding.weight": {}, "vision_model.encoder.layers.0.self_attn.q_proj.weight": {}, "vision_model.encoder.layers.31.self_attn.q_proj.weight": {}, "visual_projection.weight": {} });
const SAM3 = safetensors({ "detector.backbone.language_backbone.encoder.ln_final.weight": {}, "detector.transformer.x": {}, "tracker.model.x": {} });
/** An MP4's top-level boxes as a clip of `seconds` has them: ftyp, mdat, then moov with its movie header (version 0 or 1). */
function mp4(seconds: number, version: 0 | 1 = 0): Buffer {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };
  const mvhd = Buffer.alloc(version ? 112 : 100);
  mvhd[0] = version;
  if (version) {
    mvhd.writeUInt32BE(1000, 20);
    mvhd.writeBigUInt64BE(BigInt(seconds * 1000), 24);
  } else {
    mvhd.writeUInt32BE(600, 12);
    mvhd.writeUInt32BE(seconds * 600, 16);
  }
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\x02\0", "latin1")), box("mdat", Buffer.alloc(64)), box("moov", box("mvhd", mvhd))]);
}
/** A clip with a video track: its size, frame count and frame rate in tkhd, mdhd and stts, as an encoder writes them. */
function clip(width: number, height: number, frames: number, fps: number): Buffer {
  const box = (type: string, ...body: Buffer[]) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.reduce((n, b) => n + b.length, 0), 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, ...body]);
  };
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(width << 16, 76);
  tkhd.writeUInt32BE(height << 16, 80);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(fps * 512, 12);
  mdhd.writeUInt32BE(frames * 512, 16);
  const hdlr = (kind: string) => { const b = Buffer.alloc(24); b.write(kind, 8, "latin1"); return b; };
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(frames, 8);
  stts.writeUInt32BE(512, 12);
  const sound = box("trak", box("tkhd", Buffer.alloc(84)), box("mdia", box("mdhd", Buffer.alloc(24)), box("hdlr", hdlr("soun"))));
  const video = box("trak", box("tkhd", tkhd), box("mdia", box("mdhd", mdhd), box("hdlr", hdlr("vide")), box("minf", box("stbl", box("stts", stts)))));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(600, 12);
  mvhd.writeUInt32BE(Math.round(frames / fps * 600), 16);
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\x02\0", "latin1")), box("moov", box("mvhd", mvhd), sound, video)]);
}
// Comfy-Org's RIFE 4.26 for ComfyUI's own frame interpolation nodes.
const RIFE = safetensors({ "blocks.0.conv0.0.0.weight": {}, "blocks.0.lastconv.0.weight": {}, "encode.cnn0.weight": {}, "encode.cnn3.weight": { shape: [16, 4, 4, 4] } });
const WAN_LORA = safetensors({ "diffusion_model.blocks.0.cross_attn.k.lora_A.weight": {}, "diffusion_model.blocks.0.cross_attn.k.lora_B.weight": {} });
const UMT5 = safetensors({ "encoder.block.0.layer.0.SelfAttention.q.weight": { dtype: "F8_E4M3" }, "shared.weight": { shape: [256384, 4096] } });
const WAN22_VAE = safetensors({ "decoder.conv1.weight": { shape: [1024, 48, 3, 3, 3] }, "encoder.conv1.weight": {}, "decoder.upsamples.0.upsamples.0.residual.2.weight": {} });
const LTX2 = safetensors({ "model.diffusion_model.adaln_single.emb.timestep_embedder.linear_1.bias": {}, "model.diffusion_model.audio_adaln_single.linear.weight": {} });
const GEMMA4_12B = safetensors({ "model.layers.0.post_feedforward_layernorm.weight": {}, "model.layers.0.self_attn.q_proj.weight": { dtype: "I8" }, "model.layers.47.self_attn.q_norm.weight": {} });
const LTX2_VAE = safetensors({ "decoder.up_blocks.0.res_blocks.0.conv1.conv.weight": {}, "encoder.conv_in.conv.weight": {} });
const LTX2_AUDIO_VAE = safetensors({ "vocoder.resblocks.0.convs1.0.weight": {}, "decoder.conv_in.weight": {} });
const H3 = safetensors({ "video_patch_proj.weight": { dtype: "I8" }, "audio_patch_proj.weight": {}, "blocks.0.attn.to_q.weight": {} });
const H3_LORA = safetensors({ "diffusion_model.blocks.0.attn.to_q.lora_A.weight": {}, "diffusion_model.blocks.0.attn.to_q.lora_B.weight": {} });
const QWEN3VL_32B = safetensors({ "model.language_model.layers.0.self_attn.q_proj.weight": { dtype: "U8" }, "model.language_model.layers.0.self_attn.q_norm.weight": {}, "model.language_model.layers.63.self_attn.q_proj.weight": { dtype: "U8" } });
const H3_VAE = safetensors({ "decoder.transformer_blocks.0.scale1": {}, "encoder.down.5.block.0.conv1.weight": { dtype: "I8" } });
const H3_AUDIO_VAE = safetensors({ "pre_block.attn.zero_k_bias": { dtype: "F32" } });

function folder(files: Record<string, Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-img-"));
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}

const Z = "lyrica/huggingface/Comfy-Org/z_image_turbo/split_files";

describe("parts", () => {
  it("tells each part's role, slot, architecture and precision from its header", () => {
    const dir = folder({
      "a/z.safetensors": Z_DIFFUSION, "a/qwen3.safetensors": QWEN3, "a/qwen25vl.safetensors": QWEN25VL, "a/ae.safetensors": FLUX_VAE,
      "a/sdxl_vae.safetensors": SDXL_VAE, "a/style.safetensors": Z_LORA, "a/flux-ckpt.safetensors": FLUX_CKPT, "a/clip_l.safetensors": CLIP_L,
      "a/t5.safetensors": T5, "a/seedvr2_ema_3b_fp16.safetensors": safetensors({ x: { dtype: "F16" } }), "a/ema_vae_fp16.safetensors": safetensors({ y: {} }),
      "a/krea2.safetensors": KREA2_DIFFUSION, "a/qwen3vl.safetensors": QWEN3VL, "a/krea2-style.safetensors": KREA2_LORA,
      "a/qi21.safetensors": QI21_DIFFUSION, "a/qwen3vl-8b.safetensors": QWEN3VL_8B, "a/qwen_vae.safetensors": QWEN_VAE, "a/qi21_vae.safetensors": QI21_VAE,
      "a/krea2-q5.gguf": ggufBytes({ "general.architecture": "krea2", "general.file_type": 16 }),
      "a/qwen3vl-4b.gguf": ggufBytes({ "general.architecture": "qwen3vl", "qwen3vl.embedding_length": 2560, "tokenizer.ggml.model": "gpt2", "general.file_type": 7 }),
      "a/qwen3vl-8b.gguf": ggufBytes({ "general.architecture": "qwen3vl", "qwen3vl.embedding_length": 4096, "tokenizer.ggml.model": "gpt2" }),
    });
    const got = Object.fromEntries(scanParts(dir).map((p) => [p.file.slice(2), [p.role, p.slot, p.arch, p.precision]]));
    expect(got).toEqual({
      "ae.safetensors": ["vae", null, "flux", "bf16"],
      "clip_l.safetensors": ["text_encoder", "clip_l", "clip_l", "fp16"],
      "ema_vae_fp16.safetensors": ["vae", null, "seedvr2", "bf16"],
      "flux-ckpt.safetensors": ["checkpoint", null, "flux", "bf16"],
      "qwen25vl.safetensors": ["text_encoder", "qwen2.5vl", "qwen2.5vl", "bf16"],
      "qwen3.safetensors": ["text_encoder", "qwen3", "qwen3", "bf16"],
      "sdxl_vae.safetensors": ["vae", null, "sdxl", "bf16"],
      "seedvr2_ema_3b_fp16.safetensors": ["upscaler", null, "seedvr2", "fp16"],
      "style.safetensors": ["lora", null, "z-image", "bf16"],
      "t5.safetensors": ["text_encoder", "t5", "t5", "fp8"],
      "krea2.safetensors": ["diffusion", null, "krea2", "bf16"],
      "qwen3vl.safetensors": ["text_encoder", "qwen3vl", "qwen3vl", "bf16"],
      "krea2-style.safetensors": ["lora", null, "krea2", "bf16"],
      "krea2-q5.gguf": ["diffusion", null, "krea2", "Q5_K_S"],
      "qi21.safetensors": ["diffusion", null, "qwen-image-2.1", "bf16"],
      // Qwen-Image 2.1's encoder is the 8B, apart from Krea 2's 4B.
      "qwen3vl-8b.safetensors": ["text_encoder", "qwen3vl_8b", "qwen3vl", "int8"],
      "qwen_vae.safetensors": ["vae", null, "qwen-image", "bf16"],
      "qi21_vae.safetensors": ["vae", null, "qwen-image-2.1", "bf16"],
      // Qwen3-VL 4B is Krea 2's encoder; other text models aren't image parts.
      "qwen3vl-4b.gguf": ["text_encoder", "qwen3vl", "qwen3vl", "Q8_0"],
      "z.safetensors": ["diffusion", null, "z-image", "bf16"],
    });
  });
});

describe("video parts", () => {
  it("tells video models, their experts, encoders and audio VAEs apart, so no image recipe takes them", () => {
    const dir = folder({
      "v/wan2.2_ti2v_5B_fp16.safetensors": WAN_5B, "v/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors": WAN_T2V,
      "v/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors": WAN_T2V, "v/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": WAN_I2V,
      "v/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors": WAN_LORA, "v/umt5_xxl_fp8_e4m3fn_scaled.safetensors": UMT5,
      "v/wan2.2_vae.safetensors": WAN22_VAE, "v/wan_2.1_vae.safetensors": QWEN_VAE,
      "v/ltx-2.5-22b-distilled.safetensors": LTX2, "v/gemma4-12b-with-proj.safetensors": GEMMA4_12B, "v/ltx-2.5-video-vae-bf16.safetensors": LTX2_VAE,
      "v/ltx-2.5-audio-vae-bf16.safetensors": LTX2_AUDIO_VAE, "v/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors": safetensors({ "res_blocks.0.conv1.weight": {} }),
      "v/minimax_h3_fl2va_pruned_int8_convrot.safetensors": H3, "v/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": H3_LORA,
      "v/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": QWEN3VL_32B, "v/minimax_h3_video_vae_int8_convrot.safetensors": H3_VAE,
      "v/minimax_h3_audio_vae_fp32.safetensors": H3_AUDIO_VAE, "v/rife_v4.26.safetensors": RIFE,
      "v/Wan2.2-T2V-A14B-HighNoise-Q5_K_M.gguf": wanGguf(16), "v/Wan2.2-I2V-A14B-LowNoise-Q5_K_M.gguf": wanGguf(36, true),
      "v/wan2.1_14B_SCAIL_2_int8_convrot.safetensors": SCAIL2, "v/wan2.1_SCAIL_2_DPO_lora_bf16.safetensors": WAN_LORA,
      "v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors": WAN_LORA, "v/clip_vision_h.safetensors": CLIP_VISION_H,
      "v/sam3.1_multiplex_fp16.safetensors": SAM3,
    });
    const got = Object.fromEntries(scanParts(dir).map((p) => [p.file.slice(2), [p.role, p.slot, p.arch]]));
    expect(got).toEqual({
      "wan2.2_ti2v_5B_fp16.safetensors": ["diffusion", null, "wan2.2-5b"],
      // The 14B's two experts share their layout, so the name says which is which.
      "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors": ["diffusion", "high", "wan2.2-t2v-14b"],
      "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors": ["diffusion", "low", "wan2.2-t2v-14b"],
      "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": ["diffusion", "high", "wan2.2-i2v-14b"],
      "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors": ["lora", "high", "wan"],
      // UMT5 isn't FLUX's T5, Gemma 4 isn't Qwen3, and the 32B isn't Krea 2's Qwen3-VL.
      "umt5_xxl_fp8_e4m3fn_scaled.safetensors": ["text_encoder", "umt5", "umt5"],
      "gemma4-12b-with-proj.safetensors": ["text_encoder", "gemma4_12b", "gemma4"],
      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": ["text_encoder", "qwen3vl_32b", "qwen3vl"],
      "wan2.2_vae.safetensors": ["vae", null, "wan2.2"],
      "wan_2.1_vae.safetensors": ["vae", null, "qwen-image"],
      "rife_v4.26.safetensors": ["interpolator", null, "rife"],
      "ltx-2.5-22b-distilled.safetensors": ["diffusion", null, "ltx2"],
      "ltx-2.5-video-vae-bf16.safetensors": ["vae", null, "ltx2"],
      "ltx-2.5-audio-vae-bf16.safetensors": ["vae", "audio", "ltx2"],
      "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors": ["latent_upscaler", null, "ltx2"],
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors": ["diffusion", null, "minimax-h3"],
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": ["lora", "speed", "minimax-h3"],
      "minimax_h3_video_vae_int8_convrot.safetensors": ["vae", null, "minimax-h3"],
      "minimax_h3_audio_vae_fp32.safetensors": ["vae", "audio", "minimax-h3"],
      // A GGUF expert is told by the same tensors.
      "Wan2.2-T2V-A14B-HighNoise-Q5_K_M.gguf": ["diffusion", "high", "wan2.2-t2v-14b"],
      "Wan2.2-I2V-A14B-LowNoise-Q5_K_M.gguf": ["diffusion", "low", "wan2.2-i2v-14b"],
      // SCAIL-2 by its pose embedding, not as a Wan I2V model; CLIP ViT-H's image half isn't a text encoder.
      "wan2.1_14B_SCAIL_2_int8_convrot.safetensors": ["diffusion", null, "scail2"],
      "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors": ["lora", "dpo", "wan"],
      "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors": ["lora", "speed", "wan"],
      "clip_vision_h.safetensors": ["clip_vision", null, "clip-vision-h"],
      "sam3.1_multiplex_fp16.safetensors": ["segmenter", null, "sam3"],
    });
  });

  it("proposes one recipe for a model's two experts, with the LoRAs of its own mode", () => {
    const R = "lyrica/huggingface/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files";
    const dir = folder({
      [`${R}/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors`]: WAN_T2V, [`${R}/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors`]: WAN_T2V,
      [`${R}/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`]: WAN_LORA, [`${R}/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`]: WAN_LORA,
      [`${R}/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors`]: WAN_LORA, [`${R}/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors`]: WAN_LORA,
      [`${R}/vae/wan_2.1_vae.safetensors`]: QWEN_VAE, "other/umt5.safetensors": UMT5,
    });
    const b = new RecipeBook(mkdtempSync(join(tmpdir(), "lyrica-book-")), TEMPLATES, STARTERS);
    const parts = scanParts(dir);
    expect(b.propose(parts)).toBe(1);
    const r = b.all()[0]!;
    expect(r).toMatchObject({ template: "wan22-t2v-14b", does: ["video"], defaults: { steps: 4, shift: 5, duration: 5 } });
    const file = (role: string, slot: string) => r.parts.find((p) => p.role === role && p.slot === slot)?.file;
    expect(file("diffusion", "high")).toMatch(/t2v_high_noise/);
    expect(file("diffusion", "low")).toMatch(/t2v_low_noise/);
    expect(file("lora", "high")).toMatch(/t2v_lightx2v_4steps_lora_v1.1_high/);
    expect(file("lora", "low")).toMatch(/t2v_lightx2v_4steps_lora_v1.1_low/);
    expect(b.ready(r, new Set(parts.map((p) => p.file)))).toBe(true);
    // Its two models take only the LoRAs the template names.
    expect(() => b.patch(r.id, { op: "addLora", file: parts.find((p) => p.role === "lora")!.file, strength: 1 }, parts)).toThrow(/only the LoRAs/);
  });

  it("fills the video templates: two experts with their LoRAs, audio VAEs, and a first frame only when given", () => {
    const p = (role: Recipe["parts"][number]["role"], file: string, slot: string | null = null) => ({ role, slot, file, added: false });
    const at = (spec: string, duration: number, width: number, height: number, steps = 4) => videoValues(TEMPLATES.get(spec)!.video!, duration, width, height, steps);
    const wan14 = STARTERS.find((s) => s.id === "wan2.2-t2v-14b")!;
    const t2v = fill(TEMPLATES.get("wan22-t2v-14b")!, [
      p("diffusion", "high.safetensors", "high"), p("diffusion", "low.safetensors", "low"), p("lora", "lh.safetensors", "high"), p("lora", "ll.safetensors", "low"),
      p("text_encoder", "umt5.safetensors", "umt5"), p("vae", "vae.safetensors"),
    ], [], { negativePrompt: "", ...wan14.defaults, prompt: "x", seed: 3, width: 1280, height: 720, ...at("wan22-t2v-14b", 5, 1280, 720) });
    expect(t2v.lora_high!.inputs).toEqual({ model: ["load_model_high", 0], lora_name: "lh.safetensors", strength_model: 1 });
    expect(t2v.shift_high!.inputs.model).toEqual(["lora_high", 0]);
    expect(t2v.shift_low!.inputs.model).toEqual(["lora_low", 0]);
    // The high-noise expert takes the first half of the steps, the low-noise one the rest.
    expect(t2v.high!.inputs).toMatchObject({ steps: 4, start_at_step: 0, end_at_step: 2, noise_seed: 3, return_with_leftover_noise: "enable" });
    expect(t2v.low!.inputs).toMatchObject({ start_at_step: 2, latent_image: ["high", 0], add_noise: "disable" });
    // Wan 2.2 14B: 5 seconds at 16 fps is 81 frames.
    expect(t2v.latent!.inputs).toEqual({ width: 1280, height: 720, length: 81, batch_size: 1 });
    expect(t2v.save).toEqual({ class_type: "SaveVideoWebsocket", inputs: { video: ["video", 0] } });
    expect(JSON.stringify(t2v)).not.toContain("$");
    // Without an interpolator the clip is the model's 16 fps; with one, each gap gains a frame: 161 frames at 32 fps.
    expect(t2v.video!.inputs).toEqual({ images: ["decode", 0], fps: 16 });
    expect(Object.keys(t2v)).not.toContain("interpolate");
    const doubled = videoValues(TEMPLATES.get("wan22-t2v-14b")!.video!, 5, 1280, 720, 4, 2);
    expect(doubled).toMatchObject({ frames: 81, clipFrames: 161, fps: 32, multiplier: 2 });
    const smooth = fill(TEMPLATES.get("wan22-t2v-14b")!, [
      p("diffusion", "high.safetensors", "high"), p("diffusion", "low.safetensors", "low"), p("lora", "lh.safetensors", "high"), p("lora", "ll.safetensors", "low"),
      p("text_encoder", "umt5.safetensors", "umt5"), p("vae", "vae.safetensors"), p("interpolator", "rife.safetensors"),
    ], [], { negativePrompt: "", ...wan14.defaults, prompt: "x", seed: 3, width: 1280, height: 720, ...doubled });
    expect(smooth.load_interpolator).toEqual({ class_type: "FrameInterpolationModelLoader", inputs: { model_name: "rife.safetensors" } });
    expect(smooth.interpolate!.inputs).toEqual({ interp_model: ["load_interpolator", 0], images: ["decode", 0], multiplier: 2 });
    expect(smooth.video!.inputs).toEqual({ images: ["interpolate", 0], fps: 32 });
    expect(smooth.latent!.inputs.length).toBe(81);

    const ltxParts = [p("diffusion", "ltx.safetensors"), p("text_encoder", "gemma.safetensors", "gemma4_12b"), p("vae", "v.safetensors"), p("vae", "a.safetensors", "audio"), p("latent_upscaler", "up.safetensors")];
    const ltx = STARTERS.find((s) => s.id === "ltx-2.5-distilled")!;
    const ltxValues = { negativePrompt: "", steps: 1, ...ltx.defaults, prompt: "x", seed: 1, width: 1280, height: 704, ...at("ltx2", 5, 1280, 704) };
    const fromText = fill(TEMPLATES.get("ltx2")!, ltxParts, [], ltxValues);
    // It samples at half size, upscales the latent twice over, then refines; the audio has its own VAE.
    expect(fromText.empty!.inputs).toEqual({ width: 640, height: 352, length: 121, batch_size: 1 });
    expect(fromText.av!.inputs.video_latent).toEqual(["empty", 0]);
    expect(fromText.upscale!.inputs).toEqual({ samples: ["split", 0], upscale_model: ["load_latent_upscaler", 0], vae: ["load_vae", 0] });
    expect(fromText.sound!.inputs.audio_vae).toEqual(["load_vae_audio", 0]);
    expect(fromText.video!.inputs).toEqual({ images: ["decode", 0], fps: 24, audio: ["sound", 0] });
    expect(Object.keys(fromText)).not.toContain("load");
    expect(JSON.stringify(fromText)).not.toContain("$");
    const fromImage = fill(TEMPLATES.get("ltx2")!, ltxParts, [], { ...ltxValues, image: "lyrica-image.png" });
    expect(fromImage.first!.inputs).toMatchObject({ image: ["prep", 0], latent: ["empty", 0], strength: 0.7 });
    expect(fromImage.av!.inputs.video_latent).toEqual(["first", 0]);
    expect(fromImage.av_full!.inputs.video_latent).toEqual(["again", 0]);

    const h3 = STARTERS.find((s) => s.id === "minimax-h3-turbo")!;
    const turbo = fill(TEMPLATES.get("minimax-h3")!, [
      p("diffusion", "h3.safetensors"), p("lora", "turbo.safetensors", "speed"), p("text_encoder", "vl.safetensors", "qwen3vl_32b"),
      p("vae", "v.safetensors"), p("vae", "a.safetensors", "audio"),
    ], [], { negativePrompt: "", ...h3.defaults, prompt: "x", seed: 1, width: 1344, height: 768, ...at("minimax-h3", 5, 1344, 768, 8) });
    // The speed LoRA goes onto the one model; H3's frames come in 17s plus 5: 124 for 5 seconds at 24 fps.
    expect(turbo.guide!.inputs.model).toEqual(["lora_speed", 0]);
    expect(turbo.load_clip!.inputs).toEqual({ clip_name: "vl.safetensors", type: "minimax" });
    expect(turbo.cond!.inputs).toMatchObject({ length: 124, width: 1344 });
    expect(turbo.cond!.inputs).not.toHaveProperty("first_frame");
    expect(turbo.sound!.inputs.vae).toEqual(["load_vae_audio", 0]);
    expect(JSON.stringify(turbo)).not.toContain("$");
    // A template that needs a part the recipe lacks says so.
    expect(() => fill(TEMPLATES.get("minimax-h3")!, [p("diffusion", "h3.safetensors"), p("vae", "v.safetensors")], [], { ...h3.defaults, prompt: "x", seed: 1, width: 1344, height: 768, ...at("minimax-h3", 5, 1344, 768) })).toThrow(/nothing for \$clip/);
  });

  it("times clips on each model's frame grid, up to its longest", () => {
    const frames = (t: string, d: number) => videoValues(TEMPLATES.get(t)!.video!, d, 1280, 704, 20).frames;
    expect(frames("wan22-5b", 5)).toBe(121);
    expect(frames("wan22-i2v-14b", 3)).toBe(49);
    expect(frames("ltx2", 10)).toBe(241);
    expect(frames("minimax-h3", 15)).toBe(362);
    expect(frames("minimax-h3", 1)).toBe(39);
    for (const t of [...TEMPLATES.values()].filter((t) => t.does.some((a) => a === "video" || a === "animate"))) {
      expect(t.video, t.name).toBeDefined();
      expect(t.workflow.save!.class_type, t.name).toBe("SaveVideoWebsocket");
    }
  });
});

describe("long videos", () => {
  const h3 = TEMPLATES.get("minimax-h3")!;
  const frames = (plan: number[]) => plan.map((s) => Number(videoValues(h3.video!, s, 1344, 768, 8).frames));

  it("chains H3 clips of at most 8 seconds, each next one starting from the last 22 frames", () => {
    expect(h3.continuation).toMatchObject({ overlap: 22, clipSeconds: 8 });
    expect(TEMPLATES.has("minimax-h3-continue")).toBe(false);
    // Up to 8 seconds is one clip; past it near-equal clips, whose new frames cover what was asked.
    expect(clipPlan(h3.video!, h3.continuation, 8)).toEqual([8]);
    for (const seconds of [9, 16, 30, 60]) {
      const made = frames(clipPlan(h3.video!, h3.continuation, seconds));
      expect(Math.max(...made), `${seconds} s`).toBeLessThanOrEqual(192);
      const added = made[0]! + made.slice(1).reduce((n, f) => n + f - 22, 0);
      // At most one frame step (17) over what was asked, as one clip rounds: 16 s was 413 frames (17.2 s) before.
      expect(added, `${seconds} s`).toBeGreaterThanOrEqual(seconds * 24);
      expect(added, `${seconds} s`).toBeLessThan(seconds * 24 + 17);
    }
    expect(clipPlan(h3.video!, h3.continuation, 16)).toHaveLength(3);
    expect(clipPlan(h3.video!, h3.continuation, 60)).toHaveLength(9);
    // Extending, every clip is a continuation; without one, a template makes one clip.
    const added = frames(clipPlan(h3.video!, h3.continuation, 4, true));
    expect(added).toHaveLength(1);
    expect(added[0]! - 22).toBeGreaterThanOrEqual(96);
    expect(clipPlan(TEMPLATES.get("wan22-5b")!.video!, undefined, 8)).toEqual([8]);
  });

  it("fills the continuation: the clip so far's tail anchors frame 0 and is the prompt's first frame, and the new clip joins on after its overlap", () => {
    const p = (role: Recipe["parts"][number]["role"], file: string, slot: string | null = null) => ({ role, slot, file, added: false });
    const starter = STARTERS.find((s) => s.id === "minimax-h3-turbo")!;
    const next = fill({ ...h3, workflow: h3.continuation!.workflow }, [
      p("diffusion", "h3.safetensors"), p("lora", "turbo.safetensors", "speed"), p("text_encoder", "vl.safetensors", "qwen3vl_32b"),
      p("vae", "v.safetensors"), p("vae", "a.safetensors", "audio"),
    ], [], { negativePrompt: "", ...starter.defaults, prompt: "x", seed: 2, width: 1344, height: 768, overlap: 22, previous: "lyrica-previous.mp4", ...videoValues(h3.video!, 6, 1344, 768, 8) });
    expect(next.previous!.inputs).toEqual({ file: "lyrica-previous.mp4" });
    expect(next.tail!.inputs).toEqual({ video: ["previous", 0], frames: 22 });
    // The text encoder sees the frame the clip starts from, so the prompt reads against the clip so far, not the
    // still an animate began with: without it, the second clip of an animated still drifted back to the still's shot.
    expect(next.cond!.inputs.first_frame).toEqual(["tail", 0]);
    expect(next.anchor!.inputs).toEqual({ positive: ["cond", 0], vae: ["load_vae", 0], audio_vae: ["load_vae_audio", 0], latent: ["cond", 1], image: ["tail", 0], audio: ["tail", 1], frame_idx: 0 });
    expect(next.guide!.inputs.conditioning).toEqual(["anchor", 0]);
    expect(next.join!.inputs).toEqual({ previous: ["previous", 0], images: ["decode", 0], audio: ["sound", 0], fps: 24, overlap: 22 });
    expect(next.save!.inputs.video).toEqual(["join", 0]);
    expect(JSON.stringify(next)).not.toContain("$");
  });

  it("reads a clip's size, frame count and frame rate from its video track", () => {
    expect(mp4Video(clip(1344, 768, 192, 24))).toEqual({ width: 1344, height: 768, frames: 192, fps: 24 });
    expect(mp4Video(mp4(3))).toBeNull();
    // A version 1 media header too short for its 64-bit duration is no clip, not an error.
    const v1 = clip(1344, 768, 192, 24);
    const at = v1.lastIndexOf("mdhd");
    v1[at + 4] = 1;
    expect(mp4Video(v1)).toBeNull();
    expect(mp4Video(PNG)).toBeNull();
  });
});

describe("recipes", () => {
  function book(dir = mkdtempSync(join(tmpdir(), "lyrica-book-"))) {
    return new RecipeBook(dir, TEMPLATES, STARTERS);
  }

  it("reads an older recipe as both and persists its create tier without changing its parts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-book-"));
    const b = book(dir);
    b.fromStarter(STARTERS[0]!, () => null);
    const old = b.all()[0]!;
    delete old.useFor;
    b.save();
    const reopened = book(dir);
    expect(reopened.get(old.id).useFor).toBe("both");
    writeFileSync(join(dir, "recipes.json"), JSON.stringify([{ ...old, useFor: "slow" }]));
    expect(book(dir).get(old.id).useFor).toBe("both");
    for (const useFor of ["fast", "quality", "both"]) {
      reopened.patch(old.id, { op: "useFor", useFor }, []);
      expect(book(dir).get(old.id)).toMatchObject({ useFor, parts: old.parts, defaults: old.defaults });
    }
    expect(() => reopened.patch(old.id, { op: "useFor", useFor: "slow" }, [])).toThrow("useFor must be fast, quality or both");
    expect(book(dir).get(old.id).useFor).toBe("both");
  });

  it("proposes recipes from matching parts, lists missing ones, and leaves files without a template alone", () => {
    const dir = folder({
      [`${Z}/diffusion_models/z.safetensors`]: Z_DIFFUSION, [`${Z}/text_encoders/qwen_3_4b.safetensors`]: QWEN3,
      "shared/flux1-schnell-fp8.safetensors": FLUX_CKPT, "shared/sd15.safetensors": SD15_CKPT,
    });
    const b = book();
    const parts = scanParts(dir);
    expect(b.propose(parts)).toBe(2);
    const [z, flux] = b.all();
    expect(z).toMatchObject({ state: "proposed", arch: "z-image", template: "z-image", does: ["create"], defaults: { steps: 8, sampler: "res_multistep" } });
    expect(z!.parts).toEqual([
      { role: "diffusion", slot: null, file: `${Z}/diffusion_models/z.safetensors`, added: false },
      { role: "text_encoder", slot: "qwen3", file: `${Z}/text_encoders/qwen_3_4b.safetensors`, added: false },
      { role: "vae", slot: null, file: null, added: false, missing: expect.objectContaining({ source: "huggingface", repo: "Comfy-Org/z_image_turbo", path: "split_files/vae/ae.safetensors" }) },
    ]);
    const files = new Set(parts.map((p) => p.file));
    expect(b.ready(z!, files)).toBe(false);
    expect(flux).toMatchObject({ arch: "flux", parts: [{ role: "checkpoint", file: "shared/flux1-schnell-fp8.safetensors" }] });
    expect(b.ready(flux!, files)).toBe(true);
    // Once ignored, a proposal isn't made again.
    b.setState([flux!.id], "ignored");
    expect(b.propose(parts)).toBe(0);
  });

  it("swaps a part only for one of the same role, slot and architecture, and adds LoRAs of its architecture", () => {
    const dir = folder({ "z.safetensors": Z_DIFFUSION, "q.safetensors": QWEN3, "q2.safetensors": QWEN3, "vl.safetensors": QWEN25VL, "ae.safetensors": FLUX_VAE, "sdxl_vae.safetensors": SDXL_VAE, "style.safetensors": Z_LORA });
    const b = book();
    const parts = scanParts(dir);
    b.propose(parts);
    const r = b.all()[0]!;
    expect(() => b.patch(r.id, { op: "swap", role: "text_encoder", slot: "qwen3", file: "vl.safetensors" }, parts)).toThrow("same role, slot and architecture");
    expect(() => b.patch(r.id, { op: "swap", role: "vae", file: "sdxl_vae.safetensors" }, parts)).toThrow("same role, slot and architecture");
    b.patch(r.id, { op: "swap", role: "text_encoder", slot: "qwen3", file: "q2.safetensors" }, parts);
    const copy = b.copy(r.id, "Z, styled");
    b.patch(copy.id, { op: "addLora", file: "style.safetensors", strength: 0.8 }, parts);
    expect(b.get(copy.id)).toMatchObject({ base: r.id, state: "proposed", loras: [{ file: "style.safetensors", strength: 0.8 }] });
    expect(b.get(r.id).loras).toEqual([]);
    expect(() => b.patch(r.id, { op: "addPart", role: "vae", file: "ae.safetensors" }, parts)).toThrow("checkpoint");
  });

  it("confirms and ignores each proposal on its own, and a retry is harmless", () => {
    const b = new RecipeBook(mkdtempSync(join(tmpdir(), "lyrica-book-")), TEMPLATES, STARTERS);
    const starter = STARTERS.find((s) => s.id === "z-image-turbo")!;
    const confirmed = b.fromStarter(starter, () => null).recipe;
    const proposal = b.copy(confirmed.id, "p");
    b.get(proposal.id).state = "proposed";
    const first = b.setState([proposal.id, confirmed.id, "missing"], "confirmed");
    expect(first.done.map((r) => r.id)).toEqual([proposal.id, confirmed.id]);
    expect(first.failed).toEqual([{ id: "missing", message: "No such recipe." }]);
    expect(b.setState([proposal.id], "confirmed")).toMatchObject({ done: [{ id: proposal.id, state: "confirmed" }], failed: [] });
    expect(b.setState([proposal.id], "ignored").failed[0]!.message).toBe("p isn't a proposal.");
  });

  it("adds a part a starter gained to its installed recipe, which stays ready at 16 fps until the part is here", () => {
    const b = new RecipeBook(mkdtempSync(join(tmpdir(), "lyrica-book-")), TEMPLATES, STARTERS);
    const starter = STARTERS.find((s) => s.id === "wan2.2-t2v-14b-q5")!;
    const before = { ...starter, parts: starter.parts.filter((p) => p.role !== "interpolator") };
    const { recipe } = b.fromStarter(before, () => null);
    const here = new Set(recipe.parts.map((p) => p.file!));
    expect(b.ready(recipe, here)).toBe(true);
    const again = b.fromStarter(starter, () => null);
    expect(again.recipe.id).toBe(recipe.id);
    expect(again.toDownload.map((p) => p.role)).toContain("interpolator");
    const rife = b.get(recipe.id).parts.find((p) => p.role === "interpolator")!.file!;
    expect(rife).toMatch(/rife_v4\.26\.safetensors$/);
    // Still downloading: ready, 16 fps, and the job's parts leave it out, so no interpolation node runs.
    expect(b.ready(b.get(recipe.id), here)).toBe(true);
    expect(b.describe(b.get(recipe.id), here)).toMatchObject({ ready: true, video: { fps: 16 } });
    const job = fill(TEMPLATES.get("wan22-t2v-14b")!, present(b.get(recipe.id), here), [], { negativePrompt: "", ...starter.defaults, prompt: "x", seed: 1, width: 1280, height: 720,
      ...videoValues(TEMPLATES.get("wan22-t2v-14b")!.video!, 5, 1280, 720, 4) });
    expect(Object.keys(job)).not.toContain("interpolate");
    // Once it's here, 32 fps.
    expect(b.describe(b.get(recipe.id), new Set([...here, rife]))).toMatchObject({ ready: true, video: { fps: 32 } });
  });

  it("installs a starter once, and checks defaults against the request ranges", () => {
    const b = new RecipeBook(mkdtempSync(join(tmpdir(), "lyrica-book-")), TEMPLATES, STARTERS);
    const starter = STARTERS.find((s) => s.id === "z-image-turbo")!;
    const first = b.fromStarter(starter, () => null);
    expect(first.toDownload).toHaveLength(3);
    const again = b.fromStarter(starter, (p) => (p.role === "vae" ? "here.safetensors" : null), (p) => p.role === "text_encoder");
    expect(again.recipe.id).toBe(first.recipe.id);
    expect(again.toDownload.map((p) => p.role)).toEqual(["diffusion"]);
    expect(b.all()).toHaveLength(1);
    const id = first.recipe.id;
    for (const bad of [{ steps: 0 }, { steps: 2.5 }, { width: 1000 }, { cfg: 99 }, { colorMatch: "x" }, { sampler: "a b" }, { negativePrompt: 3 }]) {
      expect(() => b.patch(id, { op: "defaults", defaults: bad }, [])).toThrow();
    }
    b.patch(id, { op: "defaults", defaults: { steps: 30, width: 768, sampler: "dpmpp_2m", colorMatch: "wavelet" } }, []);
    expect(b.get(id).defaults).toMatchObject({ steps: 30, width: 768, sampler: "dpmpp_2m" });
  });

  it("turns a recipe a scan made from a starter's files into the starter's, rather than adding a second", () => {
    const dir = folder({ [`${Z}/diffusion_models/z_image_turbo_bf16.safetensors`]: Z_DIFFUSION, [`${Z}/text_encoders/qwen_3_4b.safetensors`]: QWEN3 });
    const b = book();
    b.propose(scanParts(dir));
    const proposed = b.all()[0]!;
    const starter = STARTERS.find((s) => s.id === "z-image-turbo")!;
    const { recipe } = b.fromStarter(starter, () => null);
    expect(b.all()).toHaveLength(1);
    expect(recipe).toMatchObject({ id: proposed.id, name: "Z-Image Turbo", state: "confirmed", starter: "z-image-turbo" });
    // One already in use is kept as it is, and counts as the starter's.
    const c = book();
    c.propose(scanParts(dir));
    c.setState([c.all()[0]!.id], "confirmed");
    expect(c.fromStarter(starter, () => null).recipe).toMatchObject({ name: "z image turbo bf16", starter: "z-image-turbo" });
    expect(c.all()).toHaveLength(1);
  });

  it("fills a template with loaders, LoRAs and values, and nothing else", () => {
    const t = TEMPLATES.get("z-image")!;
    const wf = fill(t, [
      { role: "diffusion", slot: null, file: "z.safetensors", added: false },
      { role: "text_encoder", slot: "qwen3", file: "q.gguf", added: false },
      { role: "vae", slot: null, file: "ae.safetensors", added: false },
    ], [{ file: "style.safetensors", strength: 0.8 }], { prompt: "a cat", negativePrompt: "", width: 1024, height: 768, count: 2, steps: 8, cfg: 1, seed: 7, sampler: "euler", scheduler: "simple", shift: 3 });
    expect(wf.load_model).toEqual({ class_type: "UNETLoader", inputs: { unet_name: "z.safetensors", weight_dtype: "default" } });
    expect(wf.load_clip).toEqual({ class_type: "CLIPLoaderGGUF", inputs: { clip_name: "q.gguf", type: "lumina2" } });
    expect(wf.lora_0).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["load_model", 0], lora_name: "style.safetensors", strength_model: 0.8 } });
    expect(wf.shift!.inputs.model).toEqual(["lora_0", 0]);
    expect(wf.latent!.inputs).toEqual({ width: 1024, height: 768, batch_size: 2 });
    expect(JSON.stringify(wf)).not.toContain("$");

    const edit = fill(TEMPLATES.get("qwen-image-edit")!, [
      { role: "diffusion", slot: null, file: "e.safetensors", added: false },
      { role: "text_encoder", slot: "qwen2.5vl", file: "vl.safetensors", added: false },
      { role: "vae", slot: null, file: "v.safetensors", added: false },
    ], [], { prompt: "x", negativePrompt: "", count: 1, steps: 4, cfg: 1, seed: 1, sampler: "euler", scheduler: "simple", shift: 3, image: "lyrica-image.png" });
    expect(Object.keys(edit)).not.toContain("ref1");
    expect(edit.pos!.inputs).not.toHaveProperty("image2");
    expect(edit.batch!.inputs.samples).toEqual(["encoded", 0]);
    // As ComfyUI's own template: CFGNorm after the shift, and the image at a trained resolution.
    expect(edit.sample!.inputs.model).toEqual(["norm", 0]);
    expect(edit.norm!.inputs).toEqual({ model: ["shift", 0], strength: 1 });
    expect(edit.scaled!.class_type).toBe("FluxKontextImageScale");

    const starter = STARTERS.find((s) => s.id === "qwen-image-2.1-turbo")!;
    const qi21Parts = [
      { role: "diffusion" as const, slot: null, file: "q.safetensors", added: false },
      { role: "text_encoder" as const, slot: "qwen3vl_8b", file: "vl.safetensors", added: false },
      { role: "vae" as const, slot: null, file: "v.safetensors", added: false },
    ];
    // One template creates on a new canvas and edits on the image's own.
    const qi21New = fill(TEMPLATES.get("qwen-image-2.1")!, qi21Parts, [], { negativePrompt: "", ...starter.defaults, prompt: "x", count: 1, seed: 1 });
    expect(qi21New.sample!.inputs.latent_image).toEqual(["canvas", 0]);
    expect(Object.keys(qi21New)).not.toContain("load");
    expect(qi21New.encode!.inputs).not.toHaveProperty("images.image_1");
    expect(JSON.stringify(qi21New)).not.toContain("$");
    const qi21 = fill(TEMPLATES.get("qwen-image-2.1")!, [
      { role: "diffusion", slot: null, file: "q.safetensors", added: false },
      { role: "text_encoder", slot: "qwen3vl_8b", file: "vl.safetensors", added: false },
      { role: "vae", slot: null, file: "v.safetensors", added: false },
    ], [], { negativePrompt: "", ...starter.defaults, prompt: "x", count: 2, seed: 1, image: "lyrica-image.png", reference1: "lyrica-ref.png", seen: 1 });
    expect(qi21.load_clip).toEqual({ class_type: "CLIPLoader", inputs: { clip_name: "vl.safetensors", type: "qwen_image" } });
    expect(qi21.encode!.inputs).toMatchObject({ "images.image_1": ["seen", 0], "images.image_2": ["ref1", 0], resolution: 1024 });
    expect(qi21.encode!.inputs).not.toHaveProperty("images.image_3");
    expect(qi21.sigmas!.inputs.sigmas).toMatch(/^1\.0, .*, 0$/);
    expect(qi21.batch!.inputs).toEqual({ samples: ["encode", 2], amount: 2 });
    expect(qi21.sample!.inputs.latent_image).toEqual(["batch", 0]);
    expect(qi21.save!.inputs.images).toEqual(["decode", 0]);
    expect(Object.keys(qi21)).not.toContain("inpaint");
    expect(JSON.stringify(qi21)).not.toContain("$");
    // A masked edit goes through LanPaint at about a megapixel, and only the masked part goes back into the original.
    const qi21Masked = fill(TEMPLATES.get("qwen-image-2.1")!, qi21Parts, [], { negativePrompt: "", ...starter.defaults, prompt: "x", count: 2, seed: 1, image: "lyrica-image.png", mask: "lyrica-mask.png", seen: 1 });
    // The mask grows a little, so the old outline at its edge is redrawn too.
    expect(qi21Masked.grown!.inputs).toMatchObject({ mask: ["mask", 0], expand: 24 });
    expect(qi21Masked.masked!.inputs).toMatchObject({ image: ["fit", 0], mask: ["grown", 0] });
    expect(qi21Masked.batch!.inputs.samples).toEqual(["masked", 0]);
    expect(qi21Masked.inpaint!.class_type).toBe("LanPaint_SamplerCustomAdvanced");
    expect(qi21Masked.inpaint!.inputs).toMatchObject({ guider: ["guider", 0], sigmas: ["sigmas", 0], latent_image: ["batch", 0] });
    expect(qi21Masked.merged!.inputs).toMatchObject({ blend_overlap: 31, samples: ["inpaint", 0], image: ["originals", 0], mask: ["grown", 0] });
    // The merge keeps as many images as the original has, so a batch repeats it.
    expect(qi21Masked.originals!.inputs).toEqual({ image: ["load", 0], amount: 2 });
    expect(qi21Masked.save!.inputs.images).toEqual(["merged", 0]);
    expect(qi21Masked.encode!.inputs["images.image_1"]).toEqual(["seen", 0]);
    expect(JSON.stringify(qi21Masked)).not.toContain("$");
    // Replacing the masked part: the encoder doesn't see the image, so the old object's shape doesn't come back.
    const qi21Replace = fill(TEMPLATES.get("qwen-image-2.1")!, qi21Parts, [], { negativePrompt: "", ...starter.defaults, prompt: "x", count: 1, seed: 1, image: "lyrica-image.png", mask: "lyrica-mask.png" });
    expect(qi21Replace.encode!.inputs).not.toHaveProperty("images.image_1");
    expect(qi21Replace.masked!.inputs.image).toEqual(["fit", 0]);

    const krea = fill(TEMPLATES.get("krea2")!, [
      { role: "diffusion", slot: null, file: "k.safetensors", added: false },
      { role: "text_encoder", slot: "qwen3vl", file: "vl.safetensors", added: false },
      { role: "vae", slot: null, file: "v.safetensors", added: false },
    ], [], { prompt: "x", width: 1024, height: 1024, count: 1, steps: 8, cfg: 1, seed: 1, sampler: "euler", scheduler: "simple" });
    expect(krea.load_clip).toEqual({ class_type: "CLIPLoader", inputs: { clip_name: "vl.safetensors", type: "krea2" } });
    expect(krea.neg!.inputs.conditioning).toEqual(["pos", 0]);
    expect(JSON.stringify(krea)).not.toContain("$");
  });

  it("sizes a recipe by its largest stage plus the VAE, as ComfyUI loads one stage at a time", () => {
    const GB = 1e9;
    const parts = [
      { file: "z.safetensors", size: 12.3 * GB }, { file: "qwen3.safetensors", size: 8 * GB },
      { file: "ae.safetensors", size: 0.3 * GB }, { file: "style.safetensors", size: 0.5 * GB },
    ];
    const z = {
      parts: [
        { role: "diffusion" as const, slot: null, file: "z.safetensors", added: false },
        { role: "text_encoder" as const, slot: "qwen3", file: "qwen3.safetensors", added: false },
        { role: "vae" as const, slot: null, file: "ae.safetensors", added: false },
      ],
      loras: [],
    };
    // Z-Image Turbo on a 16 GB card: 12.6 GB, not the 20.6 GB of every part at once.
    expect(recipeSize(z, parts)).toBeCloseTo(12.6 * GB);
    expect(recipeSize({ ...z, loras: [{ file: "style.safetensors", strength: 1 }] }, parts)).toBeCloseTo(13.1 * GB);
    // An encoder larger than the diffusion model sets the peak.
    expect(recipeSize(z, [...parts.slice(1), { file: "z.safetensors", size: 4 * GB }])).toBeCloseTo(8.3 * GB);
    // A video model's two experts run one after the other, each with its own LoRA; both VAEs stay.
    const sizes = [{ file: "h", size: 14 * GB }, { file: "l", size: 14 * GB }, { file: "lh", size: 0.6 * GB }, { file: "ll", size: 0.6 * GB },
      { file: "t", size: 6.7 * GB }, { file: "v", size: 0.3 * GB }, { file: "a", size: 0.1 * GB }];
    const wan = { loras: [], parts: [
      { role: "diffusion" as const, slot: "high", file: "h", added: false }, { role: "diffusion" as const, slot: "low", file: "l", added: false },
      { role: "lora" as const, slot: "high", file: "lh", added: false }, { role: "lora" as const, slot: "low", file: "ll", added: false },
      { role: "text_encoder" as const, slot: "umt5", file: "t", added: false }, { role: "vae" as const, slot: null, file: "v", added: false },
      { role: "vae" as const, slot: "audio", file: "a", added: false },
    ] };
    expect(recipeSize(wan, sizes)).toBeCloseTo(15 * GB);
  });
});

describe("ComfyUI jobs", () => {
  it("blanks the uploads and clears the history after a job", async () => {
    const fake = await fakeComfy();
    open.push(fake);
    const pngs = await new Comfy(fake.url).run({ image: PNG }, () => ({}));
    expect(pngs).toHaveLength(1);
    expect(fake.seen.uploads).toEqual(["lyrica-image.png", "lyrica-image.png"]);
    expect(fake.seen.uploadBodies[0]!.includes(PNG)).toBe(true);
    expect(fake.seen.uploadBodies[1]!.includes(PNG)).toBe(false);
    expect(fake.seen.historyCleared).toBe(1);
    expect(fake.seen.interrupted).toEqual([]);
  });

  it("runs ComfyUI only while a recipe is loaded, and stops it at once on pause", async () => {
    const fake = await fakeComfy();
    open.push(fake);
    const dir = mkdtempSync(join(tmpdir(), "comfy-gate-"));
    const status = join(dir, "status.json");
    const asked = () => JSON.parse(readFileSync(join(dir, "comfyui-0.json"), "utf8")) as { run: boolean; attempt?: string };
    const comfy = new Comfy(fake.url, undefined, undefined, { state: join(dir, "comfyui-0.json"), status });
    expect(asked().run).toBe(false);
    const recipe = (id: string) => ({ id }) as never;
    // A load waits until gate.py says a ComfyUI for this attempt runs, not one still stopping.
    writeFileSync(status, JSON.stringify({ attempt: "older" }));
    let loaded = false;
    const load = comfy.load(recipe("a")).then(() => { loaded = true; });
    await new Promise((r) => setTimeout(r, 700));
    expect(loaded).toBe(false);
    writeFileSync(status, JSON.stringify({ attempt: asked().attempt }));
    await load;
    // Switching recipes keeps it running; the last one going stops it a moment later.
    await comfy.unload(recipe("a"));
    const switching = comfy.load(recipe("b"));
    writeFileSync(status, JSON.stringify({ attempt: asked().attempt }));
    await switching;
    await comfy.unload(recipe("b"));
    expect(asked().run).toBe(true);
    await new Promise((r) => setTimeout(r, 2_200));
    expect(asked().run).toBe(false);
    // Pause stops it at once.
    const again = comfy.load(recipe("c"));
    writeFileSync(status, JSON.stringify({ attempt: asked().attempt }));
    await again;
    await comfy.reset();
    expect(asked().run).toBe(false);
  });

  it("fails at once, and says why, on a GPU ComfyUI's PyTorch can't run", async () => {
    const fake = await fakeComfy();
    open.push(fake);
    const dir = mkdtempSync(join(tmpdir(), "comfy-gate-"));
    const status = join(dir, "status.json");
    const why = "Tesla V100 is sm_70, and this ComfyUI's PyTorch has kernels only for sm_75, so it can't make images on it.";
    writeFileSync(status, JSON.stringify({ attempt: null, unsupported: why }));
    const comfy = new Comfy(fake.url, undefined, undefined, { state: join(dir, "comfyui-0.json"), status });
    expect(comfy.problem).toBe(why);
    await expect(comfy.load({ id: "a" } as never)).rejects.toMatchObject({ status: 503, message: why });
    expect(JSON.parse(readFileSync(join(dir, "comfyui-0.json"), "utf8")).run).toBe(false);
  });

  it("queues nothing when the client goes away before the prompt is sent", async () => {
    const fake = await fakeComfy();
    open.push(fake);
    const abort = new AbortController();
    const run = new Comfy(fake.url).run({ image: PNG }, () => (abort.abort(), {}), abort.signal);
    await expect(run).rejects.toThrow();
    expect(fake.seen.prompts).toEqual([]);
    expect(fake.seen.uploadBodies.at(-1)!.includes(PNG)).toBe(false);
  });

  it("refuses an image whose header claims too many pixels", () => {
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(9000, 16);
    expect(() => inputImage(huge.toString("base64"), "image")).toThrow("8192 pixels");
    huge.writeUInt32BE(8000, 16);
    huge.writeUInt32BE(8000, 20);
    expect(() => inputImage(huge.toString("base64"), "image")).toThrow("36 megapixels");
    expect(inputImage(PNG.toString("base64"), "image")).toEqual(PNG);
  });

  it("fails a job when ComfyUI is off or hangs, and the next job still runs", async () => {
    // Accepts connections and never answers, as a ComfyUI stuck loading.
    const sockets: net.Socket[] = [];
    const stuck = net.createServer((sock) => sockets.push(sock));
    await new Promise<void>((r) => stuck.listen(0, "127.0.0.1", r));
    open.push({ close: () => { for (const x of sockets) x.destroy(); stuck.close(); } });
    const comfy = new Comfy(`http://127.0.0.1:${(stuck.address() as AddressInfo).port}`, 60_000, 100);
    await expect(comfy.run({ image: PNG }, () => ({}))).rejects.toThrow("didn't answer");
    await expect(comfy.run({}, () => ({}))).rejects.toThrow("didn't answer");
    // Off entirely.
    stuck.close();
    for (const x of sockets) x.destroy();
    await expect(comfy.run({ image: PNG }, () => ({}))).rejects.toThrow("didn't answer");
  });

  it("interrupts and dequeues a job that times out or is cancelled", async () => {
    const fake = await fakeComfy({ hang: true });
    open.push(fake);
    await expect(new Comfy(fake.url, 50).run({ image: PNG }, () => ({}))).rejects.toThrow("took too long");
    expect(fake.seen).toMatchObject({ interrupted: ["p1"], deleted: ["p1"], historyCleared: 1 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    await expect(new Comfy(fake.url).run({}, () => ({}), abort.signal)).rejects.toThrow("cancelled");
    expect(fake.seen).toMatchObject({ interrupted: ["p1", "p2"], deleted: ["p1", "p2"] });
  });
});

describe("job progress", () => {
  it("counts only the samplers an output needs, each equally, as 95% of the job", () => {
    const seen: number[] = [];
    const prompt = {
      high: { class_type: "KSamplerAdvanced", inputs: { model: ["m", 0] } },
      low: { class_type: "KSamplerAdvanced", inputs: { latent_image: ["high", 0] } },
      unused: { class_type: "KSampler", inputs: {} },
      pick: { class_type: "KSamplerSelect", inputs: {} },
      decode: { class_type: "VAEDecode", inputs: { samples: ["low", 0] } },
      save: { class_type: "SaveImageWebsocket", inputs: { images: ["decode", 0] } },
    };
    const progress = samplingProgress(prompt, (f) => seen.push(f))!;
    progress("high", 2, 2);
    progress("unused", 1, 1);
    progress("decode", 1, 1);
    progress("low", 1, 4);
    progress("low", 0, 4);
    expect(seen).toEqual([0.475, 0.475 + 0.95 / 8, 0.475 + 0.95 / 8]);
    expect(samplingProgress({ save: { class_type: "SaveImageWebsocket", inputs: {} } }, () => {})).toBeUndefined();
  });
});

describe("stable-diffusion.cpp", () => {
  const part = (role: string, file: string, slot: string | null = null) => ({ role, slot, file, added: false }) as Recipe["parts"][number];

  it("gives sd-server each part under its own flag, and refuses what it can't run", () => {
    expect(sdcppArgs({ template: "flux", parts: [part("checkpoint", "f/flux.safetensors")], loras: [] }, "/models")).toEqual(["--flash-attn", "off", "--type", "q8_0", "-m", "/models/f/flux.safetensors"]);
    expect(sdcppArgs({ template: "qwen-image", parts: [part("diffusion", "q/d.safetensors"), part("text_encoder", "q/te.safetensors", "qwen2.5vl"), part("vae", "q/v.safetensors")], loras: [] }, "/models"))
      .toEqual(["--flash-attn", "off", "--type", "q8_0", "--diffusion-model", "/models/q/d.safetensors", "--llm", "/models/q/te.safetensors", "--vae", "/models/q/v.safetensors"]);
    // A GGUF main model keeps its own quantisation.
    expect(sdcppArgs({ template: "krea2", parts: [part("diffusion", "k/d.gguf"), part("text_encoder", "k/te.gguf", "qwen3vl"), part("vae", "k/v.safetensors")], loras: [] }, "/models"))
      .toEqual(["--flash-attn", "off", "--diffusion-model", "/models/k/d.gguf", "--llm", "/models/k/te.gguf", "--vae", "/models/k/v.safetensors"]);
    expect(sdcppArgs({ template: "krea2", parts: [part("diffusion", "k/d.safetensors"), part("text_encoder", "k/te.safetensors", "qwen3vl"), part("vae", "k/v.safetensors")], loras: [] }, "/models"))
      .toEqual(["--flash-attn", "off", "--type", "q8_0", "--diffusion-model", "/models/k/d.safetensors", "--llm", "/models/k/te.safetensors", "--vae", "/models/k/v.safetensors"]);
    // Unlocked tensor cores: F16 weights, flash attention on; a GGUF keeps its quantisation.
    expect(sdcppArgs({ template: "flux", parts: [part("checkpoint", "f/flux.safetensors")], loras: [] }, "/models", true)).toEqual(["--flash-attn", "on", "--type", "f16", "-m", "/models/f/flux.safetensors"]);
    expect(sdcppArgs({ template: "krea2", parts: [part("diffusion", "k/d.gguf")], loras: [] }, "/models", true)).toEqual(["--flash-attn", "on", "--diffusion-model", "/models/k/d.gguf"]);
    expect(() => sdcppArgs({ template: "seedvr2", parts: [], loras: [] }, "/models")).toThrow(/no seedvr2 support/);
    expect(() => sdcppArgs({ template: "z-image", parts: [], loras: [{ file: "l.safetensors", strength: 1 }] }, "/models")).toThrow(/LoRAs/);
  });

  it("has gate.sh report the tensor cores' rate and start sd-server with host-api's arguments alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-gate-"));
    const script = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return join(dir, name);
    };
    const env = {
      ...process.env, SDCPP_STATE: join(dir, "state.json"), SDCPP_STATUS: join(dir, "status.json"),
      SDCPP_PROBE: script("probe", "echo full"), SDCPP_SERVER: script("server", `printf '%s\\n' "$@" > ${join(dir, "args")}; exec sleep 30`),
    };
    writeFileSync(env.SDCPP_STATE, JSON.stringify({ run: true, attempt: "a1", args: ["--flash-attn", "on", "-m", "/models/x"] }));
    const gate = (await import("node:child_process")).spawn(join(host, "sdcpp/gate.sh"), { env, stdio: "ignore" });
    try {
      const status = () => { try { return JSON.parse(readFileSync(env.SDCPP_STATUS, "utf8")); } catch { return {}; } };
      for (let i = 0; i < 100 && !(status().attempt && readdirSync(dir).includes("args")); i++) await new Promise((r) => setTimeout(r, 50));
      expect(status()).toEqual({ attempt: "a1", tensor: "full" });
      expect(readFileSync(join(dir, "args"), "utf8").trim().split("\n")).toEqual(["--listen-ip", "0.0.0.0", "--listen-port", "8188", "--flash-attn", "on", "-m", "/models/x"]);
    } finally {
      gate.kill("SIGTERM");
    }
  });

  it("names samplers and schedulers as sd.cpp does, and leaves out the ones it doesn't have", () => {
    const base = { prompt: "p", negativePrompt: "", width: 512, height: 512, seed: 1, count: 1, steps: 4, cfg: 1, shift: 3, guidance: 3.5 };
    expect(sdcppJob("flux", { ...base, sampler: "euler_ancestral", scheduler: "normal" })).toMatchObject({
      sample_params: { sample_method: "euler_a", scheduler: "discrete", guidance: { txt_cfg: 1, distilled_guidance: 3.5 } },
    });
    const odd = sdcppJob("sdxl", { ...base, sampler: "uni_pc", scheduler: "ddim_uniform" }) as { sample_params: object };
    expect(odd.sample_params).not.toHaveProperty("sample_method");
    expect(odd.sample_params).not.toHaveProperty("scheduler");
    expect(odd.sample_params).not.toHaveProperty("flow_shift");
  });

  it("cancels in sd-server a job whose client went away", async () => {
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const status = join(serving, "status.json");
    const fake = await fakeSdServer(serving, status, { hang: true });
    open.push(fake);
    const sdcpp = new SdCpp(fake.url, { serving, status });
    sdcpp.prepare("recipe:a", ["--diffusion-model", "/models/a"]);
    const abort = new AbortController();
    const job = sdcpp.create("recipe:a", "z-image", { prompt: "p", steps: 1 }, abort.signal);
    await new Promise((r) => setTimeout(r, 300));
    abort.abort();
    await expect(job).rejects.toThrow("The request was cancelled.");
    expect(fake.seen.cancelled).toEqual(["job_1"]);
    // sd-server stops when its recipe unloads.
    await sdcpp.unload({ id: "recipe:a" } as never);
    expect(JSON.parse(readFileSync(join(serving, "sdcpp.json"), "utf8"))).toEqual({ run: false });
  });
});

describe("the image API", () => {
  async function stack(o: { sdcpp?: boolean; files?: Record<string, Buffer>; gpuGb?: number; gpus?: number; broken?: number; hold?: () => Promise<void> } = {}) {
    const models = folder({
      [`${Z}/diffusion_models/z.safetensors`]: Z_DIFFUSION, [`${Z}/text_encoders/qwen_3_4b.safetensors`]: QWEN3, [`${Z}/vae/ae.safetensors`]: FLUX_VAE,
      "shared/flux1-schnell-fp8.safetensors": FLUX_CKPT, "shared/style.safetensors": Z_LORA, ...o.files,
    });
    // A ComfyUI per GPU, as gate.py runs them.
    const comfyFakes = await Promise.all(Array.from({ length: o.gpus ?? 1 }, () => fakeComfy({ hold: o.hold })));
    open.push(...comfyFakes);
    const comfyFake = comfyFakes[0]!;
    const lines: string[] = [];
    const log = (event: string, fields?: object) => void lines.push(JSON.stringify({ event, ...fields }));
    const h = await startHost({ log, modelsDir: models });
    open.push(h.host);
    const gpus = new FakeGpus(comfyFakes.map(() => o.gpuGb ?? 24));
    const backend = new FakeBackend(gpus);
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    // `broken`: a GPU whose ComfyUI's PyTorch has no kernels for it, as gate.py reports.
    const gate = (gpu: number) => {
      if (gpu !== o.broken) return undefined;
      const status = join(serving, `comfyui-status-${gpu}.json`);
      writeFileSync(status, JSON.stringify({ attempt: null, unsupported: "No kernels for this GPU." }));
      return { state: join(serving, `comfyui-${gpu}.json`), status };
    };
    const comfy = new ComfyGpus(new Map(comfyFakes.map((f, gpu) => [gpu, new Comfy(f.url, undefined, undefined, gate(gpu))])));
    const sdStatus = join(serving, "sdcpp-status.json");
    const sdFake = o.sdcpp ? await fakeSdServer(serving, sdStatus) : null;
    if (sdFake) open.push(sdFake);
    const sdcpp = sdFake ? new SdCpp(sdFake.url, { serving, status: sdStatus }) : null;
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: backend, vllm: backend, comfyui: sdcpp ?? comfy }, state: h.host.state, log });
    h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log });
    const book = new RecipeBook(h.dataDir, TEMPLATES, STARTERS);
    h.host.images = new Images({ book, runtime: h.host.runtime, comfy, sdcpp, downloads: null, modelsDir: models, serving, log });
    h.host.runtime.afterScan = () => h.host.images!.scan();
    await h.host.runtime.start();
    const code: string = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: h.local, path: "/dashboard/pairing", method: "POST", headers: { host: "127.0.0.1:7236" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d).code));
      });
      r.end();
    });
    const me = lyrica();
    const pinned = await pair(h.tls, me, code);
    const api = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => call({ port: h.tls, path, identity: me, pinned, ...init });
    return { ...h, api, lines, comfyFake, comfyFakes, sdFake, book, models, scheduler };
  }

  it("makes images with stable-diffusion.cpp in ComfyUI's place", async () => {
    const s = await stack({ sdcpp: true });
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const z: Recipe = body.recipes.find((r: Recipe) => r.arch === "z-image");
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });

    const made = await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: MARKER, count: 2, seed: 11 } });
    expect(made.status).toBe(200);
    expect(made.body.images).toHaveLength(2);
    expect(Buffer.from(made.body.images[0].png, "base64")).toEqual(PNG);
    // sd.cpp makes the second image from the next seed.
    expect(made.body.images.map((i: { seed: number }) => i.seed)).toEqual([11, 12]);
    // sd-server started with the recipe's parts, and got the recipe's defaults in its own names.
    expect(s.sdFake!.seen.started).toEqual([[
      "--flash-attn", "off", "--type", "q8_0", "--diffusion-model", join(s.models, `${Z}/diffusion_models/z.safetensors`),
      "--llm", join(s.models, `${Z}/text_encoders/qwen_3_4b.safetensors`),
      "--vae", join(s.models, `${Z}/vae/ae.safetensors`),
    ]]);
    expect(s.sdFake!.seen.jobs[0]).toMatchObject({
      prompt: MARKER, width: 1024, height: 1024, seed: 11, batch_count: 2, output_format: "png",
      sample_params: { sample_steps: 8, sample_method: "res_multistep", scheduler: "simple", flow_shift: 3, guidance: { txt_cfg: 1 } },
    });
    // A second job for the same recipe doesn't start it again.
    await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "again" } });
    expect(s.sdFake!.seen.started).toHaveLength(1);
    expect(s.comfyFake.seen.prompts).toHaveLength(0);
    // Once the card's tensor cores run at full rate, the next job starts it again with F16 and flash attention.
    s.sdFake!.seen.tensor = "full";
    await new Promise((r) => setTimeout(r, 100));
    await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "unlocked" } });
    expect(s.sdFake!.seen.started[1]!.slice(0, 4)).toEqual(["--flash-attn", "on", "--type", "f16"]);

    // The list offers only what sd.cpp can run, so Lyrica's router never picks this host for the rest.
    const copy = (await s.api(`/host/v1/recipes/${z.id}/copy`, { body: { name: "Styled" } })).body;
    await s.api(`/host/v1/recipes/${copy.id}`, { method: "PATCH", body: { op: "addLora", file: "shared/style.safetensors", strength: 0.8 } });
    const listed = (await s.api("/host/v1/recipes")).body.recipes;
    expect(listed.find((r: Recipe) => r.id === z.id)).toMatchObject({ does: ["create"] });
    expect(listed.find((r: Recipe) => r.id === z.id)).not.toHaveProperty("unsupported");
    expect(listed.find((r: Recipe) => r.id === copy.id)).toMatchObject({ does: [], unsupported: expect.stringContaining("LoRAs aren't supported") });

    expect(s.lines.join("\n")).not.toContain(MARKER);
    for (const f of readdirSync(s.dataDir)) expect(readFileSync(join(s.dataDir, f), "utf8")).not.toContain(MARKER);
  });

  it("reports a tagged job's progress while it runs, and forgets it once it ends", async () => {
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    const s = await stack({ hold: () => held });
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const z: Recipe = body.recipes.find((r: Recipe) => r.arch === "z-image");
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });
    const token = "job-0123456789abcdef";
    const made = s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x" }, headers: { "x-lyrica-job": token } });
    // The one sampler is at step 1 of 2: half of sampling, which is 95% of the job.
    let state: { state: string; progress: number | null } | undefined;
    for (let i = 0; i < 100 && state?.progress == null; i++) {
      const r = await s.api(`/host/v1/jobs/${token}`);
      if (r.status === 200) state = r.body;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state).toEqual({ state: "running", progress: 0.475 });
    finish();
    expect((await made).status).toBe(200);
    expect((await s.api(`/host/v1/jobs/${token}`)).body.error.code).toBe("not_found");
    expect((await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x" }, headers: { "x-lyrica-job": "short" } })).body.error.code).toBe("invalid");
  });

  it("runs a job on each image GPU at once, each GPU's copy of the recipe its own model", async () => {
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    const s = await stack({ gpus: 2, hold: () => held });
    const z: Recipe = (await s.api("/host/v1/recipes?state=proposed")).body.recipes.find((r: Recipe) => r.arch === "z-image");
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });
    const first = s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "one" } });
    const second = s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "two" } });
    // Both are sampling, one on each GPU's ComfyUI, while neither is done.
    for (let i = 0; i < 200 && s.comfyFakes.some((f) => !f.seen.prompts.length); i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.comfyFakes.map((f) => f.seen.prompts.length)).toEqual([1, 1]);
    const status = (await s.scheduler.status()) as { index: number; models: { id: string; busy: boolean }[] }[];
    expect(status.map((g) => g.models.map((m) => [m.id, m.busy]))).toEqual([[[`recipe:${z.id}@gpu0`, true]], [[`recipe:${z.id}@gpu1`, true]]]);
    finish();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    // With both idle and both holding the recipe, the next goes to the first listed.
    await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "three" } });
    expect(s.comfyFakes.map((f) => f.seen.prompts.length)).toEqual([2, 1]);
  });

  it("sends no job to an image GPU its ComfyUI can't run on", async () => {
    const s = await stack({ gpus: 2, broken: 0 });
    const z: Recipe = (await s.api("/host/v1/recipes?state=proposed")).body.recipes.find((r: Recipe) => r.arch === "z-image");
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });
    const made = await Promise.all([1, 2].map((n) => s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: `p${n}` } })));
    expect(made.map((m) => m.status)).toEqual([200, 200]);
    expect(s.comfyFakes.map((f) => f.seen.prompts.length)).toEqual([0, 2]);
    expect((await s.api("/host/v1/status")).body.problems).toContain("Images on GPU 0: No kernels for this GPU.");
  });

  it("makes images only from a confirmed recipe and its parameters", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const z: Recipe & { ready: boolean } = body.recipes.find((r: Recipe) => r.arch === "z-image");
    expect(z.ready).toBe(true);
    // Lyrica's router reads how many references a recipe takes, so a call with them skips one that takes none.
    expect((z as { references?: number }).references).toBe(0);

    // A proposal does nothing until it is confirmed.
    expect((await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x" } })).body.error.code).toBe("not_found");
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });

    // Only the listed fields: no workflow, no node, no part.
    for (const extra of [{ workflow: {} }, { parts: [] }, { lora: "x" }, { sampler: "euler" }]) {
      const reply = await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x", ...extra } });
      expect(reply.body.error.code).toBe("invalid");
    }
    expect((await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x", width: 1000 } })).body.error.message).toMatch(/multiple of 16/);
    expect((await s.api("/host/v1/images/edit", { body: { recipe: z.id, prompt: "x", image: PNG.toString("base64") } })).body.error.message).toBe("That recipe doesn't edit images.");
    expect((await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x", references: [PNG.toString("base64")] } })).body.error.message).toBe("This recipe doesn't take reference images.");

    const made = await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: MARKER, count: 2, seed: 11 } });
    expect(made.status).toBe(200);
    expect(made.body.images).toHaveLength(2);
    expect(made.body.images[0]).toMatchObject({ width: 1, height: 1, seed: 11 });
    expect(Buffer.from(made.body.images[0].png, "base64")).toEqual(PNG);

    const sent = s.comfyFake.seen.prompts[0];
    const classes = new Set(Object.values(sent as Record<string, { class_type: string }>).map((n) => n.class_type));
    expect([...classes].sort()).toEqual(["CLIPLoader", "CLIPTextEncode", "EmptySD3LatentImage", "KSampler", "ModelSamplingAuraFlow", "SaveImageWebsocket", "UNETLoader", "VAEDecode", "VAELoader"]);
    expect(sent.sample.inputs.steps).toBe(8);
    expect(s.comfyFake.seen.historyCleared).toBe(1);

    const usage = await s.api("/host/v1/usage");
    expect(usage.body.models).toContainEqual(expect.objectContaining({ id: z.id, images: 2 }));
    expect(s.lines.join("\n")).not.toContain(MARKER);
    for (const f of readdirSync(s.dataDir)) expect(readFileSync(join(s.dataDir, f), "utf8")).not.toContain(MARKER);
  });

  it("lists a recipe too big for the image GPU as doing nothing, and says why", async () => {
    // Each recipe needs half a GiB over its parts; this GPU has a quarter.
    const s = await stack({ gpuGb: 0.25 });
    const listed = (await s.api("/host/v1/recipes")).body.recipes;
    const z = listed.find((r: Recipe) => r.arch === "z-image");
    expect(z).toMatchObject({ does: [], unsupported: expect.stringMatching(/needs about 0\.5 GB on GPU 0/) });
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });
    const made = await s.api("/host/v1/images/create", { body: { recipe: z.id, prompt: "x" } });
    expect([made.status, made.body.error.code]).toEqual([413, "too_big"]);
    expect(s.comfyFake.seen.prompts).toHaveLength(0);
  });

  it("lists a recipe whose template this host doesn't have as doing nothing, and still lists the rest", async () => {
    const s = await stack();
    const z = s.book.all().find((r) => r.arch === "z-image")!;
    s.book.all().push({ ...z, id: "00000000-0000-4000-8000-000000000001", name: "From a newer host", template: "future-model" });
    const listed = (await s.api("/host/v1/recipes")).body.recipes;
    expect(listed.find((r: Recipe) => r.id === z.id)).not.toHaveProperty("unsupported");
    expect(listed.find((r: Recipe) => r.name === "From a newer host")).toMatchObject({ does: [], ready: false, unsupported: expect.stringContaining("no template future-model") });
  });

  it("makes a long video and extends a clip as chained clips in one GPU hold, and refuses what it can't chain", async () => {
    const s = await stack({ files: {
      "v/minimax_h3_fl2va_pruned_int8_convrot.safetensors": H3, "v/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": H3_LORA,
      "v/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": QWEN3VL_32B, "v/minimax_h3_video_vae_int8_convrot.safetensors": H3_VAE,
      "v/minimax_h3_audio_vae_fp32.safetensors": H3_AUDIO_VAE,
      "w/wan2.2_ti2v_5B_fp16.safetensors": WAN_5B, "w/wan2.2_vae.safetensors": WAN22_VAE, "w/umt5.safetensors": UMT5,
    } });
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const h3r: Recipe = body.recipes.find((r: Recipe) => r.arch === "minimax-h3");
    const wan: Recipe = body.recipes.find((r: Recipe) => r.arch === "wan2.2-5b");
    expect(h3r).toMatchObject({ does: ["video", "animate", "extend"], video: { maxSeconds: 15, longestSeconds: 60 } });
    expect(wan).toMatchObject({ does: ["video", "animate"], video: { maxSeconds: 8, longestSeconds: 8 } });
    await s.api("/host/v1/recipes/confirm", { body: { ids: [h3r.id, wan.id] } });

    // 16 seconds: a first clip, then two continuations, each from the clip so far, with the next seed.
    const made = await s.api("/host/v1/videos/create", { body: { recipe: h3r.id, prompt: MARKER, duration: 16, seed: 5 } });
    expect(made.status).toBe(200);
    const [first, second, third] = s.comfyFake.seen.prompts;
    expect(s.comfyFake.seen.prompts).toHaveLength(3);
    expect(first.cond.inputs.length).toBe(141);
    // Each later clip's prompt says it goes on from the clip so far: the prompt alone would play the video again from its start.
    expect(first.cond.inputs.prompt).toBe(MARKER);
    expect(second.cond.inputs.prompt).toBe(`${TEMPLATES.get("minimax-h3")!.continuation!.promptPrefix}${MARKER}`);
    expect(TEMPLATES.get("minimax-h3")!.continuation!.promptPrefix).toMatch(/no cut/);
    expect(first).not.toHaveProperty("anchor");
    expect(second.previous.inputs.file).toBe("lyrica-previous.mp4");
    expect([second.cond.inputs.length, third.cond.inputs.length]).toEqual([141, 158]);
    expect([first.noise.inputs.noise_seed, second.noise.inputs.noise_seed, third.noise.inputs.noise_seed]).toEqual([5, 6, 7]);
    // The fake's clip has no video track, so the length is counted: each continuation adds its frames past the overlap.
    expect(made.body.video).toMatchObject({ frames: 141 + (141 - 22) + (158 - 22), fps: 24, audio: true, seed: 5 });
    expect(s.comfyFake.seen.uploads.filter((u: string) => u === "lyrica-previous.mp4").length).toBe(4);

    // Extending adds continuations only, at the clip's own size, and reads the result's length from the clip.
    const before = s.comfyFake.seen.prompts.length;
    const extended = await s.api("/host/v1/videos/create", { body: { recipe: h3r.id, prompt: "x", extend: clip(1024, 576, 120, 24).toString("base64"), duration: 4 } });
    expect(extended.status).toBe(200);
    const added = s.comfyFake.seen.prompts.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].cond.inputs).toMatchObject({ width: 1024, height: 576, length: 124 });
    expect(extended.body.video.frames).toBe(120 + 124 - 22);

    const refused = async (extra: object, recipe = h3r.id) => (await s.api("/host/v1/videos/create", { body: { recipe, prompt: "x", ...extra } })).body.error.message;
    expect(await refused({ duration: 61 })).toMatch(/from 1 to 60/);
    expect(await refused({ duration: 9 }, wan.id)).toMatch(/from 1 to 8/);
    expect(await refused({ extend: clip(1024, 576, 120, 24).toString("base64") }, wan.id)).toBe("That recipe can't extend a clip.");
    expect(await refused({ extend: clip(1024, 576, 80, 16).toString("base64") })).toMatch(/16 fps; this recipe continues 24 fps/);
    expect(await refused({ extend: clip(1000, 576, 120, 24).toString("base64") })).toMatch(/steps of 32/);
    expect(await refused({ extend: clip(1024, 576, 120, 24).toString("base64"), width: 1024 })).toMatch(/keeps its own size/);
    expect(await refused({ extend: clip(1024, 576, 120, 24).toString("base64"), image: PNG.toString("base64") })).toMatch(/no image/);
    expect(await refused({ extend: PNG.toString("base64") })).toMatch(/video track/);
    expect(s.lines.join("\n")).not.toContain(MARKER);
  });

  it("makes a clip and its poster from a video recipe, timed and sized by its template", async () => {
    const W = "lyrica/huggingface/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files";
    const s = await stack({ files: {
      [`${W}/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`]: WAN_5B, [`${W}/vae/wan2.2_vae.safetensors`]: WAN22_VAE, "other/umt5.safetensors": UMT5,
    } });
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const wan: Recipe & { video: { fps: number; audio: boolean } } = body.recipes.find((r: Recipe) => r.arch === "wan2.2-5b");
    const z: Recipe = body.recipes.find((r: Recipe) => r.arch === "z-image");
    expect(wan).toMatchObject({ does: ["video", "animate"], ready: true, video: { fps: 24, audio: false } });
    await s.api("/host/v1/recipes/confirm", { body: { ids: [wan.id, z.id] } });

    const made = await s.api("/host/v1/videos/create", { body: { recipe: wan.id, prompt: MARKER, seed: 5 } });
    expect(made.status).toBe(200);
    expect(Buffer.from(made.body.video.mp4, "base64")).toEqual(MP4);
    expect(Buffer.from(made.body.poster, "base64")).toEqual(PNG);
    // 5 seconds at 24 fps on Wan's grid of 4 frames plus 1; the poster gives the size.
    expect(made.body.video).toMatchObject({ frames: 121, fps: 24, duration: 121 / 24, audio: false, seed: 5, width: 1, height: 1 });
    const sent = s.comfyFake.seen.prompts[0];
    expect(sent.latent.inputs).toEqual({ vae: ["load_vae", 0], width: 1280, height: 704, length: 121, batch_size: 1 });
    expect(sent.sample.inputs).toMatchObject({ steps: 20, cfg: 5, sampler_name: "uni_pc" });
    expect(Object.keys(sent)).not.toContain("load");
    expect(s.comfyFake.seen.historyCleared).toBe(1);

    // Animating: the first frame is uploaded, and with no size asked the clip takes the image's shape at the recipe's area.
    const animated = await s.api("/host/v1/videos/create", { body: { recipe: wan.id, prompt: "x", image: PNG.toString("base64"), duration: 2 } });
    expect(animated.status).toBe(200);
    const second = s.comfyFake.seen.prompts[1];
    expect(second.latent.inputs).toMatchObject({ width: 960, height: 960, length: 49, start_image: ["scale", 0] });
    expect(second.load.inputs.image).toBe("lyrica-image.png");
    expect(s.comfyFake.seen.uploads).toEqual(["lyrica-image.png", "lyrica-image.png"]);

    // A size is snapped to the template's step, and an aspect ratio keeps the recipe's area in its shape.
    await s.api("/host/v1/videos/create", { body: { recipe: wan.id, prompt: "x", width: 1360, height: 768 } });
    expect(s.comfyFake.seen.prompts[2].latent.inputs).toMatchObject({ width: 1376, height: 768 });
    await s.api("/host/v1/videos/create", { body: { recipe: wan.id, prompt: "x", aspectRatio: "9:16" } });
    expect(s.comfyFake.seen.prompts[3].latent.inputs).toMatchObject({ width: 704, height: 1280 });

    const refused = async (path: string, extra: object) => (await s.api(path, { body: { recipe: wan.id, prompt: "x", ...extra } })).body.error.message;
    expect(await refused("/host/v1/videos/create", { width: 100 })).toMatch(/from 256 to 2048/);
    expect(await refused("/host/v1/videos/create", { aspectRatio: "16:9", width: 1024 })).toMatch(/not both/);
    expect(await refused("/host/v1/videos/create", { aspectRatio: "wide" })).toMatch(/width:height/);
    expect(await refused("/host/v1/videos/create", { duration: 9 })).toMatch(/from 1 to 8/);
    expect(await refused("/host/v1/videos/create", { count: 2 })).toMatch(/count/);
    expect(await refused("/host/v1/images/create", {})).toBe("That recipe doesn't create images.");
    expect((await s.api("/host/v1/videos/create", { body: { recipe: z.id, prompt: "x" } })).body.error.message).toBe("That recipe doesn't make videos.");

    expect(s.lines.join("\n")).not.toContain(MARKER);
    for (const f of readdirSync(s.dataDir)) expect(readFileSync(join(s.dataDir, f), "utf8")).not.toContain(MARKER);
  });

  it("moves an image as a driving clip moves, for no longer than the clip, and leaves nothing of either", async () => {
    const s = await stack({ files: {
      "s/wan2.1_14B_SCAIL_2_int8_convrot.safetensors": SCAIL2, "s/wan2.1_SCAIL_2_DPO_lora_bf16.safetensors": WAN_LORA,
      "s/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors": WAN_LORA, "s/umt5.safetensors": UMT5, "s/wan_2.1_vae.safetensors": QWEN_VAE,
      "s/clip_vision_h.safetensors": CLIP_VISION_H, "s/sam3.1_multiplex_fp16.safetensors": SAM3,
    } });
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const scail: Recipe & { video: { fps: number } } = body.recipes.find((r: Recipe) => r.arch === "scail2");
    expect(scail).toMatchObject({ template: "scail2", does: ["motion"], ready: true, video: { fps: 16, sizeStep: 32, maxSeconds: 5 } });
    const z: Recipe = body.recipes.find((r: Recipe) => r.arch === "z-image");
    await s.api("/host/v1/recipes/confirm", { body: { ids: [scail.id, z.id] } });

    // A 3-second clip gives 3 seconds of moves, however long was asked: 49 frames on Wan's grid at 16 fps.
    const made = await s.api("/host/v1/videos/create", { body: { recipe: scail.id, prompt: MARKER, image: PNG.toString("base64"), drive: mp4(3).toString("base64"), seed: 9 } });
    expect(made.status).toBe(200);
    expect(made.body.video).toMatchObject({ frames: 49, fps: 16, audio: false, seed: 9 });
    const sent = s.comfyFake.seen.prompts[0];
    expect(sent.drive.inputs).toEqual({ file: "lyrica-drive.mp4" });
    expect(sent.frames.inputs).toEqual({ video: ["drive", 0], fps: 16, frames: 49 });
    // The reference image's shape at the recipe's area, in steps of 32.
    expect(sent.scail.inputs).toMatchObject({ width: 960, height: 960, length: 49, replacement_mode: false, clip_vision_output: ["vision", 0], vae: ["load_vae", 0] });
    expect(sent.pose.inputs).toMatchObject({ "resize_type.width": 960, "resize_type.height": 960, input: ["frames", 0] });
    // The DPO LoRA, then the speed LoRA at 0.8, as ComfyUI's own template has them.
    expect(sent.lora_dpo.inputs).toMatchObject({ model: ["load_model", 0], strength_model: 1 });
    expect(sent.lora_speed.inputs).toMatchObject({ model: ["lora_dpo", 0], strength_model: 0.8 });
    expect(sent.shift.inputs.model).toEqual(["lora_speed", 0]);
    expect(sent.load_segmenter).toEqual({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "s/sam3.1_multiplex_fp16.safetensors" } });
    expect(sent.who_drives.inputs).toEqual({ text: "person", clip: ["load_segmenter", 1] });
    expect(sent.track_drive.inputs.model).toEqual(["load_segmenter", 0]);
    expect(sent.load_clip_vision).toEqual({ class_type: "CLIPVisionLoader", inputs: { clip_name: "s/clip_vision_h.safetensors" } });
    expect(sent.sample.inputs).toMatchObject({ noise_seed: 9, cfg: 1, model: ["shift", 0] });
    expect(JSON.stringify(sent)).not.toContain("$");
    // Both uploads are written over once the job is done.
    expect(s.comfyFake.seen.uploads).toEqual(["lyrica-image.png", "lyrica-drive.mp4", "lyrica-image.png", "lyrica-drive.mp4"]);
    expect(s.comfyFake.seen.uploadBodies[1]!.includes("mvhd")).toBe(true);
    expect(s.comfyFake.seen.uploadBodies[3]!.includes("mvhd")).toBe(false);

    // A longer clip is cut to the recipe's longest; a version 1 header reads the same.
    await s.api("/host/v1/videos/create", { body: { recipe: scail.id, prompt: "x", image: PNG.toString("base64"), drive: mp4(12, 1).toString("base64") } });
    expect(s.comfyFake.seen.prompts[1].frames.inputs.frames).toBe(81);

    const refused = async (extra: object, recipe = scail.id) => (await s.api("/host/v1/videos/create", { body: { recipe, prompt: "x", ...extra } })).body.error.message;
    expect(await refused({ drive: mp4(3).toString("base64") })).toMatch(/image is missing/);
    expect(await refused({ image: PNG.toString("base64") })).toMatch(/give it both/);
    expect(await refused({ image: PNG.toString("base64"), drive: PNG.toString("base64") })).toMatch(/isn't an MP4/);
    expect(await refused({ image: PNG.toString("base64"), drive: mp4(3).toString("base64") }, z.id)).toBe("That recipe doesn't make videos.");
    expect(s.lines.join("\n")).not.toContain(MARKER);
  });

  it("reads a clip's length from its movie header, and nothing else as a clip", () => {
    expect(mp4Seconds(mp4(3))).toBe(3);
    expect(mp4Seconds(mp4(7, 1))).toBe(7);
    expect(mp4Seconds(PNG)).toBeNull();
    expect(mp4Seconds(mp4(3).subarray(0, 40))).toBeNull();
  });

  it("saves Use for through the recipe API and keeps it when the book reopens", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/recipes");
    const r = body.recipes[0];
    expect(r.useFor).toBe("both");
    for (const useFor of ["fast", "quality", "both"]) {
      const saved = await s.api(`/host/v1/recipes/${r.id}`, { method: "PATCH", body: { op: "useFor", useFor } });
      expect(saved.status).toBe(200);
      expect(saved.body.useFor).toBe(useFor);
      expect(new RecipeBook(s.dataDir, TEMPLATES, STARTERS).get(r.id).useFor).toBe(useFor);
    }
  });

  it("lists parts with the recipes using them", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/parts");
    const vae = body.parts.find((p: { file: string }) => p.file.endsWith("ae.safetensors"));
    expect(vae).toMatchObject({ role: "vae", arch: "flux", downloaded: false, usedBy: [expect.any(String)] });
  });

  it("deletes a recipe but keeps parts another recipe uses or that the host didn't download", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/recipes");
    const z = body.recipes.find((r: Recipe) => r.arch === "z-image");
    await s.api(`/host/v1/recipes/${z.id}/confirm`, { body: {} });
    const copy = await s.api(`/host/v1/recipes/${z.id}/copy`, { body: { name: "Z copy" } });
    const deleted = await s.api(`/host/v1/recipes/${z.id}`, { method: "DELETE" });
    expect(deleted.body.deleted).toEqual([]);
    expect(deleted.body.kept).toHaveLength(3);
    expect(deleted.body.kept[0]).toEqual({ file: `${Z}/diffusion_models/z.safetensors`, reason: "Used by Z copy." });
    const second = await s.api(`/host/v1/recipes/${copy.body.id}`, { method: "DELETE" });
    expect(second.body.kept.map((k: { reason: string }) => k.reason)).toEqual(["Not downloaded by the host.", "Not downloaded by the host.", "Not downloaded by the host."]);
  });

  it("keeps a part that is also a chat model when its recipe is deleted", async () => {
    const vl = "k/Qwen3VL-4B-Instruct-Q8_0.gguf";
    const s = await stack({ files: {
      "k/krea.gguf": ggufBytes({ "general.architecture": "krea2" }),
      [vl]: ggufBytes({ "general.architecture": "qwen3vl", "qwen3vl.embedding_length": 2560, "tokenizer.ggml.model": "gpt2" }),
    } });
    expect(s.host.runtime!.models.map((m) => m.id)).toContain(vl);
    s.host.runtime!.record.set(vl, { path: vl, size: 1, sha256: "x", verified: true, downloadedAt: "", source: "huggingface", repo: null, revision: null } as never);
    const krea = (await s.api("/host/v1/recipes")).body.recipes.find((r: Recipe) => r.arch === "krea2");
    const { body } = await s.api(`/host/v1/recipes/${krea.id}`, { method: "DELETE" });
    expect(body.deleted).toEqual([]);
    expect(body.kept).toContainEqual({ file: vl, reason: "Also a chat model." });
  });

  it("lists starters with which parts are here", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/starters");
    const z = body.starters.find((st: { id: string }) => st.id === "z-image-turbo");
    // The test folder holds two of its parts at their download paths, but not its diffusion model.
    expect(z.parts.map((p: { present: boolean }) => p.present)).toEqual([false, true, true]);
    expect(body.starters.map((st: { id: string }) => st.id)).toEqual([
      "flux-schnell", "krea2-turbo", "ltx-2.5-distilled", "minimax-h3-turbo", "qwen-image-2.1-turbo", "qwen-image-edit", "qwen-image", "scail-2", "sdxl", "seedvr2-3b", "seedvr2-7b",
      "wan2.2-i2v-14b-q5", "wan2.2-i2v-14b", "wan2.2-t2v-14b-q5", "wan2.2-t2v-14b", "wan2.2-ti2v-5b", "z-image-turbo",
    ]);
  });

  it("lists a starter for one backend only on hosts using it", async () => {
    const comfy = await stack();
    expect((await comfy.api("/host/v1/starters")).body.starters.map((st: { id: string }) => st.id)).not.toContain("krea2-turbo-q5");
    expect((await comfy.api("/host/v1/starters/krea2-turbo-q5/install", { body: {} })).status).toBe(404);
    const sd = await stack({ sdcpp: true });
    const onSd = (await sd.api("/host/v1/starters")).body.starters.map((st: { id: string }) => st.id);
    expect(onSd).toContain("krea2-turbo-q5");
    // sd.cpp makes no videos, so the video starters show only on ComfyUI hosts.
    expect(onSd).not.toContain("wan2.2-ti2v-5b");
  });
});
