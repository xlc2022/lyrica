// Principles 5 and 6: Administration → Status shows which of the administrator's own notes and pages recall leans on
// (docs/memory.md, "Recall counts"), from the counts each pool keeps per hour and the citations it already derives.
// Only the shown pools count, and a private row for a general memory only when both are shown.
import { firstLine, RECALL_DAYS, splitId, type OwnerView, type Pool, type RecallCount } from "@lyrica/core";
import type { AdminMemoryUse, MemoryUseRow } from "./api.ts";

const HOUR = 3_600_000;
/** How many rows each list holds. */
const TOP = 10;
/** A note's first line on the card, at most this long. */
const LABEL = 120;

type Counts = { recalled: number; searched: number; opened: number };
const zero = (): Counts => ({ recalled: 0, searched: 0, opened: 0 });
const total = (c: Counts) => c.recalled + c.searched + c.opened;

/** The Memory use card for the last `days` days ending `now`, over `pools` (the ones the user's display shows). */
export function memoryUse(o: OwnerView, pools: Pool[], days: 7 | 30, now = Date.now()): AdminMemoryUse {
  const since = new Date(Math.floor((now - days * 24 * HOUR) / HOUR) * HOUR + HOUR).toISOString();
  // Each row as its memory's own pool and bare ID; one whose pool isn't shown is left out.
  const where = (store: Pool, id: string): { pool: Pool; id: string } | undefined => {
    const s = splitId(id);
    const pool = s?.pool ?? store;
    return s && pools.includes(pool) ? { pool, id: s.id } : undefined;
  };
  const byMemory = new Map<string, Counts>();
  const byHour = new Map<string, Counts>();
  const add = (into: Counts, r: Counts) => { into.recalled += r.recalled; into.searched += r.searched; into.opened += r.opened; };
  const exists = new Map<string, boolean>();
  const live = (pool: Pool, id: string) => {
    const key = `${pool}/${id}`;
    if (!exists.has(key)) exists.set(key, !!o[pool].get(id, { raw: true }));
    return exists.get(key)!;
  };
  for (const store of pools) {
    for (const r of o[store].recallCounts(since) as RecallCount[]) {
      const at = where(store, r.id);
      // A deleted memory's counts wait out their 31 days unseen.
      if (!at || !live(at.pool, at.id)) continue;
      const key = `${at.pool}/${at.id}`;
      if (!byMemory.has(key)) byMemory.set(key, zero());
      add(byMemory.get(key)!, r);
      const hour = `${r.hour}:00:00.000Z`;
      if (!byHour.has(hour)) byHour.set(hour, zero());
      add(byHour.get(hour)!, r);
    }
  }
  const cites = new Map<string, number>();
  for (const store of pools) {
    for (const c of o[store].citationCounts()) {
      const at = where(store, c.id);
      if (at) cites.set(`${at.pool}/${at.id}`, (cites.get(`${at.pool}/${at.id}`) ?? 0) + c.n);
    }
  }
  const row = (key: string): MemoryUseRow | undefined => {
    const slash = key.indexOf("/"), pool = key.slice(0, slash) as Pool, id = key.slice(slash + 1);
    const item = o[pool].get(id);
    if (!item || (item.kind !== "note" && item.kind !== "page")) return undefined;
    return { pool, id, kind: item.kind, label: item.kind === "page" ? item.title || id : firstLine(item.text, LABEL), ...(byMemory.get(key) ?? zero()), citedBy: cites.get(key) ?? 0 };
  };
  const top = [...byMemory].sort(([a, x], [b, y]) => total(y) - total(x) || a.localeCompare(b)).slice(0, TOP)
    .flatMap(([key]) => row(key) ?? []);
  const cited = [...cites].filter(([key]) => live(key.slice(0, key.indexOf("/")) as Pool, key.slice(key.indexOf("/") + 1)))
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, TOP).flatMap(([key]) => row(key) ?? []);
  return {
    since, days, pools,
    hours: [...byHour].sort(([a], [b]) => a.localeCompare(b)).map(([hour, c]) => ({ hour, ...c })),
    memories: byMemory.size,
    top, cited,
  };
}

/**
 * The Memory page's Most used: how often she reached each shown pool's notes and pages in the last 31 days, by pool and
 * bare ID. A private thread's count of a general memory adds to it only when both pools are shown, as on the card.
 */
export function useCounts(o: OwnerView, pools: Pool[], now = Date.now()): Record<Pool, Record<string, number>> {
  const since = new Date(now - RECALL_DAYS * 24 * HOUR).toISOString();
  const out: Record<Pool, Record<string, number>> = { general: {}, private: {} };
  for (const store of pools) {
    for (const r of o[store].recallCounts(since) as RecallCount[]) {
      const at = splitId(r.id);
      const pool = at?.pool ?? store;
      if (!at || !pools.includes(pool)) continue;
      out[pool][at.id] = (out[pool][at.id] ?? 0) + total(r);
    }
  }
  return out;
}
