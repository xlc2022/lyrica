import type { Db } from "./db.ts";
import type { Pool } from "./types.ts";

// Skills (docs/briefs/skills.md, DESIGN.md "Skills"): named procedures in the user's encrypted user.db. The
// person's are active at once; hers wait for the person's approval unless the person turned on auto-approve.
// A skill saved from a Private thread is listed only in Private threads.

export const SKILLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  pool TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  thread TEXT,
  call TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (pool, name, state)
);
CREATE INDEX IF NOT EXISTS skills_call ON skills(call);
`;

export const SKILL_LIMITS = { name: 64, description: 200, body: 8000, library: 100 } as const;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Tab and newline are fine in a body; other control characters are not.
const CONTROL = /[\0-\x08\x0b-\x1f\x7f]/;

export type SkillState = "active" | "waiting" | "declined";
export type SkillAuthor = "user" | "lyrica";

export interface SkillDraft { name: string; description: string; body: string }
export interface Skill extends SkillDraft {
  pool: Pool;
  state: SkillState;
  author: SkillAuthor;
  /** Where she saved it: her thread and the save_skill call. */
  thread?: string;
  call?: string;
  at: string;
}

/** A skill's fields, checked: trimmed, within SKILL_LIMITS, or a plain Error. */
export function checkSkill(input: unknown): SkillDraft {
  if (typeof input !== "object" || input === null) throw new Error("A skill has a name, a description and a body.");
  const o = input as Record<string, unknown>;
  const field = (key: keyof SkillDraft) => {
    const v = o[key];
    if (typeof v !== "string" || !v.trim()) throw new Error(`A skill needs a ${key}.`);
    return v.trim();
  };
  const name = field("name"), description = field("description"), body = field("body");
  if (name.length > SKILL_LIMITS.name || !NAME.test(name)) throw new Error(`A skill's name is lowercase letters and digits joined by -, at most ${SKILL_LIMITS.name} characters.`);
  if (description.length > SKILL_LIMITS.description || /[\0-\x1f\x7f]/.test(description)) throw new Error(`A skill's description is one line of at most ${SKILL_LIMITS.description} characters.`);
  if (body.length > SKILL_LIMITS.body || CONTROL.test(body)) throw new Error(`A skill's body is at most ${SKILL_LIMITS.body} characters, with no control characters.`);
  return { name, description, body };
}

interface Row { pool: Pool; name: string; state: SkillState; description: string; body: string; author: SkillAuthor; thread: string | null; call: string | null; at: string }
const toSkill = (r: Row): Skill => ({
  pool: r.pool, name: r.name, state: r.state, description: r.description, body: r.body, author: r.author,
  ...(r.thread ? { thread: r.thread } : {}), ...(r.call ? { call: r.call } : {}), at: r.at,
});

/** The pools whose skills a thread in `pool` sees: Private threads see both. */
const visible = (pool: Pool): Pool[] => (pool === "private" ? ["general", "private"] : ["general"]);

export class SkillLibrary {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  /** Every skill, for Settings: waiting first, then by name. */
  all(): Skill[] {
    return (this.db.prepare("SELECT * FROM skills ORDER BY state = 'waiting' DESC, name, pool, state").all() as Row[]).map(toSkill);
  }

  /** The active skills a thread in `pool` lists, by name. */
  active(pool: Pool): Skill[] {
    const pools = visible(pool);
    return (this.db.prepare(`SELECT * FROM skills WHERE state = 'active' AND pool IN (${pools.map(() => "?").join(", ")}) ORDER BY name, pool`).all(...pools) as Row[]).map(toSkill);
  }

  /** An active skill a thread in `pool` may read; its own pool's wins over General's. */
  read(pool: Pool, name: string): Skill | undefined {
    const pools = visible(pool);
    const rows = this.db.prepare(`SELECT * FROM skills WHERE state = 'active' AND name = ? AND pool IN (${pools.map(() => "?").join(", ")})`).all(name, ...pools) as Row[];
    const row = rows.find((r) => r.pool === pool) ?? rows[0];
    return row && toSkill(row);
  }

  /** The skill her save_skill call made, in whatever state it is now. */
  byCall(call: string): Skill | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE call = ?").get(call) as Row | undefined;
    return row && toSkill(row);
  }

  autoApprove(): boolean {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'skills.auto_approve'").get() as { value: string } | undefined)?.value === "1";
  }

  setAutoApprove(on: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('skills.auto_approve', ?)").run(on ? "1" : "0");
  }

  /** The person's own skill, active at once, in General unless they chose Private. */
  put(input: unknown, pool: Pool = "general"): Skill {
    const draft = checkSkill(input);
    return this.db.transaction(() => {
      this.limit(pool, draft.name);
      this.db.prepare("DELETE FROM skills WHERE pool = ? AND name = ? AND state IN ('active', 'waiting')").run(pool, draft.name);
      return this.insert({ ...draft, pool, state: "active", author: "user", at: this.now().toISOString() });
    })();
  }

  /** Her draft: active at once with auto-approve, otherwise waiting beside the active one it would replace. */
  propose(input: unknown, pool: Pool, thread: string, call: string): Skill {
    const draft = checkSkill(input);
    return this.db.transaction(() => {
      this.limit(pool, draft.name);
      const state: SkillState = this.autoApprove() ? "active" : "waiting";
      this.db.prepare("DELETE FROM skills WHERE pool = ? AND name = ? AND state = ?").run(pool, draft.name, state);
      return this.insert({ ...draft, pool, state, author: "lyrica", thread, call, at: this.now().toISOString() });
    })();
  }

  /** Approves her waiting draft: it replaces the active skill of that name. */
  approve(pool: Pool, name: string): Skill {
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM skills WHERE pool = ? AND name = ? AND state = 'waiting'").get(pool, name)) throw new Error("No skill of that name is waiting.");
      this.db.prepare("DELETE FROM skills WHERE pool = ? AND name = ? AND state = 'active'").run(pool, name);
      this.db.prepare("UPDATE skills SET state = 'active' WHERE pool = ? AND name = ? AND state = 'waiting'").run(pool, name);
      return toSkill(this.db.prepare("SELECT * FROM skills WHERE pool = ? AND name = ? AND state = 'active'").get(pool, name) as Row);
    })();
  }

  /** Declines her waiting draft; the active skill of that name, if any, stays. */
  decline(pool: Pool, name: string): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM skills WHERE pool = ? AND name = ? AND state = 'waiting'").get(pool, name)) throw new Error("No skill of that name is waiting.");
      this.db.prepare("DELETE FROM skills WHERE pool = ? AND name = ? AND state = 'declined'").run(pool, name);
      this.db.prepare("UPDATE skills SET state = 'declined' WHERE pool = ? AND name = ? AND state = 'waiting'").run(pool, name);
    })();
  }

  /** Removes a skill, every version of it. */
  remove(pool: Pool, name: string): void {
    this.db.prepare("DELETE FROM skills WHERE pool = ? AND name = ?").run(pool, name);
  }

  private limit(pool: Pool, name: string): void {
    const { n } = this.db.prepare("SELECT count(*) AS n FROM skills WHERE state IN ('active', 'waiting') AND NOT (pool = ? AND name = ?)").get(pool, name) as { n: number };
    if (n >= SKILL_LIMITS.library) throw new Error(`The library holds at most ${SKILL_LIMITS.library} skills: remove one first.`);
  }

  private insert(s: Skill): Skill {
    this.db.prepare("INSERT INTO skills (pool, name, state, description, body, author, thread, call, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.pool, s.name, s.state, s.description, s.body, s.author, s.thread ?? null, s.call ?? null, s.at);
    return s;
  }
}
