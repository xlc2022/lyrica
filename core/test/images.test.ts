import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudModelForbidden } from "../src/index.ts";
import { cleanPng } from "../src/models/images.ts";

import { fakeImages as setup } from "./fake-images.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
const input = { bytes: png, type: "image/png" as const };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    s.models.setProfile(s.ada.id, "local", "image.create", [s.workstation.ref, s.spare.ref, last.ref]);
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
  it("removes PNG text and EXIF metadata from provider output", () => {
    const chunk = (tag: string) => { const b = Buffer.alloc(18); b.writeUInt32BE(6); b.write(tag, 4); b.write("secret", 8); return b; };
    const dirty = Buffer.concat([png.subarray(0, 33), chunk("tEXt"), chunk("iTXt"), chunk("zTXt"), chunk("eXIf"), png.subarray(33)]);
    expect(cleanPng(dirty).bytes).toEqual(png);
  });
});
