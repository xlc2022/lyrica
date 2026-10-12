// Notifications (DESIGN.md "Where things are"; docs/ux.md §6): one list over
// everything waiting for the user, from GET …/notifications. The sidebar link
// carries the count of decisions; the welcome page shows the first few; the
// Settings section has the whole list with filters, sorting, paging and the
// actions on each row.
import { useMemo, useState } from "react";
import { get, request, u, type Notification, type NotificationAction, type NotificationPage, type NotificationType, type Pool, type ThreadSummary } from "./api.ts";
import { Section } from "./Panel.tsx";
import { go, href } from "./route.ts";
import { ErrorText, shortTime, useAction, useLoad } from "./ui.tsx";
import type { ShellContext } from "./Shell.tsx";

const TYPES: Record<NotificationType, { glyph: string; label: string }> = {
  permission: { glyph: "?", label: "Approval" },
  share: { glyph: "⇄", label: "Shared with you" },
  update: { glyph: "↻", label: "Thread update" },
  approval: { glyph: "✓", label: "Persona change" },
  suggestion: { glyph: "✎", label: "Persona suggestion" },
  sleep: { glyph: "☾", label: "Last night" },
  rollback: { glyph: "↶", label: "Update rolled back" },
};
const PAGE = 20;
type Sort = "newest" | "oldest" | "type" | "scope";

/** How many decisions wait: the sidebar's count. */
export function useWaiting(userId: string) {
  const page = useLoad(() => get<NotificationPage>(`${u(userId, "notifications")}?limit=0`), [userId]);
  return { waiting: page.data?.waiting ?? 0, reload: page.reload };
}

/** Runs one row's action; a `opens` action answers with the thread to go to. */
function useAct(ctx: ShellContext, reload: () => void) {
  const [run, busy, error] = useAction();
  const act = (actions: NotificationAction[]) => run(async () => {
    let opened: ThreadSummary | undefined;
    for (const a of actions) {
      const r = await request<unknown>(a.method, a.path, a.body ?? {});
      if (a.opens && r && typeof r === "object" && "id" in r) opened = r as ThreadSummary;
    }
    reload();
    ctx.refreshNotifications();
    if (opened) { ctx.refreshThreads(); go({ page: "thread", userId: ctx.user.id, pool: opened.pool, threadId: opened.id }); }
  });
  return [act, busy, error] as const;
}

/** A detail that opens with a number ("3 entries, …") shows the number in mono (docs/ux.md §2). */
function numFirst(text: string) {
  const m = /^(\d[\d,.]*)(\s.*)$/s.exec(text);
  return m ? <><span className="num">{m[1]}</span>{m[2]}</> : text;
}

function Where({ n, userId }: { n: Notification; userId: string }) {
  if (n.thread) return <a className="sm btn" href={href({ page: "thread", userId, pool: n.thread.pool, threadId: n.thread.id })}>Open thread</a>;
  if (n.section) {
    const [page, section] = n.section.split("/") as ["settings" | "admin", string];
    return <a className="sm btn" href={href({ page, userId, section })}>Open</a>;
  }
  return null;
}

function Row({ n, ctx, picked, onPick, act, busy }: {
  n: Notification; ctx: ShellContext; picked?: boolean; onPick?: (v: boolean) => void; act: (a: NotificationAction[]) => Promise<boolean>; busy: boolean;
}) {
  const t = TYPES[n.type];
  return (
    <li className={`nrow${onPick ? "" : " nopick"}`}>
      {onPick && <input type="checkbox" className="npick" checked={!!picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Select ${n.title}`} />}
      <span className="ico" aria-hidden="true">{t.glyph}</span>
      <div className="main-col">
        <span className="name">{n.title}</span>
        {n.detail && <span className="meta">{numFirst(n.detail)}</span>}
        <span className="nkind">{t.label} · <span className={`k${n.scope === "private" ? " private" : ""}`}>{n.scope}</span> · <span className="when">{shortTime(n.at)}</span></span>
      </div>
      <div className="actions">
        <Where n={n} userId={ctx.user.id} />
        {n.actions.map((a) => <button key={a.label} type="button" className={`sm${a.danger ? " danger" : ""}`} disabled={busy} onClick={() => act([a])}>{a.label}</button>)}
      </div>
    </li>
  );
}

/** The welcome page's card: the first few decisions, and the way to all of them. */
export function NotificationsCard({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const page = useLoad(() => get<NotificationPage>(`${u(userId, "notifications")}?type=decision&limit=4`), [userId]);
  const [act, busy, error] = useAct(ctx, page.reload);
  if (!page.data || !page.data.total) return null;
  return (
    <section className="card" aria-labelledby="h-notifications">
      <div className="section-head"><h2 id="h-notifications">Notifications</h2><a href={href({ page: "settings", userId, section: "notifications" })}>All {page.data.waiting}</a></div>
      <ErrorText error={error} />
      <ul className="list">{page.data.items.map((n) => <Row key={n.id} n={n} ctx={ctx} act={act} busy={busy} />)}</ul>
    </section>
  );
}

/** Settings → Notifications: the whole list. */
export function NotificationsSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const [type, setType] = useState<"all" | "decision" | NotificationType>("all");
  const [scope, setScope] = useState<"all" | Pool>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const query = `${u(userId, "notifications")}?${new URLSearchParams({ ...(type !== "all" ? { type } : {}), ...(scope !== "all" ? { scope } : {}), sort, limit: String(limit) })}`;
  const page = useLoad(() => get<NotificationPage>(query), [query]);
  const [act, busy, error] = useAct(ctx, page.reload);
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;
  const sel = useMemo(() => items.filter((n) => picked.has(n.id)), [items, picked]);
  // Bulk: the actions every selected row has, each with the count; none when they share none.
  const shared = sel.length ? sel[0]!.actions.filter((a) => sel.every((n) => n.actions.some((x) => x.label === a.label))) : [];
  const bulk = (label: string) => act(sel.map((n) => n.actions.find((x) => x.label === label)).filter((a): a is NotificationAction => !!a)).then(() => setPicked(new Set()));
  const chips: [typeof type, string][] = [["all", `All ${page.data ? total : ""}`.trim()], ["decision", "Needs a decision"], ...(page.data?.types ?? []).map((t): [NotificationType, string] => [t, TYPES[t].label])];
  const groups = sort === "type" || sort === "scope"
    ? [...new Map(items.map((n) => [sort === "type" ? TYPES[n.type].label : n.scope, items.filter((x) => (sort === "type" ? TYPES[x.type].label : x.scope) === (sort === "type" ? TYPES[n.type].label : n.scope))])).entries()]
    : null;
  const row = (n: Notification) => <Row key={n.id} n={n} ctx={ctx} picked={picked.has(n.id)} onPick={(v) => setPicked((s) => { const next = new Set(s); if (v) next.add(n.id); else next.delete(n.id); return next; })} act={act} busy={busy} />;
  return (
    <Section title="Notifications">
      <div className="ntop seg-row" role="group" aria-label="Show">
        {chips.map(([k, label]) => <button key={k} type="button" className="chip" aria-pressed={type === k} onClick={() => { setType(k); setLimit(PAGE); }}>{label}</button>)}
      </div>
      <div className="ntop">
        <label className="cap">Sort <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="type">By type</option><option value="scope">By pool</option>
        </select></label>
        <label className="cap">Where <select value={scope} onChange={(e) => { setScope(e.target.value as "all" | Pool); setLimit(PAGE); }}>
          <option value="all">Everywhere</option><option value="general">General</option><option value="private">Private</option>
        </select></label>
        <span className="spacer" />
        {page.data && <span className="cap"><span className="num">{total}</span> {total === 1 ? "item" : "items"}{total > items.length ? <>, <span className="num">{items.length}</span> shown</> : ""}</span>}
      </div>
      <div className="bulk" role="toolbar" aria-label="Selected">
        <label className="check"><input type="checkbox" checked={items.length > 0 && items.every((n) => picked.has(n.id))} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((n) => n.id)) : new Set())} /> Select all{total > items.length ? ` ${items.length} shown` : ""}</label>
        <span className="meta">{sel.length ? `${sel.length} selected` : ""}</span>
        <span className="spacer" />
        {shared.map((a, i) => (
          <button key={a.label} type="button" className={`sm${i === 0 && !a.danger ? " primary" : ""}${a.danger ? " danger" : ""}`} disabled={busy}
            onClick={() => bulk(a.label)}>{a.label} <span className="num">{sel.length}</span></button>
        ))}
      </div>
      <ErrorText error={page.error || error} />
      {page.data && !items.length && <p className="empty">Nothing waiting.{type !== "all" || scope !== "all" ? " Try a wider filter." : ""}</p>}
      {items.length > 0 && (groups
        ? groups.map(([label, list]) => <div key={label} className="ngroup"><div className="eyebrow">{label} · {list.length}</div><ul className="list">{list.map(row)}</ul></div>)
        : <ul className="list">{items.map(row)}</ul>)}
      {total > items.length && <div className="more-row"><button type="button" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, total - items.length)} more of {total - items.length}</button></div>}
    </Section>
  );
}
