// Small pieces shared by every page.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { InlineImage, isUnderWorkdir, Lightbox, rehypePaths, type FileLinks } from "./paths.tsx";
import type { Display, Pool } from "./api.ts";

/** Whether the display filters hide a pool. Hiding only changes what's shown. */
export const hidden = (d: Display, pool: Pool) => (pool === "private" ? !d.showPrivate : !d.showGeneral);

/** Runs a request, tracking whether it's in flight and its error in plain words. */
export function useAction(): [(fn: () => Promise<unknown>) => Promise<boolean>, boolean, string] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); return true; } catch (e) { if (alive.current) setError((e as Error).message); return false; } finally { if (alive.current) setBusy(false); }
  }, []);
  return [run, busy, error];
}

/** Loads something, and reloads when `deps` change or `reload()` is called. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error: string; reload: () => void; set: (t: T) => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => { if (live) { setData(d); setError(""); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []), set: setData };
}

/** Closes a popup on Escape or a click outside `ref`. */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const click = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", click);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", click); };
  }, [ref, open, close]);
}

/** Arrow keys move between a menu's items (WCAG 2.1.1); Home and End jump to the ends. Returns whether the key was taken. */
export function menuArrows(e: KeyboardEvent, menu: HTMLElement | null): boolean {
  if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return false;
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  if (!items.length) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  e.preventDefault();
  items[next]!.focus();
  return true;
}

export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

/** A switch with a label; a hint is its tooltip, never a caption (docs/ux.md §4). */
export function Switch({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="switch" title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Asks before doing something that can't be undone, in place rather than in a browser dialog. */
/** A control that asks before it acts, in place. `option` adds one checkbox (ticked by default); `onConfirm` gets its state. */
export function Confirm({ label, question, confirm, danger, option, onConfirm }: {
  label: string; question: string; confirm: string; danger?: boolean; option?: string; onConfirm: (option: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(true);
  if (!open) return <button type="button" className={danger ? "danger" : ""} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="confirm" role="group" aria-label={label}>
      <p>{question}</p>
      {option && <label className="check"><input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />{" "}{option}</label>}
      <div className="row">
        <button type="button" className={danger ? "danger solid" : "primary"} onClick={() => { setOpen(false); onConfirm(!!option && ticked); }}>{confirm}</button>
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export const shortTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/**
 * Links open in a new tab, except Lyrica's own (a mentioned thread, a file of the thread). A remote image is never
 * loaded, only linked by its alt text; one from the thread's folder shows in the message and opens large (docs/ux.md §6).
 */
function markdown(files: FileLinks | undefined, large: (path: string) => void): Components {
  return {
    a: ({ node: _, ...props }) => (props.href?.startsWith("#/") ? <a {...props} /> : <a {...props} target="_blank" rel="noopener noreferrer" />),
    img: ({ src, alt }) => (typeof src !== "string" || !src ? <>{alt}</>
      : files && isUnderWorkdir(src) ? <InlineImage src={src} alt={alt ?? ""} files={files} large={large} />
      : <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a>),
  };
}
const PLAIN = markdown(undefined, () => {});

/** Markdown with raw HTML skipped; with `files`, the thread's paths are links and its images show. */
export function Prose({ text, files }: { text: string; files?: FileLinks }) {
  const [large, setLarge] = useState<string>();
  const components = useMemo(() => (files ? markdown(files, setLarge) : PLAIN), [files]);
  const plugins = useMemo(() => (files ? [rehypePaths(files)] : []), [files]);
  return (
    <>
      <Markdown skipHtml components={components} rehypePlugins={plugins}>{text}</Markdown>
      {large && files && <Lightbox path={large} url={files.url(large)} onClose={() => setLarge(undefined)} />}
    </>
  );
}

/**
 * A dialog confirms an action with a consequence: the sentence and two buttons (docs/ux.md §6).
 * `option` adds one checkbox, ticked by default; `onConfirm` gets its state.
 */
export function ConfirmDialog({ title, sentence, confirm, danger, option, onConfirm, onCancel }: {
  title: string; sentence: string; confirm: string; danger?: boolean; option?: string; onConfirm: (option: boolean) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [ticked, setTicked] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="confirm-title" onCancel={(e) => { e.preventDefault(); onCancel(); }} onClick={(e) => { if (e.target === ref.current) onCancel(); }}
      onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}>
      <form method="dialog" className="dlg" onSubmit={(e) => { e.preventDefault(); onConfirm(!!option && ticked); }}>
        <h2 id="confirm-title">{title}</h2>
        <p>{sentence}</p>
        {option && <label className="check"><input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />{" "}{option}</label>}
        <div className="dlg-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className={danger ? "danger primary" : "primary"} autoFocus>{confirm}</button>
        </div>
      </form>
    </dialog>
  );
}

/** The current minute, for clocks in headers. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
