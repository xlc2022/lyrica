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
  /** A project's settings page, with its section. */
  | { page: "project"; userId: string; pool: Pool; threadId: string; section?: string }
  | { page: "memory"; userId: string; pool?: Pool; id?: string }
  | { page: "settings"; userId: string; section?: string }
  | { page: "admin"; userId: string; section?: string };

/** What the panel can show: a thread (with its drawer) or a project's settings. */
export type Panel =
  | { page: "thread"; pool: Pool; threadId: string; drawer?: true }
  | { page: "project"; pool: Pool; threadId: string; section?: string };

/** The panel's own page, as a route of its own. */
export const panelRoute = (userId: string, p: Panel): Route => ({ ...p, userId });

export function parse(hash: string): Route {
  const [, ...parts] = hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  const [first, userId, section, a, b, ...more] = parts;
  const c = more[0];
  if (first === "login") return { page: "login" };
  if (first !== "u" || !userId) return { page: "home" };
  const pool = a === "general" || a === "private" ? a : undefined;
  if (section === "t" && pool && b) {
    const drawer = c === "settings";
    const at = more.indexOf("panel");
    const inner = at >= 0 ? parse(`#/u/${encodeURIComponent(userId)}/${more.slice(at + 1).map(encodeURIComponent).join("/")}`) : undefined;
    const panel: Panel | undefined = inner?.page === "thread" ? { page: "thread", pool: inner.pool, threadId: inner.threadId, ...(inner.drawer ? { drawer: true as const } : {}) }
      : inner?.page === "project" ? { page: "project", pool: inner.pool, threadId: inner.threadId, ...(inner.section ? { section: inner.section } : {}) }
      : undefined;
    return { page: "thread", userId, pool, threadId: b, ...(drawer ? { drawer: true as const } : {}), ...(panel ? { panel } : {}) };
  }
  if (section === "p" && pool && b) return { page: "project", userId, pool, threadId: b, ...(c ? { section: c } : {}) };
  if (section === "memory") return { page: "memory", userId, pool, id: pool ? b : undefined };
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
    case "project": return `#/u/${e(r.userId)}/p/${r.pool}/${e(r.threadId)}` + (r.section ? `/${e(r.section)}` : "");
    case "memory": return `#/u/${e(r.userId)}/memory` + (r.pool && r.id ? `/${r.pool}/${e(r.id)}` : "");
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

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
