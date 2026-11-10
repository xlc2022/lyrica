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

/** What an image or video call's host measured, per image: seconds, steps, steps per second and pixels. */
type Sample = { seconds: number; steps: number; stepsPerSec: number; pixels?: number; clip: boolean };
const sampled = (c: CallInfo): Sample[] => {
  const s = c.sampling;
  if (!s || !(s.ms >= 50) || !(s.steps > 0) || !(s.images >= 1)) return [];
  return [{ seconds: s.ms / 1000 / s.images, steps: s.steps / s.images, stepsPerSec: (s.steps * 1000) / s.ms, ...(s.pixels ? { pixels: s.pixels } : {}), clip: c.task === "video" }];
};

/** What an image or video call made: its recorded count, else one (a call is recorded only once it made something). */
const madeBy = (c: CallInfo): { count: number; clip: boolean } | undefined =>
  c.task === "video" || c.task.startsWith("image.") ? { count: c.images ?? c.sampling?.images ?? 1, clip: c.task === "video" } : undefined;

/** A speech call's recorded seconds of audio, heard (Dictation) or spoken (Read aloud); never the audio or its text. */
const audioOf = (c: CallInfo): number | undefined =>
  c.task.startsWith("speech.") ? (typeof c.audioSeconds === "number" && Number.isFinite(c.audioSeconds) && c.audioSeconds >= 0 ? c.audioSeconds : 0) : undefined;

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
 * An image or video model's `sampling` comes from rows whose host measured the job:
 * medians of seconds per image, steps and steps per second, in clips when its
 * rows are clips. Its `made` adds up the images (or clips) its image and video
 * calls made, in clips when most of those calls were. A speech model's `audioSeconds`
 * adds up the seconds of audio its calls heard or spoke. `calls` gives each row's time, offering, task, output, speed and fallback mark,
 * newest first, for the charts: no thread, note or text. Fallbacks count rows that
 * carry a recorded marker, never what a note says, so they are resolution skips,
 * not retries, failed attempts or errors. Rows outside `[now - 24h, now]`, with a
 * timestamp in the future or unreadable, say nothing and are left out. Nothing is
 * capped: nightly pruning keeps the latest 500 rows per user across pools, so this
 * is retained history, not a complete day's activity. After a reset inside the
 * window (`reset`, the user's last Reset on the card), it starts there instead.
 */
export function modelFacts(calls: CallInfo[], pools: Pool[], now: number = Date.now(), reset?: string): ModelCallFacts {
  const from = reset === undefined ? NaN : Date.parse(reset);
  const since = Number.isFinite(from) && from > now - MODEL_FACTS_WINDOW_MS ? Math.min(from, now) : now - MODEL_FACTS_WINDOW_MS;
  const shown = new Set<Pool>(pools);
  type Group = { id: string; at: number; label: string; endpointName: string; kind: Fact["kind"]; calls: number; speeds: number[]; prompts: number[]; samples: Sample[]; output: number; made: number; madeCalls: number; clips: number; audio: number; audioCalls: number; fallbacks: number };
  const groups = new Map<string, Group>();
  const points: Point[] = [];
  for (const c of calls) {
    if (!shown.has(c.pool)) continue;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    let g = groups.get(c.offeringId);
    if (!g) groups.set(c.offeringId, g = { id: c.offeringId, at, label: c.label, endpointName: c.endpointName, kind: c.kind, calls: 0, speeds: [], prompts: [], samples: [], output: 0, made: 0, madeCalls: 0, clips: 0, audio: 0, audioCalls: 0, fallbacks: 0 });
    // The name it goes by now, from the newest row: labels are kept with old rows for history's sake.
    else if (at > g.at) { g.at = at; g.label = c.label; g.endpointName = c.endpointName; g.kind = c.kind; }
    const [speed] = measuredSpeed(c), [output] = outputOf(c), fallback = hasFallback(c);
    g.calls += 1;
    if (speed !== undefined) g.speeds.push(speed);
    g.prompts.push(...measuredPrompt(c));
    g.samples.push(...sampled(c));
    g.output += output ?? 0;
    const made = madeBy(c);
    if (made) { g.made += made.count; g.madeCalls += 1; if (made.clip) g.clips += 1; }
    const audio = audioOf(c);
    if (audio !== undefined) { g.audio += audio; g.audioCalls += 1; }
    if (fallback) g.fallbacks += 1;
    points.push({ at: new Date(at).toISOString(), offeringId: c.offeringId, task: c.task,
      ...(output !== undefined ? { outputTokens: output } : {}), ...(speed !== undefined ? { tokPerSec: speed } : {}), ...(fallback ? { fallback: true as const } : {}) });
  }
  const models: Fact[] = [...groups.values()].map((g) => {
    const med = median(g.speeds), prompt = median(g.prompts);
    const pixels = median(g.samples.flatMap((s) => (s.pixels ? [s.pixels] : [])));
    const sampling: Fact["sampling"] = g.samples.length ? {
      secondsPer: median(g.samples.map((s) => s.seconds))!, steps: median(g.samples.map((s) => s.steps))!, stepsPerSec: median(g.samples.map((s) => s.stepsPerSec))!,
      ...(pixels !== undefined ? { pixels } : {}), samples: g.samples.length, unit: g.samples.filter((s) => s.clip).length * 2 > g.samples.length ? "clip" : "image",
    } : undefined;
    return {
      offeringId: g.id, label: g.label, endpointName: g.endpointName, kind: g.kind, calls: g.calls,
      ...(med !== undefined ? { medianTokPerSec: med } : {}), speedSamples: g.speeds.length,
      ...(prompt !== undefined ? { medianPromptTokPerSec: prompt } : {}), promptSamples: g.prompts.length,
      ...(sampling ? { sampling } : {}),
      ...(g.madeCalls ? { made: { count: g.made, unit: g.clips * 2 > g.madeCalls ? "clip" as const : "image" as const } } : {}),
      ...(g.audioCalls ? { audioSeconds: Math.round(g.audio * 10) / 10 } : {}),
      outputTokens: g.output, fallbacks: g.fallbacks,
    };
  });
  models.sort((a, b) => a.label.localeCompare(b.label) || a.offeringId.localeCompare(b.offeringId));
  points.sort((a, b) => b.at.localeCompare(a.at));
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), pools: [...pools], models, calls: points };
}
