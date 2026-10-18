import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudModelForbidden, PLAN_IMAGE_MODEL, planImageDriver } from "../src/index.ts";
import { cleanPng } from "../src/models/images.ts";

import { fakeImages as setup } from "./fake-images.ts";

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

describe("image calls through the router (principles 1 and 2)", () => {
  it("creates, edits and upscales confirmed host recipes, keeping defaults and never naming parts", async () => {
    const s = await setup(), ctx = s.ctx({ pool: "private", localOnly: true });
    expect((await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "fast" })).images[0]).toMatchObject({ type: "image/png", width: 1, height: 1, seed: 42 });
    await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "quality", size: { width: 1024, height: 512 }, count: 2 });
    await s.models.image(ctx, { action: "edit", prompt: "Add flowers", image: input, mask: input, references: [input] });
    await s.models.image(ctx, { action: "upscale", image: input });
    expect(s.workstation.server.images.map(i => i.body)).toEqual([
      { recipe: "art", prompt: "A garden" }, { recipe: "art", prompt: "A garden", width: 1024, height: 512, count: 2 },
      { recipe: "art", prompt: "Add flowers", image: png.toString("base64"), mask: png.toString("base64"), references: [png.toString("base64")] },
      { recipe: "art", image: png.toString("base64") },
    ]);
    expect(s.heard).toEqual([]);
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
  it("uses the plan token and Responses image tool for create and maskless edits, never in restricted threads", async () => {
    const s = await setup();
    const { ref } = await planImages(s);
    for (const task of ["image.create", "image.edit"] as const) s.models.setColumnTask(s.ada.id, "general", task, [ref, s.ref]);
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(opts.headers).toMatchObject({ authorization: "Bearer fake-plan" });
      calls.push({ url, body: JSON.parse(String(opts.body)) });
      return Response.json({ output: [{ type: "image_generation_call", status: "completed", result: png.toString("base64") }] });
    }));
    for (const tier of ["fast", "quality"] as const) {
      const out = await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier, count: 2, size: { width: 1024, height: 1024 }, references: [input] });
      expect(out.images).toHaveLength(2);
      expect(calls.at(-1)!.body).toMatchObject({ model: "gpt-6.1-sol", store: false, tools: [{ type: "image_generation", quality: tier === "fast" ? "low" : "high", size: "1024x1024", output_format: "png" }] });
      expect(calls.at(-1)!.body.input[0].content[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` });
    }
    await s.models.image(s.ctx(), { action: "edit", prompt: "Add flowers", image: input });
    expect(calls.at(-1)!.body.tools[0].action).toBe("edit");
    for (const ctx of [s.ctx({ pool: "private" }), s.ctx({ localOnly: true })]) {
      await expect(s.models.image({ ...ctx, overrides: { "image.create": [ref] } }, { action: "create", prompt: "A garden", tier: "fast" })).rejects.toThrow(CloudModelForbidden);
      await s.models.image(ctx, { action: "create", prompt: "A garden", tier: "fast" });
    }
    expect(calls).toHaveLength(5);
    // Masked edits fall down the list without sending anything to the plan.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => {
      expect(opts.headers).toMatchObject({ authorization: "Bearer fake-key" });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    }));
    expect((await s.models.image(s.ctx(), { action: "edit", prompt: "Add flowers", image: input, mask: input })).resolution.ref).toEqual(s.ref);
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
    expect(planImageDriver(["gpt-5.4-mini", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol-pro", "gpt-realtime-2.1", "gpt-5.3-codex"])).toBe("gpt-6.1-sol");
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
  it("streams plan image calls and reads the image from the finished output item", async () => {
    const s = await setup();
    const { ref } = await planImages(s);
    s.models.setColumnTask(s.ada.id, "general", "image.create", [ref]);
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => {
      sent = { body: JSON.parse(String(opts.body)), headers: opts.headers };
      const events = [
        { type: "response.created", response: { output: [] } },
        { type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: png.toString("base64") } },
        { type: "response.completed", response: { output: [{ type: "image_generation_call", status: "completed" }] } },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const out = await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "quality", size: { width: 896, height: 1184 } });
    expect(out.images).toHaveLength(1);
    // The plan's newest GPT carries the request; its image tool picks the image model.
    expect(sent.body).toMatchObject({ model: "gpt-6.1-sol", stream: true, tools: [{ size: "1024x1536" }] });
    expect(sent.headers).toMatchObject({ accept: "text/event-stream" });
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
    vi.stubGlobal("fetch", vi.fn(async () => kind === "key"
      ? Response.json({ error: { code: "content_policy_violation", message: "SECRET provider prompt" } }, { status: 400 })
      : Response.json({ output: [{ type: "message", content: [{ type: "refusal", refusal: "SECRET provider prompt" }] }] })));
    await expect(s.models.image(s.ctx({ preset: preset.id }), { action: "create", prompt: "A garden", tier: "fast" })).rejects.toMatchObject({ code: "image_refusal", message: "Image generation was refused (image_refusal)." });
    expect(s.workstation.server.images).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([429, 503])("falls back from a plan's HTTP %s to the keyed offering", async status => {
    const s = await setup();
    const { ref } = await planImages(s);
    s.models.setColumnTask(s.ada.id, "general", "image.create", [ref, s.ref]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new URL(url).pathname.endsWith("/responses")
      ? Response.json({ error: { message: "SECRET provider prompt" } }, { status })
      : Response.json({ data: [{ b64_json: png.toString("base64") }] })));
    expect((await s.models.image(s.ctx(), { action: "create", prompt: "A garden", tier: "fast" })).resolution.ref).toEqual(s.ref);
    expect(fetch).toHaveBeenCalledTimes(2);
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
