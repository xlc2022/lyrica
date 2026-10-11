// A user's own view of their threads: the groups they sort threads into, and
// a thread marked unread. These live in user.db, never in the pool, so a
// shared or exported thread carries none of them (DESIGN.md, "Where things are").
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import type { Pool } from "./types.ts";

export const PREFS_SCHEMA = `
-- The user's own groups of threads, shown in the sidebar under "My groups".
CREATE TABLE IF NOT EXISTS thread_groups (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL
);
-- Per-user facts about one thread that never go in the pool: its group, and whether it is marked unread.
CREATE TABLE IF NOT EXISTS thread_prefs (
  pool     TEXT NOT NULL,
  thread   TEXT NOT NULL,
  group_id TEXT,
  unread   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pool, thread)
);
`;

export interface ThreadGroup { id: string; name: string }
export interface ThreadPref { group?: string; unread: boolean }

/** Opens the user's user.db (it must be unlocked). */
export type OpenUserDb = (userId: string) => Db;

export class ThreadPrefs {
  constructor(private readonly open: OpenUserDb) {}

  private with<T>(userId: string, fn: (db: Db) => T): T {
    const db = this.open(userId);
    try {
      db.exec(PREFS_SCHEMA);
      return fn(db);
    } finally {
      db.close();
    }
  }

  groups(userId: string): ThreadGroup[] {
    return this.with(userId, (db) => db.prepare("SELECT id, name FROM thread_groups ORDER BY position, name").all() as ThreadGroup[]);
  }

  addGroup(userId: string, name: string): ThreadGroup {
    const clean = name.trim();
    if (!clean) throw new Error("a group needs a name");
    return this.with(userId, (db) => {
      const { n } = db.prepare("SELECT count(*) AS n FROM thread_groups").get() as { n: number };
      const id = randomUUID();
      db.prepare("INSERT INTO thread_groups (id, name, position) VALUES (?, ?, ?)").run(id, clean, n);
      return { id, name: clean };
    });
  }

  renameGroup(userId: string, id: string, name: string): ThreadGroup {
    const clean = name.trim();
    if (!clean) throw new Error("a group needs a name");
    return this.with(userId, (db) => {
      if (!db.prepare("UPDATE thread_groups SET name = ? WHERE id = ?").run(clean, id).changes) throw new Error("no such group");
      return { id, name: clean };
    });
  }

  /** Its threads are in no group afterwards. */
  removeGroup(userId: string, id: string): void {
    this.with(userId, (db) => {
      db.prepare("UPDATE thread_prefs SET group_id = NULL WHERE group_id = ?").run(id);
      if (!db.prepare("DELETE FROM thread_groups WHERE id = ?").run(id).changes) throw new Error("no such group");
    });
  }

  setGroup(userId: string, pool: Pool, thread: string, groupId: string | null): void {
    this.with(userId, (db) => {
      if (groupId !== null && !db.prepare("SELECT 1 FROM thread_groups WHERE id = ?").get(groupId)) throw new Error("no such group");
      db.prepare("INSERT INTO thread_prefs (pool, thread, group_id) VALUES (?, ?, ?) ON CONFLICT (pool, thread) DO UPDATE SET group_id = excluded.group_id").run(pool, thread, groupId);
    });
  }

  setUnread(userId: string, pool: Pool, thread: string, unread: boolean): void {
    this.with(userId, (db) => {
      db.prepare("INSERT INTO thread_prefs (pool, thread, unread) VALUES (?, ?, ?) ON CONFLICT (pool, thread) DO UPDATE SET unread = excluded.unread").run(pool, thread, unread ? 1 : 0);
    });
  }

  /** Every thread's preferences, keyed `<pool>/<thread>`, in one read. */
  all(userId: string): Map<string, ThreadPref> {
    return this.with(userId, (db) => {
      const rows = db.prepare("SELECT pool, thread, group_id, unread FROM thread_prefs").all() as { pool: Pool; thread: string; group_id: string | null; unread: number }[];
      return new Map(rows.map((r) => [`${r.pool}/${r.thread}`, { ...(r.group_id ? { group: r.group_id } : {}), unread: r.unread === 1 }]));
    });
  }

  get(userId: string, pool: Pool, thread: string): ThreadPref {
    return this.all(userId).get(`${pool}/${thread}`) ?? { unread: false };
  }

  /** The thread is gone; so are its preferences. */
  forget(userId: string, pool: Pool, threads: string[]): void {
    if (!threads.length) return;
    this.with(userId, (db) => {
      const del = db.prepare("DELETE FROM thread_prefs WHERE pool = ? AND thread = ?");
      for (const t of threads) del.run(pool, t);
    });
  }
}
