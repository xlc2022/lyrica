import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/routes.ts";
import { match, statusOf, type Request } from "../src/http.ts";
import { Lyricad } from "../src/lyricad.ts";
import type { ModelsPage } from "../src/api.ts";
import { runtime } from "./helpers.ts";

// Real route handlers, sessions and encrypted stores; no sockets or model requests.
describe("the models page response", () => {
  it("counts each endpoint's calls over model_calls in the shown pools, not over the recent-calls preview", async () => {
    const rt = await runtime();
    const d = new Lyricad({ home: rt.home, port: 0, selfTest: false, log: () => {}, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 }, kdfIter: 1 });
    await d.unlock("passphrase");
    try {
      await d.services!.users.authenticate("ada", "pw");
      const cookie = d.sessions.login(undefined, rt.ada.id, () => false).id;
      const routes = apiRoutes(d);
      const request = async <T>(path: string) => {
        const url = new URL(path, "http://localhost");
        const found = match(routes, "GET", url.pathname);
        if (!found || found === "method") throw new Error("route not found");
        const req = { params: found.params, query: url.searchParams, cookie } as Request;
        try { return { status: 200, body: await found.route.handler(req) as T }; }
        catch (err) { return { status: statusOf(err), body: undefined }; }
      };

      // Three of ada's own endpoints; the page's probes fail fast on these closed addresses, which it tolerates.
      const models = d.services!.models, actor = d.services!.users.get(rt.ada.id)!;
      const gpu = models.addEndpoint(actor, { name: "gpu", kind: "local", baseUrl: "http://127.0.0.1:9/v1" });
      const box = models.addEndpoint(actor, { name: "box", kind: "local", baseUrl: "http://127.0.0.1:9/v1" });
      const sky = models.addEndpoint(actor, { name: "sky", kind: "cloud", baseUrl: "https://sky.invalid/v1", apiKey: "fake-key" });

      // Calls across both pools; one names an endpoint since removed, which counts nowhere.
      const db = d.services!.users.openUserDb(rt.ada.id);
      const call = db.prepare("INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES ('2026-10-13', ?, 't', 'chat', 'o', 'm', ?, ?)");
      for (let i = 0; i < 4; i++) call.run("general", "gpu", "local");
      call.run("private", "gpu", "local");
      call.run("private", "box", "local");
      call.run("general", "sky", "cloud");
      call.run("general", "gone-box", "local");
      db.close();

      const u = `/api/u/${rt.ada.id}`;
      const both = (await request<ModelsPage>(`${u}/models/page`)).body!;
      expect(both.endpointUses).toEqual(expect.arrayContaining([{ endpointId: gpu.id, calls: 5 }, { endpointId: box.id, calls: 1 }, { endpointId: sky.id, calls: 1 }]));
      expect(both.endpointUses).toHaveLength(3); // gone-box's call counts nowhere; endpoints with no calls aren't listed

      // Hide the private pool and ask again: its calls leave the counts.
      const db2 = d.services!.users.openUserDb(rt.ada.id);
      db2.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('display', ?)").run(JSON.stringify({ showPrivate: false }));
      db2.close();
      const shown = (await request<ModelsPage>(`${u}/models/page`)).body!;
      expect(shown.endpointUses).toEqual(expect.arrayContaining([{ endpointId: gpu.id, calls: 4 }, { endpointId: sky.id, calls: 1 }]));
      expect(shown.endpointUses.find((x) => x.endpointId === box.id)).toBeUndefined();

      // The counts are the page's own; shortening its recent-calls preview can't move them.
      expect(both.calls.length).toBeLessThanOrEqual(20);
    } finally { await d.stop(); }
  });

  it("gives each endpoint its recent speed over its last measured turns of the past day", async () => {
    const rt = await runtime();
    const d = new Lyricad({ home: rt.home, port: 0, selfTest: false, log: () => {}, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 }, kdfIter: 1 });
    await d.unlock("passphrase");
    try {
      await d.services!.users.authenticate("ada", "pw");
      const models = d.services!.models, actor = d.services!.users.get(rt.ada.id)!;
      const gpu = models.addEndpoint(actor, { name: "gpu", kind: "local", baseUrl: "http://127.0.0.1:9/v1" });
      const box = models.addEndpoint(actor, { name: "box", kind: "local", baseUrl: "http://127.0.0.1:9/v1" });
      const now = Date.parse("2026-10-20T12:00:00Z");
      const db = d.services!.users.openUserDb(rt.ada.id);
      const call = db.prepare("INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, output_tokens, gen_ms, processed, ttft_ms) VALUES (?, 'general', 't', 'chat', 'o', 'm', ?, 'local', ?, ?, ?, ?)");
      // gpu: an old fast turn outside the day, eleven slow ones inside it (only the last ten count), and one unmeasured.
      call.run("2026-10-18T12:00:00Z", "gpu", 9000, 1000, 0, 0);
      call.run("2026-10-20T08:00:00Z", "gpu", 9000, 1000, 0, 0);
      for (let i = 0; i < 10; i++) call.run("2026-10-20T09:00:00Z", "gpu", 400, 10_000, 3000, 1000);
      call.run("2026-10-20T10:00:00Z", "gpu", null, null, null, null);
      // box: only a turn from two days ago, so it keeps its count but has no speed.
      call.run("2026-10-18T12:00:00Z", "box", 500, 1000, 0, 0);
      db.close();

      const uses = models.endpointUses(rt.ada.id, ["general"], now);
      expect(uses.find((u) => u.endpointId === gpu.id)).toEqual({ endpointId: gpu.id, calls: 13, tokPerSec: 40, promptTokPerSec: 3000, speedCalls: 10 });
      expect(uses.find((u) => u.endpointId === box.id)).toEqual({ endpointId: box.id, calls: 1 });
    } finally { await d.stop(); }
  });
});
