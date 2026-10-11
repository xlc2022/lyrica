import { randomBytes } from "node:crypto";
import {
  DEFAULT_THREADS_LIMITS, type ChildInfo, type Memory, type Models, type Pool, type StartRequest, type ThreadsLimits, type ThreadState, type Users, type Workspace,
} from "@lyrica/core";
import type { Delegation, ThreadContext, ThreadsHost } from "@lyrica/extension";
import type { ThreadHost } from "./hosted.ts";
import type { ProjectSettings } from "./projects.ts";

// Child threads Lyrica starts. Each is hosted like any thread; this keeps one
// row per child in user.db (no conversation text): whether it was working,
// for after a restart, and how many updates it posted that nobody has seen.
// A project's threads are child threads of the project chat, with an anchor
// (the project chat's entry they hang off), a resolved time, whether they
// wait on the user, and whether they are queued.

const SCHEMA = `
-- A child thread Lyrica started: whether a turn was running (a restart leaves it idle and tells the parent),
-- and its updates to the parent not yet seen.
CREATE TABLE IF NOT EXISTS child_threads (
  pool       TEXT NOT NULL,
  thread     TEXT NOT NULL,
  parent     TEXT NOT NULL,
  working    INTEGER NOT NULL DEFAULT 0,
  unseen     INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  PRIMARY KEY (pool, thread)
);
`;

/** Columns added for projects: anchor (an entry number of the parent), resolved_at, needs_you, queued. */
const UPGRADES = [
  ["anchor", "ALTER TABLE child_threads ADD COLUMN anchor INTEGER"],
  ["resolved_at", "ALTER TABLE child_threads ADD COLUMN resolved_at TEXT"],
  ["needs_you", "ALTER TABLE child_threads ADD COLUMN needs_you INTEGER NOT NULL DEFAULT 0"],
  ["queued", "ALTER TABLE child_threads ADD COLUMN queued INTEGER NOT NULL DEFAULT 0"],
] as const;

/** A project's thread idle this long is resolved by the nightly tick. */
export const AUTO_RESOLVE_DAYS = 7;

interface Row {
  pool: Pool; thread: string; parent: string; working: number; unseen: number;
  anchor: number | null; resolved_at: string | null; needs_you: number; queued: number;
}

/** A project's thread for the project chat and the sidebar. */
export interface ProjectThreadInfo extends ChildInfo { state: ThreadState; anchor?: number; unseen: number; resolvedAt?: string }

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
  project?: (userId: string, pool: Pool, project: string) => ProjectSettings;
  /** A project's thread posted to the project chat. */
  updated?: (userId: string, pool: Pool, project: string, thread: string) => void;
}

export class ChildThreads implements ThreadsHost {
  readonly limits: ThreadsLimits;
  private readonly recovered = new Set<string>();
  /** Starts under way, per user, with their thread once made: until its turn runs, each counts against the limit. */
  private readonly starting = new Map<string, Set<{ pool?: Pool; thread?: string }>>();
  /** Queued starts' tasks, held in memory only: a restart tells the project chat instead. */
  private readonly queue = new Map<string, { task: string; parent: string }>();

  constructor(private readonly o: ChildOptions) {
    this.limits = { ...DEFAULT_THREADS_LIMITS, ...o.limits };
  }

  async start(parent: ThreadContext, req: StartRequest): Promise<{ id: string; link: string; queued?: boolean }> {
    const userId = parent.user.id;
    const own = parent.view.own;
    const project = !!own.getThread(parent.threadId)?.project;
    if (project && this.o.paused?.(userId, parent.pool, parent.threadId)) throw new Error("this project is paused; nothing new starts until the person resumes it");
    // In a project, past the limit the thread waits its turn; elsewhere the start is refused.
    const queued = project && this.workingCount(userId) >= this.limits.concurrency;
    if (!project) this.mayStartTurn(userId);
    // Counted at once, so starts made together can't all slip under the limit.
    const slot: { pool?: Pool; thread?: string } = {};
    const mine = this.starting.get(userId) ?? new Set();
    this.starting.set(userId, mine);
    if (!queued) mine.add(slot);
    try {
      const made = await this.create(parent, req, project, queued, slot);
      // Held until the thread's turn begins (`turn`), so a start right after this one still counts it.
      if (queued) mine.delete(slot);
      return made;
    } catch (err) {
      mine.delete(slot);
      throw err;
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
      const grants = ws.thread(parent.threadId).grants
        .filter((g) => !req.folders || req.folders.some((f) => f.replace(/\/+$/, "") === g.path.replace(/\/+$/, "")))
        .map((g) => (req.readOnly ? { ...g, writable: false } : g));
      if (req.folders && grants.length < req.folders.length) throw new Error("a child thread can only have folders its parent has");
      // Machines are reached through bash, which no folder, read-only or network narrowing covers: a narrowed child gets none.
      const noMachines = !!req.readOnly || !!req.folders || req.internet === false;
      ws.inheritSettings(parent.threadId, child.id, parent.pool, { grants, ...(req.internet === false ? { internet: false } : {}), ...(noMachines ? { machines: [] } : {}) });
      this.o.models.inheritContext(this.o.models.callContext(userId, parent.pool, parent.threadId), child.id);
      // A cloud Dictation pick is consent for the thread it was made in: a new thread starts without it.
      this.o.models.setThreadModel(userId, parent.pool, child.id, "speech.transcribe");
      const chosen = project ? this.o.project?.(userId, parent.pool, parent.threadId) : undefined;
      if (chosen?.model) this.o.models.setThreadModel(userId, parent.pool, child.id, "chat", chosen.model);
      if (chosen?.thinking) this.o.models.setThinking(userId, child.id, chosen.thinking);
      if (chosen?.fallback !== undefined) this.o.models.setThreadFallback(userId, child.id, chosen.fallback);
    } catch (err) {
      own.forgetThread(child.id, "lyrica");
      throw err;
    }
    // A project's thread hangs off the first entry the calling turn writes.
    const anchor = project ? own.nextEntryN(parent.threadId) : null;
    this.db(userId, (db) => db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at, anchor, queued) VALUES (?, ?, ?, ?, ?, ?)")
      .run(parent.pool, child.id, parent.threadId, new Date().toISOString(), anchor, queued ? 1 : 0));
    const link = `#/u/${encodeURIComponent(userId)}/t/${parent.pool}/${encodeURIComponent(child.id)}`;
    if (queued) {
      this.queue.set(`${userId}/${parent.pool}/${child.id}`, { task: req.task, parent: parent.threadId });
      return { id: child.id, link, queued: true };
    }
    try {
      await this.o.host().get(userId, parent.pool, child.id).send(req.task, { fromParent: parent.threadId });
    } catch (err) {
      // It never started: nothing is left of it.
      await this.o.host().forget(userId, parent.pool, child.id);
      this.forget(userId, parent.pool, [child.id]);
      own.forgetThread(child.id, "lyrica");
      this.o.models.forgetThread(userId, parent.pool, child.id);
      throw err;
    }
    return { id: child.id, link };
  }

  /**
   * Start a thread: the user starts a project's thread from a message of the
   * project chat (`anchor`), with that message's text as its task. Queued past
   * the limit, like a start of hers.
   */
  async startFrom(userId: string, pool: Pool, project: string, anchor: number, req: { title: string; task: string }): Promise<string> {
    const view = this.o.memory.openThreadView(userId, pool);
    try {
      const user = this.o.users.get(userId)!;
      const ctx = { user, pool, interface: view.own.getThread(project)!.interface, threadId: project, view, call: this.o.models.callContext(userId, pool, project) } as ThreadContext;
      const made = await this.start(ctx, req);
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET anchor = ? WHERE pool = ? AND thread = ?").run(anchor, pool, made.id));
      return made.id;
    } finally {
      view.close();
    }
  }

  async message(from: ThreadContext, to: string, text: string, opts: { needsYou?: boolean } = {}): Promise<void> {
    const userId = from.user.id;
    if (to === "parent") {
      const row = this.row(userId, from.pool, from.threadId);
      if (!row || !from.view.own.getThread(row.parent)) throw new Error("this thread's parent is gone");
      const needsYou = !!opts.needsYou && !!from.view.own.getThread(row.parent)?.project;
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET unseen = unseen + 1, needs_you = CASE WHEN ? THEN 1 ELSE needs_you END WHERE pool = ? AND thread = ?")
        .run(needsYou ? 1 : 0, from.pool, from.threadId));
      // The mention shows as the current title, so none is written beside it.
      const head = needsYou ? `Child thread [t:${from.threadId}] is waiting on the person` : `Update from child thread [t:${from.threadId}]`;
      this.deliver(userId, from.pool, row.parent, `${head}:\n${text}`, from.threadId, needsYou ? "waiting" : "update");
      if (from.view.own.getThread(row.parent)?.project) this.o.updated?.(userId, from.pool, row.parent, from.threadId);
      return;
    }
    const target = this.row(userId, from.pool, to);
    const mine = this.row(userId, from.pool, from.threadId);
    // In a project, its threads may write to each other; anything else only to the thread's own children.
    const sibling = !!mine && !!target && target.parent === mine.parent && target.thread !== mine.thread && !!from.view.own.getThread(mine.parent)?.project;
    if (!target || (target.parent !== from.threadId && !sibling)) throw new Error(`[t:${to}] isn't a child thread of this one${mine ? ", or another thread of this project" : ""}`);
    if (this.o.paused?.(userId, from.pool, target.parent)) throw new Error("this project is paused; its threads take no messages until the person resumes it");
    if (target.queued) throw new Error(`[t:${to}] is queued and hasn't started; it starts when another thread finishes`);
    // An idle child starts a turn, so the limit holds here too; a working one takes it into its next turn.
    if (!this.o.host().busy(userId, from.pool, to)) this.mayStartTurn(userId);
    if (target.resolved_at) this.setResolved(userId, from.pool, to, false);
    await this.o.host().get(userId, from.pool, to).send(text, sibling ? { fromThread: from.threadId } : { fromParent: from.threadId });
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
    try {
      return this.rows(userId).filter((r) => r.pool === pool && r.parent === project && view.own.getThread(r.thread)).map((r) => {
        const t = view.own.getThread(r.thread)!;
        const status = this.o.host().status(userId, pool, r.thread);
        return {
          id: r.thread, ...(t.title ? { title: t.title } : {}), status, state: stateOf(r, status), ...(r.needs_you ? { needsYou: true } : {}),
          updatedAt: view.own.lastEntry(r.thread)?.createdAt ?? t.createdAt, unseen: r.unseen,
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
  resolve(from: ThreadContext, id: string | undefined, resolved: boolean): void {
    const userId = from.user.id;
    const target = id ?? from.threadId;
    const row = this.row(userId, from.pool, target);
    if (!row || !from.view.own.getThread(row.parent)?.project) throw new Error(`[t:${target}] isn't a thread of a project`);
    if (id !== undefined && row.parent !== from.threadId) throw new Error(`[t:${target}] isn't a thread of this project`);
    this.setResolved(userId, from.pool, target, resolved);
  }

  /** Resolved (or reopened). Resolving clears waiting on the user; the parent's open views see the change. */
  setResolved(userId: string, pool: Pool, thread: string, resolved: boolean): void {
    const row = this.row(userId, pool, thread);
    if (!row) throw new Error(`[t:${thread}] isn't a thread of a project`);
    this.db(userId, (db) => db.prepare(`UPDATE child_threads SET resolved_at = ?${resolved ? ", needs_you = 0" : ""} WHERE pool = ? AND thread = ?`)
      .run(resolved ? new Date().toISOString() : null, pool, thread));
    this.o.host().changed(userId, pool, row.parent, thread);
  }

  /** The user wrote in the thread: it no longer waits on them, and a resolved thread reopens. */
  userWrote(userId: string, pool: Pool, thread: string): void {
    const row = this.row(userId, pool, thread);
    if (!row || (!row.needs_you && !row.resolved_at)) return;
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET needs_you = 0, resolved_at = NULL WHERE pool = ? AND thread = ?").run(pool, thread));
    this.o.host().changed(userId, pool, row.parent, thread);
  }

  /** A branch made in a project: a thread of the project, hanging at `anchor`. */
  adopt(userId: string, pool: Pool, thread: string, project: string, anchor: number | undefined): void {
    this.db(userId, (db) => db.prepare("INSERT OR IGNORE INTO child_threads (pool, thread, parent, started_at, anchor) VALUES (?, ?, ?, ?, ?)")
      .run(pool, thread, project, new Date().toISOString(), anchor ?? null));
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
    try {
      return this.rows(userId).filter((r) => r.pool === pool && r.parent === parent && view.own.getThread(r.thread)).map((r) => {
        const t = view.own.getThread(r.thread)!;
        return {
          id: r.thread, ...(t.title ? { title: t.title } : {}), status: this.o.host().status(userId, pool, r.thread),
          updatedAt: view.own.lastEntry(r.thread)?.createdAt ?? t.createdAt, unseen: r.unseen,
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
    if (!working) void this.startQueued(userId);
  }

  /** Whether a project is paused or hidden. */
  stopped(userId: string, pool: Pool, project: string): boolean {
    return !!this.o.paused?.(userId, pool, project);
  }

  /** A project was resumed or shown again: its queued threads may start. */
  resume(userId: string): void {
    void this.startQueued(userId);
  }

  /** A slot freed: the oldest queued thread of a project that isn't paused or hidden starts. */
  private async startQueued(userId: string): Promise<void> {
    let next: Row | undefined;
    try {
      if (this.workingCount(userId) >= this.limits.concurrency) return;
      next = this.rows(userId).find((r) => r.queued && this.queue.has(`${userId}/${r.pool}/${r.thread}`) && !this.o.paused?.(userId, r.pool, r.parent));
    } catch { return; /* locked */ }
    if (!next) return;
    const key = `${userId}/${next.pool}/${next.thread}`;
    const q = this.queue.get(key)!;
    this.queue.delete(key);
    this.db(userId, (db) => db.prepare("UPDATE child_threads SET queued = 0 WHERE pool = ? AND thread = ?").run(next!.pool, next!.thread));
    try {
      await this.o.host().get(userId, next.pool, next.thread).send(q.task, { fromParent: q.parent });
    } catch {
      this.deliver(userId, next.pool, next.parent, `Queued thread [t:${next.thread}] couldn't start, and is idle. Message it to go on.`, next.thread);
    }
  }

  /**
   * Lock: stops the user's working children, and tells each parent. Before
   * the key goes. A parent mid-turn is stopped first, as Lock would stop it
   * anyway, so the note is stored rather than left waiting for a next turn.
   */
  async lock(userId: string): Promise<void> {
    const host = this.o.host();
    const working = this.rows(userId).filter((r) => host.busy(userId, r.pool, r.thread));
    await Promise.all(working.map((r) => host.get(userId, r.pool, r.thread).stop()));
    const parents = [...new Map(working.map((r) => [`${r.pool}/${r.parent}`, r])).values()].filter((r) => host.busy(userId, r.pool, r.parent));
    await Promise.all(parents.map(async (r) => { const p = host.get(userId, r.pool, r.parent); await p.stop(); await p.settled(); }));
    this.idle(userId, working, "was stopped when the user locked Lyrica");
  }

  /** Drops the records of forgotten threads, and of the children they kept, which are threads of their own now. */
  forget(userId: string, pool: Pool, threads: string[]): void {
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
    for (const r of lost) this.deliver(userId, r.pool, r.parent, `Queued thread [t:${r.thread}] didn't start before Lyrica restarted, and is idle. Message it to start it.`, r.thread);
    this.recovered.add(userId);
  }

  /** Refuses a new child turn while as many children as the limit allows are working, across all the user's threads. */
  private mayStartTurn(userId: string): void {
    const working = this.workingCount(userId);
    if (working >= this.limits.concurrency) throw new Error(`${working} child threads are working already; wait for one to finish, or message one`);
  }

  private workingCount(userId: string): number {
    const host = this.o.host();
    const starting = [...this.starting.get(userId) ?? []].filter((s) => !s.thread || !host.busy(userId, s.pool!, s.thread)).length;
    return this.rows(userId).filter((r) => host.busy(userId, r.pool, r.thread)).length + starting;
  }

  private idle(userId: string, rows: Row[], what: string): void {
    for (const r of rows) {
      this.turn(userId, r.pool, r.thread, false);
      this.deliver(userId, r.pool, r.parent, `Child thread [t:${r.thread}] ${what}, and is idle. Message it to go on.`, r.thread);
    }
  }

  /** Into the parent: its live session, or its stored thread; the open views see it either way. */
  private deliver(userId: string, pool: Pool, parent: string, content: string, child: string, status: "update" | "waiting" = "update"): void {
    const ref = { user: { id: userId }, pool, threadId: parent } as Parameters<Delegation["deliver"]>[0];
    const details = { status, threads: [child], id: randomBytes(8).toString("hex") };
    try {
      this.o.delegation.deliver(ref, content, details);
      this.o.host().delivered(userId, pool, parent, content, details);
    } catch { /* locked */ }
  }

  private row(userId: string, pool: Pool, thread: string): Row | undefined {
    return this.rows(userId).find((r) => r.pool === pool && r.thread === thread);
  }

  private rows(userId: string): Row[] {
    return this.db(userId, (db) => db.prepare("SELECT * FROM child_threads ORDER BY started_at").all()) as Row[];
  }

  private db<T>(userId: string, fn: (db: ReturnType<Users["openUserDb"]>) => T): T {
    const db = this.o.users.openUserDb(userId);
    try {
      db.exec(SCHEMA);
      for (const [column, sql] of UPGRADES) if (!db.prepare("SELECT 1 FROM pragma_table_info('child_threads') WHERE name = ?").get(column)) db.exec(sql);
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
