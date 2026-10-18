import { ModelLabel, modelName } from "./ModelLabel.tsx";
import { CloudImageControls } from "./CloudImageControls.tsx";
// The Models area's Image models tab (docs/ux.md §6, "Image models, recipes and parts"): a row per recipe, opening to
// its copy on each host as a block of parts, and a row per image model on a plain endpoint; Parts, every image model
// file by type; To review, the recipes the hosts proposed; and Download image model. Each host's library is GET
// …/hosts/:id/images, and every change a RecipeAction (POST …/hosts/:id/recipes/:recipeId), which on a shared host is
// for administrators. The pure parts are in src/images.ts.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { get, post, u, type DeleteCopy, type GroupInfo, type HubTokenInfo, type ModelsPage, type ModelUse, type OfferingInfo, type RecipeAction } from "./api.ts";
import { fileChoices, size } from "./downloads.ts";
import { GatedNote, HostField, LinkFields, linkProblem, managedHosts, RepoField, Size, startDownload, tokenFor, useLookup, wayBack } from "./Downloads.tsx";
import { Icon } from "./icons.tsx";
import {
  addableRoles, archWord, defaultsWords, deletePlan, fileName, missingOf, precisionWord, recipeFiles, recipeRows, ROLE_WORD, roleWord, slotWord, withLora,
  type HostLibrary, type HostPart, type HostRecipe, type ImageRow, type RecipeCopy, type Role,
} from "./images.ts";
import { RowMenu } from "./Machines.tsx";
import { canEdit, Frame, plural, UsedIn, type MCtx } from "./ModelsFrame.tsx";
import { her } from "./name.ts";
import { go, href } from "./route.ts";
import { Dialog, ErrorText, useAction, useLoad, useLongPress, useSelection } from "./ui.tsx";

type Endpoint = ModelsPage["endpoints"][number];
/** One host's library with its endpoint, or why it couldn't be read. */
interface Read { ep: Endpoint; lib: HostLibrary; error?: string }

const PAGE = 50;
const DOWNLOAD_ANOTHER = "\u0000download";

async function readLibrary(userId: string, ep: Endpoint): Promise<HostLibrary> {
  const l = await get<{ recipes: unknown[]; parts: Record<string, unknown[]> }>(u(userId, "hosts", ep.id, "images"));
  return { hostId: ep.id, host: ep.name, recipes: l.recipes as HostRecipe[], parts: Object.values(l.parts).flat() as HostPart[] };
}

/** Every host's image library, read together once the Models page has said which hosts there are; `only` narrows them. */
function useLibraries(ctx: MCtx, only?: (ep: Endpoint) => boolean) {
  const userId = ctx.user.id;
  const p = ctx.models.page;
  const hosts = (p?.endpoints ?? []).filter((ep) => ep.api === "host" && (!only || only(ep)));
  const key = hosts.map((ep) => `${ep.id}:${ep.name}`).join(" ");
  return useLoad(() => (!p ? new Promise<Read[]>(() => {}) : Promise.all(hosts.map(async (ep): Promise<Read> => {
    try { return { ep, lib: await readLibrary(userId, ep) }; }
    catch (e) { return { ep, lib: { hostId: ep.id, host: ep.name, recipes: [], parts: [] }, error: `${ep.name}: ${(e as Error).message}` }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }))), [userId, key, !!p]);
}

/** The recipes the hosts proposed, by host and name. */
const proposalsOf = (libs: HostLibrary[]): RecipeCopy[] => libs.flatMap((l) => l.recipes.filter((r) => r.state === "proposed")
  .sort((a, b) => a.name.localeCompare(b.name)).map((recipe) => ({ hostId: l.hostId, host: l.host, recipe })));

/** The image models on plain endpoints: no parts, so one line each. */
const plainModels = (p?: ModelsPage) => (p?.endpoints ?? []).filter((ep) => ep.api !== "host")
  .flatMap((ep) => ep.models.filter((m) => (m.image || m.edit) && m.status !== "gone").map((m) => ({ ep, m })));

/** The architectures the hosts report, for the chips. */
const archesOf = (libs: HostLibrary[]) => [...new Set(libs.flatMap((l) => [...l.recipes.filter((r) => r.state !== "ignored").map((r) => r.arch), ...l.parts.flatMap((p) => (p.arch ? [p.arch] : []))]))]
  .sort((a, b) => archWord(a).localeCompare(archWord(b)));

/** What a copy block needs from its page. */
interface Lib {
  ctx: MCtx;
  busy: boolean;
  libOf: (hostId: string) => HostLibrary | undefined;
  editable: (hostId: string) => boolean;
  act: (c: RecipeCopy, a: RecipeAction) => void;
  onAddPart?: (c: RecipeCopy) => void;
  onDelete?: (c: RecipeCopy) => void;
}
const recipeOf = (L: Lib, hostId: string, id: string) => L.libOf(hostId)?.recipes.find((r) => r.id === id);
const nameOf = (L: Lib, hostId: string, id: string) => recipeOf(L, hostId, id)?.name;

const chip = (label: React.ReactNode, on: boolean, onClick: () => void) => <button type="button" className="chip" aria-pressed={on} onClick={onClick}>{label}</button>;

/** Any architecture, then one chip per architecture. */
function ArchChips({ arches, arch, setArch }: { arches: string[]; arch: string; setArch: (a: string) => void }) {
  if (!arches.length) return null;
  return (
    <div className="chip-row" role="group" aria-label="Architecture">
      {chip("Any architecture", !arch, () => setArch(""))}
      {arches.map((a) => <Fragment key={a}>{chip(archWord(a), arch === a, () => setArch(arch === a ? "" : a))}</Fragment>)}
    </div>
  );
}

type PartType = Role | "unused";
const TYPES: [PartType, string][] = [
  ["checkpoint", "Checkpoints"], ["diffusion", "Diffusion models"], ["text_encoder", "Text encoders"], ["vae", "VAEs"], ["lora", "LoRAs"], ["upscaler", "Upscalers"], ["unused", "Unused files"],
];

export function ImageModels({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const p = ctx.models.page;
  const libs = useLibraries(ctx);
  const groups = useLoad(() => get<GroupInfo[]>(u(userId, "groups")), [userId]);
  const [view, setView] = useState<"models" | "parts">("models");
  const [q, setQ] = useState("");
  const [arch, setArch] = useState("");
  const [type, setType] = useState<PartType>();
  const [open, setOpen] = useState<string>();
  const [scrollTo, setScrollTo] = useState<string>();
  const [adding, setAdding] = useState<RecipeCopy>();
  const [deleting, setDeleting] = useState<{ c: RecipeCopy; usedIn: ModelUse[] }>();
  const [toast, setToast] = useState("");
  const [run, busy, error] = useAction();
  const reads = useMemo(() => libs.data ?? [], [libs.data]);
  const all = useMemo(() => reads.map((r) => r.lib), [reads]);
  const rows = useMemo(() => recipeRows(all), [all]);
  const plain = useMemo(() => plainModels(p), [p]);
  const arches = useMemo(() => archesOf(all), [all]);
  const editable = useCallback((hostId: string) => { const ep = reads.find((r) => r.ep.id === hostId)?.ep; return !!ep && canEdit(ctx, ep); }, [reads, ctx]);
  /** A confirmed recipe's offering: what lists, groups and stars name. */
  const offeringOf = (c: RecipeCopy): OfferingInfo | undefined => p?.endpoints.find((ep) => ep.id === c.hostId)?.models.find((m) => m.modelId === `recipe/${c.recipe.id}`);
  const { reload: reloadLibs } = libs, { reload: reloadModels } = ctx.models, { reload: reloadGroups } = groups;
  const refresh = useCallback(() => { reloadLibs(); reloadModels(); reloadGroups(); }, [reloadLibs, reloadModels, reloadGroups]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!scrollTo) return;
    document.querySelector(`[data-entry="${CSS.escape(scrollTo)}"]`)?.scrollIntoView({ block: "nearest" });
    setScrollTo(undefined);
  }, [scrollTo]);

  const needle = q.trim().toLowerCase();
  const shownRows = rows.filter((r) => (!arch || r.copies.some((c) => c.recipe.arch === arch))
    && (!needle || `${r.name} ${r.copies.flatMap((c) => recipeFiles(c.recipe)).join(" ")}`.toLowerCase().includes(needle)));
  const shownPlain = arch ? [] : plain.filter(({ m }) => !needle || m.modelId.toLowerCase().includes(needle));
  /** Opens a row from a link elsewhere on the tab, clearing the filters if they hide it. */
  const reveal = (key: string) => {
    setView("models");
    if (!shownRows.some((r) => r.key === key)) { setQ(""); setArch(""); }
    setOpen(key);
    setScrollTo(key);
  };
  const L: Lib = {
    ctx, busy, editable,
    libOf: (hostId) => all.find((l) => l.hostId === hostId),
    act: (c, a) => void run(async () => { await post(u(userId, "hosts", c.hostId, "recipes", c.recipe.id), a); refresh(); }),
    onAddPart: setAdding,
    // The first call only says where the model is used, for the dialog; Delete deletes.
    onDelete: (c) => void run(async () => {
      const o = offeringOf(c);
      setDeleting({ c, usedIn: o ? (await post<DeleteCopy>(u(userId, "offerings", o.id, "delete-copy"), {})).usedIn : [] });
    }),
  };
  const remove = () => {
    const { c } = deleting!;
    const plan = deletePlan(c.recipe, L.libOf(c.hostId)?.parts ?? [], (id) => recipeOf(L, c.hostId, id));
    setDeleting(undefined);
    void run(async () => {
      const done = await post<{ kept?: { file: string; reason: string }[] }>(u(userId, "hosts", c.hostId, "recipes", c.recipe.id), { do: "delete" });
      // A file the dialog said would go but the host kept (it changed since it was downloaded).
      const kept = (done?.kept ?? []).filter((k) => plan.goes.some((g) => g.file === k.file));
      if (kept.length) setToast(kept.map((k) => `${fileName(k.file)} was kept. ${k.reason}`).join(" "));
      refresh();
    });
  };
  const addPart = (c: RecipeCopy, a: { role: Role; file: string; slot: string | null; strength: number; asNew: boolean }) => {
    setAdding(undefined);
    const path = (id: string) => u(userId, "hosts", c.hostId, "recipes", id);
    void run(async () => {
      if (a.role !== "lora") await post(path(c.recipe.id), { do: "change", change: { op: "addPart", role: a.role, file: a.file, ...(a.slot ? { slot: a.slot } : {}) } });
      else {
        // A LoRA changes what the model draws, so by default it goes into a copy: a model of its own, linked to this one.
        const target = a.asNew ? await post<HostRecipe>(path(c.recipe.id), { do: "copy", name: withLora(c.recipe.name, a.file) }) : c.recipe;
        await post(path(target.id), { do: "change", change: { op: "addLora", file: a.file, strength: a.strength } });
        if (a.asNew) { setOpen(target.name.trim().toLowerCase()); setScrollTo(target.name.trim().toLowerCase()); }
      }
      refresh();
    });
  };

  // The header's facts, over every host.
  const partCount = all.reduce((n, l) => n + l.parts.length, 0);
  const imageIds = new Set([...rows.flatMap((r) => r.copies.map((c) => offeringOf(c)?.id)), ...plain.map(({ m }) => m.id)].filter(Boolean));
  const groupCount = (groups.data ?? []).filter((g) => g.members.some((m) => imageIds.has(m))).length;
  const toReview = proposalsOf(reads.filter((r) => canEdit(ctx, r.ep)).map((r) => r.lib)).length;
  const facts = libs.data && <>
    {plural(rows.length + plain.length, "model (recipe)", "models (recipes)")} · {plural(partCount, "part", "parts")} on {plural(reads.filter((r) => !r.error).length, "host", "hosts")} · {plural(groupCount, "group", "groups")}
    {toReview > 0 && <> · <a className="nowrap" href={href({ page: "models", userId, tab: "images", add: "review" })}><span className="num">{toReview}</span> to review</a></>}
  </>;
  const counts = new Map(TYPES.map(([t]) => [t, all.reduce((n, l) => n + l.parts.filter((x) => (t === "unused" ? !x.usedBy.length : x.role === t)).length, 0)]));
  const types = TYPES.filter(([t]) => t !== "upscaler" || counts.get(t));
  const t = type ?? types.find(([x]) => counts.get(x))?.[0] ?? "checkpoint";
  return (
    <Frame ctx={ctx} tab="images" title="Image models" facts={facts}
      actions={<button type="button" className="primary" onClick={() => go({ page: "models", userId, tab: "images", add: "image" })}>Download model</button>}>
      <ErrorText error={ctx.models.error || libs.error || groups.error || error} />
      {reads.map((r) => r.error && <ErrorText key={r.ep.id} error={r.error} />)}
      {libs.data && <>
        <div className="lib-filters">
          <div className="img-filters">
            <div className="seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={view === "models"} onClick={() => setView("models")}>Models</button>
              <button type="button" aria-pressed={view === "parts"} onClick={() => setView("parts")}>Parts</button>
            </div>
            <input type="search" aria-label="Search image models" placeholder="Search by name or file" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ArchChips arches={arches} arch={arch} setArch={setArch} />
          {view === "parts" && (
            <div className="chip-row" role="group" aria-label="Type">
              {types.map(([x, label]) => <Fragment key={x}>{chip(<>{label} <span className="num">{counts.get(x)}</span></>, t === x, () => setType(x))}</Fragment>)}
            </div>
          )}
        </div>
        {view === "models" ? (
          <ul className="list library" aria-label="Image models">
            {shownRows.map((r) => (
              <RecipeRow key={r.key} L={L} row={r} groups={groups.data ?? []} offeringOf={offeringOf} open={open === r.key} reveal={reveal}
                onToggle={() => setOpen(open === r.key ? undefined : r.key)} />
            ))}
            {shownPlain.map(({ ep, m }) => <PlainRow ctx={ctx} key={m.id} ep={ep} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? undefined : m.id)} />)}
            {!shownRows.length && !shownPlain.length && <li className="empty">{rows.length + plain.length ? "No image models match." : "No image models yet."}</li>}
          </ul>
        ) : (
          <Parts libs={all} type={t} arch={arch} needle={needle} reviewHref={href({ page: "models", userId, tab: "images", add: "review" })} reveal={reveal} />
        )}
      </>}
      {adding && <AddPart L={L} c={adding} onAdd={(a) => addPart(adding, a)} onCancel={() => setAdding(undefined)} />}
      {deleting && <DeleteRecipe L={L} c={deleting.c} usedIn={deleting.usedIn} onConfirm={remove} onCancel={() => setDeleting(undefined)} />}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button type="button" className="icon sm" aria-label="Dismiss" onClick={() => setToast("")}><Icon name="close" /></button>
        </div>
      )}
    </Frame>
  );
}

/** One recipe name: its facts, opening to its copy on each host and what it was copied from. */
function RecipeRow({ L, row, groups, offeringOf, open, reveal, onToggle }: {
  L: Lib; row: ImageRow; groups: GroupInfo[]; offeringOf: (c: RecipeCopy) => OfferingInfo | undefined; open: boolean; reveal: (key: string) => void; onToggle: () => void;
}) {
  const ids = row.copies.map((c) => offeringOf(c)?.id).filter(Boolean);
  const group = groups.find((g) => g.members.some((m) => ids.includes(m)));
  const base = row.copies.map((c) => c.recipe.base && nameOf(L, c.hostId, c.recipe.base)).find(Boolean);
  const tiers = new Set(row.copies.filter((c) => c.recipe.does.includes("create")).map((c) => c.recipe.useFor ?? "both"));
  const facts = [
    archWord(row.copies[0]!.recipe.arch),
    ...new Set(row.copies.flatMap((c) => c.recipe.does)),
    tiers.size === 0 ? null : tiers.size === 1 && !tiers.has("both") ? [...tiers][0] : "fast and quality",
    group ? <>group of <span className="num">{group.members.length}</span></> : plural(row.copies.length, "copy", "copies"),
    base ? `built on ${base}` : null,
    [...new Set(row.copies.map((c) => c.host))].join(", "),
  ].filter(Boolean);
  return (
    <li className={`lrow img-row${open ? " open" : ""}`} data-entry={row.key}>
      <button type="button" className="lrow-main" aria-expanded={open} onClick={onToggle}>
        <span className="name">{row.name}{row.pill && <span className="pill warn">{row.pill}</span>}</span>
        <span className="meta">{facts.map((x, i) => <Fragment key={i}>{i > 0 && " · "}{x}</Fragment>)}</span>
        <Icon name="right" className="lchev" />
      </button>
      {open && (
        <div className="ldetail">
          {base && (
            <p className="meta">
              Built on <button type="button" className="link" onClick={() => reveal(base.trim().toLowerCase())}>{base}</button> with a LoRA.
            </p>
          )}
          {row.copies.map((c) => <CopyBlock key={c.hostId} L={L} c={c} />)}
        </div>
      )}
    </li>
  );
}

/** An image model on a plain endpoint: nothing to manage, so one line. */
function PlainRow({ ctx, ep, m, open, onToggle }: { ctx: MCtx; ep: Endpoint; m: OfferingInfo; open: boolean; onToggle: () => void }) {
  return (
    <li className={`lrow img-row${open ? " open" : ""}`} data-entry={m.id}>
      <button type="button" className="lrow-main" aria-expanded={open} onClick={onToggle}>
        <span className="name"><ModelLabel model={modelName(m)} endpoint={ep.name} /></span>
        <span className="meta">{[ep.kind, m.image ? "create" : "", m.edit ? "edit" : ""].filter(Boolean).join(" · ")}</span>
        <Icon name="right" className="lchev" />
      </button>
      {open && (
        <div className="ldetail">
          <p className="meta">Runs on {ep.name}.</p>
          {ep.kind === "cloud" && <CloudImageControls ctx={ctx} ep={ep} m={m} />}
        </div>
      )}
    </li>
  );
}

/**
 * A recipe on one host: its template and defaults, what can be done with it (Add a part and Delete, or for a proposal
 * Use this recipe or Download the missing parts, and Ignore), and a row per part. `details` leaves the actions out.
 */
function CopyBlock({ L, c, details }: { L: Lib; c: RecipeCopy; details?: boolean }) {
  const r = c.recipe;
  const [changing, setChanging] = useState<number>();
  const editable = !details && L.editable(c.hostId);
  const proposed = r.state === "proposed";
  const miss = missingOf(r);
  const parts = L.libOf(c.hostId)?.parts ?? [];
  const partOf = (file: string) => parts.find((x) => x.file === file);
  const main = r.parts[0];
  const mainPart = main?.file ? partOf(main.file) : undefined;
  const change = (op: Record<string, unknown>) => L.act(c, { do: "change", change: op });
  const facts = (file: string, instead?: Role) => {
    const x = partOf(file);
    const others = (x?.usedBy ?? []).filter((id) => id !== r.id).map((id) => nameOf(L, c.hostId, id)).filter(Boolean);
    return [
      precisionWord(x?.precision ?? null), x ? (x.downloaded ? `downloaded by ${her()}` : "shared folder") : "",
      others.length ? `also used by ${others.join(", ")}` : "", instead ? `used instead of the checkpoint's own ${roleWord(instead)}` : "",
    ].filter(Boolean).join(" · ");
  };
  const actions = !editable ? null : proposed ? <>
    {miss.count
      ? <button type="button" className="sm primary" disabled={L.busy || !miss.known} onClick={() => L.act(c, { do: "download-parts" })}><span>Download the missing parts (<Size text={size(miss.bytes)} />)</span></button>
      : <button type="button" className="sm primary" disabled={L.busy} onClick={() => L.act(c, { do: "confirm" })}>Use this recipe</button>}
    <button type="button" className="sm" disabled={L.busy} onClick={() => L.act(c, { do: "ignore" })}>Ignore</button>
  </> : <>
    <button type="button" className="sm" disabled={L.busy} onClick={() => L.onAddPart?.(c)}>Add a part</button>
    {mainPart?.downloaded && <button type="button" className="sm danger" disabled={L.busy} onClick={() => L.onDelete?.(c)}>Delete</button>}
  </>;
  const where = mainPart?.downloaded ? `${her()}'s downloads` : "the shared folder";
  return (
    <section className="copyblock" aria-label={`${r.name} on ${c.host}`} data-recipe={r.id}>
      <div className="copyhead">
        <b>{c.host}</b>
        <span className="cap">{[`template ${r.template}`, defaultsWords(r.defaults)].filter(Boolean).join(" · ")}</span>
        {actions && <div className="actions">{actions}</div>}
      </div>
      {proposed && !details && (
        <p className="meta copy-note">{miss.count
          ? `${her()} found the ${roleWord(main?.role ?? "diffusion")} in ${where}. It needs these parts before it can run.`
          : `${her()} found these files in ${where} and matched them. Nothing runs until you confirm.`}</p>
      )}
      {!details && r.does.includes("create") && (
        <div className="field">
          <span>Use for</span>
          <div className="seg" role="group" aria-label="Use for">
            {(["fast", "quality", "both"] as const).map((t) => <button key={t} type="button" aria-pressed={(r.useFor ?? "both") === t}
              disabled={!editable || L.busy} onClick={() => { if (t !== (r.useFor ?? "both")) change({ op: "useFor", useFor: t }); }}>
              {t === "fast" ? "Fast" : t === "quality" ? "Quality" : "Both"}
            </button>)}
          </div>
        </div>
      )}
      <ul className="partrows">
        {r.parts.map((x, i) => x.file ? (
          <PartRow key={i} role={x.role} small={x.slot ? slotWord(x.slot) : undefined} file={x.file} cap={facts(x.file, x.added ? x.role : undefined)} bytes={partOf(x.file)?.size}>
            {editable && (x.role === "text_encoder" || x.role === "vae") && (changing === i ? (
              <select autoFocus aria-label={`Choose the ${roleWord(x.role)}`} value={x.file} onBlur={() => setChanging(undefined)}
                onChange={(e) => {
                  const v = e.target.value;
                  setChanging(undefined);
                  if (v === DOWNLOAD_ANOTHER) go({ page: "models", userId: L.ctx.user.id, tab: "images", add: "image" });
                  else if (v !== x.file) change({ op: "swap", role: x.role, slot: x.slot, file: v });
                }}>
                {[...new Set([x.file, ...parts.filter((o) => o.role === x.role && o.slot === x.slot && o.arch === r.arch).map((o) => o.file)])].map((f) => {
                  const o = partOf(f);
                  return <option key={f} value={f}>{fileName(f)}{o?.precision ? ` · ${precisionWord(o.precision)}` : ""}{o && !o.downloaded ? " · shared folder" : ""}</option>;
                })}
                <option value={DOWNLOAD_ANOTHER}>Download another…</option>
              </select>
            ) : (
              <button type="button" className="sm" aria-label={`Change the ${roleWord(x.role)}`} disabled={L.busy} onClick={() => setChanging(i)}>Change</button>
            ))}
            {editable && x.added && (
              <button type="button" className="sm" aria-label={`Remove the ${roleWord(x.role)}`} disabled={L.busy} onClick={() => change({ op: "removePart", role: x.role, slot: x.slot })}>Remove</button>
            )}
          </PartRow>
        ) : (
          <PartRow key={i} missing role={x.role} small={x.slot ? slotWord(x.slot) : undefined} file={x.missing?.path} cap="Missing on this host" bytes={x.missing?.size} />
        ))}
        {r.loras.map((l) => (
          <PartRow key={l.file} role="lora" small={`strength ${l.strength}`} file={l.file} cap={facts(l.file)} bytes={partOf(l.file)?.size}>
            {editable && <button type="button" className="sm" aria-label={`Remove the LoRA ${fileName(l.file)}`} disabled={L.busy} onClick={() => change({ op: "removeLora", file: l.file })}>Remove</button>}
          </PartRow>
        ))}
      </ul>
    </section>
  );
}

function PartRow({ role, small, file, cap, bytes, missing, children }: {
  role: Role; small?: string; file?: string; cap: string; bytes?: number; missing?: boolean; children?: React.ReactNode;
}) {
  return (
    <li className={`partrow${missing ? " missing" : ""}`}>
      <span className="role">{ROLE_WORD[role]}{small && <small>{small}</small>}</span>
      <span className="pfile">{file && <code className="raw">{file}</code>}{cap && <span className={missing ? "cap warn-text" : "cap"}>{cap}</span>}</span>
      <span className="size">{bytes ? <Size text={size(bytes)} /> : null}</span>
      <span className="actions">{children}</span>
    </li>
  );
}

/** Parts: every image model file on the hosts, of one type, with the recipes that use it. */
function Parts({ libs, type, arch, needle, reviewHref, reveal }: {
  libs: HostLibrary[]; type: PartType; arch: string; needle: string; reviewHref: string; reveal: (key: string) => void;
}) {
  const list = libs.flatMap((l) => l.parts.map((part) => ({ l, part })))
    .filter(({ part }) => (type === "unused" ? !part.usedBy.length : part.role === type) && (!arch || part.arch === arch) && (!needle || part.file.toLowerCase().includes(needle)))
    .sort((a, b) => a.l.host.localeCompare(b.l.host) || fileName(a.part.file).localeCompare(fileName(b.part.file)));
  return (
    <ul className="list parts" aria-label="Parts">
      {list.map(({ l, part }) => {
        const users = part.usedBy.flatMap((id) => l.recipes.filter((r) => r.id === id));
        return (
          <li key={`${l.hostId} ${part.file}`} className="prow">
            <span className="mono pname">{fileName(part.file)}</span>
            <span className="meta">
              {[l.host, type === "unused" ? ROLE_WORD[part.role] : "", part.arch ? archWord(part.arch) : "", precisionWord(part.precision)].filter(Boolean).join(" · ")}
              {" · "}<Size text={size(part.size)} />{" · "}{part.downloaded ? `downloaded by ${her()}` : "shared folder"}
            </span>
            <span className="cap">{users.length ? <>Used by {users.map((r, i) => (
              <Fragment key={r.id}>{i > 0 && ", "}{r.state === "confirmed"
                ? <button type="button" className="link" onClick={() => reveal(r.name.trim().toLowerCase())}>{r.name}</button>
                : r.state === "proposed" ? <><a href={reviewHref}>{r.name}</a> (to confirm)</> : `${r.name} (ignored)`}</Fragment>
            ))}</> : "Not used by any recipe"}</span>
          </li>
        );
      })}
      {!list.length && <li className="empty">Nothing here.</li>}
    </ul>
  );
}

/** Add a part: a LoRA (with its strength, into a copy by default), or a VAE or text encoder for a checkpoint. */
function AddPart({ L, c, onAdd, onCancel }: {
  L: Lib; c: RecipeCopy; onAdd: (a: { role: Role; file: string; slot: string | null; strength: number; asNew: boolean }) => void; onCancel: () => void;
}) {
  const r = c.recipe;
  const roles = addableRoles(r);
  const [role, setRole] = useState<Role>(roles[0]!);
  const [file, setFile] = useState<string>();
  const [strength, setStrength] = useState(1);
  const [asNew, setAsNew] = useState(true);
  const used = new Set([...r.parts.map((x) => x.file), ...r.loras.map((l) => l.file)]);
  const files = (L.libOf(c.hostId)?.parts ?? []).filter((x) => x.role === role && x.arch === r.arch && !used.has(x.file));
  const chosen = files.find((x) => x.file === file) ?? files[0];
  return (
    <Dialog labelledBy="add-part-title" className="add-part" onCancel={onCancel}
      onSubmit={() => chosen && onAdd({ role, file: chosen.file, slot: chosen.slot, strength, asNew })}>
      <h2 id="add-part-title">Add a part to {r.name}</h2>
      <div className="seg" role="group" aria-label="Part">
        {roles.map((x) => <button key={x} type="button" aria-pressed={role === x} onClick={() => setRole(x)}>{ROLE_WORD[x]}</button>)}
      </div>
      {files.length ? (
        <div className="choices" role="radiogroup" aria-label="File">
          {files.map((x) => (
            <label key={x.file} className="choice">
              <input type="radio" name="part" checked={chosen?.file === x.file} onChange={() => setFile(x.file)} />
              <code className="raw">{x.file}</code>
              <span className="muted"><Size text={size(x.size)} /></span>
            </label>
          ))}
        </div>
      ) : <p className="muted">No {roleWord(role)} for {archWord(r.arch)} on {c.host} yet.</p>}
      <p className="meta"><a href={href({ page: "models", userId: L.ctx.user.id, tab: "images", add: "image" })}>Download another…</a></p>
      {role === "lora" && files.length > 0 && <>
        <label className="field strength"><span>Strength <span className="num">{strength.toFixed(2)}</span></span>
          <input type="range" min={0} max={1.5} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
        </label>
        <label className="check"><input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} /> Save as a new model, keeping {r.name} as it is</label>
      </>}
      <div className="dlg-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={L.busy || !chosen}>Add</button>
      </div>
    </Dialog>
  );
}

/** Delete a recipe: what goes and what it frees, what stays and why, and which lists skip it from now on. */
function DeleteRecipe({ L, c, usedIn, onConfirm, onCancel }: { L: Lib; c: RecipeCopy; usedIn: ModelUse[]; onConfirm: () => void; onCancel: () => void }) {
  const plan = deletePlan(c.recipe, L.libOf(c.hostId)?.parts ?? [], (id) => recipeOf(L, c.hostId, id));
  const names = (files: string[]) => files.map((f, i) => <Fragment key={f}>{i > 0 && ", "}<code>{fileName(f)}</code></Fragment>);
  return (
    <Dialog labelledBy="delete-recipe-title" onCancel={onCancel} onSubmit={onConfirm}>
      <h2 id="delete-recipe-title">Delete {c.recipe.name} from {c.host}?</h2>
      <p>{plan.goes.length ? <>Deletes {names(plan.goes.map((x) => x.file))}, which frees <Size text={size(plan.frees)} />.</> : "Deletes nothing."}</p>
      {plan.keeps.length > 0 && <p className="meta">Keeps {plan.keeps.map((k, i) => <Fragment key={k.file}>{i > 0 && ", "}<code>{fileName(k.file)}</code> ({k.why})</Fragment>)}.</p>}
      <UsedIn ctx={L.ctx} usedIn={usedIn} />
      <div className="dlg-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="danger primary" disabled={L.busy} autoFocus>Delete</button>
      </div>
    </Dialog>
  );
}

/* ---- To review: the hosts' proposals, one at a time or selected together ---- */

/** A proposal: its name and whether it's ready, its files, Use or Download parts, and a ⋯ with Select, Details and Ignore. */
function ReviewRow({ L, c, selected, menu, setMenu, onPick, onSelect, details, onDetails }: {
  L: Lib; c: RecipeCopy; selected?: boolean; menu: boolean; setMenu: (open: boolean) => void;
  onPick?: (e: React.MouseEvent) => void; onSelect?: () => void; details: boolean; onDetails: () => void;
}) {
  const r = c.recipe;
  const miss = missingOf(r);
  const [main, ...others] = recipeFiles(r);
  const hold = useLongPress();
  const inside = (e: React.SyntheticEvent) => !!(e.target as Element).closest("button, a, select, input, .menu");
  return (
    <li className={`rvrow${selected ? " sel" : ""}`} data-recipe={r.id}
      onClick={(e) => { if (!inside(e)) onPick?.(e); }}
      onContextMenu={(e) => { if (inside(e)) return; e.preventDefault(); setMenu(true); }}
      {...hold(() => setMenu(true), inside)}>
      <div className="main-col">
        <span className="name">
          {r.name}{selected && <span className="sr-only"> (selected)</span>}
          {r.ready ? <span className="pill ok">ready</span> : <span className="pill warn"><span>{plural(miss.count, "part missing", "parts missing")}{miss.bytes > 0 && <> · <Size text={size(miss.bytes)} /></>}</span></span>}
        </span>
        <span className="meta">{[archWord(r.arch), ...r.does].join(" · ")}{main && <> · <span className="mono">{main}</span>{others.length > 0 && <> with {others.map((f, i) => <Fragment key={f}>{i > 0 && ", "}<span className="mono">{f}</span></Fragment>)}</>}</>}</span>
      </div>
      {L.editable(c.hostId) && (
        <div className="actions">
          {r.ready
            ? <button type="button" className="sm" disabled={L.busy} onClick={() => L.act(c, { do: "confirm" })}>Use</button>
            : <button type="button" className="sm" disabled={L.busy || !miss.known} onClick={() => L.act(c, { do: "download-parts" })}>Download parts</button>}
          <RowMenu label={`Actions for ${r.name} on ${c.host}`} open={menu} onOpen={setMenu} items={[
            ...(onSelect ? [{ label: "Select", onPick: onSelect }] : []),
            { label: "Details", onPick: onDetails },
            { label: "Ignore", onPick: () => L.act(c, { do: "ignore" }) },
          ]} />
        </div>
      )}
      {details && <div className="ldetail"><CopyBlock L={L} c={c} details /></div>}
    </li>
  );
}

const keyOf = (c: RecipeCopy) => `${c.hostId}/${c.recipe.id}`;

/** Rows shown open to their details, and the one whose ⋯ is open, for a list of proposals. */
function useRowState() {
  const [menu, setMenu] = useState<string>();
  const [details, setDetails] = useState<Set<string>>(() => new Set());
  const toggleDetails = (k: string) => setDetails((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return { menu, setMenu, details, toggleDetails };
}

/** To review: every recipe the hosts proposed on hosts this user manages, by host, 50 at a time. */
export function ImageReview({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const libs = useLibraries(ctx, (ep) => canEdit(ctx, ep));
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "ready" | "missing">("all");
  const [arch, setArch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const rows = useRowState();
  const [run, busy, error] = useAction();
  const reads = useMemo(() => libs.data ?? [], [libs.data]);
  const all = useMemo(() => proposalsOf(reads.map((r) => r.lib)), [reads]);
  const needle = q.trim().toLowerCase();
  const list = all.filter((c) => (status === "all" || (status === "ready") === c.recipe.ready) && (!arch || c.recipe.arch === arch)
    && (!needle || `${c.recipe.name} ${recipeFiles(c.recipe).join(" ")}`.toLowerCase().includes(needle)));
  const visible = list.slice(0, shown);
  const { sel, setSel, pick, toggle } = useSelection(visible.map(keyOf));
  useEffect(() => { setSel(new Set()); setShown(PAGE); }, [needle, status, arch, setSel]);
  // Escape clears the selection, once an open ⋯ has closed.
  useEffect(() => {
    if (!sel.size || rows.menu) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(new Set()); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [sel.size, rows.menu, setSel]);
  const { reload } = libs, { reload: reloadModels } = ctx.models;
  const each = (cs: RecipeCopy[], a: RecipeAction) => void run(async () => {
    for (const c of cs) await post(u(userId, "hosts", c.hostId, "recipes", c.recipe.id), a);
    setSel(new Set());
    reload(); reloadModels();
  });
  const L: Lib = { ctx, busy, editable: () => true, libOf: (hostId) => reads.find((r) => r.ep.id === hostId)?.lib, act: (c, a) => each([c], a) };
  const chosen = all.filter((c) => sel.has(keyOf(c)));
  const ready = chosen.filter((c) => c.recipe.ready);
  const lacking = chosen.filter((c) => missingOf(c.recipe).known);
  const bytes = lacking.reduce((n, c) => n + missingOf(c.recipe).bytes, 0);
  const byHost = new Map<string, RecipeCopy[]>();
  for (const c of visible) byHost.set(c.hostId, [...(byHost.get(c.hostId) ?? []), c]);
  const facts = <><a href={href({ page: "models", userId, tab: "images" })}>Image models</a>{libs.data && <> · <span className="num">{all.length}</span> found on your hosts</>}</>;
  return (
    <Frame ctx={ctx} tab="images" title="To review" facts={facts}>
      <ErrorText error={ctx.models.error || libs.error || error} />
      {reads.map((r) => r.error && <ErrorText key={r.ep.id} error={r.error} />)}
      {libs.data && <>
        <div className="lib-filters">
          <input type="search" aria-label="Search to review" placeholder="Search by name or file" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chip-row" role="group" aria-label="Show">
            {chip(<>All <span className="num">{all.length}</span></>, status === "all", () => setStatus("all"))}
            {chip("Ready", status === "ready", () => setStatus(status === "ready" ? "all" : "ready"))}
            {chip("Parts missing", status === "missing", () => setStatus(status === "missing" ? "all" : "missing"))}
          </div>
          <ArchChips arches={archesOf(all.map((c) => ({ hostId: c.hostId, host: c.host, recipes: [c.recipe], parts: [] })))} arch={arch} setArch={setArch} />
        </div>
        <ul className="list review" aria-label="To review" data-selecting={sel.size > 0 || undefined}>
          {[...byHost].map(([hostId, cs]) => (
            <Fragment key={hostId}>
              <li className="group-head eyebrow">{cs[0]!.host} · <span className="num">{cs.length}</span></li>
              {cs.map((c) => {
                const k = keyOf(c);
                return (
                  <ReviewRow key={k} L={L} c={c} selected={sel.has(k)} menu={rows.menu === k} setMenu={(o) => rows.setMenu(o ? k : undefined)}
                    // While selecting, a plain click (a tap) adds or takes away a row too.
                    onPick={(e) => { if (sel.size && !e.metaKey && !e.ctrlKey && !e.shiftKey) toggle(k); else pick(e, k); }}
                    onSelect={() => { if (!sel.has(k)) toggle(k); }} details={rows.details.has(k)} onDetails={() => rows.toggleDetails(k)} />
                );
              })}
            </Fragment>
          ))}
          {!list.length && <li className="empty">Nothing to review.</li>}
          {list.length > shown && (
            <li className="more-row">
              <button type="button" onClick={() => setShown(shown + PAGE)}><span>Show <span className="num">{Math.min(PAGE, list.length - shown)}</span> more of <span className="num">{list.length - shown}</span></span></button>
            </li>
          )}
        </ul>
        {sel.size > 0 && (
          <div className="selbar review-bar" role="toolbar" aria-label="Selection">
            <span><span className="num">{sel.size}</span> selected</span>
            <button type="button" className="sm" onClick={() => setSel(new Set(visible.map(keyOf)))}>
              {list.length > visible.length ? <span>Select all <span className="num">{visible.length}</span> shown</span> : "Select all"}
            </button>
            <button type="button" className="sm primary" disabled={busy || !ready.length} onClick={() => each(ready, { do: "confirm" })}><span>Use <span className="num">{ready.length}</span> ready</span></button>
            <button type="button" className="sm" disabled={busy || !lacking.length} onClick={() => each(lacking, { do: "download-parts" })}>
              <span>Download parts{bytes > 0 && <> (<Size text={size(bytes)} />)</>}</span>
            </button>
            <button type="button" className="sm" disabled={busy} onClick={() => each(chosen, { do: "ignore" })}>Ignore</button>
            <button type="button" className="icon sm" aria-label="Clear the selection" onClick={() => setSel(new Set())}><Icon name="close" /></button>
          </div>
        )}
      </>}
    </Frame>
  );
}

/* ---- Download image model: files from Hugging Face, a link, or a scan of the host's models folder ---- */

type ImageSource = "huggingface" | "url" | "scan";
const SOURCES: [ImageSource, string][] = [["huggingface", "Hugging Face"], ["url", "Link"], ["scan", "Scan folder"]];

export function DownloadImage({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const hosts = managedHosts(ctx).filter((h) => h.status);
  const [hostId, setHostId] = useState<string>();
  const host = hosts.find((h) => h.ep.id === hostId) ?? hosts[0];
  const [source, setSource] = useState<ImageSource>("huggingface");
  const look = useLookup(userId, host?.ep.id, source === "huggingface" ? "huggingface" : "url");
  const tokens = useLoad(() => get<HubTokenInfo[]>(u(userId, "hub-tokens")), [userId]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [token, setToken] = useState("");
  const [keep, setKeep] = useState(true);
  const [link, setLink] = useState("");
  const [sha, setSha] = useState("");
  const [problem, setProblem] = useState("");
  const [scanned, setScanned] = useState<HostLibrary>();
  const rows = useRowState();
  const [run, busy, error] = useAction();
  const [back] = useState(() => wayBack(href({ page: "models", userId, tab: "images" })));
  const found = look.found;
  useEffect(() => { setPicked(new Set()); setProblem(""); }, [found, look.repo]);
  useEffect(() => { setScanned(undefined); }, [host?.ep.id]);
  const saved = tokenFor(tokens.data, "huggingface");
  const files = found?.files.filter((f) => f.allowed) ?? [];
  const refused = useMemo(() => (found ? fileChoices(found).refused : []), [found]);
  const paused = host?.status?.state === "paused" || host?.status?.state === "pausing";

  const download = () => {
    if (!host) return;
    let body: Parameters<typeof startDownload>[2];
    if (source === "url") {
      const why = linkProblem(link, sha);
      if (why) { setProblem(why); return; }
      body = { source: "url", url: link.trim(), ...(sha.trim() ? { sha256: sha.trim() } : {}) };
    } else {
      const chosen = files.filter((f) => picked.has(f.path));
      const why = !found ? "Look up the repository first." : !chosen.length ? "Choose a file."
        : found.gated && !saved && !token.trim() ? "This repository needs a token."
        : chosen.reduce((n, f) => n + f.size, 0) > found.free ? `Not enough space on ${host.ep.name}.` : "";
      if (why || !found) { setProblem(why); return; }
      body = { source: "huggingface", repo: found.repo, files: chosen.map((f) => f.path) };
    }
    setProblem("");
    void run(async () => {
      await startDownload(userId, host.ep.id, body, found?.gated && !saved ? { text: token, keep } : undefined);
      setToken("");
      ctx.models.reload();
      go({ page: "models", userId, tab: "downloads" });
    });
  };
  // The host reads its models folder again; what it proposes shows as To review's rows.
  const scan = () => run(async () => {
    await post(u(userId, "hosts", host!.ep.id, "manage"), { method: "POST", path: "/host/v1/scan" });
    setScanned(await readLibrary(userId, host!.ep));
  });
  const L: Lib = {
    ctx, busy, editable: () => true, libOf: () => scanned,
    act: (c, a) => void run(async () => { await post(u(userId, "hosts", c.hostId, "recipes", c.recipe.id), a); ctx.models.reload(); setScanned(await readLibrary(userId, host!.ep)); }),
  };
  const proposed = scanned ? proposalsOf([scanned]) : [];

  return (
    <Frame ctx={ctx} tab="images" title="Download image model">
      <ErrorText error={ctx.models.error} />
      {ctx.models.page && !host && (
        <p className="empty">No model host to download to. <a href={href({ page: "models", userId, tab: "hosts", add: "host" })}>Add model host</a></p>
      )}
      {host && (
        <div className="card dl-form">
          <HostField hosts={hosts} value={host.ep.id} onChange={setHostId} />
          {paused && <p className="meta">This host is paused. Downloading doesn't use the GPU, so it still runs.</p>}
          <div className="seg" role="group" aria-label="Source">
            {SOURCES.map(([s, label]) => <button key={s} type="button" aria-pressed={source === s} onClick={() => { setSource(s); setProblem(""); }}>{label}</button>)}
          </div>
          {source === "huggingface" && <>
            <RepoField look={look} placeholder="Comfy-Org/Qwen-Image_ComfyUI, or the page's link" />
            {found && <>
              {found.gated && <GatedNote hub="huggingface" saved={saved} token={token} setToken={setToken} keep={keep} setKeep={setKeep} />}
              <div className="field">
                <span id="h-files">Files to download</span>
                {files.length ? (
                  <div className="choices" role="group" aria-labelledby="h-files">
                    {files.map((f) => (
                      <label key={f.path} className="choice">
                        <input type="checkbox" checked={picked.has(f.path)} disabled={f.present || !f.fits}
                          onChange={(e) => { setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(f.path); else n.delete(f.path); return n; }); setProblem(""); }} />
                        <span className="choice-name">
                          <span className="mono">{f.path}</span>
                          {f.present ? <span className="pill">already on this host</span> : !f.fits && <span className="pill warn">not enough space</span>}
                        </span>
                        <span className="muted"><Size text={size(f.size)} /></span>
                      </label>
                    ))}
                  </div>
                ) : <p className="muted">Nothing in it can be downloaded.</p>}
              </div>
              {refused.map((line) => <p key={line} className="meta">{line}</p>)}
            </>}
          </>}
          {source === "url" && <LinkFields link={link} setLink={(t) => { setLink(t); setProblem(""); }} sha={sha} setSha={setSha} />}
          {source === "scan" && <>
            <div className="row"><button type="button" disabled={busy} onClick={() => void scan()}>Scan now</button></div>
            {scanned && (proposed.length ? (
              <ul className="list review" aria-label="Found">
                {proposed.map((c) => {
                  const k = keyOf(c);
                  return <ReviewRow key={k} L={L} c={c} menu={rows.menu === k} setMenu={(o) => rows.setMenu(o ? k : undefined)} details={rows.details.has(k)} onDetails={() => rows.toggleDetails(k)} />;
                })}
              </ul>
            ) : <p className="muted">Nothing new in the models folder.</p>)}
          </>}
          <ErrorText error={problem || (source === "huggingface" ? look.error : "") || error} />
          <div className="row">
            {source !== "scan" && <button type="button" className="primary" disabled={busy || look.busy} onClick={download}>Download</button>}
            <a className="link" href={back}>{source === "scan" ? "Back" : "Cancel"}</a>
          </div>
        </div>
      )}
    </Frame>
  );
}
