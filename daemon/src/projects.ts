import { EVIDENCE_SETTINGS, type EvidenceSetting, type ModelRef, type Pool, type ThinkingLevel, type Users } from "@lyrica/core";

// What a user sets about threads and projects that isn't conversation: thread
// pins, and each project's settings (paused, the model, thinking and Fallback its new
// threads start with) and which suggested threads were started. All in the
// user's encrypted user.db, including unsaved Goal and Instructions drafts.

export interface ProjectSettings {
  paused: boolean;
  code?: boolean;
  /** The evidence judge's setting its new threads start with; none: the project chat's. */
  evidence?: EvidenceSetting;
  draftGoal?: string;
  draftInstructions?: string;
  /** The chat model new threads of the project start with; none: the project chat's. */
  model?: ModelRef | ModelRef[];
  thinking?: ThinkingLevel;
  /** Fallback for its new threads; none: the project chat's. */
  fallback?: boolean;
  /** The project chat looks at what the person and its threads said (watch.ts). On unless turned off. */
  watch: boolean;
  /** The project chat may wait in a turn for its working threads (a bare sleep). On unless turned off; off, it waits for their wakes. */
  checkIn: boolean;
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
      code: this.db(userId, db => {
        const saved = db.prepare("SELECT value FROM settings WHERE key = ?").get(`project.code.${pool}/${project}`) as { value: string } | undefined;
        return saved ? saved.value === "true" : undefined;
      }),
      evidence: this.db(userId, db => {
        const saved = db.prepare("SELECT value FROM settings WHERE key = ?").get(`project.evidence.${pool}/${project}`) as { value: string } | undefined;
        return saved && EVIDENCE_SETTINGS.includes(saved.value as EvidenceSetting) ? (saved.value as EvidenceSetting) : undefined;
      }),
      watch: row?.watch !== 0,
      checkIn: this.db(userId, db => (db.prepare("SELECT value FROM settings WHERE key = ?").get(`project.checkIn.${pool}/${project}`) as { value: string } | undefined)?.value !== "false"),
      ...(row?.draft_goal !== null && row?.draft_goal !== undefined ? { draftGoal: row.draft_goal } : {}),
      ...(row?.draft_instructions !== null && row?.draft_instructions !== undefined ? { draftInstructions: row.draft_instructions } : {}),
      ...(row?.model ? { model: JSON.parse(row.model) as ModelRef | ModelRef[] } : {}),
      ...(row?.thinking ? { thinking: row.thinking as ThinkingLevel } : {}),
      ...(row?.fallback === 0 || row?.fallback === 1 ? { fallback: row.fallback === 1 } : {}),
    };
  }

  /** Changes some of a project's settings; `null` clears the model, thinking, Fallback or evidence judge. */
  set(userId: string, pool: Pool, project: string, change: { code?: boolean; evidence?: EvidenceSetting | null; checkIn?: boolean; paused?: boolean; model?: ModelRef | ModelRef[] | null; thinking?: ThinkingLevel | null; fallback?: boolean | null; watch?: boolean; draftGoal?: string | null; draftInstructions?: string | null }): ProjectSettings {
    if (change.fallback !== undefined && change.fallback !== null && typeof change.fallback !== "boolean") throw new Error("fallback is true, false or null");
    for (const value of [change.draftGoal, change.draftInstructions]) if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 2000)) throw new Error("project drafts have at most 2000 characters");
    if (change.code !== undefined) {
      if (typeof change.code !== "boolean") throw new Error("code is true or false");
      this.db(userId, db => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`project.code.${pool}/${project}`, String(change.code)));
    }
    if (change.evidence !== undefined) {
      if (change.evidence !== null && !EVIDENCE_SETTINGS.includes(change.evidence)) throw new Error("evidence is auto, on, off or null");
      this.db(userId, db => change.evidence === null
        ? db.prepare("DELETE FROM settings WHERE key = ?").run(`project.evidence.${pool}/${project}`)
        : db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`project.evidence.${pool}/${project}`, change.evidence));
    }
    if (change.checkIn !== undefined) {
      if (typeof change.checkIn !== "boolean") throw new Error("checkIn is true or false");
      this.db(userId, db => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`project.checkIn.${pool}/${project}`, String(change.checkIn)));
    }
    const now = this.settings(userId, pool, project);
    const model = change.model === undefined ? now.model : change.model ?? undefined;
    const thinking = change.thinking === undefined ? now.thinking : change.thinking ?? undefined;
    const fallback = change.fallback === undefined ? now.fallback : change.fallback ?? undefined;
    this.db(userId, (db) => db.prepare("INSERT INTO project_settings (pool, thread, paused, model, thinking, watch, fallback, draft_goal, draft_instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pool, thread) DO UPDATE SET paused = excluded.paused, model = excluded.model, thinking = excluded.thinking, watch = excluded.watch, fallback = excluded.fallback, draft_goal = excluded.draft_goal, draft_instructions = excluded.draft_instructions")
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
      for (const thread of threads) for (const key of ["code", "evidence", "checkIn"]) db.prepare("DELETE FROM settings WHERE key = ?").run(`project.${key}.${pool}/${thread}`);
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
