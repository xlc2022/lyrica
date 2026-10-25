import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
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

const latencyBarPathBuilder = (percentiles: number[], labels: string[]): uPlot.Series.PathBuilder => {
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
    const maxVal = Math.max(...percentiles, 1);
    for (let j = 0; j < percentiles.length; j++) {
      const h = (percentiles[j]! / maxVal) * height;
      const x = bx + j * (bw + 4);
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

function createDonutChart(root: HTMLDivElement, values: number[], labels: string[], uplots: uPlot[]) {
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
        stroke: "#1f6f78",
        width: 2,
        fill: "rgba(31, 111, 120, 0.15)",
        paths: donutPathBuilder(values),
        points: { show: false },
      },
    ],
    hooks: {
      init: [
        (u) => {
          u.root.style.fontFamily = "IBM Plex Sans, system-ui, -apple-system, sans-serif";
          u.root.style.color = "var(--fg)";
        },
      ],
    },
  };
  const plot = new uPlot(opts, data, root);
  uplots.push(plot);
}

function createLatencyChart(root: HTMLDivElement, task: Task, p50: number, p95: number, p99: number, uplots: uPlot[]) {
  const percentiles = [p50, p95, p99];
  const labels = ["p50", "p95", "p99"];
  const data: uPlot.AlignedData = [
    toCategoryArray(labels),
    toTypedArray(percentiles),
  ];
  const opts: uPlot.Options = {
    width: 320,
    height: 100,
    title: `${task} latency percentiles (ms)`,
    axes: [
      { space: 0 },
      { space: 30, size: 40, grid: { stroke: "var(--line)" }, ticks: { size: 4 } },
    ],
    series: [
      {},
      {
        stroke: "#1f6f78",
        width: 1,
        fill: "rgba(31, 111, 120, 0.2)",
        paths: latencyBarPathBuilder(percentiles, labels),
        points: { show: false },
      },
    ],
    scales: { x: { time: false }, y: { min: 0 } },
    cursor: { show: false },
    hooks: {
      init: [
        (u) => {
          u.root.style.fontFamily = "IBM Plex Sans, system-ui, -apple-system, sans-serif";
          u.root.style.color = "var(--fg)";
        },
      ],
    },
  };
  const plot = new uPlot(opts, data, root);
  uplots.push(plot);
}

function createThroughputChart(root: HTMLDivElement, labels: string[], input: number[], output: number[], uplots: uPlot[]) {
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
      { label: "Input", stroke: "#2b6cb0", width: 2, fill: "rgba(43, 108, 176, 0.15)" },
      { label: "Output", stroke: "#1f6f78", width: 2, fill: "rgba(31, 111, 120, 0.15)" },
    ],
    scales: { x: { time: false }, y: { min: 0 } },
    cursor: { show: false },
    hooks: {
      init: [
        (u) => {
          u.root.style.fontFamily = "IBM Plex Sans, system-ui, -apple-system, sans-serif";
          u.root.style.color = "var(--fg)";
        },
      ],
    },
  };
  const plot = new uPlot(opts, data, root);
  uplots.push(plot);
}

function createErrorRateChart(root: HTMLDivElement, labels: string[], rates: number[], uplots: uPlot[]) {
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
        stroke: "#a8322d",
        width: 1,
        fill: "rgba(168, 50, 45, 0.2)",
        paths: barPathBuilder(rates, labels),
        points: { show: false },
      },
    ],
    scales: { x: { time: false }, y: { min: 0, max: 100 } },
    cursor: { show: false },
    hooks: {
      init: [
        (u) => {
          u.root.style.fontFamily = "IBM Plex Sans, system-ui, -apple-system, sans-serif";
          u.root.style.color = "var(--fg)";
        },
      ],
    },
  };
  const plot = new uPlot(opts, data, root);
  uplots.push(plot);
}

export function ModelTelemetryCard({ userId }: { userId: string }) {
  const [range, setRange] = useState<TelemetryRange>("24h");
  const path = `${u(userId, "admin", "telemetry", "models")}?range=${range}`;
  const telemetry = useLoad<ModelTelemetry>(() => get(path), [userId, range]);
  const donutRef = useRef<HTMLDivElement>(null);
  const latencyRefs = useRef<(HTMLDivElement | null)[]>([]);
  const areaRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const uplots = useRef<uPlot[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => { setMounted(false); };
  }, []);

  // Defer chart creation to next frame to avoid blocking paint
  useEffect(() => {
    if (!mounted || !telemetry.data) return;
    const { assignments, latency, throughput, errors } = telemetry.data;

    let cancelled = false;
    const runNextFrame = () => {
      if (cancelled) return;

      // Donut: assignments by task
      if (donutRef.current) {
        const taskCounts = new Map<string, number>();
        for (const a of assignments) taskCounts.set(a.task, (taskCounts.get(a.task) ?? 0) + 1);
        const labels = Array.from(taskCounts.keys());
        const values = labels.map((t) => taskCounts.get(t)!);
        createDonutChart(donutRef.current!, values, labels, uplots.current);
      }

      // Latency percentiles bar chart per task
      for (let i = 0; i < latency.length; i++) {
        const l = latency[i];
        if (!l) continue;
        const ref = latencyRefs.current[i];
        if (ref) {
          createLatencyChart(ref, l.task, l.p50, l.p95, l.p99, uplots.current);
        }
      }

      // Area chart: throughput in/out per task
      if (areaRef.current && throughput.length > 0) {
        const labels = throughput.map((t) => t.task);
        const input = throughput.map((t) => t.inputPerSec);
        const output = throughput.map((t) => t.outputPerSec);
        createThroughputChart(areaRef.current!, labels, input, output, uplots.current);
      }

      // Stacked bar: error rate by model
      if (barRef.current && errors.length > 0) {
        const labels = errors.map((e) => e.model);
        const rates = errors.map((e) => e.rate * 100);
        createErrorRateChart(barRef.current!, labels, rates, uplots.current);
      }
    };

    requestAnimationFrame(runNextFrame);

    return () => {
      cancelled = true;
      for (const p of uplots.current) p.destroy?.();
      uplots.current = [];
    };
  }, [mounted, telemetry.data]);

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
            <div key={i} className="chart-container sparkline" ref={(el) => { latencyRefs.current[i] = el; }} />
          ))}
        </div>
        <div className="chart-container area" ref={areaRef} />
        <div className="chart-container bar" ref={barRef} />
      </div>
    </section>
  );
}