import { readView, resolve, searchView, type Hit, type PoolView, type Profile, type StoredEntry, type Item } from "@lyrica/core";

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
  recall?: string;
  lastTalk?: Date;
}

export interface MemoryContext {
  threadId: string;
  /** The person she's talking with, for "added by" labels. */
  user: { id: string; profile: Profile };
  folders: string[];
}

export const UNLOGGED_NOTICE =
  "This thread isn't being remembered: nothing said here goes into memory, and you can't save notes. " +
  "You can still read what you already remember. Don't promise to remember anything from it.";

const RECALL_HITS = 5;

/** The page about the person she's talking with. A user can write it; sleep keeps it up. */
export const ABOUT_USER_PAGE = "p:about-user";

/** Reads WAKE, the about-user page, the page index, folder pages and this message's recall hits from the view. */
export async function memorySections(view: PoolView, prompt: string, ctx: MemoryContext): Promise<MemorySections> {
  const { own } = view;
  const index = own.pageIndex().map((p) => `- [${p.id}] ${p.title}: ${p.summary}`).join("\n");
  const stores = [{ prefix: "", store: own }, ...view.reads.map((store) => ({ prefix: `${store.pool}/`, store }))];
  const folderPages = stores.flatMap(({ prefix, store }) => store.forFolders(ctx.folders).map((p) => ({ ...p, id: prefix + p.id })));
  const hits = prompt.trim() ? searchView(view, prompt, { current: true, limit: RECALL_HITS, excludeThread: ctx.threadId }) : [];
  return {
    notice: own.getThread(ctx.threadId)?.unlogged ? UNLOGGED_NOTICE : undefined,
    wake: own.getWake(),
    // The thread's own pool comes first; the about section's budget cuts whatever doesn't fit.
    about: [own, ...view.reads].map((store) => store.get(ABOUT_USER_PAGE)).filter((p) => p && !p.archived)
      .map((p) => p!.text.trim()).filter(Boolean).join("\n\n") || undefined,
    pageIndex: index || undefined,
    folders: folderPages.map((p) => `<page id="${p.id}" title="${p.title}">\n${p.text}\n</page>`).join("\n\n") || undefined,
    recall: hits.map((h) => formatHit(h, ctx.user)).join("\n") || undefined,
    lastTalk: own.lastUserMessage(),
  };
}

/** One recall hit: `[id] (kind, added by Li) snippet`. */
export function formatHit(h: Hit, user: MemoryContext["user"]): string {
  const labels = [h.kind, authorLabel(h.author, user), h.supersededBy && `superseded by ${h.supersededBy}`].filter(Boolean);
  return `[${h.id}] (${labels.join(", ")}) ${h.snippet}`;
}

function authorLabel(author: string | undefined, user: MemoryContext["user"]): string | undefined {
  if (!author?.startsWith("user:")) return undefined;
  return `added by ${author === `user:${user.id}` ? user.profile.displayName : "a user"}`;
}

/** A memory or a stretch of a past thread, as `read_memory` shows it. */
export function formatRead(view: PoolView, id: string, ctx: Pick<MemoryContext, "threadId" | "user">): string {
  const found = readView(view, id, ctx.threadId);
  if (!found) return `Nothing found for ${id}.`;
  if (found.entries) return found.entries.map(formatEntry).join("\n\n");
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

function formatEntry(e: StoredEntry): string {
  const text = e.text.length > 1500 ? `${e.text.slice(0, 1500)}…` : e.text;
  return `[${e.id}] ${e.role} (${e.createdAt.slice(0, 16).replace("T", " ")}): ${text || "(no text)"}`;
}
