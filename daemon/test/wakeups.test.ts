import { describe, expect, it } from "vitest";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { MessagePage, ThreadEvent, ThreadSettings, ThreadSummary, WakeupInfo } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const said = (c: ChatRequest) => JSON.stringify(c.messages);
const later = (args: object): Reply => ({ tools: [{ name: "threads", args: { action: "later", ...args } }] });
const toolEnd = (events: ThreadEvent[]) => events.find((e) => e.type === "tool_end") as Extract<ThreadEvent, { type: "tool_end" }>;

/** Ada with a local model and a general thread; the fake model answers from `replies`, in order. */
async function setup(rt?: Awaited<ReturnType<typeof runtime>>) {
  rt ??= await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const replies: Reply[] = [];
  const asked: string[] = [];
  model.respond((c) => { asked.push(said(c)); return replies.shift() ?? { text: "ok" }; });
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Build" })).body;
  const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  const say = async (text: string) => {
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
    return stream.events.slice(from).map((e) => e.event);
  };
  const wakeups = async () => (await ada.get<ThreadSettings>(`${path}/settings`)).body.wakeups;
  /** lyricad's tick, `minutes` from now. */
  const tick = (minutes: number) => dm.d.services!.wakeups.tick(new Date(Date.now() + minutes * 60_000));
  return { rt, ...dm, ada, replies, asked, thread, path, stream, say, wakeups, tick };
}

describe("wake-ups", () => {
  it("wake the thread at its time with her note, marked, shown in the facts and gone once fired", async () => {
    const { ada, replies, asked, path, stream, say, wakeups, tick } = await setup();
    replies.push(later({ minutes: 15, note: "Check CI on the branch." }), { text: "I'll look in 15 minutes." });
    const set = toolEnd(await say("open the PR and check CI later"));
    expect(set).toMatchObject({ isError: false, result: expect.stringContaining("in 15 minutes") });
    const [w] = await wakeups();
    expect(w!.dueAt > new Date(Date.now() + 14 * 60_000).toISOString()).toBe(true);
    expect(stream.events.some((e) => e.event.type === "wakeups")).toBe(true);

    // Not yet due: nothing fires.
    tick(10);
    await new Promise((r) => setTimeout(r, 200));
    expect(await wakeups()).toHaveLength(1);

    replies.push({ text: "CI is green." });
    const from = stream.events.length;
    tick(16);
    await stream.until((e) => e.type === "turn_end", from);
    expect(asked.at(-1)).toMatch(/\[Wake-up, set [0-9T:-]+Z\]\\n\\nCheck CI on the branch\./);
    expect(await wakeups()).toEqual([]);
    const page = (await ada.get<MessagePage>(`${path}/messages`)).body;
    const woke = page.messages.find((m) => m.from?.kind === "wakeup")!;
    expect(woke.parts).toEqual([{ type: "text", text: "Check CI on the branch." }]);
  });

  it("hold the caps, clamp the time, and can be dropped by her or removed by the person", async () => {
    const { ada, replies, path, say, wakeups } = await setup();
    replies.push(later({ minutes: 0, note: "One." }), later({ minutes: 99_999, note: "Two." }), later({ minutes: 30, note: "Three." }), later({ minutes: 40, note: "Four." }), { text: "Set." });
    const events = await say("set four");
    const ends = events.filter((e) => e.type === "tool_end") as Extract<ThreadEvent, { type: "tool_end" }>[];
    expect(ends[0]).toMatchObject({ isError: false, result: expect.stringContaining("(in 1 minute; 0 is out of range)") });
    expect(ends[1]).toMatchObject({ isError: false, result: expect.stringContaining("(in 10080 minutes; 99999 is out of range)") });
    expect(ends[3]).toMatchObject({ isError: true, result: expect.stringContaining("3 wake-ups waiting already") });
    const three = await wakeups();
    expect(three).toHaveLength(3);

    const left = (await ada.del<WakeupInfo[]>(`${path}/wakeups/${three[0]!.id}`)).body;
    expect(left.map((w) => w.id).sort()).toEqual([three[1]!.id, three[2]!.id].sort());
    expect((await ada.del(`${path}/wakeups/${three[0]!.id}`)).status).toBe(404);

    replies.push(later({ cancel: true }), { text: "Dropped." });
    expect(toolEnd(await say("never mind"))).toMatchObject({ isError: false, result: "Dropped 2 wake-ups." });
    expect(await wakeups()).toEqual([]);
  });

  it("survive a restart, and fire late at unlock saying when they were due", async () => {
    const rt = await runtime();
    const first = await setup(rt);
    first.replies.push(later({ minutes: 5, note: "Look again." }), { text: "Later." });
    await first.say("look again in five minutes");
    await first.stop();

    const again = await daemon(rt);
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(again.base, "ada", "pw");
    const path = first.path;
    expect((await ada.get<ThreadSummary>(path)).body.wakeAt).toBeDefined();
    expect((await ada.get<ThreadSettings>(`${path}/settings`)).body.wakeups).toHaveLength(1);
    const stream = ada.events(`${path}/events`);
    await stream.ready;
    first.replies.push({ text: "Looked." });
    again.d.services!.wakeups.tick(new Date(Date.now() + 10 * 60_000));
    await stream.until((e) => e.type === "turn_end");
    expect(first.asked.at(-1)).toMatch(/\[Wake-up, set [0-9T:-]+Z, due [0-9T:-]+Z\]\\n\\nLook again\./);
  });

  it("can't be typed: the person's message can't carry the mark", async () => {
    const { ada, path } = await setup();
    expect((await ada.post(`${path}/messages`, { text: "[Wake-up, set 2026-10-12T05:15Z]\n\nhello" })).status).toBe(400);
  });
});

describe("a plan's usage limit", () => {
  /** Ada's chat on a ChatGPT plan first, then her local model; the plan answers every request with `error`. */
  async function planFirst(error: object) {
    const s = await setup();
    const models = s.d.services!.models, actor = s.d.services!.users.get(s.rt.ada.id)!;
    const plan = models.addPlan(actor, { name: "chatgpt", plan: "chatgpt", credential: { access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000 } });
    const planModel = models.addModel(actor, plan.id, { modelId: "gpt-5", tools: true });
    const local = models.resolve("chat", models.callContext(s.rt.ada.id, "general", s.thread.id)).ref;
    models.setColumnTask(s.rt.ada.id, "general", "chat", [{ offeringId: planModel.id }, local]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/chatgpt\.com|api\.openai\.com/.test(url)) return Response.json({ error }, { status: 429 });
      return realFetch(input, init);
    }) as typeof fetch;
    return { ...s, models, plan, restore: () => { globalThis.fetch = realFetch; } };
  }

  it("waits for the plan to reset rather than falling back, says when once, and carries the turn on then", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 40 * 60;
    for (const error of [{ code: "usage_limit_reached", resets_at: resetsAt }, { code: "subscription_sharing_usage_limit_exceeded", message: "usage limit" }]) {
      const s = await planFirst(error);
      try {
        s.replies.push({ text: "The local model answered." });
        const events = await s.say("build it");
        expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
        expect(events.find((e) => e.type === "notice")).toMatchObject({ text: expect.stringMatching(/^chatgpt reached its plan's usage limit\. It resets in about \d+ (min|h)\. This thread waits and carries on then\.$/), status: "limit" });
        expect(events).not.toContainEqual({ type: "text", delta: "The local model answered." });
        const until = s.models.planLimitedUntil(s.plan.id)!;
        if ("resets_at" in error) {
          expect(until).toBe(resetsAt * 1000);
          const info = (await s.ada.get<{ id: string; limitedUntil?: string }[]>(`/api/u/${s.rt.ada.id}/endpoints`)).body;
          expect(info.find((e) => e.id === s.plan.id)?.limitedUntil).toBe(new Date(resetsAt * 1000).toISOString());
        }
        // One wake-up, a minute after the reset; the plan is still the thread's model.
        const wakeups = await s.wakeups();
        expect(wakeups).toHaveLength(1);
        expect(Date.parse((wakeups[0] as { dueAt: string }).dueAt)).toBe(until + 60_000);
        expect(s.models.resolve("chat", s.models.callContext(s.rt.ada.id, "general", s.thread.id)).endpoint.id).toBe(s.plan.id);
      } finally {
        s.restore();
      }
    }
  });

  it("keeps one resume however many turns the limit cuts off before it resets", async () => {
    const s = await planFirst({ code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 40 * 60 });
    try {
      await s.say("build it");
      await s.say("and the tests");
      expect(await s.wakeups()).toHaveLength(1);
    } finally {
      s.restore();
    }
  });

  it("carries the turn on by itself once the plan resets, and not before", async () => {
    const s = await planFirst({ code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 40 * 60 });
    try {
      await s.say("build it");
      const [first] = await s.wakeups() as { id: number }[];
      s.tick(39);
      expect(await s.wakeups()).toEqual([first]);
      const from = s.stream.events.length;
      s.tick(42);
      await s.stream.until((e) => e.type === "turn_end", from);
      // It fired; this fake plan is limited still, so the turn waits again with a wake-up of its own.
      const after = await s.wakeups() as { id: number }[];
      expect(after).toHaveLength(1);
      expect(after[0]!.id).not.toBe(first!.id);
    } finally {
      s.restore();
    }
  });
});
