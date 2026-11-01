import type { PinnedText } from "./assemble.ts";
import { lookPointer, projectSection, readView, resolve, searchView, type Hit, type SearchOptions, type PoolView, type Profile, type StoredEntry, type Item } from "@lyrica/core";

/** What memory contributes to the prompt. Every field is optional. */
export interface MemorySections {
  /** Said when the thread isn't logged, so she doesn't promise to remember. */
  notice?: string;
  wake?: string;
  /** The person's own page, `p:about-user`: private first, then general. */
  about?: string;
  pageIndex?: string;
  /** Pages about the thread's granted folders. */
  folders?: string;
  /** The thread's pinned messages, oldest first. */
  pinned?: PinnedText[];
  /** In a project chat or one of its threads: the goal, the project page, notes since the last sleep, and (in the chat) its threads. */
  project?: string;
  recall?: string;
  /** The item from sleep this thread was started from: she opens with it. No other thread sees items. */
  opening?: string;
  lastTalk?: Date;
}

export interface MemoryContext {
  threadId: string;
  code?: boolean;
  /** The person she's talking with, for "added by" labels. */
  user: { id: string; profile: Profile };
  folders: string[];
  /** Memories this thread must not see (sleep's wake phase never sees dreams). */
  hide?: (id: string) => boolean;
  /** In a project chat: its threads, one line each, from lyricad. */
  projectThreads?: () => string | undefined;
  /** Her name, left out of automatic recall: nearly everything mentions it. */
  name?: string;
  /** The user's message or a recall query as a vector, for hits by meaning; undefined (or a throw) means keywords alone. */
  embed?: (text: string) => Promise<{ model: string; values: Float32Array } | undefined>;
}

/** The query's vector, or nothing: an embedding model that is away or slow never holds up a turn. */
export async function queryVector(ctx: Pick<MemoryContext, "embed">, text: string): Promise<{ model: string; values: Float32Array } | undefined> {
  if (!ctx.embed || !text.trim()) return undefined;
  try {
    return await ctx.embed(text);
  } catch {
    return undefined;
  }
}

export const UNLOGGED_NOTICE =
  "This thread isn't being remembered: nothing said here goes into memory, and you can't save notes. " +
  "You can still read what you already remember. Don't promise to remember anything from it.";

const RECALL_HITS = 5;
/** In a message of three words or more, an automatic recall hit holds two of them, and words common in her memory don't count, so filler doesn't bring up an unrelated conversation. */
const RECALL_WORDS = 2;

const words = (t: string) => new Set(t.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/\{user[^}]*\}/g, " user ").match(/[\p{L}\p{N}]+/gu) ?? []);
/** Two notes are the same words, ignoring case, citations and spacing. */
export function sameText(a: string, b: string): boolean {
  // A stored mention token and a written {user} are the same person.
  const norm = (t: string) => t.toLowerCase().replace(/\[\[u:[^\]]*\]\]|\{user[^}]*\}/g, " user ").replace(/\[[^\]]*\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}

/** Two notes say the same thing: most of their words are shared. */
export function nearCopy(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.6;
}

/** The page about the person she's talking with. A user can write it; sleep keeps it up. */
export const ABOUT_USER_PAGE = "p:about-user";

/** Reads WAKE, the about-user page, the page index, folder pages and this message's recall hits from the view. */
export async function memorySections(view: PoolView, prompt: string, ctx: MemoryContext): Promise<MemorySections> {
  const { own } = view;
  const index = own.pageIndex().map((p) => `- [${p.id}] ${p.title}: ${p.summary}`).join("\n");
  const stores = [{ prefix: "", store: own }, ...view.reads.map((store) => ({ prefix: `${store.pool}/`, store }))];
  const folderPages = stores.flatMap(({ prefix, store }) => store.forFolders(ctx.folders).map((p) => ({ ...p, id: prefix + p.id })));
  const vector = await queryVector(ctx, prompt);
  const hits = prompt.trim() ? search(view, prompt, { current: true, said: true, limit: RECALL_HITS, minWords: RECALL_WORDS, skip: ctx.name ? [ctx.name] : undefined, excludeThread: ctx.threadId, fromThread: ctx.code ? codeMemoryThread(view, ctx.threadId) : ctx.threadId, ...(ctx.code ? { only: { project: true, about: "working" } } : {}), ...(vector ? { vector } : {}) }, ctx.hide) : [];
  const item = own.itemForThread(ctx.threadId);
  return {
    notice: own.getThread(ctx.threadId)?.unlogged ? UNLOGGED_NOTICE : undefined,
    wake: ctx.code || ctx.hide?.("wake") ? undefined : own.getWake(),
    // The thread's own pool comes first; the about section's budget cuts whatever doesn't fit.
    about: ctx.code ? undefined : [own, ...view.reads].map((store) => store.get(ABOUT_USER_PAGE)).filter((p) => p && !p.archived)
      .map((p) => p!.text.trim()).filter(Boolean).join("\n\n") || undefined,
    pageIndex: ctx.code ? undefined : index || undefined,
    folders: folderPages.map((p) => `<page id="${p.id}" title="${p.title}">\n${p.text}\n</page>`).join("\n\n") || undefined,
    pinned: pinnedOf(own, ctx.threadId),
    project: projectSection(own, ctx.code ? codeMemoryThread(view, ctx.threadId) : ctx.threadId, ctx.projectThreads),
    recall: hits.map((h) => formatHit(h, ctx.user)).join("\n") || undefined,
    opening: !ctx.code && item ? `You're starting this conversation. Bring this up, in your own words: ${item.text}${item.source ? ` [${item.source}]` : ""}` : undefined,
    lastTalk: own.lastUserMessage(),
  };
}

/** A thread's pinned messages, for the pinned section: only the user's messages and her replies. */
export function pinnedOf(store: Pick<PoolView["own"], "pins">, threadId: string): PinnedText[] | undefined {
  const pins = store.pins(threadId).filter((p) => (p.role === "user" || p.role === "assistant") && p.text.trim())
    .map((p) => ({ id: p.id, role: p.role, text: p.text }));
  return pins.length ? pins : undefined;
}

/** searchView, minus what the thread must not see. */
export function search(view: PoolView, query: string, opts: SearchOptions, hide?: (id: string) => boolean): Hit[] {
  if (!hide) return searchView(view, query, opts);
  const limit = opts.limit ?? 8;
  return searchView(view, query, { ...opts, limit: limit * 4 }).filter((h) => !hide(h.id)).slice(0, limit);
}

/** One recall hit: `[id] (entry by Ada, 2026-10-12) snippet`, `(your journal, …)`, `(note, …, added by Sam)`. */
export function formatHit(h: Hit, user: MemoryContext["user"]): string {
  const labels = [kindLabel(h, user), h.at?.slice(0, 10), authorLabel(h.author, user), h.supersededBy && `superseded by ${h.supersededBy}`].filter(Boolean);
  return `[${h.id}] (${labels.join(", ")}) ${h.snippet}`;
}

/** Who said a recalled message, and that a journal entry is her own, so hits from different speakers don't blend. */
function kindLabel(h: Hit, user: MemoryContext["user"]): string {
  if (h.kind === "entry") return h.origin === "user" ? `entry by ${user.profile.displayName}` : h.origin === "lyrica" ? "entry by you" : "tool result";
  return h.kind === "journal" ? "your journal" : h.kind;
}

function authorLabel(author: string | undefined, user: MemoryContext["user"]): string | undefined {
  if (!author?.startsWith("user:")) return undefined;
  return `added by ${author === `user:${user.id}` ? user.profile.displayName : "a user"}`;
}

/** A memory or a stretch of a past thread, as `read_memory` shows it. */
export function formatRead(view: PoolView, id: string, ctx: Pick<MemoryContext, "threadId" | "user" | "hide">, page?: "back" | "on"): string {
  if (ctx.hide?.(id.trim())) return `Nothing found for ${id}.`;
  const found = readView(view, id, ctx.threadId, page);
  if (!found) return `Nothing found for ${id}.`;
  if (found.entries) return found.entries.filter((e) => !ctx.hide?.(e.id)).map(formatEntry).join("\n\n") || `Nothing found for ${id}.`;
  const item = found.item as Item;
  const { store } = resolve(view, id)!;
  const head = [item.kind, item.title, authorLabel(item.author, ctx.user), item.supersededBy && `superseded by ${item.supersededBy}`,
    item.archived && "archived", `updated ${item.updatedAt.slice(0, 10)}`].filter(Boolean).join(", ");
  const lines = [`[${id}] (${head})`, item.text];
  const from = store.cameFrom(item.id);
  // Private memory that cites general memory lives in the private store.
  const usedIn = [...store.usedIn(item.id), ...(store === view.own ? [] : view.own.usedIn(`${store.pool}/${item.id}`))];
  if (from.length) lines.push(`Came from: ${from.join(", ")}`);
  if (usedIn.length) lines.push(`Used in: ${usedIn.join(", ")}`);
  return lines.join("\n");
}

/** One entry of a past thread, cut as `read_memory` cuts it. */
export function formatEntry(e: StoredEntry): string {
  const text = lookPointer(e.text) ?? (e.text.length > 1500 ? `${e.text.slice(0, 1500)}…` : e.text);
  return `[${e.id}] ${e.role} (${e.createdAt.slice(0, 16).replace("T", " ")}): ${text || "(no text)"}`;
}

/** Subagents use their nearest ordinary ancestor’s project through their existing thread view. */
export function codeMemoryThread(view: PoolView, threadId: string): string {
  let thread = view.own.getThread(threadId);
  while (thread?.subagent && thread.parent) thread = view.own.getThread(thread.parent);
  return thread?.id ?? threadId;
}

/**
 * The first of this thread's stored entries still in her context: entries
 * before it went into a compaction's summary. Undefined before any compaction.
 */
export function keptFrom(view: PoolView, branch: { type: string; firstKeptEntryId?: string }[], threadId: string): number | undefined {
  const compaction = branch.findLast((e) => e.type === "compaction");
  return compaction?.firstKeptEntryId ? view.own.entryNumber(threadId, compaction.firstKeptEntryId) : undefined;
}

/** Her pointer to what a compaction took out of context, in her prompt until the next one. */
export const earlierText = (threadId: string, kept: number) =>
  `This thread's messages before the summary are stored as e:${threadId}#1 to e:${threadId}#${kept - 1}. recall searches them; read_memory opens one with what was said around it, and pages back or on from it.`;
