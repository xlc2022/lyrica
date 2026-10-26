// Principles 1 and 8: Administration → Status says what her models actually did in
// facts that are already recorded — counts of retained call rows, medians of speeds
// already measured, output tokens and recorded fallback markers, and each row's numbers
// for its charts. Nothing new is tracked here; this only reads the rows it is handed.
import type { Pool } from "@lyrica/core";
import type { CallInfo, ModelCallFacts } from "./api.ts";

/** How far back Status's model facts reach: the last 24 hours, inclusive at both ends. */
export const MODEL_FACTS_WINDOW_MS = 24 * 60 * 60_000;

type Fact = ModelCallFacts["models"][number];
type Point = ModelCallFacts["calls"][number];

/** A measured speed, only where `speeds` recorded one (a turn too short to mean anything has none). */
const measured = (v: number | undefined): number[] => typeof v === "number" && Number.isFinite(v) && v >= 0 ? [v] : [];
const measuredSpeed = (c: CallInfo): number[] => measured(c.pace?.tokPerSec);
const measuredPrompt = (c: CallInfo): number[] => measured(c.pace?.promptTokPerSec);
const outputOf = (c: CallInfo): number[] => measured(c.pace?.outputTokens);

/** A recorded fallback marker: the first model in the list didn't answer. A note is never one. */
const hasFallback = (c: CallInfo): boolean => typeof c.fallback === "string" && c.fallback.trim() !== "";

/** The middle of measured speeds; an even count averages the central pair. */
function median(xs: number[]): number | undefined {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return undefined;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * What her models did in the last 24 hours, from call rows read for these pools.
 * Every retained row counts once, whatever its task, grouped by the permanent
 * offering ID, so two copies of one model name stay apart; each group shows the
 * label and endpoint of its newest row. Speed is the median of recorded
 * `pace.tokPerSec` with its sample count — a turn's duration is not a speed — and
 * is absent rather than zero when nothing was measured; prompt speed is the same
 * over `pace.promptTokPerSec`, and output tokens add up what paced rows wrote.
 * `calls` gives each row's time, offering, task, output, speed and fallback mark,
 * newest first, for the charts: no thread, note or text. Fallbacks count rows that
 * carry a recorded marker, never what a note says, so they are resolution skips,
 * not retries, failed attempts or errors. Rows outside `[now - 24h, now]`, with a
 * timestamp in the future or unreadable, say nothing and are left out. Nothing is
 * capped: nightly pruning keeps the latest 500 rows per user across pools, so this
 * is retained history, not a complete day's activity.
 */
export function modelFacts(calls: CallInfo[], pools: Pool[], now: number = Date.now()): ModelCallFacts {
  const since = now - MODEL_FACTS_WINDOW_MS;
  const shown = new Set<Pool>(pools);
  type Group = { id: string; at: number; label: string; endpointName: string; kind: Fact["kind"]; calls: number; speeds: number[]; prompts: number[]; output: number; fallbacks: number };
  const groups = new Map<string, Group>();
  const points: Point[] = [];
  for (const c of calls) {
    if (!shown.has(c.pool)) continue;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    let g = groups.get(c.offeringId);
    if (!g) groups.set(c.offeringId, g = { id: c.offeringId, at, label: c.label, endpointName: c.endpointName, kind: c.kind, calls: 0, speeds: [], prompts: [], output: 0, fallbacks: 0 });
    // The name it goes by now, from the newest row: labels are kept with old rows for history's sake.
    else if (at > g.at) { g.at = at; g.label = c.label; g.endpointName = c.endpointName; g.kind = c.kind; }
    const [speed] = measuredSpeed(c), [output] = outputOf(c), fallback = hasFallback(c);
    g.calls += 1;
    if (speed !== undefined) g.speeds.push(speed);
    g.prompts.push(...measuredPrompt(c));
    g.output += output ?? 0;
    if (fallback) g.fallbacks += 1;
    points.push({ at: new Date(at).toISOString(), offeringId: c.offeringId, task: c.task,
      ...(output !== undefined ? { outputTokens: output } : {}), ...(speed !== undefined ? { tokPerSec: speed } : {}), ...(fallback ? { fallback: true as const } : {}) });
  }
  const models: Fact[] = [...groups.values()].map((g) => {
    const med = median(g.speeds), prompt = median(g.prompts);
    return {
      offeringId: g.id, label: g.label, endpointName: g.endpointName, kind: g.kind, calls: g.calls,
      ...(med !== undefined ? { medianTokPerSec: med } : {}), speedSamples: g.speeds.length,
      ...(prompt !== undefined ? { medianPromptTokPerSec: prompt } : {}), promptSamples: g.prompts.length,
      outputTokens: g.output, fallbacks: g.fallbacks,
    };
  });
  models.sort((a, b) => a.label.localeCompare(b.label) || a.offeringId.localeCompare(b.offeringId));
  points.sort((a, b) => b.at.localeCompare(a.at));
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), pools: [...pools], models, calls: points };
}
