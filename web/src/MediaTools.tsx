// What the Images and Videos grids share (docs/ux.md §6): their Sort, and Auto-name's drawer, where a name for each
// image comes from the thread's "Look at images" model and nothing is renamed until Rename.
import { useEffect, useRef, useState } from "react";
import { post, type AutoName, type FileEntry } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Thumb, type FileLinks } from "./paths.tsx";
import { ErrorText } from "./ui.tsx";

export type MediaSort = "newest" | "oldest" | "name";
export const MEDIA_SORTS: { sort: MediaSort; label: string }[] = [{ sort: "newest", label: "Newest" }, { sort: "oldest", label: "Oldest" }, { sort: "name", label: "Name" }];
const SORT_KEY = "lyrica.media.sort";
const stored = (): MediaSort => {
  try { const v = localStorage.getItem(SORT_KEY); return MEDIA_SORTS.some((o) => o.sort === v) ? v as MediaSort : "newest"; } catch { return "newest"; }
};

/** The grids' Sort, one choice for both tabs, kept in this browser. */
export function useMediaSort(): [MediaSort, (s: MediaSort) => void] {
  const [sort, setSort] = useState<MediaSort>(stored);
  return [sort, (s) => { setSort(s); try { localStorage.setItem(SORT_KEY, s); } catch { /* kept for this visit only */ } }];
}

const time = (e: Pick<FileEntry, "modified">) => { const t = Date.parse(e.modified); return Number.isNaN(t) ? 0 : t; };
/** Entries in the sort's order: by when each was last changed (the newest or oldest first), or by name. */
export function sortMedia<E extends Pick<FileEntry, "name" | "path" | "modified">>(entries: E[], sort: MediaSort): E[] {
  const byName = (a: E, b: E) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path);
  return [...entries].sort(sort === "name" ? byName : (a, b) => (sort === "newest" ? time(b) - time(a) : time(a) - time(b)) || byName(a, b));
}

export function SortSelect({ sort, onSort }: { sort: MediaSort; onSort: (s: MediaSort) => void }) {
  return (
    <select className="media-sort" aria-label="Sort" value={sort} onChange={(e) => onSort(e.target.value as MediaSort)}>
      {MEDIA_SORTS.map((o) => <option key={o.sort} value={o.sort}>{o.label}</option>)}
    </select>
  );
}

export const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * A suggested name that another row in the same folder already has gets -2, -3… (lyricad keeps each free in its
 * folder; the drawer asks for each image on its own, so it keeps them apart from each other).
 */
export function apart(name: string, dir: string, rows: { path: string; draft: string }[]): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const taken = new Set(rows.filter((r) => dirOf(r.path) === dir).map((r) => r.draft.toLowerCase()));
  for (let n = 1; ; n++) { const c = `${stem}${n > 1 ? `-${n}` : ""}${ext}`; if (!taken.has(c.toLowerCase())) return c; }
}

/** Asks in flight at once (daemon/src/auto-name.ts, AUTO_NAME_AT_ONCE). */
const AT_ONCE = 3;

type Row = { path: string; draft: string; state: "waiting" | "named" | "failed" | "renamed"; error?: string };

/**
 * Auto-name: each image's suggested name, asked for a few at a time and shown as it comes, each editable. **Rename**
 * renames those whose name changed; one left as it was, or emptied, stays as it is. Closing stops the asking.
 */
export function AutoNameDrawer({ base, paths, links, onClose, onRenamed }: {
  base: string; paths: string[]; links: FileLinks; onClose: () => void; onRenamed: (moves: { from: string; to: string }[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => paths.map((path) => ({ path, draft: nameOf(path), state: "waiting" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => { live.current = false; removeEventListener("keydown", key); };
  }, [onClose]);
  // Each image on its own ask, a few at once (lyricad's own AUTO_NAME_AT_ONCE), so each name shows as it comes and
  // closing stops the rest.
  useEffect(() => {
    let on = true;
    let next = 0;
    const worker = async () => {
      while (on && next < paths.length) {
        const path = paths[next++]!;
        let got: AutoName | undefined;
        try { [got] = await post<AutoName[]>(`${base}/auto-name`, { paths: [path] }); }
        catch (e) { got = { path, error: (e as Error).message }; }
        if (!on) return;
        setRows((rs) => rs.map((r) => r.path !== path ? r
          : got?.name !== undefined ? { ...r, draft: apart(got.name, dirOf(path), rs.filter((o) => o.path !== path)), state: "named" }
          : { ...r, state: "failed", error: got?.error ?? "no name came back" }));
      }
    };
    for (let i = 0; i < Math.min(AT_ONCE, paths.length); i++) void worker();
    return () => { on = false; };
  }, [base, paths]);
  const naming = rows.filter((r) => r.state === "waiting").length;
  const changes = rows.filter((r) => r.state === "named" && r.draft.trim() && r.draft.trim() !== nameOf(r.path));
  const bad = changes.find((r) => r.draft.includes("/"));
  const rename = async () => {
    setBusy(true); setError("");
    const moves: { from: string; to: string }[] = [];
    for (const r of changes) {
      const to = `${dirOf(r.path)}/${r.draft.trim()}`;
      try {
        await post(`${base}/rename`, { from: r.path, to });
        moves.push({ from: r.path, to });
        if (live.current) setRows((rs) => rs.map((x) => x.path === r.path ? { ...x, state: "renamed" } : x));
      } catch (e) {
        if (live.current) setRows((rs) => rs.map((x) => x.path === r.path ? { ...x, state: "failed", error: (e as Error).message } : x));
      }
    }
    if (moves.length) onRenamed(moves);
    if (!live.current) return;
    setBusy(false);
    if (moves.length === changes.length) onClose();
    else setError("Some couldn't be renamed.");
  };
  return (
    <>
      <aside ref={ref} tabIndex={-1} className="drawer auto-name" aria-labelledby="auto-name-title">
        <div className="drawer-head">
          <h2 id="auto-name-title">Auto-name</h2>
          <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (changes.length && !bad && !busy) void rename(); }}>
          <p className="muted" role="status">{naming ? <>Naming <span className="num">{rows.length - naming}</span> of <span className="num">{rows.length}</span>…</> : <><span className="num">{changes.length}</span> to rename</>}</p>
          <ul className="auto-name-list">
            {rows.map((r) => (
              <li key={r.path}>
                <Thumb path={r.path} alt="" files={links} />
                <span className="auto-name-field">
                  <span className="mono muted" title={r.path}>{nameOf(r.path)}</span>
                  {r.state === "waiting" ? <span className="muted">Looking…</span>
                    : r.state === "failed" ? <span className="error">{r.error}</span>
                    : r.state === "renamed" ? <span className="mono">{r.draft}</span>
                    : <input className="mono" aria-label={`New name for ${nameOf(r.path)}`} value={r.draft} disabled={busy} spellCheck={false}
                      onChange={(e) => { const v = e.target.value; setRows((rs) => rs.map((x) => x.path === r.path ? { ...x, draft: v } : x)); }} />}
                </span>
              </li>
            ))}
          </ul>
          <ErrorText error={bad ? "A name can't contain /" : error} />
          <div className="row drawer-foot">
            <button type="submit" className="primary" disabled={busy || !changes.length || !!bad}>Rename{changes.length ? <> <span className="num">{changes.length}</span></> : null}</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </aside>
      <div className="scrim drawer-scrim" aria-hidden="true" onClick={onClose} />
    </>
  );
}
