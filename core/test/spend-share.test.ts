import { describe, expect, it } from "vitest";
import { Models, Users } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

/** Count-only fixtures: encrypted stores and manual offerings, with no listening sockets or requests. */
async function withUsageModels() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const models = new Models(keyring, users);
  const endpoint = models.addEndpoint(ada, { name: "fake", kind: "local", baseUrl: "https://model.invalid/v1" });
  const offering = models.addModel(ada, endpoint.id, { modelId: "fake-model" });
  return { users, ada, models, localRef: { offeringId: offering.id } };
}

// Principles 1 and 2: durable usage, every descendant, and pool isolation.
describe("spend share", () => {
  it("sums every request, old records and nested runs, keeps totals through pruning, and forgets them", async () => {
    const { users, ada, models, localRef } = await withUsageModels();
    const db = users.openUserDb(ada.id);
    const call = db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, prompt_tokens, read_tokens, output_tokens, ttft_ms, gen_ms)
      VALUES ('2026-01-01', ?, ?, 'chat', ?, ?, 'test', ?, ?, ?, ?, 100, 200)`);
    call.run("general", "chat", localRef.offeringId, "Local", "local", 10, 30, 5);
    call.run("general", "work", "gone", "Cloud", "cloud", 20, null, 7);
    call.run("private", "work", localRef.offeringId, "Local", "local", 900, 900, 90);
    // Code-mode turns contribute and survive pruning just like ordinary chat.
    db.prepare("UPDATE model_calls SET task = 'code' WHERE pool = 'general' AND thread = 'work'").run();
    const run = db.prepare(`INSERT INTO subagent_runs (pool, thread, run, parent, role, model, offering, background, status, input_tokens, output_tokens, started_at)
      VALUES (?, ?, 'run', ?, 'worker', ?, ?, 0, 'done', ?, ?, '2026-01-01')`);
    run.run("general", "sub", "work", "Local", localRef.offeringId, 40, 8);
    run.run("general", "deep", "sub", "Removed", "gone", 50, 9);
    run.run("private", "other", "work", "Local", localRef.offeringId, 900, 90);
    // A subagent's own measured call record never contributes: its run counts it, so a tree listing both counts it once.
    db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, prompt_tokens, output_tokens, ttft_ms, gen_ms)
      VALUES ('2026-01-01', 'general', 'sub', 'chat', 'gone', 'Removed', 'test', 'local', 40, 8, 100, 200)`).run();
    db.prepare("INSERT INTO call_totals (pool, thread, label, kind, tokens, gpu_ms, calls) VALUES ('general', 'chat', 'Local', 'local', 11, 30, 1)").run();
    const own = models.usage(ada.id, "general", ["work"]);
    expect(own.reduce((n, r) => n + r.tokens, 0)).toBe(27 + 48 + 59);
    expect(own.find(r => r.label === "Removed")).toEqual({ threadId: "work", label: "Removed", tokens: 59, input: 50, output: 9 });
    expect(own.find(r => r.label === "Local")?.gpuMs).toBeUndefined();
    // Input and output split the total: the work thread's own cloud turn read 20 and wrote 7.
    expect(own.find(r => r.label === "Cloud")).toMatchObject({ tokens: 27, input: 20, output: 7 });
    expect(models.usage(ada.id, "general", ["sub"]).reduce((n, r) => n + r.tokens, 0)).toBe(59);
    // Claude Code run from the subagent's thread isn't in its run, so it still counts there.
    models.addCallTotals(ada.id, "general", "sub", "Claude Code", "cloud", 30, 4);
    expect(models.usage(ada.id, "general", ["sub"]).find((r) => r.label === "Claude Code")).toEqual({ threadId: "sub", label: "Claude Code", kind: "cloud", tokens: 34, input: 30, output: 4 });
    db.prepare("DELETE FROM call_totals WHERE thread = 'sub'").run();
    const project = models.usage(ada.id, "general", ["chat", "work"]);
    expect(project.reduce((n, r) => n + r.tokens, 0)).toBe(180);
    expect(project.reduce((n, r) => n + (r.gpuMs ?? 0), 0)).toBe(330);
    for (let i = 0; i < 501; i++) db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES ('2026-01-01', 'general', 'unrelated', 'title', 'gone', 'Title', 'test', 'local')`).run();
    models.prune();
    expect(models.usage(ada.id, "general", ["chat", "work"])).toEqual(project);
    // The subagent's folded record is kept, and still left out of the sums.
    expect(db.prepare("SELECT sum(calls) AS n FROM call_totals WHERE pool = 'general'").get()).toEqual({ n: 4 });
    // Holes left by forgetting calls must not trim below the latest 500.
    db.prepare(`INSERT INTO model_calls (id, at, pool, thread, task, offering, label, endpoint, kind)
      SELECT max(id) + 1000, '2026-01-01', 'general', 'unrelated', 'title', 'gone', 'Title', 'test', 'local' FROM model_calls`).run();
    db.prepare("DELETE FROM model_calls WHERE id = (SELECT min(id) FROM model_calls)").run();
    models.prune();
    expect(db.prepare("SELECT count(*) AS n FROM model_calls").get()).toEqual({ n: 500 });
    expect(models.usage(ada.id, "general", ["chat", "work"])).toEqual(project);
    models.forgetThread(ada.id, "general", "chat");
    expect(models.usage(ada.id, "general", ["chat"])).toEqual([]);
    expect(models.usage(ada.id, "private", ["work"]).reduce((n, r) => n + r.tokens, 0)).toBe(1980);
    db.close();
  });

  it("records read tokens independently of context size and filters recent calls by pool", async () => {
    const { users, ada, models, localRef } = await withUsageModels();
    const db = users.openUserDb(ada.id);
    for (const pool of ["general", "private"]) db.prepare(`INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind) VALUES ('2026-01-01', ?, 'same', 'chat', 'gone', 'Local', 'test', 'local')`).run(pool);
    models.recordPace(ada.id, "same", { promptTokens: 20, readTokens: 70, outputTokens: 5, window: 100, ttftMs: 100, genMs: 200, processed: 10 }, "chat", "general");
    expect(models.recentCalls(ada.id, { pool: "general", threadIds: ["same"] })[0]?.pace?.readTokens).toBe(70);
    expect(models.recentCalls(ada.id, { pool: "general", threadIds: ["same"] })).toHaveLength(1);
    expect(models.usage(ada.id, "general", ["same"])[0]?.tokens).toBe(75);
    expect(models.usage(ada.id, "private", ["same"])).toEqual([]);
    const resolution = models.resolve("chat", { userId: ada.id, pool: "general", localOnly: true, overrides: { chat: [localRef] } });
    models.recordCall(ada.id, { pool: "general", threadId: "same", task: "chat", resolution }, { retry: true });
    expect(models.recentCalls(ada.id, { pool: "general", threadId: "same" })[0]?.label).toBe(resolution.label);
    expect(models.recentCalls(ada.id, { pool: "private", threadId: "same" })[0]?.label).toBe("Local");
    db.close();
  });

  it("shows Claude Code's tokens, counted by its relay, as the thread's own cloud row", async () => {
    const { ada, models } = await withUsageModels();
    models.addCallTotals(ada.id, "general", "work", "Claude Code", "cloud", 2112, 34);
    models.addCallTotals(ada.id, "general", "work", "Claude Code", "cloud", 45, 7);
    expect(models.usage(ada.id, "general", ["work"])).toEqual([{ threadId: "work", label: "Claude Code", kind: "cloud", tokens: 2198, input: 2157, output: 41 }]);
    expect(models.usage(ada.id, "private", ["work"])).toEqual([]);
  });
});
