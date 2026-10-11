// A thread's menu in the sidebar (docs/ux.md §6): right-click, or a long press
// on a phone, with a letter shortcut for each item. Mark as unread, Rename,
// Move to group, Hide and Delete. Pin and Share with come with their back ends.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { del, patch, post, threadPath, u, type ThreadGroup, type ThreadSummary } from "./api.ts";
import { go, type Route } from "./route.ts";
import { ConfirmDialog, ErrorText } from "./ui.tsx";

export interface MenuAt { x: number; y: number; thread: ThreadSummary }

/** Opens the menu from a right-click, or from a press held for half a second. The click after a long press is swallowed. */
export function useThreadMenu() {
  const [at, setAt] = useState<MenuAt>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const handlers = (thread: ThreadSummary) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setAt({ x: e.clientX, y: e.clientY, thread }); },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      held.current = false;
      clearTimeout(timer.current);
      const { clientX: x, clientY: y } = e;
      timer.current = setTimeout(() => { held.current = true; setAt({ x, y, thread }); }, 500);
    },
    onPointerUp: () => clearTimeout(timer.current),
    onPointerMove: () => clearTimeout(timer.current),
    onPointerCancel: () => clearTimeout(timer.current),
    onClick: (e: React.MouseEvent) => { if (held.current) { e.preventDefault(); held.current = false; } },
  });
  return { at, close: () => setAt(undefined), handlers };
}

function Item({ label, kbd, danger, sub, onClick }: { label: ReactNode; kbd?: string; danger?: boolean; sub?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={`${danger ? "danger" : ""}${sub ? " has-sub" : ""}`} data-key={kbd} onClick={onClick}>
      <span>{label}</span>{kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

export function ThreadMenu({ at, userId, route, groups, onGroups, onChange, onClose }: {
  at: MenuAt; userId: string; route: Route; groups: ThreadGroup[];
  /** The groups changed (one was made). */
  onGroups: () => void;
  /** The thread changed; the list reloads. */
  onChange: () => void;
  onClose: () => void;
}) {
  const t = at.thread;
  const base = threadPath(userId, t.pool, t.id);
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<"" | "group" | "rename" | "newgroup" | "delete">("");
  const [draft, setDraft] = useState(t.title ?? "");
  const [error, setError] = useState("");
  const children = t.children.length;

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - r.height - 8))}px`;
  }, [at, sub, groups.length, error]);
  // Escape closes the topmost thing; a click elsewhere closes the menu; letters pick items.
  useEffect(() => {
    if (sub === "delete") return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (sub) setSub(""); else onClose(); return; }
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const btn = ref.current?.querySelector<HTMLButtonElement>(`button[data-key="${e.key.toUpperCase()}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    };
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", down);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", down); };
  }, [sub, onClose]);
  useEffect(() => { if (!sub) ref.current?.querySelector("button")?.focus(); }, [sub]);

  const act = (fn: () => Promise<unknown>) => fn().then(() => { onChange(); onClose(); }, (e: Error) => setError(e.message));
  const change = (c: { title?: string; hidden?: boolean; group?: string | null; unread?: boolean }) => act(() => patch(base, c));
  const forget = (withChildren: boolean) => act(async () => {
    await del(base, { children: withChildren });
    // The open thread is gone: leave it.
    if (route.page === "thread" && route.threadId === t.id) go({ page: "home", userId });
  });

  if (sub === "delete") {
    return (
      <ConfirmDialog title="Delete this thread?" danger confirm="Delete" onCancel={onClose} onConfirm={forget}
        sentence="Its messages are deleted, and so is what Lyrica learned only from it. This can't be undone."
        {...(children > 0 ? { option: `Also delete its ${children === 1 ? "child thread" : `${children} child threads`}` } : {})} />
    );
  }
  let body: ReactNode;
  if (sub === "group") {
    body = (
      <>
        <button type="button" className="back" onClick={() => setSub("")}>‹ Move to group</button>
        {groups.map((g) => <Item key={g.id} label={<>{t.group === g.id ? "✓ " : ""}{g.name}</>} onClick={() => change({ group: t.group === g.id ? null : g.id })} />)}
        {t.group && <Item label="Not in a group" onClick={() => change({ group: null })} />}
        {groups.length > 0 && <div className="sep" role="separator" />}
        <Item label="New group…" kbd="N" onClick={() => { setDraft(""); setSub("newgroup"); }} />
      </>
    );
  } else if (sub === "rename" || sub === "newgroup") {
    const rename = sub === "rename";
    body = (
      <form onSubmit={(e) => {
        e.preventDefault();
        const name = draft.trim();
        if (!name) return;
        if (rename) void change({ title: name });
        else void act(async () => { const g = await post<ThreadGroup>(u(userId, "thread-groups"), { name }); onGroups(); await patch(base, { group: g.id }); });
      }}>
        <input autoFocus aria-label={rename ? "Title" : "Group name"} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setSub(rename ? "" : "group"); } }} />
        <button type="submit" className="primary sm" disabled={!draft.trim()}>{rename ? "Rename" : "Add"}</button>
      </form>
    );
  } else {
    body = (
      <>
        <span className="eyebrow">{t.title || "New thread"}</span>
        <Item label={t.unread ? "Mark as read" : "Mark as unread"} kbd="U" onClick={() => change({ unread: !t.unread })} />
        <Item label="Rename…" kbd="R" onClick={() => { setDraft(t.title ?? ""); setSub("rename"); }} />
        <Item label="Move to group" kbd="M" sub onClick={() => setSub("group")} />
        <div className="sep" role="separator" />
        <Item label={t.hidden ? "Unhide" : "Hide"} kbd="H" onClick={() => change({ hidden: !t.hidden })} />
        <Item label="Delete…" kbd="D" danger onClick={() => setSub("delete")} />
      </>
    );
  }
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={`${t.title || "New thread"} menu`} style={{ left: at.x, top: at.y }}>
      {body}
      <ErrorText error={error} />
    </div>
  );
}
