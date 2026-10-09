// The signed-in layout: sidebar, and the page the route points at.
import { useCallback, useEffect, useRef, useState } from "react";
import { get, patch, post, u, type DisplayChange, type Me, type Pool, type ThreadSummary, type UserCard } from "./api.ts";
import { href, go, type Route } from "./route.ts";
import { Thread } from "./Thread.tsx";
import { Memory } from "./Memory.tsx";
import { Panel } from "./Panel.tsx";
import { ErrorText, shortTime, useAction, useDismiss, useLoad } from "./ui.tsx";

export interface ShellContext {
  user: UserCard;
  me: Me;
  setMe: (me: Me) => void;
  /** Reload the thread list (after a change, or a turn that may have set a title). */
  refreshThreads: () => void;
  openSide: () => void;
}

export function Shell({ user, users, route, onAuthChange }: { user: UserCard; users: UserCard[]; route: Route; onAuthChange: () => void }) {
  const me = useLoad(() => get<Me>(u(user.id, "me")), [user.id]);
  const threads = useLoad(() => get<ThreadSummary[]>(u(user.id, "threads")), [user.id]);
  const [sideOpen, setSideOpen] = useState(false);

  // Close the sidebar overlay whenever the page changes.
  useEffect(() => setSideOpen(false), [route]);
  // Refresh the list now and then, so other threads' titles and activity show.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && threads.reload(), 30_000);
    addEventListener("focus", threads.reload);
    return () => { clearInterval(t); removeEventListener("focus", threads.reload); };
  }, [threads.reload]);
  useLook(me.data);

  if (!me.data) return <div className="loading">{me.error ? <ErrorText error={me.error} /> : "Loading…"}</div>;
  const ctx: ShellContext = { user: me.data.user, me: me.data, setMe: me.set, refreshThreads: threads.reload, openSide: () => setSideOpen(true) };

  return (
    <div className="app" data-side-open={sideOpen}>
      <Sidebar ctx={ctx} users={users} route={route} threads={threads.data ?? []} error={threads.error} onAuthChange={onAuthChange} />
      <div className="scrim" aria-hidden="true" onClick={() => setSideOpen(false)} />
      {route.page === "thread" ? (
        <Thread key={`${route.pool}/${route.threadId}`} ctx={ctx} pool={route.pool} threadId={route.threadId} threads={threads.data ?? []} />
      ) : route.page === "memory" ? (
        <Memory ctx={ctx} pool={route.pool} id={route.id} />
      ) : route.page === "panel" ? (
        <Panel ctx={ctx} />
      ) : (
        <Welcome ctx={ctx} />
      )}
    </div>
  );
}

/** Theme and the persona's accent and monogram. */
function useLook(me?: Me) {
  const theme = me?.display.theme;
  const accent = me?.user.accent;
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === "device") delete root.dataset.theme;
    else root.dataset.theme = theme;
    if (accent) root.style.setProperty("--persona", accent);
    else root.style.removeProperty("--persona");
  }, [theme, accent]);
}

export const monogram = (user: UserCard) => user.monogram || user.displayName.slice(0, 2);

function Sidebar({ ctx, users, route, threads, error, onAuthChange }: {
  ctx: ShellContext; users: UserCard[]; route: Route; threads: ThreadSummary[]; error: string; onAuthChange: () => void;
}) {
  const { user, me } = ctx;
  const [run, , actionError] = useAction();
  const setDisplay = (change: DisplayChange) => run(async () => {
    ctx.setMe(await patch<Me>(u(user.id, "me", "display"), change));
    ctx.refreshThreads();
  });
  const create = (pool: Pool) => run(async () => {
    const t = await post<ThreadSummary>(u(user.id, "threads"), { pool });
    ctx.refreshThreads();
    go({ page: "thread", userId: user.id, pool, threadId: t.id });
  });
  const current = route.page === "thread" ? `${route.pool}/${route.threadId}` : "";

  return (
    <aside className="side" aria-label="Threads">
      <div className="brand">Lyrica</div>
      <PersonaMenu ctx={ctx} users={users} onAuthChange={onAuthChange} />
      <fieldset className="filters">
        <legend className="sr-only">Show</legend>
        <label><input type="checkbox" checked={me.display.showGeneral} onChange={(e) => setDisplay({ showGeneral: e.target.checked })} /> Show general</label>
        <label><input type="checkbox" checked={me.display.showPrivate} onChange={(e) => setDisplay({ showPrivate: e.target.checked })} /> Show private</label>
        <label><input type="checkbox" checked={me.display.showHidden} onChange={(e) => setDisplay({ showHidden: e.target.checked })} /> Show hidden threads</label>
      </fieldset>
      <NewThread onCreate={create} />
      <ErrorText error={actionError || error} />
      <ul className="threads">
        {threads.map((t) => <ThreadRow key={`${t.pool}/${t.id}`} t={t} userId={user.id} current={current} />)}
        {!threads.length && !error && <li className="muted empty">No threads yet.</li>}
      </ul>
      <nav className="side-foot">
        <a href={href({ page: "memory", userId: user.id })} aria-current={route.page === "memory" ? "page" : undefined}>Memory</a>
        <a href={href({ page: "panel", userId: user.id })} aria-current={route.page === "panel" ? "page" : undefined}>Control panel</a>
      </nav>
    </aside>
  );
}

function NewThread({ onCreate }: { onCreate: (pool: Pool) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="primary new" aria-expanded="false" onClick={() => setOpen(true)}>New thread</button>;
  return (
    <div className="new-choice" role="group" aria-label="New thread in">
      <button type="button" className="primary" autoFocus onClick={() => { setOpen(false); onCreate("general"); }}>General</button>
      <button type="button" className="private" onClick={() => { setOpen(false); onCreate("private"); }}>Private</button>
      <button type="button" className="quiet" aria-label="Cancel" onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

function ThreadRow({ t, userId, current }: { t: ThreadSummary; userId: string; current: string }) {
  const key = `${t.pool}/${t.id}`;
  const [open, setOpen] = useState(() => t.children.some((c) => `${c.pool}/${c.id}` === current));
  return (
    <li>
      <div className="row">
        {t.children.length > 0
          ? <button type="button" className="chev" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} subagents`} onClick={() => setOpen(!open)}>›</button>
          : <span className="chev" />}
        <ThreadLink t={t} userId={userId} on={current === key} />
      </div>
      {open && (
        <ul className="children">
          {t.children.map((c) => <li key={c.id}><ThreadLink t={c} userId={userId} on={current === `${c.pool}/${c.id}`} /></li>)}
        </ul>
      )}
    </li>
  );
}

function ThreadLink({ t, userId, on }: { t: ThreadSummary; userId: string; on: boolean }) {
  const when = (t as ThreadSummary & { updatedAt?: string }).updatedAt ?? t.createdAt;
  return (
    <a className="thread" href={href({ page: "thread", userId, pool: t.pool, threadId: t.id })} aria-current={on ? "page" : undefined}>
      <span className="pool-dot" data-pool={t.pool} title={t.pool} />
      <span className="title">{t.title || "New thread"}</span>
      <span className="when">
        {t.busy && <span className="busy" title="Working" />}
        {t.hidden && <span className="flag">hidden</span>}
        {shortTime(when)}
      </span>
      <span className="sr-only">{t.pool} thread</span>
    </a>
  );
}

function PersonaMenu({ ctx, users, onAuthChange }: { ctx: ShellContext; users: UserCard[]; onAuthChange: () => void }) {
  const { user } = ctx;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  useEffect(() => { addEventListener("hashchange", close); return () => removeEventListener("hashchange", close); }, [close]);
  const [run, , error] = useAction();
  const leave = (path: string, body: unknown) => run(async () => {
    await post(path, body);
    setOpen(false);
    go({ page: "home" });
    onAuthChange();
  });
  return (
    <div className="persona-menu" ref={ref}>
      <button type="button" className="persona" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{monogram(user)}</span>
        <span><b>{user.displayName}</b><small>Switch persona</small></span>
        <span className="caret-down" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu">
          {users.filter((x) => x.id !== user.id).map((x) => (
            <a key={x.id} href={href({ page: "home", userId: x.id })} onClick={() => setOpen(false)}>
              <span className="avatar small" style={x.accent ? { background: x.accent } : undefined} aria-hidden="true">{monogram(x)}</span>{x.displayName}
            </a>
          ))}
          <a href="#/login" onClick={() => setOpen(false)}>Add a persona…</a>
          <button type="button" onClick={() => leave("/api/logout", { userId: user.id })}>Log out {user.displayName}</button>
          <button type="button" onClick={() => leave(u(user.id, "lock"), {})}>Lock {user.displayName}</button>
          <ErrorText error={error} />
        </div>
      )}
    </div>
  );
}

function Welcome({ ctx }: { ctx: ShellContext }) {
  return (
    <main className="main">
      <header className="head">
        <button type="button" className="menu-btn" aria-label="Show threads" onClick={ctx.openSide}>☰</button>
        <div className="head-title"><h1>Lyrica</h1></div>
      </header>
      <div className="welcome">
        <p>Hello, {ctx.user.displayName}. Pick a thread, or start a new one.</p>
      </div>
    </main>
  );
}
