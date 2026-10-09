import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { Forbidden, type User, type Users } from "./users.ts";

export const MATRIX = "PERSONALITY_MATRIX.md";
export const CORE_FILES = ["SOUL.md", "STYLE.md", "REGISTER.md"] as const;
const TOPIC_DIR = "persona_topics";
const VALID_PATH = /^(persona_topics\/)?[A-Za-z0-9_.-]+\.md$/;

export interface Topic {
  id: string;
  summary: string;
  triggers: string[];
  priority: number;
  text: string;
}

export interface Persona {
  /** SOUL, STYLE and REGISTER, always in the prompt. */
  core: { path: string; text: string }[];
  /** Routed addenda, from the matrix's front matter. */
  topics: Topic[];
}

export interface Revision {
  id: number;
  path: string;
  text: string;
  author: string;
  createdAt: string;
}

export interface Proposal {
  id: number;
  path: string;
  text: string;
  reason: string;
  author: string;
  createdAt: string;
}

/** Lyrica's persona in self.db. Every change is a new revision; the latest per file is current. */
export class PersonaStore {
  constructor(private readonly db: Db) {}

  /** Imports the seed directory if self.db has no persona yet. Returns whether it imported. */
  importSeed(dir: string): boolean {
    const n = (this.db.prepare("SELECT count(*) AS n FROM persona_revisions").get() as { n: number }).n;
    if (n > 0) return false;
    const paths = [MATRIX, ...CORE_FILES, ...readdirSync(join(dir, TOPIC_DIR)).filter((f) => f.endsWith(".md")).map((f) => `${TOPIC_DIR}/${f}`)];
    this.db.transaction(() => {
      for (const path of paths) this.insert(path, readFileSync(join(dir, path), "utf8"), "seed");
    })();
    return true;
  }

  /** Current text of every persona file, by path. */
  files(): Map<string, string> {
    const rows = this.db.prepare(
      `SELECT path, text FROM persona_revisions r
       WHERE id = (SELECT max(id) FROM persona_revisions WHERE path = r.path) ORDER BY path`,
    ).all() as { path: string; text: string }[];
    return new Map(rows.map((r) => [r.path, r.text]));
  }

  read(): Persona {
    const files = this.files();
    return {
      core: CORE_FILES.filter((p) => files.has(p)).map((path) => ({ path, text: files.get(path)! })),
      topics: parseMatrix(files.get(MATRIX) ?? "").map((t) => ({
        id: t.id,
        summary: t.summary,
        triggers: t.triggers,
        priority: t.priority,
        text: files.get(t.file) ?? "",
      })),
    };
  }

  /** Applies a change as an administrator. The previous text stays as a revision. */
  apply(actor: User, path: string, text: string): void {
    if (!actor.admin) throw new Forbidden("only an administrator can change the persona");
    if (!VALID_PATH.test(path)) throw new Error(`not a persona file: ${path}`);
    if (path === MATRIX) parseMatrix(text, true);
    if (this.files().get(path) === text) return;
    this.insert(path, text, `user:${actor.id}`);
  }

  /** Puts a proposal before the administrators. Only `PersonaProposals.send` (the user's choice) calls it. */
  submit(path: string, text: string, reason: string, author: string): number {
    if (!VALID_PATH.test(path)) throw new Error(`not a persona file: ${path}`);
    return Number(this.db.prepare("INSERT INTO persona_proposals (path, text, reason, author, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(path, text, reason, author, new Date().toISOString()).lastInsertRowid);
  }

  /** Proposals sent on to the administrators, oldest first. Drafts stay in each user's user.db. */
  proposals(): Proposal[] {
    return this.db.prepare("SELECT id, path, text, reason, author, created_at AS createdAt FROM persona_proposals ORDER BY id").all() as Proposal[];
  }

  /** Approving applies the change as the administrator; either way the proposal is closed. */
  decide(actor: User, id: number, approve: boolean): void {
    if (!actor.admin) throw new Forbidden("only an administrator can decide on persona changes");
    const p = this.proposals().find((q) => q.id === id);
    if (!p) throw new Error(`no proposal ${id}`);
    this.db.transaction(() => {
      if (approve) this.apply(actor, p.path, p.text);
      this.db.prepare("DELETE FROM persona_proposals WHERE id = ?").run(id);
    })();
  }

  revisions(path: string): Revision[] {
    return this.db.prepare(
      "SELECT id, path, text, author, created_at AS createdAt FROM persona_revisions WHERE path = ? ORDER BY id",
    ).all(path) as Revision[];
  }

  private insert(path: string, text: string, author: string): void {
    this.db.prepare("INSERT INTO persona_revisions (path, text, author, created_at) VALUES (?, ?, ?, ?)")
      .run(path, text, author, new Date().toISOString());
  }
}

interface MatrixTopic {
  id: string;
  file: string;
  summary: string;
  triggers: string[];
  priority: number;
}

/** Reads the JSON front matter (between `---` lines) of PERSONALITY_MATRIX.md. */
export function parseMatrix(text: string, strict = false): MatrixTopic[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  try {
    if (!m) throw new Error("missing front matter");
    const topics = (JSON.parse(m[1]!) as { topics?: unknown }).topics;
    if (!Array.isArray(topics)) throw new Error("front matter has no topics list");
    return topics.map((t: Partial<MatrixTopic>) => {
      if (typeof t.id !== "string" || typeof t.file !== "string" || !Array.isArray(t.triggers)) {
        throw new Error(`topic ${JSON.stringify(t.id)} needs id, file and triggers`);
      }
      return { id: t.id, file: t.file, summary: t.summary ?? "", triggers: t.triggers.map(String), priority: Number(t.priority ?? 0) };
    });
  } catch (err) {
    if (strict) throw new Error(`${MATRIX}: ${(err as Error).message}`);
    return [];
  }
}

/** Drafts in the originating user's user.db, encrypted with their key. */
export const DRAFT_SCHEMA = `
CREATE TABLE IF NOT EXISTS persona_drafts (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  text       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  author     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type Draft = Proposal;

/**
 * Persona proposals as they come from one user's conversation or dream. They
 * may carry that user's details, so they start as drafts in the user's own
 * user.db, which only they can read: they can edit, drop or send each one on.
 * Sending copies it to self.db for the administrators. A proposal from an
 * administrator's own conversation is sent at once.
 */
export class PersonaProposals {
  constructor(private readonly users: Users, private readonly persona: PersonaStore) {}

  /** Records a proposal from `user`'s conversation or dream. Returns where it went. */
  propose(user: User, p: { path: string; text: string; reason: string; author: string }): { sent: boolean; id: number } {
    if (!VALID_PATH.test(p.path)) throw new Error(`not a persona file: ${p.path}`);
    if (this.users.get(user.id)?.admin) return { sent: true, id: this.persona.submit(p.path, p.text, p.reason, p.author) };
    const id = this.db(user.id, (db) => Number(db.prepare("INSERT INTO persona_drafts (path, text, reason, author, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(p.path, p.text, p.reason, p.author, new Date().toISOString()).lastInsertRowid));
    return { sent: false, id };
  }

  drafts(userId: string): Draft[] {
    return this.db(userId, (db) => db.prepare("SELECT id, path, text, reason, author, created_at AS createdAt FROM persona_drafts ORDER BY id").all() as Draft[]);
  }

  edit(userId: string, id: number, change: { text?: string; reason?: string }): Draft {
    this.db(userId, (db) => {
      if (!db.prepare("UPDATE persona_drafts SET text = coalesce(?, text), reason = coalesce(?, reason) WHERE id = ?")
        .run(change.text ?? null, change.reason ?? null, id).changes) throw new Error(`no draft ${id}`);
    });
    return this.drafts(userId).find((d) => d.id === id)!;
  }

  drop(userId: string, id: number): void {
    this.db(userId, (db) => { if (!db.prepare("DELETE FROM persona_drafts WHERE id = ?").run(id).changes) throw new Error(`no draft ${id}`); });
  }

  /** Sends a draft on to the administrators. Returns its id among the sent proposals. */
  send(userId: string, id: number): number {
    const d = this.drafts(userId).find((x) => x.id === id);
    if (!d) throw new Error(`no draft ${id}`);
    const sent = this.persona.submit(d.path, d.text, d.reason, d.author);
    this.drop(userId, id);
    return sent;
  }

  private db<T>(userId: string, fn: (db: Db) => T): T {
    const db = this.users.openUserDb(userId);
    try {
      db.exec(DRAFT_SCHEMA);
      return fn(db);
    } finally {
      db.close();
    }
  }
}
