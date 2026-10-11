// Hash routes, so lyricad serves one file and needs no fallback.
import { useEffect, useState } from "react";
import type { Pool } from "./api.ts";

export type Route =
  | { page: "home"; userId?: string }
  | { page: "login" }
  | { page: "thread"; userId: string; pool: Pool; threadId: string }
  | { page: "memory"; userId: string; pool?: Pool; id?: string }
  | { page: "settings"; userId: string; section?: string }
  | { page: "admin"; userId: string; section?: string };

export function parse(hash: string): Route {
  const [, ...parts] = hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  const [first, userId, section, a, b, ...more] = parts;
  if (first === "login") return { page: "login" };
  if (first !== "u" || !userId) return { page: "home" };
  const pool = a === "general" || a === "private" ? a : undefined;
  if (section === "t" && pool && b) return { page: "thread", userId, pool, threadId: b };
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
    case "thread": return `#/u/${e(r.userId)}/t/${r.pool}/${e(r.threadId)}`;
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
