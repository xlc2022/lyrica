// Each message's menu: pin, branch, regenerate, edit and delete. Deleting waits a few seconds, so it can be undone.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRef, Pins, RewindRequest, ThreadSettings } from "./api.ts";
import { useDismiss } from "./ui.tsx";

/** What a thread lets its messages do. Absent in a subagent's thread. */
export interface Rewinder {
  settings?: ThreadSettings;
  busy: boolean;
  /** The last turn's user message: "Delete" removes from there. */
  lastTurn?: number;
  /** The pinned messages' numbers. */
  pinned: ReadonlySet<number>;
  pin(n: number, on: boolean): void;
  branch(n: number): void;
  /** Removes from message `n` (and sends again, for regenerate and edit). Messages from `hide` on are hidden meanwhile. */
  rewind(n: number, req: RewindRequest, hide: number): void;
}

export function MessageMenu({ n, role, rewinder, onEdit }: { n: number; role: "user" | "assistant"; rewinder: Rewinder; onEdit?: () => void }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => { setOpen(false); setModels(false); }, []);
  useDismiss(ref, open, close);
  const { busy, lastTurn } = rewinder;
  const act = (fn: () => void) => () => { close(); fn(); };
  const regenerate = (model?: ModelRef) => rewinder.rewind(n, { action: "regenerate", ...(model ? { model } : {}) }, n);
  const inLastTurn = lastTurn !== undefined && n >= lastTurn;
  return (
    <span className="msg-menu" ref={ref}>
      <button type="button" className="icon-btn" aria-label="Message actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
      </button>
      {open && (
        <div className="menu" role="menu">
          {rewinder.pinned.has(n)
            ? <button type="button" role="menuitem" onClick={act(() => rewinder.pin(n, false))}>Unpin</button>
            : <button type="button" role="menuitem" onClick={act(() => rewinder.pin(n, true))}>Pin</button>}
          <button type="button" role="menuitem" onClick={act(() => rewinder.branch(n))}>Branch from here</button>
          {role === "assistant" && <button type="button" role="menuitem" disabled={busy} onClick={act(() => regenerate())}>Regenerate</button>}
          {role === "assistant" && (
            <button type="button" role="menuitem" disabled={busy} aria-expanded={models} onClick={() => setModels(!models)}>Regenerate with…</button>
          )}
          {models && rewinder.settings?.allowed.flatMap((ep) => ep.models.map((m) => (
            <button key={m.id} type="button" role="menuitem" className="sub-item" disabled={busy}
              onClick={act(() => regenerate({ offeringId: m.id }))}>
              {m.modelId} <span className="muted">· {ep.name}</span>
            </button>
          )))}
          {role === "user" && onEdit && <button type="button" role="menuitem" disabled={busy} onClick={act(onEdit)}>Edit</button>}
          {/* The last turn has Delete; earlier messages, Delete from here. */}
          {inLastTurn
            ? <button type="button" role="menuitem" className="danger" disabled={busy} onClick={act(() => rewinder.rewind(lastTurn, { action: "delete" }, lastTurn))}>Delete</button>
            : <button type="button" role="menuitem" className="danger" disabled={busy} onClick={act(() => rewinder.rewind(n, { action: "delete" }, n))}>Delete from here</button>}
        </div>
      )}
    </span>
  );
}

/** Editing one of the user's messages in place: the edited text is sent, and what followed is replaced. */
export function EditBox({ text, onSend, onCancel }: { text: string; onSend: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  return (
    <form className="edit-box" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSend(value); }}>
      <textarea rows={3} aria-label="Edit your message" value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button type="submit" disabled={!value.trim()}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const UNDO_MS = 5000;

/**
 * Removal waits a few seconds before the request goes, so Undo is just not
 * sending it. Leaving the thread sends it at once.
 */
export function useUndo() {
  const [pending, setPending] = useState<{ hide: number; label: string }>();
  const next = useRef<{ go: () => void; timer: ReturnType<typeof setTimeout> }>(undefined);
  const flush = useCallback(() => {
    const p = next.current;
    if (!p) return;
    next.current = undefined;
    clearTimeout(p.timer);
    setPending(undefined);
    p.go();
  }, []);
  useEffect(() => flush, [flush]);
  const later = useCallback((label: string, hide: number, go: () => void) => {
    flush();
    next.current = { go, timer: setTimeout(flush, UNDO_MS) };
    setPending({ hide, label });
  }, [flush]);
  const undo = useCallback(() => {
    if (next.current) clearTimeout(next.current.timer);
    next.current = undefined;
    setPending(undefined);
  }, []);
  return { pending, later, undo };
}

/** "3 pinned ▾" in the thread's header: a popover of the pinned messages, each going to its place in the conversation. */
export function PinnedBadge({ pins }: { pins: Pins }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  if (!pins.pins.length) return null;
  const show = (n: number) => { close(); document.getElementById(`m-${n}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); };
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="badge" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        title={pins.shortened ? "Some pinned messages reach her as their first line only" : undefined}>
        {pins.pins.length} pinned{pins.shortened && <span className="warn"> · shortened</span>} ▾
      </button>
      {open && (
        <div className="picker" role="dialog" aria-label="Pinned">
          {pins.pins.map((p) => (
            <button key={p.n} type="button" className="picker-item pin-item" onClick={() => show(p.n)}>
              <span className="muted">{p.role === "user" ? "You" : "Lyrica"} · </span>{p.text.length > 140 ? `${p.text.slice(0, 140)}…` : p.text}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
