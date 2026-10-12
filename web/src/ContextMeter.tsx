// How full the thread's context is: a word in the header's facts line, and a popover with the parts (docs/ux.md §6).
import { useCallback, useRef, useState } from "react";
import type { ContextInfo, PaceInfo } from "./api.ts";
import { shortTime, useDismiss } from "./ui.tsx";

type PartName = ContextInfo["parts"][number]["name"];

const NAMES: Record<PartName, string> = {
  persona: "Persona", about: "About", memory: "Memory", pinned: "Pinned", recall: "Recall",
  tools: "Tools", conversation: "Conversation", reserve: "Reserve", free: "Free",
};
const ORDER: PartName[] = ["persona", "about", "memory", "pinned", "recall", "tools", "conversation", "reserve", "free"];

const tokens = (n: number) => Math.round(n).toLocaleString("en-US");
/** A speed: one decimal below 10, so a slow model doesn't read as 0 or 1. */
const rate = (n: number) => (n < 10 ? n.toFixed(1) : tokens(n));

/**
 * The newer of two readings: the live one from the stream, and the one the settings were loaded with. None
 * after a rewind or reset (`null`), until a turn measures again.
 */
export function newerContext(a?: ContextInfo | null, b?: ContextInfo): ContextInfo | undefined {
  if (a === null) return undefined;
  if (!a || !b) return a ?? b;
  return Date.parse(a.measuredAt) >= Date.parse(b.measuredAt) ? a : b;
}

/** Warn from 80 %, danger from 95 %, where compaction is close. */
export const contextLevel = (percent: number) => (percent >= 95 ? "danger" : percent >= 80 ? "warn" : undefined);

export function ContextFact({ context }: { context: ContextInfo }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  // From a call record there is no breakdown: used, then reserve and free.
  const parts = context.parts.length
    ? ORDER.flatMap((name) => context.parts.filter((p) => p.name === name).map((p) => ({ key: name, label: NAMES[name], tokens: p.tokens })))
    : [
        { key: "used", label: "Used", tokens: context.tokens },
        { key: "reserve", label: "Reserve", tokens: context.reserve },
        { key: "free", label: "Free", tokens: context.free },
      ];
  const width = (n: number) => `${context.window ? Math.max(0, (n / context.window) * 100) : 0}%`;
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        Context <span className="num ctx-pct" data-level={contextLevel(context.percent)}>{context.percent}%</span> <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker ctx-pop" role="dialog" aria-label="Context">
          <p className="ctx-total"><span className="num">{tokens(context.tokens)}</span> of <span className="num">{tokens(context.window)}</span> tokens</p>
          <div className="ctx-bar" aria-hidden="true">
            {parts.filter((p) => p.key !== "free" && p.tokens > 0).map((p) => <span key={p.key} data-part={p.key} style={{ width: width(p.tokens) }} />)}
          </div>
          <ul className="ctx-parts">
            {parts.map((p) => (
              <li key={p.key}><i data-part={p.key} aria-hidden="true" /><span>{p.label}</span><span className="num">{tokens(p.tokens)}</span></li>
            ))}
          </ul>
          <p className="ctx-foot">Measured <span className="num">{shortTime(context.measuredAt)}</span></p>
          {context.pace && <Pace pace={context.pace} />}
        </div>
      )}
    </span>
  );
}

/** "Last turn: 42 tok/s · 310 prompt tok/s · first token 850 ms", leaving out what wasn't measured. */
function Pace({ pace }: { pace: PaceInfo }) {
  const bits: [number | undefined, string, string, (n: number) => string][] = [
    [pace.tokPerSec, "", " tok/s", rate],
    [pace.promptTokPerSec, "", " prompt tok/s", rate],
    [pace.ttftMs, "first token ", " ms", tokens],
  ];
  const shown = bits.filter(([n]) => typeof n === "number" && Number.isFinite(n));
  if (!shown.length) return null;
  return (
    <p className="ctx-foot">
      Last turn:{" "}
      {shown.map(([n, before, after, show], i) => (
        <span key={after}>{i > 0 && " · "}{before}<span className="num">{show(n!)}</span>{after}</span>
      ))}
    </p>
  );
}
