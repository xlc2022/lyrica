import { useCallback, useEffect, useId, useRef, useState } from "react";
import { del, get, patch, threadPath, u, type RoutineInfo } from "./api.ts";
import { Icon } from "./icons.tsx";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ErrorText, fullTime, timeZone, useAction, useDismiss, useInView, useLoad, wakeTime } from "./ui.tsx";

/** The next active routine; paused schedules never supply the facts line's time. */
export function nextRoutine(routines: RoutineInfo[]): RoutineInfo | undefined {
  return routines.filter(r => !r.paused).sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0];
}

/** A project chat's routines: its own, then its threads' (from the user's whole list, kept to the project's threads in its pool), by thread. */
export function projectRoutines(own: RoutineInfo[], all: RoutineInfo[] | undefined, threads: { id: string }[] | undefined, pool: string, here: string): RoutineInfo[] {
  if (!all || !threads) return own;
  const ids = new Set(threads.map(t => t.id));
  const theirs = all.filter(r => r.pool === pool && r.threadId !== here && ids.has(r.threadId));
  return [...own, ...theirs.sort((a, b) => a.threadTitle.localeCompare(b.threadTitle) || a.threadId.localeCompare(b.threadId) || a.nextAt.localeCompare(b.nextAt))];
}

export function ScheduleText({ text }: { text: string }) {
  return <>{text.split(/(\d+(?::\d+)?)/).map((part, i) => /^\d/.test(part) ? <span className="num" key={i}>{part}</span> : part)}</>;
}

/** Explicit purpose, never the execution note; older routines keep an honest destination fallback. An untitled one is "Routine <id>": the thread is already the popover's, or its own link in Settings. */
function RoutineTitle({ routine: r }: { routine: RoutineInfo }) {
  const tip = useId();
  const [dismissed, setDismissed] = useState(false);
  const preview = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Hover can reveal the tooltip while focus is still on the outer popover's trigger.
      if (e.key !== "Escape" || !preview.current || getComputedStyle(preview.current).display === "none") return;
      e.stopPropagation();
      setDismissed(true);
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, []);
  return <span className="wl routine-title" tabIndex={0} aria-describedby={tip} data-dismissed={dismissed || undefined}
    onFocus={() => setDismissed(false)} onPointerEnter={() => setDismissed(false)}
    onClick={e => { e.currentTarget.focus(); setDismissed(false); }}>
    <span>{r.title ?? <>Routine <span className="num">{r.id}</span></>}</span>
    <span className="preview" role="tooltip" id={tip} ref={preview}>{r.description ?? `Runs the saved instructions ${r.newThread ? "in a new thread" : "here"}.`}</span>
  </span>;
}

/** `linked` gives every row its thread's link (Settings); `here` only the rows of another thread (a project chat's own popover holding its threads'). */
export function RoutineRows({ userId, routines, linked, here, onChange }: {
  userId: string; routines: RoutineInfo[]; linked?: boolean; here?: string; onChange: () => void;
}) {
  const [run, busy, error] = useAction();
  return <>
    {routines.map(r => {
      const path = threadPath(userId, r.pool, r.threadId, "routines", String(r.id));
      return <div className="wake-item routine-item" key={`${r.pool}/${r.id}`}>
        <div className="routine-facts">
          <RoutineTitle routine={r} />
          {(linked || (here !== undefined && r.threadId !== here)) && <a href={href({ page: "thread", userId, pool: r.pool, threadId: r.threadId })}>{r.threadTitle}</a>}
          <span title={`In your time zone, ${timeZone()}`}><ScheduleText text={r.schedule} /></span>
          {r.paused ? <span className="muted">Paused</span> : <time className="num" dateTime={r.nextAt} title={fullTime(r.nextAt)}>{wakeTime(r.nextAt)}</time>}
        </div>
        <button type="button" className="sm" disabled={busy} onClick={() => void run(async () => { await patch(path, { paused: !r.paused }); onChange(); })}>{r.paused ? "Resume" : "Pause"}</button>
        <button type="button" className="icon sm danger" aria-label={r.title ? `Remove routine: ${r.title}` : `Remove routine ${r.id}`} title="Remove" disabled={busy}
          onClick={() => void run(async () => { await del(path); onChange(); })}><Icon name="close" /></button>
      </div>;
    })}
    <ErrorText error={error} />
  </>;
}

export function RoutinesFact({ userId, threadId, routines, onChange }: { userId: string; threadId: string; routines: RoutineInfo[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  useInView(anchor, open);
  const next = nextRoutine(routines);
  return <span className="picker-anchor" ref={anchor}>
    <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      Routine {next ? <span className="num">{wakeTime(next.nextAt)}</span> : <span className="muted">Paused</span>} <span className="caret" aria-hidden="true">▾</span>
    </button>
    {open && <div className="picker wake-pop routine-pop" role="dialog" aria-label="Routines">
      <RoutineRows userId={userId} routines={routines} here={threadId} onChange={onChange} />
    </div>}
  </span>;
}

export function RoutinesSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const routines = useLoad(() => get<RoutineInfo[]>(u(userId, "routines")), [userId]);
  return <section className="card" aria-labelledby="h-routines">
    <h2 id="h-routines">Routines</h2>
    <ErrorText error={routines.error} />
    {routines.data && (routines.data.length ? <RoutineRows userId={userId} routines={[...routines.data].sort((a, b) => a.pool.localeCompare(b.pool) || a.threadId.localeCompare(b.threadId) || a.nextAt.localeCompare(b.nextAt))} linked onChange={routines.reload} /> : <p className="muted">No routines.</p>)}
  </section>;
}
