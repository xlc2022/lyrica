// Principles 1 and 8: Administration → Status draws what her models did from facts already recorded per call (docs/ux.md,
// Recorded model activity): calls and output per hour, each call's speed, calls by task, and a row per model copy.
import { useEffect, useRef, useState } from "react";
import type { ModelCallFacts as Facts } from "./api.ts";
import { drawChart, SERIES, tokens } from "./charts.ts";
import { shortModel } from "./ModelLabel.tsx";
import { TASK_WORD } from "./ModelsFrame.tsx";
import { tokenCount } from "./Project.tsx";
import { timeZone, useTheme } from "./ui.tsx";

const HOUR = 3_600_000;
/** More copies than the categorical order holds: the busiest seven keep their colour, the rest are Other. */
const MOST = 8;
const OTHER = "Other";

const SPEED_WHY = "Median recorded output tokens per second of generation, with positive output and at least 50 ms.";
const PROMPT_WHY = "Median recorded prompt tokens read per second, before the first token.";
const FALLBACK_WHY = "Records with a fallback marker: a resolution candidate was skipped. Not errors, retries or failed requests. No marker means no recorded fallback.";
const UNMEASURED = "Not measured: no call in the window recorded a time long enough to mean anything.";

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

/** The hours the window touches on the user's clock, as the start of each, oldest first: the last is the hour under way. */
export function hours(until: string): number[] {
  const end = wall(until);
  return Array.from({ length: 24 }, (_, i) => end - (end % HOUR) - (23 - i) * HOUR);
}

/** Calls and output per hour and series: one row each with anything in it. */
export function hourly(facts: Facts, series: Series[]) {
  const name = new Map(series.map((s) => [s.offeringId, s.name]));
  const first = hours(facts.until)[0]!;
  const rows = new Map<string, { hour: number; model: string; calls: number; tokens: number }>();
  for (const c of facts.calls) {
    const w = wall(c.at), hour = Math.max(first, w - (w % HOUR));
    const model = name.get(c.offeringId) ?? OTHER;
    const key = `${hour}\u0000${model}`;
    const row = rows.get(key) ?? { hour, model, calls: 0, tokens: 0 };
    row.calls += 1;
    row.tokens += c.outputTokens ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()];
}

function Chart({ label, spec }: { label: string; spec: object }) {
  const theme = useTheme();
  const box = useRef<HTMLDivElement>(null), tip = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState("");
  const key = JSON.stringify(spec);
  useEffect(() => {
    let undo: (() => void) | undefined, live = true;
    const el = box.current!;
    void drawChart(el, tip.current!, JSON.parse(key) as object, theme).then((u) => { if (live) { undo = u; setFailed(""); } else u(); }, (e: Error) => live && setFailed(e.message));
    return () => { live = false; undo?.(); el.replaceChildren(); };
  }, [key, theme]);
  return <figure className="status-chart">
    <figcaption>{label}</figcaption>
    <div className="chart-box"><div ref={box} /><div ref={tip} className="chart-tip" hidden /></div>
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

/** The window's hours as a time scale's domain, from the first hour's start to the last one's end. */
const span = (h: number[]) => [new Date(h[0]!).toISOString(), new Date(h[23]! + HOUR).toISOString()];

/** A wall-clock moment as the user reads it: "14:05". */
const hhmm = (w: number) => new Date(w).toISOString().slice(11, 16);

function hourlySpec(series: Series[], facts: Facts, panel: string, measure: "calls" | "tokens", title: string) {
  const { colour, ...b } = base(series, title);
  const h = hours(facts.until);
  const values = hourly(facts, series).map((r) => ({ ...r, hours: `${hhmm(r.hour)}–${hhmm(r.hour + HOUR)}` }));
  return {
    ...b, height: 140, data: { values },
    mark: { type: "bar", stroke: panel, strokeWidth: 1, cornerRadiusEnd: 2 },
    encoding: {
      x: { field: "hour", type: "temporal", timeUnit: "utcyearmonthdatehours", title: null, scale: { type: "utc", domain: span(h) }, axis: { format: "%H:%M", tickCount: 6, grid: false } },
      y: { field: measure, type: "quantitative", title: null, axis: { tickMinStep: 1, tickCount: 4, ...(measure === "calls" ? { format: "d" } : { labelExpr: "datum.value === 0 ? '0' : format(datum.value, '~s')" }) } },
      color: colour,
      tooltip: [{ field: "hours", title: "Hour" }, { field: "model", title: "Model" }, { field: measure, title: measure === "calls" ? "Calls" : "Output tokens", format: "," }],
    },
  };
}

function speedSpec(series: Series[], facts: Facts, panel: string) {
  const { colour, ...b } = base(series, "Speed per call, in output tokens per second");
  const name = new Map(series.map((s) => [s.offeringId, s.name]));
  const h = hours(facts.until);
  const values = facts.calls.filter((c) => c.tokPerSec !== undefined).map((c) => ({ at: wall(c.at), time: hhmm(wall(c.at)), model: name.get(c.offeringId) ?? OTHER, speed: c.tokPerSec, task: TASK_WORD[c.task] ?? c.task }));
  return {
    ...b, height: 140, data: { values },
    mark: { type: "point", filled: true, size: 64, opacity: 1, stroke: panel, strokeWidth: 1.5 },
    encoding: {
      x: { field: "at", type: "temporal", title: null, scale: { type: "utc", domain: span(h) }, axis: { format: "%H:%M", tickCount: 6, grid: false } },
      y: { field: "speed", type: "quantitative", title: null, axis: { tickCount: 4 } },
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

const num = (n: number | undefined, digits = 1) => n === undefined ? undefined : n.toLocaleString(undefined, { maximumFractionDigits: digits });

/** What her models did in the last 24 hours: a facts line, one legend, four charts and a row per model copy. */
export function ModelCallFacts({ facts }: { facts: Facts }) {
  const theme = useTheme();
  // No page (a test rendering to a string): the light tokens.
  const t = typeof document === "undefined" ? { edge: "#889494", panel: "#ffffff" } : tokens();
  const series = seriesOf(facts.models, theme, t.edge);
  const legend = [...new Map(series.map((s) => [s.name, s])).values()];
  const total = { calls: facts.models.reduce((n, m) => n + m.calls, 0), tokens: facts.models.reduce((n, m) => n + m.outputTokens, 0), fallbacks: facts.models.reduce((n, m) => n + m.fallbacks, 0) };
  return <section aria-label="Model calls" className="model-calls">
    <h3 style={{ fontSize: 15 }} title="Your own retained call records in displayed pools, across all recorded tasks. A turn's retries replace its record; tool requests update its pace. Claude Code relay totals are not call records. Deleted and pruned records are excluded.">Model calls · last <span className="num">24</span> hours</h3>
    <p className="muted" title="Nightly pruning keeps the latest 500 records across both pools. Earlier calls within these 24 hours may be missing; counts are not complete daily activity.">Retained history · {facts.pools.map((p) => p === "general" ? "General" : "Private").join(" and ") || "No pools shown"} · pruned to latest <span className="num">500</span> records per user</p>
    {facts.models.length ? <>
      <p><span className="num">{total.calls.toLocaleString()}</span> {total.calls === 1 ? "call" : "calls"} · <span className="num">{tokenCount(total.tokens)}</span> output tokens · <span title={FALLBACK_WHY}>Recorded fallbacks</span> <span className="num">{total.fallbacks}</span></p>
      {legend.length > 1 && <ul className="chart-legend" aria-label="Models">
        {legend.map((s) => <li key={s.name} title={s.title}><span className="swatch" style={{ background: s.color }} aria-hidden="true" />{s.name}</li>)}
      </ul>}
      <div className="status-charts">
        <Chart label="Calls per hour" spec={hourlySpec(series, facts, t.panel, "calls", "Calls per hour")} />
        <Chart label="Output tokens per hour" spec={hourlySpec(series, facts, t.panel, "tokens", "Output tokens per hour")} />
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
          return <div role="row" key={m.offeringId}>
            <span role="cell" className="mt-model" title={`${m.label} · ${m.endpointName}`}><span className="swatch" style={{ background: s.color }} aria-hidden="true" />{shortModel(m.label)} <span className="muted">· {m.endpointName}</span></span>
            <span role="cell" className="num" data-label="Calls">{m.calls}</span>
            <span role="cell" className="num" data-label="Output">{tokenCount(m.outputTokens)}</span>
            <span role="cell" className="num" data-label="Speed" title={speed === undefined ? UNMEASURED : `${SPEED_WHY} ${m.speedSamples} measured.`}>{speed === undefined ? <span className="muted">—</span> : <>{speed} <span className="muted">tok/s</span></>}</span>
            <span role="cell" className="num" data-label="Prompt" title={prompt === undefined ? UNMEASURED : `${PROMPT_WHY} ${m.promptSamples} measured.`}>{prompt === undefined ? <span className="muted">—</span> : <>{prompt} <span className="muted">tok/s</span></>}</span>
            <span role="cell" className="num" data-label="Fallbacks">{m.fallbacks}</span>
          </div>;
        })}
      </div>
    </> : <p className="muted">No retained calls in the last <span className="num">24</span> hours.</p>}
  </section>;
}
