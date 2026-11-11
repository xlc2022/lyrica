// Principles 5 and 6: Administration → Status's Memory use card (docs/ux.md, Memory use): how often she reached the
// administrator's own notes and pages, as uses per day and the most used, and which memories most others cite.
import { useState } from "react";
import type { AdminMemoryUse, MemoryUseRow } from "./api.ts";
import { SERIES, tokens } from "./charts.ts";
import { Chart, wall } from "./ModelCallFacts.tsx";
import { recalledHref } from "./route.ts";
import { useTheme } from "./ui.tsx";

const DAY = 86_400_000;
/** The three ways she reaches a memory, in the one categorical order. */
const HOW = [
  { key: "recalled", word: "Recalled", why: "Times automatic recall brought it into a turn." },
  { key: "searched", word: "Searched", why: "Times her recall tool found it." },
  { key: "opened", word: "Opened", why: "Times she opened it whole." },
] as const;
const CITED_WHY = "Notes, pages and journal entries that cite it now: how much else she has built on it.";
const HEAD_WHY = "How often she reached your own notes and pages in the pools you show: brought up by automatic recall, found by her recall tool, or opened. Sleep and threads that aren't remembered don't count.";
const KEPT_WHY = "Each pool keeps these counts per hour for 31 days: numbers and memory IDs only, never what was asked.";
/** A bar's name in the Most used chart, at most this many characters (the whole line is in its tip). */
const SHORT = 36;

const total = (r: { recalled: number; searched: number; opened: number }) => r.recalled + r.searched + r.opened;
const short = (s: string) => s.length > SHORT ? `${s.slice(0, SHORT - 1).trimEnd()}…` : s;
const dayWord = (w: number) => new Date(w).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

function colour(theme: "dark" | "light") {
  return { field: "how", type: "nominal", title: null, scale: { domain: HOW.map((h) => h.word), range: SERIES[theme].slice(0, HOW.length) }, legend: null };
}

/** Uses per day on the user's clock, stacked by how she reached them, a bar for every day of the window. */
export function perDaySpec(use: AdminMemoryUse, theme: "dark" | "light", panel: string, now = Date.now()) {
  const first = wall(use.since) - (wall(use.since) % DAY), last = wall(now) - (wall(now) % DAY);
  const days = new Map<number, Record<string, number>>();
  for (const h of use.hours) {
    const w = wall(h.hour), d = w - (w % DAY), row = days.get(d) ?? {};
    for (const how of HOW) row[how.word] = (row[how.word] ?? 0) + h[how.key];
    days.set(d, row);
  }
  const values = [...days].flatMap(([d, row]) => HOW.filter((h) => row[h.word]).map((h) => ({ day: d, when: dayWord(d), how: h.word, uses: row[h.word] })));
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json", description: "Uses per day", width: "container", autosize: { type: "fit-x", contains: "padding" },
    height: 140, data: { values },
    mark: { type: "bar", stroke: panel, strokeWidth: 1, cornerRadiusEnd: 2 },
    encoding: {
      x: { field: "day", type: "temporal", title: null, timeUnit: "utcyearmonthdate", scale: { type: "utc", domain: [new Date(first).toISOString(), new Date(last + DAY).toISOString()] }, axis: { format: "%-d %b", tickCount: 5, grid: false } },
      y: { field: "uses", type: "quantitative", title: null, aggregate: "sum", axis: { tickMinStep: 1, format: "d", tickCount: 4 } },
      color: colour(theme),
      tooltip: [{ field: "when", title: "Day" }, { field: "how", title: "How" }, { field: "uses", title: "Uses", aggregate: "sum" }],
    },
  };
}

/** The most used memories as horizontal bars, stacked by how, most first. */
export function topSpec(rows: MemoryUseRow[], theme: "dark" | "light", panel: string) {
  // Two memories can share a first line: each bar keeps its own name.
  const names = new Map<string, string>();
  for (const r of rows) {
    let name = short(r.label) || r.id;
    while ([...names.values()].includes(name)) name += " ";
    names.set(`${r.pool}/${r.id}`, name);
  }
  const values = rows.flatMap((r) => HOW.filter((h) => r[h.key]).map((h) => ({ memory: names.get(`${r.pool}/${r.id}`), whole: r.label, how: h.word, uses: r[h.key] })));
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json", description: "Most used memories", width: "container", autosize: { type: "fit-x", contains: "padding" },
    height: { step: 22 }, data: { values },
    mark: { type: "bar", stroke: panel, strokeWidth: 1, cornerRadiusEnd: 2 },
    encoding: {
      y: { field: "memory", type: "nominal", title: null, sort: "-x", axis: { labelLimit: 180 } },
      x: { field: "uses", type: "quantitative", title: null, aggregate: "sum", axis: { tickMinStep: 1, format: "d", tickCount: 4 } },
      color: colour(theme),
      tooltip: [{ field: "whole", title: "Memory" }, { field: "how", title: "How" }, { field: "uses", title: "Uses", aggregate: "sum" }],
    },
  };
}

/** The Memory use card: the window's uses per day and most used memories, then the most used or most cited as rows. */
export function MemoryUse({ use, userId, onDays }: { use: AdminMemoryUse; userId: string; onDays?: (days: 7 | 30) => void }) {
  const theme = useTheme();
  const [list, setList] = useState<"top" | "cited">(() => use.top.length || !use.cited.length ? "top" : "cited");
  // No page (a test rendering to a string): the light tokens.
  const panel = typeof document === "undefined" ? "#ffffff" : tokens().panel;
  const uses = use.hours.reduce((n, h) => n + total(h), 0);
  const rows = list === "top" ? use.top : use.cited;
  const both = use.pools.length > 1;
  return <section aria-label="Memory use" className="card model-calls memory-use">
    <div className="section-head">
      <h2 title={HEAD_WHY}>Memory use · last <span className="num">{use.days}</span> days</h2>
      {onDays && <div className="seg calls-window" role="group" aria-label="Window">
        {([7, 30] as const).map((d) => <button key={d} type="button" aria-label={`Last ${d} days`} title={`Last ${d} days`} aria-pressed={use.days === d} onClick={() => onDays(d)}>{d} d</button>)}
      </div>}
    </div>
    <p className="muted" title={KEPT_WHY}>{use.pools.map((p) => p === "general" ? "General" : "Private").join(" and ") || "No pools shown"} · kept <span className="num">31</span> days</p>
    {uses ? <>
      <p><span className="num">{uses.toLocaleString()}</span> {uses === 1 ? "use" : "uses"} · <span className="num">{use.memories.toLocaleString()}</span> {use.memories === 1 ? "memory" : "memories"}</p>
      <ul className="chart-legend" aria-label="How">
        {HOW.map((h, i) => <li key={h.key} title={h.why}><span className="swatch" style={{ background: SERIES[theme][i] }} aria-hidden="true" />{h.word}</li>)}
      </ul>
      <div className="status-charts">
        <Chart label="Uses per day" spec={perDaySpec(use, theme, panel)} />
        <Chart label="Most used" spec={topSpec(use.top, theme, panel)} />
      </div>
    </> : <p className="muted">Nothing used in the last <span className="num">{use.days}</span> days.</p>}
    {(use.top.length > 0 || use.cited.length > 0) && <>
      <div className="seg memory-use-list" role="group" aria-label="List">
        <button type="button" aria-pressed={list === "top"} title={`The ${use.top.length || 10} she reached most in the window.`} onClick={() => setList("top")}>Most used</button>
        <button type="button" aria-pressed={list === "cited"} title="The ten that most other memories cite now, whatever the window." onClick={() => setList("cited")}>Most cited</button>
      </div>
      {rows.length ? <div className="model-table memory-use-table" role="table" aria-label={list === "top" ? "Most used memories" : "Most cited memories"}>
        <div role="row" className="mt-head muted">
          <span role="columnheader">Memory</span>
          {HOW.map((h) => <span key={h.key} role="columnheader" title={h.why}>{h.word}</span>)}
          <span role="columnheader" title={CITED_WHY}>Cited by</span>
        </div>
        {rows.map((r) => <div role="row" key={`${r.pool}/${r.id}`}>
          <span role="cell" className="mt-model"><a href={recalledHref(userId, r.pool, r.id)} title={r.id}>{r.label || r.id}</a> <span className="muted">· {r.kind}{both ? `, ${r.pool}` : ""}</span></span>
          {HOW.map((h) => <span key={h.key} role="cell" className="num" data-label={h.word}>{r[h.key]}</span>)}
          <span role="cell" className="num" data-label="Cited by">{r.citedBy}</span>
        </div>)}
      </div> : <p className="muted">{list === "top" ? <>Nothing used in the last <span className="num">{use.days}</span> days.</> : "No memory cites another yet."}</p>}
    </>}
  </section>;
}
