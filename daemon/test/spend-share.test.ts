import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/routes.ts";
import { match, statusOf, type Request } from "../src/http.ts";
import { Lyricad } from "../src/lyricad.ts";
import type { CallInfo, ProjectOverview, ThreadUsage } from "../src/api.ts";
import { runtime } from "./helpers.ts";

// Real route handlers, sessions and encrypted stores; no sockets or model requests.
describe("spend-share routes", () => {
  it("uses the same durable total in usage and overview, sorts thread shares, and filters calls by project and pool", async () => {
    const rt = await runtime();
    const d = new Lyricad({ home: rt.home, port: 0, selfTest: false, log: () => {}, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 }, kdfIter: 1 });
    await d.unlock("passphrase");
    try {
      await d.services!.users.authenticate("ada", "pw");
      await d.services!.users.authenticate("sam", "pw2");
      const cookie = d.sessions.login(undefined, rt.ada.id, () => false).id;
      const other = d.sessions.login(undefined, rt.sam.id, () => false).id;
      const routes = apiRoutes(d);
      const request = async <T>(path: string, session: string | undefined = cookie) => {
        const url = new URL(path, "http://localhost");
        const found = match(routes, "GET", url.pathname);
        if (!found || found === "method") throw new Error("route not found");
        const req = { params: found.params, query: url.searchParams, cookie: session } as Request;
        try { return { status: 200, body: await found.route.handler(req) as T }; }
        catch (err) { return { status: statusOf(err), body: undefined }; }
      };
      const view = d.services!.memory.openThreadView(rt.ada.id, "general");
      const project = view.own.createThread({ interface: "web", title: "Usage project", project: true });
      const work = view.own.createThread({ interface: "web", title: "Counted work", parent: project.id, child: true });
      view.close();
      const u = `/api/u/${rt.ada.id}`;
      const path = `${u}/threads/general/${encodeURIComponent(project.id)}`;
      const db = d.services!.users.openUserDb(rt.ada.id);
      const call = db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, prompt_tokens, read_tokens, output_tokens, ttft_ms, gen_ms)
        VALUES ('2026-01-01', ?, ?, 'chat', 'test', 'Test', 'fake', ?, 5, ?, 2, 10, 20)`);
      call.run("general", project.id, "local", 10);
      call.run("general", work.id, "cloud", 30);
      call.run("private", work.id, "local", 900);
      call.run("general", "unrelated", "local", 900);
      db.prepare("INSERT INTO call_totals (pool, thread, label, kind, tokens, gpu_ms, calls) VALUES ('general', ?, 'Old', 'local', 50, 100, 1)").run(work.id);
      db.prepare(`INSERT INTO subagent_runs (pool, thread, run, parent, role, model, background, status, input_tokens, output_tokens, started_at)
        VALUES ('general', 'sub', 'run', ?, 'worker', 'Gone', 0, 'done', 7, 3, '2026-01-01')`).run(work.id);
      db.close();
      const usage = (await request<ThreadUsage>(`${path}/usage`)).body!;
      expect(usage.tokens).toBe(104);
      expect(usage.gpuMs).toBe(130);
      // Input and output split the total, except the 50 folded before the split was kept, which count in tokens alone.
      expect(usage.threads).toEqual([{ threadId: project.id, tokens: 12, input: 10, output: 2, gpuMs: 30 }, { threadId: work.id, tokens: 92, input: 37, output: 5, gpuMs: 100 }]);
      expect([usage.input, usage.output]).toEqual([47, 7]);
      expect((await request<ProjectOverview>(`${path}/overview`)).body?.tokens).toBe(usage.tokens);
      const calls = (await request<CallInfo[]>(`${u}/models/calls?project=${encodeURIComponent(project.id)}&pool=general`)).body!;
      expect(calls.map(c => [c.pool, c.threadId])).toEqual([["general", work.id], ["general", project.id]]);
      const thread = (await request<ThreadUsage>(`${u}/threads/general/${encodeURIComponent(work.id)}/usage`)).body!;
      expect(thread.tokens).toBe(92);
      expect(thread.threads).toBeUndefined();
      expect(thread.models.find(m => m.kind === "cloud")?.gpuMs).toBeUndefined();
      expect((await request(`${u}/threads/general/missing/usage`)).status).toBe(404);
      expect((await request(`${path}/usage`, "no-session")).status).toBe(401);
      expect((await request(`${path}/usage`, other)).status).toBe(401);
    } finally { await d.stop(); }
  });
});
