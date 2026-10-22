import { randomBytes } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  ANSWER, answerMark, recentWorkAllowed, WELCOME_LIMITS, alwaysAllowPrefix, CloudModelForbidden, FROM_PARENT, fromParent, HEALTH_MS, isPlan, isPlanLimit, isUnreachable, NoModel, Offline, suspectKey, ROUTINE, WAKEUP, WATCHING, WATCHING_MARK,
  type ChildStatus, type Memory, type Models, type PersonaStore, type Pool, type PoolView, type Skill, type Users, type Workspace,
} from "@lyrica/core";
import {
  checkoutsOf, codeRepositories, repoSkills, skillsIndex, type ListedSkill, createChecksExtension, formatEntry, repoRules, appendUserMessage, executeImage, ContextMeter, createDelegateExtension, createDownloadsExtension, createImageExtension, createLyricaExtension, createMcpServersExtension, createModelsExtension, createReactExtension, createThreadsExtension, createWebExtension, createWorkspaceExtension, DELEGATE_MESSAGE, EMPTY_REPLY_NOTICE, TURN_TOOL_NOTICE, OPENING, openThreadSession, piModelFor, syncEntries,
  GO_AHEAD, type ApprovalRequest, type ThreadsHost, type Delegation, type DelegationEvent, type GoAhead, type DownloadsHost, type HubListing, type ModelsHost, type PlanRequest, type SubagentApproval, type ThreadContext, type UserReaction,
} from "@lyrica/extension";
import type * as Api from "./api.ts";
import type { PermissionRequest, ThreadEvent } from "./api.ts";
import type { SameFile } from "./same-file.ts";
import { delegateThreads, delegationPart, imagePart, imageRefusal, markersFor, plainError, shortResult, toReactions, turnRecall } from "./messages.ts";

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
  /** The server's SearXNG address, for web_search; without one there is no web_search. */
  searxng?: () => string | null;
  /** Child threads: every hosted thread gets the `threads` tool. */
  threads?: ThreadsHost;
  codePulls?: (userId: string, pool: Pool, threadId: string) => string[];
  /** How often a thread whose message waits for a model asks the machines again. Default HEALTH_MS. */
  offlineRetryMs?: number;
  /** Her name for this deployment, which automatic recall leaves out. */
  name?: () => string;
  /** Holds a write to a file another thread changed lately, once, and tells that thread (same-file.ts). */
  sameFile?: SameFile;
  /** A project chat's threads, one line each, for her project section. */
  projectThreads?: (userId: string, pool: Pool, project: string) => string | undefined;
  /** A turn started or ended in a thread; at the end, whether the person's own text was part of it (a child's wake isn't). */
  onTurn?: (userId: string, pool: Pool, threadId: string, working: boolean, byPerson?: boolean) => void;
  /** Every event the thread's stream carries, as it goes out (the watcher hears of errors and approvals from it). */
  onEvent?: (userId: string, pool: Pool, threadId: string, event: ThreadEvent) => void;
}

const CHILD_WAKE = "lyrica-child-wake";
/** Events kept for reconnecting streams. Older ones reload from stored entries. */
const BUFFER = 500;
/** Each lyricad run gets its own epoch, so an event ID from before a restart is never mistaken for a current one. */
const EPOCH = randomBytes(4).toString("hex");

type Client = (id: string, event: ThreadEvent) => void;
type Outcome = "answered" | "timeout" | "stopped";
type Done = (allowed: boolean, reason: Outcome, mode?: GoAhead) => void;

/**
 * A marked message (from another thread, or a look) for the running or next
 * turn: `handed` once it is in Pi's steering queue, `prompt` while it is the
 * message a turn starts with.
 */
interface Steer { text: string; handed: boolean; prompt: boolean }

interface Opened { session: AgentSession; view: PoolView; meter: ContextMeter; dispose(): void; title(): Promise<string | undefined>; prepare(opts?: { retry?: boolean }): Promise<unknown> }

/** The threads lyricad hosts, keyed by user, pool and thread. A record is light; its Pi session opens on first use. */
export class ThreadHost {
  private readonly threads = new Map<string, HostedThread>();
  /** An update is draining: new turns from outside are refused, and the watcher's looks wait. */
  draining = false;

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
      requestId: randomBytes(8).toString("hex"), toolCallId: r.toolCallId, tool: r.tool, args: r.input, ...onMachine(r), ...commandApproval(this.opts, r.userId, r.pool, r.threadId, r.tool, r.input),
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

  /** Something every thread of the user reads changed (an MCP server): each open session reopens at its next turn, and open views fetch settings again. */
  reloadUser(userId: string): void {
    for (const t of this.threads.values()) if (t.userId === userId) { t.reload(); t.publish({ type: "settings" }); }
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

  /** Threads with a turn running or a message waiting for a model to answer: what an update's drain waits for. */
  working(): { userId: string; pool: Pool; threadId: string }[] {
    return [...this.threads].filter(([, t]) => t.working).map(([k]) => {
      const [userId, pool, ...rest] = k.split("/");
      return { userId: userId!, pool: pool as Pool, threadId: rest.join("/") };
    });
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

/** What to do with the threads the user ticked in Set up from recent work; the user's own message stays short. */
const RECENT_WORK_DIRECTIONS = [
  "The person ticked these threads to set this project up from their recent work. To answer:",
  "1. Store a draft Goal and Instructions for the project with `threads draft`; they show on Project settings for the person to edit and save.",
  "2. Suggest which of these threads to bring into the project with `threads fold` and their thread ids.",
  "3. Reply with what you drafted and why, ending with a link to Project settings.",
].join("\n");

/**
 * One thread: its Pi session while active, its event stream, and its
 * permission prompts. One turn runs at a time; the person's messages sent
 * meanwhile wait and go together as the next turn, and marked ones (from
 * another thread, or a look) join the running turn as a steer.
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
  /** The person's follow-ups (and a message held for a model): shown as waiting, and Stop gives them back. */
  private queued: string[] = [];
  /** Marked messages no turn has taken yet. Never dropped: what no turn takes is kept in the stored thread. */
  private steering: Steer[] = [];
  /** The latest model reply of the running turn ended in an error. */
  private failed = false;
  private idle: NodeJS.Timeout | undefined;
  /** No model could be reached: the queued messages wait, and this asks again until one answers. */
  private held: NodeJS.Timeout | undefined;
  /** Settings changed during a turn: reopen the session once it ends. */
  private stale = false;
  /** Closed by Lock, forgetting or shutdown. */
  closed = false;
  private closing = false;
  busy = false;
  /** Only the current turn was started by a child; a queued user follow-up is its own turn. */
  childWakeTurn = false;

  constructor(private readonly o: HostOptions, readonly userId: string, readonly pool: Pool, readonly threadId: string,
    private readonly release: () => void) {
    this.startIdle();
  }

  // --- Reactions ---

  /** The user's reactions since her last turn, told to her in the next one (extension `reactions`). */
  private unseenReactions: UserReaction[] = [];

  /**
   * Message n's reactions changed: every open tab hears. `by` is the user's own
   * reaction, which she is told of in her next turn; hers (the `react` tool) only
   * publish.
   */
  reacted(n: number, reactions: Api.Reaction[], by?: { emoji: string; on: boolean; hers: boolean }): void {
    if (by) {
      this.unseenReactions = this.unseenReactions.filter((r) => !(r.n === n && r.emoji === by.emoji));
      this.unseenReactions.push({ n, ...by });
    }
    this.emit({ type: "reactions", n, reactions });
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
    this.o.onEvent?.(this.userId, this.pool, this.threadId, event);
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

  /** Selection is held only in memory, and never enters stored messages. */
  private recentWorkSource: string | undefined;
  private recentWorkIds: string[] | undefined;

  private recentWork(view: PoolView): string | undefined {
    if (!this.recentWorkIds) return undefined;
    const local = this.o.models.callContext(this.userId, this.pool, this.threadId).localOnly;
    const work = this.recentWorkIds.map(id => {
      const row = view.own.getThread(id);
      if (!row || !recentWorkAllowed(row, this.o.models.callContext(this.userId, this.pool, id).localOnly, local)) throw new Error("selected work is no longer readable by this project");
      return `[t:${id}]\n${view.own.latestEntries(id, WELCOME_LIMITS.entries).map(formatEntry).join("\n\n")}`;
    }).join("\n\n").slice(0, WELCOME_LIMITS.chars);
    const keepsSource = this.recentWorkIds.length === 1 && this.recentWorkIds[0] === this.recentWorkSource;
    const directions = keepsSource
      ? "Continue from this thread, which stays in place. Store a draft Goal and Instructions with `threads draft`, then reply ending with a link to Project settings."
      : RECENT_WORK_DIRECTIONS;
    return `${directions}\n\n${work}`;
  }

  /**
   * Starts a turn, or, while one runs, queues the person's message as a
   * follow-up; a marked message joins the running turn as a steer, after its
   * current tool call. `queued` is true when the message waits for a later
   * turn (behind the running one, or for a model to answer), false when it
   * started a turn or joined the running one. Throws, with the reason, if
   * the session can't open. Only a child's parent sends with `fromParent`,
   * in a project another of its threads with `fromThread`, only the
   * watcher with `watching`, and only a wake-up with `wakeup` (its mark);
   * anyone else's text can't carry the line that marks it.
   */
  async send(text: string, opts: { answer?: number; fromParent?: string; fromThread?: string; watching?: boolean; wakeup?: string; routine?: string; recentThreadIds?: string[]; recentWorkSource?: string } = {}): Promise<{ queued: boolean }> {
    if (!text.trim()) throw new Error("the message is empty");
    if (opts.answer !== undefined) return this.post(`${answerMark(opts.answer)}${text}`);
    if (ANSWER.test(text)) throw new MarkedText("a message can’t start with [Answer to q:");
    if (FROM_PARENT.test(text)) throw new MarkedText("a message can't start with a [From t:…] line");
    if (WATCHING.test(text)) throw new MarkedText("a message can't start with a [Watching threads] line");
    if (WAKEUP.test(text)) throw new MarkedText("a message can't start with a [Wake-up, …] line");
    if (ROUTINE.test(text)) throw new MarkedText("a message can’t start with a [Routine, …] line");
    if (!opts.fromParent && !opts.fromThread && !opts.watching && !opts.wakeup && !opts.routine) {
      const view = this.o.memory.openThreadView(this.userId, this.pool);
      try { if (view.own.closeQuestion(this.threadId, "words")) this.o.threads?.questionsChanged?.(this.userId, this.pool, this.threadId); } finally { view.close(); }
    }
    if (opts.recentThreadIds) {
      if (this.working || this.recentWorkIds) throw new Busy("recent work needs an idle project chat");
      this.recentWorkIds = opts.recentThreadIds;
      this.recentWorkSource = opts.recentWorkSource;
      try { return await this.post(text); } catch (err) { this.recentWorkIds = undefined; this.recentWorkSource = undefined; throw err; }
    }
    if (opts.routine) return this.post(`${opts.routine}${text}`, true);
    if (opts.watching) return this.post(`${WATCHING_MARK}${text}`, true);
    if (opts.wakeup) return this.post(`${opts.wakeup}${text}`, true);
    const from = opts.fromParent ?? opts.fromThread;
    return from ? this.post(`${fromParent(from)}${text}`, true) : this.post(text);
  }

  /** The text as it goes to the session, its marks already checked. `marked`: from another thread or a look. */
  private async post(text: string, marked = false): Promise<{ queued: boolean }> {
    if (this.busy) {
      if (marked) {
        this.steer(text);
        return { queued: false };
      }
      this.queued.push(text);
      this.emit({ type: "queue", queued: [...this.queued] });
      return { queued: true };
    }
    const steer: Steer | undefined = marked ? { text, handed: false, prompt: false } : undefined;
    if (steer) this.steering.push(steer);
    // The person's messages held while no model could be reached go first, with this one; marked ones go apart.
    const held = this.queued.splice(0);
    if (held.length) this.emit({ type: "queue", queued: [] });
    const person = [...held, ...(marked ? [] : [text])];
    try {
      return await this.start(person.length ? person.join("\n\n") : undefined);
    } catch (err) {
      // The sender is told it failed.
      if (steer) this.steering = this.steering.filter((s) => s !== steer);
      throw err;
    }
  }

  /** Starts a turn with the person's text, or else with the first marked message waiting. */
  private async start(text: string | undefined): Promise<{ queued: boolean }> {
    const first = text === undefined ? this.steering[0] : undefined;
    const prompt = text ?? first?.text;
    if (prompt === undefined) return { queued: false };
    if (first) first.prompt = true;
    this.unhold();
    this.busy = true;
    try {
      await this.open();
    } catch (err) {
      this.busy = false;
      if (first) first.prompt = false;
      if (err instanceof Offline) {
        this.hold(text, err);
        return { queued: true };
      }
      const message = plainError(refusal(err));
      this.emit({ type: "error", message });
      throw new Error(message);
    }
    // Text given here is the person's (held or unmarked); a turn started from steering isn't.
    this.running = this.run(prompt, { person: text !== undefined });
    return { queued: false };
  }

  /** A marked message for the running turn: into Pi's steering queue if the session is open, else at the next turn's start. */
  private steer(text: string): void {
    const s: Steer = { text, handed: false, prompt: false };
    this.steering.push(s);
    if (this.opened) this.hand(this.opened, s);
  }

  /**
   * Pi takes a steer after the current tool call, or after the reply being
   * written, and stores it as a user message. It goes straight to the
   * agent's queue, so nothing in it is expanded and it is queued at once.
   */
  private hand(opened: Opened, s: Steer): void {
    s.handed = true;
    opened.session.agent.steer({ role: "user", content: [{ type: "text", text: s.text }], timestamp: Date.now() });
  }

  /** Pi took a user message: a marked one shows in the views now. */
  private took(text: string): void {
    const i = this.steering.findIndex((s) => (s.handed || s.prompt) && s.text === text);
    if (i < 0) return;
    this.steering.splice(i, 1);
    this.emit({ type: "received", text });
  }

  /** After a turn: the steers it didn't take come out of Pi's queue, to go into the next turn or be kept. */
  private untake(opened: Opened | undefined): void {
    opened?.session.agent.clearSteeringQueue();
    // A turn's own first message went with it.
    this.steering = this.steering.filter((s) => !s.prompt);
    for (const s of this.steering) s.handed = false;
  }

  /**
   * Marked messages no turn will take (it was stopped or failed, or the
   * thread is closing, or no model answers): appended to the stored thread
   * after what Pi stored, as the user messages they would have been, and
   * shown. The open session lacks them, so the next turn opens a fresh one.
   */
  private keep(): void {
    const opened = this.opened;
    this.untake(opened);
    const kept = this.steering.splice(0);
    if (!kept.length) return;
    try {
      const view = this.o.memory.openThreadView(this.userId, this.pool);
      try {
        if (!view.own.getThread(this.threadId)) return;
        if (opened) syncEntries(opened.session.sessionManager, view.own, this.threadId);
        for (const s of kept) appendUserMessage(view.own, this.threadId, s.text);
      } finally {
        view.close();
      }
    } catch (err) {
      this.o.log(`keeping ${kept.length} message(s) in a ${this.pool} thread failed: ${(err as Error).name}`);
      return;
    }
    for (const s of kept) this.emit({ type: "received", text: s.text });
    if (this.busy) this.stale = true;
    else this.dispose();
  }

  private running: Promise<void> = Promise.resolve();

  /** Resolves when the running turn, and the messages queued behind it, are done. */
  settled(): Promise<void> { return this.imageRetryDone ?? this.running; }

  /** Waiting for an answer to a permission request. */
  get waiting(): boolean { return this.pending.size > 0; }
  get permissions(): PermissionRequest[] { return [...this.pending.values()].map((p) => p.request); }

  /** A turn runs, or a message waits for a model to answer. */
  get working(): boolean { return this.busy || !!this.held; }

  /**
   * Child notices are already delivered; wake once without inventing a user message.
   * With `note`, a child woken for messages saved while no slot was free: not a child-woken turn.
   */
  async wakeChild(note?: string): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try { await this.open(); }
    catch (err) { this.busy = false; throw err; }
    this.running = this.run(CHILD_WAKE, { childWake: !note, wake: note ?? "Read the child thread notices and respond to the result or question." });
  }

  private readonly parentReplies: string[] = [];

  /** A reply from a parent woken by this child is saved, never steered or run. */
  appendParent(text: string, parent: string): void {
    this.parentReplies.push(`${fromParent(parent)}${text}`);
    if (!this.busy) this.keepParentReplies();
  }

  private keepParentReplies(): void {
    if (!this.parentReplies.length) return;
    const view = this.o.memory.openThreadView(this.userId, this.pool);
    try {
      if (!view.own.getThread(this.threadId)) { this.parentReplies.length = 0; return; }
      if (this.opened) syncEntries(this.opened.session.sessionManager, view.own, this.threadId);
      for (const text of this.parentReplies.splice(0)) {
        appendUserMessage(view.own, this.threadId, text);
        this.emit({ type: "received", text });
      }
      this.dispose();
    } finally { view.close(); }
  }

  private async run(text: string, opts: { childWake?: boolean; wake?: string; person?: boolean } = {}): Promise<void> {
    this.stopIdle();
    let aborted = false;
    // Whether the person's own text is part of this turn: a child's wake or a marked message isn't.
    let theirs = !!opts.person;
    let childWake = !!opts.childWake, wake = opts.wake;
    this.o.onTurn?.(this.userId, this.pool, this.threadId, true, theirs);
    try {
      for (let next: string | undefined = text; next !== undefined && !this.closed;) {
        this.childWakeTurn = childWake;
        const opened = await this.open();
        await this.retrying;
        try {
          await opened.prepare();
        } catch (err) {
          if (!(err instanceof Offline)) throw err;
          // Nothing is stored yet: the messages wait, and go once a model answers again. Marked ones wait apart.
          const marked = this.steering.find((s) => s.prompt);
          if (marked) marked.prompt = false;
          const person = [...(marked ? [] : [next]), ...this.queued.splice(0)];
          this.hold(person.length ? person.join("\n\n") : undefined, err);
          break;
        }
        // Marked messages that came while no session was open: Pi takes them after this turn's first message.
        for (const s of this.steering) if (!s.handed && !s.prompt) this.hand(opened, s);
        this.emit({ type: "turn_start" });
        // A compaction belongs to the turn that asked for it, even one that failed.
        opened.meter.pending = undefined;
        this.failed = false;
        const entry = (next === OPENING ? opened.view.own.loadEntries(this.threadId).at(-1) : undefined) as { message?: { role?: string; content?: unknown } } | undefined;
        if (wake) {
          childWake = false;
          const content = wake;
          wake = undefined;
          await opened.session.sendCustomMessage({ customType: CHILD_WAKE, content, display: false }, { triggerTurn: true });
        } else if (next === OPENING && entry?.message?.role === "user" && textOf(entry.message.content) === OPENING) {
          await this.answerOpening(opened.session);
        } else {
          try { await opened.session.prompt(next); } finally { this.recentWorkIds = undefined; this.recentWorkSource = undefined; }
        }
        aborted = this.aborted;
        await this.afterTurn(opened, aborted);
        // What the turn didn't take goes next, or, if it was stopped or failed, is kept in the stored thread.
        this.untake(opened);
        if (aborted || this.failed) this.keep();
        this.emit({ type: "turn_end", aborted });
        this.aborted = false;
        void this.maybeTitle(opened);
        if (this.stale) this.dispose();
        this.keepParentReplies();
        const nxt = this.next();
        if (nxt.person) theirs = true;
        next = nxt.text;
      }
    } catch (err) {
      this.emit({ type: "error", message: plainError(refusal(err)) });
      this.keep();
      this.emit({ type: "turn_end", aborted });
      this.queued = [];
    } finally {
      this.busy = false;
      this.childWakeTurn = false;
      this.keepParentReplies();
      this.aborted = false;
      // A session that lacks what keep stored: the next turn opens afresh.
      if (this.stale) this.dispose();
      // Shutdown, Lock or forgetting closes it: a child keeps its record of working, so a restart tells its parent.
      if (!this.closing) this.o.onTurn?.(this.userId, this.pool, this.threadId, false, theirs);
      this.startIdle();
    }
  }

  private aborted = false;

  /** The next turn's message and whether it is the person's own text: their follow-ups together, else the first marked message waiting. */
  private next(): { text?: string; person: boolean } {
    if (this.queued.length) {
      const text = this.queued.splice(0).join("\n\n");
      this.emit({ type: "queue", queued: [] });
      return { text, person: true };
    }
    const s = this.steering[0];
    if (!s) return { person: false };
    s.prompt = true;
    return { text: s.text, person: false };
  }

  /**
   * No model for the thread's chat can be reached: the person's text waits in
   * the queue (marked messages wait apart), the views are told once, and
   * every HEALTH_MS lyricad asks the machines again (resolveLive), sending it
   * as soon as one answers. Stop, or a new message (which goes with it), ends
   * the wait.
   */
  private hold(text: string | undefined, err: Offline): void {
    this.queued = text !== undefined ? [text] : [];
    this.emit({ type: "queue", queued: [...this.queued] });
    this.emit({ type: "offline", task: err.task, tried: err.tried });
    this.waitForModel();
  }

  private turnTask: "chat" | "code" = "chat";

  private chatTask(): "chat" | "code" {
    return this.o.workspace.settings(this.userId).effective(this.threadId).code ? "code" : "chat";
  }

  private waitForModel(ms = this.o.offlineRetryMs ?? HEALTH_MS): void {
    this.unhold();
    this.held = setTimeout(() => {
      this.held = undefined;
      const waiting = () => this.queued.length > 0 || this.steering.length > 0;
      if (this.closed || this.busy || !waiting()) return;
      const send = () => { if (!this.closed && !this.busy && waiting()) void this.start(this.queued.length ? this.queued.splice(0).join("\n\n") : undefined).catch(() => {}); };
      // Anything but Offline (the list was changed to one that can't work, say) is said by the turn itself.
      this.o.models.resolveLive(this.chatTask(), this.o.models.callContext(this.userId, this.pool, this.threadId))
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
    if (pace) this.o.models.recordPace(this.userId, this.threadId, pace, this.turnTask, this.pool);
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
    // Marked messages that came meanwhile start a turn of their own.
    if (!next.length) {
      await this.start(undefined);
      return;
    }
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

  /**
   * Stop: aborts the running turn, denies waiting permission requests and
   * drops the person's queued messages (the views give them back). Marked
   * messages no turn took are kept in the stored thread. Only the person's
   * Stop and a parent's `threads stop` withdraw an open question; lock and
   * pause keep it for the person to answer.
   */
  async stop(withdrawQuestion = false): Promise<void> {
    if (withdrawQuestion) {
      const view = this.o.memory.openThreadView(this.userId, this.pool);
      try { if (view.own.closeQuestion(this.threadId, "withdrawn")) this.o.threads?.questionsChanged?.(this.userId, this.pool, this.threadId); } finally { view.close(); }
    }

    this.unhold();
    this.imageRetryAbort?.abort();
    for (const p of [...this.pending.values()]) p.done(false, "stopped");
    if (this.queued.length) {
      this.queued = [];
      this.emit({ type: "queue", queued: [] });
    }
    if (this.imageRetryDone) { await this.imageRetryDone.catch(() => {}); return; }
    if (!this.busy) return this.keep();
    if (!this.opened) return;
    this.aborted = true;
    await this.opened.session.abort();
    // Lock, forgetting or shutdown disposes the session next: kept now, while it can still be synced.
    if (this.closing) this.keep();
  }

  private imageRetryAbort?: AbortController;
  private imageRetryDone?: Promise<void>;

  /** Explicit image retry: same executor and consent checks, no changes to saved task lists. */
  retryImage(args: Parameters<typeof executeImage>[2], offeringId: string, userMessageN?: number): Promise<void> {
    if (this.closed) throw new Error("this thread was closed");
    if (this.busy) throw new Busy("a turn is running: stop it or wait for it to end");
    const done = this.runImageRetry(args, offeringId, userMessageN);
    this.imageRetryDone = done;
    return done.finally(() => { if (this.imageRetryDone === done) this.imageRetryDone = undefined; });
  }

  private async runImageRetry(args: Parameters<typeof executeImage>[2], offeringId: string, userMessageN?: number): Promise<void> {
    const view = this.o.memory.openThreadView(this.userId, this.pool);
    this.busy = true;
    const controller = this.imageRetryAbort = new AbortController();
    const id = `image-retry-${randomBytes(12).toString("hex")}`;
    const { workspace, models } = this.o;
    this.stopIdle();
    this.o.onTurn?.(this.userId, this.pool, this.threadId, true);
    try {
      await this.opening?.catch(() => {});
      this.dispose();
      const tools = workspace.forThread({ userId: this.userId, pool: this.pool, threadId: this.threadId, project: view.own.projectOf(this.threadId), coordinates: !!view.own.getThread(this.threadId)?.project });
      this.emit({ type: "turn_start" });
      this.emit({ type: "message_start" });
      this.emit({ type: "tool_start", toolCallId: id, name: "image", args });
      let result;
      try {
        result = await executeImage({ models, threadId: this.threadId,
          call: () => { const ctx = models.callContext(this.userId, this.pool, this.threadId); return { ...ctx,
            overrides: { ...ctx.overrides, [`image.${args.action}`]: [{ offeringId }] }, fallback: false }; },
          files: workspace.imageFiles({ userId: this.userId, pool: this.pool, threadId: this.threadId, coordinates: !!view.own.getThread(this.threadId)?.project }),
          settings: () => workspace.settings(this.userId), enabled: () => tools.settings().images && tools.settings().mode !== "plan",
          approve: r => this.approve(r),
        }, id, args, controller.signal);
      } catch (err) { result = { content: [{ type: "text" as const, text: plainError((err as Error).message) }], isError: true, details: undefined }; }
      const text = shortResult(result.content);
      const manager = SessionManager.inMemory(this.o.cwd, undefined, view.own.loadEntries(this.threadId) as never);
      manager.appendCustomMessageEntry("lyrica-image-retry", result.content, true,
        { toolCallId: id, args, result: { details: result.details, isError: !!result.isError }, userMessageN });
      syncEntries(manager, view.own, this.threadId);
      this.emit({ type: "tool_end", toolCallId: id, name: "image", result: text, isError: !!result.isError,
        image: imagePart("image", result.details), imageRefusal: imageRefusal("image", result.details) });
    } finally {
      view.close(); this.imageRetryAbort = undefined; this.busy = false;
      this.o.onTurn?.(this.userId, this.pool, this.threadId, false);
      this.emit({ type: "turn_end", aborted: controller.signal.aborted }); this.startIdle();
      const waiting = this.queued.splice(0);
      if (waiting.length) { this.emit({ type: "queue", queued: [] }); await this.start(waiting.join("\n\n")); }
    }
  }

  // --- Permission prompts ---

  /** What her `models` tool reaches: the thread's context is read again on each call, so a thread turned local-only loses it at once. */
  private modelsHost(): ModelsHost {
    const { models, users } = this.o;
    const actor = () => users.get(this.userId)!;
    const copies = () => models.hostCopies(actor(), models.callContext(this.userId, this.pool, this.threadId));
    const mine = (offering: string) => {
      if (!copies().some((c) => c.offering === offering)) throw new Error("That isn't a host model you can manage here.");
      return offering;
    };
    const ctx = () => models.callContext(this.userId, this.pool, this.threadId);
    const localCopies = () => models.localCopies(actor(), ctx());
    const local = (offering: string) => {
      if (!localCopies().some((c) => c.offering === offering)) throw new Error("That isn't a model you can manage here.");
      return offering;
    };
    return {
      copies,
      localCopies,
      // The model the session talks to now, else the one the router would pick.
      current: () => {
        const m = this.opened?.session.model;
        const found = m && models.allowed(ctx()).find(({ endpoint }) => endpoint.id === m.provider)?.offerings.find((o) => o.modelId === m.id);
        if (found) return found.id;
        try { return models.resolve("chat", ctx()).ref.offeringId; } catch { return undefined; }
      },
      window: (offering) => models.offering(this.userId, offering)?.offering.contextWindow,
      localContext: (offering) => models.localContext(this.userId, local(offering)),
      loadLocal: async (offering, contextLength) => { await models.loadLocalContext(actor(), local(offering), contextLength); this.reload(); this.publish({ type: "settings" }); },
      // Saved with the thread's choices; the session reopens with it once this turn ends.
      limit: (tokens) => { models.setContextLimit(this.userId, this.threadId, tokens); this.reload(); this.publish({ type: "settings" }); },
      serving: (offering) => models.servingSettings(this.userId, mine(offering)),
      lookup: (offering, repo) => models.lookupRecommended(actor(), mine(offering), repo),
      propose: async (p) => (await this.ask(p.toolCallId, "models", { action: "propose", name: p.name, host: p.host, contextLength: p.contextLength, stretch: p.stretch, kvBytes: p.kvBytes, documented: p.documented ?? null, ...(p.now ? { now: true } : {}) })).allowed,
      apply: async (offering, settings, anyway) => {
        await models.setServingSettings(actor(), mine(offering), settings, { anyway });
        // Loaded and idle: reload now. In use or not loaded: it applies at the next load.
        const reloaded = await models.reloadModel(actor(), offering).then(() => true, () => false);
        // The thread plans by the new window next turn, and her Models page reads it again (live sync).
        this.reload(); this.publish({ type: "settings" });
        return { reloaded };
      },
    };
  }

  /** What her download tools reach: read again on each call, so a thread turned local-only loses its hosts at once. */
  private downloadsHost(): DownloadsHost {
    const { models, users } = this.o;
    const actor = () => users.get(this.userId)!;
    const hosts = () => models.downloadHosts(actor(), models.callContext(this.userId, this.pool, this.threadId));
    const mine = (id: string) => {
      if (!hosts().some((h) => h.id === id)) throw new Error("That isn't a model host you can manage here.");
      return id;
    };
    return {
      hosts,
      files: async (id, source, repo) => (await models.hubFiles(actor(), mine(id), { source, repo })) as HubListing,
      start: async (id, source, repo, files) => { await models.startDownload(actor(), mine(id), { source, repo, files }); },
    };
  }

  /** Asks every open view of the thread. A timeout or Stop denies. */
  private async approve(r: ApprovalRequest): Promise<boolean> {
    return (await this.ask(r.toolCallId, r.tool, r.input, { ...onMachine(r), ...commandApproval(this.o, this.userId, this.pool, this.threadId, r.tool, r.input) })).allowed;
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
  answer(requestId: string, allow: boolean, mode?: GoAhead, allowInThread?: boolean, alwaysAllow?: boolean): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    if (p.request.tool === "propose_plan" && allow && !GO_AHEAD.includes(mode!)) throw new Error("say which mode to go ahead in: ask, acceptEdits or auto");
    if (allow && alwaysAllow && allowInThread) throw new Error("Choose Always allow or Allow in this thread, not both.");
    if (allow && alwaysAllow) {
      if (!p.request.alwaysAllow || p.request.machine || p.request.tool !== "bash") throw new Error("This request cannot always allow a command.");
      const project = projectFor(this.o, this.userId, this.pool, p.request.subagent?.threadId ?? this.threadId);
      if (!project) throw new Error("This thread no longer belongs to a project.");
      this.o.workspace.settings(this.userId).addCommandRule(this.pool, project, { prefix: p.request.alwaysAllow, decision: "allow" });
    }
    if (allow && allowInThread) {
      // Stored for the thread the call runs in: a subagent's own, never its parent's.
      const where = p.request.subagent?.threadId ?? this.threadId;
      if (p.request.server && p.request.serverTool) this.o.workspace.settings(this.userId).allowToolInThread(where, p.request.server, p.request.serverTool);
      else if (!p.request.suspect) throw new Error("only a suspect command or an MCP tool can be allowed in this thread");
      else this.o.workspace.settings(this.userId).allowInThread(where, p.request.machine!, suspectKey(p.request.tool, p.request.args));
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
      // A project chat coordinates: its folders and clones are read-only to it, and its threads make the changes.
      const tools = workspace.forThread({ userId: this.userId, pool: this.pool, threadId: this.threadId, project: view.own.projectOf(this.threadId), coordinates: !!thread.project });
      const ctx: ThreadContext = { user, pool: this.pool, interface: thread.interface, threadId: this.threadId, view, call };
      // delegate is offered where the depth limit allows; it attaches itself, so background results reach this session.
      const canDelegate = delegation.depth(ctx) < delegation.limits.depth;
      const meter = new ContextMeter();
      // Repository skills by checkout and HEAD, so an unchanged checkout costs one git call a turn.
      const repoSkillsSeen = new Map<string, ListedSkill[]>();
      const { session, runtime, prepare, dispose } = await openThreadSession({
        thread: ctx, models, cwd: this.o.cwd, task: () => tools.settings().code ? "code" : "chat",
        extensions: [
          createLyricaExtension(ctx, {
            code: () => tools.settings().code,
            codeRepositories: () => codeRepositories(tools.target(), workspace.repositoriesFor({ userId: this.userId, pool: this.pool, threadId: this.threadId }), this.o.codePulls?.(this.userId, this.pool, this.threadId)),
            repoRules: () => repoRules(tools.target(), checkoutsOf(tools.settings(), workspace.repositoriesFor({ userId: this.userId, pool: this.pool, threadId: this.threadId }))),
            skills: {
              // The skills in this thread's own pool, then those it reads (a Private thread's General ones), then each
              // checkout's own (docs/briefs/skills.md). A name in its own pool wins.
              index: async () => {
                const checkouts = checkoutsOf(tools.settings(), workspace.repositoriesFor({ userId: this.userId, pool: this.pool, threadId: this.threadId }));
                return skillsIndex([
                  ...librarySkills(view).map((s) => ({ name: s.name, description: s.description, at: `s:${s.name}` })),
                  ...checkouts.length ? await repoSkills(tools.target(), checkouts, repoSkillsSeen) : [],
                ]);
              },
              read: (name) => [view.own, ...view.reads].map((p) => p.skills.read(name)).find(Boolean)?.body,
              propose: (input, call) => view.own.skills.propose(input, this.threadId, call, workspace.settings(this.userId).skillsAutoApprove()),
            },
            persona: () => persona.read(), profile: () => users.get(this.userId)!.profile, folders: tools.folders, meter,
            recentWork: () => this.recentWork(view),
            reactions: () => this.unseenReactions.splice(0),
            ...(this.o.name ? { name: this.o.name } : {}),
            ...(thread.project ? { projectThreads: () => this.o.projectThreads?.(this.userId, this.pool, this.threadId) } : {}),
          }),
          createWorkspaceExtension({
            ...tools,
            sameFile: (path) => this.o.sameFile?.claim(this.userId, this.pool, this.threadId, tools.fileKey(path), path),
            approve: (r) => this.approve(r),
            proposePlan: (r) => this.proposePlan(r),
            setMode: (mode) => { tools.setMode(mode); this.emit({ type: "settings" }); },
          }),
          createImageExtension({ models, threadId: this.threadId,
            call: () => models.callContext(this.userId, this.pool, this.threadId),
            files: workspace.imageFiles({ userId: this.userId, pool: this.pool, threadId: this.threadId, coordinates: !!thread.project }),
            settings: () => workspace.settings(this.userId), enabled: () => tools.settings().images && tools.settings().mode !== "plan",
            approve: r => this.approve(r),
          }),
          // web_search and web_fetch, behind the Web search switch; a fetch runs in the thread's sandbox.
          createWebExtension({ searxng: () => this.o.searxng?.(), target: () => tools.target() }),
          // The project's checks, run when a code turn that changed something ends.
          createChecksExtension({ checks: () => tools.checks(), code: () => tools.settings().code, plan: () => tools.settings().mode === "plan",
            checkouts: () => checkoutsOf(tools.settings(), workspace.repositoriesFor({ userId: this.userId, pool: this.pool, threadId: this.threadId })), target: () => tools.target() }),
          // Pi's MCP client and tool_search, only while the thread has a server: a change of grants reopens the session.
          ...(tools.settings().mcpServers.length ? [createMcpServersExtension(tools)] : []),
          ...(canDelegate ? [createDelegateExtension(ctx, delegation)] : []),
          // Child threads and compacting. Never a subagent's: a subagent works for its run, not on streams of its own.
          ...(!thread.subagent ? [createThreadsExtension(ctx, this.o.threads, meter)] : []),
          // Her reactions. Never a subagent's: the messages there are hers.
          ...(!thread.subagent ? [createReactExtension(ctx, { reacted: (n, reactions) => this.reacted(n, toReactions(reactions, this.userId) ?? []) })] : []),
          // The models tool: general threads only, for a user who can manage a host. Never a subagent's.
          ...(!thread.subagent && (models.hostCopies(user, call).length || models.localCopies(user, call).length) ? [createModelsExtension(this.modelsHost())] : []),
          // Downloading models when asked: general threads only, for a user who can manage a host. Never a subagent's.
          ...(!thread.subagent && models.downloadHosts(user, call).length ? [createDownloadsExtension(this.downloadsHost())] : []),
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
      return { session, view, meter, title, prepare: (opts?: { retry?: boolean }) => { this.turnTask = this.chatTask(); return prepare(opts); }, dispose: () => { unsubscribe(); dispose(); view.close(); } };
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
        if (e.message.role === "user") this.took(textOf(e.message.content));
        break;
      }
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a.type === "text_delta") this.emit({ type: "text", delta: a.delta });
        if (a.type === "thinking_delta") this.emit({ type: "thinking", delta: a.delta });
        // Principle 1: a call shows as the model starts writing it, not when the reply ends, so a reply of many calls isn't silent.
        // Its arguments follow with tool_start when it runs.
        if (a.type === "toolcall_start") {
          const call = a.partial.content[a.contentIndex];
          if (call?.type === "toolCall" && call.id && call.name) this.emit({ type: "tool_call", toolCallId: call.id, name: call.name });
        }
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
        if (m.role === "custom" && m.customType === TURN_TOOL_NOTICE) this.emit({ type: "notice", text: String(m.content), status: "limit" });
        if (m.role === "assistant") {
          this.failed = m.stopReason === "error";
          const u = m.usage;
          if (u) this.emit({ type: "usage", input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens });
          if (m.stopReason === "error" && m.errorMessage) {
            // A machine that is off or away: the next turn falls back past it, and when none is left the views say so.
            const provider = this.opened?.session.model?.provider ?? "";
            // A plan out of usage: this turn ends with OpenAI's words, and the next falls back past it.
            if (isPlanLimit(m.errorMessage) && isPlan(this.o.models.endpoint(this.userId, provider)?.api)) this.o.models.reportPlanLimit(provider);
            const offline = isUnreachable(m.errorMessage) && this.opened ? this.wentAway(provider) : undefined;
            if (offline) this.emit({ type: "offline", task: offline.task, tried: offline.tried });
            else this.emit({ type: "error", message: plainError(m.errorMessage) });
          }
        }
        break;
      }
      case "entry_appended": {
        // Delivered while she was idle: appended straight to the session.
        const entry = e.entry as { type: string; customType?: string; content?: unknown; details?: unknown };
        if (entry.type === "custom_message" && entry.customType === TURN_TOOL_NOTICE) this.emit({ type: "notice", text: String(entry.content), status: "limit" });
        // Two replies with only thinking: the turn failed, so a project hears it as it would an error.
        if (entry.type === "custom_message" && entry.customType === EMPTY_REPLY_NOTICE) this.emit({ type: "error", message: String(entry.content) });
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
        const image = !e.isError ? imagePart(e.toolName, (e.result as { details?: unknown } | undefined)?.details) : undefined;
        const refusedImage = imageRefusal(e.toolName, (e.result as { details?: unknown } | undefined)?.details);
        this.emit({ type: "tool_end", ...(refusedImage ? { imageRefusal: refusedImage } : {}), toolCallId: e.toolCallId, name: e.toolName, result, isError: e.isError, ...(threads ? { threads } : {}), ...(image ? { image } : {}) });
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
      this.o.models.resolve(this.chatTask(), this.o.models.callContext(this.userId, this.pool, this.threadId));
      return undefined;
    } catch (err) {
      return err instanceof Offline ? err : undefined;
    }
  }

  /** Answer the stored opening, retaining Pi's prompt hooks, loadout and retry lifecycle. */
  private async answerOpening(session: AgentSession): Promise<void> {
    // AgentSession has no public continuation API. Omit its new opening at
    // the agent boundary; the existing user message is already in context.
    const agent = session.agent;
    const prompt = agent.prompt;
    agent.prompt = async (input: string | AgentMessage | AgentMessage[]) => {
      agent.prompt = prompt;
      if (!Array.isArray(input)) throw new Error("expected Pi's prepared prompt messages");
      await prompt.bind(agent)(input.filter((m) => !(m.role === "user" && textOf(m.content) === OPENING)));
    };
    try {
      await session.prompt(OPENING);
    } finally {
      agent.prompt = prompt;
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

/** The active skills a thread's view sees: its own pool's, then the pools it reads, a name listed once. */
function librarySkills(view: PoolView): Skill[] {
  const seen = new Set<string>();
  return [view.own, ...view.reads].flatMap((p) => p.skills.active()).filter((s) => !seen.has(s.name) && !!seen.add(s.name));
}

function refusal(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof CloudModelForbidden) return `Refused: ${message}`;
  if (err instanceof NoModel) return `No model: ${message}`;
  return message;
}

/** A message's text parts, joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((p: { type?: string }) => p.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n") : "";
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
  if (r.server) return { server: r.server, ...(r.serverTool ? { serverTool: r.serverTool } : {}) };
  if (!r.machine) return r.warning ? { warning: r.warning } : {};
  return { machine: r.machine, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.warning ? { suspect: true as const, warning: r.warning } : {}) };
}

/** Project ownership follows subagent parents, at every depth. */
function projectFor(o: HostOptions, userId: string, pool: Pool, threadId: string): string | undefined {
  const view = o.memory.openThreadView(userId, pool);
  try {
    let id = threadId;
    while (view.own.getThread(id)?.subagent && view.own.getThread(id)?.parent) id = view.own.getThread(id)!.parent!;
    return view.own.projectOf(id);
  } finally { view.close(); }
}

function commandApproval(o: HostOptions, userId: string, pool: Pool, threadId: string, tool: string, input: Record<string, unknown>): Partial<PermissionRequest> {
  if (tool !== "bash" || input.machine || !projectFor(o, userId, pool, threadId)) return {};
  const prefix = alwaysAllowPrefix(String(input.command));
  return prefix ? { alwaysAllow: prefix } : {};
}
