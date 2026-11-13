// One thread: header with its badges, the conversation, and the composer.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { del, get, patch, post, put, threadPath, u, HttpError, type MachineInfo, type Message, type Pins, type Pool, type RemovalPlan, type RoutineInfo, type RewindRequest, type RewindResponse, type SendResponse, type Subagents, type ThreadSettings, type ThreadSettingsChange, type ThreadSummary, type ThreadTombstone, type ThreadUsage, type WakeupInfo } from "./api.ts";
import { Icon } from "./icons.tsx";
import { hasConsequences, jumpTo, PinnedBadge, RemovalConfirm, useUndo, type Rewinder } from "./Rewind.tsx";
import { JUMP_EVENT, JUMP_KEY, SHOW_EVENT, SHOW_KEY, take, type JumpRequest, type ShowRequest } from "./links.ts";
import { go, href, parse } from "./route.ts";
import { ProjectWelcome, ThreadsFact, useOverview, type ProjectEnv } from "./Project.tsx";
import { useThread } from "./stream.ts";
import { type Live, tailKey } from "./live.ts";
import { Conversation, delegateTasks, MessageBox } from "./Messages.tsx";
import { SubagentsDrawer } from "./Subagents.tsx";
import { Composer } from "./Composer.tsx";
import { ContextFact, newerContext } from "./ContextMeter.tsx";
import { TokensFact } from "./Usage.tsx";
import { projectRoutines, RoutinesFact } from "./Routines.tsx";
import { ChecklistButton } from "./Checklist.tsx";
import { ChangesFact } from "./Changes.tsx";
import { ModelBadge, SettingsDrawer } from "./Settings.tsx";
import { shortModel } from "./ModelLabel.tsx";
import { Crumbs, Main, PanelButtons, usePanel, useWide, type ShellContext } from "./Shell.tsx";
import { ThreadMenu, type MenuAt } from "./ThreadMenu.tsx";
import { clock, ErrorText, InlineRename, useAction, useDismiss, useInView, useLoad, wakeTime } from "./ui.tsx";
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
  // The address can gain …/settings while the thread is already showing (Project settings' Chat settings link): the drawer opens then too.
  const opened = useRef(!!drawerAtStart);
  useEffect(() => { if (drawerAtStart && opened.current && !drawer && !dropped.current) { dropped.current = true; dropDrawer?.(); } }, [drawer, drawerAtStart, dropDrawer]);
  useEffect(() => {
    if (drawerAtStart && !opened.current) { opened.current = true; dropped.current = false; setDrawer(true); }
    if (!drawerAtStart) opened.current = false;
  }, [drawerAtStart]);
  // The subagents drawer (docs/ux.md §6): one drawer at a time, so opening it closes Settings and back.
  const [agentsOpen, setAgentsOpen] = useState(false);
  const agentsId = useId();
  const [sendError, setSendError] = useState("");
  const { refreshThreads } = ctx;
  // A project chat: its threads, reloaded when one changes state or a turn ends.
  const isProject = !!summary.data?.project;
  // Reloaded with each context reading too, which a long turn sends after every request.
  const usage = useLoad(() => get<ThreadUsage>(`${base}/usage`), [base, t.live.children, t.live.reload, t.live.context?.measuredAt]);
  const overview = useOverview(userId, pool, threadId, isProject, t.live.children + t.live.reload);
  // A project's thread (the Plan thread) suggests threads too: its card reads what the project has started from it.
  const inProject = summary.data?.child && summary.data.parent ? findThread(threads, pool, summary.data.parent) : undefined;
  const parentOverview = useOverview(userId, pool, inProject?.id ?? threadId, !!inProject?.project, t.live.reload);
  // Its subagent runs, reloaded as a run starts, works or ends; a subagent's own thread has none.
  const ticks = Object.values(t.live.subagents).reduce((a, b) => a + b, 0);
  const isSubagent = summary.data?.subagent;
  const agents = useLoad(() => isSubagent === false ? get<Subagents>(`${base}/subagents`) : Promise.resolve(undefined), [base, isSubagent, ticks, t.live.reload, t.live.items.length]);
  const agentTasks = useMemo(() => delegateTasks([
    ...t.messages.flatMap((m) => m.role === "assistant" ? m.parts : []),
    ...t.live.items.flatMap((i) => i.role === "assistant" ? i.parts : []),
  ]), [t.messages, t.live.items]);
  // A project chat's Routine fact also holds its threads' routines (docs/ux.md §6): the user's list, kept to the project's threads in this pool, after its own.
  const userRoutines = useLoad(() => (isProject ? get<RoutineInfo[]>(u(userId, "routines")) : Promise.resolve(undefined)), [userId, isProject], [overview.data, settings.data]);
  const routines = useMemo(() => projectRoutines(settings.data?.routines ?? [], isProject ? userRoutines.data : undefined, overview.data?.threads, pool, threadId),
    [settings.data, isProject, overview.data, userRoutines.data, pool, threadId]);
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
  const projectEnv: ProjectEnv | undefined = isProject && overview.data ? { overview: overview.data, lastUpdates, onChange: () => { overview.reload(); refreshThreads(); ctx.refreshNotifications(); }, toast: ctx.toast } : undefined;
  const suggestEnv: ProjectEnv | undefined = parentOverview.data ? { overview: parentOverview.data, lastUpdates, onChange: () => { parentOverview.reload(); refreshThreads(); }, toast: ctx.toast } : undefined;

  // A new title, or a finished turn, may change the sidebar.
  useEffect(() => { if (t.live.title) { summary.reload(); refreshThreads(); } }, [t.live.title, summary.reload, refreshThreads]);
  // The stream's hello (and each turn's end) reloads the summary too: a title set after the first fetch but before
  // the stream opened came as no event, as when the file viewer opens this thread beside a file just as it is named.
  useEffect(() => { if (t.live.reload) summary.reload(); }, [t.live.reload, summary.reload]);
  const { refreshNotifications } = ctx;
  useEffect(() => {
    if (t.live.reload || t.live.settings || t.live.children) { refreshThreads(); refreshNotifications(); }
  }, [t.live.reload, t.live.settings, t.live.children, refreshThreads, refreshNotifications]);
  // A finished tool call or turn may have written the thread's folder: the Files panel beside the thread reloads.
  const { noteActivity } = ctx;
  useEffect(() => { if (t.live.reload || t.live.tools) noteActivity(`${pool}/${threadId}`); }, [t.live.reload, t.live.tools, noteActivity, pool, threadId]);
  // A double-click on the title renames the thread in place (docs/ux.md §6).
  const [renaming, setRenaming] = useState(false);
  const renameTo = (name: string) => patch<ThreadSummary>(base, { title: name }).then((x) => { summary.set(x); refreshThreads(); }, (e: Error) => setSendError(e.message));
  // Project (a project chat's header) toggles the project's overview beside the chat from the split width, and opens the page below it.
  const wide = useWide();
  const here = parse(location.hash);
  const onOverview = wide && here.page === "thread" && here.panel?.page === "threads" && here.panel.pool === pool && here.panel.threadId === threadId;
  const onSettings = wide && here.page === "thread" && here.panel?.page === "project" && here.panel.pool === pool && here.panel.threadId === threadId;
  const openOverview = () => go(!wide ? { page: "threads", userId, pool, threadId } : onOverview ? { page: "thread", userId, pool, threadId } : { page: "thread", userId, pool, threadId, panel: { page: "threads", pool, threadId } });
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
  // A turn a plan's usage limit cut off: the card needs the plan and the next model, which only settings carry.
  useEffect(() => { if (t.live.wakeups?.some((w) => w.planLimit)) refreshSettings(); }, [t.live.wakeups, refreshSettings]);
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
  // Child threads it deleted leave the sidebar, and a project's Threads.
  const rewind = (n: number, req: RewindRequest) => post<RewindResponse>(`${base}/messages/${n}/rewind`, req)
    .then((r) => { if (r.threads) { refreshThreads(); if (s?.project) overview.reload(); } }, (e: Error) => setSendError(e.message));
  const rewinder: Rewinder | undefined = s && !s.subagent ? {
    settings: settings.data,
    // A turn that ended but isn't stored yet counts too: its messages aren't in t.messages, so the last turn and the
    // Undo decision would be read from the turn before it.
    busy: t.live.busy || t.live.ended > 0,
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
  const resolve = () => post<ThreadSummary>(`${base}/resolve`).then((x) => { summary.set(x); refreshThreads(); }, (e: Error) => setSendError(e.message));
  const { ref: scroller, atBottom, arrivedUp } = useStickyScroll(t.messages, t.live);
  // A reply that landed while the person was scrolled up is one they can't see: offer to take them back down to it.
  const showJump = arrivedUp && !atBottom;
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
  // The thread as listed now, not when the menu opened: a child started just before still counts in Delete….
  const menuNow = useMemo(() => menuAt && { ...menuAt, thread: listed ?? menuAt.thread }, [menuAt, listed]);
  if (!s && summary.error && gone.data) return <Tombstone userId={userId} pool={pool} data={gone.data} />;

  return (
    <Main className="main" data-drawer-open={drawer || agentsOpen}>
      <header className="head thread-head">
        <button type="button" className="menu-btn icon" aria-label="Show threads" onClick={ctx.openSide}><Icon name="menu" /></button>
        <div className="head-title">
          <Crumbs />
          <h1 onDoubleClick={s && !s.subagent && !renaming ? (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); setRenaming(true); } : undefined}>
            {renaming ? <InlineRename value={s?.title ?? ""} label="Title" onSave={renameTo} onDone={() => setRenaming(false)} /> : title}
          </h1>
          <div className="tfacts">
            <span className={`k ${pool}`}>{pool}</span>
            {settings.data && <ModelBadge base={base} settings={settings.data} onChange={settings.set} readOnly={!!s?.subagent} />}
            {pins.data && !s?.subagent && <PinnedBadge pins={pins.data} you={ctx.user.displayName} userId={ctx.user.id} pool={pool} />}
            {s && !s.subagent && !s.child && <GroupPicker ctx={ctx} base={base} summary={s} onChange={(x) => { summary.set(x); refreshThreads(); }} />}
            {context && <ContextFact context={context} footer={phone && !isProject && usageProps ? <TokensFact {...usageProps} inline /> : undefined} />}
            {!!steps?.length && <ChecklistButton steps={steps} />}
            {!phone && usageProps && <TokensFact {...usageProps} />}
            {s?.project && overview.data && <ThreadsFact userId={userId} pool={pool} threadId={threadId} overview={overview.data} footer={phone && usageProps ? <TokensFact {...usageProps} inline /> : undefined} />}
            {!!routines.length && <RoutinesFact userId={userId} threadId={threadId} routines={routines} onChange={refreshSettings} />}
            {!!settings.data?.wakeups?.length && <WakeupsFact base={base} wakeups={settings.data.wakeups} onChange={setWakeups} />}
            {settings.data?.localOnly && pool === "general" && <span className="badge"><span className="k local">local-only</span></span>}
            {settings.data?.grants.map((g) => (
              <span key={g.path} className="badge folder" title={g.path}>{g.path} <span className="muted">{g.writable ? "rw" : "ro"}</span></span>
            ))}
            {settings.data?.machines.map((m) => <span key={m} className="badge folder" title="Machine">{m}</span>)}
            {settings.data?.repositories.map((r) => <span key={`${r.account}/${r.name}`} className="badge folder" title={`Repository, through ${r.account}`}>{r.name}</span>)}
            {settings.data?.mcpServers.map((m) => <span key={`mcp:${m}`} className="badge folder" title="MCP server">{m}</span>)}
            {/* The branch and pull request badge (docs/ux.md §6): a project chat has no checkout of its own; its threads do. */}
            {s && !s.subagent && !isProject && <ChangesFact base={base} activity={ctx.activity[`${pool}/${threadId}`] ?? 0} />}
          </div>
        </div>
        {!s?.subagent && (
          <div className="head-actions">
            {/* Project opens the overview (the project's threads list) beside the chat. */}
            {s?.project && <button type="button" className="sm" aria-label="Project" aria-pressed={wide ? onOverview : undefined} onClick={openOverview}><Icon name="project" /><span className="long">Project</span></button>}
            {/* The Files panel (docs/ux.md §6): beside the conversation from the split width, the page on its own below it. */}
            <a className="sm" href={href({ page: "files", userId, pool, threadId })} aria-label="Files and images"><Icon name="panel" /><span className="long">Files</span></a>
            {/* Subagents (docs/ux.md §6): only once the thread has delegated, with how many it has; the drawer lists them all. */}
            {!!agents.data?.runs.length && (
              <button type="button" className="sm" aria-label={`Subagents ${agents.data.runs.length}`} title="Subagents" aria-expanded={agentsOpen} aria-controls={agentsId} onClick={() => { setAgentsOpen(!agentsOpen); setDrawer(false); }}>
                <Icon name="agents" /><span className="long">Subagents</span> <span className="num">{agents.data.runs.length}</span>
              </button>
            )}
            {/* A project chat's Settings is the project's page (beside the chat from the split width); its own drawer is that page's Chat settings link. */}
            {/* Not before the summary loads, so a project chat never shows the drawer's button first. */}
            {!s ? null : s.project ? (
              <a className="sm" href={href({ page: "project", userId, pool, threadId })} aria-label="Project settings" aria-current={onSettings ? "true" : undefined}><Icon name="gear" /><span className="long">Settings</span></a>
            ) : (
              <button type="button" className="sm" aria-label="Thread settings" aria-expanded={drawer} aria-controls={drawerId} onClick={() => { setDrawer(!drawer); setAgentsOpen(false); }}>
                <Icon name="gear" /><span className="long">Settings</span>
              </button>
            )}
            {/* A project's thread resolves in one press (docs/ux.md §6); the button stays, filled while resolved, and a second press reopens it. */}
            {s?.state !== undefined && (
              <button type="button" className="sm resolve-btn" aria-label="Resolve" aria-pressed={resolved} title={resolved ? "Reopen" : "Resolve"} onClick={() => void (resolved ? reopen() : resolve())}>
                <Icon name="check" /><span className="long">{resolved ? "Resolved" : "Resolve"}</span>
              </button>
            )}
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
        <PendingBar scroller={scroller} />
        <ErrorText error={summary.error || t.loadError} />
        {settings.error && <ErrorText error={`This thread's settings didn't load: ${settings.error}`} />}
        <ErrorText error={overview.error} />
        {s?.project && settings.data && t.loaded && !t.messages.length && !t.live.items.length && <ProjectWelcome userId={userId} pool={pool} project={s} settings={settings.data} onChange={() => { summary.reload(); settings.reload(); overview.reload(); refreshThreads(); }} />}
        <Conversation ctx={ctx} pool={pool} base={base} threadId={threadId} subagent={!!s?.subagent} thread={t} rewinder={rewinder} hideFrom={pending?.hide} parentTitle={s?.child ? parent?.title : undefined}
          speech={settings.data?.speech} onError={setSendError} project={projectEnv} parentProject={suggestEnv} />
        {settings.data?.planWait && settings.data.wakeups.some((w) => w.planLimit) && <PlanWaitCard wait={settings.data.planWait} userId={userId} onDone={refreshSettings} />}
        <ErrorText error={sendError} />
        {/* A reply that arrived while the person was scrolled up (docs/ux.md §6): the small button that takes them back down. */}
        {showJump && (
          <button type="button" className="jump-latest" onClick={() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }}>
            <Icon name="arrow-down" /> Jump to latest
          </button>
        )}
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
          ctx={ctx} base={base} summary={s} settings={settings.data} machines={machines.data ?? []}
          onSettings={settings.set} onSummary={(x) => { summary.set(x); refreshThreads(); }}
          onClose={() => setDrawer(false)} id={drawerId}
        />
      )}
      {agentsOpen && s && !s.subagent && (
        <SubagentsDrawer id={agentsId} userId={userId} pool={pool} data={agents.data} error={agents.error} tasks={agentTasks} onClose={() => setAgentsOpen(false)} />
      )}
      {(drawer || agentsOpen) && <div className="scrim drawer-scrim" aria-hidden="true" onClick={() => { setDrawer(false); setAgentsOpen(false); }} />}
      {menuNow && (
        <ThreadMenu at={menuNow} userId={userId} groups={ctx.groups} onGroups={ctx.refreshGroups} onToast={ctx.toast}
          onChange={() => { summary.reload(); refreshThreads(); }} onClose={closeMenu}
          onGone={panel?.close ?? (() => go({ page: "home", userId }))} />
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
  useInView(anchor, open);
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
  useInView(anchor, open);
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
function PendingBar({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const [kind, setKind] = useState("");
  const latest = () => [...scroller.current?.querySelectorAll<HTMLElement>("[data-pending]") ?? []].at(-1);
  // Follows the cards themselves, so a card that goes away (answered, folded, Cancel) takes the bar with it.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let card: HTMLElement | undefined, seen: IntersectionObserver | undefined;
    const watch = () => {
      const next = latest();
      if (next === card) return;
      seen?.disconnect();
      card = next;
      if (!card) { seen = undefined; setKind(""); return; }
      const watched = card;
      seen = new IntersectionObserver(([e]) => setKind(e!.isIntersecting ? "" : watched.dataset.pending ?? ""), { root });
      seen.observe(watched);
    };
    watch();
    const changes = new MutationObserver(watch);
    changes.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-pending"] });
    return () => { changes.disconnect(); seen?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!kind) return null;
  return (
    <button type="button" className="pending-bar" onClick={() => latest()?.scrollIntoView({ block: "center", behavior: "smooth" })}>
      {kind} waiting for your answer
    </button>
  );
}

/**
 * Opens the conversation at its latest message and keeps it there while anything grows, unless she has scrolled up.
 * Whether she follows the bottom is decided only by her scrolling (`stuck`), never re-measured when the content or the
 * box changes size: a header that grows while the messages load, or a picture that loads after them, would otherwise
 * read as her having scrolled up, and leave a thread opened at its top. A ResizeObserver on the box and on each of its
 * children brings the bottom back into view whenever either changes size while she follows it, except right after she
 * presses a control in the conversation: scrolled up, what she opened stays where she opened it; at the bottom, the view
 * follows what it opened down, but never so far that the control leaves the top.
 * Reports whether new tail content arrived while she was scrolled up, for the jump-to-latest control:
 * only a tail that grew counts, so opening older history above her isn't an arrival.
 */
/** How long after she presses a control in the conversation its place holds while what it opened lays out. */
const PRESS_HOLD_MS = 1000;

function useStickyScroll(messages: Message[], live: Live) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const tail = useRef<string>("∅");
  const [atBottom, setAtBottom] = useState(true);
  const [arrivedUp, setArrivedUp] = useState(false);
  const observer = useRef<ResizeObserver>(undefined);
  const unhold = useRef<number>(undefined);
  // Where the box was last scrolled to, by this hook or by a scroll event: a scroll up since, whose event hasn't fired
  // yet when an update lands right after it, still counts as leaving the bottom.
  const lastTop = useRef(0);
  // A control she just pressed inside the conversation (a marker, a run, Show more): what it opens grows under it, and
  // following the bottom without limit could pull it up out of view. For a moment after the press, sizes change around
  // it instead (or, pressed at the bottom, the view follows only as far as keeps it in view), and whether she still
  // follows the bottom is measured afresh.
  const pressed = useRef<{ el: Element; top: number; at: number; bottom: boolean }>(undefined);
  // The hold is this hook's alone: the browser's own scroll anchoring would move the view first, and its scroll event
  // would end the hold and read her as scrolled up (#986). Anchoring stays on otherwise, for growth above her.
  const release = (el: HTMLDivElement) => { pressed.current = undefined; el.style.overflowAnchor = ""; };
  const follow = (el: HTMLDivElement) => {
    const p = pressed.current;
    if (p && p.el.isConnected && performance.now() - p.at < PRESS_HOLD_MS) {
      // Only a real move: setting scrollTop at all would stop a smooth scroll on its way.
      const moved = p.el.getBoundingClientRect().top - p.top;
      if (p.bottom) {
        // Pressed while following the bottom: what it opened is followed down too, as far as keeps the control itself
        // in view at the top (#986).
        const room = p.el.getBoundingClientRect().top - el.getBoundingClientRect().top;
        const to = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + Math.max(0, room));
        if (Math.abs(to - el.scrollTop) >= 1) el.scrollTop = to;
      } else if (Math.abs(moved) >= 1) el.scrollTop += moved;
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    } else {
      if (p) release(el);
      if (stuck.current && el.scrollTop < lastTop.current - 1 && el.scrollHeight - el.scrollTop - el.clientHeight >= 80) stuck.current = false;
      if (stuck.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 1) el.scrollTop = el.scrollHeight;
    }
    lastTop.current = el.scrollTop;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = tailKey(messages, live);
    const grew = now !== tail.current;
    tail.current = now;
    follow(el);
    // Content that grew at the tail while the person was scrolled up is one they can't see yet; being at the bottom ends the offer.
    if (stuck.current) setArrivedUp(false);
    else if (grew) setArrivedUp(true);
    setAtBottom(stuck.current);
    // Children come and go with each render: watch the ones there now.
    const ro = observer.current;
    if (ro) for (const c of el.children) ro.observe(c, { box: "border-box" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, live]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only scrolling changes whether she follows the bottom: hers, Jump to latest, a jump to a message, or the browser
    // clamping it when the content shrinks.
    const on = () => {
      // Her own scrolling ends the hold on a control she pressed.
      if (pressed.current && Math.abs(el.scrollTop - lastTop.current) > 1) release(el);
      const at = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stuck.current = at;
      lastTop.current = el.scrollTop;
      setAtBottom(at);
      if (at) setArrivedUp(false);
    };
    // Jump to latest, Show earlier messages and the waiting card's bar move the view themselves. A click covers a key press on a button too; it is caught on the way down, before the control's own handler opens anything.
    const press = (e: MouseEvent) => {
      const c = (e.target as Element | null)?.closest("button, a, summary, [role='button']");
      if (!c || !el.contains(c) || c.matches(".jump-latest, .older, .pending-bar")) return;
      pressed.current = { el: c, top: c.getBoundingClientRect().top, at: performance.now(), bottom: stuck.current };
      // Where she had scrolled to before pressing, whose event may land after the press, isn't a scroll that ends the hold.
      lastTop.current = el.scrollTop;
      el.style.overflowAnchor = "none";
      // Nothing may resize after the press to end the hold: let anchoring back once it is over.
      window.clearTimeout(unhold.current);
      unhold.current = window.setTimeout(() => { if (pressed.current && performance.now() - pressed.current.at >= PRESS_HOLD_MS) release(el); }, PRESS_HOLD_MS + 50);
    };
    const ro = new ResizeObserver(() => { follow(el); setAtBottom(stuck.current); });
    ro.observe(el);
    for (const c of el.children) ro.observe(c, { box: "border-box" });
    observer.current = ro;
    el.addEventListener("scroll", on, { passive: true });
    el.addEventListener("click", press, true);
    return () => { el.removeEventListener("scroll", on); el.removeEventListener("click", press, true); ro.disconnect(); observer.current = undefined; window.clearTimeout(unhold.current); };
  }, []);
  return { ref, atBottom, arrivedUp };
}

/**
 * A turn waits for its plan's usage limit to reset (docs/ux.md §6): when it carries on, and a button to
 * fall back to the next model in the list until then, for every thread and job waiting on the plan.
 */
function PlanWaitCard({ wait, userId, onDone }: { wait: NonNullable<ThreadSettings["planWait"]>; userId: string; onDone: () => void }) {
  const [run, busy, error] = useAction();
  return (
    <div className="card plan-wait" role="status">
      <p>{wait.name} reached its plan's usage limit. This thread carries on when it resets at <span className="num">{clock(wait.until)}</span>.</p>
      {wait.next && <button type="button" className="sm" disabled={busy} title={wait.claudeCode ? `Every thread waiting on ${wait.name} hands its job to ${wait.next} until it resets.` : `Every thread and sleep waiting on ${wait.name} uses ${wait.next} until it resets.`}
        onClick={() => void run(async () => { await post(`${u(userId, "endpoints")}/${encodeURIComponent(wait.endpointId)}/fall-back`, {}); onDone(); })}>Use {shortModel(wait.next)} until then</button>}
      <ErrorText error={error} />
    </div>
  );
}
