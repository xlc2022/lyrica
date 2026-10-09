// One thread: header with its badges, the conversation, and the composer.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { get, post, threadPath, type Pool, type SendResponse, type ThreadSettings, type ThreadSummary } from "./api.ts";
import { useThread } from "./stream.ts";
import { Conversation } from "./Messages.tsx";
import { Composer } from "./Composer.tsx";
import { ModelBadge, SettingsDrawer } from "./Settings.tsx";
import type { ShellContext } from "./Shell.tsx";
import { ErrorText, useLoad } from "./ui.tsx";

export function Thread({ ctx, pool, threadId, threads }: { ctx: ShellContext; pool: Pool; threadId: string; threads: ThreadSummary[] }) {
  const userId = ctx.user.id;
  const base = threadPath(userId, pool, threadId);
  const summary = useLoad(() => get<ThreadSummary>(base), [base]);
  const settings = useLoad(() => get<ThreadSettings>(`${base}/settings`), [base]);
  const t = useThread(userId, pool, threadId);
  const [drawer, setDrawer] = useState(false);
  const [sendError, setSendError] = useState("");
  const { refreshThreads } = ctx;

  // A new title, or a finished turn, may change the sidebar.
  useEffect(() => { if (t.live.title) { summary.reload(); refreshThreads(); } }, [t.live.title, summary.reload, refreshThreads]);
  useEffect(() => { if (t.live.reload) refreshThreads(); }, [t.live.reload, refreshThreads]);
  // The badge follows the profile, which may change elsewhere: refresh it after each turn and on focus.
  useEffect(() => { if (t.live.reload) settings.reload(); }, [t.live.reload, settings.reload]);
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
            {settings.data && <ModelBadge base={base} settings={settings.data} onChange={settings.set} readOnly={!!settings.data.parent} />}
            {settings.data?.localOnly && pool === "general" && <span className="badge"><span className="k local">local-only</span></span>}
            {settings.data?.grants.map((g) => (
              <span key={g.path} className="badge folder" title={g.path}>{g.path} <span className="muted">{g.writable ? "rw" : "ro"}</span></span>
            ))}
            {settings.data && settings.data.target !== "sandbox" && <span className="badge folder">{settings.data.target}</span>}
          </div>
        </div>
        <button type="button" className="gear" aria-label="Thread settings" aria-expanded={drawer} aria-controls="thread-settings" onClick={() => setDrawer(!drawer)}>
          <span aria-hidden="true">⚙ <span className="long">Thread settings</span></span>
        </button>
      </header>
      {parent && (
        <p className="subnote">Subagent of <a href={`#/u/${encodeURIComponent(userId)}/t/${pool}/${encodeURIComponent(parent.id)}`}>{parent.title || "its thread"}</a></p>
      )}
      <div className="scroll" ref={scroller}>
        <ErrorText error={summary.error || t.loadError} />
        {settings.error && <ErrorText error={`This thread's settings didn't load: ${settings.error}`} />}
        <Conversation ctx={ctx} pool={pool} base={base} thread={t} />
        <ErrorText error={sendError} />
      </div>
      {!t.connected && <p className="offline" role="status">Reconnecting…</p>}
      <Composer base={base} busy={t.live.busy} onSend={send} onStop={stop} restored={restored} readOnly={!!s?.subagent} />
      {drawer && settings.data && s && (
        <SettingsDrawer
          ctx={ctx} base={base} summary={s} settings={settings.data}
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
