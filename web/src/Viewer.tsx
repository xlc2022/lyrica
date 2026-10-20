// The file viewer (DESIGN "Files and images", docs/ux.md §6, A file opened from a library): a file from a thread's
// Files or a project's Files and images, large, with the thread whose library it is beside it. An HTML page runs in a
// sandbox with an opaque origin (daemon/src/file-view.ts), its console under it; SVG and Markdown show rendered with
// their Source a segment away; images, PDFs, audio and video in the browser's own viewers; text as text.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { get, type Pool, type ThreadSettings, type ThreadSummary } from "./api.ts";
import { Icon } from "./icons.tsx";
import { RowMenu } from "./Machines.tsx";
import { href } from "./route.ts";
import { PanelFrame, useWide, type ShellContext } from "./Shell.tsx";
import { Thread, findThread } from "./Thread.tsx";
import { ErrorText, fullTime, Prose, shortTime, useLoad } from "./ui.tsx";

/** Text this large is shown; anything bigger is offered as a download. */
export const TEXT_LIMIT = 512 * 1024;
/** Console lines kept for one page. */
const CONSOLE_LIMIT = 200;

export type ViewKind = "html" | "svg" | "markdown" | "pdf" | "image" | "audio" | "video" | "text" | "other";

/** What a file shows as, by its name; `undefined` when only its type, read with its bytes, can tell (text or not). */
export function viewKindOf(name: string): ViewKind | undefined {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio";
  if (["mp4", "webm"].includes(ext)) return "video";
  return undefined;
}

/** The word for a kind in the facts line. */
const KIND_WORD: Record<ViewKind, string> = { html: "HTML", svg: "SVG", markdown: "Markdown", pdf: "PDF", image: "Image", audio: "Audio", video: "Video", text: "Text", other: "File" };
/** Kinds with a Preview and a Source. */
const HAS_SOURCE = new Set<ViewKind>(["html", "svg", "markdown"]);

/** `madeBy`: the thread recorded as having written it, shown beside it in place of the library's own thread. */
export interface ViewerFile { path: string; name: string; size: number; modified: string; madeBy?: string }

export interface ConsoleLine { level: string; text: string }

/** A console message from the page's own frame, or nothing: anything else posting to this window is ignored. */
export function consoleLine(data: unknown): ConsoleLine | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as { lyricaConsole?: unknown; level?: unknown; text?: unknown };
  if (d.lyricaConsole !== 1 || typeof d.text !== "string") return undefined;
  const level = typeof d.level === "string" && ["log", "info", "warn", "error", "debug"].includes(d.level) ? d.level : "log";
  return { level, text: d.text.slice(0, 4000) };
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * `base` is the library's `…/files` route. `thread`: the thread whose library it is; the thread that wrote the file
 * (`file.madeBy`, in the same pool) is shown in its place where there is one. It shows beside the file from the
 * split width up and a toggle away below it; without one the file shows on its own. `items` fill the ⋯ menu after
 * Download and Copy path, unless `onMenu` opens the library's own menu (rendered as `children`, inside the dialog).
 */
export function Viewer({ ctx, threads, file, base, shownPath, thread, onMenu, onClose, children }: {
  ctx: ShellContext; threads: ThreadSummary[]; file: ViewerFile; base: string; shownPath: string;
  thread?: { pool: Pool; threadId: string }; onMenu?: (e: React.MouseEvent) => void; onClose: () => void; children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const wide = useWide();
  const [besideHidden, setBesideHidden] = useState(false);
  const [narrowPane, setNarrowPane] = useState<"file" | "thread">("file");
  const [error, setError] = useState("");
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  // Going anywhere else (a link in the thread, Open as a page) closes the viewer.
  useEffect(() => { addEventListener("hashchange", onClose); return () => removeEventListener("hashchange", onClose); }, [onClose]);
  const contentUrl = (download = false) => `${base}/content?path=${encodeURIComponent(file.path)}${download ? "&download=1" : ""}`;
  const viewUrl = `${base}/view?path=${encodeURIComponent(file.path)}`;
  const download = () => { const a = document.createElement("a"); a.href = contentUrl(true); a.download = file.name; a.click(); };

  // The thread that wrote the file, where one is recorded and still there; else the library's own.
  const known = thread && ((file.madeBy && findThread(threads, thread.pool, file.madeBy)) || findThread(threads, thread.pool, thread.threadId));
  const showThread = !!known && (wide ? !besideHidden : narrowPane === "thread");
  const showFile = wide || narrowPane === "file" || !known;
  const toggleThread = () => (wide ? setBesideHidden((h) => !h) : setNarrowPane((p) => (p === "file" ? "thread" : "file")));
  const threadHref = known ? href({ page: "thread", userId: ctx.user.id, pool: known.pool, threadId: known.id }) : "";

  return (
    <dialog ref={ref} className="viewer" aria-label={file.name} data-split={(wide && showThread) || undefined}
      // Escape closes the topmost thing: a menu or drawer open inside first, then the viewer.
      onCancel={(e) => { e.preventDefault(); if (!document.activeElement?.closest("[role='menu'], .ctx-menu, .drawer")) onClose(); }}>
      {showFile && (
        <FilePane file={file} shownPath={shownPath} contentUrl={contentUrl()} viewUrl={viewUrl}
          actions={<>
            {onMenu ? <button type="button" className="icon sm" aria-label="File actions" aria-haspopup="menu" title="File actions" onClick={onMenu}><Icon name="more" /></button>
              : <RowMenu label="File actions" items={[
                { label: "Download", onPick: download },
                { label: "Copy path", onPick: () => { void navigator.clipboard?.writeText(file.path).catch((e: Error) => setError(e.message)); } },
              ]} />}
            {known && <button type="button" className="sm" title={`Thread: ${known.title || "New thread"}`} aria-pressed={showThread} onClick={toggleThread}>Thread</button>}
            <button type="button" className="icon sm" aria-label="Close" title="Close" onClick={onClose}><Icon name="close" /></button>
          </>} onDownload={download} />
      )}
      {showThread && known && (
        <section className="viewer-thread" aria-label={known.title || "New thread"}>
          <PanelFrame value={{ crumbs: [{ label: known.title || "New thread", href: threadHref }], expand: threadHref, noReturn: true, ...(wide ? {} : { close: toggleThread }) }}>
            <Thread key={`${known.pool}/${known.id}`} ctx={ctx} pool={known.pool} threadId={known.id} threads={threads} />
          </PanelFrame>
        </section>
      )}
      <ErrorText error={error} />
      {children}
    </dialog>
  );
}

type Loaded = { kind: "loading" } | { kind: ViewKind; text?: string } | { kind: "error"; message: string };

/** The file itself: its header line, then what it shows as. */
function FilePane({ file, shownPath, contentUrl, viewUrl, actions, onDownload }: {
  file: ViewerFile; shownPath: string; contentUrl: string; viewUrl: string; actions: ReactNode; onDownload: () => void;
}) {
  const byName = viewKindOf(file.name);
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [source, setSource] = useState(false);
  useEffect(() => {
    let live = true;
    // Only text is read here; the rest is shown from its address. A name that says nothing is told by its type.
    const wantsText = byName === undefined || byName === "markdown" || byName === "html" || byName === "svg";
    if (!wantsText) { setState({ kind: byName }); return; }
    const ctl = new AbortController();
    fetch(contentUrl, { credentials: "same-origin", signal: ctl.signal }).then(async (r): Promise<Loaded> => {
      if (!r.ok) throw new Error(r.status === 404 ? "That file is gone." : (await r.json().catch(() => ({ error: "the file can't be read" })) as { error: string }).error);
      const type = r.headers.get("content-type") ?? "";
      const textual = type.startsWith("text/") || /json|xml|javascript|yaml|csv/.test(type);
      if (byName === undefined && type.startsWith("image/")) { ctl.abort(); return { kind: "image" }; }
      if (byName === undefined && (!textual || file.size > TEXT_LIMIT)) { ctl.abort(); return { kind: "other" }; }
      // An HTML or SVG page bigger than the text limit still shows; only its Source is missing.
      if (file.size > TEXT_LIMIT) { ctl.abort(); return { kind: byName ?? "other" }; }
      return { kind: byName ?? "text", text: await r.text() };
    }).then((s) => { if (live) setState(s); }, (e: Error) => { if (live && e.name !== "AbortError") setState({ kind: "error", message: e.message }); });
    return () => { live = false; ctl.abort(); };
  }, [contentUrl, byName, file.size]);

  const kind = state.kind === "loading" || state.kind === "error" ? byName : state.kind;
  const text = "text" in state ? state.text : undefined;
  const sourceable = !!kind && HAS_SOURCE.has(kind) && text !== undefined;
  const raw = sourceable && source;
  return (
    <section className="viewer-file" aria-label={shownPath}>
      <div className="viewer-head">
        <span className="fname mono" title={shownPath}>{shownPath}</span>
        <span className="viewer-facts muted">{kind ? KIND_WORD[kind] : "File"} · <span className="num">{size(file.size)}</span> · <span className="num" title={fullTime(file.modified)}>{shortTime(file.modified)}</span></span>
        <span className="viewer-acts">
          {sourceable && (
            <div className="seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>Preview</button>
              <button type="button" aria-pressed={source} onClick={() => setSource(true)}>Source</button>
            </div>
          )}
          {actions}
        </span>
      </div>
      <div className={`viewer-body${raw || kind === "text" || kind === "markdown" ? " viewer-scroll" : ""}`}>
        {state.kind === "loading" && <p className="empty">Loading…</p>}
        {state.kind === "error" && <ErrorText error={state.message} />}
        {state.kind !== "loading" && state.kind !== "error" && (raw ? <pre className="viewer-text">{text}</pre> : (
          <Shown kind={state.kind} file={file} text={text} contentUrl={contentUrl} viewUrl={viewUrl} onDownload={onDownload} />
        ))}
      </div>
    </section>
  );
}

function Shown({ kind, file, text, contentUrl, viewUrl, onDownload }: { kind: ViewKind; file: ViewerFile; text?: string; contentUrl: string; viewUrl: string; onDownload: () => void }) {
  switch (kind) {
    case "html": return <HtmlPage url={viewUrl} settingsUrl={contentUrl.replace(/\/files\/content\?.*$/, "/settings")} name={file.name} />;
    case "svg": return <div className="viewer-media"><img src={viewUrl} alt={file.name} /></div>;
    case "image": return <div className="viewer-media"><img src={contentUrl} alt={file.name} /></div>;
    // The browser's own PDF viewer; it won't show in a sandboxed frame, and the page route checks the bytes are a PDF's.
    case "pdf": return <iframe className="viewer-frame" src={viewUrl} title={file.name} />;
    case "audio": return <div className="viewer-media"><audio controls src={contentUrl} aria-label={file.name} /></div>;
    case "video": return <div className="viewer-media"><video controls src={contentUrl} aria-label={file.name} /></div>;
    case "markdown": return <div className="viewer-prose prose"><Prose text={text ?? ""} /></div>;
    case "text": return <pre className="viewer-text">{text || <span className="muted">Empty</span>}</pre>;
    default: return <p className="empty">This kind of file isn't shown here. <button type="button" className="link" onClick={onDownload}>Download</button></p>;
  }
}

/**
 * The page in a sandboxed frame (scripts and popups only: no same origin, no top navigation, no forms), and its
 * console. With the thread's internet off the route serves it with nothing run, and a muted line says so.
 */
function HtmlPage({ url, settingsUrl, name }: { url: string; settingsUrl: string; name: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const settings = useLoad(() => get<ThreadSettings>(settingsUrl), [settingsUrl]);
  const offline = settings.data?.network.internet === false;
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setLines([]);
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const line = consoleLine(e.data);
      if (line) setLines((l) => (l.length >= CONSOLE_LIMIT ? [...l.slice(1), line] : [...l, line]));
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [url]);
  return (
    <>
      {offline && <p className="viewer-note muted">Scripts don't run here: this thread's internet is off.</p>}
      <iframe ref={frame} className="viewer-frame" src={url} title={name} sandbox="allow-scripts allow-popups" referrerPolicy="no-referrer" />
      {lines.length > 0 && (
        <section className="viewer-console" aria-label="Console">
          <button type="button" className="viewer-console-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? "down" : "right"} /><span className="eyebrow">Console</span><span className="num muted">{lines.length}</span>
          </button>
          {open && (
            <ol className="viewer-console-lines">
              {lines.map((l, i) => <li key={i} className={`mono c-${l.level}`}>{l.text}</li>)}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
