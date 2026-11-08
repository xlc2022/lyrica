// Administration → Updates (docs/ux.md §6 "Updates"): the running version, the newest update note (or, with Latest merge
// ticked, main's newest commit, less tested), Update as the one primary, the updater's state as a dot and a word (or, for an update, its steps in a box), and the kept releases with
// Roll back behind each row's ⋯.
import { useCallback, useEffect, useRef, useState } from "react";
import { get, post, u, type BusyItem, type KeptRelease, type Updates, type UpdaterState, type UpdateStep } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { clock, ConfirmDialog, dateText, ErrorText, useAction, useDismiss, useLoad } from "./ui.tsx";

const WORDS: Record<UpdaterState, [string, string]> = {
  idle: ["", "Idle"], fetching: ["info", "Fetching"], building: ["info", "Building"], testing: ["info", "Testing"],
  draining: ["info", "Draining"], switching: ["info", "Switching"], probation: ["info", "Probation"], failed: ["down", "Failed"],
};
const RUNNING: UpdaterState[] = ["fetching", "building", "testing", "draining", "switching", "probation"];
const short = (commit: string) => commit.slice(0, 7);
const day = (iso: string) => dateText(iso, { day: "numeric", month: "long" });
/** The updater labels an update to the latest merge `main`, a name no update tag has. */
const MAIN = "main";
/** What an update is to, in words: its tag, or the latest merge. */
const target = (tag?: string) => tag === MAIN ? "the latest merge" : tag;
/** Not tagged yet: the latest merge's caution, in its tooltip and its dialog. */
const UNTESTED = "Not tagged as a release yet, so less tested.";

export function UpdatesSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const path = u(userId, "admin", "updates");
  const updates = useLoad(() => get<Updates>(path), [path]);
  const [run, busy, error] = useAction();
  const [rollback, setRollback] = useState<KeptRelease>();
  // Latest merge: Update installs main's newest commit instead of the update note, after a dialog.
  const [merge, setMerge] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const up = updates.data;
  const running = !!up && RUNNING.includes(up.state.state);
  const runs = (commit: string) => !!up && /^[0-9a-f]{7,}$/.test(up.running.build) && commit.startsWith(up.running.build);
  const latest = up?.latest ?? null;
  // While the updater works, or a request waits for it (shown as the step it starts with), the section follows it.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(updates.reload, 2000);
    return () => clearInterval(t);
  }, [running, updates.reload]);
  const act = (p: string, body: unknown) => run(async () => updates.set(await post<Updates>(p, body)));
  return (
    <section className="card" aria-labelledby="h-updates">
      <div className="section-head"><h2 id="h-updates">Updates</h2>{up?.available && <button type="button" className="sm" disabled={busy || running} onClick={() => void act(`${path}/check`, {})}>Check</button>}</div>
      {/* While an update runs lyricad restarts, so a reload that fails then isn't news: the box keeps the last answer. */}
      <ErrorText error={(running ? "" : updates.error) || error} />
      {up && (
        <dl className="facts">
          <dt>Running</dt><dd className="mono">{up.running.version} · {up.running.build}</dd>
          {!merge && up.note && <><dt>Update</dt><dd><span className="mono">{up.note.tag}</span> <span className="muted mono small">{short(up.note.commit)}</span></dd></>}
          {merge && latest && <><dt>Latest merge</dt><dd className="latest-merge"><span className="mono">{short(latest.commit)}</span> <span className="muted small">{day(latest.at)}</span>{latest.title && <> <MergeTitle title={latest.title} /></>}</dd></>}
        </dl>
      )}
      {!merge && up?.note && <pre className="setup note"><code>{up.note.message}</code></pre>}
      {up && !up.available && <p className="muted small">No updater is installed on this machine, so updates and rollbacks are done by hand.</p>}
      {up?.available && (
        <div className="row">
          {merge
            ? <button type="button" className="primary" disabled={busy || running || !latest || runs(latest.commit)} title={latest && runs(latest.commit) ? "Running it already" : undefined} onClick={() => setConfirmMerge(true)}>Update</button>
            : <button type="button" className="primary" disabled={busy || running || !up.note || runs(up.note.commit)} onClick={() => void act(path, { tag: up.note!.tag })}>Update</button>}
          <label className="check" title={`Updates to main's newest commit instead of the update note. ${UNTESTED}`}>
            <input type="checkbox" checked={merge} disabled={busy || running} onChange={(e) => {
              setMerge(e.target.checked);
              // Main's head is known from the last fetch; with none yet, Check fetches it.
              if (e.target.checked && !latest) void act(`${path}/check`, {});
            }} /> Latest merge
          </label>
          {!progress(up) && <StateLine up={up} userId={userId} />}
        </div>
      )}
      {up?.available && progress(up) && <Progress up={up} userId={userId} />}
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
      {confirmMerge && latest && (
        <ConfirmDialog title="Update to the latest merge?" commit={short(latest.commit)} sentence={UNTESTED} confirm="Update"
          onCancel={() => setConfirmMerge(false)} onConfirm={() => { setConfirmMerge(false); void act(path, { commit: latest.commit }); }} />
      )}
      {rollback && (
        <ConfirmDialog title={`Roll back to the release from ${day(rollback.builtAt)}?`} commit={short(rollback.commit)}
          sentence={rollback.rollback.restores ? `Messages since ${clock(rollback.rollback.restores)} will be lost.` : `${her()} restarts on it.`} confirm="Roll back" danger
          onCancel={() => setRollback(undefined)} onConfirm={() => { const c = rollback.commit; setRollback(undefined); void act(`${path}/rollback`, { commit: c }); }} />
      )}
    </section>
  );
}

/** A merge's title on one line, its whole text in a tooltip; a leading pull request number in mono, as elsewhere. */
function MergeTitle({ title }: { title: string }) {
  const m = /^(#\d+) (.*)$/.exec(title);
  return <span className="release-summary" title={title}>{m ? <><span className="mono">{m[1]}</span> {m[2]}</> : title}</span>;
}

/** The steps of an update, in the order the updater goes through them, with their names on the card and what each does. */
const STEPS: [UpdateStep["step"], string, string][] = [
  ["fetching", "Download", "Fetches main and the update tags from GitHub."],
  ["building", "Build", "Builds the release as the build user, which can't read any data."],
  ["testing", "Smoke test", "Starts the new release in a scratch home and runs its checks."],
  ["draining", "Finishing turns", "New messages wait while running turns finish. After 10 minutes it gives up and changes nothing."],
  ["switching", "Restart", "Stops Lyrica, snapshots the databases, switches to the new release and starts it. Database changes run here."],
  ["probation", "Probation", "Ten minutes on the new release with every check ok. A failed check goes back to the release before."],
];
/** An update has a box while it runs, waits for the updater, or failed with its steps on record. */
const progress = (up: Updates) => !!up.state.tag && (up.state.steps ? up.state.steps.length > 0 : up.state.state === "fetching");
/** The updater should take a request within seconds; past this the box says it hasn't. */
const STALL_MS = 60_000;

/** The updater's error past the step's own name: "probation failed: web" is "web"; "build" alone says nothing more. */
function reason(error?: string): string {
  const e = (error ?? "").replace(/^(probation failed|smoke test): ?/, "");
  if (["", "fetch", "build", "smoke test", "snapshot"].includes(e)) return e === "snapshot" ? "the snapshot couldn't be taken" : "";
  if (e === "drain timed out") return "turns were still running after 10 minutes";
  return e;
}

/** "4 s", "2 min 05 s", "1 h 03 min": how long a step took or has run. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, "0")} min`;
}

/**
 * An update's progress: a box under Update with its tag, a checklist of the steps (✓ done with how long it took,
 * ✱ the one running with how long so far, ✕ the one it failed in, ○ still to come), and after a failure the reason
 * and the output's last lines in a block that scrolls, with Copy.
 */
function Progress({ up, userId }: { up: Updates; userId: string }) {
  const st = up.state;
  const steps = st.steps ?? [];
  const failed = st.state === "failed";
  // The running step's time moves on between the section's reloads.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (failed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [failed]);
  const waiting = steps.length === 0;
  const stalled = waiting && now - Date.parse(st.since) > STALL_MS;
  const busy: BusyItem[] = st.busy ?? [];
  const mine = busy.filter((b) => b.userId === userId && b.threadId && b.pool);
  const label = (step: string) => STEPS.find(([s]) => s === step)?.[1] ?? step;
  const failedStep = steps.find((s) => s.failed);
  const [cls, word] = waiting ? ["info", "Waiting"] : WORDS[st.state];
  // The output's last lines say what went wrong: the block opens scrolled to its end.
  const out = useRef<HTMLPreElement>(null);
  // Output can be folded away; it shows by default.
  const [shown, setShown] = useState(true);
  useEffect(() => { if (out.current) out.current.scrollTop = out.current.scrollHeight; }, [st.output, shown]);
  return (
    <div className="update-progress" role="group" aria-labelledby="h-update-progress">
      <div className="row between">
        <h3 id="h-update-progress" className="update-progress-title">Update to {st.tag === MAIN ? target(st.tag) : <span className="mono">{st.tag}</span>}</h3>
        <span className="state-word" role="status" title={steps[0] ? `Started at ${clock(steps[0].started)}` : undefined}><span className={`dot ${cls}`} aria-hidden="true" />{word}</span>
      </div>
      <ol className="checklist update-steps">
        {STEPS.map(([step, name, what]) => {
          const s = steps.find((x) => x.step === step);
          const state = !s ? "todo" : s.failed ? "failed" : s.ended ? "done" : failed ? "done" : "doing";
          const mark = state === "done" ? "✓" : state === "doing" ? "✱" : state === "failed" ? "✕" : "○";
          const spoken = state === "done" ? "done" : state === "doing" ? "running" : state === "failed" ? "failed" : "to come";
          return (
            <li key={step} data-state={state}>
              <span className="step-mark" aria-hidden="true">{mark}</span>
              <span className="update-step">
                <span title={what}>{name}<span className="sr-only"> · {spoken}</span></span>
                {s && (state === "doing" || s.ended) && <span className="num muted">{span((s.ended ? Date.parse(s.ended) : now) - Date.parse(s.started))}</span>}
                {state === "doing" && step === "draining" && busy.length > 0 && <span className="muted">waiting for <span className="num">{busy.length}</span> {busy.length === 1 ? "thread" : "threads"}</span>}
              </span>
              {state === "doing" && step === "draining" && mine.length > 0 && (
                <ul className="plain small update-threads">
                  {mine.map((b) => <li key={`${b.pool}/${b.threadId}`}><a href={href({ page: "thread", userId, pool: b.pool!, threadId: b.threadId! })}>{b.kind === "sleep" ? "Sleep" : b.kind === "subagent" ? "A subagent" : "A turn"} in <span className="mono">{b.threadId}</span></a></li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {waiting && !stalled && <p className="muted small">Waiting for the updater to start.</p>}
      {stalled && <p className="warn-text">The updater hasn't started. On the server, <span className="mono">systemctl status lyrica-update.path</span> says why.</p>}
      {failed && (
        <p className="error small">{failedStep ? `${label(failedStep.step)} failed` : "Failed"}{reason(st.error) ? `: ${reason(st.error)}` : ""}.{failedStep?.step === "probation" ? " It went back to the release before." : " Nothing changed."}</p>
      )}
      {failed && st.output && (
        <div className="code-block update-output">
          <div className="code-head">
            <button type="button" className="link output-toggle" aria-expanded={shown} aria-controls="update-output" onClick={() => setShown(!shown)}>
              Output <Icon name="right" className={shown ? "chev-ic open" : "chev-ic"} />
            </button>
            <CopyButton text={st.output} label="Copy" ariaLabel="Copy output" />
          </div>
          {shown && <pre ref={out} id="update-output"><code>{st.output}</code></pre>}
        </div>
      )}
    </div>
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
        {up.state.state === "draining" && busy.length > 0 && <> · waiting for <span className="num">{busy.length}</span> {busy.length === 1 ? "thread" : "threads"}</>}
        {up.state.tag && <span className={up.state.tag === MAIN ? "muted" : "muted mono"}> · {target(up.state.tag)}</span>}
      </span>
      {up.state.state === "failed" && up.state.error && <span className="error small">{withCode(up.state.error)}</span>}
      {mine.length > 0 && (
        <ul className="plain small">
          {mine.map((b) => <li key={`${b.pool}/${b.threadId}`}><a href={href({ page: "thread", userId, pool: b.pool!, threadId: b.threadId! })}>{b.kind === "sleep" ? "Sleep" : b.kind === "subagent" ? "A subagent" : "A turn"} in <span className="mono">{b.threadId}</span></a></li>)}
        </ul>
      )}
    </div>
  );
}

/** The updater's error, a command in it (between backticks) in mono. */
function withCode(text: string) {
  return text.split("`").map((part, i) => (i % 2 ? <span key={i} className="mono">{part}</span> : part));
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
