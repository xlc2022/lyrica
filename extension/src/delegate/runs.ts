import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentSession, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  DelegationStore, LIVE_STATUSES, parseRef, refString,
  type CouncilSpec, type Grant, type LoopSpec, type Memory, type ModelRef, type Models, type Pool, type PoolStore, type Role,
  type Step, type SubagentRecord, type SubagentStatus, type Tier, type Usage, type Users, type Workflow, type WorkflowSpec, type Workspace,
} from "@lyrica/core";
import type { ThreadContext } from "../index.ts";
import { toStoredEntry } from "../record.ts";
import { openThreadSession } from "../session.ts";
import { createWorkspaceExtension } from "../workspace.ts";
import { rolesFor } from "./roles.ts";
import { createDelegateExtension, createSubagentExtension } from "./tool.ts";
import { makeWorktrees, worktreeGrants, worktreeNote, type Worktree } from "./worktree.ts";

// Runs: one delegate call each, with one or more subagents. A subagent is a
// Pi session in this process, on a thread of its own under the parent's.

export interface Limits {
  /** How deep subagents may nest: 1 means subagents can't delegate. At most 3. */
  depth: number;
  /** Subagents working at once per parent thread. More wait their turn. */
  concurrency: number;
  /** Subagents one request (one message to the parent) may start. */
  runsPerRequest: number;
  /** Longest a subagent may work on one stretch, in milliseconds. Time waiting for an answer doesn't count. */
  timeoutMs: number;
}
export const DEFAULT_LIMITS: Limits = { depth: 1, concurrency: 2, runsPerRequest: 8, timeoutMs: 15 * 60_000 };

export type DelegateWorkspace = Pick<Workspace, "inheritSettings" | "forThread" | "settings">;

export interface DelegationOptions {
  users: Users;
  memory: Memory;
  models: Models;
  /** Where subagents' file and command tools run. Without it, subagents have memory tools only. */
  workspace?: DelegateWorkspace;
  /** Pi's working directory for subagent sessions. Nothing is discovered from it. */
  cwd: string;
  limits?: Partial<Limits>;
}

/** Narrowing that applies to every subagent of a run. Nothing here can widen the parent's settings. */
export interface Narrowing { folders?: string[]; readOnly?: boolean; internet?: false }

export type Request = Narrowing & (
  | Step
  | { tasks: Step[] }
  | { chain: Step[] }
  | { loop: LoopSpec }
  | { council: CouncilSpec }
  | { workflow: string; input?: string }
);

// --- Events ---

/** Which run and subagent thread an event is about, and where its parent lives. */
export interface RunRef { userId: string; pool: Pool; parentThreadId: string; runId: string; threadId: string }
export type DelegationEvent =
  | (RunRef & { type: "started"; role: string; model: string; title: string })
  | (RunRef & { type: "output"; delta: string })
  | (RunRef & { type: "tool_call"; toolName: string; args: unknown })
  | (RunRef & { type: "question"; question: string })
  | (RunRef & { type: "finished"; status: "finished" | "failed" })
  | (RunRef & { type: "stopped"; reason: "stopped" | "timeout" })
  | (RunRef & { type: "interrupted" })
  | (RunRef & { type: "usage" } & Usage);
type EventMap = { [K in DelegationEvent["type"]]: [Extract<DelegationEvent, { type: K }>] } & { event: [DelegationEvent] };

/** Every delegation event, by type and all together on "event", for lyricad to forward over SSE. */
export class DelegationEvents extends EventEmitter<EventMap> {
  send(e: DelegationEvent): void {
    const emit = this.emit.bind(this) as (type: string, e: DelegationEvent) => boolean;
    emit(e.type, e);
    emit("event", e);
  }
}

// --- Plumbing ---

export class Stopped extends Error {}

/** A counting lock: at most `max` holders, the rest wait in order. */
class Slots {
  private used = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.used >= this.max) {
      if (signal.aborted) throw new Stopped("stopped");
      await new Promise<void>((resolve) => {
        const wake = () => { signal.removeEventListener("abort", wake); resolve(); };
        this.waiting.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal.aborted) throw new Stopped("stopped");
    this.used++;
    let held = true;
    return () => { if (held) { held = false; this.used--; this.waiting.shift()?.(); } };
  }
}

/** A message for the parent thread. Returns false if it couldn't be delivered live. */
export type Deliver = (message: { content: string; details: unknown }) => boolean;

const threadKey = (userId: string, pool: Pool, threadId: string) => `${userId}/${pool}/${threadId}`;
const lastText = (s: AgentSession) => s.getLastAssistantText()?.trim() ?? "";

export const DELEGATE_MESSAGE = "lyrica-delegate";

/** One subagent: its thread, its session, and what it has cost. */
export class Subagent {
  status: SubagentStatus = "running";
  question?: string;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
  private stopReason?: "stopped" | "timeout";
  private release?: () => void;

  constructor(
    private readonly d: Delegation, readonly run: Run, readonly ctx: ThreadContext, readonly role: Role, readonly model: string,
    readonly session: AgentSession, private readonly dispose: () => void, readonly worktrees: Worktree[],
  ) {
    session.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") this.emit({ type: "output", delta: e.assistantMessageEvent.delta });
      else if (e.type === "tool_execution_start") this.emit({ type: "tool_call", toolName: e.toolName, args: e.args });
      else if (e.type === "message_end" && e.message.role === "assistant") {
        const u = e.message.usage;
        this.usage.inputTokens += u.input + u.cacheRead + u.cacheWrite;
        this.usage.outputTokens += u.output;
        this.usage.cost += u.cost.total;
        this.emit({ type: "usage", ...this.usage });
      }
    });
  }

  get ref(): RunRef {
    return { userId: this.ctx.user.id, pool: this.ctx.pool, parentThreadId: this.run.parent.threadId, runId: this.run.id, threadId: this.ctx.threadId };
  }

  emit(e: DistributiveOmit<DelegationEvent, keyof RunRef>): void { this.d.events.send({ ...this.ref, ...e } as DelegationEvent); }

  hold(release: () => void): void { this.release = release; }
  async reacquire(): Promise<void> { this.release = await this.d.slot(this.run).acquire(this.run.abort.signal); }
  free(): void { this.release?.(); this.release = undefined; }

  /** One stretch of work. Returns the subagent's reply, or its question with status "question". */
  async turn(text: string): Promise<string> {
    this.set("running");
    this.question = undefined;
    const timer = setTimeout(() => this.stop("timeout"), this.d.limits.timeoutMs);
    try {
      await this.session.prompt(text);
    } finally {
      clearTimeout(timer);
    }
    if (this.stopReason) throw new Stopped(this.stopReason === "timeout" ? `timed out after ${Math.round(this.d.limits.timeoutMs / 1000)} s` : "stopped");
    if (this.question !== undefined) {
      this.set("question");
      this.emit({ type: "question", question: this.question });
      return this.question;
    }
    const last = this.session.messages.findLast((m) => m.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
    const reply = lastText(this.session);
    if (last?.stopReason === "error" || (!reply && last?.errorMessage)) throw new Error(`the subagent's model failed: ${last.errorMessage ?? "unknown error"}`);
    return reply || "(The subagent finished without a reply.)";
  }

  stop(reason: "stopped" | "timeout"): void {
    if (LIVE_STATUSES.includes(this.status) && !this.stopReason) {
      this.stopReason = reason;
      void this.session.abort();
    }
  }

  steer(text: string): void {
    if (this.status !== "running" || !this.session.isStreaming) throw new Error("that subagent isn't working right now");
    void this.session.steer(text);
  }

  /** Ends the subagent: records its status and usage, and closes its session and view. */
  close(status: "finished" | "failed" | "stopped"): void {
    if (!LIVE_STATUSES.includes(this.status)) return;
    this.set(status === "stopped" || this.stopReason ? "stopped" : status);
    this.free();
    this.dispose();
    this.ctx.view.close();
    if (this.status === "stopped") this.emit({ type: "stopped", reason: this.stopReason ?? "stopped" });
    else this.emit({ type: "finished", status: this.status as "finished" | "failed" });
  }

  private set(status: SubagentStatus): void {
    this.status = status;
    this.d.store.update(this.ctx.user.id, this.ctx.pool, this.ctx.threadId, { status, usage: this.usage });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RunStatus = "running" | "question" | "finished" | "failed" | "stopped";

/** One delegate call and the subagents it started. */
export class Run {
  readonly id = `d-${randomBytes(4).toString("hex")}`;
  status: RunStatus = "running";
  result = "";
  readonly subagents: Subagent[] = [];
  readonly abort = new AbortController();
  /** Set once a tool call has handed her the outcome, so it isn't delivered again. */
  delivered = false;
  /** Settles once the run has ended and its subagents are closed. */
  ended: Promise<void> = Promise.resolve();
  private readonly asking: { sub: Subagent; answer: (text: string) => void; fail: (err: Error) => void }[] = [];
  private waiters: (() => void)[] = [];

  constructor(readonly parent: ThreadContext, readonly background: boolean, readonly budget: { left: number }) {}

  get done(): boolean { return this.status !== "running" && this.status !== "question"; }
  get questions(): { sub: Subagent; question: string }[] { return this.asking.map((a) => ({ sub: a.sub, question: a.sub.question ?? "" })); }

  /** Resolves when the run has a question or has ended. */
  checkpoint(signal?: AbortSignal): Promise<void> {
    if (this.status !== "running") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Stopped("stopped"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(() => { signal?.removeEventListener("abort", onAbort); resolve(); });
    });
  }

  set(status: RunStatus, result?: string): void {
    this.status = status;
    if (result !== undefined) this.result = result;
    if (status !== "running") for (const w of this.waiters.splice(0)) w();
  }

  /** Waits for `answer` on a subagent's question. */
  waitForAnswer(sub: Subagent): Promise<string> {
    return new Promise((answer, fail) => {
      this.asking.push({ sub, answer, fail });
      this.set("question");
    });
  }

  answer(text: string): void {
    const next = this.asking.shift();
    if (!next) throw new Error(`run ${this.id} has no question waiting`);
    if (!this.asking.length) this.set("running");
    next.answer(text);
  }

  stop(): void {
    this.abort.abort();
    for (const a of this.asking.splice(0)) a.fail(new Stopped("stopped"));
    for (const s of this.subagents) s.stop("stopped");
  }
}

type ModelPick = { tier: Tier } | { model: ModelRef };

/**
 * Delegation for one lyricad: every run in this process, the limits, the
 * events, and delivery of background results into parent threads.
 */
export class Delegation {
  readonly events = new DelegationEvents();
  readonly store: DelegationStore;
  readonly limits: Limits;
  private readonly live = new Map<string, Run>();
  private readonly slots = new Map<string, Slots>();
  private readonly parents = new Map<string, Deliver>();
  private readonly recovered = new Set<string>();

  constructor(private readonly o: DelegationOptions) {
    this.store = new DelegationStore(o.users);
    const limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.limits = { ...limits, depth: Math.max(1, Math.min(3, limits.depth)) };
  }

  roles(userId: string): Role[] { return rolesFor(this.store.roles(userId)); }

  role(userId: string, name: string | undefined, fallback: string): Role {
    const role = this.roles(userId).find((r) => r.name === (name ?? fallback));
    if (!role) throw new Error(`no role ${name}; roles are ${this.roles(userId).map((r) => r.name).join(", ")}`);
    return role;
  }

  workflows(userId: string): Workflow[] { return this.store.workflows(userId); }

  /** How many subagent threads sit above this one. */
  depth(thread: ThreadContext): number {
    let n = 0;
    for (let t = thread.view.own.getThread(thread.threadId); t?.subagent && t.parent; t = thread.view.own.getThread(t.parent)) n++;
    return n;
  }

  newBudget(): { left: number } { return { left: this.limits.runsPerRequest }; }

  /** Lets a live parent session take its runs' results. Returns the detach function. */
  attach(thread: ThreadContext, deliver: Deliver): () => void {
    const key = threadKey(thread.user.id, thread.pool, thread.threadId);
    this.parents.set(key, deliver);
    return () => { if (this.parents.get(key) === deliver) this.parents.delete(key); };
  }

  get(thread: ThreadContext, id: string | undefined): Run {
    const run = id && this.live.get(id);
    if (!run || run.parent.user.id !== thread.user.id || run.parent.pool !== thread.pool || run.parent.threadId !== thread.threadId) {
      const past = id ? this.store.runs(thread.user.id, thread.pool, { run: id }).filter((r) => r.parent === thread.threadId) : [];
      throw new Error(past.length ? `run ${id} has ended (${past[0]!.status})` : `no run ${id ?? "(no id given)"} in this thread`);
    }
    return run;
  }

  /** This thread's subagents, newest first, from the records. */
  status(thread: ThreadContext): SubagentRecord[] {
    return this.store.runs(thread.user.id, thread.pool, { parent: thread.threadId });
  }

  usage(thread: Pick<ThreadContext, "user" | "pool" | "threadId">): Usage { return this.store.usage(thread.user.id, thread.pool, thread.threadId); }

  /**
   * Starts a run. It works in the background of this process either way; a
   * foreground tool call waits on `checkpoint`. A background run's result, or
   * question, is delivered into the parent thread.
   */
  start(parent: ThreadContext, req: Request, opts: { background: boolean; budget: { left: number } }): Run {
    this.recover(parent.user.id);
    if (this.depth(parent) >= this.limits.depth) throw new Error(`subagents can't start subagents of their own here (depth limit ${this.limits.depth})`);
    const run = new Run(parent, opts.background, opts.budget);
    this.live.set(run.id, run);
    run.ended = this.execute(run, req).then(
      (result) => run.set("finished", result),
      (err: Error) => run.set(err instanceof Stopped || run.abort.signal.aborted ? "stopped" : "failed", err.message),
    ).finally(() => {
      for (const s of run.subagents) s.close(run.status === "stopped" ? "stopped" : "failed");
      this.live.delete(run.id);
      // A user locked meanwhile can't be told; the run's records still say how it ended.
      if (run.background && !run.delivered) try { this.deliver(run.parent, outcome(run), { runId: run.id, status: run.status }); } catch { /* locked */ }
    });
    return run;
  }

  /** Stops every live run, or one user's, and waits until they have ended. For Lock and shutdown. */
  async stopAll(userId?: string): Promise<void> {
    const runs = [...this.live.values()].filter((r) => !userId || r.parent.user.id === userId);
    for (const r of runs) r.stop();
    await Promise.all(runs.map((r) => r.ended));
  }

  /** Marks runs that a restart left behind as interrupted, and tells their parent threads. Once per user per process. */
  recover(userId: string): void {
    if (this.recovered.has(userId)) return;
    this.recovered.add(userId);
    const rows = this.store.interrupt(userId, (run) => this.live.has(run));
    const byRun = new Map<string, SubagentRecord[]>();
    for (const r of rows) byRun.set(r.run, [...(byRun.get(r.run) ?? []), r]);
    for (const [runId, list] of byRun) {
      const { pool, parent } = list[0]!;
      for (const r of list) this.events.send({ type: "interrupted", userId, pool, parentThreadId: parent, runId, threadId: r.thread });
      const threads = list.map((r) => `t:${r.thread}`).join(", ");
      this.deliverTo(userId, pool, parent, `Subagent run ${runId} was interrupted when Lyrica restarted, and didn't finish. Its threads are kept: ${threads}.`, { runId, status: "interrupted" });
    }
  }

  slot(run: Run): Slots {
    const key = threadKey(run.parent.user.id, run.parent.pool, run.parent.threadId);
    let s = this.slots.get(key);
    if (!s) this.slots.set(key, (s = new Slots(this.limits.concurrency)));
    return s;
  }

  // --- Delivery ---

  deliver(parent: ThreadContext, content: string, details: unknown): void {
    this.deliverTo(parent.user.id, parent.pool, parent.threadId, content, details);
  }

  /** Into the live parent session if there is one, else straight into the parent's stored thread, for its next session. */
  private deliverTo(userId: string, pool: Pool, threadId: string, content: string, details: unknown): void {
    const live = this.parents.get(threadKey(userId, pool, threadId));
    if (live?.({ content, details })) return;
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      appendMessage(view.own, threadId, content, details);
    } finally {
      view.close();
    }
  }

  // --- Running ---

  private async execute(run: Run, req: Request): Promise<string> {
    const narrowing: Narrowing = { folders: req.folders, readOnly: req.readOnly, internet: req.internet };
    if ("workflow" in req) {
      const w = this.workflows(run.parent.user.id).find((x) => x.name === req.workflow);
      if (!w) throw new Error(`no workflow ${req.workflow}`);
      return this.execute(run, { ...narrowing, ...withInput(w.spec, req.input ?? "") } as Request);
    }
    if ("tasks" in req) return this.parallel(run, req.tasks, narrowing);
    if ("chain" in req) return this.chain(run, req.chain, narrowing);
    if ("loop" in req) return this.loop(run, req.loop, narrowing);
    if ("council" in req) return this.council(run, req.council, narrowing);
    return this.single(run, req, narrowing);
  }

  private async single(run: Run, step: Step, narrowing: Narrowing, worktrees: Worktree[] = []): Promise<string> {
    const sub = await this.spawn(run, step, narrowing, worktrees);
    try {
      const reply = await this.ask(sub, withWorktrees(step.task, worktrees));
      sub.close("finished");
      return worktrees.length ? `${reply}\n\nChanges are in its own worktrees:\n${worktreeNote(worktrees)}` : reply;
    } catch (err) {
      sub.close(err instanceof Stopped ? "stopped" : "failed");
      throw err;
    }
  }

  /** Sends text and keeps going through any questions, until the subagent replies. */
  private async ask(sub: Subagent, text: string): Promise<string> {
    let reply = await sub.turn(text);
    while (sub.status === "question") {
      sub.free();
      if (sub.run.background) this.deliver(sub.run.parent, `Subagent run ${sub.run.id} (${sub.role.name}, t:${sub.ctx.threadId}) asks:\n${reply}\n\nAnswer with delegate({ action: "answer", id: "${sub.run.id}", message: … }).`, { runId: sub.run.id, status: "question" });
      const answer = await sub.run.waitForAnswer(sub);
      await sub.reacquire();
      reply = await sub.turn(answer);
    }
    return reply;
  }

  private async parallel(run: Run, steps: Step[], narrowing: Narrowing): Promise<string> {
    if (!steps.length) throw new Error("tasks is empty");
    const roles = steps.map((s) => this.role(run.parent.user.id, s.role, "worker"));
    const writes = roles.map((r) => !r.readOnly && !narrowing.readOnly);
    const writers = writes.filter(Boolean).length;
    let worktrees: Worktree[][] | undefined;
    if (writers > 1 && this.o.workspace) {
      const t = { userId: run.parent.user.id, pool: run.parent.pool, threadId: run.parent.threadId };
      worktrees = await makeWorktrees(this.o.workspace.forThread(t).target(), this.grants(run, narrowing), run.id, writers, run.abort.signal);
    }
    const oneWriter = writers > 1 && !worktrees ? new Slots(1) : undefined;
    let w = 0;
    const results = await Promise.allSettled(steps.map(async (step, i) => {
      const mine = writes[i] && worktrees ? worktrees[w++]! : [];
      const release = writes[i] && oneWriter ? await oneWriter.acquire(run.abort.signal) : undefined;
      try {
        return await this.single(run, step, narrowing, mine);
      } finally {
        release?.();
      }
    }));
    if (run.abort.signal.aborted) throw new Stopped("stopped");
    return results.map((r, i) => `## ${i + 1}. ${roles[i]!.name}: ${steps[i]!.task.split("\n")[0]!.slice(0, 80)}\n${r.status === "fulfilled" ? r.value : `Failed: ${(r.reason as Error).message}`}`).join("\n\n");
  }

  private async chain(run: Run, steps: Step[], narrowing: Narrowing): Promise<string> {
    if (!steps.length) throw new Error("chain is empty");
    let previous = "";
    for (const [i, step] of steps.entries()) {
      const task = i === 0 ? step.task.replaceAll("{previous}", "")
        : step.task.includes("{previous}") ? step.task.replaceAll("{previous}", previous) : `${step.task}\n\nThe previous step's result:\n${previous}`;
      previous = await this.single(run, { ...step, task }, narrowing);
    }
    return previous;
  }

  private async loop(run: Run, spec: LoopSpec, narrowing: Narrowing): Promise<string> {
    const rounds = Math.max(1, Math.min(5, spec.rounds ?? 3));
    const worker = await this.spawn(run, { task: spec.task, role: spec.worker ?? "worker" }, narrowing);
    let reviewer: Subagent | undefined;
    try {
      let work = await this.ask(worker, spec.task);
      reviewer = await this.spawn(run, { task: `Review: ${spec.task}`, role: spec.reviewer ?? "reviewer" }, narrowing);
      let review = "";
      let round = 1;
      for (; ; round++) {
        review = await this.ask(reviewer, round === 1 ? reviewTask(spec.task, work) : `The worker revised the result:\n\n${work}\n\nReview it again. ${VERDICT}`);
        if (approved(review) || round === rounds) break;
        work = await this.ask(worker, `A reviewer asked for changes:\n\n${review}\n\nMake them, then reply with the revised result in full.`);
      }
      worker.close("finished");
      reviewer.close("finished");
      const verdict = approved(review) ? `approved in round ${round}` : `not approved after ${rounds} rounds`;
      return `${work}\n\n---\nReview (${verdict}):\n${review}`;
    } catch (err) {
      for (const s of [worker, reviewer]) s?.close(err instanceof Stopped ? "stopped" : "failed");
      throw err;
    }
  }

  private async council(run: Run, spec: CouncilSpec, narrowing: Narrowing): Promise<string> {
    const refs = spec.models?.length ? spec.models.map(parseRef) : this.councilModels(run.parent);
    const answers = await Promise.allSettled(refs.map((ref) => this.single(run, { task: spec.question, role: "oracle", model: refString(ref) }, narrowing)));
    if (run.abort.signal.aborted) throw new Stopped("stopped");
    const got = answers.map((a, i) => ({ model: refString(refs[i]!), text: a.status === "fulfilled" ? a.value : undefined })).filter((a) => a.text !== undefined);
    if (!got.length) throw new Error(`no member of the council answered: ${(answers.find((a) => a.status === "rejected") as PromiseRejectedResult).reason.message}`);
    const listed = got.map((a, i) => `<answer n="${i + 1}" model="${a.model}">\n${a.text}\n</answer>`).join("\n\n");
    const synthesis = await this.single(run, {
      task: `Several advisers answered the same question independently. Combine their answers into one: where they agree, where they differ and who is more likely right, and your recommendation.\n\nQuestion:\n${spec.question}\n\n${listed}`,
      role: "oracle", tier: "strong",
    }, narrowing);
    return `${synthesis}\n\n---\nCouncil: ${got.map((a) => a.model).join(", ")}`;
  }

  /** Up to three distinct models: the thread's subagent models first, then others it allows. */
  private councilModels(parent: ThreadContext): ModelRef[] {
    const { models } = this.o;
    const picks: ModelRef[] = [];
    for (const task of ["subagent.strong", "subagent.cheap", "chat"] as const) {
      try { picks.push(models.resolveModel(task, parent.call)); } catch { /* not set */ }
    }
    for (const { endpoint, models: list } of models.allowed(parent.call)) for (const m of list) if (m.tools !== false) picks.push({ endpointId: endpoint.id, modelId: m.modelId });
    const seen = new Set<string>();
    return picks.filter((r) => !seen.has(refString(r)) && !!seen.add(refString(r))).slice(0, 3);
  }

  /** The parent's grants, narrowed to `folders` if given. */
  private grants(run: Run, narrowing: Narrowing): Grant[] {
    const from = this.o.workspace!.settings(run.parent.user.id).thread(run.parent.threadId).grants;
    if (!narrowing.folders) return from;
    return narrowing.folders.map((path) => {
      const outer = from.find((g) => path === g.path || path.startsWith(`${g.path}/`));
      if (!outer) throw new Error(`${path} isn't one of this thread's folders`);
      return { path, writable: outer.writable };
    });
  }

  /** A new subagent: its thread, model, workspace and session. Waits for a free slot first. */
  private async spawn(run: Run, step: Step, narrowing: Narrowing, worktrees: Worktree[] = []): Promise<Subagent> {
    const { parent } = run;
    const { models, workspace } = this.o;
    const role = this.role(parent.user.id, step.role, "worker");
    const pick: ModelPick = step.model ? { model: parseRef(step.model) } : { tier: step.tier ?? role.tier };
    // Refuse a model before anything is written.
    if ("tier" in pick) models.resolveModel(`subagent.${pick.tier}`, parent.call);
    else if (!models.allowed(parent.call).some((a) => a.endpoint.id === pick.model.endpointId && a.models.some((m) => m.modelId === pick.model.modelId))) {
      throw new Error(`${step.model} isn't one of this thread's models`);
    }
    if (run.budget.left <= 0) throw new Error(`this request has already started ${this.limits.runsPerRequest} subagents`);
    run.budget.left--;
    const release = await this.slot(run).acquire(run.abort.signal);
    const view = this.o.memory.openThreadView(parent.user.id, parent.pool);
    try {
      const child = view.own.createThread({ interface: parent.interface, parent: parent.threadId, subagent: true, title: `${role.name}: ${step.task.split("\n")[0]!.slice(0, 80)}` });
      const call = models.childContext(parent.call, child.id, pick);
      const ctx: ThreadContext = { user: parent.user, pool: parent.pool, interface: parent.interface, threadId: child.id, view, call };
      const hooks = { question: (_q: string) => {} };
      const extensions: ExtensionFactory[] = [];
      if (workspace) {
        const p = { userId: parent.user.id, pool: parent.pool, threadId: parent.threadId };
        let grants = this.grants(run, narrowing);
        if (role.readOnly || narrowing.readOnly) grants = grants.map((g) => ({ ...g, writable: false }));
        if (worktrees.length) grants = worktreeGrants(grants, worktrees);
        workspace.inheritSettings(p, child.id, { grants, ...(narrowing.internet === false ? { internet: false } : {}) });
        const tools = workspace.forThread({ ...p, threadId: child.id });
        extensions.push(createWorkspaceExtension(tools));
      }
      const nested = this.depth(ctx) < this.limits.depth;
      if (nested) extensions.push(createDelegateExtension(ctx, this));
      const allowed = new Set([...role.tools, "ask_parent", ...(nested ? ["delegate"] : [])]);
      extensions.unshift(createSubagentExtension(ctx, role, hooks, allowed));
      const opened = await openThreadSession({ thread: ctx, models, cwd: this.o.cwd, extensions });
      opened.session.setThinkingLevel(role.thinking);
      const sub = new Subagent(this, run, ctx, role, refString(opened.chat), opened.session, opened.dispose, worktrees);
      hooks.question = (q) => { sub.question = q; };
      sub.hold(release);
      run.subagents.push(sub);
      this.store.record(parent.user.id, {
        pool: parent.pool, thread: child.id, run: run.id, parent: parent.threadId, role: role.name, model: sub.model,
        background: run.background, status: "running", startedAt: new Date().toISOString(),
      });
      sub.emit({ type: "started", role: role.name, model: sub.model, title: child.title ?? "" });
      if (run.abort.signal.aborted) sub.stop("stopped");
      return sub;
    } catch (err) {
      release();
      view.close();
      throw err;
    }
  }
}

const VERDICT = "End your reply with a line that says exactly VERDICT: APPROVED, or VERDICT: CHANGES NEEDED followed by what must change.";
const reviewTask = (task: string, work: string) => `Review this result against its task.\n\nTask:\n${task}\n\nResult:\n${work}\n\n${VERDICT}`;
const approved = (review: string) => /VERDICT:\s*APPROVED/i.test(review);

function withWorktrees(task: string, worktrees: Worktree[]): string {
  if (!worktrees.length) return task;
  return `${task}\n\nOther subagents are working on the same repositories at the same time, so you have your own git worktree for each. Work and commit only there, never in the original folder:\n${worktreeNote(worktrees)}`;
}

/** A saved workflow's spec, with `{input}` replaced everywhere. */
function withInput(spec: WorkflowSpec, input: string): WorkflowSpec {
  return JSON.parse(JSON.stringify(spec), (_k, v: unknown) => (typeof v === "string" ? v.replaceAll("{input}", input) : v));
}

/** What a finished run tells the parent. */
export function outcome(run: Run): string {
  const head = `Subagent run ${run.id}`;
  if (run.status === "finished") return `${head} finished:\n\n${run.result}`;
  if (run.status === "stopped") return `${head} was stopped${run.result && run.result !== "stopped" ? ` (${run.result})` : ""}.`;
  if (run.status === "question") {
    return run.questions.map((q) => `${head} (${q.sub.role.name}, t:${q.sub.ctx.threadId}) asks:\n${q.question}`).join("\n\n")
      + `\n\nAnswer with delegate({ action: "answer", id: "${run.id}", message: … }).`;
  }
  if (run.status === "failed") return `${head} failed: ${run.result}`;
  return `${head} is still running.`;
}

/**
 * Appends a message to a stored thread, after its last entry, the way Pi would
 * have: her next session on the thread loads it with the rest.
 */
export function appendMessage(store: PoolStore, threadId: string, content: string, details: unknown): void {
  const last = store.loadEntries(threadId).filter((e) => (e as { type?: string }).type !== "session").at(-1) as { id: string } | undefined;
  const entry = {
    type: "custom_message", id: randomBytes(4).toString("hex"), parentId: last?.id ?? null, timestamp: new Date().toISOString(),
    customType: DELEGATE_MESSAGE, content, display: true, details,
  } as unknown as SessionEntry;
  store.appendEntry(threadId, toStoredEntry(entry));
}
