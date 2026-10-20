import type { Db } from "./db.ts";
import type { Pool } from "./types.ts";

// Skills (docs/briefs/skills.md, DESIGN.md "Skills"): named procedures, kept in each pool's own database like the
// rest of its memory, so a Private thread's skill can't reach a General thread. The person's are active at once;
// hers wait for the person's approval unless the person turned on auto-approve (a user.db setting).

export const SKILLS_SCHEMA = `
CREATE TABLE skills (
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  thread TEXT,
  call TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (name, state)
);
CREATE INDEX skills_call ON skills(call);
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

interface Row { name: string; state: SkillState; description: string; body: string; author: SkillAuthor; thread: string | null; call: string | null; at: string }

/** One pool's skills, on that pool's database: a thread view's `own` or `reads`, or the owner view's. */
export class SkillLibrary {
  constructor(private readonly db: Db, readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  private toSkill = (r: Row): Skill => ({
    pool: this.pool, name: r.name, state: r.state, description: r.description, body: r.body, author: r.author,
    ...(r.thread ? { thread: r.thread } : {}), ...(r.call ? { call: r.call } : {}), at: r.at,
  });

  /** Every skill, for Settings: waiting first, then by name. */
  all(): Skill[] {
    return (this.db.prepare("SELECT * FROM skills ORDER BY state = 'waiting' DESC, name, state").all() as Row[]).map(this.toSkill);
  }

  /** The active skills, by name. */
  active(): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE state = 'active' ORDER BY name").all() as Row[]).map(this.toSkill);
  }

  /** An active skill by name. */
  read(name: string): Skill | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE state = 'active' AND name = ?").get(name) as Row | undefined;
    return row && this.toSkill(row);
  }

  /** The skill her save_skill call made, in whatever state it is now. */
  byCall(call: string): Skill | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE call = ?").get(call) as Row | undefined;
    return row && this.toSkill(row);
  }

  /** The person's own skill, active at once. */
  put(input: unknown): Skill {
    const draft = checkSkill(input);
    return this.db.transaction(() => {
      this.limit(draft.name);
      this.db.prepare("DELETE FROM skills WHERE name = ? AND state IN ('active', 'waiting')").run(draft.name);
      return this.insert({ ...draft, pool: this.pool, state: "active", author: "user", at: this.now().toISOString() });
    })();
  }

  /** Her draft: active at once with auto-approve, otherwise waiting beside the active one it would replace. */
  propose(input: unknown, thread: string, call: string, autoApprove: boolean): Skill {
    const draft = checkSkill(input);
    return this.db.transaction(() => {
      this.limit(draft.name);
      const state: SkillState = autoApprove ? "active" : "waiting";
      this.db.prepare("DELETE FROM skills WHERE name = ? AND state = ?").run(draft.name, state);
      return this.insert({ ...draft, pool: this.pool, state, author: "lyrica", thread, call, at: this.now().toISOString() });
    })();
  }

  /** Approves her waiting draft: it replaces the active skill of that name. */
  approve(name: string): Skill {
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM skills WHERE name = ? AND state = 'waiting'").get(name)) throw new Error("No skill of that name is waiting.");
      this.db.prepare("DELETE FROM skills WHERE name = ? AND state = 'active'").run(name);
      this.db.prepare("UPDATE skills SET state = 'active' WHERE name = ? AND state = 'waiting'").run(name);
      return this.toSkill(this.db.prepare("SELECT * FROM skills WHERE name = ? AND state = 'active'").get(name) as Row);
    })();
  }

  /** Declines her waiting draft; the active skill of that name, if any, stays. */
  decline(name: string): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM skills WHERE name = ? AND state = 'waiting'").get(name)) throw new Error("No skill of that name is waiting.");
      this.db.prepare("DELETE FROM skills WHERE name = ? AND state = 'declined'").run(name);
      this.db.prepare("UPDATE skills SET state = 'declined' WHERE name = ? AND state = 'waiting'").run(name);
    })();
  }

  /** Removes a skill, every version of it. */
  remove(name: string): void {
    this.db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  }

  private limit(name: string): void {
    const { n } = this.db.prepare("SELECT count(*) AS n FROM skills WHERE state IN ('active', 'waiting') AND name != ?").get(name) as { n: number };
    if (n >= SKILL_LIMITS.library) throw new Error(`A pool holds at most ${SKILL_LIMITS.library} skills: remove one first.`);
  }

  private insert(s: Skill): Skill {
    this.db.prepare("INSERT INTO skills (name, state, description, body, author, thread, call, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.name, s.state, s.description, s.body, s.author, s.thread ?? null, s.call ?? null, s.at);
    return s;
  }
}
