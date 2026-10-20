// Wiping memory (DESIGN.md, "Wiping memory"): an administrator, with their own
// password and the box ticked, deletes every user's threads and memories in
// both pools. Users, passwords and endpoints stay; running work is stopped first.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEPT_USER_TABLES, WIPED_USER_TABLES } from "@lyrica/core";
import { fakeOpenAI } from "../../core/test/fake-openai.ts";
import type { EndpointInfo, ThreadSummary, WipeResult } from "../src/api.ts";
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
