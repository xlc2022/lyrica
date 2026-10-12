// A thread's menu in the sidebar (docs/ux.md §6): right-click, or a long press
// on a phone, with a letter shortcut for each item. Mark as unread, Rename,
// Share with, Move to group, Hide and Delete; Pin; Make project for a top-level thread, Resolve and
// Reopen for a project's thread.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { del, get, patch, post, put, threadPath, u, type Person, type ThreadGroup, type ThreadSummary } from "./api.ts";
import { go, type Route } from "./route.ts";
import { ConfirmDialog, ErrorText, menuArrows } from "./ui.tsx";

export interface MenuAt { x: number; y: number; thread: ThreadSummary }

/** Opens the menu from a right-click, or from a press held for half a second. The click after a long press is swallowed. */
export function useThreadMenu() {
  const [at, setAt] = useState<MenuAt>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const handlers = (thread: ThreadSummary) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      // From the keyboard (Shift+F10, the Menu key) there is no pointer: open under the row.
      const r = e.clientX === 0 && e.clientY === 0 ? e.currentTarget.getBoundingClientRect() : null;
      setAt({ x: r ? r.left + 24 : e.clientX, y: r ? r.bottom : e.clientY, thread });
    },
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
  const [sub, setSub] = useState<"" | "group" | "rename" | "newgroup" | "delete" | "project" | "share">("");
  const [draft, setDraft] = useState(t.title ?? "");
  const [error, setError] = useState("");
  const [people, setPeople] = useState<Person[]>();
  const [recipient, setRecipient] = useState<Person>();
  const children = t.children.length;
  // The other users on this server, read when Share with opens.
  useEffect(() => {
    if (sub !== "share" || people) return;
    get<Person[]>(u(userId, "people")).then(setPeople, (e: Error) => setError(e.message));
  }, [sub, people, userId]);

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
    if (sub === "delete" || sub === "project" || recipient) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (sub) setSub(""); else onClose(); return; }
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (menuArrows(e, ref.current)) return;
      const btn = ref.current?.querySelector<HTMLButtonElement>(`button[data-key="${e.key.toUpperCase()}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    };
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", down);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", down); };
  }, [sub, recipient, onClose]);
  useEffect(() => { if (!sub) ref.current?.querySelector("button")?.focus(); }, [sub]);

  const act = (fn: () => Promise<unknown>) => fn().then(() => { onChange(); onClose(); }, (e: Error) => setError(e.message));
  const change = (c: { title?: string; hidden?: boolean; group?: string | null; unread?: boolean; project?: true }) => act(() => patch(base, c));
  const inProject = t.state !== undefined;
  const forget = (withChildren: boolean) => act(async () => {
    await del(base, { children: withChildren });
    // The open thread is gone: leave it.
    if (route.page === "thread" && route.threadId === t.id) go({ page: "home", userId });
  });

  if (recipient) {
    // DESIGN.md, "Share with": a copy as it is now; the sender's later messages and memory never go; a private thread asks first.
    const name = t.title || "this thread";
    return (
      <ConfirmDialog title={`Send a copy to ${recipient.displayName}?`} confirm="Send a copy" onCancel={() => setRecipient(undefined)}
        onConfirm={() => act(() => post(`${base}/share`, { to: recipient.id }))}
        sentence={`${recipient.displayName} gets “${name}” as it is now, to add to their General or Private threads or decline; your later messages and none of your memories go with it${t.pool === "private" ? ", and this thread is private." : "."}`} />
    );
  }
  if (sub === "project") {
    return (
      <ConfirmDialog title="Make this a project?" confirm="Make project" onCancel={onClose} onConfirm={() => change({ project: true })}
        sentence="This thread becomes the project chat, and threads Lyrica starts from it become the project's threads. There is no way back." />
    );
  }
  if (sub === "delete") {
    return (
      <ConfirmDialog title="Delete this thread?" danger confirm="Delete" onCancel={onClose} onConfirm={forget}
        sentence="Its messages are deleted, and so is what Lyrica learned only from it. This can't be undone."
        {...(children > 0 ? { option: `Also delete its ${children === 1 ? "child thread" : `${children} child threads`}` } : {})} />
    );
  }
  let body: ReactNode;
  if (sub === "share") {
    body = (
      <>
        <button type="button" className="back" onClick={() => setSub("")}>‹ Share with</button>
        {people?.map((p) => <Item key={p.id} label={<>{p.displayName}{p.linked && <span className="cap"> your persona</span>}</>} onClick={() => setRecipient(p)} />)}
        {people && !people.length && <span className="empty">No one else on this server.</span>}
      </>
    );
  } else if (sub === "group") {
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
        <span className="eyebrow">{t.title || (t.project ? "New project" : "New thread")}</span>
        <Item label={t.unread ? "Mark as read" : "Mark as unread"} kbd="U" onClick={() => change({ unread: !t.unread })} />
        <Item label="Rename…" kbd="R" onClick={() => { setDraft(t.title ?? ""); setSub("rename"); }} />
        {!t.project && !t.subagent && <Item label="Share with" kbd="S" sub onClick={() => setSub("share")} />}
        <Item label="Move to group" kbd="M" sub onClick={() => setSub("group")} />
        {!t.child && !t.parent && <Item label={t.pinned ? "Unpin" : "Pin"} kbd="P" onClick={() => act(() => (t.pinned ? del(`${base}/pin`) : put(`${base}/pin`, {})))} />}
        {!t.child && !t.parent && !t.project && <Item label="Make project…" kbd="K" onClick={() => setSub("project")} />}
        {inProject && <Item label={t.state === "resolved" ? "Reopen" : "Resolve"} kbd="E" onClick={() => act(() => post(`${base}/${t.state === "resolved" ? "reopen" : "resolve"}`))} />}
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
