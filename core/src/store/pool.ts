import { removeSecrets } from "../secrets.ts";
import { SkillLibrary } from "../skills.ts";
import { randomBytes } from "node:crypto";
import { nextRun, parseSchedule, type Schedule } from "../routines.ts";
import type { ForgeKind, ForgeWatchState } from "../forge/types.ts";
import type { Db } from "../db.ts";
import { render, toStored, type UserId } from "../mentions.ts";
import type { Profile } from "../profile.ts";
import type { Interface, Pool } from "../types.ts";
import { askOfCall, isQuestionCall, type Ask, FROM_PARENT, ROUTINE, WAKEUP, WATCHING, type ThreadStep } from "../threads.ts";
import { citationsIn, ftsQuery, holdsEnough, indexText, kindOf, queryTerms, queryWords, searchWords, snippet, stripCitations, withoutWords, type Kind } from "./refs.ts";

/** Who made a change. Thread views write as `lyrica` or `sleep`; the owner view as `user:<id>`. */
export type Author = "lyrica" | "sleep" | `user:${string}`;
export type Origin = "lyrica" | "sleep" | "user";

export interface Thread {
  id: string;
  interface: Interface;
  parent?: string;
  /** Delegated by its parent: the UI nests it there. */
  subagent: boolean;
  /** Started by Lyrica from its parent with `threads start`: one level deep, never a parent of another. */
  child: boolean;
  /** A project chat: its child threads are the project's threads. */
  project: boolean;
  /** A project's goal, in the user's words. */
  goal?: string;
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

/** An entry as a share carries it between pools. */
export interface ExportedEntry extends NewEntry { createdAt: string }

/** Memory tools, sleep's included: what they read or wrote belongs to the pool, and a copy that leaves it carries none of it. */
export const MEMORY_TOOLS: ReadonlySet<string> = new Set(["remember", "recall", "read_memory", "write_page", "write_journal", "write_wake", "raise", "propose_persona"]);

interface Part { type: string; text?: string; name?: string; toolName?: string }

/**
 * A Pi entry as the conversation alone, for a share (DESIGN.md, "Share
 * with": none of the sender's memory goes): user messages, her text and her
 * other tools' calls and results. Her per-turn context, memory tool calls
 * and results, and thinking are left out, and citations are stripped from
 * her text. `undefined` when nothing of the entry travels.
 */
export function conversationOnly(data: unknown): unknown {
  const entry = data as { type?: string; message?: { role?: string; content?: unknown; toolName?: string } };
  if (entry?.type !== "message" || !entry.message) return undefined;
  const m = entry.message;
  if (m.role === "toolResult") return MEMORY_TOOLS.has(m.toolName ?? "") ? undefined : data;
  if (m.role !== "user" && m.role !== "assistant") return undefined;
  if (typeof m.content === "string") return m.role === "assistant" ? { ...entry, message: { ...m, content: stripCitations(m.content) } } : data;
  if (!Array.isArray(m.content)) return undefined;
  const parts = (m.content as Part[]).flatMap((p) => {
    if (p.type === "thinking" || p.type === "redacted_thinking") return [];
    if (p.type === "toolCall" && MEMORY_TOOLS.has(p.name ?? "")) return [];
    if (p.type === "text" && m.role === "assistant" && typeof p.text === "string") return [{ ...p, text: stripCitations(p.text) }];
    return [p];
  });
  if (!parts.length) return undefined;
  return { ...entry, message: { ...m, content: parts } };
}

export interface StoredEntry {
  /** `e:<thread>#<n>`, or the original entry's ID for an exported copy. */
  id: string;
  role: string;
  text: string;
  unlogged: boolean;
  createdAt: string;
}

/** A thread's note to itself, for `dueAt` (DESIGN.md, Projects). */
export interface Wakeup { id: number; thread: string; dueAt: string; note: string; setAt: string }

export interface Routine { id: number; thread: string; schedule: Schedule; note: string; newThread: boolean; paused: boolean; nextAt: string; lastAt?: string; createdAt: string }

/** A pull request a thread opened through its relay, polled until CI and reviews land (docs/briefs/ci-wakes.md). */
export interface Watch {
  id: number;
  thread: string;
  repo: string;
  kind: ForgeKind;
  host: string;
  account: string;
  number: number;
  head: string | null;
  headSince: string;
  notifiedHeads: string[];
  seenReviews: string[];
  /** When the repository last got a signed webhook; the poller then eases to ten minutes. */
  webhookAt?: string;
  createdAt: string;
}

/** One emoji on a message and who put it there: user IDs, or "lyrica". */
export interface Reaction { emoji: string; by: string[] }
export const LYRICA_REACTS = "lyrica";
/** One emoji: pictographs, flags or keycaps, joined with ZWJ, variation selectors and skin tones; up to 32 code units. */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)(?:[\u200D\uFE0F]|\p{Emoji_Modifier}|\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)*$/u;
export const isEmoji = (s: string): boolean => s.length > 0 && s.length <= 32 && EMOJI.test(s);

/** A pinned entry, with where it is. */
export interface PinnedEntry extends StoredEntry {
  thread: string;
  n: number;
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
  /** A page's instructions, kept apart from its text. Only the user changes them. */
  instructions?: string;
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

/** Who wrote an entry: the user or her. Tool results have no speaker. */
const ENTRY_ORIGIN: Record<string, Origin | undefined> = { user: "user", assistant: "lyrica" };

export interface Hit {
  id: string;
  kind: Kind;
  snippet: string;
  /** Higher is better (negated BM25). */
  score: number;
  origin?: Origin;
  author?: string;
  supersededBy?: string;
  /** When it was said (an entry) or last changed (a memory). */
  at?: string;
}

/** A message `searchMessages` found, where it is now, with its stored text (never logged). */
export interface MessageHit {
  thread: string;
  n: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface SearchOptions {
  kinds?: Kind[];
  limit?: number;
  /** Leave out superseded notes (automatic recall does). */
  current?: boolean;
  /** Leave out entries of this thread (already in context). */
  excludeThread?: string;
  /** With `excludeThread`: keep its entries numbered below this, which a compaction took out of context. */
  keepBefore?: number;
  /** The thread searching. In a project, what belongs to it (notes citing its threads, its page, its threads' entries) ranks higher. */
  fromThread?: string;
  /** Keep only project items (fromThread) or notes with this whole about tag. Empty project membership matches nothing. */
  only?: { project?: boolean; about?: string };
  includeArchived?: boolean;
  /** Words left out of the query: automatic recall leaves out her name, which nearly everything mentions. */
  skip?: string[];
  /** A hit holds at least this many of the query's words, when the query has more than this many. */
  minWords?: number;
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

export type SleepStatus = "running" | "complete" | "partial" | "skipped";
export type SkipReason = "no-key" | "endpoint-down" | "no-activity";
export type SleepPhase = "consolidate" | "dream" | "wake";
/** The limit a sleep phase stopped at. */
export type SleepLimit = "turns" | "tokens" | "time";

export interface SleepRunRecord {
  id: string;
  reason: "scheduled" | "manual";
  status: SleepStatus;
  skipReason?: SkipReason;
  /** Entries written before this are what the run covers. */
  until: string;
  /** Each phase's thread, whether it finished, and the limit it stopped at, if one. */
  phases: Partial<Record<SleepPhase, { thread: string; done: boolean; limit?: SleepLimit }>>;
  startedAt: string;
  finishedAt?: string;
}

/** Something she'd like to raise after a night. Never in any thread's context but the one started from it. */
export interface SleepItem {
  id: string;
  run: string;
  kind: "thought" | "question" | "persona";
  text: string;
  /** What it came from: a journal entry, a page, a note, or `proposal:<id>`. */
  source?: string;
  /** The chat started from it. */
  thread?: string;
  dismissed: boolean;
  createdAt: string;
}

/** What a sleep run has to work with: everything after the watermark and before the run started. */
export interface SleepMaterial {
  /** Logged threads with new entries (not sleep's own threads, not exported copies), which of them the user pinned, and the project chat of a project's thread. */
  threads: { id: string; title?: string; entries: number; first: string; last: string; pinned?: string[]; project?: string }[];
  /** Notes written in conversation or by a user. */
  notes: Item[];
  /** Memories a user changed or added. */
  edited: Edited[];
  /** Pages that cited something since deleted. */
  flagged: string[];
}

export interface Question { n: number; asked: string; closed?: string; answer?: number | "words" | "withdrawn" }

export interface StoreContext {
  questionChange?: <T>(db: Db, thread: string, fn: () => T) => T;
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
const GOAL_LIMIT = 2000;
/** Well under the project section's budget, so the notes and threads after them always fit. */
const INSTRUCTIONS_LIMIT = 2000;
/** How much more a project's own memories weigh in recall from inside that project. A boost, never a filter. */
export const PROJECT_BOOST = 1.5;
/** The most candidates a filtered (`only`) search scans per query. */
const ONLY_SCAN = 2000;

/** The slug of a project's page: thread IDs hold '/', which slugs don't. */
export const projectSlug = (projectId: string) => `project-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** Read access to one pool database. A private thread view holds general memory only through this. */
export class PoolReader {
  constructor(protected readonly c: StoreContext) {}

  get pool(): Pool { return this.c.pool; }
  /** The user whose pool this is. */
  get owner(): UserId { return this.c.owner; }
  protected get db(): Db { return this.c.db; }
  close(): void { this.db.close(); }
  /** This pool's skills (docs/briefs/skills.md). A reader's connection is read-only, so only its reads work. */
  get skills(): SkillLibrary { return new SkillLibrary(this.db, this.pool); }

  protected render(text: string): string {
    const profiles = this.c.profiles();
    return render(text, (id) => profiles.get(id));
  }

  /**
   * Stored text as it leaves the install (an export): the owner's tokens go
   * back to `{user}`, so an import writes them as the importing user's; anyone
   * else's become their current name.
   */
  portable(text: string): string {
    return this.render(text.replace(/\[\[u:([A-Za-z0-9-]+)(?::([a-z-]+))?\]\]/g, (token, id: string, form?: string) =>
      (id === this.c.owner ? `{user${form ? `:${form}` : ""}}` : token)));
  }

  // Threads and entries

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row && toThread(row);
  }

  /** The project chat a thread belongs to: itself if it is one, or its parent if it is a project's thread. */
  projectOf(threadId: string): string | undefined {
    const thread = this.getThread(threadId);
    if (!thread) return undefined;
    if (thread.project) return thread.id;
    if (thread.child && thread.parent && this.getThread(thread.parent)?.project) return thread.parent;
    return undefined;
  }

  /** A project chat and its threads (not their subagents). Empty if the thread is in no project. */
  projectThreads(threadId: string): string[] {
    const project = this.projectOf(threadId);
    if (!project) return [];
    const children = this.db.prepare("SELECT id FROM threads WHERE parent = ? AND child = 1 ORDER BY created_at").all(project) as { id: string }[];
    return [project, ...children.map((r) => r.id)];
  }

  /** The page of the project a thread belongs to, `p:project-<id>`, if there is one yet. */
  pageForProject(threadId: string): Item | undefined {
    const project = this.projectOf(threadId);
    return project ? this.get(`p:${projectSlug(project)}`) : undefined;
  }

  /**
   * Current notes that cite the project chat or one of its threads, oldest
   * first, written at or after `since`. Found by citation: a project's notes
   * are never stored apart.
   */
  projectNotes(threadId: string, since?: string): Item[] {
    const threads = this.projectThreads(threadId);
    if (!threads.length) return [];
    const rows = this.db.prepare(`SELECT n.id FROM notes n WHERE n.superseded_by IS NULL AND n.archived = 0 AND n.created_at >= @since
      AND EXISTS (SELECT 1 FROM citations c, json_each(@threads) t WHERE c.src = n.id AND (c.dst = 't:' || t.value OR c.dst LIKE 'e:' || t.value || '#%'))
      ORDER BY n.created_at, n.rowid`).all({ threads: JSON.stringify(threads), since: since ?? "" }) as { id: string }[];
    return rows.map((r) => this.get(r.id)!);
  }

  /** With `parent`, only that thread's subagents, or with `children` its other daughters (child threads, branches, copies). */
  listThreads(opts: { includeHidden?: boolean; parent?: string; children?: boolean } = {}): Thread[] {
    const where = [opts.includeHidden ? "" : "hidden = 0", opts.parent === undefined ? "" : `parent = @parent AND subagent = ${opts.children ? 0 : 1}`].filter(Boolean);
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
  entryPage(threadId: string, opts: { before?: number; limit: number }): { entries: { n: number; data: unknown; createdAt: string; pinned: boolean; reactions: Reaction[] }[]; hasMore: boolean } {
    const rows = this.db.prepare("SELECT n, data, created_at, pinned, reactions FROM entries WHERE thread = ? AND n < ? ORDER BY n DESC LIMIT ?")
      .all(threadId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1) as { n: number; data: string; created_at: string; pinned: number; reactions: string | null }[];
    const hasMore = rows.length > opts.limit;
    return { entries: rows.slice(0, opts.limit).reverse().map((r) => ({ n: r.n, data: json(r.data), createdAt: r.created_at, pinned: r.pinned === 1, reactions: parseReactions(r.reactions) })), hasMore };
  }

  /**
   * Where the turn now running began: the entry after the last one an earlier turn ended with (her reply or a
   * tool result) before the newest stored user message. A sent message is stored before the model runs, so the
   * turn's first entries may already be here; with none stored yet, it is the next entry.
   */
  turnStartN(threadId: string): number {
    const row = this.db.prepare(`SELECT
        (SELECT max(n) FROM entries WHERE thread = @id AND role = 'user') AS user,
        (SELECT max(n) FROM entries WHERE thread = @id AND role IN ('assistant', 'toolResult')) AS reply`)
      .get({ id: threadId }) as { user: number | null; reply: number | null };
    if (row.user === null || (row.reply !== null && row.reply > row.user)) return this.nextEntryN(threadId);
    const before = this.db.prepare("SELECT max(n) AS n FROM entries WHERE thread = ? AND role IN ('assistant', 'toolResult') AND n < ?")
      .get(threadId, row.user) as { n: number | null };
    const cut = (this.db.prepare("SELECT cut FROM threads WHERE id = ?").get(threadId) as { cut: number | null } | undefined)?.cut ?? 0;
    return Math.max(before.n ?? 0, cut) + 1;
  }

  /** The number the thread's next entry will get: past every entry, and past what a rewind removed. */
  nextEntryN(threadId: string): number {
    const row = this.db.prepare("SELECT max(coalesce((SELECT max(n) FROM entries WHERE thread = @id), 0), cut) + 1 AS n FROM threads WHERE id = @id")
      .get({ id: threadId }) as { n: number } | undefined;
    if (!row) throw new Error(`no such thread: ${threadId}`);
    return row.n;
  }

  /** Pi entry IDs already stored for the thread. */
  storedPiIds(threadId: string): Set<string> {
    return new Set((this.db.prepare("SELECT pi_id FROM entries WHERE thread = ?").all(threadId) as { pi_id: string }[]).map((r) => r.pi_id));
  }

  /** The number a thread's entry was stored under, by its Pi entry ID. */
  entryNumber(threadId: string, piId: string): number | undefined {
    return (this.db.prepare("SELECT n FROM entries WHERE thread = ? AND pi_id = ?").get(threadId, piId) as { n: number } | undefined)?.n;
  }

  /** The ID an entry goes by: its own, or the original's for a copy. */
  entryId(threadId: string, n: number): string | undefined {
    const row = this.db.prepare("SELECT coalesce(orig, 'e:' || thread || '#' || n) AS id FROM entries WHERE thread = ? AND n = ?").get(threadId, n) as { id: string } | undefined;
    return row?.id;
  }

  /** The user's unsent composer text for a thread, if any. */
  draft(threadId: string): { text: string; updatedAt: string } | undefined {
    const row = this.db.prepare("SELECT text, updated_at FROM drafts WHERE thread = ?").get(threadId) as { text: string; updated_at: string } | undefined;
    return row && { text: row.text, updatedAt: row.updated_at };
  }

  /** How many of the thread's entries have this role, such as `compaction`. */
  countEntries(threadId: string, role: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM entries WHERE thread = ? AND role = ?").get(threadId, role) as { n: number }).n;
  }

  /** The newest entry of the thread with one of the roles, or of any role. */
  lastEntry(threadId: string, roles?: string[]): StoredEntry | undefined {
    const filter = roles ? `AND role IN (${roles.map(() => "?").join(",")})` : "";
    const row = this.db.prepare(`SELECT * FROM entries WHERE thread = ? ${filter} ORDER BY n DESC LIMIT 1`)
      .get(threadId, ...(roles ?? [])) as EntryRow | undefined;
    return row && toEntry(row);
  }

  questions(thread: string): Question[] {
    return (this.db.prepare("SELECT n, asked, closed, answer FROM questions WHERE thread = ? ORDER BY n").all(thread) as { n: number; asked: string; closed: string | null; answer: string | null }[])
      .map(r => ({ n: r.n, asked: r.asked, ...(r.closed ? { closed: r.closed, answer: /^\d+$/.test(r.answer ?? "") ? Number(r.answer) : r.answer as "words" | "withdrawn" } : {}) }));
  }
  openQuestion(thread: string): Question | undefined {
    return this.db.prepare("SELECT n, asked FROM questions WHERE thread = ? AND closed IS NULL").get(thread) as Question | undefined;
  }
  /** Read question words only through this thread's existing encrypted reader. */
  readAsk(thread: string, n: number): Ask | undefined {
    const entry = this.entryPage(thread, { before: n + 1, limit: 1 }).entries.find(e => e.n === n);
    const parts = (entry?.data as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (!Array.isArray(parts)) return undefined;
    const call = parts.find(p => p.type === "toolCall" && isQuestionCall(p.name, p.arguments));
    return call ? askOfCall(call.name, call.arguments) : undefined;
  }
  questionCall(thread: string, id: string): number | undefined {
    const rows = this.db.prepare("SELECT n, data FROM entries WHERE thread = ? AND role = 'assistant' ORDER BY n DESC").all(thread) as { n: number; data: string }[];
    return rows.find(r => {
      const parts = (json(r.data) as { message?: { content?: unknown } }).message?.content;
      return Array.isArray(parts) && parts.some(p => p.type === "toolCall" && p.id === id && isQuestionCall(p.name, p.arguments));
    })?.n;
  }

  /** A thread's checklist (`threads steps`); empty when it has none. */
  steps(threadId: string): ThreadStep[] {
    const row = this.db.prepare("SELECT steps FROM thread_steps WHERE thread = ?").get(threadId) as { steps: string } | undefined;
    return row ? JSON.parse(row.steps) as ThreadStep[] : [];
  }

  /** The latest code task, encrypted with the thread's pool. */
  codeTask(threadId: string): { task: string; done: string; at: string } | undefined {
    return this.db.prepare("SELECT task, done, at FROM code_tasks WHERE thread = ?").get(threadId) as { task: string; done: string; at: string } | undefined;
  }

  /** A thread's wake-ups not yet fired, soonest first; or every thread's. */
  wakeups(threadId?: string): Wakeup[] {
    const rows = this.db.prepare(`SELECT * FROM wakeups WHERE fired_at IS NULL ${threadId ? "AND thread = ?" : ""} ORDER BY due_at, id`)
      .all(...(threadId ? [threadId] : [])) as { id: number; thread: string; due_at: string; note: string; set_at: string }[];
    return rows.map((r) => ({ id: r.id, thread: r.thread, dueAt: r.due_at, note: r.note, setAt: r.set_at }));
  }

  /** Recurring turns belonging to this pool, including paused ones. */
  routines(threadId?: string): Routine[] {
    const rows = this.db.prepare(`SELECT * FROM routines ${threadId ? "WHERE thread = ?" : ""} ORDER BY next_at, id`).all(...(threadId ? [threadId] : [])) as {
      id: number; thread: string; schedule: string; note: string; new_thread: number; paused: number; next_at: string; last_at: string | null; created_at: string;
    }[];
    return rows.map(r => ({ id: r.id, thread: r.thread, schedule: parseSchedule(JSON.parse(r.schedule)), note: r.note, newThread: !!r.new_thread, paused: !!r.paused, nextAt: r.next_at, lastAt: r.last_at ?? undefined, createdAt: r.created_at }));
  }

  /** When a thread's wake-ups or routines fired since `since`, oldest first. */
  wakeupsFired(threadId: string, since: string): string[] {
    return (this.db.prepare("SELECT fired_at FROM wakeups WHERE thread = ? AND fired_at >= ? ORDER BY fired_at").all(threadId, since) as { fired_at: string }[]).map((r) => r.fired_at);
  }

  /** A thread's watched pull requests, oldest first; or every thread's. */
  watches(threadId?: string): Watch[] {
    const rows = this.db.prepare(`SELECT * FROM watches ${threadId ? "WHERE thread = ?" : ""} ORDER BY created_at, id`)
      .all(...(threadId ? [threadId] : [])) as WatchRow[];
    return rows.map(toWatch);
  }

  /** A thread's latest `limit` messages as another thread reads them: logged ones with text, no tool results; oldest first. */
  latestEntries(threadId: string, limit: number): StoredEntry[] {
    const rows = this.db.prepare("SELECT * FROM entries WHERE thread = ? AND unlogged = 0 AND role != 'toolResult' AND trim(text) != '' ORDER BY n DESC LIMIT ?")
      .all(threadId, limit) as EntryRow[];
    return rows.reverse().map(toEntry);
  }

  /** When the user last spoke in this pool, in any thread. */
  lastUserMessage(): Date | undefined {
    const row = this.db.prepare("SELECT max(created_at) AS at FROM entries WHERE role = 'user' AND unlogged = 0 AND text != '' AND text NOT LIKE '[Watching threads]%' AND text NOT LIKE '[Wake-up, set %' AND text NOT LIKE '[Routine, %'").get() as { at: string | null };
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
    const rows = this.db.prepare(`SELECT * FROM entries WHERE thread = ? AND n BETWEEN ? AND ? ${own ? "" : "AND unlogged = 0"} ORDER BY n`)
      .all(thread, Number(n) - radius, Number(n) + radius) as EntryRow[];
    if (rows.some((r) => r.n === Number(n))) return rows.map(toEntry);
    // Rewound away from its thread, but a branch still holds a copy: read it there, leaving out
    // what the branch wrote unlogged (it may have been made unlogged after the copy).
    const copy = this.db.prepare("SELECT thread, n FROM entries WHERE orig = ? AND unlogged = 0 ORDER BY rowid LIMIT 1").get(id) as { thread: string; n: number } | undefined;
    return copy ? this.entryWindow(entryId(copy.thread, copy.n), radius) : rows.map(toEntry);
  }

  // Memories

  /** A note, page, journal entry or WAKE, with mentions rendered (or raw, for an editor). */
  get(id: string, opts: { raw?: boolean } = {}): Item | undefined {
    const item = this.load(id);
    if (!item || opts.raw) return item;
    return { ...item, text: this.render(item.text), title: item.title && this.render(item.title), summary: item.summary && this.render(item.summary), ...(item.instructions ? { instructions: this.render(item.instructions) } : {}) };
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
          id, kind: "page", text: r.text, title: r.title, summary: r.summary, folders: json(r.folders), ...(r.instructions ? { instructions: r.instructions } : {}), origin: r.origin as Origin,
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
      case "entry": {
        // A logged message read as a memory of its own: what recall found before sleep consolidated it. Never one written unlogged.
        const [e] = this.entryWindow(id, 0);
        return e && !e.unlogged ? { id, kind: "entry", text: e.text, origin: e.role === "user" ? "user" : "lyrica", createdAt: e.createdAt, updatedAt: e.createdAt } : undefined;
      }
      default:
        return undefined;
    }
  }

  getWake(): string | undefined {
    const text = this.load("wake")?.text;
    return text === undefined ? undefined : this.render(text);
  }

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

  /**
   * Logged messages sleep hasn't consolidated yet (written after its watermark), newest first: the
   * memory browser's Recent layer. `before` is a `createdAt` to page from. Only what a person or she
   * said, never a tool's result or one of her looks at other threads.
   */
  recentEntries(opts: { limit: number; before?: string }): Item[] {
    const limit = Math.max(1, opts.limit);
    const stmt = this.db.prepare(`SELECT thread, n, text, created_at FROM entries WHERE unlogged = 0 AND role IN ('user', 'assistant') AND text != ''
      AND created_at > @since AND (@before IS NULL OR created_at < @before) ORDER BY created_at DESC, n DESC LIMIT @limit`);
    const since = this.watermark() ?? "";
    let before = opts.before ?? null;
    const out: Item[] = [];
    // A message from another thread (a parent's or sibling's), a watch, a wake-up or a routine is hers or the daemon's, not a person's: left out.
    const marked = [FROM_PARENT, WATCHING, WAKEUP, ROUTINE];
    for (;;) {
      const batch = limit * 2;
      const rows = stmt.all({ since, before, limit: batch }) as { thread: string; n: number; text: string; created_at: string }[];
      for (const r of rows) {
        if (marked.some((m) => m.test(r.text))) continue;
        const item = this.get(entryId(r.thread, r.n));
        if (item) out.push(item);
        if (out.length === limit) return out;
      }
      if (rows.length < batch) return out;
      before = rows[rows.length - 1]!.created_at;
    }
  }

  listJournal(limit = 20): Item[] {
    return (this.db.prepare("SELECT id FROM journal ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string }[])
      .map((r) => this.get(r.id)!);
  }

  /**
   * One layer, newest change first, for the memory browser's browse pane.
   * `before` is an `updatedAt` to page from; `about` keeps notes with that
   * tag and `origin` those of one origin. Archived memories are left out.
   */
  listMemories(kind: "note" | "page" | "journal" | "wake", opts: { limit: number; before?: string; about?: string; origin?: Origin }): Item[] {
    const limit = Math.max(1, opts.limit);
    const before = opts.before ?? null;
    let rows: { id: string }[];
    switch (kind) {
      case "note":
        rows = this.db.prepare(`SELECT id FROM notes WHERE archived = 0 AND (@before IS NULL OR updated_at < @before)
          AND (@origin IS NULL OR origin = @origin) AND (@about IS NULL OR (', ' || about || ', ') LIKE ('%, ' || @about || ', %') ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT @limit`).all({ before, origin: opts.origin ?? null, about: opts.about?.replace(/[\\%_]/g, "\\$&") ?? null, limit }) as { id: string }[];
        break;
      case "page":
        rows = this.db.prepare(`SELECT 'p:' || slug AS id FROM pages WHERE archived = 0 AND (@before IS NULL OR updated_at < @before)
          AND (@origin IS NULL OR origin = @origin) ORDER BY updated_at DESC LIMIT @limit`).all({ before, origin: opts.origin ?? null, limit }) as { id: string }[];
        break;
      case "journal":
        rows = opts.origin && opts.origin !== "sleep" ? [] : this.db.prepare("SELECT id FROM journal WHERE (@before IS NULL OR updated_at < @before) ORDER BY updated_at DESC LIMIT @limit")
          .all({ before, limit }) as { id: string }[];
        break;
      case "wake":
        rows = opts.origin && opts.origin !== "sleep" ? [] : this.db.prepare("SELECT 'wake' AS id FROM wake WHERE (@before IS NULL OR updated_at < @before)").all({ before }) as { id: string }[];
        break;
    }
    return rows.map((r) => this.get(r.id)!).filter(Boolean);
  }

  /** The tags (`about` words) of the pool's notes, most used first. */
  aboutWords(): { about: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.db.prepare("SELECT about FROM notes WHERE archived = 0 AND about != ''").all() as { about: string }[]) {
      for (const a of r.about.split(", ")) if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return [...counts].map(([about, count]) => ({ about, count })).sort((a, b) => b.count - a.count || a.about.localeCompare(b.about));
  }

  /** How many pages and notes she uses (archived ones left out). */
  counts(): { pages: number; notes: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { pages: n("SELECT count(*) AS n FROM pages WHERE archived = 0"), notes: n("SELECT count(*) AS n FROM notes WHERE archived = 0") };
  }

  /** Notes and pages a user added. */
  userIntroduced(): string[] {
    return (this.db.prepare(
      "SELECT id, updated_at FROM notes WHERE origin = 'user' UNION ALL SELECT 'p:' || slug, updated_at FROM pages WHERE origin = 'user' ORDER BY 2 DESC",
    ).all() as { id: string }[]).map((r) => r.id);
  }

  // Sleep

  /** Entries before this time have been slept: the latest run whose consolidate finished. */
  watermark(): string | undefined {
    const rows = this.db.prepare("SELECT until, phases FROM sleep_runs WHERE status != 'skipped' ORDER BY until DESC").all() as { until: string; phases: string }[];
    return rows.find((r) => json<SleepRunRecord["phases"]>(r.phases).consolidate?.done)?.until;
  }

  listSleepRuns(limit = 30): SleepRunRecord[] {
    return (this.db.prepare("SELECT * FROM sleep_runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(limit) as SleepRunRow[]).map(toRun);
  }

  /** Metadata search and paging, without loading a run's memory text. */
  sleepRunHistory({ limit, offset, q }: { limit: number; offset: number; q: string }) {
    const where = q ? "instr(lower(id || ' ' || started_at || ' ' || status || ' ' || coalesce(skip_reason, '') || ' ' || reason), lower(@q)) > 0" : "@q = ''";
    const total = (this.db.prepare(`SELECT count(*) AS n FROM sleep_runs WHERE ${where}`).get({ q }) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM sleep_runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT @limit OFFSET @offset`).all({ q, limit, offset }) as SleepRunRow[];
    return { total, entries: rows.map(toRun) };
  }

  getSleepRun(id: string): SleepRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sleep_runs WHERE id = ?").get(id) as SleepRunRow | undefined;
    return row && toRun(row);
  }

  /** Everything after `since` and before `until` that sleep should look at. */
  sleepMaterial(since: string | undefined, until: string): SleepMaterial {
    const from = since ?? "";
    const threads = (this.db.prepare(`SELECT e.thread AS id, t.title, count(*) AS entries, min(e.n) AS first, max(e.n) AS last
      FROM entries e JOIN threads t ON t.id = e.thread
      WHERE e.unlogged = 0 AND e.orig IS NULL AND t.interface != 'sleep' AND e.text != '' AND e.created_at >= ? AND e.created_at < ?
      GROUP BY e.thread ORDER BY min(e.created_at)`).all(from, until) as { id: string; title: string | null; entries: number; first: number; last: number }[])
      .map((r) => {
        const pinned = (this.db.prepare("SELECT n FROM entries WHERE thread = ? AND pinned = 1 AND unlogged = 0 AND n BETWEEN ? AND ? ORDER BY n")
          .all(r.id, r.first, r.last) as { n: number }[]).map((p) => entryId(r.id, p.n));
        // An unlogged project gets no page, so its logged threads are consolidated as ordinary threads.
        const chat = this.projectOf(r.id);
        const project = chat && !this.getThread(chat)!.unlogged ? chat : undefined;
        return {
          id: r.id, ...(r.title ? { title: r.title } : {}), entries: r.entries, first: entryId(r.id, r.first), last: entryId(r.id, r.last),
          ...(pinned.length ? { pinned } : {}), ...(project ? { project } : {}),
        };
      });
    const notes = (this.db.prepare("SELECT id FROM notes WHERE origin != 'sleep' AND archived = 0 AND created_at >= ? AND created_at < ? ORDER BY created_at")
      .all(from, until) as { id: string }[]).map((r) => this.get(r.id)!);
    const edited = this.editedSince(from).filter((e) => e.at < until);
    const flagged = (this.db.prepare("SELECT slug FROM pages WHERE flagged = 1 AND archived = 0").all() as { slug: string }[]).map((r) => `p:${r.slug}`);
    return { threads, notes, edited, flagged };
  }

  /** What sleep wrote between two times, newest version of each: notes, pages (with the version before), journal, WAKE. */
  sleepChanges(from: string, to: string): { notes: string[]; pages: { id: string; before?: Body; after: Body }[]; journal: string[]; wake?: string } {
    const revs = this.db.prepare("SELECT * FROM revisions WHERE author = 'sleep' AND created_at >= ? AND created_at <= ? ORDER BY id")
      .all(from, to) as RevisionRow[];
    const latest = new Map<string, RevisionRow>();
    for (const r of revs) latest.set(r.item, r);
    const firstId = new Map<string, number>();
    for (const r of revs) if (!firstId.has(r.item)) firstId.set(r.item, r.id);
    const ids = [...latest.keys()];
    const pages = ids.filter((id) => kindOf(id) === "page").map((id) => {
      const before = this.db.prepare("SELECT body FROM revisions WHERE item = ? AND id < ? ORDER BY id DESC LIMIT 1").get(id, firstId.get(id)) as { body: string } | undefined;
      return { id, ...(before ? { before: json<Body>(before.body) } : {}), after: json<Body>(latest.get(id)!.body) };
    });
    const created = (id: string) => !this.db.prepare("SELECT 1 FROM revisions WHERE item = ? AND id < ?").get(id, firstId.get(id));
    const wake = latest.get("wake");
    return {
      notes: ids.filter((id) => kindOf(id) === "note" && created(id)),
      pages,
      journal: ids.filter((id) => kindOf(id) === "journal"),
      ...(wake ? { wake: json<Body>(wake.body).text } : {}),
    };
  }

  /** Items from sleep, newest first. Dismissed ones are left out unless asked for. */
  listItems(opts: { run?: string; includeDismissed?: boolean } = {}): SleepItem[] {
    const where = [opts.includeDismissed ? "" : "dismissed = 0", opts.run ? "run = @run" : ""].filter(Boolean);
    return (this.db.prepare(`SELECT * FROM sleep_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`)
      .all(opts.run ? { run: opts.run } : {}) as ItemRow[]).map((r) => this.shownItem(r));
  }

  getItem(id: string): SleepItem | undefined {
    const row = this.db.prepare("SELECT * FROM sleep_items WHERE id = ?").get(id) as ItemRow | undefined;
    return row && this.shownItem(row);
  }

  /** The item a thread was started from: the only way an item reaches a conversation. */
  itemForThread(threadId: string): SleepItem | undefined {
    const row = this.db.prepare("SELECT * FROM sleep_items WHERE thread = ?").get(threadId) as ItemRow | undefined;
    return row && this.shownItem(row);
  }

  /** An item with its mentions rendered as names. */
  private shownItem(row: ItemRow): SleepItem {
    const item = toItem(row);
    return { ...item, text: this.render(item.text) };
  }

  // Search

  search(query: string, opts: SearchOptions = {}): Hit[] {
    if (opts.skip?.length) query = withoutWords(query, opts.skip);
    const fts = ftsQuery(query, this.c.profiles());
    if (!fts) return [];
    const limit = opts.limit ?? 8;
    if (limit <= 0) return [];
    const threads = opts.fromThread ? this.projectThreads(opts.fromThread) : [];
    type Row = { id: string; kind: Kind; rank: number };
    const queryRows = this.db.prepare("SELECT id, kind, bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT ? OFFSET ?");
    const tagged = opts.only?.about === undefined ? undefined : this.db.prepare(`SELECT id FROM notes
      WHERE (', ' || about || ', ') LIKE ('%, ' || ? || ', %') ESCAPE '\\'`);
    const about = opts.only?.about?.replace(/[\\%_]/g, "\\$&");
    const working = new Set(tagged?.all(about).map(r => (r as { id: string }).id));
    const rows: Row[] = [];
    // Filter before the candidate cut: unrelated high-ranked hits cannot crowd out eligible ones.
    // Batches double, so a deep hit costs about log n queries, and the scan stops at ONLY_SCAN candidates.
    const batch = limit * 4;
    for (let offset = 0, size = batch; ; ) {
      const candidates = queryRows.all(fts, size, offset) as Row[];
      const project = opts.only?.project && threads.length ? this.inProject(candidates.map(r => r.id), threads) : undefined;
      rows.push(...candidates.filter(r => !opts.only || project?.has(r.id) || (r.kind === "note" && working.has(r.id))));
      offset += candidates.length;
      if (rows.length >= batch || candidates.length < size || !opts.only || offset >= ONLY_SCAN) break;
      size = Math.min(size * 2, ONLY_SCAN - offset);
    }
    rows.length = Math.min(rows.length, batch);
    const words = queryWords(query);
    const terms = opts.minWords ? queryTerms(query, this.c.profiles()) : [];
    const ours = threads.length ? this.inProject(rows.map((r) => r.id), threads) : undefined;
    const hits: Hit[] = [];
    for (const row of rows) {
      if (opts.kinds && !opts.kinds.includes(row.kind)) continue;
      const hit = this.hit(row.id, row.kind, words, terms, -row.rank * (ours?.has(row.id) ? PROJECT_BOOST : 1), opts);
      if (hit) hits.push(hit);
      if (!ours && hits.length >= limit) break;
    }
    return ours ? hits.sort((a, b) => b.score - a.score).slice(0, limit) : hits;
  }

  /**
   * The user's messages and her replies holding every word of `query` (each
   * as a word or the start of one), newest first, from the search index:
   * at most `limit`, written before `before`, in `threads` when given. Only
   * logged entries are indexed, so nothing written unlogged is found. An
   * entry a rewind removed while a branch still holds its copy is found at
   * the copy, as `entryWindow` reads it.
   */
  searchMessages(query: string, opts: { limit: number; before?: string; threads?: string[] }): MessageHit[] {
    const words = searchWords(query);
    if (!words.length) return [];
    const ids = (this.db.prepare("SELECT id FROM search WHERE search MATCH ? AND kind = 'entry'")
      .all(words.map((w) => `"${w}"*`).join(" ")) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];
    const at = { thread: "substr(i.value, 3, instr(i.value, '#') - 3)", n: "CAST(substr(i.value, instr(i.value, '#') + 1) AS INTEGER)" };
    const where = `e.role IN ('user', 'assistant') AND e.unlogged = 0 ${opts.before ? "AND e.created_at < @before" : ""}
      ${opts.threads ? "AND e.thread IN (SELECT value FROM json_each(@threads))" : ""}`;
    const filters = { ...(opts.before ? { before: opts.before } : {}), ...(opts.threads ? { threads: JSON.stringify(opts.threads) } : {}) };
    const list = JSON.stringify(ids);
    const cols = "e.thread, e.n, e.role, e.text, e.created_at";
    type Row = { thread: string; n: number; role: "user" | "assistant"; text: string; created_at: string };
    const rows = this.db.prepare(`SELECT ${cols} FROM json_each(@ids) i JOIN entries e ON e.thread = ${at.thread} AND e.n = ${at.n}
      WHERE ${where} ORDER BY e.created_at DESC, e.thread, e.n DESC LIMIT @limit`).all({ ...filters, ids: list, limit: opts.limit }) as Row[];
    // Rewound away from its thread, but a branch still holds a copy: found there (rare, so one lookup each).
    const gone = this.db.prepare(`SELECT i.value AS id FROM json_each(@ids) i WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.thread = ${at.thread} AND e.n = ${at.n})`)
      .all({ ids: list }) as { id: string }[];
    if (gone.length) {
      const copy = this.db.prepare(`SELECT ${cols} FROM entries e WHERE e.orig = @id AND ${where} ORDER BY e.rowid LIMIT 1`);
      for (const { id } of gone) {
        const row = copy.get({ ...filters, id }) as Row | undefined;
        if (row) rows.push(row);
      }
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.thread.localeCompare(b.thread) || b.n - a.n);
    }
    return rows.slice(0, opts.limit).map((r) => ({ thread: r.thread, n: r.n, role: r.role, text: r.text, createdAt: r.created_at }));
  }

  /** Which of `ids` belong to the project made of `threads`: its page, its threads' entries, and memories citing them. */
  private inProject(ids: string[], threads: string[]): Set<string> {
    const page = `p:${projectSlug(threads[0]!)}`;
    const ours = new Set(ids.filter((id) => id === page || threads.some((t) => id.startsWith(`e:${t}#`))));
    const citing = this.db.prepare(`SELECT DISTINCT c.src FROM citations c, json_each(@ids) i, json_each(@threads) t
      WHERE c.src = i.value AND (c.dst = 't:' || t.value OR c.dst LIKE 'e:' || t.value || '#%')`)
      .all({ ids: JSON.stringify(ids), threads: JSON.stringify(threads) }) as { src: string }[];
    for (const r of citing) ours.add(r.src);
    return ours;
  }

  private hit(id: string, kind: Kind, words: string[], terms: string[][], score: number, opts: SearchOptions): Hit | undefined {
    if (kind === "entry") {
      if (opts.excludeThread && id.startsWith(`e:${opts.excludeThread}#`) && !(Number(id.slice(opts.excludeThread.length + 3)) < (opts.keepBefore ?? 0))) return undefined;
      // Indexed before sleep's threads weren't.
      if (id.startsWith("e:sleep/")) return undefined;
      const [entry] = this.entryWindow(id, 0);
      if (!entry || !holdsEnough(entry.text, terms, opts.minWords)) return undefined;
      return { id, kind, score, snippet: snippet(entry.text, words), origin: ENTRY_ORIGIN[entry.role], at: entry.createdAt };
    }
    const item = this.get(id);
    if (!item || (item.archived && !opts.includeArchived) || (item.supersededBy && opts.current)) return undefined;
    const text = item.kind === "page" ? `${item.title}: ${item.summary}\n${item.text}` : item.text;
    if (!holdsEnough(text, terms, opts.minWords)) return undefined;
    return { id, kind, score, snippet: snippet(text, words), origin: item.origin, author: item.author, supersededBy: item.supersededBy, at: item.updatedAt };
  }

  // Lineage

  /** Journal entries as a history, newest update first; versions use revisionHistory. */
  journalHistory({ limit, offset, q }: { limit: number; offset: number; q: string }) {
    const where = q ? "instr(lower(text || ' ' || updated_at), lower(@q)) > 0" : "@q = ''";
    const total = (this.db.prepare(`SELECT count(*) AS n FROM journal WHERE ${where}`).get({ q }) as { n: number }).n;
    const rows = this.db.prepare(`SELECT id FROM journal WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT @limit OFFSET @offset`).all({ q, limit, offset }) as { id: string }[];
    return { total, entries: rows.map((r) => this.get(r.id)!) };
  }

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

  /** Versions newest first; search literal text, title, summary, author and date. */
  revisionHistory(id: string, { limit, offset, q }: { limit: number; offset: number; q: string }) {
    const where = "item = @id" + (q ? " AND instr(lower(coalesce(json_extract(body, '$.text'), '') || ' ' || coalesce(json_extract(body, '$.title'), '') || ' ' || coalesce(json_extract(body, '$.summary'), '') || ' ' || author || ' ' || created_at), lower(@q)) > 0" : "");
    const params = { id, ...(q ? { q } : {}) };
    const total = (this.db.prepare(`SELECT count(*) AS n FROM revisions WHERE ${where}`).get(params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM revisions WHERE ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }) as RevisionRow[];
    return { total, entries: rows.map((r): MemoryRevision => ({ id: r.id, item: r.item, body: json(r.body), author: r.author, createdAt: r.created_at })) };
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

  /** A daughter of an unlogged thread is always unlogged. Only a top-level thread can be a project. */
  createThread(opts: { interface: Interface; parent?: string; subagent?: boolean; child?: boolean; unlogged?: boolean; title?: string; project?: boolean; goal?: string }): Thread {
    const parent = opts.parent === undefined ? undefined : this.getThread(opts.parent);
    if (opts.parent !== undefined && !parent) throw new Error(`no such thread: ${opts.parent}`);
    if ((opts.subagent || opts.child) && !parent) throw new Error("a subagent's or child thread needs its parent");
    if (opts.child && (opts.subagent || parent!.child || parent!.subagent)) throw new Error("a child thread can't start child threads of its own");
    if (opts.project && (opts.subagent || opts.child)) throw new Error("only a top-level thread can be a project");
    if (opts.goal !== undefined && !opts.project) throw new Error("only a project has a goal");
    const goal = opts.goal === undefined ? null : cleanGoal(opts.goal);
    let id: string;
    do id = `${opts.interface}/${randomBytes(4).toString("hex")}`; while (this.getThread(id));
    const unlogged = !!opts.unlogged || !!parent?.unlogged;
    this.db.prepare("INSERT INTO threads (id, interface, parent, subagent, child, project, goal, title, unlogged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, opts.interface, parent?.id ?? null, opts.subagent ? 1 : 0, opts.child ? 1 : 0, opts.project ? 1 : 0, goal, opts.title ?? null, unlogged ? 1 : 0, now());
    return this.getThread(id)!;
  }

  /** Makes a top-level thread a project. There is no way back; its child threads become the project's threads. */
  setProject(id: string): void {
    const thread = this.mustThread(id);
    if (thread.child || thread.subagent) throw new Error("only a top-level thread can be a project");
    this.db.prepare("UPDATE threads SET project = 1 WHERE id = ?").run(id);
  }

  /** Moves existing work under a project, keeping entries, checklists and wake-ups.
   * Its child threads become siblings, so project depth stays one; subagents stay put.
   */
  foldThread(projectId: string, threadId: string, childrenOnly = false): string[] {
    const project = this.mustThread(projectId), thread = this.mustThread(threadId);
    if (!project.project || projectId === threadId) throw new Error("fold needs a different project chat");
    if (thread.project || thread.child || thread.subagent) throw new Error("only a top-level non-project thread can be folded");
    const ids = [...(childrenOnly ? [] : [threadId]), ...this.listThreads({ includeHidden: true, parent: threadId, children: true }).map(t => t.id)];
    this.tx(() => {
      for (const id of ids) this.db.prepare("UPDATE threads SET parent = ?, child = 1 WHERE id = ?").run(projectId, id);
      if (project.unlogged) for (const id of ids) this.setUnlogged(id, true);
    });
    return ids;
  }

  /** A project's goal, in the user's words; empty clears it. */
  setGoal(id: string, goal: string): void {
    if (!this.mustThread(id).project) throw new Error("only a project has a goal");
    this.db.prepare("UPDATE threads SET goal = ? WHERE id = ?").run(goal.trim() ? cleanGoal(goal) : null, id);
  }

  /**
   * A project's instructions, kept on its page apart from what sleep writes.
   * Only the user sets them; the page is made, empty, if it isn't there yet.
   */
  setProjectInstructions(id: string, instructions: string, author: Author): void {
    const thread = this.mustThread(id);
    if (!thread.project) throw new Error("only a project has instructions");
    if (!author.startsWith("user:")) throw new Error("a project's instructions can only be changed by the user");
    if (instructions.length > INSTRUCTIONS_LIMIT) throw new Error(`instructions have at most ${INSTRUCTIONS_LIMIT} characters`);
    const page = `p:${projectSlug(id)}`;
    this.tx(() => {
      if (!this.load(page)) this.putPage({ slug: projectSlug(id), title: thread.title ?? "Project", summary: "", text: "" }, author);
      this.edit(page, { instructions }, author);
    });
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
      // After a rewind, numbering goes on past what was removed: an entry ID always means one entry.
      const n = this.nextEntryN(threadId);
      this.db.prepare("INSERT INTO entries (thread, n, pi_id, role, data, text, unlogged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(threadId, n, entry.piId, entry.role, JSON.stringify(entry.data), entry.text, thread.unlogged ? 1 : 0, at);
      const id = entryId(threadId, n);
      // A look only quotes other threads (daemon/src/watch.ts): recall finds the words where they were said.
      // Sleep's own threads aren't indexed: recall would find copies of memories deleted since (docs/sleep.md).
      if (!thread.unlogged && thread.interface !== "sleep" && entry.text.trim() && !WATCHING.test(entry.text)) this.index(id, "entry", entry.role === "toolResult" ? entry.text.slice(0, TOOL_TEXT_LIMIT) : entry.text);
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
      this.copyEntries(source.id, copy.id);
      return copy;
    });
  }

  /** A thread's entries as they are stored, oldest first: what a share carries to another user. */
  exportEntries(threadId: string): ExportedEntry[] {
    this.mustThread(threadId);
    return (this.db.prepare("SELECT pi_id, role, data, text, created_at FROM entries WHERE thread = ? ORDER BY n").all(threadId) as
      { pi_id: string; role: string; data: string; text: string; created_at: string }[])
      .flatMap((r) => {
        const data = conversationOnly(JSON.parse(r.data));
        return data ? [{ piId: r.pi_id, role: r.role, data, text: stripCitations(r.text), createdAt: r.created_at }] : [];
      });
  }

  /**
   * Stores exported entries in an empty thread of this pool, keeping their
   * times. Unlike `copyEntries`, each is a new entry here (indexed unless the
   * thread is unlogged): a thread shared from another user's pool is this
   * pool's own from then on.
   */
  importEntries(threadId: string, entries: ExportedEntry[]): void {
    if ((this.db.prepare("SELECT count(*) AS c FROM entries WHERE thread = ?").get(threadId) as { c: number }).c) throw new Error("entries are imported only into an empty thread");
    this.tx(() => { for (const e of entries) this.appendEntry(threadId, { piId: e.piId, role: e.role, data: e.data, text: e.text }, e.createdAt); });
  }

  /**
   * Copies a thread's entries, or those up to entry `upTo`, into an empty
   * thread (an export, a fork). Each copy keeps its original's ID in `orig`
   * and isn't indexed again, so search and sleep see it once, at its source.
   */
  copyEntries(from: string, to: string, opts: { upTo?: number } = {}): void {
    this.mustThread(from);
    this.mustThread(to);
    if ((this.db.prepare("SELECT count(*) AS c FROM entries WHERE thread = ?").get(to) as { c: number }).c) throw new Error("entries are copied only into an empty thread");
    this.db.prepare(`INSERT INTO entries (thread, n, pi_id, role, data, text, unlogged, orig, pinned, reactions, created_at)
      SELECT ?, n, pi_id, role, data, text, unlogged, coalesce(orig, 'e:' || thread || '#' || n), pinned, reactions, created_at FROM entries WHERE thread = ? AND n <= ?`)
      .run(to, from, opts.upTo ?? Number.MAX_SAFE_INTEGER);
  }

  /**
   * A branch: a child thread holding the conversation up to and including
   * entry `n` (with the results of its tool calls), copied as an export
   * copies it, so citations to those entries still resolve and nothing is
   * processed twice. The source is left as it was. A branch of an unlogged
   * thread is unlogged. In a project, a branch of the project chat or of one
   * of its threads is a thread of the project (a child of the project chat),
   * so threads stay one level deep.
   */
  branchThread(threadId: string, n: number, opts: { title?: string } = {}): Thread {
    const source = this.mustThread(threadId);
    if (source.subagent) throw new Error("a subagent's thread can't be branched");
    if (!this.db.prepare("SELECT 1 FROM entries WHERE thread = ? AND n = ?").get(threadId, n)) throw new Error(`no entry ${n} in ${threadId}`);
    // A reply's tool calls keep their results, so the copy is a conversation a model can go on with.
    const results = this.db.prepare("SELECT n, role FROM entries WHERE thread = ? AND n > ? ORDER BY n").all(threadId, n) as { n: number; role: string }[];
    let upTo = n;
    // A note delivered mid-turn doesn't end the copy before the results.
    for (const r of results) if (r.role === "toolResult") upTo = r.n; else if (r.role !== "custom_message") break;
    const title = (opts.title?.trim() || `${source.title ?? "Untitled"} (branch)`).slice(0, 200);
    const project = this.projectOf(threadId);
    return this.tx(() => {
      const branch = project
        ? this.createThread({ interface: source.interface, parent: project, child: true, unlogged: source.unlogged, title })
        : this.createThread({ interface: source.interface, parent: source.id, title });
      this.copyEntries(source.id, branch.id, { upTo });
      return branch;
    });
  }

  /** The entries whose text holds `needle`, in any thread of this pool: where an upload is still mentioned. */
  entriesMentioning(needle: string): { thread: string; n: number }[] {
    return this.db.prepare("SELECT thread, n FROM entries WHERE instr(text, ?) > 0").all(needle) as { thread: string; n: number }[];
  }

  /** Pins or unpins entry `n`: a pinned entry stays in her context word for word. Throws if there's no such entry. */
  pinEntry(threadId: string, n: number, pinned: boolean): void {
    this.mustThread(threadId);
    const changed = this.db.prepare("UPDATE entries SET pinned = ? WHERE thread = ? AND n = ?").run(pinned ? 1 : 0, threadId, n).changes;
    if (!changed) throw new Error(`no entry ${n} in ${threadId}`);
  }

  /**
   * Puts `by`'s reaction `emoji` on entry `n`, or takes it off, and answers the
   * entry's reactions as they stand. Reactions are kept with the entry (a branch
   * copies them) and never reach her context by themselves: lyricad tells her
   * of a user's in her next turn. Throws if there's no such entry.
   */
  react(threadId: string, n: number, emoji: string, by: string, on: boolean): Reaction[] {
    this.mustThread(threadId);
    if (!isEmoji(emoji)) throw new Error("not an emoji");
    const row = this.db.prepare("SELECT reactions FROM entries WHERE thread = ? AND n = ?").get(threadId, n) as { reactions: string | null } | undefined;
    if (!row) throw new Error(`no entry ${n} in ${threadId}`);
    const current = parseReactions(row.reactions);
    const at = current.find((r) => r.emoji === emoji);
    if (on) {
      if (at) { if (!at.by.includes(by)) at.by.push(by); }
      else current.push({ emoji, by: [by] });
    } else if (at) {
      at.by = at.by.filter((x) => x !== by);
    }
    const next = current.filter((r) => r.by.length);
    this.db.prepare("UPDATE entries SET reactions = ? WHERE thread = ? AND n = ?").run(next.length ? JSON.stringify(next) : null, threadId, n);
    return next;
  }

  /** Keeps the user's unsent composer text for a thread; empty text deletes it. Forgetting the thread takes it too. */
  setDraft(threadId: string, text: string): void {
    this.mustThread(threadId);
    if (!text) this.db.prepare("DELETE FROM drafts WHERE thread = ?").run(threadId);
    else this.db.prepare("INSERT INTO drafts (thread, text, updated_at) VALUES (?, ?, ?) ON CONFLICT (thread) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").run(threadId, text, now());
  }

  /** Changes a question and its project waiting flag together. */
  private questionChange<T>(thread: string, fn: () => T): T {
    return this.c.questionChange ? this.c.questionChange(this.db, thread, fn) : this.tx(fn);
  }
  askQuestion(thread: string, n: number): void {
    this.mustThread(thread);
    if (!this.readAsk(thread, n)) throw new Error("ask needs its stored tool call");
    this.questionChange(thread, () => {
      this.db.prepare("UPDATE questions SET closed = ?, answer = 'withdrawn' WHERE thread = ? AND closed IS NULL").run(now(), thread);
      this.db.prepare("INSERT INTO questions (thread, n, asked) VALUES (?, ?, ?)").run(thread, n, now());
    });
  }
  closeQuestion(thread: string, answer: number | "words" | "withdrawn", n?: number): boolean {
    if (!this.openQuestion(thread) && n === undefined) return false;
    return this.questionChange(thread, () => !!this.db.prepare(`UPDATE questions SET closed = ?, answer = ? WHERE thread = ? AND closed IS NULL ${n === undefined ? "" : "AND n = ?"}`)
      .run(now(), String(answer), thread, ...(n === undefined ? [] : [n])).changes);
  }

  /** Replaces the code task. Forgetting the thread removes it too. */
  setCodeTask(threadId: string, task: string, done = ""): void {
    this.mustThread(threadId);
    if (task.length > 300 || done.length > 1200) throw new Error("code task exceeds 300 characters or done exceeds 1200 characters");
    this.db.prepare(`INSERT INTO code_tasks (thread, task, done, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (thread) DO UPDATE SET task = excluded.task, done = excluded.done, at = excluded.at`)
      .run(threadId, removeSecrets(task), removeSecrets(done), now());
  }

  /** Replaces a thread's checklist; none clears it. Forgetting the thread takes it too. */
  setSteps(threadId: string, steps: ThreadStep[]): void {
    this.mustThread(threadId);
    if (!steps.length) this.db.prepare("DELETE FROM thread_steps WHERE thread = ?").run(threadId);
    else this.db.prepare("INSERT INTO thread_steps (thread, steps, updated_at) VALUES (?, ?, ?) ON CONFLICT (thread) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at").run(threadId, JSON.stringify(steps), now());
  }

  /** Pinned entries, oldest first: one thread's, or every thread's in this pool. */
  pins(threadId?: string): PinnedEntry[] {
    const rows = this.db.prepare(`SELECT * FROM entries WHERE pinned = 1 ${threadId === undefined ? "" : "AND thread = ?"} ORDER BY created_at, n`)
      .all(...(threadId === undefined ? [] : [threadId])) as EntryRow[];
    return rows.map((r) => ({ ...toEntry(r), thread: r.thread, n: r.n }));
  }

  /** The subagent threads started in entry `fromN` or later: a rewind from there takes them with it. */
  subagentsSince(threadId: string, fromN: number): string[] {
    const from = this.db.prepare("SELECT created_at FROM entries WHERE thread = ? AND n >= ? ORDER BY n LIMIT 1").get(threadId, fromN) as { created_at: string } | undefined;
    if (!from) return [];
    return (this.db.prepare("SELECT id FROM threads WHERE parent = ? AND subagent = 1 AND created_at >= ? ORDER BY created_at").all(threadId, from.created_at) as { id: string }[])
      .map((r) => r.id);
  }

  /**
   * Rewinds a thread: removes entry `fromN` and everything after it, as
   * forgetting does. Their index rows go; notes whose only sources were in
   * them are deleted (each leaves a tombstone, and pages citing them are
   * flagged), as are pages citing the entries directly; subagent threads
   * started in them are forgotten. Entry numbers are never reused. An entry a
   * branch still holds a copy of keeps its notes and search row, and reading
   * it opens the copy. Returns how many entries went, how many of them were
   * pinned, and the subagent threads.
   */
  truncateThread(threadId: string, fromN: number, author: Author): { removed: number; pins: number; subagents: string[] } {
    this.checkAuthor(author);
    this.mustThread(threadId);
    return this.questionChange(threadId, () => {
      const subagents = this.subagentsSince(threadId, fromN);
      for (const id of subagents) this.forgetThread(id, author);
      const rows = this.db.prepare("SELECT n, pinned FROM entries WHERE thread = ? AND n >= ? ORDER BY n").all(threadId, fromN) as { n: number; pinned: number }[];
      if (!rows.length) return { removed: 0, pins: 0, subagents };
      // An entry a branch still holds a copy of keeps its notes and search row: the copy still says it.
      const removed = rows.map((r) => entryId(threadId, r.n));
      const copied = new Set((this.db.prepare("SELECT DISTINCT orig FROM entries WHERE orig IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(removed)) as { orig: string }[]).map((r) => r.orig));
      const gone = JSON.stringify(removed.filter((id) => !copied.has(id)));
      const goneSet = new Set(JSON.parse(gone) as string[]);
      const candidates = this.db.prepare("SELECT DISTINCT src FROM citations WHERE src LIKE 'n:%' AND dst IN (SELECT value FROM json_each(?))").all(gone) as { src: string }[];
      for (const { src } of candidates) if (this.cameFrom(src).every((d) => goneSet.has(d))) this.remove(src, author, true);
      this.db.prepare("UPDATE pages SET flagged = 1 WHERE 'p:' || slug IN (SELECT src FROM citations WHERE dst IN (SELECT value FROM json_each(?)))").run(gone);
      this.db.prepare("DELETE FROM search WHERE kind = 'entry' AND id IN (SELECT value FROM json_each(?))").run(gone);
      this.db.prepare("DELETE FROM questions WHERE thread = ? AND n >= ?").run(threadId, fromN);
      this.db.prepare("DELETE FROM entries WHERE thread = ? AND n >= ?").run(threadId, fromN);
      this.db.prepare("UPDATE threads SET cut = max(cut, ?) WHERE id = ?").run(rows.at(-1)!.n, threadId);
      this.optimize();
      return { removed: rows.length, pins: rows.filter((r) => r.pinned).length, subagents };
    });
  }

  /** A recurring turn in this thread or a fresh thread in the same place. Its times are in `zone`, the user's. */
  addRoutine(threadId: string, schedule: Schedule, note: string, newThread = false, at = now(), zone?: string): number {
    this.mustThread(threadId);
    const checked = parseSchedule(schedule);
    return Number(this.db.prepare("INSERT INTO routines (thread, schedule, note, new_thread, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(threadId, JSON.stringify(checked), note, newThread ? 1 : 0, nextRun(checked, new Date(at), zone).toISOString(), at).lastInsertRowid);
  }

  /** The user's time zone changed: every routine's next run moves to its wall time in `zone`. Every-N-hours ones keep theirs. */
  rezoneRoutines(zone: string, at = now()): void {
    this.tx(() => {
      const rows = this.db.prepare("SELECT id, schedule FROM routines").all() as { id: number; schedule: string }[];
      const set = this.db.prepare("UPDATE routines SET next_at = ? WHERE id = ?");
      for (const r of rows) {
        const schedule = parseSchedule(JSON.parse(r.schedule));
        if (schedule.kind !== "every") set.run(nextRun(schedule, new Date(at), zone).toISOString(), r.id);
      }
    });
  }

  /** Resuming also moves the next time to the next run from `at` in `zone`, so the paused span is not a pile of missed runs. */
  pauseRoutine(threadId: string, id: number, paused: boolean, at = now(), zone?: string): boolean {
    return this.tx(() => {
      const row = this.db.prepare("SELECT schedule FROM routines WHERE thread = ? AND id = ?").get(threadId, id) as { schedule: string } | undefined;
      if (!row) return false;
      if (paused) this.db.prepare("UPDATE routines SET paused = 1 WHERE thread = ? AND id = ?").run(threadId, id);
      else this.db.prepare("UPDATE routines SET paused = 0, next_at = ? WHERE thread = ? AND id = ?")
        .run(nextRun(parseSchedule(JSON.parse(row.schedule)), new Date(at), zone).toISOString(), threadId, id);
      return true;
    });
  }

  removeRoutine(threadId: string, id: number): boolean {
    return this.db.prepare("DELETE FROM routines WHERE thread = ? AND id = ?").run(threadId, id).changes > 0;
  }

  /** Move past due runs; a fired run also joins the wake-ups' text-free daily ledger. */
  advanceRoutine(id: number, nextAt: string, firedAt?: string): void {
    this.tx(() => {
      const r = this.db.prepare("SELECT thread FROM routines WHERE id = ?").get(id) as { thread: string } | undefined;
      if (!r) return;
      this.db.prepare("UPDATE routines SET next_at = ?, last_at = coalesce(?, last_at) WHERE id = ?").run(nextAt, firedAt ?? null, id);
      if (firedAt) {
        // An empty-note wakeups row, inserted already fired: a ledger entry for the shared daily cap.
        const ledger = this.addWakeup(r.thread, firedAt, "", firedAt);
        this.fireWakeup(ledger, firedAt);
      }
    });
  }

  /** A wake-up for the thread at `dueAt`, with its note. Returns its ID. */
  addWakeup(threadId: string, dueAt: string, note: string, at = now()): number {
    this.mustThread(threadId);
    return Number(this.db.prepare("INSERT INTO wakeups (thread, due_at, note, set_at) VALUES (?, ?, ?, ?)").run(threadId, dueAt, note, at).lastInsertRowid);
  }

  /** A wake-up fired: kept a day for the daily cap, without its note. Older fired ones go. */
  fireWakeup(id: number, at = now()): void {
    this.tx(() => {
      this.db.prepare("UPDATE wakeups SET fired_at = ?, note = '' WHERE id = ?").run(at, id);
      this.db.prepare("DELETE FROM wakeups WHERE fired_at < ?").run(new Date(Date.parse(at) - 86_400_000).toISOString());
    });
  }

  /** Removes a thread's pending wake-ups: one, or all. Returns how many. */
  removeWakeups(threadId: string, id?: number): number {
    return this.db.prepare(`DELETE FROM wakeups WHERE thread = ? AND fired_at IS NULL ${id !== undefined ? "AND id = ?" : ""}`)
      .run(threadId, ...(id !== undefined ? [id] : [])).changes;
  }

  /** A pull request this thread opened through its relay, to watch (docs/briefs/ci-wakes.md). Returns its ID. */
  addWatch(threadId: string, input: { repo: string; kind: ForgeKind; host: string; account: string; number: number }, at = now()): number {
    this.mustThread(threadId);
    return Number(this.db.prepare(`INSERT INTO watches (thread, repo, kind, host, account, number, head_since, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(threadId, input.repo, input.kind, input.host, input.account, input.number, at, at).lastInsertRowid);
  }

  /** Saves a watch's decision state after one poll; false when the watch is already gone. */
  updateWatch(id: number, state: ForgeWatchState): boolean {
    return this.db.prepare("UPDATE watches SET head = ?, head_since = ?, notified_heads = ?, seen_reviews = ? WHERE id = ?")
      .run(state.head, state.headSince, JSON.stringify(state.notifiedHeads), JSON.stringify(state.seenReviews), id).changes > 0;
  }

  /** The watch's repository just got a signed webhook, so the poller eases to ten minutes. */
  markWatchWebhook(id: number, at = now()): void {
    this.db.prepare("UPDATE watches SET webhook_at = ? WHERE id = ?").run(at, id);
  }

  removeWatch(id: number): boolean {
    return this.db.prepare("DELETE FROM watches WHERE id = ?").run(id).changes > 0;
  }

  /** One poll's outcome in one transaction: end or save the watch, and record the note's wake-up if there is one. Returns the wake-up's ID. */
  settleWatch(id: number, next: ForgeWatchState, stop: boolean, note: { thread: string; dueAt: string; text: string } | null): number | undefined {
    return this.tx(() => {
      if (!this.db.prepare("SELECT 1 FROM watches WHERE id = ?").get(id)) return undefined; // gone since the poll began
      if (stop) this.removeWatch(id);
      else this.updateWatch(id, next);
      return note ? this.addWakeup(note.thread, note.dueAt, note.text, note.dueAt) : undefined;
    });
  }

  /**
   * Deletes the thread and its entries, and the notes whose only sources were
   * in it (each leaves a tombstone, and pages citing them are flagged). Its
   * subagents' threads hold its tasks and results, so they go first. Its
   * other daughters (child threads, branches, copies) go too with `children`;
   * otherwise they are kept as threads of their own, with the settings they
   * have (a kept child thread is no longer a child). A project forgotten with
   * `children` also takes its page and the notes that came only from it.
   * The search index is merged once at the end (`optimize`); a caller
   * forgetting several threads passes `optimize: false` for all but the last,
   * since each merge reads the whole index.
   */
  forgetThread(threadId: string, author: Author, opts: { children?: boolean; keepMemories?: boolean; optimize?: boolean } = {}): void {
    this.checkAuthor(author);
    const thread = this.mustThread(threadId);
    const keep = !!opts.keepMemories;
    if (thread.project && opts.children && !keep) this.forgetProjectMemory(threadId, author);
    for (const sub of this.listThreads({ includeHidden: true, parent: threadId })) this.forgetThread(sub.id, author, { keepMemories: keep, optimize: false });
    if (opts.children) for (const child of this.listThreads({ includeHidden: true, parent: threadId, children: true })) this.forgetThread(child.id, author, { ...opts, optimize: false });
    this.tx(() => {
      // A kept daughter is a thread of its own: a kept child thread is no longer a child, so it may start its own.
      this.db.prepare("UPDATE threads SET parent = NULL, child = 0 WHERE parent = ? AND subagent = 0").run(threadId);
      const inThread = (dst: string) => dst === `t:${threadId}` || dst.startsWith(`e:${threadId}#`);
      const candidates = this.db.prepare("SELECT DISTINCT src FROM citations WHERE src LIKE 'n:%' AND (dst = ? OR dst LIKE ?)")
        .all(`t:${threadId}`, `e:${threadId}#%`) as { src: string }[];
      if (!keep) for (const { src } of candidates) {
        if (this.cameFrom(src).every(inThread)) this.remove(src, author, true);
      }
      // A thread deleted with its memories kept leaves a text-free tombstone: its ID and deletion time, so a citation of it still leads somewhere.
      if (keep) {
        this.db.prepare("INSERT OR REPLACE INTO tombstones (id, kind, sources, deleted_by, deleted_at) VALUES (?, 'thread', '[]', ?, ?)")
          .run(`t:${threadId}`, author, now());
      }
      this.db.prepare("DELETE FROM search WHERE kind = 'entry' AND id LIKE ?").run(`e:${threadId}#%`);
      this.db.prepare("DELETE FROM entries WHERE thread = ?").run(threadId);
      this.db.prepare("DELETE FROM wakeups WHERE thread = ?").run(threadId);
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      if (opts.optimize !== false) this.optimize();
    });
  }

  /** What a thread deleted with its memories kept leaves behind: when it went. No text. */
  getThreadTombstone(threadId: string): { deletedAt: string } | undefined {
    const row = this.db.prepare("SELECT deleted_at FROM tombstones WHERE id = ? AND kind = 'thread'").get(`t:${threadId}`) as { deleted_at: string } | undefined;
    return row ? { deletedAt: row.deleted_at } : undefined;
  }

  /** Notes and pages citing a thread or one of its entries, including after it was deleted. */
  citingThread(threadId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT src FROM citations WHERE dst = ? OR dst LIKE ? ORDER BY src").all(`t:${threadId}`, `e:${threadId}#%`) as { src: string }[]).map((r) => r.src);
  }

  /** A project's page, and the notes whose every source is in the project chat or its threads. */
  forgetProjectMemory(projectId: string, author: Author): void {
    this.checkAuthor(author);
    const threads = this.projectThreads(projectId);
    const inProject = (dst: string) => threads.some((t) => dst === `t:${t}` || dst.startsWith(`e:${t}#`));
    this.tx(() => {
      for (const note of this.projectNotesAll(threads)) if (this.cameFrom(note).every(inProject)) this.remove(note, author, true);
      const page = `p:${projectSlug(projectId)}`;
      if (this.load(page)) this.remove(page, author, true);
    });
  }

  /** Every note citing one of the threads, superseded and archived ones too. */
  private projectNotesAll(threads: string[]): string[] {
    return (this.db.prepare(`SELECT DISTINCT c.src AS id FROM citations c, json_each(?) t
      WHERE c.src LIKE 'n:%' AND (c.dst = 't:' || t.value OR c.dst LIKE 'e:' || t.value || '#%')`).all(JSON.stringify(threads)) as { id: string }[]).map((r) => r.id);
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
      let text = toStored(removeSecrets(note.text.trim()), this.c.owner);
      if (!text) throw new Error("a note needs text");
      if (note.source && !citationsIn(text, this.pool).includes(note.source)) text = `${text} [${note.source}]`;
      text = removeSecrets(text);
      const id = this.newId("n", "notes");
      const at = now();
      const about = (note.about ?? []).map((a) => removeSecrets(a.trim())).filter(Boolean);
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

  /** Whether `id` can name a new note or page here: nothing holds it, and no note was deleted under it. */
  isFree(id: string): boolean {
    if (this.load(id)) return false;
    return kindOf(id) !== "note" || !this.db.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(id);
  }

  /** An unused note ID, as `addNotes` makes them. */
  unusedNoteId(): string {
    return this.newId("n", "notes");
  }

  /** The note whose stored text is exactly what `text` would be stored as, if there is one: an import's duplicate. */
  noteWithText(text: string): string | undefined {
    const stored = removeSecrets(toStored(removeSecrets(text.trim()), this.c.owner));
    return (this.db.prepare("SELECT id FROM notes WHERE text = ?").get(stored) as { id: string } | undefined)?.id;
  }

  /** Whether page `slug` already holds `text`, as it would be stored. */
  pageHolds(slug: string, text: string): boolean {
    const r = this.db.prepare("SELECT text FROM pages WHERE slug = ?").get(slug) as { text: string } | undefined;
    return !!r && r.text === toStored(removeSecrets(text), this.c.owner);
  }

  /**
   * Writes an imported note or page under `id`, which must be free, as a
   * memory the user added, keeping its original creation time.
   */
  importMemory(id: string, body: Body, author: Author, createdAt?: string): void {
    this.checkAuthor(author);
    if (this.c.mode !== "owner") throw new Error("only the memory browser imports memories");
    if (!this.isFree(id)) throw new Error(`${id} is already taken`);
    const at = now();
    const created = createdAt && !Number.isNaN(Date.parse(createdAt)) && createdAt < at ? new Date(createdAt).toISOString() : at;
    this.tx(() => {
      const stored = this.stored(body);
      if (!stored.text.trim()) throw new Error("an imported memory needs text");
      if (kindOf(id) === "note") {
        const about = (stored.about ?? []).map((a) => a.trim()).filter(Boolean);
        this.db.prepare("INSERT INTO notes (id, text, about, origin, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, stored.text, about.join(", "), "user", author, created, at);
        this.written(id, { text: stored.text, about }, author, at);
      } else if (kindOf(id) === "page") {
        const slug = id.slice(2);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("page slugs use lowercase letters, digits and '-'");
        const page = { ...stored, title: stored.title || slug, summary: stored.summary ?? "", folders: stored.folders ?? [] };
        this.db.prepare(`INSERT INTO pages (slug, title, summary, text, folders, origin, author, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(slug, page.title, page.summary, page.text, JSON.stringify(page.folders), "user", author, created, at);
        this.written(id, { text: page.text, title: page.title, summary: page.summary, folders: page.folders }, author, at);
      } else {
        throw new Error("only notes and pages can be imported");
      }
    });
  }

  putWake(text: string, author: Author): void {
    text = toStored(removeSecrets(text), this.c.owner);
    this.checkAuthor(author);
    if (this.load("wake")) return this.edit("wake", { text }, author);
    const at = now();
    this.tx(() => {
      this.db.prepare("INSERT INTO wake (id, text, updated_at) VALUES (1, ?, ?)").run(text, at);
      this.written("wake", { text }, author, at);
    });
  }

  addJournal(text: string, author: Author): string {
    text = toStored(removeSecrets(text), this.c.owner);
    this.checkAuthor(author);
    return this.tx(() => {
      const id = this.newId("j", "journal");
      const at = now();
      this.db.prepare("INSERT INTO journal (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, text, at, at);
      this.written(id, { text }, author, at);
      return id;
    });
  }

  // Sleep runs and items

  startSleepRun(reason: SleepRunRecord["reason"], until: string): string {
    const id = this.newSleepId("s", "sleep_runs");
    this.db.prepare("INSERT INTO sleep_runs (id, reason, status, until, started_at) VALUES (?, ?, 'running', ?, ?)").run(id, reason, until, now());
    return id;
  }

  updateSleepRun(id: string, change: { status?: SleepStatus; phases?: SleepRunRecord["phases"]; finished?: boolean }): void {
    const run = this.getSleepRun(id);
    if (!run) throw new Error(`no sleep run ${id}`);
    this.db.prepare("UPDATE sleep_runs SET status = ?, phases = ?, finished_at = ? WHERE id = ?")
      .run(change.status ?? run.status, JSON.stringify(change.phases ?? run.phases), change.finished ? now() : run.finishedAt ?? null, id);
  }

  /** A skipped run: nothing moves, and the reason is kept. */
  recordSleepRun(reason: SleepRunRecord["reason"], skipReason: SkipReason, at = now()): string {
    const id = this.newSleepId("s", "sleep_runs");
    this.db.prepare("INSERT INTO sleep_runs (id, reason, status, skip_reason, until, started_at, finished_at) VALUES (?, ?, 'skipped', ?, ?, ?, ?)")
      .run(id, reason, skipReason, at, at, at);
    return id;
  }

  addItem(run: string, item: { kind: SleepItem["kind"]; text: string; source?: string }): string {
    const text = toStored(removeSecrets(item.text.trim()), this.c.owner);
    if (!text) throw new Error("an item needs text");
    const id = this.newSleepId("i", "sleep_items");
    this.db.prepare("INSERT INTO sleep_items (id, run, kind, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, run, item.kind, text, item.source ?? null, now());
    return id;
  }

  /** Links the item to the chat started from it. One chat per item. */
  startItem(id: string, threadId: string): void {
    this.mustThread(threadId);
    if (!this.db.prepare("UPDATE sleep_items SET thread = ? WHERE id = ? AND thread IS NULL AND dismissed = 0").run(threadId, id).changes) {
      throw new Error(`item ${id} is gone or already has a chat`);
    }
  }

  dismissItem(id: string): void {
    if (!this.db.prepare("UPDATE sleep_items SET dismissed = 1 WHERE id = ?").run(id).changes) throw new Error(`no item ${id}`);
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
    if (item.kind === "page" && !author.startsWith("user:") && (body.instructions ?? "") !== (item.instructions ?? "")) {
      throw new Error("a page's instructions can only be changed by the user");
    }
    // A page a user wrote or edited keeps their words: sleep may only add around them.
    const theirs = item.kind === "page" && !author.startsWith("user:") ? this.userText(id) : undefined;
    if (theirs && !body.text.includes(theirs)) {
      throw new Error(`${id} has text a user wrote; keep it word for word and add around it, or ask about it instead`);
    }
    const at = now();
    this.tx(() => {
      switch (item.kind) {
        case "note":
          this.db.prepare("UPDATE notes SET text = ?, about = ?, updated_at = ? WHERE id = ?").run(body.text, (body.about ?? []).join(", "), at, id);
          break;
        case "page":
          this.db.prepare("UPDATE pages SET text = ?, title = ?, summary = ?, folders = ?, instructions = ?, flagged = 0, updated_at = ? WHERE slug = ?")
            .run(body.text, body.title, body.summary, JSON.stringify(body.folders ?? []), body.instructions || null, at, id.slice(2));
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

  /** The text of the latest version in which a user changed the text, if any. */
  private userText(id: string): string | undefined {
    const revs = this.db.prepare("SELECT body, author FROM revisions WHERE item = ? ORDER BY id").all(id) as { body: string; author: string }[];
    let theirs: string | undefined;
    let before: string | undefined;
    for (const r of revs) {
      const text = json<Body>(r.body).text.trim();
      if (r.author.startsWith("user:") && text !== before) theirs = text;
      before = text;
    }
    return theirs;
  }

  private newSleepId(prefix: "s" | "i", table: "sleep_runs" | "sleep_items"): string {
    let id: string;
    do id = `${prefix}:${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
    while (this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
    return id;
  }

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
    const s = (t: string | undefined) => (t === undefined ? undefined : toStored(removeSecrets(t), this.c.owner));
    citationsIn(body.text, this.pool); // general refuses to cite private
    return { ...body, text: s(body.text)!, title: s(body.title), summary: s(body.summary), about: body.about?.map(removeSecrets), folders: body.folders?.map(removeSecrets), ...(body.instructions ? { instructions: s(body.instructions.trim()) } : { instructions: undefined }) };
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

function cleanGoal(goal: string): string {
  const clean = goal.trim();
  if (clean.length > GOAL_LIMIT) throw new Error(`a goal has at most ${GOAL_LIMIT} characters`);
  return clean;
}

const originOf = (author: Author): Origin => (author.startsWith("user:") ? "user" : (author as Origin));

function bodyOf(item: Item): Body {
  const body: Body = { text: item.text };
  if (item.kind === "page") Object.assign(body, { title: item.title, summary: item.summary, folders: item.folders, ...(item.instructions ? { instructions: item.instructions } : {}) });
  if (item.kind === "note") body.about = item.about;
  return body;
}

interface ThreadRow { id: string; interface: Interface; parent: string | null; subagent?: number; child?: number; project?: number; goal?: string | null; title: string | null; hidden: number; unlogged: number; created_at: string }
interface EntryRow { thread: string; n: number; role: string; text: string; unlogged: number; orig: string | null; created_at: string }
interface NoteRow { text: string; about: string; origin: string; author: string; superseded_by: string | null; archived: number; created_at: string; updated_at: string }
interface PageRow { slug: string; title: string; summary: string; text: string; folders: string; instructions?: string | null; origin: string; author: string; archived: number; flagged: number; created_at: string; updated_at: string }
interface SleepRunRow { id: string; reason: string; status: string; skip_reason: string | null; until: string; phases: string; started_at: string; finished_at: string | null }
interface ItemRow { id: string; run: string; kind: string; text: string; source: string | null; thread: string | null; dismissed: number; created_at: string }
interface RevisionRow { id: number; item: string; body: string; author: string; created_at: string }
interface WatchRow { id: number; thread: string; repo: string; kind: ForgeKind; host: string; account: string; number: number; head: string | null; head_since: string; notified_heads: string; seen_reviews: string; webhook_at: string | null; created_at: string }

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id, interface: r.interface, parent: r.parent ?? undefined, subagent: r.subagent === 1, child: r.child === 1,
    project: r.project === 1, ...(r.goal ? { goal: r.goal } : {}), title: r.title ?? undefined,
    hidden: r.hidden === 1, unlogged: r.unlogged === 1, createdAt: r.created_at,
  };
}

function toRun(r: SleepRunRow): SleepRunRecord {
  return {
    id: r.id, reason: r.reason as SleepRunRecord["reason"], status: r.status as SleepStatus, ...(r.skip_reason ? { skipReason: r.skip_reason as SkipReason } : {}),
    until: r.until, phases: json(r.phases), startedAt: r.started_at, ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
  };
}

function toItem(r: ItemRow): SleepItem {
  return {
    id: r.id, run: r.run, kind: r.kind as SleepItem["kind"], text: r.text, ...(r.source ? { source: r.source } : {}),
    ...(r.thread ? { thread: r.thread } : {}), dismissed: r.dismissed === 1, createdAt: r.created_at,
  };
}

function parseReactions(raw: string | null): Reaction[] {
  if (!raw) return [];
  const v = json(raw);
  return Array.isArray(v) ? (v as Reaction[]).filter((r) => typeof r.emoji === "string" && Array.isArray(r.by)).map((r) => ({ emoji: r.emoji, by: [...r.by] })) : [];
}

function toEntry(r: EntryRow): StoredEntry {
  return { id: r.orig ?? entryId(r.thread, r.n), role: r.role, text: r.text, unlogged: r.unlogged === 1, createdAt: r.created_at };
}

function toWatch(r: WatchRow): Watch {
  return {
    id: r.id, thread: r.thread, repo: r.repo, kind: r.kind, host: r.host, account: r.account, number: r.number,
    head: r.head, headSince: r.head_since, notifiedHeads: json<string[]>(r.notified_heads), seenReviews: json<string[]>(r.seen_reviews),
    ...(r.webhook_at ? { webhookAt: r.webhook_at } : {}), createdAt: r.created_at,
  };
}
