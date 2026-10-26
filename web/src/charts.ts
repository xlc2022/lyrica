// The one chart look (docs/ux.md §6): a chart in a message and Status's charts share these colours and axes, in light
// and dark. Vega-Lite and Vega load only when a chart is drawn; nothing a chart draws loads anything.

export type Theme = "dark" | "light";

/** The categorical order every chart and pie uses, light and dark (validated for colour-blind separation). */
export const SERIES: Record<Theme, string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

export const URL_REFUSED = "its data must be in the message as values, not loaded from a URL.";

/** The page's colour tokens, read where they are set (all plain hex, so the libraries can parse them). */
export function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { panel: v("--panel"), tool: v("--tool"), fg: v("--fg"), muted: v("--muted"), line: v("--line"), edge: v("--edge"), font: v("--ui") };
}

/** Vega-Lite's config in the page's colours and type. */
export function chartConfig(theme: Theme) {
  const t = tokens();
  const axis = { domainColor: t.edge, gridColor: t.line, tickColor: t.edge, labelColor: t.muted, titleColor: t.fg, labelFont: t.font, titleFont: t.font, labelFontSize: 12, titleFontSize: 12, titleFontWeight: 600 };
  return {
    background: null, font: t.font, view: { stroke: null },
    axis, axisX: { labelAngle: 0 }, legend: { labelColor: t.fg, titleColor: t.fg, labelFont: t.font, titleFont: t.font, labelFontSize: 12, titleFontSize: 12 },
    title: { color: t.fg, font: t.font, fontSize: 13, fontWeight: 600 }, text: { color: t.fg, font: t.font },
    range: { category: SERIES[theme] }, mark: { color: SERIES[theme][0] }, line: { strokeWidth: 2 },
    bar: { cornerRadiusEnd: 4 }, arc: { stroke: t.panel, strokeWidth: 2 },
  };
}

/** A Vega view whose loader refuses every URL and whose expressions are interpreted, never compiled into a function. */
async function view(spec: object, theme: Theme, opts: { container?: HTMLElement; renderer: "svg" | "none" }) {
  const [{ compile }, vega, { expressionInterpreter }] = await Promise.all([import("vega-lite"), import("vega"), import("vega-interpreter")]);
  const vg = compile(spec as Parameters<typeof compile>[0], { config: chartConfig(theme) as never }).spec;
  const loader = vega.loader();
  const refuse = () => Promise.reject(new Error(URL_REFUSED));
  loader.load = refuse;
  loader.sanitize = refuse;
  return new vega.View(vega.parse(vg, undefined, { ast: true }), { renderer: opts.renderer, loader, expr: expressionInterpreter, ...(opts.container ? { container: opts.container, hover: true } : {}) });
}

/** A chart drawn once, as SVG text (a message's chart, sanitized by its caller). */
export async function chartSvg(spec: object, theme: Theme): Promise<string> {
  const v = await view(spec, theme, { renderer: "none" });
  try { return await v.toSVG(); } finally { v.finalize(); }
}

/**
 * A live chart in `el`, with a tooltip of the hovered mark's fields as text in `tip`. Returns its teardown.
 * The data is the page's own: Status's charts are built from the facts lyricad sent.
 */
export async function drawChart(el: HTMLElement, tip: HTMLElement, spec: object, theme: Theme): Promise<() => void> {
  const v = await view(spec, theme, { container: el, renderer: "svg" });
  v.tooltip((_handler: unknown, event: MouseEvent | undefined, _item: unknown, value: unknown) => {
    if (value === undefined || value === null || value === "" || !event) { tip.hidden = true; return; }
    tip.replaceChildren(...(typeof value === "object" ? Object.entries(value as Record<string, unknown>) : [["", value] as const]).map(([k, x]) => {
      const line = document.createElement("div");
      if (k) { const b = document.createElement("span"); b.className = "muted"; b.textContent = `${k} `; line.append(b); }
      line.append(String(x));
      return line;
    }));
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    // Beside the pointer, turned back inside the chart near its right edge.
    tip.style.left = `${Math.max(0, Math.min(x + 12, box.width - tip.offsetWidth))}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
  });
  await v.runAsync();
  return () => v.finalize();
}
