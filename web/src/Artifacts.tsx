// Artifacts (DESIGN "Files and images", docs/ux.md §6, docs/briefs/artifacts.md): a page she published or the user
// imported, kept with every version. A card in her reply and a row on the Artifacts page open one in the file viewer,
// where its versions, and what can be done with it, are.
import { useCallback, useEffect, useRef, useState } from "react";
import { del, errorFrom, get, patch, post, u, type ArtifactDetail, type ArtifactInfo, type ArtifactKind, type ArtifactPart, type Pool } from "./api.ts";
import { Icon } from "./icons.tsx";
import { RowMenu } from "./Machines.tsx";
import { href } from "./route.ts";
import { PageHead, type ShellContext } from "./Shell.tsx";
import { her } from "./name.ts";
import { ConfirmDialog, ErrorText, fullTime, hidden, InlineRename, shortTime, useAction, useDismiss, useLoad } from "./ui.tsx";
import { Viewer, type ViewKind } from "./Viewer.tsx";

/** The word for a kind, as the viewer's facts line has it for a file. */
export const ARTIFACT_KIND: Record<ArtifactKind, string> = { html: "HTML", svg: "SVG", markdown: "Markdown", react: "React" };
/** The files Import and Add version take. */
const ACCEPT = ".html,.htm,.svg,.md,.markdown,.jsx,.tsx";
const EXT: Record<ArtifactKind, string> = { html: "html", svg: "svg", markdown: "md", react: "tsx" };

const OPEN = "lyrica:artifact";
const CHANGED = "lyrica:artifacts-changed";
interface Opened { pool: Pool; id: string; version?: number }

/** Opens an artifact in the viewer, over whatever page is showing (`ArtifactHost`); `version` picks one, the newest otherwise. */
export const openArtifact = (o: Opened) => { dispatchEvent(new CustomEvent<Opened>(OPEN, { detail: o })); };
const changed = () => { dispatchEvent(new Event(CHANGED)); };

const base = (userId: string, pool: Pool, id?: string) => (id ? u(userId, "artifacts", pool, id) : u(userId, "artifacts", pool));

/** Sends a file's bytes as an import or a new version; the server's sentence is the error. */
async function send<T>(url: string, file: File): Promise<T> {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}name=${encodeURIComponent(file.name)}`, { method: "POST", body: file, credentials: "same-origin" });
  if (!res.ok) throw await errorFrom(res);
  return await res.json() as T;
}

/** The card for an artifact she published in a reply: its title, kind and the version that call made, and Open. */
export function ArtifactCard({ part, pool }: { part: ArtifactPart; pool: Pool }) {
  return (
    <div className="artifact-card" data-artifact={part.id}>
      <Icon name="file" className="dim" />
      <span className="artifact-name">
        <span className="artifact-title">{part.title}</span>
        <span className="cap">{ARTIFACT_KIND[part.kind]} · Version <span className="num">{part.version}</span></span>
      </span>
      <button type="button" className="sm" aria-label={`Open ${part.title}`} onClick={() => openArtifact({ pool, id: part.id, version: part.version })}>Open</button>
    </div>
  );
}

/** Mounted once in the shell: shows the artifact `openArtifact` asked for, until it is closed or the address changes. */
export function ArtifactHost({ ctx }: { ctx: ShellContext }) {
  const [open, setOpen] = useState<Opened>();
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<Opened>).detail);
    addEventListener(OPEN, on);
    return () => removeEventListener(OPEN, on);
  }, []);
  const close = useCallback(() => setOpen(undefined), []);
  return open ? <ArtifactViewer key={`${open.pool}/${open.id}/${open.version ?? ""}`} ctx={ctx} opened={open} onClose={close} /> : null;
}

function ArtifactViewer({ ctx, opened, onClose }: { ctx: ShellContext; opened: Opened; onClose: () => void }) {
  const userId = ctx.user.id;
  const at = base(userId, opened.pool, opened.id);
  const detail = useLoad(() => get<ArtifactDetail>(at), [at]);
  const [picked, setPicked] = useState(opened.version);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [run, busy, error] = useAction();
  const picker = useRef<HTMLInputElement>(null);
  const d = detail.data;
  // One that is gone (deleted, or its pool hidden) says so in a toast and shows nothing.
  const gone = !d && !!detail.error;
  useEffect(() => { if (gone) { ctx.toast("That artifact is gone."); onClose(); } }, [gone]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const a = d.artifact;
  const version = d.versions.find((v) => v.n === picked) ?? d.versions[0]!;
  const newest = version.n === a.version;
  const q = `?v=${version.n}`;
  const took = (next: ArtifactDetail) => { detail.set(next); setPicked(next.artifact.version); changed(); };
  const kind: ViewKind = a.kind === "react" ? "html" : a.kind;
  const link = `${location.origin}${location.pathname}${href({ page: "artifacts", userId, pool: a.pool, id: a.id })}`;
  return (
    <Viewer ctx={ctx} threads={ctx.threads} onClose={onClose} base="" shownPath={a.title}
      file={{ path: a.id, name: `${a.title}.${EXT[a.kind]}`, size: version.size, modified: version.createdAt }}
      thread={a.thread ? { pool: a.pool, threadId: a.thread } : undefined}
      from={{
        kind, content: (download) => `${at}/content${q}${download ? "&download=1" : ""}`, view: `${at}/view${q}`,
        ...(a.thread ? { settings: u(userId, "threads", a.pool, a.thread, "settings") } : {}),
        heading: renaming
          ? <InlineRename value={a.title} label="Title" className="artifact-rename" onDone={() => setRenaming(false)}
            onSave={(title) => run(async () => { const next = await patch<ArtifactInfo>(at, { title }); detail.set({ ...d, artifact: next }); changed(); })} />
          : <span className="fname artifact-heading" title={a.title} onDoubleClick={() => setRenaming(true)}>{a.title}</span>,
        facts: d.versions.length > 1 ? (
          <select className="artifact-version" aria-label="Version" value={version.n} onChange={(e) => setPicked(Number(e.target.value))}>
            {d.versions.map((v) => <option key={v.n} value={v.n}>Version {v.n} · {v.author === "user" ? "you" : her()} · {shortTime(v.createdAt)}</option>)}
          </select>
        ) : <>Version <span className="num">1</span></>,
        actions: <>
          <RowMenu label="Artifact actions" items={[
            { label: "Open in new tab", onPick: () => { window.open(`${at}/view${q}`, "_blank", "noopener"); }, ...(a.kind === "markdown" ? { disabled: true, title: "Markdown opens only here." } : {}) },
            { label: "Copy link", onPick: () => { void run(() => navigator.clipboard.writeText(link)); } },
            { label: "Add version…", onPick: () => picker.current?.click() },
            { label: "Restore this version", onPick: () => { void run(async () => took(await post<ArtifactDetail>(`${at}/restore`, { version: version.n }))); }, ...(newest ? { disabled: true, title: "This is the newest version." } : {}) },
            { label: "Rename…", onPick: () => setRenaming(true) },
            { label: "Delete…", danger: true, onPick: () => setDeleting(true) },
          ]} />
          <input ref={picker} type="file" hidden accept={ACCEPT} aria-label="Add version" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(async () => took(await send<ArtifactDetail>(`${at}/versions`, f))); }} />
        </>,
      }}>
      {error && <div className="viewer-error" role="alert"><ErrorText error={error} /></div>}
      {deleting && (
        <ConfirmDialog title={`Delete ${a.title}?`} danger confirm="Delete" onCancel={() => setDeleting(false)}
          sentence={d.versions.length > 1 ? `All ${d.versions.length} versions are deleted. This can't be undone.` : "It is deleted for good. This can't be undone."}
          onConfirm={() => { setDeleting(false); void run(async () => { await del(at); changed(); onClose(); }); }} />
      )}
    </Viewer>
  );
}

/** The Artifacts page: every artifact in the pools shown, newest change first, and Import. `id` opens one (a copied link). */
export function ArtifactsPage({ ctx, pool, id }: { ctx: ShellContext; pool?: Pool; id?: string }) {
  const userId = ctx.user.id;
  const display = ctx.me.display;
  const list = useLoad(() => get<ArtifactInfo[]>(u(userId, "artifacts")), [userId, display.showGeneral, display.showPrivate]);
  const [query, setQuery] = useState("");
  const pools = (["general", "private"] as const).filter((p) => !hidden(display, p));
  // Where the picked files go: the one pool shown, or the one chosen from Import's menu.
  const into = useRef<Pool>("general");
  const [choosing, setChoosing] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  useDismiss(menu, choosing, () => setChoosing(false));
  const pick = (p: Pool) => { into.current = p; setChoosing(false); picker.current?.click(); };
  const [run, busy, error] = useAction();
  const picker = useRef<HTMLInputElement>(null);
  const { reload } = list;
  useEffect(() => { addEventListener(CHANGED, reload); return () => removeEventListener(CHANGED, reload); }, [reload]);
  // A copied link: the page with that artifact open over it.
  useEffect(() => { if (pool && id) openArtifact({ pool, id }); }, [pool, id]);
  const add = (files: File[]) => run(async () => {
    let last: ArtifactInfo | undefined;
    try { for (const f of files) last = await send<ArtifactInfo>(base(userId, into.current), f); } finally { reload(); }
    if (last && files.length === 1) openArtifact({ pool: last.pool, id: last.id });
  });
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (list.data ?? []).filter((a) => words.every((w) => `${a.title} ${a.threadTitle ?? ""} ${ARTIFACT_KIND[a.kind]}`.toLowerCase().includes(w)));
  return (
    <main className="main" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); into.current = pools[0] ?? "general"; void add([...e.dataTransfer.files]); } }}>
      <PageHead ctx={ctx} title="Artifacts" facts={list.data && list.data.length > 0 ? <span className="num">{list.data.length}</span> : undefined}>
        <span className="row-menu" ref={menu}>
          <button type="button" className="primary" disabled={busy || !pools.length} aria-haspopup={pools.length > 1 ? "menu" : undefined} aria-expanded={pools.length > 1 ? choosing : undefined}
            onClick={() => (pools.length > 1 ? setChoosing((c) => !c) : pick(pools[0]!))}>Import</button>
          {choosing && (
            <div className="menu" role="menu" aria-label="Import">
              {pools.map((p) => <button key={p} type="button" role="menuitem" onClick={() => pick(p)}>{p === "general" ? "Into General" : "Into Private"}</button>)}
            </div>
          )}
        </span>
        <input ref={picker} type="file" hidden multiple accept={ACCEPT} aria-label="Import files"
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void add(files); }} />
      </PageHead>
      <div className="scroll">
        <div className="artifacts">
          <ErrorText error={list.error || error} />
          {(list.data?.length ?? 0) > 0 && (
            <input type="search" aria-label="Search artifacts" placeholder="Search artifacts" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {list.data && !list.data.length && <p className="empty">No artifacts yet.</p>}
          {list.data && list.data.length > 0 && !shown.length && <p className="empty">No artifacts match.</p>}
          {shown.length > 0 && (
            <ul className="artifact-list" aria-label="Artifacts">
              {shown.map((a) => (
                <li key={`${a.pool}/${a.id}`}>
                  <button type="button" className="artifact-row" data-artifact={a.id} onClick={() => openArtifact({ pool: a.pool, id: a.id })}>
                    <span className="artifact-title">{a.title}</span>
                    <span className="cap">
                      {ARTIFACT_KIND[a.kind]} · Version <span className="num">{a.version}</span>
                      {pools.length > 1 && <> · {a.pool === "general" ? "General" : "Private"}</>}
                      {a.threadTitle && <> · {a.threadTitle}</>} · <span className="num" title={fullTime(a.updatedAt)}>{shortTime(a.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
