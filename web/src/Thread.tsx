// One thread: header with its badges, the conversation, and the composer.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { del, get, patch, post, put, threadPath, u, HttpError, type MachineInfo, type Pins, type Pool, type RemovalPlan, type RewindRequest, type SendResponse, type ThreadSettings, type ThreadSettingsChange, type ThreadSummary, type ThreadTombstone, type ThreadUsage, type WakeupInfo } from "./api.ts";
import { Icon } from "./icons.tsx";
import { hasConsequences, jumpTo, PinnedBadge, RemovalConfirm, useUndo, type Rewinder } from "./Rewind.tsx";
import { JUMP_EVENT, JUMP_KEY, SHOW_EVENT, SHOW_KEY, take, type JumpRequest, type ShowRequest } from "./links.ts";
import { go, href } from "./route.ts";
import { ProjectWelcome, ThreadsFact, useOverview, type ProjectEnv } from "./Project.tsx";
import { useThread } from "./stream.ts";
import { Conversation, MessageBox } from "./Messages.tsx";
import { Composer } from "./Composer.tsx";
import { ContextFact, newerContext } from "./ContextMeter.tsx";
import { TokensFact } from "./Usage.tsx";
import { RoutinesFact } from "./Routines.tsx";
import { ChecklistButton } from "./Checklist.tsx";
import { ModelBadge, SettingsDrawer } from "./Settings.tsx";
import { Crumbs, Main, PanelButtons, usePanel, type ShellContext } from "./Shell.tsx";
import { ThreadMenu, type MenuAt } from "./ThreadMenu.tsx";
import { ErrorText, useAction, useDismiss, useLoad, wakeTime } from "./ui.tsx";
import { stopReading } from "./Voice.tsx";
import { Tombstone } from "./Tombstone.tsx";

export function Thread({ ctx, pool, threadId, threads, drawerAtStart, dropDrawer }: {
  ctx: ShellContext; pool: Pool; threadId: string; threads: ThreadSummary[];
  /** Opened by its address (…/settings): the drawer shows, and `dropDrawer` takes that off the address once it closes, so a reload doesn't reopen it. */
  drawerAtStart?: boolean; dropDrawer?: () => void;
}) {
  const userId = ctx.user.id;
  const base = threadPath(userId, pool, threadId);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  // A thread deleted with its memories kept has a tombstone where the thread was.
  const gone = useLoad(() => (summary.error ? get<ThreadTombstone>(`${base}/tombstone`).catch(() => undefined) : Promise.resolve(undefined)), [base, summary.error]);
  const settings = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  const pins = useLoad(() => get<Pins>(`${base}/pins`), [base]);
  // The user's machines, for the granted ones' limits in the mode menu and the settings drawer.
  const machines = useLoad(() => get<MachineInfo[]>(u(userId, "machines")), [userId]);
  const granted = settings.data?.machines.flatMap((name) => { const m = machines.data?.find((x) => x.name === name); return m ? [{ name, limit: m.limit }] : []; }) ?? [];
  const t = useThread(userId, pool, threadId);
  const [drawer, setDrawer] = useState(!!drawerAtStart);
  // Two Thread trees can share a page (the panel), so the drawer's id is this one's.
  const drawerId = useId();
  const dropped = useRef(false);
  useEffect(() => { if (drawerAtStart && !drawer && !dropped.current) { dropped.current = true; dropDrawer?.(); } }, [drawer, drawerAtStart, dropDrawer]);
  const [sendError, setSendError] = useState("");
  const { refreshThreads } = ctx;
  // A project chat: its threads, reloaded when one changes state or a turn ends.
  const isProject = !!summary.data?.project;
  const usage = useLoad(() => get<ThreadUsage>(`${base}/usage`), [base, t.live.children, t.live.reload]);
  const overview = useOverview(userId, pool, threadId, isProject, t.live.children + t.live.reload);
  const usageProps = usage.data ? { usage: usage.data, userId, pool, threadId, threads: overview.data?.threads ?? threads } : undefined;
  useEffect(() => { if (t.live.children) refreshThreads(); }, [t.live.children, refreshThreads]);
  // Each thread's last update to the project chat, for its card.
  const lastUpdates = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of t.messages) {
      if (m.role !== "notice") continue;
      for (const p of m.parts) if (p.type === "delegation" && p.threads?.[0] && (p.status === "update" || p.status === "waiting")) out.set(p.threads[0].id, afterHead(p.text));
    }
    for (const item of t.live.items) if (item.role === "notice" && item.threads?.[0] && (item.status === "update" || item.status === "waiting")) out.set(item.threads[0].id, afterHead(item.text));
    return out;
  }, [t.messages, t.live.items]);
  const projectEnv: ProjectEnv | undefined = isProject && overview.data ? { overview: overview.data, lastUpdates, onChange: () => { overview.reload(); refreshThreads(); }, toast: ctx.toast } : undefined;

  // A new title, or a finished turn, may change the sidebar.
  useEffect(() => { if (t.live.title) { summary.reload(); refreshThreads(); } }, [t.live.title, summary.reload, refreshThreads]);
  useEffect(() => { if (t.live.reload) refreshThreads(); }, [t.live.reload, refreshThreads]);
  // A child thread's update changes its badge in the sidebar.
  const updates = t.live.items.filter((x) => x.role === "notice").length;
  useEffect(() => { if (updates) refreshThreads(); }, [updates, refreshThreads]);
  // The badge follows the preset, which may change elsewhere: refresh it after each turn and on focus.
  // A refresh that a change overtakes is dropped, so it can't undo a Shift+Tab pressed meanwhile.
  const latest = useRef(0);
  const inFlight = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const refreshSettings = useCallback(() => {
    const n = latest.current;
    get<ThreadSettings>(`${base}/settings`).then((s) => { if (n === latest.current && !inFlight.current) settings.set(s); }, () => {});
  }, [base, settings.set]);
  useEffect(() => { if (t.live.reload || t.live.settings) refreshSettings(); }, [t.live.reload, t.live.settings, refreshSettings]);
  // Wake-ups set, removed or fired arrive on the stream with the whole list.
  const setWakeups = useCallback((wakeups: WakeupInfo[]) => { if (settings.data) settings.set({ ...settings.data, wakeups }); }, [settings.data, settings.set]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (t.live.wakeups) setWakeups(t.live.wakeups); }, [t.live.wakeups]);
  // A rewind may take pinned messages with it.
  useEffect(() => { if (t.live.reload) pins.reload(); }, [t.live.reload, pins.reload]);
  useEffect(() => {
    addEventListener("focus", refreshSettings);
    return () => removeEventListener("focus", refreshSettings);
  }, [refreshSettings]);

  // Leaving the thread stops anything being read aloud.
  useEffect(() => stopReading, [base]);

  // Show in thread, from the Files panel: the first message that names the file (the upload, or her call that wrote it).
  const messages = t.messages;
  const showFile = useCallback((path: string) => {
    const names = (m: typeof messages[number]) => m.parts.some((p) => (p.type === "text" || p.type === "delegation") ? p.text.includes(path) : p.type === "tool" ? JSON.stringify(p.args ?? "").includes(path) : false);
    const m = messages.find(names);
    if (m) jumpTo(m.n);
    return !!m;
  }, [messages]);
  useEffect(() => {
    const on = (e: Event) => {
      const { detail } = e as CustomEvent<ShowRequest>;
      if (detail.base !== base) return;
      detail.handled = true;
      detail.found = showFile(detail.path);
    };
    addEventListener(SHOW_EVENT, on);
    return () => removeEventListener(SHOW_EVENT, on);
  }, [base, showFile]);
  // Kept by the Files page (a phone): shown once the messages are here.
  useEffect(() => {
    if (!messages.length) return;
    const kept = take<ShowRequest>(SHOW_KEY, base);
    if (kept && !showFile(kept.path)) setSendError("That file isn't named in the messages shown.");
  }, [messages, base, showFile]);

  // A search hit in the sidebar opens the thread at its message: older pages load until it is here.
  const [jump, setJump] = useState<{ n: number; atOnce: boolean }>();
  const loadingTo = useRef<number>(undefined);
  useEffect(() => {
    const on = (e: Event) => {
      const { detail } = e as CustomEvent<JumpRequest>;
      if (detail.base !== base) return;
      detail.handled = true;
      setJump({ n: detail.n, atOnce: false });
    };
    addEventListener(JUMP_EVENT, on);
    return () => removeEventListener(JUMP_EVENT, on);
  }, [base]);
  useEffect(() => {
    if (!t.loaded) return;
    const kept = take<JumpRequest>(JUMP_KEY, base);
    if (kept) setJump({ n: kept.n, atOnce: true });
  }, [t.loaded, base]);
  const { loaded, hasMore, loadUntil } = t;
  useEffect(() => {
    if (!jump || !loaded) return;
    if (messages.some((m) => m.n === jump.n)) { jumpTo(jump.n, { atOnce: jump.atOnce }); setJump(undefined); return; }
    if (hasMore && (messages[0]?.n ?? 0) > jump.n) {
      if (loadingTo.current === jump.n) return;
      loadingTo.current = jump.n;
      loadUntil(jump.n).catch((e: Error) => { setSendError(e.message); setJump(undefined); }).finally(() => { loadingTo.current = undefined; });
      return;
    }
    setJump(undefined);
  }, [jump, messages, loaded, hasMore, loadUntil]);

  const send = useCallback(async (text: string) => {
    setSendError("");
    stopReading();
    try {
      await queue.current; // a mode just picked applies to this message
      const afterN = t.messages.at(-1)?.n ?? 0;
      const r = await post<SendResponse>(`${base}/messages`, { text });
      if (!r.queued) t.dispatch({ type: "sent", text, afterN });
      return true;
    } catch (e) {
      // While an update drains, the message stays in the box and the line says Updating.
      setSendError((e as HttpError).updating ? "Updating" : (e as Error).message);
      return false;
    }
  }, [base, t.dispatch, t.messages]);
  // The mode and switches beside the message box: shown at once, so Shift+Tab pressed again cycles on from here.
  // Changes go to the server one at a time, so the last one pressed is the one saved; only its answer is shown.
  const changeSettings = useCallback((change: ThreadSettingsChange) => {
    setSendError("");
    const n = ++latest.current;
    inFlight.current++;
    if (settings.data && change.internet === undefined) settings.set({ ...settings.data, ...(change as Partial<ThreadSettings>) });
    queue.current = queue.current.then(() => patch<ThreadSettings>(`${base}/settings`, change)).finally(() => inFlight.current--).then(
      (s) => { if (n === latest.current) settings.set(s); },
      (e: Error) => { setSendError(e.message); settings.reload(); },
    );
  }, [base, settings.data, settings.set, settings.reload]);
  // Stop drops queued follow-ups, so their text goes back into the composer.
  const [restored, setRestored] = useState("");
  const stop = () => {
    if (t.live.queued.length) setRestored(t.live.queued.join("\n\n"));
    t.dispatch({ type: "stopping" });
    post(`${base}/stop`).catch((e: Error) => setSendError(e.message));
  };

  const s = summary.data;
  // Branch, regenerate, edit and delete, from each message's menu. Deleting waits for Undo.
  const { pending, later, undo } = useUndo();
  const [removal, setRemoval] = useState<{ plan: RemovalPlan; go: (skip: string[]) => void }>();
  const rewind = (n: number, req: RewindRequest) => post(`${base}/messages/${n}/rewind`, req).catch((e: Error) => setSendError(e.message));
  const rewinder: Rewinder | undefined = s && !s.subagent ? {
    settings: settings.data,
    busy: t.live.busy,
    lastTurn: t.messages.findLast((m) => m.role === "user")?.n,
    pinned: new Set(pins.data?.pins.map((p) => p.n)),
    pin: (n, on) => {
      setSendError("");
      (on ? put(`${base}/messages/${n}/pin`, {}) : del(`${base}/messages/${n}/pin`)).then(pins.reload, (e: Error) => setSendError(e.message));
    },
    // The thread's event stream brings the new reactions to this tab as to any other.
    react: (n, emoji, on) => {
      setSendError("");
      const path = `${base}/messages/${n}/reactions/${encodeURIComponent(emoji)}`;
      (on ? put(path, {}) : del(path)).catch((e: Error) => setSendError(e.message));
    },
    branch: (n) => {
      setSendError("");
      post<ThreadSummary>(`${base}/messages/${n}/branch`).then((b) => { refreshThreads(); go({ page: "thread", userId, pool, threadId: b.id }); },
        (e: Error) => setSendError(e.message));
    },
    rewind: (n, req, hide) => {
      setSendError("");
      // Turns that did things (files, branches, commands, pins, subagents) are confirmed first, with what goes.
      post<RemovalPlan>(`${base}/messages/${n}/rewind`, { ...req, preview: true }).then(
        (plan) => (hasConsequences(plan) ? setRemoval({ plan, go: (skip) => removeTurns(n, { ...req, skip }, hide) }) : removeTurns(n, req, hide)),
        (e: Error) => setSendError(e.message));
    },
    ...(s.project ? {
      startThread: (n: number) => {
        setSendError("");
        post<ThreadSummary>(`${base}/messages/${n}/thread`, {}).then(() => { overview.reload(); refreshThreads(); }, (e: Error) => setSendError(e.message));
      },
    } : {}),
  } : undefined;
  function removeTurns(n: number, req: RewindRequest, hide: number) {
    const last = t.messages.findLast((m) => m.role === "user")?.n;
    // What is sent again: the edited text, or the question her reply answered.
    const resend = req.action === "edit" ? req.text : req.action === "regenerate"
      ? t.messages.filter((m) => m.n < n && m.role === "user" && !m.from).at(-1)?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : undefined;
    const go = () => { t.willResend(resend); void rewind(n, req); };
    // Removing turns waits for Undo; regenerating or editing the last turn goes at once.
    if (req.action === "delete") later(n === last ? "Turn deleted" : "Messages deleted", hide, go);
    else if (last !== undefined && n < last) later(req.action === "edit" ? "Message edited" : "Regenerating", hide, go);
    else go();
  }
  const parent = s?.parent ? findThread(threads, pool, s.parent) : undefined;
  const title = t.live.title || s?.title || (s?.project ? "New project" : "New thread");
  const resolved = s?.state === "resolved";
  const reopen = () => post<ThreadSummary>(`${base}/reopen`).then((x) => { summary.set(x); refreshThreads(); }, (e: Error) => setSendError(e.message));
  const scroller = useStickyScroll([t.messages, t.live]);
  // On a phone the tokens move into the Threads popover, so the facts line stays at two rows.
  const phone = usePhone();
  // The stream's reading after a turn, or the one the settings brought (the open session's, else the last call's).
  const context = newerContext(t.live.context, settings.data?.context);
  // Her checklist: the stream's, once a `steps` event came, else the summary's; none while Checklists is off.
  const steps = ctx.me.display.checklists ? t.live.steps ?? s?.steps : undefined;
  // The thread's menu from the header's ⋯, the sidebar's own (docs/ux.md §6), under the button.
  const panel = usePanel();
  const [menuAt, setMenuAt] = useState<MenuAt>();
  const moreBtn = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => { setMenuAt(undefined); moreBtn.current?.focus(); }, []);
  const listed = findThread(threads, pool, threadId) ?? s;
  if (!s && summary.error && gone.data) return <Tombstone userId={userId} pool={pool} data={gone.data} />;

  return (
    <Main className="main" data-drawer-open={drawer}>
      <header className="head thread-head">
        <button type="button" className="menu-btn icon" aria-label="Show threads" onClick={ctx.openSide}><Icon name="menu" /></button>
        <div className="head-title">
          <Crumbs />
          <h1>{title}</h1>
          <div className="tfacts">
            <span className={`k ${pool}`}>{pool}</span>
            {settings.data && <ModelBadge base={base} settings={settings.data} onChange={settings.set} readOnly={!!s?.subagent} />}
            {pins.data && !s?.subagent && <PinnedBadge pins={pins.data} you={ctx.user.displayName} userId={ctx.user.id} pool={pool} />}
            {s && !s.subagent && !s.child && <GroupPicker ctx={ctx} base={base} summary={s} onChange={(x) => { summary.set(x); refreshThreads(); }} />}
            {context && <ContextFact context={context} footer={phone && !isProject && usageProps ? <TokensFact {...usageProps} inline /> : undefined} />}
            {!!steps?.length && <ChecklistButton steps={steps} />}
            {!phone && usageProps && <TokensFact {...usageProps} />}
            {s?.project && overview.data && <ThreadsFact userId={userId} pool={pool} threadId={threadId} overview={overview.data} footer={phone && usageProps ? <TokensFact {...usageProps} inline /> : undefined} />}
            {!!settings.data?.routines?.length && <RoutinesFact userId={userId} routines={settings.data.routines} onChange={refreshSettings} />}
            {!!settings.data?.wakeups?.length && <WakeupsFact base={base} wakeups={settings.data.wakeups} onChange={setWakeups} />}
            {settings.data?.localOnly && pool === "general" && <span className="badge"><span className="k local">local-only</span></span>}
            {settings.data?.grants.map((g) => (
              <span key={g.path} className="badge folder" title={g.path}>{g.path} <span className="muted">{g.writable ? "rw" : "ro"}</span></span>
            ))}
            {settings.data?.machines.map((m) => <span key={m} className="badge folder" title="Machine">{m}</span>)}
            {settings.data?.repositories.map((r) => <span key={`${r.account}/${r.name}`} className="badge folder" title={`Repository, through ${r.account}`}>{r.name}</span>)}
            {settings.data?.mcpServers.map((m) => <span key={`mcp:${m}`} className="badge folder" title="MCP server">{m}</span>)}
          </div>
        </div>
        {!s?.subagent && (
          <div className="head-actions">
            {/* A project chat keeps its drawer (folders, network, local-only, the other task models); the page holds the project's own settings. */}
            {s?.project && <a className="link project-link" href={href({ page: "project", userId, pool, threadId })} aria-label="Project settings"><Icon name="project" /><span className="long">Project</span></a>}
            {/* The Files panel (docs/ux.md §6): beside the conversation from the split width, the page on its own below it. */}
            <a className="sm" href={href({ page: "files", userId, pool, threadId })} aria-label="Files and images"><Icon name="panel" /><span className="long">Files</span></a>
            <button type="button" className="sm" aria-label="Thread settings" aria-expanded={drawer} aria-controls={drawerId} onClick={() => setDrawer(!drawer)}>
              <Icon name="gear" /><span className="long">Settings</span>
            </button>
            {/* Its pointerdown stays here, so a press while the menu is open closes it rather than closing and reopening. */}
            {listed && (
              <button ref={moreBtn} type="button" className="icon sm" aria-label="Thread actions" title="Thread actions" aria-haspopup="menu" aria-expanded={!!menuAt}
                onPointerDown={(e) => { if (menuAt) e.stopPropagation(); }}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt(menuAt ? undefined : { x: r.right, y: r.bottom + 4, thread: listed, end: true }); }}>
                <Icon name="more" />
              </button>
            )}
          </div>
        )}
        <PanelButtons />
      </header>
      {parent && (
        <p className="subnote">{s?.subagent ? "Subagent of" : s?.child ? "Child thread of" : "Branched from"} <a href={`#/u/${encodeURIComponent(userId)}/t/${pool}/${encodeURIComponent(parent.id)}`}>{parent.title || "the parent thread"}</a></p>
      )}
      <div className="scroll" ref={scroller}>
        <PendingBar scroller={scroller} deps={[t.messages, t.live.permissions]} />
        <ErrorText error={summary.error || t.loadError} />
        {settings.error && <ErrorText error={`This thread's settings didn't load: ${settings.error}`} />}
        <ErrorText error={overview.error} />
        {s?.project && settings.data && t.loaded && !t.messages.length && !t.live.items.length && <ProjectWelcome userId={userId} pool={pool} project={s} settings={settings.data} onChange={() => { summary.reload(); settings.reload(); overview.reload(); refreshThreads(); }} />}
        <Conversation ctx={ctx} pool={pool} base={base} threadId={threadId} subagent={!!s?.subagent} thread={t} rewinder={rewinder} hideFrom={pending?.hide} parentTitle={s?.child ? parent?.title : undefined}
          speech={settings.data?.speech} onError={setSendError} project={projectEnv} />
        <ErrorText error={sendError} />
      </div>
      {!t.connected && <p className="offline" role="status">Reconnecting…</p>}
      {removal && (
        <RemovalConfirm plan={removal.plan} onCancel={() => setRemoval(undefined)}
          onConfirm={(skip) => { setRemoval(undefined); removal.go(skip); }} />
      )}
      {pending && (
        <div className="toast" role="status">
          <span>{pending.label}</span>
          <button type="button" className="link" onClick={undo}>Undo</button>
        </div>
      )}
      {/* A subagent's thread is its transcript and a message box, as in its delegate card; a resolved project thread has one Reopen link. */}
      {s?.subagent
        ? <div className="composer sub-composer"><MessageBox thread={{ pool, id: threadId }} env={{ userId }} onSent={() => t.dispatch({ type: "refresh" })} /></div>
        : resolved
        ? <div className="composer resolved-box"><p className="muted">Resolved. <button type="button" className="link" onClick={() => void reopen()}>Reopen</button></p></div>
        : <Composer base={base} busy={t.live.busy} onSend={send} onStop={stop} restored={restored} settings={settings.data} machines={granted} onSettings={changeSettings} onError={setSendError} />}
      {drawer && settings.data && s && !s.subagent && (
        <SettingsDrawer
          ctx={ctx} base={base} summary={s} settings={settings.data} machines={machines.data ?? []} children={findThread(threads, pool, threadId)?.children.length ?? 0}
          onSettings={settings.set} onSummary={(x) => { summary.set(x); refreshThreads(); }}
          onClose={() => setDrawer(false)} id={drawerId}
        />
      )}
      {drawer && <div className="scrim drawer-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />}
      {menuAt && (
        <ThreadMenu at={menuAt} userId={userId} groups={ctx.groups} onGroups={ctx.refreshGroups} onToast={ctx.toast}
          onChange={() => { summary.reload(); refreshThreads(); }} onClose={closeMenu}
          onGone={panel ? panel.close : () => go({ page: "home", userId })} />
      )}
    </Main>
  );
}

/** The thread's group, picked from a popover on its word in the facts line (docs/ux.md §6). */
function GroupPicker({ ctx, base, summary, onChange }: { ctx: ShellContext; base: string; summary: ThreadSummary; onChange: (s: ThreadSummary) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const [run, busy, error] = useAction();
  const current = ctx.groups.find((g) => g.id === summary.group);
  const pick = (group: string | null) => run(async () => { onChange(await patch<ThreadSummary>(base, { group })); close(); });
  const add = () => run(async () => {
    const g = await post<{ id: string }>(u(ctx.user.id, "thread-groups"), { name });
    ctx.refreshGroups();
    setName("");
    onChange(await patch<ThreadSummary>(base, { group: g.id }));
    close();
  });
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current ? current.name : "Group"} <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker" role="dialog" aria-label="Group">
          {ctx.groups.map((g) => (
            <button key={g.id} type="button" className="picker-item" aria-pressed={g.id === summary.group} disabled={busy} onClick={() => pick(g.id === summary.group ? null : g.id)}>{g.name}</button>
          ))}
          {current && <button type="button" className="picker-item" disabled={busy} onClick={() => pick(null)}>Not in a group</button>}
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void add(); }}>
            <input aria-label="New group" placeholder="New group" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="sm" disabled={busy || !name.trim()}>Add</button>
          </form>
          <ErrorText error={error} />
        </div>
      )}
    </span>
  );
}

/**
 * Her wake-ups waiting in this thread (docs/ux.md §6): Wake-up and the next time in the facts line,
 * a popover listing each by its time with Remove. Never her note.
 */
function WakeupsFact({ base, wakeups, onChange }: { base: string; wakeups: WakeupInfo[]; onChange: (w: WakeupInfo[]) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const [run, busy, error] = useAction();
  const remove = (id: number) => run(async () => {
    const left = await del<WakeupInfo[]>(`${base}/wakeups/${id}`);
    onChange(left);
    if (!left.length) close();
  });
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        Wake-up <span className="num">{wakeTime(wakeups[0]!.dueAt)}</span> <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker wake-pop" role="dialog" aria-label="Wake-ups">
          {wakeups.map((w) => {
            const at = wakeTime(w.dueAt);
            return (
              <div key={w.id} className="wake-item">
                <span className="num">{at}</span>
                <button type="button" className="icon sm" aria-label={`Remove wake-up at ${at}`} title="Remove" disabled={busy} onClick={() => void remove(w.id)}><Icon name="close" /></button>
              </div>
            );
          })}
          <ErrorText error={error} />
        </div>
      )}
    </span>
  );
}

/** Below the shell's phone breakpoint (app.css). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = matchMedia("(max-width: 760px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** An update's text without its first line, the head Lyrica reads ("Update from child thread …:"). */
function afterHead(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(nl + 1);
}

export function findThread(list: ThreadSummary[], pool: Pool, id: string): ThreadSummary | undefined {
  for (const t of list) {
    if (t.pool === pool && t.id === id) return t;
    const c = findThread(t.children, pool, id);
    if (c) return c;
  }
  return undefined;
}

/**
 * When the latest card waiting for her answer (a plan, an approval) has
 * scrolled out of view, a thin bar across the top of the conversation names
 * it and jumps to it.
 */
function PendingBar({ scroller, deps }: { scroller: React.RefObject<HTMLDivElement | null>; deps: unknown[] }) {
  const [kind, setKind] = useState("");
  const latest = () => [...scroller.current?.querySelectorAll<HTMLElement>("[data-pending]") ?? []].at(-1);
  useEffect(() => {
    const card = latest();
    if (!card) { setKind(""); return; }
    const seen = new IntersectionObserver(([e]) => setKind(e!.isIntersecting ? "" : card.dataset.pending ?? ""), { root: scroller.current });
    seen.observe(card);
    return () => seen.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  if (!kind) return null;
  return (
    <button type="button" className="pending-bar" onClick={() => latest()?.scrollIntoView({ block: "center", behavior: "smooth" })}>
      {kind} waiting for your answer
    </button>
  );
}

/**
 * Keeps the conversation scrolled to the bottom while new text arrives, unless she has scrolled up.
 * Whether she was at the bottom is judged against the height before this update, not from the
 * last scroll event, which may not have fired yet when an update lands right after she scrolls.
 */
function useStickyScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (height.current - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
    height.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
