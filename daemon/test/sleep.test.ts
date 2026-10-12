import { describe, expect, it, vi } from "vitest";
import { PoolStore } from "@lyrica/core";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { EndpointInfo, MessagePage, OfferingInfo, SendResponse, SleepEvent, SleepOverview, SleepRunDetail, SleepStarted, ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime, sse } from "./helpers.ts";

// Sleep through lyricad: the nightly schedule, /sleep, the Sleep section's API.
// The fake model plays each phase, told apart by the tools it is offered.

const MARKER = "PELICAN-MARKER-42";
const call = (name: string, args: unknown): Reply => ({ tools: [{ name, args }] });
const said = (c: ChatRequest) => JSON.stringify(c.messages);
const lastIsTool = (c: ChatRequest) => c.messages.at(-1)?.role === "tool";

/** Answers a phase once with its tool call, then "Done."; a conversation with a note; anything else with text. */
function night(c: ChatRequest, o: { note?: () => string | undefined; hold?: Promise<void> } = {}): Reply | Promise<Reply> {
  const tools = (c.tools ?? []).map((t) => t.function.name);
  if (lastIsTool(c)) return { text: "Done." };
  if (tools.includes("write_page")) {
    const note = o.note?.();
    if (o.hold) return o.hold.then(() => call("recall", { query: "anything" }));
    return note ? call("write_page", { slug: "birds", title: "Birds", summary: "{user} and birds", text: `{user} likes pelicans [${note}].` }) : { text: "Done." };
  }
  if (tools.includes("write_journal")) return call("write_journal", { text: "I dreamt of pelicans over a harbour." });
  if (tools.includes("write_wake")) return call("write_wake", { text: `Waking up. ${"word ".repeat(420)}` });
  if (tools.includes("remember") && said(c).includes(MARKER)) return call("remember", { notes: [{ text: `{user} loves pelicans (${MARKER})` }] });
  return { text: "Lovely." };
}

async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt, { sleep: { retries: 0 } });
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const u = `/api/u/${rt.ada.id}`;
  const note = () => {
    const o = dm.d.services!.memory.openOwnerView(rt.ada.id);
    try { return o.general.search("pelicans", { kinds: ["note"] })[0]?.id; } finally { o.close(); }
  };
  model.respond((c) => night(c, { note }));
  /** A conversation where Ada mentions the marker and she notes it. */
  const talk = async () => {
    const thread = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general" })).body;
    const path = `${u}/threads/general/${enc(thread.id)}`;
    const stream = ada.events(`${path}/events`);
    await ada.post(`${path}/messages`, { text: `I love pelicans, remember ${MARKER}` });
    await stream.until((e: ThreadEvent) => e.type === "turn_end");
    stream.close();
    return path;
  };
  const sleepEvents = () => sse(`${dm.base}${u}/sleep/events`, { cookie: ada.cookie! });
  return { rt, ...dm, ada, model, u, talk, note, sleepEvents };
}

const finished = (pool: string) => (e: unknown) => (e as SleepEvent).type === "finished" && (e as SleepEvent).pool === pool;

describe("sleep in lyricad", () => {
  it("sleeps every pool at night, and shows what it did", async () => {
    const s = await setup();
    await s.talk();
    await s.d.sleepNight();
    const overview = (await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body;
    expect(overview).toMatchObject({ mode: "scheduled", time: "04:00" });
    expect(overview.runs.map((r) => [r.pool, r.status, r.skipReason])).toEqual(expect.arrayContaining([
      ["general", "complete", undefined], ["private", "skipped", "no-activity"],
    ]));
    const run = overview.runs.find((r) => r.pool === "general")!;
    const detail = (await s.ada.get<SleepRunDetail>(`${s.u}/sleep/general/runs/${enc(run.id)}`)).body;
    expect(detail.pages).toEqual([{ id: "p:birds", title: "Birds", after: `[[u:${s.rt.ada.id}]] likes pelicans [${s.note()}].` }]);
    expect(detail.dream[0]!.text).toContain("pelicans over a harbour");
    expect(detail.wake).toMatch(/^Waking up/);
    expect(detail.users[s.rt.ada.id]!.displayName).toBe("Ada");
    // The phases are threads of the sleep interface.
    const sleepThreads = (await s.ada.get<ThreadSummary[]>(`${s.u}/threads?interface=sleep&all=1`)).body;
    expect(sleepThreads.map((t) => t.title).sort()).toEqual(["Sleep: consolidate", "Sleep: dream", "Sleep: wake"]);
  });

  it("in manual mode sleeps only on /sleep, asks first, then opens a fresh thread", async () => {
    const s = await setup();
    await s.ada.put(`${s.u}/sleep/mode`, { mode: "manual" });
    const path = await s.talk();
    await s.d.sleepNight();
    expect((await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body.runs).toEqual([]);

    // Typed in a thread, /sleep asks first.
    const asked = (await s.ada.post<SendResponse>(`${path}/messages`, { text: "/sleep" })).body;
    expect(asked.sleep).toEqual({ confirm: expect.stringContaining("Sleep now?") });
    const events = s.sleepEvents();
    await events.ready;
    const started = await s.ada.post<SleepStarted>(`${s.u}/sleep/general`, { confirm: true });
    expect(started.body).toEqual({ started: true });
    await events.until((e) => (e as unknown as SleepEvent).type === "thread");
    events.close();
    const types = events.events.map((e) => (e.event as unknown as SleepEvent).type);
    expect(types).toEqual(["started", "phase", "phase", "phase", "phase", "phase", "phase", "finished", "thread"]);
    const fresh = (events.events.at(-1)!.event as unknown as Extract<SleepEvent, { type: "thread" }>).threadId;
    const list = (await s.ada.get<ThreadSummary[]>(`${s.u}/threads`)).body;
    expect(list.map((t) => t.id)).toContain(fresh);
    expect((await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body.runs.map((r) => [r.status, r.reason])).toEqual([["complete", "manual"]]);
  });

  it("answers /sleep with a plain error when it can't run", async () => {
    const s = await setup();
    const nothing = await s.ada.post(`${s.u}/sleep/general`, {});
    expect(nothing).toMatchObject({ status: 409, body: { error: "Sleep can't run now: nothing is new since the last sleep." } });
    await s.talk();
    const dead = (await s.ada.post<EndpointInfo>(`${s.u}/endpoints`, { name: "dead", kind: "local", baseUrl: "http://127.0.0.1:9/v1" })).body;
    const m = (await s.ada.post<OfferingInfo>(`${s.u}/endpoints/${dead.id}/models`, { modelId: "m" })).body;
    await s.ada.put(`${s.u}/profiles/custom/sleep.wake`, { model: { offeringId: m.id } });
    const down = await s.ada.post(`${s.u}/sleep/general`, {});
    expect(down).toMatchObject({ status: 409, body: { error: "Sleep can't run now: no model for Sleep: wake can be reached now (dead/m: dead is down)." } });
    expect((await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body.runs.map((r) => r.skipReason)).toEqual(["endpoint-down", "no-activity"]);
  });

  it("starts a chat from an item, where she speaks first, and dismisses others", async () => {
    const s = await setup();
    await s.talk();
    s.model.respond((c) => {
      const tools = (c.tools ?? []).map((t) => t.function.name);
      if (tools.includes("write_journal") && !lastIsTool(c)) {
        return { tools: [{ name: "write_journal", args: { text: "Pelicans again." }, id: "a" }, { name: "raise", args: { text: "Ask whether the pelicans came back" }, id: "b" }, { name: "raise", args: { text: "A second thought" }, id: "c" }] };
      }
      if (said(c).includes("Ask whether the pelicans came back") && !tools.includes("raise")) return { text: "Did the pelicans come back?" };
      return night(c, { note: s.note });
    });
    await s.d.sleepNight();
    const items = (await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body.items;
    expect(items.map((i) => [i.text, i.new])).toEqual(expect.arrayContaining([["Ask whether the pelicans came back", true], ["A second thought", true]]));
    const item = items.find((i) => i.text.startsWith("Ask"))!;
    const other = items.find((i) => i.text.startsWith("A second"))!;

    const thread = (await s.ada.post<ThreadSummary>(`${s.u}/sleep/general/items/${enc(item.id)}/chat`)).body;
    const path = `${s.u}/threads/general/${enc(thread.id)}`;
    let page = (await s.ada.get<MessagePage>(`${path}/messages`)).body;
    for (const end = Date.now() + 5000; !page.messages.length && Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      page = (await s.ada.get<MessagePage>(`${path}/messages`)).body;
    }
    expect(page.messages.map((m) => m.role)).toEqual(["assistant"]);
    expect(page.messages[0]!.parts).toContainEqual({ type: "text", text: "Did the pelicans come back?" });
    // Her turn and its title call are done before counting.
    await s.d.services!.host.get(s.rt.ada.id, "general", thread.id).settled();
    await new Promise((r) => setTimeout(r, 200));
    const calls = s.model.requests.length;
    const again = await s.ada.post<ThreadSummary>(`${s.u}/sleep/general/items/${enc(item.id)}/chat`);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(thread.id);
    expect(s.model.requests).toHaveLength(calls);

    await s.ada.del(`${s.u}/sleep/general/items/${enc(other.id)}`);
    const after = (await s.ada.get<SleepOverview>(`${s.u}/sleep`)).body.items;
    expect(after.map((i) => [i.text, i.new, i.thread])).toEqual([["Ask whether the pelicans came back", false, thread.id]]);
    await s.ada.del(path);
    expect((await s.ada.post(`${s.u}/sleep/general/items/${enc(item.id)}/chat`)).status).toBe(409);
  });

  it("retries an interrupted item opening after restart", async () => {
    const s = await setup();
    const owner = s.d.services!.memory.openOwnerView(s.rt.ada.id);
    let item: string;
    try {
      const run = owner.general.startSleepRun("manual", new Date().toISOString());
      item = owner.general.addItem(run, { kind: "thought", text: "Ask about the harbour" });
    } finally { owner.close(); }
    let reached!: () => void;
    const requested = new Promise<void>((resolve) => { reached = resolve; });
    s.model.respond(() => { reached(); return new Promise<Reply>(() => {}); });
    const route = `${s.u}/sleep/general/items/${enc(item!)}/chat`;
    await s.ada.post(route);
    await requested;
    const linked = s.d.services!.memory.openOwnerView(s.rt.ada.id);
    let thread: string;
    try { thread = linked.general.getItem(item!)!.thread!; } finally { linked.close(); }
    const busy = await s.ada.post<ThreadSummary>(route);
    expect(busy.body.id).toBe(thread!);
    expect(s.model.requests).toHaveLength(1);
    // A crash cannot flush Pi's pending opening or an abort reply at shutdown.
    const append = vi.spyOn(PoolStore.prototype, "appendEntry").mockImplementation(() => "");
    try { await s.stop(); } finally { append.mockRestore(); }
    s.model.respond(() => ({ text: "How was the harbour?" }));
    const restarted = await daemon(s.rt, { sleep: { retries: 0 } });
    await browser(restarted.base).post("/api/unlock", { passphrase: "passphrase" });
    const ada = await login(restarted.base, "ada", "pw");
    const again = await ada.post<ThreadSummary>(route);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(thread!);
    await restarted.d.services!.host.get(s.rt.ada.id, "general", thread!).settled();
    const view = restarted.d.services!.memory.openOwnerView(s.rt.ada.id);
    try {
      const entries = view.general.loadEntries(thread!) as { type: string; message?: { role: string; content: unknown } }[];
      expect(entries.filter((e) => e.message?.role === "assistant")).toHaveLength(1);
      expect(entries.filter((e) => e.message?.role === "user")).toHaveLength(1);
    } finally { view.close(); }
    expect(s.model.requests).toHaveLength(2);
    expect(s.model.requests[1]!.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("stops at Lock with the run partial, and logs no text", async () => {
    const s = await setup();
    await s.talk();
    let release!: () => void;
    const reached = new Promise<void>((r) => (release = r));
    const never = new Promise<void>(() => {});
    s.model.respond((c) => {
      if ((c.tools ?? []).some((t) => t.function.name === "write_page") && !lastIsTool(c)) { release(); return night(c, { hold: never }); }
      return night(c, { note: s.note });
    });
    const running = s.d.services!.sleep.run(s.rt.ada.id, "general", "manual");
    await reached;
    await s.ada.post(`${s.u}/lock`);
    expect((await running).status).toBe("partial");
    expect(s.logs.join("\n")).toContain("sleep general: partial");
    expect(s.logs.join("\n")).not.toContain(MARKER);
  });
});
