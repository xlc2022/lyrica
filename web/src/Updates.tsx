// Administration → Updates (docs/ux.md §6 "Updates"): the running version, the newest update note, Update as the one
// primary, the updater's state as a dot and a word, and the kept releases with Roll back behind each row's ⋯.
import { useCallback, useEffect, useRef, useState } from "react";
import { get, post, u, type BusyItem, type KeptRelease, type Updates, type UpdaterState } from "./api.ts";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, useAction, useDismiss, useLoad } from "./ui.tsx";

const WORDS: Record<UpdaterState, [string, string]> = {
  idle: ["", "Idle"], fetching: ["info", "Fetching"], building: ["info", "Building"], testing: ["info", "Testing"],
  draining: ["info", "Draining"], switching: ["info", "Switching"], probation: ["info", "Probation"], failed: ["down", "Failed"],
};
const RUNNING: UpdaterState[] = ["fetching", "building", "testing", "draining", "switching", "probation"];
const short = (commit: string) => commit.slice(0, 7);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "long" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function UpdatesSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const path = u(userId, "admin", "updates");
  const updates = useLoad(() => get<Updates>(path), [path]);
  const [run, busy, error] = useAction();
  const [rollback, setRollback] = useState<KeptRelease>();
  const up = updates.data;
  const running = !!up && RUNNING.includes(up.state.state);
  // While the updater works, the section follows it.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(updates.reload, 5000);
    return () => clearInterval(t);
  }, [running, updates.reload]);
  const act = (p: string, body: unknown) => run(async () => updates.set(await post<Updates>(p, body)));
  return (
    <section className="card" aria-labelledby="h-updates">
      <div className="section-head"><h2 id="h-updates">Updates</h2>{up?.available && <button type="button" className="sm" disabled={busy || running} onClick={() => void act(`${path}/check`, {})}>Check</button>}</div>
      <ErrorText error={updates.error || error} />
      {up && (
        <dl className="facts">
          <dt>Running</dt><dd className="mono">{up.running.version} · {up.running.build}</dd>
          {up.note && <><dt>Update</dt><dd><span className="mono">{up.note.tag}</span> <span className="muted mono small">{short(up.note.commit)}</span></dd></>}
        </dl>
      )}
      {up?.note && <pre className="setup note"><code>{up.note.message}</code></pre>}
      {up && !up.available && <p className="muted small">No updater is installed on this machine, so updates and rollbacks are done by hand.</p>}
      {up?.available && (
        <div className="row">
          <button type="button" className="primary" disabled={busy || running || !up.note || up.note.commit === up.running.build} onClick={() => void act(path, { tag: up.note!.tag })}>Update</button>
          <StateLine up={up} userId={userId} />
        </div>
      )}
      {up?.lastRollback && (
        <p className="muted small">
          Rolled back from <span className="mono">{short(up.lastRollback.from)}</span> to <span className="mono">{short(up.lastRollback.to)}</span> on {day(up.lastRollback.at)} at <span className="num">{clock(up.lastRollback.at)}</span>
          {up.lastRollback.automatic ? `, automatically${up.lastRollback.check ? `, after ${up.lastRollback.check} failed` : ""}` : ""}
          {up.lastRollback.restoredFrom ? `; the snapshot from ${clock(up.lastRollback.restoredFrom)} was restored` : ""}.
        </p>
      )}
      {up && up.releases.length > 0 && (
        <ul className="list releases" aria-label="Kept releases">
          {up.releases.map((r) => (
            <li key={r.commit} className="row between release-row">
              <span className="mono">{short(r.commit)}</span>
              <span className="muted">{day(r.builtAt)}{r.tag ? ` · ${r.tag}` : ""}</span>
              {r.summary && <span className="release-summary" title={r.summary}>{r.summary}</span>}
              <span className="state-word">{r.running ? <><span className="dot up" aria-hidden="true" />Running</> : r.previous ? "Previous" : ""}</span>
              {!r.running && <RowDots disabled={busy || running || !r.rollback.possible} title={r.rollback.possible ? undefined : `Can't be read by this release's databases${r.rollback.oldest ? `; the oldest that can is ${short(r.rollback.oldest)}` : ""}`} onRollback={() => setRollback(r)} />}
            </li>
          ))}
        </ul>
      )}
      {rollback && (
        <ConfirmDialog title={`Roll back to the release from ${day(rollback.builtAt)}?`} commit={short(rollback.commit)}
          sentence={rollback.rollback.restores ? `Messages since ${clock(rollback.rollback.restores)} will be lost.` : `${her()} restarts on it.`} confirm="Roll back" danger
          onCancel={() => setRollback(undefined)} onConfirm={() => { const c = rollback.commit; setRollback(undefined); void act(`${path}/rollback`, { commit: c }); }} />
      )}
    </section>
  );
}

/** The updater's state: a dot and a word; while draining, how many threads it waits for, linked beneath. */
function StateLine({ up, userId }: { up: Updates; userId: string }) {
  const [cls, word] = WORDS[up.state.state];
  const busy: BusyItem[] = up.state.busy ?? [];
  const mine = busy.filter((b) => b.userId === userId && b.threadId && b.pool);
  if (up.state.state === "idle") return null;
  return (
    <div className="stack state-line">
      <span className="state-word" title={up.state.error}>
        {cls && <span className={`dot ${cls}`} aria-hidden="true" />}{word}
        {up.state.state === "draining" && <> · waiting for <span className="num">{busy.length}</span> {busy.length === 1 ? "thread" : "threads"}</>}
        {up.state.tag && <span className="muted mono"> · {up.state.tag}</span>}
      </span>
      {up.state.state === "failed" && up.state.error && <span className="error small">{up.state.error}</span>}
      {mine.length > 0 && (
        <ul className="plain small">
          {mine.map((b) => <li key={`${b.pool}/${b.threadId}`}><a href={href({ page: "thread", userId, pool: b.pool!, threadId: b.threadId! })}>{b.kind === "sleep" ? "Sleep" : b.kind === "subagent" ? "A subagent" : "A turn"} in <span className="mono">{b.threadId}</span></a></li>)}
        </ul>
      )}
    </div>
  );
}

function RowDots({ disabled, title, onRollback }: { disabled: boolean; title?: string; onRollback: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <span className="msg-menu" ref={ref}>
      <button type="button" className="icon-btn" aria-label="Release actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" /></button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" disabled={disabled} title={title} onClick={() => { close(); onRollback(); }}>Roll back</button>
        </div>
      )}
    </span>
  );
}
