// Principles 1 and 8: Administration → Status draws what her models did from facts already recorded per call (docs/ux.md,
// Recorded model activity): calls and output per hour, 6 hours or day, each call's speed, calls by task, and a row per
// model copy (an image model's output in images, a speech model's in seconds of audio), over the last 24 hours, 7 or 30
// days, or a span narrowed on the charts.
import { useEffect, useRef, useState } from "react";
import type { ModelCallFacts as Facts } from "./api.ts";
import { drawChart, SERIES, tokens } from "./charts.ts";
import { shortModel } from "./ModelLabel.tsx";
import { TASK_WORD } from "./ModelsFrame.tsx";
import { tokenCount } from "./Project.tsx";
import { clock, ErrorText, timeZone, useAction, useTheme } from "./ui.tsx";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Pixels kept between a speed dot's centre and the plot's edges: its radius and its outline. */
const DOT = 8;
/** More copies than the categorical order holds: the busiest seven keep their colour, the rest are Other. */
const MOST = 8;
const OTHER = "Other";

const SPEED_WHY = "Median recorded output tokens per second of generation, with positive output and at least 50 ms.";
const PROMPT_WHY = "Median recorded prompt tokens read per second, before the first token.";
const FALLBACK_WHY = "Records with a fallback marker: a resolution candidate was skipped. Not errors, retries or failed requests. No marker means no recorded fallback.";
const UNMEASURED = "Not measured: no call in the window recorded a time long enough to mean anything.";
const SAMPLING_WHY = "Median sampling time per image on its host, from ComfyUI's sampler steps; waiting, model loading and decoding aren't counted.";
const NO_PROMPT = "An image model reads no prompt tokens.";
const MADE_WHY = "Images (or clips) its calls made, in place of output tokens.";
const AUDIO_WHY = "Seconds of audio its calls heard (Dictation) or spoke (Read aloud), in place of output tokens.";
const RESET_WHY = "Count calls from now on. Call records stay: thread usage, speeds and history still use them.";
const KEPT_WHY = "Nightly cleanup keeps every call record from the last 31 days, at least the latest 500 and at most 20,000 per user, across both pools.";
const NARROW_WHY = "Drag across the chart, or click two bars, to narrow the window.";

/** The window Model calls shows: the last 24 hours, 7 or 30 days, or a span narrowed on its charts (`span`, ISO). */
export interface FactsWindow { days: 1 | 7 | 30; span?: { from: string; to: string } }
const DAYS: { days: FactsWindow["days"]; label: string; n: number; unit: string }[] = [
  { days: 1, label: "24 h", n: 24, unit: "hours" }, { days: 7, label: "7 d", n: 7, unit: "days" }, { days: 30, label: "30 d", n: 30, unit: "days" },
];

/** The query Status asks with for this window: none for the last 24 hours, lyricad's default. */
export function factsQuery(w: FactsWindow, now = Date.now()): string {
  if (w.span) return `?from=${encodeURIComponent(w.span.from)}&to=${encodeURIComponent(w.span.to)}`;
  return w.days === 1 ? "" : `?from=${encodeURIComponent(new Date(now - w.days * DAY).toISOString())}`;
}

/** An image or video model's speed, for its Speed cell and tooltip: seconds per image with the steps, size and steps per second it ran at. */
export function samplingWords(s: NonNullable<Facts["models"][number]["sampling"]>): { seconds: string; unit: string; title: string } {
  const at = [`${num(s.steps, 0)} ${s.steps === 1 ? "step" : "steps"}`, ...(s.pixels ? [`${num(s.pixels / 1_000_000)} MP`] : []), `${num(s.stepsPerSec)} it/s`].join(" · ");
  return { seconds: s.secondsPer >= 100 ? num(s.secondsPer, 0)! : num(s.secondsPer)!, unit: `s/${s.unit}`, title: `${SAMPLING_WHY} ${at}. ${s.samples} measured.` };
}

export interface Series { offeringId: string; name: string; title: string; color: string }

/**
 * Each model copy's series: its short name (with its endpoint where two share one), its full label as a title, and a
 * colour in the one order, by label so a copy keeps its colour as counts change; past eight, the least used are Other.
 */
export function seriesOf(models: Facts["models"], theme: "dark" | "light", other: string): Series[] {
  const kept = models.length <= MOST ? models : [...models].sort((a, b) => b.calls - a.calls).slice(0, MOST - 1);
  const short = (m: Facts["models"][number]) => shortModel(m.label);
  const dup = (m: Facts["models"][number]) => models.filter((x) => short(x) === short(m)).length > 1;
  let i = 0;
  return models.map((m) => kept.includes(m)
    ? { offeringId: m.offeringId, name: dup(m) ? `${short(m)} · ${m.endpointName}` : short(m), title: `${m.label} · ${m.endpointName}`, color: SERIES[theme][i++]! }
    : { offeringId: m.offeringId, name: OTHER, title: OTHER, color: other });
}

/** A moment as the user's clock reads it, held as if that were UTC: the charts keep their zone, not the browser's. */
export function wall(at: string | number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at));
  const p = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return Date.UTC(p("year"), p("month") - 1, p("day"), p("hour"), p("minute"), p("second"));
}

/** A wall-clock moment back as the instant it names, so a span picked on the charts can be asked for. */
export function unwall(w: number): number {
  const once = w - (wall(w) - w);
  return w - (wall(once) - once);
}

/** How wide one bar is for a window this long: an hour up to a day and a half, 6 hours up to 10 days, else a day. */
export function bucketSize(facts: Pick<Facts, "from" | "until">): number {
  const ms = Date.parse(facts.until) - Date.parse(facts.from);
  return ms <= 36 * HOUR ? HOUR : ms <= 10 * DAY ? 6 * HOUR : DAY;
}

/**
 * The bars the window touches on the user's clock, as the start of each, oldest first: the last is the one under way,
 * and the first holds what came before it (a 24-hour window is 24 hours, 7 days 28 six-hour bars, 30 days 30 days).
 */
export function buckets(facts: Pick<Facts, "from" | "until">, size = bucketSize(facts)): number[] {
  const end = wall(facts.until) - 1, last = end - (end % size);
  const n = Math.max(1, Math.ceil((Date.parse(facts.until) - Date.parse(facts.from)) / size));
  return Array.from({ length: n }, (_, i) => last - (n - 1 - i) * size);
}

/** Calls and output per bar and series: one row each with anything in it. */
export function bucketed(facts: Facts, series: Series[], size = bucketSize(facts)) {
  const name = new Map(series.map((s) => [s.offeringId, s.name]));
  const first = buckets(facts, size)[0]!;
  const rows = new Map<string, { hour: number; model: string; calls: number; tokens: number }>();
  for (const c of facts.calls) {
    const w = wall(c.at), hour = Math.max(first, w - (w % size));
    const model = name.get(c.offeringId) ?? OTHER;
    const key = `${hour}\u0000${model}`;
    const row = rows.get(key) ?? { hour, model, calls: 0, tokens: 0 };
    row.calls += 1;
    row.tokens += c.outputTokens ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Where a bar chart's bars sit, for narrowing on it: the first bar's start, the bar width and how many. */
interface Bars { first: number; size: number; count: number }
type Scale = ((v: number) => number) & { invert: (x: number) => Date | number; range: () => number[] };
type ChartView = { scale: (name: string) => unknown; origin: () => [number, number] };

/**
 * A chart. With `bars`, a bar chart that narrows the window: a mouse drag across it picks the bars it covers, and a
 * click (a tap on a phone, where a drag scrolls the page) marks one bar, the next click the other end; Escape lets go.
 */
export function Chart({ label, spec, bars, onSpan }: { label: string; spec: object; bars?: Bars; onSpan?: (from: number, to: number) => void }) {
  const theme = useTheme();
  const box = useRef<HTMLDivElement>(null), tip = useRef<HTMLDivElement>(null), view = useRef<ChartView>(undefined);
  const [failed, setFailed] = useState("");
  // The bars picked so far, as wall-clock bar starts: a drag under way, or the first of two clicks.
  const [picked, setPicked] = useState<[number, number]>();
  const down = useRef<{ x: number; at: number; drag: boolean; mouse: boolean }>(undefined);
  const key = JSON.stringify(spec);
  useEffect(() => {
    let undo: (() => void) | undefined, live = true;
    const el = box.current!;
    view.current = undefined;
    setPicked(undefined);
    void drawChart(el, tip.current!, JSON.parse(key) as object, theme, (v) => { if (live) view.current = v as unknown as ChartView; })
      .then((u) => { if (live) { undo = u; setFailed(""); } else u(); }, (e: Error) => live && setFailed(e.message));
    return () => { live = false; undo?.(); el.replaceChildren(); };
  }, [key, theme]);
  useEffect(() => {
    if (!picked) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { down.current = undefined; setPicked(undefined); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [picked]);
  const scale = () => view.current?.scale("x") as Scale | undefined;
  /** The bar under a pointer's x, by the chart's own scale: the start of the bar, held to the window's bars. */
  const barAt = (clientX: number): number | undefined => {
    const x = scale(), svg = box.current?.querySelector("svg");
    if (!bars || !x || !svg) return undefined;
    const [lo = 0, hi = 0] = x.range();
    const px = Math.max(lo, Math.min(hi - 1, clientX - svg.getBoundingClientRect().left - view.current!.origin()[0]));
    const w = +x.invert(px), last = bars.first + (bars.count - 1) * bars.size;
    return Math.max(bars.first, Math.min(last, w - ((w - bars.first) % bars.size)));
  };
  const done = (a: number, b: number) => { setPicked(undefined); onSpan?.(Math.min(a, b), Math.max(a, b) + bars!.size); };
  const pointer = bars && onSpan ? {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const at = barAt(e.clientX);
      if (at === undefined) return;
      down.current = { x: e.clientX, at, drag: false, mouse: e.pointerType === "mouse" || e.pointerType === "pen" };
      if (down.current.mouse) e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = down.current;
      if (!d?.mouse || (!d.drag && Math.abs(e.clientX - d.x) < 5)) return;
      d.drag = true;
      const at = barAt(e.clientX);
      if (at !== undefined) setPicked([d.at, at]);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = down.current;
      down.current = undefined;
      if (!d) return;
      const at = barAt(e.clientX) ?? d.at;
      if (d.drag) return done(d.at, at);
      // A click: the first marks a bar, the second picks the span between them; a second click on the marked bar lets go.
      if (picked && picked[0] === picked[1]) return at === picked[0] ? setPicked(undefined) : done(picked[0], at);
      setPicked([at, at]);
    },
    onPointerCancel: () => { down.current = undefined; },
  } : {};
  // The picked bars, tinted over the plot.
  const x = picked ? scale() : undefined, svg = box.current?.querySelector("svg");
  const shade = x && svg && box.current ? (() => {
    const left = svg.getBoundingClientRect().left - box.current.getBoundingClientRect().left + view.current!.origin()[0];
    const a = Math.min(...picked!), b = Math.max(...picked!) + bars!.size;
    return { left: left + x(a), width: Math.max(2, x(b) - x(a)) };
  })() : undefined;
  return <figure className="status-chart">
    <figcaption title={pointer.onPointerDown ? NARROW_WHY : undefined}>{label}</figcaption>
    <div className={pointer.onPointerDown ? "chart-box narrows" : "chart-box"} {...pointer}>
      <div ref={box} />
      {shade && <div className="chart-pick" aria-hidden="true" style={{ left: shade.left, width: shade.width }} />}
      <div ref={tip} className="chart-tip" hidden />
    </div>
    {failed && <p className="meta muted">This chart didn't draw: {failed}</p>}
  </figure>;
}

/** What every chart shares: the container's width, the series' colours, no legend (one stands above them all). */
function base(series: Series[], description: string) {
  const names = [...new Set(series.map((s) => s.name))];
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json", description, width: "container", autosize: { type: "fit-x", contains: "padding" },
    colour: { field: "model", type: "nominal", title: "Model", scale: { domain: names, range: names.map((n) => series.find((s) => s.name === n)!.color) }, legend: null },
  };
}

/** The window's bars as a time scale's domain, from the first bar's start to the last one's end. */
const span = (h: number[], size: number) => [new Date(h[0]!).toISOString(), new Date(h[h.length - 1]! + size).toISOString()];

/** A wall-clock moment as the user reads it: "14:05". */
const hhmm = (w: number) => new Date(w).toISOString().slice(11, 16);
/** A wall-clock day as the user reads it: "3 Nov", or "Mon 3 Nov". */
const day = (w: number, weekday = false) => new Date(w).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", ...(weekday ? { weekday: "short" } : {}) });

/** What a bar's width is called in its chart's name: "hour", "6 hours" or "day". */
export const barWord = (size: number) => size === HOUR ? "hour" : size === DAY ? "day" : "6 hours";

/** The time axis for bars this wide: hours of the clock, else days. */
// The speed plot is narrower than the bars' (its dots keep clear of the edges), so it asks for fewer day labels.
const timeAxis = (size: number, sparse = false) => size === HOUR ? { format: "%H:%M", tickCount: 6, grid: false } : { format: "%-d %b", tickCount: sparse ? 4 : 5, grid: false };

function barSpec(series: Series[], facts: Facts, panel: string, measure: "calls" | "tokens", title: string) {
  const { colour, ...b } = base(series, title);
  const size = bucketSize(facts), h = buckets(facts, size);
  const values = bucketed(facts, series, size).map((r) => ({ ...r,
    hours: size === DAY ? day(r.hour, true) : size === HOUR ? `${hhmm(r.hour)}–${hhmm(r.hour + HOUR)}` : `${day(r.hour)} ${hhmm(r.hour)}–${hhmm(r.hour + size)}` }));
  return {
    ...b, height: 140, data: { values },
    mark: { type: "bar", stroke: panel, strokeWidth: 1, cornerRadiusEnd: 2 },
    encoding: {
      x: { field: "hour", type: "temporal", title: null, scale: { type: "utc", domain: span(h, size) }, axis: timeAxis(size),
        timeUnit: size === HOUR ? "utcyearmonthdatehours" : size === DAY ? "utcyearmonthdate" : { unit: "utcyearmonthdatehours", step: 6 } },
      y: { field: measure, type: "quantitative", title: null, axis: { tickMinStep: 1, tickCount: 4, ...(measure === "calls" ? { format: "d" } : { labelExpr: "datum.value === 0 ? '0' : format(datum.value, '~s')" }) } },
      color: colour,
      tooltip: [{ field: "hours", title: size === DAY ? "Day" : size === HOUR ? "Hour" : "Hours" }, { field: "model", title: "Model" }, { field: measure, title: measure === "calls" ? "Calls" : "Output tokens", format: "," }],
    },
  };
}

/**
 * Each call's speed as a dot. The time axis starts at the window's start when that comes before the first whole hour
 * (the hourly charts fold those calls into it), so no dot lands left of the axis; both scales keep a dot's width
 * clear of the axes and their labels.
 */
export function speedSpec(series: Series[], facts: Facts, panel: string) {
  const { colour, ...b } = base(series, "Speed per call, in output tokens per second");
  const name = new Map(series.map((s) => [s.offeringId, s.name]));
  const size = bucketSize(facts), h = buckets(facts, size);
  const values = facts.calls.filter((c) => c.tokPerSec !== undefined).map((c) => {
    const w = wall(c.at);
    return { at: w, time: size === HOUR ? hhmm(w) : `${day(w)} ${hhmm(w)}`, model: name.get(c.offeringId) ?? OTHER, speed: c.tokPerSec, task: TASK_WORD[c.task] ?? c.task };
  });
  // Past a day the dots shrink and let the ones beneath show, so a busy month stays readable.
  const dot = size === HOUR ? { size: 64, opacity: 1 } : size === DAY ? { size: 25, opacity: 0.7 } : { size: 36, opacity: 0.85 };
  return {
    ...b, height: 140, data: { values },
    mark: { type: "point", filled: true, ...dot, stroke: panel, strokeWidth: size === HOUR ? 1.5 : 1 },
    encoding: {
      x: { field: "at", type: "temporal", title: null, scale: { type: "utc", domain: [new Date(Math.min(h[0]!, wall(facts.since))).toISOString(), span(h, size)[1]], padding: DOT }, axis: timeAxis(size, true) },
      y: { field: "speed", type: "quantitative", title: null, scale: { padding: DOT }, axis: { tickCount: 4 } },
      color: colour,
      tooltip: [{ field: "time", title: "Time" }, { field: "model", title: "Model" }, { field: "task", title: "Task" }, { field: "speed", title: "tok/s", format: ",.1f" }],
    },
  };
}

function taskSpec(series: Series[], facts: Facts, panel: string) {
  const { colour, ...b } = base(series, "Calls by task");
  const name = new Map(series.map((s) => [s.offeringId, s.name]));
  const rows = new Map<string, { task: string; model: string; calls: number }>();
  for (const c of facts.calls) {
    const task = TASK_WORD[c.task] ?? c.task, model = name.get(c.offeringId) ?? OTHER, key = `${task}\u0000${model}`;
    rows.set(key, { task, model, calls: (rows.get(key)?.calls ?? 0) + 1 });
  }
  const tasks = new Set([...rows.values()].map((r) => r.task));
  return {
    ...b, height: { step: 22 }, data: { values: [...rows.values()] },
    mark: { type: "bar", stroke: panel, strokeWidth: 1, cornerRadiusEnd: 2 },
    encoding: {
      y: { field: "task", type: "nominal", title: null, sort: "-x", axis: { labelLimit: 140 } },
      x: { field: "calls", type: "quantitative", title: null, axis: { tickMinStep: 1, format: "d", tickCount: Math.min(4, tasks.size + 1) } },
      color: colour,
      tooltip: [{ field: "task", title: "Task" }, { field: "model", title: "Model" }, { field: "calls", title: "Calls" }],
    },
  };
}

/** Seconds of audio as its Output cell reads them: "42.5 s", "3.2 min" or "1.4 h", the unit apart to be muted. */
export function audioWords(seconds: number): { amount: string; unit: string } {
  return seconds >= 3600 ? { amount: num(seconds / 3600)!, unit: "h audio" } : seconds >= 60 ? { amount: num(seconds / 60)!, unit: "min audio" } : { amount: num(seconds)!, unit: "s audio" };
}

const num = (n: number | undefined, digits = 1) => n === undefined ? undefined : n.toLocaleString(undefined, { maximumFractionDigits: digits });

/**
 * A moment on the user's clock with its day, day first as the axes and tips read it: "3 Nov 14:00", digits in mono.
 * With `today`, a moment today is its time alone.
 */
function Stamp({ at, today = false }: { at: string; today?: boolean }) {
  const w = wall(at), [d, month] = day(w).split(" ");
  if (today && day(w) === day(wall(Date.now()))) return <span className="num">{clock(at)}</span>;
  return <><span className="num">{d}</span> {month} <span className="num">{clock(at)}</span></>;
}

/**
 * What her models did in the window (the last 24 hours, 7 or 30 days, or a span narrowed on the charts), or since the
 * user's Reset: a facts line, one legend, four charts and a row per model copy. `onWindow` picks another window and
 * `onReset` restarts the count from now and reloads.
 */
export function ModelCallFacts({ facts, window = { days: 1 }, onWindow, onReset }: { facts: Facts; window?: FactsWindow; onWindow?: (w: FactsWindow) => void; onReset?: () => Promise<unknown> }) {
  const theme = useTheme();
  const [act, busy, error] = useAction();
  // A Reset inside the window starts it later: the head says since when.
  const reset = Date.parse(facts.since) > Date.parse(facts.from);
  // No page (a test rendering to a string): the light tokens.
  const t = typeof document === "undefined" ? { edge: "#889494", panel: "#ffffff" } : tokens();
  const series = seriesOf(facts.models, theme, t.edge);
  const legend = [...new Map(series.map((s) => [s.name, s])).values()];
  const total = { calls: facts.models.reduce((n, m) => n + m.calls, 0), tokens: facts.models.reduce((n, m) => n + m.outputTokens, 0), fallbacks: facts.models.reduce((n, m) => n + m.fallbacks, 0) };
  const size = bucketSize(facts), h = buckets(facts, size);
  const bars = { first: h[0]!, size, count: h.length };
  const narrow = onWindow ? (a: number, b: number) => onWindow({ days: window.days, span: { from: new Date(unwall(a)).toISOString(), to: new Date(unwall(b)).toISOString() } }) : undefined;
  const last = DAYS.find((d) => d.days === window.days)!;
  const per = barWord(size);
  return <section aria-label="Model calls" className="card model-calls">
    <div className="section-head">
      <h2 title="Your own retained call records in displayed pools, across all recorded tasks. A turn's retries replace its record; tool requests update its pace. Claude Code relay totals are not call records. Deleted and pruned records are excluded.">Model calls · {window.span
        ? <><Stamp at={facts.since} /> – <Stamp at={facts.until} /></>
        : reset ? <>since <Stamp at={facts.since} today /></>
        : <>last <span className="num">{last.n}</span> {last.unit}</>}</h2>
      {onWindow && <div className="seg calls-window" role="group" aria-label="Window">
        {DAYS.map((d) => <button key={d.days} type="button" aria-label={`Last ${d.n} ${d.unit}`} title={`Last ${d.n} ${d.unit}`} aria-pressed={!window.span && window.days === d.days} onClick={() => onWindow({ days: d.days })}>{d.label}</button>)}
      </div>}
      {onWindow && window.span && <button type="button" className="link" title={`Back to the last ${last.n} ${last.unit}.`} onClick={() => onWindow({ days: window.days })}>Clear</button>}
      {onReset && <button type="button" className="link" title={RESET_WHY} disabled={busy} onClick={() => void act(onReset)}>Reset</button>}
    </div>
    {error && <ErrorText error={error} />}
    <p className="muted" title={KEPT_WHY}>Retained history · {facts.pools.map((p) => p === "general" ? "General" : "Private").join(" and ") || "No pools shown"} · kept <span className="num">31</span> days</p>
    {facts.models.length ? <>
      <p><span className="num">{total.calls.toLocaleString()}</span> {total.calls === 1 ? "call" : "calls"} · <span className="num">{tokenCount(total.tokens)}</span> output tokens · <span title={FALLBACK_WHY}>Recorded fallbacks</span> <span className="num">{total.fallbacks}</span></p>
      {legend.length > 1 && <ul className="chart-legend" aria-label="Models">
        {legend.map((s) => <li key={s.name} title={s.title}><span className="swatch" style={{ background: s.color }} aria-hidden="true" />{s.name}</li>)}
      </ul>}
      <div className="status-charts">
        <Chart label={`Calls per ${per}`} spec={barSpec(series, facts, t.panel, "calls", `Calls per ${per}`)} bars={bars} onSpan={narrow} />
        <Chart label={`Output tokens per ${per}`} spec={barSpec(series, facts, t.panel, "tokens", `Output tokens per ${per}`)} bars={bars} onSpan={narrow} />
        <Chart label="Speed per call · tok/s" spec={speedSpec(series, facts, t.panel)} />
        <Chart label="Calls by task" spec={taskSpec(series, facts, t.panel)} />
      </div>
      <div className="model-table" role="table" aria-label="Model calls by model">
        <div role="row" className="mt-head muted">
          <span role="columnheader">Model</span><span role="columnheader">Calls</span><span role="columnheader">Output</span>
          <span role="columnheader" title={SPEED_WHY}>Speed</span><span role="columnheader" title={PROMPT_WHY}>Prompt</span><span role="columnheader" title={FALLBACK_WHY}>Fallbacks</span>
        </div>
        {facts.models.map((m) => {
          const s = series.find((x) => x.offeringId === m.offeringId)!;
          const speed = num(m.medianTokPerSec), prompt = num(m.medianPromptTokPerSec, 0);
          const sampled = speed === undefined && m.sampling ? samplingWords(m.sampling) : undefined;
          const audio = m.audioSeconds !== undefined && !m.outputTokens ? audioWords(m.audioSeconds) : undefined;
          return <div role="row" key={m.offeringId}>
            <span role="cell" className="mt-model" title={`${m.label} · ${m.endpointName}`}><span className="swatch" style={{ background: s.color }} aria-hidden="true" />{shortModel(m.label)} <span className="muted">· {m.endpointName}</span></span>
            <span role="cell" className="num" data-label="Calls">{m.calls}</span>
            <span role="cell" className="num" data-label="Output" title={m.made && !m.outputTokens ? MADE_WHY : audio ? AUDIO_WHY : undefined}>{m.made && !m.outputTokens
              ? <>{m.made.count.toLocaleString()} <span className="muted">{m.made.count === 1 ? m.made.unit : `${m.made.unit}s`}</span></>
              : audio ? <>{audio.amount} <span className="muted">{audio.unit}</span></>
              : tokenCount(m.outputTokens)}</span>
            <span role="cell" className="num" data-label="Speed" title={sampled ? sampled.title : speed === undefined ? UNMEASURED : `${SPEED_WHY} ${m.speedSamples} measured.`}>{sampled ? <>{sampled.seconds} <span className="muted">{sampled.unit}</span></> : speed === undefined ? <span className="muted">—</span> : <>{speed} <span className="muted">tok/s</span></>}</span>
            <span role="cell" className="num" data-label="Prompt" title={prompt === undefined ? (sampled ? NO_PROMPT : UNMEASURED) : `${PROMPT_WHY} ${m.promptSamples} measured.`}>{prompt === undefined ? <span className="muted">—</span> : <>{prompt} <span className="muted">tok/s</span></>}</span>
            <span role="cell" className="num" data-label="Fallbacks">{m.fallbacks}</span>
          </div>;
        })}
      </div>
    </> : <p className="muted">{window.span ? <>No calls in this window.</> : reset ? <>No calls since <Stamp at={facts.since} today />.</> : <>No retained calls in the last <span className="num">{last.n}</span> {last.unit}.</>}</p>}
  </section>;
}
