import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THREADS_LIMITS, ROUTINE_GUIDELINE } from "@lyrica/core";
import { checkWords, createThreadsExtension, MESSAGE_MAX, type ThreadsHost } from "../src/threads.ts";
import { ContextMeter } from "../src/context.ts";
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

describe("threads definition", () => {
  // Principle 8: the definition is resent with every reply, so each thread gets only the actions it can use.
  it("sends each kind of thread only its actions and their fields, within a size ceiling", async () => {
    const s = await withMemory();
    const t = s.thread();
    const own = t.view.own;
    const project = own.createThread({ interface: "web", project: true, title: "Homelab" });
    const kinds = {
      plain: t.threadId,
      child: own.createThread({ interface: "cli", parent: t.threadId, child: true }).id,
      projectChat: project.id,
      projectThread: own.createThread({ interface: "web", parent: project.id, child: true, title: "DNS" }).id,
    };
    const host: ThreadsHost = {
      limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async () => "started" as const, list: () => [],
      later: () => ({ dueAt: "" }), cancelLater: () => 0, stop: async () => true, resolve: () => {}, draft: () => {}, stepsChanged: () => {}, checklistsOn: () => true,
    };
    const defs = Object.fromEntries(Object.entries(kinds).map(([kind, threadId]) => {
      let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
      createThreadsExtension({ ...t.context, threadId }, host, new ContextMeter())({ on: () => {}, registerTool: (v: typeof tool) => { tool = v; } } as unknown as ExtensionAPI);
      const params = tool.parameters as unknown as { properties: Record<string, { enum?: string[] }> };
      return [kind, { actions: params.properties.action!.enum, fields: Object.keys(params.properties), size: JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length }];
    }));
    const always = ["later", "routine", "steps", "compact"];
    expect(defs.plain!.actions).toEqual(["start", "message", "list", "read", "stop", "ask", ...always]);
    expect(defs.child!.actions).toEqual(["message", ...always]);
    expect(defs.projectChat!.actions).toEqual(["start", "message", "list", "read", "stop", "suggest", "fold", "draft", "resolve", "reopen", "ask", ...always]);
    expect(defs.projectThread!.actions).toEqual(["message", "list", "read", "resolve", "ask", ...always]);
    expect(defs.plain!.fields).not.toContain("to");
    expect(defs.plain!.fields).not.toContain("base");
    expect(defs.projectChat!.fields).toContain("base");
    expect(defs.child!.fields).toEqual(expect.arrayContaining(["to", "question", "text"]));
    expect(defs.child!.fields).not.toContain("id");
    expect(defs.projectThread!.fields).toEqual(expect.arrayContaining(["needsYou", "id"]));
    for (const field of ["task", "ids", "goal"]) expect(defs.projectThread!.fields).not.toContain(field);
    // Ceilings a little above today's sizes: growing past one is a choice, made here.
    expect(defs.plain!.size).toBeLessThan(4000);
    expect(defs.child!.size).toBeLessThan(2900);
    expect(defs.projectChat!.size).toBeLessThan(4750);
    expect(defs.projectThread!.size).toBeLessThan(3600);
  });
});

describe("threads watch", () => {
  it("is offered only where a repository can be watched, and takes owner/repo#number or the pull request's URL", async () => {
    const s = await withMemory();
    const t = s.thread();
    const asked: [string, number][] = [];
    const host = (watchable: boolean): ThreadsHost => ({
      limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async () => "started" as const, list: () => [],
      watch: async (_from, repo, n) => { asked.push([repo, n]); return `Watching #${n} (${repo}).`; }, watchable: () => watchable,
    });
    const toolOf = (h: ThreadsHost) => {
      let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
      createThreadsExtension(t.context, h)({ on: () => {}, registerTool: (v: typeof tool) => { tool = v; } } as unknown as ExtensionAPI);
      return tool;
    };
    const actions = (tool: ReturnType<typeof toolOf>) => (tool.parameters as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(actions(toolOf(host(false)))).not.toContain("watch");
    const tool = toolOf(host(true));
    expect(actions(tool)).toContain("watch");
    const call = (pr: string) => tool.execute("call", { action: "watch", pr }, undefined, undefined, {} as never);
    await call("ada/lyrica#12");
    await call("https://github.com/ada/lyrica/pull/13");
    await call("https://forge.example/ada/lyrica.git/pulls/14");
    expect(asked).toEqual([["ada/lyrica", 12], ["ada/lyrica", 13], ["ada/lyrica", 14]]);
    await expect(call("#12")).rejects.toThrow("owner/repo#number");
  });
});

describe("handing files over", () => {
  // A model once planned to send a whole page to another thread as base64 chunks in messages.
  it("refuses a file or an over-long text in a message, naming /shared", async () => {
    const s = await withMemory();
    const t = s.thread();
    const own = t.view.own;
    const project = own.createThread({ interface: "web", project: true, title: "Homelab" });
    const dns = own.createThread({ interface: "web", parent: project.id, child: true, title: "DNS" });
    const sent: string[] = [];
    const host: ThreadsHost = { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async (_t, _to, text) => { sent.push(text); return "started" as const; }, list: () => [] };
    let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
    createThreadsExtension({ ...t.context, threadId: dns.id }, host)({ on: () => {}, registerTool: (v: typeof tool) => { tool = v; } } as unknown as ExtensionAPI);
    const call = (args: object) => tool.execute("call", args, undefined, undefined, {} as never);
    const page = Buffer.from("<html>".repeat(200)).toString("base64").replace(/.{76}/g, "$&\n");
    await expect(call({ action: "message", to: "parent", text: `Part 1 of 3:\n${page}` })).rejects.toThrow(/encoded file.*\/shared/);
    await expect(call({ action: "message", to: "parent", text: "word ".repeat(MESSAGE_MAX / 4) })).rejects.toThrow(/10,000 characters, over 8,000.*\/shared/);
    await call({ action: "message", to: "parent", text: "The page is at /shared/pagoda.html." });
    expect(sent).toEqual(["The page is at /shared/pagoda.html."]);
    // Its own project chat can't be read from a project thread, and the error names what works.
    await expect(call({ action: "read", id: project.id })).rejects.toThrow(`[t:${project.id}] is your project chat: it can't be read from here, but you can message it with to: "parent"`);
    // Her own subagent's thread reads; another thread's subagent points to delegate wait.
    const scout = own.createThread({ interface: "web", parent: dns.id, subagent: true });
    expect((await call({ action: "read", id: `t:${scout.id}` })).content).toEqual([{ type: "text", text: `[t:${scout.id}] has no messages to read.` }]);
    const theirs = own.createThread({ interface: "web", parent: project.id, subagent: true });
    await expect(call({ action: "read", id: theirs.id })).rejects.toThrow("for a subagent's result, use delegate with action wait and its run ID");
  });

  it("reads question: \"False\" as false and a written-out question as the message, asked", async () => {
    const s = await withMemory();
    const t = s.thread();
    const project = t.view.own.createThread({ interface: "web", project: true, title: "Homelab" });
    const dns = t.view.own.createThread({ interface: "web", parent: project.id, child: true, title: "DNS" });
    const sent: { text: string; question?: boolean }[] = [];
    const host: ThreadsHost = { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async (_t, _to, text, opts) => { sent.push({ text, question: opts?.question }); return "started" as const; }, list: () => [] };
    let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
    createThreadsExtension({ ...t.context, threadId: dns.id }, host)({ on: () => {}, registerTool: (v: typeof tool) => { tool = v; } } as unknown as ExtensionAPI);
    const call = (args: object) => tool.execute("call", args, undefined, undefined, {} as never);
    // A tool format that makes every value text sends booleans as words.
    await call({ action: "message", to: "parent", text: "Done.", question: "False" });
    await call({ action: "message", to: "parent", text: "Which zone?", question: " yes " });
    await call({ action: "message", to: "parent", question: "Which flowers?" });
    expect(sent).toEqual([{ text: "Done.", question: false }, { text: "Which zone?", question: true }, { text: "Which flowers?", question: true }]);
  });

  it("sends a child's message with no recipient, or naming its parent, to the parent, and counts what's left for siblings", async () => {
    const s = await withMemory();
    const t = s.thread();
    const project = t.view.own.createThread({ interface: "web", project: true, title: "Homelab" });
    const dns = t.view.own.createThread({ interface: "web", parent: project.id, child: true, title: "DNS" });
    const web = t.view.own.createThread({ interface: "web", parent: project.id, child: true, title: "Web" });
    const api = t.view.own.createThread({ interface: "web", parent: project.id, child: true, title: "API" });
    const sent: string[] = [];
    const host: ThreadsHost = { limits: { ...DEFAULT_THREADS_LIMITS, siblingMessages: 2 }, start: async () => { throw new Error("unused"); }, message: async (_t, to) => { sent.push(to); return "started" as const; },
      list: () => [{ id: web.id, title: "Web", status: "idle" } as never, { id: api.id, title: "API", status: "idle" } as never] };
    let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
    createThreadsExtension({ ...t.context, threadId: dns.id }, host)({ on: () => {}, registerTool: (v: typeof tool) => { tool = v; } } as unknown as ExtensionAPI);
    const call = (args: object) => tool.execute("call", args, undefined, undefined, {} as never);
    await call({ action: "message", text: "Report." });
    await call({ action: "message", id: "homelab", text: "Report." });
    await call({ action: "message", id: `[t:${project.id}]`, text: "Report." });
    const first = await call({ action: "message", id: "Web", text: "Zone is ready." });
    expect(JSON.stringify(first.content)).toContain(`1 more to [t:${web.id}] this turn`);
    await call({ action: "message", id: web.id, text: "And the cert." });
    await expect(call({ action: "message", id: web.id, text: "One more." })).rejects.toThrow(/sent \[t:.*\] its 2 messages.*to: "parent"/);
    // The limit is per thread: the same news still reaches another one.
    await call({ action: "message", id: "API", text: "Zone is ready." });
    await call({ action: "message", id: api.id, text: "And the cert." });
    expect(sent).toEqual(["parent", "parent", "parent", web.id, web.id, api.id, api.id]);
  });

  it("lets ordinary prose, links and hashes through", () => {
    expect(() => checkWords("See https://example.com/a/b?c=d and commit 3f9c2e4b1d7a8f6e5d4c3b2a1908f7e6d5c4b3a2 for the fix.", MESSAGE_MAX)).not.toThrow();
  });
});

describe("prose question shape", () => {
  it("ignores ordinary questions and lists followed by unrelated prose", async () => {
    const { proseQuestion } = await import("../src/threads.ts");
    for (const text of ["Any thoughts?", "- One\n- Two\n\nThe work is done.\n\nHow was your day?", "Which?\n- One", "Which?\n- One\n- Two\n- Three\n- Four\n- Five"]) expect(proseQuestion(text)).toBe(false);
    for (const mark of ["-", "*", "1.", "1)", "A)"]) expect(proseQuestion(`Which?\n${mark} One\n${mark} Two`)).toBe(true);
  });
});

describe("hidden nudge context", () => {
  it("expires at a new turn marker even without a typed message", async () => {
    const { dropNudges } = await import("../src/context.ts");
    const nudge = { role: "custom", customType: "lyrica-ask-nudge" };
    const turn = { role: "custom", customType: "lyrica-turn" };
    expect(dropNudges([turn, nudge])).toEqual([turn, nudge]);
    expect(dropNudges([turn, nudge, turn])).toEqual([turn, turn]);
  });
});

describe("a marked message mid-turn", () => {
  it("says it arrived while she was working, only after a tool result and only in the request", async () => {
    const { frameMidTurn, MID_TURN } = await import("../src/context.ts");
    const from = { role: "user", content: [{ type: "text", text: "[From t:abc]\n\nFYI: the tests pass." }] };
    const tool = { role: "toolResult", content: [{ type: "text", text: "ok\n" }] };
    const ask = { role: "user", content: [{ type: "text", text: "Fix the login bug." }] };
    const messages: { role: string; content?: unknown }[] = [from, { role: "assistant" }, tool, from, tool, ask];
    const framed = frameMidTurn(messages);
    // A turn it starts, and a person's message, are left as they are.
    expect(framed[0]).toBe(from);
    expect(framed[5]).toBe(ask);
    expect(framed[3]!.content).toEqual([{ type: "text", text: `[From t:abc]\n\n${MID_TURN}FYI: the tests pass.` }]);
    expect(from.content[0]!.text).toBe("[From t:abc]\n\nFYI: the tests pass.");
    expect(frameMidTurn([ask, tool, ask])).toEqual([ask, tool, ask]);
    const plain = [ask, tool, ask];
    expect(frameMidTurn(plain)).toBe(plain);
  });
});

describe("code mode nudge", () => {
  it("tells her once, on her first edit with code mode off, and never with it on", async () => {
    const { CODE_NUDGE } = await import("../src/code.ts");
    const s = await withMemory();
    const t = s.thread();
    let on = false;
    const host: ThreadsHost = { limits: DEFAULT_THREADS_LIMITS, start: async () => { throw new Error("unused"); }, message: async () => "started" as const, list: () => [], code: () => {}, codeOn: () => on };
    const handlers = new Map<string, (e: unknown) => unknown>();
    createThreadsExtension(t.context, host)({ on: (name: string, h: (e: unknown) => unknown) => handlers.set(name, h), registerTool: () => {} } as unknown as ExtensionAPI);
    const result = (toolName: string) => handlers.get("tool_result")!({ toolName, content: [{ type: "text", text: "ok" }], isError: false }) as { content: { text: string }[] } | undefined;
    expect(result("read")).toBeUndefined();
    on = true;
    expect(result("edit")).toBeUndefined();
    on = false;
    expect(result("write")!.content.at(-1)!.text).toBe(CODE_NUDGE);
    expect(result("edit")).toBeUndefined();
  });
});
