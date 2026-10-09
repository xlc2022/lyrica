import { randomBytes } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  CloudModelForbidden, NoModel, type Memory, type Models, type PersonaStore, type Pool, type PoolView, type Users, type Workspace,
} from "@lyrica/core";
import {
  createDelegateExtension, createLyricaExtension, createWorkspaceExtension, DELEGATE_MESSAGE, openThreadSession, piModelFor,
  type ApprovalRequest, type Delegation, type DelegationEvent, type ThreadContext,
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
}

/** Events kept for reconnecting streams. Older ones reload from stored entries. */
const BUFFER = 500;
/** Each lyricad run gets its own epoch, so an event ID from before a restart is never mistaken for a current one. */
const EPOCH = randomBytes(4).toString("hex");

type Client = (id: string, event: ThreadEvent) => void;

interface Opened { session: AgentSession; view: PoolView; dispose(): void; title(): Promise<string | undefined> }

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

  /** Settings changed: an open session reopens with them. A thread with no record needs nothing. */
  reload(userId: string, pool: Pool, threadId: string): void {
    this.threads.get(`${userId}/${pool}/${threadId}`)?.reload();
  }

  /** Whether a turn is running in the thread, without creating a record. */
  busy(userId: string, pool: Pool, threadId: string): boolean {
    return this.threads.get(`${userId}/${pool}/${threadId}`)?.busy ?? false;
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
  private opening: Promise<Opened> | undefined;
  private readonly buffer: { n: number; event: ThreadEvent }[] = [];
  private n = 0;
  private readonly clients = new Set<Client>();
  private readonly pending = new Map<string, { request: PermissionRequest; done(allowed: boolean, reason: "answered" | "timeout" | "stopped"): void }>();
  private queued: string[] = [];
  private idle: NodeJS.Timeout | undefined;
  /** Settings changed during a turn: reopen the session once it ends. */
  private stale = false;
  /** Closed by Lock, forgetting or shutdown. */
  closed = false;
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
    const n = ++this.n;
    this.buffer.push({ n, event });
    if (this.buffer.length > BUFFER) this.buffer.shift();
    for (const c of this.clients) c(this.id(n), event);
  }

  // --- Turns ---

  /** Starts a turn, or queues the message while one runs. Throws, with the reason, if the session can't open. */
  async send(text: string): Promise<{ queued: boolean }> {
    if (!text.trim()) throw new Error("the message is empty");
    if (this.busy) {
      this.queued.push(text);
      this.emit({ type: "queue", queued: [...this.queued] });
      return { queued: true };
    }
    this.busy = true;
    try {
      await this.open();
    } catch (err) {
      this.busy = false;
      const message = plainError(refusal(err));
      this.emit({ type: "error", message });
      throw new Error(message);
    }
    void this.run(text);
    return { queued: false };
  }

  private async run(text: string): Promise<void> {
    this.stopIdle();
    let aborted = false;
    try {
      for (let next: string | undefined = text; next !== undefined && !this.closed;) {
        const opened = await this.open();
        this.emit({ type: "turn_start" });
        await opened.session.prompt(next);
        aborted = this.aborted;
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
      this.startIdle();
    }
  }

  private aborted = false;

  /** Stop: aborts the running turn, denies waiting permission requests and drops queued messages. */
  async stop(): Promise<void> {
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
  private approve(r: ApprovalRequest): Promise<boolean> {
    const requestId = randomBytes(8).toString("hex");
    const request: PermissionRequest = {
      requestId, toolCallId: r.toolCallId, tool: r.tool, args: r.input,
      expiresAt: new Date(Date.now() + this.o.permissionMs).toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(false, "timeout"), this.o.permissionMs);
      const done = (allowed: boolean, reason: "answered" | "timeout" | "stopped") => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        this.emit({ type: "permission_end", requestId, allowed, reason });
        resolve(allowed);
      };
      this.pending.set(requestId, { request, done });
      this.emit({ type: "permission", ...request });
    });
  }

  /** Answers a permission request. Returns false if it's no longer waiting. */
  answer(requestId: string, allow: boolean): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.done(allow, "answered");
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
      const { session, runtime, dispose } = await openThreadSession({
        thread: ctx, models, cwd: this.o.cwd,
        extensions: [
          createLyricaExtension(ctx, { persona: () => persona.read(), profile: () => users.get(this.userId)!.profile, folders: tools.folders }),
          createWorkspaceExtension({ ...tools, approve: (r) => this.approve(r) }),
          ...(canDelegate ? [createDelegateExtension(ctx, delegation)] : []),
        ],
      });
      const unsubscribe = session.subscribe((e) => this.forward(e));
      // The thread's title, by the `title` task model through the thread's own CallContext.
      const title = async () => {
        const { model } = piModelFor(runtime, models, "title", call);
        const said = view.own.loadEntries(this.threadId).map(conversationLine).filter(Boolean).slice(0, 4).join("\n");
        const reply = await runtime.completeSimple(model, {
          systemPrompt: "Write a short title, at most six words, for the conversation below. Reply with the title only, no quotes.",
          messages: [{ role: "user", content: said, timestamp: Date.now() }],
        });
        const text = reply.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("").trim();
        return text.replace(/^["'“]+|["'”.]+$/g, "").split("\n")[0]!.slice(0, 80) || undefined;
      };
      return { session, view, title, dispose: () => { unsubscribe(); dispose(); view.close(); } };
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
          if (m.stopReason === "error" && m.errorMessage) this.emit({ type: "error", message: plainError(m.errorMessage) });
        }
        break;
      }
      case "entry_appended": {
        // Delivered while she was idle: appended straight to the session.
        const entry = e.entry as { type: string; customType?: string; content?: unknown; details?: unknown };
        if (entry.type === "custom_message" && entry.customType === DELEGATE_MESSAGE) this.notice(entry.content, entry.details);
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

  private readonly noticed = new Set<string>();

  /** A delivered run result, once, however Pi reported it. */
  private notice(content: unknown, details: unknown): void {
    const { type: _part, ...notice } = delegationPart(content, details);
    const key = JSON.stringify(notice);
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    if (this.noticed.size > 100) this.noticed.delete(this.noticed.values().next().value!);
    this.emit({ type: "notice", ...notice });
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
  }

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
      if (this.busy || this.pending.size || this.opening) return;
      this.dispose();
      if (!this.clients.size) this.release();
    }, this.o.idleMs);
    this.idle.unref();
  }

  private stopIdle(): void { if (this.idle) clearTimeout(this.idle); }

  /** Stops the turn and disposes the session. Streams are told to reset. */
  async close(): Promise<void> {
    await this.stop().catch(() => {});
    this.closed = true;
    this.stopIdle();
    await this.opening?.catch(() => {});
    this.dispose();
    this.emit({ type: "reset" });
    this.clients.clear();
  }
}

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
  return text.trim() ? `${m.role}: ${text.trim().slice(0, 500)}` : "";
}
