// Each message's menu: branch, regenerate, edit and delete. Deleting waits a few seconds, so it can be undone.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRef, RewindRequest, ThreadSettings } from "./api.ts";
import { useDismiss } from "./ui.tsx";

/** What a thread lets its messages do. Absent in a subagent's thread. */
export interface Rewinder {
  settings?: ThreadSettings;
  busy: boolean;
  /** The last turn's user message: "Delete" removes from there. */
  lastTurn?: number;
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
      <button type="button" className="dots" aria-label="Message actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={act(() => rewinder.branch(n))}>Branch from here</button>
          {role === "assistant" && <button type="button" role="menuitem" disabled={busy} onClick={act(() => regenerate())}>Regenerate</button>}
          {role === "assistant" && (
            <button type="button" role="menuitem" disabled={busy} aria-expanded={models} onClick={() => setModels(!models)}>Regenerate with…</button>
          )}
          {models && rewinder.settings?.allowed.flatMap((ep) => ep.models.map((m) => (
            <button key={`${ep.id}/${m.modelId}`} type="button" role="menuitem" className="sub-item" disabled={busy}
              onClick={act(() => regenerate({ endpointId: ep.id, modelId: m.modelId }))}>
              {m.modelId} <span className="muted">· {ep.name}</span>
            </button>
          )))}
          {role === "user" && onEdit && <button type="button" role="menuitem" disabled={busy} onClick={act(onEdit)}>Edit</button>}
          {inLastTurn && <button type="button" role="menuitem" disabled={busy} onClick={act(() => rewinder.rewind(lastTurn, { action: "delete" }, lastTurn))}>Delete</button>}
          {!(inLastTurn && n === lastTurn) && (
            <button type="button" role="menuitem" disabled={busy} onClick={act(() => rewinder.rewind(n, { action: "delete" }, n))}>Delete from here</button>
          )}
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
        <button type="submit" className="primary" disabled={!value.trim()}>Send</button>
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
