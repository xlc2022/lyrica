// Project settings → Files and images (DESIGN "Projects", docs/ux.md §6): the project folder, which is the
// project chat's own folder and a root in every thread of the project, managed one folder at a time through
// the Files panel's routes on the project chat. Files in the chat's header stays the quick view.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { get, post, threadPath, upload, type FileEntry, type FileListing, type ImageEntry, type Pool } from "./api.ts";
import { kb } from "./Files.tsx";
import { Icon } from "./icons.tsx";
import { RowMenu } from "./Machines.tsx";
import { her } from "./name.ts";
import { Lightbox, Thumb, useFileLinks, WORKDIR } from "./paths.tsx";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, InlineRename, shortTime, useAction } from "./ui.tsx";

type Tab = "files" | "images";
type Filter = "all" | "uploaded" | "made";

/** How many folders Move to… lists at most. */
const FOLDER_LIMIT = 500;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
/** A path inside the project folder as the section names it: the folder itself is the Project folder. */
export const relative = (p: string) => (p === WORKDIR ? "Project folder" : p.startsWith(`${WORKDIR}/`) ? p.slice(WORKDIR.length + 1) : p);
/** The crumbs from the project folder down to `dir`. */
export function crumbs(dir: string): { path: string; name: string }[] {
  const out = [{ path: WORKDIR, name: "Project folder" }];
  if (!under(dir, WORKDIR) || dir === WORKDIR) return out;
  let at = WORKDIR;
  for (const part of dir.slice(WORKDIR.length + 1).split("/")) { at = `${at}/${part}`; out.push({ path: at, name: part }); }
  return out;
}
/** The folders a file or folder can move to: not where it is, and not a folder into itself. */
export function moveTargets(folders: string[], entry: Pick<FileEntry, "path" | "kind">): string[] {
  return folders.filter((f) => f !== parent(entry.path) && !(entry.kind === "folder" && under(f, entry.path)));
}

export function FilesSection({ ctx, pool, threadId }: { ctx: ShellContext; pool: Pool; threadId: string }) {
  const userId = ctx.user.id;
  const base = `${threadPath(userId, pool, threadId)}/files`;
  const links = useFileLinks(userId, pool, threadId);
  const [tab, setTab] = useState<Tab>("files");
  const [dir, setDir] = useState(WORKDIR);
  const [listing, setListing] = useState<FileListing>();
  const [images, setImages] = useState<ImageEntry[]>();
  const [filter, setFilter] = useState<Filter>("all");
  const [renaming, setRenaming] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<FileEntry>();
  const [deleting, setDeleting] = useState<FileEntry>();
  const [large, setLarge] = useState<ImageEntry>();
  const [dropping, setDropping] = useState(false);
  const [run, busy, error] = useAction();
  const [loadError, setLoadError] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => (tab === "files"
    ? get<FileListing>(`${base}?dir=${encodeURIComponent(dir)}`).then((l) => { setListing(l); setLoadError(""); })
    : get<ImageEntry[]>(`${base}/images`).then((i) => { setImages(i); setLoadError(""); })
  ).catch((e: Error) => setLoadError(e.message)), [base, dir, tab]);
  useEffect(() => { void load(); }, [load]);
  // The folder is shared by every thread of the project: any thread finishing a tool call or a turn reloads it, and so does coming back to the window.
  const activity = Object.values(ctx.activity).reduce((n, x) => n + x, 0);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } void load(); }, [activity]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => { if (document.visibilityState === "visible") void load(); };
    addEventListener("focus", on);
    return () => removeEventListener("focus", on);
  }, [load]);

  const contentUrl = (p: string, download = false) => `${base}/content?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
  const download = (e: FileEntry) => run(async () => {
    const a = document.createElement("a");
    if (e.kind !== "folder") { a.href = contentUrl(e.path, true); a.download = e.name; a.click(); return; }
    const r = await fetch(`${base}/zip`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [e.path] }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({ error: "the zip failed" })) as { error: string }).error);
    a.href = URL.createObjectURL(await r.blob()); a.download = `${e.name}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });
  const rename = (e: FileEntry, name: string) => run(async () => {
    if (name.includes("/")) throw new Error("A name can't contain /.");
    await post(`${base}/rename`, { from: e.path, to: `${parent(e.path)}/${name}` });
    await load();
  });
  const mkdir = (name: string) => run(async () => {
    if (name.includes("/")) throw new Error("A name can't contain /.");
    await post(`${base}/folder`, { path: `${dir}/${name}` });
    await load();
  });
  const send = (files: Iterable<File>) => {
    const list = [...files];
    if (list.length) void run(async () => { for (const f of list) await upload(`${base}/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, f, () => {}); await load(); });
  };
  const menu = (e: FileEntry) => [
    { label: e.kind === "folder" ? "Download as zip" : "Download", onPick: () => void download(e) },
    { label: "Rename…", onPick: () => setRenaming(e.path) },
    { label: "Move to…", onPick: () => setMoving(e) },
    { label: "Delete…", danger: true, onPick: () => setDeleting(e) },
  ];
  const facts = (e: FileEntry) => e.kind === "folder" ? "Folder" : `${shortTime(e.modified)} · ${kb(e.size)}`;
  const shownImages = images?.filter((i) => filter === "all" || i.source === filter);

  return (
    <section className={`card project-form pfiles${dropping ? " drop" : ""}`} aria-labelledby="h-files"
      onDragOver={(e) => { if (tab === "files" && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={(e) => { if (tab !== "files") return; e.preventDefault(); setDropping(false); send(e.dataTransfer.files); }}>
      <h2 id="h-files">Files and images</h2>
      <div className="row pfiles-bar">
        <div className="seg" role="group" aria-label="Kind">
          {(["files", "images"] as const).map((k) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{k === "files" ? "Files" : "Images"}</button>)}
        </div>
        <span className="spacer" />
        <button type="button" className="sm" disabled={busy} onClick={() => picker.current?.click()} title={tab === "images" ? `To ${relative(dir)}` : undefined}>Upload…</button>
        {tab === "files" && <button type="button" className="sm" disabled={busy || adding} onClick={() => setAdding(true)}>New folder</button>}
      </div>
      <ErrorText error={loadError || error} />
      {tab === "files" ? (
        <>
          {dir !== WORKDIR && (
            <nav className="pfiles-crumbs mono" aria-label="Folder">
              {crumbs(dir).map((c, i, all) => i === all.length - 1
                ? <span key={c.path} aria-current="location">{c.name}</span>
                : <Fragment key={c.path}><button type="button" className="link" onClick={() => setDir(c.path)}>{c.name}</button><span className="muted" aria-hidden="true">/</span></Fragment>)}
            </nav>
          )}
          {!listing ? <p className="muted">Loading…</p> : (
            <ul className="list pfiles-list">
              {adding && (
                <li className="pfile-row">
                  <span className="pfile-main"><Icon name="folder" className="dim" /><InlineRename className="mono" value="" label="Folder name" onSave={mkdir} onDone={() => setAdding(false)} /></span>
                </li>
              )}
              {listing.entries.map((e) => (
                <li key={e.path} className="pfile-row">
                  <span className="pfile-main">
                    <Icon name={e.kind === "folder" ? "folder" : IMAGE.test(e.name) ? "image" : "file"} className="dim" />
                    {renaming === e.path
                      ? <InlineRename className="mono" value={e.name} label="New name" onSave={(n) => rename(e, n)} onDone={() => setRenaming(undefined)} />
                      : <span className="pfile-name mono">{e.name}</span>}
                    <span className="fact">{facts(e)}</span>
                  </span>
                  {e.kind === "folder"
                    ? <button type="button" className="sm" onClick={() => setDir(e.path)}>Open</button>
                    : <a className="sm" href={links.href(e.path)}>Open</a>}
                  <RowMenu label={`Actions for ${e.name}`} items={menu(e)} />
                </li>
              ))}
              {!listing.entries.length && !adding && <li className="muted">{dir === WORKDIR ? "No files yet." : "Empty"}</li>}
              {listing.more && <li className="muted">Only the first 2,000 are shown.</li>}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="seg" role="group" aria-label="Show">
            {([["all", "All"], ["uploaded", "Uploaded"], ["made", `Made by ${her()}`]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          {!images ? <p className="muted">Loading…</p> : !shownImages?.length ? <p className="muted">No images yet.</p> : (
            <ul className="pfiles-grid" aria-label="Images">
              {shownImages.map((i) => (
                <li key={i.path}>
                  <button type="button" className="pfiles-thumb" aria-label={`Open ${i.name}`} onClick={() => setLarge(i)}><Thumb path={i.path} alt="" files={links} /></button>
                  <span className="pfiles-tile">
                    {renaming === i.path
                      ? <InlineRename className="mono" value={i.name} label="New name" onSave={(n) => rename(i, n)} onDone={() => setRenaming(undefined)} />
                      : <span className="mono" title={relative(i.path)}>{i.name}</span>}
                    <RowMenu label={`Actions for ${i.name}`} items={menu(i)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <input ref={picker} type="file" multiple hidden onChange={(e) => { send(e.target.files ?? []); e.target.value = ""; }} />
      {large && <Lightbox path={large.path} url={contentUrl(large.path)} onClose={() => setLarge(undefined)} />}
      {moving && <MoveDrawer base={base} entry={moving} onClose={() => setMoving(undefined)} onMoved={() => { setMoving(undefined); void load(); }} />}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} danger confirm="Delete" onCancel={() => setDeleting(undefined)}
          sentence={`${deleting.name}${deleting.kind === "folder" ? " and everything in it are" : " is"} deleted for good, for every thread of the project. This can't be undone.`}
          onConfirm={() => { const e = deleting; setDeleting(undefined); void run(async () => { await post(`${base}/delete`, { paths: [e.path] }); await load(); }); }} />
      )}
    </section>
  );
}

/** Move to…: one Folder select of every folder in the project folder, and Move at the foot. */
function MoveDrawer({ base, entry, onClose, onMoved }: { base: string; entry: FileEntry; onClose: () => void; onMoved: () => void }) {
  const [folders, setFolders] = useState<string[]>();
  const [to, setTo] = useState("");
  const [run, busy, error] = useAction();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  // Folder by folder from the top, as the panel lists them, until the cap.
  useEffect(() => {
    let live = true;
    void run(async () => {
      const found = [WORKDIR];
      for (let i = 0; i < found.length && found.length < FOLDER_LIMIT; i++) {
        const l = await get<FileListing>(`${base}?dir=${encodeURIComponent(found[i]!)}`);
        for (const e of l.entries) if (e.kind === "folder" && found.length < FOLDER_LIMIT) found.push(e.path);
      }
      if (live) { const targets = moveTargets(found.sort(), entry); setFolders(targets); setTo(targets[0] ?? ""); }
    });
    return () => { live = false; };
  }, [base, entry]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = () => run(async () => { await post(`${base}/rename`, { from: entry.path, to: `${to}/${entry.name}` }); onMoved(); });
  return (
    <>
      <aside ref={ref} tabIndex={-1} className="drawer" aria-labelledby="move-title">
        <div className="drawer-head">
          <h2 id="move-title">Move <span className="mono">{entry.name}</span></h2>
          <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (to) void move(); }}>
          {!folders ? <p className="muted">Loading…</p> : folders.length ? (
            <label className="field"><span>Folder</span>
              <select className="mono" value={to} onChange={(e) => setTo(e.target.value)}>
                {folders.map((f) => <option key={f} value={f}>{relative(f)}</option>)}
              </select>
            </label>
          ) : <p className="muted">No other folder yet.</p>}
          <ErrorText error={error} />
          <div className="row drawer-foot"><button type="submit" className="primary" disabled={busy || !to}>Move</button></div>
        </form>
      </aside>
      <div className="scrim drawer-scrim" aria-hidden="true" onClick={onClose} />
    </>
  );
}
