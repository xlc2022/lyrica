import { describe, expect, it } from "vitest";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { CallInfo, EndpointInfo, MessagePage, Profiles, ProjectOverview, ThreadEvent, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

// Projects: a project chat whose child threads are the project's threads.

const said = (c: ChatRequest) => JSON.stringify(c.messages);
/** Which thread a request is from: its first user message's text says so in these tests. */
const who = (c: ChatRequest) => (JSON.stringify(c.messages[0]?.content ?? "").includes("Reply with JSON only") ? "watching"
  : /\[From t:[^\]]+\]\\n\\n(\w+)/.exec(said(c))?.[1] ?? "chat");

type Script = Reply | ((c: ChatRequest) => Reply | Promise<Reply>);

/**
 * Li with a local model and a project. The fake model answers each thread
 * from its own script, by the first word of its task ("chat" for the
 * project chat), so turns can run at once.
 */
async function setup(opts: Parameters<typeof daemon>[1] = {}) {
  const rt = await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const li = await login(dm.base, "li", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(li, rt.li.id, model.baseUrl);
  const scripts = new Map<string, Script[]>();
  const script = (name: string) => { if (!scripts.has(name)) scripts.set(name, []); return scripts.get(name)!; };
  const requests: ChatRequest[] = [];
  model.respond(async (c) => {
    requests.push(c);
    const next = script(who(c)).shift() ?? { text: `${who(c)} idle` };
    return typeof next === "function" ? next(c) : next;
  });
  const u = `/api/u/${rt.li.id}`;
  const project = (await li.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Homelab", project: true, goal: "Move the homelab to the new rack" })).body;
  const path = `${u}/threads/general/${enc(project.id)}`;
  const stream = li.events(`${path}/events`);
  await stream.ready;
  const say = async (text: string, at = path) => {
    const from = stream.events.length;
    const res = await li.post(`${at}/messages`, { text });
    if (at === path) await stream.until((e) => e.type === "turn_end", from);
    return { res, events: stream.events.slice(from).map((e) => e.event) };
  };
  const threadPath = (id: string) => `${u}/threads/general/${enc(id)}`;
  const messages = async (p: string) => (await li.get<MessagePage>(`${p}/messages`)).body.messages;
  const overview = async () => (await li.get<ProjectOverview>(`${path}/overview`)).body;
  const get = async (id: string) => (await li.get<ThreadSummary>(threadPath(id))).body;
  return { rt, ...dm, li, model, script, requests, u, project, path, stream, say, threadPath, messages, overview, get };
}

const start = (...threads: [string, string][]): Reply => ({ tools: threads.map(([title, task]) => ({ name: "threads", args: { action: "start", title, task } })) });
const tool = (args: object): Reply => ({ tools: [{ name: "threads", args }] });
const ends = (events: ThreadEvent[]) => events.filter((e) => e.type === "tool_end") as Extract<ThreadEvent, { type: "tool_end" }>[];

async function until<T>(fn: () => Promise<T>, ok: (t: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await fn();
    if (ok(t)) return t;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(t).slice(0, 4000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("projects", () => {
  it("start pinned, filter in the thread list, and can't be undone", async () => {
    const { li, u, project, path } = await setup();
    expect(project).toMatchObject({ project: true, goal: "Move the homelab to the new rack", pinned: true, projectSettings: { paused: false } });
    const plain = (await li.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Taxes" })).body;
    expect(plain.pinned).toBe(false);
    const ids = async () => (await li.get<ThreadSummary[]>(`${u}/threads`)).body.map((t) => t.id);
    // Pinned threads come first, whatever was active last.
    expect(await ids()).toEqual([project.id, plain.id]);
    await li.patch(`${u}/me/display`, { projects: "only" });
    expect(await ids()).toEqual([project.id]);
    await li.patch(`${u}/me/display`, { projects: "none" });
    expect(await ids()).toEqual([plain.id]);
    await li.patch(`${u}/me/display`, { projects: "all" });

    // Make project on a thread: pinned, and no way back.
    const made = (await li.patch<ThreadSummary>(`${u}/threads/general/${enc(plain.id)}`, { project: true })).body;
    expect(made).toMatchObject({ project: true, pinned: true });
    expect((await li.patch(`${u}/threads/general/${enc(plain.id)}`, { project: false })).status).toBe(400);
    expect((await li.del(`${u}/threads/general/${enc(plain.id)}/pin`)).status).toBe(200);
    expect((await li.get<ThreadSummary>(`${u}/threads/general/${enc(plain.id)}`)).body.pinned).toBe(false);
    expect((await li.patch<ThreadSummary>(path, { goal: "Rack by Friday" })).body.goal).toBe("Rack by Friday");
    expect((await li.patch<ThreadSummary>(path, { instructions: "Ask before buying anything." })).body.instructions).toBe("Ask before buying anything.");
    // The project page, where the instructions are kept, opens by the ID the summary gives.
    expect((await li.get(`${u}/memory/general/${enc(project.projectSettings!.pageId)}`)).status).toBe(200);
    expect((await li.patch(path, { instructions: "x".repeat(2001) })).status).toBe(400);
  });

  it("start new threads with the project's Fallback, which each thread can change", async () => {
    const { li, u, path, script, say, threadPath } = await setup();
    expect((await li.patch<ThreadSummary>(path, { threadsFallback: false })).body.projectSettings).toMatchObject({ threadsFallback: false });
    // The project chat's own Dictation pick was consent for that thread only: a new thread starts without it.
    const stt = (await li.get<EndpointInfo[]>(`${u}/endpoints`)).body[0]!.models[0]!.id;
    expect((await li.patch(`${u}/offerings/${stt}`, { transcribe: true })).status).toBe(200);
    expect((await li.patch<ThreadSettings>(`${path}/settings`, { models: { "speech.transcribe": { offeringId: stt } } })).body.models["speech.transcribe"]).toMatchObject({ source: "thread" });
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    const { events } = await say("move DNS");
    const dns = ends(events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    expect((await li.get<ThreadSettings>(`${threadPath(dns)}/settings`)).body).toMatchObject({ fallback: false, fallbackOn: false });
    expect((await li.get<ThreadSettings>(`${threadPath(dns)}/settings`)).body.models["speech.transcribe"].source).not.toBe("thread");
    expect((await li.patch<ThreadSettings>(`${threadPath(dns)}/settings`, { fallback: null })).body).toMatchObject({ fallback: null, fallbackOn: true });
    expect((await li.patch(`${threadPath(dns)}/settings`, { fallback: "off" })).status).toBe(400);
    // Cleared, new threads follow the project chat's again.
    expect((await li.patch<ThreadSummary>(path, { threadsFallback: null })).body.projectSettings?.threadsFallback).toBeUndefined();
    // The defaults: new threads, and sleep's phases.
    expect((await li.patch<Profiles>(`${u}/profiles`, { fallback: false, sleepFallback: false })).body).toMatchObject({ fallback: false, sleepFallback: false });
    expect((await li.get<ThreadSettings>(`${path}/settings`)).body).toMatchObject({ fallback: null, fallbackOn: false });
  });

  it("queue a start past the limit, and run it when a slot frees", async () => {
    const { script, say, overview, get, messages, threadPath } = await setup({ threads: { concurrency: 1 } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script("chat").push(start(["DNS", "dns: move DNS to the router"], ["Backups", "backups: copy the backups"]), { text: "Started two." });
    script("dns").push(async () => { await gate; return { text: "DNS moved." }; });
    script("backups").push({ text: "Backups copied." });
    const { events } = await say("move DNS and copy the backups");
    // The queued one answers at once, so it may end first.
    const dns = ends(events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    const backups = ends(events).find((e) => e.result.startsWith("Queued"))!.threads![0]!.id;
    expect((await get(dns!)).state).toBe("working");
    expect((await get(backups!)).state).toBe("queued");
    // Both hang off the message that started them.
    expect((await overview()).threads.map((t) => t.anchor)).toEqual([1, 1]);
    release();
    await until(() => messages(threadPath(backups!)), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("Backups copied")));
  });

  it("start nothing queued while a project is hidden", async () => {
    const { li, path, script, say, get, messages, threadPath } = await setup({ threads: { concurrency: 1 } });
    script("chat").push(start(["DNS", "dns: move DNS"], ["Backups", "backups: copy the backups"]), { text: "Started two." });
    script("dns").push(async () => { await new Promise(() => {}); return { text: "never" }; });
    script("backups").push({ text: "Backups copied." });
    const { events } = await say("move DNS and copy the backups");
    const dns = ends(events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    const backups = ends(events).find((e) => e.result.startsWith("Queued"))!.threads![0]!.id;
    await until(() => get(dns), (t) => t.state === "working");
    // Hiding stops the working thread; the freed slot doesn't start the queued one.
    expect((await li.patch(path, { hidden: true })).status).toBe(200);
    await until(() => get(dns), (t) => t.state !== "working");
    await new Promise((r) => setTimeout(r, 200));
    expect((await get(backups)).state).toBe("queued");
    expect((await messages(threadPath(backups))).some((m) => m.role === "assistant")).toBe(false);
    expect((await li.post(`${threadPath(dns)}/messages`, { text: "hello?" })).status).toBe(409);
  });

  it("watch its threads: a look is one call to the Watching model that tells the thread it affects, with no turn of the project chat", async () => {
    const { li, u, project, path, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    const looks = async () => (await messages(path)).filter((m) => m.from?.kind === "watching");
    const asked = () => requests.filter((c) => who(c) === "watching");
    const chatTurns = () => requests.filter((c) => who(c) === "chat" && !!c.tools?.length).length;
    script("chat").push(start(["DNS", "dns: move DNS to the router"], ["Backups", "backups: copy the backups"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    script("backups").push({ text: "Copying." });
    const { events } = await say("move DNS and copy the backups");
    const ids = ends(events).flatMap((e) => e.threads ?? []).map((t) => t.id);
    const titles = await Promise.all(ids.map(async (id) => [(await li.get<ThreadSummary>(threadPath(id))).body.title, id] as const));
    const [dns, backups] = ["DNS", "Backups"].map((t) => titles.find(([title]) => title === t)![1]);
    await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant"));
    await until(() => messages(threadPath(backups!)), (m) => m.some((x) => x.role === "assistant"));
    const turnsBefore = chatTurns();

    // Li writes in DNS: one call to the Watching model, which sees both sides, and tells Backups.
    script("dns").push({ text: "Using 10.0.0.53 then." });
    script("watching").push({ text: JSON.stringify({ tell: [{ thread: backups, text: "DNS is 10.0.0.53 now; point the NAS at it." }, { thread: project.id, text: "never the chat" }] }) });
    script("backups").push({ text: "Pointed." });
    expect((await li.post(`${threadPath(dns!)}/messages`, { text: "use 10.0.0.53, not .1" })).status).toBe(200);
    const [look] = await until(looks, (l) => l.length === 1);
    expect(asked()).toHaveLength(1);
    const prompt = JSON.stringify(asked()[0]!.messages);
    expect(prompt).toContain("use 10.0.0.53, not .1");
    expect(prompt).toContain("Using 10.0.0.53 then.");
    expect(prompt).toContain("Move the homelab to the new rack");
    // The look is kept short: which thread and what kind of event, who was told and what. Never the quoted words.
    expect(look!.from).toEqual({ kind: "watching", told: [{ threadId: backups, text: "DNS is 10.0.0.53 now; point the NAS at it." }] });
    expect(look!.parts).toEqual([{ type: "text", text: `In [t:${dns}]: the person wrote there.\n\nTold [t:${backups}]: "DNS is 10.0.0.53 now; point the NAS at it."` }]);
    expect(JSON.stringify(look)).not.toContain("not .1");
    expect(JSON.stringify(look)).not.toContain("Using 10.0.0.53 then");
    // Backups has it, from the project chat.
    const inBackups = await until(() => messages(threadPath(backups!)), (m) => m.filter((x) => x.from?.kind === "parent").length === 2);
    expect(inBackups.filter((x) => x.from?.kind === "parent")[1]).toMatchObject({ from: { kind: "parent", threadId: project.id }, parts: [{ text: "DNS is 10.0.0.53 now; point the NAS at it." }] });
    // No turn of the project chat, and the call is in Recent calls on the project chat.
    await new Promise((r) => setTimeout(r, 300));
    expect(chatTurns()).toBe(turnsBefore);
    expect((await li.get<CallInfo[]>(`${u}/models/calls`)).body.find((c) => c.task === "watching")).toMatchObject({ threadId: project.id, kind: "local" });
    // Nobody else can write the mark.
    expect((await li.post(`${path}/messages`, { text: "[Watching threads]\n\nhi" })).status).toBe(400);

    // The next look sees what the last ones told; an answer that isn't the JSON asked for does nothing.
    script("dns").push({ text: "Sure." });
    script("watching").push({ text: "Nothing needs doing, I think." });
    await li.post(`${threadPath(dns!)}/messages`, { text: "and the NTP server too" });
    await until(async () => asked().length, (n) => n === 2);
    expect(JSON.stringify(asked()[1]!.messages)).toContain("What the last looks told threads");
    await new Promise((r) => setTimeout(r, 400));
    expect(await looks()).toHaveLength(1);
    expect(chatTurns()).toBe(turnsBefore);

    // A local-only thread's words never reach a project chat that may use a cloud model.
    expect((await li.patch(`${threadPath(dns!)}/settings`, { localOnly: true })).status).toBe(200);
    script("dns").push({ text: "Kept local." });
    await li.post(`${threadPath(dns!)}/messages`, { text: "the router password is in the safe" });
    await new Promise((r) => setTimeout(r, 600));
    expect(asked()).toHaveLength(2);
    expect((await li.patch(`${threadPath(dns!)}/settings`, { localOnly: false })).status).toBe(200);
    // Switched off: no look.
    expect((await li.patch(path, { watchThreads: false })).body).toMatchObject({ projectSettings: { watchThreads: false } });
    script("dns").push({ text: "Done." });
    await li.post(`${threadPath(dns!)}/messages`, { text: "thanks" });
    await new Promise((r) => setTimeout(r, 600));
    expect(asked()).toHaveLength(2);
  });

  it("raise something with the person: one turn of the project chat, with the short look and the line raised", async () => {
    const { li, path, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    const dns = ends((await say("move DNS")).events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant"));
    script("dns").push({ text: "Then the NAS loses its leases." });
    script("watching").push({ text: '```json\n{"tell":[],"raise":"Moving DNS to the router breaks the NAS leases: which first?"}\n```' });
    script("chat").push({ text: "Li, which first: the router or the NAS?" });
    await li.post(`${threadPath(dns)}/messages`, { text: "move it to the router tonight" });
    const raised = await until(() => messages(path), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("which first: the router")));
    const look = raised.filter((m) => m.from?.kind === "watching");
    expect(look).toHaveLength(1);
    expect(look[0]!.from).toEqual({ kind: "watching", told: [] });
    expect(look[0]!.parts[0]).toEqual({ type: "text", text: `In [t:${dns}]: the person wrote there.\n\nTold no thread.\nRaised: "Moving DNS to the router breaks the NAS leases: which first?"` });
    // Her turn saw the marked look and the line raised; the quotes went only to the Watching model.
    const turn = requests.filter((c) => who(c) === "chat").at(-1)!;
    expect(JSON.stringify(turn.messages)).toContain("[Watching threads]");
    expect(JSON.stringify(turn.messages)).toContain("breaks the NAS leases");
    expect(JSON.stringify(look)).not.toContain("tonight");
  });

  it("look on a failure and on a waiting approval, even after a run of 3 looks", async () => {
    const { li, path, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100, permissionMs: 10_000 });
    const looks = async () => (await messages(path)).filter((m) => m.from?.kind === "watching");
    const asked = () => requests.filter((c) => who(c) === "watching");
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    const dns = ends((await say("move DNS")).events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant"));
    await li.patch(`${threadPath(dns)}/settings`, { mode: "acceptEdits" });
    // The look and the thread keep each other going: each look tells DNS, and DNS posts an update.
    const ask = { text: JSON.stringify({ tell: [{ thread: dns, text: "anything new?" }] }) };
    for (let i = 0; i < 5; i++) script("watching").push(ask);
    const later = async (): Promise<Reply> => { await new Promise((r) => setTimeout(r, 200)); return tool({ action: "message", to: "parent", text: "Still fine." }); };
    script("dns").push({ text: "Noted." }, later, { text: "Posted." }, later, { text: "Posted." });
    // The third tell fails; the fourth waits for an approval.
    script("dns").push({ status: 400 }, { tools: [{ name: "bash", args: { command: "true" } }] }, { text: "Done." }, later, { text: "Posted." });
    const stream = li.events(`${threadPath(dns)}/events`);
    await stream.ready;
    await li.post(`${threadPath(dns)}/messages`, { text: "check again" });
    // Three looks from the person's message and two updates; the failure brings a fourth past the run of 3.
    await until(async () => asked().length, (n) => n === 4, 15000);
    expect(JSON.stringify(asked()[3]!.messages)).toContain("It stopped with an error.");
    await stream.until((e) => e.type === "permission");
    await until(async () => asked().length, (n) => n === 5, 15000);
    expect(JSON.stringify(asked()[4]!.messages)).toContain("It is waiting for an approval.");
    const request = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string };
    await li.post(`${threadPath(dns)}/permissions/${request.requestId}`, { allow: false });
    const all = await until(looks, (l) => l.length === 5);
    expect(all.map((l) => (l.parts[0] as { text: string }).text.split("\n")[0])).toEqual([
      `In [t:${dns}]: the person wrote there.`, `In [t:${dns}]: it posted an update.`, `In [t:${dns}]: it posted an update.`,
      `In [t:${dns}]: it stopped with an error.`, `In [t:${dns}]: it is waiting for an approval.`,
    ]);
    // The last look's line reached DNS, whose update comes past the run of 3: no look for it.
    await until(() => messages(path), (m) => m.filter((x) => x.role === "notice").length >= 3);
    await new Promise((r) => setTimeout(r, 600));
    expect(asked()).toHaveLength(5);
    stream.close();
  });

  it("keep a private project's looks on local models", async () => {
    const { li, u, script, requests } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    // Watching on a cloud model in the custom profile, which general projects use.
    const cloud = await fakeOpenAI({ label: "cloud", models: [{ id: "deepseek" }] });
    const deepseek = { offeringId: (await li.post<EndpointInfo>(`${u}/endpoints`, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl })).body.models[0]!.id };
    expect((await li.put(`${u}/profiles/custom/watching`, { model: deepseek })).status).toBe(200);
    const asked = () => requests.filter((c) => who(c) === "watching");
    const watchIn = async (pool: "general" | "private") => {
      const project = (await li.post<ThreadSummary>(`${u}/threads`, { pool, title: "Garden", project: true, goal: "Plant the beds" })).body;
      const at = `${u}/threads/${pool}/${enc(project.id)}`;
      const stream = li.events(`${at}/events`);
      await stream.ready;
      script("chat").push(start(["Beds", "beds: dig the beds"]), { text: "Started." });
      script("beds").push({ text: "Dug." });
      await li.post(`${at}/messages`, { text: "dig the beds" });
      await stream.until((e) => e.type === "turn_end");
      stream.close();
      const beds = (await li.get<ProjectOverview>(`${at}/overview`)).body.threads[0]!.id;
      const bedsAt = `${u}/threads/${pool}/${enc(beds)}`;
      await until(async () => (await li.get<MessagePage>(`${bedsAt}/messages`)).body.messages, (m) => m.some((x) => x.role === "assistant"));
      script("beds").push({ text: "Roses then." });
      await li.post(`${bedsAt}/messages`, { text: "roses in the south bed" });
    };
    // A general project's look goes to the cloud model it was given.
    await watchIn("general");
    await until(async () => cloud.requests.length, (n) => n === 1);
    // A private project's look resolves through its own context: the local profile, local models only.
    script("watching").push({ text: '{"tell":[]}' });
    await watchIn("private");
    await until(async () => asked().length, (n) => n === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(cloud.requests).toHaveLength(1);
    expect(JSON.stringify(asked()[0]!.messages)).toContain("roses in the south bed");
    expect((await li.get<CallInfo[]>(`${u}/models/calls`)).body.filter((c) => c.task === "watching").map((c) => [c.pool, c.kind])).toEqual([["private", "local"], ["general", "cloud"]]);
  });

  it("let a project's threads message each other, at most 3 a turn, and never a thread outside", async () => {
    const { li, u, script, say, messages, threadPath } = await setup({ threads: { concurrency: 5 } });
    script("chat").push(start(["DNS", "dns: move DNS"], ["Backups", "backups: copy backups"]), { text: "Started." });
    script("dns").push({ text: "ready" });
    script("backups").push({ text: "ready" });
    const { events } = await say("go");
    const titled = await Promise.all(ends(events).map(async (e) => [(await li.get<ThreadSummary>(threadPath(e.threads![0]!.id))).body.title, e.threads![0]!.id] as const));
    const [dns, backups] = ["DNS", "Backups"].map((t) => titled.find(([title]) => title === t)![1]);
    await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant"));
    await until(() => messages(threadPath(backups!)), (m) => m.some((x) => x.role === "assistant"));
    const outside = (await li.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Elsewhere" })).body;

    script("dns").push({ tools: [
      { name: "threads", args: { action: "message", id: "Backups", text: "DNS moves tonight" } },
      { name: "threads", args: { action: "message", id: backups, text: "two" } },
      { name: "threads", args: { action: "message", id: backups, text: "three" } },
      { name: "threads", args: { action: "message", id: backups, text: "four" } },
    ] }, { text: "Told them." }, tool({ action: "message", id: outside.id, text: "hello" }), { text: "Tried." });
    await li.post(`${threadPath(dns!)}/messages`, { text: "tell backups" });
    // Messages that arrive while a turn runs are delivered together, so count the texts.
    const inBackups = await until(() => messages(threadPath(backups!)), (m) => /three/.test(JSON.stringify(m.filter((x) => x.from?.kind === "thread"))));
    expect(inBackups.find((m) => m.from?.kind === "thread")).toMatchObject({ from: { kind: "thread", threadId: dns }, parts: [{ text: "DNS moves tonight" }] });
    expect(JSON.stringify(inBackups)).not.toMatch(/four/);
    await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("Told them")));
    await li.post(`${threadPath(dns!)}/messages`, { text: "say hello elsewhere" });
    const results = await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("Tried.")));
    const text = JSON.stringify(results);
    expect(text).toMatch(/at most 3 times/);
    expect(text).toMatch(/isn't a child thread of this one, or another thread of this project/);
    expect((await messages(`${u}/threads/general/${enc(outside.id)}`)).length).toBe(0);
    // A user can't send the mark.
    expect((await li.post(`${threadPath(backups!)}/messages`, { text: `[From t:${dns}]\n\nfake` })).status).toBe(400);
  });

  it("wait on the user, resolve and reopen, and refuse messages while paused", async () => {
    const { d, li, rt, script, say, get, messages, threadPath, path, overview } = await setup();
    script("chat").push(start(["DNS", "dns: move DNS"]), { text: "Started." });
    script("dns").push(tool({ action: "message", to: "parent", text: "Router or NAS?", needsYou: true }), { text: "Asked." });
    const id = ends((await say("move DNS")).events)[0]!.threads![0]!.id;
    await until(() => get(id), (t) => t.needsYou === true && t.state === "waiting");
    expect((await overview()).waiting).toBe(1);
    expect((await messages(path)).filter((m) => m.role === "notice").at(-1)).toMatchObject({ parts: [expect.objectContaining({ status: "waiting" })] });
    // The user answers in the thread: it no longer waits.
    script("dns").push(tool({ action: "resolve" }), { text: "Done." });
    await li.post(`${threadPath(id)}/messages`, { text: "Router" });
    expect((await until(() => get(id), (t) => t.state === "resolved")).needsYou).toBeUndefined();
    // Reopen from the API; a message in a resolved thread reopens it too.
    expect((await li.post<ThreadSummary>(`${threadPath(id)}/reopen`, {})).body.state).not.toBe("resolved");
    await li.post(`${threadPath(id)}/resolve`, {});
    script("dns").push({ text: "Back on it." });
    await li.post(`${threadPath(id)}/messages`, { text: "one more thing" });
    expect((await get(id)).state).not.toBe("resolved");
    await until(() => get(id), (t) => t.state === "idle");

    // The nightly tick resolves threads idle for 7 days.
    expect(d.services!.children.autoResolve(rt.li.id, new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect((await get(id)).state).toBe("resolved");

    // Paused: no messages, no starts.
    expect((await li.patch<ThreadSummary>(path, { paused: true })).body.projectSettings?.paused).toBe(true);
    expect((await li.post(`${threadPath(id)}/messages`, { text: "hello?" })).status).toBe(409);
    script("chat").push(start(["More", "more: more work"]), { text: "Tried." });
    const tried = ends((await say("start more")).events)[0]!;
    expect(tried).toMatchObject({ isError: true, result: expect.stringMatching(/paused/) });
  });

  it("suggest threads on a card, and start them from it once each", async () => {
    const { li, script, say, path, overview } = await setup();
    script("chat").push(tool({ action: "suggest", threads: [{ title: "DNS", task: "dns: move DNS" }, { title: "Backups", task: "backups: copy backups" }] }), { text: "Shall I?" });
    const end = ends((await say("propose first")).events)[0]!;
    expect(end).toMatchObject({ isError: false, result: expect.stringMatching(/Suggested 2 threads/) });
    expect((await overview()).threads).toEqual([]);
    const one = (await li.post<ThreadSummary[]>(`${path}/suggestions/${end.toolCallId}/start`, { index: 1 })).body;
    expect(one.map((t) => t.title)).toEqual(["Backups"]);
    const rest = (await li.post<ThreadSummary[]>(`${path}/suggestions/${end.toolCallId}/start`, {})).body;
    expect(rest.map((t) => t.title)).toEqual(["DNS"]);
    expect(Object.keys((await overview()).started).sort()).toEqual([`${end.toolCallId}#0`, `${end.toolCallId}#1`]);
    expect((await li.post<ThreadSummary[]>(`${path}/suggestions/${end.toolCallId}/start`, {})).body).toEqual([]);
  });

  it("keep anchors through a rewind of later turns, and branches inside the project", async () => {
    const { li, script, say, get, path, threadPath, messages, overview } = await setup();
    script("chat").push({ text: "Noted." });
    await say("first, just a note");
    script("chat").push(start(["DNS", "dns: move DNS"]), { text: "Started." });
    const id = ends((await say("move DNS")).events)[0]!.threads![0]!.id;
    // It hangs off the turn that started it: the card goes under the first message at or after its anchor.
    const chat = await messages(path);
    const asked = chat.find((m) => m.role === "user" && JSON.stringify(m).includes("move DNS"))!;
    const before = chat.filter((m) => m.n < asked.n).at(-1)!;
    const anchor = (await get(id)).anchor!;
    expect(anchor > before.n && anchor <= asked.n).toBe(true);
    // Start a thread from the first message.
    const first = chat.find((m) => m.role === "user")!.n;
    const started = (await li.post<ThreadSummary>(`${path}/messages/${first}/thread`, { title: "From the note" })).body;
    expect(started).toMatchObject({ child: true, parent: (await get(id)).parent, anchor: first, title: "From the note" });
    // A branch of a project's thread is a thread of the project, hanging where its source does.
    await until(() => messages(threadPath(id)), (m) => m.some((x) => x.role === "assistant"));
    const branch = (await li.post<ThreadSummary>(`${threadPath(id)}/messages/1/branch`, {})).body;
    expect(branch).toMatchObject({ child: true, anchor });
    expect((await overview()).threads.map((t) => t.id)).toEqual(expect.arrayContaining([id, started.id, branch.id]));
    // Rewinding the turn that started DNS leaves DNS, unanchored; the thread from message 1 keeps its anchor.
    expect((await li.post(`${path}/messages/${asked.n}/rewind`, { action: "delete" })).status).toBe(200);
    expect((await get(id)).anchor).toBeUndefined();
    expect((await get(started.id)).anchor).toBe(first);
  });

  it("carry a note from one thread into the next thread's project section, and forget it all with the project", async () => {
    const { li, d, rt, script, say, requests, path, threadPath, messages, logs } = await setup();
    script("chat").push(start(["DNS", "dns: move DNS"]), { text: "Started." });
    script("dns").push({ tools: [{ name: "remember", args: { notes: [{ text: "The router serves DNS now (MARKER-7)" }] } }] }, { text: "Saved." });
    const dns = ends((await say("move DNS")).events)[0]!.threads![0]!.id;
    await until(() => messages(threadPath(dns)), (m) => JSON.stringify(m).includes("Saved."));
    script("chat").push(start(["Backups", "backups: copy backups"]), { text: "Started." });
    script("backups").push({ text: "On it." });
    const backups = ends((await say("now the backups")).events)[0]!.threads![0]!.id;
    await until(() => messages(threadPath(backups)), (m) => m.some((x) => x.role === "assistant"));
    const seen = requests.filter((c) => who(c) === "backups").map(said).join("");
    expect(seen).toContain("MARKER-7");
    expect(seen).toContain("Move the homelab to the new rack");
    // The project chat sees its threads in its section.
    script("chat").push({ text: "ok" });
    await say("status?");
    expect(said(requests.at(-1)!)).toMatch(/Its threads:[^]*DNS/);

    const view = d.services!.memory.openThreadView(rt.li.id, "general");
    const note = view.own.projectNotes(dns)[0]!.id;
    view.close();
    expect((await li.del(`${path}?children=1`, {})).status).toBe(200);
    const after = d.services!.memory.openThreadView(rt.li.id, "general");
    expect([after.own.get(note), after.own.getThread(dns), after.own.getThread(backups)]).toEqual([undefined, undefined, undefined]);
    after.close();
    expect(logs.join("\n")).not.toMatch(/MARKER-7|move DNS|copy backups/);
  });
});
