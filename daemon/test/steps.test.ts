import { describe, expect, it } from "vitest";
import { STEPS_LIMITS, threadLine } from "@lyrica/core";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { Me, ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const steps = (list: object[]): Reply => ({ tools: [{ name: "threads", args: { action: "steps", steps: list } }] });
const toolEnds = (events: ThreadEvent[]) => events.filter((e) => e.type === "tool_end") as Extract<ThreadEvent, { type: "tool_end" }>[];

/** A user with a local model and a general thread; the fake model answers from `replies`, in order. */
async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const replies: Reply[] = [];
  const asked: ChatRequest[] = [];
  model.respond((c) => { asked.push(c); return replies.shift() ?? { text: "ok" }; });
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
  const summary = async () => (await ada.get<ThreadSummary>(path)).body;
  return { rt, ada, replies, asked, path, stream, say, summary };
}

describe("a thread's checklist", () => {
  it("is set and cleared by her, cut to its limits, sent to open views and shown in the thread's summary", async () => {
    const { replies, say, stream, summary } = await setup();
    const long = "x".repeat(STEPS_LIMITS.chars + 20);
    replies.push(steps([
      { text: "Read the brief", state: "done" },
      { text: "  Build   the route ", state: "doing" },
      { text: long, state: "todo" },
      { text: "   ", state: "todo" },
    ]), { text: "On it." });
    expect(toolEnds(await say("build it"))[0]).toMatchObject({ isError: false, result: "Checklist set: 1 of 3 steps done." });
    const set = (await summary()).steps!;
    expect(set.slice(0, 2)).toEqual([{ text: "Read the brief", state: "done" }, { text: "Build the route", state: "doing" }]);
    expect(set[2]!.text).toHaveLength(STEPS_LIMITS.chars);
    expect(set[2]!.text.endsWith("…")).toBe(true);
    expect(stream.events.some((e) => e.event.type === "steps" && e.event.steps.length === 3)).toBe(true);

    // Too many steps, or a state that isn't one, change nothing.
    replies.push(steps(Array.from({ length: STEPS_LIMITS.steps + 1 }, (_, i) => ({ text: `Step ${i}`, state: "todo" }))),
      steps([{ text: "Ship", state: "shipped" }]), { text: "Hm." });
    const refused = toolEnds(await say("more"));
    expect(refused[0]).toMatchObject({ isError: true, result: expect.stringContaining(`at most ${STEPS_LIMITS.steps} steps`) });
    expect(refused[1]).toMatchObject({ isError: true, result: expect.stringContaining("steps[0].state received string; must be one of todo, doing, done") });
    expect(refused[1]!.result).not.toContain("shipped");
    expect((await summary()).steps).toHaveLength(3);

    replies.push(steps([]), { text: "Done." });
    expect(toolEnds(await say("never mind"))[0]).toMatchObject({ isError: false, result: "Checklist cleared." });
    expect((await summary()).steps).toBeUndefined();
  });

  it("is off with the person's Checklists switch: she isn't offered it, can't set it, and summaries show none", async () => {
    const { rt, ada, replies, asked, say, summary } = await setup();
    replies.push(steps([{ text: "Plan", state: "doing" }]), { text: "Planned." });
    await say("plan it");
    expect(JSON.stringify(asked.at(-1)!.messages)).toContain("keep this thread's checklist");
    expect((await summary()).steps).toHaveLength(1);

    const me = await ada.patch<Me>(`/api/u/${rt.ada.id}/me/display`, { checklists: false });
    expect(me.body.display.checklists).toBe(false);
    expect((await summary()).steps).toBeUndefined();
    replies.push(steps([{ text: "Plan", state: "done" }]), { text: "Fine." });
    const ends = toolEnds(await say("carry on"));
    expect(JSON.stringify(asked.at(-2)!.messages)).not.toContain("keep this thread's checklist");
    expect(ends[0]).toMatchObject({ isError: true, result: expect.stringContaining("action: must be equal to one of the allowed values") });
    expect((await ada.patch(`/api/u/${rt.ada.id}/me/display`, { checklists: "no" })).status).toBe(400);
  });

  it("shows in a parent's list of its threads as where the work stands", () => {
    const line = threadLine({ id: "c1", title: "Build", status: "working", updatedAt: "2026-01-01T00:00:00Z", steps: [
      { text: "Read", state: "done" }, { text: "Test", state: "doing" }, { text: "PR", state: "todo" },
    ] });
    expect(line).toBe("[t:c1] \"Build\": working, last 2026-01-01T00:00:00Z; 1 of 3 steps done, now: \"Test\"");
    expect(threadLine({ id: "c2", status: "idle", updatedAt: "2026-01-01T00:00:00Z" })).not.toContain("steps");
  });
});
