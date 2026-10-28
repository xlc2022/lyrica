import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Comfy } from "../src/comfy.ts";
import { Images, inputImage, recipeSize } from "../src/images.ts";
import { ggufBytes } from "../src/gguf.ts";
import { scanParts } from "../src/parts.ts";
import { RecipeBook, loadStarters, type Recipe } from "../src/recipes.ts";
import { Runtime } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fill, loadTemplates } from "../src/templates.ts";
import { SdCpp, sdcppArgs, sdcppJob } from "../src/sdcpp.ts";
import { FakeBackend, FakeGpus, PNG, fakeComfy, fakeSdServer, safetensors } from "./fakes.ts";
import { call, lyrica, pair, startHost } from "./helpers.ts";

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
    ], [], { negativePrompt: "", ...starter.defaults, prompt: "x", count: 2, seed: 1, image: "lyrica-image.png", reference1: "lyrica-ref.png" });
    expect(qi21.load_clip).toEqual({ class_type: "CLIPLoader", inputs: { clip_name: "vl.safetensors", type: "qwen_image" } });
    expect(qi21.encode!.inputs).toMatchObject({ "images.image_1": ["load", 0], "images.image_2": ["ref1", 0], resolution: 1024 });
    expect(qi21.encode!.inputs).not.toHaveProperty("images.image_3");
    expect(qi21.sigmas!.inputs.sigmas).toMatch(/^1\.0, .*, 0$/);
    expect(qi21.batch!.inputs).toEqual({ samples: ["encode", 2], amount: 2 });
    expect(qi21.sample!.inputs.latent_image).toEqual(["batch", 0]);
    expect(qi21.save!.inputs.images).toEqual(["decode", 0]);
    expect(Object.keys(qi21)).not.toContain("inpaint");
    expect(JSON.stringify(qi21)).not.toContain("$");
    // A masked edit goes through LanPaint at about a megapixel, and only the masked part goes back into the original.
    const qi21Masked = fill(TEMPLATES.get("qwen-image-2.1")!, qi21Parts, [], { negativePrompt: "", ...starter.defaults, prompt: "x", count: 2, seed: 1, image: "lyrica-image.png", mask: "lyrica-mask.png" });
    // The mask grows a little, so the old outline at its edge is redrawn too.
    expect(qi21Masked.grown!.inputs).toMatchObject({ mask: ["mask", 0], expand: 24 });
    expect(qi21Masked.masked!.inputs).toMatchObject({ image: ["fit", 0], mask: ["grown", 0] });
    expect(qi21Masked.batch!.inputs.samples).toEqual(["masked", 0]);
    expect(qi21Masked.inpaint!.class_type).toBe("LanPaint_SamplerCustomAdvanced");
    expect(qi21Masked.inpaint!.inputs).toMatchObject({ guider: ["guider", 0], sigmas: ["sigmas", 0], latent_image: ["batch", 0] });
    expect(qi21Masked.merged!.inputs).toMatchObject({ samples: ["inpaint", 0], image: ["originals", 0], mask: ["grown", 0] });
    // The merge keeps as many images as the original has, so a batch repeats it.
    expect(qi21Masked.originals!.inputs).toEqual({ image: ["load", 0], amount: 2 });
    expect(qi21Masked.save!.inputs.images).toEqual(["merged", 0]);
    expect(JSON.stringify(qi21Masked)).not.toContain("$");

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
    const asked = () => JSON.parse(readFileSync(join(dir, "comfyui.json"), "utf8")) as { run: boolean; attempt?: string };
    const comfy = new Comfy(fake.url, undefined, undefined, { serving: dir, status });
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
    const comfy = new Comfy(fake.url, undefined, undefined, { serving: dir, status });
    expect(comfy.problem).toBe(why);
    await expect(comfy.load({ id: "a" } as never)).rejects.toMatchObject({ status: 503, message: why });
    expect(JSON.parse(readFileSync(join(dir, "comfyui.json"), "utf8")).run).toBe(false);
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

describe("stable-diffusion.cpp", () => {
  const part = (role: string, file: string, slot: string | null = null) => ({ role, slot, file, added: false }) as Recipe["parts"][number];

  it("gives sd-server each part under its own flag, and refuses what it can't run", () => {
    expect(sdcppArgs({ template: "flux", parts: [part("checkpoint", "f/flux.safetensors")], loras: [] }, "/models")).toEqual(["--type", "q8_0", "-m", "/models/f/flux.safetensors"]);
    expect(sdcppArgs({ template: "qwen-image", parts: [part("diffusion", "q/d.safetensors"), part("text_encoder", "q/te.safetensors", "qwen2.5vl"), part("vae", "q/v.safetensors")], loras: [] }, "/models"))
      .toEqual(["--type", "q8_0", "--diffusion-model", "/models/q/d.safetensors", "--llm", "/models/q/te.safetensors", "--vae", "/models/q/v.safetensors"]);
    // A GGUF main model keeps its own quantisation.
    expect(sdcppArgs({ template: "krea2", parts: [part("diffusion", "k/d.gguf"), part("text_encoder", "k/te.gguf", "qwen3vl"), part("vae", "k/v.safetensors")], loras: [] }, "/models"))
      .toEqual(["--diffusion-model", "/models/k/d.gguf", "--llm", "/models/k/te.gguf", "--vae", "/models/k/v.safetensors"]);
    expect(sdcppArgs({ template: "krea2", parts: [part("diffusion", "k/d.safetensors"), part("text_encoder", "k/te.safetensors", "qwen3vl"), part("vae", "k/v.safetensors")], loras: [] }, "/models"))
      .toEqual(["--type", "q8_0", "--diffusion-model", "/models/k/d.safetensors", "--llm", "/models/k/te.safetensors", "--vae", "/models/k/v.safetensors"]);
    expect(() => sdcppArgs({ template: "seedvr2", parts: [], loras: [] }, "/models")).toThrow(/no seedvr2 support/);
    expect(() => sdcppArgs({ template: "z-image", parts: [], loras: [{ file: "l.safetensors", strength: 1 }] }, "/models")).toThrow(/LoRAs/);
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
  async function stack(o: { sdcpp?: boolean; files?: Record<string, Buffer> } = {}) {
    const models = folder({
      [`${Z}/diffusion_models/z.safetensors`]: Z_DIFFUSION, [`${Z}/text_encoders/qwen_3_4b.safetensors`]: QWEN3, [`${Z}/vae/ae.safetensors`]: FLUX_VAE,
      "shared/flux1-schnell-fp8.safetensors": FLUX_CKPT, "shared/style.safetensors": Z_LORA, ...o.files,
    });
    const comfyFake = await fakeComfy();
    open.push(comfyFake);
    const lines: string[] = [];
    const log = (event: string, fields?: object) => void lines.push(JSON.stringify({ event, ...fields }));
    const h = await startHost({ log, modelsDir: models });
    open.push(h.host);
    const gpus = new FakeGpus([24]);
    const backend = new FakeBackend(gpus);
    const comfy = new Comfy(comfyFake.url);
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const sdStatus = join(serving, "sdcpp-status.json");
    const sdFake = o.sdcpp ? await fakeSdServer(serving, sdStatus) : null;
    if (sdFake) open.push(sdFake);
    const sdcpp = sdFake ? new SdCpp(sdFake.url, { serving, status: sdStatus }) : null;
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: backend, vllm: backend, comfyui: sdcpp ?? comfy }, state: h.host.state, log });
    h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log });
    const book = new RecipeBook(h.dataDir, TEMPLATES, STARTERS);
    h.host.images = new Images({ book, runtime: h.host.runtime, comfy, sdcpp, downloads: null, modelsDir: models, serving, comfyGpu: 0, log });
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
    const api = (path: string, init: { method?: string; body?: unknown } = {}) => call({ port: h.tls, path, identity: me, pinned, ...init });
    return { ...h, api, lines, comfyFake, sdFake, book, models };
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
      "--type", "q8_0", "--diffusion-model", join(s.models, `${Z}/diffusion_models/z.safetensors`),
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

  it("makes images only from a confirmed recipe and its parameters", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/recipes?state=proposed");
    const z: Recipe & { ready: boolean } = body.recipes.find((r: Recipe) => r.arch === "z-image");
    expect(z.ready).toBe(true);

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
    expect(body.starters.map((st: { id: string }) => st.id)).toEqual(["flux-schnell", "krea2-turbo", "qwen-image-2.1-turbo", "qwen-image-edit", "qwen-image", "sdxl", "seedvr2-3b", "seedvr2-7b", "z-image-turbo"]);
  });

  it("lists a starter for one backend only on hosts using it", async () => {
    const comfy = await stack();
    expect((await comfy.api("/host/v1/starters")).body.starters.map((st: { id: string }) => st.id)).not.toContain("krea2-turbo-q5");
    expect((await comfy.api("/host/v1/starters/krea2-turbo-q5/install", { body: {} })).status).toBe(404);
    const sd = await stack({ sdcpp: true });
    expect((await sd.api("/host/v1/starters")).body.starters.map((st: { id: string }) => st.id)).toContain("krea2-turbo-q5");
  });
});
