// Wiping memory (DESIGN.md, "Wiping memory"): an administrator, with their own
// password and the box ticked, deletes every user's threads and memories in
// both pools. Users, passwords and endpoints stay; running work is stopped first.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KEPT_USER_TABLES, WIPED_USER_TABLES } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { EndpointInfo, Skills, ThreadSummary, WipeResult } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

describe("wiping memory", () => {
  it("empties both pools for every user and keeps logins, endpoints and settings", async () => {
    const rt = await runtime();
    const { base, d, logs } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const au = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const general = (await ada.post<ThreadSummary>(`${au}/threads`, { pool: "general", title: "Miso the cat" })).body;
    await ada.post<ThreadSummary>(`${au}/threads`, { pool: "private", title: "A private worry" });
    await ada.put(`${au}/threads/general/${enc(general.id)}/pin`, {});
    await sam.post<ThreadSummary>(`${su}/threads`, { pool: "general", title: "Sam's plans" });
    // Sam locks: their pools go now, their user.db rows at their next unlock.
    await sam.post(`${su}/lock`, {});

    // Administrators only, with their own password and the box ticked.
    expect((await sam.post(`${su}/admin/wipe`, { password: "pw2", understood: true })).status).toBe(401);
    expect((await ada.post(`${au}/admin/wipe`, { password: "pw", understood: false })).status).toBe(400);
    expect((await ada.post(`${au}/admin/wipe`, { password: "not-ada", understood: true })).status).toBe(401);
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body).toHaveLength(2);

    const done = await ada.post<WipeResult>(`${au}/admin/wipe`, { password: "pw", understood: true });
    expect(done.body).toEqual({ wiped: true, busy: [] });
    // Ada stays signed in, with no threads in either pool and the endpoint still there.
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body).toEqual([]);
    expect((await ada.get<EndpointInfo[]>(`${au}/endpoints`)).body.map((e) => e.name)).toContain("gpu");
    const db = d.services!.users.openUserDb(rt.ada.id);
    try { expect(db.prepare("SELECT count(*) AS n FROM pinned_threads").get()).toEqual({ n: 0 }); } finally { db.close(); }
    // Sam's pools are gone while they're locked; logging in still works, and opens empty pools.
    expect(existsSync(join(rt.home, "users", rt.sam.id, "general.db"))).toBe(false);
    const sam2 = await login(base, "sam", "pw2");
    expect((await sam2.get<ThreadSummary[]>(`${su}/threads`)).body).toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/Miso|worry|Sam's plans/);
  });

  it("sends a stop to running work and wipes only once everything has stopped", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const au = `/api/u/${rt.ada.id}`;
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const thread = (await ada.post<ThreadSummary>(`${au}/threads`, { pool: "general", title: "long work" })).body;
    const path = `${au}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    model.reply({ text: "a very slow answer", slowMs: 60_000 });
    await ada.post(`${path}/messages`, { text: "take your time" });
    await stream.until((e) => e.type === "turn_start", 0, 10_000);

    const first = (await ada.post<WipeResult>(`${au}/admin/wipe`, { password: "pw", understood: true })).body;
    expect(first).toEqual({ wiped: false, busy: [{ kind: "turn", user: "Ada", pool: "general" }] });
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body).toHaveLength(1);
    await stream.until((e) => e.type === "turn_end", 0, 10_000);
    expect((await ada.get<WipeResult>(`${au}/admin/wipe`)).body).toEqual({ wiped: false, busy: [] });
    expect((await ada.post<WipeResult>(`${au}/admin/wipe`, { password: "pw", understood: true })).body).toEqual({ wiped: true, busy: [] });
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body).toEqual([]);
    stream.close();
  });

  it("refuses new messages while it runs, and still leaves no threads", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const au = `/api/u/${rt.ada.id}`;
    const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
    await localModel(ada, rt.ada.id, model.baseUrl);
    const thread = (await ada.post<ThreadSummary>(`${au}/threads`, { pool: "general", title: "late message" })).body;
    // Stopping the user's work takes a moment: a message sent meanwhile is refused.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const stop = d.services!.sleep.stop.bind(d.services!.sleep);
    vi.spyOn(d.services!.sleep, "stop").mockImplementation(async (id) => { await held; return stop(id); });
    const wiping = ada.post<WipeResult>(`${au}/admin/wipe`, { password: "pw", understood: true });
    await vi.waitFor(() => expect(d.services!.sleep.stop).toHaveBeenCalled());
    const late = await ada.post(`${au}/threads/general/${enc(thread.id)}/messages`, { text: "one more thing" });
    expect(late.status).toBe(409);
    expect((await ada.post(`${au}/admin/wipe`, { password: "pw", understood: true })).status).toBe(409);
    release();
    expect((await wiping).body).toEqual({ wiped: true, busy: [] });
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  it("wipes only the user's own memory from Settings, with their own password", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const au = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    const adas = (await ada.post<ThreadSummary>(`${au}/threads`, { pool: "general", title: "Ada's garden" })).body;
    await ada.put(`${au}/threads/general/${enc(adas.id)}/pin`, {});
    await sam.post<ThreadSummary>(`${su}/threads`, { pool: "general", title: "Sam's plans" });
    await sam.post<ThreadSummary>(`${su}/threads`, { pool: "private", title: "Sam's worry" });

    // Anyone may wipe their own, not someone else's, and only with their own password and the box ticked.
    expect((await sam.post(`${au}/me/wipe`, { password: "pw2", understood: true })).status).toBe(401);
    expect((await sam.post(`${su}/me/wipe`, { password: "pw2", understood: false })).status).toBe(400);
    expect((await sam.post(`${su}/me/wipe`, { password: "pw", understood: true })).status).toBe(401);
    expect((await sam.get<WipeResult>(`${su}/me/wipe`)).body).toEqual({ wiped: false, busy: [] });
    expect((await sam.post<WipeResult>(`${su}/me/wipe`, { password: "pw2", understood: true })).body).toEqual({ wiped: true, busy: [] });

    // Sam's threads are gone from both pools; Ada's thread and pin stay, and Sam is still signed in.
    expect((await sam.get<ThreadSummary[]>(`${su}/threads`)).body).toEqual([]);
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body.map((t) => t.title)).toEqual(["Ada's garden"]);
    const db = d.services!.users.openUserDb(rt.ada.id);
    try { expect(db.prepare("SELECT count(*) AS n FROM pinned_threads").get()).toEqual({ n: 1 }); } finally { db.close(); }
    expect(existsSync(join(rt.home, "users", rt.ada.id, "general.db"))).toBe(true);
  });

  it("keeps active skills when asked, for an unlocked user at once and a locked one at their next unlock", async () => {
    const rt = await runtime();
    const { base } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const au = `/api/u/${rt.ada.id}`;
    const su = `/api/u/${rt.sam.id}`;
    const skill = (name: string) => ({ name, description: `When ${name} comes up.`, body: "Do it." });
    await ada.post(`${au}/skills`, skill("release"));
    await ada.post(`${au}/skills`, { ...skill("secret-recipe"), pool: "private" });
    await sam.post(`${su}/skills`, skill("sams-way"));
    await ada.post<ThreadSummary>(`${au}/threads`, { pool: "general", title: "Miso the cat" });
    await sam.post(`${su}/lock`, {});

    expect((await ada.post<WipeResult>(`${au}/admin/wipe`, { password: "pw", understood: true, keepSkills: true })).body.wiped).toBe(true);
    expect((await ada.get<ThreadSummary[]>(`${au}/threads`)).body).toEqual([]);
    const names = async (c: typeof ada, u: string) => (await c.get<Skills>(`${u}/skills`)).body.skills.map((k) => `${k.pool}/${k.name}`);
    expect(await names(ada, au)).toEqual(["general/release", "private/secret-recipe"]);
    expect(existsSync(join(rt.home, "users", rt.sam.id, "general.keep.db"))).toBe(true);
    const sam2 = await login(base, "sam", "pw2");
    expect(await names(sam2, su)).toEqual(["general/sams-way"]);
    expect(existsSync(join(rt.home, "users", rt.sam.id, "general.keep.db"))).toBe(false);

    // Without the option, skills go with everything else.
    expect((await ada.post<WipeResult>(`${au}/me/wipe`, { password: "pw", understood: true })).body.wiped).toBe(true);
    expect(await names(ada, au)).toEqual([]);
  });

  it("finishes the rest of a wipe when the kept skills can't be read, leaving them for the next unlock", async () => {
    const rt = await runtime();
    const { base, d, logs } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(base, "ada", "pw");
    const sam = await login(base, "sam", "pw2");
    const su = `/api/u/${rt.sam.id}`;
    const plans = (await sam.post<ThreadSummary>(`${su}/threads`, { pool: "general", title: "Sam's plans" })).body;
    await sam.put(`${su}/threads/general/${enc(plans.id)}/pin`, {});
    await sam.post(`${su}/lock`, {});
    expect((await ada.post<WipeResult>(`/api/u/${rt.ada.id}/admin/wipe`, { password: "pw", understood: true, keepSkills: true })).body.wiped).toBe(true);
    const kept = join(rt.home, "users", rt.sam.id, "general.keep.db");
    writeFileSync(kept, "not a database");
    const sam2 = await login(base, "sam", "pw2");
    expect((await sam2.get<ThreadSummary[]>(`${su}/threads`)).body).toEqual([]);
    expect(existsSync(kept)).toBe(true);
    expect(logs.join("\n")).toContain("keeping skills through a wipe failed");
    const db = d.services!.users.openUserDb(rt.sam.id);
    try { expect(db.prepare("SELECT count(*) AS n FROM pinned_threads").get()).toEqual({ n: 0 }); } finally { db.close(); }
  });

  it("names every user.db table as wiped or kept", async () => {
    const rt = await runtime();
    const { base, d } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    await login(base, "ada", "pw");
    const db = d.services!.users.openUserDb(rt.ada.id);
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name).sort();
      expect(tables).toEqual([...WIPED_USER_TABLES, ...KEPT_USER_TABLES].sort());
    } finally { db.close(); }
  });
});
