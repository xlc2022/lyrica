import { expect, vi } from "vitest";
import { Models, Users, type CallContext } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
export async function fakeImages() {
  const keyring = await freshKeyring(), users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const models = new Models(keyring, users);
  const hostFetches = new Map<string, typeof fetch>();
  vi.spyOn(models, "fetchFor").mockImplementation(ep => hostFetches.get(ep.id));
  const host = async (name: string, useFor?: "fast" | "quality" | "both", mask?: boolean) => {
    const images: { action: string; body: Record<string, unknown> }[] = [];
    let down: string | false = false;
    let output: Buffer = png;
    const ep = models.addEndpoint(ada, { name, kind: "local", baseUrl: `https://${name}.example/v1` }, { shared: true });
    // A paired host's persisted endpoint shape; TLS itself is covered by host tests.
    keyring.self().prepare("UPDATE endpoints SET api = 'host', addresses = ?, pin = ? WHERE id = ?").run(JSON.stringify([`${name}.example`]), "fake-pin", ep.id);
    const server = { images, useFor, imagesOff(code: string | false = "unavailable") { down = code; }, replyImage(bytes: Buffer) { output = bytes; } };
    hostFetches.set(ep.id, (async (url: string, opts: RequestInit = {}) => {
      const path = new URL(url).pathname;
      if (path === "/host/v1/status") return Response.json({ state: "running" });
      if (path === "/host/v1/models") return Response.json({ models: [] });
      if (path === "/host/v1/recipes") return Response.json({ recipes: [
        { id: "art", name: "Art", state: "confirmed", ready: true, useFor: server.useFor, does: ["create", "edit", "upscale"], ...(mask === undefined ? {} : { mask }) },
        { id: "proposal", name: "Proposal", state: "proposed", ready: true, does: ["create"] },
      ] });
      if (down) return Response.json({ error: { code: down, message: "Images unavailable." } }, { status: 503 });
      const action = path.split("/").at(-1)!;
      const body = JSON.parse(String(opts.body));
      if (body.recipe !== "art") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      const allowed = ["recipe", "prompt", "count", "references", ...(action === "create" ? ["width", "height"] : action === "edit" ? ["image", "mask", "replace"] : ["image", "scale", "maxSize"])];
      expect(Object.keys(body).every(k => allowed.includes(k))).toBe(true);
      images.push({ action, body });
      return Response.json({ images: Array.from({ length: body.count ?? 1 }, () => ({ png: output.toString("base64"), width: 1, height: 1, seed: 42 })), seconds: 0.1 });
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
