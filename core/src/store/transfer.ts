import type { Pool } from "../types.ts";
import type { OwnerView } from "./memory.ts";
import type { Author, PoolStore } from "./pool.ts";
import { citationsIn, firstLine, kindOf, splitId, type Kind } from "./refs.ts";

// Memory export and import (docs/memory.md, "Export and import"). An export
// is Markdown the browser downloads: each note or page under a header with
// its kind, pool, ID and, for every link in its text, words saying what the
// link points at. Nothing here touches the disk. An import writes each
// memory as one the user added, keeps links that still resolve, and turns
// the rest into those words.

/** The first line of each memory's header, with the format's version. */
const MARK = "lyrica: memory 1";
const BLOCK = /^---\r?\nlyrica: memory(?: \d+)?\r?\n/m;
/** The most memories one import takes. */
export const IMPORT_LIMIT = 5000;

export interface MemoryRef { pool: Pool; id: string }

export interface Exported {
  /** A file name for the download. */
  name: string;
  markdown: string;
  count: number;
  /** Selected memories that aren't notes or pages, or are gone. */
  skipped: number;
}

export interface ImportSource { name?: string; text: string }

export interface ImportResult {
  imported: MemoryRef[];
  /** Memories already there, word for word, and not written again. */
  duplicates: number;
  /** Imported under another ID because theirs was taken. */
  renamed: number;
  /** Links that still resolve, kept as links. */
  linksKept: number;
  /** Links to memories that aren't there, or that the pool can't cite, written as words. */
  linksWorded: number;
  /** Blocks that aren't notes or pages, or have no text. */
  skipped: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const quoted = (s: string) => `“${s}”`;
const KIND_WORD: Record<Kind, string> = { note: "note", page: "page", journal: "journal entry", wake: "WAKE", thread: "conversation", entry: "message" };

/** What a link points at, in words, from what the exporting install still has. */
function describe(store: PoolStore, id: string): string {
  const kind = kindOf(id);
  if (kind === "thread" || kind === "entry") {
    const thread = store.getThread(id.slice(2).replace(/#\d+$/, ""));
    if (!thread) return "a forgotten conversation";
    const at = kind === "entry" ? store.get(id)?.createdAt ?? thread.createdAt : thread.createdAt;
    const where = thread.title ? `the conversation ${quoted(store.portable(thread.title))}` : "a conversation";
    return `${kind === "entry" ? `a message in ${where}` : where}, ${day(at)}`;
  }
  const item = store.get(id, { raw: true });
  if (!item) return `a deleted ${KIND_WORD[kind ?? "note"]}`;
  if (kind === "page") return `the page ${quoted(store.portable(item.title || id.slice(2)))}`;
  if (kind === "wake") return "WAKE";
  if (kind === "journal") return `her journal, ${day(item.createdAt)}`;
  return `a note, ${day(item.createdAt)}: ${quoted(firstLine(store.portable(item.text), 80))}`;
}

/** Fields written as they are; the rest are JSON, so any title or summary reads back exactly. */
const BARE = new Set(["kind", "pool", "id", "created", "updated"]);
const header = (fields: [string, unknown][]) => ["---", MARK, ...fields.filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && v !== "")
  .map(([k, v]) => (k === "cites" ? `cites:\n${Object.entries(v as Record<string, string>).map(([id, w]) => `  ${id}: ${JSON.stringify(w)}`).join("\n")}` : `${k}: ${BARE.has(k) ? String(v) : JSON.stringify(v)}`)), "---"].join("\n");

/** The selected notes and pages as one Markdown file. Other kinds are counted, not written. */
export function exportMemories(o: OwnerView, refs: MemoryRef[], at = new Date()): Exported {
  const blocks: string[] = [];
  let skipped = 0, single = "";
  for (const { pool, id } of refs) {
    const store = o[pool];
    const kind = kindOf(id);
    const item = kind === "note" || kind === "page" ? store.get(id, { raw: true }) : undefined;
    if (!item) { skipped++; continue; }
    const cites: Record<string, string> = {};
    for (const ref of citationsIn(item.text, pool)) {
      const s = splitId(ref)!;
      cites[ref] = describe(o[s.pool ?? pool], s.id);
    }
    const title = item.title && store.portable(item.title);
    blocks.push(`${header([
      ["kind", item.kind], ["pool", pool], ["id", id], ["title", title], ["summary", item.summary && store.portable(item.summary)],
      ["about", item.about], ["folders", item.folders], ["created", item.createdAt], ["updated", item.updatedAt],
      ["cites", Object.keys(cites).length ? cites : undefined],
    ])}\n\n${store.portable(item.text).trim()}\n`);
    single = title || firstLine(store.portable(item.text), 40);
  }
  const date = at.toISOString().slice(0, 10);
  const slug = single.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const name = blocks.length === 1 && slug ? `${slug}.md` : `lyrica-memories-${date}.md`;
  return { name, markdown: blocks.join("\n"), count: blocks.length, skipped };
}

interface Parsed {
  kind: string;
  pool?: Pool;
  id?: string;
  title?: string;
  summary?: string;
  about?: string[];
  folders?: string[];
  created?: string;
  cites: Record<string, string>;
  text: string;
}

const value = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return raw; } };
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v.split(/,\s*/).filter(Boolean) : undefined);

/** The memories in one file: each header block, or the whole file as one note when it has none. */
export function parseMemories(text: string): Parsed[] {
  const parts = text.replace(/^﻿/, "").split(BLOCK);
  const out: Parsed[] = [];
  if (parts.length === 1) {
    const plain = text.trim();
    return plain ? [{ kind: "note", cites: {}, text: plain }] : [];
  }
  for (const part of parts.slice(1)) {
    const end = /^---[ \t]*$/m.exec(part);
    if (!end) continue;
    const fields: Record<string, unknown> = {};
    const cites: Record<string, string> = {};
    let inCites = false;
    for (const line of part.slice(0, end.index).split(/\r?\n/)) {
      const cite = /^\s+(\S+):\s(.*)$/.exec(line);
      if (inCites && cite) { const w = str(value(cite[2]!)); if (w && splitId(cite[1]!)) cites[cite[1]!] = w; continue; }
      const m = /^([a-z]+):\s?(.*)$/.exec(line);
      if (!m) continue;
      inCites = m[1] === "cites";
      if (!inCites) fields[m[1]!] = value(m[2]!.trim());
    }
    const pool = fields.pool === "general" || fields.pool === "private" ? fields.pool : undefined;
    out.push({
      kind: str(fields.kind) ?? "note", ...(pool ? { pool } : {}), id: str(fields.id), title: str(fields.title), summary: str(fields.summary),
      about: strs(fields.about), folders: strs(fields.folders), created: str(fields.created), cites,
      text: part.slice(end.index + end[0].length).trim(),
    });
  }
  return out;
}

/** Whether `id` names something in `store`: a memory, a thread, or a logged message. */
function exists(store: PoolStore, id: string): boolean {
  const kind = kindOf(id);
  if (kind === "thread") return !!store.getThread(id.slice(2));
  return !!store.get(id);
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "imported";

/**
 * Imports the memories in `sources` into the user's own pools: each to
 * `pool`, or the pool it was exported from (a file without headers goes to
 * private). Every memory is written as one the user added.
 */
export function importMemories(o: OwnerView, sources: ImportSource[], opts: { pool?: Pool; author: Author }): ImportResult {
  const items = sources.flatMap((s) => parseMemories(s.text));
  if (items.length > IMPORT_LIMIT) throw new Error(`an import takes at most ${IMPORT_LIMIT} memories`);
  const result: ImportResult = { imported: [], duplicates: 0, renamed: 0, linksKept: 0, linksWorded: 0, skipped: 0 };
  // Where each exported memory went: `<pool>/<id>` as exported → its pool and ID here.
  const moved = new Map<string, MemoryRef>();
  const taken = new Set<string>();
  const seen = new Map<string, string>();
  const plan: { item: Parsed; from: Pool; to: Pool; id: string }[] = [];
  const find = (from: Pool) => (ref: string): MemoryRef | undefined => {
    const s = splitId(ref);
    if (!s) return undefined;
    const pool = s.pool ?? from;
    return moved.get(`${pool}/${s.id}`) ?? (exists(o[pool], s.id) ? { pool, id: s.id } : undefined);
  };

  for (const item of items) {
    if ((item.kind !== "note" && item.kind !== "page") || !item.text) { result.skipped++; continue; }
    const to = opts.pool ?? item.pool ?? "private";
    const from = item.pool ?? to;
    const store = o[to];
    const was = item.id && kindOf(item.id) === item.kind ? item.id : undefined;
    const free = (id: string) => !taken.has(`${to}/${id}`) && store.isFree(id);
    // An earlier import of the same file stored its links resolved: compare that form too.
    const linked = relink(item, from, to, find(from), { ...result });
    let id: string | undefined;
    if (item.kind === "note") {
      const same = store.noteWithText(item.text) ?? store.noteWithText(linked) ?? seen.get(`${to}\n${item.text}`);
      if (same) { result.duplicates++; if (was) moved.set(`${from}/${was}`, { pool: to, id: same }); continue; }
      id = was && free(was) ? was : store.unusedNoteId();
      seen.set(`${to}\n${item.text}`, id);
    } else {
      const base = was ? was.slice(2) : slugOf(item.title ?? firstLine(item.text, 40));
      let slug = base;
      const holds = (x: string) => store.pageHolds(x, item.text) || store.pageHolds(x, linked);
      for (let n = 2; !free(`p:${slug}`) && !holds(slug); n++) slug = `${base}-${n}`;
      if (holds(slug)) { result.duplicates++; if (was) moved.set(`${from}/${was}`, { pool: to, id: `p:${slug}` }); continue; }
      id = `p:${slug}`;
    }
    if (was && was !== id) result.renamed++;
    taken.add(`${to}/${id}`);
    if (was) moved.set(`${from}/${was}`, { pool: to, id });
    plan.push({ item, from, to, id });
  }

  for (const { item, from, to, id } of plan) {
    const text = relink(item, from, to, find(from), result);
    o[to].importMemory(id, {
      text, ...(item.kind === "page" ? { title: item.title ?? id.slice(2), summary: item.summary ?? "", folders: item.folders ?? [] } : { about: item.about ?? [] }),
    }, opts.author, item.created);
    result.imported.push({ pool: to, id });
  }
  return result;
}

/**
 * The text with each link resolved for its new pool: kept (as `general/…`
 * from private), or, when the memory isn't here or sits in a pool this one
 * can't cite, replaced by words. Words from a private memory never land in a
 * general one.
 */
function relink(item: Parsed, from: Pool, to: Pool, find: (ref: string) => MemoryRef | undefined, result: ImportResult): string {
  return item.text.replace(/ ?(?<!\[)\[([^[\]]+)\](?!\])/g, (whole, inside: string) => {
    const parts = inside.split(/[,;]\s*/);
    if (!parts.every((p) => splitId(p))) return whole;
    const kept: string[] = [], words: string[] = [];
    for (const raw of parts) {
      const ref = raw.trim();
      const s = splitId(ref)!;
      const here = find(ref);
      const cited = here?.pool ?? s.pool ?? from;
      if (here && (here.pool === to || here.pool === "general")) {
        kept.push(here.pool === to ? here.id : `general/${here.id}`);
        result.linksKept++;
      } else if (cited === "private" && to === "general") {
        words.push(`a private ${KIND_WORD[kindOf(s.id) ?? "note"]}`);
        result.linksWorded++;
      } else {
        words.push(item.cites[ref] ?? `a ${KIND_WORD[kindOf(s.id) ?? "note"]} that isn't here`);
        result.linksWorded++;
      }
    }
    return `${kept.length ? ` [${kept.join(", ")}]` : ""}${words.length ? ` (from ${words.join("; from ")})` : ""}`;
  }).trim();
}
