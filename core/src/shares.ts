// Share with (DESIGN.md, "Where things are"): a copy of a thread sent to
// another user on this server. It waits in self.db, the one place both can
// reach (each user's pools open only with their own key), until the recipient
// adds it to General or Private, which copies the entries into a new thread
// there, or declines, which leaves nothing. Nothing of the sender's memory
// goes with it (the entries are exported as the conversation alone), the
// sender's later messages never reach the copy, and a copy keeps the pool
// rules it came with: a private thread is added only to Private, and a
// local-only thread stays off the cloud.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import type { ExportedEntry } from "./store/pool.ts";
import type { Pool } from "./types.ts";

export interface PendingShare {
  id: string;
  from: string;
  to: string;
  title?: string;
  /** The pool it was shared from: a private thread is added only to Private. */
  pool: Pool;
  unlogged: boolean;
  /** The thread was kept off cloud models; so is its copy. */
  localOnly: boolean;
  entryCount: number;
  createdAt: string;
}

export interface ShareContents extends PendingShare { entries: ExportedEntry[] }

interface Row { id: string; from_user: string; to_user: string; title: string | null; pool: Pool; unlogged: number; local_only: number; entries: string; created_at: string }

const pending = (r: Row, count: number): PendingShare =>
  ({ id: r.id, from: r.from_user, to: r.to_user, ...(r.title ? { title: r.title } : {}), pool: r.pool, unlogged: r.unlogged === 1, localOnly: r.local_only === 1, entryCount: count, createdAt: r.created_at });

export class ThreadShares {
  constructor(private readonly db: Db) {}

  /** Sends a copy: the thread's entries as they are now. Returns the share's ID. */
  send(share: { from: string; to: string; title?: string; pool: Pool; unlogged: boolean; localOnly: boolean; entries: ExportedEntry[] }): string {
    if (share.from === share.to) throw new Error("a thread can't be shared with its own user");
    const id = randomUUID();
    this.db.prepare("INSERT INTO thread_shares (id, from_user, to_user, title, pool, unlogged, local_only, entries, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, share.from, share.to, share.title ?? null, share.pool, share.unlogged ? 1 : 0, share.localOnly || share.pool === "private" ? 1 : 0, JSON.stringify(share.entries), new Date().toISOString());
    return id;
  }

  /** What waits for a user, newest first. */
  forUser(to: string): PendingShare[] {
    return (this.db.prepare("SELECT *, json_array_length(entries) AS n FROM thread_shares WHERE to_user = ? ORDER BY created_at DESC").all(to) as (Row & { n: number })[])
      .map((r) => pending(r, r.n));
  }

  /** One share with its entries, for the recipient only. */
  get(id: string, to: string): ShareContents | undefined {
    const r = this.db.prepare("SELECT * FROM thread_shares WHERE id = ? AND to_user = ?").get(id, to) as Row | undefined;
    if (!r) return undefined;
    const entries = JSON.parse(r.entries) as ExportedEntry[];
    return { ...pending(r, entries.length), entries };
  }

  /** Accepted or declined: the copy is gone from here. Returns whether there was one. */
  remove(id: string, to: string): boolean {
    return this.db.prepare("DELETE FROM thread_shares WHERE id = ? AND to_user = ?").run(id, to).changes > 0;
  }
}
