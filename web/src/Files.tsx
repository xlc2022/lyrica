// The Files panel (DESIGN "Files and images", docs/ux.md §6): a thread's
// folder and its granted folders, one folder at a time, with a search, a
// file opened in the viewer (Viewer.tsx), Images, Videos and Artifacts tabs, and every action in a
// right-click menu (a long press on a phone, or the ⋯ beside a file).
// Beside the conversation from the split width, where Expand opens it in a dialog
// over the conversation; the page on its own below it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { get, post, threadPath, upload, type FileCopyResponse, type FileEntry, type FileListing, type FileRoot, type FileSearch, type ImageEntry, type Pool, type ThreadSummary } from "./api.ts";
import { ask, ATTACH_EVENT, ATTACH_KEY, keep, SHOW_EVENT, SHOW_KEY, type AttachRequest, type ShowRequest } from "./links.ts";
import { FAMILY_ROOT, isUnderWorkdir, SHARED, shown, Thumb, useFileLinks, VideoThumb, WORKDIR, type FileLinks } from "./paths.tsx";
import { ArtifactsTab, importArtifacts } from "./Artifacts.tsx";
import { Viewer } from "./Viewer.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { go } from "./route.ts";
import { Crumbs, Main, PanelButtons, usePanel, type ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, InlineRename, menuArrows, useLongPress, useSelection } from "./ui.tsx";

type Tab = "files" | MediaTab | "artifacts";
/** The tabs that are a grid of one kind of file, each the route that lists them. */
type MediaTab = "images" | "videos";
const TAB_LABEL: Record<Tab, string> = { files: "Files", images: "Images", videos: "Videos", artifacts: "Artifacts" };
const isMedia = (t: Tab): t is MediaTab => t === "images" || t === "videos";
type Filter = "all" | "uploaded" | "made";

/** What a menu is about: a file, a folder (a root has no parent to rename it in), the selection, or the space under a folder's entries. */
type Target =
  | { kind: "file"; entry: FileEntry }
  | { kind: "folder"; path: string; root: boolean }
  | { kind: "selection"; paths: string[] }
  | { kind: "space"; dir: string };

/** `sub`: the menu opens straight into one of its steps (a row's Delete button opens its confirm). */
interface MenuAt { x: number; y: number; target: Target; sub?: "delete" }

/**
 * What Ctrl+C (or Copy in the menu) last copied in a Files panel (docs/ux.md §6), for Ctrl+V in any of the same user's
 * panels. `text` is what went on the system clipboard with it, so a later copy anywhere else wins; `system` is false
 * when the browser refused that write, and Lyrica's own copy is then all there is to paste.
 */
let copied: { userId: string; pool: Pool; base: string; paths: string[]; folders: string[]; text: string; system: boolean } | undefined;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
/** A field the keys belong to: the shortcuts leave text alone. */
const inField = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
/** An image's bytes as PNG, the one image type every browser puts on the system clipboard. */
async function asPng(url: string): Promise<Blob> {
  const blob = await fetch(url, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error("the image couldn't be read"); return r.blob(); });
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("the image couldn't be copied"))), "image/png"));
}

const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
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
  // Every thread listed, children under their parents, for a project chat's thread folders: their titles and order.
  const everyThread = useMemo(() => { const flat = (t: ThreadSummary): ThreadSummary[] => [t, ...t.children.flatMap(flat)]; return threads.filter((t) => t.pool === pool).flatMap(flat); }, [threads, pool]);
  const project = !!everyThread.find((t) => t.id === threadId)?.project;
  const [tab, setTab] = useState<Tab>("files");
  const [error, setError] = useState("");
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [listings, setListings] = useState<Record<string, FileListing>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([WORKDIR, FAMILY_ROOT]));
  const [current, setCurrent] = useState<FileEntry>();
  /** The files the open one was opened among (its folder, the search hits or the Images or Videos grid), for the viewer's steps. */
  const [among, setAmong] = useState<FileEntry[]>();
  const [menu, setMenu] = useState<MenuAt>();
  /** The row renamed in place from its Rename button. */
  const [renaming, setRenaming] = useState<string>();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ q: string; entries: FileEntry[]; more: boolean }>();
  const [filter, setFilter] = useState<Filter>("all");
  const [media, setMedia] = useState<Partial<Record<MediaTab, ImageEntry[]>>>({});
  /** Where an upload or a new folder goes when nothing more specific was picked: the last folder opened. */
  const [cwd, setCwd] = useState(WORKDIR);
  const [dropping, setDropping] = useState(false);
  /** How many files Ctrl+C just copied, said in the selection bar for a moment. */
  const [copiedNote, setCopiedNote] = useState(0);
  useEffect(() => { if (!copiedNote) return; const t = setTimeout(() => setCopiedNote(0), 2000); return () => clearTimeout(t); }, [copiedNote]);
  /** The keys act here while the panel was the last thing pressed or focused, so they never reach a panel the person isn't using. */
  const active = useRef(false);
  /** Opened large in a dialog over the conversation, from the panel's Expand. */
  const inPanel = !!usePanel();
  const [big, setBig] = useState(false);
  const closeBig = useCallback(() => setBig(false), []);
  const picker = useRef<HTMLInputElement>(null);
  const uploadTo = useRef(WORKDIR);
  const writable = useCallback((p: string) => roots.some((r) => under(p, r.path) && r.writable), [roots]);
  // A project chat's thread folders, in the thread list's order, each named by its thread's title (docs/ux.md §6).
  const members = useMemo(() => {
    const at = new Map(everyThread.map((t, i) => [t.id, i]));
    return roots.filter((r) => r.kind === "member").sort((a, b) => (at.get(a.threadId!) ?? Infinity) - (at.get(b.threadId!) ?? Infinity));
  }, [roots, everyThread]);
  const threadTitle = useCallback((id: string) => everyThread.find((t) => t.id === id)?.title || "New thread", [everyThread]);
  /** A path as the panel names it: in a project chat its folder is the Project folder, and a thread's folder goes by its title. */
  const named = useCallback((p: string) => {
    if (project && p === WORKDIR) return "Project folder";
    const m = members.find((r) => under(p, r.path));
    return m ? `${threadTitle(m.threadId!)}${p.slice(m.path.length)}` : shown(p);
  }, [project, members, threadTitle]);

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
  const reloadShown = useCallback(() => { Promise.all(shownDirs.current.map(load)).catch(fail); if (isMedia(tab)) void loadMediaRef.current(tab); }, [load, tab]);
  const loadMediaRef = useRef<(k: MediaTab) => Promise<unknown>>(() => Promise.resolve());
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
      if (!found?.entry) { setError(`${named(own(path))} wasn't found.`); return; }
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
  const loadMedia = useCallback((k: MediaTab) => get<ImageEntry[]>(`${base}/${k}`).then((l) => setMedia((m) => ({ ...m, [k]: l })), fail), [base]);
  loadMediaRef.current = loadMedia;
  useEffect(() => { if (isMedia(tab)) void loadMedia(tab); }, [tab, loadMedia]);

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
    if (isMedia(tab)) await loadMedia(tab);
    if (hits) setQ((x) => `${x} `.trimEnd() === x ? `${x} ` : x.trimEnd()); // nudges the search to run again
  }, [load, tab, loadMedia, hits]);

  const toggle = (dir: string) => {
    setCwd(dir);
    setOpen((s) => { const n = new Set(s); if (n.has(dir)) n.delete(dir); else n.add(dir); return n; });
    if (!listings[dir]) load(dir).catch(fail);
  };
  const view = (f: FileEntry, list?: FileEntry[]) => {
    setCurrent(f); setCwd(parent(f.path));
    setAmong(list ?? (hits ? hits.entries : listings[parent(f.path)]?.entries));
  };

  // Ctrl- or Cmd-click adds to the selection, Shift-click takes everything between (docs/ux.md §6), in the grid's order on Images and Videos.
  const visible = useMemo(() => {
    if (isMedia(tab)) return filtered(media[tab], filter)?.map((e) => e.path) ?? [];
    if (tab === "artifacts") return [];
    if (hits) return hits.entries.map((e) => e.path);
    const out: string[] = [];
    const walk = (dir: string) => { for (const e of listings[dir]?.entries ?? []) { out.push(e.path); if (e.kind === "folder" && open.has(e.path)) walk(e.path); } };
    for (const r of roots) if (open.has(r.path)) walk(r.path);
    return out;
  }, [tab, media, filter, hits, listings, open, roots]);
  const { sel, setSel, pick: choose } = useSelection(visible);
  const treeEl = useRef<HTMLDivElement>(null);
  const treeBox = useBoxSelect(treeEl, sel, setSel);
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
    setBig(false);
    const req: AttachRequest = { base: thread, paths };
    if (ask(ATTACH_EVENT, req)) return;
    // No message box on this page (a phone): the thread's box takes them when it shows.
    keep(ATTACH_KEY, req);
    go({ page: "thread", userId, pool, threadId });
  };
  /** Show in thread: the conversation beside the panel scrolls to the message that names the file; on a phone, the thread page does. */
  const showInThread = (path: string) => {
    setBig(false);
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
  /** Ctrl+C: the files themselves, for Ctrl+V in this panel or another thread's; one image also goes on the system clipboard as an image. */
  const copyFiles = (paths: string[]) => {
    if (!paths.length) return;
    const text = paths.join("\n");
    const isFolder = (p: string) => listingEntry(p)?.kind === "folder";
    const c = { userId, pool, base, paths, folders: paths.filter(isFolder), text, system: true };
    copied = c;
    const cb = navigator.clipboard;
    const one = paths.length === 1 && IMAGE_NAME.test(paths[0]!) && !isFolder(paths[0]!) ? paths[0]! : undefined;
    const write = one && cb && "write" in cb && typeof ClipboardItem !== "undefined"
      ? cb.write([new ClipboardItem({ "image/png": asPng(contentUrl(one)), "text/plain": new Blob([text], { type: "text/plain" }) })]).catch(() => cb.writeText(text))
      : cb ? cb.writeText(text) : Promise.reject(new Error("no clipboard"));
    write.catch(() => { c.system = false; });
    setCopiedNote(paths.length);
  };
  /**
   * Ctrl+V of what was copied in a panel: copies made in `dir` by lyricad within this thread, or carried over from
   * another of the user's threads. `beside` (Images and Videos, which show no folders): a copy within the thread lands
   * beside its original where that folder is writable, so it shows as "tray-2.png", not as a twin.
   */
  const pasteCopied = async (dir: string, beside = false) => {
    const c = copied;
    if (!c) return;
    const into = (p: string) => (beside && c.base === base && writable(parent(p)) ? parent(p) : dir);
    const bad = c.paths.map(into).find((d) => !writable(d));
    if (bad) { setError(`${named(bad)} is read-only.`); return; }
    setError("");
    let made: string[] = [];
    if (c.base === base) {
      const groups = new Map<string, string[]>();
      for (const p of c.paths) groups.set(into(p), [...groups.get(into(p)) ?? [], p]);
      for (const [d, ps] of groups) made.push(...(await post<FileCopyResponse>(`${base}/copy`, { paths: ps, dir: d })).paths);
    } else {
      // Private stays private: a private thread's files never land in a general one.
      if (c.pool === "private" && pool !== "private") throw new Error("Files from a private thread can't be pasted into a general one.");
      if (c.folders.length) throw new Error("A folder pastes only within its own thread; copy the files in it instead.");
      for (const p of c.paths) {
        const r = await fetch(`${c.base}/content?path=${encodeURIComponent(p)}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`${basename(p)} couldn't be read.`);
        made.push((await upload(`${base}/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(basename(p))}`, new File([await r.blob()], basename(p)), () => {})).path);
      }
    }
    setOpen((s) => new Set([...s, ...made.map(parent)]));
    await refresh(made);
    setSel(new Set(made));
  };
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
    if (!writable(dir)) { setError(`${named(dir)} is read-only.`); return; }
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
    // In a project chat each thread's own part of shared/ (named by its id) goes by the thread's title too.
    const ownShared = project && !hits && parent(e.path) === `${WORKDIR}/shared` && isDir ? everyThread.find((t) => t.id === safeDecode(e.name)) : undefined;
    const name = hits ? named(e.path) : ownShared ? ownShared.title || "New thread" : e.name;
    if (renaming === e.path) {
      return (
        <div key={e.path} className="frow" style={{ paddingLeft: 6 + depth * 14 }}>
          <InlineRename className="fname" value={e.name} label="New name" onSave={(n) => n.includes("/") ? Promise.reject(new Error("A name can't contain /")).catch(fail) : rename(e.path, n).catch(fail)} onDone={() => setRenaming(undefined)} />
        </div>
      );
    }
    return (
      <div key={e.path} className="frow">
        <button type="button" className={selected ? "sel" : undefined} data-path={e.path} title={ownShared ? e.path : undefined} style={{ paddingLeft: 6 + depth * 14 }}
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
  ) : roots.length ? <>
    {roots.filter((r) => r.kind !== "member").map((r) => (
      <div key={r.path} className="fentry">
        <button type="button" className="root" aria-expanded={open.has(r.path)} title={r.kind === "shared" ? r.path : undefined} onClick={() => toggle(r.path)} {...press({ kind: "folder", path: r.path, root: true })}>
          <Icon name={open.has(r.path) ? "down" : "right"} /><span className="fname">{named(r.path)}</span>
          {r.kind === "grant" && <span className="rw num">{r.writable ? "rw" : "ro"}</span>}
        </button>
        {open.has(r.path) && folder(r.path, 1)}
      </div>
    ))}
    {members.length > 0 && (
      // A project chat's threads, each one's folder read-only under its title (docs/ux.md §6).
      <div className="fentry">
        <button type="button" className="root" aria-expanded={open.has(FAMILY_ROOT)} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(FAMILY_ROOT)) n.delete(FAMILY_ROOT); else n.add(FAMILY_ROOT); return n; })}>
          <Icon name={open.has(FAMILY_ROOT) ? "down" : "right"} /><span className="fname">Threads</span>
        </button>
        {open.has(FAMILY_ROOT) && members.map((r) => (
          <div key={r.path} className="fentry">
            <button type="button" style={{ paddingLeft: 20 }} aria-expanded={open.has(r.path)} title={r.path} onClick={() => toggle(r.path)} {...press({ kind: "folder", path: r.path, root: true })}>
              <Icon name={open.has(r.path) ? "down" : "right"} /><Icon name="folder" className="dim" /><span className="fname">{threadTitle(r.threadId!)}</span>
            </button>
            {open.has(r.path) && folder(r.path, 2)}
          </div>
        ))}
      </div>
    )}
  </> : <p className="empty">{error ? "" : "Loading…"}</p>;

  const act = (fn: () => Promise<unknown>) => fn().then(() => setMenu(undefined), (e: Error) => { setError(e.message); setMenu(undefined); });
  const dropDir = current ? parent(current.path) : cwd;
  // Ctrl or Cmd+C copies the selection, Ctrl or Cmd+V pastes into the folder last opened, Delete or Backspace asks to
  // delete the selection (docs/ux.md §6). Never in a text field, nor while a menu, a dialog or the viewer is up.
  const keys = useRef<{ key: (e: KeyboardEvent) => void; paste: (e: ClipboardEvent) => void }>(undefined);
  keys.current = {
    key: (e) => {
      if (!active.current || e.altKey || e.defaultPrevented || inField(e.target) || menu || current || tab === "artifacts" || renaming) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace") && sel.size) {
        const paths = [...sel];
        if (!paths.every(writable)) { setError("Something selected is read-only."); return; }
        e.preventDefault();
        const bar = document.querySelector(".selbar")?.getBoundingClientRect();
        setMenu({ x: bar?.left ?? 0, y: bar?.top ?? 0, target: { kind: "selection", paths }, sub: "delete" });
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "c" && sel.size && (getSelection()?.isCollapsed ?? true)) {
        e.preventDefault();
        copyFiles([...sel]);
      }
    },
    paste: (e) => {
      if (!active.current || inField(e.target) || menu || current || tab === "artifacts" || renaming) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (copied && copied.userId === userId && (text === copied.text || (!copied.system && !files.length && !text))) {
        e.preventDefault();
        pasteCopied(cwd, isMedia(tab)).catch(fail);
      } else if (files.length) {
        // A screenshot or files copied outside Lyrica upload, as a drop does.
        e.preventDefault();
        send(cwd, files);
      }
    },
  };
  useEffect(() => {
    // Pressing or focusing anywhere else ends it; the panel's own handlers (below) start it again, after this.
    const away = () => { active.current = false; };
    const key = (e: KeyboardEvent) => keys.current?.key(e);
    const paste = (e: ClipboardEvent) => keys.current?.paste(e);
    addEventListener("pointerdown", away, true);
    addEventListener("focusin", away, true);
    addEventListener("keydown", key);
    addEventListener("paste", paste);
    return () => { removeEventListener("pointerdown", away, true); removeEventListener("focusin", away, true); removeEventListener("keydown", key); removeEventListener("paste", paste); };
  }, []);
  const here = { onPointerDownCapture: () => { active.current = true; }, onFocusCapture: () => { active.current = true; } };
  const panelTitle = TAB_LABEL[tab];
  const closeViewer = useCallback(() => setCurrent(undefined), []);
  /** The thread whose folder holds a path, in a project chat's Threads. */
  const memberOf = (p: string) => members.find((r) => under(p, r.path))?.threadId;
  // Inside the viewer while it shows, since the page under a modal dialog can't be reached.
  const fileMenu = menu && (
    <FileMenu at={menu} writable={writable} onClose={() => setMenu(undefined)} shownName={named}
      onAttach={(ps) => { setMenu(undefined); setCurrent(undefined); attach(ps); }} onDownload={(ps) => { setMenu(undefined); download(ps); }} onCopy={(ps) => { setMenu(undefined); void copy(ps); }}
      onCopyFiles={(ps) => { setMenu(undefined); copyFiles(ps); }} canPaste={!!copied && copied.userId === userId} onPaste={(dir) => act(() => pasteCopied(dir))}
      onSelect={(p) => { setMenu(undefined); setSel((s) => new Set([...s, p])); }} onShow={(p) => { setMenu(undefined); setCurrent(undefined); showInThread(p); }}
      onUpload={(dir) => { setMenu(undefined); askUpload(dir); }} onMkdir={(dir, name) => act(() => mkdir(dir, name))} onRename={(p, name) => act(() => rename(p, name))}
      onDelete={(ps) => act(() => remove(ps))} />
  );

  // Dropping files on the browser uploads them, wherever it shows: the panel, the page or the dialog.
  const drop = {
    ...here,
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); },
    // On the Artifacts tab a dropped file is imported as an artifact of this thread.
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); setDropping(false);
      if (tab === "artifacts") importArtifacts(userId, pool, threadId, [...e.dataTransfer.files]).catch(fail);
      else send(dropDir, e.dataTransfer.files);
    },
  };
  const body = (
    <>
      <header className="head">
        <button type="button" className="menu-btn icon" aria-label="Show threads" onClick={ctx.openSide}><Icon name="menu" /></button>
        <div className="head-title">
          <Crumbs />
          <h1>{panelTitle}</h1>
          <span className="cap">{title}</span>
        </div>
        <div className="head-actions">
          <div className="seg" role="tablist" aria-label="Files, images, videos or artifacts">
            {(["files", "images", "videos", "artifacts"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{TAB_LABEL[k]}</button>
            ))}
          </div>
        </div>
        {big ? (
          <div className="head-actions panel-actions">
            <button type="button" className="icon sm" aria-label="Close" title="Close" onClick={closeBig}><Icon name="close" /></button>
          </div>
        ) : <PanelButtons onExpand={inPanel ? () => setBig(true) : undefined} />}
      </header>
      <ErrorText error={error} />
      {tab === "files" ? (
        <>
          <div className="fsearch"><input type="search" aria-label="Search files" placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="fbody">
            <div ref={treeEl} className="ftree" role="tree" aria-label="Folders and files" {...both(press({ kind: "space", dir: cwd }), treeBox.drag)}>
              {tree}
              {/* Last, so the tree's first-child rules still see the first folder. */}
              {treeBox.box && <div className="selbox" aria-hidden="true" style={treeBox.box} />}
            </div>
          </div>
        </>
      ) : tab === "artifacts" ? (
        <ArtifactsTab ctx={ctx} pool={pool} threadId={threadId} activity={activity} onError={setError} />
      ) : (
        <MediaGrid kind={tab} entries={media[tab]} filter={filter} onFilter={setFilter} links={links} sel={sel} onSelect={setSel} onPick={pick} press={(e) => press({ kind: "file", entry: e })} onOpen={(i) => view(i, filtered(media[tab], filter))} />
      )}
      {sel.size > 0 && (
        <div className="selbar" role="toolbar" aria-label="Selection">
          <span role="status"><span className="num">{sel.size}</span> selected{copiedNote ? <> · Copied</> : null}</span>
          <button type="button" className="icon sm" aria-label="Actions for the selection" onClick={(e) => openMenu(e, { kind: "selection", paths: [...sel] })}><Icon name="more" /></button>
          <button type="button" className="icon sm" aria-label="Clear the selection" onClick={() => setSel(new Set())}><Icon name="close" /></button>
        </div>
      )}
      <input ref={picker} type="file" multiple hidden onChange={(e) => { send(uploadTo.current, e.target.files ?? []); e.target.value = ""; }} />
      {current && (
        // The file large, with this thread beside it when the file is in its own folder (a grant's has no thread of its own).
        <Viewer ctx={ctx} threads={threads} file={current} base={base} shownPath={named(current.path)} thread={isUnderWorkdir(current.path) ? { pool, threadId } : memberOf(current.path) ? { pool, threadId: memberOf(current.path)! } : undefined}
          list={among} onStep={(f) => view(f as FileEntry, among)}
          onMenu={(e) => openMenu(e, { kind: "file", entry: current })} onClose={closeViewer}>
          {menu && fileMenu}
        </Viewer>
      )}
      {menu && !current && fileMenu}
    </>
  );
  const cls = `main files-page${dropping ? " drop" : ""}`;
  if (big) {
    // Out of the panel's column into the body, so the panel's narrow-column rules don't reach it; React events still reach this page.
    return (
      <Main className="main files-page" aria-label={`${title}: files`}>
        {createPortal(<FilesDialog label={`${title}: files`} onClose={closeBig}><div className={cls} {...drop}>{body}</div></FilesDialog>, document.body)}
      </Main>
    );
  }
  return <Main className={cls} aria-label={`${title}: files`} {...drop}>{body}</Main>;
}

/** The Files panel opened large over the conversation (Expand in its header); Close, Escape or the scrim puts it back in the panel. */
function FilesDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  // Going anywhere else (a link inside it, Show in thread) puts it back.
  useEffect(() => { addEventListener("hashchange", onClose); return () => removeEventListener("hashchange", onClose); }, [onClose]);
  return (
    <dialog ref={ref} className="files-dialog" aria-label={label}
      // A click on the scrim (the dialog itself, outside its content) closes it, as every dialog does.
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      // Escape closes the topmost thing: a menu or drawer inside first, then the dialog.
      onCancel={(e) => { e.preventDefault(); if (!document.activeElement?.closest("[role='menu'], .ctx-menu, .drawer")) onClose(); }}>
      {children}
    </dialog>
  );
}

const filtered = (entries: ImageEntry[] | undefined, filter: Filter) => entries?.filter((i) => filter === "all" || i.source === filter);

/** The thread's images or clips, filtered, each opening in the viewer; a clip shows its poster. */
function MediaGrid({ kind, entries, filter, onFilter, links, sel, onSelect, onPick, press, onOpen }: {
  kind: MediaTab; entries?: ImageEntry[]; filter: Filter; onFilter: (f: Filter) => void; links: FileLinks; sel: Set<string>; onSelect: (s: Set<string>) => void;
  onPick: (e: React.MouseEvent, entry: FileEntry) => boolean; press: (entry: FileEntry) => Record<string, unknown>; onOpen: (entry: FileEntry) => void;
}) {
  const listed = filtered(entries, filter);
  const grid = useRef<HTMLDivElement>(null);
  const { box, drag } = useBoxSelect(grid, sel, onSelect);
  return (
    <>
      <div className="ifilter">
        <div className="seg" role="group" aria-label="Show">
          {([["all", "All"], ["uploaded", "Uploaded"], ["made", `Made by ${her()}`]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => onFilter(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div ref={grid} className="igrid" aria-label={TAB_LABEL[kind]} {...drag}>
        {!entries ? <p className="empty">Loading…</p> : !listed?.length ? <p className="empty">No {kind} yet</p> : listed.map((i) => (
          <button key={i.path} type="button" aria-label={i.name} data-path={i.path} className={sel.has(i.path) ? "sel" : undefined} aria-pressed={sel.has(i.path) || undefined}
            onClick={(e) => { if (!onPick(e, i)) onOpen(i); }} {...press(i)}>
            {kind === "videos" ? <VideoThumb path={i.path} files={links} /> : <Thumb path={i.path} alt="" files={links} />}<span className="meta mono">{i.name}</span>
          </button>
        ))}
        {box && <div className="selbox" aria-hidden="true" style={box} />}
      </div>
    </>
  );
}
/** Two sets of event handlers as one: where both have a handler for an event, each runs, `a`'s first. */
function both(a: Record<string, unknown>, b: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...a, ...b };
  for (const k of Object.keys(a)) {
    const f = a[k], g = b[k];
    if (typeof f === "function" && typeof g === "function") out[k] = (...args: unknown[]) => { f(...args); g(...args); };
  }
  return out;
}

/** Past this many pixels a press that moves is a drag, not a click. */
const DRAG_START = 5;
/** How far into a row or tile the box must reach to take it. */
const SLACK = 2;
/** Within this many pixels of the grid's top or bottom edge a drag scrolls it. */
const EDGE = 32;

/**
 * Click and drag with a mouse across the Files tree or the Images and Videos grid draws a box, and the rows or tiles it touches are the selection; holding Ctrl,
 * Cmd or Shift adds them to the selection already there (docs/ux.md §6). A press that doesn't move stays a click, and
 * the click that ends a drag is swallowed so no tile opens. Touch keeps scrolling and the long press.
 */
function useBoxSelect(grid: React.RefObject<HTMLDivElement | null>, sel: Set<string>, onSelect: (s: Set<string>) => void) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const live = useRef<{ x: number; y: number; cx: number; cy: number; w: number; h: number; base: Set<string>; moved: boolean; frame?: number }>(undefined);
  const swallow = useRef(false);

  /** Grid content coordinates (they scroll with the tiles) of a point on screen. */
  const at = (el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };
  const update = () => {
    const el = grid.current, d = live.current;
    if (!el || !d?.moved) return;
    // Kept inside the tiles' own extent, so the box never makes the grid taller and the edge scroll stops at the end.
    const q = at(el, d.cx, d.cy), p = { x: Math.max(0, Math.min(q.x, d.w)), y: Math.max(0, Math.min(q.y, d.h)) };
    const left = Math.min(d.x, p.x), top = Math.min(d.y, p.y), right = Math.max(d.x, p.x), bottom = Math.max(d.y, p.y);
    setBox({ left, top, width: right - left, height: bottom - top });
    const r = el.getBoundingClientRect();
    const next = new Set(d.base);
    for (const t of el.querySelectorAll<HTMLElement>("button[data-path]")) {
      const b = t.getBoundingClientRect();
      const tl = b.left - r.left + el.scrollLeft, tt = b.top - r.top + el.scrollTop;
      // A row or tile counts once the box is a couple of pixels into it, not when their edges merely meet.
      if (tl + SLACK < right && tl + b.width - SLACK > left && tt + SLACK < bottom && tt + b.height - SLACK > top) next.add(t.dataset.path!);
    }
    onSelect(next);
  };
  /** Near the top or bottom edge the grid scrolls, frame by frame, while the button is held. */
  const scroll = () => {
    const el = grid.current, d = live.current;
    if (!el || !d) return;
    const r = el.getBoundingClientRect();
    const by = d.cy < r.top + EDGE ? -Math.ceil((r.top + EDGE - d.cy) / 4) : d.cy > r.bottom - EDGE ? Math.ceil((d.cy - r.bottom + EDGE) / 4) : 0;
    if (by) { el.scrollTop += by; update(); }
    d.frame = by ? requestAnimationFrame(scroll) : undefined;
  };
  const end = () => {
    const d = live.current;
    if (d?.frame) cancelAnimationFrame(d.frame);
    live.current = undefined;
    setBox(undefined);
  };
  useEffect(() => () => { const f = live.current?.frame; if (f) cancelAnimationFrame(f); }, []);

  const drag = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      // A mouse's main button only, and not on the scrollbar (outside the grid's client area).
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      const el = e.currentTarget, r = el.getBoundingClientRect();
      if (e.clientX - r.left >= el.clientLeft + el.clientWidth || e.clientY - r.top >= el.clientTop + el.clientHeight) return;
      const p = at(el, e.clientX, e.clientY);
      const add = e.ctrlKey || e.metaKey || e.shiftKey;
      live.current = { ...p, cx: e.clientX, cy: e.clientY, w: el.scrollWidth, h: el.scrollHeight, base: add ? new Set(sel) : new Set(), moved: false };
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = live.current;
      if (!d) return;
      d.cx = e.clientX; d.cy = e.clientY;
      if (!d.moved) {
        const p = at(e.currentTarget, e.clientX, e.clientY);
        if (Math.hypot(p.x - d.x, p.y - d.y) < DRAG_START) return;
        d.moved = true;
        // Held here, the drag keeps going when the pointer leaves the grid.
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      update();
      if (!d.frame) scroll();
    },
    onPointerUp: () => {
      // The click this release makes (if it makes one) comes in the same task; nothing later is swallowed.
      if (live.current?.moved) { swallow.current = true; setTimeout(() => { swallow.current = false; }); }
      end();
    },
    onPointerCancel: end,
    onScroll: () => { if (live.current?.moved) update(); },
    // An image would otherwise start the browser's own drag of it.
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
    onClickCapture: (e: React.MouseEvent) => { if (swallow.current) { e.preventDefault(); e.stopPropagation(); swallow.current = false; } },
  };
  return { box, drag };
}

function Item({ label, kbd, danger, onClick }: { label: ReactNode; kbd?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={danger ? "danger" : undefined} data-key={kbd} onClick={onClick}>
      <span>{label}</span>{kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

/** The right-click menu: Attach, Select, Show in thread, Download, Copy path; Rename and Delete where the folder is writable; Upload and New folder on a folder. */
function FileMenu({ at, writable, shownName, onClose, onAttach, onDownload, onCopy, onCopyFiles, canPaste, onPaste, onSelect, onShow, onUpload, onMkdir, onRename, onDelete }: {
  at: MenuAt; writable: (p: string) => boolean; shownName: (p: string) => string; onClose: () => void;
  onAttach: (paths: string[]) => void; onDownload: (paths: string[]) => void; onCopy: (paths: string[]) => void;
  onCopyFiles: (paths: string[]) => void; canPaste: boolean; onPaste: (dir: string) => Promise<unknown>; onSelect: (path: string) => void; onShow: (path: string) => void;
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
        <Item label="Copy" kbd="C" onClick={() => onCopyFiles(paths)} />
        <Item label="Copy paths" kbd="P" onClick={() => onCopy(paths)} />
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
        <Item label="Copy" kbd="C" onClick={() => onCopyFiles(paths)} />
        <Item label="Copy path" kbd="P" onClick={() => onCopy(paths)} />
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
            {canPaste && <Item label="Paste" kbd="V" onClick={() => void run(onPaste(dir))} />}
          </>
        ) : <p className="empty">Read-only</p>}
        {t.kind === "folder" && <Item label="Download as zip" kbd="S" onClick={() => onDownload(paths)} />}
        {t.kind === "folder" && !root && <Item label="Copy" kbd="C" onClick={() => onCopyFiles(paths)} />}
        <Item label="Copy path" kbd="P" onClick={() => onCopy([dir])} />
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
