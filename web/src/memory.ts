// Pure pieces of the memory browser: the citations in a memory's text, how
// each reads (a title, a dated source mark, "Private is hidden"), and word
// differences between two versions. Nothing here keeps text anywhere.
import type { Display, MemoryKind, MemoryLink, Pool } from "./api.ts";
import { href, idHref } from "./route.ts";
import { hidden } from "./ui.tsx";

/** A citation group as stored: `[n:…]`, `[general/p:slug, t:web/x]`. Doubled brackets are mention tokens, not citations. */
const ONE = String.raw`(?:(?:general|private)\/)?(?:[etnpj]:[^\s,;[\]]+|wake)`;
export const CITATION_GROUP = new RegExp(String.raw`(?<!\[)\[(${ONE}(?:[,;]\s*${ONE})*)\](?!\])`, "g");

export interface Ref {
  /** As written: `n:x`, or `general/n:x` from the other pool. */
  raw: string;
  pool: Pool;
  /** Without the pool. */
  bare: string;
  kind: MemoryKind;
}

const KINDS: Record<string, MemoryKind> = { e: "entry", t: "thread", n: "note", p: "page", j: "journal" };

/** Reads one citation, as it appears in a memory of `pool`. */
export function parseRef(raw: string, pool: Pool): Ref | undefined {
  const m = /^(?:(general|private)\/)?(.+)$/s.exec(raw.trim());
  if (!m) return undefined;
  const bare = m[2]!;
  const kind = bare === "wake" ? "wake" : bare[1] === ":" ? KINDS[bare[0]!] : undefined;
  return kind && { raw: raw.trim(), pool: (m[1] as Pool | undefined) ?? pool, bare, kind };
}

/** The refs of a citation group's inside (`n:x, p:y`). */
export const refsOf = (inside: string, pool: Pool): Ref[] => inside.split(/[,;]\s*/).map((x) => parseRef(x, pool)).filter((x): x is Ref => !!x);

export const KIND_WORD: Record<MemoryKind, string> = { page: "page", note: "note", wake: "WAKE", journal: "journal", thread: "thread", entry: "message" };
export const dateWord = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
export const longDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "long" });
export const poolWord = (pool: Pool) => (pool === "private" ? "Private" : "General");

/** A memory's name where it has no title: its first words. */
export function firstWords(text: string, width = 60): string {
  const flat = plainCitations(text).replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1).trimEnd()}…` : flat;
}

/** The text without its citation groups. */
export const plainCitations = (text: string) => text.replace(new RegExp(String.raw`\s*${CITATION_GROUP.source}`, "g"), "").replace(/\s+([.,;:!?])/g, "$1");

export interface Word {
  text: string;
  /** Opens the memory or thread; a hidden pool's or a gone memory's word is plain text. */
  href?: string;
  /** A note's dated source mark, set small in mono. */
  cite?: boolean;
  ref: Ref;
  link?: MemoryLink;
}

/** How a citation reads: the link's title, a note's date, the hidden pool's word, or what is gone. */
export function wordFor(ref: Ref, link: MemoryLink | undefined, display: Display, userId: string): Word {
  if (hidden(display, ref.pool)) return { text: `${poolWord(ref.pool)} is hidden`, ref };
  if (!link) {
    const gone = ref.kind === "thread" || ref.kind === "entry" ? "a forgotten thread" : ref.kind === "note" ? "a deleted note" : ref.kind === "page" ? "a deleted page" : "a deleted memory";
    return { text: gone, ref };
  }
  const to = idHref(userId, ref.pool, ref.raw);
  switch (ref.kind) {
    case "note": return { text: dateWord(link.updatedAt), href: to, cite: true, ref, link };
    case "journal": return { text: `the journal, ${longDate(link.updatedAt)}`, href: to, ref, link };
    case "wake": return { text: "WAKE", href: to, ref, link };
    case "page": return { text: link.title || "an untitled page", href: to, ref, link };
    default: return { text: link.deleted ? "a deleted thread" : link.title || "an untitled thread", href: to, ref, link };
  }
}

const escapeMd = (s: string) => s.replace(/[\\[\]()*_`]/g, "\\$&");

/**
 * Markdown for a memory's text (mentions already rendered): every citation as
 * a link titled as it reads, with the words behind each href for a preview.
 */
export function linkCitations(text: string, pool: Pool, userId: string, links: Record<string, MemoryLink>, display: Display): { markdown: string; words: Map<string, Word> } {
  const words = new Map<string, Word>();
  const markdown = text.replace(CITATION_GROUP, (_whole, inside: string) => refsOf(inside, pool).map((ref) => {
    const w = wordFor(ref, links[ref.raw], display, userId);
    if (!w.href) return w.text;
    words.set(w.href, w);
    return `[${escapeMd(w.text)}](${w.href})`;
  }).join(", "));
  return { markdown, words };
}

/**
 * The text as plain words, for differences and the cards' sentences: pages
 * and threads read as their titles, notes and the journal drop out (a
 * sentence reads on without its source marks). `mark` wraps one cited
 * memory's title in U+2060-free markers the caller can split on.
 */
export function plainWords(text: string, pool: Pool, links: Record<string, MemoryLink>, display: Display, userId: string): string {
  return text.replace(new RegExp(String.raw`\s*${CITATION_GROUP.source}`, "g"), (whole, inside: string) => {
    const kept = refsOf(inside, pool).map((ref) => wordFor(ref, links[ref.raw], display, userId)).filter((w) => !w.cite && w.ref.kind !== "journal").map((w) => w.text);
    return kept.length ? `${/^\s/.test(whole) ? " " : ""}${kept.join(", ")}` : "";
  }).replace(/\s+(\u2063*[.,;:!?])/g, "$1").replace(/\s+/g, " ").trim(); // U+2063 is Sentence's mark around a citation
}

export type DiffOp = { kind: "same" | "del" | "ins"; text: string };

/** Words with the whitespace that follows each, so the pieces join back to the text. */
const tokens = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];

/**
 * Word differences from `from` to `to`: deleted words, inserted words, and
 * what stayed, in order. Small texts; computed in the browser, never stored.
 */
export function wordDiff(from: string, to: string): DiffOp[] {
  const a = tokens(from), b = tokens(to);
  const word = (t: string) => t.trim();
  let head = 0;
  while (head < a.length && head < b.length && word(a[head]!) === word(b[head]!)) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && word(a[a.length - 1 - tail]!) === word(b[b.length - 1 - tail]!)) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  const out: DiffOp[] = [];
  const push = (kind: DiffOp["kind"], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text; else out.push({ kind, text });
  };
  push("same", b.slice(0, head).join(""));
  if (midA.length * midB.length > 4_000_000) {
    push("del", midA.join("")); push("ins", midB.join(""));
  } else {
    // Longest common subsequence over the middle, then walk it back.
    const n = midA.length, m = midB.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i * (m + 1) + j] = word(midA[i]!) === word(midB[j]!) ? L[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (m + 1) + j]!, L[i * (m + 1) + j + 1]!);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (word(midA[i]!) === word(midB[j]!)) { push("same", midB[j]!); i++; j++; }
      else if (L[(i + 1) * (m + 1) + j]! >= L[i * (m + 1) + j + 1]!) { push("del", midA[i]!); i++; }
      else { push("ins", midB[j]!); j++; }
    }
    while (i < n) push("del", midA[i++]!);
    while (j < m) push("ins", midB[j++]!);
  }
  push("same", b.slice(b.length - tail).join(""));
  return out;
}

/** Where a memory opens in a thread: beside it in the panel from the split width, the Memory page below it. */
export const memoryHref = (userId: string, pool: Pool, id: string) => href({ page: "memory", userId, pool, id });
