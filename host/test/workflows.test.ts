import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Comfy, ComfyGpus } from "../src/comfy.ts";
import { Images } from "../src/images.ts";
import type { Part } from "../src/parts.ts";
import { loadStarters, RecipeBook } from "../src/recipes.ts";
import { Runtime } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fill, loadTemplates, type Template } from "../src/templates.ts";
import { checkTemplate, importWorkflow, partSpecs, Workflows } from "../src/workflows.ts";
import { FakeBackend, FakeGpus, fakeComfy, safetensors } from "./fakes.ts";
import { call, lyrica, pair, startHost } from "./helpers.ts";

const TEMPLATES = () => loadTemplates(new URL("../workflows/", import.meta.url).pathname);
const STARTERS = loadStarters(new URL("../recipes/", import.meta.url).pathname);
const MARKER = "teal-heron-8812";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

const FLUX_CKPT = safetensors({ "model.diffusion_model.double_blocks.0.img_attn.qkv.weight": {}, "vae.decoder.conv_in.weight": {}, "text_encoders.t5xxl.x": {} });
const FLUX_LORA = safetensors({ "diffusion_model.double_blocks.0.img_attn.qkv.lora_A.weight": {}, "diffusion_model.double_blocks.0.img_attn.qkv.lora_B.weight": {} });

/** A text-to-image workflow as ComfyUI's Export (API) writes it, from the user's own machine. */
function exported(prompt = "a lighthouse at dusk") {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-schnell-fp8.safetensors" }, _meta: { title: "Load Checkpoint" } },
    "10": { class_type: "LoraLoaderModelOnly", inputs: { model: ["4", 0], lora_name: "Styles\\flux-style.safetensors", strength_model: 0.7 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
    "3": { class_type: "KSampler", inputs: { model: ["10", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0], seed: 42, steps: 6, cfg: 1.5, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "ComfyUI" } },
    "11": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
  };
}

const PARTS: Part[] = [
  { file: "shared/flux1-schnell-fp8.safetensors", size: 1, format: "safetensors", role: "checkpoint", slot: null, arch: "flux", precision: "fp8" },
  { file: "shared/flux-style.safetensors", size: 1, format: "safetensors", role: "lora", slot: null, arch: "flux", precision: "bf16" },
  { file: "lyrica/huggingface/a/b/unet_high.safetensors", size: 1, format: "safetensors", role: "diffusion", slot: "high", arch: "wan2.2-t2v-14b", precision: "fp8" },
];

describe("importing a workflow", () => {
  it("turns an export's loaders into parts, its saves into the websocket, and guesses its blanks", () => {
    const d = importWorkflow(exported(MARKER), "Flux styled", "create", PARTS);
    expect(d.loaders).toBeNull();
    expect(d.arch).toBe("flux");
    expect(d.parts).toEqual([{ role: "checkpoint", slot: null, file: "shared/flux1-schnell-fp8.safetensors", added: false }]);
    // The LoRA straight off the model, named with the user's own folder, is this host's file.
    expect(d.loras).toEqual([{ file: "shared/flux-style.safetensors", strength: 0.7 }]);
    expect(Object.keys(d.workflow).sort()).toEqual(["3", "5", "6", "7", "8", "9"]);
    expect(d.dropped).toEqual(["11 (PreviewImage)"]);
    expect(d.workflow["9"]).toEqual({ class_type: "SaveImageWebsocket", inputs: { images: ["8", 0] } });
    expect(d.workflow["3"]!.inputs).toMatchObject({ model: "$model", seed: "$seed", steps: "$steps", cfg: "$cfg", sampler_name: "$sampler", scheduler: "$scheduler", denoise: 1 });
    expect(d.workflow["6"]!.inputs).toEqual({ text: "$prompt", clip: "$clip" });
    expect(d.workflow["7"]!.inputs).toEqual({ text: "$negativePrompt", clip: "$clip" });
    expect(d.workflow["5"]!.inputs).toEqual({ width: "$width", height: "$height", batch_size: "$count" });
    expect(d.workflow["8"]!.inputs.vae).toBe("$vae");
    // What it replaced becomes the defaults; the prompt itself is dropped.
    expect(d.defaults).toEqual({ steps: 6, cfg: 1.5, sampler: "euler", scheduler: "simple", negativePrompt: "blurry", width: 832, height: 1216 });
    expect(JSON.stringify(d)).not.toContain(MARKER);
    expect(d.unmatched).toEqual([]);

    // Filled as any template: the recipe's loaders and LoRA, the job's values.
    const t: Template = { name: "custom-00000000", arch: d.arch, does: ["create"], checkpoint: true, clipType: null, parts: partSpecs(d.parts), references: 0, mask: false, workflow: d.workflow, custom: { name: "x", from: "import", made: "" } };
    expect(checkTemplate(t, null).problems).toEqual([]);
    const graph = fill(t, d.parts.map((p) => ({ ...p, file: p.file! })), d.loras, { prompt: "p", negativePrompt: "n", seed: 1, steps: 6, cfg: 1, sampler: "euler", scheduler: "simple", width: 832, height: 1216, count: 1 });
    expect(graph.load_checkpoint).toEqual({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "shared/flux1-schnell-fp8.safetensors" } });
    expect(graph.lora_0!.inputs).toMatchObject({ lora_name: "shared/flux-style.safetensors", strength_model: 0.7 });
    expect(graph["3"]!.inputs.model).toEqual(["lora_0", 0]);
    expect(graph["6"]!.inputs).toEqual({ text: "p", clip: ["load_checkpoint", 1] });
  });

  it("keeps loaders it can't map in the workflow, with this host's paths", () => {
    const wf = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "unet_high.safetensors", weight_dtype: "default" } },
      "2": { class_type: "UNETLoader", inputs: { unet_name: "unet_low.safetensors", weight_dtype: "default" } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["4", 0] } },
      "4": { class_type: "CLIPLoader", inputs: { clip_name: "umt5.safetensors", type: "wan" } },
      "5": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 832, height: 480, length: 81, batch_size: 1 } },
      "6": { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], positive: ["3", 0], negative: ["3", 0], latent_image: ["5", 0], noise_seed: 3, steps: 20, cfg: 3.5, sampler_name: "euler", scheduler: "simple" } },
      "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["8", 0] } },
      "8": { class_type: "VAELoader", inputs: { vae_name: "wan_vae.safetensors" } },
      "9": { class_type: "VHS_VideoCombine", inputs: { images: ["7", 0], frame_rate: 16, filename_prefix: "x" } },
    };
    const d = importWorkflow(wf, "Wan two experts", "video", PARTS);
    expect(d.loaders).toBe("template");
    expect(d.parts).toEqual([]);
    expect(d.workflow["1"]!.inputs.unet_name).toBe("lyrica/huggingface/a/b/unet_high.safetensors");
    expect(d.unmatched).toEqual(["unet_low.safetensors", "umt5.safetensors", "wan_vae.safetensors"]);
    // A frames save becomes CreateVideo, then the websocket; length is the clip's frames.
    expect(d.workflow["9"]).toEqual({ class_type: "SaveVideoWebsocket", inputs: { video: ["9_video", 0] } });
    expect(d.workflow["9_video"]).toEqual({ class_type: "CreateVideo", inputs: { images: ["7", 0], fps: "$fps" } });
    expect(d.workflow["5"]!.inputs).toMatchObject({ width: "$width", height: "$height", length: "$frames", batch_size: 1 });
    expect(d.video).toEqual({ fps: 16, frameStep: 8, frameOffset: 1, sizeStep: 16, maxSeconds: 5, audio: false });
    const check = checkTemplate({ workflow: d.workflow, does: ["video"], loaders: "template", parts: [], video: d.video! }, { CreateVideo: { inputs: {}, output: false } });
    expect(check.problems).toEqual([]);
    expect(check.missingNodes).toEqual(["CLIPLoader", "CLIPTextEncode", "EmptyHunyuanLatentVideo", "KSamplerAdvanced", "SaveVideoWebsocket", "UNETLoader", "VAEDecode", "VAELoader"]);
  });

  it("refuses ComfyUI's UI file, file writers, fixed input files and unknown blanks", () => {
    expect(() => importWorkflow({ nodes: [], links: [] }, "x", "create", PARTS)).toThrow(/Export \(API\)/);
    const d = importWorkflow(exported(), "x", "create", PARTS);
    const bad = {
      ...d.workflow,
      "20": { class_type: "SaveLatent", inputs: { samples: ["3", 0] } },
      "21": { class_type: "LoadImage", inputs: { image: "someone-elses.png" } },
      "22": { class_type: "CLIPTextEncode", inputs: { text: "$secret", clip: "$clip" } },
      "23": { class_type: "CLIPTextEncode", inputs: { text: "../../etc/passwd", clip: ["99", 0] } },
    };
    const { problems } = checkTemplate({ workflow: bad, does: ["create"], parts: partSpecs(d.parts) }, null);
    expect(problems.join("\n")).toMatch(/Node 20 \(SaveLatent\) writes files/);
    expect(problems.join("\n")).toMatch(/Node 21 \(LoadImage\) reads a fixed file/);
    expect(problems.join("\n")).toMatch(/\$secret isn't a blank/);
    expect(problems.join("\n")).toMatch(/links to node 99/);
    expect(problems.join("\n")).toMatch(/Node 23's text names a path outside/);
    const noPrompt = { ...d.workflow, "6": { class_type: "CLIPTextEncode", inputs: { text: "fixed", clip: "$clip" } } };
    expect(checkTemplate({ workflow: noPrompt, does: ["create"], parts: partSpecs(d.parts) }, null).problems).toEqual(["The workflow needs a $prompt blank to do create."]);
  });
});

describe("the workflow API", () => {
  async function stack(o: { extra?: string[]; noNodes?: boolean; files?: Record<string, Buffer> } = {}) {
    const models = mkdtempSync(join(tmpdir(), "lyrica-wf-models-"));
    for (const [path, data] of Object.entries(o.files ?? { "shared/flux1-schnell-fp8.safetensors": FLUX_CKPT, "shared/flux-style.safetensors": FLUX_LORA })) {
      mkdirSync(dirname(join(models, path)), { recursive: true });
      writeFileSync(join(models, path), data);
    }
    const classes = ["CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImageWebsocket", "CheckpointLoaderSimple", "LoraLoaderModelOnly", "FluxGuidance", "ModelSamplingFlux", ...(o.extra ?? [])];
    const objectInfo = Object.fromEntries(classes.map((c) => [c, { input: { required: { x: ["INT", { default: 3 }] } }, output_node: c.startsWith("Save") || c.startsWith("Preview"), output: ["LATENT"], output_name: ["LATENT"], category: "test" }]));
    const comfyFake = await fakeComfy(o.noNodes ? {} : { objectInfo });
    open.push(comfyFake);
    const h = await startHost({ modelsDir: models });
    open.push(h.host);
    const gpus = new FakeGpus([24]);
    const backend = new FakeBackend(gpus);
    const comfy = new ComfyGpus(new Map([[0, new Comfy(comfyFake.url)]]));
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: backend, vllm: backend, comfyui: comfy }, state: h.host.state, log: () => {} });
    h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log: () => {} });
    const templates = TEMPLATES();
    const workflows = new Workflows(h.dataDir, templates);
    comfy.byGpu.get(0)!.onNodes = (info) => workflows.saveNodes(info);
    const book = new RecipeBook(h.dataDir, templates, STARTERS);
    h.host.images = new Images({ book, workflows, runtime: h.host.runtime, comfy, downloads: null, modelsDir: models, serving: mkdtempSync(join(tmpdir(), "lyrica-serving-")), log: () => {} });
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
    return { ...h, api, comfyFake, book, templates, models };
  }

  it("imports, saves, runs, revises and restores a workflow, and deletes it with its recipe", async () => {
    const s = await stack();
    const imported = await s.api("/host/v1/workflows/import", { body: { workflow: exported(), name: "Flux styled", does: "create" } });
    expect(imported.status).toBe(200);
    // ComfyUI hasn't run yet: nodes can't be checked.
    expect(imported.body).toMatchObject({ problems: [], missingNodes: null });
    const d = imported.body.draft;
    const saved = await s.api("/host/v1/workflows", { body: { name: d.label, does: d.does, arch: d.arch, workflow: d.workflow, loaders: d.loaders, clipType: d.clipType, video: d.video, parts: d.parts, loras: d.loras, defaults: d.defaults } });
    expect(saved.status).toBe(200);
    const { workflow, recipe } = saved.body;
    expect(workflow).toMatchObject({ label: "Flux styled", from: "import", does: ["create"], recipes: [{ id: recipe.id, name: "Flux styled" }] });
    expect(recipe).toMatchObject({ state: "confirmed", ready: true, custom: true, template: workflow.name, loras: [{ file: "shared/flux-style.safetensors", strength: 0.7 }] });
    expect(existsSync(join(s.dataDir, "workflows", `${workflow.name}.json`))).toBe(true);

    const made = await s.api("/host/v1/images/create", { body: { recipe: recipe.id, prompt: MARKER, seed: 5 } });
    expect(made.status).toBe(200);
    const sent = s.comfyFake.seen.prompts[0];
    expect(sent["6"].inputs.text).toBe(MARKER);
    expect(sent["3"].inputs).toMatchObject({ seed: 5, steps: 6, cfg: 1.5, model: ["lora_0", 0] });
    expect(sent["5"].inputs).toEqual({ width: 832, height: 1216, batch_size: 1 });
    // Nothing of the prompt is kept on disk.
    for (const f of readdirSync(join(s.dataDir, "workflows"))) expect(readFileSync(join(s.dataDir, "workflows", f), "utf8")).not.toContain(MARKER);

    // ComfyUI reported its nodes when it started: this one has them all.
    await new Promise((r) => setTimeout(r, 100));
    const got = (await s.api(`/host/v1/workflows/${workflow.name}`)).body;
    expect(got).toMatchObject({ nodesChecked: true, missingNodes: [], problems: [], revision: 1, by: "app" });

    // A change, by Lyrica: a new revision, the old one kept.
    const changed = { ...got.workflow, "3": { ...got.workflow["3"], inputs: { ...got.workflow["3"].inputs, denoise: 0.9 } } };
    const put = await s.api(`/host/v1/workflows/${workflow.name}`, { method: "PUT", body: { workflow: changed, by: "lyrica" } });
    expect(put.status).toBe(200);
    const revs = (await s.api(`/host/v1/workflows/${workflow.name}/revisions`)).body;
    expect(revs.current).toBe(2);
    expect(revs.revisions.map((r: { revision: number; by: string }) => [r.revision, r.by])).toEqual([[2, "lyrica"], [1, "app"]]);
    expect((await s.api(`/host/v1/workflows/${workflow.name}/revisions/1`)).body.workflow["3"].inputs.denoise).toBe(1);
    // A save that breaks the workflow is refused and changes nothing.
    const broken = await s.api(`/host/v1/workflows/${workflow.name}`, { method: "PUT", body: { workflow: { ...changed, "12": { class_type: "SaveImage", inputs: { images: ["8", 0] } } } } });
    expect(broken.status).toBe(400);
    expect(broken.body.error.message).toMatch(/Node 12 \(SaveImage\) writes files/);
    // Restoring is a new revision too.
    const restored = await s.api(`/host/v1/workflows/${workflow.name}/revisions/1/restore`, { body: {} });
    expect(restored.body.workflow["3"].inputs.denoise).toBe(1);
    expect((await s.api(`/host/v1/workflows/${workflow.name}/revisions`)).body.revisions.map((r: { revision: number }) => r.revision)).toEqual([3, 2, 1]);

    // A node ComfyUI doesn't have: the recipe says which, and does nothing.
    const fancy = { ...got.workflow, "13": { class_type: "FancyUpscaleNode", inputs: { image: ["8", 0] } } };
    expect((await s.api(`/host/v1/workflows/${workflow.name}`, { method: "PUT", body: { workflow: fancy } })).status).toBe(200);
    const listed = (await s.api("/host/v1/recipes")).body.recipes.find((r: { id: string }) => r.id === recipe.id);
    expect(listed).toMatchObject({ does: [], unsupported: expect.stringContaining("FancyUpscaleNode") });

    // A custom workflow goes with its last recipe.
    expect((await s.api(`/host/v1/recipes/${recipe.id}`, { method: "DELETE" })).status).toBe(200);
    expect(readdirSync(join(s.dataDir, "workflows"))).toEqual([]);
    expect((await s.api(`/host/v1/workflows/${workflow.name}`)).status).toBe(404);
  });

  async function saveImported(s: Awaited<ReturnType<typeof stack>>, extra: Record<string, unknown> = {}) {
    const d = (await s.api("/host/v1/workflows/import", { body: { workflow: exported(), name: "Flux styled", does: "create" } })).body.draft;
    return s.api("/host/v1/workflows", { body: { name: d.label, does: d.does, arch: d.arch, workflow: { ...d.workflow, ...extra }, loaders: d.loaders, clipType: d.clipType, video: d.video, parts: d.parts, loras: d.loras, defaults: d.defaults } });
  }

  it("copies a model with its custom workflow and LoRA to another host, placing each file there", async () => {
    const from = await stack();
    const { recipe } = (await saveImported(from)).body;
    // The other host has the checkpoint in a folder of its own, by the same name and size, and not the LoRA.
    const to = await stack({ files: { "mine/flux1-schnell-fp8.safetensors": FLUX_CKPT } });
    const bundle = (await from.api(`/host/v1/recipes/${recipe.id}/export`)).body;
    expect(bundle.recipe).toMatchObject({ id: recipe.id, name: "Flux styled", loras: [{ file: "shared/flux-style.safetensors", strength: 0.7 }] });
    expect(bundle.workflow).toMatchObject({ label: "Flux styled", from: "import", does: "create", arch: "flux" });
    expect(bundle.files).toEqual([
      { file: "shared/flux1-schnell-fp8.safetensors", size: FLUX_CKPT.length, sha256: null, origin: null },
      { file: "shared/flux-style.safetensors", size: FLUX_LORA.length, sha256: null, origin: null },
    ]);

    // Planning saves nothing.
    const plan = (await to.api("/host/v1/recipes/import", { body: { ...bundle, check: true } })).body;
    expect(plan.placed.map((p: { file: string; how: string; to: string }) => [p.file, p.how, p.to])).toEqual([
      ["shared/flux1-schnell-fp8.safetensors", "here", "mine/flux1-schnell-fp8.safetensors"],
      ["shared/flux-style.safetensors", "copy", "lyrica/upload/flux-style.safetensors"],
    ]);
    expect(plan.existing).toBeNull();
    expect((await to.api("/host/v1/recipes")).body.recipes).toEqual([expect.objectContaining({ name: "flux1 schnell fp8", state: "proposed" })]);

    const made = (await to.api("/host/v1/recipes/import", { body: bundle })).body;
    expect(made.copies).toEqual([{ file: "shared/flux-style.safetensors", name: "flux-style.safetensors", size: FLUX_LORA.length, to: "lyrica/upload/flux-style.safetensors" }]);
    expect(made.recipe).toMatchObject({
      name: "Flux styled", state: "confirmed", ready: false, custom: true, copiedFrom: recipe.id,
      parts: [{ role: "checkpoint", file: "mine/flux1-schnell-fp8.safetensors" }], loras: [{ file: "lyrica/upload/flux-style.safetensors", strength: 0.7 }],
    });
    const workflows = (await to.api("/host/v1/workflows")).body.workflows;
    expect(workflows).toEqual([expect.objectContaining({ label: "Flux styled", from: "import", recipes: [{ id: made.recipe.id, name: "Flux styled" }] })]);

    // lyricad carries the LoRA in pieces read from the first host.
    const head = await from.api(`/host/v1/parts/content?file=${encodeURIComponent("shared/flux-style.safetensors")}&offset=8&length=16`);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("16");
    expect(head.headers["x-file-size"]).toBe(String(FLUX_LORA.length));
    expect(head.body).toBe(FLUX_LORA.subarray(8, 24).toString("utf8"));
    expect((await from.api("/host/v1/parts/content?file=elsewhere.safetensors")).status).toBe(404);

    // Once it has arrived, the copy is ready; copying again gives back the same model and copies nothing.
    mkdirSync(join(to.models, "lyrica/upload"), { recursive: true });
    writeFileSync(join(to.models, "lyrica/upload/flux-style.safetensors"), FLUX_LORA);
    await to.api("/host/v1/scan", { method: "POST" });
    const again = (await to.api("/host/v1/recipes/import", { body: bundle })).body;
    expect(again).toMatchObject({ recipe: { id: made.recipe.id, ready: true }, copies: [] });
    expect((await to.api("/host/v1/workflows")).body.workflows).toHaveLength(1);
  });

  it("copies a model on a built-in template only to a host that has the template, and refuses a bad path", async () => {
    const from = await stack();
    const flux = (await from.api("/host/v1/recipes")).body.recipes.find((r: { name: string }) => r.name === "flux1 schnell fp8");
    const bundle = (await from.api(`/host/v1/recipes/${flux.id}/export`)).body;
    expect(bundle.workflow).toBeNull();
    const to = await stack({ files: {} });
    const missing = await to.api("/host/v1/recipes/import", { body: { ...bundle, recipe: { ...bundle.recipe, template: "no-such-template" } } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/no template no-such-template/);
    const outside = await to.api("/host/v1/recipes/import", { body: { ...bundle, files: [{ file: "../etc/passwd", size: 1, sha256: null, origin: null }] } });
    expect(outside.status).toBe(400);
    const made = (await to.api("/host/v1/recipes/import", { body: bundle })).body;
    expect(made.recipe).toMatchObject({ template: flux.template, state: "confirmed", ready: false, parts: [{ role: "checkpoint", file: "lyrica/upload/flux1-schnell-fp8.safetensors" }] });
  });

  it("refuses to run a workflow saved before ComfyUI reported its nodes when one of them writes files", async () => {
    const s = await stack({ extra: ["PreviewImage"] });
    // ComfyUI hasn't run yet, so only the name test applies and PreviewImage passes it.
    const saved = await saveImported(s, { "12": { class_type: "PreviewImage", inputs: { images: ["8", 0] } } });
    expect(saved.status).toBe(200);
    const { recipe } = saved.body;
    // The job starts ComfyUI, which reports PreviewImage as an output: nothing is queued.
    const made = await s.api("/host/v1/images/create", { body: { recipe: recipe.id, prompt: "x" } });
    expect(made.status).toBe(503);
    expect(made.body.error.message).toMatch(/Node 12 \(PreviewImage\) writes files/);
    expect(s.comfyFake.seen.prompts).toEqual([]);
    // And the recipe now says so.
    const listed = (await s.api("/host/v1/recipes")).body.recipes.find((r: { id: string }) => r.id === recipe.id);
    expect(listed).toMatchObject({ does: [], unsupported: expect.stringContaining("PreviewImage") });
  });

  it("lists ComfyUI's nodes for the Graph view and keeps a workflow's layout through saves and restores", async () => {
    const s = await stack();
    expect((await s.api("/host/v1/workflows/nodes")).body).toEqual({ nodes: null });
    const { workflow, recipe } = (await saveImported(s)).body;
    await s.api("/host/v1/images/create", { body: { recipe: recipe.id, prompt: "x" } });
    const nodes = (await s.api("/host/v1/workflows/nodes")).body.nodes;
    expect(nodes.KSampler).toEqual({ inputs: { x: "INT" }, output: false, outputs: ["LATENT"], outputNames: ["LATENT"], category: "test", defaults: { x: 3 } });
    const got = (await s.api(`/host/v1/workflows/${workflow.name}`)).body;
    expect(got.layout).toBeNull();
    // Only nodes the workflow has, as whole numbers; a bad position is dropped.
    const put = await s.api(`/host/v1/workflows/${workflow.name}`, { method: "PUT", body: { workflow: got.workflow, layout: { "3": [10.4, 20], "99": [0, 0], "8": ["a", 1] } } });
    expect(put.body.layout).toEqual({ "3": [10, 20] });
    // A save without a layout keeps it; restoring brings back the revision's.
    const kept = await s.api(`/host/v1/workflows/${workflow.name}`, { method: "PUT", body: { workflow: got.workflow, name: "Renamed" } });
    expect(kept.body.layout).toEqual({ "3": [10, 20] });
    const restored = await s.api(`/host/v1/workflows/${workflow.name}/revisions/1/restore`, { body: {} });
    expect(restored.body.layout).toBeNull();
    expect((await s.api(`/host/v1/workflows/${workflow.name}/revisions/2`)).body.layout).toEqual({ "3": [10, 20] });
  });

  it("runs no custom workflow while ComfyUI hasn't reported its nodes", async () => {
    const s = await stack({ noNodes: true });
    const { recipe } = (await saveImported(s)).body;
    const made = await s.api("/host/v1/images/create", { body: { recipe: recipe.id, prompt: "x" } });
    expect(made.status).toBe(503);
    expect(made.body.error.message).toMatch(/hasn't reported its nodes/);
    expect(s.comfyFake.seen.prompts).toEqual([]);
  });

  it("edits a built-in recipe's workflow in place: the model gets its own revision, the built-in stays, and Reset puts it back", async () => {
    const s = await stack({ extra: ["ConditioningZeroOut", "EmptySD3LatentImage"] });
    const proposed = (await s.api("/host/v1/recipes?state=proposed")).body.recipes;
    const flux = proposed.find((r: { arch: string }) => r.arch === "flux");
    await s.api(`/host/v1/recipes/${flux.id}/confirm`, { body: {} });
    // Read: the built-in as it ships.
    const shipped = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "GET" });
    expect(shipped.status).toBe(200);
    expect(shipped.body).toMatchObject({ builtIn: true, name: "flux", base: "flux", label: flux.name, revision: 0, problems: [] });
    // A name on its own renames the model and leaves it on the built-in: nothing is written to workflows/.
    const named = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "PUT", body: { name: "Flux dev" } });
    expect(named.body).toMatchObject({ builtIn: true, name: "flux", label: "Flux dev", revision: 0, recipes: [{ id: flux.id, name: "Flux dev" }] });
    expect((await s.api(`/host/v1/recipes/${flux.id}`, { method: "GET" })).body).toMatchObject({ name: "Flux dev", template: "flux", custom: false });
    expect(readdirSync(join(s.dataDir, "workflows"))).toEqual([]);
    flux.name = "Flux dev";
    // Save: a workflow of the model's own, named after it, on the built-in as its base; the built-in is untouched.
    const workflow = structuredClone(shipped.body.workflow) as Record<string, { inputs: Record<string, unknown> }>;
    const sampler = Object.entries(workflow).find(([, n]) => "steps" in n.inputs)!;
    sampler[1].inputs.denoise = 0.9;
    const edited = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "PUT", body: { workflow } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ builtIn: false, from: "copy", base: "flux", label: flux.name, revision: 1, problems: [], recipes: [{ id: flux.id, name: flux.name }] });
    expect(edited.body.workflow[sampler[0]].inputs.denoise).toBe(0.9);
    expect(s.templates.get("flux")!.custom).toBeUndefined();
    const recipe = (await s.api(`/host/v1/recipes/${flux.id}`, { method: "GET" })).body;
    expect(recipe).toMatchObject({ name: flux.name, template: edited.body.name, custom: true, workflowBase: "flux" });
    // A name on its own renames the model and relabels its workflow, with no new revision; with edits, it rides along.
    const renamed = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "PUT", body: { name: " Flux, my way " } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: edited.body.name, label: "Flux, my way", revision: 1, recipes: [{ id: flux.id, name: "Flux, my way" }] });
    expect((await s.api(`/host/v1/recipes/${flux.id}`, { method: "GET" })).body).toMatchObject({ name: "Flux, my way", template: edited.body.name });
    expect((await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "PUT", body: { name: "  " } })).status).toBe(400);
    // The model still fills and runs; a second save is revision 2 of the same workflow.
    expect((await s.api("/host/v1/images/create", { body: { recipe: flux.id, prompt: "x" } })).status).toBe(200);
    sampler[1].inputs.denoise = 0.8;
    const again = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "PUT", body: { workflow } });
    expect(again.body).toMatchObject({ name: edited.body.name, revision: 2, label: "Flux, my way" });
    expect(readdirSync(join(s.dataDir, "workflows")).sort()).toEqual([`${edited.body.name}.json`, `${edited.body.name}.revisions.json`]);
    // Reset: back on the built-in, the model's own workflow and revisions gone.
    const reset = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "DELETE" });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ builtIn: true, name: "flux" });
    expect((await s.api(`/host/v1/recipes/${flux.id}`, { method: "GET" })).body).toMatchObject({ template: "flux", custom: false, workflowBase: null });
    expect(s.templates.has(edited.body.name)).toBe(false);
    expect(readdirSync(join(s.dataDir, "workflows"))).toEqual([]);
    // An imported workflow has no template to go back to.
    const resetAgain = await s.api(`/host/v1/recipes/${flux.id}/workflow`, { method: "DELETE" });
    expect(resetAgain.status).toBe(400);
    expect(resetAgain.body.error.message).toMatch(/on its template already/);
  });
});
