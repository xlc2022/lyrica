// Artifacts (docs/briefs/artifacts.md): a page she published or the person imported, kept with every version it has
// had. Principle 4: two tables in the pool's own database, so a version doesn't change when the file it came from
// does, an imported page needs no thread folder, and the list is one query. The bytes are encrypted with the pool.
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";

export const ARTIFACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  thread     TEXT,
  path       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_thread ON artifacts (thread, path);
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,
  bytes      BLOB NOT NULL,
  built      BLOB,
  author     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact, n)
);
`;

/** What an artifact is: a page, a drawing, a document, or a React component built into a page. */
export type ArtifactKind = "html" | "svg" | "markdown" | "react";
/** Who made a version: her `page publish`, or the person's import or restore. */
export type ArtifactAuthor = "lyrica" | "user";

/** The largest version kept, the file viewer's own limit. */
export const ARTIFACT_LIMIT = 16 * 1024 * 1024;
/** The longest title kept. */
export const ARTIFACT_TITLE_MAX = 120;

export interface Artifact {
  id: string;
  pool: Pool;
  title: string;
  kind: ArtifactKind;
  /** The thread it belongs to; none for one imported on its own, or kept when its thread was deleted. */
  thread?: string;
  /** The file it was last published from, as its thread names it. */
  path?: string;
  /** Its newest version's number, which is also how many it has had. */
  version: number;
  /** The newest version's size in bytes. */
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion { n: number; author: ArtifactAuthor; size: number; createdAt: string }

/** A version's content: `bytes` as written; `built` is the page made from a React component's source. */
export interface ArtifactContent { kind: ArtifactKind; n: number; bytes: Buffer; built?: Buffer }

/** A file's kind by its name, or nothing when it can't be an artifact. */
export function artifactKind(name: string): ArtifactKind | undefined {
  const ext = posix.extname(name).slice(1).toLowerCase();
  return ext === "html" || ext === "htm" ? "html" : ext === "svg" ? "svg" : ext === "md" || ext === "markdown" ? "markdown"
    : ext === "jsx" || ext === "tsx" ? "react" : undefined;
}

/** The extension a download of this kind gets. */
export const artifactExtension = (kind: ArtifactKind) => (kind === "html" ? "html" : kind === "svg" ? "svg" : kind === "markdown" ? "md" : "tsx");

/** A title from a file's name: its base name without the extension, hyphens and underscores as spaces. */
export function titleFromName(name: string): string {
  const base = posix.basename(name).replace(/\.[^.]+$/, "").replace(/\.single$/, "").replace(/[-_]+/g, " ").trim();
  return (base || "Artifact").slice(0, ARTIFACT_TITLE_MAX);
}

/** A problem with what was given (a title, a size, a missing artifact), said to whoever asked. */
export class ArtifactError extends Error {
  constructor(message: string) { super(message); this.name = "ArtifactError"; }
}

interface Row { id: string; title: string; kind: ArtifactKind; thread: string | null; path: string | null; created_at: string; updated_at: string; version: number; size: number }

const SELECT = `SELECT a.*, v.n AS version, length(v.bytes) AS size FROM artifacts a
  JOIN artifact_versions v ON v.artifact = a.id AND v.n = (SELECT max(n) FROM artifact_versions WHERE artifact = a.id)`;

export interface NewVersion { bytes: Buffer; built?: Buffer; author: ArtifactAuthor }

/** One pool's artifacts, on that pool's database: a thread view's `own`, or the owner view's. */
export class ArtifactLibrary {
  constructor(private readonly db: Db, readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  private toArtifact = (r: Row): Artifact => ({
    id: r.id, pool: this.pool, title: r.title, kind: r.kind, ...(r.thread ? { thread: r.thread } : {}), ...(r.path ? { path: r.path } : {}),
    version: r.version, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  private checkTitle(title: string): string {
    const t = title.replace(/\s+/g, " ").trim();
    if (!t) throw new ArtifactError("An artifact needs a title.");
    if (t.length > ARTIFACT_TITLE_MAX) throw new ArtifactError(`A title is at most ${ARTIFACT_TITLE_MAX} characters.`);
    return t;
  }

  private checkSize(v: NewVersion): void {
    if (!v.bytes.length) throw new ArtifactError("The page is empty.");
    if (v.bytes.length > ARTIFACT_LIMIT || (v.built?.length ?? 0) > ARTIFACT_LIMIT) throw new ArtifactError("An artifact is at most 16 MiB.");
  }

  /** Every artifact, newest change first; `threads` keeps those of the named threads. */
  list(opts: { threads?: string[] } = {}): Artifact[] {
    if (opts.threads && !opts.threads.length) return [];
    const where = opts.threads ? ` WHERE a.thread IN (${opts.threads.map(() => "?").join(",")})` : "";
    return (this.db.prepare(`${SELECT}${where} ORDER BY a.updated_at DESC, a.id`).all(...(opts.threads ?? [])) as Row[]).map(this.toArtifact);
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
    return row && this.toArtifact(row);
  }

  private must(id: string): Artifact {
    const a = this.get(id);
    if (!a) throw new ArtifactError(`No artifact ${id}.`);
    return a;
  }

  /** The artifact a thread published from this path. */
  byPath(thread: string, path: string): Artifact | undefined {
    const row = this.db.prepare(`${SELECT} WHERE a.thread = ? AND a.path = ?`).get(thread, path) as Row | undefined;
    return row && this.toArtifact(row);
  }

  /** Its versions, newest first, without their bytes. */
  versions(id: string): ArtifactVersion[] {
    return (this.db.prepare("SELECT n, author, length(bytes) AS size, created_at FROM artifact_versions WHERE artifact = ? ORDER BY n DESC").all(id) as
      { n: number; author: ArtifactAuthor; size: number; created_at: string }[]).map((r) => ({ n: r.n, author: r.author, size: r.size, createdAt: r.created_at }));
  }

  /** A version's content; the newest when `n` is left out. */
  read(id: string, n?: number): ArtifactContent | undefined {
    const row = this.db.prepare(`SELECT a.kind, v.n, v.bytes, v.built FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact
      WHERE v.artifact = ? AND ${n === undefined ? "v.n = (SELECT max(n) FROM artifact_versions WHERE artifact = v.artifact)" : "v.n = ?"}`)
      .get(...(n === undefined ? [id] : [id, n])) as { kind: ArtifactKind; n: number; bytes: Buffer; built: Buffer | null } | undefined;
    return row && { kind: row.kind, n: row.n, bytes: row.bytes, ...(row.built ? { built: row.built } : {}) };
  }

  /** A new artifact at version 1. */
  create(a: { title: string; kind: ArtifactKind; thread?: string; path?: string } & NewVersion): Artifact {
    const title = this.checkTitle(a.title);
    this.checkSize(a);
    const id = randomUUID(), at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO artifacts (id, title, kind, thread, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, title, a.kind, a.thread ?? null, a.path ?? null, at, at);
      this.db.prepare("INSERT INTO artifact_versions (artifact, n, bytes, built, author, created_at) VALUES (?, 1, ?, ?, ?, ?)")
        .run(id, a.bytes, a.built ?? null, a.author, at);
    })();
    return this.must(id);
  }

  /** The next version of an artifact; `path` and `title` follow when given. A version is never changed afterwards. */
  addVersion(id: string, v: NewVersion & { path?: string; title?: string }): Artifact {
    const a = this.must(id);
    this.checkSize(v);
    const title = v.title === undefined ? a.title : this.checkTitle(v.title);
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO artifact_versions (artifact, n, bytes, built, author, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, a.version + 1, v.bytes, v.built ?? null, v.author, at);
      this.db.prepare("UPDATE artifacts SET updated_at = ?, title = ?, path = ? WHERE id = ?").run(at, title, v.path ?? a.path ?? null, id);
    })();
    return this.must(id);
  }

  /**
   * Her `page publish`: a version of `artifact` when she names one of this thread's (or its project's, `threads`),
   * else of the artifact this thread published from the same path, else a new artifact.
   */
  publish(p: { thread: string; threads?: string[]; path: string; kind: ArtifactKind; title?: string; artifact?: string } & NewVersion): { artifact: Artifact; created: boolean } {
    let existing: Artifact | undefined;
    if (p.artifact) {
      existing = this.get(p.artifact);
      if (!existing?.thread || ![p.thread, ...(p.threads ?? [])].includes(existing.thread)) throw new ArtifactError(`No artifact ${p.artifact} in this thread or its project.`);
    } else existing = this.byPath(p.thread, p.path);
    if (existing) {
      if (existing.kind !== p.kind) throw new ArtifactError(`${existing.title} is ${existing.kind}, and ${p.path} is ${p.kind}: publish it as a new artifact from another path.`);
      const same = this.read(existing.id);
      if (same && same.bytes.equals(p.bytes) && (p.title === undefined || this.checkTitle(p.title) === existing.title)) return { artifact: existing, created: false };
      return { artifact: this.addVersion(existing.id, { bytes: p.bytes, built: p.built, author: p.author, path: p.path, title: p.title }), created: false };
    }
    return { artifact: this.create({ title: p.title ?? titleFromName(p.path), kind: p.kind, thread: p.thread, path: p.path, bytes: p.bytes, built: p.built, author: p.author }), created: true };
  }

  /** An old version again, as a new version; nothing is removed. */
  restore(id: string, n: number, author: ArtifactAuthor): Artifact {
    const old = this.read(id, n);
    if (!old) throw new ArtifactError(`No version ${n}.`);
    return this.addVersion(id, { bytes: old.bytes, built: old.built, author });
  }

  rename(id: string, title: string): Artifact {
    this.must(id);
    this.db.prepare("UPDATE artifacts SET title = ? WHERE id = ?").run(this.checkTitle(title), id);
    return this.must(id);
  }

  /** The artifact and every version of it. */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM artifact_versions WHERE artifact = ?").run(id);
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    })();
  }

  /** A deleted thread's artifacts go with it; with `keep` they stay, belonging to no thread. */
  forgetThread(thread: string, keep = false): void {
    if (keep) { this.db.prepare("UPDATE artifacts SET thread = NULL, path = NULL WHERE thread = ?").run(thread); return; }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM artifact_versions WHERE artifact IN (SELECT id FROM artifacts WHERE thread = ?)").run(thread);
      this.db.prepare("DELETE FROM artifacts WHERE thread = ?").run(thread);
    })();
  }
}
