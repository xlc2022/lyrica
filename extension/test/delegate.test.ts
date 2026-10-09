import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Memory, PRONOUN_PRESETS, Workspace, type ExecutionTarget, type Persona, type Pool, type ToolOps, type WorkspaceThread } from "@lyrica/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatRequest } from "../../core/test/fake-openai.ts";
import { withModels } from "../../core/test/helpers.ts";
import {
  createDelegateExtension, createLyricaExtension, Delegation, openThreadSession,
  type DelegationEvent, type Limits, type Request, type ThreadContext,
} from "../src/index.ts";

// Delegation against fake model servers: Li's cloud endpoint ("openrouter")
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

/** Li with cloud subagent models, a Memory, and a Delegation over them. */
async function setup(o: { limits?: Partial<Limits>; workspace?: (m: Awaited<ReturnType<typeof withModels>>) => Workspace } = {}) {
  const m = await withModels();
  for (const task of ["chat", "subagent.cheap", "subagent.strong"] as const) m.models.setProfile(m.li.id, "cloud", task, m.cloudRef);
  m.models.setProfile(m.li.id, "local", "chat", m.localRef);
  const memory = new Memory(m.keyring, m.users);
  const cwd = tempDir();
  const workspace = o.workspace?.(m);
  const options = { users: m.users, memory, models: m.models, cwd, limits: o.limits, workspace };
  const delegation = new Delegation(options);
  const thread = (pool: Pool = "general", t: { localOnly?: boolean; unlogged?: boolean } = {}): ThreadContext => {
    const view = memory.openThreadView(m.li.id, pool);
    const { id } = view.own.createThread({ interface: "cli", unlogged: t.unlogged });
    if (t.localOnly) m.models.setLocalOnly(m.li.id, pool, id, true);
    return { user: m.li, pool, interface: "cli", threadId: id, view, call: m.models.callContext(m.li.id, pool, id) };
  };
  const open = (t: ThreadContext) => openThreadSession({
    thread: t, models: m.models, cwd,
    extensions: [
      createLyricaExtension(t, { persona: () => persona, profile: () => ({ displayName: "Li", pronouns: PRONOUN_PRESETS.she, previousNames: [] }) }),
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
  it("gives a subagent of a private or local-only thread only a local model", async () => {
    const s = await setup();
    s.local.respond(() => ({ text: "checked locally" }));
    for (const parent of [s.thread("private"), s.thread("general", { localOnly: true })]) {
      const run = await s.run(parent, { task: "check the list", tier: "strong" });
      expect(run.status).toBe("finished");
      expect(run.result).toBe("checked locally");
      // Naming a cloud model is refused before any thread is made.
      const named = await s.run(parent, { task: "check it", model: `openrouter/${s.cloudRef.modelId}` });
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
      for (const d of ["a", "b"]) ws.allowedPaths.allow(m.li, m.li.id, "general", join(host, d));
      return ws;
    } });
    const parent = s.thread();
    ws.settings(s.li.id).setThread(parent.threadId, "general", { grants: [{ path: join(host, "a"), writable: true }], internet: false, hosts: ["10.0.0.5"], mode: "ask-commands" });

    const outside = await s.run(parent, { task: "read there", role: "scout", folders: [join(host, "b")] });
    expect(outside.status).toBe("failed");
    expect(outside.result).toContain("isn't one of this thread's folders");
    // A subagent can't ask for approval yet, so no writer where the parent asks first.
    const asks = await s.run(parent, { task: "change it", role: "worker" });
    expect(asks.result).toContain("this thread asks before commands");

    await s.run(parent, { task: "look", role: "scout" });
    ws.settings(s.li.id).setThread(parent.threadId, "general", { mode: "auto" });
    await s.run(parent, { task: "change it", role: "worker" });
    const [worker, scout] = s.delegation.status(parent);
    const child = (thread: string) => ({ ...ws.settings(s.li.id).thread(thread), network: ws.network({ userId: s.li.id, pool: "general", threadId: thread }) });
    expect(child(scout!.thread)).toMatchObject({ grants: [{ path: join(host, "a"), writable: false }], mode: "ask-commands", parent: parent.threadId, network: { internet: false, services: false, hosts: ["10.0.0.5"] } });
    expect(child(worker!.thread)).toMatchObject({ grants: [{ path: join(host, "a"), writable: true }], network: { internet: false, hosts: ["10.0.0.5"] } });
    // Anything wider is refused by the workspace itself.
    const p = { userId: s.li.id, pool: "general" as const, threadId: parent.threadId };
    expect(() => ws.inheritSettings(p, worker!.thread, { internet: true })).toThrow("no internet");
    expect(() => ws.inheritSettings(p, worker!.thread, { hosts: ["10.0.0.6"] })).toThrow("isn't in the parent thread's hosts");
  });

  it("runs parallel tasks within the concurrency limit, and counts their tokens", async () => {
    const s = await setup({ limits: { concurrency: 2 } });
    let working = 0;
    let most = 0;
    s.cloud.respond(async (r) => {
      most = Math.max(most, ++working);
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
    const run = await s.run(s.thread(), { council: { question: "What should I plant?", models: [`openrouter/${s.cloudRef.modelId}`, "gpu/qwen3.8-27b"] } });
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
      ws.allowedPaths.allow(m.li, m.li.id, "general", repo);
      ws.allowedPaths.allow(m.li, m.li.id, "general", plain);
      return ws;
    } });
    let working = 0;
    let most = 0;
    s.cloud.respond(async () => { most = Math.max(most, ++working); await sleep(30); working--; return { text: "changed" }; });

    const parent = s.thread();
    ws.settings(s.li.id).setThread(parent.threadId, "general", { grants: [{ path: repo, writable: true }] });
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
    expect(writers.map((r) => ws.settings(s.li.id).thread(r.thread).grants)).toEqual([[{ path: `${repo}/.git`, writable: true }], [{ path: `${repo}/.git`, writable: true }]]);
    const tasks = s.cloud.requests.map(told).filter((t) => t.startsWith("change"));
    expect(tasks.filter((t) => t.includes(trees[0]!))).toHaveLength(1);
    expect(tasks.filter((t) => t.includes(trees[1]!))).toHaveLength(1);

    // Not a git repository: the writers take turns.
    const other = s.thread();
    ws.settings(s.li.id).setThread(other.threadId, "general", { grants: [{ path: plain, writable: true }] });
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
    const child: ThreadContext = { ...parent, threadId: row!.thread, call: s.models.callContext(s.li.id, "general", row!.thread) };
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
    after.recover(s.li.id);
    expect(after.status(parent)[0]).toMatchObject({ run: run.id, status: "interrupted" });
    expect(events).toEqual([expect.objectContaining({ type: "interrupted", runId: run.id, parentThreadId: parent.threadId })]);
    expect(JSON.stringify(parent.view.own.loadEntries(parent.threadId))).toContain(`Subagent run ${run.id} was interrupted`);
    run.stop();
    g.open();
  });

  it("runs a saved workflow by name, with custom roles", async () => {
    const s = await setup();
    s.delegation.store.setRole(s.li.id, { name: "poet", description: "Writes verse.", prompt: "You write short poems.", tier: "cheap", tools: [], readOnly: true, thinking: "low" });
    s.delegation.store.setWorkflow(s.li.id, { name: "verse", description: "A poem, then a check.", spec: { chain: [{ task: "A poem about {input}", role: "poet" }, { task: "Check: {previous}", role: "reviewer" }] } });
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
    s.models.setLocalOnly(s.li.id, "general", parent.threadId, true);
    g.open();
    await chain.checkpoint();
    expect(chain.result).toBe("local step");
    expect(s.local.requests).toHaveLength(1);

    // A cloud subagent waiting on an answer is stopped, and never sees it.
    for (const change of ["local-only", "unlogged"] as const) {
      const p = s.thread();
      const run = await s.run(p, { task: "pick" }, true);
      expect(run.status).toBe("question");
      if (change === "local-only") s.models.setLocalOnly(s.li.id, "general", p.threadId, true);
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
    await s.delegation.forget(s.li.id, "general", parent.threadId);
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
    expect(() => after.recover(s.li.id)).not.toThrow();
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
