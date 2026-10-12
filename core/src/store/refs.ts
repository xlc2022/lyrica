import { queryTokens, type UserId } from "../mentions.ts";
import type { Profile } from "../profile.ts";
import type { Pool } from "../types.ts";

// Memory IDs and inline citations (docs/contracts.md, "IDs and citations").
//   e:<thread>#<n>  an entry       t:<thread>  a whole thread
//   n:<id>          a note         p:<slug>    a page
//   j:<id>          a journal entry           wake  the WAKE text
// A citation into the other pool carries it: [general/n:…].

export type Kind = "entry" | "thread" | "note" | "page" | "journal" | "wake";

const ID = /^(?:(general|private)\/)?((?:[etnpj]):[^\s,;[\]]+|wake)$/;

const KINDS: Record<string, Kind> = { e: "entry", t: "thread", n: "note", p: "page", j: "journal" };

export function kindOf(id: string): Kind | undefined {
  if (id === "wake") return "wake";
  return id[1] === ":" ? KINDS[id[0]!] : undefined;
}

/** Splits `general/n:x` into its pool (if any) and the bare ID. */
export function splitId(id: string): { pool?: Pool; id: string } | undefined {
  const m = ID.exec(id.trim());
  if (!m) return undefined;
  return { pool: m[1] as Pool | undefined, id: m[2]! };
}

/**
 * The citations in a text, as stored: bare IDs for the same pool, `general/…`
 * for general memory cited from private. General memory can never cite private.
 */
export function citationsIn(text: string, pool: Pool): string[] {
  const out = new Set<string>();
  for (const [, inside] of text.matchAll(/(?<!\[)\[([^[\]]+)\](?!\])/g)) {
    for (const part of inside!.split(/[,;]\s*/)) {
      const ref = splitId(part);
      if (!ref) continue;
      if (ref.pool && ref.pool !== pool) {
        if (pool === "general") throw new Error("general memory can't cite private memory");
        out.add(`${ref.pool}/${ref.id}`);
      } else {
        out.add(ref.id);
      }
    }
  }
  return [...out];
}

/** The text as the search index sees it: mention tokens become one word per user, citations drop out. */
export function indexText(text: string): string {
  return text
    .replace(/\[\[u:([A-Za-z0-9-]+)(?::[a-z-]+)?\]\]/g, (_m, id: string) => ` ${userWord(id)} `)
    .replace(/(?<!\[)\[[^[\]]+\](?!\])/g, (m) => (citationsInSafe(m) ? " " : m));
}

const citationsInSafe = (m: string) => m.slice(1, -1).split(/[,;]\s*/).every((p) => splitId(p));
const userWord = (id: UserId) => `lyricau${id.replaceAll("-", "")}`;

const STOP = new Set(("a an and are as at be but by can do did does for from had has have how i if in is it its me my no not of on or " +
  "our so that the their them then there these they this to too us was we were what when where which who why will with would " +
  "you your yes ok just about like really very").split(" "));

/**
 * An FTS5 query for free text: every word, OR'd. A user's name found in the
 * query adds that user's token as one more alternative, so "Li" finds
 * `[[u:…]]` and "Li-ion" still finds "Li-ion".
 */
export function ftsQuery(query: string, profiles: Map<UserId, Profile>): string | undefined {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, 32);
  const users = [...new Set(queryTokens(query, profiles).map((m) => userWord(m.userId)))];
  const terms = [...words.map((w) => `"${w}"`), ...users];
  return terms.length ? terms.join(" OR ") : undefined;
}

/** The literal words of a query, for picking a snippet. */
export function queryWords(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));
}

/** About `width` characters of `text` around the first query word it contains. */
export function snippet(text: string, words: string[], width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), flat.length);
  const start = at === flat.length ? 0 : Math.max(0, at - width / 3);
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/**
 * The sentence of `text` that cites `id` (as stored: bare, or `general/…`
 * from private), for "Came from" and "Used in". A citation group that
 * follows a sentence's full stop belongs to that sentence.
 */
export function sentenceCiting(text: string, id: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?:\s*\[[^[\]]+\])*)?|[.!?]+(?:\s*\[[^[\]]+\])*/g) ?? [flat];
  const want = id.trim();
  const cites = (s: string) => [...s.matchAll(/(?<!\[)\[([^[\]]+)\](?!\])/g)].flatMap((m) => m[1]!.split(/[,;]\s*/).map((x) => x.trim()));
  return sentences.find((s) => cites(s).includes(want))?.trim();
}

/** The first line of a memory's text without its citations, for a preview. */
export function firstLine(text: string, width = 200): string {
  const line = text.replace(/\s*(?<!\[)\[(?:(?:general|private)\/)?(?:[etnpj]:[^\s,;[\]]+|wake)(?:[,;]\s*(?:(?:general|private)\/)?(?:[etnpj]:[^\s,;[\]]+|wake))*\](?!\])/g, "").replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1).trimEnd()}…` : line;
}
