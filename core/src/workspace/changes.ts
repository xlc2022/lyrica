import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";

// What her write and edit calls did to files, so removing the turns that made
// them can undo them. One row per call and file in user.db (paths and hashes,
// no content); the content a file had before is a snapshot in the user's
// encrypted home workspace, outside every thread's folder.

export const CHANGES_SCHEMA = `
-- A file her write or edit tool created or changed: which call, where, and the hash it left.
-- snapshot: the file's earlier content, kept in the home workspace's snapshots/ folder.
CREATE TABLE IF NOT EXISTS file_changes (
  id         TEXT PRIMARY KEY,
  pool       TEXT NOT NULL,
  thread     TEXT NOT NULL,
  tool_call  TEXT NOT NULL,
  target     TEXT NOT NULL,
  path       TEXT NOT NULL,
  created    INTEGER NOT NULL,
  hash_after TEXT NOT NULL,
  snapshot   TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_changes_thread ON file_changes (pool, thread);
`;

export interface FileChange {
  id: string;
  pool: Pool;
  thread: string;
  toolCall: string;
  /** "sandbox" or "ssh:<name>". */
  target: string;
  /** As the target sees it. */
  path: string;
  /** The call made the file; otherwise it changed one. */
  created: boolean;
  hashAfter: string;
  snapshot?: string;
  at: string;
}

/** A change about to be recorded: what the file held before (none if it was made) and after. */
export interface NewChange {
  toolCall: string;
  target: string;
  path: string;
  before: Buffer | undefined;
  after: string | Buffer;
}

export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

const SNAPSHOT = /^[0-9a-f]{32}$/;

/** One user's file changes: rows in their user.db, snapshots in `<home>/snapshots`. */
export class FileChanges {
  constructor(private readonly db: Db, private readonly home: () => string) {
    db.exec(CHANGES_SCHEMA);
  }

  close(): void { this.db.close(); }

  private get dir(): string {
    const dir = join(this.home(), "snapshots");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  record(pool: Pool, thread: string, c: NewChange): FileChange {
    const snapshot = c.before ? randomBytes(16).toString("hex") : undefined;
    if (snapshot) writeFileSync(join(this.dir, snapshot), c.before!, { mode: 0o600 });
    const row: FileChange = {
      id: randomBytes(8).toString("hex"), pool, thread, toolCall: c.toolCall, target: c.target, path: c.path,
      created: !c.before, hashAfter: sha256(c.after), ...(snapshot ? { snapshot } : {}), at: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO file_changes (id, pool, thread, tool_call, target, path, created, hash_after, snapshot, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, pool, thread, row.toolCall, row.target, row.path, row.created ? 1 : 0, row.hashAfter, snapshot ?? null, row.at);
    return row;
  }

  /**
   * The changes the given tool calls made in a thread, oldest first. Some
   * models reuse call IDs from turn to turn ("call_1"), so `since` (when the
   * first of those turns began) keeps earlier turns' calls out.
   */
  forCalls(pool: Pool, thread: string, toolCalls: string[], since = ""): FileChange[] {
    return (this.db.prepare("SELECT * FROM file_changes WHERE pool = ? AND thread = ? AND at >= ? AND tool_call IN (SELECT value FROM json_each(?)) ORDER BY at, rowid")
      .all(pool, thread, since, JSON.stringify(toolCalls)) as Row[]).map(toChange);
  }

  /** A snapshot's content. */
  snapshot(id: string): Buffer {
    if (!SNAPSHOT.test(id)) throw new Error(`no snapshot ${id}`);
    return readFileSync(join(this.dir, id));
  }

  /** Drops the records (and snapshots) of changes that are settled: undone, or their turns gone. */
  forget(ids: string[]): void {
    const rows = this.db.prepare("SELECT * FROM file_changes WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Row[];
    for (const r of rows) if (r.snapshot && SNAPSHOT.test(r.snapshot)) rmSync(join(this.dir, r.snapshot), { force: true });
    this.db.prepare("DELETE FROM file_changes WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
  }

  /** Every change of the threads given, for when they're forgotten. */
  forThreads(pool: Pool, threads: string[]): FileChange[] {
    return (this.db.prepare("SELECT * FROM file_changes WHERE pool = ? AND thread IN (SELECT value FROM json_each(?))")
      .all(pool, JSON.stringify(threads)) as Row[]).map(toChange);
  }

  /**
   * Removes records and snapshots older than `before`, and snapshot files no
   * record names. Returns how many of each went.
   */
  sweep(before: Date): { records: number; snapshots: number } {
    const old = (this.db.prepare("SELECT id FROM file_changes WHERE at < ?").all(before.toISOString()) as { id: string }[]).map((r) => r.id);
    this.forget(old);
    const named = new Set((this.db.prepare("SELECT snapshot FROM file_changes WHERE snapshot IS NOT NULL").all() as { snapshot: string }[]).map((r) => r.snapshot));
    let snapshots = 0;
    for (const name of readdirSync(this.dir)) {
      if (named.has(name)) continue;
      // A snapshot written just now may not have its row yet.
      if (statSync(join(this.dir, name)).mtimeMs > Date.now() - 60_000) continue;
      rmSync(join(this.dir, name), { recursive: true, force: true });
      snapshots++;
    }
    return { records: old.length, snapshots };
  }
}

interface Row { id: string; pool: Pool; thread: string; tool_call: string; target: string; path: string; created: number; hash_after: string; snapshot: string | null; at: string }

function toChange(r: Row): FileChange {
  return {
    id: r.id, pool: r.pool, thread: r.thread, toolCall: r.tool_call, target: r.target, path: r.path, created: r.created === 1,
    hashAfter: r.hash_after, ...(r.snapshot ? { snapshot: r.snapshot } : {}), at: r.at,
  };
}
