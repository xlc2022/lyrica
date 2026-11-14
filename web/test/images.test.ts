// A host's recipes and parts in words (web/src/images.ts), as the Image models tab shows them.
import { describe, expect, it } from "vitest";
import { addableRoles, defaultsWords, deletePlan, loaderWords, missingOf, moreCloud, plainModels, recipeFiles, recipeRows, starredFirst, withLora, type HostPart, type HostRecipe } from "../src/images.ts";
import type { ModelsPage } from "../src/api.ts";

const GB = 2 ** 30;
const recipe = (r: Partial<HostRecipe>): HostRecipe => ({
  id: "r1", name: "Z-Image Turbo", state: "confirmed", ready: true, arch: "z-image", template: "z-image", does: ["create"],
  parts: [
    { role: "diffusion", slot: null, file: "lyrica/z/z_image_turbo_bf16.safetensors", added: false },
    { role: "text_encoder", slot: "qwen3", file: "lyrica/z/qwen_3_4b.safetensors", added: false },
    { role: "vae", slot: null, file: "lyrica/z/ae.safetensors", added: false },
  ],
  loras: [], defaults: {}, base: null, ...r,
});
const part = (file: string, p: Partial<HostPart> = {}): HostPart => ({ file, size: GB, role: "vae", slot: null, arch: "z-image", precision: "bf16", downloaded: true, usedBy: ["r1"], ...p });

describe("a recipe in words", () => {
  it("says its defaults the way the caption does", () => {
    expect(defaultsWords({ steps: 8, cfg: 1, sampler: "res_multistep", scheduler: "simple", width: 1024, height: 1024 })).toBe("8 steps · CFG 1 · res_multistep · simple · 1024×1024");
    expect(defaultsWords({ steps: 28, guidance: 2.5, negativePrompt: "blurry" })).toBe("28 steps · guidance 2.5");
    expect(defaultsWords({ scale: 2, maxSize: 4096, colorMatch: "lab" })).toBe("to 2× · up to 4096 px");
    expect(defaultsWords({})).toBe("");
    // A setting no input of the workflow takes is left out: its fixed value runs instead.
    expect(defaultsWords({ steps: 12, cfg: 3.5, sampler: "euler", width: 1024, height: 1024 }, ["cfg"])).toBe("12 steps · euler · 1024×1024");
  });
  it("counts what it is missing, and names its files", () => {
    const r = recipe({ state: "proposed", ready: false, parts: [
      { role: "diffusion", slot: null, file: "comfy/qwen_image_fp8.safetensors", added: false },
      { role: "vae", slot: null, file: null, added: false, missing: { source: "huggingface", repo: "Comfy-Org/Qwen-Image_ComfyUI", path: "split_files/vae/qwen_image_vae.safetensors", size: 0.25 * GB } },
      { role: "text_encoder", slot: "qwen2.5vl", file: null, added: false },
    ] });
    expect(missingOf(r)).toEqual({ count: 2, bytes: 0.25 * GB, known: 1 });
    expect(recipeFiles(r)).toEqual(["qwen_image_fp8.safetensors", "qwen_image_vae.safetensors"]);
  });
  it("names a recipe with a LoRA after its LoRA", () => {
    expect(withLora("Z-Image Turbo", "comfy/loras/pixel-art_zimage.safetensors")).toBe("Z-Image Turbo + pixel art zimage");
  });
  it("offers a VAE and a text encoder only to a checkpoint without them", () => {
    expect(addableRoles(recipe({}))).toEqual(["lora"]);
    expect(addableRoles(recipe({ parts: [{ role: "checkpoint", slot: null, file: "sdxl.safetensors", added: false }] }))).toEqual(["lora", "vae", "text_encoder"]);
    expect(addableRoles(recipe({ parts: [{ role: "checkpoint", slot: null, file: "sdxl.safetensors", added: false }, { role: "vae", slot: null, file: "vae.safetensors", added: true }] }))).toEqual(["lora", "text_encoder"]);
  });
});

describe("the Models list", () => {
  it("is a row per recipe name across hosts, leaving out what is only proposed or ignored", () => {
    const rows = recipeRows([
      { hostId: "a", host: "box", parts: [], recipes: [recipe({}), recipe({ id: "r2", name: "Qwen-Image", state: "proposed" }), recipe({ id: "r3", name: "SDXL", state: "ignored" })] },
      { hostId: "b", host: "workstation", parts: [], recipes: [recipe({ id: "r4", name: "z-image turbo", state: "proposed", ready: false, parts: [{ role: "vae", slot: null, file: null, added: false }] }), recipe({ id: "r5", name: "Krea 2" })] },
    ]);
    expect(rows.map((r) => [r.name, r.copies.map((c) => c.host), r.pill])).toEqual([
      ["Z-Image Turbo", ["box", "workstation"], "parts missing"],
      ["Krea 2", ["workstation"], undefined],
    ]);
  });
});

describe("deleting a recipe", () => {
  it("deletes only what Lyrica downloaded and nothing else uses, and says why the rest stays", () => {
    const r = recipe({ loras: [{ file: "lyrica/l/style.safetensors", strength: 0.8 }] });
    const parts = [
      part("lyrica/z/z_image_turbo_bf16.safetensors", { size: 12 * GB }),
      part("lyrica/z/qwen_3_4b.safetensors", { usedBy: ["r1", "r2", "r3"] }),
      part("lyrica/z/ae.safetensors", { downloaded: false }),
      part("lyrica/l/style.safetensors", { size: 0.5 * GB }),
    ];
    const names: Record<string, string> = { r2: "Krea 2", r3: "FLUX dev" };
    const plan = deletePlan(r, parts, (id) => (names[id] ? { name: names[id], state: "confirmed" } : undefined));
    expect(plan.goes.map((p) => p.file)).toEqual(["lyrica/z/z_image_turbo_bf16.safetensors", "lyrica/l/style.safetensors"]);
    expect(plan.frees).toBe(12.5 * GB);
    expect(plan.keeps).toEqual([
      { file: "lyrica/z/qwen_3_4b.safetensors", why: "Krea 2 and FLUX dev use it" },
      { file: "lyrica/z/ae.safetensors", why: "not Lyrica's" },
    ]);
  });
  it("counts an ignored recipe as no user, since the host deletes what only ignored recipes name", () => {
    const parts = [
      part("lyrica/z/z_image_turbo_bf16.safetensors", { usedBy: ["r1", "r2"] }),
      part("lyrica/z/qwen_3_4b.safetensors", { usedBy: ["r1", "r2", "r3"] }),
      part("lyrica/z/ae.safetensors"),
    ];
    const others: Record<string, Pick<HostRecipe, "name" | "state">> = { r2: { name: "Old proposal", state: "ignored" }, r3: { name: "Krea 2", state: "proposed" } };
    const plan = deletePlan(recipe({}), parts, (id) => others[id]);
    expect(plan.goes.map((p) => p.file)).toEqual(["lyrica/z/z_image_turbo_bf16.safetensors", "lyrica/z/ae.safetensors"]);
    expect(plan.keeps).toEqual([{ file: "lyrica/z/qwen_3_4b.safetensors", why: "Krea 2 uses it" }]);
  });
});

describe("an architecture's group of image models", () => {
  it("lists starred models first, recipes and plain models alike, each keeping its order", () => {
    const shown = [
      { name: "Flux dev", starred: false }, { name: "Z-Image Turbo", starred: true },
      { name: "shared.cloud/gpt-image", starred: false }, { name: "ChatGPT Images", starred: true },
    ];
    expect(starredFirst(shown, (x) => x.starred).map((x) => x.name)).toEqual(["Z-Image Turbo", "ChatGPT Images", "Flux dev", "shared.cloud/gpt-image"]);
  });
});

describe("loaderWords", () => {
  it("names the model with the LoRAs the host chains onto it, the text encoder and the VAE", () => {
    const parts = [
      { role: "diffusion" as const, slot: null, file: "shared/flux1-dev.safetensors" },
      { role: "text_encoder" as const, slot: "t5", file: "shared/t5xxl.safetensors" },
      { role: "text_encoder" as const, slot: "clip_l", file: "shared/clip_l.safetensors" },
      { role: "vae" as const, slot: null, file: "shared/ae.safetensors" },
    ];
    const loras = [{ file: "shared/flux-style.safetensors", strength: 0.7 }, { file: "shared/pixel.safetensors", strength: -1 }];
    expect(loaderWords(parts, loras, [])).toEqual({
      model: "flux1-dev + LoRA flux-style (0.7) + LoRA pixel (-1)", clip: "t5xxl + clip_l", vae: "ae",
    });
  });

  it("puts a LoRA made for one expert on that expert, and any other on both", () => {
    const parts = [
      { role: "diffusion" as const, slot: "high", file: "wan-high.gguf" },
      { role: "diffusion" as const, slot: "low", file: "wan-low.gguf" },
    ];
    const loras = [{ file: "lightning-high.safetensors", strength: 1 }, { file: "style.safetensors", strength: 0.5 }];
    const words = loaderWords(parts, loras, [{ file: "lightning-high.safetensors", slot: "high" }]);
    expect(words.model_high).toBe("wan-high + LoRA lightning-high (1) + LoRA style (0.5)");
    expect(words.model_low).toBe("wan-low + LoRA style (0.5)");
  });

  it("gives a checkpoint's own text encoder and VAE unless the recipe adds others", () => {
    expect(loaderWords([{ role: "checkpoint", slot: null, file: "sdxl.safetensors" }], [], [])).toEqual({ model: "sdxl", clip: "sdxl", vae: "sdxl" });
  });
});

describe("plain and other cloud models", () => {
  // A model switched off in its endpoint's list has no switches to change: the daemon finds no model by its ID.
  const page = (models: object[]) => ({ endpoints: [{ id: "e1", name: "OpenRouter", kind: "cloud", api: "openai-compatible", hasApiKey: true, models }] }) as unknown as ModelsPage;
  const m = (id: string, x: object = {}) => ({ id, modelId: id, status: "listed", ...x });

  it("leaves out a model switched off in its endpoint's list", () => {
    const p = page([m("on", { image: true }), m("off", { image: true, disabled: true }), m("chat"), m("chat-off", { disabled: true })]);
    expect(plainModels(p).map((x) => x.m.id)).toEqual(["on"]);
    expect(moreCloud(p).map((x) => x.m.id)).toEqual(["chat"]);
  });
});
