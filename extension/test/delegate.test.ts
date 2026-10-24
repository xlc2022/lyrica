import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { generateSshKey, Memory, PRONOUN_PRESETS, Workspace, type ExecutionTarget, type Persona, type Pool, type ToolOps, type WorkspaceThread } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatRequest } from "../../core/test/fake-openai.ts";
import { withModels } from "../../core/test/helpers.ts";
import {
  createDelegateExtension, createLyricaExtension, Delegation, openThreadSession,
  type DelegationEvent, type DelegationOptions, type Limits, type Request, type ThreadContext,
} from "../src/index.ts";

// Delegation against fake model servers: Ada's cloud endpoint ("openrouter")
// and local one ("gpu"). Subagents are told apart from their parent by the
// preamble every subagent gets.

const persona: Persona = { core: [{ path: "SOUL.md", text: "She is Lyrica." }], topics: [] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "lyrica-delegate-"))); dirs.push(d); return d; };

const said = (m: ChatRequest["messages"][number]) =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
const isSub = (r: ChatRequest) => JSON.stringify(r.messages).includes("You are a subagent");
/** What the subagent was last told: its task, a reviewer's notes, or an answer. */
const told = (r: ChatRequest) => said(r.messages.filter((m) => m.role === "user").at(-1) ?? { role: "user" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await sleep(10)) if (Date.now() > end) throw new Error("timed out waiting");
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

/** Ada with cloud subagent models, a Memory, and a Delegation over them. */
async function setup(o: { limits?: Partial<Limits>; workspace?: (m: Awaited<ReturnType<typeof withModels>>) => Workspace; approve?: DelegationOptions["approve"]; searxng?: () => string } = {}) {
  const m = await withModels();
  for (const task of ["chat", "subagent.cheap", "subagent.strong"] as const) m.models.setColumnTask(m.ada.id, "general", task, m.cloudRef);
  m.models.setColumnTask(m.ada.id, "private", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const cwd = tempDir();
  const workspace = o.workspace?.(m);
  const options = { users: m.users, memory, models: m.models, cwd, limits: o.limits, workspace, approve: o.approve, searxng: o.searxng };
  const delegation = new Delegation(options);
  const thread = (pool: Pool = "general", t: { localOnly?: boolean; unlogged?: boolean; project?: boolean } = {}): ThreadContext => {
    const view = memory.openThreadView(m.ada.id, pool);
    const { id } = view.own.createThread({ interface: "cli", unlogged: t.unlogged, project: t.project });
    if (t.localOnly) m.models.setLocalOnly(m.ada.id, pool, id, true);
    return { user: m.ada, pool, interface: "cli", threadId: id, view, call: m.models.callContext(m.ada.id, pool, id) };
  };
  const open = (t: ThreadContext) => openThreadSession({
    thread: t, models: m.models, cwd,
    extensions: [
      createLyricaExtension(t, { persona: () => persona, profile: () => ({ displayName: "Ada", pronouns: PRONOUN_PRESETS.she, previousNames: [] }) }),
      createDelegateExtension(t, delegation),
    ],
  });
  const run = async (parent: ThreadContext, req: Request, background = false) => {
    const r = delegation.start(parent, req, { background, budget: delegation.newBudget() });
    await r.checkpoint();
    return r;
  };
  return { ...m, memory, delegation, options, thread, open, run, cwd };
}

describe("delegate", () => {
  it("routes an implicit repository writer in a project's thread through code, with project memory and the inherited context limit", async () => {
    let ws!: Workspace;
    const s = await setup({ workspace: m => (ws = new Workspace(m.keyring, m.users, { excludePorts: [] })) });
    const chat = s.thread();
    chat.view.own.setProject(chat.threadId);
    chat.view.own.setGoal(chat.threadId, "CODE-PROJECT");
    // The project chat's own clones are read-only to it; its threads make the changes.
    const { id } = chat.view.own.createThread({ interface: "cli", parent: chat.threadId, child: true });
    const parent: ThreadContext = { ...chat, threadId: id, call: s.models.callContext(s.ada.id, "general", id) };
    const settings = ws.settings(s.ada.id);
    settings.addGitAccount({ name: "forge", kind: "other", host: "forge.example", account: "ada", token: "fake", pool: "general", offNetwork: false });
    settings.setThread(parent.threadId, "general", { repositories: [{ name: "garden/controller", account: "forge" }] });
    s.models.setColumnTask(s.ada.id, "general", "code", s.localRef);
    s.models.setThreadModel(s.ada.id, "general", parent.threadId, "chat", s.cloudRef);
    s.models.setContextLimit(s.ada.id, parent.threadId, 8192);
    s.local.respond(request => {
      expect(JSON.stringify(request.messages)).toContain("CODE-PROJECT");
      expect(JSON.stringify(request.messages)).toContain("Prior decisions");
      return { text: "verified fixture" };
    });
    const run = await s.run(parent, { task: "Fix fixture", done: "Prior decisions" });
    expect(run.status).toBe("finished");
    expect(s.delegation.status(parent)[0]).toMatchObject({ role: "coder", model: "gpu/qwen3.8-27b" });
    const child = parent.view.own.listThreads({ parent: parent.threadId })[0]!;
    expect(s.models.callContext(s.ada.id, "general", child.id).contextLimit).toBe(8192);
    expect(s.models.recentCalls(s.ada.id, { threadId: child.id })[0]).toMatchObject({ task: "code" });
    // Its turn is measured on its call record, so its endpoint's speed counts it.
    expect(s.models.recentCalls(s.ada.id, { threadId: child.id })[0]!.pace?.outputTokens).toBeGreaterThan(0);
    expect(s.cloud.requests).toHaveLength(0);
  });

  it("gives a subagent of a private or local-only thread only a local model", async () => {
    const s = await setup();
    s.local.respond(() => ({ text: "checked locally" }));
    for (const parent of [s.thread("private"), s.thread("general", { localOnly: true })]) {
      const run = await s.run(parent, { task: "check the list", tier: "strong" });
      expect(run.status).toBe("finished");
      expect(run.result).toBe("checked locally");
      // Naming a cloud model is refused before any thread is made.
      const named = await s.run(parent, { task: "check it", model: "openrouter/deepseek/deepseek-4.1-flash" });
      expect(named.status).toBe("failed");
      expect(named.result).toContain("isn't one of this thread's models");
      expect(parent.view.own.listThreads({ parent: parent.threadId })).toHaveLength(1);
      expect(s.delegation.status(parent)[0]).toMatchObject({ model: "gpu/qwen3.8-27b", status: "finished" });
    }
    expect(s.cloud.requests).toHaveLength(0);
  });

  it("makes children of an unlogged thread unlogged, listed under their parent", async () => {
    const s = await setup();
    const parent = s.thread("general", { unlogged: true });
    const run = await s.run(parent, { task: "look around", role: "scout" });
    expect(run.status).toBe("finished");
    const [child] = parent.view.own.listThreads({ parent: parent.threadId });
    expect(child).toMatchObject({ parent: parent.threadId, subagent: true, unlogged: true });
    expect(child!.title).toBe("scout: look around");
  });

  it("never widens the parent's folders, switches or hosts", async () => {
    const host = tempDir();
    for (const d of ["a", "b"]) mkdirSync(join(host, d));
    let ws!: Workspace;
    const s = await setup({ workspace: (m) => {
      ws = new Workspace(m.keyring, m.users, { excludePorts: [] });
      for (const d of ["a", "b"]) ws.allowedPaths.allow(m.ada, m.ada.id, "general", join(host, d));
      return ws;
    } });
    const parent = s.thread();
    ws.settings(s.ada.id).addMachine({ name: "nas", host: "127.0.0.1", port: 22, username: "lyrica", privateKey: generateSshKey("test").privateKey, root: null, pool: "general", offNetwork: false }, `SHA256:${"A".repeat(43)}`);
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { grants: [{ path: join(host, "a"), writable: true }], internet: false, hosts: ["10.0.0.5"], mode: "acceptEdits", machines: ["nas"] });

    const opened: WorkspaceThread[] = [];
    const forThread = ws.forThread.bind(ws);
    ws.forThread = (t) => { opened.push(t); return forThread(t); };

    const outside = await s.run(parent, { task: "read there", role: "scout", folders: [join(host, "b")] });
    expect(outside.status).toBe("failed");
    expect(outside.result).toContain("isn't one of this thread's folders");
    await s.run(parent, { task: "look", role: "scout" });
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { mode: "auto" });
    await s.run(parent, { task: "change it", role: "worker" });
    await s.run(parent, { task: "change only a", role: "worker", folders: [join(host, "a")] });
    await s.run(parent, { task: "change it offline", role: "worker", internet: false });
    const [offline, narrowed, worker, scout] = s.delegation.status(parent);
    const child = (thread: string) => ({ ...ws.settings(s.ada.id).thread(thread), network: ws.network({ userId: s.ada.id, pool: "general", threadId: thread }) });
    expect(child(scout!.thread)).toMatchObject({ grants: [{ path: join(host, "a"), writable: false }], mode: "acceptEdits", parent: parent.threadId, network: { internet: false, services: false, hosts: ["10.0.0.5"] } });
    expect(child(worker!.thread)).toMatchObject({ grants: [{ path: join(host, "a"), writable: true }], network: { internet: false, hosts: ["10.0.0.5"] } });
    // Bash on a machine follows no folder or read-only narrowing, so only an unnarrowed writer keeps the parent's machines.
    expect([scout, worker, narrowed, offline].map((r) => child(r!.thread).machines)).toEqual([[], ["nas"], [], []]);
    // Only an unnarrowed writer works in its parent's clones; the others see them read-only.
    expect([scout, worker, narrowed, offline].map((r) => opened.find((t) => t.threadId === r!.thread)))
      .toMatchObject([true, false, true, true].map((reposReadOnly) => ({ reposOf: parent.threadId, reposReadOnly })));
    // Anything wider is refused by the workspace itself.
    const p = { userId: s.ada.id, pool: "general" as const, threadId: parent.threadId };
    expect(() => ws.inheritSettings(p, worker!.thread, { internet: true })).toThrow("no internet");
    expect(() => ws.inheritSettings(p, worker!.thread, { hosts: ["10.0.0.6"] })).toThrow("isn't in the parent thread's hosts");
  });

  it("keeps a project chat's folders and clones read-only to the subagents it delegates to", async () => {
    const host = tempDir();
    mkdirSync(join(host, "a"));
    let ws!: Workspace;
    const s = await setup({ workspace: (m) => {
      ws = new Workspace(m.keyring, m.users, { excludePorts: [] });
      ws.allowedPaths.allow(m.ada, m.ada.id, "general", join(host, "a"));
      return ws;
    } });
    const chat = s.thread("general", { project: true });
    ws.settings(s.ada.id).setThread(chat.threadId, "general", { grants: [{ path: join(host, "a"), writable: true }], mode: "auto" });
    const opened: WorkspaceThread[] = [];
    const forThread = ws.forThread.bind(ws);
    ws.forThread = (t) => { opened.push(t); return forThread(t); };

    await s.run(chat, { task: "change it", role: "coder" });
    await s.run(chat, { task: "change it too", role: "worker" });
    for (const r of s.delegation.status(chat)) {
      expect(ws.settings(s.ada.id).thread(r.thread)).toMatchObject({ grants: [{ path: join(host, "a"), writable: false }] });
      expect(opened.find((t) => t.threadId === r.thread)).toMatchObject({ reposOf: chat.threadId, reposReadOnly: true });
    }
  });

  it("explains checkout folder rejection and keeps scouts in the parent's read-only clones", async () => {
    let ws!: Workspace;
    const s = await setup({ workspace: (m) => (ws = new Workspace(m.keyring, m.users, { excludePorts: [] })) });
    const parent = s.thread();
    const settings = ws.settings(s.ada.id);
    settings.addGitAccount({ name: "bot", kind: "github", host: "github.com", account: "test-bot", token: "test-token", pool: "general", offNetwork: true });
    settings.setThread(parent.threadId, "general", { grants: [], repositories: [{ name: "example/project", account: "bot" }] });
    const opened: WorkspaceThread[] = [];
    const forThread = ws.forThread.bind(ws);
    ws.forThread = (t) => { opened.push(t); return forThread(t); };

    const rejected = await s.run(parent, { task: "read the checkout", role: "scout", folders: ["/workspace/repos/project"] });
    expect(rejected.status).toBe("failed");
    expect(rejected.result).toContain("folders narrows granted host folders, not repository checkout paths");
    expect(rejected.result).toContain("Omit folders to read the parent's repository checkouts");
    expect(opened).toHaveLength(0);

    const scout = await s.run(parent, { task: "read the checkout", role: "scout" });
    expect(scout.status).toBe("finished");
    const child = s.delegation.status(parent).find((r) => r.status === "finished")!;
    // A scout reads the parent's clones, and its forge credentials are read-only: the relay refuses a push or an API write.
    expect(opened).toEqual([expect.objectContaining({ threadId: child.thread, reposOf: parent.threadId, reposReadOnly: true })]);
    expect(settings.effective(child.thread)).toMatchObject({ grants: [], repositories: [{ name: "example/project", account: "bot", readOnly: true }] });
    expect(ws.credentialsFor({ userId: s.ada.id, pool: "general", threadId: child.thread }).forge.map((f) => f.readOnly)).toEqual([true]);
  });

  it("gives an offline researcher neither web_search nor web_fetch", async () => {
    let ws!: Workspace;
    const s = await setup({ searxng: () => "http://127.0.0.1:9", workspace: (m) => (ws = new Workspace(m.keyring, m.users, { excludePorts: [] })) });
    s.cloud.respond(() => ({ text: "Nothing found." }));
    const parent = s.thread();
    await s.run(parent, { task: "look it up", role: "researcher" });
    await s.run(parent, { task: "look it up offline", role: "researcher", internet: false });
    const [online, offline] = s.cloud.requests.filter(isSub).map((r) => (r.tools ?? []).map((t) => t.function.name));
    expect(online).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    expect(offline!.filter((t) => t.startsWith("web_"))).toEqual([]);
    const [last] = s.delegation.status(parent);
    expect(ws.settings(s.ada.id).thread(last!.thread).webSearch).toBe(false);
  });

  it("runs parallel tasks within the concurrency limit, and counts their tokens", async () => {
    const s = await setup({ limits: { concurrency: 2 } });
    let working = 0;
    let most = 0;
    s.cloud.respond(async (r) => {
      most = Math.max(most, ++working);
      // Waits for a second call to arrive (or a second to pass), so a slow runner still sees them overlap.
      for (let t = 0; t < 100 && working < 2; t++) await sleep(10);
      await sleep(30);
      working--;
      return { text: `done: ${told(r)}` };
    });
    const parent = s.thread();
    const run = await s.run(parent, { tasks: [1, 2, 3, 4].map((i) => ({ task: `task ${i}`, role: "scout" })) });
    expect(run.status).toBe("finished");
    for (const i of [1, 2, 3, 4]) expect(run.result).toContain(`done: task ${i}`);
    expect(most).toBe(2);
    const rows = s.delegation.status(parent);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.inputTokens > 0 && r.outputTokens > 0)).toBe(true);
    const total = rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    const u = s.delegation.usage(parent);
    expect(u.inputTokens + u.outputTokens).toBe(total);
  });

  it("runs as many at once as the person asked for, on the models they named in their own words", async () => {
    const s = await setup({ limits: { concurrency: 2 } });
    let working = 0;
    let most = 0;
    const slow = async (r: ChatRequest) => {
      most = Math.max(most, ++working);
      for (let t = 0; t < 100 && working < 3; t++) await sleep(10);
      await sleep(30);
      working--;
      return { text: `done: ${told(r)}` };
    };
    s.cloud.respond(slow);
    s.local.respond(slow);
    // Two requests share one local model only when it is served with 200k or more (model-share.ts).
    s.models.setCapabilities(s.ada, s.localRef.offeringId, { contextWindow: 262_144 });
    const parent = s.thread();
    const tasks = [{ task: "a", model: "qwen 27b" }, { task: "b", model: "deepseek flash" }, { task: "c", model: "gpu/qwen3.8-27b" }].map((t) => ({ ...t, role: "scout" }));
    const run = s.delegation.start(parent, { tasks }, { background: false, budget: s.delegation.newBudget(), workers: 3 });
    await run.checkpoint();
    expect(run.status).toBe("finished");
    expect(most).toBe(3);
    expect(s.delegation.status(parent).map((r) => r.model).sort()).toEqual(["gpu/qwen3.8-27b", "gpu/qwen3.8-27b", "openrouter/deepseek/deepseek-4.1-flash"]);

    // A name that fits no one model: the closest are offered, and nothing starts.
    const vague = await s.run(parent, { task: "d", role: "scout", model: "qwen 3.9" });
    expect(vague.status).toBe("failed");
    expect(vague.result).toContain("Closest: gpu/qwen3.8-27b");
    expect(vague.result).toContain("Ask the person");
    expect(s.delegation.status(parent)).toHaveLength(3);
    // A local-only thread can't name a cloud model, even by its whole label.
    const local = await s.run(s.thread("general", { localOnly: true }), { task: "e", role: "scout", model: "openrouter/deepseek/deepseek-4.1-flash" });
    expect(local.status).toBe("failed");
    expect(s.delegation.models(s.thread("general", { localOnly: true })).map((m) => m.label)).toEqual(["gpu/qwen3.8-27b"]);
  });

  it("runs a project chat's subagents in the background, and moves a long foreground run there", async () => {
    const s = await setup({ limits: { foregroundMs: 300 } });
    const g = gate();
    s.cloud.respond(async (r) => {
      if (isSub(r)) { await g.opened; return { text: "reviewed: fine" }; }
      const last = r.messages.at(-1)!;
      if (last.role === "tool") return { text: "I've started a review." };
      if (JSON.stringify(last).includes("reviewed: fine")) return { text: "The review says fine." };
      return { tools: [{ name: "delegate", args: { task: "review the work" } }] };
    });
    // A project chat: background, though the call didn't ask for it.
    const chat = s.thread("general", { project: true });
    const c = await s.open(chat);
    try {
      await c.session.prompt("review it");
      expect(JSON.stringify(c.session.messages.find((m) => m.role === "toolResult"))).toContain("as every run in a project chat is");
      expect(s.delegation.status(chat)[0]).toMatchObject({ status: "running", background: true });
    } finally {
      c.dispose();
    }
    // Elsewhere: the turn waits foregroundMs, then the run carries on and its result arrives as a message.
    const plain = s.thread();
    const p = await s.open(plain);
    try {
      await p.session.prompt("review it");
      expect(JSON.stringify(p.session.messages.find((m) => m.role === "toolResult"))).toContain("carries on in the background");
      g.open();
      await until(() => p.session.messages.some((m) => m.role === "custom" && JSON.stringify(m).includes("reviewed: fine")));
    } finally {
      p.dispose();
    }
  });

  it("stops a subagent whose model goes quiet, not one that keeps working, waits for approval or runs a silent command", async () => {
    const scratch = tempDir();
    const target: ExecutionTarget = { name: "sandbox", cwd: async () => scratch, ops: () => ({ bash: createLocalBashOperations() } as unknown as ToolOps), folders: () => [] };
    let answer = gate();
    let ws!: Workspace;
    const s = await setup({
      limits: { idleMs: 400 },
      workspace: (m) => (ws = new (class extends Workspace { override targetFor(_t: WorkspaceThread) { return target; } })(m.keyring, m.users, { excludePorts: [] })),
      approve: async () => { await answer.opened; return true; },
    });
    const parent = s.thread();
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { mode: "acceptEdits" });
    const hush = gate();
    s.cloud.respond(async (r) => {
      const task = told(r);
      if (task === "quiet") { await hush.opened; return { text: "too late" }; }
      if (task === "ask") return r.messages.at(-1)!.role === "tool" ? { text: "asked and done" } : { tools: [{ name: "bash", args: { command: "echo ok" } }] };
      if (task === "build") return r.messages.at(-1)!.role === "tool" ? { text: "built" } : { tools: [{ name: "bash", args: { command: "sleep 1" } }] };
      // Busy: a tool call every 150 ms, five times, for longer than idleMs in all.
      const calls = r.messages.filter((m) => m.role === "tool").length;
      await sleep(150);
      return calls < 5 ? { tools: [{ name: "read_memory", args: { path: "nothing" } }] } : { text: "busy and done" };
    });
    const quiet = await s.run(parent, { task: "quiet", role: "scout" });
    hush.open();
    expect(quiet.status).toBe("stopped");
    expect(quiet.result).toContain("no sign of work");
    expect(s.delegation.status(parent)[0]!.status).toBe("stopped");

    const busy = await s.run(parent, { task: "busy", role: "scout" });
    expect(busy.status).toBe("finished");
    expect(busy.result).toContain("busy and done");

    // Waiting on the person for longer than idleMs doesn't count against it.
    const pending = s.delegation.start(parent, { task: "ask", role: "worker" }, { background: false, budget: s.delegation.newBudget() });
    await sleep(800);
    answer.open();
    await pending.checkpoint();
    expect(pending.status).toBe("finished");
    expect(pending.result).toContain("asked and done");

    // A command that prints nothing for longer than idleMs, as a build or test run can.
    const build = await s.run(parent, { task: "build", role: "worker" });
    expect(build.status).toBe("finished");
    expect(build.result).toContain("built");
    answer = gate();
  });

  it("passes each step's output on in a chain", async () => {
    const s = await setup();
    s.cloud.respond((r) => ({ text: told(r).includes("alpha") ? "beta, from alpha" : "alpha" }));
    const run = await s.run(s.thread(), { chain: [{ task: "find it", role: "scout" }, { task: "use {previous} well" }] });
    expect(run.result).toBe("beta, from alpha");
    expect(told(s.cloud.requests[1]!)).toBe("use alpha well");
  });

  it("stops a review loop when the reviewer approves, even one subagent at a time", async () => {
    const s = await setup({ limits: { concurrency: 1 } });
    let drafts = 0;
    let reviews = 0;
    s.cloud.respond((r) => {
      if (JSON.stringify(r.messages).includes("You are the reviewer")) return { text: ++reviews === 1 ? "Too short.\nVERDICT: CHANGES NEEDED: add detail" : "Good.\nVERDICT: APPROVED" };
      return { text: `draft ${++drafts}` };
    });
    const run = await s.run(s.thread(), { loop: { task: "write the note", rounds: 4 } });
    expect(run.result).toContain("draft 2");
    expect(run.result).toContain("approved in round 2");
    expect([drafts, reviews]).toEqual([2, 2]);
    // The worker kept its thread, and saw the reviewer's notes.
    expect(told(s.cloud.requests.filter((r) => !JSON.stringify(r.messages).includes("You are the reviewer")).at(-1)!)).toContain("add detail");
  });

  it("asks a council of models and combines their answers", async () => {
    const s = await setup();
    s.local.respond(() => ({ text: "local says plant tomatoes" }));
    s.cloud.respond((r) => ({ text: told(r).includes("Several advisers") ? "Combined: tomatoes, then beans." : "cloud says plant beans" }));
    const run = await s.run(s.thread(), { council: { question: "What should I plant?", models: ["openrouter/deepseek/deepseek-4.1-flash", "gpu/qwen3.8-27b"] } });
    expect(run.result).toContain("Combined: tomatoes, then beans.");
    const synthesis = told(s.cloud.requests.find((r) => told(r).includes("Several advisers"))!);
    expect(synthesis).toContain("local says plant tomatoes");
    expect(synthesis).toContain("cloud says plant beans");
  });

  it("delivers a background result to the parent on a later turn", async () => {
    const s = await setup();
    const g = gate();
    let parentTurns = 0;
    s.cloud.respond(async (r) => {
      if (isSub(r)) { await g.opened; return { text: "the answer is 42" }; }
      parentTurns++;
      if (parentTurns === 1) return { tools: [{ name: "delegate", args: { task: "find the answer", background: true } }] };
      return { text: parentTurns === 2 ? "I've asked a subagent." : "It found 42." };
    });
    const events: DelegationEvent[] = [];
    s.delegation.events.on("event", (e) => events.push(e));
    const parent = s.thread();
    const p = await s.open(parent);
    try {
      await p.session.prompt("please find the answer");
      expect(p.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: false });
      expect(s.delegation.status(parent)[0]).toMatchObject({ status: "running", background: true });
      g.open();
      await until(() => p.session.messages.some((m) => m.role === "custom" && JSON.stringify(m).includes("the answer is 42")));
      await p.session.prompt("what did it find?");
    } finally {
      p.dispose();
    }
    expect(JSON.stringify(s.cloud.requests.at(-1)!.messages)).toContain("the answer is 42");
    expect(JSON.stringify(parent.view.own.loadEntries(parent.threadId))).toContain("the answer is 42");
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["started", "output", "usage", "finished"]));
    expect(events.every((e) => e.parentThreadId === parent.threadId)).toBe(true);
  });

  it("keeps a result for a parent whose session has closed, and stops a run on request", async () => {
    const s = await setup();
    const g = gate();
    s.cloud.respond(async (r) => {
      if (isSub(r) && told(r).includes("slow")) { await g.opened; return { text: "too late" }; }
      return { text: isSub(r) ? "kept for later" : "Thanks." };
    });
    const parent = s.thread();
    const p = await s.open(parent);
    const done = s.delegation.start(parent, { task: "quick" }, { background: true, budget: s.delegation.newBudget() });
    p.dispose();
    await until(() => done.done);
    await until(() => JSON.stringify(parent.view.own.loadEntries(parent.threadId)).includes("kept for later"));
    const again = await s.open(parent);
    try {
      await again.session.prompt("anything new?");
    } finally {
      again.dispose();
    }
    expect(JSON.stringify(s.cloud.requests.at(-1)!.messages)).toContain("kept for later");

    const slow = s.delegation.start(parent, { task: "slow work" }, { background: true, budget: s.delegation.newBudget() });
    await until(() => s.delegation.status(parent).length === 2 && s.cloud.requests.some((r) => told(r) === "slow work"));
    slow.stop();
    await slow.checkpoint();
    expect(slow.status).toBe("stopped");
    expect(s.delegation.status(parent)[0]).toMatchObject({ run: slow.id, status: "stopped" });
    g.open();
  });

  it("pauses a background run on a question until it's answered", async () => {
    const s = await setup();
    s.cloud.respond((r) => (told(r).includes("blue") ? { text: "Painted it blue." } : { tools: [{ name: "ask_parent", args: { question: "Which colour?" } }] }));
    const parent = s.thread();
    const run = await s.run(parent, { task: "paint the shed" }, true);
    expect(run.status).toBe("question");
    expect(s.delegation.status(parent)[0]!.status).toBe("question");
    await until(() => JSON.stringify(parent.view.own.loadEntries(parent.threadId)).includes("Which colour?"));
    await sleep(50);
    expect(s.cloud.requests).toHaveLength(1);

    run.answer("Use blue.");
    await run.checkpoint();
    expect(run.status).toBe("finished");
    expect(run.result).toBe("Painted it blue.");
    await until(() => JSON.stringify(parent.view.own.loadEntries(parent.threadId)).includes("Painted it blue."));

    // A foreground run returns the question as its result.
    s.cloud.reply({ tools: [{ name: "ask_parent", args: { question: "Indoors or out?" } }] });
    const fg = await s.run(parent, { task: "plant it" });
    expect(fg.status).toBe("question");
    expect(fg.questions[0]!.question).toBe("Indoors or out?");
    fg.stop();
  });

  it("gives parallel writers in a git folder their own worktrees, and otherwise runs them one at a time", async () => {
    const host = tempDir();
    const scratch = tempDir();
    const repo = join(host, "repo");
    const plain = join(host, "plain");
    mkdirSync(repo);
    mkdirSync(plain);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    // Commands run on this host in a scratch folder, standing in for the sandbox.
    const target: ExecutionTarget = { name: "sandbox", cwd: async () => scratch, ops: () => ({ bash: createLocalBashOperations() } as unknown as ToolOps), folders: () => [] };
    let ws!: Workspace;
    const s = await setup({ limits: { concurrency: 3 }, workspace: (m) => {
      ws = new (class extends Workspace { override targetFor(_t: WorkspaceThread) { return target; } })(m.keyring, m.users, { excludePorts: [] });
      ws.allowedPaths.allow(m.ada, m.ada.id, "general", repo);
      ws.allowedPaths.allow(m.ada, m.ada.id, "general", plain);
      return ws;
    } });
    let working = 0;
    let most = 0;
    s.cloud.respond(async () => { most = Math.max(most, ++working); await sleep(30); working--; return { text: "changed" }; });

    const parent = s.thread();
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { grants: [{ path: repo, writable: true }] });
    const run = await s.run(parent, { tasks: [{ task: "change A" }, { task: "change B" }, { task: "look", role: "scout" }] });
    expect(run.status).toBe("finished");
    expect(most).toBe(3);
    const trees = [1, 2].map((i) => join(scratch, "worktrees", `${run.id}-${i}`, "repo"));
    // Each writer's worktree is gone once it's done; its branch stays.
    for (const t of trees) expect(existsSync(t)).toBe(false);
    expect(git("worktree", "list")).not.toContain("worktrees");
    expect(git("branch", "--list", "lyrica/*")).toContain(`lyrica/${run.id}-2`);
    expect(run.result).toContain(`its commits are on branch lyrica/${run.id}-1`);
    const writers = s.delegation.status(parent).filter((r) => r.role === "worker");
    expect(writers.map((r) => ws.settings(s.ada.id).thread(r.thread).grants)).toEqual([[{ path: `${repo}/.git`, writable: true }], [{ path: `${repo}/.git`, writable: true }]]);
    const tasks = s.cloud.requests.map(told).filter((t) => t.startsWith("change"));
    expect(tasks.filter((t) => t.includes(trees[0]!))).toHaveLength(1);
    expect(tasks.filter((t) => t.includes(trees[1]!))).toHaveLength(1);

    // Not a git repository: the writers take turns.
    const other = s.thread();
    ws.settings(s.ada.id).setThread(other.threadId, "general", { grants: [{ path: plain, writable: true }] });
    most = 0;
    const serial = await s.run(other, { tasks: [{ task: "change C" }, { task: "change D" }] });
    expect(serial.status).toBe("finished");
    expect(serial.result).toContain(`The writers ran one at a time: ${plain} isn't the top of a git repository`);
    expect(most).toBe(1);

    // Nor do writers from two runs share it.
    most = 0;
    const both = [s.delegation.start(other, { task: "change E" }, { background: true, budget: s.delegation.newBudget() }),
      s.delegation.start(other, { task: "change F" }, { background: true, budget: s.delegation.newBudget() })];
    await Promise.all(both.map((r) => r.ended));
    expect(both.map((r) => r.status)).toEqual(["finished", "finished"]);
    expect(most).toBe(1);
  });

  it("refuses work past the depth and run limits", async () => {
    const s = await setup({ limits: { runsPerRequest: 2 } });
    const parent = s.thread();
    const run = await s.run(parent, { tasks: [1, 2, 3].map((i) => ({ task: `task ${i}`, role: "scout" })) });
    expect(run.result).toContain("Failed: this request has already started 2 subagents");
    expect(parent.view.own.listThreads({ parent: parent.threadId })).toHaveLength(2);

    // At depth 1 a subagent can't delegate, and isn't offered the tool; it can only read memory.
    const sent = s.cloud.requests[0]!.tools!.map((t) => t.function.name);
    expect(sent).toEqual(expect.arrayContaining(["ask_parent", "recall", "read_memory"]));
    expect(sent).not.toContain("delegate");
    expect(sent).not.toContain("remember");
    const [row] = s.delegation.status(parent);
    const child: ThreadContext = { ...parent, threadId: row!.thread, call: s.models.callContext(s.ada.id, "general", row!.thread) };
    expect(() => createDelegateExtension(child, s.delegation)).toThrow("depth limit");
    expect(() => s.delegation.start(child, { task: "more" }, { background: false, budget: s.delegation.newBudget() })).toThrow("depth limit");

    // At depth 2 it can.
    const deeper = await setup({ limits: { depth: 2 } });
    await deeper.run(deeper.thread(), { task: "go", role: "scout" });
    expect(deeper.cloud.requests[0]!.tools!.map((t) => t.function.name)).toContain("delegate");
  });

  it("reports a run interrupted by a restart", async () => {
    const s = await setup();
    const g = gate();
    s.cloud.respond(async () => { await g.opened; return { text: "never seen" }; });
    const parent = s.thread();
    const run = s.delegation.start(parent, { task: "long job" }, { background: true, budget: s.delegation.newBudget() });
    await until(() => s.cloud.requests.length === 1);

    // A new lyricad over the same data: the run it finds live in the records is gone.
    const after = new Delegation(s.options);
    const events: DelegationEvent[] = [];
    after.events.on("interrupted", (e) => events.push(e));
    after.recover(s.ada.id);
    expect(after.status(parent)[0]).toMatchObject({ run: run.id, status: "interrupted" });
    expect(events).toEqual([expect.objectContaining({ type: "interrupted", runId: run.id, parentThreadId: parent.threadId })]);
    expect(JSON.stringify(parent.view.own.loadEntries(parent.threadId))).toContain(`Subagent run ${run.id} was interrupted`);
    run.stop();
    g.open();
  });

  it("runs a saved workflow by name, with custom roles", async () => {
    const s = await setup();
    s.delegation.store.setRole(s.ada.id, { name: "poet", description: "Writes verse.", prompt: "You write short poems.", tier: "cheap", tools: [], readOnly: true, thinking: "low" });
    s.delegation.store.setWorkflow(s.ada.id, { name: "verse", description: "A poem, then a check.", spec: { chain: [{ task: "A poem about {input}", role: "poet" }, { task: "Check: {previous}", role: "reviewer" }] } });
    s.cloud.respond((r) => ({ text: told(r).startsWith("A poem") ? "Roses and rain" : "Scans well." }));
    const run = await s.run(s.thread(), { workflow: "verse", input: "spring" });
    expect(run.result).toBe("Scans well.");
    expect(told(s.cloud.requests[0]!)).toBe("A poem about spring");
    expect(JSON.stringify(s.cloud.requests[0]!.messages)).toContain("You write short poems.");
    expect(s.cloud.requests[0]!.tools!.map((t) => t.function.name).sort()).toEqual(["ask_parent"]);
  });

  it("stops a run when its parent goes local-only or unlogged, and gives later steps a local model", async () => {
    const s = await setup();
    s.local.respond(() => ({ text: "local step" }));
    const g = gate();
    s.cloud.respond(async (r) => {
      if (told(r) === "first") { await g.opened; return { text: "cloud step" }; }
      return told(r).includes("secret") ? { text: "got it" } : { tools: [{ name: "ask_parent", args: { question: "Which one?" } }] };
    });
    // A chain whose parent goes local-only between steps: the next step is local.
    const parent = s.thread();
    const chain = s.delegation.start(parent, { chain: [{ task: "first" }, { task: "second" }] }, { background: true, budget: s.delegation.newBudget() });
    await until(() => s.cloud.requests.length === 1);
    s.models.setLocalOnly(s.ada.id, "general", parent.threadId, true);
    g.open();
    await chain.checkpoint();
    expect(chain.result).toBe("local step");
    expect(s.local.requests).toHaveLength(1);

    // A cloud subagent waiting on an answer is stopped, and never sees it.
    for (const change of ["local-only", "unlogged"] as const) {
      const p = s.thread();
      const run = await s.run(p, { task: "pick" }, true);
      expect(run.status).toBe("question");
      if (change === "local-only") s.models.setLocalOnly(s.ada.id, "general", p.threadId, true);
      else p.view.own.setUnlogged(p.threadId, true);
      run.answer("the secret one");
      await run.checkpoint();
      expect(run.status).toBe("stopped");
      expect(run.result).toContain(change === "local-only" ? "now local-only" : "no longer logged");
      expect(s.delegation.status(p)[0]!.status).toBe("stopped");
    }
    expect(JSON.stringify(s.cloud.requests)).not.toContain("secret");
  });

  it("stops a forgotten thread's runs, and survives a restart after its parent was forgotten", async () => {
    const s = await setup();
    const g = gate();
    s.cloud.respond(async () => { await g.opened; return { text: "done" }; });
    const parent = s.thread();
    const run = s.delegation.start(parent, { task: "long job" }, { background: true, budget: s.delegation.newBudget() });
    await until(() => s.cloud.requests.length === 1);
    await s.delegation.forget(s.ada.id, "general", parent.threadId);
    expect(run.status).toBe("stopped");
    expect(run.result).toContain("forgotten");
    expect(s.delegation.status(parent)).toEqual([]);
    parent.view.own.forgetThread(parent.threadId, "lyrica");
    expect(parent.view.own.listThreads({ includeHidden: true }).filter((t) => t.subagent)).toEqual([]);

    // A run left live by a restart, whose parent is forgotten before anything recovers it.
    const other = s.thread();
    const left = s.delegation.start(other, { task: "more" }, { background: true, budget: s.delegation.newBudget() });
    await until(() => s.cloud.requests.length === 2);
    other.view.own.forgetThread(other.threadId, "lyrica");
    const after = new Delegation(s.options);
    expect(() => after.recover(s.ada.id)).not.toThrow();
    left.stop();
    g.open();
  });

  it("counts nested subagents against the request that started them", async () => {
    const s = await setup({ limits: { depth: 2, runsPerRequest: 2 } });
    s.cloud.respond((r) => {
      const tools = r.tools?.map((t) => t.function.name) ?? [];
      if (tools.includes("delegate") && r.messages.at(-1)!.role !== "tool") return { tools: [{ name: "delegate", args: { tasks: [{ task: "a", role: "scout" }, { task: "b", role: "scout" }] } }] };
      return { text: r.messages.at(-1)!.role === "tool" ? said(r.messages.at(-1)!) : "scouted" };
    });
    const parent = s.thread();
    const run = await s.run(parent, { task: "split it up", role: "worker" });
    expect(run.result).toContain("this request has already started 2 subagents");
    const [child] = parent.view.own.listThreads({ parent: parent.threadId });
    expect(parent.view.own.listThreads({ parent: child!.id })).toHaveLength(1);
  });
});

describe("talking with subagents", () => {
  const stored = (t: ThreadContext) => JSON.stringify(t.view.own.loadEntries(t.threadId));

  it("message joins a working subagent's turn, answers its question, and continues one that has ended", async () => {
    const s = await setup();
    const g = gate();
    s.cloud.respond(async (r) => {
      const all = JSON.stringify(r.messages);
      if (told(r).includes("paint")) return { tools: [{ name: "ask_parent", args: { question: "Which colour?" } }] };
      if (told(r) === "Blue.") return { text: "Painted it blue." };
      if (told(r).includes("anything else")) return { text: all.includes("also look in the shed") ? "Only the trowel, from the shed." : "nothing" };
      if (all.includes("also look in the shed")) return { text: "Found the trowel in the shed." };
      await g.opened;
      return { text: "Nothing in the house." };
    });
    const parent = s.thread();
    const budget = () => s.delegation.newBudget();

    // Working: the message joins the turn in progress.
    const run = s.delegation.start(parent, { task: "find the trowel", role: "scout" }, { background: false, budget: budget() });
    await until(() => s.cloud.requests.length === 1);
    const joined = s.delegation.message(parent, run.id, { text: "also look in the shed" }, { budget: budget() });
    expect(joined.how).toBe("joined");
    g.open();
    await run.checkpoint();
    expect(run.result).toBe("Found the trowel in the shed.");

    // Asking: the message is its answer.
    const paint = await s.run(parent, { task: "paint the shed" });
    expect(paint.status).toBe("question");
    expect(s.delegation.message(parent, paint.id, { text: "Blue." }, { budget: budget() }).how).toBe("answered");
    await paint.checkpoint();
    expect(paint.result).toBe("Painted it blue.");

    // Ended: it continues in its own thread, with what it knew, under the same run, and counts once more.
    const before = s.cloud.requests.length;
    const more = s.delegation.message(parent, run.id, { text: "anything else?" }, { budget: budget() });
    expect(more.how).toBe("continued");
    await more.opened;
    await more.run.checkpoint();
    expect(more.run.id).toBe(run.id);
    expect(more.run.result).toBe("Only the trowel, from the shed.");
    const sent = JSON.stringify(s.cloud.requests[before]!.messages);
    for (const earlier of ["find the trowel", "also look in the shed", "Found the trowel in the shed."]) expect(sent).toContain(earlier);
    expect(s.delegation.status(parent).find((r) => r.run === run.id)).toMatchObject({ status: "finished", thread: more.threadId });
    await expect(s.delegation.message(parent, run.id, { text: "and?" }, { budget: { left: 0 } }).opened).rejects.toThrow("already started");

    // Only this thread's runs, and the subagent must be clear.
    expect(() => s.delegation.message(s.thread(), run.id, { text: "hi" }, { budget: budget() })).toThrow(`no run ${run.id} in this thread`);
    const two = await s.run(parent, { tasks: [{ task: "one", role: "scout" }, { task: "two", role: "scout" }] });
    expect(() => s.delegation.message(parent, two.id, { text: "hi" }, { budget: budget() })).toThrow("say which with thread");
    const [, second] = s.delegation.status(parent).filter((r) => r.run === two.id);
    const picked = s.delegation.message(parent, two.id, { text: "anything else?" }, { thread: `t:${second!.thread}`, budget: budget() });
    expect(picked.threadId).toBe(second!.thread);
    await picked.run.ended;
  });

  it("gives an ended run's last replies to a wait, and nothing for a live run or another thread's", async () => {
    const s = await setup();
    s.cloud.respond(async () => ({ text: "The trowel is in the shed." }));
    const parent = s.thread();
    const run = await s.run(parent, { task: "find the trowel", role: "scout" });
    await run.ended;
    const [row] = s.delegation.status(parent);
    expect(s.delegation.ended(parent, run.id)).toBe(`Subagent run ${run.id} has ended.\n\nscout (t:${row!.thread}), finished:\n\nThe trowel is in the shed.`);
    expect(s.delegation.ended(s.thread(), run.id)).toBeUndefined();
    expect(s.delegation.ended(parent, "r-none")).toBeUndefined();
  });

  it("continues a subagent interrupted by a restart from its thread", async () => {
    const s = await setup();
    const g = gate();
    s.cloud.respond(async (r) => {
      if (told(r) === "long job") { await g.opened; return { text: "never seen" }; }
      return { text: JSON.stringify(r.messages).includes("long job") ? "Picking up the long job." : "lost" };
    });
    const parent = s.thread();
    const run = s.delegation.start(parent, { task: "long job" }, { background: true, budget: s.delegation.newBudget() });
    await until(() => s.cloud.requests.length === 1);

    const after = new Delegation(s.options);
    after.recover(s.ada.id);
    const [row] = after.status(parent);
    expect(row).toMatchObject({ status: "interrupted" });
    expect(stored(parent)).toContain("To go on, send it a message");
    const go = after.message(parent, run.id, { text: "carry on" }, { budget: after.newBudget() });
    await go.opened;
    await go.run.ended;
    // A background run's reply arrives in the parent thread.
    expect(go.run.result).toBe("Picking up the long job.");
    expect(stored(parent)).toContain("Picking up the long job.");
    expect(after.status(parent)[0]).toMatchObject({ status: "finished" });
    run.stop();
    g.open();
  });

  it("works a continued subagent's model out again: local once its parent is local-only, refused once it is forgotten", async () => {
    const s = await setup();
    s.local.respond(() => ({ text: "local reply" }));
    const parent = s.thread();
    const run = await s.run(parent, { task: "plan the beds", tier: "strong" });
    expect(s.delegation.status(parent)[0]!.model).toBe("openrouter/deepseek/deepseek-4.1-flash");

    s.models.setLocalOnly(s.ada.id, "general", parent.threadId, true);
    const local = s.delegation.message(parent, run.id, { text: "and the paths?" }, { budget: s.delegation.newBudget() });
    await local.opened;
    await local.run.checkpoint();
    expect(local.run.result).toBe("local reply");
    expect(s.delegation.status(parent)[0]!.model).toBe("gpu/qwen3.8-27b");
    expect(JSON.stringify(s.cloud.requests)).not.toContain("and the paths?");

    parent.view.own.forgetThread(parent.threadId, "lyrica");
    const gone = s.delegation.message(parent, run.id, { text: "still there?" }, { budget: s.delegation.newBudget() });
    await expect(gone.opened).rejects.toThrow(/forgotten/);
    expect(JSON.stringify([s.cloud.requests, s.local.requests])).not.toContain("still there?");
  });

  it("delivers notes from a subagent that keeps working, a few per stretch", async () => {
    const s = await setup({ limits: { notes: 2 } });
    s.cloud.respond((r) => {
      if (r.messages.at(-1)!.role === "tool") return { text: "Weeded all three beds." };
      return { tools: [1, 2, 3].map((i) => ({ name: "ask_parent", args: { question: `bed ${i} is done`, wait: false } })) };
    });
    const events: DelegationEvent[] = [];
    s.delegation.events.on("note", (e) => events.push(e));
    const parent = s.thread();
    const run = await s.run(parent, { task: "weed the beds" }, true);
    await run.ended;
    expect(run.status).toBe("finished");
    expect(run.result).toBe("Weeded all three beds.");
    expect(events.map((e) => (e as { note: string }).note)).toEqual(["bed 1 is done", "bed 2 is done"]);
    const text = stored(parent);
    expect(text).toContain("bed 1 is done");
    expect(text).toContain("bed 2 is done");
    expect(text).not.toContain("bed 3 is done");
    expect(JSON.stringify(s.cloud.requests.at(-1)!.messages)).toContain("sent all the notes you can");
  });

  it("forks a subagent from the parent's conversation, and keeps a fork of a restricted parent local", async () => {
    const s = await setup();
    s.cloud.respond((r) => {
      if (isSub(r)) return { text: JSON.stringify(r.messages).includes("SPRUCE") ? "Fork knows SPRUCE." : "Fork knows nothing." };
      if (JSON.stringify(r.messages).includes("try two ways")) {
        if (r.messages.at(-1)!.role === "tool") return { text: "Both forks reported." };
        return { tools: [{ name: "delegate", args: { tasks: [{ task: "way A", fork: true }, { task: "way B", role: "scout" }] } }] };
      }
      return { text: "Noted." };
    });
    const parent = s.thread();
    const p = await s.open(parent);
    try {
      await p.session.prompt("The password is SPRUCE.");
      await p.session.prompt("Now try two ways.");
    } finally {
      p.dispose();
    }
    const subs = s.cloud.requests.filter(isSub);
    const forked = subs.find((r) => told(r).includes("way A"))!;
    expect(told(forked)).toContain("copied for you");
    expect(JSON.stringify(forked.messages)).toContain("SPRUCE");
    // It is still a subagent: its own preamble, read-only memory, no remember.
    expect(forked.tools!.map((t) => t.function.name)).not.toContain("remember");
    // Without fork, it sees only its task.
    expect(JSON.stringify(subs.find((r) => told(r).includes("way B"))!.messages)).not.toContain("SPRUCE");
    // The copies point at their originals: search finds the parent's entry once, and sleep doesn't read them again.
    const forkThread = s.delegation.status(parent).find((r) => r.role === "worker")!.thread;
    const said = parent.view.own.search("password SPRUCE").filter((h) => h.id.startsWith("e:"));
    const original = said.filter((h) => h.snippet.includes("The password is SPRUCE"));
    expect(original.map((h) => h.id)).toEqual([expect.stringMatching(new RegExp(`^e:${parent.threadId}#`))]);
    const copied = parent.view.own.entryPage(forkThread, { limit: 1000 }).entries.length - (parent.view.own.sleepMaterial(undefined, "9999").threads.find((t) => t.id === forkThread)?.entries ?? 0);
    expect(copied).toBeGreaterThan(0);
    const material = parent.view.own.sleepMaterial(undefined, "9999").threads.find((t) => t.id === forkThread)!;
    expect(Number(material.first.split("#")[1])).toBeGreaterThan(copied);

    // A fork of a private or local-only conversation runs on local models, now and when continued.
    s.local.respond((r) => ({ text: JSON.stringify(r.messages).includes("HEMLOCK") ? "local fork knows HEMLOCK" : "local" }));
    for (const restricted of [s.thread("private"), s.thread("general", { localOnly: true })]) {
      const q = await s.open(restricted);
      try { await q.session.prompt("The other password is HEMLOCK."); } finally { q.dispose(); }
      const run = await s.run(restricted, { task: "recall it", fork: true });
      expect(run.result).toBe("local fork knows HEMLOCK");
      const [row] = s.delegation.status(restricted);
      expect(s.models.callContext(s.ada.id, restricted.pool, row!.thread).localOnly).toBe(true);
      if (restricted.pool === "general") s.models.setLocalOnly(s.ada.id, "general", restricted.threadId, false);
      const again = s.delegation.message(restricted, run.id, { text: "once more" }, { budget: s.delegation.newBudget() });
      await again.opened;
      await again.run.checkpoint();
      expect(again.run.result).toBe("local fork knows HEMLOCK");
    }
    expect(JSON.stringify(s.cloud.requests)).not.toContain("HEMLOCK");
  });

  it("offers message, and no longer steer or answer", async () => {
    const s = await setup();
    const parent = s.thread();
    const p = await s.open(parent);
    try {
      await p.session.prompt("hello");
    } finally {
      p.dispose();
    }
    const tool = JSON.stringify(s.cloud.requests[0]!.tools!.find((t) => t.function.name === "delegate"));
    expect(tool).toContain("Only these granted host folders");
    expect(tool).toContain("omit folders to read the parent's checkouts; scouts see them read-only");
    expect(tool).toContain('"message"');
    expect(tool).not.toContain('"steer"');
    expect(tool).not.toContain('"answer"');
  });

  it("asks before a writer's commands where its parent asks, and refuses on deny or stop", async () => {
    const scratch = tempDir();
    const target: ExecutionTarget = { name: "sandbox", cwd: async () => scratch, ops: () => ({ bash: createLocalBashOperations() } as unknown as ToolOps), folders: () => [] };
    let answer: (r: { tool: string; role: string; threadId: string; runId: string; input: Record<string, unknown> }) => Promise<boolean> = async () => true;
    const asked: { tool: string; role: string; threadId: string; parentThreadId: string; runId: string }[] = [];
    let ws!: Workspace;
    const s = await setup({
      workspace: (m) => (ws = new (class extends Workspace { override targetFor(_t: WorkspaceThread) { return target; } })(m.keyring, m.users, { excludePorts: [] })),
      approve: async (r, signal) => {
        asked.push(r);
        if (signal.aborted) return false;
        return answer(r);
      },
    });
    s.cloud.respond((r) => {
      if (r.messages.at(-1)!.role === "tool") return { text: `result: ${said(r.messages.at(-1)!)}` };
      return { tools: [{ name: "bash", args: { command: `echo hi > ${told(r)}.txt` } }] };
    });
    const parent = s.thread();
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { mode: "acceptEdits" });

    const allowed = await s.run(parent, { task: "yes", role: "worker" });
    expect(allowed.status).toBe("finished");
    expect(existsSync(join(scratch, "yes.txt"))).toBe(true);
    expect(asked).toEqual([expect.objectContaining({ tool: "bash", role: "worker", runId: allowed.id, parentThreadId: parent.threadId, threadId: s.delegation.status(parent)[0]!.thread })]);

    answer = async () => false;
    const denied = await s.run(parent, { task: "no", role: "worker" });
    expect(denied.result).toContain("Not approved");
    expect(existsSync(join(scratch, "no.txt"))).toBe(false);

    // Writers working side by side each ask for their own calls, named by thread.
    const pair = await s.run(parent, { tasks: [{ task: "left" }, { task: "right" }] });
    expect(pair.status).toBe("finished");
    expect(new Set(asked.slice(2).map((r) => r.threadId)).size).toBe(2);
    asked.splice(2);

    // Stopped while it waits: that call is refused, and nothing runs.
    answer = () => new Promise(() => {});
    const waiting = s.delegation.start(parent, { task: "stop", role: "worker" }, { background: true, budget: s.delegation.newBudget() });
    await until(() => asked.length === 3);
    waiting.stop();
    await waiting.ended;
    expect(waiting.status).toBe("stopped");
    expect(existsSync(join(scratch, "stop.txt"))).toBe(false);

    // In "auto", nothing is asked.
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { mode: "auto" });
    await s.run(parent, { task: "auto", role: "worker" });
    expect(asked).toHaveLength(3);
    expect(existsSync(join(scratch, "auto.txt"))).toBe(true);
  });

  it("starts only read-only roles from a thread in Plan mode, and they only read", async () => {
    const scratch = tempDir();
    const target: ExecutionTarget = { name: "sandbox", cwd: async () => scratch, ops: () => ({ bash: createLocalBashOperations() } as unknown as ToolOps), folders: () => [] };
    let ws!: Workspace;
    const s = await setup({ workspace: (m) => (ws = new (class extends Workspace { override targetFor(_t: WorkspaceThread) { return target; } })(m.keyring, m.users, { excludePorts: [] })) });
    s.cloud.respond((r) => {
      if (r.messages.at(-1)!.role === "tool") return { text: `result: ${said(r.messages.at(-1)!)}` };
      return { tools: [{ name: "bash", args: { command: "echo hi > scout.txt" } }] };
    });
    const parent = s.thread();
    ws.settings(s.ada.id).setThread(parent.threadId, "general", { mode: "plan" });

    const writer = await s.run(parent, { task: "change it", role: "worker" });
    expect(writer.status).toBe("failed");
    expect(writer.result).toContain("Plan mode");
    expect(parent.view.own.listThreads({ parent: parent.threadId })).toHaveLength(0);

    const scout = await s.run(parent, { task: "look", role: "scout" });
    expect(scout.status).toBe("finished");
    // The scout's bash is off in Plan mode: it wasn't offered, and nothing ran.
    const sub = s.cloud.requests.filter(isSub)[0]!;
    expect(sub.tools!.map((t) => t.function.name).sort()).toEqual(["ask_parent", "read", "read_memory", "recall"]);
    expect(existsSync(join(scratch, "scout.txt"))).toBe(false);
  });
});

