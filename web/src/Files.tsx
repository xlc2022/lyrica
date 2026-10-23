// The Files panel (DESIGN "Files and images", docs/ux.md §6): a thread's
// folder and its granted folders, one folder at a time, with a search, a
// file opened in the viewer (Viewer.tsx), an Images tab, and every action in a
// right-click menu (a long press on a phone, or the ⋯ beside a file).
// Beside the conversation from the split width; the page on its own below it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, post, threadPath, upload, type FileEntry, type FileListing, type FileRoot, type FileSearch, type ImageEntry, type Pool, type ThreadSummary } from "./api.ts";
import { ask, ATTACH_EVENT, ATTACH_KEY, keep, SHOW_EVENT, SHOW_KEY, type AttachRequest, type ShowRequest } from "./links.ts";
import { isUnderWorkdir, SHARED, shown, Thumb, useFileLinks, WORKDIR, type FileLinks } from "./paths.tsx";
import { Viewer } from "./Viewer.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { go } from "./route.ts";
import { Crumbs, Main, PanelButtons, type ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, InlineRename, menuArrows, useLongPress, useSelection } from "./ui.tsx";

type Tab = "files" | "images";
type Filter = "all" | "uploaded" | "made";

/** What a menu is about: a file, a folder (a root has no parent to rename it in), the selection, or the space under a folder's entries. */
type Target =
  | { kind: "file"; entry: FileEntry }
  | { kind: "folder"; path: string; root: boolean }
  | { kind: "selection"; paths: string[] }
  | { kind: "space"; dir: string };

/** `sub`: the menu opens straight into one of its steps (a row's Delete button opens its confirm). */
interface MenuAt { x: number; y: number; target: Target; sub?: "delete" }

const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
export const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** A path as the panel names it: inside the thread's folder without the prefix, elsewhere as it is. */

/** `path`: a file to show on arrival (a link in the conversation), with its folders opened in the tree. */
export function FilesPage({ ctx, pool, threadId, threads, path }: { ctx: ShellContext; pool: Pool; threadId: string; threads: ThreadSummary[]; path?: string }) {
  const userId = ctx.user.id;
  const thread = threadPath(userId, pool, threadId);
  const base = `${thread}/files`;
  const links = useFileLinks(userId, pool, threadId);
  const title = threads.find((t) => t.pool === pool && t.id === threadId)?.title || "New thread";
  const [tab, setTab] = useState<Tab>("files");
  const [error, setError] = useState("");
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [listings, setListings] = useState<Record<string, FileListing>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([WORKDIR]));
  const [current, setCurrent] = useState<FileEntry>();
  /** The files the open one was opened among (its folder, the search hits or the Images grid), for the viewer's steps. */
  const [among, setAmong] = useState<FileEntry[]>();
  const [menu, setMenu] = useState<MenuAt>();
  /** The row renamed in place from its Rename button. */
  const [renaming, setRenaming] = useState<string>();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ q: string; entries: FileEntry[]; more: boolean }>();
  const [filter, setFilter] = useState<Filter>("all");
  const [images, setImages] = useState<ImageEntry[]>();
  /** Where an upload or a new folder goes when nothing more specific was picked: the last folder opened. */
  const [cwd, setCwd] = useState(WORKDIR);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const uploadTo = useRef(WORKDIR);
  const writable = useCallback((p: string) => roots.some((r) => under(p, r.path) && r.writable), [roots]);

  const fail = (e: unknown) => setError((e as Error).message);
  const load = useCallback(async (dir: string) => {
    const l = await get<FileListing>(`${base}?dir=${encodeURIComponent(dir)}`);
    setRoots(l.roots);
    setListings((x) => ({ ...x, [dir]: l }));
    return l;
  }, [base]);
  useEffect(() => { load(WORKDIR).catch(fail); }, [load]);
  // The tree follows the thread: every folder shown reloads when the thread's open stream finishes a tool call or a turn
  // (the shell counts them per thread), and when the window comes back into focus, so a file she wrote shows without reopening the panel.
  const shownDirs = useRef<string[]>([]);
  shownDirs.current = Object.keys(listings);
  const activity = ctx.activity[`${pool}/${threadId}`] ?? 0;
  const reloadShown = useCallback(() => { Promise.all(shownDirs.current.map(load)).catch(fail); if (tab === "images") void loadImagesRef.current(); }, [load, tab]);
  const loadImagesRef = useRef<() => Promise<unknown>>(() => Promise.resolve());
  useEffect(() => { if (activity) reloadShown(); }, [activity, reloadShown]);
  useEffect(() => {
    const on = () => { if (document.visibilityState === "visible") reloadShown(); };
    addEventListener("focus", on);
    return () => removeEventListener("focus", on);
  }, [reloadShown]);
  // A linked file: its folders open and it is shown; a folder is only opened. Where the family's /shared is the
  // thread's own `shared/` (a project chat), a /shared path opens there. A link she wrote relative to her folder
  // that isn't in it is looked for at the same place in /shared, then in each grant, before it is called missing.
  useEffect(() => {
    if (!path) return;
    let live = true;
    (async () => {
      // The path's listing, or nothing where its folder isn't there or can't be read.
      const look = async (q: string) => { try { const l = await load(parent(q)); return { q, l, entry: l.entries.find((e) => e.path === q) }; } catch { return undefined; } };
      let roots = (await load(WORKDIR)).roots;
      const own = (q: string) => (under(q, SHARED) && !roots.some((r) => r.kind === "shared") ? `${WORKDIR}/shared${q.slice(SHARED.length)}` : q);
      const rest = path.slice(WORKDIR.length);
      const tries = [path, ...(path !== WORKDIR && under(path, WORKDIR) ? [SHARED, ...roots.filter((r) => r.kind === "grant").map((r) => r.path)].map((r) => `${r}${rest}`) : [])].map(own);
      let found: Awaited<ReturnType<typeof look>>;
      for (const q of tries) if ((found = await look(q))?.entry) break;
      if (!live) return;
      if (!found?.entry) { setError(`${shown(own(path))} wasn't found.`); return; }
      const { q: p, l, entry } = found;
      roots = l.roots;
      const root = roots.find((r) => under(p, r.path))?.path ?? WORKDIR;
      const dirs: string[] = [];
      for (let d = parent(p); d.length >= root.length && under(d, root); d = parent(d)) dirs.unshift(d);
      setOpen((s) => new Set([...s, ...dirs, ...(entry.kind === "folder" ? [p] : [])]));
      if (entry.kind === "folder") { setCwd(p); if (!listings[p]) load(p).catch(fail); }
      else view(entry);
    })().catch(fail);
    return () => { live = false; };
  }, [path, load]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadImages = useCallback(() => get<ImageEntry[]>(`${base}/images`).then(setImages, fail), [base]);
  loadImagesRef.current = loadImages;
  useEffect(() => { if (tab === "images") void loadImages(); }, [tab, loadImages]);

  // A search runs under every root; the thread's folder first.
  useEffect(() => {
    const text = q.trim();
    if (!text) { setHits(undefined); return; }
    let live = true;
    const t = setTimeout(() => {
      Promise.all(roots.map((r) => get<FileSearch>(`${base}/search?root=${encodeURIComponent(r.path)}&q=${encodeURIComponent(text)}`)))
        .then((rs) => { if (live) setHits({ q: text, entries: rs.flatMap((r) => r.entries), more: rs.some((r) => r.more) }); }, fail);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, roots, base]);

  /** Reloads the folders holding these paths, and whatever else shows them. */
  const refresh = useCallback(async (paths: string[]) => {
    const dirs = new Set(paths.map(parent));
    await Promise.all([...dirs].map((d) => load(d)));
    if (tab === "images") await loadImages();
    if (hits) setQ((x) => `${x} `.trimEnd() === x ? `${x} ` : x.trimEnd()); // nudges the search to run again
  }, [load, tab, loadImages, hits]);

  const toggle = (dir: string) => {
    setCwd(dir);
    setOpen((s) => { const n = new Set(s); if (n.has(dir)) n.delete(dir); else n.add(dir); return n; });
    if (!listings[dir]) load(dir).catch(fail);
  };
  const view = (f: FileEntry, list?: FileEntry[]) => {
    setCurrent(f); setCwd(parent(f.path));
    setAmong(list ?? (hits ? hits.entries : listings[parent(f.path)]?.entries));
  };

  // Ctrl- or Cmd-click adds to the selection, Shift-click takes everything between (docs/ux.md §6).
  const visible = useMemo(() => {
    if (hits) return hits.entries.map((e) => e.path);
    const out: string[] = [];
    const walk = (dir: string) => { for (const e of listings[dir]?.entries ?? []) { out.push(e.path); if (e.kind === "folder" && open.has(e.path)) walk(e.path); } };
    for (const r of roots) if (open.has(r.path)) walk(r.path);
    return out;
  }, [hits, listings, open, roots]);
  const { sel, setSel, pick: choose } = useSelection(visible);
  const pick = (e: React.MouseEvent, entry: FileEntry) => choose(e, entry.path);

  const openMenu = (e: React.MouseEvent | { clientX: number; clientY: number }, target: Target) => {
    if ("preventDefault" in e) e.preventDefault();
    // From the keyboard there is no pointer: open where the row is.
    const el = "currentTarget" in e && e.clientX === 0 && e.clientY === 0 ? (e.currentTarget as Element).getBoundingClientRect() : null;
    const t: Target = target.kind === "file" && sel.size > 1 && sel.has(target.entry.path) ? { kind: "selection", paths: [...sel] } : target;
    if (target.kind === "file" && sel.size && !sel.has(target.entry.path)) setSel(new Set());
    setMenu({ x: el ? el.left + 24 : e.clientX, y: el ? el.bottom : e.clientY, target: t });
  };
  const hold = useLongPress();
  /** A right-click or a long press opens the menu. The space under the rows answers only for itself. */
  const press = (target: Target) => {
    const onButton = (e: React.SyntheticEvent) => target.kind === "space" && !!(e.target as Element).closest("button");
    return {
      onContextMenu: (e: React.MouseEvent) => { if (!onButton(e)) openMenu(e, target); },
      ...hold((at) => openMenu(at, target), onButton),
    };
  };

  // The actions, each from the menu.
  const contentUrl = (p: string, download = false) => `${base}/content?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
  const attach = (paths: string[]) => {
    const req: AttachRequest = { base: thread, paths };
    if (ask(ATTACH_EVENT, req)) return;
    // No message box on this page (a phone): the thread's box takes them when it shows.
    keep(ATTACH_KEY, req);
    go({ page: "thread", userId, pool, threadId });
  };
  /** Show in thread: the conversation beside the panel scrolls to the message that names the file; on a phone, the thread page does. */
  const showInThread = (path: string) => {
    const req: ShowRequest = { base: thread, path };
    if (ask(SHOW_EVENT, req)) { if (!req.found) setError("That file isn't named in the messages shown."); return; }
    keep(SHOW_KEY, req);
    go({ page: "thread", userId, pool, threadId });
  };
  const download = (paths: string[]) => {
    const a = document.createElement("a");
    if (paths.length === 1 && listingEntry(paths[0]!)?.kind !== "folder") { a.href = contentUrl(paths[0]!, true); a.download = basename(paths[0]!); a.click(); return; }
    fetch(`${base}/zip`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({ error: "the zip failed" })) as { error: string }).error); return r.blob(); })
      .then((blob) => { a.href = URL.createObjectURL(blob); a.download = `${paths.length === 1 ? basename(paths[0]!) : "files"}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000); }, fail);
  };
  const listingEntry = (p: string) => listings[parent(p)]?.entries.find((e) => e.path === p) ?? hits?.entries.find((e) => e.path === p);
  const copy = (paths: string[]) => navigator.clipboard?.writeText(paths.join("\n")).catch(fail);
  const mkdir = async (dir: string, name: string) => { await post(`${base}/folder`, { path: `${dir}/${name}` }); setOpen((s) => new Set([...s, dir])); await refresh([`${dir}/${name}`]); };
  const rename = async (from: string, name: string) => {
    const to = `${parent(from)}/${name}`;
    await post(`${base}/rename`, { from, to });
    if (current?.path === from) setCurrent(undefined);
    setSel((s) => (s.has(from) ? new Set([...s].filter((p) => p !== from)) : s));
    await refresh([from, to]);
  };
  const remove = async (paths: string[]) => {
    await post(`${base}/delete`, { paths });
    if (current && paths.some((p) => under(current.path, p))) setCurrent(undefined);
    setSel(new Set());
    setListings((l) => Object.fromEntries(Object.entries(l).filter(([d]) => !paths.some((p) => under(d, p)))));
    await refresh(paths);
  };
  const send = (dir: string, files: Iterable<File>) => {
    const list = [...files];
    if (!list.length) return;
    if (!writable(dir)) { setError(`${shown(dir)} is read-only.`); return; }
    setError("");
    (async () => {
      for (const f of list) await upload(`${base}/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, f, () => {});
      setOpen((s) => new Set([...s, dir]));
      await refresh(list.map((f) => `${dir}/${f.name}`));
    })().catch(fail);
  };
  const askUpload = (dir: string) => { uploadTo.current = dir; picker.current?.click(); };

  // What the tree shows: the search's hits, or the roots with their open folders. A row in a writable folder carries
  // Rename and Delete at its right (docs/ux.md §6), shown on hover or focus (always on a touch screen); the menu has the rest.
  const row = (e: FileEntry, depth: number) => {
    const isDir = e.kind === "folder";
    const selected = sel.has(e.path);
    const target: Target = isDir ? { kind: "folder", path: e.path, root: false } : { kind: "file", entry: e };
    const name = hits ? shown(e.path) : e.name;
    if (renaming === e.path) {
      return (
        <div key={e.path} className="frow" style={{ paddingLeft: 6 + depth * 14 }}>
          <InlineRename className="fname" value={e.name} label="New name" onSave={(n) => n.includes("/") ? Promise.reject(new Error("A name can't contain /")).catch(fail) : rename(e.path, n).catch(fail)} onDone={() => setRenaming(undefined)} />
        </div>
      );
    }
    return (
      <div key={e.path} className="frow">
        <button type="button" className={selected ? "sel" : undefined} style={{ paddingLeft: 6 + depth * 14 }}
          aria-current={!isDir && current?.path === e.path ? "true" : undefined} aria-expanded={isDir ? open.has(e.path) : undefined} aria-pressed={selected || undefined}
          onClick={(ev) => { if (pick(ev, e)) return; if (isDir) toggle(e.path); else view(e); }}
          {...press(target)}>
          {isDir ? <Icon name={open.has(e.path) ? "down" : "right"} /> : <Icon name={/\.(png|jpe?g|gif|webp)$/i.test(e.name) ? "image" : "file"} className="dim" />}
          {isDir && <Icon name="folder" className="dim" />}
          <span className="fname">{name}</span>
        </button>
        {writable(e.path) && (
          <span className="frow-acts">
            <button type="button" className="icon" aria-label={`Rename ${name}`} title="Rename" onClick={() => setRenaming(e.path)}><Icon name="edit" /></button>
            <button type="button" className="icon" aria-label={`Delete ${name}`} title="Delete" onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom, target, sub: "delete" }); }}><Icon name="trash" /></button>
          </span>
        )}
      </div>
    );
  };
  const folder = (dir: string, depth: number): ReactNode => {
    const l = listings[dir];
    if (!l) return <p key={`${dir}/…`} className="empty" style={{ paddingLeft: 6 + depth * 14 }}>Loading…</p>;
    if (!l.entries.length) return <p key={`${dir}/…`} className="empty" style={{ paddingLeft: 6 + depth * 14 }} {...press({ kind: "space", dir })}>Empty</p>;
    return (
      <>
        {l.entries.map((e) => (
          <div key={e.path} className="fentry">
            {row(e, depth)}
            {e.kind === "folder" && open.has(e.path) && folder(e.path, depth + 1)}
          </div>
        ))}
        {l.more && <p className="empty" style={{ paddingLeft: 6 + depth * 14 }}>Only the first 2,000 are shown.</p>}
      </>
    );
  };
  const tree = hits ? (
    hits.entries.length ? <>{hits.entries.map((e) => row(e, 0))}{hits.more && <p className="empty">Only the first 200 are shown.</p>}</> : <p className="empty">No files match.</p>
  ) : roots.length ? roots.map((r) => (
    <div key={r.path} className="fentry">
      <button type="button" className="root" aria-expanded={open.has(r.path)} title={r.kind === "shared" ? r.path : undefined} onClick={() => toggle(r.path)} {...press({ kind: "folder", path: r.path, root: true })}>
        <Icon name={open.has(r.path) ? "down" : "right"} /><span className="fname">{shown(r.path)}</span>
        {r.kind === "grant" && <span className="rw num">{r.writable ? "rw" : "ro"}</span>}
      </button>
      {open.has(r.path) && folder(r.path, 1)}
    </div>
  )) : <p className="empty">{error ? "" : "Loading…"}</p>;

  const act = (fn: () => Promise<unknown>) => fn().then(() => setMenu(undefined), (e: Error) => { setError(e.message); setMenu(undefined); });
  const dropDir = current ? parent(current.path) : cwd;
  const panelTitle = tab === "files" ? "Files" : "Images";
  const closeViewer = useCallback(() => setCurrent(undefined), []);
  // Inside the viewer while it shows, since the page under a modal dialog can't be reached.
  const fileMenu = menu && (
    <FileMenu at={menu} writable={writable} onClose={() => setMenu(undefined)} shownName={shown}
      onAttach={(ps) => { setMenu(undefined); setCurrent(undefined); attach(ps); }} onDownload={(ps) => { setMenu(undefined); download(ps); }} onCopy={(ps) => { setMenu(undefined); void copy(ps); }}
      onSelect={(p) => { setMenu(undefined); setSel((s) => new Set([...s, p])); }} onShow={(p) => { setMenu(undefined); setCurrent(undefined); showInThread(p); }}
      onUpload={(dir) => { setMenu(undefined); askUpload(dir); }} onMkdir={(dir, name) => act(() => mkdir(dir, name))} onRename={(p, name) => act(() => rename(p, name))}
      onDelete={(ps) => act(() => remove(ps))} />
  );

  return (
    <Main className={`main files-page${dropping ? " drop" : ""}`} aria-label={`${title}: files`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={(e) => { e.preventDefault(); setDropping(false); send(dropDir, e.dataTransfer.files); }}>
      <header className="head">
        <button type="button" className="menu-btn icon" aria-label="Show threads" onClick={ctx.openSide}><Icon name="menu" /></button>
        <div className="head-title">
          <Crumbs />
          <h1>{panelTitle}</h1>
          <span className="cap">{title}</span>
        </div>
        <div className="head-actions">
          <div className="seg" role="tablist" aria-label="Files or images">
            {(["files", "images"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{k === "files" ? "Files" : "Images"}</button>
            ))}
          </div>
        </div>
        <PanelButtons />
      </header>
      <ErrorText error={error} />
      {tab === "files" ? (
        <>
          <div className="fsearch"><input type="search" aria-label="Search files" placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="fbody">
            <div className="ftree" role="tree" aria-label="Folders and files" {...press({ kind: "space", dir: cwd })}>{tree}</div>
          </div>
        </>
      ) : (
        <ImagesTab images={images} filter={filter} onFilter={setFilter} links={links} sel={sel} onPick={pick} press={(e) => press({ kind: "file", entry: e })} onOpen={(i) => view(i, shownImages(images, filter))} />
      )}
      {sel.size > 0 && (
        <div className="selbar" role="toolbar" aria-label="Selection">
          <span><span className="num">{sel.size}</span> selected</span>
          <button type="button" className="icon sm" aria-label="Actions for the selection" onClick={(e) => openMenu(e, { kind: "selection", paths: [...sel] })}><Icon name="more" /></button>
          <button type="button" className="icon sm" aria-label="Clear the selection" onClick={() => setSel(new Set())}><Icon name="close" /></button>
        </div>
      )}
      <input ref={picker} type="file" multiple hidden onChange={(e) => { send(uploadTo.current, e.target.files ?? []); e.target.value = ""; }} />
      {current && (
        // The file large, with this thread beside it when the file is in its own folder (a grant's has no thread of its own).
        <Viewer ctx={ctx} threads={threads} file={current} base={base} shownPath={shown(current.path)} thread={isUnderWorkdir(current.path) ? { pool, threadId } : undefined}
          list={among} onStep={(f) => view(f as FileEntry, among)}
          onMenu={(e) => openMenu(e, { kind: "file", entry: current })} onClose={closeViewer}>
          {menu && fileMenu}
        </Viewer>
      )}
      {menu && !current && fileMenu}
    </Main>
  );
}

const shownImages = (images: ImageEntry[] | undefined, filter: Filter) => images?.filter((i) => filter === "all" || i.source === filter);

/** The thread's images, filtered, each opening in the viewer. */
function ImagesTab({ images, filter, onFilter, links, sel, onPick, press, onOpen }: {
  images?: ImageEntry[]; filter: Filter; onFilter: (f: Filter) => void; links: FileLinks; sel: Set<string>;
  onPick: (e: React.MouseEvent, entry: FileEntry) => boolean; press: (entry: FileEntry) => Record<string, unknown>; onOpen: (entry: FileEntry) => void;
}) {
  const listed = shownImages(images, filter);
  return (
    <>
      <div className="ifilter">
        <div className="seg" role="group" aria-label="Show">
          {([["all", "All"], ["uploaded", "Uploaded"], ["made", `Made by ${her()}`]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => onFilter(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="igrid" aria-label="Images">
        {!images ? <p className="empty">Loading…</p> : !listed?.length ? <p className="empty">No images yet</p> : listed.map((i) => (
          <button key={i.path} type="button" aria-label={i.name} className={sel.has(i.path) ? "sel" : undefined} aria-pressed={sel.has(i.path) || undefined}
            onClick={(e) => { if (!onPick(e, i)) onOpen(i); }} {...press(i)}>
            <Thumb path={i.path} alt="" files={links} /><span className="meta mono">{i.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}
function Item({ label, kbd, danger, onClick }: { label: ReactNode; kbd?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={danger ? "danger" : undefined} data-key={kbd} onClick={onClick}>
      <span>{label}</span>{kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

/** The right-click menu: Attach, Select, Show in thread, Download, Copy path; Rename and Delete where the folder is writable; Upload and New folder on a folder. */
function FileMenu({ at, writable, shownName, onClose, onAttach, onDownload, onCopy, onSelect, onShow, onUpload, onMkdir, onRename, onDelete }: {
  at: MenuAt; writable: (p: string) => boolean; shownName: (p: string) => string; onClose: () => void;
  onAttach: (paths: string[]) => void; onDownload: (paths: string[]) => void; onCopy: (paths: string[]) => void; onSelect: (path: string) => void; onShow: (path: string) => void;
  onUpload: (dir: string) => void; onMkdir: (dir: string, name: string) => Promise<unknown>; onRename: (path: string, name: string) => Promise<unknown>; onDelete: (paths: string[]) => Promise<unknown>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<"" | "rename" | "newfolder" | "delete">(at.sub ?? "");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const t = at.target;
  const paths = t.kind === "file" ? [t.entry.path] : t.kind === "selection" ? t.paths : t.kind === "folder" ? [t.path] : [];
  const dir = t.kind === "folder" ? t.path : t.kind === "space" ? t.dir : "";
  const canWrite = paths.length ? paths.every(writable) : writable(dir);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - r.height - 8))}px`;
  }, [at, sub, error]);
  useEffect(() => {
    if (sub === "delete") return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (sub) setSub(""); else onClose(); return; }
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (menuArrows(e, ref.current)) return;
      const btn = ref.current?.querySelector<HTMLButtonElement>(`button[data-key="${e.key.toUpperCase()}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    };
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", down);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", down); };
  }, [sub, onClose]);
  useEffect(() => { if (!sub) ref.current?.querySelector("button")?.focus(); }, [sub]);
  // The menu may sit above an open dialog (an image shown large).
  useEffect(() => { const el = ref.current, dlg = document.querySelector("dialog[open]"); if (el && dlg && !dlg.contains(el)) dlg.appendChild(el); }, []);

  const run = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));
  if (sub === "delete") {
    const inGrant = paths.some((p) => !p.startsWith(`${WORKDIR}/`));
    const one = paths.length === 1 ? shownName(paths[0]!) : undefined;
    const what = one ?? `${paths.length} items`;
    const sentence = one
      ? inGrant ? `${one} is one of your own files, not a copy. It is deleted for good; this can't be undone.` : `${one} is deleted for good. This can't be undone.`
      : inGrant ? `These ${paths.length} items are your own files, not copies. They are deleted for good; this can't be undone.` : `These ${paths.length} items are deleted for good. This can't be undone.`;
    return (
      <ConfirmDialog title={`Delete ${what}?`} danger confirm="Delete" onCancel={onClose} onConfirm={() => void run(onDelete(paths))} sentence={sentence} />
    );
  }
  let body: ReactNode;
  if (sub === "rename" || sub === "newfolder") {
    body = (
      <form onSubmit={(e) => { e.preventDefault(); const name = draft.trim(); if (!name || name.includes("/")) return; void run(sub === "rename" ? onRename(paths[0]!, name) : onMkdir(dir, name)); }}>
        <input autoFocus aria-label={sub === "rename" ? "New name" : "Folder name"} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setSub(""); } }} />
        <button type="submit" className="primary sm" disabled={!draft.trim() || draft.includes("/")}>{sub === "rename" ? "Rename" : "Add"}</button>
      </form>
    );
  } else if (t.kind === "selection") {
    body = (
      <>
        <span className="eyebrow"><span className="num">{paths.length}</span> items</span>
        <Item label={`Attach ${paths.length}`} kbd="A" onClick={() => onAttach(paths)} />
        <Item label="Download as zip" kbd="S" onClick={() => onDownload(paths)} />
        <Item label="Copy paths" kbd="C" onClick={() => onCopy(paths)} />
        {canWrite && <><div className="sep" role="separator" /><Item label={`Delete ${paths.length}…`} kbd="D" danger onClick={() => setSub("delete")} /></>}
      </>
    );
  } else if (t.kind === "file") {
    body = (
      <>
        <span className="eyebrow name">{t.entry.name}</span>
        <Item label="Attach to message" kbd="A" onClick={() => onAttach(paths)} />
        <Item label="Select" kbd="X" onClick={() => onSelect(t.entry.path)} />
        <Item label="Show in thread" kbd="G" onClick={() => onShow(t.entry.path)} />
        <Item label="Download" kbd="S" onClick={() => onDownload(paths)} />
        <Item label="Copy path" kbd="C" onClick={() => onCopy(paths)} />
        {canWrite && (
          <>
            <div className="sep" role="separator" />
            <Item label="Rename…" kbd="R" onClick={() => { setDraft(t.entry.name); setSub("rename"); }} />
            <Item label="Delete…" kbd="D" danger onClick={() => setSub("delete")} />
          </>
        )}
      </>
    );
  } else {
    const root = t.kind === "folder" && t.root;
    body = (
      <>
        <span className={dir === WORKDIR ? "eyebrow" : "eyebrow name"}>{shownName(dir)}</span>
        {canWrite ? (
          <>
            <Item label="Upload…" kbd="U" onClick={() => onUpload(dir)} />
            <Item label="New folder…" kbd="N" onClick={() => { setDraft(""); setSub("newfolder"); }} />
          </>
        ) : <p className="empty">Read-only</p>}
        {t.kind === "folder" && <Item label="Download as zip" kbd="S" onClick={() => onDownload(paths)} />}
        <Item label="Copy path" kbd="C" onClick={() => onCopy([dir])} />
        {t.kind === "folder" && !root && canWrite && (
          <>
            <div className="sep" role="separator" />
            <Item label="Rename…" kbd="R" onClick={() => { setDraft(basename(t.path)); setSub("rename"); }} />
            <Item label="Delete…" kbd="D" danger onClick={() => setSub("delete")} />
          </>
        )}
      </>
    );
  }
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label="File actions" style={{ left: at.x, top: at.y }}>
      {body}
      <ErrorText error={error} />
    </div>
  );
}
