import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudModelForbidden, HostRefused, PLAN_IMAGE_MODEL, type ImageRequest } from "../src/index.ts";
import { cleanPng, imageAt } from "../src/models/images.ts";
import { VIDEO_TIMEOUT_MS, videoTimeout } from "../src/models/videos.ts";
import { loraFiles, matchLora } from "../src/models/loras.ts";

import { fakeImages as setup, mp4 } from "./fake-images.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
const input = { bytes: png, type: "image/png" as const };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PLAN = { name: "chatgpt", plan: "chatgpt" as const, credential: { access: "fake-plan", refresh: "fake-refresh", expires: Date.now() + 3600000 } };
const PLAN_MODELS = [{ modelId: "gpt-5.4-mini", vision: true }, { modelId: "gpt-6.1-sol", vision: true }, { modelId: "gpt-5.5", vision: true }];
const imagesOf = (s: Awaited<ReturnType<typeof setup>>, endpointId: string) => ({ offeringId: s.models.offerings(s.ada.id, endpointId).find((o) => o.modelId === PLAN_IMAGE_MODEL)!.id });

/** A signed-in ChatGPT plan, discovered: its chat models and its one image model, ChatGPT Images. */
async function planImages(s: Awaited<ReturnType<typeof setup>>) {
  s.models.setPlanCatalog(() => PLAN_MODELS);
  const ep = s.models.addPlan(s.ada, PLAN);
  await s.models.discover(s.ada, ep.id);
  return { ep, ref: imagesOf(s, ep.id) };
}

/** Stands in for the user's Codex: records what it was asked and answers with `answer`. */
function codex(s: Awaited<ReturnType<typeof setup>>, answer: (r: ImageRequest) => unknown = () => [{ bytes: png, type: "image/png", width: 1, height: 1 }]) {
  const asked: { userId: string; request: ImageRequest }[] = [];
  s.models.setCodexImages(async (userId, request) => { asked.push({ userId, request }); const out = answer(request); if (out instanceof Error) throw out; return out as never; });
  return asked;
}

describe("image calls through the router (principles 1 and 2)", () => {
  it("creates, edits and upscales confirmed host recipes, keeping defaults and never naming parts", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    expect((await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "fast" })).images[0]).toMatchObject({ type: "image/png", width: 1, height: 1, seed: 42 });
    await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", size: { width: 1024, height: 512 }, count: 2 });
    await s.models.image(ctx, { action: "edit", prompt: "Add flowers", image: input, mask: input, references: [input] });
    await s.models.image(ctx, { action: "edit", prompt: "A round mirror on a beige wall", image: input, mask: input, replace: true });
    await s.models.image(ctx, { action: "upscale", image: input });
    expect(s.workstation.server.images.map(i => i.body)).toEqual([
      { recipe: "art", prompt: "A garden" }, { recipe: "art", prompt: "A garden", width: 1024, height: 512, count: 2 },
      { recipe: "art", prompt: "Add flowers", image: png.toString("base64"), mask: png.toString("base64"), references: [png.toString("base64")] },
      { recipe: "art", prompt: "A round mirror on a beige wall", image: png.toString("base64"), mask: png.toString("base64"), replace: true },
      { recipe: "art", image: png.toString("base64") },
    ]);
    expect(s.heard).toEqual([]);
  });
  it("passes over a host recipe that takes no mask for a masked edit, and uses it for a maskless one", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    const plain = await s.host("plain", undefined, false);
    s.models.setColumnTask(s.ada.id, "private", "image.edit", [plain.ref, s.spare.ref]);
    expect((await s.models.image(ctx, { action: "edit", prompt: "Add flowers", image: input, mask: input })).resolution.ref).toEqual(s.spare.ref);
    expect((await s.models.image(ctx, { action: "edit", prompt: "Add flowers", image: input })).resolution.ref).toEqual(plain.ref);
    expect(plain.server.images.map(i => "mask" in i.body)).toEqual([false]);
  });
  it("passes over a host recipe that takes fewer reference images than a call sends, and uses it without them", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    const plain = await s.host("plain", undefined, undefined, 0), one = await s.host("one", undefined, undefined, 1);
    s.models.setColumnTask(s.ada.id, "private", "image.create", [plain.ref, one.ref, s.spare.ref]);
    const made = await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", references: [input] });
    expect(made.resolution.ref).toEqual(one.ref);
    expect(made.resolution.skipped.map(p => p.reason)).toEqual(["it doesn't take reference images"]);
    expect((await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", references: [input, input] })).resolution.ref).toEqual(s.spare.ref);
    expect((await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality" })).resolution.ref).toEqual(plain.ref);
    expect(plain.server.images.map(i => "references" in i.body)).toEqual([false]);
  });
  it("creates and edits through the keyed OpenAI endpoint, including quality and references", async () => {
    const s = await setup();
    for (const tier of ["fast", "quality"] as const) await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier, count: 2 });
    await s.models.image(s.ctx(), { action: "edit", prompt: "Add flowers", image: input, mask: input, references: [input] });
    expect(s.heard.slice(0, 2)).toMatchObject([
      { path: "/v1/images/generations", body: { model: "gpt-image-1", quality: "low", n: 2, output_format: "png" } },
      { path: "/v1/images/generations", body: { quality: "high" } },
    ]);
    const form = s.heard[2]!.body as FormData;
    expect(s.heard[2]!.path).toBe("/v1/images/edits");
    expect(form.get("prompt")).toBe("Add flowers");
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.get("mask")).toBeTruthy();
  });
  it("private and local-only contexts never reach cloud even with a cloud override", async () => {
    const s = await setup();
    for (const ctx of [s.ctx({ pool: "private" }), s.ctx({ localOnly: true })]) {
      await expect(s.models.image({ ...ctx, overrides: { "image.create": [s.ref] } }, { action: "create", prompt: "A garden", tier: "quality" })).rejects.toThrow(CloudModelForbidden);
      await s.models.image(ctx, { action: "edit", prompt: "Add flowers", image: input });
    }
    expect(s.heard).toEqual([]);
  });
  it("falls back from workstation to 3090 when image execution is unavailable", async () => {
    const s = await setup();
    s.workstation.server.imagesOff();
    const out = await s.models.image(s.ctx({ localOnly: true }), { action: "create", prompt: "A garden", tier: "quality" });
    expect(out.resolution.endpoint.name).toBe("3090");
    expect(s.spare.server.images).toHaveLength(1);
    expect(s.heard).toEqual([]);
  });
  it("passes over a recipe too big for its machine's GPU, and says retrying won't help when none fits", async () => {
    const s = await setup();
    s.workstation.server.imagesOff("too_big");
    const out = await s.models.image(s.ctx({ localOnly: true }), { action: "create", prompt: "A garden", tier: "quality" });
    expect(out.resolution.endpoint.name).toBe("3090");
    const s2 = await setup();
    s2.workstation.server.imagesOff("too_big");
    s2.spare.server.imagesOff("too_big");
    await expect(s2.models.image(s2.ctx({ localOnly: true }), { action: "create", prompt: "A garden", tier: "quality" })).rejects.toThrow(/too big for that machine's GPU, so retrying won't help/);
  });
  it.each(["fast", "quality"] as const)("%s skips the other tier and falls back down the same list", async (tier) => {
    const s = await setup();
    s.workstation.server.useFor = tier === "fast" ? "quality" : "fast";
    s.spare.server.useFor = tier;
    await s.models.discover(s.ada, s.workstation.ep.id);
    await s.models.discover(s.ada, s.spare.ep.id);
    const last = await s.host("last", tier);
    s.models.setColumnTask(s.ada.id, "private", "image.create", [s.workstation.ref, s.spare.ref, last.ref]);
    const ctx = s.ctx({ localOnly: true });
    const request = { action: "create" as const, prompt: "A garden", tier };
    const first = await s.models.image(ctx, request);
    expect(first.resolution.ref).toEqual(s.spare.ref);
    expect(first.resolution.skipped).toContainEqual({ label: s.models.label(s.ada.id, s.workstation.ref.offeringId), reason: `it is for ${s.workstation.server.useFor} images` });
    s.spare.server.imagesOff("model_unavailable");
    expect((await s.models.image(ctx, request)).resolution.ref).toEqual(last.ref);
    expect(s.workstation.server.images).toEqual([]);
    expect(last.server.images).toHaveLength(1);
    expect(s.heard).toEqual([]);
  });
  it("uses a non-GPT keyed offering and persists cloud tiers in hand JSON", async () => {
    const s = await setup();
    const ep = s.models.endpoint(s.ada.id, s.models.offering(s.ada.id, s.ref.offeringId)!.endpoint.id)!;
    const fast = { offeringId: s.models.addModel(s.ada, ep.id, { modelId: "art-model", image: true, edit: true, useFor: "fast" }).id };
    s.models.setColumnTask(s.ada.id, "general", "image.create", [fast, s.ref]);
    expect((await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "fast" })).resolution.ref).toEqual(fast);
    expect(s.heard[0]!.body).toMatchObject({ model: "art-model" });
    expect((await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "quality" })).resolution.ref).toEqual(s.ref);
    s.models.setCapabilities(s.ada, fast.offeringId, { useFor: "both", edit: false });
    expect(s.models.offering(s.ada.id, fast.offeringId)!.offering).toMatchObject({ useFor: "both", image: true, edit: false });
    const db = s.users.openUserDb(s.ada.id);
    try {
      const hand = db.prepare("SELECT hand FROM offerings WHERE id = ?").get(fast.offeringId) as { hand: string };
      expect(JSON.parse(hand.hand)).toMatchObject({ useFor: "both", image: true, edit: false });
    } finally { db.close(); }
    expect(() => s.models.setCapabilities(s.ada, fast.offeringId, { useFor: "slow" as "fast" })).toThrow(/useFor/);
  });
  it("makes ChatGPT Images with the user's own Codex for create and maskless edits, never in restricted threads", async () => {
    const s = await setup();
    const { ref } = await planImages(s);
    for (const task of ["image.create", "image.edit"] as const) s.models.setColumnTask(s.ada.id, "general", task, [ref, s.ref]);
    const asked = codex(s);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("nothing goes over the plan's sign-in"); }));
    const out = await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "quality", size: { width: 1024, height: 1024 }, references: [input] });
    expect(out.images).toHaveLength(1);
    expect(out.resolution.ref).toEqual(ref);
    await s.models.image(s.ctx(), { action: "edit", prompt: "Add flowers", image: input });
    expect(asked.map((a) => [a.userId, a.request.action])).toEqual([[s.ada.id, "create"], [s.ada.id, "edit"]]);
    for (const ctx of [s.ctx({ pool: "private" }), s.ctx({ localOnly: true })]) {
      await expect(s.models.image({ ...ctx, overrides: { "image.create": [ref] } }, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toThrow(CloudModelForbidden);
    }
    expect(asked).toHaveLength(2);
    // Masked edits fall down the list without reaching Codex.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => {
      expect(opts.headers).toMatchObject({ authorization: "Bearer fake-key" });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    }));
    expect((await s.models.image(s.ctx(), { action: "edit", prompt: "Add flowers", image: input, mask: input })).resolution.ref).toEqual(s.ref);
    expect(asked).toHaveLength(2);
  });
  it("drops a model from image lists when its image switch goes off, keeping the rest of the list", async () => {
    const s = await setup();
    const { ref } = await planImages(s);
    s.models.setColumnTask(s.ada.id, "general", "image.create", [ref, s.ref]);
    s.models.setColumnTask(s.ada.id, "general", "image.edit", [ref]);
    const preset = s.models.addPreset(s.ada.id, { name: "Plan images", scope: "general" }, "general");
    s.models.setCapabilities(s.ada, ref.offeringId, { image: false });
    expect(s.models.preset(s.ada.id, preset.id)!.entries["image.create"]).toEqual([s.ref]);
    expect(s.models.preset(s.ada.id, preset.id)!.entries["image.edit"]).toEqual([ref]);
    s.models.setCapabilities(s.ada, ref.offeringId, { edit: false });
    expect(s.models.preset(s.ada.id, preset.id)!.entries["image.edit"]).toBeUndefined();
  });
  it("gives a ChatGPT plan one image model, ChatGPT Images, in place of switches on its chat models", async () => {
    const s = await setup();
    s.models.setPlanCatalog(() => PLAN_MODELS);
    const ep = s.models.addPlan(s.ada, PLAN);
    // An older release put the image switch on a chat model; it no longer makes images.
    const chat = s.models.addModel(s.ada, ep.id, { modelId: "gpt-6.1-sol", image: true, edit: true });
    expect(s.models.offering(s.ada.id, chat.id)!.offering).not.toHaveProperty("image");
    await s.models.discover(s.ada, ep.id);
    const images = s.models.offering(s.ada.id, imagesOf(s, ep.id).offeringId)!.offering;
    expect(images).toMatchObject({ recipe: "ChatGPT Images", image: true, edit: true });
    expect(s.models.label(s.ada.id, images.id)).toBe("chatgpt/ChatGPT Images");
  });
  it("moves image lists that named a plan's chat model to ChatGPT Images when it is first found", async () => {
    const s = await setup();
    s.models.setPlanCatalog(() => PLAN_MODELS);
    const ep = s.models.addPlan(s.ada, PLAN);
    const chat = { offeringId: s.models.addModel(s.ada, ep.id, { modelId: "gpt-6.1-sol" }).id };
    const preset = s.models.addPreset(s.ada.id, { name: "Plan images", scope: "general" }, "general");
    // Lists an older release saved while the chat model's switch was on.
    (s.models as unknown as { editLists: (u: string, f: (t: Record<string, unknown>) => boolean) => void })
      .editLists(s.ada.id, (t) => { t["image.create"] = [chat, s.ref, chat]; t["image.edit"] = [chat]; return true; });
    await s.models.discover(s.ada, ep.id);
    const images = imagesOf(s, ep.id);
    expect(s.models.preset(s.ada.id, preset.id)!.entries["image.create"]).toEqual([images, s.ref]);
    expect(s.models.preset(s.ada.id, preset.id)!.entries["image.edit"]).toEqual([images]);
    // Only the first time: a later discovery leaves the lists as the user set them.
    s.models.setColumnTask(s.ada.id, "general", "image.edit", [s.ref]);
    await s.models.discover(s.ada, ep.id);
    expect(s.models.column(s.ada.id, "general").entries["image.edit"]).toEqual([s.ref]);
  });
  it("puts ChatGPT Images in empty Image edits lists that may use cloud, once, when it is first found", async () => {
    const s = await setup();
    const general = s.models.addPreset(s.ada.id, { name: "Mixed images", scope: "general" }, "general");
    const set = s.models.addPreset(s.ada.id, { name: "Set edits", scope: "general" }, "general");
    const lists = s.models as unknown as { editLists: (u: string, f: (t: Record<string, unknown>) => boolean) => void };
    lists.editLists(s.ada.id, (t) => { delete t["image.edit"]; return true; });
    s.models.useColumnPreset(s.ada.id, "general", set.id);
    s.models.setColumnTask(s.ada.id, "general", "image.edit", [s.ref]);
    s.models.savePreset(s.ada.id, set.id, "general");
    s.models.useColumnPreset(s.ada.id, "general", general.id);
    const local = s.models.addPreset(s.ada.id, { name: "Local images", scope: "private" }, "private");
    const { ep, ref } = await planImages(s);
    expect(s.models.preset(s.ada.id, general.id)!.entries["image.edit"]).toEqual([ref]);
    expect(s.models.column(s.ada.id, "general").entries["image.edit"]).toEqual([ref]);
    expect(s.models.preset(s.ada.id, set.id)!.entries["image.edit"]).toEqual([s.ref]);
    expect(s.models.preset(s.ada.id, local.id)!.entries["image.edit"]).toBeUndefined();
    expect(s.models.preset(s.ada.id, "builtin.local")!.entries["image.edit"]).toBeUndefined();
    // A list the user empties afterwards stays empty.
    s.models.setColumnTask(s.ada.id, "general", "image.edit", []);
    s.models.savePreset(s.ada.id, general.id, "general");
    await s.models.discover(s.ada, ep.id);
    expect(s.models.preset(s.ada.id, general.id)!.entries["image.edit"]).toBeUndefined();
  });
  it("makes an image through ChatGPT Images for a plan added before it, without the Models page opening first", async () => {
    const s = await setup();
    s.models.setPlanCatalog(() => PLAN_MODELS);
    const ep = s.models.addPlan(s.ada, PLAN);
    const chat = { offeringId: s.models.addModel(s.ada, ep.id, { modelId: "gpt-6.1-sol" }).id };
    (s.models as unknown as { editLists: (u: string, f: (t: Record<string, unknown>) => boolean) => void })
      .editLists(s.ada.id, (t) => { t["image.create"] = [chat]; return true; });
    const asked = codex(s);
    const out = await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "fast" });
    expect(out.resolution.ref).toEqual(imagesOf(s, ep.id));
    expect(asked).toHaveLength(1);
  });
  it.each(["key", "plan"] as const)("stops on a %s content refusal without echoing provider text or trying the fallback", async kind => {
    const s = await setup();
    let ref = s.ref;
    if (kind === "plan") {
      ref = (await planImages(s)).ref;
    }
    s.models.setColumnTask(s.ada.id, "general", "image.create", [ref, s.workstation.ref]);
    const preset = s.models.addPreset(s.ada.id, { name: "Image fallbacks", scope: "general" }, "general");
    expect(s.models.resolve("image.create", s.ctx({ preset: preset.id })).ref).toEqual(ref);
    const asked = codex(s, () => new HostRefused("image_refusal", "Image generation was refused (image_refusal)."));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "content_policy_violation", message: "SECRET provider prompt" } }, { status: 400 })));
    await expect(s.models.image(s.ctx({ preset: preset.id }), { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "image_refusal", message: "Image generation was refused (image_refusal)." });
    expect(s.workstation.server.images).toEqual([]);
    expect(kind === "key" ? vi.mocked(fetch).mock.calls.length : asked.length).toBe(1);
  });
  it("falls back to the keyed offering when Codex can't make the image", async () => {
    const s = await setup();
    const { ref } = await planImages(s);
    s.models.setColumnTask(s.ada.id, "general", "image.create", [ref, s.ref]);
    const asked = codex(s, () => new HostRefused("unavailable", "Codex reached its usage limit."));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] })));
    expect((await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "fast" })).resolution.ref).toEqual(s.ref);
    expect(asked).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never makes a Grok plan's model an image model, so no image call reaches the unsupported plan", async () => {
    const s = await setup();
    const ep = s.models.addPlan(s.ada, { name: "grok", plan: "grok", credential: { access: "fake-plan", refresh: "fake-refresh", expires: Date.now() + 3600000 } });
    const ref = { offeringId: s.models.addModel(s.ada, ep.id, { modelId: "grok-model", image: true }).id };
    expect(() => s.models.setColumnTask(s.ada.id, "general", "image.create", [ref, s.ref])).toThrow("grok/grok-model can't do image.create");
  });
  it("removes PNG text and EXIF metadata from provider output", () => {
    const chunk = (tag: string) => { const b = Buffer.alloc(18); b.writeUInt32BE(6); b.write(tag, 4); b.write("secret", 8); return b; };
    const dirty = Buffer.concat([png.subarray(0, 33), chunk("tEXt"), chunk("iTXt"), chunk("zTXt"), chunk("eXIf"), png.subarray(33)]);
    expect(cleanPng(dirty).bytes).toEqual(png);
  });
});

describe("LoRAs asked for by name (docs/models.md, \"LoRAs for one call\")", () => {
  const FILES = ["l/pixel_art_v2.safetensors", "l/pixel_art_v2_extra_strong.safetensors", "w/detail_high_noise.safetensors", "w/detail_low_noise.safetensors"];
  it("matches a name loosely: the file it names, else the shortest that contains it, and both of a high and low noise pair", () => {
    expect(matchLora("Pixel-Art", FILES)).toEqual(["l/pixel_art_v2.safetensors"]);
    expect(matchLora("pixel art v2 extra strong", FILES)).toEqual(["l/pixel_art_v2_extra_strong.safetensors"]);
    expect(matchLora("detail", FILES)).toEqual(["w/detail_high_noise.safetensors", "w/detail_low_noise.safetensors"]);
    expect(matchLora("watercolour", FILES)).toEqual([]);
    expect(loraFiles([{ name: "pixel art", strength: 0.7 }, { name: "ink", strength: 1 }], FILES))
      .toEqual({ loras: [{ file: "l/pixel_art_v2.safetensors", strength: 0.7 }], missing: ["ink"] });
  });
  it("goes to a host recipe that takes every LoRA named, sends their files, and says which model it passed over", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    const styles = await s.host("styles", undefined, undefined, undefined, FILES);
    // The workstation takes none and is first on the list: it is passed over, and that is said.
    s.models.setColumnTask(s.ada.id, "private", "image.create", [s.workstation.ref, styles.ref]);
    const asked = [{ name: "pixel art", strength: 0.7 }];
    const made = await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", loras: asked });
    expect(made.resolution.ref).toEqual(styles.ref);
    expect(made.resolution.passedOver).toEqual([{ label: "shared.workstation/Art", reason: "it takes no LoRAs" }]);
    expect(styles.server.images.map(i => i.body)).toEqual([{ recipe: "art", prompt: "A garden", loras: [{ file: "l/pixel_art_v2.safetensors", strength: 0.7 }] }]);
    // Off the list, it is still found and tried first; the names are what her tool lists.
    s.models.setColumnTask(s.ada.id, "private", "image.create", [s.workstation.ref]);
    const found = s.models.loraModels(ctx, "image.create", asked);
    expect(found.ids).toEqual([styles.ref.offeringId]);
    expect(found.names).toEqual(["detail high noise", "detail low noise", "pixel art v2", "pixel art v2 extra strong"]);
    expect((await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", loras: asked }, { first: found.ids })).resolution.ref).toEqual(styles.ref);
    // One that no model takes finds none; a call without LoRAs sends none.
    expect(s.models.loraModels(ctx, "image.create", [{ name: "ink", strength: 1 }]).ids).toEqual([]);
    await expect(s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", loras: [{ name: "ink", strength: 1 }] })).rejects.toThrow(/takes no LoRAs/);
    await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality" });
    expect(s.workstation.server.images.at(-1)!.body).not.toHaveProperty("loras");
    // A cloud model takes none.
    s.models.setColumnTask(s.ada.id, "general", "image.create", [s.ref, styles.ref]);
    expect((await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "quality", loras: asked })).resolution.passedOver).toEqual([{ label: "openai/gpt-image-1", reason: "it takes no LoRAs" }]);
    await expect(s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", loras: [{ name: "pixel art", strength: 9 }] })).rejects.toThrow(/-4 to 4/);
  });
  it("sends a clip's LoRA, both files of a high and low noise pair", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    const styles = await s.host("styles", undefined, undefined, undefined, FILES);
    s.models.setColumnTask(s.ada.id, "private", "video", [styles.clip]);
    await s.models.video(ctx, { prompt: "A fox", loras: [{ name: "detail", strength: 0.5 }] });
    expect(styles.server.videos).toEqual([{ recipe: "clip", prompt: "A fox", loras: [{ file: "w/detail_high_noise.safetensors", strength: 0.5 }, { file: "w/detail_low_noise.safetensors", strength: 0.5 }] }]);
  });
});

describe("a failed image call's error", () => {
  const image = { bytes: png, type: "image/png" as const };
  it("passes on the host's own message, such as a recipe that doesn't fit its GPU", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: "too_big", message: "This model needs about 18 GB on GPU 0; it has 16 GB." } }, { status: 413 })) as unknown as typeof globalThis.fetch;
    await expect(imageAt({ fetch, baseUrl: "https://host.example", host: true, modelId: "recipe/art" }, { action: "edit", prompt: "Add eyeliner", image }))
      .rejects.toMatchObject({ code: "too_big", message: "image endpoint answered 413: This model needs about 18 GB on GPU 0; it has 16 GB." });
  });
  it("names a cloud error's code, type and parameter, never its message", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: "invalid_value", type: "invalid_request_error", param: "size", message: "SECRET provider prompt" } }, { status: 400 })) as unknown as typeof globalThis.fetch;
    const failed = imageAt({ fetch, baseUrl: "https://images.example/v1", host: false, modelId: "gpt-image-1", apiKey: "fake-key" }, { action: "create", prompt: "A garden", tier: "fast" });
    await expect(failed).rejects.toMatchObject({ code: "invalid", message: "image endpoint answered 400 (code invalid_value, type invalid_request_error, parameter size)" });
    await expect(failed).rejects.not.toMatchObject({ message: expect.stringContaining("SECRET") });
  });
});

describe("video calls through the router (principles 1 and 2)", () => {
  it("makes a clip from a prompt and from a first frame on a host's video recipe, never naming parts", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.clip]);
    const out = await s.models.video(ctx, { prompt: "A fox in the snow", duration: 5 });
    expect(out.video).toMatchObject({ type: "video/mp4", width: 1280, height: 704, frames: 121, fps: 24, duration: 5.04, audio: false, seed: 7, poster: { type: "image/png", width: 1, height: 1 } });
    expect(out.resolution.ref).toEqual(s.workstation.clip);
    await s.models.video(ctx, { prompt: "It runs off", image: input, size: { width: 1024, height: 576 } });
    expect(s.workstation.server.videos).toEqual([
      { recipe: "clip", prompt: "A fox in the snow", duration: 5 },
      { recipe: "clip", prompt: "It runs off", image: png.toString("base64"), width: 1024, height: 576 },
    ]);
  });
  it("takes only video recipes for the list, and passes over one that can't animate for a first frame", async () => {
    const s = await setup();
    expect(() => s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.ref])).toThrow(/can't do video/);
    s.models.setColumnTask(s.ada.id, "general", "video", [s.spare.clip]);
    s.models.setCapabilities(s.ada, s.spare.clip.offeringId, { animate: false });
    await expect(s.models.video(s.ctx(), { prompt: "It runs off", image: input })).rejects.toThrow(/doesn't animate images/);
    expect((await s.models.video(s.ctx(), { prompt: "A fox" })).resolution.ref).toEqual(s.spare.clip);
  });
  it("moves an image as a driving clip moves only on a recipe that does motion, and passes over one that doesn't", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    const drive = mp4;
    s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.clip, s.workstation.moves]);
    const out = await s.models.video(ctx, { prompt: "A plain studio", image: input, drive });
    expect(out.resolution.ref).toEqual(s.workstation.moves);
    expect(s.workstation.server.videos).toEqual([{ recipe: "moves", prompt: "A plain studio", image: png.toString("base64"), drive: drive.toString("base64") }]);
    // A clip from a prompt or a first frame still goes to the recipe that makes those.
    expect((await s.models.video(ctx, { prompt: "A fox" })).resolution.ref).toEqual(s.workstation.clip);
    s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.clip]);
    await expect(s.models.video(ctx, { prompt: "x", image: input, drive })).rejects.toThrow(/doesn't move an image as a clip does/);
    // A driving clip needs its subject, and must be an MP4.
    await expect(s.models.video(ctx, { prompt: "x", drive })).rejects.toThrow(/needs the image/);
    await expect(s.models.video(ctx, { prompt: "x", image: input, drive: png })).rejects.toThrow(/MP4/);
    // An offering that does only motion is no chat model.
    const ids = s.models.offerings(s.ada.id, s.workstation.ep.id).map((o) => o.modelId);
    expect(ids).toContain("recipe/moves");
  });
  it("sends a video past a model's longest, and a clip to extend, only to a recipe that chains clips, and names the longest", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.clip, s.workstation.long]);
    expect(s.models.firstVideoModel(ctx)).toEqual({ name: "Clip", longestSeconds: 8, extend: false, sound: false });
    // Up to its longest the first model makes it; past it, or to extend, the next one that can.
    expect((await s.models.video(ctx, { prompt: "A fox", duration: 8 })).resolution.ref).toEqual(s.workstation.clip);
    const long = await s.models.video(ctx, { prompt: "A fox", duration: 16 });
    expect(long.resolution.ref).toEqual(s.workstation.long);
    expect(long.resolution.skipped).toEqual([expect.objectContaining({ reason: "it makes videos of at most 8 s" })]);
    expect((await s.models.video(ctx, { prompt: "It goes on", extend: mp4, duration: 4 })).resolution.ref).toEqual(s.workstation.long);
    expect(s.workstation.server.videos.slice(-1)).toEqual([{ recipe: "long", prompt: "It goes on", extend: mp4.toString("base64"), duration: 4 }]);
    s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.clip]);
    await expect(s.models.video(ctx, { prompt: "A fox", duration: 16 })).rejects.toThrow(/at most 8 s/);
    await expect(s.models.video(ctx, { prompt: "It goes on", extend: mp4 })).rejects.toThrow(/doesn't extend clips/);
  });
  it("gives a chained video a timeout per clip it may take", () => {
    expect(videoTimeout({})).toBe(VIDEO_TIMEOUT_MS);
    expect(videoTimeout({ duration: 8 })).toBe(2 * VIDEO_TIMEOUT_MS);
    expect(videoTimeout({ duration: 60 })).toBe(12 * VIDEO_TIMEOUT_MS);
  });
  it("takes a thread's own Videos pick over the column, and names any video recipe for its drawer", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "private", "video", [s.workstation.clip]);
    const ctx = s.ctx({ pool: "private", localOnly: true, overrides: { video: [s.workstation.moves] } });
    // The drawer resolves with no kind of clip, so a recipe that only moves images still shows as the thread's pick.
    expect(s.models.resolveModel("video", ctx)).toEqual(s.workstation.moves);
    expect(() => s.models.resolveModel("video", s.ctx({ pool: "private", localOnly: true, overrides: { video: [s.workstation.ref] } }))).toThrow(/doesn't make videos/);
    const out = await s.models.video(ctx, { prompt: "A plain studio", image: input, drive: mp4 });
    expect(out.resolution.ref).toEqual(s.workstation.moves);
    await expect(s.models.video(ctx, { prompt: "A fox" })).rejects.toThrow(/doesn't make videos from a prompt/);
  });
  it("refuses a bad request before any call", async () => {
    const s = await setup();
    s.models.setColumnTask(s.ada.id, "general", "video", [s.spare.clip]);
    await expect(s.models.video(s.ctx(), { prompt: " " })).rejects.toThrow(/needs a prompt/);
    await expect(s.models.video(s.ctx(), { prompt: "A fox", duration: 61 })).rejects.toThrow(/1 to 60 seconds/);
    await expect(s.models.video(s.ctx(), { prompt: "A fox", extend: mp4, image: input })).rejects.toThrow(/keeps its own/);
    await expect(s.models.video(s.ctx(), { prompt: "A fox", extend: png })).rejects.toThrow(/MP4/);
    expect(s.spare.server.videos).toEqual([]);
  });
});
