import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Comfy } from "../src/comfy.ts";
import { Images, inputImage } from "../src/images.ts";
import { scanParts } from "../src/parts.ts";
import { RecipeBook, loadStarters, type Recipe } from "../src/recipes.ts";
import { Runtime } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fill, loadTemplates } from "../src/templates.ts";
import { FakeBackend, FakeGpus, PNG, fakeComfy, safetensors } from "./fakes.ts";
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

describe("the image API", () => {
  async function stack() {
    const models = folder({
      [`${Z}/diffusion_models/z.safetensors`]: Z_DIFFUSION, [`${Z}/text_encoders/qwen_3_4b.safetensors`]: QWEN3, [`${Z}/vae/ae.safetensors`]: FLUX_VAE,
      "shared/flux1-schnell-fp8.safetensors": FLUX_CKPT,
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
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: backend, vllm: backend, comfyui: comfy }, state: h.host.state, log });
    h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log });
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const book = new RecipeBook(h.dataDir, TEMPLATES, STARTERS);
    h.host.images = new Images({ book, runtime: h.host.runtime, comfy, downloads: null, modelsDir: models, serving, comfyGpu: 0, log });
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
    return { ...h, api, lines, comfyFake, book };
  }

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

  it("lists starters with which parts are here", async () => {
    const s = await stack();
    const { body } = await s.api("/host/v1/starters");
    const z = body.starters.find((st: { id: string }) => st.id === "z-image-turbo");
    // The test folder holds two of its parts at their download paths, but not its diffusion model.
    expect(z.parts.map((p: { present: boolean }) => p.present)).toEqual([false, true, true]);
    expect(body.starters.map((st: { id: string }) => st.id)).toEqual(["flux-schnell", "qwen-image-edit", "qwen-image", "sdxl", "seedvr2-3b", "seedvr2-7b", "z-image-turbo"]);
  });
});
