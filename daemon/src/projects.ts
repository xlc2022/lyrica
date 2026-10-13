import type { ModelRef, Pool, ThinkingLevel, Users } from "@lyrica/core";

// What a user sets about threads and projects that isn't conversation: thread
// pins, and each project's settings (paused, the model, thinking and Fallback its new
// threads start with) and which suggested threads were started. All in the
// user's encrypted user.db, including unsaved Goal and Instructions drafts.

export interface ProjectSettings {
  paused: boolean;
  draftGoal?: string;
  draftInstructions?: string;
  /** The chat model new threads of the project start with; none: the project chat's. */
  model?: ModelRef | ModelRef[];
  thinking?: ThinkingLevel;
  /** Fallback for its new threads; none: the project chat's. */
  fallback?: boolean;
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
      { paused: number; model: string | null; thinking: string | null; watch: number; fallback: number | null; draft_goal: string | null; draft_instructions: string | null } | undefined;
    return {
      paused: row?.paused === 1,
      watch: row?.watch !== 0,
      ...(row?.draft_goal !== null && row?.draft_goal !== undefined ? { draftGoal: row.draft_goal } : {}),
      ...(row?.draft_instructions !== null && row?.draft_instructions !== undefined ? { draftInstructions: row.draft_instructions } : {}),
      ...(row?.model ? { model: JSON.parse(row.model) as ModelRef | ModelRef[] } : {}),
      ...(row?.thinking ? { thinking: row.thinking as ThinkingLevel } : {}),
      ...(row?.fallback === 0 || row?.fallback === 1 ? { fallback: row.fallback === 1 } : {}),
    };
  }

  /** Changes some of a project's settings; `null` clears the model, thinking or Fallback. */
  set(userId: string, pool: Pool, project: string, change: { paused?: boolean; model?: ModelRef | ModelRef[] | null; thinking?: ThinkingLevel | null; fallback?: boolean | null; watch?: boolean; draftGoal?: string | null; draftInstructions?: string | null }): ProjectSettings {
    if (change.fallback !== undefined && change.fallback !== null && typeof change.fallback !== "boolean") throw new Error("fallback is true, false or null");
    for (const value of [change.draftGoal, change.draftInstructions]) if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 2000)) throw new Error("project drafts have at most 2000 characters");
    const now = this.settings(userId, pool, project);
    const model = change.model === undefined ? now.model : change.model ?? undefined;
    const thinking = change.thinking === undefined ? now.thinking : change.thinking ?? undefined;
    const fallback = change.fallback === undefined ? now.fallback : change.fallback ?? undefined;
    this.db(userId, (db) => db.prepare("INSERT OR REPLACE INTO project_settings (pool, thread, paused, model, thinking, watch, fallback, draft_goal, draft_instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(pool, project, (change.paused ?? now.paused) ? 1 : 0, model ? JSON.stringify(model) : null, thinking ?? null, (change.watch ?? now.watch) ? 1 : 0,
        fallback === undefined ? null : fallback ? 1 : 0,
        change.draftGoal === undefined ? now.draftGoal ?? null : change.draftGoal,
        change.draftInstructions === undefined ? now.draftInstructions ?? null : change.draftInstructions));
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
      return fn(db);
    } finally {
      db.close();
    }
  }
}
