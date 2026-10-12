import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudModelForbidden, Models, Users, type CallContext } from "../src/index.ts";
import { cleanPng } from "../src/models/images.ts";

import { freshKeyring, profile } from "./helpers.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
const input = { bytes: png, type: "image/png" as const };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup() {
  const keyring = await freshKeyring(), users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const models = new Models(keyring, users);
  const hostFetches = new Map<string, typeof fetch>();
  vi.spyOn(models, "fetchFor").mockImplementation(ep => hostFetches.get(ep.id));
  const host = async (name: string) => {
    const images: { action: string; body: Record<string, unknown> }[] = [];
    let down: string | false = false;
    const ep = models.addEndpoint(ada, { name, kind: "local", baseUrl: `https://${name}.example/v1` }, { shared: true });
    // A paired host's persisted endpoint shape; TLS itself is covered by host tests.
    keyring.self().prepare("UPDATE endpoints SET api = 'host', addresses = ?, pin = ? WHERE id = ?").run(JSON.stringify([`${name}.example`]), "fake-pin", ep.id);
    const server = { images, imagesOff(code: string | false = "unavailable") { down = code; } };
    hostFetches.set(ep.id, (async (url: string, opts: RequestInit = {}) => {
      const path = new URL(url).pathname;
      if (path === "/host/v1/status") return Response.json({ state: "running" });
      if (path === "/host/v1/models") return Response.json({ models: [] });
      if (path === "/host/v1/recipes") return Response.json({ recipes: [
        { id: "art", name: "Art", state: "confirmed", ready: true, does: ["create", "edit", "upscale"] },
        { id: "proposal", name: "Proposal", state: "proposed", ready: true, does: ["create"] },
      ] });
      if (down) return Response.json({ error: { code: down, message: "Images unavailable." } }, { status: 503 });
      const action = path.split("/").at(-1)!;
      const body = JSON.parse(String(opts.body));
      if (body.recipe !== "art") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      const allowed = ["recipe", "prompt", "count", "references", ...(action === "create" ? ["width", "height"] : action === "edit" ? ["image", "mask"] : ["image", "scale", "maxSize"])];
      expect(Object.keys(body).every(k => allowed.includes(k))).toBe(true);
      images.push({ action, body });
      return Response.json({ images: [{ png: png.toString("base64"), width: 1, height: 1, seed: 42 }], seconds: 0.1 });
    }) as typeof fetch);
    const offerings = await models.discover(ada, ep.id);
    expect(offerings).toHaveLength(1);
    const ref = { offeringId: offerings[0]!.id };
    models.reportUp(ada.id, ep.id);
    return { server, ep, ref };
  };
  const workstation = await host("workstation"), spare = await host("3090");
  const cloud = models.addEndpoint(ada, { name: "openai", kind: "cloud", baseUrl: "https://images.example/v1", apiKey: "fake-key" });
  const ref = { offeringId: models.addModel(ada, cloud.id, { modelId: "gpt-image-1", image: true, edit: true }).id };
  const heard: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
    expect(opts.headers).toMatchObject({ authorization: "Bearer fake-key" });
    heard.push({ path: new URL(url).pathname, body: opts.body instanceof FormData ? opts.body : JSON.parse(String(opts.body)) });
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  }));
  for (const task of ["image.create", "image.edit", "image.upscale"] as const) models.setProfile(ada.id, "local", task, [workstation.ref, spare.ref]);
  for (const task of ["image.create", "image.edit"] as const) models.setProfile(ada.id, "cloud", task, [ref]);
  const ctx = (opts: Partial<CallContext> = {}): CallContext => ({ userId: ada.id, pool: "general", localOnly: false, ...opts });
  return { models, ada, workstation, spare, ref, heard, ctx };
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
  it("removes PNG text and EXIF metadata from provider output", () => {
    const chunk = (tag: string) => { const b = Buffer.alloc(18); b.writeUInt32BE(6); b.write(tag, 4); b.write("secret", 8); return b; };
    const dirty = Buffer.concat([png.subarray(0, 33), chunk("tEXt"), chunk("iTXt"), chunk("zTXt"), chunk("eXIf"), png.subarray(33)]);
    expect(cleanPng(dirty).bytes).toEqual(png);
  });
});
