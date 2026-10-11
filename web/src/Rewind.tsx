// Each message's menu: pin, branch, regenerate, edit and delete. Deleting waits a few seconds, so it can be undone.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRef, Pins, Pool, RemovalPlan, RewindRequest, ThreadSettings } from "./api.ts";
import { useMentionText } from "./mentions.ts";
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
export function PinnedBadge({ pins, you, userId, pool }: { pins: Pins; you: string; userId: string; pool: Pool }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  if (!pins.pins.length) return null;
  const show = (n: number) => {
    close();
    const el = document.getElementById(`m-${n}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    // Where it landed, for a moment.
    el?.classList.remove("flash");
    void el?.offsetWidth;
    el?.classList.add("flash");
  };
  return (
    <span className="picker-anchor" ref={anchor}>
      <button type="button" className="badge" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        title={pins.shortened ? "Some pinned messages reach her as their first line only" : undefined}>
        <span className="num">{pins.pins.length}</span>&nbsp;pinned{pins.shortened && <span className="warn"> · shortened</span>} ▾
      </button>
      {open && (
        <div className="picker" role="dialog" aria-label="Pinned">
          {pins.pins.map((p) => (
            <button key={p.n} type="button" className="picker-item pin-item" onClick={() => show(p.n)}>
              <span className="muted">{p.role === "user" ? you : "Lyrica"} · </span><PinPreview text={p.text} userId={userId} pool={pool} />
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Whether a removal has anything to confirm: files, branches, commands, pins or subagents. */
/** One or two lines: the first line, threads she mentions by their current title, at most about 90 characters. */
function PinPreview({ text, userId, pool }: { text: string; userId: string; pool: Pool }) {
  const first = useMentionText(text.trim().split("\n")[0]!, userId, pool);
  return <>{first.length > 90 ? `${first.slice(0, 90)}…` : first}</>;
}

export function hasConsequences(p: RemovalPlan): boolean {
  return p.files.length + p.branches.length + p.commands.length + p.pins + p.subagents > 0;
}

/**
 * Before turns that did things are removed: what goes with them, each undo
 * ticked by default and untickable. Files changed since, and branches with
 * commits of their own, are listed but kept unless ticked.
 */
export function RemovalConfirm({ plan, onConfirm, onCancel }: { plan: RemovalPlan; onConfirm: (skip: string[]) => void; onCancel: () => void }) {
  const [ticked, setTicked] = useState(() => new Set([...plan.files, ...plan.branches].filter((x) => x.ticked).map((x) => x.id)));
  const toggle = (id: string, on: boolean) => setTicked((t) => { const n = new Set(t); if (on) n.add(id); else n.delete(id); return n; });
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onCancel);
  const undoable = [...plan.files.filter((f) => f.action !== "keep"), ...plan.branches];
  const kept = plan.files.filter((f) => f.action === "keep");
  const num = (n: number) => <span className="num">{n}</span>;
  return (
    <div className="confirm removal" role="group" aria-label="Remove messages" ref={ref}>
      {/* The one sentence Remove answers; the lists' headings say the rest. */}
      <p>
        Remove {num(plan.messages)} {plan.messages === 1 ? "message" : "messages"}
        {plan.subagents > 0 && <> and {num(plan.subagents)} {plan.subagents === 1 ? "subagent thread" : "subagent threads"}</>}?
        {plan.pins > 0 && <> {num(plan.pins)} {plan.pins === 1 ? "is" : "are"} pinned.</>}
      </p>
      {undoable.length > 0 && (
        <div className="removal-list">
          <h4 title="Untick to keep">Undone</h4>
          {plan.files.filter((f) => f.action !== "keep").map((f) => (
            <label key={f.id} className="check">
              <input type="checkbox" checked={ticked.has(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} />
              <span>{f.action === "delete" ? "Delete" : "Put back"} <code>{f.path}</code></span>
            </label>
          ))}
          {plan.branches.map((b) => (
            <label key={b.id} className="check">
              <input type="checkbox" checked={ticked.has(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} />
              <span>Delete branch <code>{b.branch}</code> in <code>{b.repo}</code>{b.commits && <span className="badge" title="It has commits no other branch has">has commits</span>}</span>
            </label>
          ))}
        </div>
      )}
      {kept.length > 0 && (
        <div className="removal-list">
          <h4>Kept</h4>
          {kept.map((f) => (
            <div key={f.id} className="kept">
              <code>{f.path}</code>
              <span className="badge" title={f.reason === "changed since" ? "Something else changed it since" : "This thread's files can't be reached now"}>{f.reason}</span>
            </div>
          ))}
        </div>
      )}
      {plan.commands.length > 0 && (
        <div className="removal-list">
          <h4 title="What commands changed isn't tracked">Not undone</h4>
          <details className="removal-commands">
            <summary>{num(plan.commands.length)} {plan.commands.length === 1 ? "command" : "commands"} ▾</summary>
            {plan.commands.map((c, i) => <code key={i}>{c}</code>)}
          </details>
        </div>
      )}
      <div className="row">
        <button type="button" className="danger solid" onClick={() => onConfirm([...plan.files, ...plan.branches].filter((x) => !ticked.has(x.id)).map((x) => x.id))}>Remove</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
