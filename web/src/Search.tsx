// The sidebar's Search (docs/web.md "Sidebar"): titles match in the browser as
// they are typed, and 300 ms later lyricad's message hits (GET …/search) turn
// the list into one group per thread, its row then its hits.
import { useCallback, useEffect, useState } from "react";
import { get, u, type Display, type Pool, type SearchHit, type SearchResults, type ThreadSummary } from "./api.ts";
import { her } from "./name.ts";
import { href } from "./route.ts";
import { PoolLock, ThreadLink, type MenuHandlers } from "./Shell.tsx";
import { findThread } from "./Thread.tsx";
import { fullTime, shortTime, wakeTime } from "./ui.tsx";

/** lyricad's page of hits. */
const PAGE = 50;
/** Hits shown under a thread before "<n> more in this thread". */
const SHOWN = 3;

/** A query long enough to search messages: 2 characters. */
export const searchable = (q: string) => [...q.trim()].length >= 2;

interface Results { q: string; hits: SearchHit[]; more: boolean }

/**
 * lyricad's hits for `q`, 300 ms after it last changed, and again when the
 * display's pools or Hidden change. Hits for an older query are never shown.
 */
export function useMessageSearch(userId: string, q: string, display: Display) {
  const [results, setResults] = useState<Results>();
  const [error, setError] = useState("");
  const shown = `${display.showGeneral}/${display.showPrivate}/${display.showHidden}`;
  const path = (before?: string) => `${u(userId, "search")}?q=${encodeURIComponent(q)}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  useEffect(() => {
    setError("");
    if (!searchable(q)) { setResults(undefined); return; }
    let current = true;
    const timer = setTimeout(() => {
      get<SearchResults>(path()).then((r) => { if (current) setResults({ q, hits: r.hits, more: r.hits.length >= PAGE }); }, (e: Error) => { if (current) setError(e.message); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, q, shown]);
  const now = results?.q === q ? results : undefined;
  /** Show more: the next page, older than the last hit. */
  const more = useCallback(async () => {
    if (!now) return;
    const r = await get<SearchResults>(path(now.hits.at(-1)?.at));
    setResults((old) => (old?.q === now.q ? { q: old.q, hits: [...old.hits, ...r.hits], more: r.hits.length >= PAGE } : old));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  return { results: now, error, more };
}

interface Group { pool: Pool; threadId: string; title?: string; hits: SearchHit[] }

/** The hits as one group per thread, in the order of each thread's first hit. */
function groups(hits: SearchHit[]): Group[] {
  const out = new Map<string, Group>();
  for (const h of hits) {
    const key = `${h.pool}/${h.threadId}`;
    const g = out.get(key) ?? { pool: h.pool, threadId: h.threadId, ...(h.title ? { title: h.title } : {}), hits: [] };
    g.hits.push(h);
    out.set(key, g);
  }
  return [...out.values()];
}

/**
 * The result groups: each thread with hits, its row as the list draws it and
 * then up to three hits, and after them the threads whose title matched but
 * no message did. `onOpen` runs as a hit's link is followed.
 */
export function SearchGroups({ hits, titled, threads, userId, current, menu, onOpen, more }: {
  hits: SearchHit[]; titled: ThreadSummary[]; threads: ThreadSummary[]; userId: string; current: string;
  menu: (t: ThreadSummary) => MenuHandlers; onOpen: (h: SearchHit) => void; more?: () => void;
}) {
  const found = groups(hits);
  const rest = titled.filter((t) => !found.some((g) => g.pool === t.pool && g.threadId === t.id));
  return (
    <>
      {found.map((g) => <HitGroup key={`${g.pool}/${g.threadId}`} g={g} t={findThread(threads, g.pool, g.threadId)} userId={userId} current={current} menu={menu} onOpen={onOpen} />)}
      {rest.map((t) => (
        <li key={`${t.pool}/${t.id}`} className="hit-group">
          <ThreadLink t={t} userId={userId} on={current === `${t.pool}/${t.id}`} menu={menu} />
        </li>
      ))}
      {more && <li className="hits-more"><button type="button" className="link sm" onClick={more}>Show more</button></li>}
    </>
  );
}

function HitGroup({ g, t, userId, current, menu, onOpen }: {
  g: Group; t?: ThreadSummary; userId: string; current: string; menu: (t: ThreadSummary) => MenuHandlers; onOpen: (h: SearchHit) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? g.hits : g.hits.slice(0, SHOWN);
  const left = g.hits.length - shown.length;
  const to = href({ page: "thread", userId, pool: g.pool, threadId: g.threadId });
  const title = t?.title || g.title || "New thread";
  return (
    <li className="hit-group">
      {t ? <ThreadLink t={t} userId={userId} on={current === `${g.pool}/${g.threadId}`} menu={menu} /> : (
        // Not in the list as it is shown (the Sort menu's projects choice): the row from the hit.
        <a className="thread" href={to} aria-current={current === `${g.pool}/${g.threadId}` ? "page" : undefined}>
          {g.pool === "private" ? <PoolLock /> : <span className="pool-dot" aria-hidden="true" />}
          <span className="title">{title}</span>
          <span className="when">{shortTime(g.hits[0]!.at)}</span>
          {g.pool === "private" && <span className="sr-only">private</span>}
        </a>
      )}
      <ul className="hits" aria-label={`Messages in ${title}`}>
        {shown.map((h) => (
          <li key={h.n}>
            <a className="hit" href={to} onClick={() => onOpen(h)}>
              <span className="by">{h.who === "you" ? "you" : h.who === "agent" ? her() : h.who}</span>
              <span className="snip">{marked(h)}</span>
              <time className="when" dateTime={h.at} title={fullTime(h.at)}>{wakeTime(h.at)}</time>
            </a>
          </li>
        ))}
        {left > 0 && (
          <li><button type="button" className="link sm more-hits" onClick={() => setOpen(true)}><span className="num">{left}</span> more in this thread</button></li>
        )}
      </ul>
    </li>
  );
}

/**
 * The snippet with its matches marked. A hit is at most two narrow lines, so a
 * match past the first few words starts the text one word before it, after "…".
 */
function marked(h: SearchHit): React.ReactNode[] {
  const s = h.snippet;
  const first = h.marks[0]?.[0] ?? 0;
  const space = first > 12 ? s.lastIndexOf(" ", first - 2) : -1;
  const from = first > 12 ? (space > 0 ? space + 1 : first) : 0;
  const out: React.ReactNode[] = from > 0 ? ["…"] : [];
  let at = from;
  for (const [a, b] of h.marks) {
    if (b <= at) continue;
    const start = Math.max(a, at);
    if (start > at) out.push(s.slice(at, start));
    out.push(<mark key={a}>{s.slice(start, b)}</mark>);
    at = b;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}
