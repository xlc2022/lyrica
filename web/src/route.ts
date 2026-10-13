// Hash routes, so lyricad serves one file and needs no fallback.
import { useEffect, useState } from "react";
import type { Pool } from "./api.ts";

export type Route =
  | { page: "home"; userId?: string }
  | { page: "login" }
  /**
   * `drawer`: opened with its settings drawer showing (`…/t/<pool>/<thread>/settings`).
   * `panel`: what the right panel shows beside the conversation (`…/panel/<its path>`);
   * below the split width the same address is that page on its own.
   */
  | { page: "thread"; userId: string; pool: Pool; threadId: string; drawer?: true; panel?: Panel }
  /** A thread's Files panel on its own (`…/t/<pool>/<thread>/files`), as it is below the split width; `path` is a file to show (`/files/<encoded path>`). */
  | { page: "files"; userId: string; pool: Pool; threadId: string; path?: string }
  /** A project's settings page, with its section. */
  | { page: "project"; userId: string; pool: Pool; threadId: string; section?: string }
  /** A project's threads list (`…/t/<pool>/<thread>/threads`): what the panel shows beside its chat, and this page on its own below the split width. */
  | { page: "threads"; userId: string; pool: Pool; threadId: string }
  | { page: "memory"; userId: string; pool?: Pool; id?: string }
  | { page: "sleep"; userId: string }
  | { page: "notifications"; userId: string }
  /**
   * The Models area, at one of its tabs (Overview when none). `add` is a page under its tab: "host" is Add model host
   * under Hosts and endpoints (`…/hosts/add-host`), "text" is Download text model under Downloads (`…/downloads/text`),
   * "image" Download image model (`…/images/download`) and "review" To review (`…/images/review`) under Image models.
   */
  | { page: "models"; userId: string; tab?: ModelsTab; add?: ModelsPageUnder; project?: string; pool?: Pool }
  | { page: "settings"; userId: string; section?: string }
  | { page: "admin"; userId: string; section?: string };

export const MODELS_TABS = ["overview", "tasks", "text", "images", "hosts", "downloads", "cleanup", "calls"] as const;
export type ModelsTab = (typeof MODELS_TABS)[number];
export type ModelsPageUnder = "host" | "text" | "image" | "review";
/** Each page under a tab, by the tab and the address's last part. */
const UNDER: { tab: ModelsTab; part: string; add: ModelsPageUnder }[] = [
  { tab: "hosts", part: "add-host", add: "host" },
  { tab: "downloads", part: "text", add: "text" },
  { tab: "images", part: "download", add: "image" },
  { tab: "images", part: "review", add: "review" },
];

/** What the panel can show: a thread (with its drawer), a thread's files, a project's settings or threads list, or a memory. */
export type Panel =
  | { page: "thread"; pool: Pool; threadId: string; drawer?: true }
  | { page: "files"; pool: Pool; threadId: string; path?: string }
  | { page: "project"; pool: Pool; threadId: string; section?: string }
  | { page: "threads"; pool: Pool; threadId: string }
  | { page: "memory"; pool: Pool; id: string };

/** The panel's own page, as a route of its own. */
export const panelRoute = (userId: string, p: Panel): Route => ({ ...p, userId });

export function parse(hash: string): Route {
  const [path, query = ""] = hash.split("?");
  const params = new URLSearchParams(query);
  const [, ...parts] = path!.replace(/^#/, "").split("/").map(decodeURIComponent);
  const [first, userId, section, a, b, ...more] = parts;
  const c = more[0];
  if (first === "login") return { page: "login" };
  if (first !== "u" || !userId) return { page: "home" };
  const pool = a === "general" || a === "private" ? a : undefined;
  if (section === "t" && pool && b) {
    const drawer = c === "settings";
    const at = more.indexOf("panel");
    const inner = at >= 0 ? parse(`#/u/${encodeURIComponent(userId)}/${more.slice(at + 1).map(encodeURIComponent).join("/")}`) : undefined;
    if (c === "files") return { page: "files", userId, pool, threadId: b, ...(more[1] ? { path: more[1] } : {}) };
    if (c === "threads") return { page: "threads", userId, pool, threadId: b };
    const panel: Panel | undefined = inner?.page === "thread" ? { page: "thread", pool: inner.pool, threadId: inner.threadId, ...(inner.drawer ? { drawer: true as const } : {}) }
      : inner?.page === "files" ? { page: "files", pool: inner.pool, threadId: inner.threadId, ...(inner.path ? { path: inner.path } : {}) }
      : inner?.page === "project" ? { page: "project", pool: inner.pool, threadId: inner.threadId, ...(inner.section ? { section: inner.section } : {}) }
      : inner?.page === "threads" ? { page: "threads", pool: inner.pool, threadId: inner.threadId }
      : inner?.page === "memory" && inner.pool && inner.id ? { page: "memory", pool: inner.pool, id: inner.id }
      : undefined;
    return { page: "thread", userId, pool, threadId: b, ...(drawer ? { drawer: true as const } : {}), ...(panel ? { panel } : {}) };
  }
  if (section === "p" && pool && b) return { page: "project", userId, pool, threadId: b, ...(c ? { section: c } : {}) };
  if (section === "memory") return { page: "memory", userId, pool, id: pool ? b : undefined };
  if (section === "sleep") return { page: "sleep", userId };
  if (section === "notifications") return { page: "notifications", userId };
  if (section === "models") {
    const tab = MODELS_TABS.find((t) => t === a);
    const add = UNDER.find((x) => x.tab === tab && x.part === b)?.add;
    return { page: "models", userId, ...(tab && tab !== "overview" ? { tab } : {}), ...(add ? { add } : {}), ...(tab === "calls" && params.get("project") ? { project: params.get("project")!, pool: params.get("pool") === "private" ? "private" as const : "general" as const } : {}) };
  }
  // Settings → Endpoints moved to Models → Hosts and endpoints, and Settings → Model presets to Models → Tasks.
  if (section === "settings" && a === "endpoints") return { page: "models", userId, tab: "hosts" };
  if (section === "settings" && a === "profiles") return { page: "models", userId, tab: "tasks" };
  // A section may have pages of its own under it (settings/machines/new): the rest of the path rides along.
  const rest = [a, b, ...more].filter((x): x is string => x !== undefined).join("/");
  if (section === "settings") return { page: "settings", userId, ...(rest ? { section: rest } : {}) };
  if (section === "admin") return { page: "admin", userId, ...(rest ? { section: rest } : {}) };
  // The control panel became Settings and Administration.
  if (section === "panel") return { page: "settings", userId };
  return { page: "home", userId };
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.page) {
    case "home": return r.userId ? `#/u/${e(r.userId)}` : "#/";
    case "login": return "#/login";
    case "thread": {
      const own = `#/u/${e(r.userId)}/t/${r.pool}/${e(r.threadId)}` + (r.drawer ? "/settings" : "");
      return r.panel ? `${own}/panel/${href(panelRoute(r.userId, r.panel)).split("/").slice(3).join("/")}` : own;
    }
    case "files": return `#/u/${e(r.userId)}/t/${r.pool}/${e(r.threadId)}/files` + (r.path ? `/${e(r.path)}` : "");
    case "project": return `#/u/${e(r.userId)}/p/${r.pool}/${e(r.threadId)}` + (r.section ? `/${e(r.section)}` : "");
    case "threads": return `#/u/${e(r.userId)}/t/${r.pool}/${e(r.threadId)}/threads`;
    case "memory": return `#/u/${e(r.userId)}/memory` + (r.pool && r.id ? `/${r.pool}/${e(r.id)}` : "");
    case "sleep": return `#/u/${e(r.userId)}/sleep`;
    case "notifications": return `#/u/${e(r.userId)}/notifications`;
    case "models": {
      const under = UNDER.find((x) => x.tab === r.tab && x.add === r.add);
      return `#/u/${e(r.userId)}/models` + (r.tab && r.tab !== "overview" ? `/${r.tab}` : "") + (under ? `/${under.part}` : "") + (r.tab === "calls" && r.project ? `?project=${e(r.project)}&pool=${r.pool ?? "general"}` : "");
    }
    case "settings": return `#/u/${e(r.userId)}/settings` + (r.section ? `/${r.section.split("/").map(e).join("/")}` : "");
    case "admin": return `#/u/${e(r.userId)}/admin` + (r.section ? `/${r.section.split("/").map(e).join("/")}` : "");
  }
}

/**
 * Where a cited ID leads: a thread or one of its messages opens the thread,
 * anything else the memory. An ID in the other pool carries it: `general/n:12`.
 */
export function idHref(userId: string, pool: Pool, id: string): string {
  const [, other, bare = id] = /^(?:(general|private)\/)?(.*)$/s.exec(id) ?? [];
  const p = (other as Pool | undefined) ?? pool;
  const thread = /^[te]:([^#]+)/.exec(bare)?.[1];
  return thread ? href({ page: "thread", userId, pool: p, threadId: thread }) : href({ page: "memory", userId, pool: p, id: bare });
}

export const go = (r: Route) => { location.hash = href(r); };

/** The route at the current address; an address that moved is replaced by its new one (settings/endpoints, settings/profiles). */
function current(): Route {
  const r = parse(location.hash);
  if (r.page === "models" && !location.hash.includes("/models")) history.replaceState(null, "", href(r));
  return r;
}

/** The address before the last move inside the app ("" when the page was opened at its own address): a page's way back. */
let previous = "";
export const cameFrom = () => previous;

export function useRoute(): Route {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const on = (e: HashChangeEvent) => { previous = new URL(e.oldURL).hash; setRoute(current()); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
