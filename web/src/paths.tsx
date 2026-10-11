// Files named in a conversation (DESIGN, "Files and images"; docs/ux.md §6):
// a path under the thread's folder is a link that opens the file in the
// Files panel, and an image she writes from there shows in the message.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";
import type { Element, Root, Text } from "hast";
import { threadPath, type Pool } from "./api.ts";
import { href } from "./route.ts";

export const WORKDIR = "/workspace";
/** A path as the panel shows it: the thread folder by name, its files without the prefix, a grant's as they are. */
export const shown = (p: string) => (p === WORKDIR ? "Thread folder" : p.startsWith(`${WORKDIR}/`) ? p.slice(WORKDIR.length + 1) : p);

/**
 * A path under the thread's folder, as written in prose: it starts the word (not inside `/home/li/workspace`,
 * `~/workspace` or a URL) and ends before a space, a quote, a bracket or trailing punctuation.
 */
export const PATH = /(?<![\w.~/:-])\/workspace(?:\/[^\s"'`<>()[\]{}|,;]*[^\s"'`<>()[\]{}|,;:.!?])?(?![\w-])/g;
/** Each path in a text, with where it starts. */
export const findPaths = (text: string): { path: string; at: number }[] => [...text.matchAll(PATH)].map((m) => ({ path: m[0], at: m.index }));
export const isUnderWorkdir = (p: string) => p === WORKDIR || p.startsWith(`${WORKDIR}/`);

/** Where a path in this thread leads: the Files panel with the file shown, the file's own bytes, and its thumbnail. */
export interface FileLinks {
  href: (path: string) => string;
  url: (path: string) => string;
  thumb: (path: string) => string;
}

export function useFileLinks(userId: string, pool: Pool, threadId: string): FileLinks {
  return useMemo(() => ({
    href: (path) => href({ page: "files", userId, pool, threadId, ...(path === WORKDIR ? {} : { path }) }),
    url: (path) => `${threadPath(userId, pool, threadId)}/files/content?path=${encodeURIComponent(path)}`,
    thumb: (path) => `${threadPath(userId, pool, threadId)}/files/thumb?path=${encodeURIComponent(path)}`,
  }), [userId, pool, threadId]);
}

/** Plain text with each path under the thread's folder as a link. */
export function PathText({ text, files }: { text: string; files: FileLinks }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<a key={m.index} className="fpath" href={files.href(m[0])}>{m[0]}</a>);
    last = m.index + m[0].length;
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
    } else if (c.type === "text" && c.value.includes(WORKDIR)) {
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

/** An image from the thread's folder, shown in the message by its thumbnail and opened large on a click; any other image stays a link. */
export function InlineImage({ src, alt, files, large }: { src: string; alt: string; files: FileLinks; large: (path: string) => void }) {
  return (
    <button type="button" className="inline-img" onClick={() => large(src)} aria-label={`${alt || basename(src)}, open large`}>
      <Thumb path={src} alt={alt || basename(src)} files={files} />
    </button>
  );
}

/** The thumbnail, or the image itself where the server makes none. */
export function Thumb({ path, alt, files }: { path: string; alt: string; files: FileLinks }) {
  const [full, setFull] = useState(false);
  return <img src={full ? files.url(path) : files.thumb(path)} alt={alt} loading="lazy" onError={() => setFull(true)} />;
}

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** An image shown large over the page; the Files panel's Images tab and a message's inline images share it. */
export function Lightbox({ path, url, onClose, onMenu }: { path: string; url: string; onClose: () => void; onMenu?: (e: React.MouseEvent) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  const name = basename(path);
  return (
    <dialog ref={ref} className="lightbox" aria-label={name} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="fhead">
        <span className="fname mono">{shown(path)}</span>
        {onMenu && <button type="button" className="icon sm" aria-label="Image actions" aria-haspopup="menu" onClick={onMenu}><Icon name="more" /></button>}
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="lb-img"><img src={url} alt={name} /></div>
    </dialog>
  );
}
