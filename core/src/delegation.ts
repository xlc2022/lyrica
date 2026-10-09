import type { Db } from "./db.ts";
import type { Pool } from "./types.ts";
import type { Users } from "./users.ts";

// Delegation's settings and run records, in the user's user.db. No text from a
// conversation is stored here: a run's task and result live in its thread.

export type Tier = "cheap" | "strong";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** What a subagent is: its prompt, default tier, tools, whether it may write, and how hard it thinks. */
export interface Role {
  name: string;
  description: string;
  prompt: string;
  tier: Tier;
  /** Tool names it may use. `ask_parent` and, where depth allows, `delegate` are always added. */
  tools: string[];
  readOnly: boolean;
  thinking: Thinking;
}

/** One step of work: a task, with an optional role and a tier or a named `endpoint/model`. */
export interface Step { task: string; role?: string; tier?: Tier; model?: string }
export interface LoopSpec { task: string; worker?: string; reviewer?: string; rounds?: number }
export interface CouncilSpec { question: string; models?: string[] }

/** A saved workflow. `{input}` in its text is replaced with the input it is run with. */
export type WorkflowSpec = { chain: Step[] } | { loop: LoopSpec } | { council: CouncilSpec };
export interface Workflow { name: string; description: string; spec: WorkflowSpec }

export type SubagentStatus = "running" | "question" | "finished" | "failed" | "stopped" | "interrupted";
export const LIVE_STATUSES: readonly SubagentStatus[] = ["running", "question"];

/** One subagent's thread within a run (one delegate call). */
export interface SubagentRecord {
  pool: Pool;
  thread: string;
  run: string;
  parent: string;
  role: string;
  model: string;
  background: boolean;
  status: SubagentStatus;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  endedAt: string | null;
}

/** Tokens only: every model is declared free to Pi, so it reports no cost. */
export interface Usage { inputTokens: number; outputTokens: number }

export const DELEGATION_SCHEMA = `
-- Roles the user added, or built-in roles they changed (same name).
CREATE TABLE IF NOT EXISTS delegate_roles (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('cheap', 'strong')),
  tools       TEXT NOT NULL,
  read_only   INTEGER NOT NULL,
  thinking    TEXT NOT NULL
);
-- Named chains, loops and councils.
CREATE TABLE IF NOT EXISTS delegate_workflows (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  spec        TEXT NOT NULL
);
-- Each subagent thread a run started: its status and the tokens it used. Live rows left by a restart become interrupted.
CREATE TABLE IF NOT EXISTS subagent_runs (
  pool          TEXT NOT NULL,
  thread        TEXT NOT NULL,
  run           TEXT NOT NULL,
  parent        TEXT NOT NULL,
  role          TEXT NOT NULL,
  model         TEXT NOT NULL,
  background    INTEGER NOT NULL,
  status        TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  PRIMARY KEY (pool, thread)
);
CREATE INDEX IF NOT EXISTS subagent_runs_parent ON subagent_runs (pool, parent);
`;

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

interface RoleRow { name: string; description: string; prompt: string; tier: Tier; tools: string; read_only: number; thinking: Thinking }
interface RunRow {
  pool: Pool; thread: string; run: string; parent: string; role: string; model: string; background: number; status: SubagentStatus;
  input_tokens: number; output_tokens: number; started_at: string; ended_at: string | null;
}
const toRecord = (r: RunRow): SubagentRecord => ({
  pool: r.pool, thread: r.thread, run: r.run, parent: r.parent, role: r.role, model: r.model, background: r.background === 1,
  status: r.status, inputTokens: r.input_tokens, outputTokens: r.output_tokens, startedAt: r.started_at, endedAt: r.ended_at,
});

/** One user's roles, workflows and subagent runs. Opens user.db per call, so the user must be unlocked. */
export class DelegationStore {
  constructor(private readonly users: Users) {}

  // --- Roles ---

  roles(userId: string): Role[] {
    return (this.db(userId, (db) => db.prepare("SELECT * FROM delegate_roles ORDER BY name").all()) as RoleRow[]).map((r) => ({
      name: r.name, description: r.description, prompt: r.prompt, tier: r.tier, tools: JSON.parse(r.tools), readOnly: r.read_only === 1, thinking: r.thinking,
    }));
  }

  /** Adds a role, or overrides a built-in one of the same name. */
  setRole(userId: string, role: Role): void {
    if (!NAME.test(role.name)) throw new Error("role names use lowercase letters, digits and '-'");
    if (role.tier !== "cheap" && role.tier !== "strong") throw new Error("a role's tier is cheap or strong");
    if (!THINKING.includes(role.thinking)) throw new Error(`thinking is one of ${THINKING.join(", ")}`);
    if (!role.prompt.trim()) throw new Error("a role needs a prompt");
    this.db(userId, (db) => db.prepare("INSERT OR REPLACE INTO delegate_roles (name, description, prompt, tier, tools, read_only, thinking) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(role.name, role.description, role.prompt, role.tier, JSON.stringify(role.tools), role.readOnly ? 1 : 0, role.thinking));
  }

  removeRole(userId: string, name: string): void {
    if (!this.db(userId, (db) => db.prepare("DELETE FROM delegate_roles WHERE name = ?").run(name).changes)) throw new Error(`no custom role ${name}`);
  }

  // --- Workflows ---

  workflows(userId: string): Workflow[] {
    return (this.db(userId, (db) => db.prepare("SELECT * FROM delegate_workflows ORDER BY name").all()) as { name: string; description: string; spec: string }[])
      .map((r) => ({ name: r.name, description: r.description, spec: JSON.parse(r.spec) }));
  }

  setWorkflow(userId: string, w: Workflow): void {
    if (!NAME.test(w.name)) throw new Error("workflow names use lowercase letters, digits and '-'");
    const kinds = ["chain", "loop", "council"].filter((k) => k in w.spec);
    if (kinds.length !== 1) throw new Error("a workflow is one chain, loop or council");
    if ("chain" in w.spec && !w.spec.chain.length) throw new Error("a chain needs at least one step");
    this.db(userId, (db) => db.prepare("INSERT OR REPLACE INTO delegate_workflows (name, description, spec) VALUES (?, ?, ?)")
      .run(w.name, w.description, JSON.stringify(w.spec)));
  }

  removeWorkflow(userId: string, name: string): void {
    if (!this.db(userId, (db) => db.prepare("DELETE FROM delegate_workflows WHERE name = ?").run(name).changes)) throw new Error(`no workflow ${name}`);
  }

  // --- Runs ---

  record(userId: string, r: Omit<SubagentRecord, "inputTokens" | "outputTokens" | "endedAt">): void {
    this.db(userId, (db) => db.prepare(`INSERT INTO subagent_runs (pool, thread, run, parent, role, model, background, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.pool, r.thread, r.run, r.parent, r.role, r.model, r.background ? 1 : 0, r.status, r.startedAt));
  }

  update(userId: string, pool: Pool, thread: string, change: { status?: SubagentStatus; usage?: Usage }): void {
    const ended = change.status && !LIVE_STATUSES.includes(change.status) ? new Date().toISOString() : null;
    this.db(userId, (db) => db.prepare(`UPDATE subagent_runs SET status = coalesce(?, status), ended_at = coalesce(?, ended_at),
      input_tokens = coalesce(?, input_tokens), output_tokens = coalesce(?, output_tokens) WHERE pool = ? AND thread = ?`)
      .run(change.status ?? null, ended, change.usage?.inputTokens ?? null, change.usage?.outputTokens ?? null, pool, thread));
  }

  /** A parent thread's subagent runs, newest first, or one run's. */
  runs(userId: string, pool: Pool, by: { parent: string } | { run: string }): SubagentRecord[] {
    const [col, val] = "parent" in by ? ["parent", by.parent] : ["run", by.run];
    return (this.db(userId, (db) => db.prepare(`SELECT * FROM subagent_runs WHERE pool = ? AND ${col} = ? ORDER BY started_at DESC, rowid DESC`).all(pool, val)) as RunRow[]).map(toRecord);
  }

  /** Marks every live row whose run isn't in `live` as interrupted, and returns them. */
  interrupt(userId: string, live: (run: string) => boolean): SubagentRecord[] {
    return this.db(userId, (db) => {
      const rows = (db.prepare("SELECT * FROM subagent_runs WHERE status IN ('running', 'question')").all() as RunRow[]).filter((r) => !live(r.run));
      const mark = db.prepare("UPDATE subagent_runs SET status = 'interrupted', ended_at = ? WHERE pool = ? AND thread = ?");
      const at = new Date().toISOString();
      for (const r of rows) mark.run(at, r.pool, r.thread);
      return rows.map((r) => ({ ...toRecord(r), status: "interrupted" as const, endedAt: at }));
    });
  }

  /** Tokens used by every subagent a parent thread started. */
  usage(userId: string, pool: Pool, parent: string): Usage {
    const row = this.db(userId, (db) => db.prepare(`SELECT coalesce(sum(input_tokens), 0) AS i, coalesce(sum(output_tokens), 0) AS o
      FROM subagent_runs WHERE pool = ? AND parent = ?`).get(pool, parent)) as { i: number; o: number };
    return { inputTokens: row.i, outputTokens: row.o };
  }

  /** Drops a forgotten thread's records. */
  forget(userId: string, pool: Pool, parent: string): void {
    this.db(userId, (db) => db.prepare("DELETE FROM subagent_runs WHERE pool = ? AND parent = ?").run(pool, parent));
  }

  private db<T>(userId: string, fn: (db: Db) => T): T {
    const db = this.users.openUserDb(userId);
    try {
      db.exec(DELEGATION_SCHEMA);
      return fn(db);
    } finally {
      db.close();
    }
  }
}
