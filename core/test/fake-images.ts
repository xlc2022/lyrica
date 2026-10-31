import { expect, vi } from "vitest";
import { Models, Users, type CallContext } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";
/** An MP4's first box, enough for the router's check. */
export const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
export async function fakeImages() {
  const keyring = await freshKeyring(), users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const models = new Models(keyring, users);
  const hostFetches = new Map<string, typeof fetch>();
  vi.spyOn(models, "fetchFor").mockImplementation(ep => hostFetches.get(ep.id));
  /** `loras`: the LoRA files its Art and Clip recipes take for one call. `upscalesClips`: Art upscales clips too, as SeedVR2 does. */
  const host = async (name: string, useFor?: "fast" | "quality" | "both", mask?: boolean, references?: number, loras?: string[], upscalesClips = true) => {
    const takes = loras ? { takesLoras: loras } : {};
    const images: { action: string; body: Record<string, unknown> }[] = [];
    const videos: Record<string, unknown>[] = [];
    const upscaled: Record<string, unknown>[] = [];
    let down: string | false = false;
    let output: Buffer = png;
    const ep = models.addEndpoint(ada, { name, kind: "local", baseUrl: `https://${name}.example/v1` }, { shared: true });
    // A paired host's persisted endpoint shape; TLS itself is covered by host tests.
    keyring.self().prepare("UPDATE endpoints SET api = 'host', addresses = ?, pin = ? WHERE id = ?").run(JSON.stringify([`${name}.example`]), "fake-pin", ep.id);
    const server = { images, videos, upscaled, useFor, imagesOff(code: string | false = "unavailable") { down = code; }, replyImage(bytes: Buffer) { output = bytes; } };
    hostFetches.set(ep.id, (async (url: string, opts: RequestInit = {}) => {
      const path = new URL(url).pathname;
      if (path === "/host/v1/status") return Response.json({ state: "running" });
      if (path === "/host/v1/models") return Response.json({ models: [] });
      if (path === "/host/v1/recipes") return Response.json({ recipes: [
        { id: "art", name: "Art", state: "confirmed", ready: true, useFor: server.useFor, does: ["create", "edit", "upscale", ...upscalesClips ? ["upscale_video"] : []], ...(mask === undefined ? {} : { mask }), ...(references === undefined ? {} : { references }), ...takes },
        { id: "proposal", name: "Proposal", state: "proposed", ready: true, does: ["create"] },
        { id: "clip", name: "Clip", state: "confirmed", ready: true, does: ["video", "animate"], video: { fps: 24, audio: false, maxSeconds: 8, longestSeconds: 8 }, ...takes },
        { id: "moves", name: "Moves", state: "confirmed", ready: true, does: ["motion"], video: { fps: 16, audio: false } },
        { id: "long", name: "Long", state: "confirmed", ready: true, does: ["video", "animate", "extend"], video: { fps: 24, audio: true, maxSeconds: 15, longestSeconds: 60 } },
      ] });
      if (down) return Response.json({ error: { code: down, message: "Images unavailable." } }, { status: 503 });
      const action = path.split("/").at(-1)!;
      const body = JSON.parse(String(opts.body));
      if (path === "/host/v1/videos/create") {
        if (!["clip", "moves", "long"].includes(body.recipe)) return Response.json({ error: { code: "invalid", message: "That recipe doesn't make videos." } }, { status: 400 });
        expect(Object.keys(body).every(k => ["recipe", "prompt", "image", "drive", "extend", "width", "height", "aspectRatio", "duration", "steps", "loras"].includes(k))).toBe(true);
        videos.push(body);
        return Response.json({ video: { mp4: mp4.toString("base64"), width: 1280, height: 704, frames: 121, fps: 24, duration: 5.04, audio: false, seed: 7 }, poster: png.toString("base64"), seconds: 300 });
      }
      if (path === "/host/v1/videos/upscale") {
        expect(Object.keys(body).every(k => ["recipe", "video", "scale", "maxSize"].includes(k))).toBe(true);
        upscaled.push(body);
        return Response.json({ video: { mp4: mp4.toString("base64"), width: 2560, height: 1408, frames: 121, fps: 24, duration: 5.04, audio: true, seed: 7 }, poster: png.toString("base64"), seconds: 600 });
      }
      if (body.recipe !== "art") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      const allowed = ["recipe", "prompt", "count", "references", "loras", ...(action === "create" ? ["width", "height"] : action === "edit" ? ["image", "mask", "replace"] : ["image", "scale", "maxSize"])];
      expect(Object.keys(body).every(k => allowed.includes(k))).toBe(true);
      images.push({ action, body });
      return Response.json({ images: Array.from({ length: body.count ?? 1 }, () => ({ png: output.toString("base64"), width: 1, height: 1, seed: 42 })), seconds: 0.1 });
    }) as typeof fetch);
    const offerings = await models.discover(ada, ep.id);
    // Art, Clip, Moves and Long: a proposal never resolves.
    expect(offerings.map(o => o.recipe)).toEqual(["Art", "Clip", "Long", "Moves"]);
    expect(offerings[1]).toMatchObject({ video: true, animate: true, longestSeconds: 8 });
    expect(offerings[1]).not.toHaveProperty("sound");
    expect(offerings[1]).not.toHaveProperty("extend");
    expect(offerings[2]).toMatchObject({ video: true, extend: true, longestSeconds: 60, sound: true });
    expect(offerings[3]).toMatchObject({ motion: true });
    expect(offerings[3]).not.toHaveProperty("video");
    const ref = { offeringId: offerings[0]!.id }, clip = { offeringId: offerings[1]!.id }, long = { offeringId: offerings[2]!.id }, moves = { offeringId: offerings[3]!.id };
    models.reportUp(ada.id, ep.id);
    return { server, ep, ref, clip, moves, long };
  };
  const workstation = await host("workstation"), spare = await host("3090");
  const cloud = models.addEndpoint(ada, { name: "openai", kind: "cloud", baseUrl: "https://images.example/v1", apiKey: "fake-key" });
  const ref = { offeringId: models.addModel(ada, cloud.id, { modelId: "gpt-image-1", image: true, edit: true }).id };
  models.reportUp(ada.id, cloud.id);
  const heard: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
    expect(opts.headers).toMatchObject({ authorization: "Bearer fake-key" });
    heard.push({ path: new URL(url).pathname, body: opts.body instanceof FormData ? opts.body : JSON.parse(String(opts.body)) });
    const body = heard.at(-1)!.body;
    const count = body instanceof FormData ? Number(body.get("n") ?? 1) : (body as { n?: number }).n ?? 1;
    return Response.json({ data: Array.from({ length: count }, () => ({ b64_json: png.toString("base64") })) });
  }));
  for (const task of ["image.create", "image.edit", "image.upscale"] as const) models.setColumnTask(ada.id, "private", task, [workstation.ref, spare.ref]);
  for (const task of ["image.create", "image.edit"] as const) models.setColumnTask(ada.id, "general", task, [ref]);
  const ctx = (opts: Partial<CallContext> = {}): CallContext => ({ userId: ada.id, pool: "general", localOnly: false, ...opts });
  return { keyring, users, models, ada, workstation, spare, ref, heard, ctx, host };
}
