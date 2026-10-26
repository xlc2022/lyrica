// A diagram, chart or equation in her Markdown (docs/ux.md §6, Diagrams, charts and math in a message), drawn here from
// the message's own text. Mermaid, Vega-Lite and KaTeX ship with the UI and load only when a message holds one; nothing
// they draw loads anything: Mermaid runs strict, a chart's loader refuses every URL, and the SVG is sanitized.
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import type { ExtraProps } from "react-markdown";
import { codeOf, CodeBlock } from "./CodeBlock.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { chartSvg, SERIES, tokens, URL_REFUSED, type Theme } from "./charts.ts";
import { useTheme } from "./ui.tsx";

type Kind = "mermaid" | "vega-lite";

const KINDS: Record<string, Kind> = { mermaid: "mermaid", "vega-lite": "vega-lite", vegalite: "vega-lite" };

/** How long the text must stay unchanged before it is drawn: a block still being written isn't drawn on every token. */
const SETTLE_MS = 400;

async function sanitize(svg: string): Promise<string> {
  const { default: purify } = await import("dompurify");
  return purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

let drawn = 0;

async function mermaid(text: string, theme: Theme): Promise<string> {
  const { default: m } = await import("mermaid");
  const t = tokens();
  m.initialize({
    // Labels as SVG text: the sanitizer drops the HTML a foreignObject label would need.
    startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: t.font, htmlLabels: false,
    themeVariables: {
      darkMode: theme === "dark", background: t.panel, fontFamily: t.font, fontSize: "14px",
      primaryColor: t.tool, primaryBorderColor: t.edge, primaryTextColor: t.fg, secondaryColor: t.panel, tertiaryColor: t.panel,
      lineColor: t.muted, textColor: t.fg, edgeLabelBackground: t.panel, noteBkgColor: t.tool, noteTextColor: t.fg, noteBorderColor: t.line,
      ...Object.fromEntries(SERIES[theme].map((c, i) => [`pie${i + 1}`, c])), pieStrokeColor: t.panel, pieOuterStrokeColor: t.line, pieOpacity: "1",
      // A pie in the message's type scale, beside a flowchart's 14 px labels and a chart's 12 px axes.
      pieTitleTextSize: "16px", pieTitleTextColor: t.fg, pieSectionTextSize: "13px", pieLegendTextSize: "13px", pieLegendTextColor: t.fg,
    },
  });
  // Parsed first: a failed render leaves its error drawing in the page's body.
  await m.parse(text);
  const id = `lyrica-diagram-${++drawn}`;
  try { return (await m.render(id, text)).svg; } finally { document.getElementById(`d${id}`)?.remove(); }
}

/** Whether a spec names a URL anywhere (data, an image mark, a link): Vega would draw an empty chart, not say why. */
export const namesUrl = (x: unknown): boolean =>
  Array.isArray(x) ? x.some(namesUrl) : typeof x === "object" && x !== null && Object.entries(x).some(([k, v]) => k === "url" || namesUrl(v));

async function vegaLite(text: string, theme: Theme): Promise<string> {
  const spec: unknown = JSON.parse(text);
  if (namesUrl(spec)) throw new Error(URL_REFUSED);
  return chartSvg(spec as object, theme);
}

const DRAW: Record<Kind, (text: string, theme: Theme) => Promise<string>> = { mermaid, "vega-lite": vegaLite };
const WORD: Record<Kind, string> = { mermaid: "diagram", "vega-lite": "chart" };

/** The first line of why a block didn't draw, short enough for one caption. */
function reason(e: unknown): string {
  const line = (e instanceof Error ? e.message : String(e)).split("\n").find((l) => l.trim())?.trim().replace(/:$/, "").slice(0, 160) ?? "";
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

/** A ```mermaid or ```vega-lite block: drawn once its text settles, with Preview | Source and Copy in its strip. */
function Figure({ kind, lang, text, children }: { kind: Kind; lang: string; text: string; children: ReactNode }) {
  const theme = useTheme();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      DRAW[kind](text, theme).then(sanitize).then(
        (out) => { if (live) { setSvg(out); setError(undefined); } },
        (e: unknown) => { if (live) { setSvg(undefined); setError(reason(e)); } },
      );
    }, SETTLE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [kind, text, theme]);
  const showing = svg && !source;
  return (
    <figure className="code-block rich-block">
      <div className="code-head">
        <span className="code-lang">{lang}</span>
        {svg && (
          <div className="seg" role="group" aria-label="Show">
            <button type="button" className="sm" aria-pressed={!source} onClick={() => setSource(false)}>Preview</button>
            <button type="button" className="sm" aria-pressed={source} onClick={() => setSource(true)}>Source</button>
          </div>
        )}
        <CopyButton text={text} label="Copy" ariaLabel={`Copy ${WORD[kind]} source`} className="code-copy" />
      </div>
      {showing ? <div className="rich-draw" role="img" aria-label={WORD[kind]} dangerouslySetInnerHTML={{ __html: svg }} /> : <pre>{children}</pre>}
      {error && !svg && <p className="rich-error">This {WORD[kind]} didn't draw: {error}</p>}
    </figure>
  );
}

/** Math drawn by KaTeX; until it loads, and where it can't parse, the TeX as code. */
export function MathText({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    let live = true;
    void Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([{ default: katex }]) => {
      let out: string | undefined;
      try { out = katex.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, output: "htmlAndMathml" }); } catch { out = undefined; }
      if (live) setHtml(out);
    });
    return () => { live = false; };
  }, [tex, display]);
  if (!html) return display ? <pre className="math-display"><code>{tex}</code></pre> : <code>{tex}</code>;
  return display ? <div className="math-display" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Inline code, or inline math (remark-math marks it `math-inline`). */
export function RichCode({ node: _, className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  if (className?.split(" ").includes("math-inline")) return <MathText tex={String(children)} display={false} />;
  return <code className={className} {...props}>{children}</code>;
}

/** A `pre` for react-markdown: a diagram or chart drawn, display math drawn, other code as a code block (with `copy`, its strip). */
export function richPre(copy: boolean) {
  return function RichPre(props: ComponentProps<"pre"> & ExtraProps) {
    const { lang, text } = codeOf(props.node);
    const kind = KINDS[lang];
    if (kind) return <Figure kind={kind} lang={lang} text={text}>{props.children}</Figure>;
    if (lang === "math") return <MathText tex={text} display />;
    return copy ? <CodeBlock {...props} /> : <pre>{props.children}</pre>;
  };
}
