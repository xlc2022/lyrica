// Principle 1: what her image call is making, while it is (docs/ux.md, "An image the agent made" and "A clip the
// agent made"), so the person doesn't watch an empty chat for minutes.
import { useEffect, useState } from "react";
import type { Making } from "./api.ts";

interface Args { action?: string; size?: { width?: unknown; height?: unknown }; aspectRatio?: unknown; count?: unknown; image?: unknown }

/** The shape asked for, as width over height: a size, or an aspect ratio. */
export function askedRatio(a: Args): number | undefined {
  const w = Number(a.size?.width), h = Number(a.size?.height);
  if (w > 0 && h > 0) return w / h;
  const m = typeof a.aspectRatio === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(a.aspectRatio) : null;
  const r = m ? Number(m[1]) / Number(m[2]) : NaN;
  return Number.isFinite(r) && r > 0 ? r : undefined;
}

/** Time since it started, as the pill shows it: 0:42, 12:05, 1:02:05. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** The same time in words, for a screen reader. */
const spoken = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * One card per image asked for, at the result's shape (two or more side by side, smaller): a field of dots in the accent that lights from its top-right
 * corner as the model host reports progress, over the source image blurred when there is one, and a pill on the first with
 * the percent, Waiting while the host's GPU is busy, or the time since it started.
 */
export function MakingCards({ args, making, label, url }: { args: unknown; making: Making; label: string; url: (path: string) => string }) {
  const a = (args ?? {}) as Args;
  const clip = a.action === "video" || a.action === "animate" || a.action === "motion" || a.action === "extend" || a.action === "upscale_video";
  const source = ["edit", "upscale", "animate", "motion"].includes(a.action ?? "") && typeof a.image === "string" ? a.image : undefined;
  const [sourceRatio, setSourceRatio] = useState<number>();
  const [sourceGone, setSourceGone] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The clock ticks every second, for the pill or its tooltip.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ratio = askedRatio(a) ?? sourceRatio ?? (clip ? 16 / 9 : 1);
  const count = a.action === "create" || a.action === "edit" ? Math.min(4, Math.max(1, Math.floor(Number(a.count) || 1))) : 1;
  const since = now - Date.parse(making.startedAt);
  const pct = making.progress === undefined ? undefined : Math.round(making.progress * 100);
  const pill = pct !== undefined ? `${pct}%` : making.queued ? "Waiting" : elapsed(since);
  return (
    <div className="message-images making-cards">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="making" data-state={pct !== undefined ? "progress" : making.queued ? "queued" : "running"}
          style={{ width: count > 1 ? `min(calc(50% - 4px), ${Math.round(Math.min(240, 200 * ratio))}px)` : `min(100%, ${Math.round(Math.min(420, 320 * ratio))}px)`, aspectRatio: ratio, "--p": (making.progress ?? 0.3).toString() } as React.CSSProperties}
          {...(i === 0
            ? { role: "progressbar", "aria-label": label, ...(pct !== undefined ? { "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 } : { "aria-valuetext": making.queued ? "Waiting" : spoken(since) }) }
            : { "aria-hidden": true })}>
          {source && !sourceGone && (
            <img className="making-source" src={url(source)} alt="" onError={() => setSourceGone(true)}
              onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w && h) setSourceRatio(w / h); }} />
          )}
          <span className="making-dots" />
          {i === 0 && <span className={`making-pill${pct !== undefined || !making.queued ? " num" : ""}`} title={making.queued ? "Waiting for the model host's GPU" : `Running for ${elapsed(since)}`}>{pill}</span>}
        </div>
      ))}
    </div>
  );
}
