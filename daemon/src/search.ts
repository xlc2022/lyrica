// Message search for the sidebar (docs/daemon.md "Search"): the search index's
// entries, through the owner view, as hits the browser marks without guessing.
// Message text goes only into the response, never into a log.
import { FROM_PARENT, WAKEUP, searchWords, stripCitations, type MessageHit, type OwnerView, type Pool } from "@lyrica/core";
import type { SearchHit } from "./api.ts";

export const SEARCH_PAGE = 50;
export const SNIPPET_MAX = 160;

/**
 * Up to `limit` hits over `pools`, newest first: web threads only (the
 * thread list's), hidden ones only with `showHidden`, never a subagent's.
 */
export function searchMessages(o: OwnerView, pools: Pool[], query: string, opts: { limit: number; before?: string; showHidden: boolean }): SearchHit[] {
  const words = searchWords(query).map(fold).filter(Boolean);
  if (!words.length) return [];
  return pools.flatMap((pool) => {
    const store = o[pool];
    const threads = new Map(store.listThreads({ includeHidden: opts.showHidden }).filter((t) => t.interface === "web" && !t.subagent).map((t) => [t.id, t]));
    if (!threads.size) return [];
    return store.searchMessages(query, { limit: opts.limit, before: opts.before, threads: [...threads.keys()] })
      .map((m) => toHit(pool, threads.get(m.thread)?.title, m, words));
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts.limit);
}

function toHit(pool: Pool, title: string | undefined, m: MessageHit, words: string[]): SearchHit {
  // What she sent from another thread, and her wake-up notes, are user entries she wrote.
  const mark = m.role === "user" ? FROM_PARENT.exec(m.text) ?? WAKEUP.exec(m.text) : null;
  const text = plain(stripCitations(mark ? m.text.slice(mark[0].length) : m.text));
  return {
    threadId: m.thread, pool, ...(title ? { title } : {}), n: m.n,
    who: m.role === "assistant" || mark ? "agent" : "you",
    ...snippetOf(text, words), at: m.createdAt,
  };
}

/** Her Markdown as one reads it: no emphasis, code ticks, or heading, quote and list marks. */
function plain(text: string): string {
  return text.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "").replace(/(\*\*|__|`+)/g, "");
}

/** A word as the index compares it: lower case, without accents. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The sentence of `text` holding the most of the query's (folded) words, the
 * first such, at most 160 characters: a longer one is cut around its first
 * match, with "…" where it was cut. `marks` are where the words are in it.
 */
export function snippetOf(text: string, words: string[]): { snippet: string; marks: [number, number][] } {
  const sentences = text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  let best = sentences[0] ?? "", most = 0;
  for (const s of sentences) {
    const found = new Set(marksIn(s, words).map((m) => m.word)).size;
    if (found > most) { best = s; most = found; }
  }
  const cut = cutAround(best, marksIn(best, words)[0]?.start ?? 0);
  return { snippet: cut, marks: marksIn(cut, words).map((m) => [m.start, m.end]) };
}

/** Every word of `s` that starts with one of `words`, as far as the matching part goes. */
function marksIn(s: string, words: string[]): { start: number; end: number; word: string }[] {
  const out: { start: number; end: number; word: string }[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
    const token = fold(m[0]);
    const word = words.filter((w) => token.startsWith(w)).sort((a, b) => b.length - a.length)[0];
    if (!word) continue;
    // Walk the original characters until their folded form covers the word.
    let len = 0, folded = "";
    for (const ch of m[0]) {
      folded += fold(ch);
      len += ch.length;
      if (folded.length >= word.length) break;
    }
    // Trailing accents belong to the last letter marked.
    while (len < m[0].length && /\p{M}/u.test(m[0][len]!)) len++;
    out.push({ start: m.index, end: m.index + len, word });
  }
  return out;
}

/** At most SNIPPET_MAX characters of `s`, starting a little before `at`, on word and character boundaries. */
function cutAround(s: string, at: number): string {
  if (s.length <= SNIPPET_MAX) return s;
  let start = Math.max(0, at - 40);
  if (start > 0) {
    const space = s.lastIndexOf(" ", start);
    if (space >= 0 && at - space <= 60) start = space + 1;
    if (isLow(s.charCodeAt(start))) start++;
  }
  const lead = start > 0 ? "…" : "";
  const room = SNIPPET_MAX - lead.length;
  if (s.length - start <= room) return lead + s.slice(start);
  let end = start + room - 1;
  const space = s.lastIndexOf(" ", end);
  if (space > at && space > start + room / 2) end = space;
  if (isLow(s.charCodeAt(end))) end--;
  return `${lead}${s.slice(start, end).trimEnd()}…`;
}

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
