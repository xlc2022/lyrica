import { describe, expect, it } from "vitest";
import { initialLive, liveReducer, type Live, type LiveAction } from "../src/live.ts";

const run = (actions: LiveAction[], from: Live = initialLive) => actions.reduce(liveReducer, from);

describe("the live view of a thread's stream", () => {
  it("builds her reply from deltas, markers and tool results, and drops it once the stored copy is loaded", () => {
    const s = run([
      { type: "hello", busy: false, queued: [], permissions: [] },
      { type: "sent", text: "hi" },
      { type: "turn_start" },
      { type: "message_start", model: "m" },
      { type: "recall", ids: ["n:1"] },
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "tool_start", toolCallId: "c1", name: "bash", args: { command: "ls" } },
      { type: "tool_end", toolCallId: "c1", name: "bash", result: "a b", isError: false },
      { type: "text", delta: "Done." },
    ]);
    expect(s.busy).toBe(true);
    expect(s.items).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", model: "m", parts: [
        { type: "recall", ids: ["n:1"] },
        { type: "text", text: "Hello" },
        { type: "tool", toolCallId: "c1", name: "bash", args: { command: "ls" }, result: "a b", isError: false },
        { type: "text", text: "Done." },
      ] },
    ]);
    const ended = run([{ type: "turn_end", aborted: false }], s);
    expect(ended.busy).toBe(false);
    expect(ended.reload).toBe(s.reload + 1);
    // A new turn may start before the reload arrives; only the stored turn goes.
    const next = run([{ type: "sent", text: "again" }, { type: "stored" }], ended);
    expect(next.items).toEqual([{ role: "user", text: "again" }]);
  });

  it("keeps a delegate call's subagent threads, and shows a delivered notice", () => {
    const s = run([
      { type: "turn_start" },
      { type: "tool_start", toolCallId: "d1", name: "delegate", args: { task: "look" } },
      { type: "tool_end", toolCallId: "d1", name: "delegate", result: "done", isError: false, threads: [{ pool: "general", id: "web/sub1" }] },
      { type: "notice", text: "Subagent run r1 finished" },
    ]);
    expect(s.items[0]).toMatchObject({ role: "assistant", parts: [{ type: "tool", threads: [{ pool: "general", id: "web/sub1" }] }] });
    expect(s.items[1]).toEqual({ role: "notice", text: "Subagent run r1 finished" });
  });

  it("shows a follow-up once it leaves the queue", () => {
    const s = run([
      { type: "turn_start" },
      { type: "queue", queued: ["one", "two"] },
      { type: "queue", queued: ["two"] },
    ]);
    expect(s.queued).toEqual(["two"]);
    expect(s.items).toEqual([{ role: "user", text: "one" }]);
  });

  it("shows a message no model took as waiting, once, until a turn starts", () => {
    const tried = [{ label: "gpu/qwen", reason: "gpu is down" }];
    const s = run([
      { type: "hello", busy: false, queued: [], permissions: [] },
      { type: "sent", text: "hi" },
      { type: "queue", queued: ["hi"] },
      { type: "offline", task: "chat", tried },
    ]);
    expect([s.items, s.queued, s.offline]).toEqual([[], ["hi"], { task: "chat", tried }]);
    // A message sent while one was held goes with it, joined: neither shows twice.
    const joined = run([{ type: "sent", text: "there" }, { type: "queue", queued: ["hi\n\nthere"] }, { type: "offline", task: "chat", tried }], s);
    expect([joined.items, joined.queued]).toEqual([[], ["hi\n\nthere"]]);
    const back = run([{ type: "queue", queued: [] }, { type: "turn_start" }], s);
    expect([back.items, back.offline]).toEqual([[{ role: "user", text: "hi" }], undefined]);
  });

  it("tracks permission prompts until they are answered", () => {
    const req = { requestId: "r1", toolCallId: "c1", tool: "bash", args: {}, expiresAt: "2026-10-09T00:00:00Z" };
    const asked = run([{ type: "permission", ...req }]);
    expect(asked.permissions).toEqual([req]);
    expect(run([{ type: "permission_end", requestId: "r1", allowed: true, reason: "answered" }], asked).permissions).toEqual([]);
  });

  it("keeps a subagent's prompt past the parent's turn, and reloads when a subagent's thread changes", () => {
    const sub = { requestId: "r2", toolCallId: "c2", tool: "bash", args: {}, expiresAt: "2026-10-09T00:00:00Z", subagent: { runId: "d-1", threadId: "t2", parentThreadId: "t1", role: "worker" } };
    const own = { requestId: "r1", toolCallId: "c1", tool: "bash", args: {}, expiresAt: "2026-10-09T00:00:00Z" };
    const s = run([{ type: "turn_start" }, { type: "permission", ...own }, { type: "permission", ...sub }, { type: "turn_end", aborted: false }]);
    expect(s.permissions).toEqual([sub]);
    const refreshed = run([{ type: "refresh" }], s);
    expect(refreshed.reload).toBe(s.reload + 1);
    // A subagent's stored work changed: its transcript in a delegate card reloads.
    const ref = { userId: "u", pool: "general" as const, parentThreadId: "t1", runId: "d-1", threadId: "t2" };
    const worked = run([{ type: "delegation", event: { ...ref, type: "output", delta: "x" } }, { type: "delegation", event: { ...ref, type: "finished", status: "finished" } }], s);
    expect(worked.subagents).toEqual({ t2: 1 });
  });

  it("reloads after a reconnect finds the turn over, and after a reset", () => {
    const mid = run([{ type: "turn_start" }, { type: "text", delta: "partial" }]);
    const back = run([{ type: "hello", busy: false, queued: [], permissions: [] }], mid);
    expect(back.reload).toBe(mid.reload + 1);
    expect(run([{ type: "stored" }], back).items).toEqual([]);
    const reset = run([{ type: "reset" }], mid);
    expect(reset.items).toEqual([]);
    expect(reset.reload).toBe(mid.reload + 1);
  });

  it("reloads when the stream opens on an idle thread, in case a turn ended after the messages were fetched", () => {
    // A child thread opened as its first turn ends: fetched while busy, the stream opens idle with nothing live.
    const opened = run([{ type: "hello", busy: false, queued: [], permissions: [] }]);
    expect(opened.reload).toBe(1);
    expect(run([{ type: "hello", busy: true, queued: [], permissions: [] }]).reload).toBe(0);
  });
});
