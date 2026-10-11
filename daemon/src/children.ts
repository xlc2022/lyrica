import { randomBytes } from "node:crypto";
import type { Memory, Models, Pool, Users, Workspace } from "@lyrica/core";
import {
  DEFAULT_THREADS_LIMITS, type ChildInfo, type Delegation, type StartRequest, type ThreadContext, type ThreadsHost, type ThreadsLimits,
} from "@lyrica/extension";
import type { ThreadHost } from "./hosted.ts";

// Child threads Lyrica starts. Each is hosted like any thread; this keeps one
// row per child in user.db (no conversation text): whether it was working,
// for after a restart, and how many updates it posted that nobody has seen.

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

interface Row { pool: Pool; thread: string; parent: string; working: number; unseen: number }

export interface ChildOptions {
  users: Users;
  memory: Memory;
  models: Models;
  workspace: Workspace;
  delegation: Delegation;
  host: () => ThreadHost;
  limits?: Partial<ThreadsLimits>;
}

export class ChildThreads implements ThreadsHost {
  readonly limits: ThreadsLimits;
  private readonly recovered = new Set<string>();

  constructor(private readonly o: ChildOptions) {
    this.limits = { ...DEFAULT_THREADS_LIMITS, ...o.limits };
  }

  async start(parent: ThreadContext, req: StartRequest): Promise<{ id: string; link: string }> {
    const userId = parent.user.id;
    this.mayStartTurn(userId);
    // The store refuses a child of a child; the workspace refuses anything wider than the parent.
    const own = parent.view.own;
    const child = own.createThread({ interface: parent.interface, parent: parent.threadId, child: true, title: req.title.slice(0, 200) });
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
    } catch (err) {
      own.forgetThread(child.id, "lyrica");
      throw err;
    }
    this.db(userId, (db) => db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at) VALUES (?, ?, ?, ?)")
      .run(parent.pool, child.id, parent.threadId, new Date().toISOString()));
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
    return { id: child.id, link: `#/u/${encodeURIComponent(userId)}/t/${parent.pool}/${encodeURIComponent(child.id)}` };
  }

  async message(from: ThreadContext, to: string, text: string): Promise<void> {
    const userId = from.user.id;
    if (to === "parent") {
      const row = this.row(userId, from.pool, from.threadId);
      if (!row || !from.view.own.getThread(row.parent)) throw new Error("this thread's parent is gone");
      const title = from.view.own.getThread(from.threadId)?.title;
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET unseen = unseen + 1 WHERE pool = ? AND thread = ?").run(from.pool, from.threadId));
      this.deliver(userId, from.pool, row.parent, `Update from child thread t:${from.threadId}${title ? ` ("${title}")` : ""}:\n${text}`, from.threadId);
      return;
    }
    const row = this.row(userId, from.pool, to);
    if (!row || row.parent !== from.threadId) throw new Error(`t:${to} isn't a child thread of this one`);
    // An idle child starts a turn, so the limit holds here too; a working one takes it into its next turn.
    if (!this.o.host().busy(userId, from.pool, to)) this.mayStartTurn(userId);
    await this.o.host().get(userId, from.pool, to).send(text, { fromParent: from.threadId });
  }

  list(parent: ThreadContext): ChildInfo[] {
    return this.children(parent.user.id, parent.pool, parent.threadId).map(({ unseen: _u, ...c }) => c);
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
    try {
      this.db(userId, (db) => db.prepare("UPDATE child_threads SET working = ? WHERE pool = ? AND thread = ?").run(working ? 1 : 0, pool, thread));
    } catch { /* locked meanwhile; recover() catches it up */ }
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
    this.recovered.add(userId);
  }

  /** Refuses a new child turn while as many children as the limit allows are working, across all the user's threads. */
  private mayStartTurn(userId: string): void {
    const working = this.rows(userId).filter((r) => this.o.host().busy(userId, r.pool, r.thread)).length;
    if (working >= this.limits.concurrency) throw new Error(`${working} child threads are working already; wait for one to finish, or message one`);
  }

  private idle(userId: string, rows: Row[], what: string): void {
    for (const r of rows) {
      this.turn(userId, r.pool, r.thread, false);
      this.deliver(userId, r.pool, r.parent, `Child thread t:${r.thread} ${what}, and is idle. Message it to go on.`, r.thread);
    }
  }

  /** Into the parent: its live session, or its stored thread; the open views see it either way. */
  private deliver(userId: string, pool: Pool, parent: string, content: string, child: string): void {
    const ref = { user: { id: userId }, pool, threadId: parent } as Parameters<Delegation["deliver"]>[0];
    const details = { status: "update", threads: [child], id: randomBytes(8).toString("hex") };
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
      return fn(db);
    } finally {
      db.close();
    }
  }
}
