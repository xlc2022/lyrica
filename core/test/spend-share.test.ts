import { describe, expect, it } from "vitest";
import { withModels } from "./helpers.ts";

// Principles 1 and 2: durable usage, every descendant, and pool isolation.
describe("spend share", () => {
  it("sums every request, old records and nested runs, keeps totals through pruning, and forgets them", async () => {
    const { users, ada, models, localRef } = await withModels();
    const db = users.openUserDb(ada.id);
    const call = db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, prompt_tokens, read_tokens, output_tokens, ttft_ms, gen_ms)
      VALUES ('2026-01-01', ?, ?, 'chat', ?, ?, 'test', ?, ?, ?, ?, 100, 200)`);
    call.run("general", "chat", localRef.offeringId, "Local", "local", 10, 30, 5);
    call.run("general", "work", "gone", "Cloud", "cloud", 20, null, 7);
    call.run("private", "work", localRef.offeringId, "Local", "local", 900, 900, 90);
    const run = db.prepare(`INSERT INTO subagent_runs (pool, thread, run, parent, role, model, offering, background, status, input_tokens, output_tokens, started_at)
      VALUES (?, ?, 'run', ?, 'worker', ?, ?, 0, 'done', ?, ?, '2026-01-01')`);
    run.run("general", "sub", "work", "Local", localRef.offeringId, 40, 8);
    run.run("general", "deep", "sub", "Removed", "gone", 50, 9);
    run.run("private", "other", "work", "Local", localRef.offeringId, 900, 90);
    // Calls without counted turns never contribute, including a subagent's routing record.
    db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES ('2026-01-01', 'general', 'sub', 'chat', 'gone', 'Removed', 'test', 'local')`).run();
    db.prepare("INSERT INTO call_totals (pool, thread, label, kind, tokens, gpu_ms, calls) VALUES ('general', 'chat', 'Local', 'local', 11, 30, 1)").run();
    const own = models.usage(ada.id, "general", ["work"]);
    expect(own.reduce((n, r) => n + r.tokens, 0)).toBe(27 + 48 + 59);
    expect(own.find(r => r.label === "Removed")).toEqual({ threadId: "work", label: "Removed", tokens: 59 });
    expect(own.find(r => r.label === "Local")?.gpuMs).toBeUndefined();
    const project = models.usage(ada.id, "general", ["chat", "work"]);
    expect(project.reduce((n, r) => n + r.tokens, 0)).toBe(180);
    expect(project.reduce((n, r) => n + (r.gpuMs ?? 0), 0)).toBe(330);
    for (let i = 0; i < 501; i++) db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES ('2026-01-01', 'general', 'unrelated', 'title', 'gone', 'Title', 'test', 'local')`).run();
    models.prune();
    expect(models.usage(ada.id, "general", ["chat", "work"])).toEqual(project);
    expect(db.prepare("SELECT sum(calls) AS n FROM call_totals WHERE pool = 'general'").get()).toEqual({ n: 3 });
    models.prune();
    expect(models.usage(ada.id, "general", ["chat", "work"])).toEqual(project);
    models.forgetThread(ada.id, "general", "chat");
    expect(models.usage(ada.id, "general", ["chat"])).toEqual([]);
    expect(models.usage(ada.id, "private", ["work"]).reduce((n, r) => n + r.tokens, 0)).toBe(1980);
    db.close();
  });

  it("records read tokens independently of context size and filters recent calls by pool", async () => {
    const { users, ada, models } = await withModels();
    const db = users.openUserDb(ada.id);
    for (const pool of ["general", "private"]) db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES ('2026-01-01', ?, 'same', 'chat', 'gone', 'Local', 'test', 'local')`).run(pool);
    models.recordPace(ada.id, "same", { promptTokens: 20, readTokens: 70, outputTokens: 5, window: 100, ttftMs: 100, genMs: 200, processed: 10 });
    expect(models.recentCalls(ada.id, { pool: "private", threadIds: ["same"] })[0]?.pace?.readTokens).toBe(70);
    expect(models.recentCalls(ada.id, { pool: "general", threadIds: ["same"] })).toHaveLength(1);
    expect(models.usage(ada.id, "private", ["same"])[0]?.tokens).toBe(75);
    db.close();
  });
});
