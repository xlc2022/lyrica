// Principle 6: bounded previews and one shared search/paging surface for review.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { get, type HistoryPage as Page } from "./api.ts";
import { href, type Route } from "./route.ts";
import { ErrorText, useLoad } from "./ui.tsx";

/** The eyebrow and its link; the link is hidden when there is nothing more to open (one entry or fewer). */
export function HistoryHead({ to, count }: { to: Route; count?: number }) {
  return <div className="section-head"><h3 className="eyebrow">History</h3>{(count === undefined || count > 1) && <a href={href(to)}>Show all</a>}</div>;
}

/**
 * Existing fields, secondary buttons and rows; data stays in React state.
 * `route` carries the search text and page number in the address: committed changes replace the entry
 * (no new history), so Back leaves this page for good and returns to it with the same search and page.
 */
export function HistoryList<T, P extends Page<T> = Page<T>>({ path, render, route }: { path: string; render: (page: P, reload: () => void) => ReactNode; route?: Extract<Route, { page: "history" | "models" }> }) {
  const [search, setSearch] = useState(route?.q ?? "");
  const [q, setQuery] = useState(route?.q ?? "");
  const [page, setPage] = useState(route?.at ?? 1);
  const size = 20;
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search, q]);
  const data = useLoad(() => get<P>(`${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ limit: String(size), offset: String((page - 1) * size), q })}`), [path, page, q]);
  const pages = Math.max(1, Math.ceil((data.data?.total ?? 0) / size));
  useEffect(() => { if (data.data && page > pages) setPage(pages); }, [data.data, page, pages]);
  useEffect(() => { if (route) history.replaceState(null, "", href({ ...route, q, at: page })); }, [route, q, page]);
  // Bound the control row as well as the entries, even with years of history.
  const numbers = [...new Set([1, ...Array.from({ length: 5 }, (_, i) => page - 2 + i).filter((n) => n > 0 && n <= pages), pages])].sort((a, b) => a - b);
  return <div className="stack">
    <label className="field"><span>Search</span><input type="search" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} /></label>
    <ErrorText error={data.error} />
    {data.data && (data.data.entries.length ? render(data.data, data.reload) : <p className="empty">Nothing matches.</p>)}
    {data.data && <nav className="row wrap pages" aria-label="Pages">
      <span>Page <span className="num">{page}</span> of <span className="num">{pages}</span></span>
      {numbers.map((n, i) => { const prev = numbers[i - 1]; return <Fragment key={n}>
        {prev !== undefined && n > prev + 1 && <span className="muted gap" aria-hidden="true">…</span>}
        <button type="button" className="sm num" aria-label={`Page ${n}`} aria-current={page === n ? "page" : undefined} onClick={() => setPage(n)}>{n}</button>
      </Fragment>; })}
    </nav>}
  </div>;
}
