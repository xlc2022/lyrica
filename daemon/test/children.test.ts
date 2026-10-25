import { execFileSync } from "node:child_process";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Sandbox, pickThread, threadLine, type ExecutionTarget, type ToolOps } from "@lyrica/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERRUPTED, MAX_TURN_TOOL_CALLS } from "@lyrica/extension";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { EndpointInfo, MachineProbe, MessagePage, ThreadEvent, ThreadSettings, ThreadSummary, ThreadUsage } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

/** Whether a chat request is a child thread's: its conversation holds a message from its parent. */
const isChild = (c: ChatRequest) => JSON.stringify(c.messages).includes("[From t:");
const said = (c: ChatRequest) => JSON.stringify(c.messages);

/** How long a poll waits for a turn to end or start: a code child's turn starts by cloning or making worktrees, which takes seconds on a slow or nested sandbox, past expect.poll's default second. */
const TURN = { timeout: 15_000 };

/**
 * Ada with a local model and a general thread. The fake model answers the
 * parent from `parent` and children from `child`, in order, so their turns
 * can run at once.
 */
async function setup(opts: Parameters<typeof daemon>[1] = {}, rt?: Awaited<ReturnType<typeof runtime>>) {
  rt ??= await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  // Served at 1M, so threads may share it four at a time (docs/models.md, Local servers).
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b", meta: { n_ctx: 1_048_576 } }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const parent: (Reply | ((c: ChatRequest) => Reply | Promise<Reply>))[] = [];
  const child: (Reply | ((c: ChatRequest) => Reply | Promise<Reply>))[] = [];
  const reply = async (c: ChatRequest) => {
    const next = (isChild(c) ? child : parent).shift() ?? { text: isChild(c) ? "child idle" : "parent idle" };
    return typeof next === "function" ? next(c) : next;
  };
  model.respond(reply);
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Homelab" })).body;
  const u = `/api/u/${rt.ada.id}`;
  const path = `${u}/threads/general/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  const say = async (text: string) => {
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
    return stream.events.slice(from).map((e) => e.event);
  };
  const list = async () => (await ada.get<ThreadSummary[]>(`${u}/threads`)).body;
  const childPath = (id: string) => `${u}/threads/general/${enc(id)}`;
  const messages = async (p: string) => (await ada.get<MessagePage>(`${p}/messages`)).body.messages;
  const idleParent = async () => {
    await expect.poll(() => dm.d.services!.host.busy(rt!.ada.id, "general", thread.id), TURN).toBe(false);
  };
  return { rt, ...dm, ada, model, reply, parent, child, thread, u, path, stream, say, list, childPath, messages, idleParent };
}

const start = (title: string, task: string, more: object = {}): Reply => ({ tools: [{ name: "threads", args: { action: "start", title, task, ...more } }] });
const toParent = (text: string): Reply => ({ tools: [{ name: "threads", args: { action: "message", to: "parent", text } }] });
const toolEnd = (events: ThreadEvent[]) => events.find((e) => e.type === "tool_end") as Extract<ThreadEvent, { type: "tool_end" }>;

/** Waits until `fn` holds, or fails after a few seconds. */
async function until<T>(fn: () => Promise<T>, ok: (t: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await fn();
    if (ok(t)) return t;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(t).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A child's first model call that waits until released, then answers `reply` (by default a tool call, so the turn goes on). */
function held(reply: Reply = toParent("Planning the beds.")) {
  let entered!: () => void;
  let release!: () => void;
  const busy = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  const first = async (): Promise<Reply> => { entered(); await gate; return reply; };
  return { busy, release, first };
}

describe("messages to a busy thread", () => {
  it("a parent's message joins the child's running turn; the person's waits for the next", async () => {
    const { ada, model, parent, child, say, childPath, messages, thread } = await setup();
    const turn = held();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(turn.first, { text: "Tulips added." }, { text: "Roses too." });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await turn.busy;
    const view = ada.events(`${childPath(id)}/events`);
    await view.ready;

    // While the child works: its parent writes, then the person does.
    parent.push({ tools: [{ name: "threads", args: { action: "message", id, text: "Add tulips." } }] }, { text: "Told it." });
    expect(toolEnd(await say("tell it to add tulips"))).toMatchObject({ isError: false });
    const sent = await ada.post<{ queued: boolean }>(`${childPath(id)}/messages`, { text: "and roses" });
    expect(sent.body.queued).toBe(true);
    await view.until((e) => e.type === "queue");
    turn.release();

    // The parent's message reached the turn after its tool call, before the turn's reply; the person's went as the next turn.
    const stored = await until(() => messages(childPath(id)), (m) => m.filter((x) => x.role === "assistant").length === 3);
    expect(stored.map((m) => m.role === "user" ? `${m.from?.kind ?? "you"}: ${(m.parts[0] as { text: string }).text}` : m.role)).toEqual([
      "parent: Plan the beds.", "assistant", "parent: Add tulips.", "assistant", "you: and roses", "assistant",
    ]);
    const calls = model.requests.filter(isChild).map(said);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("Add tulips.");
    expect(calls[1]).not.toContain("and roses");
    expect(calls[2]).toContain("and roses");
    // Its open view saw it land inside the turn, and never as waiting.
    await view.until((e) => e.type === "turn_end");
    const seen = view.events.map((e) => e.event);
    expect(seen.findIndex((e) => e.type === "received")).toBeLessThan(seen.findIndex((e) => e.type === "turn_end"));
    expect(seen.find((e) => e.type === "received")).toEqual({ type: "received", text: `[From t:${thread.id}]\n\nAdd tulips.` });
    expect(seen.filter((e) => e.type === "queue").every((e) => !JSON.stringify(e).includes("tulips"))).toBe(true);
  });

  it("Steer now sends the person's waiting message into the running turn", async () => {
    const { ada, model, parent, child, say, childPath, messages } = await setup();
    const turn = held();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(turn.first, { text: "Roses added." });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await turn.busy;
    const view = ada.events(`${childPath(id)}/events`);
    await view.ready;
    expect((await ada.post<{ queued: boolean }>(`${childPath(id)}/messages`, { text: "and roses" })).body.queued).toBe(true);
    await view.until((e) => e.type === "queue");
    // The text must still be the one at that place: one that went or moved isn't steered by mistake.
    expect((await ada.post(`${childPath(id)}/queue/0/steer`, { text: "and tulips" })).status).toBe(409);
    expect((await ada.post(`${childPath(id)}/queue/0/steer`, { text: "and roses" })).status).toBe(200);
    await view.until((e) => e.type === "queue" && "steered" in e);
    expect(view.events.map((e) => e.event)).toContainEqual({ type: "queue", queued: [], steered: true });
    // Nothing is left to steer, so a second press says so.
    expect((await ada.post(`${childPath(id)}/queue/0/steer`, { text: "and roses" })).status).toBe(409);
    turn.release();

    // It reached the turn after its tool call: two calls, not a third turn for it.
    const stored = await until(() => messages(childPath(id)), (m) => m.filter((x) => x.role === "assistant").length === 2);
    expect(stored.map((m) => m.role === "user" ? (m.parts[0] as { text: string }).text : m.role)).toEqual(["Plan the beds.", "assistant", "and roses", "assistant"]);
    expect(model.requests.filter(isChild).map(said)[1]).toContain("and roses");
    await view.until((e) => e.type === "turn_end");
    expect(view.events.map((e) => e.event)).toContainEqual({ type: "received", text: "and roses" });
    // With no turn running, it refuses: the message goes as the next one anyway.
    expect((await ada.post(`${childPath(id)}/queue/0/steer`, { text: "and roses" })).status).toBe(409);
  });

  it("a parent's message to a child whose turn fails is kept in the child's thread", async () => {
    const { ada, model, parent, child, say, childPath, messages } = await setup();
    const turn = held({ status: 400 });
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(turn.first, { status: 400 }, { text: "Tulips added." });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await turn.busy;
    const view = ada.events(`${childPath(id)}/events`);
    await view.ready;
    parent.push({ tools: [{ name: "threads", args: { action: "message", id, text: "Add tulips." } }] }, { text: "Told it." });
    await say("tell it to add tulips");
    turn.release();
    await view.until((e) => e.type === "turn_end");
    expect(view.events.map((e) => e.event.type)).toContain("received");

    // Both replies failed: the message is stored between them, as from the parent, and the next turn has it.
    const stored = await messages(childPath(id));
    expect(stored.map((m) => m.role === "user" ? `${m.from?.kind}: ${(m.parts[0] as { text: string }).text}` : m.error ? "failed" : "answered"))
      .toEqual(["parent: Plan the beds.", "failed", "parent: Add tulips.", "failed"]);
    expect((await ada.post(`${childPath(id)}/messages`, { text: "go on" })).status).toBe(200);
    await until(() => messages(childPath(id)), (m) => m.at(-1)?.role === "assistant" && !m.at(-1)!.error);
    expect(said(model.requests.filter(isChild).at(-1)!)).toContain("Add tulips.");
  });

  it("a parent's message the turn hadn't taken when stopped is kept", async () => {
    const { ada, parent, child, say, childPath, messages } = await setup();
    const turn = held({ text: "Too late." });
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(turn.first);
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await turn.busy;
    const view = ada.events(`${childPath(id)}/events`);
    await view.ready;
    parent.push({ tools: [{ name: "threads", args: { action: "message", id, text: "Add tulips." } }] }, { text: "Told it." });
    await say("tell it to add tulips");
    expect((await ada.post(`${childPath(id)}/stop`)).status).toBe(200);
    turn.release();
    await view.until((e) => e.type === "turn_end");
    const seen = view.events.map((e) => e.event.type);
    expect(seen.indexOf("received")).toBeGreaterThan(-1);
    expect(seen.indexOf("received")).toBeLessThan(seen.indexOf("turn_end"));
    expect((await messages(childPath(id))).at(-1)).toMatchObject({ role: "user", from: { kind: "parent" }, parts: [{ type: "text", text: "Add tulips." }] });
  });
});

describe("naming a thread", () => {
  it("finds it by ID in any form, or by its current title", () => {
    const rows = [{ id: "web/aa11", title: "Homelab" }, { id: "web/bb22", title: "DNS" }, { id: "web/cc33", title: "dns" }, { id: "web/dd44" }];
    expect(["web/aa11", "t:web/aa11", "[t:web/aa11]", "homelab", " Homelab "].map((r) => pickThread(r, rows))).toEqual(Array(5).fill("web/aa11"));
    expect(() => pickThread("DNS", rows)).toThrow(/more than one thread is called "DNS": \[t:web\/bb22\], \[t:web\/cc33\]/);
    expect(pickThread("web/zz99", rows)).toBe("web/zz99");
  });
});

describe("child threads", () => {
  it("start one that works in the background, nests under its parent, and posts updates back", async () => {
    const { ada, parent, child, thread, stream, say, list, childPath, messages, path, logs } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    parent.push(start("NAS migration", "Move the backups off the old NAS."), { text: "I've started it in its own thread." });
    child.push(async () => { await gate; return toParent("Halfway: the backups are copied."); }, { text: "Copying done." });

    // The tool returns at once, while the child still works.
    const events = await say("keep going on the NAS migration in its own thread");
    const end = toolEnd(events);
    expect(end).toMatchObject({ name: "threads", isError: false, result: expect.stringContaining("Started child thread [t:") });
    const id = end.threads![0]!.id;
    const nested = (await list()).find((t) => t.id === thread.id)!.children;
    expect(nested).toEqual([expect.objectContaining({ id, child: true, title: "NAS migration", status: "working", unseen: 0 })]);

    // Its update shows in the parent as a notice, live and stored, and as an unseen badge.
    const from = stream.events.length;
    release();
    await stream.until((e) => e.type === "notice", from);
    expect(stream.events.slice(from).find((e) => e.event.type === "notice")!.event).toMatchObject({ status: "update", threads: [{ pool: "general", id }], text: expect.stringContaining("Halfway") });
    await until(list, (l) => l.find((t) => t.id === thread.id)!.children[0]!.status === "idle");
    expect((await list()).find((t) => t.id === thread.id)!.children[0]!.unseen).toBe(1);
    expect((await messages(path)).filter((m) => m.role === "notice")).toEqual([
      expect.objectContaining({ parts: [expect.objectContaining({ status: "update", text: expect.stringContaining("Halfway"), threads: [{ pool: "general", id }] })] }),
    ]);
    // Opening the child sees the update; its task shows as from the parent.
    expect((await messages(childPath(id)))[0]).toMatchObject({ role: "user", from: { kind: "parent", threadId: thread.id }, parts: [{ type: "text", text: "Move the backups off the old NAS." }] });
    expect((await list()).find((t) => t.id === thread.id)!.children[0]!.unseen).toBe(0);
    expect(logs.join("\n")).not.toMatch(/NAS|backups|Halfway/);
  });

  it("a child's context and tokens show while its long turn still runs, counted from its own calls", async () => {
    const { ada, parent, child, say, childPath, path } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    parent.push(start("Plant beds", "Plan the beds."), { text: "Started." });
    child.push(toParent("Measuring the beds."), async () => { await gate; return { text: "Planned." }; });
    const id = toolEnd(await say("plan the beds in their own thread")).threads![0]!.id;
    // Its first request asked for a tool and its second waits: the turn is still going.
    const usage = await until(() => ada.get<ThreadUsage>(`${childPath(id)}/usage`).then((r) => r.body), (u) => u.models.length > 0);
    const settings = (await ada.get<ThreadSettings>(`${childPath(id)}/settings`)).body;
    expect(settings.context).toMatchObject({ tokens: expect.any(Number), window: 1_048_576 });
    const parentUsage = (await ada.get<ThreadUsage>(`${path}/usage`)).body;
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.tokens).toBeLessThan(parentUsage.tokens);
    release();
  });

  it("messages flow both ways, and the user talks in a child without the parent being told", async () => {
    const { model, ada, parent, child, say, childPath, messages, path } = await setup();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push({ text: "Planned." });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await until(() => messages(childPath(id)), (m) => m.some((x) => x.role === "assistant"));

    // Parent to child: it reaches the child's next turn, as from the parent.
    parent.push({ tools: [{ name: "threads", args: { action: "message", id, text: "Add tulips." } }] }, { text: "Told it." });
    child.push({ text: "Tulips added." });
    await say("tell it to add tulips");
    const inChild = await until(() => messages(childPath(id)), (m) => m.filter((x) => x.role === "assistant").length === 2);
    expect(inChild.filter((m) => m.role === "user").at(-1)).toMatchObject({ from: { kind: "parent" }, parts: [{ text: "Add tulips." }] });

    // The user writes in the child: an ordinary turn, and nothing reaches the parent.
    const before = (await messages(path)).length;
    child.push({ text: "Sure, roses too." });
    expect((await ada.post(`${childPath(id)}/messages`, { text: "and roses" })).status).toBe(200);
    await until(() => messages(childPath(id)), (m) => m.filter((x) => x.role === "assistant").length === 3);
    expect((await messages(path)).length).toBe(before);
    expect(model.requests.filter((c) => !isChild(c)).some((c) => said(c).includes("and roses"))).toBe(false);
  });

  it("inherit a local-only, unlogged parent's rules, narrow but never widen, and stay one level deep", async () => {
    const { ada, parent, child, path, say, childPath, messages } = await setup();
    await ada.patch(`${path}/settings`, { localOnly: true, unlogged: true });
    parent.push(start("Quiet work", "Think it over.", { internet: false }), { text: "Started." });
    child.push(start("Deeper", "Go deeper."), { text: "Can't nest." });
    const id = toolEnd(await say("work on it quietly"))!.threads![0]!.id;
    const settings = (await ada.get<ThreadSettings>(`${childPath(id)}/settings`)).body;
    expect(settings).toMatchObject({ localOnly: true, unlogged: true, internet: false });
    expect((await ada.patch(`${childPath(id)}/settings`, { localOnly: false })).status).toBe(400);
    expect((await ada.patch(`${childPath(id)}/settings`, { unlogged: false })).status).toBe(400);
    // Its own attempt to start a child thread is refused: its threads tool has no start.
    const msgs = await until(() => messages(childPath(id)), (m) => m.some((x) => x.parts.some((p) => p.type === "tool" && p.result !== undefined)));
    expect(msgs.flatMap((m) => m.parts).find((p) => p.type === "tool")).toMatchObject({ name: "threads", isError: true, result: expect.stringMatching(/action: must be equal to one of the allowed values/) });
    // A folder the parent doesn't have is refused.
    parent.push(start("Elsewhere", "Look around.", { folders: ["/etc"] }), { text: "No." });
    expect(toolEnd(await say("look in /etc"))).toMatchObject({ isError: true, result: expect.stringMatching(/folders its parent has/) });
  });

  it("hold the limits: a few working at once", async () => {
    const { parent, child, say } = await setup({ threads: { concurrency: 2, perRequest: 3 } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => { await gate; return { text: "done" } as Reply; };
    parent.push({ tools: [1, 2, 3].map((i) => ({ name: "threads", args: { action: "start", title: `T${i}`, task: `job ${i}` }, id: `c${i}` })) }, { text: "Some." });
    child.push(slow, slow, slow);
    const results = (await say("start three")).filter((e): e is Extract<ThreadEvent, { type: "tool_end" }> => e.type === "tool_end");
    expect(results.filter((r) => r.isError).map((r) => r.result)).toEqual([expect.stringMatching(/working already/)]);
    release();
  });

  it("hold the limits: a few per message", async () => {
    const { parent, say } = await setup({ threads: { concurrency: 10, perRequest: 3 } });
    parent.push({ tools: [1, 2, 3, 4].map((i) => ({ name: "threads", args: { action: "start", title: `U${i}`, task: `job ${i}` }, id: `d${i}` })) }, { text: "More." });
    const results = (await say("start four")).filter((e): e is Extract<ThreadEvent, { type: "tool_end" }> => e.type === "tool_end");
    expect(results.filter((r) => r.isError).map((r) => r.result)).toEqual([expect.stringMatching(/at most 3/)]);
  });

  it("hold the limits: more per message on a cloud model, which uses no local GPU", async () => {
    const { ada, u, path, parent, child, reply, say } = await setup({ threads: { concurrency: 32, perRequest: 3, cloudPerRequest: 6 } });
    const cloud = await fakeOpenAI({ models: [{ id: "gpt-cloud" }] });
    cloud.respond(reply);
    const gpt = { offeringId: (await ada.post<EndpointInfo>(`${u}/endpoints`, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl })).body.models[0]!.id };
    expect((await ada.patch(`${path}/settings`, { models: { chat: gpt } })).status).toBe(200);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => { await gate; return { text: "done" } as Reply; };
    // Seven at once: six start and work side by side (children inherit the cloud model); the seventh is over the per-message limit.
    parent.push({ tools: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: "threads", args: { action: "start", title: `C${i}`, task: `job ${i}` }, id: `e${i}` })) }, { text: "Many." });
    child.push(slow, slow, slow, slow, slow, slow);
    const results = (await say("start seven")).filter((e): e is Extract<ThreadEvent, { type: "tool_end" }> => e.type === "tool_end");
    expect(results.filter((r) => r.isError).map((r) => r.result)).toEqual([expect.stringMatching(/at most 6/)]);
    release();
  });

  it("Lock stops a working child; a restart leaves one idle, says so in it, and tells and wakes the parent", async () => {
    const rt = await runtime();
    const first = await setup({}, rt);
    first.parent.push(start("Long job", "Work for a long time."), { text: "Started." });
    first.child.push(() => new Promise<Reply>(() => {}));
    const id = toolEnd(await first.say("start a long job"))!.threads![0]!.id;
    await until(first.list, (l) => l.find((t) => t.id === first.thread.id)!.children[0]?.status === "working");

    // A restart while it works: idle afterwards, never resumed, and the parent is told and woken.
    first.parent.push((c) => ({ text: JSON.stringify(c.messages).includes("interrupted when Lyrica restarted") ? "Heard." : "Missed it." }));
    await first.stop();
    const again = await daemon(rt);
    await browser(again.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(again.base, "ada", "pw");
    const list = (await ada.get<ThreadSummary[]>(`${first.u}/threads`)).body;
    expect(list.find((t) => t.id === first.thread.id)!.children[0]).toMatchObject({ id, status: "idle" });
    const page = (await ada.get<MessagePage>(`${first.path}/messages`)).body.messages;
    expect(page.filter((m) => m.role === "notice").map((m) => m.parts[0])).toEqual([expect.objectContaining({ text: expect.stringContaining("interrupted when Lyrica restarted") })]);
    // The child says it was cut off, where its reply would be.
    const cut = (await ada.get<MessagePage>(`${first.childPath(id)}/messages`)).body.messages.at(-1)!;
    expect(cut).toMatchObject({ role: "assistant", error: INTERRUPTED });
    // The parent's woken turn hears of it, to decide which to message on.
    await until(async () => (await ada.get<MessagePage>(`${first.path}/messages`)).body.messages, (m) => m.some((x) => x.role === "assistant" && x.parts.some((p) => p.type === "text" && p.text === "Heard.")));
  });

  it("Lock stops working children, and tells the parent", async () => {
    const { rt, base, ada, parent, child, say, list, thread, path } = await setup();
    parent.push(start("Long job", "Work for a long time."), { text: "Started." });
    child.push(() => new Promise<Reply>(() => {}));
    await say("start a long job");
    await until(list, (l) => l.find((t) => t.id === thread.id)!.children[0]?.status === "working");
    expect((await ada.post(`/api/u/${rt.ada.id}/lock`)).status).toBe(200);
    const again = await login(base, "ada", "pw");
    const after = (await again.get<ThreadSummary[]>(`/api/u/${rt.ada.id}/threads`)).body;
    expect(after.find((t) => t.id === thread.id)!.children[0]).toMatchObject({ status: "idle" });
    const page = (await again.get<MessagePage>(`${path}/messages`)).body.messages;
    expect(page.filter((m) => m.role === "notice").map((m) => m.parts[0])).toEqual([expect.objectContaining({ text: expect.stringContaining("stopped when the user locked") })]);
  });

  it("narrow a child to the folders asked for, read-only, and keep a local-only parent's child off cloud models", async () => {
    const { rt, ada, u, parent, child, path, say, childPath } = await setup();
    const [a, b] = [0, 1].map(() => realpathSync(mkdtempSync(join(tmpdir(), "lyrica-child-"))));
    for (const p of [a!, b!]) expect((await ada.post(`${u}/admin/users/${rt.ada.id}/paths`, { pool: "general", path: p })).status).toBe(200);
    const probe = (await ada.post<MachineProbe>(`${u}/machines/probe`, { name: "nas", address: "lyrica@127.0.0.1:1" })).body;
    expect((await ada.post(`${u}/machines`, { name: "nas", address: "lyrica@127.0.0.1:1", pool: "general", draft: probe.draft, hostKey: `SHA256:${"A".repeat(43)}` })).status).toBe(200);
    expect((await ada.patch(`${path}/settings`, { localOnly: true, grants: [{ path: a, writable: true }, { path: b, writable: true }], machines: ["nas"] })).status).toBe(200);
    parent.push(start("Read only", "Read the notes.", { folders: [a], readOnly: true }), { text: "Started." });
    child.push({ text: "Read." });
    const id = toolEnd(await say("read the notes in a child thread"))!.threads![0]!.id;
    const settings = (await ada.get<ThreadSettings>(`${childPath(id)}/settings`)).body;
    expect(settings.grants).toEqual([{ path: a, writable: false }]);
    // Bash on a machine follows no folder or read-only narrowing: a narrowed child gets no machines.
    expect(settings.machines).toEqual([]);
    // The router refuses a cloud model for it, as for its parent.
    const cloud = await fakeOpenAI({ models: [{ id: "deepseek" }] });
    const deepseek = { offeringId: (await ada.post<EndpointInfo>(`${u}/endpoints`, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl })).body.models[0]!.id };
    const refused = await ada.patch<{ error: string }>(`${childPath(id)}/settings`, { models: { chat: deepseek } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/cloud model/);
  });

  it("lose a machine at once when the parent's is taken off, and their open views hear of it", async () => {
    const { ada, u, parent, child, path, say, childPath } = await setup();
    const probe = (await ada.post<MachineProbe>(`${u}/machines/probe`, { name: "nas", address: "lyrica@127.0.0.1:1" })).body;
    expect((await ada.post(`${u}/machines`, { name: "nas", address: "lyrica@127.0.0.1:1", pool: "general", draft: probe.draft, hostKey: `SHA256:${"A".repeat(43)}` })).status).toBe(200);
    expect((await ada.patch(`${path}/settings`, { machines: ["nas"] })).status).toBe(200);
    parent.push(start("Backups", "Check the backups."), { text: "Started." });
    child.push({ text: "Checked." });
    const id = toolEnd(await say("check the backups in a child thread"))!.threads![0]!.id;
    expect((await ada.get<ThreadSettings>(`${childPath(id)}/settings`)).body.machines).toEqual(["nas"]);
    const view = ada.events(`${childPath(id)}/events`);
    await view.ready;
    expect((await ada.patch(`${path}/settings`, { machines: [] })).status).toBe(200);
    await view.until((e) => e.type === "settings");
    expect((await ada.get<ThreadSettings>(`${childPath(id)}/settings`)).body.machines).toEqual([]);
    // The machine it can no longer see doesn't block an unrelated change.
    expect((await ada.patch(`${childPath(id)}/settings`, { webSearch: false })).status).toBe(200);
  });

  it("hold the limits: a message to an idle child waits for a slot, and another parent's children count", async () => {
    const { ada, u, model, parent, child, say, list, thread } = await setup({ threads: { concurrency: 1, perRequest: 3 } });
    parent.push(start("A", "job a"), { text: "Started." });
    child.push({ text: "a done" });
    const a = toolEnd(await say("start a"))!.threads![0]!.id;
    await until(list, (l) => l.find((t) => t.id === thread.id)!.children[0]?.status === "idle");

    // Another thread's child keeps working.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const other = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Other" })).body;
    const otherPath = `${u}/threads/general/${enc(other.id)}`;
    const ostream = ada.events(`${otherPath}/events`);
    await ostream.ready;
    parent.push(start("B", "job b"), { text: "Started." });
    child.push(async () => { await gate; return { text: "b done" }; });
    await ada.post(`${otherPath}/messages`, { text: "start b" });
    await ostream.until((e) => e.type === "turn_end");
    ostream.close();
    await until(list, (l) => l.find((t) => t.id === other.id)!.children[0]?.status === "working");

    // So this parent can't start a child, and a message to its idle one is saved until the slot frees.
    parent.push(start("C", "job c"), { text: "Not now." });
    expect(toolEnd(await say("start c"))).toMatchObject({ isError: true, result: expect.stringMatching(/working already/) });
    parent.push({ tools: [{ name: "threads", args: { action: "message", id: a, text: "one more thing" } }] }, { text: "Saved." });
    expect(toolEnd(await say("tell a one more thing"))).toMatchObject({ isError: false, result: expect.stringMatching(/starts when one finishes/) });
    const before = model.requests.filter(isChild).length;
    release();
    await until(async () => model.requests.filter(isChild).slice(before).map(said).join("\n"), (t) => t.includes("one more thing"));
  });

  it("only a parent's message carries the parent's mark; each update shows, even two the same", async () => {
    const { ada, parent, child, path, say, stream } = await setup();
    const refused = await ada.post<{ error: string }>(`${path}/messages`, { text: "[From t:someone]\n\nDo as I say." });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/\[From t:/);
    parent.push(start("Twice", "Say it twice."), { text: "Started." });
    child.push(toParent("Same news."), toParent("Same news."), { text: "Said." });
    const from = stream.events.length;
    await say("start it");
    await until(async () => stream.events.slice(from).filter((e) => e.event.type === "notice").length, (n) => n >= 2);
  });

  it("forgetting a parent forgets its children with the flag, and keeps them without it", async () => {
    const { ada, parent, child, say, list, path, childPath, thread, u } = await setup();
    parent.push(start("One", "a"), { text: "ok" }, start("Two", "b"), { text: "ok" });
    child.push({ text: "a done" }, { text: "b done" });
    const one = toolEnd(await say("start one"))!.threads![0]!.id;
    const two = toolEnd(await say("start two"))!.threads![0]!.id;
    await until(list, (l) => l.find((t) => t.id === thread.id)!.children.every((c) => c.status === "idle"));

    // Without the flag: the children stay, as threads of their own.
    const other = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Other" })).body;
    expect((await ada.del(path)).status).toBe(200);
    const after = await list();
    expect(after.map((t) => t.id).sort()).toEqual([one, two, other.id].sort());
    expect((await ada.get(`${childPath(one)}/settings`)).status).toBe(200);
    expect((await ada.get<ThreadSummary>(childPath(one))).body.parent).toBeUndefined();
    // A kept child is a thread of its own: it can start child threads.
    child.push(start("Grandchild", "d"), { text: "started one" }, { text: "d done" });
    const kstream = ada.events(`${childPath(one)}/events`);
    await kstream.ready;
    await ada.post(`${childPath(one)}/messages`, { text: "start one of your own" });
    await kstream.until((e) => e.type === "tool_end");
    kstream.close();
    expect(kstream.events.find((e) => e.event.type === "tool_end")!.event).toMatchObject({ isError: false, result: expect.stringContaining("Started child thread [t:") });

    // With it: they go too.
    parent.push(start("Three", "c"), { text: "ok" });
    child.push({ text: "c done" });
    const otherPath = `${u}/threads/general/${enc(other.id)}`;
    const ostream = ada.events(`${otherPath}/events`);
    await ada.post(`${otherPath}/messages`, { text: "start three" });
    await ostream.until((e) => e.type === "turn_end");
    ostream.close();
    const three = (await list()).find((t) => t.id === other.id)!.children[0]!.id;
    await until(list, (l) => l.find((t) => t.id === other.id)!.children.every((c) => c.status === "idle"));
    expect((await ada.del(otherPath, { children: true })).status).toBe(200);
    expect((await list()).map((t) => t.id).sort()).toEqual([one, two].sort());
    expect((await ada.get(childPath(three))).status).toBe(404);
  });
});

describe("a child's end, reading and stopping", () => {
  const notices = async (messages: () => Promise<{ role: string; parts: unknown[] }[]>) =>
    (await messages()).filter((m) => m.role === "notice").map((m) => (m.parts[0] as { text: string }).text);
  const call = (args: object): Reply => ({ tools: [{ name: "threads", args }] });

  it("the parent gets a child's last message as its report when it sent none, again after a new message, and not from one that reported", async () => {
    const { parent, child, say, path, messages, idleParent } = await setup();
    parent.push(start("Silent", "Plan the beds."), { text: "Started." });
    child.push({ text: "Planned." });
    const silent = toolEnd(await say("start the silent one"))!.threads![0]!.id;
    const implicit = (text: string) => `Child thread [t:${silent}] ended without a report; its last message, as its report:\n${text}`;
    await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes(implicit("Planned."))));

    // The parent writes to it again; it ends without a report again, and the parent hears again.
    await idleParent();
    parent.push(call({ action: "message", id: silent, text: "And the paths?" }), { text: "Asked." });
    child.push({ text: "Paths too." });
    await say("ask it about the paths");
    await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes(implicit("Paths too."))));

    await idleParent();
    parent.push(start("Loud", "Plan the paths."), { text: "Started." });
    child.push(toParent("Paths planned."), { text: "Done." });
    const loud = toolEnd(await say("start the loud one"))!.threads![0]!.id;
    await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes("Paths planned.")));
    await new Promise((r) => setTimeout(r, 300));
    const all = (await notices(() => messages(path))).join("\n");
    expect(all).not.toContain(`[t:${loud}] ended without a report`);
    expect(all).not.toContain("finished without a report");
    expect(all).not.toContain("stopped with an error");
  });

  it("the parent is woken at once, with its last message, when a child's turn stops at the tool limit, even after it reported", async () => {
    const { parent, child, say, path, messages } = await setup();
    parent.push(start("Status", "Record the call facts."), { text: "Started." });
    // It reports early (one call), then runs into the turn's limit of tool calls, and writes where things stand.
    child.push(toParent("Started on the facts."), ...Array.from({ length: MAX_TURN_TOOL_CALLS - 1 }, (_, i) => ({ tools: [{ name: "recall", args: { query: `fact ${i}` } }] })), { text: "Halfway: the tests still need fixing." });
    const id = toolEnd(await say("record the call facts in their own thread"))!.threads![0]!.id;
    const got = await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes("tool limit")));
    const text = got.find((t) => t.includes("tool limit"))!;
    expect(text).toContain(`Child thread [t:${id}] stopped at its turn's tool limit`);
    expect(text).toContain("Halfway: the tests still need fixing.");
  });

  it("the parent hears of a child whose model call fails", async () => {
    const { parent, child, say, path, messages } = await setup();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push({ status: 400 });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    const got = await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes("stopped with an error")));
    expect(got.join("\n")).toContain(`Child thread [t:${id}] stopped with an error, and is idle`);
    expect(got.join("\n")).not.toContain("finished without a report");
  });

  it("the parent hears that a child waits for its plan's reset, once, not that it stopped with an error", async () => {
    const { rt, d, thread, parent, child, say, path, messages } = await setup();
    const resets = Date.parse("2030-01-01T06:48:00Z");
    parent.push(start("Status", "Record the call facts."), { text: "Started." });
    // The child's plan refuses for its usage limit, as hosted.ts reports it: the thread waits, and its turn ends in the error.
    child.push(() => {
      const { children } = d.services!;
      for (const c of children.children(rt.ada.id, "general", thread.id)) { children.planWaiting(rt.ada.id, "general", c.id, "chatgpt", resets); children.planWaiting(rt.ada.id, "general", c.id, "chatgpt", resets); }
      return { status: 400 };
    });
    const id = toolEnd(await say("record the facts in their own thread"))!.threads![0]!.id;
    await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes("usage limit")));
    await new Promise((r) => setTimeout(r, 300));
    const all = (await notices(() => messages(path))).filter((t) => t.includes(`[t:${id}]`));
    expect(all.filter((t) => t.includes("usage limit"))).toEqual([`Child thread [t:${id}] is waiting for chatgpt's usage limit, which resets at 06:48 UTC; it carries on then by itself.`]);
    expect(all.join("\n")).not.toContain("stopped with an error");
  });

  it("the parent hears at once, from lyricad, when a child's checks run out of rounds, with its last message", async () => {
    const { rt, d, thread, parent, child, say, path, messages } = await setup();
    parent.push(start("Track", "Fix the track."), { text: "Started." });
    // The checks extension's last round, as hosted.ts passes it on (extension/test/checks.test.ts covers the rounds).
    child.push(() => {
      const { children } = d.services!;
      for (const c of children.children(rt.ada.id, "general", thread.id)) children.checksExhausted(rt.ada.id, "general", c.id, "$ npm test (at abc1234)\nFAIL track.test.ts");
      return { text: "The track test still fails." };
    });
    const id = toolEnd(await say("fix the track in its own thread"))!.threads![0]!.id;
    const got = (await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes("checks still fail")))).join("\n");
    expect(got).toContain(`Child thread [t:${id}]'s checks still fail after 3 rounds, so they stopped for this turn:\n\n$ npm test (at abc1234)\nFAIL track.test.ts`);
    expect(got).toContain("run the failing command here on the base branch");
    expect(got).toContain("Its last message:\nThe track test still fails.");
    // One notice: no separate report of its last message.
    expect(got).not.toContain("ended without a report");
  });

  it("the parent hears of a child that fails every time only once, until it reports", async () => {
    const { parent, child, say, path, messages } = await setup();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push({ status: 400 });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    const failed = (n: string[]) => n.filter((t) => t.includes(`[t:${id}] stopped with an error`)).length;
    await until(() => notices(() => messages(path)), (n) => failed(n) === 1);

    parent.push(call({ action: "message", id, text: "Try again." }), { text: "Asked it again." });
    child.push({ status: 400 });
    await say("ask it to try again");
    await until(() => messages(`${path.replace(/[^/]+$/, "")}${enc(id)}`), (m) => m.filter((x) => x.role === "assistant" && x.error).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(failed(await notices(() => messages(path)))).toBe(1);
  });

  it("the parent reads a child's latest messages, but not another thread's", async () => {
    const { ada, u, parent, child, say, path, messages, idleParent } = await setup();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push({ text: "Tulips go by the wall." });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await until(() => notices(() => messages(path)), (n) => n.length > 0);

    await idleParent();
    parent.push(call({ action: "read", id, last: 1 }), { text: "Read it." });
    const one = toolEnd(await say("read its last message"));
    expect(one).toMatchObject({ isError: false });
    expect(one.result).toContain("Tulips go by the wall.");
    expect(one.result).not.toContain("Plan the beds.");
    expect(one.result!.match(/\[e:/g)).toHaveLength(1);

    const other = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Other" })).body;
    parent.push(call({ action: "read", id: other.id }), { text: "Refused." });
    expect(toolEnd(await say("read the other thread"))).toMatchObject({ isError: true, result: expect.stringMatching(/isn't a child thread/) });

    parent.push(call({ action: "read", id }), { text: "Read it." });
    const all = toolEnd(await say("read what it did"));
    expect(all).toMatchObject({ isError: false });
    expect(all.result).toContain("Plan the beds.");
    expect(all.result).toContain("Tulips go by the wall.");
  });

  it("the parent stops a working child, and nobody is told it ended", async () => {
    const { parent, child, say, list, thread, path, messages } = await setup();
    const turn = held();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(turn.first);
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await turn.busy;

    parent.push(call({ action: "stop", id }), { text: "Stopped it." });
    expect(toolEnd(await say("stop it"))).toMatchObject({ isError: false, result: expect.stringContaining(`Stopped [t:${id}]`) });
    await until(list, (l) => l.find((t) => t.id === thread.id)!.children[0]?.status === "idle");
    turn.release();
    await new Promise((r) => setTimeout(r, 300));
    const all = (await notices(() => messages(path))).join("\n");
    expect(all).not.toContain("finished without a report");
    expect(all).not.toContain("stopped with an error");

    parent.push(call({ action: "stop", id }), { text: "Already idle." });
    expect(toolEnd(await say("stop it again"))).toMatchObject({ isError: false, result: `[t:${id}] wasn't working.` });
  });

  it("the person writing in a child that reported doesn't tell the parent", async () => {
    const { ada, parent, child, say, childPath, path, messages } = await setup();
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(toParent("Beds planned."), { text: "Done." });
    const id = toolEnd(await say("plan the garden in its own thread"))!.threads![0]!.id;
    await until(() => messages(childPath(id)), (m) => m.some((x) => x.role === "assistant" && !x.error && x.parts.some((p) => p.type === "text")));
    await until(() => notices(() => messages(path)), (n) => n.some((t) => t.includes("Beds planned.")));
    const before = (await messages(path)).length;

    child.push({ text: "Sure, roses too." });
    expect((await ada.post(`${childPath(id)}/messages`, { text: "and roses" })).status).toBe(200);
    await until(() => messages(childPath(id)), (m) => m.filter((x) => x.role === "assistant").length === 3);
    await new Promise((r) => setTimeout(r, 300));
    expect((await messages(path)).length).toBe(before);
  });
});


describe("child notices waking a parent", () => {
  it("progress waits; a question wakes once and its parent's reply cannot wake the child", async () => {
    const { ada, model, parent, child, say, childPath, messages, path } = await setup();
    const turn = held(toParent("Still planning."));
    const finish = held({ text: "Done." });
    parent.push(start("Garden", "Plan the beds."), { text: "Started." });
    child.push(turn.first, finish.first);
    const id = toolEnd(await say("start it"))!.threads![0]!.id;
    await turn.busy;
    turn.release();
    await finish.busy;
    await until(() => messages(path), m => m.some(x => x.role === "notice"));
    const before = model.requests.filter(c => !isChild(c)).length;
    await new Promise(r => setTimeout(r, 150));
    expect(model.requests.filter(c => !isChild(c))).toHaveLength(before);
    // The user can ask the child to send a question after its current turn.
    finish.release();
    await until(() => messages(path), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "parent idle")));
    const answer = held({ text: "Acknowledged." });
    parent.push({ tools: [{ name: "threads", args: { action: "message", id, text: "Use tulips." } }] }, answer.first);
    // A question written out, as ask takes it, is sent as the message and asked.
    child.push({ tools: [{ name: "threads", args: { action: "message", to: "parent", question: "Which flowers?" } }] }, { text: "Waiting." });
    await ada.post(`${childPath(id)}/messages`, { text: "Ask which flowers." });
    await answer.busy;
    await until(() => messages(childPath(id)), m => m.some(x => x.role === "user" && x.from?.kind === "parent" && x.parts.some(p => p.type === "text" && p.text === "Use tulips.")));
    const childCalls = model.requests.filter(isChild).length;
    await new Promise(r => setTimeout(r, 150));
    expect(model.requests.filter(isChild)).toHaveLength(childCalls);
    answer.release();
  });

  it("coalesces three questions and the final report into one running parent turn", async () => {
    const { ada, parent, child, say, childPath, path, messages, stream, idleParent } = await setup();
    const turn = held({ text: "Ready." });
    parent.push(start("Garden", "Plan."), { text: "Started." });
    child.push(turn.first);
    const id = toolEnd(await say("start"))!.threads![0]!.id;
    await turn.busy;
    // Let the initial task finish, including its daemon notice.
    turn.release();
    await until(() => messages(path), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "parent idle")));
    const wake = held({ text: "Heard them." });
    parent.push(wake.first);
    await idleParent();
    const count = stream.events.filter(e => e.event.type === "turn_start").length;
    child.push(...[1, 2, 3].map(n => ({ tools: [{ name: "threads", args: { action: "message", to: "parent", text: `Question ${n}`, question: true } }] })), { text: "Reported." });
    await ada.post(`${childPath(id)}/messages`, { text: "Ask three questions." });
    await wake.busy;
    await until(() => messages(childPath(id)), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "Reported.")));
    wake.release();
    await until(() => messages(path), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "Heard them.")));
    await new Promise(r => setTimeout(r, 200));
    expect(stream.events.filter(e => e.event.type === "turn_start")).toHaveLength(count + 1);
  });
});


it("a final child report wakes a parent whose live session was disposed", async () => {
  const { d, rt, thread, parent, child, say, path, messages, idleParent, stream } = await setup();
  const turn = held(toParent("Beds planned."));
  parent.push(start("Garden", "Plan the beds."), { text: "Started." });
  child.push(turn.first, { text: "Done." });
  await say("start it");
  await turn.busy;
  await idleParent();
  d.services!.host.reload(rt.ada.id, "general", thread.id);
  const before = stream.events.filter(e => e.event.type === "turn_start").length;
  turn.release();
  await until(() => messages(path), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "parent idle")));
  await idleParent();
  expect(stream.events.filter(e => e.event.type === "turn_start")).toHaveLength(before + 1);
  expect((await messages(path)).filter(m => m.role === "notice")).toHaveLength(1);
});


it("a woken parent's reply reaches a busy child's next user turn without starting one", async () => {
  const { ada, parent, child, say, childPath, path, messages, idleParent } = await setup();
  const question = held({ tools: [{ name: "threads", args: { action: "message", to: "parent", text: "Which flowers?", question: true } }] });
  const childEnd = held({ text: "Waiting." });
  const parentEnd = held({ text: "Answered." });
  parent.push(start("Garden", "Plan."), { text: "Started." });
  child.push(question.first, childEnd.first);
  const id = toolEnd(await say("start it"))!.threads![0]!.id;
  await question.busy;
  await idleParent();
  parent.push({ tools: [{ name: "threads", args: { action: "message", id, text: "Use tulips." } }] }, parentEnd.first);
  question.release();
  await childEnd.busy;
  await parentEnd.busy;
  child.push(c => {
    expect(said(c)).toContain("Use tulips.");
    return { text: "Tulips it is." };
  });
  expect((await ada.post(`${childPath(id)}/messages`, { text: "Carry on." })).status).toBe(200);
  childEnd.release();
  await until(() => messages(childPath(id)), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "Tulips it is.")));
  parentEnd.release();
  await until(() => messages(path), m => m.some(x => x.role === "assistant" && x.parts.some(p => p.type === "text" && p.text === "Answered.")));
});


// Git runs locally only in these fakes; model traffic uses setup's fake endpoint.
describe("code thread worktrees", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  async function projectRepo(opts: Parameters<typeof setup>[0] = {}, project = true) {
    const s = await setup(opts);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-thread-worktrees-")));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "example repository\n");
    git("add", ".");
    git("-c", "user.name=Example", "-c", "user.email=example@example.invalid", "commit", "-qm", "initial");
    await s.ada.post(`${s.u}/admin/users/${s.rt.ada.id}/paths`, { pool: "general", path: repo });
    await s.ada.patch(s.path, { project });
    expect((await s.ada.patch(`${s.path}/settings`, { grants: [{ path: repo, writable: true }] })).status).toBe(200);
    const workspace = s.d.services!.workspace;
    const ws = workspace.settings(s.rt.ada.id);
    vi.spyOn(workspace, "targetFor").mockImplementation((t) => {
      const cwd = join(root, "threads", encodeURIComponent(ws.folderThread(t.threadId)));
      mkdirSync(cwd, { recursive: true });
      return { name: "sandbox", cwd: async () => cwd, ops: () => ({ bash: createLocalBashOperations() } as unknown as ToolOps), folders: () => [] } satisfies ExecutionTarget;
    });
    const make = async (title: string, more = {}) => {
      s.parent.push(start(title, `Build ${title}.`, { code: true, ...more }), { text: "Started." });
      s.child.push({ text: "Ready." });
      const result = toolEnd(await s.say(`Start ${title}.`));
      await s.idleParent();
      return result;
    };
    const idle = async (id: string) => { await expect.poll(() => s.d.services!.host.busy(s.rt.ada.id, "general", id), TURN).toBe(false); };
    // A child that ends without a report wakes its parent: that turn ends too before the next start, so it can't take the start's script.
    const settled = async (id: string) => {
      await idle(id);
      await expect.poll(async () => JSON.stringify(await s.messages(s.path)), TURN).toContain(`[t:${id}] ended without a report`);
      await s.idleParent();
    };
    const pair = async () => {
      const services = s.d.services!;
      const view = services.memory.openThreadView(s.rt.ada.id, "general");
      try {
        const ctx = { user: services.users.get(s.rt.ada.id)!, pool: "general" as const, interface: "web" as const,
          threadId: s.thread.id, view, call: services.models.callContext(s.rt.ada.id, "general", s.thread.id) };
        return await Promise.all([
          services.children.start(ctx, { title: "Physics", task: "Build physics.", code: true }),
          services.children.start(ctx, { title: "Renderer", task: "Build renderer.", code: true }),
        ]);
      } finally { view.close(); }
    };
    return { ...s, root, repo, git, ws, workspace, make, idle, settled, pair };
  }

  it.each([true, false])("isolates two writers and restores a resolved checkout (project: %s)", async (project) => {
    const s = await projectRepo({}, project);
    expect(s.ws.folderThread(s.thread.id)).toBe(s.thread.id);
    expect(s.ws.threadWork(s.thread.id)).toBeUndefined();
    expect(s.ws.effective(s.thread.id).grants).toEqual([{ path: s.repo, writable: true }]);
    const [{ id: a }, { id: b }] = await s.pair();
    await s.idle(a); await s.idle(b);
    expect(s.ws.effective(s.thread.id).grants).toEqual([{ path: s.repo, writable: true }]);
    expect(s.ws.folderThread(s.thread.id)).toBe(s.thread.id);
    const wa = s.ws.threadWork(a)!.worktrees[0]!;
    const wb = s.ws.threadWork(b)!.worktrees[0]!;
    expect(wa).toBeDefined(); expect(wb).toBeDefined();
    expect(wa.path).not.toBe(wb.path);
    expect(wa.branch).not.toBe(wb.branch);
    expect(wa.branch).toMatch(/^lyrica\/[^/]+\/[^/]+$/);
    expect(wa.branch).not.toContain("physics");
    expect(wb.branch).not.toContain("renderer");
    expect(wa.path).toBe(join(s.root, "threads", encodeURIComponent(a), "worktrees", "repo"));
    writeFileSync(join(wa.path, "physics.ts"), "export const speed = 1;\n");
    expect(existsSync(join(wb.path, "physics.ts"))).toBe(false);
    expect(existsSync(join(s.repo, "physics.ts"))).toBe(false);
    for (const id of [a, b]) {
      const grants = s.ws.effective(id).grants;
      expect(grants).toEqual([{ path: s.repo, writable: false }, { path: `${s.repo}/.git`, writable: true }]);
      const box = new Sandbox({ workdir: s.root, grants, network: { internet: false, services: false, hosts: [] } });
      expect(() => box.allow(join(s.repo, "README.md"), true)).toThrow(/read-only/);
      expect(box.allow(join(s.repo, ".git", "index"), true)).toContain(".git/index");
    }
    expect(s.model.requests.filter(isChild).map(said).join("\n")).toContain(wa.path);
    // Commit before resolving: the checkout goes, the branch stays.
    execFileSync("git", ["-C", wa.path, "add", "."]);
    execFileSync("git", ["-C", wa.path, "-c", "user.name=Example", "-c", "user.email=example@example.invalid", "commit", "-qm", "physics"]);
    if (!project) {
      // Plain parents merge directly; Resolve/Reopen belongs to projects.
      s.git("merge", "--ff-only", wa.branch);
      expect(readFileSync(join(s.repo, "physics.ts"), "utf8")).toContain("speed = 1");
      expect((await s.ada.del(s.childPath(a))).status).toBe(200);
      expect(existsSync(wa.path)).toBe(false);
      expect(s.git("branch", "--list", wa.branch)).toContain(wa.branch);
      return;
    }
    expect((await s.ada.post(`${s.childPath(a)}/resolve`)).status).toBe(200);
    expect(existsSync(wa.path)).toBe(false);
    expect(s.git("branch", "--list", wa.branch)).toContain(wa.branch);
    expect((await s.ada.post(`${s.childPath(a)}/reopen`)).status).toBe(200);
    await s.workspace.prepareWorktrees({ userId: s.rt.ada.id, pool: "general", threadId: a });
    expect(existsSync(join(wa.path, "physics.ts"))).toBe(true);
    await s.ada.post(`${s.childPath(a)}/resolve`);
    s.git("merge", "--ff-only", wa.branch);
    expect(readFileSync(join(s.repo, "physics.ts"), "utf8")).toContain("speed = 1");
    s.git("branch", "-d", wa.branch);
    await s.ada.post(`${s.childPath(a)}/reopen`);
    await s.workspace.prepareWorktrees({ userId: s.rt.ada.id, pool: "general", threadId: a });
    expect(existsSync(join(wa.path, "physics.ts"))).toBe(true);
    // A later narrowing still removes commit access.
    s.ws.setThread(s.thread.id, "general", { grants: [{ path: s.repo, writable: false }] });
    expect(s.ws.effective(a).grants.every((g) => !g.writable)).toBe(true);
  });

  it("lets several base threads be open at once, and doesn't run a resolved queued one", async () => {
    const s = await projectRepo({ threads: { concurrency: 0 } });
    const a = (await s.make("Scaffold", { base: true })).threads![0]!.id;
    await s.idle(a);
    expect(s.d.services!.children.projectThreads(s.rt.ada.id, "general", s.thread.id).find((t) => t.id === a)?.state).toBe("queued");
    expect(s.ws.threadWork(a)).toMatchObject({ base: true, worktrees: [] });
    expect(s.ws.effective(a).grants).toEqual([{ path: s.repo, writable: true }]);
    // No hold: a second base thread starts while the first is open.
    const b = (await s.make("Merge", { base: true })).threads![0]!.id;
    await s.idle(b);
    expect(s.ws.threadWork(b)?.base).toBe(true);
    await s.ada.post(`${s.childPath(a)}/resolve`);
    expect(s.d.services!.children.projectThreads(s.rt.ada.id, "general", s.thread.id).find((t) => t.id === a)?.state).toBe("resolved");
    // A resolved queued thread doesn't run when slots free up.
    s.d.services!.children.limits.concurrency = 1;
    s.d.services!.children.resume(s.rt.ada.id);
    await expect.poll(() => s.model.requests.filter(isChild).map(said).join("\n"), TURN).toContain("Build Merge.");
    const db = s.d.services!.users.openUserDb(s.rt.ada.id);
    try { expect(db.prepare("SELECT queued FROM child_threads WHERE thread = ?").get(a)).toEqual({ queued: 1 }); }
    finally { db.close(); }
    // Reopening a base thread is allowed with another open.
    expect((await s.ada.post(`${s.childPath(a)}/reopen`)).status).toBe(200);
  });

  it("sends a second start for an open thread's task to that thread, and lists the branch a thread works on", async () => {
    const s = await projectRepo();
    const a = (await s.make("#7 Physics")).threads![0]!.id;
    await s.settled(a);
    // Refused before anything runs, so only the parent takes a script: the same title, or another naming the same #7.
    for (const title of ["#7 physics ", "Implement the engine for #7"]) {
      s.parent.push(start(title, "Build physics.", { code: true }), { text: "Asked it." });
      const again = toolEnd(await s.say("Start that again."));
      await s.idleParent();
      expect(again).toMatchObject({ isError: true, result: expect.stringContaining(`[t:${a}] is already open for this task`) });
    }
    const row = s.d.services!.children.projectThreads(s.rt.ada.id, "general", s.thread.id).find((t) => t.id === a)!;
    const w = s.ws.threadWork(a)!.worktrees[0]!;
    expect(row.worktrees).toEqual([{ branch: w.branch, path: w.path }]);
    expect(threadLine(row)).toContain(`works on ${w.branch} in ${w.path} (readable to you`);
  });

  it("keeps a dirty worktree on resolve and reports where, and removes it when the thread is deleted", async () => {
    const s = await projectRepo();
    const id = (await s.make("Track")).threads![0]!.id;
    await s.idle(id);
    const w = s.ws.threadWork(id)!.worktrees[0]!;
    writeFileSync(join(w.path, "track.ts"), "export const laps = 2;\n");
    // Her resolve stops at work no remote has, and goes through only when forced.
    await s.settled(id);
    s.parent.push({ tools: [{ name: "threads", args: { action: "resolve", id } }] }, { text: "Kept it." });
    // Worded apart from the child's task, so recall doesn't bring the child's messages into this turn.
    expect(toolEnd(await s.say("Tidy up the list."))).toMatchObject({ isError: true, result: expect.stringContaining(`[t:${id}] has work no remote has:\n${w.path}: 1 file not committed`) });
    await s.idleParent();
    expect(s.d.services!.children.projectThreads(s.rt.ada.id, "general", s.thread.id).find((t) => t.id === id)?.state).not.toBe("resolved");
    s.parent.push({ tools: [{ name: "threads", args: { action: "resolve", id, force: true } }] }, { text: "Set aside." });
    expect(toolEnd(await s.say("Tidy up the list anyway."))).toMatchObject({ isError: false });
    await s.idleParent();
    expect(existsSync(w.path)).toBe(true);
    expect(JSON.stringify(await s.messages(s.path))).toContain("was kept");
    await s.ada.del(s.childPath(id));
    expect(existsSync(w.path)).toBe(false);
    expect(s.git("worktree", "list")).not.toContain(w.path);
    expect(s.git("branch", "--list", w.branch)).toContain(w.branch);
  });

  it("starts with a visible reason when a writable folder is not a repository", async () => {
    const s = await projectRepo();
    const folder = join(s.root, "plain"); mkdirSync(folder);
    await s.ada.post(`${s.u}/admin/users/${s.rt.ada.id}/paths`, { pool: "general", path: folder });
    s.ws.setThread(s.thread.id, "general", { grants: [{ path: folder, writable: true }] });
    const id = (await s.make("Plain folder")).threads![0]!.id;
    await s.idle(id);
    expect(s.ws.threadWork(id)?.reason).toContain("isn't the top");
    expect((await s.ada.get<ThreadSummary>(s.childPath(id))).body.worktreeReason).toContain("isn't the top");
    expect(s.model.requests.filter(isChild).map(said).join("\n")).toContain("No worktree");
  });

  it("gives no reason for a thread that has only repositories, since it works in its own clones", async () => {
    const s = await projectRepo();
    s.ws.addGitAccount({ name: "ada", kind: "github", host: "github.com", account: "ada", token: "ada-token", pool: "general", offNetwork: true });
    s.ws.setThread(s.thread.id, "general", { grants: [], repositories: [{ name: "ada/track", account: "ada" }] });
    const cloned = (await s.make("Cloned")).threads![0]!.id;
    await s.settled(cloned);
    expect(s.ws.threadWork(cloned)?.reason).toBeUndefined();
    // A read-only child keeps the repository, read-only at the relay.
    const reader = (await s.make("Reader", { readOnly: true })).threads![0]!.id;
    await s.settled(reader);
    expect(s.ws.effective(reader).repositories).toEqual([{ name: "ada/track", account: "ada", readOnly: true }]);
    s.ws.setThread(s.thread.id, "general", { repositories: [] });
    const bare = (await s.make("Bare")).threads![0]!.id;
    await s.idle(bare);
    expect(s.ws.threadWork(bare)?.reason).toContain("no writable host folders");
  });

  it.each(["mid-merge", "no sandbox"])("starts with a reason when there is %s", async (why) => {
    const s = await projectRepo();
    if (why === "mid-merge") writeFileSync(join(s.repo, ".git", "MERGE_HEAD"), s.git("rev-parse", "HEAD"));
    else {
      const local = s.workspace.targetFor({ userId: s.rt.ada.id, pool: "general", threadId: s.thread.id });
      vi.mocked(s.workspace.targetFor).mockReturnValue({ ...local, name: "ssh:example" });
    }
    const id = (await s.make("Fallback")).threads![0]!.id;
    await s.idle(id);
    expect(s.ws.threadWork(id)?.worktrees).toEqual([]);
    expect(s.ws.threadWork(id)?.reason).toMatch(why === "mid-merge" ? /mid-merge/ : /need the sandbox/);
    expect(s.ws.effective(id).grants).toEqual([{ path: s.repo, writable: true }]);
  });

  it("keeps a non-code child in its parent's folder", async () => {
    const s = await setup();
    s.parent.push(start("Research", "Read the example."), { text: "Started." });
    s.child.push({ text: "Done." });
    const id = toolEnd(await s.say("Start a research child." )).threads![0]!.id;
    const ws = s.d.services!.workspace.settings(s.rt.ada.id);
    expect(ws.threadWork(id)).toBeUndefined();
    expect(ws.folderThread(id)).toBe(s.thread.id);
  });

});
