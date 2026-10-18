import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THREADS_LIMITS, ROUTINE_GUIDELINE } from "@lyrica/core";
import { createThreadsExtension, type ThreadsHost } from "../src/threads.ts";
import { withMemory } from "./helpers.ts";

async function setup(child = false) {
  const s = await withMemory();
  const t = s.thread();
  if (child) {
    const c = t.view.own.createThread({ interface: "cli", parent: t.threadId, child: true });
    t.context.threadId = c.id;
  }
  const host: ThreadsHost = { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async () => "started" as const, list: () => [] };
  const toolFor = (context = t.context) => {
    let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
    createThreadsExtension(context, host)({ on: () => {}, registerTool: (value: typeof tool) => { tool = value; } } as unknown as ExtensionAPI);
    return { tool, call: (args: object) => tool.execute("call", { action: "routine", ...args }, undefined, undefined, {} as never) };
  };
  return { ...s, ...t, ...toolFor(), toolFor };
}

describe("threads routine", () => {
  it("adds in a child thread, lists without notes, pauses, resumes and removes", async () => {
    const s = await setup(true);
    expect(s.tool.promptGuidelines).toContain(ROUTINE_GUIDELINE);
    const added = await s.call({ routineAction: "add", schedule: { kind: "weekdays", time: "08:00" }, note: "  Check the build.  ", newThread: true });
    expect(added.content).toEqual([{ type: "text", text: expect.stringContaining("Weekdays at 08:00") }]);
    const [r] = s.view.own.routines(s.context.threadId);
    expect(r).toMatchObject({ note: "Check the build.", newThread: true, paused: false });
    const listed = await s.call({ routineAction: "list" });
    expect(JSON.stringify(listed.content)).toContain(`Routine ${r!.id}`);
    expect(JSON.stringify(listed.content)).not.toContain(r!.note);
    for (const routineAction of ["pause", "resume"] as const) {
      await s.call({ routineAction, routineId: r!.id });
      expect(s.view.own.routines(s.context.threadId)[0]!.paused).toBe(routineAction === "pause");
    }
    await s.call({ routineAction: "remove", routineId: r!.id });
    expect(s.view.own.routines(s.context.threadId)).toEqual([]);
    expect((await s.call({ routineAction: "list" })).content).toEqual([{ type: "text", text: "This thread has no routines." }]);
  });

  it("anchors hourly schedules now and defaults to running here", async () => {
    const s = await setup();
    const before = Date.now();
    await s.call({ routineAction: "add", schedule: { kind: "every", hours: 2 }, note: "Check status." });
    const [r] = s.view.own.routines(s.context.threadId);
    expect(r!.newThread).toBe(false);
    expect(r!.schedule.kind).toBe("every");
    if (r!.schedule.kind !== "every") throw new Error("expected hourly schedule");
    expect(Date.parse(r!.schedule.from)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(r!.nextAt) - Date.parse(r!.schedule.from)).toBe(2 * 3_600_000);
  });

  it("returns plain validation errors and keeps invalid routines out of storage", async () => {
    const s = await setup();
    for (const schedule of [{ kind: "daily", time: "25:00" }, { kind: "weekly", day: 7, time: "08:00" }, { kind: "yearly", date: "04-31", time: "08:00" }, { kind: "every", hours: 0 }, { kind: "unknown" }]) {
      const result = await s.call({ routineAction: "add", schedule, note: "Check status." });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.any(String) }] });
    }
    expect(await s.call({ routineAction: "add", schedule: { kind: "daily", time: "08:00" }, note: " " })).toMatchObject({ isError: true });
    expect(await s.call({ routineAction: "pause" })).toMatchObject({ isError: true });
    expect(await s.call({})).toMatchObject({ isError: true });
    expect(s.view.own.routines(s.context.threadId)).toEqual([]);
  });

  it("caps each thread at 10 including paused routines, even for concurrent calls", async () => {
    const s = await setup();
    const add = () => s.call({ routineAction: "add", schedule: { kind: "daily", time: "08:00" }, note: "Check status." });
    await Promise.all(Array.from({ length: 10 }, add));
    const [first] = s.view.own.routines(s.context.threadId);
    await s.call({ routineAction: "pause", routineId: first!.id });
    expect(await add()).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("10 routines") }] });
    expect(s.view.own.routines(s.context.threadId)).toHaveLength(10);
    await s.call({ routineAction: "remove", routineId: first!.id });
    expect(await add()).not.toHaveProperty("isError");
  });

  it("cannot list, pause, resume or remove another thread's routine", async () => {
    const s = await setup();
    const other = s.thread();
    const id = other.view.own.addRoutine(other.threadId, { kind: "daily", time: "08:00" }, "Other thread's note.");
    expect(JSON.stringify((await s.call({ routineAction: "list" })).content)).not.toContain("Other thread");
    for (const routineAction of ["pause", "resume", "remove"]) {
      expect(await s.call({ routineAction, routineId: id })).toMatchObject({ isError: true, content: [{ type: "text", text: "this thread has no routine with that ID" }] });
      expect(other.view.own.routines(other.threadId)).toMatchObject([{ id, paused: false }]);
    }
    await s.call({ routineAction: "add", schedule: { kind: "daily", time: "09:00" }, note: "Own note.", id: other.threadId });
    expect(s.view.own.routines(s.context.threadId)).toHaveLength(1);
    expect(other.view.own.routines(other.threadId)).toHaveLength(1);
  });
});
