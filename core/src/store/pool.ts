import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import { render, toStored, type UserId } from "../mentions.ts";
import type { Profile } from "../profile.ts";
import type { Interface, Pool } from "../types.ts";
import { citationsIn, ftsQuery, indexText, kindOf, queryWords, snippet, type Kind } from "./refs.ts";

/** Who made a change. Thread views write as `lyrica` or `sleep`; the owner view as `user:<id>`. */
export type Author = "lyrica" | "sleep" | `user:${string}`;
export type Origin = "lyrica" | "sleep" | "user";

export interface Thread {
  id: string;
  interface: Interface;
  parent?: string;
  /** Delegated by its parent: the UI nests it there. */
  subagent: boolean;
  title?: string;
  hidden: boolean;
  unlogged: boolean;
  createdAt: string;
}

/** One Pi session entry. `text` is what search and thread windows see (tool output already shortened). */
export interface NewEntry {
  piId: string;
  role: string;
  data: unknown;
  text: string;
}

export interface StoredEntry {
  /** `e:<thread>#<n>`, or the original entry's ID for an exported copy. */
  id: string;
  role: string;
  text: string;
  unlogged: boolean;
  createdAt: string;
}

export interface NoteInput {
  text: string;
  about?: string[];
  /** Notes this one corrects. They stay, but drop out of automatic recall. */
  supersedes?: string[];
  /** The entry it came from; cited inline unless the text already cites it. */
  source?: string;
}

export interface PageInput {
  slug: string;
  title: string;
  summary: string;
  text: string;
  folders?: string[];
}

/** The editable fields of a memory. One version of it is a revision. */
export interface Body {
  text: string;
  title?: string;
  summary?: string;
  folders?: string[];
  about?: string[];
}

export interface Item extends Body {
  id: string;
  kind: Kind;
  origin?: Origin;
  author?: string;
  supersededBy?: string;
  archived?: boolean;
  flagged?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Hit {
  id: string;
  kind: Kind;
  snippet: string;
  /** Higher is better (negated BM25). */
  score: number;
  origin?: Origin;
  author?: string;
  supersededBy?: string;
}

export interface SearchOptions {
  kinds?: Kind[];
  limit?: number;
  /** Leave out superseded notes (automatic recall does). */
  current?: boolean;
  /** Leave out entries of this thread (already in context). */
  excludeThread?: string;
  includeArchived?: boolean;
}

export interface MemoryRevision {
  id: number;
  item: string;
  body: Body;
  author: string;
  createdAt: string;
}

export interface Edited {
  id: string;
  author: string;
  at: string;
}

export interface StoreContext {
  db: Db;
  pool: Pool;
  /** The user whose pool this is. `{user}` in written text means them. */
  owner: UserId;
  profiles: () => Map<UserId, Profile>;
  /** "thread" writes as lyrica or sleep; "owner" as the user. */
  mode: "thread" | "owner";
}

const now = () => new Date().toISOString();
const json = <T>(s: string): T => JSON.parse(s) as T;
const entryId = (thread: string, n: number) => `e:${thread}#${n}`;
const TOOL_TEXT_LIMIT = 2000;

/** Read access to one pool database. A private thread view holds general memory only through this. */
export class PoolReader {
  constructor(protected readonly c: StoreContext) {}

  get pool(): Pool { return this.c.pool; }
  protected get db(): Db { return this.c.db; }
  close(): void { this.db.close(); }

  protected render(text: string): string {
    const profiles = this.c.profiles();
    return render(text, (id) => profiles.get(id));
  }

  // Threads and entries

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row && toThread(row);
  }

  /** With `parent`, only that thread's subagents. */
  listThreads(opts: { includeHidden?: boolean; parent?: string } = {}): Thread[] {
    const where = [opts.includeHidden ? "" : "hidden = 0", opts.parent === undefined ? "" : "parent = @parent AND subagent = 1"].filter(Boolean);
    const rows = this.db.prepare(`SELECT * FROM threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`)
      .all(opts.parent === undefined ? {} : { parent: opts.parent }) as ThreadRow[];
    return rows.map(toThread);
  }

  /** The thread's Pi entries, in order, for `SessionManager.inMemory`. */
  loadEntries(threadId: string): unknown[] {
    return (this.db.prepare("SELECT data FROM entries WHERE thread = ? ORDER BY n").all(threadId) as { data: string }[])
      .map((r) => json(r.data));
  }

  /** A page of the thread's raw entries, oldest first: the newest `limit`, or those before entry `before`. */
  entryPage(threadId: string, opts: { before?: number; limit: number }): { entries: { n: number; data: unknown; createdAt: string }[]; hasMore: boolean } {
    const rows = this.db.prepare("SELECT n, data, created_at FROM entries WHERE thread = ? AND n < ? ORDER BY n DESC LIMIT ?")
      .all(threadId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1) as { n: number; data: string; created_at: string }[];
    const hasMore = rows.length > opts.limit;
    return { entries: rows.slice(0, opts.limit).reverse().map((r) => ({ n: r.n, data: json(r.data), createdAt: r.created_at })), hasMore };
  }

  /** Pi entry IDs already stored for the thread. */
  storedPiIds(threadId: string): Set<string> {
    return new Set((this.db.prepare("SELECT pi_id FROM entries WHERE thread = ?").all(threadId) as { pi_id: string }[]).map((r) => r.pi_id));
  }

  /** The newest entry of the thread with one of the roles, or of any role. */
  lastEntry(threadId: string, roles?: string[]): StoredEntry | undefined {
    const filter = roles ? `AND role IN (${roles.map(() => "?").join(",")})` : "";
    const row = this.db.prepare(`SELECT * FROM entries WHERE thread = ? ${filter} ORDER BY n DESC LIMIT 1`)
      .get(threadId, ...(roles ?? [])) as EntryRow | undefined;
    return row && toEntry(row);
  }

  /** When the user last spoke in this pool, in any thread. */
  lastUserMessage(): Date | undefined {
    const row = this.db.prepare("SELECT max(created_at) AS at FROM entries WHERE role = 'user' AND unlogged = 0").get() as { at: string | null };
    return row.at ? new Date(row.at) : undefined;
  }

  /**
   * Entries around `e:<thread>#<n>`, for reading a past conversation. Entries
   * written unlogged are never shown outside their own thread.
   */
  entryWindow(id: string, radius = 4, fromThread?: string): StoredEntry[] {
    const m = /^e:(.+)#(\d+)$/.exec(id);
    if (!m) return [];
    const [, thread, n] = m as unknown as [string, string, string];
    const own = thread === fromThread;
    return (this.db.prepare(`SELECT * FROM entries WHERE thread = ? AND n BETWEEN ? AND ? ${own ? "" : "AND unlogged = 0"} ORDER BY n`)
      .all(thread, Number(n) - radius, Number(n) + radius) as EntryRow[]).map(toEntry);
  }

  // Memories

  /** A note, page, journal entry or WAKE, with mentions rendered (or raw, for an editor). */
  get(id: string, opts: { raw?: boolean } = {}): Item | undefined {
    const item = this.load(id);
    if (!item || opts.raw) return item;
    return { ...item, text: this.render(item.text), title: item.title && this.render(item.title), summary: item.summary && this.render(item.summary) };
  }

  protected load(id: string): Item | undefined {
    switch (kindOf(id)) {
      case "note": {
        const r = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
        return r && {
          id, kind: "note", text: r.text, about: r.about ? r.about.split(", ") : [], origin: r.origin as Origin, author: r.author,
          supersededBy: r.superseded_by ?? undefined, archived: r.archived === 1, createdAt: r.created_at, updatedAt: r.updated_at,
        };
      }
      case "page": {
        const r = this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(id.slice(2)) as PageRow | undefined;
        return r && {
          id, kind: "page", text: r.text, title: r.title, summary: r.summary, folders: json(r.folders), origin: r.origin as Origin,
          author: r.author, archived: r.archived === 1, flagged: r.flagged === 1, createdAt: r.created_at, updatedAt: r.updated_at,
        };
      }
      case "journal": {
        const r = this.db.prepare("SELECT * FROM journal WHERE id = ?").get(id) as { text: string; created_at: string; updated_at: string } | undefined;
        return r && { id, kind: "journal", text: r.text, createdAt: r.created_at, updatedAt: r.updated_at };
      }
      case "wake": {
        const r = this.db.prepare("SELECT * FROM wake WHERE id = 1").get() as { text: string; updated_at: string } | undefined;
        return r && { id, kind: "wake", text: r.text, createdAt: r.updated_at, updatedAt: r.updated_at };
      }
      default:
        return undefined;
    }
  }

  getWake(): string | undefined { return this.load("wake")?.text; }

  /** Titles and one-line summaries of every page she uses, newest first. */
  pageIndex(): { id: string; title: string; summary: string; updatedAt: string }[] {
    return (this.db.prepare("SELECT slug, title, summary, updated_at FROM pages WHERE archived = 0 ORDER BY updated_at DESC").all() as PageRow[])
      .map((r) => ({ id: `p:${r.slug}`, title: this.render(r.title), summary: this.render(r.summary), updatedAt: r.updated_at }));
  }

  /** Pages whose folders contain or equal any of the paths. */
  forFolders(paths: string[]): Item[] {
    const norm = (p: string) => p.replace(/\/+$/, "");
    const wanted = paths.map(norm).filter(Boolean);
    if (!wanted.length) return [];
    const rows = this.db.prepare("SELECT slug, folders FROM pages WHERE archived = 0 AND folders != '[]' ORDER BY updated_at DESC").all() as PageRow[];
    return rows
      .filter((r) => json<string[]>(r.folders).map(norm).some((f) => wanted.some((p) => p === f || p.startsWith(`${f}/`))))
      .map((r) => this.get(`p:${r.slug}`)!);
  }

  listJournal(limit = 20): Item[] {
    return (this.db.prepare("SELECT id FROM journal ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string }[])
      .map((r) => this.get(r.id)!);
  }

  /** Notes and pages a user added. */
  userIntroduced(): string[] {
    return (this.db.prepare(
      "SELECT id, updated_at FROM notes WHERE origin = 'user' UNION ALL SELECT 'p:' || slug, updated_at FROM pages WHERE origin = 'user' ORDER BY 2 DESC",
    ).all() as { id: string }[]).map((r) => r.id);
  }

  // Search

  search(query: string, opts: SearchOptions = {}): Hit[] {
    const fts = ftsQuery(query, this.c.profiles());
    if (!fts) return [];
    const limit = opts.limit ?? 8;
    const rows = this.db.prepare("SELECT id, kind, bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?")
      .all(fts, limit * 4) as { id: string; kind: Kind; rank: number }[];
    const words = queryWords(query);
    const hits: Hit[] = [];
    for (const row of rows) {
      if (opts.kinds && !opts.kinds.includes(row.kind)) continue;
      const hit = this.hit(row.id, row.kind, words, -row.rank, opts);
      if (hit) hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private hit(id: string, kind: Kind, words: string[], score: number, opts: SearchOptions): Hit | undefined {
    if (kind === "entry") {
      if (opts.excludeThread && id.startsWith(`e:${opts.excludeThread}#`)) return undefined;
      const [entry] = this.entryWindow(id, 0);
      return entry && { id, kind, score, snippet: snippet(entry.text, words) };
    }
    const item = this.get(id);
    if (!item || (item.archived && !opts.includeArchived) || (item.supersededBy && opts.current)) return undefined;
    const text = item.kind === "page" ? `${item.title}: ${item.summary}\n${item.text}` : item.text;
    return { id, kind, score, snippet: snippet(text, words), origin: item.origin, author: item.author, supersededBy: item.supersededBy };
  }

  // Lineage

  /** What the item cites (its sources, or what a user memory is connected to). */
  cameFrom(id: string): string[] {
    return (this.db.prepare("SELECT dst FROM citations WHERE src = ? ORDER BY dst").all(id) as { dst: string }[]).map((r) => r.dst);
  }

  /** What cites the item. From a private store, pass `general/…` to find private memory citing general. */
  usedIn(id: string): string[] {
    return (this.db.prepare("SELECT src FROM citations WHERE dst = ? ORDER BY src").all(id) as { src: string }[]).map((r) => r.src);
  }

  revisions(id: string): MemoryRevision[] {
    return (this.db.prepare("SELECT * FROM revisions WHERE item = ? ORDER BY id").all(id) as RevisionRow[])
      .map((r) => ({ id: r.id, item: r.item, body: json(r.body), author: r.author, createdAt: r.created_at }));
  }

  /** Whether a deleted memory came from this entry (or its whole thread), so sleep mustn't extract it again. */
  isTombstoned(entry: string): boolean {
    const thread = /^e:(.+)#\d+$/.exec(entry)?.[1];
    return !!this.db.prepare("SELECT 1 FROM tombstones, json_each(tombstones.sources) WHERE value = ? OR value = ? LIMIT 1")
      .get(entry, thread ? `t:${thread}` : entry);
  }

  /** Memories a user changed after `since` (an ISO time), newest change per item. Sleep treats these as authoritative. */
  editedSince(since: string): Edited[] {
    return (this.db.prepare(
      "SELECT item AS id, author, max(created_at) AS at FROM revisions WHERE author LIKE 'user:%' AND created_at > ? GROUP BY item ORDER BY at",
    ).all(since) as Edited[]);
  }
}

/** Read and write access to one pool database. */
export class PoolStore extends PoolReader {
  // Threads and entries

  /** A daughter of an unlogged thread is always unlogged. */
  createThread(opts: { interface: Interface; parent?: string; subagent?: boolean; unlogged?: boolean; title?: string }): Thread {
    const parent = opts.parent === undefined ? undefined : this.getThread(opts.parent);
    if (opts.parent !== undefined && !parent) throw new Error(`no such thread: ${opts.parent}`);
    if (opts.subagent && !parent) throw new Error("a subagent's thread needs its parent");
    let id: string;
    do id = `${opts.interface}/${randomBytes(4).toString("hex")}`; while (this.getThread(id));
    const unlogged = !!opts.unlogged || !!parent?.unlogged;
    this.db.prepare("INSERT INTO threads (id, interface, parent, subagent, title, unlogged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, opts.interface, parent?.id ?? null, opts.subagent ? 1 : 0, opts.title ?? null, unlogged ? 1 : 0, now());
    return this.getThread(id)!;
  }

  setTitle(id: string, title: string): void {
    this.mustThread(id);
    const clean = title.trim();
    if (!clean || clean.length > 200) throw new Error("a title has 1 to 200 characters");
    this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(clean, id);
  }

  setHidden(id: string, hidden: boolean): void {
    this.mustThread(id);
    this.db.prepare("UPDATE threads SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id);
  }

  /** Affects only entries written afterwards. A daughter of an unlogged thread can't be logged. */
  setUnlogged(id: string, unlogged: boolean): void {
    const thread = this.mustThread(id);
    if (!unlogged && thread.parent && this.getThread(thread.parent)?.unlogged) {
      throw new Error("this thread's parent isn't logged, so it can't be logged either");
    }
    this.db.prepare("UPDATE threads SET unlogged = ? WHERE id = ?").run(unlogged ? 1 : 0, id);
  }

  /** Stores one Pi entry and returns its ID. Entries written while unlogged are never indexed. */
  appendEntry(threadId: string, entry: NewEntry, at = now()): string {
    const thread = this.mustThread(threadId);
    return this.tx(() => {
      const n = (this.db.prepare("SELECT coalesce(max(n), 0) + 1 AS n FROM entries WHERE thread = ?").get(threadId) as { n: number }).n;
      this.db.prepare("INSERT INTO entries (thread, n, pi_id, role, data, text, unlogged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(threadId, n, entry.piId, entry.role, JSON.stringify(entry.data), entry.text, thread.unlogged ? 1 : 0, at);
      const id = entryId(threadId, n);
      if (!thread.unlogged && entry.text.trim()) this.index(id, "entry", entry.role === "toolResult" ? entry.text.slice(0, TOOL_TEXT_LIMIT) : entry.text);
      return id;
    });
  }

  /**
   * Copies a thread to another interface. The copy's entries keep their
   * original IDs and aren't indexed again, so nothing is processed twice.
   */
  exportThread(threadId: string, to: Interface): Thread {
    const source = this.mustThread(threadId);
    return this.tx(() => {
      const copy = this.createThread({ interface: to, parent: source.id, title: source.title });
      this.db.prepare(`INSERT INTO entries (thread, n, pi_id, role, data, text, unlogged, orig, created_at)
        SELECT ?, n, pi_id, role, data, text, unlogged, coalesce(orig, 'e:' || thread || '#' || n), created_at FROM entries WHERE thread = ?`)
        .run(copy.id, source.id);
      return copy;
    });
  }

  /**
   * Deletes the thread and its entries, and the notes whose only sources were
   * in it (each leaves a tombstone, and pages citing them are flagged). Its
   * subagents' threads hold its tasks and results, so they go first.
   */
  forgetThread(threadId: string, author: Author): void {
    this.checkAuthor(author);
    this.mustThread(threadId);
    for (const child of this.listThreads({ includeHidden: true, parent: threadId })) this.forgetThread(child.id, author);
    this.tx(() => {
      const inThread = (dst: string) => dst === `t:${threadId}` || dst.startsWith(`e:${threadId}#`);
      const candidates = this.db.prepare("SELECT DISTINCT src FROM citations WHERE src LIKE 'n:%' AND (dst = ? OR dst LIKE ?)")
        .all(`t:${threadId}`, `e:${threadId}#%`) as { src: string }[];
      for (const { src } of candidates) {
        if (this.cameFrom(src).every(inThread)) this.remove(src, author, true);
      }
      this.db.prepare("DELETE FROM search WHERE kind = 'entry' AND id LIKE ?").run(`e:${threadId}#%`);
      this.db.prepare("DELETE FROM entries WHERE thread = ?").run(threadId);
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      this.optimize();
    });
  }

  // Notes

  /**
   * Saves notes. `{user}` mentions become tokens. From a thread view the
   * thread must be logged, and each note cites its source entry.
   */
  addNotes(notes: NoteInput[], opts: { author: Author; thread?: string }): string[] {
    this.checkAuthor(opts.author);
    if (opts.thread !== undefined && this.mustThread(opts.thread).unlogged) {
      throw new Error("this thread isn't logged in memory, so notes can't be written from it");
    }
    return this.tx(() => notes.map((note) => {
      let text = toStored(note.text.trim(), this.c.owner);
      if (!text) throw new Error("a note needs text");
      if (note.source && !citationsIn(text, this.pool).includes(note.source)) text = `${text} [${note.source}]`;
      const id = this.newId("n", "notes");
      const at = now();
      const about = (note.about ?? []).map((a) => a.trim()).filter(Boolean);
      this.db.prepare("INSERT INTO notes (id, text, about, origin, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, text, about.join(", "), originOf(opts.author), opts.author, at, at);
      this.written(id, { text, about }, opts.author, at);
      for (const old of note.supersedes ?? []) {
        if (!this.load(old) || kindOf(old) !== "note") throw new Error(`no such note to supersede: ${old}`);
        this.db.prepare("UPDATE notes SET superseded_by = ? WHERE id = ?").run(id, old);
      }
      return id;
    }));
  }

  // Pages, WAKE and journal

  /** Creates or rewrites a page. Sleep may add to a user's page; only the user may change who it belongs to. */
  putPage(page: PageInput, author: Author): string {
    this.checkAuthor(author);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(page.slug)) throw new Error("page slugs use lowercase letters, digits and '-'");
    const id = `p:${page.slug}`;
    const body: Body = { text: page.text, title: page.title, summary: page.summary, folders: page.folders ?? [] };
    if (this.load(id)) {
      this.edit(id, body, author);
      return id;
    }
    const at = now();
    return this.tx(() => {
      const stored = this.stored(body);
      this.db.prepare(`INSERT INTO pages (slug, title, summary, text, folders, origin, author, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(page.slug, stored.title, stored.summary, stored.text, JSON.stringify(stored.folders), originOf(author), author, at, at);
      this.written(id, stored, author, at);
      return id;
    });
  }

  putWake(text: string, author: Author): void {
    this.checkAuthor(author);
    if (this.load("wake")) return this.edit("wake", { text }, author);
    const at = now();
    this.tx(() => {
      this.db.prepare("INSERT INTO wake (id, text, updated_at) VALUES (1, ?, ?)").run(text, at);
      this.written("wake", { text }, author, at);
    });
  }

  addJournal(text: string, author: Author): string {
    this.checkAuthor(author);
    return this.tx(() => {
      const id = this.newId("j", "journal");
      const at = now();
      this.db.prepare("INSERT INTO journal (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, text, at, at);
      this.written(id, { text }, author, at);
      return id;
    });
  }

  // Editing

  /**
   * Changes a memory. The new version is a revision; mention tokens are kept
   * and `{user}` is accepted; citations and the search index update with it.
   * Only the user may change what a user wrote.
   */
  edit(id: string, change: Partial<Body>, author: Author): void {
    this.checkAuthor(author);
    const item = this.load(id);
    if (!item) throw new Error(`no such memory: ${id}`);
    if (item.origin === "user" && item.kind === "note" && !author.startsWith("user:")) {
      throw new Error("a memory a user added can only be changed by the user");
    }
    const body = this.stored({ ...bodyOf(item), ...change });
    const at = now();
    this.tx(() => {
      switch (item.kind) {
        case "note":
          this.db.prepare("UPDATE notes SET text = ?, about = ?, updated_at = ? WHERE id = ?").run(body.text, (body.about ?? []).join(", "), at, id);
          break;
        case "page":
          this.db.prepare("UPDATE pages SET text = ?, title = ?, summary = ?, folders = ?, flagged = 0, updated_at = ? WHERE slug = ?")
            .run(body.text, body.title, body.summary, JSON.stringify(body.folders ?? []), at, id.slice(2));
          break;
        case "journal":
          this.db.prepare("UPDATE journal SET text = ?, updated_at = ? WHERE id = ?").run(body.text, at, id);
          break;
        case "wake":
          this.db.prepare("UPDATE wake SET text = ?, updated_at = ? WHERE id = 1").run(body.text, at);
          break;
      }
      this.written(id, body, author, at);
    });
  }

  /** Brings back an earlier version, as a new revision. */
  restore(id: string, revisionId: number, author: Author): void {
    const rev = this.revisions(id).find((r) => r.id === revisionId);
    if (!rev) throw new Error(`no revision ${revisionId} of ${id}`);
    this.edit(id, rev.body, author);
  }

  /** She stops using it; it is kept, and can be brought back. */
  archive(id: string, archived: boolean, author: Author): void {
    this.checkAuthor(author);
    const table = { note: "notes", page: "pages" }[kindOf(id) as "note"];
    if (!table || !this.load(id)) throw new Error(`no such note or page: ${id}`);
    this.db.prepare(`UPDATE ${table} SET archived = ? WHERE ${table === "pages" ? "slug" : "id"} = ?`)
      .run(archived ? 1 : 0, table === "pages" ? id.slice(2) : id);
  }

  /** Removes the text and every revision, leaves a text-free tombstone, and flags pages that cited it. */
  delete(id: string, author: Author): void {
    this.checkAuthor(author);
    if (!this.load(id)) throw new Error(`no such memory: ${id}`);
    this.tx(() => {
      this.remove(id, author, false);
      this.optimize();
    });
  }

  /** Forgetting a topic: delete every memory the user picked from a search, at once. */
  deleteMany(ids: string[], author: Author): void {
    this.checkAuthor(author);
    this.tx(() => {
      for (const id of ids) if (this.load(id)) this.remove(id, author, false);
      this.optimize();
    });
  }

  // Internals

  private remove(id: string, author: Author, forgettingThread: boolean): void {
    const item = this.load(id)!;
    if (item.origin === "user" && !author.startsWith("user:") && !forgettingThread) {
      throw new Error("a memory a user added can only be deleted by the user");
    }
    // Every source any version cited, so an edit that dropped a citation can't let the fact back in.
    const sources = [...new Set([...this.cameFrom(id), ...this.revisions(id).flatMap((r) => citationsIn(r.body.text, this.pool))])].sort();
    this.db.prepare("INSERT OR REPLACE INTO tombstones (id, kind, sources, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, item.kind, JSON.stringify(sources), author, now());
    this.db.prepare("UPDATE pages SET flagged = 1 WHERE 'p:' || slug IN (SELECT src FROM citations WHERE dst = ?)").run(id);
    if (item.kind === "note") this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    if (item.kind === "page") this.db.prepare("DELETE FROM pages WHERE slug = ?").run(id.slice(2));
    if (item.kind === "journal") this.db.prepare("DELETE FROM journal WHERE id = ?").run(id);
    if (item.kind === "wake") this.db.prepare("DELETE FROM wake").run();
    this.db.prepare("DELETE FROM revisions WHERE item = ?").run(id);
    this.db.prepare("DELETE FROM citations WHERE src = ?").run(id);
    this.db.prepare("DELETE FROM search WHERE id = ?").run(id);
  }

  /** Records a new version: a revision, its citations and its search row. */
  private written(id: string, body: Body, author: Author, at: string): void {
    this.db.prepare("INSERT INTO revisions (item, body, author, created_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(body), author, at);
    this.db.prepare("DELETE FROM citations WHERE src = ?").run(id);
    const cite = this.db.prepare("INSERT OR IGNORE INTO citations (src, dst) VALUES (?, ?)");
    for (const dst of citationsIn(body.text, this.pool)) if (dst !== id) cite.run(id, dst);
    const kind = kindOf(id)!;
    if (kind === "wake") return;
    const text = [body.title, body.summary, body.text, body.about?.join(" ")].filter(Boolean).join("\n");
    this.db.prepare("DELETE FROM search WHERE id = ?").run(id);
    this.index(id, kind, text);
  }

  private index(id: string, kind: Kind, text: string): void {
    this.db.prepare("INSERT INTO search (id, kind, text) VALUES (?, ?, ?)").run(id, kind, indexText(text));
  }

  /** Stored form: `{user}` becomes a token; existing tokens are kept as they are. */
  private stored(body: Body): Body {
    const s = (t: string | undefined) => (t === undefined ? undefined : toStored(t, this.c.owner));
    citationsIn(body.text, this.pool); // general refuses to cite private
    return { ...body, text: s(body.text)!, title: s(body.title), summary: s(body.summary) };
  }

  /** Merges old segments so deleted text doesn't linger in the index. */
  private optimize(): void {
    this.db.prepare("INSERT INTO search (search) VALUES ('optimize')").run();
  }

  private checkAuthor(author: Author): void {
    const ok = this.c.mode === "owner" ? author === `user:${this.c.owner}` : author === "lyrica" || author === "sleep";
    if (!ok) throw new Error(`${author} can't write through a ${this.c.mode} view`);
  }

  private mustThread(id: string): Thread {
    const thread = this.getThread(id);
    if (!thread) throw new Error(`no such thread: ${id}`);
    return thread;
  }

  private newId(prefix: "n" | "j", table: "notes" | "journal"): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    let id: string;
    do id = `${prefix}:${day}-${randomBytes(4).toString("hex")}`;
    while (this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) || this.db.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(id));
    return id;
  }

  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn)();
  }
}

const originOf = (author: Author): Origin => (author.startsWith("user:") ? "user" : (author as Origin));

function bodyOf(item: Item): Body {
  const body: Body = { text: item.text };
  if (item.kind === "page") Object.assign(body, { title: item.title, summary: item.summary, folders: item.folders });
  if (item.kind === "note") body.about = item.about;
  return body;
}

interface ThreadRow { id: string; interface: Interface; parent: string | null; subagent?: number; title: string | null; hidden: number; unlogged: number; created_at: string }
interface EntryRow { thread: string; n: number; role: string; text: string; unlogged: number; orig: string | null; created_at: string }
interface NoteRow { text: string; about: string; origin: string; author: string; superseded_by: string | null; archived: number; created_at: string; updated_at: string }
interface PageRow { slug: string; title: string; summary: string; text: string; folders: string; origin: string; author: string; archived: number; flagged: number; created_at: string; updated_at: string }
interface RevisionRow { id: number; item: string; body: string; author: string; created_at: string }

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id, interface: r.interface, parent: r.parent ?? undefined, subagent: r.subagent === 1, title: r.title ?? undefined,
    hidden: r.hidden === 1, unlogged: r.unlogged === 1, createdAt: r.created_at,
  };
}

function toEntry(r: EntryRow): StoredEntry {
  return { id: r.orig ?? entryId(r.thread, r.n), role: r.role, text: r.text, unlogged: r.unlogged === 1, createdAt: r.created_at };
}
