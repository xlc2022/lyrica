// The signed-in layout: the sidebar, and the page the route points at.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { get, patch, post, u, type Display, type DisplayChange, type LogoutResponse, type Me, type Pool, type State, type ThreadGroup, type ThreadSort, type ThreadSummary, type UserCard } from "./api.ts";
import { href, go, panelRoute, parse, type Panel, type Route } from "./route.ts";
import { Icon } from "./icons.tsx";
import { Thread, findThread } from "./Thread.tsx";
import { Memory } from "./Memory.tsx";
import { AdminPage, SettingsPage } from "./Panel.tsx";
import { FilesPage } from "./Files.tsx";
import { NotificationsCard, useWaiting } from "./Notifications.tsx";
import { ThreadMenu, useThreadMenu } from "./ThreadMenu.tsx";
import { ProjectPage, stateWord } from "./Project.tsx";
import { ErrorText, hidden, menuArrows, shortTime, useAction, useDismiss, useLoad, useNow } from "./ui.tsx";

export interface ShellContext {
  user: UserCard;
  me: Me;
  setMe: (me: Me) => void;
  /** lyricad's version and build, for the header. */
  build: Pick<State, "version" | "build">;
  /** Reload the thread list (after a change, or a turn that may have set a title). */
  refreshThreads: () => void;
  /** The user's own groups of threads, and a reload after one is made or renamed. */
  groups: ThreadGroup[];
  refreshGroups: () => void;
  /** How many decisions wait in Notifications (the sidebar's count), and a reload after one is acted on. */
  waiting: number;
  refreshNotifications: () => void;
  openSide: () => void;
}

export function Shell({ user, users, route, build, onAuthChange }: {
  user: UserCard; users: UserCard[]; route: Route; build: Pick<State, "version" | "build">;
  /** After logout or Lock, with a line to show, if any. */
  onAuthChange: (notice?: string) => void;
}) {
  const me = useLoad(() => get<Me>(u(user.id, "me")), [user.id]);
  const threads = useLoad(() => get<ThreadSummary[]>(u(user.id, "threads")), [user.id]);
  const groups = useLoad(() => get<ThreadGroup[]>(u(user.id, "thread-groups")), [user.id]);
  const [sideOpen, setSideOpen] = useState(false);
  const wide = useWide();
  // Below the split width the panel's address is the page itself (docs/ux.md §6).
  const shown: Route = route.page === "thread" && route.panel && !wide ? panelRoute(route.userId, route.panel) : route;
  const trail = usePanelTrail(route);

  // Close the sidebar overlay whenever the page changes.
  useEffect(() => setSideOpen(false), [route]);
  const notes = useWaiting(user.id);
  // Refresh the list and the count now and then, so other threads' titles and activity show, and what waits.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") { threads.reload(); notes.reload(); } };
    const t = setInterval(tick, 30_000);
    addEventListener("focus", tick);
    return () => { clearInterval(t); removeEventListener("focus", tick); };
  }, [threads.reload, notes.reload]);
  useLook(me.data);

  if (!me.data) return <div className="loading">{me.error ? <ErrorText error={me.error} /> : "Loading…"}</div>;
  const ctx: ShellContext = {
    user: me.data.user, me: me.data, setMe: me.set, build, refreshThreads: threads.reload,
    groups: groups.data ?? [], refreshGroups: groups.reload, waiting: notes.waiting, refreshNotifications: notes.reload, openSide: () => setSideOpen(true),
  };

  const panel = wide && route.page === "thread" ? route.panel : undefined;
  const page = (r: Route, dropDrawer?: () => void) =>
    r.page === "thread" && hidden(me.data!.display, r.pool) ? (
      <HiddenPool ctx={ctx} pool={r.pool} />
    ) : r.page === "thread" ? (
      <Thread key={`${r.pool}/${r.threadId}`} ctx={ctx} pool={r.pool} threadId={r.threadId} threads={threads.data ?? []} drawerAtStart={r.drawer} dropDrawer={dropDrawer} />
    ) : r.page === "files" && hidden(me.data!.display, r.pool) ? (
      <HiddenPool ctx={ctx} pool={r.pool} />
    ) : r.page === "files" ? (
      <FilesPage key={`${r.pool}/${r.threadId}`} ctx={ctx} pool={r.pool} threadId={r.threadId} threads={threads.data ?? []} path={r.path} />
    ) : r.page === "project" && hidden(me.data!.display, r.pool) ? (
      <HiddenPool ctx={ctx} pool={r.pool} />
    ) : r.page === "project" ? (
      <ProjectPage key={`${r.pool}/${r.threadId}`} ctx={ctx} pool={r.pool} threadId={r.threadId} section={r.section} />
    ) : r.page === "memory" ? (
      <Memory ctx={ctx} pool={r.pool} id={r.id} />
    ) : r.page === "settings" ? (
      <SettingsPage ctx={ctx} section={r.section} />
    ) : r.page === "admin" ? (
      <AdminPage ctx={ctx} section={r.section} />
    ) : (
      <Welcome ctx={ctx} />
    );

  return (
    <div className="app" data-side-open={sideOpen} data-panel={!!panel || undefined} onClick={wide && route.page === "thread" ? (e) => openInPanel(e, route, trail) : undefined}>
      <Sidebar ctx={ctx} users={users} route={shown} threads={threads.data ?? []} error={threads.error} onAuthChange={onAuthChange} onClose={() => setSideOpen(false)} />
      <div className="scrim" aria-hidden="true" onClick={() => setSideOpen(false)} />
      {page(shown, () => dropDrawer(shown === route ? "page" : "panel"))}
      {panel && route.page === "thread" && (
        <PanelColumn route={route} panel={panel} trail={trail} threads={threads.data ?? []}>
          {page(panelRoute(route.userId, panel), () => dropDrawer("panel"))}
        </PanelColumn>
      )}
    </div>
  );
}

/** Takes `/settings` off the address of the thread shown on its own or in the panel, once its drawer closes (no navigation). */
function dropDrawer(which: "page" | "panel") {
  const r = parse(location.hash);
  if (r.page !== "thread") return;
  const next: Route = which === "page" ? { ...r, drawer: undefined } : r.panel?.page === "thread" ? { ...r, panel: { ...r.panel, drawer: undefined } } : r;
  if (href(next) !== href(r)) history.replaceState(null, "", href(next));
}

/* ---- The right panel (docs/ux.md §6): what is looked at without leaving a conversation. ---- */

/** The split view starts at this width; below it the panel's address is the page. */
const SPLIT_WIDTH = 1180;
const PANEL_MIN = 360, PANEL_MAX = 520, PANEL_DEFAULT = 420;
const PANEL_WIDTH_KEY = "lyrica.panel-width";

function useWide(): boolean {
  const q = `(min-width: ${SPLIT_WIDTH}px)`;
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return wide;
}

/** The pages opened in the panel in turn, for its breadcrumb: the current one last. */
interface Trail { crumbs: Panel[]; set: (crumbs: Panel[]) => void }

function usePanelTrail(route: Route): Trail {
  const ref = useRef<Panel[]>([]);
  const cur = route.page === "thread" ? route.panel : undefined;
  const last = ref.current.at(-1);
  // A panel reached any other way than a link inside it starts a new trail.
  if (!cur) ref.current = [];
  else if (!last || href(panelRoute("", last)) !== href(panelRoute("", cur))) ref.current = [cur];
  return { crumbs: ref.current, set: (c) => { ref.current = c; } };
}

/**
 * Links in a conversation to a thread or a project's settings open in the panel, and links inside the
 * panel replace what it shows; the sidebar's rows navigate. A link to the conversation's own thread
 * closes the panel (its Thread settings link opens the drawer).
 */
function openInPanel(e: React.MouseEvent, route: Route & { page: "thread" }, trail: Trail) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest("a[href^='#/u/']");
  if (!a || a.closest(".side, .panel-actions")) return;
  const to = parse(a.getAttribute("href")!);
  if (to.page !== "thread" && to.page !== "project" && to.page !== "files") return;
  if (to.userId !== route.userId) return;
  e.preventDefault();
  if (to.page === "thread" && to.pool === route.pool && to.threadId === route.threadId) {
    go({ page: "thread", userId: route.userId, pool: route.pool, threadId: route.threadId, ...(to.drawer ? { drawer: true } : {}) });
    return;
  }
  const panel: Panel = to.page === "thread"
    ? { page: "thread", pool: to.pool, threadId: to.threadId, ...(to.drawer ? { drawer: true as const } : {}) }
    : to.page === "files" ? { page: "files", pool: to.pool, threadId: to.threadId, ...(to.path ? { path: to.path } : {}) }
    : { page: "project", pool: to.pool, threadId: to.threadId, ...(to.section ? { section: to.section } : {}) };
  // The Files button toggles its panel; a file's link shows that file in it.
  if (panel.page === "files" && !panel.path && route.panel?.page === "files" && route.panel.threadId === panel.threadId) { go({ ...route, drawer: undefined, panel: undefined }); return; }
  // A breadcrumb goes back to that page; a link in the panel goes one deeper; one in the conversation starts afresh.
  const crumb = (a as HTMLElement).dataset.crumb;
  trail.set(crumb !== undefined ? trail.crumbs.slice(0, Number(crumb) + 1) : a.closest(".panel") ? [...trail.crumbs, panel] : [panel]);
  go({ ...route, drawer: undefined, panel });
}

interface PanelContext {
  /** The pages opened in turn; the current one last. */
  crumbs: { label: string; href: string }[];
  /** The panel's page on its own. */
  expand: string;
  close: () => void;
}
const PanelCtx = createContext<PanelContext | undefined>(undefined);
/** The panel's breadcrumb and buttons, when inside it. */
export const usePanel = () => useContext(PanelCtx);

/** The page's root: `main` on its own, a plain block inside the panel (one main per document). */
export function Main(props: React.HTMLAttributes<HTMLElement>) {
  return usePanel() ? <div {...props} /> : <main {...props} />;
}

function PanelColumn({ route, panel, trail, threads, children }: { route: Route & { page: "thread" }; panel: Panel; trail: Trail; threads: ThreadSummary[]; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // The width kept per browser; where storage is off, the panel starts at the default each time.
  const [width, setWidth] = useState(() => { try { const n = Number(localStorage.getItem(PANEL_WIDTH_KEY)); return n >= PANEL_MIN && n <= PANEL_MAX ? n : PANEL_DEFAULT; } catch { return PANEL_DEFAULT; } });
  const resize = (w: number) => { const x = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w))); setWidth(x); try { localStorage.setItem(PANEL_WIDTH_KEY, String(x)); } catch { /* kept for this visit only */ } };
  const close = useCallback(() => go({ ...route, drawer: undefined, panel: undefined }), [route]);
  const label = (p: Panel) => p.page === "project" ? "Project settings" : p.page === "files" ? "Files" : findThread(threads, p.pool, p.threadId)?.title || "New thread";
  const crumbs = trail.crumbs.map((p) => ({ label: label(p), href: href(panelRoute(route.userId, p)) }));
  const ctx: PanelContext = { crumbs, expand: href(panelRoute(route.userId, panel)), close };
  const current = href(panelRoute("", panel));
  // Focus lands on the page's heading each time the panel shows something else.
  useEffect(() => { const h = ref.current?.querySelector("h1"); if (h) { h.tabIndex = -1; h.focus(); } }, [current]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if ((e.target as Element).closest("dialog, [role='menu'], .drawer, .picker, [aria-expanded='true']")) return;
    close();
  };
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const startX = e.clientX, startW = width;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => resize(startW + (startX - ev.clientX));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const keys = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === "ArrowLeft") { resize(width + step); e.preventDefault(); }
    else if (e.key === "ArrowRight") { resize(width - step); e.preventDefault(); }
    else if (e.key === "Home") { resize(PANEL_MAX); e.preventDefault(); }
    else if (e.key === "End") { resize(PANEL_MIN); e.preventDefault(); }
  };
  return (
    <aside ref={ref} className="panel" role="complementary" aria-label={crumbs.map((c) => c.label).join(" › ")} style={{ "--panel-w": `${width}px` } as React.CSSProperties} onKeyDown={onKeyDown}>
      <div className="divider" role="separator" aria-orientation="vertical" aria-label="Panel width" aria-valuemin={PANEL_MIN} aria-valuemax={PANEL_MAX} aria-valuenow={width} tabIndex={0} onPointerDown={drag} onKeyDown={keys} />
      <PanelCtx.Provider value={ctx}>{children}</PanelCtx.Provider>
    </aside>
  );
}

/** The pages before this one in the panel, above its title; nothing on a page on its own. */
export function Crumbs() {
  const p = usePanel();
  if (!p || p.crumbs.length < 2) return null;
  return (
    <nav className="crumbs" aria-label="Opened from">
      {p.crumbs.slice(0, -1).map((c, i) => <a key={i} href={c.href} data-crumb={i}>{c.label}</a>)}
    </nav>
  );
}

/** Open as a page and Close panel, at the end of the panel's header. */
export function PanelButtons() {
  const p = usePanel();
  if (!p) return null;
  return (
    <div className="head-actions panel-actions">
      <a className="icon sm" href={p.expand} aria-label="Open as a page" title="Open as a page"><Icon name="expand" /></a>
      <button type="button" className="icon sm" aria-label="Close panel" title="Close panel" onClick={p.close}><Icon name="close" /></button>
    </div>
  );
}

/** Theme and the user's accent and monogram. */
function useLook(me?: Me) {
  const theme = me?.display.theme;
  const accent = me?.user.accent;
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === "device") delete root.dataset.theme;
    else root.dataset.theme = theme;
    if (accent) root.style.setProperty("--user-accent", accent);
    else root.style.removeProperty("--user-accent");
  }, [theme, accent]);
}

/** The page header: the menu button on a phone, a title, and a line of facts beneath it. */
export function PageHead({ ctx, title, facts, children }: { ctx: ShellContext; title: React.ReactNode; facts?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="head">
      <button type="button" className="menu-btn icon" aria-label="Show threads" onClick={ctx.openSide}><Icon name="menu" /></button>
      <div className="head-title">
        <Crumbs />
        <h1>{title}</h1>
        {facts && <span className="cap">{facts}</span>}
      </div>
      {children}
      <PanelButtons />
    </header>
  );
}

/** In place of a thread or memory from a pool the filters hide. */
export function HiddenPool({ ctx, pool }: { ctx: ShellContext; pool: Pool }) {
  const name = pool === "private" ? "Private" : "General";
  return (
    <main className="main">
      <PageHead ctx={ctx} title={`${name} is hidden`} />
      <div className="welcome"><p>Turn on {name} in the Sort menu to see it.</p></div>
    </main>
  );
}

export const monogram = (user: UserCard) => user.monogram || user.displayName.slice(0, 2);

const PROJECT_FILTERS: { projects: Display["projects"]; label: string }[] = [
  { projects: "all", label: "All threads" }, { projects: "only", label: "Only projects" }, { projects: "none", label: "No projects" },
];

const SORTS: { sort: ThreadSort; label: string }[] = [
  { sort: "date", label: "By date" }, { sort: "activity", label: "Last activity" }, { sort: "started", label: "Start date" }, { sort: "title", label: "Title" }, { sort: "groups", label: "My groups" },
];

/** The sidebar's sections of threads for one sort: a label and the threads under it. */
function sections(threads: ThreadSummary[], sort: ThreadSort, groups: ThreadGroup[], now: Date): { label: string; count?: number; threads: ThreadSummary[] }[] {
  const byActivity = (a: ThreadSummary, b: ThreadSummary) => b.updatedAt.localeCompare(a.updatedAt);
  if (sort === "title") return [{ label: "Title", threads: [...threads].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "") || byActivity(a, b)) }];
  if (sort === "started") return [{ label: "Start date", threads: [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }];
  if (sort === "activity") return [{ label: "Last activity", threads: [...threads].sort(byActivity) }];
  const sorted = [...threads].sort(byActivity);
  if (sort === "groups") {
    return [
      ...groups.map((g) => { const mine = sorted.filter((t) => t.group === g.id); return { label: g.name, count: mine.length, threads: mine }; }),
      { label: "Not in a group", threads: sorted.filter((t) => !groups.some((g) => g.id === t.group)) },
    ];
  }
  // By date: Today, Yesterday, Previous 7 days, Previous 30 days, Older.
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const edges: [string, number][] = [["Today", start], ["Yesterday", start - 864e5], ["Previous 7 days", start - 7 * 864e5], ["Previous 30 days", start - 30 * 864e5], ["Older", -Infinity]];
  const out = edges.map(([label]) => ({ label, threads: [] as ThreadSummary[] }));
  for (const t of sorted) {
    const at = new Date(t.updatedAt).getTime();
    out[edges.findIndex(([, from]) => at >= from)]!.threads.push(t);
  }
  return out.filter((s) => s.threads.length);
}

function Sidebar({ ctx, users, route, threads, error, onAuthChange, onClose }: {
  ctx: ShellContext; users: UserCard[]; route: Route; threads: ThreadSummary[]; error: string; onAuthChange: (notice?: string) => void; onClose: () => void;
}) {
  const { user, me } = ctx;
  const [run, , actionError] = useAction();
  const [query, setQuery] = useState("");
  const now = useNow();
  const menu = useThreadMenu();
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
  const sort = me.display.sort;
  // Search filters titles, child threads included, as they are typed.
  const q = query.trim().toLowerCase();
  const matches = (t: ThreadSummary): boolean => !q || (t.title ?? "New thread").toLowerCase().includes(q) || t.children.some(matches);
  // Pinned threads sit at the top, whatever the sort; the projects filter is the Sort menu's third part.
  const projects = me.display.projects;
  const shown = useMemo(() => {
    const visible = threads.filter((t) => (projects === "only" ? t.project : projects === "none" ? !t.project : true)).filter(matches);
    const pinned = visible.filter((t) => t.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rest = sections(visible.filter((t) => !t.pinned), sort, ctx.groups, now);
    return pinned.length ? [{ label: "Pinned", threads: pinned }, ...rest] : rest;
  }, [threads, sort, projects, ctx.groups, now, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortLabel = SORTS.find((s) => s.sort === sort)?.label ?? "By date";
  const listMenu = useListMenu();

  return (
    <aside className="side" aria-label="Threads">
      <div className="side-top">
        <span className="brand">Lyrica</span>
        <button type="button" className="icon sm side-close" aria-label="Hide threads" onClick={onClose}><Icon name="close" /></button>
      </div>
      <nav className="side-nav" aria-label="Pages">
        <NewThread onCreate={create} />
        <details>
          <summary><Icon name="search" />Search</summary>
          <div><input type="search" aria-label="Search threads" placeholder="Titles" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        </details>
        <a href={href({ page: "settings", userId: user.id, section: "notifications" })} aria-current={route.page === "settings" && route.section === "notifications" ? "page" : undefined}>
          <Icon name="bell" />Notifications{ctx.waiting > 0 && <span className="count" aria-label={`${ctx.waiting} waiting`}>{ctx.waiting}</span>}
        </a>
        <a href={href({ page: "memory", userId: user.id })} aria-current={route.page === "memory" ? "page" : undefined}><Icon name="memory" />Memory</a>
      </nav>
      <div className="thread-tools">
        <details className="showing">
          <summary aria-label={`Sort: ${sortLabel}`}>Sort: {sortLabel} <span className="caret" aria-hidden="true">▾</span></summary>
          <div>
            <div className="rg" role="radiogroup" aria-label="Sort threads">
              {SORTS.map((s) => (
                <label key={s.sort}><input type="radio" name="tsort" checked={sort === s.sort} onChange={() => setDisplay({ sort: s.sort })} /> {s.label}</label>
              ))}
            </div>
            {sort === "groups" && <NewGroup userId={user.id} onDone={ctx.refreshGroups} />}
            <hr className="menu-sep" />
            <label><input type="checkbox" checked={me.display.showGeneral} onChange={(e) => setDisplay({ showGeneral: e.target.checked })} /> General</label>
            <label><input type="checkbox" checked={me.display.showPrivate} onChange={(e) => setDisplay({ showPrivate: e.target.checked })} /> Private</label>
            <label><input type="checkbox" checked={me.display.showHidden} onChange={(e) => setDisplay({ showHidden: e.target.checked })} /> Hidden</label>
            <hr className="menu-sep" />
            <div className="rg" role="radiogroup" aria-label="Projects">
              {PROJECT_FILTERS.map((f) => (
                <label key={f.projects}><input type="radio" name="tprojects" checked={projects === f.projects} onChange={() => setDisplay({ projects: f.projects })} /> {f.label}</label>
              ))}
            </div>
          </div>
        </details>
      </div>
      <ErrorText error={actionError || error} />
      <ul className="threads" aria-label="Threads" {...listMenu.handlers}>
        {shown.map((s) => (
          <li key={s.label} className="group-rows">
            {(shown.length > 1 || sort === "groups" || s.label === "Pinned") && <span className="eyebrow">{s.label}{s.count !== undefined && <span className="num">{s.count}</span>}</span>}
            <ul className="threads-in">
              {s.threads.map((t) => <ThreadRow key={`${t.pool}/${t.id}`} t={t} userId={user.id} current={current} menu={menu.handlers} />)}
            </ul>
          </li>
        ))}
        {!threads.length && !error && <li className="muted empty">No threads yet.</li>}
      </ul>
      {menu.at && (
        <ThreadMenu at={menu.at} userId={user.id} route={route} groups={ctx.groups} onGroups={ctx.refreshGroups} onChange={ctx.refreshThreads} onClose={menu.close} />
      )}
      {listMenu.at && <ListMenu at={listMenu.at} ctx={ctx} onClose={listMenu.close} />}
      <div className="side-foot">
        <UserMenu ctx={ctx} users={users} onAuthChange={onAuthChange} />
      </div>
    </aside>
  );
}

/** New group, in the Sort menu while My groups is the sort. */
function NewGroup({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [run, busy, error] = useAction();
  if (!open) return <button type="button" className="link sm new-group" onClick={() => setOpen(true)}>New group…</button>;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(u(userId, "thread-groups"), { name }); setName(""); setOpen(false); onDone(); }); }}>
      <input autoFocus aria-label="Group name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="primary sm" disabled={busy || !name.trim()}>Add</button>
      <ErrorText error={error} />
    </form>
  );
}

/** The thread list's own menu, from a right-click or long press on its empty space: New project and New group. */
function useListMenu() {
  const [at, setAt] = useState<{ x: number; y: number }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Anywhere on the list that is not a row: the eyebrows, the gaps, and the strip under the last row.
  const onList = (e: React.SyntheticEvent) => !(e.target as HTMLElement).closest(".thread, .chev, .resolved-row");
  const handlers = {
    onContextMenu: (e: React.MouseEvent) => { if (!onList(e)) return; e.preventDefault(); setAt({ x: e.clientX, y: e.clientY }); },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" || !onList(e)) return;
      clearTimeout(timer.current);
      const { clientX: x, clientY: y } = e;
      timer.current = setTimeout(() => setAt({ x, y }), 500);
    },
    onPointerUp: () => clearTimeout(timer.current),
    onPointerMove: () => clearTimeout(timer.current),
    onPointerCancel: () => clearTimeout(timer.current),
  };
  return { at, close: () => setAt(undefined), handlers };
}

function ListMenu({ at, ctx, onClose }: { at: { x: number; y: number }; ctx: ShellContext; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<"" | "project" | "group">("");
  const [name, setName] = useState("");
  const [run, , error] = useAction();
  const userId = ctx.user.id;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - r.height - 8))}px`;
    el.querySelector("button")?.focus();
  }, [at, sub]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (sub) setSub(""); else onClose(); return; }
      if (e.target instanceof HTMLInputElement || menuArrows(e, ref.current)) return;
      const btn = ref.current?.querySelector<HTMLButtonElement>(`button[data-key="${e.key.toUpperCase()}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    };
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", down);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", down); };
  }, [sub, onClose]);
  const addGroup = () => run(async () => { await post(u(userId, "thread-groups"), { name: name.trim() }); ctx.refreshGroups(); onClose(); });
  // A new project is an empty project chat, pinned, opened at once.
  const create = (pool: Pool) => run(async () => {
    const t = await post<ThreadSummary>(u(userId, "threads"), { pool, project: true });
    ctx.refreshThreads();
    onClose();
    go({ page: "thread", userId, pool, threadId: t.id });
  });
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label="Thread list menu" style={{ left: at.x, top: at.y }}>
      {sub === "project" ? (
        <>
          <button type="button" className="back" onClick={() => setSub("")}>‹ New project in</button>
          <button type="button" role="menuitem" data-key="G" onClick={() => create("general")}><span>General</span><kbd>G</kbd></button>
          <button type="button" role="menuitem" data-key="P" onClick={() => create("private")}><span>Private</span><kbd>P</kbd></button>
        </>
      ) : sub === "group" ? (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void addGroup(); }}>
          <input autoFocus aria-label="Group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="primary sm" disabled={!name.trim()}>Add</button>
        </form>
      ) : (
        <>
          <button type="button" role="menuitem" className="has-sub" data-key="P" onClick={() => setSub("project")}><span>New project</span><kbd>P</kbd></button>
          <button type="button" role="menuitem" data-key="G" onClick={() => setSub("group")}><span>New group…</span><kbd>G</kbd></button>
        </>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function NewThread({ onCreate }: { onCreate: (pool: Pool) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" aria-expanded="false" onClick={() => setOpen(true)}><Icon name="plus" />New thread</button>;
  return (
    <div className="new-choice" role="group" aria-label="New thread in">
      <button type="button" className="primary sm" autoFocus onClick={() => { setOpen(false); onCreate("general"); }}>General</button>
      <button type="button" className="private sm" onClick={() => { setOpen(false); onCreate("private"); }}>Private</button>
      <button type="button" className="icon sm" aria-label="Cancel" onClick={() => setOpen(false)}><Icon name="close" /></button>
    </div>
  );
}

type MenuHandlers = ReturnType<ReturnType<typeof useThreadMenu>["handlers"]>;

function ThreadRow({ t, userId, current, menu }: { t: ThreadSummary; userId: string; current: string; menu: (t: ThreadSummary) => MenuHandlers }) {
  const key = `${t.pool}/${t.id}`;
  // A project's threads show by default; resolved ones fold under one Resolved row.
  const [open, setOpen] = useState(() => !!t.project || t.children.some((c) => `${c.pool}/${c.id}` === current));
  const [resolvedOpen, setResolvedOpen] = useState(() => t.children.some((c) => c.state === "resolved" && `${c.pool}/${c.id}` === current));
  const active = t.project ? t.children.filter((c) => c.state !== "resolved") : t.children;
  const resolved = t.project ? t.children.filter((c) => c.state === "resolved") : [];
  return (
    <li>
      <div className="trow">
        {t.children.length > 0
          ? <button type="button" className="chev" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${t.project ? "the project's threads" : "child threads"}`} onClick={() => setOpen(!open)}><Icon name="right" /></button>
          : <span className="chev" />}
        <ThreadLink t={t} userId={userId} on={current === key} menu={menu} />
      </div>
      {open && (
        <ul className="children">
          {active.map((c) => <li key={c.id}><ThreadLink t={c} userId={userId} on={current === `${c.pool}/${c.id}`} menu={menu} child /></li>)}
          {resolved.length > 0 && (
            <li>
              <button type="button" className="resolved-row" aria-expanded={resolvedOpen} onClick={() => setResolvedOpen(!resolvedOpen)}>
                <Icon name="right" className="chev-ic" />Resolved <span className="num">{resolved.length}</span>
              </button>
              {resolvedOpen && <ul className="children">{resolved.map((c) => <li key={c.id}><ThreadLink t={c} userId={userId} on={current === `${c.pool}/${c.id}`} menu={menu} child /></li>)}</ul>}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function ThreadLink({ t, userId, on, menu, child }: { t: ThreadSummary; userId: string; on: boolean; menu: (t: ThreadSummary) => MenuHandlers; child?: boolean }) {
  // A project's thread: its state as a word, then its unseen updates. Otherwise at most two badges,
  // most pressing first (ux.md §5): waiting on her, then new updates, then hidden.
  const inProject = t.state !== undefined;
  const badges = [
    inProject ? <span key="s" className="tstate" data-state={t.needsYou ? "needsYou" : t.state}>{stateWord(t)}</span> : t.status === "waiting" && <span key="w" className="flag">waiting</span>,
    !!t.unseen && <span key="u" className="count" aria-label={`${t.unseen} new ${t.unseen === 1 ? "update" : "updates"}`}>{t.unseen}</span>,
    t.hidden && <span key="h" className="flag">hidden</span>,
  ].filter(Boolean).slice(0, 2);
  // A project row: the project icon in the pool dot's place, amber when one of its threads waits on her.
  const waiting = t.project && t.children.some((c) => c.state === "waiting");
  return (
    <a className={`thread${t.unread ? " unread" : ""}${t.project ? " project" : ""}${child && inProject ? " dotted" : ""}`} href={href({ page: "thread", userId, pool: t.pool, threadId: t.id })} aria-current={on ? "page" : undefined} {...menu(t)}>
      {t.project ? <span className={`project-mark ${t.pool}`} data-waiting={waiting || undefined}><Icon name="project" />{waiting && <span className="sr-only">a thread waits on you</span>}</span>
        : (!child || inProject) && (t.pool === "private"
          ? <svg className="pool-lock" viewBox="0 0 12 14" aria-hidden="true"><rect x="1" y="6" width="10" height="7.5" rx="1.5" /><path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" fill="none" strokeWidth="1.6" /></svg>
          : <span className="pool-dot" aria-hidden="true" />)}
      <span className="title">{t.title || (t.project ? "New project" : "New thread")}</span>
      <span className="when">
        {t.busy && !inProject && <span className="busy" title="Working" />}
        {badges}
        {!inProject && shortTime(t.updatedAt)}
      </span>
      {t.pool === "private" && <span className="sr-only">private</span>}
      {t.unread && <span className="sr-only">unread</span>}
    </a>
  );
}

/** The user's button at the sidebar's foot: Settings, Administration, Switch user, Lock and Log out. */
function UserMenu({ ctx, users, onAuthChange }: { ctx: ShellContext; users: UserCard[]; onAuthChange: (notice?: string) => void }) {
  const { user } = ctx;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  useEffect(() => { addEventListener("hashchange", close); return () => removeEventListener("hashchange", close); }, [close]);
  // Open from the keyboard: the first item takes focus, the arrows move, closing returns focus to the button.
  useEffect(() => {
    if (!open) return;
    const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]');
    menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const key = (e: KeyboardEvent) => { menuArrows(e, menu ?? null); };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); ref.current?.querySelector<HTMLElement>(".user-switch")?.focus(); };
  }, [open]);
  const [run, , error] = useAction();
  const leave = (path: string, body: unknown) => run(async () => {
    const r = await post<Partial<LogoutResponse>>(path, body);
    setOpen(false);
    go({ page: "home" });
    onAuthChange(r.stillUnlocked?.length
      ? `Logged out here. ${user.displayName} stays unlocked, because another browser is still logged in.`
      : undefined);
  });
  const others = users.filter((x) => x.id !== user.id);
  return (
    <div className="user-wrap" ref={ref}>
      {open && (
        <div className="menu above" role="menu">
          <a href={href({ page: "settings", userId: user.id })} role="menuitem" onClick={close}>Settings</a>
          {user.admin && <a href={href({ page: "admin", userId: user.id })} role="menuitem" onClick={close}>Administration</a>}
          <div className="sep" role="separator" />
          <span className="cap">Switch user</span>
          {others.map((x) => (
            <a key={x.id} href={href({ page: "home", userId: x.id })} role="menuitem" onClick={close}>
              <span className="avatar small" style={x.accent ? { background: x.accent } : undefined} aria-hidden="true">{monogram(x)}</span>{x.displayName}
            </a>
          ))}
          <a href="#/login" role="menuitem" onClick={close}>Log in as another user…</a>
          <div className="sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => leave(u(user.id, "lock"), {})}>Lock</button>
          <button type="button" role="menuitem" onClick={() => leave("/api/logout", { userId: user.id })}>Log out</button>
          <ErrorText error={error} />
        </div>
      )}
      <button type="button" className="user-switch" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{monogram(user)}</span>
        <span><b>{user.displayName}</b><small>Switch user</small></span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
    </div>
  );
}

const greeting = (h: number) => (h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");

/** The welcome page: the header carries the version and build; the message box starts a thread with its first message. */
function Welcome({ ctx }: { ctx: ShellContext }) {
  const now = useNow();
  const date = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <main className="main">
      <PageHead ctx={ctx} title={<>Lyrica <span className="ver">{ctx.build.version} · {ctx.build.build}</span></>} facts={<>{date} · <span className="num">{time}</span></>} />
      <div className="scroll">
        <div className="welcome">
          <h1>{greeting(now.getHours())}, {ctx.user.displayName}.</h1>
          <HomeBox ctx={ctx} />
          <NotificationsCard ctx={ctx} />
        </div>
      </div>
    </main>
  );
}

/** Starts a thread in the chosen pool and sends the text as its first message. */
function HomeBox({ ctx }: { ctx: ShellContext }) {
  const [pool, setPool] = useState<Pool>("general");
  const [draft, setDraft] = useState("");
  const [run, busy, error] = useAction();
  const userId = ctx.user.id;
  const start = () => run(async () => {
    const text = draft.trim();
    if (!text) return;
    const t = await post<ThreadSummary>(u(userId, "threads"), { pool });
    await post(u(userId, "threads", pool, t.id, "messages"), { text });
    ctx.refreshThreads();
    go({ page: "thread", userId, pool, threadId: t.id });
  });
  const touch = matchMedia("(pointer: coarse)").matches;
  return (
    <form className="home-box" data-has-text={!!draft.trim()} onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <div className="composer-box">
        <textarea rows={1} aria-label="Message" placeholder="Start a new thread…" value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !touch) { e.preventDefault(); void start(); } }} />
        <button type="submit" className="icon send" aria-label="Send" title="Send" disabled={busy || !draft.trim()}><Icon name="up" /></button>
      </div>
      <div className="composer-row">
        <div className="seg" role="group" aria-label="Pool">
          <button type="button" aria-pressed={pool === "general"} onClick={() => setPool("general")}>General</button>
          <button type="button" className="private" aria-pressed={pool === "private"} onClick={() => setPool("private")}>Private</button>
        </div>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
