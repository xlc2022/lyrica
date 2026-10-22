import { randomBytes } from "node:crypto";
import {
  makeWorktrees, worktreeGrants, removeWorktrees, DEFAULT_THREADS_LIMITS, matchModel, unmatched, type ChildInfo, type Memory, type Models, type Pool, type StartRequest, type ThreadsLimits, type ThreadState, type ThreadStep, type Users, type Workspace,
} from "@lyrica/core";
import type { Delegation, Delivery, ThreadContext, ThreadsHost } from "@lyrica/extension";
import type { ThreadHost } from "./hosted.ts";
import type { ProjectSettings } from "./projects.ts";
import type { Wakeups } from "./wakeups.ts";

// Child threads Lyrica starts. Each is hosted like any thread; this keeps one
// row per child in user.db (no conversation text): whether it was working,
// for after a restart, and how many updates it posted that nobody has seen.
// A project's threads are child threads of the project chat, with an anchor
// (the project chat's entry they hang off), a resolved time, whether they
// wait on the user, and whether they are queued.

/** Turns a parent woken by a child may start in that child before the person writes in either. */
export const MAX_WAKE_ROUNDS = 3;

/** A project's thread idle this long is resolved by the nightly tick. */
export const AUTO_RESOLVE_DAYS = 7;

interface Row {
  pool: Pool; thread: string; parent: string; working: number; unseen: number;
  anchor: number | null; resolved_at: string | null; needs_you: number; queued: number;
}

/** A project's thread for the project chat and the sidebar. */
export interface ProjectThreadInfo extends ChildInfo { worktreeReason?: string; state: ThreadState; held?: { thread: string; title?: string; path: string }; anchor?: number; unseen: number; resolvedAt?: string }

export interface ChildOptions {
  users: Users;
  memory: Memory;
  models: Models;
  workspace: Workspace;
  delegation: Delegation;
  host: () => ThreadHost;
  limits?: Partial<ThreadsLimits>;
  /** Whether a project is paused or hidden: its threads start nothing and take no messages. */
  paused?: (userId: string, pool: Pool, project: string) => boolean;
  /** The model and thinking a project's new threads start with, if the user chose them. */
  draft?: (userId: string, pool: Pool, project: string, change: { goal?: string; instructions?: string }) => void;
  project?: (userId: string, pool: Pool, project: string) => ProjectSettings;
  /** A project's thread posted to the project chat. */
  updated?: (userId: string, pool: Pool, project: string, thread: string) => void;
  /** Wake-ups, which her `threads later` sets. */
  wakeups?: () => Wakeups;
  /** The thread's unsettled same-file hold (same-file.ts), shown as Blocked while it is idle. */
  held?: (userId: string, pool: Pool, thread: string) => { other: string; path: string } | undefined;
  /** One of a project's threads messaged another: a hold between them is theirs to settle. */
  messaged?: (userId: string, pool: Pool, from: string, to: string) => void;
}

/** The most of a child's last message that goes to its parent as its report. */
const IMPLICIT_REPORT_CHARS = 4000;
/** A project idle this long with its checklist unfinished wakes its chat, at most this many times until its threads move. */
export const IDLE_WATCH = { ms: 10 * 60_000, wakes: 2 };
const IDLE_NOTE = "Nothing in this project is running, and its checklist isn't finished. Carry on, or tell the person what you're waiting for.";

export class ChildThreads implements ThreadsHost {
  readonly limits: ThreadsLimits;
  private readonly bases = new Map<string, string>();
  private readonly cleaning = new Map<string, Promise<void>>();
  private readonly cleanupAfterTurn = new Set<string>();
  private readonly recovered = new Set<string>();
  /** Starts under way, per user, with their thread once made: until its turn runs, each counts against the limit. */
  private readonly starting = new Map<string, Set<{ pool?: Pool; thread?: string }>>();
  /** Queued starts' tasks, held in memory only: a restart tells the project chat instead. */
  private readonly queue = new Map<string, { task: string; parent: string }>();
  /**
   * Children working on a task from their parent, by `user/pool/thread`:
   * whether they have messaged the parent since. In memory only: a restart
   * tells the parent anyway (`recover`).
   */
  private readonly tasked = new Map<string, { reported: boolean }>();
  /**
   * Children whose parent was told they ended badly, until they report or
   * the person writes in them: a second bad end tells nobody, so a child that
   * fails every time can't keep its parent taking turns.
   */
  private readonly noticed = new Set<string>();
  /** A report in this turn, including a turn started by the user. */
  private readonly reports = new Set<string>();
  private readonly locking = new Set<string>();
  /** One pending or running wake per parent, with the children whose messages woke it. */
  private readonly parentWakes = new Map<string, { userId: string; pool: Pool; parent: string; children: Set<string>; running: boolean }>();
  /** Turns a child-woken parent started in each child since the person last wrote in either, by `user/pool/child`. */
  private readonly rounds = new Map<string, number>();
  /** Projects whose last turn was stopped, by `user/pool/project`: the idle watch leaves them alone until a turn there ends otherwise. */
  private readonly stoppedProjects = new Set<string>();
  /** The idle watch's wakes per project since the person last wrote in it, by `user/pool/project`. */
  private readonly idleWakes = new Map<string, number>();
  /** Idle threads holding a saved message until a slot frees, by `user/pool/thread`. In memory only: the message itself is stored. */
  private readonly waiting = new Map<string, { userId: string; pool: Pool; thread: string; parent: string }>();

  constructor(private readonly o: ChildOptions) {
    this.limits = { ...DEFAULT_THREADS_LIMITS, ...o.limits };
  }

  code(from: ThreadContext, on: boolean): void {
    if (from.view.own.getThread(from.threadId)?.subagent) throw new Error("a subagent can't change code mode");
    this.o.workspace.settings(from.user.id).setThread(from.threadId, from.pool, { code: on });
    this.o.host().peek(from.user.id, from.pool, from.threadId)?.publish({ type: "settings" });
  }

  codeOn(from: ThreadContext): boolean {
    return this.o.workspace.settings(from.user.id).effective(from.threadId).code;
  }

  model(from: ThreadContext, name: string): { label: string; already?: boolean; goesOn?: boolean } {
    if (from.view.own.getThread(from.threadId)?.subagent) throw new Error("a subagent can't change its model");
    const { models, workspace } = this.o;
    const userId = from.user.id;
    const call = models.callContext(userId, from.pool, from.threadId);
    const list = models.textModels(call);
    const found = models.find(userId, name);
    const m = found && "offeringId" in found ? list.find((x) => x.id === found.offeringId) : undefined;
    const match = m ? { model: m } : matchModel(name, list);
    if ("closest" in match) throw new Error(unmatched(name, match));
    const ref = { offeringId: match.model.id };
    const code = workspace.settings(userId).effective(from.threadId).code;
    let now: string | undefined;
    try { now = models.resolveModel(code ? "code" : "chat", call).offeringId; } catch { /* no usable model now: switch */ }
    if (now === ref.offeringId) return { label: match.model.label, already: true };
    models.setThreadModel(userId, from.pool, from.threadId, "chat", ref);
    // In code mode the thread runs on its Coding model, so that changes too.
    if (code) models.setThreadModel(userId, from.pool, from.threadId, "code", ref);
    // The turn that asked ends on the old model; the next starts by itself on the new one.
    // Not from a turn that itself went on after a switch: switches never chain unattended.
    const goesOn = this.o.host().reload(userId, from.pool, from.threadId, `You now run on ${match.model.label}. Go on with what you were doing.`);
    return { label: match.model.label, goesOn };
  }

  async start(parent: ThreadContext, req: StartRequest): Promise<{ id: string; link: string; queued?: boolean }> {
    const userId = parent.user.id;
    const own = parent.view.own;
    const project = !!own.getThread(parent.threadId)?.project;
    if (project && this.o.paused?.(userId, parent.pool, parent.threadId)) throw new Error("this project is paused; nothing new starts until the person resumes it");
    const baseKey = `${userId}/${parent.pool}/${parent.threadId}`;
    if (project && req.base) this.checkBase(userId, parent.pool, parent.threadId);
    // In a project, past the limit the thread waits its turn; elsewhere the start is refused.
    const queued = project && this.workingCount(userId) >= this.limits.concurrency;
    if (!project) this.mayStartTurn(userId);
    // Counted at once, so starts made together can't all slip under the limit.
    const slot: { pool?: Pool; thread?: string } = {};
    const mine = this.starting.get(userId) ?? new Set();
    this.starting.set(userId, mine);
    if (!queued) mine.add(slot);
    if (project && req.base) this.bases.set(baseKey, req.title);
    try {
      const made = await this.create(parent, req, project, queued, slot);
      // Held until the thread's turn begins (`turn`), so a start right after this one still counts it.
      if (queued) mine.delete(slot);
      return made;
    } catch (err) {
      mine.delete(slot);
      throw err;
    } finally {
      if (project && req.base) this.bases.delete(baseKey);
    }
  }

  private async create(parent: ThreadContext, req: StartRequest, project: boolean, queued: boolean, slot: { pool?: Pool; thread?: string }): Promise<{ id: string; link: string; queued?: boolean }> {
    const userId = parent.user.id;
    const own = parent.view.own;
    // The store refuses a child of a child; the workspace refuses anything wider than the parent.
    const child = own.createThread({ interface: parent.interface, parent: parent.threadId, child: true, title: req.title.slice(0, 200) });
    Object.assign(slot, { pool: parent.pool, thread: child.id });
    try {
      const ws = this.o.workspace.settings(userId);
      const grants = ws.effective(parent.threadId).grants
        .filter((g) => !req.folders || req.folders.some((f) => f.replace(/\/+$/, "") === g.path.replace(/\/+$/, "")))
        .map((g) => (req.readOnly ? { ...g, writable: false } : g));
      if (req.folders && grants.length < req.folders.length) throw new Error("a child thread can only have folders its parent has");
      // Machines are reached through bash, which no folder, read-only or network narrowing covers: a narrowed child gets none.
      const noMachines = !!req.readOnly || !!req.folders || req.internet === false;
      ws.inheritSettings(parent.threadId, child.id, parent.pool, { grants, ...(req.internet === false ? { internet: false } : {}), ...(noMachines ? { machines: [], repositories: [], mcpServers: [], claudeCode: false } : {}) });
      if (req.code || (project && this.o.project?.(userId, parent.pool, parent.threadId)?.code)) {
        ws.setThreadWork(child.id, { ...(req.base ? { base: true } : {}), worktrees: [] });
        if (!req.base) {
          const ref = { userId, pool: parent.pool, threadId: child.id, ...(project ? { project: parent.threadId } : {}) };
          const worktrees: import("@lyrica/core").Worktree[] = [];
          try {
            const target = this.o.workspace.targetFor(ref);
            const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "thread";
            // Git metadata is outside the encrypted home: identifiers only, never conversation titles.
            const branch = `lyrica/${slug(parent.threadId)}/${slug(child.id)}`;
            // Process each grant separately: an ordinary folder must not prevent isolating a git repository.
            const reasons: string[] = [];
            for (const grant of grants.filter((g) => g.writable)) {
              try {
                const made = await makeWorktrees(target, [grant], child.id, 1, undefined, { branch, directory: `${await (target.worktreeRoot?.() ?? target.cwd())}/worktrees` });
                if (typeof made === "string") reasons.push(made); else worktrees.push(...made.flat());
              } catch (err) { reasons.push((err as Error).message); }
            }
            if (!grants.some((g) => g.writable)) reasons.push("this thread has no writable host folders");
            ws.setThread(child.id, parent.pool, { grants: worktreeGrants(grants, worktrees, true), ...(worktrees.length ? { machines: [], mcpServers: [], claudeCode: false } : {}) });
            ws.setThreadWork(child.id, { worktrees, ...(reasons.length ? { reason: reasons.join("; ") } : {}) });
          } catch (err) {
            if (worktrees.length) await removeWorktrees(this.o.workspace.targetFor(ref), worktrees);
            ws.setThreadWork(child.id, { worktrees: [], reason: (err as Error).message });
          }
        }
      } else if (project && req.base) {
        ws.setThreadWork(child.id, { base: true, worktrees: [] });
      }
      this.o.models.inheritContext(this.o.models.callContext(userId, parent.pool, parent.threadId), child.id);
      // A cloud Dictation pick is consent for the thread it was made in: a new thread starts without it.
      this.o.models.setThreadModel(userId, parent.pool, child.id, "speech.transcribe");
      const chosen = project ? this.o.project?.(userId, parent.pool, parent.threadId) : undefined;
      if (chosen?.code !== undefined) ws.setThread(child.id, parent.pool, { code: chosen.code });
      // Asked for by her start: the child codes from its first turn, with its task as the Code task.
      if (req.code) {
        ws.setThread(child.id, parent.pool, { code: true });
        own.setCodeTask(child.id, req.task.slice(0, 300));
      }
      if (chosen?.model) this.o.models.setThreadModel(userId, parent.pool, child.id, "chat", chosen.model);
      if (chosen?.thinking) this.o.models.setThinking(userId, child.id, chosen.thinking);
      if (chosen?.fallback !== undefined) this.o.models.setThreadFallback(userId, child.id, chosen.fallback);
    } catch (err) {
      await this.cleanupWorktrees(userId, parent.pool, child.id, true);
      own.forgetThread(child.id, "lyrica");
      throw err;
    }
    // A project's thread hangs off the first entry the calling turn writes.
    const anchor = project ? own.turnStartN(parent.threadId) : null;
    this.db(userId, (db) => db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at, anchor, queued) VALUES (?, ?, ?, ?, ?, ?)")
      .run(parent.pool, child.id, parent.threadId, new Date().toISOString(), anchor, queued ? 1 : 0));
    const link = `#/u/${encodeURIComponent(userId)}/t/${parent.pool}/${encodeURIComponent(child.id)}`;
    if (queued) {
      this.queue.set(`${userId}/${parent.pool}/${child.id}`, { task: req.task, parent: parent.threadId });
      return { id: child.id, link, queued: true };
    }
    try {
      this.task(userId, parent.pool, child.id);
      await this.o.host().get(userId, parent.pool, child.id).send(req.task, { fromParent: parent.threadId });
    } catch (err) {
      this.tasked.delete(`${userId}/${parent.pool}/${child.id}`);
      // It never started: nothing is left of it.
      await this.o.host().forget(userId, parent.pool, child.id);
      await this.cleanupWorktrees(userId, parent.pool, child.id, true);
      this.forget(userId, parent.pool, [child.id]);
      own.forgetThread(child.id, "lyrica");
      this.o.models.forgetThread(userId, parent.pool, child.id);
      throw err;
    }
    return { id: child.id, link };
  }

  /**
   * Start a thread: the user starts a project's thread from a message of the
   * project chat (`anchor`), with that message's text as its task, or with no
   * anchor, hanging under the chat's last message. Queued past the limit, like
   * a start of hers.
   */
  async startFrom(userId: string, pool: Pool, project: string, anchor: number | undefined, req: { title: string; task: string }): Promise<string> {
    return this.asProjectChat(userId, pool, project, async (ctx) => {
      const made = await this.start(ctx, req);
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET anchor = ? WHERE pool = ? AND thread = ?").run(anchor ?? null, pool, made.id));
      return made.id;
    });
  }

  /** A look's line to a thread (watch.ts): sent as the project chat's `threads message` sends it, marked as from the project chat. */
  tellFromProject(userId: string, pool: Pool, project: string, to: string, text: string): Promise<Delivery> {
    return this.asProjectChat(userId, pool, project, (ctx) => this.message(ctx, to, text, {}, false));
  }

  private async asProjectChat<T>(userId: string, pool: Pool, project: string, fn: (ctx: ThreadContext) => Promise<T>): Promise<T> {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const user = this.o.users.get(userId)!;
      return await fn({ user, pool, interface: view.own.getThread(project)!.interface, threadId: project, view, call: this.o.models.callContext(userId, pool, project) } as ThreadContext);
    } finally {
      view.close();
    }
  }

  /** A look's entry in the project chat, without a turn: as a delivery is stored. */
  storeLook(userId: string, pool: Pool, project: string, content: string, details: object): void {
    const ref = { user: { id: userId }, pool, threadId: project } as Parameters<Delegation["deliver"]>[0];
    const d = { ...details, id: randomBytes(8).toString("hex") };
    this.o.delegation.deliver(ref, content, d);
    this.o.host().delivered(userId, pool, project, content, d);
  }

  /** `task`: a parent's message is work its child reports back on; a look's line isn't. */
  async message(from: ThreadContext, to: string, text: string, opts: { needsYou?: boolean; question?: boolean } = {}, task = true): Promise<Delivery> {
    const userId = from.user.id;
    if (to === "parent") {
      const row = this.row(userId, from.pool, from.threadId);
      if (!row || !from.view.own.getThread(row.parent)) throw new Error("this thread's parent is gone");
      const t = this.tasked.get(`${userId}/${from.pool}/${from.threadId}`);
      if (t) t.reported = true;
      this.reports.add(`${userId}/${from.pool}/${from.threadId}`);
      this.noticed.delete(`${userId}/${from.pool}/${from.threadId}`);
      const needsYou = !!opts.needsYou && !!from.view.own.getThread(row.parent)?.project;
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET unseen = unseen + 1, needs_you = CASE WHEN ? THEN 1 ELSE needs_you END WHERE pool = ? AND thread = ?")
        .run(needsYou ? 1 : 0, from.pool, from.threadId));
      // The mention shows as the current title, so none is written beside it.
      const head = needsYou ? `Child thread [t:${from.threadId}] is waiting on the person` : `Update from child thread [t:${from.threadId}]`;
      const wakes = needsYou || !!opts.question;
      this.deliver(userId, from.pool, row.parent, `${head}:\n${text}`, from.threadId, needsYou ? "waiting" : "update", wakes);
      if (from.view.own.getThread(row.parent)?.project) this.o.updated?.(userId, from.pool, row.parent, from.threadId);
      return wakes ? "wakes" : "update";
    }
    const target = this.row(userId, from.pool, to);
    const mine = this.row(userId, from.pool, from.threadId);
    // In a project, its threads may write to each other; anything else only to the thread's own children.
    const sibling = !!mine && !!target && target.parent === mine.parent && target.thread !== mine.thread && !!from.view.own.getThread(mine.parent)?.project;
    if (!target || (target.parent !== from.threadId && !sibling)) throw new Error(`[t:${to}] isn't a child thread of this one${mine ? ", or another thread of this project" : ""}`);
    if (this.o.paused?.(userId, from.pool, target.parent)) throw new Error("this project is paused; its threads take no messages until the person resumes it");
    if (target.queued) throw new Error(`[t:${to}] is queued and hasn't started; it starts when another thread finishes`);
    this.o.messaged?.(userId, from.pool, from.threadId, to);
    const host = this.o.host();
    const key = `${userId}/${from.pool}/${to}`;
    // A parent woken by this child answers it with a turn, for a few rounds; past that it's saved, so two threads can't keep each other going.
    const wake = this.parentWakes.get(`${userId}/${from.pool}/${from.threadId}`);
    if (wake?.running && wake.children.has(to) && host.get(userId, from.pool, from.threadId).childWakeTurn) {
      const n = (this.rounds.get(key) ?? 0) + 1;
      if (n > MAX_WAKE_ROUNDS) {
        host.get(userId, from.pool, to).appendParent(text, from.threadId);
        return "saved";
      }
      this.rounds.set(key, n);
    }
    if (target.resolved_at) this.setResolved(userId, from.pool, to, false);
    if (task && !sibling) this.task(userId, from.pool, to);
    // An idle thread starts a turn, so the limit holds here too: past it, the message is saved and the thread wakes when a slot frees.
    const busy = host.busy(userId, from.pool, to);
    if (!busy && (this.waiting.has(key) || this.workingCount(userId) >= this.limits.concurrency)) {
      host.get(userId, from.pool, to).appendParent(text, from.threadId);
      this.waiting.set(key, { userId, pool: from.pool, thread: to, parent: target.parent });
      this.wakeWaiting(userId);
      return this.waiting.has(key) ? "queued" : "started";
    }
    await host.get(userId, from.pool, to).send(text, sibling ? { fromThread: from.threadId } : { fromParent: from.threadId });
    return busy ? "running" : "started";
  }

  /** The thread works on a task from its parent, and owes it a report. */
  private task(userId: string, pool: Pool, thread: string): void {
    this.tasked.set(`${userId}/${pool}/${thread}`, { reported: false });
  }

  /**
   * A child's turn ended and it is idle. On a task from its parent, the
   * parent is told, as an update is delivered, when it ended without a
   * message to the parent since the task began (its last message, as its
   * report), or with an error: an error once, until the child reports or the
   * person writes in it (`noticed`). A stopped turn tells nobody: whoever
   * stopped it knows.
   */
  ended(userId: string, pool: Pool, thread: string, how: "done" | "error" | "stopped"): void {
    const key = `${userId}/${pool}/${thread}`;
    this.markStopped(userId, pool, thread, how === "stopped");
    const wake = this.parentWakes.get(key);
    if (wake?.running) this.parentWakes.delete(key);
    const reported = this.reports.delete(key);
    const t = this.tasked.get(key);
    if (how === "done" && reported) {
      const row = this.row(userId, pool, thread);
      if (row) this.queueParentWake(userId, pool, row.parent, thread);
    }
    this.drainWakes(userId);
    if (!t) return;
    this.tasked.delete(key);
    if (how === "stopped" || (how === "done" && t.reported) || (how === "error" && this.noticed.has(key))) return;
    let row: Row | undefined;
    try { row = this.row(userId, pool, thread); } catch { return; /* locked */ }
    if (!row) return;
    // Her last words count as the report she didn't send, marked so the parent knows.
    if (how === "done" && this.implicitReport(userId, pool, thread, row.parent)) return;
    if (how === "error") this.noticed.add(key);
    this.deliver(userId, pool, row.parent, how === "error"
      ? `Child thread [t:${thread}] stopped with an error, and is idle. Read it with threads read, or message it to go on.`
      : `Child thread [t:${thread}] finished without a report, and is idle. Read it with threads read, or message it.`, thread, "update", true);
  }

  /**
   * A tasked child ended without a report: its last reply, if it has one,
   * goes to the parent as its report would, marked as not sent with report.
   * It brings no look (watch.ts): the person didn't write, and the child posted nothing.
   * Returns whether there was one.
   */
  private implicitReport(userId: string, pool: Pool, thread: string, parent: string): boolean {
    const view = this.o.memory.openThreadView(userId, pool);
    let last: string | undefined;
    try {
      const e = view.own.getThread(thread)?.unlogged ? undefined : view.own.latestEntries(thread, 1)[0];
      if (e?.role === "assistant") last = e.text.trim();
    } finally { view.close(); }
    if (!last) return false;
    const text = last.length > IMPLICIT_REPORT_CHARS ? `${last.slice(0, IMPLICIT_REPORT_CHARS)}…` : last;
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET unseen = unseen + 1 WHERE pool = ? AND thread = ?").run(pool, thread));
    this.deliver(userId, pool, parent, `Child thread [t:${thread}] ended without a report; its last message, as its report:\n${text}`, thread, "update", true);
    return true;
  }

  /** A turn the person started (lyricad's onTurn): the idle watch may wake their project again. */
  personWrote(userId: string, pool: Pool, thread: string): void {
    try {
      const view = this.o.memory.openThreadView(userId, pool);
      try { const project = view.own.projectOf(thread); if (project) this.idleWakes.delete(`${userId}/${pool}/${project}`); } finally { view.close(); }
    } catch { /* locked */ }
  }

  /** A turn in a project ended: stopped, the idle watch leaves the project alone; any other end lets it watch again. */
  private markStopped(userId: string, pool: Pool, thread: string, stopped: boolean): void {
    let project: string | undefined;
    try {
      const view = this.o.memory.openThreadView(userId, pool);
      try { project = view.own.projectOf(thread); } finally { view.close(); }
    } catch { return; /* locked */ }
    if (!project) return;
    const key = `${userId}/${pool}/${project}`;
    if (stopped) this.stoppedProjects.add(key);
    else this.stoppedProjects.delete(key);
  }

  /**
   * lyricad's tick: a project with an unfinished checklist (its chat's or a
   * thread's) where nothing runs, waits or is queued, no question waits for
   * the person, and nothing was written for `IDLE_WATCH.ms` wakes its chat
   * with a note to carry on or say what it waits for. Never a paused or
   * hidden project, nor one whose last turn was stopped; at most
   * `IDLE_WATCH.wakes` times until the person writes in it (`personWrote`):
   * what its threads do meanwhile never resets that, so it can't run unattended.
   */
  watchIdle(now = new Date()): void {
    const host = this.o.host();
    if (host.draining) return;
    for (const userId of this.recovered) {
      if (this.locking.has(userId)) continue;
      try { this.watchUser(userId, now); } catch { /* locked meanwhile */ }
    }
  }

  private watchUser(userId: string, now: Date): void {
    const host = this.o.host();
    const rows = this.rows(userId);
    for (const pool of ["general", "private"] as const) {
      const due: string[] = [];
      const view = this.o.memory.openThreadView(userId, pool);
      try {
        for (const p of view.own.listThreads().filter((t) => t.project)) {
          const key = `${userId}/${pool}/${p.id}`;
          if (this.stoppedProjects.has(key) || this.o.paused?.(userId, pool, p.id) || host.busy(userId, pool, p.id) || this.parentWakes.has(key)) continue;
          const mine = rows.filter((r) => r.pool === pool && r.parent === p.id && !r.resolved_at);
          if (mine.some((r) => r.queued || r.needs_you || host.busy(userId, pool, r.thread) || this.waiting.has(`${userId}/${pool}/${r.thread}`))) continue;
          const threads = [p.id, ...mine.map((r) => r.thread)];
          if (threads.some((t) => view.own.openQuestion(t))) continue;
          if (!threads.some((t) => view.own.steps(t).some((s) => s.state !== "done"))) continue;
          const latest = (ts: string[]) => ts.map((t) => view.own.lastEntry(t)?.createdAt ?? "").reduce((a, b) => (a > b ? a : b), "");
          const last = latest(threads);
          if (!last || now.getTime() - Date.parse(last) < IDLE_WATCH.ms) continue;
          const n = this.idleWakes.get(key) ?? 0;
          if (n >= IDLE_WATCH.wakes) continue;
          this.idleWakes.set(key, n + 1);
          due.push(p.id);
        }
      } finally { view.close(); }
      for (const project of due) void host.get(userId, pool, project).wakeChild(IDLE_NOTE).catch(() => {});
    }
  }

  /** Stops a child's running turn, as Pause does: from its parent, or from the project chat. */
  async stop(from: ThreadContext, id: string): Promise<boolean> {
    const userId = from.user.id;
    const row = this.row(userId, from.pool, id);
    if (!row || row.parent !== from.threadId) throw new Error(`[t:${id}] isn't a child thread of this one`);
    this.tasked.delete(`${userId}/${from.pool}/${id}`);
    const host = this.o.host();
    if (!host.busy(userId, from.pool, id)) return false;
    await host.get(userId, from.pool, id).stop(true);
    this.turn(userId, from.pool, id, false);
    return true;
  }

  /** Her `threads later`: a wake-up for the thread she's in. */
  later(from: ThreadContext, minutes: number, note: string): { dueAt: string } {
    if (!this.o.wakeups) throw new Error("wake-ups aren't available here");
    return this.o.wakeups().set(from, minutes, note);
  }

  /** Her `threads later` with `cancel`. */
  cancelLater(from: ThreadContext): number {
    if (!this.o.wakeups) throw new Error("wake-ups aren't available here");
    return this.o.wakeups().cancel(from);
  }

  async asked(from: ThreadContext): Promise<void> {
    this.questionsChanged(from.user.id, from.pool, from.threadId);
    const t = from.view.own.getThread(from.threadId);
    if (t?.parent && from.view.own.getThread(t.parent)?.project) {
      const q = from.view.own.openQuestion(from.threadId)!;
      const ask = from.view.own.readAsk(from.threadId, q.n)!;
      await this.message(from, "parent", ask.question, { needsYou: true });
    }
  }

  questionsChanged(userId: string, pool: Pool, thread: string): void {
    const parent = this.parentOf(userId, pool, thread);
    if (parent) this.o.host().changed(userId, pool, parent, thread);
    this.o.host().peek(userId, pool, thread)?.publish({ type: "settings" });
  }

  questionClosed(userId: string, pool: Pool, thread: string, answer: "words" | "withdrawn"): void {
    const view = this.o.memory.openThreadView(userId, pool);
    let changed = false;
    try { changed = view.own.closeQuestion(thread, answer); } finally { view.close(); }
    if (changed) this.questionsChanged(userId, pool, thread);
  }

  /** Her `threads steps` changed this thread's checklist: its open views and its parent's card hear of it. */
  stepsChanged(from: ThreadContext): void {
    const host = this.o.host();
    host.peek(from.user.id, from.pool, from.threadId)?.publish({ type: "steps", steps: from.view.own.steps(from.threadId) });
    const parent = this.parentOf(from.user.id, from.pool, from.threadId);
    if (parent) host.changed(from.user.id, from.pool, parent, from.threadId);
  }

  /** Whether the user keeps the Checklists display switch on (the default); off, her threads aren't offered `threads steps`. */
  checklistsOn(from: ThreadContext): boolean {
    return this.checklists(from.user.id);
  }

  /** The user's Checklists switch; off, no list or summary carries steps. */
  private checklists(userId: string): boolean {
    const db = this.o.users.openUserDb(userId);
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'display'").get() as { value: string } | undefined;
      return !row || (JSON.parse(row.value) as { checklists?: boolean }).checklists !== false;
    } finally {
      db.close();
    }
  }

  /**
   * Whether a wake-up may start a turn in the thread now. A child waits for
   * a slot under the at-once limit, unless its turn is running; a queued
   * thread waits for its start, and a paused or hidden project's thread for
   * the project to resume.
   */
  mayWake(userId: string, pool: Pool, thread: string): boolean {
    const row = this.row(userId, pool, thread);
    if (!row) return true;
    if (row.queued || this.o.paused?.(userId, pool, row.parent)) return false;
    return this.o.host().busy(userId, pool, thread) || this.workingCount(userId) < this.limits.concurrency;
  }

  /** Routine turns share the child at-once budget, including standalone chats. */
  private readonly routineThreads = new Map<string, { userId: string; pool: Pool; thread: string }>();

  routineWaiting(userId: string, pool: Pool, thread: string): boolean {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const project = view.own.projectOf(thread);
      return !!this.row(userId, pool, thread)?.queued || !!(project && this.o.paused?.(userId, pool, project));
    } finally { view.close(); }
  }

  reserveRoutine(userId: string, pool: Pool, thread: string): { track(thread: string): void; release(): void } | undefined {
    if (this.routineWaiting(userId, pool, thread)) return;
    if (!this.mayWake(userId, pool, thread) || this.workingCount(userId) >= this.limits.concurrency) return;
    const slot: { pool?: Pool; thread?: string } = {};
    const mine = this.starting.get(userId) ?? new Set();
    this.starting.set(userId, mine);
    mine.add(slot);
    return {
      track: target => {
        Object.assign(slot, { pool, thread: target });
        this.routineThreads.set(`${userId}/${pool}/${target}`, { userId, pool, thread: target });
      },
      release: () => { mine.delete(slot); },
    };
  }

  /** A fresh thread in the source's project or thread list, with its privacy and workspace. */
  async routineThread(userId: string, pool: Pool, source: string, title: string): Promise<string> {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const own = view.own;
      const from = own.getThread(source)!;
      const project = own.projectOf(source);
      const made = own.createThread({ interface: from.interface, ...(project ? { parent: project, child: true } : {}), title, unlogged: from.unlogged });
      try {
        this.o.workspace.settings(userId).inheritSettings(source, made.id, pool);
        this.o.models.inheritContext(this.o.models.callContext(userId, pool, source), made.id);
        this.o.models.setThreadModel(userId, pool, made.id, "speech.transcribe");
        const chosen = project ? this.o.project?.(userId, pool, project) : undefined;
        if (chosen?.code !== undefined) this.o.workspace.settings(userId).setThread(made.id, pool, { code: chosen.code });
        if (chosen?.model) this.o.models.setThreadModel(userId, pool, made.id, "chat", chosen.model);
        if (chosen?.thinking) this.o.models.setThinking(userId, made.id, chosen.thinking);
        if (chosen?.fallback !== undefined) this.o.models.setThreadFallback(userId, made.id, chosen.fallback);
        if (project) this.db(userId, db => db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at) VALUES (?, ?, ?, ?)").run(pool, made.id, project, new Date().toISOString()));
        return made.id;
      } catch (err) {
        own.forgetThread(made.id, "lyrica");
        this.o.models.forgetThread(userId, pool, made.id);
        throw err;
      }
    } finally { view.close(); }
  }

  /** A wake-up fired in the thread: a resolved project thread reopens, as a message reopens it. */
  woke(userId: string, pool: Pool, thread: string): void {
    if (this.row(userId, pool, thread)?.resolved_at) this.setResolved(userId, pool, thread, false);
  }

  /** The thread's parent, if it is a child thread. */
  parentOf(userId: string, pool: Pool, thread: string): string | undefined {
    try { return this.row(userId, pool, thread)?.parent; } catch { return undefined; /* locked */ }
  }

  list(parent: ThreadContext): ChildInfo[] {
    const mine = this.row(parent.user.id, parent.pool, parent.threadId);
    // A project's thread sees the project's other threads.
    if (mine && parent.view.own.getThread(mine.parent)?.project) {
      return this.projectThreads(parent.user.id, parent.pool, mine.parent).filter((c) => c.id !== parent.threadId).map(({ unseen: _u, anchor: _a, resolvedAt: _r, ...c }) => c);
    }
    if (parent.view.own.getThread(parent.threadId)?.project) {
      return this.projectThreads(parent.user.id, parent.pool, parent.threadId).map(({ unseen: _u, anchor: _a, resolvedAt: _r, ...c }) => c);
    }
    return this.children(parent.user.id, parent.pool, parent.threadId).map(({ unseen: _u, ...c }) => c);
  }

  /** A project's threads, oldest first, with their state, anchor and unseen updates. */
  projectThreads(userId: string, pool: Pool, project: string): ProjectThreadInfo[] {
    const view = this.o.memory.openThreadView(userId, pool);
    const on = this.checklists(userId);
    try {
      return this.rows(userId).filter((r) => r.pool === pool && r.parent === project && view.own.getThread(r.thread)).map((r) => {
        const t = view.own.getThread(r.thread)!;
        const status = this.o.host().status(userId, pool, r.thread);
        const reason = this.o.workspace.settings(userId).threadWork(r.thread)?.reason;
        const state = stateOf(r, status);
        const hold = state === "idle" ? this.o.held?.(userId, pool, r.thread) : undefined;
        return {
          id: r.thread, ...(t.title ? { title: t.title } : {}), status, state: hold ? "held" : state, ...(hold ? { held: { thread: hold.other, ...(view.own.getThread(hold.other)?.title ? { title: view.own.getThread(hold.other)!.title! } : {}), path: hold.path } } : {}), ...(r.needs_you ? { needsYou: true } : {}),
          ...(reason ? { worktreeReason: reason } : {}),
          updatedAt: view.own.lastEntry(r.thread)?.createdAt ?? t.createdAt, unseen: r.unseen, ...(on ? stepsOf(view.own.steps(r.thread)) : {}),
          ...(r.anchor !== null ? { anchor: r.anchor } : {}), ...(r.resolved_at ? { resolvedAt: r.resolved_at } : {}),
        };
      });
    } finally {
      view.close();
    }
  }

  /** A project's threads for her project section: open ones a line each with what they wait on; resolved ones only counted. */
  projectLines(userId: string, pool: Pool, project: string): string | undefined {
    const all = this.projectThreads(userId, pool, project);
    const open = all.filter((t) => t.state !== "resolved");
    const resolved = all.length - open.length;
    const lines = open.map((t) => `- [t:${t.id}] ${t.title ? JSON.stringify(t.title) : "(untitled)"}: ${t.needsYou ? "waiting on the person" : t.status === "waiting" ? "waiting for an approval" : t.state}, last active ${t.updatedAt}`);
    if (resolved) lines.push(`- ${resolved} resolved`);
    return lines.join("\n") || undefined;
  }

  /** Resolves or reopens a project's thread, from her tool. A thread resolves only itself; the project chat any of its threads. */
  resolve(from: ThreadContext, id: string | undefined, resolved: boolean): Promise<void> {
    const userId = from.user.id;
    const target = id ?? from.threadId;
    const row = this.row(userId, from.pool, target);
    if (!row || !from.view.own.getThread(row.parent)?.project) throw new Error(`[t:${target}] isn't a thread of a project`);
    if (id !== undefined && row.parent !== from.threadId) throw new Error(`[t:${target}] isn't a thread of this project`);
    return this.setResolved(userId, from.pool, target, resolved);
  }

  /** Resolved (or reopened). Resolving clears waiting on the user; the parent's open views see the change. */
  setResolved(userId: string, pool: Pool, thread: string, resolved: boolean): Promise<void> {
    const row = this.row(userId, pool, thread);
    if (!row) throw new Error(`[t:${thread}] isn't a thread of a project`);
    if (!resolved && this.o.workspace.settings(userId).threadWork(thread)?.base) this.checkBase(userId, pool, row.parent, thread);
    if (resolved) this.questionClosed(userId, pool, thread, "withdrawn");
    this.db(userId, (db) => db.prepare(`UPDATE child_threads SET resolved_at = ?${resolved ? ", needs_you = 0" : ""} WHERE pool = ? AND thread = ?`)
      .run(resolved ? new Date().toISOString() : null, pool, thread));
    this.o.host().changed(userId, pool, row.parent, thread);
    const key = `${userId}/${pool}/${thread}`;
    if (!resolved) { this.cleanupAfterTurn.delete(key); return Promise.resolve(); }
    // A thread resolving itself mid-turn keeps its worktree until the turn ends.
    const work = this.o.workspace.settings(userId).threadWork(thread);
    if (!work?.worktrees.length || work.cleaned) return Promise.resolve();
    if (this.o.host().status(userId, pool, thread) !== "idle") { this.cleanupAfterTurn.add(key); return Promise.resolve(); }
    return this.cleanupWorktrees(userId, pool, thread);
  }

  /** Why the user can't write in this thread now: it is a resolved base thread, and another thread holds the base checkout. Checked before anything is sent. */
  baseHeld(userId: string, pool: Pool, thread: string): string | undefined {
    const row = this.row(userId, pool, thread);
    if (!row?.resolved_at || !this.o.workspace.settings(userId).threadWork(thread)?.base) return undefined;
    try { this.checkBase(userId, pool, row.parent, thread); return undefined; } catch (err) { return (err as Error).message; }
  }

  /** The user wrote in the thread: it no longer waits on them, and a resolved thread reopens. */
  userWrote(userId: string, pool: Pool, thread: string): void {
    this.questionClosed(userId, pool, thread, "words");
    this.noticed.delete(`${userId}/${pool}/${thread}`);
    this.rounds.delete(`${userId}/${pool}/${thread}`);
    for (const r of this.rows(userId)) if (r.pool === pool && r.parent === thread) this.rounds.delete(`${userId}/${pool}/${r.thread}`);
    const row = this.row(userId, pool, thread);
    if (!row || (!row.needs_you && !row.resolved_at)) return;
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET needs_you = 0, resolved_at = NULL WHERE pool = ? AND thread = ?").run(pool, thread));
    this.o.host().changed(userId, pool, row.parent, thread);
  }

  draft(from: ThreadContext, change: { goal?: string; instructions?: string }): void {
    if (!from.view.own.getThread(from.threadId)?.project || !this.o.draft) throw new Error("draft is for a project chat");
    this.o.draft(from.user.id, from.pool, from.threadId, change);
    this.o.host().peek(from.user.id, from.pool, from.threadId)?.publish({ type: "settings" });
  }

  /** A branch made in a project: a thread of the project, hanging at `anchor`. */
  adopt(userId: string, pool: Pool, thread: string, project: string, anchor: number | undefined): void {
    this.db(userId, (db) => db.prepare("INSERT OR IGNORE INTO child_threads (pool, thread, parent, started_at, anchor) VALUES (?, ?, ?, ?, ?)")
      .run(pool, thread, project, new Date().toISOString(), anchor ?? null));
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET parent = ?, anchor = ? WHERE pool = ? AND thread = ?").run(project, anchor ?? null, pool, thread));
    const queued = this.queue.get(`${userId}/${pool}/${thread}`);
    if (queued) queued.parent = project;
    this.o.host().changed(userId, pool, project, thread);
  }

  /** Where a project's thread hangs in the project chat, if it does. */
  anchorOf(userId: string, pool: Pool, thread: string): number | undefined {
    return this.row(userId, pool, thread)?.anchor ?? undefined;
  }

  /** A rewind of the parent from entry `fromN`: threads anchored there or later lose their anchor, and stay. */
  unanchor(userId: string, pool: Pool, parent: string, fromN: number): void {
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET anchor = NULL WHERE pool = ? AND parent = ? AND anchor >= ?").run(pool, parent, fromN));
  }

  /** The nightly tick: a project's threads idle for AUTO_RESOLVE_DAYS are resolved. Returns how many. */
  autoResolve(userId: string, now = new Date()): number {
    const cutoff = new Date(now.getTime() - AUTO_RESOLVE_DAYS * 86_400_000).toISOString();
    let n = 0;
    for (const pool of ["general", "private"] as const) {
      const view = this.o.memory.openThreadView(userId, pool);
      try {
        for (const r of this.rows(userId)) {
          if (r.pool !== pool || r.resolved_at || r.queued || !view.own.getThread(r.parent)?.project) continue;
          if (this.o.host().status(userId, pool, r.thread) !== "idle") continue;
          const t = view.own.getThread(r.thread);
          if (!t || (view.own.lastEntry(r.thread)?.createdAt ?? t.createdAt) >= cutoff) continue;
          this.setResolved(userId, pool, r.thread, true);
          n++;
        }
      } finally {
        view.close();
      }
    }
    return n;
  }

  /** Paused or hidden: the project's working threads stop, and each is idle. */
  async stopProject(userId: string, pool: Pool, project: string): Promise<void> {
    const host = this.o.host();
    const working = this.rows(userId).filter((r) => r.pool === pool && r.parent === project && host.busy(userId, pool, r.thread));
    await Promise.all(working.map((r) => host.get(userId, r.pool, r.thread).stop()));
    for (const r of working) this.turn(userId, r.pool, r.thread, false);
  }

  /** A thread's children, with what the sidebar shows: status and unseen updates. */
  children(userId: string, pool: Pool, parent: string): (ChildInfo & { unseen: number })[] {
    const view = this.o.memory.openThreadView(userId, pool);
    const on = this.checklists(userId);
    try {
      return this.rows(userId).filter((r) => r.pool === pool && r.parent === parent && view.own.getThread(r.thread)).map((r) => {
        const t = view.own.getThread(r.thread)!;
        return {
          id: r.thread, ...(t.title ? { title: t.title } : {}), status: this.o.host().status(userId, pool, r.thread),
          updatedAt: view.own.lastEntry(r.thread)?.createdAt ?? t.createdAt, unseen: r.unseen, ...(on ? stepsOf(view.own.steps(r.thread)) : {}),
        };
      });
    } finally {
      view.close();
    }
  }

  /** Status and unseen updates for each of the user's child threads, by thread. */
  info(userId: string): Map<string, { status: ChildInfo["status"]; unseen: number }> {
    return new Map(this.rows(userId).map((r) => [`${r.pool}/${r.thread}`, { status: this.o.host().status(userId, r.pool, r.thread), unseen: r.unseen }]));
  }

  /** The user opened the child thread: its updates are seen. */
  seen(userId: string, pool: Pool, thread: string): void {
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET unseen = 0 WHERE pool = ? AND thread = ? AND unseen > 0").run(pool, thread));
  }

  /** A hosted thread's turn started or ended. Only children are recorded. */
  turn(userId: string, pool: Pool, thread: string, working: boolean): void {
    for (const slot of this.starting.get(userId) ?? []) if (slot.pool === pool && slot.thread === thread) this.starting.get(userId)!.delete(slot);
    try {
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET working = ? WHERE pool = ? AND thread = ?").run(working ? 1 : 0, pool, thread));
      const row = this.row(userId, pool, thread);
      if (row) this.o.host().changed(userId, pool, row.parent, thread);
    } catch { /* locked meanwhile; recover() catches it up */ }
    if (!working) {
      this.routineThreads.delete(`${userId}/${pool}/${thread}`);
      if (this.cleanupAfterTurn.delete(`${userId}/${pool}/${thread}`)) {
        let resolved = false;
        try { resolved = !!this.row(userId, pool, thread)?.resolved_at; } catch { /* locked */ }
        if (resolved) void this.cleanupWorktrees(userId, pool, thread);
      }
      this.wakeWaiting(userId);
      void this.startQueued(userId);
    }
  }

  /** Whether a project is paused or hidden. */
  stopped(userId: string, pool: Pool, project: string): boolean {
    return !!this.o.paused?.(userId, pool, project);
  }

  /** A project was resumed or shown again: its queued threads may start. */
  resume(userId: string): void {
    this.wakeWaiting(userId);
    void this.startQueued(userId);
    this.drainWakes(userId);
  }

  /** A slot freed: threads holding saved messages wake, oldest first, while slots last. */
  private wakeWaiting(userId: string): void {
    for (const [key, w] of this.waiting) {
      if (w.userId !== userId) continue;
      try {
        if (this.o.paused?.(userId, w.pool, w.parent) || this.o.host().busy(userId, w.pool, w.thread)) continue;
        if (this.workingCount(userId) >= this.limits.concurrency) return;
        this.waiting.delete(key);
        const slot = { pool: w.pool, thread: w.thread };
        const mine = this.starting.get(userId) ?? new Set();
        this.starting.set(userId, mine);
        mine.add(slot);
        // The slot goes when its turn starts (`turn`), or here if none did.
        void this.o.host().get(userId, w.pool, w.thread).wakeChild("Read the messages above, sent while you were waiting for a free slot, and go on.")
          .catch(() => {}).finally(() => { if (!this.o.host().busy(userId, w.pool, w.thread)) mine.delete(slot); });
      } catch { return; /* locked; the saved messages remain */ }
    }
  }

  /** A slot freed: the oldest queued thread of a project that isn't paused or hidden starts. */
  private async startQueued(userId: string): Promise<void> {
    let next: Row | undefined;
    try {
      if (this.workingCount(userId) >= this.limits.concurrency) return;
      next = this.rows(userId).find((r) => r.queued && !r.resolved_at && this.queue.has(`${userId}/${r.pool}/${r.thread}`) && !this.o.paused?.(userId, r.pool, r.parent));
    } catch { return; /* locked */ }
    if (!next) return;
    const key = `${userId}/${next.pool}/${next.thread}`;
    const q = this.queue.get(key)!;
    this.queue.delete(key);
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET queued = 0 WHERE pool = ? AND thread = ?").run(next!.pool, next!.thread));
    try {
      this.task(userId, next.pool, next.thread);
      await this.o.host().get(userId, next.pool, next.thread).send(q.task, { fromParent: q.parent });
    } catch {
      this.tasked.delete(key);
      this.deliver(userId, next.pool, next.parent, `Queued thread [t:${next.thread}] couldn't start, and is idle. Message it to go on.`, next.thread, "update", true);
    }
  }

  /**
   * Lock: stops the user's working children, and tells each parent. Before
   * the key goes. A parent mid-turn is stopped first, as Lock would stop it
   * anyway, so the note is stored rather than left waiting for a next turn.
   */
  async lock(userId: string): Promise<void> {
    this.locking.add(userId);
    for (const [key, w] of this.parentWakes) if (w.userId === userId) this.parentWakes.delete(key);
    for (const [key, w] of this.waiting) if (w.userId === userId) this.waiting.delete(key);
    const host = this.o.host();
    const working = this.rows(userId).filter((r) => host.busy(userId, r.pool, r.thread));
    await Promise.all(working.map((r) => host.get(userId, r.pool, r.thread).stop()));
    const parents = [...new Map(working.map((r) => [`${r.pool}/${r.parent}`, r])).values()].filter((r) => host.busy(userId, r.pool, r.parent));
    await Promise.all(parents.map(async (r) => { const p = host.get(userId, r.pool, r.parent); await p.stop(); await p.settled(); }));
    this.idle(userId, working, "was stopped when the user locked Lyrica");
    for (const [key, w] of this.parentWakes) if (w.userId === userId) this.parentWakes.delete(key);
    this.locking.delete(userId);
  }

  private checkBase(userId: string, pool: Pool, project: string, except?: string): void {
    const pending = this.bases.get(`${userId}/${pool}/${project}`);
    if (pending) throw new Error(`the base checkout is held by ${JSON.stringify(pending)}`);
    const holder = this.rows(userId).find((r) => r.pool === pool && r.parent === project && r.thread !== except && !r.resolved_at && this.o.workspace.settings(userId).threadWork(r.thread)?.base);
    if (!holder) return;
    const view = this.o.memory.openThreadView(userId, pool);
    try { throw new Error(`the base checkout is held by ${JSON.stringify(view.own.getThread(holder.thread)?.title ?? holder.thread)} [t:${holder.thread}]; resolve it first`); }
    finally { view.close(); }
  }

  /**
   * Removes a thread's worktrees, keeping their branches: on resolve, keeping one with changes that weren't committed;
   * when the thread is forgotten (`forget`), all of them, saying nothing, since its parent may be going too.
   */
  cleanupWorktrees(userId: string, pool: Pool, thread: string, forget = false): Promise<void> {
    const key = `${userId}/${pool}/${thread}`;
    this.cleanupAfterTurn.delete(key);
    const active = this.cleaning.get(key);
    if (active && !forget) return active;
    const ws = this.o.workspace.settings(userId);
    const work = ws.threadWork(thread);
    if (!work?.worktrees.length || (work.cleaned && !forget)) return active ?? Promise.resolve();
    const row = forget ? undefined : this.row(userId, pool, thread);
    const job = (async () => {
      await active;
      try {
        const note = await this.o.workspace.removeThreadWorktrees({ userId, pool, threadId: thread }, forget);
        if (row) this.deliver(userId, pool, row.parent, `Worktrees for [t:${thread}]:\n${note}`, thread);
      } catch {
        if (row) this.deliver(userId, pool, row.parent, `Worktrees for [t:${thread}] were kept: cleanup could not run.\n${work.worktrees.map((w) => w.path).join("\n")}`, thread);
      }
    })().finally(() => this.cleaning.delete(key));
    this.cleaning.set(key, job);
    return job;
  }

  /** Drops the records of forgotten threads, and of the children they kept, which are threads of their own now. */
  forget(userId: string, pool: Pool, threads: string[]): void {
    for (const t of threads) { this.parentWakes.delete(`${userId}/${pool}/${t}`); this.waiting.delete(`${userId}/${pool}/${t}`); this.rounds.delete(`${userId}/${pool}/${t}`); this.reports.delete(`${userId}/${pool}/${t}`); this.tasked.delete(`${userId}/${pool}/${t}`); this.noticed.delete(`${userId}/${pool}/${t}`); this.idleWakes.delete(`${userId}/${pool}/${t}`); this.stoppedProjects.delete(`${userId}/${pool}/${t}`); }
    this.db(userId, (db) => db.prepare("DELETE FROM child_threads WHERE pool = @pool AND (thread IN (SELECT value FROM json_each(@t)) OR parent IN (SELECT value FROM json_each(@t)))")
      .run({ pool, t: JSON.stringify(threads) }));
  }

  /** At unlock: children a restart left working are idle now, never resumed; their parents are told. Once per user per process. */
  recover(userId: string): void {
    if (this.recovered.has(userId)) return;
    this.idle(userId, this.rows(userId).filter((r) => r.working && !this.o.host().busy(userId, r.pool, r.thread)), "was interrupted when Lyrica restarted");
    // A queued task was held in memory only: the thread is there, but hasn't started.
    const lost = this.rows(userId).filter((r) => r.queued && !this.queue.has(`${userId}/${r.pool}/${r.thread}`));
    this.db(userId, (db) => { for (const r of lost) db.prepare("UPDATE child_threads SET queued = 0 WHERE pool = ? AND thread = ?").run(r.pool, r.thread); });
    for (const r of lost) this.deliver(userId, r.pool, r.parent, `Queued thread [t:${r.thread}] didn't start before Lyrica restarted, and is idle. Message it to start it.`, r.thread, "update", true);
    this.recovered.add(userId);
  }

  perRequest(from: ThreadContext): number {
    return this.cloud(from.user.id, from.pool, from.threadId) ? this.limits.cloudPerRequest : this.limits.perRequest;
  }

  /** Whether the thread's model runs in the cloud now; a thread with no usable model counts as local. */
  private cloud(userId: string, pool: Pool, thread: string): boolean {
    try {
      const code = this.o.workspace.settings(userId).effective(thread).code;
      return this.o.models.resolve(code ? "code" : "chat", this.o.models.callContext(userId, pool, thread)).endpoint.kind === "cloud";
    } catch { return false; }
  }

  /** Refuses a new child turn while as many children as the limit allows are working, across all the user's threads. */
  private mayStartTurn(userId: string): void {
    const working = this.workingCount(userId);
    if (working >= this.limits.concurrency) throw new Error(`${working} child threads are working already; wait for one to finish, or message one`);
  }

  private workingCount(userId: string): number {
    const host = this.o.host();
    const starting = [...this.starting.get(userId) ?? []].filter((s) => !s.thread || !host.busy(userId, s.pool!, s.thread)).length;
    const working = new Set(this.rows(userId).filter(r => host.busy(userId, r.pool, r.thread)).map(r => `${r.pool}/${r.thread}`));
    for (const [key, r] of this.routineThreads) {
      if (r.userId !== userId) continue;
      if (host.busy(userId, r.pool, r.thread)) working.add(`${r.pool}/${r.thread}`);
      else this.routineThreads.delete(key);
    }
    return working.size + starting;
  }

  private idle(userId: string, rows: Row[], what: string): void {
    for (const r of rows) {
      this.turn(userId, r.pool, r.thread, false);
      this.deliver(userId, r.pool, r.parent, `Child thread [t:${r.thread}] ${what}, and is idle. Message it to go on.`, r.thread);
    }
  }

  /** Into the parent: its live session, or its stored thread; the open views see it either way. */
  private deliver(userId: string, pool: Pool, parent: string, content: string, child: string, status: "update" | "waiting" = "update", wake = false): void {
    const ref = { user: { id: userId }, pool, threadId: parent } as Parameters<Delegation["deliver"]>[0];
    const details = { childDelivery: true, joinRunning: this.parentWakes.get(`${userId}/${pool}/${parent}`)?.running ?? false, status, threads: [child], id: randomBytes(8).toString("hex") };
    try {
      this.o.delegation.deliver(ref, content, details);
      this.o.host().delivered(userId, pool, parent, content, details);
      if (wake) this.queueParentWake(userId, pool, parent, child);
    } catch { /* locked */ }
  }

  private queueParentWake(userId: string, pool: Pool, parent: string, child: string): void {
    const key = `${userId}/${pool}/${parent}`;
    const existing = this.parentWakes.get(key);
    if (existing) { existing.children.add(child); return; }
    this.parentWakes.set(key, { userId, pool, parent, children: new Set([child]), running: false });
    this.drainWakes(userId);
  }

  /** Pending notices wait for a slot or project resume; only metadata lives here. */
  drainWakes(userId?: string): void {
    for (const [key, wake] of this.parentWakes) {
      if (wake.running || this.locking.has(wake.userId) || (userId && wake.userId !== userId)) continue;
      try {
        if (this.o.host().draining || this.o.paused?.(wake.userId, wake.pool, wake.parent)) continue;
        if (this.o.host().busy(wake.userId, wake.pool, wake.parent)) continue;
        // The parent isn't one of the working children: waiting for a child's slot could leave both waiting on each other.
        if (!this.mayWake(wake.userId, wake.pool, wake.parent)) continue;
        wake.running = true;
        void this.o.host().get(wake.userId, wake.pool, wake.parent).wakeChild()
          .catch(() => { this.parentWakes.delete(key); });
      } catch { /* locked; the stored notices remain */ }
    }
  }

  private row(userId: string, pool: Pool, thread: string): Row | undefined {
    return this.rows(userId).find((r) => r.pool === pool && r.thread === thread);
  }

  /** Child threads with updates the user hasn't seen, or waiting on them. */
  updates(userId: string): { pool: Pool; thread: string; parent: string; unseen: number; needsYou: boolean }[] {
    return this.rows(userId).filter((r) => r.unseen > 0 || r.needs_you).map((r) => ({ pool: r.pool, thread: r.thread, parent: r.parent, unseen: r.unseen, needsYou: r.needs_you === 1 }));
  }

  private rows(userId: string): Row[] {
    return this.db(userId, (db) => db.prepare("SELECT * FROM child_threads ORDER BY started_at").all()) as Row[];
  }

  private db<T>(userId: string, fn: (db: ReturnType<Users["openUserDb"]>) => T): T {
    const db = this.o.users.openUserDb(userId);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
}

function stateOf(r: Row, status: ChildInfo["status"]): ThreadState {
  if (r.resolved_at) return "resolved";
  if (r.queued) return "queued";
  if (status === "waiting" || r.needs_you) return "waiting";
  return status;
}

const stepsOf = (steps: ThreadStep[]) => (steps.length ? { steps } : {});
