import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedThread } from "../src/hosted.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeOpenAI, type ChatRequest, type Reply } from "../../core/test/fake-openai.ts";
import type { CallInfo, EndpointInfo, MessagePage, Presets, ProjectOverview, ThreadEvent, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const welcomeFolders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const folder of welcomeFolders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

// Projects: a project chat whose child threads are the project's threads.

const said = (c: ChatRequest) => JSON.stringify(c.messages);
/** Which thread a request is from: its first user message's text says so in these tests. */
const who = (c: ChatRequest) => (JSON.stringify(c.messages[0]?.content ?? "").includes("Reply with JSON only") ? "watching"
  : /\[From t:[^\]]+\]\\n\\n(\w+)/.exec(said(c))?.[1] ?? "chat");

type Script = Reply | ((c: ChatRequest) => Reply | Promise<Reply>);

/**
 * Ada with a local model and a project. The fake model answers each thread
 * from its own script, by the first word of its task ("chat" for the
 * project chat), so turns can run at once.
 */
async function setup(opts: Parameters<typeof daemon>[1] = {}) {
  const rt = await runtime();
  const dm = await daemon(rt, opts);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  // Served at 1M, so the project's threads may share it four at a time (docs/models.md, Local servers).
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b", meta: { n_ctx: 1_048_576 } }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const scripts = new Map<string, Script[]>();
  const script = (name: string) => { if (!scripts.has(name)) scripts.set(name, []); return scripts.get(name)!; };
  const requests: ChatRequest[] = [];
  model.respond(async (c) => {
    requests.push(c);
    const next = script(who(c)).shift() ?? { text: `${who(c)} idle` };
    return typeof next === "function" ? next(c) : next;
  });
  const u = `/api/u/${rt.ada.id}`;
  const project = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Homelab", project: true, goal: "Move the homelab to the new rack" })).body;
  const path = `${u}/threads/general/${enc(project.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  const say = async (text: string, at = path) => {
    const from = stream.events.length;
    const res = await ada.post(`${at}/messages`, { text });
    if (at === path) await stream.until((e) => e.type === "turn_end", from);
    return { res, events: stream.events.slice(from).map((e) => e.event) };
  };
  const threadPath = (id: string) => `${u}/threads/general/${enc(id)}`;
  const messages = async (p: string) => (await ada.get<MessagePage>(`${p}/messages`)).body.messages;
  const overview = async () => (await ada.get<ProjectOverview>(`${path}/overview`)).body;
  const get = async (id: string) => (await ada.get<ThreadSummary>(threadPath(id))).body;
  return { rt, ...dm, ada, model, script, requests, u, project, path, stream, say, threadPath, messages, overview, get };
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
  it("applies code mode through settings and threads code on the next turn, preserving Mode", async () => {
    const s = await setup();
    const settings = () => s.ada.get<ThreadSettings>(`${s.path}/settings`);
    expect((await settings()).body.code).toBe(false);
    await s.ada.patch(`${s.path}/settings`, { mode: "ask" });
    s.script("chat").push(tool({ action: "code", on: true, task: "Fix addition", done: "Read the failure" }), { text: "Enabled." });
    await s.say("Use code mode");
    expect((await settings()).body).toMatchObject({ code: true, mode: "ask" });
    s.script("chat").push({ text: "Checked." });
    await s.say("Check the fixture");
    const request = s.requests.filter(c => c.tools?.length).at(-1)!;
    expect(said(request)).toContain("Code task");
    expect(said(request)).toContain("Fix addition");
    expect(request.tools!.map(t => t.function.name)).not.toContain("react");
    expect(s.d.services!.models.recentCalls(s.rt.ada.id, { threadId: s.project.id, limit: 10 }).filter(c => c.task === "code")).toHaveLength(1);
    await s.ada.patch(`${s.path}/settings`, { code: false });
    expect((await settings()).body).toMatchObject({ code: false, mode: "ask" });
    s.script("chat").push({ text: "Restored." });
    await s.say("Continue normally");
    const restored = s.requests.filter(c => c.tools?.length).at(-1)!;
    expect(said(restored)).not.toContain("<code_task>");
    expect(restored.tools!.map(t => t.function.name)).toContain("react");
  });

  it("switches her own model when asked, and Thread settings and the model pill follow at once", async () => {
    const s = await setup();
    const other = await fakeOpenAI({ label: "box", models: [{ id: "gemma-5-12b" }] });
    const onGemma: Reply[] = [{ text: "Going on." }, tool({ action: "model", model: "gemma" }), { text: "Still gemma." }];
    other.respond(() => onGemma.shift() ?? { text: "From gemma." });
    expect((await s.ada.post(`${s.u}/endpoints`, { name: "box", kind: "local", baseUrl: other.baseUrl })).status).toBe(200);
    const settings = async () => (await s.ada.get<ThreadSettings>(`${s.path}/settings`)).body;
    s.script("chat").push(tool({ action: "model", model: "llama" }), tool({ action: "model", model: "gemma" }), { text: "Switched." });
    const { events } = await s.say("Use gemma from now on");
    const [vague, switched] = ends(events);
    expect(vague!.isError).toBe(true);
    expect(JSON.stringify(vague)).toContain("Ask the person");
    expect(JSON.stringify(switched)).toContain("box/gemma-5-12b");
    expect(events.some((e) => e.type === "settings")).toBe(true);
    expect((await settings()).models.chat).toMatchObject({ label: "box/gemma-5-12b", source: "thread" });
    // The turn that asked finished on the old model; the next starts by itself on gemma.
    await expect.poll(() => other.requests.length).toBe(1);
    expect(said(other.requests[0]!)).toContain("You now run on box/gemma-5-12b");
    await expect.poll(() => s.d.services!.host.busy(s.rt.ada.id, "general", s.project.id)).toBe(false);
    // The model it already runs on: nothing changes, and no turn follows.
    const again = ends((await s.say("Use gemma")).events);
    expect(JSON.stringify(again)).toContain("already runs on box/gemma-5-12b");
    await new Promise((r) => setTimeout(r, 300));
    expect(other.requests).toHaveLength(3);
  });

  it("uses the project code default for new and routine threads while children keep independent choices", async () => {
    const s = await setup();
    expect((await s.ada.patch(s.path, { threadsCode: true })).status).toBe(200);
    expect((await s.get(s.project.id)).projectSettings?.threadsCode).toBe(true);
    s.script("chat").push(start(["Fixture", "fixture: fix addition"]), { text: "Started." });
    const { events } = await s.say("Fix the fixture");
    const child = ends(events).flatMap(e => e.threads ?? [])[0]!.id;
    await until(() => s.messages(s.threadPath(child)), rows => rows.some(m => m.role === "assistant"));
    const settings = () => s.ada.get<ThreadSettings>(`${s.threadPath(child)}/settings`);
    expect((await settings()).body.code).toBe(true);
    await s.ada.patch(`${s.threadPath(child)}/settings`, { code: false });
    expect((await settings()).body.code).toBe(false);
    const made = await s.d.services!.children.routineThread(s.rt.ada.id, "general", s.project.id, "Routine fixture");
    expect(s.d.services!.workspace.settings(s.rt.ada.id).thread(made).code).toBe(true);
    await s.ada.patch(s.path, { threadsCode: false });
    const next = await s.d.services!.children.routineThread(s.rt.ada.id, "general", s.project.id, "Next fixture");
    expect(s.d.services!.workspace.settings(s.rt.ada.id).thread(next).code).toBe(false);
  });

  it("starts a child in code mode, with the Coding model and its task as the Code task, when she asks", async () => {
    const s = await setup();
    s.script("chat").push({ tools: [{ name: "threads", args: { action: "start", title: "Racing sim", task: "Build the racing sim in the repository", code: true } }] }, { text: "Started." });
    const { events } = await s.say("Build a racing sim");
    const child = ends(events).flatMap(e => e.threads ?? [])[0]!.id;
    await until(() => s.messages(s.threadPath(child)), rows => rows.some(m => m.role === "assistant"));
    expect((await s.ada.get<ThreadSettings>(`${s.threadPath(child)}/settings`)).body.code).toBe(true);
    const first = s.requests.find(c => said(c).includes("Build the racing sim in the repository") && said(c).includes("Code task"));
    expect(first).toBeDefined();
    // Its check output stays out of the repository (a project code thread once committed its screenshot).
    expect(said(first!)).toContain("check output in your scratch folder (/workspace, outside worktrees/), never in a repository");
    expect(said(first!)).toContain("run git status in each repository or worktree you changed");
    expect(s.d.services!.models.recentCalls(s.rt.ada.id, { threadId: child, limit: 10 }).some(c => c.task === "code")).toBe(true);
  });

  it("folds work and its children without losing checklists, wake-ups or child state", async () => {
    const { ada, d, rt, u, project, path, threadPath, overview } = await setup();
    const view = d.services!.memory.openThreadView(rt.ada.id, "general");
    const source = view.own.createThread({ interface: "web", title: "Seed trays" });
    const child = view.own.createThread({ interface: "web", parent: source.id, child: true, title: "Watering" });
    const steps = [{ text: "Sow seeds", state: "doing" as const }];
    view.own.setSteps(source.id, steps);
    const due = new Date(Date.now() + 3600_000).toISOString();
    view.own.addWakeup(child.id, due, "Check soil");
    view.close();
    d.services!.wakeups.load(rt.ada.id);
    d.services!.children.adopt(rt.ada.id, "general", child.id, source.id, undefined);
    const db = d.services!.users.openUserDb(rt.ada.id);
    db.prepare("UPDATE child_threads SET needs_you = 1, resolved_at = ? WHERE thread = ?").run("2026-10-12T00:00:00Z", child.id);
    db.close();
    const ws = d.services!.workspace.settings(rt.ada.id);
    ws.setThread(project.id, "general", { internet: false, services: false, hosts: [] });
    ws.setThread(source.id, "general", { internet: true, services: true, hosts: ["127.0.0.1"] });
    const folded = await ada.post<ThreadSummary>(`${path}/fold`, { threadId: source.id });
    expect(folded.status).toBe(200);
    expect(ws.network(source.id, "general")).toEqual({ internet: false, services: false, hosts: [] });
    expect(folded.body).toMatchObject({ id: source.id, parent: project.id, child: true, steps });
    const moved = (await ada.get<ThreadSummary>(threadPath(child.id))).body;
    expect(moved).toMatchObject({ parent: project.id, child: true, needsYou: true, state: "resolved", wakeAt: due });
    expect((await overview()).threads.map(t => t.id)).toEqual(expect.arrayContaining([source.id, child.id]));
    expect((await ada.post(`${path}/fold`, { threadId: child.id })).status).toBe(400);
    expect((await ada.post(`${path}/fold`, { threadId: project.id })).status).toBe(400);
    const privateThread = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "private", title: "Private work" })).body;
    expect((await ada.post(`${path}/fold`, { threadId: privateThread.id })).status).toBe(404);
  });

  it("lists only readable recent work and never reads unlogged or local-only text into a cloud project", async () => {
    const { ada, d, rt, u, path, threadPath, requests, say, logs } = await setup();
    const view = d.services!.memory.openThreadView(rt.ada.id, "general");
    const rows = ["selected", "unticked", "local", "unlogged"].map(title => view.own.createThread({ interface: "web", title, unlogged: title === "unlogged" }));
    for (const row of rows) view.own.appendEntry(row.id, { piId: row.id, role: "user", text: `WELCOME-${row.title}`, data: { type: "message", message: { role: "user", content: `WELCOME-${row.title}` } } });
    view.close();
    await ada.patch(`${threadPath(rows[2]!.id)}/settings`, { localOnly: true });
    const recent = `${u}/threads/general/recent?project=${enc((await ada.get<ThreadSummary>(path)).body.id)}`;
    expect((await ada.get<ThreadSummary[]>(recent)).body.map(t => t.id)).toEqual(expect.arrayContaining(rows.slice(0, 2).map(t => t.id)));
    expect((await ada.get<ThreadSummary[]>(recent)).body.map(t => t.id)).not.toEqual(expect.arrayContaining([rows[2]!.id]));
    expect((await ada.get<ThreadSummary[]>(recent)).body.map(t => t.id)).not.toContain(rows[3]!.id);
    expect((await ada.post(`${path}/fold`, { threadId: rows[2]!.id })).status).toBe(400);
    for (const row of rows.slice(2)) expect((await ada.post(`${path}/messages`, { text: "Set up", recentThreadIds: [row.id] })).status).toBe(400);
    const stream = ada.events(`${path}/events`); await stream.ready;
    await ada.post(`${path}/messages`, { text: "Set up", recentThreadIds: [rows[0]!.id] });
    await stream.until(e => e.type === "turn_end"); stream.close();
    expect(stream.events.filter(e => e.event.type === "error")).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(said(requests.at(-1)!)).toContain("WELCOME-selected");
    expect(said(requests.at(-1)!)).toContain("threads fold");
    expect(said(requests.at(-1)!)).not.toMatch(/WELCOME-(unticked|local|unlogged)/);
    await say("Now a fresh turn");
    expect(said(requests.at(-1)!)).not.toContain("WELCOME-selected");
    expect(logs.join("\n")).not.toContain("WELCOME-");
    await ada.patch(`${path}/settings`, { localOnly: true });
    expect((await ada.get<ThreadSummary[]>(recent)).body.map(t => t.id)).toContain(rows[2]!.id);
    expect((await ada.post(`${path}/fold`, { threadId: rows[2]!.id })).status).toBe(200);
  });

  it("reads selected private work through its own pool only and leaves unlogged work out", async () => {
    const { ada, d, rt, u, requests } = await setup();
    const view = d.services!.memory.openThreadView(rt.ada.id, "private");
    const source = view.own.createThread({ interface: "web", title: "Private garden" });
    const unlogged = view.own.createThread({ interface: "web", title: "Unlogged", unlogged: true });
    view.own.appendEntry(source.id, { piId: "private", role: "user", text: "PRIVATE-WELCOME", data: { type: "message", message: { role: "user", content: "PRIVATE-WELCOME" } } });
    view.close();
    const project = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "private", title: "Garden", project: true })).body;
    const at = `${u}/threads/private/${enc(project.id)}`;
    const recent = (await ada.get<ThreadSummary[]>(`${u}/threads/private/recent?project=${enc(project.id)}`)).body;
    expect(recent.map(t => t.id)).toContain(source.id);
    expect(recent.map(t => t.id)).not.toContain(unlogged.id);
    expect((await ada.post(`${at}/messages`, { text: "Set up", recentThreadIds: [unlogged.id] })).status).toBe(400);
    const general = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "General garden" })).body;
    expect((await ada.post(`${at}/messages`, { text: "Set up", recentThreadIds: [general.id] })).status).toBe(400);
    const stream = ada.events(`${at}/events`); await stream.ready;
    expect((await ada.post(`${at}/messages`, { text: "Set up", recentThreadIds: [source.id] })).status).toBe(200);
    await stream.until(e => e.type === "turn_end"); stream.close();
    expect(said(requests.at(-1)!)).toContain("PRIVATE-WELCOME");
    expect((await ada.get<ThreadSummary[]>(`${u}/threads/general/recent`)).body.map(t => t.id)).not.toContain(source.id);
    expect((await ada.post(`${u}/threads/private/${enc(unlogged.id)}/continue-as-project`, {})).status).toBe(400);
  });

  it("refuses to fold a general thread into a private project, leaving it where it was", async () => {
    const { ada, u, threadPath } = await setup();
    const general = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "General garden" })).body;
    const project = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "private", title: "Garden", project: true })).body;
    expect((await ada.post(`${u}/threads/private/${enc(project.id)}/fold`, { threadId: general.id })).status).toBe(404);
    expect((await ada.get<ThreadSummary>(threadPath(general.id))).body).toMatchObject({ id: general.id, child: false });
    expect((await ada.get<ThreadSummary>(threadPath(general.id))).body.parent).toBeUndefined();
  });

  it("refuses recent work from the private pool in a general project chat", async () => {
    const { ada, u, path } = await setup();
    const secret = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "private", title: "Private garden" })).body;
    expect((await ada.post(`${path}/messages`, { text: "Set up", recentThreadIds: [secret.id] })).status).toBe(400);
  });

  it("stores drafts without applying them, preserves them through other settings, and clears on Save or discard", async () => {
    const { ada, script, say, path } = await setup();
    const commandRules = [{ prefix: "npm test", decision: "ask" }];
    await ada.patch(path, { commandRules });
    script("chat").push(tool({ action: "draft", goal: "Grow herbs", instructions: "Keep a diary" }), { text: "Edit in Project settings." });
    await say("Draft project settings");
    const get = async () => (await ada.get<ThreadSummary>(path)).body;
    expect(await get()).toMatchObject({ goal: "Move the homelab to the new rack", projectSettings: { draftGoal: "Grow herbs", draftInstructions: "Keep a diary" } });
    expect((await get()).instructions).toBeUndefined();
    await ada.patch(path, { watchThreads: false });
    expect((await get()).projectSettings?.draftGoal).toBe("Grow herbs");
    await ada.patch(path, { goal: "Grow herbs", instructions: "Keep a diary" });
    expect(await get()).toMatchObject({ goal: "Grow herbs", instructions: "Keep a diary" });
    expect((await get()).projectSettings?.draftGoal).toBeUndefined();
    script("chat").push(tool({ action: "draft", goal: "Grow roses" }), { text: "Drafted." });
    await say("Another draft");
    await ada.patch(path, { discardDraft: true });
    expect((await get()).projectSettings?.draftGoal).toBeUndefined();
    expect((await get()).goal).toBe("Grow herbs");
    expect((await get()).projectSettings?.commandRules).toEqual(commandRules);
  });

  it("applies fold suggestions once, by row or all", async () => {
    const { ada, u, path, script, say, overview } = await setup();
    const ids = [];
    for (const title of ["Seeds", "Beds"]) ids.push((await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title })).body.id);
    script("chat").push(tool({ action: "fold", ids }), { text: "Fold these in?" });
    const end = ends((await say("Suggest recent work")).events)[0]!;
    expect(end.isError).toBe(false);
    expect((await ada.post<ThreadSummary[]>(`${path}/folds/${end.toolCallId}/apply`, { index: 1 })).body.map(t => t.id)).toEqual([ids[1]]);
    expect((await ada.post<ThreadSummary[]>(`${path}/folds/${end.toolCallId}/apply`, {})).body.map(t => t.id)).toEqual([ids[0]]);
    expect((await ada.post<ThreadSummary[]>(`${path}/folds/${end.toolCallId}/apply`, {})).body).toEqual([]);
    expect((await overview()).threads).toHaveLength(2);
  });

  it("continues as a pinned project on the source model, copying grants and local-only while leaving the source", async () => {
    const { ada, d, rt, threadPath } = await setup();
    const view = d.services!.memory.openThreadView(rt.ada.id, "general");
    const source = view.own.createThread({ interface: "web", title: "Garden" });
    const child = view.own.createThread({ interface: "web", parent: source.id, child: true, title: "Beds" });
    view.own.appendEntry(source.id, { piId: "source", role: "user", text: "WELCOME-GARDEN", data: { type: "message", message: { role: "user", content: "WELCOME-GARDEN" } } });
    view.close();
    const ws = d.services!.workspace.settings(rt.ada.id);
    ws.addMachine({ name: "garden-host", host: "127.0.0.1", port: 22, username: "tester", root: "/srv", pool: "general", limit: "ask", privateKey: "fake", offNetwork: false }, `SHA256:${"A".repeat(43)}`);
    ws.addGitAccount({ name: "forge", kind: "other", host: "127.0.0.1:9876", account: "tester", token: "fake", pool: "general", offNetwork: false });
    ws.addMcpServer({ name: "garden", url: "http://127.0.0.1:9876/mcp", token: "", pool: "general", offNetwork: false, tools: 0, description: "" });
    const folder = mkdtempSync(join(tmpdir(), "lyrica-welcome-grant-"));
    welcomeFolders.push(folder);
    d.services!.workspace.allowedPaths.allow(rt.ada, rt.ada.id, "general", folder);
    ws.setThread(source.id, "general", { grants: [{ path: folder, writable: true }], machines: ["garden-host"], repositories: [{ name: "tester/garden", account: "forge" }], mcpServers: ["garden"] });
    await ada.patch(`${threadPath(source.id)}/settings`, { localOnly: true, preset: "builtin.local" });
    const send = vi.spyOn(HostedThread.prototype, "send").mockResolvedValue({ queued: false });
    const continued = await ada.post<ThreadSummary>(`${threadPath(source.id)}/continue-as-project`, {});
    expect(continued.status).toBe(200);
    expect(continued.body).toMatchObject({ title: "Garden", project: true, pinned: true });
    expect(d.services!.models.callContext(rt.ada.id, "general", continued.body.id)).toMatchObject({ localOnly: true, preset: "builtin.local" });
    expect(ws.effective(continued.body.id)).toEqual(ws.effective(source.id));
    expect((await ada.get<ThreadSummary>(threadPath(child.id))).body.parent).toBe(continued.body.id);
    expect((await ada.get<ThreadSummary>(threadPath(source.id))).body).toMatchObject({ child: false, title: "Garden" });
    expect(send).toHaveBeenCalledWith(expect.stringContaining(`[t:${source.id}]`), { recentThreadIds: [source.id], recentWorkSource: source.id });
    expect(d.services!.models.callContext(rt.ada.id, "general", continued.body.id).overrides).toEqual(d.services!.models.callContext(rt.ada.id, "general", source.id).overrides);
    const reread = d.services!.memory.openThreadView(rt.ada.id, "general");
    expect(reread.own.latestEntries(source.id, 10)).toHaveLength(1); reread.close();
  });

  it("continues from one source without asking to fold the source that stays in place", async () => {
    const { ada, u, requests, threadPath, messages } = await setup();
    const source = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Seed notes" })).body;
    const continued = (await ada.post<ThreadSummary>(`${threadPath(source.id)}/continue-as-project`, {})).body;
    await until(() => messages(threadPath(continued.id)), rows => rows.some(row => row.role === "assistant"));
    const context = said(requests.at(-1)!);
    expect(context).toContain("which stays in place");
    expect(context).toContain("threads draft");
    expect(context).not.toContain("Suggest which of these threads to bring into the project");
    expect((await ada.get<ThreadSummary>(threadPath(source.id))).body.parent).toBeUndefined();
  });

  it("start pinned, filter in the thread list, and can't be undone", async () => {
    const { ada, u, project, path } = await setup();
    expect(project).toMatchObject({ project: true, goal: "Move the homelab to the new rack", pinned: true, projectSettings: { paused: false } });
    const plain = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Taxes" })).body;
    expect(plain.pinned).toBe(false);
    const ids = async () => (await ada.get<ThreadSummary[]>(`${u}/threads`)).body.map((t) => t.id);
    // Pinned threads come first, whatever was active last.
    expect(await ids()).toEqual([project.id, plain.id]);
    await ada.patch(`${u}/me/display`, { projects: "only" });
    expect(await ids()).toEqual([project.id]);
    await ada.patch(`${u}/me/display`, { projects: "none" });
    expect(await ids()).toEqual([plain.id]);
    await ada.patch(`${u}/me/display`, { projects: "all" });

    // Make project on a thread: pinned, and no way back.
    const made = (await ada.patch<ThreadSummary>(`${u}/threads/general/${enc(plain.id)}`, { project: true })).body;
    expect(made).toMatchObject({ project: true, pinned: true });
    expect((await ada.patch(`${u}/threads/general/${enc(plain.id)}`, { project: false })).status).toBe(400);
    expect((await ada.del(`${u}/threads/general/${enc(plain.id)}/pin`)).status).toBe(200);
    expect((await ada.get<ThreadSummary>(`${u}/threads/general/${enc(plain.id)}`)).body.pinned).toBe(false);
    expect((await ada.patch<ThreadSummary>(path, { goal: "Rack by Friday" })).body.goal).toBe("Rack by Friday");
    expect((await ada.patch<ThreadSummary>(path, { instructions: "Ask before buying anything." })).body.instructions).toBe("Ask before buying anything.");
    // The project page, where the instructions are kept, opens by the ID the summary gives.
    expect((await ada.get(`${u}/memory/general/${enc(project.projectSettings!.pageId)}`)).status).toBe(200);
    expect((await ada.patch(path, { instructions: "x".repeat(2001) })).status).toBe(400);
  });

  it("start new threads with the project's Fallback, which each thread can change", async () => {
    const { ada, u, path, script, say, threadPath } = await setup();
    expect((await ada.patch<ThreadSummary>(path, { threadsFallback: false })).body.projectSettings).toMatchObject({ threadsFallback: false });
    // The project chat's own Dictation pick was consent for that thread only: a new thread starts without it.
    const stt = (await ada.get<EndpointInfo[]>(`${u}/endpoints`)).body[0]!.models[0]!.id;
    expect((await ada.patch(`${u}/offerings/${stt}`, { transcribe: true })).status).toBe(200);
    expect((await ada.patch<ThreadSettings>(`${path}/settings`, { models: { "speech.transcribe": { offeringId: stt } } })).body.models["speech.transcribe"]).toMatchObject({ source: "thread" });
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    const { events } = await say("move DNS");
    const dns = ends(events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    expect((await ada.get<ThreadSettings>(`${threadPath(dns)}/settings`)).body).toMatchObject({ fallback: false, fallbackOn: false });
    expect((await ada.get<ThreadSettings>(`${threadPath(dns)}/settings`)).body.models["speech.transcribe"].source).not.toBe("thread");
    expect((await ada.patch<ThreadSettings>(`${threadPath(dns)}/settings`, { fallback: null })).body).toMatchObject({ fallback: null, fallbackOn: true });
    expect((await ada.patch(`${threadPath(dns)}/settings`, { fallback: "off" })).status).toBe(400);
    // Only a project chat makes looks, so only it chooses a Watching threads model.
    expect((await ada.patch(`${threadPath(dns)}/settings`, { models: { watching: { offeringId: stt } } })).status).toBe(400);
    expect((await ada.patch<ThreadSettings>(`${path}/settings`, { models: { watching: { offeringId: stt } } })).body.models.watching).toMatchObject({ source: "thread" });
    // Cleared, new threads follow the project chat's again.
    expect((await ada.patch<ThreadSummary>(path, { threadsFallback: null })).body.projectSettings?.threadsFallback).toBeUndefined();
    // The defaults: new threads, and sleep's phases.
    expect((await ada.patch<Presets>(`${u}/presets`, { fallback: false, sleepFallback: false })).body).toMatchObject({ fallback: false, sleepFallback: false });
    expect((await ada.get<ThreadSettings>(`${path}/settings`)).body).toMatchObject({ fallback: null, fallbackOn: false });
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
    const { ada, path, script, say, get, messages, threadPath } = await setup({ threads: { concurrency: 1 } });
    script("chat").push(start(["DNS", "dns: move DNS"], ["Backups", "backups: copy the backups"]), { text: "Started two." });
    script("dns").push(async () => { await new Promise(() => {}); return { text: "never" }; });
    script("backups").push({ text: "Backups copied." });
    const { events } = await say("move DNS and copy the backups");
    const dns = ends(events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    const backups = ends(events).find((e) => e.result.startsWith("Queued"))!.threads![0]!.id;
    await until(() => get(dns), (t) => t.state === "working");
    // Hiding stops the working thread; the freed slot doesn't start the queued one.
    expect((await ada.patch(path, { hidden: true })).status).toBe(200);
    await until(() => get(dns), (t) => t.state !== "working");
    await new Promise((r) => setTimeout(r, 200));
    expect((await get(backups)).state).toBe("queued");
    expect((await messages(threadPath(backups))).some((m) => m.role === "assistant")).toBe(false);
    expect((await ada.post(`${threadPath(dns)}/messages`, { text: "hello?" })).status).toBe(409);
  });

  it("hold every look after the person stops the project chat, until they write in the project again", async () => {
    const { d, ada, rt, project, path, script, requests, say, stream, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    const asked = () => requests.filter((c) => who(c) === "watching").length;
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    const { events } = await say("move DNS");
    const dns = ends(events).flatMap((e) => e.threads ?? [])[0]!.id;
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant"));
    // A turn Ada started in the chat, stopped while it works; the stopped turn ends after Stop.
    script("chat").push(() => new Promise<Reply>(() => {}));
    const from = stream.events.length;
    const chatCalls = requests.length;
    await ada.post(`${path}/messages`, { text: "keep going" });
    await until(async () => requests.length, (n) => n > chatCalls);
    expect((await ada.post(`${path}/stop`)).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
    d.services!.watcher.failed(rt.ada.id, "general", project.id, dns);
    await new Promise((r) => setTimeout(r, 400));
    expect(asked()).toBe(0);
    // Ada writes in DNS: looks come again.
    script("dns").push({ text: "Rechecked." });
    script("watching").push({ text: JSON.stringify({ tell: [] }) });
    await ada.post(`${threadPath(dns)}/messages`, { text: "check it again" });
    await until(async () => asked(), (n) => n === 1);
  });

  it("watch its threads: a look is one call to the Watching model that tells the thread it affects, with no turn of the project chat", async () => {
    const { ada, u, project, path, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    const looks = async () => (await messages(path)).filter((m) => m.from?.kind === "watching");
    const asked = () => requests.filter((c) => who(c) === "watching");
    const chatTurns = () => requests.filter((c) => who(c) === "chat" && !!c.tools?.length).length;
    script("chat").push(start(["DNS", "dns: move DNS to the router"], ["Backups", "backups: copy the backups"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    script("backups").push({ text: "Copying." });
    const { events } = await say("move DNS and copy the backups");
    const ids = ends(events).flatMap((e) => e.threads ?? []).map((t) => t.id);
    const titles = await Promise.all(ids.map(async (id) => [(await ada.get<ThreadSummary>(threadPath(id))).body.title, id] as const));
    const [dns, backups] = ["DNS", "Backups"].map((t) => titles.find(([title]) => title === t)![1]);
    await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant"));
    await until(() => messages(threadPath(backups!)), (m) => m.some((x) => x.role === "assistant"));
    const turnsBefore = chatTurns();

    // Ada writes in DNS: one call to the Watching model, which sees both sides, and tells Backups.
    script("dns").push({ text: "Using 10.0.0.53 then." });
    script("watching").push({ text: JSON.stringify({ tell: [{ thread: backups, text: "DNS is 10.0.0.53 now; point the NAS at it." }, { thread: project.id, text: "never the chat" }] }) });
    script("backups").push({ text: "Pointed." });
    expect((await ada.post(`${threadPath(dns!)}/messages`, { text: "use 10.0.0.53, not .1" })).status).toBe(200);
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
    expect((await ada.get<CallInfo[]>(`${u}/models/calls`)).body.find((c) => c.task === "watching")).toMatchObject({ threadId: project.id, kind: "local" });
    // Nobody else can write the mark.
    expect((await ada.post(`${path}/messages`, { text: "[Watching threads]\n\nhi" })).status).toBe(400);

    // The next look sees what the last ones told; an answer that isn't the JSON asked for does nothing.
    script("dns").push({ text: "Sure." });
    script("watching").push({ text: "Nothing needs doing, I think." });
    await ada.post(`${threadPath(dns!)}/messages`, { text: "and the NTP server too" });
    await until(async () => asked().length, (n) => n === 2);
    expect(JSON.stringify(asked()[1]!.messages)).toContain("What the last looks told threads");
    await new Promise((r) => setTimeout(r, 400));
    expect(await looks()).toHaveLength(1);
    expect(chatTurns()).toBe(turnsBefore);

    // A line for the thread the look was about isn't sent: it knows, and it asked nothing.
    script("dns").push({ text: "Will do." });
    script("watching").push({ text: JSON.stringify({ tell: [{ thread: dns, text: "back to you, DNS" }] }) });
    await ada.post(`${threadPath(dns!)}/messages`, { text: "and the DHCP range" });
    const [, back] = await until(looks, (l) => l.length === 2);
    expect(back!.from).toEqual({ kind: "watching", told: [] });
    expect(back!.parts).toEqual([{ type: "text", text: `In [t:${dns}]: the person wrote there.\n\nTold no thread.` }]);
    expect(JSON.stringify(await messages(threadPath(dns!)))).not.toContain("back to you, DNS");

    // A local-only thread's words never reach a project chat that may use a cloud model.
    expect((await ada.patch(`${threadPath(dns!)}/settings`, { localOnly: true })).status).toBe(200);
    script("dns").push({ text: "Kept local." });
    await ada.post(`${threadPath(dns!)}/messages`, { text: "the router password is in the safe" });
    await new Promise((r) => setTimeout(r, 600));
    expect(asked()).toHaveLength(3);
    expect((await ada.patch(`${threadPath(dns!)}/settings`, { localOnly: false })).status).toBe(200);
    // Switched off: no look.
    expect((await ada.patch(path, { watchThreads: false })).body).toMatchObject({ projectSettings: { watchThreads: false } });
    script("dns").push({ text: "Done." });
    await ada.post(`${threadPath(dns!)}/messages`, { text: "thanks" });
    await new Promise((r) => setTimeout(r, 600));
    expect(asked()).toHaveLength(3);
  });

  it("make no look for a wake-up's turn in a project's thread: the person didn't write", async () => {
    const { d, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    script("dns").push(tool({ action: "later", minutes: 5, note: "Check the leases." }), { text: "Later." });
    const { events } = await say("move DNS");
    const dns = ends(events).flatMap((e) => e.threads ?? [])[0]!.id;
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant" && x.parts.some((p) => p.type === "text" && p.text === "Later.")));
    script("dns").push({ text: "Leases look fine." });
    d.services!.wakeups.tick(new Date(Date.now() + 10 * 60_000));
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.from?.kind === "wakeup") && m.at(-1)!.role === "assistant");
    await new Promise((r) => setTimeout(r, 400));
    expect(requests.filter((c) => who(c) === "watching")).toHaveLength(0);
  });

  it("keep a quiet look that answers during a turn Ada started for after that turn, starting no other", async () => {
    const { ada, path, script, requests, say, threadPath, messages, stream } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    const asked = () => requests.filter((c) => who(c) === "watching");
    const chatTurns = () => requests.filter((c) => who(c) === "chat" && !!c.tools?.length).length;
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    const dns = ends((await say("move DNS")).events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant"));
    // The look's call waits until Ada has started a turn in the project chat, and that turn waits for the look's answer.
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    let reply!: () => void;
    const replied = new Promise<void>((r) => (reply = r));
    script("watching").push(async () => { await answered; return { text: '{"tell":[]}' }; });
    script("chat").push(async () => { await replied; return { text: "Here's where it stands." }; });
    script("dns").push({ text: "Using 10.0.0.53." });
    await ada.post(`${threadPath(dns)}/messages`, { text: "use 10.0.0.53" });
    await until(async () => asked().length, (n) => n === 1);
    const turnsBefore = chatTurns();
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text: "how is it going?" })).status).toBe(200);
    await until(async () => chatTurns(), (n) => n === turnsBefore + 1);
    answer();
    await new Promise((r) => setTimeout(r, 300));
    expect((await messages(path)).filter((m) => m.from?.kind === "watching")).toHaveLength(0);
    reply();
    await stream.until((e) => e.type === "turn_end", from);
    // Kept after the turn, as a delivery, and no turn of its own.
    const all = await until(() => messages(path), (m) => m.some((x) => x.from?.kind === "watching"));
    const at = all.findIndex((m) => m.from?.kind === "watching");
    expect(all.findIndex((m) => m.role === "assistant" && JSON.stringify(m).includes("where it stands"))).toBeLessThan(at);
    await new Promise((r) => setTimeout(r, 600));
    expect(chatTurns()).toBe(turnsBefore + 1);
  });

  it("raise something with the person: one turn of the project chat, with the short look and the line raised", async () => {
    const { ada, path, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    script("chat").push(start(["DNS", "dns: move DNS to the router"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    const dns = ends((await say("move DNS")).events).find((e) => e.result.startsWith("Started"))!.threads![0]!.id;
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant"));
    script("dns").push({ text: "Then the NAS loses its leases." });
    script("watching").push({ text: '```json\n{"tell":[],"raise":"Moving DNS to the router breaks the NAS leases: which first?"}\n```' });
    script("chat").push({ text: "Ada, which first: the router or the NAS?" });
    await ada.post(`${threadPath(dns)}/messages`, { text: "move it to the router tonight" });
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

  it("look on a failure and on a waiting approval past a run of 3 looks, telling no thread but raising", async () => {
    const { ada, path, script, requests, say, threadPath, messages } = await setup({ threads: { concurrency: 5 }, watchMs: 100, permissionMs: 10_000 });
    const looks = async () => (await messages(path)).filter((m) => m.from?.kind === "watching");
    const asked = () => requests.filter((c) => who(c) === "watching");
    const chatTurns = () => requests.filter((c) => who(c) === "chat" && !!c.tools?.length).length;
    // A child's report or bad end now wakes an idle parent for a turn of its own (brief child-wakes); those aren't looks' turns.
    const wakeTurns = () => requests.filter((c) => who(c) === "chat" && JSON.stringify(c.messages.at(-1)).includes("Read the child thread notices")).length;
    script("chat").push(start(["DNS", "dns: move DNS to the router"], ["Backups", "backups: copy the backups"]), { text: "Started." });
    script("dns").push({ text: "DNS moved." });
    script("backups").push({ text: "Copying." });
    const { events } = await say("move DNS and copy the backups");
    const ids = ends(events).flatMap((e) => e.threads ?? []).map((t) => t.id);
    const titles = await Promise.all(ids.map(async (id) => [(await ada.get<ThreadSummary>(threadPath(id))).body.title, id] as const));
    const [dns, backups] = ["DNS", "Backups"].map((t) => titles.find(([title]) => title === t)![1]) as [string, string];
    await until(() => messages(threadPath(dns)), (m) => m.some((x) => x.role === "assistant"));
    await until(() => messages(threadPath(backups)), (m) => m.some((x) => x.role === "assistant"));
    await ada.patch(`${threadPath(backups)}/settings`, { mode: "acceptEdits" });
    const turnsBefore = chatTurns() - wakeTurns();
    // The two threads keep each other going: each look tells the other one, which posts an update.
    const tell = (to: string, text = "anything new?") => ({ text: JSON.stringify({ tell: [{ thread: to, text }] }) });
    script("watching").push(tell(backups), tell(dns), tell(backups));
    const later = async (): Promise<Reply> => { await new Promise((r) => setTimeout(r, 200)); return tool({ action: "message", to: "parent", text: "Still fine." }); };
    script("dns").push({ text: "Noted." }, later, { text: "Posted." });
    // Told a third time, past the run: its update brings no look, its approval brings one, and after a no it fails.
    script("backups").push(later, { text: "Posted." }, tool({ action: "message", to: "parent", text: "One more thing." }), { tools: [{ name: "bash", args: { command: "true" } }] }, { status: 400 });
    script("watching").push(tell(backups, "approve it"), { text: JSON.stringify({ tell: [{ thread: dns, text: "Backups failed" }], raise: "Backups stopped with an error after you said no." }) });
    script("chat").push({ text: "Ada, Backups stopped." });
    const stream = ada.events(`${threadPath(backups)}/events`);
    await stream.ready;
    await ada.post(`${threadPath(dns)}/messages`, { text: "check again" });
    // Three looks: Ada's message, then each thread's update.
    await until(async () => asked().length, (n) => n === 3, 15000);
    await stream.until((e) => e.type === "permission");
    await until(async () => asked().length, (n) => n === 4, 15000);
    expect(JSON.stringify(asked()[3]!.messages)).toContain("It is waiting for an approval.");
    expect(JSON.stringify(asked()[3]!.messages)).toContain("this look tells no thread");
    await until(looks, (l) => l.length === 4);
    const request = stream.events.find((e) => e.event.type === "permission")!.event as { requestId: string };
    await ada.post(`${threadPath(backups)}/permissions/${request.requestId}`, { allow: false });
    await until(async () => asked().length, (n) => n === 5, 15000);
    expect(JSON.stringify(asked()[4]!.messages)).toContain("It stopped with an error.");
    const all = await until(looks, (l) => l.length === 5);
    expect(all.map((l) => (l.parts[0] as { text: string }).text)).toEqual([
      `In [t:${dns}]: the person wrote there.\n\nTold [t:${backups}]: "anything new?"`,
      `In [t:${backups}]: it posted an update.\n\nTold [t:${dns}]: "anything new?"`,
      `In [t:${dns}]: it posted an update.\n\nTold [t:${backups}]: "anything new?"`,
      `In [t:${backups}]: it is waiting for an approval.\n\nTold no thread.`,
      `In [t:${backups}]: it stopped with an error.\n\nTold no thread.\nRaised: "Backups stopped with an error after you said no."`,
    ]);
    // The raise is one turn of the project chat; neither line past the run was sent.
    // A child's report now wakes an idle parent for a turn of its own (brief child-wakes), so those turns don't count here.
    await until(() => messages(path), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("Backups stopped.")));
    await new Promise((r) => setTimeout(r, 600));
    expect(chatTurns() - wakeTurns()).toBe(turnsBefore + 1);
    expect(asked()).toHaveLength(5);
    expect(JSON.stringify(await messages(threadPath(dns)))).not.toContain("Backups failed");
    expect(JSON.stringify(await messages(threadPath(backups)))).not.toContain("approve it");
    stream.close();
  });

  it("keep a private project's looks on local models", async () => {
    const { ada, u, script, requests } = await setup({ threads: { concurrency: 5 }, watchMs: 100 });
    // Watching on a cloud model in the General column, which general projects use.
    const cloud = await fakeOpenAI({ label: "cloud", models: [{ id: "deepseek" }] });
    const deepseek = { offeringId: (await ada.post<EndpointInfo>(`${u}/endpoints`, { name: "openrouter", kind: "cloud", baseUrl: cloud.baseUrl })).body.models[0]!.id };
    expect((await ada.put(`${u}/columns/general/watching`, { model: deepseek })).status).toBe(200);
    const asked = () => requests.filter((c) => who(c) === "watching");
    const watchIn = async (pool: "general" | "private") => {
      const project = (await ada.post<ThreadSummary>(`${u}/threads`, { pool, title: "Garden", project: true, goal: "Plant the beds" })).body;
      const at = `${u}/threads/${pool}/${enc(project.id)}`;
      const stream = ada.events(`${at}/events`);
      await stream.ready;
      script("chat").push(start(["Beds", "beds: dig the beds"]), { text: "Started." });
      script("beds").push({ text: "Dug." });
      await ada.post(`${at}/messages`, { text: "dig the beds" });
      await stream.until((e) => e.type === "turn_end");
      stream.close();
      const beds = (await ada.get<ProjectOverview>(`${at}/overview`)).body.threads[0]!.id;
      const bedsAt = `${u}/threads/${pool}/${enc(beds)}`;
      await until(async () => (await ada.get<MessagePage>(`${bedsAt}/messages`)).body.messages, (m) => m.some((x) => x.role === "assistant"));
      script("beds").push({ text: "Roses then." });
      await ada.post(`${bedsAt}/messages`, { text: "roses in the south bed" });
    };
    // A general project's look goes to the cloud model it was given.
    await watchIn("general");
    await until(async () => cloud.requests.length, (n) => n === 1);
    // A private project's look resolves through its own context: the private column, local models only.
    script("watching").push({ text: '{"tell":[]}' });
    await watchIn("private");
    await until(async () => asked().length, (n) => n === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(cloud.requests).toHaveLength(1);
    expect(JSON.stringify(asked()[0]!.messages)).toContain("roses in the south bed");
    expect((await ada.get<CallInfo[]>(`${u}/models/calls`)).body.filter((c) => c.task === "watching").map((c) => [c.pool, c.kind])).toEqual([["private", "local"], ["general", "cloud"]]);
  });

  it("let a project's threads message each other, at most 3 a turn, and never a thread outside", async () => {
    const { ada, u, script, say, messages, threadPath } = await setup({ threads: { concurrency: 5 } });
    script("chat").push(start(["DNS", "dns: move DNS"], ["Backups", "backups: copy backups"]), { text: "Started." });
    script("dns").push({ text: "ready" });
    script("backups").push({ text: "ready" });
    const { events } = await say("go");
    const titled = await Promise.all(ends(events).map(async (e) => [(await ada.get<ThreadSummary>(threadPath(e.threads![0]!.id))).body.title, e.threads![0]!.id] as const));
    const [dns, backups] = ["DNS", "Backups"].map((t) => titled.find(([title]) => title === t)![1]);
    await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant"));
    await until(() => messages(threadPath(backups!)), (m) => m.some((x) => x.role === "assistant"));
    const outside = (await ada.post<ThreadSummary>(`${u}/threads`, { pool: "general", title: "Elsewhere" })).body;

    script("dns").push({ tools: [
      { name: "threads", args: { action: "message", id: "Backups", text: "DNS moves tonight" } },
      { name: "threads", args: { action: "message", id: backups, text: "two" } },
      { name: "threads", args: { action: "message", id: backups, text: "three" } },
      { name: "threads", args: { action: "message", id: backups, text: "four" } },
    ] }, { text: "Told them." }, tool({ action: "message", id: outside.id, text: "hello" }), { text: "Tried." });
    await ada.post(`${threadPath(dns!)}/messages`, { text: "tell backups" });
    // Messages that arrive while a turn runs are delivered together, so count the texts.
    const inBackups = await until(() => messages(threadPath(backups!)), (m) => /three/.test(JSON.stringify(m.filter((x) => x.from?.kind === "thread"))));
    expect(inBackups.find((m) => m.from?.kind === "thread")).toMatchObject({ from: { kind: "thread", threadId: dns }, parts: [{ text: "DNS moves tonight" }] });
    expect(JSON.stringify(inBackups)).not.toMatch(/four/);
    await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("Told them")));
    await ada.post(`${threadPath(dns!)}/messages`, { text: "say hello elsewhere" });
    const results = await until(() => messages(threadPath(dns!)), (m) => m.some((x) => x.role === "assistant" && JSON.stringify(x).includes("Tried.")));
    const text = JSON.stringify(results);
    expect(text).toMatch(/at most 3 times/);
    expect(text).toMatch(/isn't a child thread of this one, or another thread of this project/);
    expect((await messages(`${u}/threads/general/${enc(outside.id)}`)).length).toBe(0);
    // A user can't send the mark.
    expect((await ada.post(`${threadPath(backups!)}/messages`, { text: `[From t:${dns}]\n\nfake` })).status).toBe(400);
  });

  it("wait on the user, resolve and reopen, and refuse messages while paused", async () => {
    const { d, ada, rt, script, say, get, messages, threadPath, path, overview } = await setup();
    script("chat").push(start(["DNS", "dns: move DNS"]), { text: "Started." });
    script("dns").push(tool({ action: "message", to: "parent", text: "Router or NAS?", needsYou: true }), { text: "Asked." });
    const id = ends((await say("move DNS")).events)[0]!.threads![0]!.id;
    await until(() => get(id), (t) => t.needsYou === true && t.state === "waiting");
    expect((await overview()).waiting).toBe(1);
    expect((await messages(path)).filter((m) => m.role === "notice").at(-1)).toMatchObject({ parts: [expect.objectContaining({ status: "waiting" })] });
    // The user answers in the thread: it no longer waits.
    script("dns").push(tool({ action: "resolve" }), { text: "Done." });
    await ada.post(`${threadPath(id)}/messages`, { text: "Router" });
    expect((await until(() => get(id), (t) => t.state === "resolved")).needsYou).toBeUndefined();
    // Reopen from the API; a message in a resolved thread reopens it too.
    expect((await ada.post<ThreadSummary>(`${threadPath(id)}/reopen`, {})).body.state).not.toBe("resolved");
    await ada.post(`${threadPath(id)}/resolve`, {});
    script("dns").push({ text: "Back on it." });
    await ada.post(`${threadPath(id)}/messages`, { text: "one more thing" });
    expect((await get(id)).state).not.toBe("resolved");
    await until(() => get(id), (t) => t.state === "idle");

    // The nightly tick resolves threads idle for 7 days.
    expect(d.services!.children.autoResolve(rt.ada.id, new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect((await get(id)).state).toBe("resolved");

    // Paused: no messages, no starts.
    expect((await ada.patch<ThreadSummary>(path, { paused: true })).body.projectSettings?.paused).toBe(true);
    expect((await ada.post(`${threadPath(id)}/messages`, { text: "hello?" })).status).toBe(409);
    script("chat").push(start(["More", "more: more work"]), { text: "Tried." });
    const tried = ends((await say("start more")).events)[0]!;
    expect(tried).toMatchObject({ isError: true, result: expect.stringMatching(/paused/) });
  });

  it("suggest threads on a card, and start them from it once each", async () => {
    const { ada, script, say, path, overview } = await setup();
    script("chat").push(tool({ action: "suggest", threads: [{ title: "DNS", task: "dns: move DNS" }, { title: "Backups", task: "backups: copy backups" }] }), { text: "Shall I?" });
    const end = ends((await say("propose first")).events)[0]!;
    expect(end).toMatchObject({ isError: false, result: expect.stringMatching(/Suggested 2 threads/) });
    expect((await overview()).threads).toEqual([]);
    const one = (await ada.post<ThreadSummary[]>(`${path}/suggestions/${end.toolCallId}/start`, { index: 1 })).body;
    expect(one.map((t) => t.title)).toEqual(["Backups"]);
    const rest = (await ada.post<ThreadSummary[]>(`${path}/suggestions/${end.toolCallId}/start`, {})).body;
    expect(rest.map((t) => t.title)).toEqual(["DNS"]);
    expect(Object.keys((await overview()).started).sort()).toEqual([`${end.toolCallId}#0`, `${end.toolCallId}#1`]);
    expect((await ada.post<ThreadSummary[]>(`${path}/suggestions/${end.toolCallId}/start`, {})).body).toEqual([]);
  });

  it("makes a plan in one call: a Plan thread with a card, and nothing while paused", async () => {
    const { ada, path, script, get, overview, messages, threadPath } = await setup();
    script("make").push({ text: "Planning." });
    expect((await ada.patch(path, { paused: true })).status).toBe(200);
    expect((await ada.post(`${path}/plan`, {})).status).toBe(409);
    expect((await overview()).threads).toEqual([]);
    expect((await ada.patch(path, { paused: false })).status).toBe(200);
    const plan = await ada.post<ThreadSummary>(`${path}/plan`, {});
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ title: "Plan", parent: plan.body.parent, child: true });
    const rows = (await overview()).threads;
    expect(rows.map(t => t.title)).toEqual(["Plan"]);
    expect(rows[0]!.anchor).toBeUndefined();
    expect((await get(plan.body.id)).title).toBe("Plan");
    await until(() => messages(threadPath(plan.body.id)), m => JSON.stringify(m).includes("Move the homelab to the new rack"));
  });

  it("keep anchors through a rewind of later turns, and branches inside the project", async () => {
    const { ada, script, say, get, path, threadPath, messages, overview } = await setup();
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
    const started = (await ada.post<ThreadSummary>(`${path}/messages/${first}/thread`, { title: "From the note" })).body;
    expect(started).toMatchObject({ child: true, parent: (await get(id)).parent, anchor: first, title: "From the note" });
    // A branch of a project's thread is a thread of the project, hanging where its source does.
    await until(() => messages(threadPath(id)), (m) => m.some((x) => x.role === "assistant"));
    const branch = (await ada.post<ThreadSummary>(`${threadPath(id)}/messages/1/branch`, {})).body;
    expect(branch).toMatchObject({ child: true, anchor });
    expect((await overview()).threads.map((t) => t.id)).toEqual(expect.arrayContaining([id, started.id, branch.id]));
    // Rewinding the turn that started DNS leaves DNS, unanchored; the thread from message 1 keeps its anchor.
    expect((await ada.post(`${path}/messages/${asked.n}/rewind`, { action: "delete" })).status).toBe(200);
    expect((await get(id)).anchor).toBeUndefined();
    expect((await get(started.id)).anchor).toBe(first);
  });

  it("carry a note from one thread into the next thread's project section, and forget it all with the project", async () => {
    const { ada, d, rt, script, say, requests, path, threadPath, messages, logs } = await setup();
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

    const view = d.services!.memory.openThreadView(rt.ada.id, "general");
    const note = view.own.projectNotes(dns)[0]!.id;
    view.close();
    expect((await ada.del(`${path}?children=1`, {})).status).toBe(200);
    const after = d.services!.memory.openThreadView(rt.ada.id, "general");
    expect([after.own.get(note), after.own.getThread(dns), after.own.getThread(backups)]).toEqual([undefined, undefined, undefined]);
    after.close();
    expect(logs.join("\n")).not.toMatch(/MARKER-7|move DNS|copy backups/);
  });
});
