import type { ModelRef, Pool, ThinkingLevel, Users } from "@lyrica/core";

// What a user sets about threads and projects that isn't conversation: thread
// pins, and each project's settings (paused, the model and thinking its new
// threads start with) and which suggested threads were started. All in the
// user's user.db, as IDs and switches only, never in the pool.

const SCHEMA = `
-- Threads the user pinned to the top of the thread list.
CREATE TABLE IF NOT EXISTS pinned_threads (
  pool      TEXT NOT NULL,
  thread    TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (pool, thread)
);
-- A project's settings: paused, the model (JSON ModelRef or list) and thinking its new threads start with, and whether she watches its threads.
CREATE TABLE IF NOT EXISTS project_settings (
  pool     TEXT NOT NULL,
  thread   TEXT NOT NULL,
  paused   INTEGER NOT NULL DEFAULT 0,
  model    TEXT,
  thinking TEXT,
  watch    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (pool, thread)
);
-- A suggested thread the user started: the suggest call (its tool call ID), which of its threads, and the thread made.
CREATE TABLE IF NOT EXISTS started_suggestions (
  pool   TEXT NOT NULL,
  thread TEXT NOT NULL,
  call   TEXT NOT NULL,
  idx    INTEGER NOT NULL,
  child  TEXT NOT NULL,
  PRIMARY KEY (pool, thread, call, idx)
);
`;

export interface ProjectSettings {
  paused: boolean;
  /** The chat model new threads of the project start with; none: the project chat's. */
  model?: ModelRef | ModelRef[];
  thinking?: ThinkingLevel;
  /** The project chat looks at what the person and its threads said (watch.ts). On unless turned off. */
  watch: boolean;
}

export class Projects {
  constructor(private readonly users: Users) {}

  /** Pinned threads, as `pool/thread`. */
  pinned(userId: string): Set<string> {
    return new Set(this.db(userId, (db) => db.prepare("SELECT pool, thread FROM pinned_threads").all() as { pool: string; thread: string }[])
      .map((r) => `${r.pool}/${r.thread}`));
  }

  pin(userId: string, pool: Pool, thread: string, pinned: boolean): void {
    this.db(userId, (db) => pinned
      ? db.prepare("INSERT OR IGNORE INTO pinned_threads (pool, thread, pinned_at) VALUES (?, ?, ?)").run(pool, thread, new Date().toISOString())
      : db.prepare("DELETE FROM pinned_threads WHERE pool = ? AND thread = ?").run(pool, thread));
  }

  settings(userId: string, pool: Pool, project: string): ProjectSettings {
    const row = this.db(userId, (db) => db.prepare("SELECT * FROM project_settings WHERE pool = ? AND thread = ?").get(pool, project)) as
      { paused: number; model: string | null; thinking: string | null; watch: number } | undefined;
    return {
      paused: row?.paused === 1,
      watch: row?.watch !== 0,
      ...(row?.model ? { model: JSON.parse(row.model) as ModelRef | ModelRef[] } : {}),
      ...(row?.thinking ? { thinking: row.thinking as ThinkingLevel } : {}),
    };
  }

  /** Changes some of a project's settings; `null` clears the model or thinking. */
  set(userId: string, pool: Pool, project: string, change: { paused?: boolean; model?: ModelRef | ModelRef[] | null; thinking?: ThinkingLevel | null; watch?: boolean }): ProjectSettings {
    const now = this.settings(userId, pool, project);
    const model = change.model === undefined ? now.model : change.model ?? undefined;
    const thinking = change.thinking === undefined ? now.thinking : change.thinking ?? undefined;
    this.db(userId, (db) => db.prepare("INSERT OR REPLACE INTO project_settings (pool, thread, paused, model, thinking, watch) VALUES (?, ?, ?, ?, ?, ?)")
      .run(pool, project, (change.paused ?? now.paused) ? 1 : 0, model ? JSON.stringify(model) : null, thinking ?? null, (change.watch ?? now.watch) ? 1 : 0));
    return this.settings(userId, pool, project);
  }

  paused(userId: string, pool: Pool, project: string): boolean {
    return this.settings(userId, pool, project).paused;
  }

  /** Which of a suggest call's threads were started, by index, with the thread made. */
  started(userId: string, pool: Pool, project: string): Map<string, string> {
    return new Map(this.db(userId, (db) => db.prepare("SELECT call, idx, child FROM started_suggestions WHERE pool = ? AND thread = ?").all(pool, project) as { call: string; idx: number; child: string }[])
      .map((r) => [`${r.call}#${r.idx}`, r.child]));
  }

  markStarted(userId: string, pool: Pool, project: string, call: string, idx: number, child: string): void {
    this.db(userId, (db) => db.prepare("INSERT OR IGNORE INTO started_suggestions (pool, thread, call, idx, child) VALUES (?, ?, ?, ?, ?)").run(pool, project, call, idx, child));
  }

  /** Forgotten threads: their pins, settings and started suggestions go. */
  forget(userId: string, pool: Pool, threads: string[]): void {
    const t = JSON.stringify(threads);
    this.db(userId, (db) => {
      for (const table of ["pinned_threads", "project_settings", "started_suggestions"]) {
        db.prepare(`DELETE FROM ${table} WHERE pool = ? AND thread IN (SELECT value FROM json_each(?))`).run(pool, t);
      }
    });
  }

  private db<T>(userId: string, fn: (db: ReturnType<Users["openUserDb"]>) => T): T {
    const db = this.users.openUserDb(userId);
    try {
      db.exec(SCHEMA);
      // Added after the table was: an older user.db gains the column, on.
      if (!(db.prepare("PRAGMA table_info(project_settings)").all() as { name: string }[]).some((c) => c.name === "watch")) {
        db.exec("ALTER TABLE project_settings ADD COLUMN watch INTEGER NOT NULL DEFAULT 1");
      }
      return fn(db);
    } finally {
      db.close();
    }
  }
}
