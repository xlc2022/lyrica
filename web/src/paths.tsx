// Files named in a conversation (DESIGN, "Files and images"; docs/ux.md §6):
// a path under the thread's folder or /shared, and a markdown link to a file,
// opens the file in the Files panel, and an image she writes shows in the message.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";
import type { Element, Root, Text } from "hast";
import { threadPath, u, type Pool } from "./api.ts";
import { href } from "./route.ts";
import { RowMenu } from "./Machines.tsx";
import { ErrorText } from "./ui.tsx";

export const WORKDIR = "/workspace";
export const SHARED = "/shared";
/** A path as the panel shows it: the thread folder by name, its files without the prefix, a grant's as they are. */
export const shown = (p: string) => (p === WORKDIR ? "Thread folder" : p === SHARED ? "Shared folder" : p.startsWith(`${WORKDIR}/`) ? p.slice(WORKDIR.length + 1) : p);

/**
 * A path under the thread's folder or /shared, as written in prose: it starts the word (not inside `/home/ada/workspace`,
 * `~/workspace` or a URL) and ends before a space, a quote, a bracket or trailing punctuation.
 */
export const PATH = /(?<![\w.~/:-])\/(?:workspace|shared)(?:\/[^\s"'`<>()[\]{}|,;]*[^\s"'`<>()[\]{}|,;:.!?])?(?![\w-])/g;
/** Each path in a text, with where it starts. */
export const findPaths = (text: string): { path: string; at: number }[] => [...text.matchAll(PATH)].map((m) => ({ path: m[0], at: m.index }));
export const isUnderWorkdir = (p: string) => p === WORKDIR || p.startsWith(`${WORKDIR}/`);

/**
 * The file a markdown link or image names, as an absolute path, or nothing for a URL or an anchor: an absolute path
 * or `file://` URL as it is, a relative one against the thread's folder. The Files panel refuses what she can't reach.
 */
export function fileTarget(href: string | undefined): string | undefined {
  if (!href || /^(?:[#?]|\/\/)/.test(href)) return undefined;
  let p = href;
  if (/^file:\/\//i.test(p)) p = p.slice(7);
  else if (/^[a-z][a-z\d+.-]*:/i.test(p)) return undefined;
  p = p.replace(/[?#].*$/, "");
  try { p = decodeURIComponent(p); } catch { /* left as written */ }
  if (!p) return undefined;
  const parts: string[] = [];
  for (const s of (p.startsWith("/") ? p : `${WORKDIR}/${p}`).split("/")) {
    if (s === "..") parts.pop();
    else if (s && s !== ".") parts.push(s);
  }
  return `/${parts.join("/")}`;
}

/** Where a path in this thread leads: the Files panel with the file shown, the file's own bytes, and its thumbnail. */
export interface FileLinks {
  href: (path: string) => string;
  url: (path: string) => string;
  thumb: (path: string) => string;
  /** A remote image through lyricad, which serves only the offline copy of Wikipedia's (docs/ux.md §6). */
  picture?: (url: string) => string;
}

/** A remote image's address, as against a path. */
export const isRemote = (src: string) => /^https?:\/\//i.test(src);

/** What shows an image large: a remote one through lyricad, a file by its path. */
export const largeUrl = (files: FileLinks, path: string) => (isRemote(path) && files.picture ? files.picture(path) : files.url(path));

export function useFileLinks(userId: string, pool: Pool, threadId: string): FileLinks {
  return useMemo(() => ({
    href: (path) => href({ page: "files", userId, pool, threadId, ...(path === WORKDIR ? {} : { path }) }),
    url: (path) => `${threadPath(userId, pool, threadId)}/files/content?path=${encodeURIComponent(path)}`,
    thumb: (path) => `${threadPath(userId, pool, threadId)}/files/thumb?path=${encodeURIComponent(path)}`,
    picture: (url) => `${u(userId, "web", "picture")}?url=${encodeURIComponent(url)}`,
  }), [userId, pool, threadId]);
}

/** An image the web UI shows inline, by its extension (an SVG stays a link: `…/files/content` serves it as text). */
export const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(p);

/**
 * Plain text with each path under the thread's folder as a link. With `large`, an image's path shows as its
 * thumbnail instead, opening large (docs/ux.md §6, an uploaded image in the person's message); the line break after
 * the path goes with it, since an upload puts the path on a line of its own.
 */
export function PathText({ text, files, large }: { text: string; files: FileLinks; large?: (path: string) => void }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (large && isImagePath(m[0])) {
      out.push(<InlineImage key={m.index} src={m[0]} alt={basename(m[0])} label={basename(m[0])} files={files} large={large} />);
      if (text[last] === "\n") last++;
    } else out.push(<a key={m.index} className="fpath" href={files.href(m[0])}>{m[0]}</a>);
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</>;
}

/** A rehype plugin: each path in her prose becomes a link, except inside a link or a code block (a command stays a command). */
export function rehypePaths(files: FileLinks) {
  return () => (tree: Root) => { walk(tree, files); };
}

function walk(node: Root | Element, files: FileLinks) {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (c.type === "element") {
      if (c.tagName === "a" || c.tagName === "pre") continue;
      walk(c, files);
    } else if (c.type === "text" && (c.value.includes(WORKDIR) || c.value.includes(SHARED))) {
      const parts = split(c.value, files);
      if (parts) { children.splice(i, 1, ...parts); i += parts.length - 1; }
    }
  }
}

function split(value: string, files: FileLinks): (Element | Text)[] | undefined {
  const out: (Element | Text)[] = [];
  let last = 0;
  for (const m of value.matchAll(PATH)) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({ type: "element", tagName: "a", properties: { href: files.href(m[0]), className: ["fpath"] }, children: [{ type: "text", value: m[0] }] });
    last = m.index + m[0].length;
  }
  if (!out.length) return undefined;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** An image she can reach, shown in the message by its thumbnail and opened large on a click; any other image stays a link. */
export function InlineImage({ src, alt, label, files, large, onGone, onBroken }: { src: string; alt: string; label?: string; files: FileLinks; large: (path: string) => void; /** The file is gone. */ onGone?: () => void; /** It won't load for another reason. */ onBroken?: () => void }) {
  return (
    <button type="button" className="inline-img" onClick={() => large(src)} aria-label={label ?? `${alt || basename(src)}, open large`}>
      <Thumb path={src} alt={alt || basename(src)} files={files} onGone={onGone} onBroken={onBroken} />
    </button>
  );
}

/**
 * A remote image in her prose: shown, opening large, when lyricad serves it (a picture of the offline copy of
 * Wikipedia); otherwise, and until it has loaded, the link with its alt text. The browser asks only lyricad, never
 * the image's own host (docs/ux.md §6).
 */
export function RemotePicture({ url, alt, files, large }: { url: string; alt: string; files: FileLinks; large: (path: string) => void }) {
  const src = files.picture?.(url);
  // One that loaded before (the live message's copy, replaced by the stored one when the turn ends) shows at once.
  const [shown, setShown] = useState<boolean | undefined>(() => (src && loadedPictures.has(src) ? true : undefined));
  const name = basename(url.replace(/[?#].*$/, ""));
  const link = <a href={url} target="_blank" rel="noopener noreferrer">{alt || url}</a>;
  if (!src || shown === false) return link;
  return shown ? (
    <button type="button" className="inline-img" onClick={() => large(url)} aria-label={`${alt || name}, open large`}>
      <img src={src} alt={alt || name} />
    </button>
  ) : <>{link}<img src={src} alt="" hidden onLoad={() => { loadedPictures.add(src); setShown(true); }} onError={() => setShown(false)} /></>;
}
/** The pictures that have loaded in this page, by their lyricad address. */
const loadedPictures = new Set<string>();

/** The thumbnail, or the image itself where the server makes none. */
export function Thumb({ path, alt, files, onGone, onBroken }: { path: string; alt: string; files: FileLinks; /** Neither the thumbnail nor the image loads, and the server says the file isn't there. */ onGone?: () => void; /** Neither loads, for any other reason (refused, offline). */ onBroken?: () => void }) {
  const [full, setFull] = useState(false);
  // Both failing may only mean the network or the server is down: it's gone only when the server says so.
  const gone = () => void fetch(files.url(path)).then((r) => { void r.body?.cancel(); if (r.status === 404) onGone?.(); else onBroken?.(); }, () => onBroken?.());
  return <img src={full ? files.url(path) : files.thumb(path)} alt={alt} loading="lazy" onError={() => (full ? gone() : setFull(true))} />;
}

/**
 * A clip's tile: the poster kept as its thumbnail, or, where it has none (an uploaded clip), the clip's own first
 * frame, read from its metadata and never saved. A play mark sits over either.
 */
export function VideoThumb({ path, files }: { path: string; files: FileLinks }) {
  const [poster, setPoster] = useState(true);
  return (
    <span className="vthumb">
      {poster ? <img src={files.thumb(path)} alt="" loading="lazy" onError={() => setPoster(false)} />
        : <video src={`${files.url(path)}#t=0.1`} preload="metadata" muted playsInline aria-hidden="true" tabIndex={-1} />}
      <span className="vplay" aria-hidden="true"><Icon name="play" /></span>
    </span>
  );
}

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** An image shown large over the page; the Files panel's Images tab and a message's inline images share it. */
export function Lightbox({ path, url, onClose, onMenu, bare }: { path: string; url: string; onClose: () => void; bare?: boolean; onMenu?: (e: React.MouseEvent) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  const name = basename(path);
  return (
    <dialog ref={ref} className="lightbox" aria-label={name} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape" && menu) { e.preventDefault(); e.stopPropagation(); setMenu(false); } }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="fhead">
        <span className="fname mono">{bare ? name : shown(path)}</span>
        {onMenu ? <button type="button" className="icon sm" aria-label="Image actions" aria-haspopup="menu" onClick={onMenu}><Icon name="more" /></button>
          : <RowMenu label="Image actions" open={menu} onOpen={setMenu} items={[
            { label: "Download", onPick: () => { const a = document.createElement("a"); a.href = url; a.download = name; a.click(); } },
            { label: "Copy path", onPick: () => { void navigator.clipboard.writeText(path).catch((e: Error) => setError(e.message)); } },
          ]} />}
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="lb-img"><img src={url} alt={name} /></div>
      <ErrorText error={error} />
    </dialog>
  );
}
