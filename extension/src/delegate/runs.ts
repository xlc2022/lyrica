import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentSession, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  DelegationStore, isRestricted, LIVE_STATUSES, matchModel, refId, renderThreadMentions, unmatched,
  type CouncilSpec, type Grant, type LoopSpec, type Memory, type ModelRef, type Models, type Pool, type PoolStore, type Role,
  type Step, type SubagentRecord, type SubagentStatus, type Tier, type Usage, type User, type Users, type Workflow, type WorkflowSpec, type Workspace,
} from "@lyrica/core";
import type { ThreadContext } from "../index.ts";
import { syncEntries, toStoredEntry } from "../record.ts";
import { openThreadSession } from "../session.ts";
import { createMcpServersExtension } from "../mcp.ts";
import { createWebExtension } from "../web.ts";
import { createImageExtension } from "../images.ts";
import { createWorkspaceExtension, type ApprovalRequest } from "../workspace.ts";
import { rolesFor } from "./roles.ts";
import { createDelegateExtension, createSubagentExtension } from "./tool.ts";
import { makeWorktrees, removeWorktrees, worktreeGrants, worktreeNote, type Worktree } from "./worktree.ts";

// Runs: one delegate call each, with one or more subagents. A subagent is a
// Pi session in this process, on a thread of its own under the parent's.

export interface Limits {
  /** How deep subagents may nest: 1 means subagents can't delegate. At most 3. */
  depth: number;
  /** Subagents working at once per parent thread. More wait their turn. */
  concurrency: number;
  /** Subagents one request (one message to the parent) may start. */
  runsPerRequest: number;
  /** Longest a subagent may work on one stretch, in milliseconds, however busy. Time waiting for its turn or an answer doesn't count. */
  timeoutMs: number;
  /** Longest a subagent may go without any sign of work (a token, a tool call, a reply), in milliseconds; a pending approval doesn't count. */
  idleMs: number;
  /** Notes (`ask_parent` with `wait: false`) a subagent may send per stretch of work. */
  notes: number;
}
// A local model working through a large task can take an hour; one that has stopped answering shows within minutes.
export const DEFAULT_LIMITS: Limits = { depth: 1, concurrency: 2, runsPerRequest: 8, timeoutMs: 90 * 60_000, idleMs: 5 * 60_000, notes: 3 };

export type DelegateWorkspace = Pick<Workspace, "inheritSettings" | "forThread" | "settings"> & Partial<Pick<Workspace, "imageFiles">>;

export interface DelegationOptions {
  users: Users;
  memory: Memory;
  models: Models;
  /** Where subagents' file and command tools run. Without it, subagents have memory tools only. */
  workspace?: DelegateWorkspace;
  /** Pi's working directory for subagent sessions. Nothing is discovered from it. */
  cwd: string;
  limits?: Partial<Limits>;
  /**
   * Asks whoever watches the subagent's thread and its parent's whether a
   * tool call may run, where the parent's permission mode asks. lyricad
   * supplies it. Without it, every such call is refused. The signal aborts
   * when the subagent is stopped: the answer is then a refusal.
   */
  approve?: (request: SubagentApproval, signal: AbortSignal) => Promise<boolean>;
  /** Her name for this deployment, for the subagents' preamble and the ask_parent label. Lyrica without it. */
  name?: () => string;
  /** The server's SearXNG address, for a subagent's web_search. */
  searxng?: () => string | null;
}

/** A subagent's tool call waiting for approval: which subagent, and what exactly. */
export type SubagentApproval = RunRef & ApprovalRequest & { role: string };

/** The parent thread a run belongs to. */
export type Parent = Pick<ThreadContext, "user" | "pool" | "interface" | "threadId">;

/** A message to a subagent: from Lyrica, or from a user typing in its thread. */
export interface Said { text: string; from?: User }

/** A user's message in a subagent's thread: a custom message, so only lyricad can make one. */
export const USER_MESSAGE = "lyrica-user-message";
const userMessage = (said: Said) => ({
  customType: USER_MESSAGE, display: true, details: { userId: said.from!.id },
  content: `${said.from!.profile.displayName} writes to you directly, in your thread (Lyrica is told):\n\n${said.text}`,
});

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
  | (RunRef & { type: "note"; note: string })
  | (RunRef & { type: "finished"; status: "finished" | "failed" })
  | (RunRef & { type: "stopped"; reason: StopReason })
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
const stopped = (signal: AbortSignal) => (signal.reason instanceof Stopped ? signal.reason : new Stopped("stopped"));

/** A counting lock: at most `max` holders, the rest wait in order. */
class Slots {
  private used = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.used >= this.max) {
      if (signal.aborted) throw stopped(signal);
      await new Promise<void>((resolve) => {
        const wake = () => { signal.removeEventListener("abort", wake); resolve(); };
        this.waiting.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal.aborted) throw stopped(signal);
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

/** Why a subagent was stopped: on request, by the timeout, or because its parent thread changed under it. */
export type StopReason = "stopped" | "timeout" | "parent_changed";

/** One subagent: its thread, its session, and the tokens it has used. */
export class Subagent {
  status: SubagentStatus = "running";
  question?: string;
  /** Notes sent in this stretch of work. */
  notes = 0;
  /** When it last showed any sign of work, and how many of its tool calls wait for approval. */
  active = Date.now();
  approving = 0;
  readonly usage: Usage;
  private stopped?: { reason: StopReason; message: string };
  /** Messages that arrived between its turns; they go next, in order. */
  private readonly queued: Said[] = [];
  private readonly aborter = new AbortController();

  constructor(
    private readonly d: Delegation, readonly run: Run, readonly ctx: ThreadContext, readonly role: Role, readonly model: string,
    /** Whether its model is on a cloud endpoint. */
    readonly cloud: boolean, readonly session: AgentSession, private readonly dispose: () => void,
    /** Releases the parent's folders, for a writer without worktrees. */
    private readonly releaseFolders: () => void,
    /** Tokens it used before, for a subagent that is continued. */
    usage: Usage = { inputTokens: 0, outputTokens: 0 },
  ) {
    this.usage = { ...usage };
    session.subscribe((e) => {
      this.active = Date.now();
      // What it was told is stored at once (Pi saves it just after this event), so a subagent cut off by a restart can be continued with it.
      if (e.type === "message_end" && e.message.role !== "assistant") {
        setImmediate(() => { try { syncEntries(session.sessionManager, ctx.view.own, ctx.threadId); } catch { /* closed meanwhile */ } });
      }
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") this.emit({ type: "output", delta: e.assistantMessageEvent.delta });
      else if (e.type === "tool_execution_start") this.emit({ type: "tool_call", toolName: e.toolName, args: e.args });
      else if (e.type === "message_end" && e.message.role === "assistant") {
        const u = e.message.usage;
        this.usage.inputTokens += u.input + u.cacheRead + u.cacheWrite;
        this.usage.outputTokens += u.output;
        this.emit({ type: "usage", ...this.usage });
      }
    });
  }

  get ref(): RunRef {
    return { userId: this.ctx.user.id, pool: this.ctx.pool, parentThreadId: this.run.parent.threadId, runId: this.run.id, threadId: this.ctx.threadId };
  }

  emit(e: DistributiveOmit<DelegationEvent, keyof RunRef>): void { this.d.events.send({ ...this.ref, ...e } as DelegationEvent); }

  /** Aborts when it or its run is stopped: a pending approval is then refused. */
  get signal(): AbortSignal { return AbortSignal.any([this.aborter.signal, this.run.abort.signal]); }

  /**
   * One stretch of work, holding one of the parent's concurrency slots. Returns
   * the reply, or the question with status "question". First checks that the
   * parent still allows this subagent; if not, the whole run stops.
   */
  async turn(said: Said): Promise<string> {
    this.guard();
    const release = await this.d.slot(this.run).acquire(this.run.abort.signal);
    this.set("running");
    this.question = undefined;
    this.notes = 0;
    const { timeoutMs, idleMs } = this.d.limits;
    const timer = setTimeout(() => this.stop("timeout", `timed out after ${Math.round(timeoutMs / 60_000)} min`), timeoutMs);
    this.active = Date.now();
    const idle = setInterval(() => {
      if (this.approving) this.active = Date.now();
      else if (Date.now() - this.active >= idleMs) this.stop("timeout", `stopped after ${Math.round(idleMs / 1000)} s with no sign of work from its model`);
    }, Math.min(idleMs / 4, 30_000));
    try {
      await this.send(said);
      // Messages that came between turns go next, each after the same check.
      while (this.queued.length && !this.stopped && this.question === undefined) {
        this.guard();
        await this.send(this.queued.shift()!);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(idle);
      release();
    }
    if (this.stopped) throw new Stopped(this.stopped.message);
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

  stop(reason: StopReason, message: string = reason): void {
    if (LIVE_STATUSES.includes(this.status) && !this.stopped) {
      this.stopped = { reason, message };
      this.aborter.abort(new Stopped(message));
      void this.session.abort();
    }
  }

  private async send(said: Said): Promise<void> {
    if (!said.from) return this.session.prompt(said.text);
    await this.session.sendCustomMessage(userMessage(said), { triggerTurn: true });
    await this.session.waitForIdle();
  }

  /** A message while it works: joins the turn in progress, or waits for its next turn. */
  tell(said: Said): void {
    this.guard();
    if (this.status !== "running") throw new Error("that subagent isn't working right now");
    if (!this.session.isStreaming) {
      this.queued.push(said);
      return;
    }
    const sent = said.from ? this.session.sendCustomMessage(userMessage(said), { deliverAs: "steer" }) : this.session.steer(said.text);
    sent.catch(() => this.queued.push(said));
  }

  /** Stops the run if the parent thread is gone, stopped being logged, or went local-only while this runs on a cloud model. */
  private guard(): void {
    const why = this.d.parentChanged(this);
    if (!why) return;
    this.run.stop("parent_changed", why);
    throw new Stopped(why);
  }

  /** Ends the subagent: records its status and usage, and closes its session and view. */
  close(status: "finished" | "failed" | "stopped"): void {
    if (!LIVE_STATUSES.includes(this.status)) return;
    this.set(status === "stopped" || this.stopped ? "stopped" : status);
    this.releaseFolders();
    this.dispose();
    this.ctx.view.close();
    if (this.status === "stopped") this.emit({ type: "stopped", reason: this.stopped?.reason ?? "stopped" });
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
  readonly id: string;
  status: RunStatus = "running";
  result = "";
  readonly subagents: Subagent[] = [];
  readonly abort = new AbortController();
  /** Set once a tool call has handed her the outcome, so it isn't delivered again. */
  delivered = false;
  /**
   * Whether its questions and outcome are delivered into the parent thread:
   * a background run's, and any run a user has messaged, since no tool call
   * waits for what that brings.
   */
  notify: boolean;
  /** Settles once the run has ended and its subagents are closed. */
  ended: Promise<void> = Promise.resolve();
  private readonly asking: { sub: Subagent; answer: (said: Said) => void; fail: (err: Error) => void }[] = [];
  private waiters: (() => void)[] = [];
  /** How many of its subagents may work at once, when the person asked for a number; its own slots then replace the thread's. */
  workers?: number;
  slots?: Slots;

  /** `id` is given when a subagent of an earlier run is continued. */
  constructor(readonly parent: Parent, readonly background: boolean, readonly budget: { left: number }, id?: string) {
    this.id = id ?? `d-${randomBytes(4).toString("hex")}`;
    this.notify = background;
  }

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

  /** Waits for an answer to a subagent's question. */
  waitForAnswer(sub: Subagent): Promise<Said> {
    return new Promise((answer, fail) => {
      this.asking.push({ sub, answer, fail });
      this.set("question");
    });
  }

  /** Answers a subagent's question, or the oldest one. */
  answer(said: Said | string, sub?: Subagent): void {
    const i = sub ? this.asking.findIndex((a) => a.sub === sub) : 0;
    const [next] = i >= 0 ? this.asking.splice(i, 1) : [];
    if (!next) throw new Error(`run ${this.id} has no question waiting${sub ? " from that subagent" : ""}`);
    if (!this.asking.length) this.set("running");
    next.answer(typeof said === "string" ? { text: said } : said);
  }

  /** Ends one subagent's wait for an answer, as stopped. */
  cancel(sub: Subagent, message: string): void {
    const i = this.asking.findIndex((a) => a.sub === sub);
    if (i < 0) return;
    const [a] = this.asking.splice(i, 1);
    if (!this.asking.length && this.status === "question") this.set("running");
    a!.fail(new Stopped(message));
  }

  stop(reason: StopReason = "stopped", message: string = reason): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort(new Stopped(message));
    for (const a of this.asking.splice(0)) a.fail(new Stopped(message));
    for (const s of this.subagents) s.stop(reason, message);
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
  /** One writer at a time in a parent thread's folders, across runs. Writers in their own worktrees don't take it. */
  private readonly writers = new Map<string, Slots>();
  private readonly parents = new Map<string, Deliver>();
  private readonly recovered = new Set<string>();

  constructor(private readonly o: DelegationOptions) {
    this.store = new DelegationStore(o.users);
    // The journal's record of each subagent: ids, role, model and outcome, never what it was told or said.
    this.events.on("started", (e) => console.log(`subagent ${e.runId}/${e.threadId} started: ${e.role} on ${e.model}`));
    this.events.on("finished", (e) => console.log(`subagent ${e.runId}/${e.threadId} ${e.status}`));
    this.events.on("stopped", (e) => console.log(`subagent ${e.runId}/${e.threadId} stopped: ${e.reason}`));
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
  start(parent: ThreadContext, req: Request, opts: { background: boolean; budget: { left: number }; workers?: number }): Run {
    this.recover(parent.user.id);
    if (this.depth(parent) >= this.limits.depth) throw new Error(`subagents can't start subagents of their own here (depth limit ${this.limits.depth})`);
    const run = new Run(parent, opts.background, opts.budget);
    run.workers = opts.workers;
    this.track(run, this.execute(run, req));
    return run;
  }

  /** Keeps a run live while `work` goes on; then closes its subagents and, if asked, tells the parent. */
  private track(run: Run, work: Promise<string>): void {
    this.live.set(run.id, run);
    run.ended = work.then(
      (result) => run.set("finished", result),
      (err: Error) => run.set(err instanceof Stopped || run.abort.signal.aborted ? "stopped" : "failed", err.message),
    ).finally(() => {
      for (const s of run.subagents) s.close(run.status === "stopped" ? "stopped" : "failed");
      // A continuation may already have taken its place.
      if (this.live.get(run.id) === run) this.live.delete(run.id);
      // A user locked meanwhile can't be told; the run's records still say how it ended.
      if (run.notify && !run.delivered) try { this.deliver(run.parent, outcome(run), { runId: run.id, status: run.status, threads: run.subagents.map((s) => s.ctx.threadId) }); } catch { /* locked */ }
    });
  }

  /**
   * A message to one subagent of a run this parent thread started. It joins
   * a working subagent's turn, answers its open question, or continues a
   * subagent that has ended in its own thread, as a new stretch of work under
   * the same run, with its model and workspace worked out again from the
   * parent's current settings. `thread` picks the subagent where the run has
   * several. A message from a user is told to the parent thread too.
   * `opened` settles once the message has reached the subagent, or rejects
   * with the reason it couldn't.
   */
  message(parent: Parent, id: string | undefined, said: Said, opts: { thread?: string; budget: { left: number }; background?: boolean }): Messaged {
    this.recover(parent.user.id);
    if (!said.text.trim()) throw new Error("the message is empty");
    // A run that has ended but not yet closed is as good as over.
    const found = id ? this.live.get(id) : undefined;
    if (found && !sameThread(found.parent, parent)) throw new Error(`no run ${id} in this thread`);
    const live = found && !found.done ? found : undefined;
    const rows = id ? this.store.runs(parent.user.id, parent.pool, { run: id }).filter((r) => r.parent === parent.threadId) : [];
    if (!rows.length) throw new Error(live ? `run ${id} hasn't started a subagent yet` : `no run ${id ?? "(no id given)"} in this thread`);
    const row = this.pickSubagent(rows, live, opts.thread?.replace(/^t:/, ""));
    const done = (run: Run, how: Messaged["how"], opened: Promise<void> = Promise.resolve()): Messaged => {
      const from = said.from;
      if (from) {
        run.notify = true;
        // The parent hears of it once it has reached the subagent.
        opened.then(() => this.deliver(parent, `${from.profile.displayName} wrote to subagent ${row.role} (run ${row.run}, t:${row.thread}):\n${said.text}`,
          { runId: row.run, status: "user_message", threads: [row.thread], userId: from.id })).catch(() => {});
      }
      return { run, threadId: row.thread, role: row.role, how, opened };
    };
    if (live) {
      const sub = live.subagents.find((x) => x.ctx.threadId === row.thread && LIVE_STATUSES.includes(x.status));
      if (sub?.status === "question" && live.questions.some((q) => q.sub === sub)) {
        live.answer(said, sub);
        return done(live, "answered");
      }
      if (sub) {
        sub.tell(said);
        return done(live, "joined");
      }
      throw new Error(`that subagent has ${row.status === "running" ? "not started yet" : "ended"}, but run ${id} is still working; message it once the run ends`);
    }
    const run = new Run(parent, opts.background ?? row.background, opts.budget, row.run);
    let opened!: { resolve: () => void; reject: (err: Error) => void };
    const ready = new Promise<void>((resolve, reject) => { opened = { resolve, reject }; });
    ready.catch(() => {});
    this.track(run, this.resume(run, row, said, opened));
    return done(run, "continued", ready);
  }

  /** The subagent a message is for: the one named, the one waiting, or the only one. */
  private pickSubagent(rows: SubagentRecord[], live: Run | undefined, thread: string | undefined): SubagentRecord {
    const list = () => rows.map((r) => `${r.thread} (${r.role}, ${r.status})`).join(", ");
    if (thread) {
      const row = rows.find((r) => r.thread === thread);
      if (!row) throw new Error(`run ${rows[0]!.run} has no subagent in thread ${thread}; its threads are ${list()}`);
      return row;
    }
    const asking = live?.questions ?? [];
    if (asking.length === 1) return rows.find((r) => r.thread === asking[0]!.sub.ctx.threadId)!;
    if (rows.length === 1) return rows[0]!;
    throw new Error(`run ${rows[0]!.run} has ${rows.length} subagents; say which with thread: ${list()}`);
  }

  /** A subagent that had ended, continued in its own thread. */
  private async resume(run: Run, row: SubagentRecord, said: Said, opened: { resolve: () => void; reject: (err: Error) => void }): Promise<string> {
    let sub: Subagent;
    try {
      const role = this.role(run.parent.user.id, row.role, "worker");
      const pick: ModelPick = row.pick && "model" in row.pick ? { model: this.named(run, row.pick.model) } : { tier: row.pick?.tier ?? role.tier };
      sub = await this.open(run, role, pick, row.narrowing ?? {}, row);
      opened.resolve();
    } catch (err) {
      // Its caller is told at once, so it isn't delivered again.
      run.delivered = true;
      opened.reject(err as Error);
      throw err;
    }
    try {
      const reply = await this.ask(sub, said);
      sub.close("finished");
      return reply;
    } catch (err) {
      sub.close(err instanceof Stopped ? "stopped" : "failed");
      throw err;
    }
  }

  /** Stops the subagent working in a thread, if one is: Stop pressed in its own thread. */
  stopThread(userId: string, pool: Pool, threadId: string): boolean {
    for (const run of this.live.values()) {
      if (run.parent.user.id !== userId || run.parent.pool !== pool) continue;
      const sub = run.subagents.find((x) => x.ctx.threadId === threadId && LIVE_STATUSES.includes(x.status));
      if (sub) {
        sub.stop("stopped");
        // A subagent waiting on its question has no turn to abort: its wait ends instead.
        run.cancel(sub, "stopped");
        return true;
      }
    }
    return false;
  }

  /** A note from a subagent that keeps working, delivered like a background result. False once it has sent its few for this stretch. */
  note(sub: Subagent, text: string): boolean {
    if (sub.notes >= this.limits.notes) return false;
    sub.notes++;
    sub.emit({ type: "note", note: text });
    try {
      this.deliver(sub.run.parent, `Subagent run ${sub.run.id} (${sub.role.name}, t:${sub.ctx.threadId}) sends a note and keeps working:\n${text}`,
        { runId: sub.run.id, status: "note", threads: [sub.ctx.threadId] });
    } catch { /* locked */ }
    return true;
  }

  /** Asks about a subagent's tool call, through lyricad. Refused if nobody can be asked, or once it is stopped. */
  private async approve(sub: Subagent, r: ApprovalRequest): Promise<boolean> {
    const signal = sub.signal;
    if (!this.o.approve || signal.aborted) return false;
    const refused = new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
    sub.approving++;
    try {
      return await Promise.race([this.o.approve({ ...sub.ref, role: sub.role.name, ...r }, signal), refused]) && !signal.aborted;
    } catch {
      return false;
    } finally {
      sub.approving--;
      sub.active = Date.now();
    }
  }

  /** The parent thread of every live run: what an update's drain waits for. */
  working(): { userId: string; pool: Pool; threadId: string }[] {
    return [...this.live.values()].map((r) => ({ userId: r.parent.user.id, pool: r.parent.pool, threadId: r.parent.threadId }));
  }

  /** Stops every live run, or one user's, and waits until they have ended. For Lock and shutdown. */
  async stopAll(userId?: string): Promise<void> {
    const runs = [...this.live.values()].filter((r) => !userId || r.parent.user.id === userId);
    for (const r of runs) r.stop();
    await Promise.all(runs.map((r) => r.ended));
  }

  /** Before a thread is forgotten: stops the runs it started and drops their records. */
  async forget(userId: string, pool: Pool, threadId: string): Promise<void> {
    const runs = [...this.live.values()].filter((r) => r.parent.user.id === userId && r.parent.pool === pool && r.parent.threadId === threadId);
    for (const r of runs) r.stop("parent_changed", "its parent thread was forgotten");
    await Promise.all(runs.map((r) => r.ended));
    this.store.forget(userId, pool, threadId);
  }

  /**
   * Before a rewind forgets subagent threads (and those they started):
   * stops every run with a subagent among them, and drops their records.
   */
  async forgetSubagents(userId: string, pool: Pool, threads: string[]): Promise<void> {
    const doomed = new Set(threads);
    const runs = [...this.live.values()].filter((r) => r.parent.user.id === userId && r.parent.pool === pool
      && (doomed.has(r.parent.threadId) || r.subagents.some((s) => doomed.has(s.ctx.threadId))));
    for (const r of runs) r.stop("parent_changed", "the turns that started it were removed");
    await Promise.all(runs.map((r) => r.ended));
    this.store.forgetThreads(userId, pool, threads);
  }

  /** Why a subagent may no longer go on, if its parent thread changed under it. */
  parentChanged(sub: Subagent): string | undefined {
    const { user, pool, threadId } = sub.run.parent;
    const own = sub.ctx.view.own;
    const parent = own.getThread(threadId);
    const mine = own.getThread(sub.ctx.threadId);
    if (!parent || !mine) return "its parent thread was forgotten";
    if (parent.unlogged && !mine.unlogged) return "its parent thread is no longer logged";
    if (sub.cloud && isRestricted(this.o.models.callContext(user.id, pool, threadId))) return "its parent thread is now local-only, and this subagent runs on a cloud model";
    return undefined;
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
      this.deliverTo(userId, pool, parent, `Subagent run ${runId} was interrupted when Lyrica restarted, and didn't finish. Its threads are kept: ${threads}. `
        + `To go on, send it a message: delegate({ action: "message", id: "${runId}", message: … }).`, { runId, status: "interrupted", threads: list.map((r) => r.thread) });
    }
  }

  /** The run's own slots when the person asked for more workers, else the parent thread's. */
  slot(run: Run): Slots {
    if (run.workers) return (run.slots ??= new Slots(Math.min(run.workers, this.limits.runsPerRequest)));
    return this.lock(this.slots, run, this.limits.concurrency);
  }

  private lock(locks: Map<string, Slots>, run: Run, max: number): Slots {
    const key = threadKey(run.parent.user.id, run.parent.pool, run.parent.threadId);
    let s = locks.get(key);
    if (!s) locks.set(key, (s = new Slots(max)));
    return s;
  }

  // --- Delivery ---

  deliver(parent: Parent, content: string, details: unknown): void {
    this.deliverTo(parent.user.id, parent.pool, parent.threadId, content, details);
  }

  /**
   * Into the live parent session if there is one, else straight into the
   * parent's stored thread, for its next session. Nothing, if the parent was forgotten.
   */
  private deliverTo(userId: string, pool: Pool, threadId: string, content: string, details: unknown): void {
    // An ID, so the thread shows each delivery once, however it hears of it.
    if (details && typeof details === "object" && !("id" in details)) details = { ...details, id: randomBytes(8).toString("hex") };
    const live = this.parents.get(threadKey(userId, pool, threadId));
    if (live?.({ content, details })) return;
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      if (view.own.getThread(threadId)) appendMessage(view.own, threadId, content, details);
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
    // Its worktrees go once it's done; its commits stay on its branches.
    const tidy = async () => (worktrees.length ? `\n\n${await removeWorktrees(this.target(run), worktrees)}` : "");
    let reply: string;
    try {
      const sub = await this.spawn(run, step, narrowing, worktrees);
      try {
        const task = step.fork ? `The conversation above is ${this.o.name?.() ?? "Lyrica"}'s, copied for you. You are her subagent now, with this task:\n\n${step.task}` : step.task;
        reply = await this.ask(sub, { text: withWorktrees(task, worktrees) });
        sub.close("finished");
      } catch (err) {
        sub.close(err instanceof Stopped ? "stopped" : "failed");
        throw err;
      }
    } catch (err) {
      (err as Error).message += await tidy();
      throw err;
    }
    return reply + await tidy();
  }

  private target(run: Run) {
    return this.o.workspace!.forThread({ userId: run.parent.user.id, pool: run.parent.pool, threadId: run.parent.threadId }).target();
  }

  /** Sends a message and keeps going through any questions, until the subagent replies. */
  private async ask(sub: Subagent, said: Said): Promise<string> {
    let reply = await sub.turn(said);
    while (sub.status === "question") {
      if (sub.run.notify) {
        try {
          this.deliver(sub.run.parent, `${asks(sub, reply)}\n\n${answerWith(sub)}`, { runId: sub.run.id, status: "question", threads: [sub.ctx.threadId] });
        } catch { /* locked */ }
      }
      const answer = await sub.run.waitForAnswer(sub);
      reply = await sub.turn(answer);
    }
    return reply;
  }

  private async parallel(run: Run, steps: Step[], narrowing: Narrowing): Promise<string> {
    if (!steps.length) throw new Error("tasks is empty");
    const roles = steps.map((s) => this.role(run.parent.user.id, s.role, this.defaultRole(run, narrowing)));
    const writes = roles.map((r) => !r.readOnly && !narrowing.readOnly);
    const writers = writes.filter(Boolean).length;
    let worktrees: Worktree[][] | undefined;
    let turns = "";
    if (writers > 1 && this.o.workspace) {
      const made = await makeWorktrees(this.target(run), this.grants(run, narrowing), run.id, writers, run.abort.signal);
      if (typeof made === "string") turns = `The writers ran one at a time: ${made}.\n\n`;
      else worktrees = made;
    }
    let w = 0;
    const results = await Promise.allSettled(steps.map((step, i) => this.single(run, step, narrowing, writes[i] && worktrees ? worktrees[w++]! : [])));
    if (run.abort.signal.aborted) throw stopped(run.abort.signal);
    return turns + results.map((r, i) => `## ${i + 1}. ${roles[i]!.name}: ${steps[i]!.task.split("\n")[0]!.slice(0, 80)}\n${r.status === "fulfilled" ? r.value : `Failed: ${(r.reason as Error).message}`}`).join("\n\n");
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
    const worker = await this.spawn(run, { task: spec.task, role: spec.worker ?? this.defaultRole(run, narrowing) }, narrowing);
    let reviewer: Subagent | undefined;
    try {
      let work = await this.ask(worker, { text: spec.task });
      reviewer = await this.spawn(run, { task: `Review: ${spec.task}`, role: spec.reviewer ?? "reviewer" }, narrowing);
      let review = "";
      let round = 1;
      for (; ; round++) {
        review = await this.ask(reviewer, { text: round === 1 ? reviewTask(spec.task, work) : `The worker revised the result:\n\n${work}\n\nReview it again. ${VERDICT}` });
        if (approved(review) || round === rounds) break;
        work = await this.ask(worker, { text: `A reviewer asked for changes:\n\n${review}\n\nMake them, then reply with the revised result in full.` });
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
    const userId = run.parent.user.id;
    const refs = spec.models?.length ? spec.models.map((m) => this.named(run, m)) : this.councilModels(run);
    const label = (ref: ModelRef) => this.o.models.label(userId, refId(ref)) ?? refId(ref);
    const answers = await Promise.allSettled(refs.map((ref) => this.single(run, { task: spec.question, role: "oracle", model: refId(ref) }, narrowing)));
    if (run.abort.signal.aborted) throw stopped(run.abort.signal);
    const got = answers.map((a, i) => ({ model: label(refs[i]!), text: a.status === "fulfilled" ? a.value : undefined })).filter((a) => a.text !== undefined);
    if (!got.length) throw new Error(`no member of the council answered: ${(answers.find((a) => a.status === "rejected") as PromiseRejectedResult).reason.message}`);
    const listed = got.map((a, i) => `<answer n="${i + 1}" model="${a.model}">\n${a.text}\n</answer>`).join("\n\n");
    const synthesis = await this.single(run, {
      task: `Several advisers answered the same question independently. Combine their answers into one: where they agree, where they differ and who is more likely right, and your recommendation.\n\nQuestion:\n${spec.question}\n\n${listed}`,
      role: "oracle", tier: "strong",
    }, narrowing);
    return `${synthesis}\n\n---\nCouncil: ${got.map((a) => a.model).join(", ")}`;
  }

  /**
   * A model a saved workflow or the person names: by offering ID, as
   * `endpoint/model`, or in plain words that fit one of the thread's models.
   * Otherwise the error lists the closest, for her to ask which was meant.
   */
  private named(run: Run, name: string): ModelRef {
    const { models } = this.o;
    const ref = models.find(run.parent.user.id, name);
    if (ref) return ref;
    const m = matchModel(name, models.textModels(this.parentCall(run)));
    if ("closest" in m) throw new Error(unmatched(name, m));
    return { offeringId: m.model.id };
  }

  /** Up to three distinct models: the thread's subagent models first, then others it allows. */
  private councilModels(run: Run): ModelRef[] {
    const { models } = this.o;
    const call = this.parentCall(run);
    const picks: { offeringId: string }[] = [];
    for (const task of ["subagent.strong", "subagent.cheap", "chat"] as const) {
      try { picks.push(models.resolveModel(task, call)); } catch { /* not set */ }
    }
    for (const { offerings } of models.allowed(call)) for (const m of offerings) if (m.tools !== false && m.status === "listed") picks.push({ offeringId: m.id });
    const seen = new Set<string>();
    return picks.filter((r) => !seen.has(r.offeringId) && !!seen.add(r.offeringId)).slice(0, 3);
  }

  /** The chat models this thread may name for its subagents, as it is now. */
  models(parent: ThreadContext): { id: string; label: string; local: boolean }[] {
    const { models } = this.o;
    return models.textModels(models.callContext(parent.user.id, parent.pool, parent.threadId));
  }

  /** The parent's CallContext as it is now: local-only may have been switched on since the run started. */
  private parentCall(run: Run) {
    return this.o.models.callContext(run.parent.user.id, run.parent.pool, run.parent.threadId);
  }

  /** The parent's grants as they apply now, narrowed to `folders` if given. */
  private grants(run: Run, narrowing: Narrowing): Grant[] {
    const from = this.o.workspace!.settings(run.parent.user.id).effective(run.parent.threadId).grants;
    if (!narrowing.folders) return from;
    return narrowing.folders.map((path) => {
      const outer = from.find((g) => path === g.path || path.startsWith(`${g.path}/`));
      // Checkout mounts are separate from host grants; never reinterpret their sandbox paths as grants.
      if (!outer) throw new Error(`${path} isn't one of this thread's folders: folders narrows granted host folders, not repository checkout paths. Omit folders to read the parent's repository checkouts; scouts see them read-only.`);
      return { path, writable: outer.writable };
    });
  }

  /** A new subagent of the run, on a thread of its own: empty, or a fork of the parent's conversation. */
  private defaultRole(run: Run, narrowing: Narrowing): string {
    return !narrowing.readOnly && this.o.workspace?.settings(run.parent.user.id).effective(run.parent.threadId).repositories.length ? "coder" : "worker";
  }

  private spawn(run: Run, step: Step, narrowing: Narrowing, worktrees: Worktree[] = []): Promise<Subagent> {
    const role = this.role(run.parent.user.id, step.role, this.defaultRole(run, narrowing));
    const pick: ModelPick = step.model ? { model: this.named(run, step.model) } : { tier: step.tier ?? role.tier };
    return this.open(run, role, pick, narrowing, undefined, step.task, worktrees, !!step.fork, step.done);
  }

  /**
   * A subagent's model, workspace and session, from the parent's settings as
   * they are now: on a new thread, or on the thread of one being continued
   * (`earlier`). Each counts against the request's budget. A writer without
   * worktrees first waits until no other writer is in the parent's folders.
   */
  private async open(run: Run, role: Role, pick: ModelPick, narrowing: Narrowing, earlier: SubagentRecord | undefined, task = "", worktrees: Worktree[] = [], fork = false, done = ""): Promise<Subagent> {
    const { parent } = run;
    const { models, workspace } = this.o;
    const writer = !!workspace && !role.readOnly && !narrowing.readOnly;
    if (workspace && !role.readOnly && workspace.forThread({ userId: parent.user.id, pool: parent.pool, threadId: parent.threadId }).settings().mode === "plan") {
      throw new Error(`the thread is in Plan mode, where only read-only roles run; ${role.name} isn't one`);
    }
    let parentCall = this.parentCall(run);
    // A subagent that started local-only (a fork of a local-only conversation, say) stays local-only.
    if (earlier && isRestricted(models.callContext(parent.user.id, parent.pool, earlier.thread))) parentCall = { ...parentCall, localOnly: true };
    // Refuse a model before anything is written.
    if ("tier" in pick) models.resolveModel(role.name === "coder" ? "code" : `subagent.${pick.tier}`, parentCall);
    else if ("offeringId" in pick.model && !models.allowed(parentCall).some((a) => a.offerings.some((m) => "offeringId" in pick.model && m.id === pick.model.offeringId))) {
      throw new Error(`${models.label(parent.user.id, refId(pick.model)) ?? refId(pick.model)} isn't one of this thread's models`);
    }
    if (run.budget.left <= 0) throw new Error(`this request has already started ${this.limits.runsPerRequest} subagents`);
    run.budget.left--;
    const release = writer && !worktrees.length ? await this.lock(this.writers, run, 1).acquire(run.abort.signal) : () => {};
    const view = this.o.memory.openThreadView(parent.user.id, parent.pool);
    try {
      if (!view.own.getThread(parent.threadId)) throw new Error("its parent thread was forgotten");
      const child = earlier ? view.own.getThread(earlier.thread)
        : view.own.createThread({ interface: parent.interface, parent: parent.threadId, subagent: true, title: `${role.name}: ${subagentTitle(task, view.own)}` });
      if (!child) throw new Error("that subagent's thread was forgotten");
      if (fork) forkConversation(view.own, parent.threadId, child.id);
      const parentThread = view.own.getThread(parent.threadId)!;
      if (parentThread.unlogged && !child.unlogged) throw new Error("its parent thread is no longer logged");
      let call = role.name === "coder" ? models.inheritContext(parentCall, child.id) : models.childContext(parentCall, child.id, pick);
      if (role.name === "coder") {
        if ("model" in pick) models.setThreadModel(parent.user.id, parent.pool, child.id, "code", pick.model);
        call = models.callContext(parent.user.id, parent.pool, child.id);
        if (!earlier) view.own.setCodeTask(child.id, task.slice(0, 300), done);
      }
      const ctx: ThreadContext = { user: parent.user, pool: parent.pool, interface: parent.interface, threadId: child.id, view, call };
      let sub: Subagent | undefined;
      const hooks: SubagentHooks = {
        question: (q) => { sub!.question = q; },
        note: (text) => this.note(sub!, text),
      };
      const extensions: ExtensionFactory[] = [];
      let mcp = false;
      if (workspace) {
        let owner = parent.threadId;
        while (view.own.getThread(owner)?.subagent && view.own.getThread(owner)?.parent) owner = view.own.getThread(owner)!.parent!;
        const p = { userId: parent.user.id, pool: parent.pool, threadId: parent.threadId, project: view.own.projectOf(owner) };
        let grants = this.grants(run, narrowing);
        if (role.readOnly || narrowing.readOnly) grants = grants.map((g) => ({ ...g, writable: false }));
        if (worktrees.length) grants = worktreeGrants(grants, worktrees);
        // A machine is reached through bash, and an MCP server from lyricad, which no sandbox mount or network rule narrows:
        // a read-only, offline or folder-narrowed subagent, or a writer in its own worktree, gets none.
        const noMachines = role.readOnly || narrowing.readOnly || narrowing.internet === false || !!narrowing.folders || worktrees.length > 0;
        // Offline means web_search too: SearXNG is asked from lyricad, not the sandbox.
        workspace.inheritSettings(p, child.id, {
          grants, ...(narrowing.internet === false ? { internet: false, webSearch: false } : {}),
          ...(noMachines ? { machines: [], repositories: [], mcpServers: [], claudeCode: false } : {}),
        });
        // Its settings follow its parent's as they are now (the stricter mode, switches off where theirs are); it can't leave Plan mode itself.
        // It works in its parent's clones, which the parent fetched at its turn's start; read-only when it gets
        // no repositories, so a narrowed or read-only subagent, or a writer in a worktree, can't change them.
        const { setMode: _own, cloneRepositories: _fetched, addRepository: _asks, ...tools } = workspace.forThread({ ...p, threadId: child.id, reposOf: parent.threadId, reposReadOnly: noMachines });
        extensions.push(createWorkspaceExtension({ ...tools, approve: (r) => this.approve(sub!, r) }));
        if (workspace.imageFiles) extensions.push(createImageExtension({ models: this.o.models, threadId: child.id,
          call: () => this.o.models.callContext(parent.user.id, parent.pool, child.id),
          files: workspace.imageFiles({ ...p, threadId: child.id }), settings: () => workspace.settings(parent.user.id),
          enabled: () => !role.readOnly && !narrowing.readOnly && tools.settings().images && tools.settings().mode !== "plan",
          approve: r => this.approve(sub!, r),
        }));
        // Its role says whether it searches; its Web search switch is its parent's or off.
        extensions.push(createWebExtension({ searxng: () => this.o.searxng?.(), target: () => tools.target() }));
        // Its parent's MCP servers, read live, so one taken from the parent goes from it too; its calls ask in both threads.
        if (tools.settings().mcpServers.length) {
          extensions.push(createMcpServersExtension(tools));
          mcp = true;
        }
      }
      const nested = this.depth(ctx) < this.limits.depth;
      if (nested) extensions.push(createDelegateExtension(ctx, this, run.budget));
      // tool_search loads the MCP tools, which register after its role's tools are set, so the role doesn't turn them off.
      const allowed = new Set([...role.tools, "ask_parent", ...(nested ? ["delegate"] : []), ...(mcp ? ["tool_search"] : [])]);
      // First: it must run before the MCP extension registers anything, else the role gate turns loaded MCP tools off.
      extensions.unshift(createSubagentExtension(ctx, role, hooks, allowed, this.o.name?.() ?? "Lyrica", !earlier && role.name === "coder" ? { task, done } : undefined));
      const opened = await openThreadSession({ thread: ctx, models, cwd: this.o.cwd, extensions, task: () => role.name === "coder" ? "code" : "chat" });
      opened.session.setThinkingLevel(role.thinking);
      // Passes over a model whose machine is away, and records the call. The role keeps its own thinking level.
      const chat = await opened.prepare({ thinking: false }).catch((err) => { opened.dispose(); throw err; });
      const before = earlier ? { inputTokens: earlier.inputTokens, outputTokens: earlier.outputTokens } : undefined;
      sub = new Subagent(this, run, ctx, role, chat.label, chat.endpoint.kind !== "local", opened.session, opened.dispose, release, before);
      run.subagents.push(sub);
      if (earlier) {
        this.store.update(parent.user.id, parent.pool, child.id, { status: "running", model: sub.model, offeringId: chat.ref.offeringId });
      } else {
        this.store.record(parent.user.id, {
          pool: parent.pool, thread: child.id, run: run.id, parent: parent.threadId, role: role.name, model: sub.model, offeringId: chat.ref.offeringId,
          background: run.background, status: "running", startedAt: new Date().toISOString(),
          pick: "tier" in pick ? pick : { model: refId(pick.model) }, narrowing: compact(narrowing),
        });
      }
      sub.emit({ type: "started", role: role.name, model: sub.model, title: child.title ?? "" });
      if (run.abort.signal.aborted) sub.stop("stopped", stopped(run.abort.signal).message);
      return sub;
    } catch (err) {
      release();
      view.close();
      throw err;
    }
  }
}

/** What `message` did, and on which subagent. */
export interface Messaged {
  run: Run;
  threadId: string;
  role: string;
  how: "joined" | "answered" | "continued";
  /** Settles once the message has reached the subagent; rejects with the reason a continued one couldn't open. */
  opened: Promise<void>;
}

/** What a subagent's tools report back to its run. */
export interface SubagentHooks {
  question(q: string): void;
  /** False once it has sent its few notes for this stretch. */
  note(text: string): boolean;
}

const sameThread = (a: Parent, b: Parent) => a.user.id === b.user.id && a.pool === b.pool && a.threadId === b.threadId;
const compact = (n: Narrowing): Narrowing | undefined => {
  const out = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined)) as Narrowing;
  return Object.keys(out).length ? out : undefined;
};
const asks = (sub: Subagent, question: string) => `Subagent run ${sub.run.id} (${sub.role.name}, t:${sub.ctx.threadId}) asks:\n${question}`;
const answerWith = (sub: Subagent) => `Answer with delegate({ action: "message", id: "${sub.run.id}", thread: "${sub.ctx.threadId}", message: … }).`;

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
    return run.questions.map((q) => `${asks(q.sub, q.question)}\n${answerWith(q.sub)}`).join("\n\n");
  }
  if (run.status === "failed") return `${head} failed: ${run.result}`;
  return `${head} is still running.`;
}

/**
 * Copies a parent's stored conversation into a fork's new thread, entry for
 * entry, so its compaction applies as it does for the parent. The copies
 * point at their originals and aren't indexed again (`copyEntries`). A
 * trailing call still waiting for its results (the `delegate` call making the fork) is left out.
 */
export function forkConversation(store: PoolStore, from: string, to: string): void {
  type Entry = { type?: string; message?: { role: string; content?: unknown; toolCallId?: string } };
  const entries = store.entryPage(from, { limit: Number.MAX_SAFE_INTEGER }).entries as { n: number; data: Entry }[];
  const answered = new Set(entries.map((e) => e.data.message?.toolCallId).filter(Boolean));
  const waiting = ({ data: e }: { data: Entry }) => e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content)
    && (e.message.content as { type: string; id?: string }[]).some((p) => p.type === "toolCall" && !answered.has(p.id));
  while (entries.length && waiting(entries.at(-1)!)) entries.pop();
  if (entries.length) store.copyEntries(from, to, { upTo: entries.at(-1)!.n });
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

/** A subagent thread's title from its task's first line: threads it mentions by their current title, cut after. */
function subagentTitle(task: string, own: { getThread(id: string): { title?: string } | undefined }): string {
  // Another pool's thread (a general one from a private view) isn't looked up here.
  const line = renderThreadMentions(task.split("\n")[0]!, (id, pool) => (pool ? "a thread" : own.getThread(id) && (own.getThread(id)!.title || "an untitled thread")));
  return line.slice(0, 80);
}
