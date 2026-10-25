import { useEffect, useRef, useState } from "react";
import uPlot, { type BBox } from "uplot";
import { get, u, type ModelTelemetry, type TelemetryRange, type Task } from "./api.ts";
import { useLoad } from "./ui.tsx";

const RANGES: { value: TelemetryRange; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

const toTypedArray = (arr: number[]): Float64Array => new Float64Array(arr);
const toCategoryArray = (arr: string[]): Float64Array => new Float64Array(arr.map((_, i) => i));

const donutPathBuilder = (values: number[]): uPlot.Series.PathBuilder => {
  return (u, _seriesIdx, _idx0, _idx1) => {
    const total = values.reduce((a, b) => a + b, 0);
    const bbox = u.bbox!;
    const left = bbox.left as number;
    const top = bbox.top as number;
    const width = bbox.width as number;
    const height = bbox.height as number;
    const cx = left + width / 2;
    const cy = top + height / 2;
    const r = Math.min(width, height) / 2 - 10;
    const strokePath = new Path2D();
    const fillPath = new Path2D();
    let angle = -Math.PI / 2;
    for (let i = 0; i < values.length; i++) {
      const slice = (values[i]! / total) * 2 * Math.PI;
      const x = cx + Math.cos(angle + slice) * r;
      const y = cy + Math.sin(angle + slice) * r;
      if (i === 0) {
        fillPath.moveTo(cx, cy);
        strokePath.moveTo(x, y);
      } else {
        fillPath.lineTo(cx, cy);
      }
      fillPath.arc(cx, cy, r, angle, angle + slice);
      strokePath.arc(cx, cy, r, angle, angle + slice);
      angle += slice;
    }
    fillPath.closePath();
    strokePath.closePath();
    return { stroke: strokePath, fill: fillPath };
  };
};

const barPathBuilder = (rates: number[], labels: string[]): uPlot.Series.PathBuilder => {
  return (u, _seriesIdx, _idx0, _idx1) => {
    const bbox = u.bbox!;
    const left = bbox.left as number;
    const top = bbox.top as number;
    const width = bbox.width as number;
    const height = bbox.height as number;
    const strokePath = new Path2D();
    const fillPath = new Path2D();
    const bx = left + 10;
    const bw = Math.max(1, (width - 20) / labels.length - 4);
    for (let i = 0; i < rates.length; i++) {
      const h = (rates[i]! / 100) * height;
      const x = bx + i * (bw + 4);
      const y = top + height - h;
      fillPath.moveTo(x, top + height);
      fillPath.lineTo(x, y);
      fillPath.lineTo(x + bw, y);
      fillPath.lineTo(x + bw, top + height);
      fillPath.closePath();
      strokePath.moveTo(x, top + height);
      strokePath.lineTo(x, y);
      strokePath.lineTo(x + bw, y);
      strokePath.lineTo(x + bw, top + height);
    }
    return { stroke: strokePath, fill: fillPath };
  };
};

export function ModelTelemetryCard() {
  const [range, setRange] = useState<TelemetryRange>("24h");
  const telemetry = useLoad<ModelTelemetry>(() => get(u("admin", "telemetry", "models")), [range]);
  const donutRef = useRef<HTMLDivElement>(null);
  const sparklineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const areaRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const uplots = useRef<uPlot[]>([]);

  useEffect(() => {
    if (!telemetry.data) return;
    const { assignments, latency, throughput, errors } = telemetry.data;

    // Donut: assignments by task
    if (donutRef.current) {
      const taskCounts = new Map<string, number>();
      for (const a of assignments) taskCounts.set(a.task, (taskCounts.get(a.task) ?? 0) + 1);
      const labels = Array.from(taskCounts.keys());
      const values = labels.map((t) => taskCounts.get(t)!);
      const data: uPlot.AlignedData = [
        toCategoryArray(labels),
        toTypedArray(values),
      ];
      const opts: uPlot.Options = {
        width: 200,
        height: 200,
        title: "Assignments by Task",
        series: [
          {},
          {
            label: "Count",
            stroke: "var(--accent)",
            width: 2,
            fill: "color-mix(in oklab, var(--accent) 15%, transparent)",
            paths: donutPathBuilder(values),
            points: { show: false },
          },
        ],
      };
      const plot = new uPlot(opts, data, donutRef.current);
      uplots.current.push(plot);
    }

    // Sparklines: latency p50/p95/p99 per task
    for (let i = 0; i < latency.length; i++) {
      const l = latency[i];
      if (!l) continue;
      const ref = sparklineRefs.current[i];
      if (ref) {
        const xVals = [0, 1, 2];
        const data: uPlot.AlignedData = [
          toTypedArray(xVals),
          toTypedArray([l.p50, l.p95, l.p99]),
        ];
        const opts: uPlot.Options = {
          width: 320,
          height: 100,
          title: `${l.task} latency (ms)`,
          axes: [
            { space: 0, show: false },
            { space: 30, size: 40, grid: { stroke: "var(--line)" }, ticks: { size: 4 } },
          ],
          series: [
            {},
            { stroke: "var(--accent)", width: 2, fill: "none", points: { show: true, size: 4 } },
            { stroke: "var(--warn)", width: 1, fill: "none", points: { show: true, size: 3 }, dash: [4, 2] },
            { stroke: "var(--danger)", width: 1, fill: "none", points: { show: true, size: 3 }, dash: [2, 2] },
          ],
          scales: { x: { time: false }, y: { min: 0 } },
          cursor: { show: false },
        };
        const plot = new uPlot(opts, data, ref);
        uplots.current.push(plot);
      }
    }

    // Area chart: throughput in/out per task
    if (areaRef.current && throughput.length > 0) {
      const labels = throughput.map((t) => t.task);
      const input = throughput.map((t) => t.inputPerSec);
      const output = throughput.map((t) => t.outputPerSec);
      const data: uPlot.AlignedData = [
        toCategoryArray(labels),
        toTypedArray(input),
        toTypedArray(output),
      ];
      const opts: uPlot.Options = {
        width: 320,
        height: 160,
        title: "Token Throughput (tok/s)",
        axes: [
          { space: 0 },
          { space: 30, size: 50, grid: { stroke: "var(--line)" }, ticks: { size: 4 } },
        ],
        series: [
          {},
          { label: "Input", stroke: "var(--info)", width: 2, fill: "color-mix(in oklab, var(--info) 15%, transparent)" },
          { label: "Output", stroke: "var(--accent)", width: 2, fill: "color-mix(in oklab, var(--accent) 15%, transparent)" },
        ],
        scales: { x: { time: false }, y: { min: 0 } },
        cursor: { show: false },
      };
      const plot = new uPlot(opts, data, areaRef.current);
      uplots.current.push(plot);
    }

    // Stacked bar: error rate by model
    if (barRef.current && errors.length > 0) {
      const labels = errors.map((e) => e.model);
      const rates = errors.map((e) => e.rate * 100);
      const data: uPlot.AlignedData = [
        toCategoryArray(labels),
        toTypedArray(rates),
      ];
      const opts: uPlot.Options = {
        width: 320,
        height: 160,
        title: "Error Rate by Model (%)",
        axes: [
          { space: 0, size: 80 },
          { space: 30, size: 40, grid: { stroke: "var(--line)" }, ticks: { size: 4 } },
        ],
        series: [
          {},
          {
            label: "Error %",
            stroke: "var(--danger)",
            width: 1,
            fill: "color-mix(in oklab, var(--danger) 20%, transparent)",
            paths: barPathBuilder(rates, labels),
            points: { show: false },
          },
        ],
        scales: { x: { time: false }, y: { min: 0, max: 100 } },
        cursor: { show: false },
      };
      const plot = new uPlot(opts, data, barRef.current);
      uplots.current.push(plot);
    }

    return () => {
      for (const p of uplots.current) p.destroy?.();
      uplots.current = [];
    };
  }, [telemetry.data]);

  if (telemetry.error) return <div className="telemetry-card"><p className="error">{telemetry.error}</p></div>;
  if (!telemetry.data) return <div className="telemetry-card"><p className="muted">Loading…</p></div>;

  const { assignments, latency, throughput, errors } = telemetry.data;

  return (
    <section className="telemetry-card status-card">
      <header className="card-head">
        <h3>Model Telemetry</h3>
        <div className="telemetry-picker">
          <label htmlFor="telemetry-range" className="sr-only">Time range</label>
          <select id="telemetry-range" value={range} onChange={(e) => setRange(e.target.value as TelemetryRange)}>
            {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
      </header>
      <div className="chart-grid">
        <div className="chart-container donut" ref={donutRef} />
        <div className="chart-row">
          {latency.map((_, i) => (
            <div key={i} className="chart-container sparkline" ref={(el) => { sparklineRefs.current[i] = el; }} />
          ))}
        </div>
        <div className="chart-container area" ref={areaRef} />
        <div className="chart-container bar" ref={barRef} />
      </div>
    </section>
  );
}