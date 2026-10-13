// Principle 6: bounded previews and one shared search/paging surface for review.
import { useEffect, useState, type ReactNode } from "react";
import { get, type HistoryPage as Page } from "./api.ts";
import { href, type Route } from "./route.ts";
import { ErrorText, useLoad } from "./ui.tsx";

export function HistoryHead({ to }: { to: Route }) {
  return <div className="section-head"><h3 className="eyebrow">History</h3><a href={href(to)}>Show all</a></div>;
}

/** Existing fields, secondary buttons and rows; data stays in React state. */
export function HistoryList<T, P extends Page<T> = Page<T>>({ path, render }: { path: string; render: (page: P, reload: () => void) => ReactNode }) {
  const [search, setSearch] = useState("");
  const [q, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const size = 20;
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search, q]);
  const data = useLoad(() => get<P>(`${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ limit: String(size), offset: String((page - 1) * size), q })}`), [path, page, q]);
  const pages = Math.max(1, Math.ceil((data.data?.total ?? 0) / size));
  useEffect(() => { if (data.data && page > pages) setPage(pages); }, [data.data, page, pages]);
  // Bound the control row as well as the entries, even with years of history.
  const numbers = [...new Set([1, ...Array.from({ length: 5 }, (_, i) => page - 2 + i).filter((n) => n > 0 && n <= pages), pages])].sort((a, b) => a - b);
  return <div className="stack">
    <label className="field"><span>Search</span><input type="search" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} /></label>
    <ErrorText error={data.error} />
    {data.data && (data.data.entries.length ? render(data.data, data.reload) : <p className="empty">Nothing matches.</p>)}
    {data.data && <nav className="row wrap" aria-label="Pages">
      <span className="num">Page {page} of {pages}</span>
      {numbers.map((n) => <button type="button" className="sm num" key={n} aria-label={`Page ${n}`} aria-current={page === n ? "page" : undefined} disabled={page === n} onClick={() => setPage(n)}>{n}</button>)}
    </nav>}
  </div>;
}
