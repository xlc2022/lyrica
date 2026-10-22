// The memory browser, read like a notebook (DESIGN.md Memory, docs/ux.md §6):
// a browse pane by layer with search above it, and the memory beside it, its
// citations reading as titles that preview on hover, Came from and Used in
// with the citing sentence, history as word differences, editing in place.
// Everything comes from the owner view through lyricad; titles, previews and
// differences live in React state, never in browser storage.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import {
  del, get, patch, post, u,
  type Display, type MemoryDetail, type MemoryExport, type MemoryImportResult, type MemoryHistory, type MemoryHit, type MemoryKind, type MemoryLink, type MemoryOverview, type MemoryRevision, type MemoryTag, type MemoryUse, type Pool, type UserMap,
} from "./api.ts";
import { HistoryHead, HistoryList } from "./History.tsx";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import { CITATION_GROUP, dateWord, firstWords, KIND_WORD, linkCitations, longDate, parseRef, plainCitations, plainWords, poolWord, wordDiff, wordFor, type Word } from "./memory.ts";
import { fromEditable, readable, toEditable } from "./mentions.ts";
import { go, href, idHref, parse, type Route } from "./route.ts";
import { Main, PageHead, usePanel, type ShellContext } from "./Shell.tsx";
import { ConfirmDialog, dateText, ErrorText, hidden, Prose, shortTime, useAction, useDismiss, useLoad } from "./ui.tsx";

type Layer = "page" | "note" | "wake" | "journal" | "entry";
/** The layers; Recent is what sleep hasn't consolidated yet, the messages recall finds before they become notes and pages. */
const LAYERS: { layer: Layer; label: string; tip?: string }[] = [
  { layer: "page", label: "Pages" }, { layer: "note", label: "Notes" }, { layer: "wake", label: "WAKE" }, { layer: "journal", label: "Journal" },
  { layer: "entry", label: "Recent", tip: "Messages she hasn't slept on yet. Sleep turns them into notes and pages." },
];
const PAGE_SIZE = 40;
const LINEAGE_PREVIEW = 4;

/** Titles of memories read in this visit, for the panel's breadcrumb; nothing of a memory's text. */
const TITLES = new Map<string, string>();
export const memoryTitle = (pool: Pool, id: string) => TITLES.get(`${pool}/${id}`);

/** A memory's name: its title, or for a note its first words, WAKE, or the journal entry's day. */
function nameOf(kind: MemoryKind, title: string | undefined, text: string, at: string): string {
  if (title) return title;
  if (kind === "wake") return "WAKE";
  if (kind === "journal") return longDate(at);
  return firstWords(text) || "an empty memory";
}

const originWord = (origin?: string) => (origin === "user" ? "yours" : origin === "sleep" ? "sleep" : her());

/** What the browse pane shows: the layer, and a tag that narrows the Notes layer. */
interface Browsing { layer: Layer; tag?: string }

export function Memory({ ctx, pool, id }: { ctx: ShellContext; pool?: Pool; id?: string }) {
  const userId = ctx.user.id;
  const display = ctx.me.display;
  const inPanel = !!usePanel();
  const [adding, setAdding] = useState(false);
  /** Bumped after an import, so the lists and counts read again. */
  const [imports, setImports] = useState(0);
  const [browsing, setBrowsing] = useState<Browsing>({ layer: "page" });
  const [title, setTitle] = useState<string>();
  /** The memories read in turn by following links inside one, for the page's own breadcrumb. */
  const [trail, setTrail] = useState<{ pool: Pool; id: string; title: string }[]>([]);
  const overview = useLoad(() => get<MemoryOverview>(u(userId, "memory")), [userId, display.showGeneral, display.showPrivate, imports]);
  useEffect(() => { if (!id) setTitle(undefined); }, [id]);

  const reading = !!(id && pool) || adding;
  const detail = adding ? <AddMemory userId={userId} onImported={() => setImports((n) => n + 1)} onDone={(d) => { setAdding(false); if (d) go({ page: "memory", userId, pool: d.item.pool, id: d.item.id }); }} />
    : id && pool && hidden(display, pool) ? <p className="muted empty">{poolWord(pool)} is hidden. Turn on {poolWord(pool)} in the Sort menu to see it.</p>
    : id && pool ? <Detail key={`${pool}/${id}`} ctx={ctx} pool={pool} id={id} onTitle={setTitle} onTag={(tag) => { setBrowsing({ layer: "note", tag }); go({ page: "memory", userId }); }} />
    : <p className="muted empty">Pick a memory to read it, or search.</p>;

  if (inPanel) {
    return (
      <Main className="main memory">
        <PageHead ctx={ctx} title="Memory" />
        <div className="mem-read">{detail}</div>
      </Main>
    );
  }

  // A link inside the memory opens the next one in place, and the breadcrumb grows; a crumb goes back to that one.
  const follow = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest("a[href^='#/u/']");
    if (!a) return;
    const to = parse(a.getAttribute("href")!);
    if (to.page !== "memory" || !to.pool || !to.id) return;
    const crumb = (a as HTMLElement).dataset.crumb;
    if (crumb !== undefined) setTrail(trail.slice(0, Number(crumb)));
    else if (id && pool && title) setTrail([...trail, { pool, id, title }]);
  };
  const facts = overview.data && (
    <><span className="num">{overview.data.pages}</span> {overview.data.pages === 1 ? "page" : "pages"} · <span className="num">{overview.data.notes}</span> {overview.data.notes === 1 ? "note" : "notes"}
      {overview.data.slept && <> · slept <span className="num">{shortTime(overview.data.slept)}</span></>}</>
  );
  return (
    <Main className="main memory">
      <PageHead ctx={ctx} title="Memory" facts={facts}>
        <button type="button" className="sm" onClick={() => { setAdding(true); go({ page: "memory", userId }); }}><Icon name="plus" /><span className="long">Add a memory</span></button>
      </PageHead>
      <div className="mem" data-reading={reading}>
        <Browse ctx={ctx} current={id} imports={imports} browsing={browsing} onBrowse={setBrowsing} onPick={() => { setTrail([]); setAdding(false); }} />
        <div className="mem-read" onClick={follow}>
          {reading && <a className="sm mem-back" href={href({ page: "memory", userId })}><Icon name="back" />Memory</a>}
          {trail.length > 0 && id && (
            <nav className="crumbs" aria-label="Opened from">
              {trail.map((c, i) => <a key={i} href={href({ page: "memory", userId, pool: c.pool, id: c.id })} data-crumb={i}>{c.title}</a>)}
            </nav>
          )}
          {detail}
        </div>
      </div>
    </Main>
  );
}

/** The browse pane: search, the layer segment, the filters row, the Notes layer's tags, and the list, newest first and paged. */
function Browse({ ctx, current, imports, browsing, onBrowse, onPick }: { ctx: ShellContext; current?: string; imports: number; browsing: Browsing; onBrowse: (b: Browsing) => void; onPick: () => void }) {
  const userId = ctx.user.id;
  const { display } = ctx.me;
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [pool, setPool] = useState<"" | Pool>("");
  const [userOnly, setUserOnly] = useState(false);
  const [more, setMore] = useState<MemoryHit[]>([]);
  const [noMore, setNoMore] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [forgetting, setForgetting] = useState(false);
  const [left, setLeft] = useState(0);
  const [run, busy, error] = useAction();
  const { layer, tag } = browsing;
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("kinds", query ? "note,page,wake,journal" : layer);
  if (pool) params.set("pool", pool);
  if (userOnly) params.set("origin", "user");
  if (!query && layer === "note" && tag) params.set("about", tag);
  const journalPreview = !query && layer === "journal";
  // The preview shows one entry; it asks for two so a second proves there is more to open.
  params.set("limit", String(journalPreview ? 2 : PAGE_SIZE));
  const search = params.toString();
  const hits = useLoad(() => get<MemoryHit[]>(`${u(userId, "memory", "search")}?${search}`), [userId, search, display.showGeneral, display.showPrivate, imports]);
  const tags = useLoad(() => (layer === "note" && !query ? get<MemoryTag[]>(`${u(userId, "memory", "about")}${pool ? `?pool=${pool}` : ""}`) : Promise.resolve([] as MemoryTag[])), [userId, layer, query, pool, display.showGeneral, display.showPrivate]);
  useEffect(() => { setMore([]); setNoMore(false); setSel([]); setLeft(0); }, [search]);

  const rows = [...(hits.data ?? []), ...more];
  const shownRows = journalPreview ? rows.slice(0, 1) : rows;
  const canPage = !query && !journalPreview && hits.data && hits.data.length >= PAGE_SIZE && !noMore;
  const page = () => run(async () => {
    const last = rows.at(-1)?.updatedAt;
    if (!last) return;
    const next = await get<MemoryHit[]>(`${u(userId, "memory", "search")}?${search}&before=${encodeURIComponent(last)}`);
    setMore((m) => [...m, ...next]);
    if (next.length < PAGE_SIZE) setNoMore(true);
  });
  const key = (h: MemoryHit) => `${h.pool}/${h.id}`;
  // Ctrl- or Cmd-click adds to the selection, Shift-click takes everything between (as in the Files panel).
  const select = (e: React.MouseEvent, h: MemoryHit) => {
    const k = key(h);
    if (e.shiftKey && sel.length) {
      const keys = rows.map(key);
      const [a, b] = [keys.indexOf(sel.at(-1)!), keys.indexOf(k)].sort((x, y) => x - y) as [number, number];
      setSel([...new Set([...sel, ...keys.slice(a, b + 1)])]);
    } else setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
  };
  const forget = () => run(async () => {
    const byPool = new Map<Pool, string[]>();
    for (const k of sel) { const [p, ...rest] = k.split("/"); byPool.set(p as Pool, [...(byPool.get(p as Pool) ?? []), rest.join("/")]); }
    for (const [p, ids] of byPool) await post(u(userId, "memory", p, "forget"), { ids });
    setSel([]); setForgetting(false);
    hits.reload();
    if (sel.some((k) => k.endsWith(`/${current}`))) go({ page: "memory", userId });
  });

  const exportSel = () => run(async () => {
    const out = await download(userId, sel.map((k) => { const [p, ...rest] = k.split("/"); return { pool: p as Pool, id: rest.join("/") }; }));
    setLeft(out.skipped);
  });

  const line = (h: MemoryHit): ReactNode => {
    const kind = query ? `${KIND_WORD[h.kind]} · ` : "";
    if (h.kind === "note") return <>{kind}{(h.about ?? []).join(", ")}{h.about?.length && h.origin === "user" ? " · " : ""}{h.origin === "user" && "yours"}{h.supersededBy && " · superseded"}</>;
    if (h.kind === "page") return <>{kind}{h.origin === "user" && "yours · "}{h.snippet}</>;
    return <>{kind}{h.title ? h.snippet : firstWords(h.snippet, 90)}</>;
  };
  return (
    <section className="mem-pane" aria-label="Browse memory" onClick={(e) => { if ((e.target as Element).closest("a")) onPick(); }}>
      <input type="search" aria-label="Search memory" placeholder="Search memory" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="seg" role="group" aria-label="Layer">
        {LAYERS.map((l) => <button key={l.layer} type="button" aria-pressed={!query && layer === l.layer} title={l.tip} onClick={() => { setQ(""); onBrowse({ layer: l.layer }); }}>{l.label}</button>)}
      </div>
      <div className="mem-filters">
        <select aria-label="Pool" value={pool} onChange={(e) => setPool(e.target.value as "" | Pool)}>
          <option value="">Both pools</option>
          <option value="general">General</option>
          <option value="private">Private</option>
        </select>
        <label className="check"><input type="checkbox" checked={userOnly} onChange={(e) => setUserOnly(e.target.checked)} /> User introduced</label>
      </div>
      {tags.data && tags.data.length > 0 && (
        <div className="tags" role="group" aria-label="Tags">
          {tags.data.map((t) => <button key={t.about} type="button" className="tag" aria-pressed={tag === t.about} onClick={() => onBrowse({ layer, tag: tag === t.about ? undefined : t.about })}>{t.about} <span className="num">{t.count}</span></button>)}
        </div>
      )}
      <ErrorText error={hits.error || tags.error || error} />
      {journalPreview && <HistoryHead to={{ page: "history", userId, kind: "journal", ...(pool ? { pool } : {}) }} count={hits.data?.length} />}
      <div className="mem-list" aria-label={query ? "Search results" : LAYERS.find((l) => l.layer === layer)!.label} data-selecting={sel.length > 0 || undefined}>
        {shownRows.map((h) => (
          <a key={key(h)} href={href({ page: "memory", userId, pool: h.pool, id: h.id })} aria-current={current === h.id ? "true" : undefined} className={sel.includes(key(h)) ? "sel" : undefined}
            onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); e.stopPropagation(); select(e, h); } }}>
            <span className="t"><span>{nameOf(h.kind, h.title, h.snippet, h.updatedAt ?? "")}</span>{h.updatedAt && <span className="when num">{shortTime(h.updatedAt)}</span>}</span>
            <span className="s"><span className={`kind ${h.pool}`}>{h.pool}</span>{line(h)}</span>
          </a>
        ))}
        {hits.data && !rows.length && <p className="muted empty">{query ? "Nothing found." : layer === "wake" ? "She hasn't woken yet." : layer === "journal" ? "No journal yet." : layer === "page" ? "No pages yet." : layer === "entry" ? "Nothing since she last slept." : "No notes yet."}</p>}
        {canPage && <div className="more-row"><button type="button" className="sm" disabled={busy} onClick={page}>More</button></div>}
      </div>
      {sel.length > 0 && (
        <div className="selbar" role="toolbar" aria-label="Selection">
          <span><span className="num">{sel.length}</span> selected</span>
          <button type="button" className="sm" disabled={busy} title={EXPORT_TIP} onClick={exportSel}>Export</button>
          <button type="button" className="sm danger" onClick={() => setForgetting(true)}>Forget…</button>
          <button type="button" className="icon sm" aria-label="Clear the selection" onClick={() => { setSel([]); setLeft(0); }}><Icon name="close" /></button>
        </div>
      )}
      {left > 0 && sel.length > 0 && <p className="meta muted">{left === sel.length ? "Only notes and pages can be exported." : <><span className="num">{left}</span> left out: only notes and pages can be exported.</>}</p>}
      {forgetting && (
        <ConfirmDialog title={`Forget ${sel.length === 1 ? "this memory" : `these ${sel.length} memories`}?`} confirm="Forget" danger onCancel={() => setForgetting(false)} onConfirm={forget}
          sentence="Each is deleted for good, leaving a marker with only its ID so sleep doesn't learn it again." />
      )}
    </section>
  );
}

/** One memory: its facts, tags, text with titled citations, actions, Came from, Used in and History. */
function Detail({ ctx, pool, id, onTitle, onTag }: { ctx: ShellContext; pool: Pool; id: string; onTitle: (t: string) => void; onTag: (tag: string) => void }) {
  const userId = ctx.user.id;
  const { display } = ctx.me;
  const d = useLoad(() => get<MemoryDetail>(u(userId, "memory", pool, id)), [userId, pool, id, display.showGeneral, display.showPrivate]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState<"Came from" | "Used in" | null>(null);
  const [run, busy, error] = useAction();
  const item = d.data?.item;
  const name = item && nameOf(item.kind, item.title && readable(item.title, d.data!.users), readable(item.text, d.data!.users), item.updatedAt);
  useEffect(() => { if (name) { TITLES.set(`${pool}/${id}`, name); onTitle(name); } }, [name, pool, id, onTitle]);
  if (!d.data || !item) return <ErrorText error={d.error} />;
  const { users } = d.data;
  // The memory being read is its own citer's target: the lineage names it rather than calling it gone.
  const self: MemoryLink = { kind: item.kind, pool: item.pool, ...(item.title ? { title: item.title } : {}), snippet: firstWords(plainCitations(item.text)), updatedAt: item.updatedAt, ...(item.origin ? { origin: item.origin } : {}) };
  const links: Record<string, MemoryLink> = { ...d.data.links, [item.id]: self, [`${item.pool}/${item.id}`]: self };
  const path = u(userId, "memory", item.pool, item.id);
  const act = (fn: () => Promise<MemoryDetail>) => run(async () => d.set(await fn()));
  const canDelete = item.kind === "note" || item.kind === "page";
  // A message is read here as short-term memory; it is changed in its thread (Came from), never here.
  const canEdit = item.kind !== "entry";
  const cameFrom: MemoryUse[] = d.data.cameFrom.map((ref) => ({ id: ref, sentence: sentenceCiting(item.text, ref) }));

  return (
    <article className="mem-item" aria-labelledby="mem-title">
      <h2 id="mem-title">{name}</h2>
      <div className="tfacts">
        <span className={`kind ${item.pool}`}>{item.pool}</span>
        <span>{KIND_WORD[item.kind]}</span>
        <span>{originWord(item.origin)}</span>
        {item.archived && <span>archived</span>}
        <span>updated <span className="num">{shortTime(item.updatedAt)}</span></span>
        {item.folders && item.folders.length > 0 && <span className="folder" title={item.folders.join(", ")}><Icon name="folder" />{item.folders.join(", ")}</span>}
      </div>
      {item.about && item.about.length > 0 && (
        <div className="tags" aria-label="Tags">{item.about.map((t) => <button key={t} type="button" className="tag" onClick={() => onTag(t)}>{t}</button>)}</div>
      )}
      {item.supersededBy && <p className="meta muted">Superseded by <a href={idHref(userId, item.pool, item.supersededBy)}>a later note</a>.</p>}
      {!editing && item.summary && <p className="summary">{readable(item.summary, users)}</p>}
      <ErrorText error={error} />
      {editing
        ? <Editor detail={d.data} display={display} userId={userId} busy={busy} onCancel={() => setEditing(false)}
            onSave={(edit) => act(() => patch<MemoryDetail>(path, edit)).then((ok) => ok && setEditing(false))} />
        : (
          <>
            <div className="prose"><MemoryProse text={item.text} pool={item.pool} userId={userId} links={links} users={users} display={display} /></div>
            {canEdit && <div className="row">
              <button type="button" className="sm" onClick={() => setEditing(true)}>Edit</button>
              <MoreMenu>
                <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => post<MemoryDetail>(`${path}/archive`, { archived: !item.archived }))}>{item.archived ? "Unarchive" : "Archive"}</button>
                {canDelete && <button type="button" role="menuitem" title={EXPORT_TIP} disabled={busy} onClick={() => run(() => download(userId, [{ pool: item.pool, id: item.id }]))}>Export</button>}
                {canDelete && <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => setDeleting(true)}>Delete…</button>}
              </MoreMenu>
            </div>}
          </>
        )}
      <Lineage title="Came from" uses={cameFrom} mark={undefined} ctx={ctx} pool={item.pool} links={links} users={users} ownText expanded={expanded === "Came from"} onToggle={() => setExpanded(expanded === "Came from" ? null : "Came from")} />
      {expanded !== "Came from" && <Lineage title="Used in" uses={d.data.usedIn} mark={item.id} ctx={ctx} pool={item.pool} links={links} users={users} expanded={expanded === "Used in"} onToggle={() => setExpanded(expanded === "Used in" ? null : "Used in")} />}
      {!expanded && <History detail={d.data} userId={userId} display={display} busy={busy} onRestore={(rev) => act(() => post<MemoryDetail>(`${path}/restore`, { revision: rev }))} />}
      {deleting && (
        <ConfirmDialog title={`Delete “${name}”?`} confirm="Delete" danger onCancel={() => setDeleting(false)}
          sentence={`Its text and its history are gone for good; a marker with only its ID stays, so she doesn't learn it again.${d.data.usedIn.length ? ` ${d.data.usedIn.length === 1 ? "One memory cites it and is" : `${d.data.usedIn.length} memories cite it and are`} rewritten at the next sleep.` : ""}`}
          onConfirm={() => run(async () => { await del(path); go({ page: "memory", userId }); })} />
      )}
    </article>
  );
}

/** The sentence of `text` citing `ref` (as written), for a Came from card; the server does the same for Used in. */
function sentenceCiting(text: string, ref: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?:\s*\[[^[\]]+\])*)?|[.!?]+(?:\s*\[[^[\]]+\])*/g) ?? [flat];
  const cites = (s: string) => [...s.matchAll(/(?<!\[)\[([^[\]]+)\](?!\])/g)].flatMap((m) => m[1]!.split(/[,;]\s*/).map((x) => x.trim()));
  return sentences.find((s) => cites(s).includes(ref))?.trim();
}

/** Rare actions behind a ⋯ (docs/ux.md §6). */
function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <span className="row-menu" ref={ref} onClick={(e) => { if ((e.target as Element).closest("[role='menuitem']")) setOpen(false); }}>
      <button type="button" className="icon-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" /></button>
      {open && <div className="menu" role="menu">{children}</div>}
    </span>
  );
}

/** A memory's text with each citation reading as a title, a dated source mark, or the hidden pool's word, previewing on hover or focus. */
export function MemoryProse({ text, pool, userId, links, users, display }: { text: string; pool: Pool; userId: string; links: Record<string, MemoryLink>; users: UserMap; display: Display }) {
  const { markdown, words } = useMemo(() => linkCitations(readable(text, users), pool, userId, links, display), [text, users, pool, userId, links, display]);
  const a = useMemo<Components["a"]>(() => ({ node: _, ...props }) => {
    const w = props.href ? words.get(props.href) : undefined;
    if (!w) return props.href?.startsWith("#/") ? <a {...props} /> : <a {...props} target="_blank" rel="noopener noreferrer" />;
    return <WordLink word={w} users={users} {...props} />;
  }, [words, users]);
  return <Prose text={markdown} a={a} />;
}

let tipN = 0;
/** A link that reads as its memory's title or date and previews it (first line, pool, date) on hover or focus. */
function WordLink({ word, users, children, href: to }: { word: Word; users: UserMap; children?: ReactNode; href?: string }) {
  const [tip] = useState(() => `tip-${++tipN}`);
  const l = word.link!;
  const kind = KIND_WORD[word.ref.kind];
  return (
    <a href={to} className={word.cite ? "cite" : "wl"} aria-describedby={tip} aria-label={word.cite ? `Source note, ${word.text}` : undefined}>
      {children}
      <span className="preview" role="tooltip" id={tip}>
        <span className="meta">{kind[0]!.toUpperCase() + kind.slice(1)} · {l.pool} · <span className="num">{dateWord(l.updatedAt)}</span>{l.origin === "user" && " · yours"}</span>
        {l.kind === "page" || l.kind === "thread" ? (l.snippet ? readable(l.snippet, users) : l.title) : readable(l.snippet, users)}
      </span>
    </a>
  );
}

/** Came from and Used in: a card per memory with its title or first words, its date, and the citing sentence (docs/ux.md §6). */
function Lineage({ title, uses, mark, ctx, pool, links, users, ownText, expanded, onToggle }: {
  title: string; uses: MemoryUse[]; mark?: string; ctx: ShellContext; pool: Pool; links: Record<string, MemoryLink>; users: UserMap;
  /** The sentences are this memory's own (Came from): the cited memory is marked by its ref instead. */
  ownText?: boolean; expanded: boolean; onToggle: () => void;
}) {
  const userId = ctx.user.id;
  const { display } = ctx.me;
  if (!uses.length) return null;
  return (
    <section className="lineage" aria-label={title}>
      <div className="section-head">
        <h3 className="eyebrow">{title}</h3>
        {uses.length > LINEAGE_PREVIEW && <a href="#" aria-expanded={expanded} onClick={(event) => { event.preventDefault(); onToggle(); }}>{expanded ? "Show less" : "Show all"}</a>}
      </div>
      <div className={`links${expanded ? " expanded" : ""}`}>
        {(expanded ? uses : uses.slice(0, LINEAGE_PREVIEW)).map((use) => {
          const ref = parseRef(use.id, pool);
          if (!ref) return null;
          const w = wordFor(ref, links[use.id], display, userId);
          const marked = ownText ? use.id : mark;
          const sentence = use.sentence && w.href ? <Sentence text={use.sentence} pool={ownText ? pool : ref.pool} links={links} users={users} display={display} userId={userId} mark={marked} /> : null;
          if (!w.href) {
            // A hidden pool's memory, a private citer of a general memory, or one that is gone: the ID stays, no words.
            const otherPool = ref.pool !== pool && !hidden(display, ref.pool);
            return otherPool
              ? <a key={use.id} className="lk" href={idHref(userId, pool, use.id)} title={`A ${ref.pool} memory uses this. Its words stay out of a ${pool} memory; open it to read it.`}><span><span className="eyebrow">{ref.pool} {KIND_WORD[ref.kind]}</span></span></a>
              : <div key={use.id} className="lk plain"><span>{w.text}</span></div>;
          }
          return (
            <a key={use.id} className="lk" href={w.href}>
              <span>{ref.kind !== "note" && <span className="eyebrow">{KIND_WORD[ref.kind]}</span>}{w.cite ? firstWords(readable(w.link!.snippet, users)) : w.text}{w.link?.origin === "user" && <span className="cap"> yours</span>}{w.link?.deleted && <span className="cap"> deleted</span>}</span>
              <span className="when num">{dateWord(w.link!.updatedAt)}</span>
              {sentence}
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** A citing sentence as it reads, titles for citations, the cited memory's title marked. */
function Sentence({ text, pool, links, users, display, userId, mark }: { text: string; pool: Pool; links: Record<string, MemoryLink>; users: UserMap; display: Display; userId: string; mark?: string }) {
  const MARK = "⁣";
  const withMark = mark ? text.replace(/(?<!\[)\[([^[\]]+)\](?!\])/g, (whole, inside: string) => (inside.split(/[,;]\s*/).map((x) => x.trim()).includes(mark) ? `${MARK}${whole}${MARK}` : whole)) : text;
  const plain = plainWords(readable(withMark, users), pool, links, display, userId);
  const parts = plain.split(MARK);
  return <span className="q">{parts.map((p, i) => (i % 2 ? (p.trim() ? <mark key={i}>{p.trim()}</mark> : null) : p))}</span>;
}

export function JournalHistoryPage({ ctx, pool, route }: { ctx: ShellContext; pool?: Pool; route?: Extract<Route, { page: "history" }> }) {
  const userId = ctx.user.id;
  return <main className="main">
    <PageHead ctx={ctx} title="Journal history"><a href={href({ page: "memory", userId })}>Memory</a></PageHead>
    <div className="scroll"><div className="sleep">
      <HistoryList<MemoryHit> key={`${userId}/${pool}/${ctx.me.display.showGeneral}/${ctx.me.display.showPrivate}`} route={route} path={`${u(userId, "memory", "journal", "history")}${pool ? `?pool=${pool}` : ""}`} render={(page) => <ul className="list">
        {page.entries.map((entry) => <li key={`${entry.pool}/${entry.id}`}>
          <div className="row between"><a href={href({ page: "memory", userId, pool: entry.pool, id: entry.id })}>{dateText(entry.updatedAt!, { day: "numeric", month: "long", year: "numeric" })}</a><span className={`kind ${entry.pool}`}>{poolWord(entry.pool)}</span></div>
          <p>{entry.snippet}</p>
        </li>)}
      </ul>} />
    </div></div>
  </main>;
}

export function MemoryHistoryPage({ ctx, pool, id, route }: { ctx: ShellContext; pool: Pool; id: string; route?: Extract<Route, { page: "history" }> }) {
  const userId = ctx.user.id;
  const path = u(userId, "memory", pool, id);
  const [run, busy, error] = useAction();
  return <main className="main">
    <PageHead ctx={ctx} title="Memory history"><a href={href({ page: "memory", userId, pool, id })}>Memory</a></PageHead>
    <div className="scroll"><div className="sleep">
      <ErrorText error={error} />
      {hidden(ctx.me.display, pool) ? <p className="empty">{poolWord(pool)} is hidden.</p> :
        <HistoryList<MemoryRevision, MemoryHistory> route={route} path={`${path}/history`} render={(page, reload, offset) => <History detail={page.detail} entries={page.entries} offset={offset} total={page.total} userId={userId} display={ctx.me.display} busy={busy}
          onRestore={(revision) => void run(async () => { await post(`${path}/restore`, { revision }); reload(); })} />} />}
    </div></div>
  </main>;
}

/** The newest earlier version in the preview (the current text is already shown above); paged versions keep their differences and Restore. */
function History({ detail, entries, offset = 1, total, userId, display, busy, onRestore }: { detail: MemoryDetail; entries?: MemoryRevision[]; offset?: number; total?: number; userId: string; display: Display; busy: boolean; onRestore: (revision: number) => void }) {
  const { item, revisions, users, links } = detail;
  // With no earlier version there is nothing to show here at all.
  const shown = entries ?? revisions.slice(1, 2);
  if (!shown.length) return null;
  const plain = (text: string) => plainWords(readable(text, users), item.pool, links, display, userId);
  const current = plain(item.text);
  const by = (r: MemoryRevision) => {
    const who = /^user:(.+)$/.exec(r.author)?.[1];
    return who ? (who === userId ? "yours" : users[who]?.displayName ?? "a user") : r.author;
  };
  return (
    <section className="history">
      {!entries && <HistoryHead to={{ page: "history", userId, kind: "memory", pool: item.pool, id: item.id }} />}
      <div className="hist">
        {shown.map((r, i) => {
          const isCurrent = r.id === revisions[0]?.id;
          const diff = isCurrent ? undefined : wordDiff(current, plain(r.body.text));
          return (
            <details key={r.id} open={i === 0}>
              <summary><span className="when num">{shortTime(r.createdAt)}</span><span className="by">{by(r)}</span><span className="n">{isCurrent ? "current" : entries ? <><span className="num">{(total ?? 0) - (offset + i)}</span> of <span className="num">{total}</span></> : "earlier"}</span></summary>
              {diff ? <div className="wdiff">{diff.map((op, k) => (op.kind === "same" ? <span key={k}>{op.text}</span> : op.kind === "del" ? <del key={k}>{op.text}</del> : <ins key={k}>{op.text}</ins>))}</div>
                : <div className="wdiff">{current}</div>}
              {!isCurrent && <div className="row actions"><button type="button" className="sm" disabled={busy} onClick={() => onRestore(r.id)}>Restore</button></div>}
            </details>
          );
        })}
      </div>
    </section>
  );
}

interface Pick { kind: "page" | "person"; label: string; meta?: string; insert: string; ref?: string; link?: MemoryLink; key: string }

/** Editing in place: an Edit | Preview segment, the textarea, Save as the one primary. `[[` offers pages (saved as IDs) and people (saved as name tokens). */
function Editor({ detail, display, userId, busy, onSave, onCancel }: {
  detail: MemoryDetail; display: Display; userId: string; busy: boolean; onSave: (e: { text: string; title?: string; summary?: string }) => void; onCancel: () => void;
}) {
  const { item, users } = detail;
  // A page citation reads as [[its title]] while editing and is saved as its ID; notes stay cited by ID, since they have no title.
  const [pageTitles, setPageTitles] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(detail.links).filter(([, l]) => l.kind === "page" && l.title).map(([ref, l]) => [ref, l.title!])));
  const editable = (stored: string) => toEditable(stored, users).replace(CITATION_GROUP, (whole, inside: string) => {
    const refs = inside.split(/[,;]\s*/).map((x) => x.trim());
    return refs.every((r) => pageTitles[r]) ? refs.map((r) => `[[${pageTitles[r]}]]`).join(", ") : whole;
  });
  const [text, setText] = useState(() => editable(item.text));
  const [title, setTitle] = useState(item.title ?? "");
  const [summary, setSummary] = useState(() => toEditable(item.summary ?? "", users));
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [picked, setPicked] = useState<Record<string, MemoryLink>>({});
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const page = item.kind === "page";
  const dirty = text !== editable(item.text) || title !== (item.title ?? "") || summary !== toEditable(item.summary ?? "", users);
  // Leaving the page with an unsaved edit asks first, with the browser's own prompt; nothing is kept.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    addEventListener("beforeunload", ask);
    return () => removeEventListener("beforeunload", ask);
  }, [dirty]);
  // The pages `[[` can link: this pool's, and general's from a private memory, from the pools the display shows.
  const pools = (item.pool === "private" ? (["private", "general"] as Pool[]) : ["general" as Pool]).filter((p) => !hidden(display, p));
  const pages = useLoad(() => Promise.all(pools.map((p) => get<MemoryHit[]>(`${u(userId, "memory", "search")}?kinds=page&pool=${p}&limit=100`))).then((r) => r.flat()), [userId, pools.join()]);

  const typing = /\[\[([^[\]]*)$/.exec(text.slice(0, caret));
  const query = typing?.[1]?.toLowerCase() ?? "";
  const picks: Pick[] = typing ? [
    ...(pages.data ?? []).filter((p) => !query || (p.title ?? p.id).toLowerCase().includes(query) || p.id.includes(query)).slice(0, 6)
      .map((p): Pick => ({ kind: "page", label: p.title ?? p.id, meta: p.pool !== item.pool ? `${p.pool} · ${p.snippet}` : p.snippet, key: `${p.pool}/${p.id}`, insert: `[[${p.title ?? p.id}]]`, ref: `${p.pool === item.pool ? "" : `${p.pool}/`}${p.id}`, link: { kind: "page", pool: p.pool, title: p.title, snippet: p.snippet, updatedAt: p.updatedAt ?? "" } })),
    ...Object.entries(users).filter(([, x]) => !query || x.displayName.toLowerCase().includes(query)).slice(0, 4)
      .map(([id, x]): Pick => ({ kind: "person", label: x.displayName, meta: "saved as a name token", key: `u/${id}`, insert: `[[${x.displayName}]]` })),
  ] : [];
  useEffect(() => setActive(0), [query]);
  const pick = (p: Pick) => {
    const start = caret - typing![0].length;
    const next = `${text.slice(0, start)}${p.insert} ${text.slice(caret)}`;
    setText(next);
    if (p.ref && p.link) { setPicked((x) => ({ ...x, [p.ref!]: p.link! })); setPageTitles((x) => ({ ...x, [p.ref!]: p.label })); }
    const at = start + p.insert.length + 1;
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(at, at); setCaret(at); });
  };
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!picks.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % picks.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + picks.length) % picks.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(picks[active]!); }
    else if (e.key === "Escape") { e.preventDefault(); setCaret(0); }
  };
  // Back to stored form: people first (as today), then every [[title]] that names a page the editor knows.
  const byTitle = new Map(Object.entries(pageTitles).map(([ref, t]) => [t, ref]));
  const stored = () => fromEditable(text, users).replace(/\[\[([^[\]:]+)\]\]/g, (whole, t: string) => (byTitle.has(t.trim()) ? `[${byTitle.get(t.trim())}]` : whole));
  return (
    <form className="mem-edit stack" onSubmit={(e) => { e.preventDefault(); onSave({ text: stored(), ...(page && { title, summary: fromEditable(summary, users) }) }); }}>
      <div className="seg" role="group" aria-label="Edit or preview">
        <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>Edit</button>
        <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
      </div>
      {mode === "edit" && page && <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
      {mode === "edit" && page && <label className="field"><span>Summary</span><input value={summary} onChange={(e) => setSummary(e.target.value)} /></label>}
      {mode === "edit" ? (
        <div className="ac">
          <textarea ref={area} aria-label="Text" rows={Math.min(24, Math.max(8, text.split("\n").length + 2))} value={text} aria-autocomplete="list" aria-expanded={picks.length > 0}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }} onKeyDown={keys}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)} onBlur={() => setTimeout(() => setCaret(0), 150)} />
          {picks.length > 0 && (
            <div className="popover" role="listbox" aria-label="Link to">
              {picks.some((p) => p.kind === "page") && <span className="eyebrow">Pages</span>}
              {picks.map((p, i) => (
                <button key={p.key} type="button" className="item" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
                  {p.kind === "person" && i === picks.findIndex((x) => x.kind === "person") && <span className="eyebrow">People</span>}
                  <span>{p.label}</span>{p.meta && <span className="meta muted">{p.meta}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="prose preview-pane"><MemoryProse text={stored()} pool={item.pool} userId={userId} links={{ ...detail.links, ...picked }} users={users} display={display} /></div>
      )}
      <div className="row">
        <button type="submit" className="primary sm" disabled={busy || !text.trim()}>Save</button>
        <button type="button" className="sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const EXPORT_TIP = "Downloads a Markdown file. It isn't encrypted.";

/** Exports notes and pages as one Markdown file the browser saves; the text is held only in this page while it downloads. */
async function download(userId: string, items: { pool: Pool; id: string }[]): Promise<MemoryExport> {
  const out = await post<MemoryExport>(u(userId, "memory", "export"), { items });
  if (out.count) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([out.markdown], { type: "text/markdown" }));
    a.download = out.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  return out;
}

function AddMemory({ userId, onDone, onImported }: { userId: string; onDone: (d?: MemoryDetail) => void; onImported: () => void }) {
  const [mode, setMode] = useState<"write" | "import">("write");
  return (
    <div className="stack mem-add">
      <h2>Add a memory</h2>
      <div className="seg" role="group" aria-label="Write or import">
        <button type="button" aria-pressed={mode === "write"} onClick={() => setMode("write")}>Write</button>
        <button type="button" aria-pressed={mode === "import"} onClick={() => setMode("import")}>Import</button>
      </div>
      {mode === "write" ? <WriteMemory userId={userId} onDone={onDone} /> : <ImportMemories userId={userId} onDone={() => onDone()} onImported={onImported} />}
    </div>
  );
}

/** Import: Markdown files read here and sent to lyricad, each memory written as one the user added. */
function ImportMemories({ userId, onDone, onImported }: { userId: string; onDone: () => void; onImported: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const [pool, setPool] = useState<"" | Pool>("");
  const [result, setResult] = useState<MemoryImportResult>();
  const [run, busy, error] = useAction();
  const submit = () => run(async () => {
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
    setResult(await post<MemoryImportResult>(u(userId, "memory", "import"), { files: read, ...(pool ? { pool } : {}) }));
    onImported();
  });
  if (result) {
    const n = result.imported.length;
    return (
      <div className="stack">
        <p role="status">
          {n ? <>Imported <span className="num">{n}</span> {n === 1 ? "memory" : "memories"}</> : "Nothing new to import"}
          {result.duplicates > 0 && <> · <span className="num">{result.duplicates}</span> already here</>}
          {result.renamed > 0 && <> · <span className="num">{result.renamed}</span> renamed</>}
          {result.linksWorded > 0 && <> · <span className="num">{result.linksWorded}</span> {result.linksWorded === 1 ? "link" : "links"} written out</>}
          {result.skipped > 0 && <> · <span className="num">{result.skipped}</span> skipped</>}
        </p>
        <div className="row"><button type="button" className="primary" onClick={onDone}>Done</button></div>
      </div>
    );
  }
  return (
    <form className="stack import-memory" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="field"><span id="import-files">Files</span>
        <div className="row">
          <button type="button" className="sm" aria-describedby="import-files" onClick={() => picker.current?.click()}>Choose files…</button>
          {files.length > 0 && <span className="picked mono muted">{files.map((f) => f.name).join(", ")}</span>}
        </div>
        <input ref={picker} type="file" multiple hidden aria-labelledby="import-files" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </div>
      <label className="field"><span>Pool</span>
        <select value={pool} title="A file without Lyrica's header goes to Private." onChange={(e) => setPool(e.target.value as "" | Pool)}>
          <option value="">As exported</option><option value="general">General</option><option value="private">Private</option>
        </select>
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !files.length}>Import</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function WriteMemory({ userId, onDone }: { userId: string; onDone: (d?: MemoryDetail) => void }) {
  const [pool, setPool] = useState<Pool>("general");
  const [kind, setKind] = useState<"note" | "page">("note");
  const [text, setText] = useState("");
  const [about, setAbout] = useState("");
  const [links, setLinks] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [run, busy, error] = useAction();
  const linkList = links.split(/[\s,]+/).filter(Boolean);
  const submit = () => run(async () => {
    const body = kind === "note" ? { text, links: linkList, about: about.split(/[\s,]+/).filter(Boolean) } : { slug, title, summary, text, links: linkList };
    onDone(await post<MemoryDetail>(u(userId, "memory", pool, kind === "note" ? "notes" : "pages"), body));
  });
  return (
    <form className="stack add-memory" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
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
          <label className="field"><span>Short name</span><input value={slug} placeholder="node-2-backups" title="How other memories link to it: lowercase letters, digits and hyphens." onChange={(e) => setSlug(e.target.value)} /></label>
          <label className="field"><span>Summary</span><input value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        </>
      )}
      <label className="field"><span>Text</span><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></label>
      {kind === "note" && <label className="field"><span>Tags</span><input value={about} placeholder="garden, backups" onChange={(e) => setAbout(e.target.value)} /></label>}
      <label className="field"><span>Links</span>
        <input value={links} placeholder="t:web/3f7a2c  e:web/3f7a2c#41  n:12" title="Threads, messages or memories this comes from, by ID. Empty makes a free memory." onChange={(e) => setLinks(e.target.value)} />
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !text.trim() || (kind === "page" && (!title || !slug))}>Add</button>
        <button type="button" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}
