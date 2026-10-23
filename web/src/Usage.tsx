// Principles 1 and 8: usage lives in the existing facts and popovers (docs/ux.md §6).
import { useCallback, useRef, useState } from "react";
import type { Pool, ThreadSummary, ThreadUsage } from "./api.ts";
import { tokenCount } from "./Project.tsx";
import { href } from "./route.ts";
import { useDismiss, useInView } from "./ui.tsx";

export interface UsageProps { usage: ThreadUsage; userId: string; pool: Pool; threadId: string; threads: ThreadSummary[] }
const gpuTime = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
const COUNTS_WHY = "Counts every request, cached reads included.";
const TOTAL_WHY = "Tokens counted before input and output were kept apart count here alone.";
const CACHED_WHY = "The share of input the model's server says it read from its cache, over recent calls.";
/** Input, output and total tokens, the cache's share of input, then GPU time; the split can fall short of the total for tokens counted before it was kept. */
const Counts = ({ tokens, input, output, gpuMs, cacheHit, cloud }: { tokens: number; input: number; output: number; gpuMs?: number; cacheHit?: number; cloud?: boolean }) => <>
  <span className="num">{tokenCount(input)}</span><span className="num">{tokenCount(output)}</span><span className="num">{tokenCount(tokens)}</span>
  {cacheHit !== undefined ? <span className="num">{Math.round(cacheHit * 100)}%</span> : <span className="num muted" title="Not measured">—</span>}
  {gpuMs !== undefined ? <span className="num" title="GPU time">{gpuTime(gpuMs)}</span> : cloud ? <span className="num muted" title="Cloud: no GPU time">—</span> : <span />}
</>;

export function UsageRows({ usage, userId, pool, threadId, threads }: UsageProps) {
  return <div className="usage-rows">
    <div className="usage-head muted"><span>Model</span><span title={COUNTS_WHY}>Input</span><span>Output</span><span>Total</span><span title={CACHED_WHY}>Cached</span><span>GPU time</span></div>
    {usage.models.map(m => <div className="usage-row" key={`${m.label}/${m.kind}`}><span className="usage-name">{m.label} {m.kind && <span className="muted">{m.kind}</span>}</span><Counts {...m} cloud={m.kind === "cloud"} /></div>)}
    <div className="usage-row"><strong title={TOTAL_WHY}>Total<span className="sr-only">. {TOTAL_WHY}</span></strong><Counts {...usage} /></div>
    {usage.threads && <>
      <div className="picker-ep">By thread</div>
      {usage.threads.map(t => <div className="usage-row" key={t.threadId}>
        {t.threadId === threadId ? <span>This chat</span> : <a href={href({ page: "thread", userId, pool, threadId: t.threadId })}>{threads.find(x => x.id === t.threadId && x.pool === pool)?.title || "New thread"}</a>}
        <Counts {...t} />
      </div>)}
      <a href={href({ page: "models", userId, tab: "calls", pool, project: threadId })}>Recent calls</a>
    </>}
  </div>;
}

/** On a phone this opens rows in the Context or Threads popover itself. */
export function TokensFact({ inline, ...props }: UsageProps & { inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, !inline && open, close);
  useInView(anchor, !inline && open);
  if (!props.usage.models.length) return null;
  return <span className={`picker-anchor tokens${inline ? " usage-inline" : ""}`} ref={anchor}>
    <button type="button" className="link" aria-expanded={open} aria-haspopup={inline ? undefined : "dialog"} onClick={() => setOpen(!open)}>
      <span className="num">{tokenCount(props.usage.tokens)} tokens</span> <span className="caret" aria-hidden="true">▾</span>
    </button>
    {open && (inline ? <UsageRows {...props} /> : <div className="picker usage-pop" role="dialog" aria-label="Tokens"><UsageRows {...props} /></div>)}
  </span>;
}
