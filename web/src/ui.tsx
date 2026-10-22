// Small pieces shared by every page.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock.tsx";
import { Icon } from "./icons.tsx";
import { basename, fileTarget, InlineImage, Lightbox, rehypePaths, type FileLinks } from "./paths.tsx";
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

/**
 * A name edited in place after a double-click (docs/ux.md §6, "Renaming in place"): the field takes the
 * name's spot with it selected; Enter or leaving the field saves a changed name, Escape or an unchanged one
 * puts the name back. Clicks inside it never reach the row or link around it.
 */
export function InlineRename({ value, label, className, onSave, onDone }: { value: string; label: string; className?: string; onSave: (name: string) => Promise<unknown>; onDone: () => void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (save && name && name !== value) void onSave(name).finally(onDone);
    else onDone();
  };
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); if ("preventDefault" in e && (e.type === "click" || e.type === "dblclick")) e.preventDefault(); };
  return (
    <input className={className ? `rename ${className}` : "rename"} autoFocus aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()} onBlur={() => finish(true)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
      onClick={stop} onDoubleClick={stop} onPointerDown={stop} onContextMenu={stop} />
  );
}

export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

/** One line at the foot of the screen about what just happened, with Dismiss; `after` takes it away by itself (ms). */
export function Toast({ text, after, onClose }: { text: string; after?: number; onClose: () => void }) {
  useEffect(() => {
    if (!after) return;
    const t = setTimeout(onClose, after);
    return () => clearTimeout(t);
  }, [after, onClose]);
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      <button type="button" className="icon sm" aria-label="Dismiss" onClick={onClose}><Icon name="close" /></button>
    </div>
  );
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
/** A checkbox in a confirm: its words and whether it starts ticked. */
export interface ConfirmOption { label: string; ticked: boolean }

/** The ticked state of a confirm's options, starting from their defaults. */
function useTicks(options: ConfirmOption[] | undefined): [boolean[], (i: number, v: boolean) => void] {
  const [ticks, setTicks] = useState(() => (options ?? []).map((o) => o.ticked));
  return [ticks, (i, v) => setTicks((t) => t.map((x, j) => (j === i ? v : x)))];
}

function Options({ options, ticks, set }: { options?: ConfirmOption[]; ticks: boolean[]; set: (i: number, v: boolean) => void }) {
  return <>{options?.map((o, i) => (
    <label key={o.label} className="check"><input type="checkbox" checked={ticks[i] ?? o.ticked} onChange={(e) => set(i, e.target.checked)} />{" "}{o.label}</label>
  ))}</>;
}

/** A control that asks before it acts, in place. `options` add checkboxes, each with its own default; `onConfirm` gets their states. `question` may follow them. */
export function Confirm({ label, question, confirm, danger, options, onConfirm }: {
  label: string; question: string | ((ticked: boolean[]) => string); confirm: string; danger?: boolean; options?: ConfirmOption[]; onConfirm: (ticked: boolean[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ticks, set] = useTicks(options);
  if (!open) return <button type="button" className={danger ? "danger" : ""} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="confirm" role="group" aria-label={label}>
      <p>{typeof question === "function" ? question(ticks) : question}</p>
      <Options options={options} ticks={ticks} set={set} />
      <div className="row">
        <button type="button" className={danger ? "danger solid" : "primary"} onClick={() => { setOpen(false); onConfirm(ticks); }}>{confirm}</button>
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// Every time the app shows is in the user's own time zone (Settings → Profile), not the browser's.
let zone: string | undefined;
/** The shell sets it from Me before each render; undefined is the browser's own. */
export function setTimeZone(z: string | undefined): void { zone = z; }
/** The zone times show in. */
export const timeZone = (): string => zone ?? browserZone();
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** toLocaleDateString in the user's zone and the reader's locale. */
export const dateText = (at: string | number | Date, opts: Intl.DateTimeFormatOptions): string => new Date(at).toLocaleDateString([], { ...opts, timeZone: timeZone() });

/** A moment's calendar day in the user's zone, as days since 1970, to compare and count days. */
export function dayNumber(at: string | number | Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timeZone(), year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 864e5;
}

/** The hour of the day, 0–23, in the user's zone. */
export const hourOf = (at: string | number | Date): number =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: timeZone(), hour: "numeric", hourCycle: "h23" }).format(new Date(at))) % 24;

/** A time of day as 24-hour HH:MM, as every time in the app is shown (docs/ux.md, "When a message was sent"). */
export function clock(at: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

export const shortTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  if (dayNumber(d) === dayNumber(now)) return clock(d);
  if (now.getTime() - d.getTime() < 6 * 864e5) return dateText(d, { weekday: "short" });
  return dateText(d, { day: "numeric", month: "short" });
};

/** A wake-up's time in local HH:MM, with the date before it when it isn't today (docs/ux.md §6). */
export function wakeTime(iso: string): string {
  const d = new Date(iso);
  const hm = clock(d);
  return dayNumber(d) === dayNumber(new Date()) ? hm : `${dateText(d, { day: "numeric", month: "short" })} ${hm}`;
}

/** A time in full, for a tooltip: the weekday, date and 24-hour time in the reader's locale. */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timeZone() });
}

/**
 * Links open in a new tab, except Lyrica's own (a mentioned thread, a file she can reach). A link to a file, by its
 * absolute path or relative to the thread's folder, opens it in the Files panel. A remote image is never loaded, only
 * linked by its alt text; a file's shows in the message and opens large (docs/ux.md §6).
 */
function markdown(files: FileLinks | undefined, large: (path: string) => void, skip?: ReadonlySet<string>): Components {
  return {
    a: ({ node: _, ...props }) => {
      if (props.href?.startsWith("#/")) return <a {...props} />;
      const file = files && fileTarget(props.href);
      // Mono only when the link's text is the path itself; words stay prose.
      const path = typeof props.children === "string" && props.children.startsWith("/");
      return file ? <a {...props} className={path ? "fpath" : undefined} href={files.href(file)} title={file} /> : <a {...props} target="_blank" rel="noopener noreferrer" />;
    },
    img: ({ src, alt }) => {
      if (typeof src !== "string" || !src) return <>{alt}</>;
      const file = files && fileTarget(src);
      // An image already shown in this turn (an image part's) stays a link to it, so it isn't shown twice.
      return file && files && skip?.has(file) ? <a className="fpath" href={files.href(file)}>{alt || basename(file)}</a>
        : file && files ? <InlineImage src={file} alt={alt ?? ""} files={files} large={large} />
        : <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a>;
    },
  };
}
const PLAIN = markdown(undefined, () => {});

/**
 * Markdown with raw HTML skipped; with `files`, the thread's paths are links and its images show. `onLarge` lets the
 * caller hold the opened image: a message's prose is replaced when its stored copy arrives, which would close a
 * lightbox whose state lived here. `a` draws the links instead (a memory's titled citations). `copyCode` gives each
 * fenced block its language and Copy (a message's prose, docs/ux.md §6); the other pages' code blocks stay as they are.
 */
export function Prose({ text, files, onLarge, a, copyCode, skipImages }: { text: string; files?: FileLinks; onLarge?: (path: string) => void; a?: Components["a"]; copyCode?: boolean; /** Images of the thread's shown already, kept as links. */ skipImages?: ReadonlySet<string> }) {
  const [large, setLarge] = useState<string>();
  const open = onLarge ?? setLarge;
  const components = useMemo(() => ({ ...(files ? markdown(files, open, skipImages) : PLAIN), ...(a ? { a } : {}), ...(copyCode ? { pre: CodeBlock } : {}) }), [files, open, a, copyCode, skipImages]);
  const plugins = useMemo(() => (files ? [rehypePaths(files)] : []), [files]);
  return (
    <>
      <Markdown skipHtml components={components} rehypePlugins={plugins}>{text}</Markdown>
      {large && files && createPortal(<Lightbox path={large} url={files.url(large)} onClose={() => setLarge(undefined)} />, document.body)}
    </>
  );
}

/**
 * A dialog confirms an action with a consequence: the sentence and two buttons (docs/ux.md §6).
 * `options` add checkboxes, each with its own default, in order; `sentence` may follow their state; `onConfirm` gets their states.
 */
export function ConfirmDialog({ title, commit, sentence, confirm, cancel, danger, options, onConfirm, onCancel }: {
  title: string; /** A commit in mono after the title (Roll back). */ commit?: string; sentence: string | ((ticked: boolean[]) => string); confirm: string; /** The cancel button's word; default Cancel. */ cancel?: string;
  danger?: boolean; options?: ConfirmOption[]; onConfirm: (ticked: boolean[]) => void; onCancel: () => void;
}) {
  const [ticks, set] = useTicks(options);
  return (
    <Dialog labelledBy="confirm-title" onCancel={onCancel} onSubmit={() => onConfirm(ticks)}>
      <h2 id="confirm-title">{title}{commit && <> <span className="mono dlg-commit">{commit}</span></>}</h2>
      <p>{typeof sentence === "function" ? sentence(ticks) : sentence}</p>
      <Options options={options} ticks={ticks} set={set} />
      <div className="dlg-actions">
        <button type="button" onClick={onCancel}>{cancel ?? "Cancel"}</button>
        <button type="submit" className={danger ? "danger primary" : "primary"} autoFocus>{confirm}</button>
      </div>
    </Dialog>
  );
}

/** A modal dialog around one form: Escape and a click outside it cancel, and submitting it is its action. */
export function Dialog({ labelledBy, className, onCancel, onSubmit, children }: {
  labelledBy: string; className?: string; onCancel: () => void; onSubmit: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} className={className} aria-labelledby={labelledBy} onCancel={(e) => { e.preventDefault(); onCancel(); }} onClick={(e) => { if (e.target === ref.current) onCancel(); }}
      onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}>
      <form method="dialog" className="dlg" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{children}</form>
    </dialog>
  );
}

/**
 * Choosing several rows (docs/ux.md §6, the Files panel and To review): Ctrl- or Cmd-click adds a row or takes it
 * away, Shift-click takes every row between it and the last one picked. `pick` says whether the click chose; a plain
 * click clears the selection and is left to the row. `order` is the rows as shown.
 */
export function useSelection(order: string[]) {
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const last = useRef<string>(undefined);
  const toggle = (key: string) => {
    setSel((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    last.current = key;
  };
  const pick = (e: React.MouseEvent, key: string) => {
    if (e.shiftKey && last.current) {
      const a = order.indexOf(last.current), b = order.indexOf(key);
      if (a >= 0 && b >= 0) { setSel((s) => new Set([...s, ...order.slice(Math.min(a, b), Math.max(a, b) + 1)])); return true; }
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey) { toggle(key); return true; }
    last.current = key;
    if (sel.size) setSel(new Set());
    return false;
  };
  return { sel, setSel, pick, toggle };
}

/**
 * A long press on a touch screen does what a right-click does: `open` gets where the finger was, and the click after
 * it is swallowed. `skip` leaves a press alone (one on a button inside the thing).
 */
export function useLongPress() {
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback((open: (at: { clientX: number; clientY: number }) => void, skip?: (e: React.PointerEvent) => boolean) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" || skip?.(e)) return;
      held.current = false;
      clearTimeout(timer.current);
      const { clientX, clientY } = e;
      timer.current = setTimeout(() => { held.current = true; open({ clientX, clientY }); }, 500);
    },
    onPointerUp: () => clearTimeout(timer.current),
    onPointerMove: () => clearTimeout(timer.current),
    onPointerCancel: () => clearTimeout(timer.current),
    onClickCapture: (e: React.MouseEvent) => { if (held.current) { e.preventDefault(); e.stopPropagation(); held.current = false; } },
  }), []);
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
