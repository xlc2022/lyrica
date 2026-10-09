import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { LoginResponse, Me, MemoryDetail, MemoryHit, State, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime, systemdStart } from "./helpers.ts";

describe("lyricad, locked", () => {
  it("answers only the state and unlock endpoints until self.db is unlocked", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    const b = browser(base);
    expect((await b.get<State>("/api/state")).body).toEqual({ locked: true, users: [] });
    expect((await b.post("/api/login", { login: "li", password: "pw" })).status).toBe(503);
    expect((await b.get(`/api/u/${rt.li.id}/threads`)).status).toBe(503);
    expect((await b.post("/api/unlock", { passphrase: "wrong" })).status).toBe(401);
    expect(d.locked).toBe(true);
    const ok = await b.post<State>("/api/unlock", { passphrase: "passphrase" });
    expect(ok.status).toBe(200);
    expect(ok.body.locked).toBe(false);
    expect((await b.post("/api/login", { login: "li", password: "pw" })).status).toBe(200);
    expect(statSync(d.socketPath!).mode & 0o777).toBe(0o600);
  });

  it("starts unlocked, with users' keys, from saved credentials", async () => {
    const rt = await runtime();
    const first = await daemon(rt);
    await browser(first.base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(first.base, "li", "pw");
    expect((await li.put(`/api/u/${rt.li.id}/admin/passphrase`, { save: true, passphrase: "wrong" })).status).toBe(401);
    expect((await li.put(`/api/u/${rt.li.id}/admin/passphrase`, { save: true, passphrase: "passphrase" })).body).toMatchObject({ savedPassphrase: true });
    expect((await li.put<Me>(`/api/u/${rt.li.id}/me/credentials`, { save: true })).body.savedCredentials).toBe(true);
    await first.stop();

    systemdStart(rt);
    const second = await daemon(rt);
    expect(second.d.locked).toBe(false);
    expect(second.d.keyring.hasUserKey(rt.li.id)).toBe(true);
    expect(second.d.keyring.hasUserKey(rt.sam.id)).toBe(false);
    // Turning it off deletes the saved credential.
    const again = await login(second.base, "li", "pw");
    await again.put(`/api/u/${rt.li.id}/me/credentials`, { save: false });
    expect(existsSync(`${rt.sealed}/user-${rt.li.id}`)).toBe(false);
    expect(existsSync(`${rt.sealed}/self`)).toBe(true);
  });
});

describe("logging in", () => {
  it("refuses a wrong password and slows down repeated attempts", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt, { rateLimit: { free: 2, baseMs: 60_000, maxMs: 600_000 } });
    const b = browser(base);
    await b.post("/api/unlock", { passphrase: "passphrase" });
    expect((await b.post("/api/login", { login: "li", password: "nope" })).status).toBe(401);
    expect((await b.post("/api/login", { login: "li", password: "nope" })).status).toBe(401);
    const slowed = await b.post("/api/login", { login: "li", password: "pw" });
    expect(slowed.status).toBe(429);
    expect(Number(slowed.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another login name from the same address is slowed too: the address has failed.
    expect((await b.post("/api/login", { login: "sam", password: "pw2" })).status).toBe(429);
  });

  it("sets a Secure, HttpOnly, SameSite=Strict cookie with a 256-bit ID and refuses cross-origin writes", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const b = await login(base, "li", "pw");
    const flags = b.setCookie!.split(";").map((s) => s.trim());
    expect(flags).toEqual(expect.arrayContaining(["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]));
    expect(Buffer.from(b.cookie!.split("=")[1]!, "base64url")).toHaveLength(32);

    const evil = browser(base, "https://evil.example");
    evil.cookie = b.cookie;
    expect((await evil.post(`/api/u/${rt.li.id}/threads`, { pool: "general" })).status).toBe(403);
    expect((await evil.post("/api/login", { login: "li", password: "pw" })).status).toBe(403);
    const none = await fetch(`${base}/api/u/${rt.li.id}/threads`, { method: "POST", headers: { cookie: b.cookie!, "content-type": "application/json" }, body: "{\"pool\":\"general\"}" });
    expect(none.status).toBe(403);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
    expect(none.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(none.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps several users in one browser, and one user can't reach another's threads, settings or memory", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "private", title: "t" })).body;
    const sam = await login(base, "sam", "pw2");
    const paths = [
      `/api/u/${rt.li.id}/threads`, `/api/u/${rt.li.id}/me`, `/api/u/${rt.li.id}/endpoints`,
      `/api/u/${rt.li.id}/threads/private/${enc(thread.id)}/settings`, `/api/u/${rt.li.id}/threads/private/${enc(thread.id)}/messages`,
      `/api/u/${rt.li.id}/memory/search?q=x`, `/api/u/${rt.li.id}/admin/users`,
    ];
    for (const p of paths) expect((await sam.get(p)).status, p).toBe(401);
    expect((await sam.get(`/api/u/${rt.sam.id}/threads/private/${enc(thread.id)}/settings`)).status).toBe(404);
    expect((await sam.get(`/api/u/${rt.sam.id}/admin/users`)).status).toBe(403);

    // Li adds Sam to her browser: both are available, without a new password to switch.
    expect((await li.post<LoginResponse>("/api/login", { login: "sam", password: "pw2" })).status).toBe(200);
    const state = (await li.get<State>("/api/state")).body;
    expect(state.users.map((u) => u.login).sort()).toEqual(["li", "sam"]);
    expect((await li.get(`/api/u/${rt.sam.id}/me`)).status).toBe(200);
    await li.post("/api/logout", { userId: rt.sam.id });
    expect((await li.get(`/api/u/${rt.sam.id}/me`)).status).toBe(401);
    expect((await li.get(`/api/u/${rt.li.id}/me`)).status).toBe(200);
  });

  it("Lock drops the key, and the user's requests fail until they log in again", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const other = await login(base, "li", "pw");
    expect((await li.post(`/api/u/${rt.li.id}/lock`)).status).toBe(200);
    expect(d.keyring.hasUserKey(rt.li.id)).toBe(false);
    expect((await li.get(`/api/u/${rt.li.id}/threads`)).status).toBe(401);
    expect((await other.get(`/api/u/${rt.li.id}/threads`)).status).toBe(401);
    await li.post("/api/login", { login: "li", password: "pw" });
    expect((await li.get(`/api/u/${rt.li.id}/threads`)).status).toBe(200);
  });
});

describe("settings", () => {
  it("refuses a cloud model for a private thread when it is saved, with the reason", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const cloud = await fakeOpenAI({ models: [{ id: "deepseek" }] });
    const local = await fakeOpenAI();
    await li.post(`/api/u/${rt.li.id}/endpoints`, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl });
    await localModel(li, rt.li.id, local.baseUrl, "m1");
    const t = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "private", title: "p" })).body;
    const url = `/api/u/${rt.li.id}/threads/private/${enc(t.id)}/settings`;
    const refused = await li.patch<{ error: string }>(url, { models: { chat: { endpointId: "openrouter", modelId: "deepseek" } } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/cloud model/);
    expect((await li.patch(url, { localOnly: false })).status).toBe(400);
    // Nothing was written; the allowed list offers only local models.
    const s = (await li.get<ThreadSettings>(url)).body;
    expect(s.models.chat).toMatchObject({ model: { endpointId: "gpu", modelId: "m1" }, source: "profile", kind: "local" });
    expect(s.allowed.map((e) => e.id)).toEqual(["gpu"]);
    // A folder outside the allowed paths is refused too.
    expect((await li.patch(url, { grants: [{ path: "/etc", writable: false }] })).status).toBe(400);
    // A general thread switched to local-only refuses the cloud model as well.
    const g = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "g" })).body;
    const gurl = `/api/u/${rt.li.id}/threads/general/${enc(g.id)}/settings`;
    expect((await li.patch(gurl, { models: { chat: { endpointId: "openrouter", modelId: "deepseek" } } })).status).toBe(200);
    expect((await li.patch(gurl, { localOnly: true })).status).toBe(400);
    expect((await li.patch(gurl, { localOnly: true, models: { chat: null } })).status).toBe(200);
  });
});

describe("the memory browser", () => {
  it("adds, edits and restores a user's memory, keeping mention tokens", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const m = `/api/u/${rt.li.id}/memory`;
    const added = await li.post<MemoryDetail>(`${m}/general/notes`, { text: "{user} grows tomatoes" });
    expect(added.status).toBe(200);
    const { item } = added.body;
    expect(item).toMatchObject({ origin: "user", text: `[[u:${rt.li.id}]] grows tomatoes` });
    expect(added.body.users[rt.li.id]!.displayName).toBe("Li");

    const hits = (await li.get<MemoryHit[]>(`${m}/search?q=tomatoes`)).body;
    expect(hits.map((h) => [h.pool, h.id])).toEqual([["general", item.id]]);
    expect(hits[0]!.snippet).toContain("Li");

    const url = `${m}/general/${enc(item.id)}`;
    await li.patch(url, { text: `[[u:${rt.li.id}]] grows tomatoes and basil` });
    const edited = (await li.get<MemoryDetail>(url)).body;
    expect(edited.revisions).toHaveLength(2);
    await li.post(`${url}/restore`, { revision: edited.revisions[0]!.id });
    expect((await li.get<MemoryDetail>(url)).body.item.text).toBe(`[[u:${rt.li.id}]] grows tomatoes`);
    expect((await li.del(url)).status).toBe(200);
    expect((await li.get(url)).status).toBe(404);
  });
});
