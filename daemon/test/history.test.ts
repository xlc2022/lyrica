import { describe, expect, it } from "vitest";
import type { CallInfo, HistoryPage, MemoryDetail, MemoryHistory, SleepOverview, SleepRunInfo } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  return { ...dm, rt, ada, u: `/api/u/${rt.ada.id}` };
}

describe("server-side history", () => {
  it("pages sleep metadata across pools, searches before counting, and excludes hidden pools", async () => {
    const s = await setup();
    for (const pool of ["general", "private"] as const) {
      const view = s.d.services!.memory.openThreadView(s.rt.ada.id, pool);
      try {
        for (let i = 1; i <= 24; i++) view.own.recordSleepRun("scheduled", i % 2 ? "no-activity" : "endpoint-down", `2026-09-${String(i).padStart(2, "0")}T04:00:00.000Z`);
      } finally { view.close(); }
    }
    const path = `${s.u}/sleep/history`;
    const first = (await s.ada.get<HistoryPage<SleepRunInfo>>(`${path}?limit=20`)).body;
    const next = (await s.ada.get<HistoryPage<SleepRunInfo>>(`${path}?limit=20&offset=20`)).body;
    expect(first.total).toBe(48);
    expect(first.entries).toHaveLength(20);
    expect(next.entries).toHaveLength(20);
    expect(next.entries.some((r) => first.entries.some((f) => f.id === r.id && f.pool === r.pool))).toBe(false);
    expect(first.entries[0]!.startedAt).toBe("2026-09-24T04:00:00.000Z");
    const filtered = (await s.ada.get<HistoryPage<SleepRunInfo>>(`${path}?q=ENDPOINT-down&limit=5&offset=5`)).body;
    expect(filtered.total).toBe(24);
    expect(filtered.entries).toHaveLength(5);
    expect(filtered.entries.every((r) => r.skipReason === "endpoint-down")).toBe(true);
    expect((await s.ada.get<HistoryPage<SleepRunInfo>>(`${path}?q=%25`)).body.total).toBe(0);
    expect((await s.ada.get<HistoryPage<SleepRunInfo>>(`${path}?offset=100`)).body.entries).toEqual([]);
    const overview = (await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body;
    expect(overview.runs).toHaveLength(2);
    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    const visible = (await s.ada.get<HistoryPage<SleepRunInfo>>(path)).body;
    expect(visible.total).toBe(24);
    expect(visible.entries.every((r) => r.pool === "general")).toBe(true);
    expect(s.logs.join("\n")).not.toContain("ENDPOINT-down");
  });

  it("returns one revision in details, searches and pages all versions, and restores an older result", async () => {
    const s = await setup();
    const view = s.d.services!.memory.openThreadView(s.rt.ada.id, "private");
    try { view.own.putWake("Initial wake", "sleep"); } finally { view.close(); }
    const path = `${s.u}/memory/private/wake`;
    for (let i = 1; i <= 24; i++) await s.ada.patch(path, { text: `${i % 2 ? "Pelicans" : "Harbour"} version ${i}` });
    const detail = (await s.ada.get<MemoryDetail>(path)).body;
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]!.body.text).toBe("Harbour version 24");
    const first = (await s.ada.get<MemoryHistory>(`${path}/history?limit=20`)).body;
    const next = (await s.ada.get<MemoryHistory>(`${path}/history?limit=20&offset=20`)).body;
    expect(first.total).toBe(25);
    expect(first.entries).toHaveLength(20);
    expect(next.entries).toHaveLength(5);
    expect(first.entries[0]!.id).toBe(detail.revisions[0]!.id);
    const matches = (await s.ada.get<MemoryHistory>(`${path}/history?q=PELICANS&limit=5&offset=5`)).body;
    expect(matches.total).toBe(12);
    expect(matches.entries).toHaveLength(5);
    expect(matches.entries.every((r) => r.body.text.startsWith("Pelicans"))).toBe(true);
    const restored = (await s.ada.post<MemoryDetail>(`${path}/restore`, { revision: matches.entries[0]!.id })).body;
    expect(restored.item.text).toBe(matches.entries[0]!.body.text);
    expect((await s.ada.get<MemoryHistory>(`${path}/history?q=absent`)).body).toMatchObject({ total: 0, entries: [] });
    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    expect((await s.ada.get(`${path}/history`)).status).toBe(404);
    expect(s.logs.join("\n")).not.toContain("Pelicans");
  });

  it("pages and searches call metadata without model requests", async () => {
    const s = await setup(), models = s.d.services!.models;
    const user = s.d.services!.users.get(s.rt.ada.id)!;
    const endpoint = models.addEndpoint(user, { name: "fixture", kind: "local", baseUrl: "http://127.0.0.1:1/v1" });
    const offering = models.addModel(user, endpoint.id, { modelId: "fixture-model", tools: true });
    models.setProfile(user.id, "local", "chat", { offeringId: offering.id });
    const resolution = models.resolve("chat", { userId: user.id, pool: "private", localOnly: true });
    for (let i = 0; i < 25; i++) models.recordCall(user.id, { pool: i % 2 ? "private" : "general", threadId: `fixture-${i}`, task: "chat", resolution, note: i % 2 ? "fallback fixture" : "ordinary" });
    const path = `${s.u}/models/calls/history`;
    const first = (await s.ada.get<HistoryPage<CallInfo>>(`${path}?limit=20`)).body;
    const next = (await s.ada.get<HistoryPage<CallInfo>>(`${path}?limit=20&offset=20`)).body;
    expect(first.total).toBe(25);
    expect(first.entries[0]!.threadId).toBe("fixture-24");
    expect(next.entries).toHaveLength(5);
    expect((await s.ada.get<HistoryPage<CallInfo>>(`${path}?q=FALLBACK`)).body.total).toBe(12);
    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    expect((await s.ada.get<HistoryPage<CallInfo>>(path)).body.total).toBe(13);
  });

  it("rejects invalid bounds on each history API", async () => {
    const s = await setup();
    for (const suffix of ["sleep/history", "models/calls/history", "memory/general/wake/history"]) {
      for (const query of ["limit=0", "limit=101", "offset=-1", "offset=1.5", "limit=NaN", `q=${"x".repeat(201)}`]) {
        expect((await s.ada.get(`${s.u}/${suffix}?${query}`)).status).toBe(400);
      }
    }
  });
});
