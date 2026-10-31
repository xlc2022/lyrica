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

/** The text without its citation groups (`[n:…]`, `[general/p:slug, e:t#3]`), for a copy that leaves the pool. */
export function stripCitations(text: string): string {
  return text.replace(/ ?(?<!\[)\[([^[\]]+)\](?!\])/g, (whole, inside: string) =>
    (inside.split(/[,;]\s*/).every((part) => splitId(part)) ? "" : whole));
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

/**
 * Words a search leaves out: function words, greetings, and the filler of a
 * question ("some", "should", "try", "something"), which says nothing about
 * what it is about, but in a small memory is rare enough to carry a match.
 */
const STOP = new Set(("a an and are as at be but by can do did does for from had has have how i if in is it its me my no not of on or " +
  "our so that the their them then there these they this to too us was we were what when where which who why will with would " +
  "you your yes ok just about like really very hi hello hey thanks thank please " +
  "some any something anything things thing should could might must shall may try tried trying want wants wanted need needs needed " +
  "think thought know knew get got give take make made let see look tell say said also maybe perhaps much more most lot lots bit " +
  "going gone go went come came here into onto than only other over out up down still already again ever never always often " +
  "sometimes someone anyone everyone everything nothing somewhere am been being while because").split(" "));

/**
 * A word's stem, when a common English ending can be taken off and at least four
 * letters are left: "recipes" is "recipe", "interesting" is "interest", "drinks"
 * is "drink". The index has no stemmer, so the query carries the stem as a prefix.
 */
export function stem(word: string): string | undefined {
  for (const end of ["ing", "ies", "ed", "es", "s"]) {
    if (word.length - end.length >= 4 && word.endsWith(end)) {
      const base = word.slice(0, -end.length);
      return end === "ies" ? `${base}i` : end === "s" && base.endsWith("s") ? undefined : base;
    }
  }
  return undefined;
}

/** How many letters a text's word may add to a short query word and still be that word ("cats", "baked"), not another ("sometimes", "trying"). */
const SHORT_WORD = 5;
const SHORT_GROWTH = 2;

/**
 * Whether a text word is the query word: the same word, a longer word
 * starting with it (any length past `SHORT_WORD` letters; a short one
 * grows at most `SHORT_GROWTH`), or a word sharing its stem.
 */
export function sameWord(have: string, want: string): boolean {
  if (have === want) return true;
  if (have.startsWith(want) && (want.length >= SHORT_WORD || have.length - want.length <= SHORT_GROWTH)) return true;
  const base = stem(want);
  return base !== undefined && have.startsWith(base);
}

/** The query's words without stopwords; with `fallback`, all of them when every word is one (a deliberate search for "something"). */
function contentWords(query: string, fallback: boolean): string[] {
  const all = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const kept = all.filter((w) => !STOP.has(w));
  return kept.length || !fallback ? kept : all;
}

/**
 * An FTS5 query for free text: every word, OR'd. A user's name found in the
 * query adds that user's token as one more alternative, so "Al" finds
 * `[[u:…]]` and "Al-ion" still finds "Al-ion". A query of only stopwords
 * searches them as they are, unless `strict` (automatic recall), which finds nothing.
 */
export function ftsQuery(query: string, profiles: Map<UserId, Profile>, strict = false): string | undefined {
  const words = contentWords(query, !strict).slice(0, 32);
  const users = [...new Set(queryTokens(query, profiles).map((m) => userWord(m.userId)))];
  // A word with an English ending also matches by its stem, as a prefix: "recipes" finds "recipe".
  const stems = [...new Set(words.map(stem).filter((s): s is string => !!s && !words.includes(s)))];
  const terms = [...words.map((w) => `"${w}"`), ...stems.map((s) => `"${s}"*`), ...users];
  return terms.length ? terms.join(" OR ") : undefined;
}

/** The query without `skip`'s words (a name of one or more words), as whole words, in any case. */
export function withoutWords(query: string, skip: string[]): string {
  const drop = new Set(skip.flatMap((w) => fold(w).match(WORD) ?? []));
  return query.replace(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu, (w) => (drop.has(fold(w)) ? " " : w));
}

/**
 * The query's terms for `holdsEnough`: each word on its own, and a user's
 * name together with that user's mention token, so a name counts once
 * whichever way the text holds it.
 */
export function queryTerms(query: string, profiles: Map<UserId, Profile>): string[][] {
  const users = queryTokens(query, profiles).map((m) => ({ words: fold(m.name).match(WORD) ?? [], token: userWord(m.userId) }));
  const named = new Set(users.flatMap((u) => u.words));
  const words = [...new Set(fold(query).match(WORD) ?? [])].filter((w) => !STOP.has(w) && !named.has(w));
  return [...words.map((w) => [w]), ...users.map((u) => [...u.words, u.token])];
}

/**
 * Whether `text` holds at least `min` of the terms, each as a word
 * (`sameWord`: "drink" counts in "drinks" and "recipes" in "recipe", but "some"
 * not in "sometimes"). A query of `min` terms or fewer needs
 * only one. With `common` (terms found in much of the index), it must also
 * hold `min` of the other terms, or all of them when there are fewer, or one
 * for a short query; a query of only common terms finds nothing.
 */
export function holdsEnough(text: string, terms: string[][], min = 1, common?: boolean[]): boolean {
  const rare = common ? terms.filter((_, i) => !common[i]) : terms;
  if (!rare.length) return !terms.length;
  const has = [...new Set(fold(indexText(text)).match(WORD) ?? [])];
  const holds = (t: string[]) => t.some((w) => has.some((h) => sameWord(h, w)));
  if (terms.length <= min) return rare.some(holds);
  return terms.filter(holds).length >= min && rare.filter(holds).length >= Math.min(min, rare.length);
}

/** Lower case without diacritics, as the index's tokenizer folds words. */
const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * The words of a search in the sidebar, lower case. A word keeps its
 * combining marks, so the index's tokenizer splits it as it split the text.
 * One-letter words are left out when longer ones are there ("don't" is "don").
 */
export function searchWords(query: string): string[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [])];
  const long = words.filter((w) => [...w].length > 1);
  return (long.length ? long : words).slice(0, 16);
}

/** The literal words of a query, for picking a snippet. */
export function queryWords(query: string): string[] {
  return contentWords(query, true);
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
  const line = text.replace(/\s*(?<!\[)\[(?:(?:general|private)\/)?(?:[etnpj]:[^\s,;[\]]+|wake)(?:[,;]\s*(?:(?:general|private)\/)?(?:[etnpj]:[^\s,;[\]]+|wake))*\](?!\])/g, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1).trimEnd()}…` : line;
}
