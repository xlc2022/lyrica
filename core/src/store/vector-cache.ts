import type { Db } from "../db.ts";
import type { Kind } from "./refs.ts";

// Recall by meaning, held in memory (docs/memory.md, "Recall"). A pool's
// vectors are read from its database once, on its first search by meaning,
// and kept here at one byte per number, shared by every connection to that
// file. Later searches compare in memory and read only the few candidates
// they keep, so their scores are exactly what the database holds.
//
// The cache sees every change because each writable pool connection carries
// temporary triggers (watchVectors) that name the vector rows it changes;
// the next search re-reads just those rows. All the caches together stay
// under VECTOR_CACHE_BYTES: the least recently used pool is let go first,
// and a pool too big for the budget on its own is searched from disk.
// A cache unused for VECTOR_CACHE_IDLE_MS is let go too.

/** All pools' vectors in memory together stay under this (the operator's limit is 4 GB; this leaves room). */
export const VECTOR_CACHE_BYTES = 2 * 1024 ** 3;
/** A pool's vectors unused this long leave memory. */
export const VECTOR_CACHE_IDLE_MS = 15 * 60_000;
/** The limits in force; tests lower them. */
export const vectorCacheLimits = { bytes: VECTOR_CACHE_BYTES, idleMs: VECTOR_CACHE_IDLE_MS };
/** What one entry's id and slot cost besides its numbers, roughly. */
const ENTRY_OVERHEAD = 96;
/** Candidates kept past `limit` for exact rescoring, and how far under the floor one may sit, so rounding never drops a hit. */
const RESCORE_SLACK = 16;
const ROUNDING_MARGIN = 0.02;
/** After a pool proved too big for the budget, how long before it is tried again. */
const TOO_BIG_RETRY_MS = 60 * 60_000;

interface Cache {
  model: string;
  dim: number;
  /** Slot → item, undefined for a free slot. */
  ids: (string | undefined)[];
  kinds: Kind[];
  /** Unit vectors rounded to whole numbers from -127 to 127, `dim` per slot. */
  codes: Int8Array;
  /** What one step of a slot's codes is worth. */
  scales: Float32Array;
  slot: Map<string, number>;
  free: number[];
  /** Rough bytes held: the arrays' capacity plus each entry's overhead. */
  idBytes: number;
  lastUsed: number;
}

const caches = new Map<string, Cache>();
/** Per file: ids changed since its cache last caught up, or "all" after too many to track. */
const changed = new Map<string, Set<string> | "all">();
const tooBig = new Map<string, { model: string; until: number }>();
const watched = new WeakSet<Db>();
let sweeper: ReturnType<typeof setInterval> | undefined;

const bytesOf = (c: Cache) => c.codes.byteLength + c.scales.byteLength + c.idBytes;
const totalBytes = (except?: Cache) => [...caches.values()].reduce((n, c) => (c === except ? n : n + bytesOf(c)), 0);

/**
 * Has this writable connection report every change to its pool's vectors, so
 * the cache can follow. Every writable pool connection must carry it
 * (Memory opens them so); a read-only one needn't.
 */
export function watchVectors(db: Db): void {
  if (watched.has(db) || db.readonly || db.memory) return;
  const path = db.name;
  db.function("lyrica_vector_changed", { deterministic: false }, (id: unknown) => {
    if (typeof id !== "string" || !caches.has(path)) return null;
    const seen = changed.get(path);
    if (seen === "all") return null;
    const set = seen ?? new Set<string>();
    set.add(id);
    // A wholesale change (a model swap, a big wipe) is cheaper to reread whole.
    changed.set(path, set.size > Math.max(1000, (caches.get(path)?.slot.size ?? 0) / 4) ? "all" : set);
    return null;
  });
  db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS lyrica_vectors_ins AFTER INSERT ON main.vectors BEGIN SELECT lyrica_vector_changed(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS lyrica_vectors_upd AFTER UPDATE ON main.vectors BEGIN SELECT lyrica_vector_changed(OLD.id); SELECT lyrica_vector_changed(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS lyrica_vectors_del AFTER DELETE ON main.vectors BEGIN SELECT lyrica_vector_changed(OLD.id); END;`);
  watched.add(db);
}

/** Lets go of the vectors held for files under this path (a wiped pool, a deleted user). */
export function forgetVectors(pathPrefix: string): void {
  for (const key of [...caches.keys()]) if (key.startsWith(pathPrefix)) drop(key);
  for (const key of [...tooBig.keys()]) if (key.startsWith(pathPrefix)) tooBig.delete(key);
}

/** How many bytes the caches hold now, for tests and the budget. */
export function vectorCacheBytes(): number { return totalBytes(); }

function drop(path: string): void {
  caches.delete(path);
  changed.delete(path);
  if (!caches.size && sweeper) { clearInterval(sweeper); sweeper = undefined; }
}

function sweep(): void {
  const cut = Date.now() - vectorCacheLimits.idleMs;
  for (const [path, c] of caches) if (c.lastUsed < cut) drop(path);
}

/** Frees the least recently used other caches until `need` more bytes fit; false when they can't. */
function makeRoom(need: number, keep: Cache): boolean {
  while (totalBytes() + need > vectorCacheLimits.bytes) {
    let oldest: [string, Cache] | undefined;
    for (const e of caches) if (e[1] !== keep && (!oldest || e[1].lastUsed < oldest[1].lastUsed)) oldest = e;
    if (!oldest) return false;
    drop(oldest[0]);
  }
  return true;
}

/**
 * Grows a cache's arrays to hold `want` slots, within the budget; false when it can't. The old arrays
 * count until the copy is done, so even mid-copy the caches stay under the budget.
 */
function grow(c: Cache, want: number): boolean {
  const have = c.scales.length;
  if (want <= have) return true;
  const next = Math.max(want, Math.ceil(have * 1.25), 64);
  if (!makeRoom(next * (c.dim + 4), c)) return false;
  const codes = new Int8Array(next * c.dim); codes.set(c.codes);
  const scales = new Float32Array(next); scales.set(c.scales);
  c.codes = codes; c.scales = scales;
  return true;
}

const floats = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

/** Puts one vector in its slot (a new one if the id has none); false when the budget can't take it. */
function put(c: Cache, id: string, kind: Kind, v: Float32Array): boolean {
  let at = c.slot.get(id);
  if (at === undefined) {
    at = c.free.pop() ?? c.ids.length;
    if (at === c.ids.length) {
      if (!grow(c, at + 1)) return false;
      c.ids.push(undefined); c.kinds.push(kind);
    }
    c.slot.set(id, at);
    c.idBytes += ENTRY_OVERHEAD + 2 * id.length;
  }
  c.ids[at] = id; c.kinds[at] = kind;
  let norm = 0, max = 0;
  for (let i = 0; i < v.length; i++) { const x = v[i]!; norm += x * x; const a = Math.abs(x); if (a > max) max = a; }
  const base = at * c.dim;
  if (!norm || !max) { c.scales[at] = 0; c.codes.fill(0, base, base + c.dim); return true; }
  // Each number of the unit vector in steps of `step`: v[i] / |v| / step = v[i] * 127 / max.
  c.scales[at] = max / Math.sqrt(norm) / 127;
  const per = 127 / max;
  const codes = c.codes;
  for (let i = 0; i < c.dim; i++) { const y = v[i]! * per; codes[base + i] = y < 0 ? (y - 0.5) | 0 : (y + 0.5) | 0; }
  return true;
}

function remove(c: Cache, id: string): void {
  const at = c.slot.get(id);
  if (at === undefined) return;
  c.slot.delete(id);
  c.ids[at] = undefined; c.scales[at] = 0;
  c.free.push(at);
  c.idBytes -= ENTRY_OVERHEAD + 2 * id.length;
}

/** Gives up holding this pool's vectors for a while: it is searched from disk. */
function tooLarge(path: string, model: string): undefined {
  drop(path);
  tooBig.set(path, { model, until: Date.now() + TOO_BIG_RETRY_MS });
  return undefined;
}

/** Reads `model`'s vectors whole, one row at a time; undefined when they don't fit the budget. */
function load(db: Db, path: string, model: string): Cache | undefined {
  const c: Cache = { model, dim: 0, ids: [], kinds: [], codes: new Int8Array(0), scales: new Float32Array(0), slot: new Map(), free: [], idBytes: 0, lastUsed: Date.now() };
  caches.set(path, c);
  changed.delete(path);
  // Sized once up front, so loading doesn't copy as it grows.
  const first = db.prepare("SELECT length(vec) AS n FROM vectors WHERE model = ? AND vec IS NOT NULL LIMIT 1").get(model) as { n: number } | undefined;
  if (first) {
    c.dim = first.n / 4;
    // Every row, skipped ones too: an upper bound that the primary key's small index counts without reading the vectors.
    const count = (db.prepare("SELECT count(*) AS n FROM vectors").get() as { n: number }).n;
    if (!grow(c, count)) return tooLarge(path, model);
  }
  const rows = db.prepare("SELECT id, kind, vec FROM vectors WHERE model = ? AND vec IS NOT NULL").iterate(model) as IterableIterator<{ id: string; kind: Kind; vec: Buffer }>;
  for (const r of rows) {
    const v = floats(r.vec);
    if (!c.dim) c.dim = v.length;
    // One model, one size; a stray row of another size is never a hit, as on disk.
    if (v.length !== c.dim) continue;
    if (!put(c, r.id, r.kind, v)) {
      // Leaving early mid-iteration: the statement must be finished before the connection is used again.
      rows.return?.();
      return tooLarge(path, model);
    }
  }
  sweeper ??= setInterval(sweep, 60_000).unref();
  return c;
}

/** Brings a cache up to date with the rows its watchers saw change. */
function catchUp(db: Db, path: string, c: Cache): Cache | undefined {
  const seen = changed.get(path);
  if (!seen) return c;
  changed.delete(path);
  if (seen === "all") { drop(path); return load(db, path, c.model); }
  const read = db.prepare("SELECT kind, model, vec FROM vectors WHERE id = ?");
  for (const id of seen) {
    const r = read.get(id) as { kind: Kind; model: string; vec: Buffer | null } | undefined;
    const v = r?.vec ? floats(r.vec) : undefined;
    if (r && v && r.model === c.model && (!c.dim || v.length === c.dim)) {
      if (!c.dim) c.dim = v.length;
      if (!put(c, id, r.kind, v)) return tooLarge(path, c.model);
    } else remove(c, id);
  }
  return c;
}

/**
 * The `limit` items nearest `q` (already of length one) by cosine at or
 * above `floor`, from memory; undefined when this pool's vectors can't be
 * held, for the caller to read them from disk instead.
 */
export function nearestInMemory(db: Db, model: string, q: Float32Array, limit: number, floor: number): { id: string; kind: Kind; score: number }[] | undefined {
  if (db.memory) return undefined;
  const path = db.name;
  const big = tooBig.get(path);
  if (big && big.model === model && big.until > Date.now()) return undefined;
  let c = caches.get(path);
  if (c && c.model !== model) { drop(path); c = undefined; }
  c = c ? catchUp(db, path, c) : load(db, path, model);
  if (!c) return undefined;
  c.lastUsed = Date.now();
  if (!c.dim || q.length !== c.dim) return [];
  // Rounded scores first, then the best few exactly from the database.
  const keep = limit + RESCORE_SLACK;
  const cut = floor - ROUNDING_MARGIN;
  let picked: { at: number; score: number }[] = [];
  let worst = -Infinity;
  for (let at = 0; at < c.ids.length; at++) {
    const step = c.scales[at]!;
    if (!step) continue;
    let dot = 0;
    const base = at * c.dim;
    for (let i = 0; i < c.dim; i++) dot += c.codes[base + i]! * q[i]!;
    const score = dot * step;
    if (score < cut || (picked.length >= keep && score <= worst)) continue;
    picked.push({ at, score });
    if (picked.length > keep * 4) { picked.sort((a, b) => b.score - a.score); picked = picked.slice(0, keep); worst = picked.at(-1)!.score; }
  }
  picked.sort((a, b) => b.score - a.score);
  const ids = picked.slice(0, keep).map((p) => c.ids[p.at]!);
  if (!ids.length) return [];
  const rows = db.prepare("SELECT id, kind, vec FROM vectors WHERE model = ? AND vec IS NOT NULL AND id IN (SELECT value FROM json_each(?))")
    .all(model, JSON.stringify(ids)) as { id: string; kind: Kind; vec: Buffer }[];
  return exactScores(rows, q, floor).slice(0, limit);
}

/** Cosine of each stored vector with `q` (of length one), at or above `floor`, best first: the database's own numbers. */
export function exactScores(rows: { id: string; kind: Kind; vec: Buffer }[], q: Float32Array, floor: number): { id: string; kind: Kind; score: number }[] {
  const found: { id: string; kind: Kind; score: number }[] = [];
  for (const r of rows) {
    const v = floats(r.vec);
    if (v.length !== q.length) continue;
    let dot = 0, norm = 0;
    for (let i = 0; i < v.length; i++) { dot += v[i]! * q[i]!; norm += v[i]! * v[i]!; }
    const score = norm > 0 ? dot / Math.sqrt(norm) : 0;
    if (score >= floor) found.push({ id: r.id, kind: r.kind, score });
  }
  return found.sort((a, b) => b.score - a.score);
}
