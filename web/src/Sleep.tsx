// Sleep (docs/sleep.md "Sleep in the UI"): her items from the night at the top, each with Start a chat
// and Dismiss; then the newest run, with Show all beside History, opening to its notes, pages with their word
// differences, questions, dream and WAKE, each linking into the memory browser; Sleep now at the foot.
// Also the per-user mode (Settings → Sleep) and the administrator's sleep time.
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  del, get, HttpError, post, put, u,
  type Display, type HistoryPage, type Pool, type SleepEvent, type SleepItemInfo, type SleepMode, type SleepOverview, type SleepRunDetail, type SleepRunInfo, type SleepStarted, type SleepTime, type ThreadSummary, type UserMap,
} from "./api.ts";
import { HistoryHead, HistoryList } from "./History.tsx";
import { Icon } from "./icons.tsx";
import { plainCitations, poolWord, wordDiff } from "./memory.ts";
import { readable } from "./mentions.ts";
import { go, href, idHref, type Route } from "./route.ts";
import { PageHead, PoolLock, type ShellContext } from "./Shell.tsx";
import { ClampedText, clock, ConfirmDialog, dateText, ErrorText, hidden, Prose, shortTime, useAction, useDismiss, useLoad } from "./ui.tsx";

export interface SleepState {
  overview?: SleepOverview;
  /** Items neither started nor dismissed: the sidebar's count. */
  fresh: number;
  running: boolean;
  error: string;
  reload: () => void;
  set: (o: SleepOverview) => void;
}

/** The overview, loaded once by the shell for the sidebar's count (only pools the user shows); the Sleep page and its events keep it fresh. */
export function useSleepOverview(userId: string, display?: Display): SleepState {
  const o = useLoad(() => get<SleepOverview>(u(userId, "sleep")), [userId]);
  return {
    overview: o.data,
    fresh: display ? o.data?.items.filter((i) => i.new && !hidden(display, i.pool)).length ?? 0 : 0,
    running: !!display && !!o.data?.runs.some((r) => r.status === "running" && !hidden(display, r.pool)),
    error: o.error,
    reload: o.reload,
    set: o.set,
  };
}

export const SKIPPED: Record<NonNullable<SleepRunInfo["skipReason"]>, string> = { "no-key": "Skipped: no key", "endpoint-down": "Skipped: the endpoint was down", "no-activity": "Skipped: nothing new", "plan-limit": "Waiting: the plan's usage limit" };
const PHASE_WORD = { consolidate: "consolidating", dream: "dreaming", wake: "waking" } as const;
const KIND_WORD: Record<SleepItemInfo["kind"], string> = { thought: "thought", question: "question", persona: "persona suggestion" };
const plural = (n: number, one: string, many: string) => <><span className="num">{n}</span> {n === 1 ? one : many}</>;

/** Stored text as it reads: names for mention tokens (someone, where the user isn't known here), no citation groups. */
const plain = (text: string, users: UserMap) => plainCitations(readable(text, users)).replace(/\[\[u:[^\]]+\]\]/g, "someone");

/** A memory's link: a page, a note or a journal entry in that pool; a persona suggestion has none. */
const memoryLink = (userId: string, pool: Pool, id?: string) => (id && !/^(draft|proposal):/.test(id) ? idHref(userId, pool, id) : undefined);

function PoolName({ pool }: { pool: Pool }) {
  return <span className={`kind ${pool}`}>{pool === "private" && <PoolLock />}{poolWord(pool)}</span>;
}

export function SleepCard({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const o = ctx.sleep.overview;
  const items = (o?.items ?? []).filter((i) => i.new && !hidden(ctx.me.display, i.pool));
  const last = o?.runs.find((r) => !hidden(ctx.me.display, r.pool));
  const users: UserMap = { [userId]: { displayName: ctx.user.displayName, pronouns: ctx.user.pronouns } };
  const [run, busy, error] = useAction();
  const chat = (i: SleepItemInfo) => run(async () => {
    const t = await post<ThreadSummary>(u(userId, "sleep", i.pool, "items", i.id, "chat"));
    ctx.sleep.reload(); ctx.refreshThreads();
    go({ page: "thread", userId, pool: t.pool, threadId: t.id });
  });
  const dismiss = (i: SleepItemInfo) => run(async () => {
    await del(u(userId, "sleep", i.pool, "items", i.id));
    if (o) ctx.sleep.set({ ...o, items: o.items.filter((x) => x !== i) });
    ctx.sleep.reload();
  });
  return (
    <section className="card" aria-labelledby="h-home-sleep">
      <div className="section-head"><h2 id="h-home-sleep">From sleep</h2><a href={href({ page: "sleep", userId })}>Sleep</a></div>
      <ErrorText error={ctx.sleep.error || error} />
      {o && (items.length ? <ul className="list sleep-items">{items.map((i) => (
        <li key={`${i.pool}/${i.id}`} className="sleep-item">
          {/* Three lines until its own link opens the rest, as a From sleep row in Notifications does (§6). */}
          <div className="main-col"><ClampedText className="text" text={plain(i.text, users)} prefix={i.pool === "private" ? <span className="private" title="Private"><Icon name="lock" /><span className="sr-only">Private: </span></span> : undefined} /></div>
          <div className="actions">
            <button type="button" className="sm" disabled={busy} onClick={() => void chat(i)}>Start a chat</button>
            <button type="button" className="sm" disabled={busy} onClick={() => void dismiss(i)}>Dismiss</button>
          </div>
        </li>
      ))}</ul> : <p className="empty">Nothing she wants to raise.{last && <> She slept at <span className="num" title={last.finishedAt ?? last.startedAt}>{clock(last.finishedAt ?? last.startedAt)}</span>.</>}</p>)}
    </section>
  );
}

/** The run's one line: why it was skipped, what phase it's in, or what it wrote. */
function runLine(run: SleepRunInfo, d?: SleepRunDetail): ReactNode {
  if (run.status === "skipped") return run.skipReason ? SKIPPED[run.skipReason] : "Skipped";
  if (run.status === "running") {
    const order = ["consolidate", "dream", "wake"] as const;
    const at = [...order].reverse().find((p) => run.phases[p]) ?? "consolidate";
    return `Sleeping… ${PHASE_WORD[at]}`;
  }
  const early = run.status === "partial" ? "Stopped early" : "";
  if (!d) return early || "Complete";
  const created = d.pages.filter((p) => p.before === undefined).length, changed = d.pages.length - created;
  const thoughts = d.items.filter((i) => i.kind === "thought").length, persona = d.items.length - thoughts;
  const written = [d.dream.length > 0 && "dream", d.wake && "WAKE"].filter(Boolean).join(" and ");
  const parts: ReactNode[] = [
    early,
    d.notes.length > 0 && <>{plural(d.notes.length, "note", "notes")} added</>,
    created > 0 && <>{plural(created, "page", "pages")} created</>,
    changed > 0 && <>{plural(changed, "page", "pages")} changed</>,
    d.questions.length > 0 && plural(d.questions.length, "question", "questions"),
    thoughts > 0 && plural(thoughts, "thought", "thoughts"),
    persona > 0 && plural(persona, "persona suggestion", "persona suggestions"),
    written && `${written} written`,
  ].filter(Boolean);
  return parts.length > (early ? 1 : 0) ? parts.map((p, k) => <Fragment key={k}>{k > 0 && " · "}{p}</Fragment>) : early || "Nothing changed";
}

export function SleepPage({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const { reload } = ctx.sleep;
  const display = ctx.me.display;
  // Pools hidden in the Sort menu leave out their items and runs, as on the Memory page.
  const o = useMemo(() => {
    const ov = ctx.sleep.overview;
    return ov && { ...ov, items: ov.items.filter((i) => !hidden(display, i.pool)), runs: ov.runs.filter((r) => !hidden(display, r.pool)) };
  }, [ctx.sleep.overview, display.showGeneral, display.showPrivate]); // eslint-disable-line react-hooks/exhaustive-deps
  const [run, busy, error] = useAction();
  const [details, setDetails] = useState<Record<string, SleepRunDetail>>({});

  // Her events while the page is open: a run starting or ending refreshes the overview; manual mode's fresh thread opens.
  useEffect(() => {
    const es = new EventSource(u(userId, "sleep", "events"));
    const on = (m: MessageEvent<string>) => {
      try {
        const e = JSON.parse(m.data) as SleepEvent;
        if (e.type === "thread") { ctx.refreshThreads(); go({ page: "thread", userId, pool: e.pool, threadId: e.threadId }); }
        else reload();
      } catch { /* not ours */ }
    };
    for (const type of ["started", "phase", "finished", "thread"]) es.addEventListener(type, on);
    return () => es.close();
  }, [userId, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = (o?.runs ?? []).slice(0, 1);
  // The history page's total decides whether the preview's Show all is worth showing; one row answers that cheaply.
  const runTotal = useLoad(() => get<HistoryPage<SleepRunInfo>>(`${u(userId, "sleep", "history")}?limit=1`), [userId]);

  // Last night's runs are read at once, for their lines; an earlier one when it opens. Reread when a run ends.
  const load = useCallback((r: SleepRunInfo) => get<SleepRunDetail>(u(userId, "sleep", r.pool, "runs", r.id)).then((d) => setDetails((m) => ({ ...m, [`${r.pool}/${r.id}`]: d }))), [userId]);
  const lastKey = last.map((r) => `${r.pool}/${r.id}/${r.status}`).join(" ");
  useEffect(() => { for (const r of last) if (r.status !== "skipped") void load(r).catch(() => {}); }, [lastKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const users: UserMap = useMemo(() => Object.assign({ [ctx.user.id]: { displayName: ctx.user.displayName, pronouns: ctx.user.pronouns } }, ...Object.values(details).map((d) => d.users)), [ctx.user, details]);
  const items = (o?.items ?? []).filter((i) => i.new);
  const chat = (i: SleepItemInfo) => run(async () => {
    const t = await post<ThreadSummary>(u(userId, "sleep", i.pool, "items", i.id, "chat"));
    reload(); ctx.refreshThreads();
    go({ page: "thread", userId, pool: t.pool, threadId: t.id });
  });
  const dismiss = (i: SleepItemInfo) => run(async () => {
    await del(u(userId, "sleep", i.pool, "items", i.id));
    if (o) ctx.sleep.set({ ...o, items: o.items.filter((x) => x !== i) });
    reload();
  });

  const row = (r: SleepRunInfo) => <RunRow key={`${r.pool}/${r.id}`} run={r} detail={details[`${r.pool}/${r.id}`]} userId={userId} users={users} load={load} />;
  return (
    <main className="main">
      <PageHead ctx={ctx} title="Sleep" facts={items.length > 0 ? <><span className="num">{items.length}</span> new</> : undefined} />
      <div className="scroll">
        <div className="sleep">
          <section aria-labelledby="h-sleep-items" className="sleep-block">
            <h2 id="h-sleep-items" className="sr-only">Items</h2>
            <ErrorText error={ctx.sleep.error || error} />
            {o && !items.length && <p className="empty">Nothing to raise.</p>}
            {items.length > 0 && (
              <ul className="list sleep-items" aria-label="Items">
                {items.map((i) => (
                  <li key={`${i.pool}/${i.id}`} className="sleep-item" data-item={i.id}>
                    <div className="main-col">
                      <span className="text">{plain(i.text, users)}</span>
                      <span className="cap"><PoolName pool={i.pool} /> · {KIND_WORD[i.kind]} · <span className="num">{shortTime(i.createdAt)}</span>
                        {memoryLink(userId, i.pool, i.source) && <> · <a href={memoryLink(userId, i.pool, i.source)}>Came from</a></>}</span>
                    </div>
                    <div className="actions">
                      <button type="button" className="sm" disabled={busy} onClick={() => void chat(i)}>Start a chat</button>
                      <button type="button" className="sm" disabled={busy} onClick={() => void dismiss(i)}>Dismiss</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(["general", "private"] as const).filter((p) => hidden(display, p)).map((p) => (
              <p key={p} className="muted small">{poolWord(p)} is hidden. Turn on {poolWord(p)} in the Sort menu to see it.</p>
            ))}
          </section>
          <section aria-label="History" className="sleep-block">
            <HistoryHead to={{ page: "history", userId, kind: "sleep" }} count={runTotal.data?.total} />
            <div className="list sleep-runs">{last.map(row)}</div>
          </section>
          {o && !o.runs.length && <p className="empty">No sleep yet.</p>}
          <SleepFoot ctx={ctx} />
        </div>
      </div>
    </main>
  );
}

export function SleepHistoryPage({ ctx, route }: { ctx: ShellContext; route?: Extract<Route, { page: "history" }> }) {
  const userId = ctx.user.id;
  const [details, setDetails] = useState<Record<string, SleepRunDetail>>({});
  const load = (r: SleepRunInfo) => get<SleepRunDetail>(u(userId, "sleep", r.pool, "runs", r.id)).then((d) => setDetails((all) => ({ ...all, [`${r.pool}/${r.id}`]: d })));
  return <main className="main">
    <PageHead ctx={ctx} title="Sleep history"><a href={href({ page: "sleep", userId })}>Sleep</a></PageHead>
    <div className="scroll"><div className="sleep">
      <HistoryList<SleepRunInfo> key={`${userId}/${ctx.me.display.showGeneral}/${ctx.me.display.showPrivate}`} route={route} path={u(userId, "sleep", "history")} render={(page) => {
        const days = new Map<string, SleepRunInfo[]>();
        for (const r of page.entries) { const day = dateText(r.startedAt, { day: "numeric", month: "long", year: "numeric" }); days.set(day, [...(days.get(day) ?? []), r]); }
        return <div className="stack">{[...days].map(([day, runs]) => <div className="sleep-day" key={day}>
          <div className="eyebrow num">{day}</div>
          <div className="list sleep-runs">{runs.map((r) => <RunRow key={`${r.pool}/${r.id}`} run={r} detail={details[`${r.pool}/${r.id}`]} userId={userId}
            users={{ [userId]: { displayName: ctx.user.displayName, pronouns: ctx.user.pronouns } }} load={load} />)}</div>
        </div>)}</div>;
      }} />
    </div></div>
  </main>;
}

/** One run: the pool, the time, its line; it opens to what it wrote. */
function RunRow({ run, detail, userId, users, load }: { run: SleepRunInfo; detail?: SleepRunDetail; userId: string; users: UserMap; load: (r: SleepRunInfo) => Promise<void> }) {
  const [error, setError] = useState("");
  const open = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && !detail) load(run).catch((err: Error) => setError(err.message));
  };
  const head = <>
    <span className="t"><PoolName pool={run.pool} />{run.status === "running" && <span className="busy" title="Sleeping" />}<span className="when num">{clock(run.startedAt)}</span></span>
    <span className="meta">{runLine(run, detail)}</span>
  </>;
  // A skipped run wrote nothing, so there is nothing to open.
  if (run.status === "skipped") return <div className="sleep-run" data-run={run.id} data-pool={run.pool} data-status={run.status}><div className="sleep-sum">{head}</div></div>;
  return (
    <details className="sleep-run" data-run={run.id} data-pool={run.pool} data-status={run.status} onToggle={open}>
      <summary className="sleep-sum">{head}</summary>
      <div className="sleep-detail">
        <ErrorText error={error} />
        {detail ? <RunDetail d={detail} userId={userId} users={users} /> : !error && <p className="muted small">Loading…</p>}
      </div>
    </details>
  );
}

function RunDetail({ d, userId, users }: { d: SleepRunDetail; userId: string; users: UserMap }) {
  const all = { ...users, ...d.users };
  const text = (t: string) => plain(t, all);
  const empty = !d.notes.length && !d.pages.length && !d.questions.length && !d.items.length && !d.dream.length && !d.wake;
  const itemList = (list: SleepItemInfo[]) => (
    <ul className="plain">
      {list.map((i) => {
        const from = memoryLink(userId, d.pool, i.source);
        return (
          <li key={i.id}>{text(i.text)}
            {(from || i.thread) && <span className="cap">{from && <> · <a href={from}>Came from</a></>}{i.thread && <> · <a href={href({ page: "thread", userId, pool: d.pool, threadId: i.thread })}>Open thread</a></>}</span>}
          </li>
        );
      })}
    </ul>
  );
  return (
    <>
      {empty && <p className="muted small">Nothing changed.</p>}
      {d.notes.length > 0 && (
        <div className="sleep-part"><div className="eyebrow">Notes</div>
          <ul className="plain">{d.notes.map((n) => <li key={n.id}><a href={idHref(userId, d.pool, n.id)}>{text(n.text) || n.id}</a></li>)}</ul>
        </div>
      )}
      {d.pages.length > 0 && (
        <div className="sleep-part"><div className="eyebrow">Pages</div>
          <ul className="plain">
            {d.pages.map((p) => (
              <li key={p.id}>
                <a href={idHref(userId, d.pool, p.id)}>{p.title ? readable(p.title, all) : p.id}</a>
                <div className="wdiff">{wordDiff(p.before === undefined ? "" : text(p.before), text(p.after)).map((op, k) => (op.kind === "same" ? <span key={k}>{op.text}</span> : op.kind === "del" ? <del key={k}>{op.text}</del> : <ins key={k}>{op.text}</ins>))}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.questions.length > 0 && <div className="sleep-part"><div className="eyebrow">Questions</div>{itemList(d.questions)}</div>}
      {d.items.length > 0 && <div className="sleep-part"><div className="eyebrow">Thoughts</div>{itemList(d.items)}</div>}
      {d.dream.length > 0 && (
        <div className="sleep-part"><a className="eyebrow" href={idHref(userId, d.pool, d.dream[0]!.id)}>Dream</a>
          {d.dream.map((x) => <div key={x.id} className="prose small"><Prose text={text(x.text)} /></div>)}
        </div>
      )}
      {d.wake && (
        <div className="sleep-part"><a className="eyebrow" href={idHref(userId, d.pool, "wake")}>WAKE</a>
          <div className="prose small"><Prose text={text(d.wake)} /></div>
        </div>
      )}
    </>
  );
}

/** Sleep now, with its menu of pools, and the mode in one line with a link to where it changes. */
function SleepFoot({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const o = ctx.sleep.overview;
  const pools = (["general", "private"] as const).filter((p) => !hidden(ctx.me.display, p));
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<{ pool: Pool; sentence: string }>();
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const sleep = async (pool: Pool, confirm?: true) => {
    setOpen(false); setBusy(true); setToast("");
    try {
      const r = await post<SleepStarted>(u(userId, "sleep", pool), confirm ? { confirm } : {});
      if ("confirm" in r) setAsking({ pool, sentence: r.confirm });
      else ctx.sleep.reload();
    } catch (e) { setToast(e instanceof HttpError ? e.message : String(e)); } finally { setBusy(false); }
  };
  const change = href({ page: "settings", userId, section: "sleep" });
  return (
    <div className="sleep-foot">
      <div className="msg-menu" ref={ref}>
        <button type="button" disabled={busy || !pools.length} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Sleep now <span className="caret" aria-hidden="true">▾</span></button>
        {open && (
          <div className="menu above" role="menu" aria-label="Sleep now">
            {pools.map((p) => <button key={p} type="button" role="menuitem" onClick={() => void sleep(p)}>{p === "private" && <PoolLock />}{poolWord(p)}</button>)}
          </div>
        )}
      </div>
      {o && (
        <span className="cap sleep-mode">
          {o.mode === "scheduled" ? <>Scheduled nightly at <span className="num">{o.time}</span></> : "Manual: only when you ask"} · <a href={change}>change</a>
        </span>
      )}
      {asking && (
        // lyricad's sentence opens with its question: that is the dialog's title, the rest its sentence.
        <ConfirmDialog title={/^[^?]*\?/.exec(asking.sentence)?.[0] ?? "Sleep now?"} sentence={asking.sentence.replace(/^[^?]*\?\s*/, "") || asking.sentence} confirm="Sleep now"
          onCancel={() => setAsking(undefined)} onConfirm={() => { const p = asking.pool; setAsking(undefined); void sleep(p, true); }} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button type="button" className="icon sm" aria-label="Dismiss" onClick={() => setToast("")}><Icon name="close" /></button>
        </div>
      )}
    </div>
  );
}

/** Settings → Sleep: when sleep happens for this user. Saved at once, like Sleep fallback beside it. */
export function SleepModeField({ ctx }: { ctx: ShellContext }) {
  const o = ctx.sleep.overview;
  const [run, busy, error] = useAction();
  if (!o) return null;
  const set = (mode: SleepMode) => run(async () => ctx.sleep.set(await put<SleepOverview>(u(ctx.user.id, "sleep", "mode"), { mode })));
  return (
    <>
      <label className="field sleep-mode-field"><span>Sleep</span>
        <select name="sleep-mode" aria-label="Sleep" value={o.mode} disabled={busy} onChange={(e) => void set(e.target.value as SleepMode)}>
          <option value="scheduled">Nightly at {o.time}</option>
          <option value="manual">Only when I ask</option>
        </select>
      </label>
      <ErrorText error={error} />
    </>
  );
}

/** Administration → Sleep: the time each pool with new activity sleeps. */
export function SleepTimeSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const path = u(userId, "admin", "sleep");
  const sleep = useLoad(() => get<SleepTime>(path), [path]);
  const [run, busy, error] = useAction();
  const [time, setTime] = useState<string>();
  const save = () => run(async () => { sleep.set(await put<SleepTime>(path, { time: time ?? sleep.data?.time })); setTime(undefined); ctx.sleep.reload(); });
  return (
    <section className="card" aria-labelledby="h-sleep">
      <div className="section-head"><h2 id="h-sleep">Sleep</h2></div>
      <ErrorText error={sleep.error || error} />
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span title="Each user sleeps at this time in their own time zone.">Sleep time</span><input type="time" name="sleep-time" value={time ?? sleep.data?.time ?? ""} onChange={(e) => setTime(e.target.value)} /></label>
        <button className="primary" disabled={busy || !time || time === sleep.data?.time}>Save</button>
      </form>
    </section>
  );
}
