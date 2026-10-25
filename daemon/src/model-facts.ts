// Principles 1 and 8: Administration → Status says what her models actually did in
// facts that are already recorded — counts of retained call rows, medians of speeds
// already measured, and recorded fallback markers. Nothing new is tracked, timed or
// charted; this only reads the rows it is handed.
import type { Pool } from "@lyrica/core";
import type { CallInfo, ModelCallFacts } from "./api.ts";

/** How far back Status's model facts reach: the last 24 hours, inclusive at both ends. */
export const MODEL_FACTS_WINDOW_MS = 24 * 60 * 60_000;

type Fact = ModelCallFacts["models"][number];

/** A measured speed, only where `speeds` recorded one (a turn too short to mean anything has none). */
const measuredSpeed = (c: CallInfo): number[] => {
  const v = c.pace?.tokPerSec;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? [v] : [];
};

/** A recorded fallback marker: the first model in the list didn't answer. A note is never one. */
const hasFallback = (c: CallInfo): boolean => typeof c.fallback === "string" && c.fallback.trim() !== "";

/** The middle of measured speeds; an even count averages the central pair, as the library's medians do. */
function median(xs: number[]): number | undefined {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return undefined;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round(((v[mid - 1]! + v[mid]!) / 2) * 10) / 10;
}

/**
 * What her models did in the last 24 hours, from call rows read for these pools.
 * Every retained row counts once, whatever its task, grouped by the permanent
 * offering ID, so two copies of one model name stay apart; each group shows the
 * label and endpoint of its newest row. Speed is the median of recorded
 * `pace.tokPerSec` with its sample count — a turn's duration is not a speed — and
 * is absent rather than zero when nothing was measured. Fallbacks count rows that
 * carry a recorded marker, never what a note says, so they are resolution skips,
 * not retries, failed attempts or errors. Rows outside `[now - 24h, now]`, with a
 * timestamp in the future or unreadable, say nothing and are left out. Nothing is
 * capped: the store keeps only the latest 500 rows per user across pools, so this
 * is retained history, not a complete day's activity.
 */
export function modelFacts(calls: CallInfo[], pools: Pool[], now: number = Date.now()): ModelCallFacts {
  const since = now - MODEL_FACTS_WINDOW_MS;
  const shown = new Set<Pool>(pools);
  const groups = new Map<string, { id: string; at: number; label: string; endpointName: string; calls: number; speeds: number[]; fallbacks: number }>();
  for (const c of calls) {
    if (!shown.has(c.pool)) continue;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    const g = groups.get(c.offeringId);
    if (!g) {
      groups.set(c.offeringId, { id: c.offeringId, at, label: c.label, endpointName: c.endpointName, calls: 1, speeds: measuredSpeed(c), fallbacks: hasFallback(c) ? 1 : 0 });
    } else {
      g.calls += 1;
      g.speeds.push(...measuredSpeed(c));
      if (hasFallback(c)) g.fallbacks += 1;
      // The name it goes by now, from the newest row: labels are kept with old rows for history's sake.
      if (at > g.at) { g.at = at; g.label = c.label; g.endpointName = c.endpointName; }
    }
  }
  const models: Fact[] = [...groups.values()].map((g) => {
    const med = median(g.speeds);
    return {
      offeringId: g.id, label: g.label, endpointName: g.endpointName, calls: g.calls, speedSamples: g.speeds.length,
      ...(med !== undefined ? { medianTokPerSec: med } : {}), fallbacks: g.fallbacks,
    };
  });
  models.sort((a, b) => a.label.localeCompare(b.label) || a.offeringId.localeCompare(b.offeringId));
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), pools: [...pools], models };
}
