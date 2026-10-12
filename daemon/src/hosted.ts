import { randomBytes } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  CloudModelForbidden, FROM_PARENT, fromParent, HEALTH_MS, isUnreachable, NoModel, Offline, suspectKey, WATCHING, WATCHING_MARK,
  type ChildStatus, type Memory, type Models, type PersonaStore, type Pool, type PoolView, type Users, type Workspace,
} from "@lyrica/core";
import {
  ContextMeter, createDelegateExtension, createLyricaExtension, createThreadsExtension, createWorkspaceExtension, DELEGATE_MESSAGE, OPENING, openThreadSession, piModelFor,
  GO_AHEAD, type ApprovalRequest, type ThreadsHost, type Delegation, type DelegationEvent, type GoAhead, type PlanRequest, type SubagentApproval, type ThreadContext,
} from "@lyrica/extension";
import type * as Api from "./api.ts";
import type { PermissionRequest, ThreadEvent } from "./api.ts";
import { delegateThreads, delegationPart, markersFor, plainError, shortResult, turnRecall } from "./messages.ts";

export interface HostOptions {
  users: Users;
  memory: Memory;
  models: Models;
  workspace: Workspace;
  persona: PersonaStore;
  /** Subagent runs, for every hosted thread. */
  delegation: Delegation;
  /** Pi's working directory. Nothing is discovered from it. */
  cwd: string;
  /** A session idle this long is disposed. Its entries are already stored. */
  idleMs: number;
  /** A permission request nobody answers is denied after this long. */
  permissionMs: number;
  /** For failures that aren't the user's: never message text. */
  log: (line: string) => void;
  /** Child threads: every hosted thread gets the `threads` tool. */
  threads?: ThreadsHost;
  /** How often a thread whose message waits for a model asks the machines again. Default HEALTH_MS. */
  offlineRetryMs?: number;
  /** A project chat's threads, one line each, for her project section. */
  projectThreads?: (userId: string, pool: Pool, project: string) => string | undefined;
  /** A turn started or ended in a thread. */
  onTurn?: (userId: string, pool: Pool, threadId: string, working: boolean) => void;
}

/** Events kept for reconnecting streams. Older ones reload from stored entries. */
const BUFFER = 500;
/** Each lyricad run gets its own epoch, so an event ID from before a restart is never mistaken for a current one. */
const EPOCH = randomBytes(4).toString("hex");

type Client = (id: string, event: ThreadEvent) => void;
type Outcome = "answered" | "timeout" | "stopped";
type Done = (allowed: boolean, reason: Outcome, mode?: GoAhead) => void;

interface Opened { session: AgentSession; view: PoolView; meter: ContextMeter; dispose(): void; title(): Promise<string | undefined>; prepare(opts?: { retry?: boolean }): Promise<unknown> }

/** The threads lyricad hosts, keyed by user, pool and thread. A record is light; its Pi session opens on first use. */
export class ThreadHost {
  private readonly threads = new Map<string, HostedThread>();

  constructor(readonly opts: HostOptions) {
    // A run's events go to its parent thread's stream and its subagent thread's own, wherever they are open.
    opts.delegation.events.on("event", (e: DelegationEvent) => {
      const event: Api.DelegationEvent = e;
      for (const id of new Set([e.parentThreadId, e.threadId])) this.threads.get(`${e.userId}/${e.pool}/${id}`)?.publish({ type: "delegation", event });
    });
  }

  /** The permission requests waiting in any of the user's threads. */
  pending(userId: string): { pool: Pool; threadId: string; request: PermissionRequest }[] {
    const out: { pool: Pool; threadId: string; request: PermissionRequest }[] = [];
    for (const t of this.threads.values()) if (t.userId === userId) for (const request of t.permissions) out.push({ pool: t.pool, threadId: t.threadId, request });
    return out;
  }

  /** The thread's record if it has one now; unlike `get`, never makes one. */
  peek(userId: string, pool: Pool, threadId: string): HostedThread | undefined {
    return this.threads.get(`${userId}/${pool}/${threadId}`);
  }

  get(userId: string, pool: Pool, threadId: string): HostedThread {
    const key = `${userId}/${pool}/${threadId}`;
    let t = this.threads.get(key);
    if (!t) {
      // An idle record with no streams is dropped; a stream that comes back later gets `reset`.
      const created: HostedThread = new HostedThread(this.opts, userId, pool, threadId, () => {
        if (this.threads.get(key) === created) this.threads.delete(key);
      });
      t = created;
      this.threads.set(key, t);
    }
    return t;
  }

  /**
   * A subagent's tool call: one request, shown in the subagent's thread and
   * its parent's. The first answer from either wins and both views update; a
   * timeout, Stop in either thread, or the subagent being stopped refuses it.
   */
  approveSubagent(r: SubagentApproval, signal: AbortSignal): Promise<boolean> {
    const request: PermissionRequest = {
      requestId: randomBytes(8).toString("hex"), toolCallId: r.toolCallId, tool: r.tool, args: r.input, ...onMachine(r),
      expiresAt: new Date(Date.now() + this.opts.permissionMs).toISOString(),
      subagent: { runId: r.runId, threadId: r.threadId, parentThreadId: r.parentThreadId, role: r.role },
    };
    const threads = [r.parentThreadId, r.threadId].map((id) => this.get(r.userId, r.pool, id));
    return new Promise((resolve) => {
      let settled = false;
      const done = (allowed: boolean, reason: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stopped);
        for (const t of threads) t.endPermission(request.requestId, allowed, reason);
        resolve(allowed);
      };
      const timer = setTimeout(() => done(false, "timeout"), this.opts.permissionMs);
      const stopped = () => done(false, "stopped");
      signal.addEventListener("abort", stopped, { once: true });
      for (const t of threads) t.addPermission(request, done);
      if (signal.aborted) stopped();
    });
  }

  /** Settings changed: an open session reopens with them, and open views fetch them again. A thread with no record needs nothing. */
  reload(userId: string, pool: Pool, threadId: string): void {
    const t = this.threads.get(`${userId}/${pool}/${threadId}`);
    t?.reload();
    t?.publish({ type: "settings" });
  }

  /** A project's thread changed state: the project chat's open views update its card. Creates no record. */
  changed(userId: string, pool: Pool, parent: string, threadId: string): void {
    this.threads.get(`${userId}/${pool}/${parent}`)?.publish({ type: "child", threadId });
  }

  /** Working (a turn runs), waiting (for an approval) or idle, without creating a record. */
  status(userId: string, pool: Pool, threadId: string): ChildStatus {
    const t = this.threads.get(`${userId}/${pool}/${threadId}`);
    return t?.waiting ? "waiting" : t?.busy ? "working" : "idle";
  }

  /** Something was delivered into the thread: its open views see it, once, however it got there. */
  delivered(userId: string, pool: Pool, threadId: string, content: string, details: unknown): void {
    this.threads.get(`${userId}/${pool}/${threadId}`)?.delivered(content, details);
  }

  /** Whether a turn is running in the thread, without creating a record. */
  busy(userId: string, pool: Pool, threadId: string): boolean {
    return this.threads.get(`${userId}/${pool}/${threadId}`)?.busy ?? false;
  }

  /** A hosted thread's context now, if its session is open. */
  context(userId: string, pool: Pool, threadId: string): Api.ContextInfo | undefined {
    return this.threads.get(`${userId}/${pool}/${threadId}`)?.context();
  }

  /** Stops and drops every thread of the user (Lock), or of everyone. */
  async close(userId?: string): Promise<void> {
    const mine = [...this.threads].filter(([k]) => !userId || k.startsWith(`${userId}/`));
    await Promise.all(mine.map(async ([k, t]) => { this.threads.delete(k); await t.close(); }));
  }

  /** Drops one thread's record, after it is forgotten. */
  async forget(userId: string, pool: Pool, threadId: string): Promise<void> {
    const key = `${userId}/${pool}/${threadId}`;
    await this.threads.get(key)?.close();
    this.threads.delete(key);
  }
}

/**
 * One thread: its Pi session while active, its event stream, and its
 * permission prompts. One turn runs at a time; messages sent meanwhile wait
 * and go together as the next turn.
 */
export class HostedThread {
  private opened: Opened | undefined;
  /** A retry's re-resolution, still running, which the next turn waits for. */
  private retrying: Promise<unknown> | undefined;
  private opening: Promise<Opened> | undefined;
  private readonly buffer: { n: number; event: ThreadEvent }[] = [];
  private n = 0;
  private readonly clients = new Set<Client>();
  private readonly pending = new Map<string, { request: PermissionRequest; done: Done }>();
  private queued: string[] = [];
  private idle: NodeJS.Timeout | undefined;
  /** No model could be reached: the queued messages wait, and this asks again until one answers. */
  private held: NodeJS.Timeout | undefined;
  /** Settings changed during a turn: reopen the session once it ends. */
  private stale = false;
  /** Closed by Lock, forgetting or shutdown. */
  closed = false;
  private closing = false;
  busy = false;

  constructor(private readonly o: HostOptions, readonly userId: string, readonly pool: Pool, readonly threadId: string,
    private readonly release: () => void) {
    this.startIdle();
  }

  // --- The stream ---

  /** Subscribes a stream. Replays what came after `lastEventId`, or starts with `reset` if that's gone. */
  subscribe(client: Client, lastEventId?: string): () => void {
    const hello: ThreadEvent = { type: "hello", busy: this.busy, queued: [...this.queued], permissions: [...this.pending.values()].map((p) => p.request) };
    if (lastEventId) {
      const [epoch, num] = lastEventId.split("-");
      const after = Number(num);
      const oldest = this.buffer[0]?.n ?? this.n + 1;
      if (epoch !== EPOCH || !Number.isInteger(after) || after < oldest - 1 || after > this.n) client(this.id(this.n), { type: "reset" });
      else for (const b of this.buffer) if (b.n > after) client(this.id(b.n), b.event);
    }
    client(this.id(this.n), hello);
    this.clients.add(client);
    this.stopIdle();
    return () => {
      this.clients.delete(client);
      if (!this.clients.size && !this.busy) this.startIdle();
    };
  }

  private id(n: number): string { return `${EPOCH}-${n}`; }

  private emit(event: ThreadEvent): void {
    this.track(event);
    const n = ++this.n;
    this.buffer.push({ n, event });
    if (this.buffer.length > BUFFER) this.buffer.shift();
    for (const c of this.clients) c(this.id(n), event);
  }

  // --- Her message as it is written, for Read aloud ---

  /** Her message being written now: its text so far (in memory only), and who is following it. */
  private live: { text: string; done: boolean; wake: Set<() => void> } | undefined;

  private track(event: ThreadEvent): void {
    const end = () => { if (this.live) { this.live.done = true; for (const w of this.live.wake) w(); } };
    if (event.type === "message_start") { end(); this.live = { text: "", done: false, wake: new Set() }; }
    else if (event.type === "text" && this.live && !this.live.done) { this.live.text += event.delta; for (const w of this.live.wake) w(); }
    else if (event.type === "turn_end" || event.type === "rewound" || event.type === "reset") { end(); this.live = undefined; }
  }

  /**
   * Follows her message still being written: its text so far, and a wait
   * for more. Undefined when nothing is being written.
   */
  following(): { text: () => string; done: () => boolean; more: (signal: AbortSignal) => Promise<void> } | undefined {
    const live = this.live;
    if (!live || live.done) return undefined;
    return {
      text: () => live.text,
      done: () => live.done || this.closed,
      more: (signal) => new Promise<void>((resolve) => {
        if (live.done || signal.aborted) return resolve();
        const wake = () => { live.wake.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
        live.wake.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      }),
    };
  }

  // --- Turns ---

  /**
   * Starts a turn, or queues the message while one runs. Throws, with the
   * reason, if the session can't open. Only a child's parent sends with
   * `fromParent`, in a project another of its threads with `fromThread`, and
   * only the watcher with `watching`; anyone else's text can't carry the
   * line that marks it.
   */
  async send(text: string, opts: { fromParent?: string; fromThread?: string; watching?: boolean } = {}): Promise<{ queued: boolean }> {
    if (!text.trim()) throw new Error("the message is empty");
    if (FROM_PARENT.test(text)) throw new MarkedText("a message can't start with a [From t:…] line");
    if (WATCHING.test(text)) throw new MarkedText("a message can't start with a [Watching threads] line");
    if (opts.watching) return this.post(`${WATCHING_MARK}${text}`);
    const from = opts.fromParent ?? opts.fromThread;
    return this.post(from ? `${fromParent(from)}${text}` : text);
  }

  /** The text as it goes to the session, its marks already checked. */
  private async post(text: string): Promise<{ queued: boolean }> {
    if (this.busy) {
      this.queued.push(text);
      this.emit({ type: "queue", queued: [...this.queued] });
      return { queued: true };
    }
    // Messages held while no model could be reached go first, with this one.
    if (this.queued.length) {
      text = [...this.queued.splice(0), text].join("\n\n");
      this.emit({ type: "queue", queued: [] });
    }
    this.unhold();
    this.busy = true;
    try {
      await this.open();
    } catch (err) {
      this.busy = false;
      if (err instanceof Offline) {
        this.hold(text, err);
        return { queued: true };
      }
      const message = plainError(refusal(err));
      this.emit({ type: "error", message });
      throw new Error(message);
    }
    this.running = this.run(text);
    return { queued: false };
  }

  private running: Promise<void> = Promise.resolve();

  /** Resolves when the running turn, and the messages queued behind it, are done. */
  settled(): Promise<void> { return this.running; }

  /** Waiting for an answer to a permission request. */
  get waiting(): boolean { return this.pending.size > 0; }
  get permissions(): PermissionRequest[] { return [...this.pending.values()].map((p) => p.request); }

  private async run(text: string): Promise<void> {
    this.stopIdle();
    let aborted = false;
    this.o.onTurn?.(this.userId, this.pool, this.threadId, true);
    try {
      for (let next: string | undefined = text; next !== undefined && !this.closed;) {
        const opened = await this.open();
        await this.retrying;
        try {
          await opened.prepare();
        } catch (err) {
          if (!(err instanceof Offline)) throw err;
          // Nothing is stored yet: the message waits, and goes once a model answers again.
          this.hold([next, ...this.queued.splice(0)].join("\n\n"), err);
          break;
        }
        this.emit({ type: "turn_start" });
        // A compaction belongs to the turn that asked for it, even one that failed.
        opened.meter.pending = undefined;
        await opened.session.prompt(next);
        aborted = this.aborted;
        await this.afterTurn(opened, aborted);
        this.emit({ type: "turn_end", aborted });
        this.aborted = false;
        void this.maybeTitle(opened);
        if (this.stale) this.dispose();
        next = this.queued.length ? this.queued.splice(0).join("\n\n") : undefined;
        if (next !== undefined) this.emit({ type: "queue", queued: [] });
      }
    } catch (err) {
      this.emit({ type: "error", message: plainError(refusal(err)) });
      this.emit({ type: "turn_end", aborted });
      this.queued = [];
    } finally {
      this.busy = false;
      this.aborted = false;
      // Shutdown, Lock or forgetting closes it: a child keeps its record of working, so a restart tells its parent.
      if (!this.closing) this.o.onTurn?.(this.userId, this.pool, this.threadId, false);
      this.startIdle();
    }
  }

  private aborted = false;

  /**
   * No model for the thread's chat can be reached: the text waits in the
   * queue, the views are told once, and every HEALTH_MS lyricad asks the
   * machines again (resolveLive), sending it as soon as one answers. Stop,
   * or a new message (which goes with it), ends the wait.
   */
  private hold(text: string, err: Offline): void {
    this.queued = [text];
    this.emit({ type: "queue", queued: [...this.queued] });
    this.emit({ type: "offline", task: err.task, tried: err.tried });
    this.waitForModel();
  }

  private waitForModel(ms = this.o.offlineRetryMs ?? HEALTH_MS): void {
    this.unhold();
    this.held = setTimeout(() => {
      this.held = undefined;
      if (this.closed || this.busy || !this.queued.length) return;
      const send = () => { if (!this.closed && !this.busy && this.queued.length) void this.post(this.queued.splice(0).join("\n\n")).catch(() => {}); };
      // Anything but Offline (the list was changed to one that can't work, say) is said by the turn itself.
      this.o.models.resolveLive("chat", this.o.models.callContext(this.userId, this.pool, this.threadId))
        .then(send, (err) => (err instanceof Offline ? this.waitForModel() : send()));
    }, ms);
    this.held.unref();
  }

  private unhold(): void {
    if (this.held) clearTimeout(this.held);
    this.held = undefined;
  }

  /** The thread's context now, from its open session. */
  context(): Api.ContextInfo | undefined {
    return this.opened?.meter.report();
  }

  /**
   * After a turn: its counts and times go on the call record (never text, so
   * a "Do not log" thread records them too), a compaction she asked for runs
   * unless the turn was stopped, and the stream gets the context as it now stands.
   */
  private async afterTurn(opened: Opened, aborted: boolean): Promise<void> {
    const pace = opened.meter.takePace();
    if (pace) this.o.models.recordPace(this.userId, this.threadId, pace);
    const asked = opened.meter.pending;
    opened.meter.pending = undefined;
    // Stop means stop: a stopped turn's compaction is dropped.
    if (asked && !aborted) {
      opened.meter.running = asked;
      try {
        // With her summary, session_before_compact hands it to Pi; without, Pi writes one with her notes.
        await opened.session.compact(asked.summary ? undefined : asked.notes || undefined);
      } catch (err) {
        this.emit({ type: "error", message: `The thread couldn't compact: ${plainError((err as Error).message)}` });
      } finally {
        opened.meter.running = undefined;
      }
    }
    const context = opened.meter.report();
    if (context) this.emit({ type: "context", context });
  }

  /**
   * Changes the stored thread while holding its turn, so nothing runs
   * meanwhile: the session closes first, so the next turn loads what is
   * left. `change` returns the first entry number it removed. Then `then` is
   * sent, if given. Throws while a turn runs.
   */
  async rewind(change: () => Promise<number>, then?: string): Promise<void> {
    if (this.busy) throw new Busy("a turn is running: stop it or wait for it to end");
    this.busy = true;
    try {
      await this.opening?.catch(() => {});
      this.dispose();
      const from = await change();
      this.emit({ type: "rewound", from, ...(then !== undefined ? { resend: true as const } : {}) });
    } finally {
      this.busy = false;
      this.startIdle();
    }
    // Messages sent while it was held go after what replaces the removed turns, or on their own.
    const waiting = this.queued.splice(0);
    if (waiting.length) this.emit({ type: "queue", queued: [] });
    const next = [then, ...waiting].filter((t): t is string => t !== undefined);
    if (!next.length) return;
    try {
      await this.post(next[0]!);
    } catch (err) {
      // The session couldn't open: keep the queued messages for the next one rather than dropping them.
      const kept = then === undefined ? next : next.slice(1);
      if (kept.length) {
        this.queued.unshift(...kept);
        this.emit({ type: "queue", queued: [...this.queued] });
      }
      throw err;
    }
    for (const t of next.slice(1)) await this.post(t);
  }

  /** Stop: aborts the running turn, denies waiting permission requests and drops queued messages. */
  async stop(): Promise<void> {
    this.unhold();
    for (const p of [...this.pending.values()]) p.done(false, "stopped");
    if (this.queued.length) {
      this.queued = [];
      this.emit({ type: "queue", queued: [] });
    }
    if (!this.busy || !this.opened) return;
    this.aborted = true;
    await this.opened.session.abort();
  }

  // --- Permission prompts ---

  /** Asks every open view of the thread. A timeout or Stop denies. */
  private async approve(r: ApprovalRequest): Promise<boolean> {
    return (await this.ask(r.toolCallId, r.tool, r.input, onMachine(r))).allowed;
  }

  /** A plan, the same way: approving it says which mode to go ahead in; anything else keeps planning. */
  private async proposePlan(r: PlanRequest): Promise<GoAhead | undefined> {
    const { allowed, mode } = await this.ask(r.toolCallId, "propose_plan", { plan: r.plan });
    return allowed ? mode : undefined;
  }

  private ask(toolCallId: string, tool: string, args: unknown, where: Partial<PermissionRequest> = {}): Promise<{ allowed: boolean; mode?: GoAhead }> {
    const requestId = randomBytes(8).toString("hex");
    const request: PermissionRequest = { requestId, toolCallId, tool, args, ...where, expiresAt: new Date(Date.now() + this.o.permissionMs).toISOString() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(false, "timeout"), this.o.permissionMs);
      const done: Done = (allowed, reason, mode) => {
        if (!this.pending.has(requestId)) return;
        clearTimeout(timer);
        this.endPermission(requestId, allowed, reason);
        resolve({ allowed, mode });
      };
      this.addPermission(request, done);
    });
  }

  /** Shows a request in this thread's views; `done` settles it, here and wherever else it shows. */
  addPermission(request: PermissionRequest, done: Done): void {
    this.pending.set(request.requestId, { request, done });
    this.emit({ type: "permission", ...request });
  }

  /** The request was settled: its prompt goes from this thread's views. */
  endPermission(requestId: string, allowed: boolean, reason: Outcome): void {
    if (!this.pending.delete(requestId)) return;
    this.emit({ type: "permission_end", requestId, allowed, reason });
    if (!this.busy && !this.pending.size && !this.clients.size) this.startIdle();
  }

  /**
   * Answers a permission request; approving a plan needs the mode to go ahead
   * in. Allowing a suspect command in this thread stores that exact command
   * for the thread it runs in, and only that one. Returns false if it's no
   * longer waiting.
   */
  answer(requestId: string, allow: boolean, mode?: GoAhead, allowInThread?: boolean): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    if (p.request.tool === "propose_plan" && allow && !GO_AHEAD.includes(mode!)) throw new Error("say which mode to go ahead in: ask, acceptEdits or auto");
    if (allow && allowInThread) {
      if (!p.request.suspect) throw new Error("only a suspect command can be allowed in this thread");
      this.o.workspace.settings(this.userId).allowInThread(p.request.subagent?.threadId ?? this.threadId, p.request.machine!, suspectKey(p.request.tool, p.request.args));
    }
    p.done(allow, "answered", allow ? mode : undefined);
    return true;
  }

  // --- The Pi session ---

  private open(): Promise<Opened> {
    if (this.closed) return Promise.reject(new Error("this thread was closed"));
    if (this.opened) return Promise.resolve(this.opened);
    this.opening ??= this.create().then((o) => {
      this.opened = o;
      return o;
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async create(): Promise<Opened> {
    const { users, memory, models, workspace, persona, delegation } = this.o;
    const user = users.get(this.userId);
    if (!user) throw new Error("no such user");
    const view = memory.openThreadView(this.userId, this.pool);
    try {
      const thread = view.own.getThread(this.threadId);
      if (!thread) throw new Error("no such thread");
      const call = models.callContext(this.userId, this.pool, this.threadId);
      const tools = workspace.forThread({ userId: this.userId, pool: this.pool, threadId: this.threadId });
      const ctx: ThreadContext = { user, pool: this.pool, interface: thread.interface, threadId: this.threadId, view, call };
      // delegate is offered where the depth limit allows; it attaches itself, so background results reach this session.
      const canDelegate = delegation.depth(ctx) < delegation.limits.depth;
      const meter = new ContextMeter();
      const { session, runtime, prepare, dispose } = await openThreadSession({
        thread: ctx, models, cwd: this.o.cwd,
        extensions: [
          createLyricaExtension(ctx, {
            persona: () => persona.read(), profile: () => users.get(this.userId)!.profile, folders: tools.folders, meter,
            ...(thread.project ? { projectThreads: () => this.o.projectThreads?.(this.userId, this.pool, this.threadId) } : {}),
          }),
          createWorkspaceExtension({
            ...tools,
            approve: (r) => this.approve(r),
            proposePlan: (r) => this.proposePlan(r),
            setMode: (mode) => { tools.setMode(mode); this.emit({ type: "settings" }); },
          }),
          ...(canDelegate ? [createDelegateExtension(ctx, delegation)] : []),
          // Child threads and compacting. Never a subagent's: a subagent works for its run, not on streams of its own.
          ...(!thread.subagent ? [createThreadsExtension(ctx, this.o.threads, meter)] : []),
        ],
      });
      const unsubscribe = session.subscribe((e) => this.forward(e));
      // The thread's title, by the `title` task model through the thread's own CallContext.
      // Its machine away: the next title model tries; with none left, the thread stays untitled until a later turn.
      const title = async () => {
        const said = view.own.loadEntries(this.threadId).map(conversationLine).filter(Boolean).slice(0, 4).join("\n");
        const reply = await models.callWithFallback("title", call, {}, async (resolution) => {
          const { model } = piModelFor(runtime, models, "title", call, resolution);
          models.recordCall(this.userId, { pool: this.pool, threadId: this.threadId, task: "title", resolution });
          const r = await runtime.completeSimple(model, {
            systemPrompt: "Write a short title, at most six words, for the conversation below. Reply with the title only, no quotes.",
            messages: [{ role: "user", content: said, timestamp: Date.now() }],
          });
          if (r.stopReason === "error") throw new Error(r.errorMessage ?? "the title model failed");
          return r;
        });
        const text = reply.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("").trim();
        return text.replace(/^["'“]+|["'”.]+$/g, "").split("\n")[0]!.slice(0, 80) || undefined;
      };
      return { session, view, meter, title, prepare: (opts?: { retry?: boolean }) => prepare(opts), dispose: () => { unsubscribe(); dispose(); view.close(); } };
    } catch (err) {
      view.close();
      throw err;
    }
  }

  /** Pi's session events, as the stream carries them. */
  private forward(e: AgentSessionEvent): void {
    switch (e.type) {
      case "message_start": {
        if (e.message.role === "assistant") this.emit({ type: "message_start", model: e.message.model });
        break;
      }
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a.type === "text_delta") this.emit({ type: "text", delta: a.delta });
        if (a.type === "thinking_delta") this.emit({ type: "thinking", delta: a.delta });
        break;
      }
      case "message_end": {
        const m = e.message;
        if (m.role === "custom" && m.customType === "lyrica-turn") {
          const ids = turnRecall(m.content);
          if (ids.length) this.emit({ type: "recall", ids });
        }
        // Delivered during a turn, as a follow-up.
        if (m.role === "custom" && m.customType === DELEGATE_MESSAGE) this.notice(m.content, m.details);
        if (m.role === "assistant") {
          const u = m.usage;
          if (u) this.emit({ type: "usage", input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens });
          if (m.stopReason === "error" && m.errorMessage) {
            // A machine that is off or away: the next turn falls back past it, and when none is left the views say so.
            const offline = isUnreachable(m.errorMessage) && this.opened ? this.wentAway(this.opened.session.model?.provider ?? "") : undefined;
            if (offline) this.emit({ type: "offline", task: offline.task, tried: offline.tried });
            else this.emit({ type: "error", message: plainError(m.errorMessage) });
          }
        }
        break;
      }
      case "entry_appended": {
        // Delivered while she was idle: appended straight to the session.
        const entry = e.entry as { type: string; customType?: string; content?: unknown; details?: unknown };
        if (entry.type === "custom_message" && entry.customType === DELEGATE_MESSAGE) this.notice(entry.content, entry.details);
        break;
      }
      case "compaction_end": {
        // Hers, or Pi's own at the window's edge: a marker that expands to the summary.
        const r = e.result;
        if (!r || e.aborted) break;
        // Her compaction stores its estimate with the entry, so the live marker and the stored one agree.
        const after = (r.details as { after?: number } | undefined)?.after ?? r.estimatedTokensAfter;
        if (after !== undefined) this.opened?.meter.compacted(after);
        this.emit({ type: "compacted", before: r.tokensBefore, ...(after !== undefined ? { after } : {}), summary: r.summary });
        break;
      }
      case "auto_retry_start": {
        // Pi is about to retry a model whose machine couldn't be reached: send the retry to the next model in the list instead.
        // Pi doesn't wait for listeners, but pauses two seconds before retrying; prepare probes for at most one, so it's done first.
        if (isUnreachable(e.errorMessage) && this.opened) {
          this.o.models.reportDown(this.opened.session.model?.provider ?? "");
          // With no model left to try, retrying the one that's away only keeps her waiting: the turn ends, and says so.
          const session = this.opened.session;
          this.retrying = this.opened.prepare({ retry: true }).catch((err) => { if (err instanceof Offline) session.abortRetry(); });
        }
        break;
      }
      case "tool_execution_start":
        this.emit({ type: "tool_start", toolCallId: e.toolCallId, name: e.toolName, args: e.args });
        break;
      case "tool_execution_end": {
        const content = (e.result as { content?: unknown } | undefined)?.content;
        const result = shortResult(content);
        const threads = delegateThreads(e.toolName, (e.result as { details?: unknown } | undefined)?.details, this.pool);
        this.emit({ type: "tool_end", toolCallId: e.toolCallId, name: e.toolName, result, isError: e.isError, ...(threads ? { threads } : {}) });
        const full = Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? "").join("\n") : String(content ?? "");
        for (const m of markersFor(e.toolName, (e as { args?: unknown }).args, full)) this.emit(m);
        break;
      }
    }
  }

  /** The endpoint couldn't be reached: marks it down, and returns the chat's Offline when no model is left. */
  private wentAway(endpointId: string): Offline | undefined {
    this.o.models.reportDown(endpointId);
    try {
      this.o.models.resolve("chat", this.o.models.callContext(this.userId, this.pool, this.threadId));
      return undefined;
    } catch (err) {
      return err instanceof Offline ? err : undefined;
    }
  }

  private readonly noticed = new Set<string>();

  /** A delivered result or update, once, however Pi reported it. */
  private notice(content: unknown, details: unknown): void {
    const { type: _part, ...notice } = delegationPart(content, details);
    // Two deliveries may say the same thing; each has its own ID.
    const id = (details as { id?: unknown } | undefined)?.id;
    const key = typeof id === "string" ? id : JSON.stringify(notice);
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    if (this.noticed.size > 100) this.noticed.delete(this.noticed.values().next().value!);
    const threads = delegateThreads("delegate", details, this.pool);
    this.emit({ type: "notice", ...notice, ...(threads ? { threads } : {}) });
  }

  private async maybeTitle(opened: Opened): Promise<void> {
    try {
      if (opened.view.own.getThread(this.threadId)?.title) return;
      const title = await opened.title();
      if (!title || this.closed || opened.view.own.getThread(this.threadId)?.title) return;
      opened.view.own.setTitle(this.threadId, title);
      this.emit({ type: "title", title });
    } catch (err) {
      this.o.log(`title for a ${this.pool} thread failed: ${(err as Error).name}`);
    }
  }

  /** Settings changed: the next turn opens a fresh session (with the new models). */
  reload(): void {
    if (this.busy) this.stale = true;
    else this.dispose();
    // A message waiting for a model tries the new settings at once.
    if (this.held) this.waitForModel(0);
  }

  /** Delivered into the stored thread or the live session: shown once either way. */
  delivered(content: unknown, details: unknown): void { this.notice(content, details); }

  /** A forwarded event from elsewhere, such as Delegation's runs. */
  publish(event: ThreadEvent): void { this.emit(event); }

  private dispose(): void {
    this.stale = false;
    this.opened?.dispose();
    this.opened = undefined;
  }

  /** After a while with no turn: the session is disposed, and with no stream open, the whole record with its buffer. */
  private startIdle(): void {
    this.stopIdle();
    this.idle = setTimeout(() => {
      if (this.held) return this.startIdle();
      if (this.busy || this.pending.size || this.opening) return;
      this.dispose();
      if (!this.clients.size) this.release();
    }, this.o.idleMs);
    this.idle.unref();
  }

  private stopIdle(): void { if (this.idle) clearTimeout(this.idle); }

  /** Stops the turn and disposes the session. Streams are told to reset. */
  async close(): Promise<void> {
    this.closing = true;
    await this.stop().catch(() => {});
    this.closed = true;
    this.unhold();
    this.stopIdle();
    await this.opening?.catch(() => {});
    this.dispose();
    this.emit({ type: "reset" });
    this.clients.clear();
  }
}

/** The thread is in a turn, so it can't be changed now. */
export class Busy extends Error {}

/** A message carries a mark only lyricad may put on it. */
export class MarkedText extends Error {}

function refusal(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof CloudModelForbidden) return `Refused: ${message}`;
  if (err instanceof NoModel) return `No model: ${message}`;
  return message;
}

/** "user: …" or "assistant: …" for the title model. */
function conversationLine(entry: unknown): string {
  const m = (entry as { type?: string; message?: { role: string; content?: unknown } }).message;
  if ((entry as { type?: string }).type !== "message" || !m || (m.role !== "user" && m.role !== "assistant")) return "";
  const text = typeof m.content === "string" ? m.content
    : Array.isArray(m.content) ? m.content.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join(" ") : "";
  return text.trim() && text !== OPENING ? `${m.role}: ${text.trim().slice(0, 500)}` : "";
}

/** A call on a machine: its name and folder, and for a suspect command the warning. */
function onMachine(r: ApprovalRequest): Partial<PermissionRequest> {
  if (!r.machine) return {};
  return { machine: r.machine, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.warning ? { suspect: true as const, warning: r.warning } : {}) };
}
