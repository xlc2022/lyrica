// The model request a reply waits on, as a line of counts in place of the writing dots (docs/ux.md, "The reply as she writes it").
import { useEffect, useState } from "react";
import type { LiveCall } from "./api.ts";

/** Tokens as the chat says them: whole below 10,000, then thousands to one decimal ("48.2k"), whole from 100k. */
export function tokens(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
}

const perSecond = (n: number) => `${n < 100 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n).toLocaleString("en-US")} tok/s`;

/**
 * What the line says, and its tooltip; none when nothing is known yet (the dots stay).
 * `seconds` is how long ago the request went out.
 */
export function callLine(c: LiveCall, seconds: number): { text: string; tip: string } | undefined {
  const cached = c.cached ?? 0;
  const parts: string[] = [];
  if (c.prompt !== undefined) parts.push(c.cached ? `${tokens(c.prompt)} prompt tokens, ${tokens(cached)} from cache` : `${tokens(c.prompt)} prompt tokens${c.read === undefined && c.output === undefined ? ", estimated" : ""}`);
  if (c.readRate !== undefined) parts.push(`read at ${perSecond(c.readRate)}`);
  if (c.output !== undefined) {
    const word = c.writing === "tool" ? "Writing a tool call" : c.writing === "thinking" ? "Thinking" : "Writing";
    const text = `${word} · ${c.counted ? "≈" : ""}${tokens(c.output)} tokens${c.outputRate !== undefined ? ` · ${perSecond(c.outputRate)}` : ""}`;
    if (c.counted) parts.push("output counted from the text, as this server doesn't count it while it writes");
    return { text, tip: parts.join(" · ") };
  }
  if (c.prompt !== undefined && c.read !== undefined) {
    const fresh = Math.max(c.read, c.prompt - cached);
    return { text: `Reading ${tokens(c.read)} of ${tokens(fresh)} new${c.readRate !== undefined ? ` · ${perSecond(c.readRate)}` : ""}`, tip: parts.join(" · ") };
  }
  if (c.prompt !== undefined) {
    return { text: `Prompt ${tokens(c.prompt)} · ${seconds} s`, tip: [...parts, "this server doesn't say how far it has read"].join(" · ") };
  }
  return undefined;
}

/** The line, or the three dots while nothing is known. Its seconds tick while it waits on a server that says nothing. */
export function CallStats({ live }: { live?: { call: LiveCall; since: number } }) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!live && live.call.output === undefined && live.call.read === undefined && live.call.prompt !== undefined;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const line = live && callLine(live.call, Math.max(0, Math.floor((Math.max(now, live.since) - live.since) / 1000)));
  if (!line) return <span className="writing-dots" aria-hidden="true"><i /><i /><i /></span>;
  // Numbers in mono; the words around them in the muted body font.
  // Hidden from screen readers, as the dots are: it changes twice a second, and the status line says she is working.
  return <span className="call-stats" title={line.tip} aria-hidden="true">{line.text.split(/([≈\d][\d,.]*k?(?: tok\/s| s)?)/).map((s, i) => (i % 2 ? <span key={i} className="num">{s}</span> : s))}</span>;
}
