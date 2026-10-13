import { describe, expect, it, vi } from "vitest";
import type { CallInfo, DownloadHistory, HostDownload, HistoryPage, MemoryDetail, MemoryHistory, MemoryHit, SleepOverview, SleepRunInfo } from "../src/api.ts";
import { Memory, Models, Users } from "@lyrica/core";
import { freshKeyring, profile } from "../../core/test/helpers.ts";
import { HttpError, match, statusOf, type Request } from "../src/http.ts";
import type { Lyricad } from "../src/lyricad.ts";
import { apiRoutes } from "../src/routes.ts";

/** API handler tests: real encrypted stores and route validation, no listener or model calls. */
async function setup() {
  const keyring = await freshKeyring(), users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  const sam = await users.createUser("sam", "pw2", profile("Sam"), { admin: false });
  await users.authenticate("ada", "pw");
  await users.authenticate("sam", "pw2");
  const memory = new Memory(keyring, users), models = new Models(keyring, users);
  const logs: string[] = [];
  const d = {
    keyring,
    services: { users, memory, models, sleep: { mode: () => "scheduled" } },
    sleepTime: () => "04:00",
    userFor: (r: Request) => {
      const user = users.get(r.params.userId!);
      if (!user) throw new HttpError(401, "not logged in");
      return user;
    },
    log: (line: string) => logs.push(line),
  } as unknown as Lyricad;
  const routes = apiRoutes(d);
  const client = (userId: string) => {
    const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const url = new URL(path, "http://fixture");
      const found = match(routes, method, url.pathname);
      if (!found || found === "method") throw new Error("no fixture route");
      if (found.params.userId !== userId) throw new Error("wrong fixture user");
      const request = { method, params: found.params, query: url.searchParams, json: async () => body } as Request;
      try { return { status: 200, body: await found.route.handler(request) as T }; }
      catch (error) { return { status: statusOf(error), body: { error: (error as Error).message } as T }; }
    };
    return {
      get: <T = unknown>(path: string) => call<T>("GET", path),
      post: <T = unknown>(path: string, body: unknown) => call<T>("POST", path, body),
      patch: <T = unknown>(path: string, body: unknown) => call<T>("PATCH", path, body),
    };
  };
  return { d, logs, rt: { ada, sam }, client, ada: client(ada.id), u: `/api/u/${ada.id}` };
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
    expect((await s.ada.get<HistoryPage<SleepRunInfo>>(`${path}?offset=${Number.MAX_SAFE_INTEGER}`)).body.entries).toEqual([]);
    const overview = (await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body;
    expect(overview.runs).toHaveLength(2);
    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    const visible = (await s.ada.get<HistoryPage<SleepRunInfo>>(path)).body;
    expect(visible.total).toBe(24);
    expect(visible.entries.every((r) => r.pool === "general")).toBe(true);
    expect(s.logs.join("\n")).not.toContain("ENDPOINT-down");
  });

  it("pages and searches journal entries, with a one-entry preview and hidden pools excluded", async () => {
    const s = await setup();
    for (const pool of ["general", "private"] as const) {
      const view = s.d.services!.memory.openThreadView(s.rt.ada.id, pool);
      try { for (let i = 1; i <= 24; i++) view.own.addJournal(`${i % 2 ? "Pelicans" : "Harbour"} dream ${i}`, "sleep"); }
      finally { view.close(); }
    }
    const path = `${s.u}/memory/journal/history`;
    const first = (await s.ada.get<HistoryPage<MemoryHit>>(`${path}?limit=20`)).body;
    const next = (await s.ada.get<HistoryPage<MemoryHit>>(`${path}?limit=20&offset=20`)).body;
    expect(first.total).toBe(48);
    expect(first.entries).toHaveLength(20);
    expect(next.entries).toHaveLength(20);
    expect(next.entries.some((r) => first.entries.some((f) => f.id === r.id && f.pool === r.pool))).toBe(false);
    const matches = (await s.ada.get<HistoryPage<MemoryHit>>(`${path}?q=PELICANS&limit=5&offset=5`)).body;
    expect(matches.total).toBe(24);
    expect(matches.entries).toHaveLength(5);
    expect(matches.entries.every((r) => r.snippet.startsWith("Pelicans"))).toBe(true);
    expect((await s.ada.get<MemoryHit[]>(`${s.u}/memory/search?kinds=journal&limit=1`)).body).toHaveLength(1);
    expect((await s.ada.get<HistoryPage<MemoryHit>>(`${path}?pool=private`)).body.total).toBe(24);
    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    expect((await s.ada.get<HistoryPage<MemoryHit>>(path)).body.total).toBe(24);
    expect((await s.ada.get<HistoryPage<MemoryHit>>(`${path}?pool=private`)).body).toMatchObject({ entries: [], total: 0 });
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
    models.setColumnTask(user.id, "private", "chat", { offeringId: offering.id });
    const resolution = models.resolve("chat", { userId: user.id, pool: "private", localOnly: true });
    for (let i = 0; i < 25; i++) models.recordCall(user.id, { pool: i % 2 ? "private" : "general", threadId: `fixture-${i}`, task: "chat", resolution, note: i % 2 ? "fallback fixture" : "ordinary" });
    const path = `${s.u}/models/calls/history`;
    const first = (await s.ada.get<HistoryPage<CallInfo>>(`${path}?limit=20`)).body;
    const next = (await s.ada.get<HistoryPage<CallInfo>>(`${path}?limit=20&offset=20`)).body;
    expect(first.total).toBe(25);
    expect(first.entries[0]!.threadId).toBe("fixture-24");
    expect(next.entries).toHaveLength(5);
    expect((await s.ada.get<HistoryPage<CallInfo>>(`${path}?q=FALLBACK`)).body.total).toBe(12);
    // More than the former preview window's worth of private calls cannot hide the newest visible general call.
    for (let i = 0; i < 25; i++) models.recordCall(user.id, { pool: "private", threadId: `private-fixture-${i}`, task: "chat", resolution });
    await s.ada.patch(`${s.u}/me/display`, { showPrivate: false });
    const visible = (await s.ada.get<HistoryPage<CallInfo>>(`${path}?limit=1`)).body;
    expect(visible.total).toBe(13);
    expect(visible.entries[0]!.threadId).toBe("fixture-24");
  });

  it("pages finished downloads across manageable hosts and bounds each queue preview", async () => {
    const s = await setup(), models = s.d.services!.models;
    const user = s.d.services!.users.get(s.rt.ada.id)!;
    const endpoint = models.addEndpoint(user, { name: "fixture", kind: "local", baseUrl: "http://127.0.0.1:1/v1" });
    const entries: HostDownload[] = Array.from({ length: 25 }, (_, i) => ({
      id: `download-${i}`, source: "url", repo: null, url: null, path: `lyrica/url/example.org/model-${i}.gguf`,
      state: i === 24 ? "downloading" : i % 2 ? "done" : "failed", size: 100, received: 100,
      verified: true, error: null, startedAt: `2026-09-${String(i + 1).padStart(2, "0")}T04:00:00.000Z`,
    }));
    const endpoints = vi.spyOn(models, "endpoints").mockReturnValue([{ ...endpoint, api: "host" }, { ...endpoint, id: "shared-fixture", api: "host", shared: true }]);
    const downloads = vi.spyOn(models, "downloads").mockResolvedValue({ downloads: entries });
    try {
      const path = `${s.u}/models/downloads/history`;
      const first = (await s.ada.get<DownloadHistory>(`${path}?limit=20`)).body;
      const next = (await s.ada.get<DownloadHistory>(`${path}?offset=20&limit=20`)).body;
      expect(first.total).toBe(48);
      expect(first.entries).toHaveLength(20);
      expect(next.entries).toHaveLength(20);
      expect(first.entries[0]!.download.id).toBe("download-23");
      expect(next.entries.some((r) => first.entries.some((x) => x.endpointId === r.endpointId && x.download.id === r.download.id))).toBe(false);
      const matches = (await s.ada.get<DownloadHistory>(`${path}?q=DONE&limit=5&offset=5`)).body;
      expect(matches.total).toBe(24);
      expect(matches.entries).toHaveLength(5);
      expect(matches.entries.every((r) => r.download.state === "done")).toBe(true);
      const preview = (await s.ada.get<{ downloads: HostDownload[]; finishedTotal: number }>(`${s.u}/hosts/${endpoint.id}/downloads?preview=1`)).body;
      expect(preview.finishedTotal).toBe(24);
      expect(preview.downloads.map((d) => d.id)).toEqual(["download-24", "download-23"]);
      const sam = s.client(s.rt.sam.id);
      downloads.mockClear();
      const own = (await sam.get<DownloadHistory>(`/api/u/${s.rt.sam.id}/models/downloads/history`)).body;
      expect(own.total).toBe(24);
      expect(downloads).toHaveBeenCalledTimes(1);
      expect(downloads).toHaveBeenCalledWith(expect.objectContaining({ id: s.rt.sam.id }), endpoint.id);
    } finally { endpoints.mockRestore(); downloads.mockRestore(); }
  });

  it("rejects invalid bounds on each history API", async () => {
    const s = await setup();
    for (const suffix of ["sleep/history", "models/calls/history", "models/downloads/history", "memory/general/wake/history", "memory/journal/history"]) {
      for (const query of ["limit=0", "limit=101", "offset=-1", "offset=1.5", "limit=NaN", `q=${"x".repeat(201)}`]) {
        expect((await s.ada.get(`${s.u}/${suffix}?${query}`)).status).toBe(400);
      }
    }
  });
});
