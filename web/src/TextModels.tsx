// The Models area's Text models tab (docs/ux.md §6, "A text model's copies, groups and settings"): one row per model
// from GET …/library/text, starred first, opening in place to its copies, where groups are made, ordered and undone;
// each copy's Settings drawer has Sampling and, on a model host, Serving. The whole library is read at once (200 a
// request), so the header's counts, the search and the chips (Starred among them) work here; the list shows 40 rows at a time.
import { ModelLabel } from "./ModelLabel.tsx";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  del, get, HttpError, patch, post, put, u,
  type AnswerSettings, type DeleteCopy, type GroupInfo, type GroupSuggestion, type LibraryEntry, type ModelUse,
  type OfferingInfo, type OfferingSettings, type ServingSettings, type TextLibrary,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { canon, groupWarnings, reseedDraft, type LibraryCopy as Copy } from "./library.ts";
import { RowMenu } from "./Machines.tsx";
import { canEdit, Frame, GB, gb, hostOf, Kind, plural, Price, Retires, UsedIn, VoiceDrawer, type MCtx } from "./ModelsFrame.tsx";
import { replyCap } from "../../core/src/models/settings.ts";
import { go } from "./route.ts";
import { ConfirmDialog, Dialog, ErrorText, useAction, useDismiss, useLoad } from "./ui.tsx";
import { companionsOf, fileChoices, HUB_WORD, size, type FileChoice, type HubFiles } from "./downloads.ts";

type Entry = LibraryEntry;
const PAGE = 40;

/** Every entry of the library, 200 a request (the most the route gives). */
async function wholeLibrary(userId: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await get<TextLibrary>(`${u(userId, "library", "text")}?offset=${offset}&limit=200`);
    out.push(...page.entries);
    if (!page.entries.length || out.length >= page.total) return out;
  }
}

interface Filters { q: string; endpoint: string; kind?: "local" | "cloud"; vision: boolean; starred: boolean }
const NO_FILTERS: Filters = { q: "", endpoint: "", vision: false, starred: false };

/** As the route's own search: the name, a raw name or a label; a copy on the endpoint, of the kind, that sees images. */
function matches(e: Entry, f: Filters): boolean {
  const q = f.q.trim().toLowerCase();
  if (q && !e.name.toLowerCase().includes(q) && !e.copies.some((c) => c.rawName.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))) return false;
  if (f.endpoint && !e.copies.some((c) => c.endpointId === f.endpoint)) return false;
  if (f.kind && !e.copies.some((c) => c.kind === f.kind)) return false;
  if (f.vision && !e.copies.some((c) => c.capabilities.vision)) return false;
  return !f.starred || e.starred;
}

/** A context length as "128k" or "1,024k". */
const tokensK = (n: number) => `${Math.round(n / 1024).toLocaleString("en-US")}k`;

/** What a row and its detail need from the tab. */
interface Lib {
  ctx: MCtx;
  entries: Entry[];
  byKey: Map<string, Entry>;
  byCopy: Map<string, { entry: Entry; copy: Copy }>;
  groups: GroupInfo[];
  suggestions: GroupSuggestion[];
  /** The Models page's record of an offering: its checksum and whether it was separated. */
  offering: (id: string) => OfferingInfo | undefined;
  onHost: (endpointId: string) => boolean;
  /** Copies moved to a row of their own this visit, with the model they left; false once undone. */
  separated: Record<string, string | false>;
  setSeparated: (id: string, from: string | false) => void;
  refresh: () => Promise<void>;
  reveal: (key: string) => void;
  revealCopy: (offeringId: string) => void;
  onSettings: (entry: Entry, copy: Copy) => void;
  onDelete: (entry: Entry, copy: Copy) => void;
}

export function TextModels({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const p = ctx.models.page;
  const lib = useLoad(() => wholeLibrary(userId), [userId, ctx.changed]);
  const groups = useLoad(() => get<GroupInfo[]>(u(userId, "groups")), [userId]);
  const suggestions = useLoad(() => get<GroupSuggestion[]>(u(userId, "groups", "suggestions")), [userId]);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string>();
  const [scrollTo, setScrollTo] = useState<string>();
  const [pendingCopy, setPendingCopy] = useState<string>();
  const [editing, setEditing] = useState<{ entry: Entry; copy: Copy }>();
  const [voice, setVoice] = useState<OfferingInfo>();
  const [deleting, setDeleting] = useState<{ entry: Entry; copy: Copy; usedIn: ModelUse[] }>();
  const [separated, setSeparatedMap] = useState<Record<string, string | false>>({});
  const [toast, setToast] = useState("");
  const [run, busy, error] = useAction();
  const entries = useMemo(() => lib.data ?? [], [lib.data]);
  const list = useMemo(() => entries.filter((e) => matches(e, f)), [entries, f]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const byCopy = useMemo(() => new Map(entries.flatMap((entry) => entry.copies.map((copy) => [copy.offeringId, { entry, copy }] as const))), [entries]);
  const offerings = useMemo(() => new Map((p?.endpoints ?? []).flatMap((ep) => ep.models.map((m) => [m.id, m] as const))), [p]);
  const { set: setLib } = lib, { set: setGroups } = groups, { set: setSuggestions } = suggestions;
  const refresh = useCallback(async () => {
    const [l, g, s] = await Promise.all([wholeLibrary(userId), get<GroupInfo[]>(u(userId, "groups")), get<GroupSuggestion[]>(u(userId, "groups", "suggestions"))]);
    setLib(l); setGroups(g); setSuggestions(s);
  }, [userId, setLib, setGroups, setSuggestions]);
  const filter = (next: Partial<Filters>) => { setF({ ...f, ...next }); setShown(PAGE); };
  // Opening a row from a link elsewhere on the tab: clear the filters if they hide it, show enough pages to reach it.
  const reveal = useCallback((key: string) => {
    let at = list.findIndex((e) => e.key === key);
    if (at < 0) { setF(NO_FILTERS); at = entries.findIndex((e) => e.key === key); }
    if (at < 0) return;
    setShown((n) => Math.max(n, Math.ceil((at + 1) / PAGE) * PAGE));
    setOpen(key);
    setScrollTo(key);
  }, [list, entries]);
  useEffect(() => {
    if (!scrollTo) return;
    document.querySelector(`[data-entry="${CSS.escape(scrollTo)}"]`)?.scrollIntoView({ block: "nearest" });
    setScrollTo(undefined);
  }, [scrollTo]);
  // After Not this model or Undo, the copy's new row opens once the library has it.
  useEffect(() => {
    if (!pendingCopy) return;
    const at = byCopy.get(pendingCopy);
    if (!at) return;
    setPendingCopy(undefined);
    reveal(at.entry.key);
  }, [pendingCopy, byCopy, reveal]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const closeDrawer = useCallback(() => setEditing(undefined), []);
  const closeVoice = useCallback(() => setVoice(undefined), []);

  const star = (e: Entry) => run(async () => {
    await Promise.all(e.copies.map((c) => put(u(userId, "offerings", c.offeringId, "star"), { starred: !e.starred })));
    await refresh();
  });
  const L: Lib = {
    ctx, entries, byKey, byCopy, groups: groups.data ?? [], suggestions: suggestions.data ?? [],
    offering: (id) => offerings.get(id),
    onHost: (endpointId) => p?.endpoints.find((ep) => ep.id === endpointId)?.api === "host",
    separated, setSeparated: (id, from) => setSeparatedMap((m) => ({ ...m, [id]: from })),
    refresh, reveal, revealCopy: setPendingCopy,
    onSettings: (entry, copy) => {
      if (copy.capabilities.speak?.voices.length) {
        setVoice(offerings.get(copy.offeringId) ?? { id: copy.offeringId, modelId: copy.rawName, label: copy.label, manual: false, status: copy.status, ...copy.capabilities });
      } else setEditing({ entry, copy });
    },
    // The first call only says where the copy is used, for the dialog; Delete confirms.
    onDelete: (entry, copy) => void run(async () => {
      const d = await post<DeleteCopy>(u(userId, "offerings", copy.offeringId, "delete-copy"), {});
      setDeleting({ entry, copy, usedIn: d.usedIn });
    }),
  };
  const remove = () => {
    const d = deleting!;
    setDeleting(undefined);
    void run(async () => {
      const done = await post<DeleteCopy>(u(userId, "offerings", d.copy.offeringId, "delete-copy"), { confirm: true });
      if (done.left) setToast(done.left.reason);
      await refresh();
      ctx.models.reload();
    });
  };

  // The header's facts, over the whole library.
  const endpoints = new Map<string, string>();
  for (const e of entries) for (const c of e.copies) endpoints.set(c.endpointId, c.endpointName);
  const copyCount = entries.reduce((n, e) => n + e.copies.length, 0);
  const groupCount = (groups.data ?? []).filter((g) => g.members.some((m) => byCopy.has(m))).length;
  const facts = lib.data && <>
    {plural(entries.length, "model", "models")} · {plural(copyCount, "copy", "copies")} on {plural(endpoints.size, "endpoint", "endpoints")} · {plural(groupCount, "group", "groups")} · <span className="num">{entries.filter((e) => e.starred).length}</span> starred
  </>;
  // The same file on several hosts: the strong suggestions, by the row that holds them.
  const same = [...new Map((suggestions.data ?? []).filter((s) => s.strength === "strong")
    .flatMap((s) => { const at = byCopy.get(s.members[0]!); return at ? [[at.entry.key, at.entry] as const] : []; })).values()];
  const chip = (label: React.ReactNode, on: boolean, onClick: () => void) => <button type="button" className="chip" aria-pressed={on} onClick={onClick}>{label}</button>;
  return (
    <Frame ctx={ctx} tab="text" title="Text models" facts={facts}
      actions={<button type="button" className="primary" onClick={() => go({ page: "models", userId, tab: "downloads", add: "text" })}>Download model</button>}>
      <ErrorText error={lib.error || groups.error || suggestions.error || error} />
      {same.length > 0 && (
        <div className="banner info" role="status">
          <span className="dot info" aria-hidden="true" />
          <span>The same file is on several hosts for {same.map((e, i) => (
            <Fragment key={e.key}>{i > 0 && ", "}<button type="button" className="link" onClick={() => reveal(e.key)}>{e.name}</button></Fragment>
          ))}. Group them?</span>
        </div>
      )}
      {lib.data && <>
        <div className="lib-filters">
          <input type="search" aria-label="Search models" placeholder="Search by name or file" value={f.q} onChange={(e) => filter({ q: e.target.value })} />
          <div className="chip-row" role="group" aria-label="Endpoint">
            {chip("Any endpoint", !f.endpoint, () => filter({ endpoint: "" }))}
            {[...endpoints].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <Fragment key={id}>{chip(name, f.endpoint === id, () => filter({ endpoint: f.endpoint === id ? "" : id }))}</Fragment>)}
          </div>
          <div className="chip-row" role="group" aria-label="Show only">
            {chip("Local", f.kind === "local", () => filter({ kind: f.kind === "local" ? undefined : "local" }))}
            {chip("Cloud", f.kind === "cloud", () => filter({ kind: f.kind === "cloud" ? undefined : "cloud" }))}
            {chip("Vision", f.vision, () => filter({ vision: !f.vision }))}
            {chip("Starred", f.starred, () => filter({ starred: !f.starred }))}
          </div>
        </div>
        <ul className="list library" aria-label="Text models">
          {list.slice(0, shown).map((e) => (
            <EntryRow key={e.key} L={L} e={e} open={open === e.key} busy={busy} onStar={() => void star(e)} onToggle={() => setOpen(open === e.key ? undefined : e.key)} />
          ))}
          {!list.length && <li className="empty">No models match.</li>}
          {list.length > shown && (
            <li className="more-row">
              <button type="button" onClick={() => setShown(shown + PAGE)}>Show <span className="num">{Math.min(PAGE, list.length - shown)}</span> more of <span className="num">{list.length - shown}</span></button>
            </li>
          )}
        </ul>
      </>}
      {editing && (
        <>
          <CopyDrawer key={editing.copy.offeringId} ctx={ctx} entry={editing.entry} copy={editing.copy} onClose={closeDrawer}
            onSaved={(said) => { setEditing(undefined); setToast(said); void refresh(); ctx.models.reload(); }} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={closeDrawer} />
        </>
      )}
      {voice && <VoiceDrawer userId={userId} model={voice} onClose={closeVoice} />}
      {voice && <div className="scrim drawer-scrim" aria-hidden="true" onClick={closeVoice} />}
      {deleting && (
        <DeleteDialog ctx={ctx} entry={deleting.entry} copy={deleting.copy} usedIn={deleting.usedIn} busy={busy}
          loaded={loadedOn(ctx, deleting.copy)} inGroup={deleting.copy.groups.length > 0} onConfirm={remove} onCancel={() => setDeleting(undefined)} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button type="button" className="icon sm" aria-label="Dismiss" onClick={() => setToast("")}><Icon name="close" /></button>
        </div>
      )}
    </Frame>
  );
}

/** A host model as the host's status lists it, on any of its GPUs: loaded (or loading), and whether pinned. */
function onGpus(ctx: MCtx, copy: Copy) {
  const host = ctx.models.page && hostOf(ctx.models.page, copy.endpointId);
  return (host && "status" in host ? host.status.gpus : []).flatMap((g) => g.models).filter((m) => m.id === copy.rawName);
}
const loadedOn = (ctx: MCtx, copy: Copy) => onGpus(ctx, copy).length > 0;

/** "local", "cloud" or "local and cloud". */
const kindWords = (copies: Copy[]) => { const k = [...new Set(copies.map((c) => c.kind))]; return k.length > 1 ? "local and cloud" : k[0] ?? ""; };

/** One model: its star, its name with its pills and a facts line, opening in place to its copies. */
function EntryRow({ L, e, open, busy, onStar, onToggle }: { L: Lib; e: Entry; open: boolean; busy: boolean; onStar: () => void; onToggle: () => void }) {
  const group = L.groups.find((g) => g.id === e.groups[0]);
  const eps = [...new Set(e.copies.map((c) => c.endpointName))];
  const pills = [...(e.base ? ["finetune"] : []), ...(e.copies.every((c) => c.status === "gone") ? ["gone"] : [])];
  const facts = [
    kindWords(e.copies),
    group ? <>group of <span className="num">{group.members.length}</span></> : plural(e.copies.length, "copy", "copies"),
    e.base ? `built on ${e.base.name}` : null,
    <>{eps.slice(0, 3).join(", ")}{eps.length > 3 && <> and <span className="num">{eps.length - 3}</span> more</>}</>,
  ].filter(Boolean);
  return (
    <li className={`lrow${open ? " open" : ""}`} data-entry={e.key}>
      <button type="button" className="icon sm star" aria-pressed={e.starred} aria-label={`${e.starred ? "Unstar" : "Star"} ${e.name}`} disabled={busy} onClick={onStar}>
        <Icon name="star" />
      </button>
      <button type="button" className="lrow-main" aria-expanded={open} onClick={onToggle}>
        <span className="name">{e.name}{pills.map((x) => <span key={x} className={`pill${x === "gone" ? " bad" : ""}`}>{x}</span>)}</span>
        <span className="meta">{facts.map((x, i) => <Fragment key={i}>{i > 0 && " · "}{x}</Fragment>)}</span>
        <Icon name="right" className="lchev" />
      </button>
      {open && <Detail L={L} e={e} group={group} />}
    </li>
  );
}

/**
 * A model's copies side by side, its group's order first; how the group's copies differ; Lyrica's suggestion to group
 * them; what it is a finetune of; and the group with Rename and Ungroup.
 */
function Detail({ L, e, group }: { L: Lib; e: Entry; group?: GroupInfo }) {
  const { ctx } = L;
  const userId = ctx.user.id;
  const [run, busy, error] = useAction();
  const [renaming, setRenaming] = useState<string>();
  const [ungrouping, setUngrouping] = useState(false);
  const members = group ? group.members.flatMap((id) => { const at = L.byCopy.get(id); return at ? [at.copy] : []; }) : [];
  const rows: { c: Copy; order?: number }[] = [
    ...members.map((c) => ({ c, order: group!.members.indexOf(c.offeringId) })),
    ...e.copies.filter((c) => !group?.members.includes(c.offeringId)).map((c) => ({ c })),
  ];
  const differs = (f: (c: Copy) => unknown) => new Set(rows.map(({ c }) => JSON.stringify(f(c) ?? null))).size > 1;
  const diffContext = differs((c) => c.capabilities.contextWindow), diffVision = differs((c) => !!c.capabilities.vision);
  const editGroup = !!group && canEdit(ctx, group);
  const digest = (id: string) => L.offering(id)?.digest;
  const setMembers = (next: string[]) => run(async () => { await patch(u(userId, "groups", group!.id), { members: next }); await L.refresh(); });
  const move = (at: number, by: number) => { const next = [...group!.members]; [next[at], next[at + by]] = [next[at + by]!, next[at]!]; void setMembers(next); };
  const separate = (c: Copy, on: boolean) => run(async () => {
    await put(u(userId, "offerings", c.offeringId, "separate"), { separate: on });
    L.setSeparated(c.offeringId, on ? e.name : false);
    await L.refresh();
    L.revealCopy(c.offeringId);
  });
  const ids = new Set(e.copies.map((c) => c.offeringId));
  const suggested = L.suggestions.filter((s) => s.members.some((m) => ids.has(m)));
  const makeGroup = (s: GroupSuggestion) => run(async () => {
    if (group && editGroup) await patch(u(userId, "groups", group.id), { members: [...group.members, ...s.members.filter((m) => !group.members.includes(m))] });
    else await post(u(userId, "groups"), { name: s.name, members: s.members });
    await L.refresh();
  });
  const base = e.base && L.byKey.get(e.base.key);
  const finetunes = L.entries.filter((x) => x.base?.key === e.key);
  const only = e.copies.length === 1 ? e.copies[0] : undefined;
  const from = only && L.separated[only.offeringId];
  const isSeparate = !!only && (from !== undefined ? from !== false : !!L.offering(only.offeringId)?.separate);
  const rename = () => run(async () => { await patch(u(userId, "groups", group!.id), { name: renaming!.trim() }); setRenaming(undefined); await L.refresh(); });
  const link = (x: Entry) => <button type="button" className="link" onClick={() => L.reveal(x.key)}>{x.name}</button>;
  return (
    <div className="ldetail">
      <div className="tablewrap">
        <table className="stack-table copies">
          <thead>
            <tr>{group && <th>Order</th>}<th>Copy</th><th>Context</th><th>Vision</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {rows.map(({ c, order }) => {
              const own = canEdit(ctx, c);
              const host = L.onHost(c.endpointId);
              const sameFile = order === undefined && !!group && !!digest(c.offeringId) && group.members.some((m) => digest(m) === digest(c.offeringId));
              const menu = [
                ...(order === undefined && e.copies.length > 1 && own ? [{ label: "Not this model", onPick: () => void separate(c, true) }] : []),
                ...(c.downloaded && host && own ? [{ label: "Delete from host…", danger: true, onPick: () => L.onDelete(e, c) }] : []),
              ];
              const canAdd = order === undefined && editGroup && !c.flagged && (!group!.shared || c.shared);
              const cap = [
                c.downloaded ? "downloaded by Lyrica" : host ? "shared folder" : null,
                c.speed?.tokPerSec ? <><span className="num">{Math.round(c.speed.tokPerSec)}</span> tok/s</> : null,
                L.offering(c.offeringId)?.price ? <Price m={L.offering(c.offeringId)!} /> : null,
                L.offering(c.offeringId)?.retiresAt ? <Retires m={L.offering(c.offeringId)!} /> : null,
                <button type="button" className="link sm" aria-label={`Settings for ${c.rawName} on ${c.endpointName}`} onClick={() => L.onSettings(e, c)}>Settings</button>,
                c.flagged ? <span className="warn-text" title={c.flagged}>the file records no finetune, but its name suggests one</span> : null,
              ].filter(Boolean);
              return (
                <tr key={c.offeringId} data-offering={c.offeringId}>
                  {group && <td className="num" data-h="Order">{order !== undefined ? order + 1 : null}</td>}
                  <td className="copy">
                    <div className="copy-name">
                      <ModelLabel model={c.rawName} endpoint={c.endpointName} raw /> <Kind kind={c.kind} />
                      {c.status !== "listed" && <span className={`pill ${c.status === "gone" ? "bad" : "warn"}`}>{c.status}</span>}
                      {sameFile && <span className="pill">same file</span>}
                    </div>
                    <span className="cap">{cap.map((x, i) => <Fragment key={i}>{i > 0 && "\u00a0· "}{x}</Fragment>)}</span>
                  </td>
                  <td className={`num${diffContext ? " differs" : ""}`} data-h="Context">{c.capabilities.contextWindow ? tokensK(c.capabilities.contextWindow) : "—"}</td>
                  <td className={diffVision ? "differs" : undefined} data-h="Vision">{c.capabilities.vision ? "yes" : "no"}</td>
                  <td className="act">
                    {((order !== undefined && editGroup) || canAdd || menu.length > 0) && <div className="octl">
                      {order !== undefined && editGroup && <>
                        <button type="button" className="icon sm" aria-label="Move up" disabled={busy || order === 0} onClick={() => move(order, -1)}><Icon name="up" /></button>
                        <button type="button" className="icon sm" aria-label="Move down" disabled={busy || order === group!.members.length - 1} onClick={() => move(order, 1)}><Icon name="arrow-down" /></button>
                        <button type="button" className="icon sm" aria-label="Remove from the group" title="Remove from the group" disabled={busy || group!.members.length === 1}
                          onClick={() => void setMembers(group!.members.filter((m) => m !== c.offeringId))}><Icon name="close" /></button>
                      </>}
                      {canAdd && (
                        <button type="button" className="sm" disabled={busy} onClick={() => void setMembers([...group!.members, c.offeringId])}>Add to group</button>
                      )}
                      {menu.length > 0 && <RowMenu label={`Actions for ${c.rawName} on ${c.endpointName}`} items={menu} />}
                    </div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorText error={error} />
      {group && groupWarnings(members).map((w) => <p key={w} className="warn-text">{w}</p>)}
      {suggested.map((s) => {
        const sum = s.strength === "strong" ? digest(s.members[0]!) : undefined;
        return (
          <div key={s.members.join(" ")} className="note suggestion">
            <span className="meta">{s.strength === "strong" ? <>Same file on each host{sum && <> · checksum <span className="mono">{sum.slice(0, 8)}</span>…</>}</> : "Same name only"}</span>
            <div className="actions"><button type="button" className="sm" disabled={busy} onClick={() => void makeGroup(s)}>Group</button></div>
          </div>
        );
      })}
      {isSeparate ? (
        <p className="meta">{from ? `Separated from ${from}` : "Separated"} · <button type="button" className="link" disabled={busy || !canEdit(ctx, only!)} onClick={() => void separate(only!, false)}>Undo</button></p>
      ) : e.base ? (
        <p className="meta">Finetune of {base ? link(base) : e.base.name}.</p>
      ) : finetunes.length > 0 && (
        <p className="meta">Finetunes: {finetunes.map((x, i) => <Fragment key={x.key}>{i > 0 && ", "}{link(x)}</Fragment>)}.</p>
      )}
      {group && (renaming === undefined ? (
        <div className="group-line">
          <span className="meta">Group · {group.shared ? "shared with every user" : "only you"}</span>
          {editGroup && (
            <div className="actions">
              <button type="button" className="sm" disabled={busy} onClick={() => setRenaming(group.name)}>Rename</button>
              <button type="button" className="sm" disabled={busy} onClick={() => setUngrouping(true)}>Ungroup</button>
            </div>
          )}
        </div>
      ) : (
        <form className="inline" onSubmit={(ev) => { ev.preventDefault(); void rename(); }}>
          <label className="field grow"><span>Name</span><input autoFocus value={renaming} onChange={(ev) => setRenaming(ev.target.value)} /></label>
          <button className="sm" disabled={busy || !renaming.trim() || renaming.trim() === group.name}>Save</button>
          <button type="button" className="sm" onClick={() => setRenaming(undefined)}>Cancel</button>
        </form>
      ))}
      {ungrouping && group && (
        <ConfirmDialog title={`Ungroup ${group.name}?`} sentence="Lists that name the group drop it. Its copies stay where they are." confirm="Ungroup" danger
          onCancel={() => setUngrouping(false)}
          onConfirm={() => { setUngrouping(false); void run(async () => { await del(u(userId, "groups", group.id)); await L.refresh(); }); }} />
      )}
    </div>
  );
}

/** Delete from host…: what goes, what it frees, and which lists skip it from now on. */
function DeleteDialog({ ctx, entry, copy, usedIn, loaded, inGroup, busy, onConfirm, onCancel }: {
  ctx: MCtx; entry: Entry; copy: Copy; usedIn: ModelUse[]; loaded: boolean; inGroup: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog labelledBy="delete-copy-title" onCancel={onCancel} onSubmit={onConfirm}>
      <h2 id="delete-copy-title">Delete {entry.name} from {copy.endpointName}?</h2>
      <p>
        <code>{copy.rawName}</code> is deleted from the host{copy.size ? <>, which frees <span className="num">{gb(copy.size)}</span> GB</> : null}.
        {loaded && " It's loaded now, so it's unloaded first."}
      </p>
      <UsedIn ctx={ctx} usedIn={usedIn} more={inGroup ? ", and the group keeps its other copies" : ""} />
      {copy.shared && <p>This host is shared, so other people's lists skip it too.</p>}
      <div className="dlg-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="danger primary" disabled={busy} autoFocus>Delete</button>
      </div>
    </Dialog>
  );
}

/* ---- A copy's Settings drawer: Sampling, and on a model host Serving ---- */

type SKey = Exclude<keyof AnswerSettings, "voices" | "speed">;
/** The sampling rows, in this order, with these labels. */
const SAMPLING: { key: SKey; label: string; step?: number; unit?: string }[] = [
  { key: "temperature", label: "Temperature", step: 0.05 },
  { key: "topP", label: "Top-p", step: 0.01 },
  { key: "topK", label: "Top-k", step: 1 },
  { key: "minP", label: "Min-p", step: 0.01 },
  { key: "repeatPenalty", label: "Repeat penalty", step: 0.01 },
  { key: "presencePenalty", label: "Presence penalty", step: 0.1 },
  { key: "frequencyPenalty", label: "Frequency penalty", step: 0.1 },
  { key: "maxTokens", label: "Maximum reply length", step: 1, unit: "tokens" },
  { key: "seed", label: "Seed", step: 1 },
  { key: "stop", label: "Stop strings" },
];
const textOf = (v: unknown) => (v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v));
const valueOf = (k: SKey, text: string) => (text.trim() === "" ? null : k === "stop" ? text.split(",").map((x) => x.trim()).filter(Boolean) : Number(text));

type Scope = "mine" | "shared";
type Placement = { mode: "auto" } | { mode: "gpus"; gpus: number[]; split?: number[]; parallel?: "tensor" | "pipeline" };
type Stretch = { type: "yarn"; factor: number; originalContext?: number };
/** The host's settings that size the model's memory: Reset in the Memory group takes them back to the host's defaults. */
const VISION_TIP = "The vision projector: off saves its memory, and the model no longer sees images.";
const PROJECTOR_TIP = "The vision projector the model loads with. By name is the one beside it whose name matches; a fine-tune may need one picked by hand. A wrong one fails when the model loads.";
const fileName = (path: string) => path.split("/").pop() ?? path;
/** A projector's file name, with its folder when another projector shares the name. */
const projectorName = (path: string, all: { path: string }[]) =>
  all.some((p) => p.path !== path && fileName(p.path) === fileName(path)) ? path.split("/").slice(-2).join("/") : fileName(path);

/**
 * A downloaded model's missing vision projector or MTP file, looked up in the
 * repository it came from and downloaded beside it, where the host finds it
 * at the model's next load.
 */
function MissingCompanions({ userId, hostId, model, origin, lacks, onStarted }: {
  userId: string; hostId: string; model: string; origin: NonNullable<ServingSettings["origin"]>; lacks: { vision: boolean; mtp: boolean }; onStarted: (said: string) => void;
}) {
  const [found, setFound] = useState<FileChoice[]>();
  const [run, busy, error] = useAction();
  const what = lacks.vision && lacks.mtp ? "projector or MTP file" : lacks.vision ? "projector" : "MTP file";
  const look = () => run(async () => {
    const list = await get<HubFiles>(`${u(userId, "hosts", hostId, "hub", "files")}?${new URLSearchParams({ source: origin.source, repo: origin.repo, ...(origin.revision ? { revision: origin.revision } : {}) })}`);
    const choices = fileChoices(list).choices.filter((c) => c.kind && !c.present && lacks[c.kind]);
    // What the host would pair with the model first, as the download picker ticks it.
    const best = companionsOf(choices, model);
    setFound([...choices].sort((a, b) => (best.includes(b.key) ? 1 : 0) - (best.includes(a.key) ? 1 : 0)));
  });
  const download = (c: FileChoice) => run(async () => {
    await post(u(userId, "hosts", hostId, "downloads"), { source: origin.source, repo: origin.repo, ...(origin.revision ? { revision: origin.revision } : {}), files: c.files });
    onStarted(`Downloading ${fileName(c.label)}. The model uses it from its next load.`);
  });
  return (
    <fieldset className="sgroup">
      <legend className="eyebrow">Missing files</legend>
      {!found ? (
        <p className="cap">No {what} here. <button type="button" className="link" disabled={busy} onClick={look}>Look in {origin.repo}</button> <span className="cap">({HUB_WORD[origin.source]})</span></p>
      ) : !found.length ? (
        <p className="cap">{origin.repo} has no {what} this model lacks.</p>
      ) : <>
        {found.map((c) => (
            <div key={c.key} className="srow">
              <span className="lbl"><span className="mono" title={c.key}>{fileName(c.label)}</span> <span className="cap">{c.kind === "vision" ? "Vision" : "MTP"} · <span className="num">{size(c.size)}</span></span></span>
              <button type="button" disabled={busy || !c.fits} title={c.fits ? undefined : "Not enough free space on the host."} onClick={() => download(c)}>Download</button>
            </div>
          ))}
        {found.some((c) => c.kind === "vision") && <p className="cap">A projector takes about its size in GPU memory beside the model: a model that only just fits may need a shorter context.</p>}
      </>}
      <ErrorText error={error} />
    </fieldset>
  );
}
const MTP_TIPS = {
  file: "Multi-token prediction with the model's MTP file: faster answers for a little more memory.",
  "built-in": "Multi-token prediction with the model's own MTP layers: faster answers.",
} as const;
const MEMORY_KEYS = ["contextLength", "stretch", "kvCacheType", "gpuLayers", "systemRam", "flashAttention", "vision", "mmproj", "mtp", "draftMax"];
const MAX_STRETCH = 8;

/** A label, a control and its unit; `word` is the value's source after the label. */
function SRow({ label, word, title, unit, children }: { label: string; word?: string; title?: string; unit?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="srow">
      <span className="lbl"><span title={title}>{label}</span>{word && <span className="cap src">{word}</span>}</span>
      {unit ? <span className="with-unit">{children}<span className="unit">{unit}</span></span> : children}
    </label>
  );
}

/**
 * A copy's Settings: Sampling (each value with its source, yours over the shared ones; on a plain endpoint the
 * context window by hand) and, on a model host, Serving (placement, memory, throughput and template, as host/API.md
 * names them). One Save at the foot saves both; Save and reload applies a loaded model's new serving settings now.
 */
function CopyDrawer({ ctx, entry, copy, onClose, onSaved }: { ctx: MCtx; entry: Entry; copy: Copy; onClose: () => void; onSaved: (said: string) => void }) {
  const userId = ctx.user.id;
  const id = copy.offeringId;
  const ep = ctx.models.page?.endpoints.find((x) => x.id === copy.endpointId);
  const onHost = ep?.api === "host";
  const hostNow = ctx.models.page ? hostOf(ctx.models.page, copy.endpointId) : undefined;
  const allowance = hostNow && "status" in hostNow ? hostNow.status.systemRam?.allowance ?? 0 : 0;
  const own = canEdit(ctx, copy);
  const settings = useLoad(() => get<OfferingSettings>(u(userId, "offerings", id, "settings")), [userId, id, ctx.changed]);
  const serving = useLoad(() => (onHost ? get<ServingSettings>(u(userId, "offerings", id, "serving")) : Promise.resolve(undefined)), [userId, id, onHost, ctx.changed]);
  const [tab, setTab] = useState<"sampling" | "serving">("sampling");
  const [scope, setScope] = useState<Scope>("mine");
  const [texts, setTexts] = useState<Record<Scope, Partial<Record<SKey, string>>>>({ mine: {}, shared: {} });
  const [ctxText, setCtxText] = useState<string>();
  const [draft, setDraft] = useState<Record<string, unknown>>();
  const [splitText, setSplitText] = useState<string>();
  const [pin, setPin] = useState<boolean>();
  // Past the card's stretch: Save anyway repeats the save that was refused, reload included.
  const [above, setAbove] = useState<false | { reload: boolean }>(false);
  const [repo, setRepo] = useState<string>();
  const [run, busy, error] = useAction();
  const [look, looking, lookError] = useAction();
  const ref = useRef<HTMLElement>(null);
  const popRef = useRef<HTMLFormElement>(null);
  const repoOpen = useRef(false);
  repoOpen.current = repo !== undefined;
  useEffect(() => {
    ref.current?.focus();
    // Escape closes the Repository popover first, then the drawer.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !repoOpen.current) onClose(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const closeRepo = useCallback(() => setRepo(undefined), []);
  useDismiss(popRef, repo !== undefined, closeRepo);
  const sv = serving.data;
  // A change from elsewhere (live sync) replaces an untouched draft, so Save never puts the old settings back.
  const seededFrom = useRef<Record<string, unknown>>(undefined);
  useEffect(() => {
    if (!sv) return;
    setDraft((d) => reseedDraft(d, seededFrom.current, sv.settings));
    seededFrom.current = sv.settings;
  }, [sv]);

  // Sampling: a field shows what was typed, else the value saved in this scope; the placeholder is what it inherits.
  const s = settings.data;
  const savedText = (sc: Scope, k: SKey) => (s && s.sources[k] === (sc === "mine" ? "yours" : "shared") ? textOf(s.values[k]) : "");
  // The longest reply: replyCap of the context in effect (one typed here first); a value above it shows clamped, as it is sent.
  const maxOutput = ep?.models.find((m) => m.id === id)?.maxOutput;
  const cap = replyCap(ctxText !== undefined ? Number(ctxText) || undefined : s?.contextWindow?.value, { local: ep?.kind === "local", ...(maxOutput ? { maxOutput } : {}) });
  const capped = (k: SKey, text: string) => (k === "maxTokens" && text.trim() !== "" && Number(text) > cap ? String(cap) : text);
  const shown = (k: SKey) => texts[scope][k] ?? capped(k, savedText(scope, k));
  const clampMax = () => {
    const t = texts[scope].maxTokens;
    if (t === undefined || t.trim() === "" || !Number.isFinite(Number(t))) return;
    setTexts({ ...texts, [scope]: { ...texts[scope], maxTokens: String(Math.min(cap, Math.max(1, Math.round(Number(t))))) } });
  };
  const changes = (sc: Scope) => SAMPLING.map((r) => r.key).filter((k) => texts[sc][k] !== undefined && texts[sc][k] !== savedText(sc, k));
  const hand = s?.contextWindow?.source === "hand";
  const ctxShown = ctxText ?? (hand ? String(s!.contextWindow!.value) : "");
  const ctxChanged = ctxText !== undefined && ctxText !== (hand ? String(s!.contextWindow!.value) : "");
  const samplingChanged = changes("mine").length > 0 || changes("shared").length > 0 || ctxChanged;
  const resettable = SAMPLING.some((r) => shown(r.key) !== "");
  const reset = () => setTexts({ ...texts, [scope]: Object.fromEntries(SAMPLING.map((r) => [r.key, ""])) });
  // An empty field shows what applies instead: the shared value, else the model's own (sent by nobody, used by its server), else the reply cap.
  const inherited = (k: SKey) => scope === "mine" && s?.sources[k] === "shared" ? "shared" : s && k in s.defaults ? "model's" : k === "maxTokens" ? "most" : undefined;
  const placeholder = (k: SKey) => {
    const from = inherited(k);
    return from === "shared" ? textOf(s!.values[k]) : from === "model's" ? textOf((s!.defaults as Record<string, number>)[k]) : from === "most" ? cap.toLocaleString("en-US") : undefined;
  };
  const word = (k: SKey) => {
    if (s?.dropped.includes(k)) return "not sent";
    if (shown(k)) return scope === "mine" ? "yours" : "everyone";
    return inherited(k) === "most" ? undefined : inherited(k);
  };

  // Serving: the host's settings object, edited whole and saved whole.
  const gpus = (() => { const h = ctx.models.page && hostOf(ctx.models.page, copy.endpointId); return h && "status" in h ? h.status.gpus : []; })();
  const here = onGpus(ctx, copy);
  const loaded = here.length > 0, pinned = here.some((m) => m.pinned);
  const llama = /\.gguf$/i.test(copy.rawName);
  const server = llama ? "llama.cpp" : "vLLM";
  const set = (k: string, v: unknown) => { setAbove(false); setDraft((d) => { const n = { ...d }; if (v === undefined) delete n[k]; else n[k] = v; return n; }); };
  const num = (k: string) => (typeof draft?.[k] === "number" ? String(draft[k]) : "");
  const setNum = (k: string, text: string) => set(k, text.trim() === "" ? undefined : Number(text));
  const clamp = (k: string, lo: number, hi: number, whole = true) => {
    const v = draft?.[k];
    if (typeof v === "number" && Number.isFinite(v)) set(k, Math.min(hi, Math.max(lo, whole ? Math.round(v) : v)));
  };
  const placement = (draft?.placement as Placement | undefined) ?? { mode: "auto" as const };
  const chosen = placement.mode === "gpus" ? placement.gpus : [];
  const place = (next: Placement) => set("placement", next.mode === "auto" && !sv?.settings.placement ? undefined : next);
  const choose = (index: number, on: boolean) => {
    if (placement.mode !== "gpus") return;
    const list = on ? [...placement.gpus, index].sort((a, b) => a - b) : placement.gpus.filter((g) => g !== index);
    const { split: _, parallel: __, ...rest } = placement;
    setSplitText(undefined);
    place(list.length > 1 ? { ...rest, gpus: list, ...(placement.parallel ? { parallel: placement.parallel } : {}) } : { ...rest, gpus: list });
  };
  const splitShown = splitText ?? (placement.mode === "gpus" && placement.split ? placement.split.join(", ") : "");
  const splitNums = splitShown.split(/[\s,:]+/).filter(Boolean).map(Number);
  const splitBad = !!splitShown.trim() && (splitNums.length !== chosen.length || splitNums.some((n) => !(n >= 0.01 && n <= 1000)));
  const setSplit = (text: string) => {
    setSplitText(text);
    if (placement.mode !== "gpus") return;
    const nums = text.split(/[\s,:]+/).filter(Boolean).map(Number);
    const { split: _, ...rest } = placement;
    if (!text.trim()) place(rest);
    else if (nums.length === chosen.length && nums.every((n) => n >= 0.01 && n <= 1000)) place({ ...rest, split: nums });
  };
  const sameCards = chosen.length > 1 && new Set(chosen.map((i) => gpus.find((g) => g.index === i)?.name)).size === 1;
  const stretch = draft?.stretch as Stretch | undefined;
  const rec = sv?.recommended;
  // The context a stretch multiplies: the trained length, else the card's original context.
  const base = sv?.trainedContextLength ?? rec?.originalContext ?? null;
  const maxContext = sv ? (base ? (stretch?.originalContext ?? base) * (stretch?.factor ?? 1) : sv.maxContextLength) : null;
  const setFactor = (text: string) => set("stretch", text.trim() === "" ? undefined
    : { type: "yarn", factor: Number(text), ...(stretch?.originalContext ? { originalContext: stretch.originalContext } : !sv?.trainedContextLength && rec?.originalContext ? { originalContext: rec.originalContext } : {}) });
  const setOriginal = (text: string) => {
    if (!stretch) return;
    const { originalContext: _, ...rest } = stretch;
    set("stretch", text.trim() === "" ? rest : { ...rest, originalContext: Number(text) });
  };
  const clampFactor = () => { if (stretch) set("stretch", { ...stretch, factor: Math.min(MAX_STRETCH, Math.max(1, llama ? Math.round(stretch.factor) : stretch.factor)) }); };
  // A Q8_0 or Q4_0 KV cache needs Flash attention on (host/API.md), so choosing one turns it on.
  const kvCache = (v: string) => { set("kvCacheType", v); if (v !== "f16") set("flashAttention", "on"); };
  const memorySet = MEMORY_KEYS.some((k) => draft?.[k] !== undefined);
  const resetMemory = () => { setAbove(false); setDraft((d) => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => !MEMORY_KEYS.includes(k)))); };
  const servingChanged = !!draft && !!sv && canon(draft) !== canon(sv.settings);
  const pinChanged = pin !== undefined && pin !== pinned;
  const invalid = placement.mode === "gpus" && !chosen.length ? "Choose at least one GPU."
    : splitBad ? "Split ratio needs one number per chosen GPU, each from 0.01 to 1000." : "";
  const fileRef = useRef<HTMLInputElement>(null);
  const lookUp = (r?: string) => look(async () => {
    try {
      serving.set(await post<ServingSettings>(u(userId, "offerings", id, "lookup"), r ? { repo: r } : {}));
      setRepo(undefined);
    } catch (e) {
      if (e instanceof HttpError && e.code === "need_repo" && !r) { setRepo(""); return; }
      throw e;
    }
  });

  const save = (reload: boolean, anyway = false) => run(async () => {
    setAbove(false);
    for (const sc of ["mine", "shared"] as const) {
      const keys = changes(sc);
      if (keys.length) await put<OfferingSettings>(u(userId, "offerings", id, "settings"), { scope: sc, values: Object.fromEntries(keys.map((k) => [k, valueOf(k, capped(k, texts[sc][k]!))])) });
    }
    if (ctxChanged) await patch(u(userId, "offerings", id), { contextWindow: ctxText!.trim() === "" ? null : Number(ctxText) });
    if (servingChanged) {
      try {
        await put(u(userId, "offerings", id, "serving"), { settings: draft, ...(anyway ? { anyway: true } : {}) });
      } catch (e) {
        if (e instanceof HttpError && e.code === "above_recommended") setAbove({ reload });
        throw e;
      }
    }
    if (pinChanged) await post(u(userId, "hosts", copy.endpointId, "manage"), { method: "POST", path: "/host/v1/models/pin", body: { model: copy.rawName, pinned: pin } });
    if (reload) await post(u(userId, "offerings", id, "reload"));
    onSaved(reload ? `Saved. Reloading ${entry.name} with the new settings.` : "Saved.");
  });
  const changed = samplingChanged || servingChanged || pinChanged;
  const serveOwn = own && !!sv;

  const sampling = <>
    {copy.shared && ctx.user.admin && (
      <div className="seg" role="group" aria-label="Whose values">
        <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>Yours</button>
        <button type="button" aria-pressed={scope === "shared"} onClick={() => setScope("shared")}>Everyone's</button>
      </div>
    )}
    <ErrorText error={settings.error} />
    <fieldset className="sgroup" disabled={!s || busy}>
      <legend className="eyebrow">Sampling</legend>
      {SAMPLING.map(({ key, label, step, unit }) => (
        <SRow key={key} label={label} word={word(key)} unit={key === "maxTokens" ? <>of <span className="num">{cap.toLocaleString("en-US")}</span> {unit}</> : unit}>
          <input type={key === "stop" ? "text" : "number"} step={step} aria-label={label} disabled={s?.dropped.includes(key)}
            {...(key === "maxTokens" ? { min: 1, max: cap, onBlur: clampMax } : {})}
            title={key === "stop" ? "Separate them with commas" : undefined}
            placeholder={placeholder(key)}
            value={shown(key)} onChange={(e) => setTexts({ ...texts, [scope]: { ...texts[scope], [key]: e.target.value } })} />
        </SRow>
      ))}
      {resettable && (
        <button type="button" className="link sm" title={scope === "mine" && copy.shared ? "Back to the shared values" : "Back to the endpoint's defaults"} onClick={reset}>Reset</button>
      )}
    </fieldset>
    {ep && !onHost && (
      <fieldset className="sgroup" disabled={!s || busy || !own}>
        <legend className="eyebrow">Context</legend>
        <SRow label="Context window" word={ctxShown ? "set by hand" : s?.contextWindow.source === "assumed" ? "assumed" : s?.contextWindow.source === "host" ? "loaded" : undefined} unit="tokens">
          <input type="number" min={512} step={1024} aria-label="Context window" value={ctxShown} onChange={(e) => setCtxText(e.target.value)}
            placeholder={s && !hand ? s.contextWindow.value.toLocaleString("en-US") : undefined} />
        </SRow>
      </fieldset>
    )}
  </>;

  const servingBody = !sv || !draft ? <ErrorText error={serving.error} /> : <>
    <fieldset className="sgroup" disabled={busy || !serveOwn}>
      <legend className="eyebrow">Placement · {server}</legend>
      <div className="seg" role="group" aria-label="Placement">
        <button type="button" aria-pressed={placement.mode === "auto"} onClick={() => { setSplitText(undefined); place({ mode: "auto" }); }}>Auto</button>
        <button type="button" aria-pressed={placement.mode === "gpus"} onClick={() => placement.mode !== "gpus" && place({ mode: "gpus", gpus: [] })}>Choose GPUs</button>
      </div>
      {placement.mode === "gpus" && (
        <div className="gpu-pick">
          {gpus.map((g) => (
            <label key={g.index} className="check">
              <input type="checkbox" checked={chosen.includes(g.index)} onChange={(e) => choose(g.index, e.target.checked)} />
              <span>GPU <span className="num">{g.index}</span> · {g.name} · <span className="num">{Math.round(g.vram.total / 2 ** 30)}</span> GB</span>
            </label>
          ))}
        </div>
      )}
      {chosen.length > 1 && (llama ? (
        <SRow label="Split ratio"><input type="text" className="mono" aria-label="Split ratio" placeholder="even" value={splitShown} onChange={(e) => setSplit(e.target.value)} /></SRow>
      ) : (
        <SRow label="Parallelism">
          <select aria-label="Parallelism" value={placement.mode === "gpus" ? placement.parallel ?? (sameCards ? "tensor" : "pipeline") : "tensor"}
            onChange={(e) => placement.mode === "gpus" && place({ ...placement, parallel: e.target.value as "tensor" | "pipeline" })}>
            <option value="tensor">Tensor parallel</option><option value="pipeline">Pipeline parallel</option>
          </select>
        </SRow>
      ))}
      {!llama && (
        <SRow label="Memory share" unit="%">
          <input type="number" min={5} max={95} step={5} aria-label="Memory share" value={typeof draft.memoryShare === "number" ? String(Math.round(draft.memoryShare * 100)) : ""}
            onChange={(e) => set("memoryShare", e.target.value.trim() === "" ? undefined : Number(e.target.value) / 100)}
            onBlur={() => { const v = draft.memoryShare; if (typeof v === "number") set("memoryShare", Math.min(95, Math.max(5, Math.round(v * 100))) / 100); }} />
        </SRow>
      )}
      <label className="check"><input type="checkbox" checked={pin ?? pinned} onChange={(e) => setPin(e.target.checked)} /> Pinned</label>
      {invalid ? <p className="estimate bad" role="status">{invalid}</p>
        : sv.kvBytes !== null && <p className="estimate" role="status">KV cache <span className="num">{gb(sv.kvBytes)}</span> GB at <span className="num">{tokensK(sv.contextLength)}</span> tokens</p>}
      {!invalid && !!sv.ramBytes && <p className="estimate" role="status"><span className="num">{gb(sv.ramBytes)}</span> GB stays in system RAM, so it runs slower.</p>}
    </fieldset>
    <fieldset className="sgroup" disabled={busy || !serveOwn}>
      <legend className="sr-only">Memory</legend>
      <div className="sgroup-head">
        <span className="eyebrow" aria-hidden="true">Memory</span>
        <span className="spacer" />
        <button type="button" className="link sm" disabled={looking} onClick={() => void lookUp()}>Look up</button>
        {memorySet && <button type="button" className="link sm" title="Back to the host's defaults" onClick={resetMemory}>Reset</button>}
        {repo !== undefined && (
          <form ref={popRef} className="repo-pop" onSubmit={(e) => { e.preventDefault(); if (repo.trim()) void lookUp(repo.trim()); }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeRepo(); } }}>
            <label className="field"><span>Repository</span><input className="mono" autoFocus autoCapitalize="none" placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
            <button className="sm" disabled={looking || !repo.trim()}>Look up</button>
          </form>
        )}
      </div>
      <ErrorText error={lookError} />
      <SRow label="Context length" unit={maxContext ? `of ${tokensK(maxContext)}` : "tokens"}>
        <input type="number" min={512} max={maxContext ?? undefined} step={1024} aria-label="Context length" placeholder={String(sv.contextLength)} value={num("contextLength")}
          onChange={(e) => setNum("contextLength", e.target.value)} onBlur={() => clamp("contextLength", 512, maxContext ?? Infinity)} />
      </SRow>
      <SRow label="Stretch" title={`RoPE scaling (YaRN): off while empty. It applies to every request, so publishers suggest it only for long contexts.${rec?.factor ? ` The model's card suggests ${rec.factor}×.` : ""}`}
        word={stretch ? "yours" : undefined} unit="×">
        <input type="number" min={1} max={MAX_STRETCH} step={llama ? 1 : 0.5} aria-label="Stretch" disabled={!base}
          placeholder="Off" value={stretch ? String(stretch.factor) : ""} onChange={(e) => setFactor(e.target.value)} onBlur={clampFactor} />
      </SRow>
      {stretch && (
        <SRow label="Original context" title="The context the model was trained for, which the stretch multiplies." word={stretch.originalContext ? "yours" : undefined} unit="tokens">
          <input type="number" min={512} step={1024} aria-label="Original context"
            placeholder={String(rec?.originalContext ?? sv.trainedContextLength ?? "")} value={stretch.originalContext ? String(stretch.originalContext) : ""} onChange={(e) => setOriginal(e.target.value)} />
        </SRow>
      )}
      {llama && <>
        <SRow label="KV cache">
          <select aria-label="KV cache" value={typeof draft.kvCacheType === "string" ? draft.kvCacheType : "f16"} onChange={(e) => kvCache(e.target.value)}>
            <option value="f16">F16</option><option value="q8_0">Q8_0</option><option value="q4_0">Q4_0</option>
          </select>
        </SRow>
        {(!!allowance || draft.systemRam === false) && (
          <SRow label="System RAM" title={`Auto keeps what doesn't fit the GPUs in system RAM, slower; Off refuses a model too big for them.${allowance ? ` The host's allowance is ${Math.round(allowance / GB)} GB.` : ""}`}>
            <select aria-label="System RAM" value={draft.systemRam === false ? "off" : "auto"} onChange={(e) => set("systemRam", e.target.value === "off" ? false : undefined)}>
              <option value="auto">Auto</option><option value="off">Off</option>
            </select>
          </SRow>
        )}
        <label className="check"><input type="checkbox" checked={draft.flashAttention === "on"} onChange={(e) => set("flashAttention", e.target.checked ? "on" : undefined)} /> Flash attention</label>
        {!!sv.projectors?.length && (
          <SRow label="Projector" title={PROJECTOR_TIP} word={typeof draft.mmproj === "string" ? "yours" : undefined}>
            <select aria-label="Projector" title={typeof draft.mmproj === "string" ? draft.mmproj : sv.matchedProjector ?? undefined}
              value={typeof draft.mmproj === "string" ? draft.mmproj : ""} onChange={(e) => set("mmproj", e.target.value || undefined)}>
              <option value="">{sv.matchedProjector ? `By name: ${fileName(sv.matchedProjector)}` : "By name: none"}</option>
              {sv.projectors.map((p) => <option key={p.path} value={p.path}>{projectorName(p.path, sv.projectors ?? [])} · {size(p.size)}</option>)}
            </select>
          </SRow>
        )}
        {sv.extras?.vision && (
          <label className="check" title={VISION_TIP}>
            <input type="checkbox" checked={draft.vision !== false} onChange={(e) => set("vision", e.target.checked ? undefined : false)} /> Vision<span className="sr-only">. {VISION_TIP}</span>
          </label>
        )}
        {sv.extras?.mtp && <>
          <label className="check" title={MTP_TIPS[sv.extras.mtp]}>
            <input type="checkbox" checked={draft.mtp !== false} onChange={(e) => set("mtp", e.target.checked ? undefined : false)} /> MTP<span className="sr-only">. {MTP_TIPS[sv.extras.mtp]}</span>
          </label>
          {draft.mtp !== false && (
            <SRow label="Draft tokens" title="Tokens MTP guesses ahead. Try 1 to 6." unit="of 6">
              <input type="number" min={1} max={6} step={1} aria-label="Draft tokens" placeholder="2" value={num("draftMax")} onChange={(e) => setNum("draftMax", e.target.value)} onBlur={() => clamp("draftMax", 1, 6)} />
            </SRow>
          )}
        </>}
      </>}
    </fieldset>
    {llama && sv.origin && serveOwn && (!sv.extras?.vision || !sv.extras.mtp) && (
      <MissingCompanions userId={userId} hostId={copy.endpointId} model={copy.rawName} origin={sv.origin} lacks={{ vision: !sv.extras?.vision, mtp: !sv.extras?.mtp }} onStarted={onSaved} />
    )}
    <fieldset className="sgroup" disabled={busy || !serveOwn}>
      <legend className="eyebrow">Throughput</legend>
      {llama ? <>
        <SRow label="Parallel" unit="of 64">
          <input type="number" min={1} max={64} step={1} aria-label="Parallel" placeholder="1" value={num("parallel")} onChange={(e) => setNum("parallel", e.target.value)} onBlur={() => clamp("parallel", 1, 64)} />
        </SRow>
        <SRow label="Batch size" unit="tokens">
          <input type="number" min={32} max={65536} step={128} aria-label="Batch size" value={num("batchSize")} onChange={(e) => setNum("batchSize", e.target.value)} onBlur={() => clamp("batchSize", 32, 65536)} />
        </SRow>
      </> : <>
        <SRow label="Max sequences" unit="of 1,024">
          <input type="number" min={1} max={1024} step={1} aria-label="Max sequences" value={num("maxSeqs")} onChange={(e) => setNum("maxSeqs", e.target.value)} onBlur={() => clamp("maxSeqs", 1, 1024)} />
        </SRow>
        <SRow label="Data type">
          <select aria-label="Data type" value={typeof draft.dtype === "string" ? draft.dtype : "auto"} onChange={(e) => set("dtype", e.target.value === "auto" ? undefined : e.target.value)}>
            <option value="auto">Auto</option><option value="bfloat16">BF16</option><option value="float16">FP16</option>
          </select>
        </SRow>
      </>}
    </fieldset>
    <fieldset className="sgroup" disabled={busy || !serveOwn}>
      <legend className="eyebrow">Template</legend>
      <SRow label="Template">
        <select aria-label="Template" value={typeof draft.chatTemplate === "string" ? "custom" : "model"}
          onChange={(e) => { if (e.target.value === "custom") fileRef.current?.click(); else set("chatTemplate", undefined); }}>
          <option value="model">From the model</option><option value="custom">Custom file…</option>
        </select>
      </SRow>
      <input ref={fileRef} type="file" hidden accept=".jinja,.j2,.txt,text/plain"
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void file.text().then((t) => set("chatTemplate", t)); }} />
    </fieldset>
  </>;

  return (
    <aside ref={ref} tabIndex={-1} className="drawer copy-drawer" aria-label={`Settings for ${entry.name}`}>
      <div className="drawer-head">
        <div className="copy-title"><h2>{entry.name}</h2><span className="cap">{copy.endpointName} <Kind kind={copy.kind} /> · <code>{copy.rawName}</code></span></div>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="drawer-body">
        {onHost && (
          <div className="seg" role="group" aria-label="Settings">
            <button type="button" aria-pressed={tab === "sampling"} title="Temperature and the other sampling settings, sent with every call" onClick={() => setTab("sampling")}>Sampling</button>
            <button type="button" aria-pressed={tab === "serving"} title="Placement, context and memory on the host" onClick={() => setTab("serving")}>Serving</button>
          </div>
        )}
        {tab === "sampling" || !onHost ? sampling : servingBody}
      </div>
      <div className="drawer-foot copy-foot">
        <ErrorText error={error} />
        <button type="button" className="sm" onClick={onClose}>Cancel</button>
        {loaded && servingChanged && (
          <button type="button" className="sm" disabled={busy || !!invalid} title="Reload the model with these settings now" onClick={() => void save(true)}>Save and reload</button>
        )}
        {above && <button type="button" className="sm" disabled={busy} onClick={() => void save(above.reload, true)}>Save anyway</button>}
        <button type="button" className="sm primary" disabled={busy || !changed || !!invalid} title={tab === "serving" ? "Applies at the next load" : "Sent with every call to this copy"}
          onClick={() => void save(false)}>Save</button>
      </div>
    </aside>
  );
}
