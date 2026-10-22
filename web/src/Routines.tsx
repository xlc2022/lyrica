import { useCallback, useRef, useState } from "react";
import { del, get, patch, threadPath, u, type RoutineInfo } from "./api.ts";
import { Icon } from "./icons.tsx";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ErrorText, fullTime, timeZone, useAction, useDismiss, useLoad, wakeTime } from "./ui.tsx";

/** The next active routine; paused schedules never supply the facts line's time. */
export function nextRoutine(routines: RoutineInfo[]): RoutineInfo | undefined {
  return routines.filter(r => !r.paused).sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0];
}

export function ScheduleText({ text }: { text: string }) {
  return <>{text.split(/(\d+(?::\d+)?)/).map((part, i) => /^\d/.test(part) ? <span className="num" key={i}>{part}</span> : part)}</>;
}

export function RoutineRows({ userId, routines, linked, onChange }: {
  userId: string; routines: RoutineInfo[]; linked?: boolean; onChange: () => void;
}) {
  const [run, busy, error] = useAction();
  return <>
    {routines.map(r => {
      const path = threadPath(userId, r.pool, r.threadId, "routines", String(r.id));
      return <div className="wake-item routine-item" key={`${r.pool}/${r.id}`}>
        <div className="routine-facts">
          {linked && <a href={href({ page: "thread", userId, pool: r.pool, threadId: r.threadId })}>{r.threadTitle}</a>}
          <span title={`In your time zone, ${timeZone()}`}><ScheduleText text={r.schedule} /></span>
          {r.paused ? <span className="muted">Paused</span> : <time className="num" dateTime={r.nextAt} title={fullTime(r.nextAt)}>{wakeTime(r.nextAt)}</time>}
        </div>
        <button type="button" className="sm" disabled={busy} onClick={() => void run(async () => { await patch(path, { paused: !r.paused }); onChange(); })}>{r.paused ? "Resume" : "Pause"}</button>
        <button type="button" className="icon sm danger" aria-label={`Remove routine: ${r.schedule}`} title="Remove" disabled={busy}
          onClick={() => void run(async () => { await del(path); onChange(); })}><Icon name="close" /></button>
      </div>;
    })}
    <ErrorText error={error} />
  </>;
}

export function RoutinesFact({ userId, routines, onChange }: { userId: string; routines: RoutineInfo[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const next = nextRoutine(routines);
  return <span className="picker-anchor" ref={anchor}>
    <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      Routine {next ? <span className="num">{wakeTime(next.nextAt)}</span> : <span className="muted">Paused</span>} <span className="caret" aria-hidden="true">▾</span>
    </button>
    {open && <div className="picker wake-pop routine-pop" role="dialog" aria-label="Routines">
      <RoutineRows userId={userId} routines={routines} onChange={onChange} />
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
