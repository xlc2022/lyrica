// Hash routes, so lyricad serves one file and needs no fallback.
import { useEffect, useState } from "react";
import type { Pool } from "./api.ts";

export type Route =
  | { page: "home"; userId?: string }
  | { page: "login" }
  | { page: "thread"; userId: string; pool: Pool; threadId: string }
  | { page: "memory"; userId: string; pool?: Pool; id?: string }
  | { page: "panel"; userId: string };

export function parse(hash: string): Route {
  const [, ...parts] = hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  const [first, userId, section, a, b] = parts;
  if (first === "login") return { page: "login" };
  if (first !== "u" || !userId) return { page: "home" };
  const pool = a === "general" || a === "private" ? a : undefined;
  if (section === "t" && pool && b) return { page: "thread", userId, pool, threadId: b };
  if (section === "memory") return { page: "memory", userId, pool, id: pool ? b : undefined };
  if (section === "panel") return { page: "panel", userId };
  return { page: "home", userId };
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.page) {
    case "home": return r.userId ? `#/u/${e(r.userId)}` : "#/";
    case "login": return "#/login";
    case "thread": return `#/u/${e(r.userId)}/t/${r.pool}/${e(r.threadId)}`;
    case "memory": return `#/u/${e(r.userId)}/memory` + (r.pool && r.id ? `/${r.pool}/${e(r.id)}` : "");
    case "panel": return `#/u/${e(r.userId)}/panel`;
  }
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
