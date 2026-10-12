import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { isThreadView, type PoolView } from "./store/memory.ts";
import { Forbidden, type User, type Users } from "./users.ts";

export const MATRIX = "PERSONALITY_MATRIX.md";
export const CORE_FILES = ["SOUL.md", "STYLE.md", "REGISTER.md"] as const;
const TOPIC_DIR = "persona_topics";
const VALID_PATH = /^(persona_topics\/)?[A-Za-z0-9_.-]+\.md$/;

/** Her name when none is set. */
export const DEFAULT_NAME = "Lyrica";
const NAME_KEY = "self.name";

/** Her name for this deployment (self.db `settings` `self.name`), default Lyrica. */
export function selfName(self: Db): string {
  const row = self.prepare("SELECT value FROM settings WHERE key = ?").get(NAME_KEY) as { value: string } | undefined;
  return row?.value || DEFAULT_NAME;
}

/** Checks and trims a name: 1 to 40 characters on one line. */
export function checkName(name: unknown): string {
  const n = String(name ?? "").trim();
  if (!n || [...n].length > 40) throw new Error("her name is 1 to 40 characters");
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(n)) throw new Error("her name is one line of text");
  return n;
}

export function setSelfName(self: Db, name: string): string {
  const n = checkName(name);
  self.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(NAME_KEY, n);
  return n;
}


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

/** A proposal sent on to the administrators. */
export interface Proposal {
  id: number;
  path: string;
  text: string;
  reason: string;
  /** Who wrote it first: `sleep`, `lyrica`. */
  author: string;
  /** The user who sent it on, `user:<id>`. */
  sentBy: string;
  /** Whether that user changed its text: then the words are theirs. */
  edited: boolean;
  /** The file's revision when it was drafted (0 for a new file). */
  base: number;
  /** The file has changed since: approving would replace those changes. */
  stale: boolean;
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
      core: CORE_FILES.filter((p) => files.has(p)).map((path) => ({ path, text: path === "REGISTER.md" ? named(files.get(path)!, selfName(this.db)) : files.get(path)! })),
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

  /** The file's newest revision, or 0 if it doesn't exist yet. */
  latest(path: string): number {
    return (this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM persona_revisions WHERE path = ?").get(path) as { id: number }).id;
  }

  /** Proposals sent on to the administrators, oldest first. Drafts stay in each user's user.db. */
  proposals(): Proposal[] {
    const rows = this.db.prepare(`SELECT id, path, text, reason, author, sent_by AS sentBy, edited, base, created_at AS createdAt
      FROM persona_proposals ORDER BY id`).all() as (Omit<Proposal, "edited" | "stale"> & { edited: number })[];
    return rows.map((r) => ({ ...r, edited: r.edited === 1, stale: this.latest(r.path) !== r.base }));
  }

  /**
   * Approving applies the change as the administrator; either way the
   * proposal is closed. A proposal whose file changed since it was drafted
   * is approved only with `overwrite`, so newer revisions aren't undone unseen.
   */
  decide(actor: User, id: number, approve: boolean, opts: { overwrite?: boolean } = {}): void {
    if (!actor.admin) throw new Forbidden("only an administrator can decide on persona changes");
    const p = this.proposals().find((q) => q.id === id);
    if (!p) throw new Error(`no proposal ${id}`);
    if (approve && p.stale && !opts.overwrite) throw new Error(`${p.path} has changed since this was proposed; look at it again, then approve with overwrite`);
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

/** REGISTER.md with her set name in its `Name:` line. The stored file is left as it is. */
function named(register: string, name: string): string {
  return register.replace(/^Name:.*$/m, () => `Name: ${name}`);
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
  original   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  author     TEXT NOT NULL,
  base       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface Draft { id: number; path: string; text: string; reason: string; author: string; createdAt: string }

/**
 * Persona proposals as they come from one user's conversation or dream. They
 * may carry that user's details, so they start as drafts in the user's own
 * user.db, which only they can read: they can edit, drop or send each one on.
 * Sending puts it before the administrators in self.db. A proposal from an
 * administrator's own conversation goes there at once. This is the only way
 * into self.db's `persona_proposals`.
 */
export class PersonaProposals {
  constructor(private readonly self: Db, private readonly users: Users, private readonly persona: PersonaStore) {}

  /**
   * Records a proposal from a conversation or a dream. Whose it is comes from
   * the thread's own view, never from the caller, so it can't be put in the
   * wrong user's hands. Returns where it went.
   */
  propose(view: PoolView, threadId: string, p: { path: string; text: string; reason: string; author: string }): { sent: boolean; id: number } {
    if (!isThreadView(view) || !view.own.getThread(threadId)) throw new Error("a proposal comes from one of the user's own threads");
    if (!VALID_PATH.test(p.path)) throw new Error(`not a persona file: ${p.path}`);
    const owner = view.own.owner;
    const base = this.persona.latest(p.path);
    if (this.users.get(owner)?.admin) return { sent: true, id: this.insert({ ...p, sentBy: `user:${owner}`, edited: false, base }) };
    const id = this.db(owner, (db) => Number(db.prepare("INSERT INTO persona_drafts (path, text, original, reason, author, base, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.path, p.text, p.text, p.reason, p.author, base, new Date().toISOString()).lastInsertRowid));
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

  /** Sends a draft on to the administrators, as sent by this user, and edited by them if they changed it. */
  send(userId: string, id: number): number {
    const d = this.db(userId, (db) => db.prepare("SELECT * FROM persona_drafts WHERE id = ?").get(id)) as
      { path: string; text: string; original: string; reason: string; author: string; base: number } | undefined;
    if (!d) throw new Error(`no draft ${id}`);
    const sent = this.insert({ path: d.path, text: d.text, reason: d.reason, author: d.author, sentBy: `user:${userId}`, edited: d.text !== d.original, base: d.base });
    this.drop(userId, id);
    return sent;
  }

  private insert(p: { path: string; text: string; reason: string; author: string; sentBy: string; edited: boolean; base: number }): number {
    return Number(this.self.prepare(`INSERT INTO persona_proposals (path, text, reason, author, sent_by, edited, base, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.path, p.text, p.reason, p.author, p.sentBy, p.edited ? 1 : 0, p.base, new Date().toISOString()).lastInsertRowid);
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
