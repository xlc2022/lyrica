import { once } from "node:events";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePhotosDir } from "@lyrica/core";
import { createImageExtension } from "@lyrica/extension";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { png } from "../../core/test/fake-images.ts";
import { apiRoutes } from "../src/routes.ts";
import { match, statusOf, type Request } from "../src/http.ts";
import { Lyricad } from "../src/lyricad.ts";
import { runtime } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

/** Real routes, sessions and encrypted databases; no listening sockets or model calls. */
async function setup() {
  const rt = await runtime();
  const d = new Lyricad({ home: rt.home, port: 0, selfTest: false, log: () => {}, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } });
  await d.unlock("passphrase");
  await d.services!.users.authenticate("ada", "pw"); await d.services!.users.authenticate("sam", "pw2");
  const homes = new Map([rt.ada, rt.sam].map(u => [u.id, join(rt.home, `test-home-${u.id}`)]));
  for (const home of homes.values()) { mkdirSync(home); ensurePhotosDir(home); }
  // Synthetic image files stand in for the mounted homes; key checks remain real.
  vi.spyOn(d.services!.workspace as unknown as { imageHome(id: string): string }, "imageHome").mockImplementation(id => {
    d.keyring.userKey(id); return homes.get(id)!;
  });
  const cookies = new Map([rt.ada, rt.sam].map(u => [u.id, d.sessions.login(undefined, u.id, () => false).id]));
  const view = d.services!.memory.openThreadView(rt.ada.id, "private");
  const thread = view.own.createThread({ interface: "web", title: "images" }); view.close();
  const dir = join(homes.get(rt.ada.id)!, "threads", encodeURIComponent(thread.id)); mkdirSync(dir, { recursive: true });
  const routes = apiRoutes(d);
  async function call(method: string, path: string, userId: string | null = rt.ada.id, body: unknown = {}) {
    const url = new URL(path, "http://localhost"); const found = match(routes, method, url.pathname);
    if (!found || found === "method") throw new Error("test route not found");
    let status = 200; let headers: Record<string, string> = {}; const chunks: Buffer[] = [];
    const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    Object.assign(res, { writeHead(code: number, h: Record<string, string>) { status = code; headers = h; return res; } });
    const r = { params: found.params, query: url.searchParams, cookie: userId ? cookies.get(userId) : undefined, res,
      json: async () => body, bytes: async () => Buffer.from(body as Buffer) } as unknown as Request;
    try {
      const done = once(res, "finish");
      const value = await found.route.handler(r);
      if (value === undefined) await done; else res.end();
      return { status, headers, value, bytes: Buffer.concat(chunks) };
    } catch (err) { res.end(); return { status: statusOf(err), headers, value: undefined, bytes: Buffer.concat(chunks) }; }
  }
  return { rt, d, homes, dir, thread, call };
}

describe("image routes (principles 1 and 2)", () => {
  it("serves sniffed, uncached thread results only to their owner; traversal and symlinks are 404", async () => {
    const { rt, d, homes, dir, thread, call } = await setup();
    try {
      mkdirSync(join(dir, "images")); writeFileSync(join(dir, "images", "result.txt"), png);
      const base = `/api/u/${rt.ada.id}/threads/private/${encodeURIComponent(thread.id)}/file`;
      const url = `${base}?path=${encodeURIComponent("/workspace/images/result.txt")}`;
      const result = await call("GET", url);
      expect(result.status).toBe(200); expect(result.bytes).toEqual(png);
      expect(result.headers).toMatchObject({ "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      expect((await call("GET", url, null)).status).toBe(401);
      expect((await call("GET", url, rt.sam.id)).status).toBe(404);
      expect((await call("GET", url.replace(rt.ada.id, rt.sam.id), rt.sam.id)).status).toBe(404);
      writeFileSync(join(homes.get(rt.ada.id)!, "photos-of-me", "portrait.png"), png);
      symlinkSync(join(homes.get(rt.ada.id)!, "photos-of-me"), join(dir, "escape"));
      symlinkSync(join(homes.get(rt.ada.id)!, "photos-of-me", "portrait.png"), join(dir, "link.png"));
      for (const path of ["../photos-of-me/portrait.png", "/workspace/../photos-of-me/portrait.png", "escape/portrait.png", "link.png", "/photos-of-me/portrait.png", "images", "/tmp/result.png"]) {
        expect((await call("GET", `${base}?path=${encodeURIComponent(path)}`)).status).toBe(404);
      }
    } finally { await d.stop(); }
  });

  it("lists, uploads and deletes portraits per user, strips metadata and rejects other users and invalid images", async () => {
    const { rt, d, homes, call } = await setup();
    try {
      const base = `/api/u/${rt.ada.id}/photos-of-me`;
      expect((await call("GET", base)).value).toEqual([]);
      const text = Buffer.alloc(18); text.writeUInt32BE(6); text.write("tEXt", 4); text.write("secret", 8);
      const dirty = Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]);
      const upload = await call("POST", base, rt.ada.id, dirty);
      expect(upload.status).toBe(200); const { path } = upload.value as { path: string };
      expect((await call("GET", base)).value).toEqual([{ path, size: png.length, type: "image/png" }]);
      expect((await call("GET", base.replace(rt.ada.id, rt.sam.id), rt.sam.id)).value).toEqual([]);
      expect((await call("POST", base, rt.sam.id, png)).status).toBe(404);
      expect((await call("POST", base, rt.ada.id, Buffer.alloc(16))).status).toBe(400);
      const name = path.split("/").at(-1)!;
      const photo = await call("GET", `${base}/${name}`);
      expect(photo.bytes).toEqual(png);
      expect(photo.headers).toMatchObject({ "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox" });
      expect((await call("GET", `${base}/${name}`, null)).status).toBe(401);
      expect((await call("GET", `${base}/${name}`, rt.sam.id)).status).toBe(404);
      expect((await call("GET", `${base.replace(rt.ada.id, rt.sam.id)}/${name}`, rt.sam.id)).status).toBe(404);
      expect((await call("GET", `${base}/..%2F${name}`)).status).toBe(404);
      writeFileSync(join(homes.get(rt.ada.id)!, "photos-of-me", "other.txt"), "synthetic non-image");
      expect((await call("GET", `${base}/other.txt`)).status).toBe(404);
      symlinkSync(join(homes.get(rt.ada.id)!, "photos-of-me", name), join(homes.get(rt.ada.id)!, "photos-of-me", "link.png"));
      expect((await call("GET", base)).value).toHaveLength(1);
      expect((await call("GET", `${base}/link.png`)).status).toBe(404);
      expect((await call("DELETE", `${base}/link.png`)).status).toBe(404);
      expect((await call("DELETE", `${base}/..%2F${name}`)).status).toBe(404);
      expect((await call("DELETE", `${base}/${name}`, rt.sam.id)).status).toBe(404);
      expect((await call("DELETE", `${base}/${name}`)).status).toBe(200);
      expect((await call("GET", base)).value).toEqual([]);
    } finally { await d.stop(); }
  });

  it("Never prevents portrait bytes reaching a cloud image call, while ordinary images still work (principle 2)", async () => {
    const { rt, d, thread, call } = await setup();
    const send = vi.fn(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    vi.stubGlobal("fetch", send);
    try {
      const services = d.services!, models = services.models;
      const user = services.users.get(rt.ada.id)!;
      const ep = models.addEndpoint(user, { name: "cloud-images", kind: "cloud", baseUrl: "https://images.example/v1", apiKey: "fake-key" });
      const ref = { offeringId: models.addModel(user, ep.id, { modelId: "gpt-image-1", image: true, edit: true }).id };
      for (const task of ["image.create", "image.edit"] as const) models.setProfile(user.id, "cloud", task, [ref]);
      const { path } = (await call("POST", `/api/u/${user.id}/photos-of-me`, user.id, png)).value as { path: string };
      await call("PUT", `/api/u/${user.id}/photo-cloud`, user.id, { policy: "never" });
      let tool!: ToolDefinition;
      const approve = vi.fn(async () => true);
      createImageExtension({ models, threadId: thread.id,
        call: () => ({ userId: user.id, pool: "general", localOnly: false }),
        files: services.workspace.imageFiles({ userId: user.id, pool: "private", threadId: thread.id }),
        settings: () => services.workspace.settings(user.id), enabled: () => true, approve,
      })({ registerTool: (t: ToolDefinition) => { tool = t; } } as unknown as ExtensionAPI);
      const run = (args: unknown) => tool.execute("portrait", args, undefined, undefined, { hasUI: false } as ExtensionToolContext);
      await expect(run({ action: "create", prompt: "A garden", tier: "quality", references: [path] })).rejects.toThrow(/aren't allowed/);
      await expect(run({ action: "edit", instruction: "Add flowers", image: path })).rejects.toThrow(/aren't allowed/);
      expect(send).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
      await run({ action: "create", prompt: "A garden", tier: "fast" });
      expect(send).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); await d.stop(); }
  });

  it("reads and changes only this user's photo cloud setting, validating all values", async () => {
    const { rt, d, call } = await setup();
    try {
      const base = `/api/u/${rt.ada.id}/photo-cloud`;
      expect((await call("GET", base)).value).toEqual({ policy: "ask" });
      for (const policy of ["never", "always", "ask"]) expect((await call("PUT", base, rt.ada.id, { policy })).value).toEqual({ policy });
      expect((await call("PUT", base, rt.ada.id, { policy: "always" })).status).toBe(200);
      expect((await call("GET", base.replace(rt.ada.id, rt.sam.id), rt.sam.id)).value).toEqual({ policy: "ask" });
      expect((await call("PUT", base, rt.sam.id, { policy: "never" })).status).toBe(404);
      expect((await call("PUT", base, rt.ada.id, { policy: "maybe" })).status).toBe(400);
      expect((await call("GET", base)).value).toEqual({ policy: "always" });
    } finally { await d.stop(); }
  });

  it("removes JPEG and WebP metadata before saving portraits", async () => {
    const { rt, d, homes, call } = await setup();
    try {
      const base = `/api/u/${rt.ada.id}/photos-of-me`;
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, ...Buffer.from("secret"),
        0xff, 0xda, 0, 2, 5, 0xff, 0, 7, 0xff, 0xd0, 8, 0xff, 0xfe, 0, 8, ...Buffer.from("secret"), 0xff, 0xd9]);
      const chunk = (tag: string, data: Buffer) => {
        const b = Buffer.alloc(8 + data.length + data.length % 2); b.write(tag); b.writeUInt32LE(data.length, 4); data.copy(b, 8); return b;
      };
      const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), chunk("VP8X", Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), chunk("EXIF", Buffer.from("secret")), chunk("XMP ", Buffer.from("secret")), chunk("VP8 ", Buffer.alloc(4))]);
      webp.writeUInt32LE(webp.length - 8, 4);
      const { readFileSync } = await import("node:fs");
      for (const bytes of [jpeg, webp]) {
        const upload = await call("POST", base, rt.ada.id, bytes); expect(upload.status).toBe(200);
        const { path } = upload.value as { path: string };
        const saved = readFileSync(join(homes.get(rt.ada.id)!, path.slice(1)));
        expect(saved.includes(Buffer.from("secret"))).toBe(false);
        expect(saved.includes(Buffer.from("EXIF"))).toBe(false); expect(saved.includes(Buffer.from("XMP "))).toBe(false);
      }
      expect((await call("POST", base, rt.ada.id, Buffer.from([0xff, 0xd8, 0xff]))).status).toBe(400);
    } finally { await d.stop(); }
  });
});
