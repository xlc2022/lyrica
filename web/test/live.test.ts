import { describe, expect, it } from "vitest";
import { initialLive, liveReducer, storedLiveCopies, storedUserItems, tailKey, type Live, type LiveAction, type LiveItem } from "../src/live.ts";

import type { Message } from "../src/api.ts";

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

  it("shows a call as soon as the model starts writing it, and fills in its arguments in place when it runs", () => {
    const s = run([
      { type: "turn_start" },
      { type: "message_start", model: "m" },
      { type: "tool_call", toolCallId: "c1", name: "image" },
      { type: "tool_call", toolCallId: "c2", name: "bash" },
      { type: "tool_call", toolCallId: "c1", name: "image" },
    ]);
    expect(s.items).toEqual([{ role: "assistant", model: "m", parts: [
      { type: "tool", toolCallId: "c1", name: "image", args: {} },
      { type: "tool", toolCallId: "c2", name: "bash", args: {} },
    ] }]);
    const ran = run([
      { type: "tool_start", toolCallId: "c1", name: "image", args: { action: "create", prompt: "A garden" } },
      { type: "tool_end", toolCallId: "c1", name: "image", result: "made", isError: false },
    ], s);
    expect((ran.items[0] as { parts: unknown[] }).parts).toEqual([
      { type: "tool", toolCallId: "c1", name: "image", args: { action: "create", prompt: "A garden" }, result: "made", isError: false },
      { type: "tool", toolCallId: "c2", name: "bash", args: {} },
    ]);
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

  it("shows an image result beside its call while the reply streams, until the stored copy arrives", () => {
    const image = { type: "image" as const, paths: ["/workspace/images/garden.png", "/workspace/images/pond.png"], model: "box/Z-Image", tier: "fast" as const };
    const s = run([
      { type: "turn_start" },
      { type: "tool_start", toolCallId: "i1", name: "image", args: { action: "create", tier: "fast", prompt: "A garden" } },
      { type: "tool_end", toolCallId: "i1", name: "image", result: "Made two images.", isError: false, image },
      { type: "text", delta: "Here is the garden." },
    ]);
    expect(s.items[0]).toMatchObject({ role: "assistant", parts: [
      { type: "tool", toolCallId: "i1", result: "Made two images.", isError: false }, image,
      { type: "text", text: "Here is the garden." },
    ] });
    expect(run([{ type: "turn_end", aborted: false }, { type: "stored" }], s).items).toEqual([]);
  });

  it("a steered follow-up leaves the queue but shows only when she takes it", () => {
    const s = run([
      { type: "hello", busy: true, queued: [], permissions: [] },
      { type: "queue", queued: ["one", "two"] },
      { type: "queue", queued: ["two"], steered: true },
    ]);
    expect([s.queued, s.items]).toEqual([["two"], []]);
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

  it("shows another thread's message where it reached the turn, never as waiting", () => {
    const s = run([
      { type: "turn_start" },
      { type: "message_start" },
      { type: "text", delta: "Checking." },
      { type: "received", text: "[From t:web/p1]\n\nAdd tulips." },
      { type: "message_start" },
    ]);
    expect(s.queued).toEqual([]);
    expect(s.items.map((i) => i.role)).toEqual(["assistant", "user", "assistant"]);
    expect(s.items[1]).toEqual({ role: "user", text: "[From t:web/p1]\n\nAdd tulips." });
  });

  it("keeps who a look told on its notice, for the marker", () => {
    const told = [{ threadId: "b", text: "Go." }];
    const text = "[Watching threads]\n\nIn [t:a]: it posted.\n\nTold [t:b]: \"Go.\"";
    const s = run([{ type: "notice", text, status: "watching", told }]);
    expect(s.items).toEqual([{ role: "notice", text, status: "watching", told }]);
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
    // One message with a blank line in it, held on its own, shows once too.
    const lines = run([{ type: "sent", text: "a\n\nb" }, { type: "queue", queued: ["a\n\nb"] }, { type: "offline", task: "chat", tried }]);
    expect([lines.items, lines.queued]).toEqual([[], ["a\n\nb"]]);
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

  it("keeps the latest context for the header's meter, and marks it unmeasured when turns are rewound or reset", () => {
    const context = { tokens: 900, window: 1000, percent: 90, reserve: 80, free: 20, parts: [], measuredAt: "2026-10-12T10:00:00Z" };
    const later = { ...context, tokens: 400, percent: 40, free: 520, measuredAt: "2026-10-12T10:05:00Z" };
    const s = run([{ type: "turn_start" }, { type: "turn_end", aborted: false }, { type: "context", context }, { type: "context", context: later }]);
    expect(s.context).toEqual(later);
    expect(run([{ type: "stored" }], s).context).toEqual(later);
    expect(run([{ type: "rewound", from: 3 }], s).context).toBeNull();
    expect(run([{ type: "reset" }], s).context).toBeNull();
    expect(run([{ type: "rewound", from: 3 }, { type: "context", context }], s).context).toEqual(context);
  });
});

// Principle 1: an early persisted upload must appear once while the reply streams.
describe("stored user messages replacing live copies", () => {
  const message = (n: number, text: string): Message => ({
    id: `e:web/test#${n}`, n, role: "user", parts: [{ type: "text", text }], createdAt: "2026-10-12T10:00:00Z",
  });
  const text = "/workspace/uploads/plan.md";

  it("shows the sent message until its stored copy arrives, preserving the streaming reply", () => {
    const live = run([{ type: "sent", text, afterN: 7 }, { type: "turn_start" }, { type: "text", delta: "Reading." }]);
    expect(storedUserItems(live.items, [message(7, text)])).toEqual(new Set());
    const hidden = storedUserItems(live.items, [message(7, text), message(8, text)]);
    expect(hidden).toEqual(new Set([0]));
    expect(live.items.filter((_, i) => !hidden.has(i))).toEqual([{ role: "assistant", parts: [{ type: "text", text: "Reading." }] }]);
  });

  it("dedupes a send response that arrives after the turn's stored reload", () => {
    const live = run([{ type: "turn_start" }, { type: "text", delta: "Done." },
      { type: "turn_end", aborted: false }, { type: "stored" }, { type: "sent", text, afterN: 7 }]);
    expect(storedUserItems(live.items, [message(8, text)])).toEqual(new Set([0]));
  });

  it("replaces the message a regenerate sent again once the stored copy arrives at or after the rewind point", () => {
    // The stream's `rewound` dispatches the re-sent text with afterN just before the rewind point (stream.ts).
    const live = run([{ type: "rewound", from: 8 }, { type: "sent", text, afterN: 7 }, { type: "turn_start" }, { type: "text", delta: "Again." }]);
    expect(storedUserItems(live.items, [message(7, text)])).toEqual(new Set());
    expect(storedUserItems(live.items, [message(8, text)])).toEqual(new Set([0]));
  });

  it("matches repeated sends once each in order, without hiding an unstored repeat", () => {
    const live = run([{ type: "sent", text, afterN: 7 }, { type: "sent", text, afterN: 7 }]);
    expect(storedUserItems(live.items, [message(7, text), message(8, text)])).toEqual(new Set([0]));
    expect(storedUserItems(live.items, [message(8, text), message(10, text)])).toEqual(new Set([0, 1]));
    expect(storedUserItems(live.items, [{ ...message(8, text), from: { kind: "parent", threadId: "web/parent" } }])).toEqual(new Set());
    expect(storedUserItems(live.items, [message(8, "another file")])).toEqual(new Set());
  });
});

// Principle 1: a thread opened mid-turn shows her question card once, not its stored copy beside the live one.
describe("stored messages the stream is also showing", () => {
  const ask = (n: number, toolCallId: string): Message => ({
    id: `e:web/test#${n}`, n, role: "assistant", parts: [{ type: "tool", toolCallId, name: "threads", args: { action: "ask" } }], createdAt: "2026-10-12T10:00:00Z",
  });

  it("leaves a stored message to the live copy that shares its tool call", () => {
    const live = run([{ type: "turn_start" }, { type: "tool_call", toolCallId: "call_1", name: "threads" }]);
    expect(storedLiveCopies(live.items, [ask(2, "call_1")])).toEqual(new Set([2]));
    expect(storedLiveCopies(live.items, [ask(2, "call_0")])).toEqual(new Set());
  });

  it("hides nothing once the turn's end has replaced the live copy", () => {
    const live = run([{ type: "turn_start" }, { type: "tool_call", toolCallId: "call_1", name: "threads" }, { type: "turn_end", aborted: false }, { type: "stored" }]);
    expect(storedLiveCopies(live.items, [ask(2, "call_1")])).toEqual(new Set());
  });
});

// An arrival is new tail content while scrolled up; the key follows the real ordered tail, not just her reply.
describe("the conversation's tail key", () => {
  const assistant = (n: number, text: string): Message => ({ id: `e:web/test#${n}`, n, role: "assistant", parts: [{ type: "text", text }], createdAt: "2026-10-12T10:00:00Z" });
  const user = (n: number, text: string): Message => ({ id: `e:web/test#${n}`, n, role: "user", parts: [{ type: "text", text }], createdAt: "2026-10-12T10:00:00Z" });
  const liveWith = (items: LiveItem[]): Live => ({ ...initialLive, items });

  it("grows while a reply streams into the same tail, so a scrolled-up person is offered the jump", () => {
    expect(tailKey([], liveWith([{ role: "assistant", parts: [{ type: "text", text: "Hel" }] }]))).not.toBe(tailKey([], liveWith([{ role: "assistant", parts: [{ type: "text", text: "Hello" }] }])));
  });

  it("grows when a user or notice lands below the tail, and stays put when older history is prepended", () => {
    expect(tailKey([assistant(2, "hi")], initialLive)).not.toBe(tailKey([user(3, "you there?")], initialLive));
    const withNotice = liveWith([{ role: "assistant", parts: [{ type: "text", text: "Hello." }] }, { role: "notice", text: "A subagent finished." }]);
    expect(tailKey([], withNotice)).not.toBe(tailKey([], initialLive));
    expect(tailKey([assistant(4, "old"), assistant(3, "hi")], initialLive)).toBe(tailKey([assistant(3, "hi")], initialLive));
  });
});
