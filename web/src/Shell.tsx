// The signed-in layout: the sidebar, and the page the route points at.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { get, patch, post, upload, threadPath, u, type Display, type DisplayChange, type LogoutResponse, type Me, type Pool, type SearchHit, type State, type ThreadGroup, type ThreadSort, type ThreadSummary, type ThreadSettings, type ThreadSettingsChange, type UserCard } from "./api.ts";
import { asPanel, href, go, panelRoute, parse, type Panel, type Route } from "./route.ts";
import { Icon } from "./icons.tsx";
import { ComposerRow } from "./Composer.tsx";
import { useDictation, stopReading } from "./Voice.tsx";
import { Brand } from "./Brand.tsx";
import { Thread, findThread } from "./Thread.tsx";
import { JournalHistoryPage, MemoryHistoryPage, Memory, memoryTitle } from "./Memory.tsx";
import { AdminPage, SettingsPage } from "./Panel.tsx";
import { FilesPage } from "./Files.tsx";
import { NotificationsCard, NotificationsPage, useWaiting } from "./Notifications.tsx";
import { SleepCard, SleepHistoryPage, SleepPage, useSleepOverview, type SleepState } from "./Sleep.tsx";
import { BackendCard, ModelsArea, useCleanupCount, useModelsPage } from "./Models.tsx";
import type { ModelsState } from "./ModelsFrame.tsx";
import { SideStatus } from "./SideStatus.tsx";
import { ThreadMenu, useThreadMenu } from "./ThreadMenu.tsx";
import { Flyout, useCanHover, useFlyout } from "./flyout.tsx";
import { ProjectPage, ThreadsPage, stateWord } from "./Project.tsx";
import { SearchGroups, searchable, useMessageSearch } from "./Search.tsx";
import { ask, JUMP_EVENT, JUMP_KEY, keep, type JumpRequest } from "./links.ts";
import { clock, ErrorText, hidden, InlineRename, menuArrows, shortTime, Toast, useAction, useDismiss, useLoad, useNow } from "./ui.tsx";

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
  /** The Sleep overview for the sidebar's count of new items; user and Sleep events keep it fresh. */
  sleep: SleepState;
  /** How many items Clean up lists (the sidebar's Models count), and a reload after one is acted on. */
  cleanup: { count: number; reload: () => void };
  /** GET …/models/page, polled by the shell so the sidebar's status panel shows everywhere; the Models area reads it from here too. */
  models: ModelsState;
  /** Counts what the user stream says changed: a page's loads that depend on it read again (a model's settings after she changes them). */
  changed: number;
  /** The thread list, for naming threads elsewhere (Recent calls, Clean up). */
  threads: ThreadSummary[];
  openSide: () => void;
  /** Reload GET /api/state: after her name changes. */
  refreshState: () => void;
  /** Says what an action did in a toast at the foot of the screen ("Pinned to the top"), gone after a few seconds. */
  toast: (text: string) => void;
  /** Per thread (`<pool>/<id>`), a count bumped when its open stream finished a tool call or a turn: the Files panel beside it reloads its folders. */
  activity: Record<string, number>;
  noteActivity: (key: string) => void;
}

export function Shell({ user, users, route, build, onAuthChange, refreshState }: {
  user: UserCard; users: UserCard[]; route: Route; build: Pick<State, "version" | "build">;
  /** After logout or Lock, with a line to show, if any. */
  onAuthChange: (notice?: string) => void;
  refreshState: () => void;
}) {
  const me = useLoad(() => get<Me>(u(user.id, "me")), [user.id]);
  const threads = useLoad(() => get<ThreadSummary[]>(u(user.id, "threads")), [user.id]);
  const groups = useLoad(() => get<ThreadGroup[]>(u(user.id, "thread-groups")), [user.id]);
  const [sideOpen, setSideOpen] = useState(false);
  // Numbered, so the same words said again start their few seconds again.
  const [toast, setToast] = useState<{ text: string; n: number }>();
  const closeToast = useCallback(() => setToast(undefined), []);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const noteActivity = useCallback((key: string) => setActivity((a) => ({ ...a, [key]: (a[key] ?? 0) + 1 })), []);
  const wide = useWide();
  // Below the split width the panel's address is the page itself (docs/ux.md §6).
  const shown: Route = route.page === "thread" && route.panel && !wide ? panelRoute(route.userId, route.panel) : route;
  const trail = usePanelTrail(route);

  // Close the sidebar overlay whenever the page changes, and forget where a page opened as a page came from once it is left.
  useEffect(() => { setSideOpen(false); forgetBeside(route); }, [route]);
  const notes = useWaiting(user.id);
  const sleep = useSleepOverview(user.id, me.data?.display);
  const cleanup = useCleanupCount(user.id);
  // The endpoints' live status, for the sidebar's panel and the Models area; when it last arrived is what the panel's "checked" times count from.
  const models = useModelsPage(user.id, cleanup.reload, me.data?.display.showGeneral ?? true, me.data?.display.showPrivate ?? true);
  const [checkedAt, setCheckedAt] = useState(0);
  useEffect(() => { if (models.page) setCheckedAt(Date.now()); }, [models.page]);
  // The user stream says when something changed, from this tab, another or her own work: the shell reads its lists again.
  const refreshShell = useCallback(() => {
    me.reload(); threads.reload(); groups.reload(); notes.reload(); sleep.reload();
  }, [me.reload, threads.reload, groups.reload, notes.reload, sleep.reload]);
  // The Models area too, so a setting she changed in a thread shows without a refresh.
  const [changed, setChanged] = useState(0);
  const onChanged = useCallback(() => { refreshShell(); models.reload(); setChanged((n) => n + 1); }, [refreshShell, models.reload]);
  useEffect(() => {
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let stopped = false;
    const open = () => {
      es = new EventSource(u(user.id, "events"));
      es.addEventListener("hello", () => { delay = 1000; onChanged(); });
      es.addEventListener("changed", onChanged);
      // EventSource retries ordinary disconnects. Recreate it if an HTTP error makes it give up,
      // and use Me's authenticated GET to surface logout or Lock through the usual auth handler.
      es.onerror = () => {
        if (es?.readyState !== EventSource.CLOSED || stopped) return;
        me.reload();
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
    return () => { stopped = true; es?.close(); clearTimeout(retry); };
  }, [user.id, onChanged, me.reload]);
  // Endpoint status comes from probes, so only Models keeps a timer. Focus still refreshes everything.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") models.reload(); };
    const focus = () => { if (document.visibilityState === "visible") { refreshShell(); models.reload(); } };
    const t = setInterval(tick, 30_000);
    addEventListener("focus", focus);
    return () => { clearInterval(t); removeEventListener("focus", focus); };
  }, [refreshShell, models.reload]);
  useLook(me.data);

  if (!me.data) return <div className="loading">{me.error ? <ErrorText error={me.error} /> : "Loading…"}</div>;
  const ctx: ShellContext = {
    user: me.data.user, me: me.data, setMe: me.set, build, refreshThreads: threads.reload,
    groups: groups.data ?? [], refreshGroups: groups.reload, waiting: notes.waiting, refreshNotifications: notes.reload, sleep, cleanup, models, changed, threads: threads.data ?? [], openSide: () => setSideOpen(true),
    refreshState, toast: (text) => setToast((t) => ({ text, n: (t?.n ?? 0) + 1 })), activity, noteActivity,
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
    ) : r.page === "threads" && hidden(me.data!.display, r.pool) ? (
      <HiddenPool ctx={ctx} pool={r.pool} />
    ) : r.page === "threads" ? (
      <ThreadsPage key={`${r.pool}/${r.threadId}`} ctx={ctx} pool={r.pool} threadId={r.threadId} />
    ) : r.page === "memory" ? (
      <Memory ctx={ctx} pool={r.pool} id={r.id} />
    ) : r.page === "history" && r.kind === "sleep" ? (
      <SleepHistoryPage ctx={ctx} route={r} />
    ) : r.page === "history" && r.kind === "journal" ? (
      <JournalHistoryPage ctx={ctx} pool={r.pool} route={r} />
    ) : r.page === "history" && r.pool && r.id ? (
      <MemoryHistoryPage key={`${r.pool}/${r.id}`} ctx={ctx} pool={r.pool} id={r.id} route={r} />
    ) : r.page === "sleep" ? (
      <SleepPage ctx={ctx} />
    ) : r.page === "models" ? (
      <ModelsArea ctx={ctx} tab={r.tab} add={r.add} project={r.project} pool={r.pool} route={r} />
    ) : r.page === "notifications" ? (
      <NotificationsPage ctx={ctx} />
    ) : r.page === "settings" ? (
      <SettingsPage ctx={ctx} section={r.section} />
    ) : r.page === "admin" ? (
      <AdminPage ctx={ctx} section={r.section} />
    ) : (
      <Welcome ctx={ctx} />
    );

  return (
    <div className="app" data-side-open={sideOpen} data-panel={!!panel || undefined} onClick={wide && route.page === "thread" ? (e) => openInPanel(e, route, trail) : undefined}>
      <Sidebar ctx={ctx} users={users} route={shown} trail={trail} threads={threads.data ?? []} error={threads.error} checkedAt={checkedAt} onAuthChange={onAuthChange} onClose={() => setSideOpen(false)} />
      <div className="scrim" aria-hidden="true" onClick={() => setSideOpen(false)} />
      {page(shown, () => dropDrawer(shown === route ? "page" : "panel"))}
      {panel && route.page === "thread" && (
        <PanelColumn route={route} panel={panel} trail={trail} threads={threads.data ?? []}>
          {page(panelRoute(route.userId, panel), () => dropDrawer("panel"))}
        </PanelColumn>
      )}
      {toast && <Toast key={toast.n} text={toast.text} after={4000} onClose={closeToast} />}
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
const PANEL_MIN = 280, PANEL_MAX = 1000, PANEL_DEFAULT = 420;
const PANEL_WIDTH_KEY = "lyrica.panel-width";
const SIDE_MIN = 200, SIDE_MAX = 440, SIDE_DEFAULT = 248;
const SIDE_WIDTH_KEY = "lyrica.sidebar-width";

/** A column's width kept per browser; where storage is off, it starts at the default each time. */
function useStoredWidth(key: string, min: number, max: number, start: number): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => { try { const n = Number(localStorage.getItem(key)); return n >= min && n <= max ? n : start; } catch { return start; } });
  const resize = (w: number) => { const x = Math.round(Math.min(max, Math.max(min, w))); setWidth(x); try { localStorage.setItem(key, String(x)); } catch { /* kept for this visit only */ } };
  return [width, resize];
}

/**
 * The draggable edge of a column (the panel's left, the sidebar's right): a separator the arrow keys move too,
 * Home and End to the leftmost and rightmost place. A drag or a key starts from the width the column shows,
 * which the layout may hold under the stored one in a narrow window.
 */
function Divider({ label, edge, min, max, width, resize }: { label: string; edge: "left" | "right"; min: number; max: number; width: number; resize: (w: number) => void }) {
  // Moving the edge right widens a column whose right edge it is, and narrows one whose left edge it is.
  const dir = edge === "right" ? 1 : -1;
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const startX = e.clientX, startW = el.parentElement!.getBoundingClientRect().width;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => resize(startW + dir * (ev.clientX - startX));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10;
    const shown = Math.min(width, e.currentTarget.parentElement!.getBoundingClientRect().width);
    if (e.key === "ArrowLeft") resize(shown - dir * step);
    else if (e.key === "ArrowRight") resize(shown + dir * step);
    else if (e.key === "Home") resize(dir > 0 ? min : max);
    else if (e.key === "End") resize(dir > 0 ? max : min);
    else return;
    e.preventDefault();
  };
  return <div className={`divider ${edge}`} role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0} onPointerDown={drag} onKeyDown={keys} />;
}

/** At or above the split width: the panel can show beside a conversation. */
export function useWide(): boolean {
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
 * panel replace what it shows; the sidebar's rows navigate (a child row's Shift+click opens beside).
 * A link to the conversation's own thread closes the panel (its Thread settings link opens the drawer).
 */
function openInPanel(e: React.MouseEvent, route: Route & { page: "thread" }, trail: Trail) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest("a[href^='#/u/']");
  if (!a || a.closest(".side, .panel-actions")) return;
  const to = parse(a.getAttribute("href")!);
  if (to.page !== "thread" && to.page !== "project" && to.page !== "files" && !(to.page === "memory" && to.pool && to.id)) return;
  if (to.userId !== route.userId) return;
  e.preventDefault();
  if (to.page === "thread" && to.pool === route.pool && to.threadId === route.threadId) {
    go({ page: "thread", userId: route.userId, pool: route.pool, threadId: route.threadId, ...(to.drawer ? { drawer: true } : {}) });
    return;
  }
  const panel: Panel = to.page === "thread"
    ? { page: "thread", pool: to.pool, threadId: to.threadId, ...(to.drawer ? { drawer: true as const } : {}) }
    : to.page === "files" ? { page: "files", pool: to.pool, threadId: to.threadId, ...(to.path ? { path: to.path } : {}) }
    : to.page === "memory" ? { page: "memory", pool: to.pool!, id: to.id! }
    : { page: "project", pool: to.pool, threadId: to.threadId, ...(to.section ? { section: to.section } : {}) };
  // The Files button toggles its panel; a file's link shows that file in it.
  if (panel.page === "files" && !panel.path && route.panel?.page === "files" && route.panel.threadId === panel.threadId) { go({ ...route, drawer: undefined, panel: undefined }); return; }
  // A breadcrumb goes back to that page; a link in the panel goes one deeper.
  const crumb = (a as HTMLElement).dataset.crumb;
  if (crumb !== undefined || a.closest(".panel")) {
    trail.set(crumb !== undefined ? trail.crumbs.slice(0, Number(crumb) + 1) : [...trail.crumbs, panel]);
    go({ ...route, drawer: undefined, panel });
  } else showInPanel(route, trail, panel); // one in the conversation starts afresh.
}

/** Opens `panel` beside the thread in `route`, its trail starting there: a panel reached any other way than a link inside it begins a new one. */
function showInPanel(route: Route & { page: "thread" }, trail: Trail, panel: Panel) {
  trail.set([panel]);
  go({ ...route, drawer: undefined, panel });
}

export interface PanelContext {
  /** The pages opened in turn; the current one last. */
  crumbs: { label: string; href: string }[];
  /** The panel's page on its own. */
  expand: string;
  /** Closes the panel; left out beside the file viewer at the split width, where the viewer's Thread toggle hides it. */
  close?: () => void;
  /** Open as a page keeps no way back beside it (the thread beside the file viewer, whose page isn't a conversation's panel). */
  noReturn?: true;
}
const PanelCtx = createContext<PanelContext | undefined>(undefined);
/** The panel's breadcrumb and buttons, when inside it. */
export const usePanel = () => useContext(PanelCtx);
/** A page shown as if in the panel somewhere else (the producing thread beside the file viewer): its own crumbs and buttons. */
export const PanelFrame = ({ value, children }: { value: PanelContext; children: React.ReactNode }) => <PanelCtx.Provider value={value}>{children}</PanelCtx.Provider>;

/** The page's root: `main` on its own, a plain block inside the panel (one main per document). */
export function Main(props: React.HTMLAttributes<HTMLElement>) {
  return usePanel() ? <div {...props} /> : <main {...props} />;
}

function PanelColumn({ route, panel, trail, threads, children }: { route: Route & { page: "thread" }; panel: Panel; trail: Trail; threads: ThreadSummary[]; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [width, resize] = useStoredWidth(PANEL_WIDTH_KEY, PANEL_MIN, PANEL_MAX, PANEL_DEFAULT);
  // The grid that reads --panel-w is .app, the aside's parent (app.css), so it goes there; on the aside it never reached that rule.
  useLayoutEffect(() => {
    const app = ref.current?.parentElement;
    if (!app) return;
    app.style.setProperty("--panel-w", `${width}px`);
    return () => { app.style.removeProperty("--panel-w"); };
  }, [width]);
  const close = useCallback(() => go({ ...route, drawer: undefined, panel: undefined }), [route]);
  // The first memory in the trail is the panel's name, Memory; a memory followed from it carries its title, so the crumbs grow.
  const label = (p: Panel, i: number) => p.page === "project" ? "Project settings" : p.page === "threads" ? "Threads" : p.page === "files" ? "Files"
    : p.page === "memory" ? (trail.crumbs[i - 1]?.page === "memory" && memoryTitle(p.pool, p.id)) || "Memory"
    : findThread(threads, p.pool, p.threadId)?.title || "New thread";
  const crumbs = trail.crumbs.map((p, i) => ({ label: label(p, i), href: href(panelRoute(route.userId, p)) }));
  const ctx: PanelContext = { crumbs, expand: href(panelRoute(route.userId, panel)), close };
  const current = href(panelRoute("", panel));
  // Focus lands on the page's heading each time the panel shows something else, unless the user is typing in a field
  // outside the panel (renaming a sidebar row that opened it, say): a field being edited keeps its focus.
  useEffect(() => {
    const h = ref.current?.querySelector("h1");
    if (!h) return;
    h.tabIndex = -1;
    const a = document.activeElement;
    if (a && !ref.current!.contains(a) && a.matches("input, textarea, [contenteditable]")) return;
    h.focus();
  }, [current]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if ((e.target as Element).closest("dialog, [role='menu'], .drawer, .picker, [aria-expanded='true']")) return;
    close();
  };
  return (
    <aside ref={ref} className="panel" role="complementary" aria-label={crumbs.map((c) => c.label).join(" › ")} onKeyDown={onKeyDown}>
      <Divider label="Panel width" edge="left" min={PANEL_MIN} max={PANEL_MAX} width={width} resize={resize} />
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

/**
 * Where Open as a page left from: the conversation's address, and which page went on its own, so that page
 * can go back beside it (Open in panel). Kept for the tab's session; where storage is off, for this visit.
 */
const BESIDE_KEY = "lyrica.beside";
let beside: { from: string; page: string } | undefined = (() => { try { return JSON.parse(sessionStorage.getItem(BESIDE_KEY) ?? "null") ?? undefined; } catch { return undefined; } })();
function keepBeside(b: typeof beside) {
  beside = b;
  try { if (b) sessionStorage.setItem(BESIDE_KEY, JSON.stringify(b)); else sessionStorage.removeItem(BESIDE_KEY); } catch { /* kept for this visit only */ }
}
/** Which page a panel shows, whatever its drawer, file or section: the page on its own stays the same page through those. */
const pageKey = (p: Panel) => p.page === "memory" ? `memory/${p.pool}/${p.id}` : `${p.page}/${p.pool}/${p.threadId}`;

/** The conversation the page at `route` was opened from with Open as a page, with this page in its panel as it is now; forgotten once another page shows. */
function besideRoute(route: Route): Route | undefined {
  const panel = asPanel(route);
  if (!beside || !panel || pageKey(panel) !== beside.page) return undefined;
  const from = parse(beside.from);
  return from.page === "thread" ? { ...from, panel } : undefined;
}
function forgetBeside(route: Route) {
  const panel = asPanel(route);
  if (beside && (!panel || pageKey(panel) !== beside.page)) keepBeside(undefined);
}

/** Open as a page and Close panel (when the panel can close) at the end of the panel's header; on a page opened that way, Open in panel in their place, from 1180 px up. */
export function PanelButtons() {
  const p = usePanel();
  const wide = useWide();
  const back = !p && wide ? besideRoute(parse(location.hash)) : undefined;
  const backHref = back && href(back);
  // Esc on the page goes back beside the conversation, as it closes the panel.
  useEffect(() => {
    if (!backHref) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as Element).closest?.("dialog, [role='menu'], .drawer, .picker, [aria-expanded='true'], .panel")) return;
      location.hash = backHref;
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [backHref]);
  if (backHref) {
    return (
      <div className="head-actions panel-actions">
        <a className="icon sm" href={backHref} aria-label="Open in panel" title="Open in panel"><Icon name="collapse" /></a>
      </div>
    );
  }
  if (!p) return null;
  return (
    <div className="head-actions panel-actions">
      <a className="icon sm" href={p.expand} aria-label="Open as a page" title="Open as a page" onClick={p.noReturn ? undefined : () => keepBeside({ from: location.hash, page: pageKey(asPanel(parse(p.expand))!) })}><Icon name="expand" /></a>
      {p.close && <button type="button" className="icon sm" aria-label="Close panel" title="Close panel" onClick={p.close}><Icon name="close" /></button>}
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

/** The private pool's small lock, where a general row has its dot. */
export const PoolLock = () => (
  <svg className="pool-lock" viewBox="0 0 12 14" aria-hidden="true"><rect x="1" y="6" width="10" height="7.5" rx="1.5" /><path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" fill="none" strokeWidth="1.6" /></svg>
);

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

function Sidebar({ ctx, users, route, trail, threads, error, checkedAt, onAuthChange, onClose }: {
  ctx: ShellContext; users: UserCard[]; route: Route; trail: Trail; threads: ThreadSummary[]; error: string; checkedAt: number; onAuthChange: (notice?: string) => void; onClose: () => void;
}) {
  const { user, me } = ctx;
  const [run, , actionError] = useAction();
  const [query, setQuery] = useState("");
  // Its width, dragged on its right edge, goes to .app's grid as the panel's does; a phone's slide-over keeps its own.
  const sideRef = useRef<HTMLElement>(null);
  const [sideWidth, resizeSide] = useStoredWidth(SIDE_WIDTH_KEY, SIDE_MIN, SIDE_MAX, SIDE_DEFAULT);
  useLayoutEffect(() => {
    const app = sideRef.current?.parentElement;
    if (!app) return;
    app.style.setProperty("--side-w", `${sideWidth}px`);
    return () => { app.style.removeProperty("--side-w"); };
  }, [sideWidth]);
  const now = useNow();
  const menu = useThreadMenu();
  // Open beside (docs/ux.md §6): from 1180 px up, with a thread open, a child row opens in the panel beside it.
  const wide = useWide();
  const root = wide && route.page === "thread" ? route : undefined;
  const openBeside = root ? (t: ThreadSummary) => showInPanel(root, trail, { page: "thread", pool: t.pool, threadId: t.id }) : undefined;
  // A double-click on a row's title renames it in place (docs/ux.md §6), as the menu's Rename… does.
  const rename = (t: ThreadSummary, title: string) => run(async () => { await patch(threadPath(user.id, t.pool, t.id), { title }); ctx.refreshThreads(); });
  const setDisplay = (change: DisplayChange) => run(async () => {
    ctx.setMe(await patch<Me>(u(user.id, "me", "display"), change));
    ctx.refreshThreads();
  });
  const create = (pool: Pool) => run(async () => {
    const t = await post<ThreadSummary>(u(user.id, "threads"), { pool });
    ctx.refreshThreads();
    go({ page: "thread", userId: user.id, pool, threadId: t.id });
  });
  // A new project is an empty project chat, pinned, opened at once — what the list menu's item does.
  const createProject = (pool: Pool) => run(async () => {
    const t = await post<ThreadSummary>(u(user.id, "threads"), { pool, project: true });
    ctx.refreshThreads();
    go({ page: "thread", userId: user.id, pool, threadId: t.id });
  });
  const current = route.page === "thread" ? `${route.pool}/${route.threadId}` : "";
  const sort = me.display.sort;
  // Search filters titles, child threads included, as they are typed; from 2 characters lyricad's
  // message hits follow 300 ms later, and the list becomes their groups.
  const q = query.trim().toLowerCase();
  const titleMatches = (t: ThreadSummary) => (t.title ?? "New thread").toLowerCase().includes(q);
  const matches = (t: ThreadSummary): boolean => !q || titleMatches(t) || t.children.some(matches);
  const search = useMessageSearch(user.id, q, me.display);
  const hits = q ? search.results : undefined;
  // A hit opens its thread at the message: the open thread scrolls there, any other takes it when it opens.
  const openHit = (h: SearchHit) => {
    const req: JumpRequest = { base: threadPath(user.id, h.pool, h.threadId), n: h.n };
    const here = route.page === "thread" && route.pool === h.pool && route.threadId === h.threadId;
    if (!(here && ask(JUMP_EVENT, req))) keep(JUMP_KEY, req);
    onClose();
  };
  const [moreRun, , moreError] = useAction();
  // Pinned threads sit at the top, whatever the sort; the projects filter is the Sort menu's third part.
  const projects = me.display.projects;
  const shown = useMemo(() => {
    const visible = threads.filter((t) => (projects === "only" ? t.project : projects === "none" ? !t.project : true)).filter(matches);
    const pinned = visible.filter((t) => t.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rest = sections(visible.filter((t) => !t.pinned), sort, ctx.groups, now);
    return pinned.length ? [{ label: "Pinned", threads: pinned }, ...rest] : rest;
  }, [threads, sort, projects, ctx.groups, now, q]); // eslint-disable-line react-hooks/exhaustive-deps
  // With the hits here: the threads whose own title matches, for the rows after the hits' groups.
  const flat = (t: ThreadSummary): ThreadSummary[] => [t, ...t.children.flatMap(flat)];
  const titled = hits ? shown.flatMap((s) => s.threads).flatMap(flat).filter(titleMatches) : [];
  const nothing = !!q && threads.length > 0 && (hits ? !hits.hits.length && !titled.length : !searchable(q) && !shown.length);
  const sortLabel = SORTS.find((s) => s.sort === sort)?.label ?? "By date";
  const listMenu = useListMenu();

  return (
    <aside ref={sideRef} className="side" aria-label="Threads">
      <div className="side-top">
        <Brand userId={user.id} route={route} onClick={onClose} />
        <button type="button" className="icon sm side-close" aria-label="Hide threads" onClick={onClose}><Icon name="close" /></button>
      </div>
      <nav className="side-nav" aria-label="Pages">
        <NewButtons onCreate={create} onCreateProject={createProject} />
        <details>
          <summary><Icon name="search" />Search</summary>
          <div>
            <input type="search" aria-label="Search titles and messages" placeholder="Search titles and messages" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }} />
          </div>
        </details>
        <a href={href({ page: "notifications", userId: user.id })} aria-current={route.page === "notifications" ? "page" : undefined} data-nav="notifications">
          <Icon name="bell" />Notifications{ctx.waiting > 0 && <span className="count" aria-label={`${ctx.waiting} waiting`}>{ctx.waiting}</span>}
        </a>
        <a href={href({ page: "memory", userId: user.id })} aria-current={route.page === "memory" ? "page" : undefined}><Icon name="memory" />Memory</a>
        <a href={href({ page: "sleep", userId: user.id })} aria-current={route.page === "sleep" ? "page" : undefined} data-nav="sleep">
          <Icon name="moon" />Sleep{ctx.sleep.fresh > 0 ? <span className="count" aria-label={`${ctx.sleep.fresh} new`}>{ctx.sleep.fresh}</span>
            : ctx.sleep.running && <span className="busy" title="Sleeping"><span className="sr-only">Sleeping</span></span>}
        </a>
        <a href={href({ page: "models", userId: user.id })} aria-current={route.page === "models" ? "page" : undefined} data-nav="models">
          <Icon name="models" />Models{ctx.cleanup.count > 0 && <span className="count" aria-label={`${ctx.cleanup.count} to clean up`}>{ctx.cleanup.count}</span>}
        </a>
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
            <label title="Hidden threads are left out of the list and of search."><input type="checkbox" checked={me.display.showHidden} onChange={(e) => setDisplay({ showHidden: e.target.checked })} /> Hidden</label>
            <hr className="menu-sep" />
            <div className="rg" role="radiogroup" aria-label="Projects">
              {PROJECT_FILTERS.map((f) => (
                <label key={f.projects}><input type="radio" name="tprojects" checked={projects === f.projects} onChange={() => setDisplay({ projects: f.projects })} /> {f.label}</label>
              ))}
            </div>
          </div>
        </details>
      </div>
      <ErrorText error={actionError || error || search.error || moreError} />
      <ul className="threads" aria-label="Threads" {...listMenu.handlers}>
        {hits ? (
          <SearchGroups hits={hits.hits} titled={titled} threads={threads} userId={user.id} current={current} menu={menu.handlers} onOpen={openHit}
            more={hits.more ? () => void moreRun(search.more) : undefined} />
        ) : shown.map((s) => (
          <li key={s.label} className="group-rows">
            {(shown.length > 1 || sort === "groups" || s.label === "Pinned") && <span className="eyebrow">{s.label}{s.count !== undefined && <span className="num">{s.count}</span>}</span>}
            <ul className="threads-in">
              {s.threads.map((t) => <ThreadRow key={`${t.pool}/${t.id}`} t={t} userId={user.id} current={current} menu={menu.handlers} openBeside={openBeside} onRename={rename} />)}
            </ul>
          </li>
        ))}
        {!threads.length && !error && <li className="muted empty">No threads yet.</li>}
        {nothing && <li className="muted empty">Nothing matches.</li>}
      </ul>
      {menu.at && (
        <ThreadMenu at={menu.at} userId={user.id} route={route} groups={ctx.groups} onGroups={ctx.refreshGroups} onChange={ctx.refreshThreads} onToast={ctx.toast} onOpenBeside={openBeside} onClose={menu.close} />
      )}
      {listMenu.at && <ListMenu at={listMenu.at} ctx={ctx} onClose={listMenu.close} />}
      <div className="side-foot">
        <SideStatus page={ctx.models.page} checkedAt={checkedAt} />
        <UserMenu ctx={ctx} users={users} onAuthChange={onAuthChange} />
      </div>
      <Divider label="Sidebar width" edge="right" min={SIDE_MIN} max={SIDE_MAX} width={sideWidth} resize={resizeSide} />
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
  const canHover = useCanHover();
  // On a device that can hover New project opens beside its item instead of replacing the menu (docs/ux.md §3).
  const fly = canHover && sub === "project";
  const hover = useFlyout(sub, setSub, canHover && (sub === "" || !!fly));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - r.height - 8))}px`;
    // With the flyout open focus stays put: a pointer opened it, or → moved into it.
    if (!fly) el.querySelector("button")?.focus();
  }, [at, sub]);
  useEffect(() => {
    // Closing a flyout from the keyboard puts focus back on its item.
    const back = () => { const open = fly; setSub(""); if (open) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-submenu="${sub}"]`)?.focus()); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (sub) back(); else onClose(); return; }
      // → opens the item's flyout, ← closes one level.
      const focus = document.activeElement as HTMLElement | null;
      if (e.key === "ArrowRight" && focus?.dataset.submenu) {
        e.preventDefault(); setSub(focus.dataset.submenu as typeof sub);
        requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".flyout button")?.focus());
        return;
      }
      if (e.key === "ArrowLeft" && sub) { e.preventDefault(); back(); return; }
      if (e.target instanceof HTMLInputElement) return;
      // Letters and arrows act inside the open flyout when focus is there, else in the menu itself.
      const scope = (focus?.closest(".flyout") as HTMLElement | null) ?? ref.current;
      if (menuArrows(e, scope)) return;
      const btn = scope?.querySelector<HTMLButtonElement>(`button[data-key="${e.key.toUpperCase()}"]`);
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
  // The submenu contents, shared by the in-place replacement and the flyout.
  const projectItems = (
    <>
      <button type="button" role="menuitem" data-key="G" onClick={() => create("general")}><span>General</span><kbd>G</kbd></button>
      <button type="button" role="menuitem" data-key="P" onClick={() => create("private")}><span>Private</span><kbd>P</kbd></button>
    </>
  );
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label="Thread list menu" style={{ left: at.x, top: at.y }} {...hover}>
      {sub === "group" ? (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void addGroup(); }}>
          <input autoFocus aria-label="Group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="primary sm" disabled={!name.trim()}>Add</button>
        </form>
      ) : sub === "project" && !fly ? (
        <><button type="button" className="back" onClick={() => setSub("")}>‹ New project in</button>{projectItems}</>
      ) : (
        <>
          <button type="button" role="menuitem" className="has-sub" data-key="P" data-submenu="project" aria-expanded={!!fly} onClick={() => setSub("project")}><span>New project</span><kbd>P</kbd></button>
          <button type="button" role="menuitem" data-key="G" onClick={() => setSub("group")}><span>New group…</span><kbd>G</kbd></button>
        </>
      )}
      <ErrorText error={error} />
      {fly && <Flyout parentRef={ref} anchor="project">{projectItems}</Flyout>}
    </div>
  );
}

/** New thread and New project at the top of the sidebar: one row style each, and only one General / Private choice open at a time (docs/ux.md §3). */
function NewButtons({ onCreate, onCreateProject }: { onCreate: (pool: Pool) => void; onCreateProject: (pool: Pool) => void }) {
  const [open, setOpen] = useState<"" | "thread" | "project">("");
  return (
    <>
      <NewRow shown={open === "thread"} onShow={(on) => setOpen(on ? "thread" : "")} icon="plus" label="New thread" onCreate={onCreate} />
      <NewRow shown={open === "project"} onShow={(on) => setOpen(on ? "project" : "")} icon="project" label="New project" onCreate={onCreateProject} />
    </>
  );
}

/** A row that stays put, with its General / Private choice under it while open, so the choice reads as this row's.
 * Clicking the row again or pressing Escape closes it (docs/ux.md §3), and focus goes back to the row. */
function NewRow({ shown, onShow, icon, label, onCreate }: { shown: boolean; onShow: (on: boolean) => void; icon: "plus" | "project"; label: string; onCreate: (pool: Pool) => void }) {
  const row = useRef<HTMLButtonElement>(null);
  const esc = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || !shown) return;
    e.preventDefault();
    onShow(false);
    row.current?.focus();
  };
  return (
    <>
      <button ref={row} type="button" aria-expanded={shown} onClick={() => onShow(!shown)} onKeyDown={esc}><Icon name={icon} />{label}</button>
      {shown && (
        <div className="new-choice" role="group" aria-label={`${label} in`} onKeyDown={esc}>
          <button type="button" className="primary sm" autoFocus onClick={() => { onShow(false); onCreate("general"); }}>General</button>
          <button type="button" className="private sm" onClick={() => { onShow(false); onCreate("private"); }}>Private</button>
        </div>
      )}
    </>
  );
}

export type MenuHandlers = ReturnType<ReturnType<typeof useThreadMenu>["handlers"]>;

function ThreadRow({ t, userId, current, menu, openBeside, onRename }: {
  t: ThreadSummary; userId: string; current: string; menu: (t: ThreadSummary) => MenuHandlers;
  /** Open a child row in the panel beside the open thread; absent below 1180 px or with no thread open. */
  openBeside?: (t: ThreadSummary) => void;
  onRename?: (t: ThreadSummary, title: string) => Promise<unknown>;
}) {
  const key = `${t.pool}/${t.id}`;
  // A project's threads show by default, pinned ones first (pinned from their cards); resolved ones fold under one Resolved row.
  const [open, setOpen] = useState(() => !!t.project || t.children.some((c) => `${c.pool}/${c.id}` === current));
  const [resolvedOpen, setResolvedOpen] = useState(() => t.children.some((c) => c.state === "resolved" && `${c.pool}/${c.id}` === current));
  const children = t.children.filter((c) => c.pinned).concat(t.children.filter((c) => !c.pinned));
  const active = t.project ? children.filter((c) => c.state !== "resolved") : children;
  const resolved = t.project ? children.filter((c) => c.state === "resolved") : [];
  return (
    <li>
      <div className="trow">
        {t.children.length > 0
          ? <button type="button" className="chev" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${t.project ? "the project's threads" : "child threads"}`} onClick={() => setOpen(!open)}><Icon name="right" /></button>
          : <span className="chev" />}
        <ThreadLink t={t} userId={userId} on={current === key} menu={menu} onRename={onRename} />
      </div>
      {open && (
        <ul className="children">
          {active.map((c) => <li key={c.id}><ThreadLink t={c} userId={userId} on={current === `${c.pool}/${c.id}`} menu={menu} child openBeside={openBeside} besideOnClick={current === key} onRename={onRename} /></li>)}
          {resolved.length > 0 && (
            <li>
              <button type="button" className="resolved-row" aria-expanded={resolvedOpen} onClick={() => setResolvedOpen(!resolvedOpen)}>
                <Icon name="right" className="chev-ic" />Resolved <span className="num">{resolved.length}</span>
              </button>
              {resolvedOpen && <ul className="children">{resolved.map((c) => <li key={c.id}><ThreadLink t={c} userId={userId} on={current === `${c.pool}/${c.id}`} menu={menu} child openBeside={openBeside} besideOnClick={current === key} onRename={onRename} /></li>)}</ul>}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function ThreadLink({ t, userId, on, menu, child, openBeside, besideOnClick, onRename }: {
  t: ThreadSummary; userId: string; on: boolean; menu: (t: ThreadSummary) => MenuHandlers; child?: boolean;
  /** Open this row in the panel beside the open thread (Open beside); absent below 1180 px or with no thread open. */
  openBeside?: (t: ThreadSummary) => void;
  /** The open thread is this row's parent: a plain click opens the row beside it too, replacing what the panel shows. */
  besideOnClick?: boolean;
  /** A double-click on the title renames the thread in place; absent where it can't be renamed. */
  onRename?: (t: ThreadSummary, title: string) => Promise<unknown>;
}) {
  const [renaming, setRenaming] = useState(false);
  // A project's thread: its state as a word, then its unseen updates. Otherwise at most two badges,
  // most pressing first (ux.md §5): waiting on her, then new updates, then hidden.
  const inProject = t.state !== undefined;
  const badges = [
    t.question ? <span key="q" className="tstate" data-state="needsYou">Waiting on you</span> : inProject ? <span key="s" className="tstate" data-state={t.needsYou ? "needsYou" : t.state}>{stateWord(t)}</span> : t.status === "waiting" && <span key="w" className="flag">waiting</span>,
    !!t.unseen && <span key="u" className="count" aria-label={`${t.unseen} new ${t.unseen === 1 ? "update" : "updates"}`}>{t.unseen}</span>,
    t.hidden && <span key="h" className="flag">hidden</span>,
  ].filter(Boolean).slice(0, 2);
  // A project row: the project icon in the pool dot's place, amber when one of its threads waits on her.
  const waiting = t.project && t.children.some((c) => c.state === "waiting");
  const handlers = menu(t);
  // Shift+click and Shift+Enter on a child row open it beside the conversation (Open beside). Below 1180 px, or with no thread open, they navigate itself: without preventDefault the browser would open a new window.
  const shiftTo = (e: React.MouseEvent | React.KeyboardEvent): boolean => {
    if (!child || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
    e.preventDefault();
    if (openBeside) openBeside(t); else go({ page: "thread", userId, pool: t.pool, threadId: t.id });
    return true;
  };
  // With its parent open, a plain click opens a child beside it rather than leaving the parent (docs/ux.md §6).
  const click = (e: React.MouseEvent) => {
    if (shiftTo(e)) return;
    handlers.onClick(e);
    if (e.defaultPrevented || !besideOnClick || !openBeside || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    openBeside(t);
  };
  const title = t.title || (t.project ? "New project" : "New thread");
  // A thread at work pulses its pool dot or lock (steady with reduced motion); a project thread's word says so too.
  const working = t.busy || t.state === "working";
  return (
    <a className={`thread${t.unread ? " unread" : ""}${t.project ? " project" : ""}${child && inProject ? " dotted" : ""}${working ? " working" : ""}`} href={href({ page: "thread", userId, pool: t.pool, threadId: t.id })} aria-current={on ? "page" : undefined} {...handlers}
      onClick={click} onKeyDown={(e) => { if (e.key === "Enter") shiftTo(e); }}
      onDoubleClick={onRename && !renaming ? (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); setRenaming(true); } : undefined}>
      {t.project ? <span className={`project-mark ${t.pool}`} data-waiting={waiting || undefined}><Icon name="project" />{waiting && <span className="sr-only">a thread waits on you</span>}</span>
        : (!child || inProject) && (t.pool === "private"
          ? <PoolLock />
          : <span className="pool-dot" aria-hidden="true" />)}
      {renaming && onRename
        ? <InlineRename className="title" value={t.title ?? ""} label="Title" onSave={(name) => onRename(t, name)} onDone={() => setRenaming(false)} />
        : <span className="title">{title}</span>}
      <span className="when">
        {badges}
        {!inProject && shortTime(t.updatedAt)}
      </span>
      {t.pool === "private" && <span className="sr-only">private</span>}
      {t.unread && <span className="sr-only">unread</span>}
      {working && !inProject && <span className="sr-only">working</span>}
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

/** The welcome page: the greeting is its heading, the version and build end the header's facts; the message box starts a thread with its first message. */
function Welcome({ ctx }: { ctx: ShellContext }) {
  const now = useNow();
  const date = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const time = clock(now);
  return (
    <main className="main">
      <PageHead ctx={ctx} title={<>{greeting(now.getHours())}, {ctx.user.displayName}.</>}
        facts={<>{date} · <span className="num">{time}</span> · <span className="ver num" title={`Version ${ctx.build.version}, build ${ctx.build.build}`}>{ctx.build.version} · {ctx.build.build}</span></>} />
      <div className="scroll">
        <div className="welcome">
          <HomeBox ctx={ctx} />
          <div className="cards">
            <SleepCard ctx={ctx} />
            <NotificationsCard ctx={ctx} />
            <BackendCard ctx={ctx} />
          </div>
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
  const [problem, setProblem] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const threads = useRef<Partial<Record<Pool, Promise<ThreadSummary>>>>({});
  const texts = useRef<Record<Pool, string>>({ general: "", private: "" });
  const files = useRef<Record<Pool, { file: File; path?: string }[]>>({ general: [], private: [] });
  type Tools = Partial<Pick<ThreadSettings, "webSearch" | "images">> & { internet?: boolean };
  const [changes, setChanges] = useState<Partial<Record<Pool, Tools>>>({});
  const defaults = useLoad(async () => ({ pool, value: await get<ThreadSettings>(`${u(userId, "thread-defaults")}?pool=${pool}`) }), [userId, pool]);
  const value = defaults.data?.pool === pool ? defaults.data.value : undefined;
  const settings = value ? { ...value, ...changes[pool], network: { ...value.network, internet: changes[pool]?.internet ?? value.network.internet } } : undefined;
  const ensure = (p: Pool) => {
    if (!threads.current[p]) {
      threads.current[p] = post<ThreadSummary>(u(userId, "threads"), { pool: p }).then((t) => { ctx.refreshThreads(); return t; }, (e) => { delete threads.current[p]; throw e; });
    }
    return threads.current[p]!;
  };
  const change = (c: ThreadSettingsChange) => {
    const tools: Tools = {
      ...(c.webSearch === undefined ? {} : { webSearch: c.webSearch }),
      ...(c.images === undefined ? {} : { images: c.images }),
      ...(typeof c.internet === "boolean" ? { internet: c.internet } : {}),
    };
    setChanges((previous) => ({ ...previous, [pool]: { ...previous[pool], ...tools } }));
  };
  const attach = (picked: Iterable<File>) => {
    for (const file of picked) {
      files.current[pool].push({ file });
      const text = texts.current[pool];
      texts.current[pool] = (text && !text.endsWith("\n") ? `${text}\n` : text) + file.name + "\n";
    }
    setDraft(texts.current[pool]);
  };
  const mic = useDictation({ base: `${u(userId)}?pool=${pool}`, onText: (text) => {
    const el = area.current;
    const at = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? at;
    const before = draft.slice(0, at), after = draft.slice(end);
    const value = before + (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "") + after;
    texts.current[pool] = value;
    setDraft(value);
  }, onError: setProblem });
  const start = () => run(async () => {
    const text = draft.trim();
    if (!text || mic.state !== "idle") return;
    stopReading();
    const t = await ensure(pool);
    const base = threadPath(userId, pool, t.id);
    if (changes[pool]) await patch(`${base}/settings`, changes[pool]);
    const attachments = files.current[pool].slice();
    for (const attachment of attachments) {
      attachment.path ??= (await upload(`${base}/uploads?name=${encodeURIComponent(attachment.file.name)}`, attachment.file, () => {})).path;
    }
    // Replace each filename line once, without rewriting a path from an earlier attachment.
    const message = text.split("\n").map((line) => {
      const at = attachments.findIndex(({ file }) => file.name === line);
      return at < 0 ? line : attachments.splice(at, 1)[0]!.path!;
    }).join("\n");
    await post(`${base}/messages`, { text: message });
    ctx.refreshThreads();
    go({ page: "thread", userId, pool, threadId: t.id });
  });
  const touch = matchMedia("(pointer: coarse)").matches;
  return (
    <form className="home-box" data-has-text={!!draft.trim()} onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <div className="composer-box">
        <textarea ref={area} rows={1} aria-label="Message" placeholder={mic.state === "recording" ? "Listening…" : "Start a new thread…"} value={draft} disabled={busy} onChange={(e) => { texts.current[pool] = e.target.value; setDraft(e.target.value); }}
          onKeyDown={(e) => {
            if (mic.state === "recording" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void mic.stop(); return; }
            if (mic.state !== "idle" && e.key === "Escape") { e.preventDefault(); mic.discard(); return; }
            if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); void start(); }
          }} />
        <button type="submit" className="icon send" aria-label="Send" title="Send" disabled={busy || mic.state !== "idle" || !draft.trim()}><Icon name="up" /></button>
      </div>
      <ComposerRow settings={settings} onSettings={change} onAttach={attach}
        mic={{ state: mic.state, seconds: mic.seconds, speech: settings?.speech, onStart: () => void mic.start(), onStop: () => void mic.stop() }}>
        <div className="seg" role="group" aria-label="Pool">
          {(["general", "private"] as const).map((p) => <button key={p} type="button" className={p === "private" ? "private" : undefined} disabled={busy || mic.state !== "idle"} aria-pressed={pool === p}
            onClick={() => { mic.discard(); setPool(p); setDraft(texts.current[p]); }}>{p === "general" ? "General" : "Private"}</button>)}
        </div>
      </ComposerRow>
      <ErrorText error={defaults.error} />
      <ErrorText error={problem} />
      <ErrorText error={error} />
    </form>
  );
}
