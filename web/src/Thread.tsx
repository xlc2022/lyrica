// One thread: header with its badges, the conversation, and the composer.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { del, get, post, put, threadPath, type Pins, type Pool, type RemovalPlan, type RewindRequest, type SendResponse, type ThreadSettings, type ThreadSummary } from "./api.ts";
import { hasConsequences, PinnedBadge, RemovalConfirm, useUndo, type Rewinder } from "./Rewind.tsx";
import { go } from "./route.ts";
import { useThread } from "./stream.ts";
import { Conversation, MessageBox } from "./Messages.tsx";
import { Composer } from "./Composer.tsx";
import { ModelBadge, SettingsDrawer } from "./Settings.tsx";
import type { ShellContext } from "./Shell.tsx";
import { ErrorText, useLoad } from "./ui.tsx";

export function Thread({ ctx, pool, threadId, threads }: { ctx: ShellContext; pool: Pool; threadId: string; threads: ThreadSummary[] }) {
  const userId = ctx.user.id;
  const base = threadPath(userId, pool, threadId);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  const settings = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  const pins = useLoad(() => get<Pins>(`${base}/pins`), [base]);
  const t = useThread(userId, pool, threadId);
  const [drawer, setDrawer] = useState(false);
  const [sendError, setSendError] = useState("");
  const { refreshThreads } = ctx;

  // A new title, or a finished turn, may change the sidebar.
  useEffect(() => { if (t.live.title) { summary.reload(); refreshThreads(); } }, [t.live.title, summary.reload, refreshThreads]);
  useEffect(() => { if (t.live.reload) refreshThreads(); }, [t.live.reload, refreshThreads]);
  // A child thread's update changes its badge in the sidebar.
  const updates = t.live.items.filter((x) => x.role === "notice").length;
  useEffect(() => { if (updates) refreshThreads(); }, [updates, refreshThreads]);
  // The badge follows the profile, which may change elsewhere: refresh it after each turn and on focus.
  useEffect(() => { if (t.live.reload) settings.reload(); }, [t.live.reload, settings.reload]);
  // A rewind may take pinned messages with it.
  useEffect(() => { if (t.live.reload) pins.reload(); }, [t.live.reload, pins.reload]);
  useEffect(() => {
    addEventListener("focus", settings.reload);
    return () => removeEventListener("focus", settings.reload);
  }, [settings.reload]);

  const send = useCallback(async (text: string) => {
    setSendError("");
    try {
      const r = await post<SendResponse>(`${base}/messages`, { text });
      if (!r.queued) t.dispatch({ type: "sent", text });
      return true;
    } catch (e) {
      setSendError((e as Error).message);
      return false;
    }
  }, [base, t.dispatch]);
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
  const title = t.live.title || s?.title || "New thread";
  const scroller = useStickyScroll([t.messages, t.live]);

  return (
    <main className="main" data-drawer-open={drawer}>
      <header className="head">
        <button type="button" className="menu-btn" aria-label="Show threads" onClick={ctx.openSide}>☰</button>
        <div className="head-title">
          <h1>{title}</h1>
          <div className="badges">
            <span className="badge" data-kind={pool === "private" ? "private" : "general"}><span className="k">{pool}</span></span>
            {settings.data && <ModelBadge base={base} settings={settings.data} onChange={settings.set} readOnly={!!s?.subagent} />}
            {pins.data && !s?.subagent && <PinnedBadge pins={pins.data} you={ctx.user.displayName} />}
            {settings.data?.localOnly && pool === "general" && <span className="badge"><span className="k local">local-only</span></span>}
            {settings.data?.grants.map((g) => (
              <span key={g.path} className="badge folder" title={g.path}>{g.path} <span className="muted">{g.writable ? "rw" : "ro"}</span></span>
            ))}
            {settings.data && settings.data.target !== "sandbox" && <span className="badge folder">{settings.data.target}</span>}
          </div>
        </div>
        {!s?.subagent && (
          <button type="button" className="gear" aria-label="Thread settings" aria-expanded={drawer} aria-controls="thread-settings" onClick={() => setDrawer(!drawer)}>
            <span aria-hidden="true">⚙ <span className="long">Thread settings</span></span>
          </button>
        )}
      </header>
      {parent && (
        <p className="subnote">{s?.subagent ? "Subagent of" : s?.child ? "Child thread of" : "Branched from"} <a href={`#/u/${encodeURIComponent(userId)}/t/${pool}/${encodeURIComponent(parent.id)}`}>{parent.title || "the parent thread"}</a></p>
      )}
      <div className="scroll" ref={scroller}>
        <ErrorText error={summary.error || t.loadError} />
        {settings.error && <ErrorText error={`This thread's settings didn't load: ${settings.error}`} />}
        <Conversation ctx={ctx} pool={pool} base={base} threadId={threadId} subagent={!!s?.subagent} thread={t} rewinder={rewinder} hideFrom={pending?.hide} parentTitle={s?.child ? parent?.title : undefined} />
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
      {/* A subagent's thread is its transcript and a message box, as in its delegate card. */}
      {s?.subagent
        ? <div className="composer sub-composer"><MessageBox thread={{ pool, id: threadId }} env={{ userId }} onSent={() => t.dispatch({ type: "refresh" })} /></div>
        : <Composer base={base} busy={t.live.busy} onSend={send} onStop={stop} restored={restored} />}
      {drawer && settings.data && s && !s.subagent && (
        <SettingsDrawer
          ctx={ctx} base={base} summary={s} settings={settings.data} children={findThread(threads, pool, threadId)?.children.length ?? 0}
          onSettings={settings.set} onSummary={(x) => { summary.set(x); refreshThreads(); }}
          onClose={() => setDrawer(false)}
        />
      )}
      {drawer && <div className="scrim drawer-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />}
    </main>
  );
}

function findThread(list: ThreadSummary[], pool: Pool, id: string): ThreadSummary | undefined {
  for (const t of list) {
    if (t.pool === pool && t.id === id) return t;
    const c = findThread(t.children, pool, id);
    if (c) return c;
  }
  return undefined;
}

/** Keeps the conversation scrolled to the bottom while new text arrives, unless she has scrolled up. */
function useStickyScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => { stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
