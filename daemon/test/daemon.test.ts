import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeHost } from "../../core/test/fake-host.ts";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { CleanupItem, EndpointInfo, HostStatus, LoginResponse, Me, ModelsNotice, OfferingInfo, Profiles, MemoryDetail, MemoryHit, State, ThreadSettings, ThreadSummary } from "../src/api.ts";
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

  it("counts parallel attempts, so a burst of guesses gets one try", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt, { rateLimit: { free: 1, baseMs: 60_000, maxMs: 600_000 } });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const statuses = await Promise.all(Array.from({ length: 5 }, () => browser(base).post("/api/login", { login: "li", password: "nope" })))
      .then((rs) => rs.map((r) => r.status).sort());
    expect(statuses).toEqual([401, 429, 429, 429, 429]);
  });

  it("slows down guessing the current password with a stolen cookie", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt, { rateLimit: { free: 2, baseMs: 60_000, maxMs: 600_000 } });
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const url = `/api/u/${rt.li.id}/me/password`;
    expect((await li.post(url, { oldPassword: "guess1", newPassword: "x" })).status).toBe(401);
    expect((await li.post(url, { oldPassword: "guess2", newPassword: "x" })).status).toBe(401);
    expect((await li.post(url, { oldPassword: "pw", newPassword: "x" })).status).toBe(429);
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

    // Linked (both passwords), the two can share a browser: both are available, without a new password to switch.
    expect((await li.post(`/api/u/${rt.li.id}/links`, { password: "pw", login: "sam", otherPassword: "pw2" })).status).toBe(200);
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
    const t = (await other.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "t" })).body;
    const stream = other.events(`/api/u/${rt.li.id}/threads/general/${enc(t.id)}/events`);
    await stream.ready;
    expect((await li.post(`/api/u/${rt.li.id}/lock`)).status).toBe(200);
    await stream.done; // Lock ends live streams in every browser
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
    const deepseek = { offeringId: (await li.post<EndpointInfo>(`/api/u/${rt.li.id}/endpoints`, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl })).body.models[0]!.id };
    const m1 = await localModel(li, rt.li.id, local.baseUrl, "m1");
    const t = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "private", title: "p" })).body;
    const url = `/api/u/${rt.li.id}/threads/private/${enc(t.id)}/settings`;
    const refused = await li.patch<{ error: string }>(url, { models: { chat: deepseek } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/cloud model/);
    expect((await li.patch(url, { localOnly: false })).status).toBe(400);
    // Nothing was written; the allowed list offers only local models.
    const s = (await li.get<ThreadSettings>(url)).body;
    expect(s.models.chat).toMatchObject({ model: m1, label: "gpu/m1", source: "profile", kind: "local" });
    expect(s.allowed.map((e) => e.name)).toEqual(["gpu"]);
    // A folder outside the allowed paths is refused too.
    expect((await li.patch(url, { grants: [{ path: "/etc", writable: false }] })).status).toBe(400);
    // A general thread switched to local-only refuses the cloud model as well.
    const g = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general", title: "g" })).body;
    const gurl = `/api/u/${rt.li.id}/threads/general/${enc(g.id)}/settings`;
    expect((await li.patch(gurl, { models: { chat: deepseek } })).status).toBe(200);
    expect((await li.patch(gurl, { localOnly: true })).status).toBe(400);
    expect((await li.patch(gurl, { localOnly: true, models: { chat: null } })).status).toBe(200);
  });
});

describe("endpoints and offerings", () => {
  it("keeps IDs through an edit, never returns a key, lets only administrators change shared ones, and tells a user what was rewritten", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const sam = await login(base, "sam", "pw2");
    const local = await fakeOpenAI({ models: [{ id: "qwen3.8-27b" }, { id: "qwen3.8-flash" }] });
    const lan = (await li.post<EndpointInfo>(`/api/u/${rt.li.id}/endpoints`, { name: "lan", kind: "local", baseUrl: local.baseUrl, apiKey: "sk-secret", shared: true })).body;
    expect(lan).toMatchObject({ name: "lan", hasApiKey: true, shared: true, unencrypted: false, stale: false });
    expect(JSON.stringify(lan)).not.toContain("sk-secret");
    const [qwen, flash] = lan.models;
    const edited = (await li.patch<EndpointInfo>(`/api/u/${rt.li.id}/endpoints/${lan.id}`, { name: "blackwell", apiKey: null })).body;
    expect(edited).toMatchObject({ id: lan.id, name: "blackwell", hasApiKey: false });
    expect(edited.models.map((m) => [m.id, m.label])).toEqual([[qwen!.id, "shared.blackwell/qwen3.8-27b"], [flash!.id, "shared.blackwell/qwen3.8-flash"]]);

    const samU = `/api/u/${rt.sam.id}`;
    expect((await sam.put(`${samU}/profiles/local/chat`, { model: { offeringId: qwen!.id } })).status).toBe(200);
    expect((await sam.patch(`${samU}/endpoints/${lan.id}`, { name: "mine" })).status).toBe(403);
    expect((await sam.del(`${samU}/offerings/${qwen!.id}`)).status).toBe(403);
    expect((await sam.patch(`${samU}/offerings/${qwen!.id}`, { tools: true })).status).toBe(403);
    expect((await li.patch<OfferingInfo>(`/api/u/${rt.li.id}/offerings/${qwen!.id}`, { tools: true, contextWindow: 32768 })).body).toMatchObject({ tools: true, contextWindow: 32768 });
    expect((await li.post(`/api/u/${rt.li.id}/offerings/${qwen!.id}/replace`, { with: flash!.id })).status).toBe(200);
    expect((await sam.get<Profiles>(`${samU}/profiles`)).body.local.chat).toEqual([{ offeringId: flash!.id }]);
    expect((await sam.get<ModelsNotice>(`${samU}/models/notice`)).body.lines).toEqual([
      "shared.blackwell/qwen3.8-27b was replaced by shared.blackwell/qwen3.8-flash in the local profile's chat.",
    ]);
    await sam.del(`${samU}/models/notice`);
    expect((await sam.get<ModelsNotice>(`${samU}/models/notice`)).body.lines).toEqual([]);
    expect((await sam.get<CleanupItem[]>(`${samU}/models/cleanup`)).body).toEqual([]);
  });
});

describe("model hosts", () => {
  it("pairs a shared host, shows its status to everyone, and lets only administrators manage it", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const sam = await login(base, "sam", "pw2");
    const host = await fakeHost({ name: "lyrica-blackwell" });
    const bad = await li.post<{ error: string }>(`/api/u/${rt.li.id}/hosts`, { name: "blackwell", addresses: [host.address], code: "0000-0000-0000-0000", shared: true });
    expect(bad).toMatchObject({ status: 400, body: { error: expect.stringMatching(/no pairing code/) } });
    const ep = (await li.post<EndpointInfo>(`/api/u/${rt.li.id}/hosts`, { name: "blackwell", addresses: [host.address], code: host.newCode(), shared: true })).body;
    expect(ep).toMatchObject({ api: "host", kind: "local", shared: true, fingerprint: host.fingerprint, addresses: [host.address] });
    expect(ep.models.map((m) => m.modelId)).toEqual(["lyrica/huggingface/Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf"]);

    const samU = `/api/u/${rt.sam.id}`;
    expect((await sam.get<HostStatus>(`${samU}/hosts/${ep.id}/status`)).body).toMatchObject({ name: "lyrica-blackwell", state: "running" });
    expect((await sam.post(`${samU}/hosts/${ep.id}/pause`)).status).toBe(403);
    expect((await sam.put(`${samU}/hosts/${ep.id}/addresses`, { addresses: ["127.0.0.1:1"] })).status).toBe(403);
    expect((await li.post<HostStatus>(`/api/u/${rt.li.id}/hosts/${ep.id}/pause`)).body.state).toBe("paused");

    // Another key at the same address: refused in plain words.
    await host.replaceKey();
    const changed = await li.get<{ error: string }>(`/api/u/${rt.li.id}/hosts/${ep.id}/status`);
    expect(changed).toMatchObject({ status: 502, body: { error: "This host's identity changed. Pair it again." } });
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
    // Show general off hides the pool from search too, unless ?all=1.
    await li.patch(`/api/u/${rt.li.id}/me/display`, { showGeneral: false });
    expect((await li.get<MemoryHit[]>(`${m}/search?q=tomatoes`)).body).toEqual([]);
    expect((await li.get<MemoryHit[]>(`${m}/search?q=tomatoes&all=1`)).body).toHaveLength(1);

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
