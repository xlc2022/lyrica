// Mention tokens in memory text. Reading shows current names and pronouns
// (core's render); editing shows `[[Name]]` and `[[Name:obj]]`, which go back
// to `[[u:ID]]` tokens on save, so a later rename still applies.
import { useEffect, useState } from "react";
import { get, HttpError, threadPath, type Pool, type ThreadSummary, type UserMap } from "./api.ts";
import { render, THREAD_MENTION } from "../../core/src/mentions.ts";
import { href } from "./route.ts";

export function readable(text: string, users: UserMap): string {
  return render(text, (id) => (users[id] ? { ...users[id], previousNames: [] } : undefined));
}

const STORED = /\[\[u:([A-Za-z0-9-]+)(:[a-z-]+)?\]\]/g;
const EDITABLE = /\[\[([^\]:[]+)(:[a-z-]+)?\]\]/g;

export function toEditable(text: string, users: UserMap): string {
  return text.replace(STORED, (token, id: string, form = "") => (users[id] ? `[[${users[id].displayName}${form}]]` : token));
}

export function fromEditable(text: string, users: UserMap): string {
  const byName = new Map(Object.entries(users).map(([id, x]) => [x.displayName, id]));
  return text.replace(EDITABLE, (whole, name: string, form = "") => {
    const id = byName.get(name.trim());
    return id ? `[[u:${id}${form}]]` : whole;
  });
}

// Thread mentions in her text, `[t:<id>]` or `[e:<id>#<n>]` (`general/` for
// the other pool): each shows as the thread's current title, linked to it,
// or "a forgotten thread" once it is gone. Titles are fetched once per thread
// and kept briefly, so a rename shows on the next look.

const TITLES = new Map<string, { title: string | null; at: number }>();
/** Fetches under way, with every mention waiting on each, so all of them re-render when the title arrives. */
const PENDING = new Map<string, Set<() => void>>();
const KEEP_MS = 30_000;

/** Fetches the titles of the threads a text mentions; re-renders as they arrive. */
function useMentionTitles(text: string, userId: string, pool: Pool): (pool: Pool, id: string) => string | null | undefined {
  const [, setTick] = useState(0);
  // A general message never resolves a private thread, so those aren't fetched.
  const found = [...text.matchAll(THREAD_MENTION)].map((m) => ({ pool: (m[1] as Pool | undefined) ?? pool, id: m[3]! }))
    .filter((f) => !(pool === "general" && f.pool === "private"));
  const keys = found.map((f) => `${userId}/${f.pool}/${f.id}`);
  useEffect(() => {
    let live = true;
    const tick = () => { if (live) setTick((n) => n + 1); };
    found.forEach((f, i) => {
      const key = keys[i]!;
      const known = TITLES.get(key);
      const pending = PENDING.get(key);
      if (pending) return void pending.add(tick);
      if (known && Date.now() - known.at < KEEP_MS) return;
      PENDING.set(key, new Set([tick]));
      get<ThreadSummary>(threadPath(userId, f.pool, f.id))
        .then((t) => TITLES.set(key, { title: t.title || "an untitled thread", at: Date.now() }))
        .catch((err) => { if (err instanceof HttpError && err.status === 404) TITLES.set(key, { title: null, at: Date.now() }); })
        .finally(() => { const waiting = PENDING.get(key); PENDING.delete(key); waiting?.forEach((w) => w()); });
    });
    return () => { live = false; };
  }, [keys.join(" ")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (p, id) => TITLES.get(`${userId}/${p}/${id}`)?.title;
}

/** Markdown with each mention as a link titled with the thread's current title. */
export function useThreadMentions(text: string, userId: string, pool: Pool): string {
  return linkMentions(text, userId, pool, useMentionTitles(text, userId, pool));
}

/** Plain text with each mention as the thread's current title, where a link can't go (a button, a title). */
export function useMentionText(text: string, userId: string, pool: Pool): string {
  return plainMentions(text, pool, useMentionTitles(text, userId, pool));
}

/** Each mention as its title, unlinked. */
export function plainMentions(text: string, pool: Pool, titleOf: (pool: Pool, id: string) => string | null | undefined): string {
  return text.replace(THREAD_MENTION, (_whole, other: string | undefined, _kind: string, id: string) => {
    const p = (other as Pool | undefined) ?? pool;
    if (pool === "general" && p === "private") return "a forgotten thread";
    const title = titleOf(p, id);
    return title === null ? "a forgotten thread" : title ?? "a thread";
  });
}

/** Each mention as a markdown link with the title (`null`: gone; undefined: not known yet). A general message never shows a private thread. */
export function linkMentions(text: string, userId: string, pool: Pool, titleOf: (pool: Pool, id: string) => string | null | undefined): string {
  return text.replace(THREAD_MENTION, (_whole, other: string | undefined, _kind: string, id: string) => {
    const p = (other as Pool | undefined) ?? pool;
    if (pool === "general" && p === "private") return "a forgotten thread";
    const title = titleOf(p, id);
    if (title === null) return "a forgotten thread";
    return `[${(title ?? "a thread").replace(/[\\[\]]/g, "\\$&")}](${href({ page: "thread", userId, pool: p, threadId: id })})`;
  });
}
