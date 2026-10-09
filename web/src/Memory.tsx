// The memory browser: search, read with lineage, edit with history, delete, add.
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import {
  del, get, patch, post, u, HttpError,
  type MemoryDetail, type MemoryHit, type MemoryKind, type Pool,
} from "./api.ts";
import { fromEditable, readable, toEditable } from "./mentions.ts";
import { go, href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { Confirm, ErrorText, shortTime, useAction, useLoad } from "./ui.tsx";

const KINDS: { kind: MemoryKind; label: string }[] = [
  { kind: "note", label: "Notes" },
  { kind: "page", label: "Pages" },
  { kind: "wake", label: "WAKE" },
  { kind: "journal", label: "Journal" },
  { kind: "entry", label: "Thread messages" },
];

export function Memory({ ctx, pool, id }: { ctx: ShellContext; pool?: Pool; id?: string }) {
  const userId = ctx.user.id;
  const [adding, setAdding] = useState(false);
  return (
    <main className="main memory" data-detail={!!id || adding}>
      <header className="head">
        <button type="button" className="menu-btn" aria-label="Show threads" onClick={ctx.openSide}>☰</button>
        <div className="head-title"><h1>Memory</h1></div>
        <button type="button" className="gear" onClick={() => { setAdding(true); go({ page: "memory", userId }); }}>Add a memory</button>
      </header>
      <div className="memory-panes">
        <Search ctx={ctx} current={id} />
        <div className="memory-detail">
          {adding ? <AddMemory userId={userId} onDone={(d) => { setAdding(false); if (d) go({ page: "memory", userId, pool: d.item.pool, id: d.item.id }); }} />
            : id && pool ? <Detail key={`${pool}/${id}`} userId={userId} pool={pool} id={id} />
            : <p className="muted empty">Search, or pick a memory to read it.</p>}
        </div>
      </div>
    </main>
  );
}

function Search({ ctx, current }: { ctx: ShellContext; current?: string }) {
  const userId = ctx.user.id;
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [pool, setPool] = useState<"" | Pool>("");
  const [kinds, setKinds] = useState<MemoryKind[]>(["note", "page", "wake", "journal"]);
  const [userOnly, setUserOnly] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [run, , error] = useAction();

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (pool) params.set("pool", pool);
  // A pool chosen here is shown even if the sidebar hides it.
  if (pool) params.set("all", "1");
  params.set("kinds", kinds.join(","));
  if (userOnly) params.set("origin", "user");
  params.set("limit", "50");
  const search = params.toString();
  const hits = useLoad(() => (query || userOnly ? get<MemoryHit[]>(`${u(userId, "memory", "search")}?${search}`) : Promise.resolve([])), [userId, search]);
  useEffect(() => setPicked([]), [search]);

  const forget = () => run(async () => {
    const byPool = new Map<Pool, string[]>();
    for (const key of picked) {
      const [p, ...rest] = key.split("/");
      byPool.set(p as Pool, [...(byPool.get(p as Pool) ?? []), rest.join("/")]);
    }
    for (const [p, ids] of byPool) await post(u(userId, "memory", p, "forget"), { ids });
    hits.reload();
  });

  return (
    <section className="memory-search" aria-label="Search memory">
      <form role="search" className="inline" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input type="search" aria-label="Search memory" placeholder="Search memory" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      <div className="filters-row">
        <select aria-label="Pool" value={pool} onChange={(e) => setPool(e.target.value as "" | Pool)}>
          <option value="">Both pools</option>
          <option value="general">General</option>
          <option value="private">Private</option>
        </select>
        {KINDS.map((k) => (
          <label key={k.kind} className="check">
            <input type="checkbox" checked={kinds.includes(k.kind)}
              onChange={(e) => setKinds(e.target.checked ? [...kinds, k.kind] : kinds.filter((x) => x !== k.kind))} />
            {k.label}
          </label>
        ))}
        <label className="check"><input type="checkbox" checked={userOnly} onChange={(e) => setUserOnly(e.target.checked)} /> User introduced</label>
      </div>
      <ErrorText error={hits.error || error} />
      <ul className="hits">
        {(hits.data ?? []).map((h) => {
          const key = `${h.pool}/${h.id}`;
          return (
            <li key={key} aria-current={current === h.id ? "true" : undefined}>
              <input type="checkbox" aria-label={`Select ${h.id}`} checked={picked.includes(key)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, key] : picked.filter((x) => x !== key))} />
              <a href={href({ page: "memory", userId, pool: h.pool, id: h.id })}>
                <span className="hit-meta">
                  <span className="badge" data-kind={h.pool === "private" ? "private" : "general"}><span className="k">{h.pool}</span></span>
                  {h.kind}{h.origin === "user" && " · yours"}{h.supersededBy && " · superseded"}
                </span>
                <span className="snippet">{h.snippet}</span>
              </a>
            </li>
          );
        })}
        {hits.data && !hits.data.length && (query || userOnly) && <li className="muted empty">Nothing found.</li>}
      </ul>
      {picked.length > 0 && (
        <Confirm label={`Forget these ${picked.length}`} danger confirm="Forget them"
          question={`Forget ${picked.length} ${picked.length === 1 ? "memory" : "memories"} as a topic? Each is deleted, leaving a tombstone so sleep doesn't learn it again. This can't be undone.`}
          onConfirm={forget} />
      )}
    </section>
  );
}

function Detail({ userId, pool, id }: { userId: string; pool: Pool; id: string }) {
  // Recall markers in a private thread may point at general memory: try the other pool too.
  const d = useLoad(async () => {
    try { return await get<MemoryDetail>(u(userId, "memory", pool, id)); } catch (e) {
      if (!(e instanceof HttpError && e.status === 404) || pool === "general") throw e;
      return await get<MemoryDetail>(u(userId, "memory", "general", id));
    }
  }, [userId, pool, id]);
  const [editing, setEditing] = useState(false);
  const [run, busy, error] = useAction();
  if (!d.data) return <ErrorText error={d.error} />;
  const { item, users } = d.data;
  const path = u(userId, "memory", item.pool, item.id);
  const act = (fn: () => Promise<MemoryDetail>) => run(async () => d.set(await fn()));

  return (
    <article className="memory-item">
      <a className="back quiet" href={href({ page: "memory", userId })}>← Results</a>
      <h2>{item.title ?? item.id}</h2>
      <p className="hit-meta">
        <span className="badge" data-kind={item.pool === "private" ? "private" : "general"}><span className="k">{item.pool}</span></span>
        {item.kind} · {item.id}{item.origin === "user" && " · User introduced"}{item.archived && " · archived"}
        {" · "}updated {shortTime(item.updatedAt)}
      </p>
      {item.supersededBy && <p className="muted">Superseded by <MemoryLink userId={userId} pool={item.pool} id={item.supersededBy} />.</p>}
      <ErrorText error={error} />
      {editing
        ? <Editor detail={d.data} busy={busy} onCancel={() => setEditing(false)}
            onSave={(edit) => act(() => patch<MemoryDetail>(path, edit)).then((ok) => ok && setEditing(false))} />
        : (
          <>
            {item.summary && <p className="summary">{readable(item.summary, users)}</p>}
            <div className="prose"><Markdown skipHtml>{readable(item.text, users)}</Markdown></div>
            <div className="row">
              <button type="button" onClick={() => setEditing(true)}>Edit</button>
              <button type="button" onClick={() => act(() => post<MemoryDetail>(`${path}/archive`, { archived: !item.archived }))}>{item.archived ? "Unarchive" : "Archive"}</button>
              <Confirm label="Delete" danger confirm="Delete it"
                question="Delete this memory? Its text is gone for good. A tombstone with only its ID stays, so sleep doesn't learn it again."
                onConfirm={() => run(async () => { await del(path); go({ page: "memory", userId }); })} />
            </div>
          </>
        )}
      <Lineage userId={userId} pool={item.pool} title="Came from" ids={d.data.cameFrom} />
      <Lineage userId={userId} pool={item.pool} title="Used in" ids={d.data.usedIn} />
      {d.data.revisions.length > 0 && (
        <section className="history">
          <h3>History</h3>
          <ol>
            {d.data.revisions.map((r) => (
              <li key={r.id}>
                <details>
                  <summary>{shortTime(r.createdAt)} · {users[r.author]?.displayName ?? r.author}</summary>
                  <div className="prose small"><Markdown skipHtml>{readable(r.body.text, users)}</Markdown></div>
                  <button type="button" disabled={busy} onClick={() => act(() => post<MemoryDetail>(`${path}/restore`, { revision: r.id }))}>Restore this version</button>
                </details>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}

function Editor({ detail, busy, onSave, onCancel }: {
  detail: MemoryDetail; busy: boolean; onSave: (e: { text: string; title?: string; summary?: string }) => void; onCancel: () => void;
}) {
  const { item, users } = detail;
  const [text, setText] = useState(() => toEditable(item.text, users));
  const [title, setTitle] = useState(item.title ?? "");
  const [summary, setSummary] = useState(() => toEditable(item.summary ?? "", users));
  const page = item.kind === "page";
  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      onSave({ text: fromEditable(text, users), ...(page && { title, summary: fromEditable(summary, users) }) });
    }}>
      {page && <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
      {page && <label className="field"><span>Summary</span><input value={summary} onChange={(e) => setSummary(e.target.value)} /></label>}
      <label className="field"><span>Text</span><textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <p className="muted small">People appear as [[Name]] (or [[Name:obj]], [[Name:poss]]…) and are saved so a later rename still applies.</p>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Lineage({ userId, pool, title, ids }: { userId: string; pool: Pool; title: string; ids: string[] }) {
  if (!ids.length) return null;
  return (
    <section className="lineage">
      <h3>{title}</h3>
      <ul>{ids.map((id) => <li key={id}><MemoryLink userId={userId} pool={pool} id={id} /></li>)}</ul>
    </section>
  );
}

/**
 * Threads and their messages open the thread; everything else opens the
 * memory. An ID in the other pool carries it: `general/n:12`.
 */
function MemoryLink({ userId, pool, id }: { userId: string; pool: Pool; id: string }) {
  const [, other, bare = id] = /^(?:(general|private)\/)?(.*)$/.exec(id) ?? [];
  const p = (other as Pool | undefined) ?? pool;
  const thread = /^[te]:([^#]+)/.exec(bare)?.[1];
  const to = thread ? href({ page: "thread", userId, pool: p, threadId: thread }) : href({ page: "memory", userId, pool: p, id: bare });
  return <a href={to}>{id}</a>;
}

function AddMemory({ userId, onDone }: { userId: string; onDone: (d?: MemoryDetail) => void }) {
  const [pool, setPool] = useState<Pool>("general");
  const [kind, setKind] = useState<"note" | "page">("note");
  const [text, setText] = useState("");
  const [links, setLinks] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [run, busy, error] = useAction();
  const linkList = links.split(/[\s,]+/).filter(Boolean);
  const submit = () => run(async () => {
    const body = kind === "note" ? { text, links: linkList } : { slug, title, summary, text, links: linkList };
    onDone(await post<MemoryDetail>(u(userId, "memory", pool, kind === "note" ? "notes" : "pages"), body));
  });
  return (
    <form className="stack add-memory" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>Add a memory</h2>
      <p className="muted">What you add is User introduced: she treats it as true and never rewrites it.</p>
      <div className="row">
        <label className="field"><span>Pool</span>
          <select value={pool} onChange={(e) => setPool(e.target.value as Pool)}><option value="general">General</option><option value="private">Private</option></select>
        </label>
        <label className="field"><span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "note" | "page")}><option value="note">Note</option><option value="page">Page</option></select>
        </label>
      </div>
      {kind === "page" && (
        <>
          <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field"><span>Short name (for links)</span><input value={slug} placeholder="node-2-backups" onChange={(e) => setSlug(e.target.value)} /></label>
          <label className="field"><span>Summary</span><input value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        </>
      )}
      <label className="field"><span>Text</span><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <label className="field"><span>Links (optional)</span>
        <input value={links} placeholder="t:web/3f7a2c  e:web/3f7a2c#41  n:12" onChange={(e) => setLinks(e.target.value)} />
        <small className="muted">Threads, messages or memories this comes from. Leave empty for a free memory.</small>
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !text.trim() || (kind === "page" && (!title || !slug))}>Add</button>
        <button type="button" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}
