// The Models area (docs/ux.md §6, "Models, hosts, downloads, clean-up"): Overview, Tasks, Text models (TextModels.tsx),
// Image models (ImageModels.tsx), Hosts and endpoints (with the Add model host page), Downloads (Downloads.tsx), Clean
// up and Recent calls, with its sections listed at the left (the frame and what the tabs share are in ModelsFrame.tsx).
// The shell polls GET …/models/cleanup for the sidebar's count; GET …/models/page, which probes every
// endpoint, is read while the area or the welcome page is open, and the Hosts tab's changes reload it.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  del, get, patch, post, put, u,
  type CallInfo, type CleanupItem, type EndpointChange, type EndpointInfo, type GroupInfo, type HostStatus, type ModelsNotice, type ModelsPage,
  type ModelRef, type OfferingInfo, type PlanSignInStarted, type ProfileEntry, type ProfileEntryChange, type Profiles, type Task,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { Downloads, DownloadText } from "./Downloads.tsx";
import { DownloadImage, ImageModels, ImageReview } from "./ImageModels.tsx";
import { duration, RowMenu } from "./Machines.tsx";
import {
  canEdit, Frame, GB, gb, hostOf, Kind, plural, PROFILE_WORD, TASK_WORD, useWords, VoiceDrawer,
  type Host, type MCtx, type ModelsState,
} from "./ModelsFrame.tsx";
import { go, href, type ModelsPageUnder, type ModelsTab } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { TextModels } from "./TextModels.tsx";
import { ConfirmDialog, ErrorText, hidden, shortTime, Switch, useAction, useLoad } from "./ui.tsx";

/** The sidebar's Clean up count, from GET …/models/cleanup: a plain read, so the shell can poll it without probing any endpoint. */
export function useCleanupCount(userId: string): { count: number; reload: () => void } {
  const c = useLoad(() => get<CleanupItem[]>(u(userId, "models", "cleanup")), [userId]);
  return { count: c.data?.length ?? 0, reload: c.reload };
}

/**
 * GET …/models/page, while Models or the welcome page is open: it probes every endpoint, so it is read on arriving,
 * on each tab, and every 30 s and on focus while the area stays open. A reload also refreshes the sidebar's count.
 */
function useModelsPage(ctx: ShellContext): ModelsState {
  const p = useLoad(() => get<ModelsPage>(u(ctx.user.id, "models", "page")), [ctx.user.id]);
  const { reload: reloadPage } = p;
  const { reload: reloadCount } = ctx.cleanup;
  const reload = useCallback(() => { reloadPage(); reloadCount(); }, [reloadPage, reloadCount]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") reloadPage(); };
    const t = setInterval(tick, 30_000);
    addEventListener("focus", tick);
    return () => { clearInterval(t); removeEventListener("focus", tick); };
  }, [reloadPage]);
  return { page: p.data, error: p.error, reload, set: p.set };
}

type Endpoint = ModelsPage["endpoints"][number];
type Gpu = HostStatus["gpus"][number];

const gbTotal = (bytes: number) => String(Math.round(bytes / GB));
/** A host model's file name, without its folders and extension. */
const shortId = (id: string) => (id.split("/").pop() ?? id).replace(/\.(gguf|safetensors)$/i, "");
/** A label (`[shared.]<endpoint>/<model>`) as "<model> · <endpoint>". */
function modelAndEndpoint(label: string, endpointName?: string): string {
  const m = /^(?:shared\.)?([^/]+)\/(.+)$/s.exec(label);
  if (!m) return endpointName ? `${label} · ${endpointName}` : label;
  return `${m[2]} · ${endpointName ?? m[1]}`;
}

/** A text model: not one that draws, embeds, hears or speaks, and not gone. Counted once per model ID. */
function textModels(eps: EndpointInfo[]): number {
  const ids = new Set<string>();
  for (const ep of eps) for (const m of ep.models) {
    if (m.status !== "gone" && !m.image && !m.edit && !m.embedding && !m.transcribe && !m.speak) ids.add(m.modelId.toLowerCase());
  }
  return ids.size;
}

/** An endpoint's one state: a dot's class and its word, with a duration in mono where there is one. */
function stateOf(ep: Endpoint, host?: Host): { dot: string; word: string; since?: string } {
  const since = ep.downSince ? duration(Date.now() - Date.parse(ep.downSince)) : undefined;
  if (ep.api === "host" && host && "status" in host) {
    const s = host.status.state;
    if (s === "running") return { dot: "up", word: "Online" };
    if (s === "restarting") return { dot: "info", word: "Restarting" };
    return { dot: "away", word: s === "pausing" ? "Pausing" : "Paused" };
  }
  if (unpaired(host)) return { dot: "down", word: "Unpaired" };
  if (ep.signedOut) return { dot: "down", word: "Signed out" };
  if (ep.state === "up") return { dot: "up", word: ep.api === "host" ? "Online" : "Up" };
  return { dot: "down", word: "Unreachable", since };
}

function StateWord({ ep, host }: { ep: Endpoint; host?: Host }) {
  const s = stateOf(ep, host);
  return (
    <span className="status-word" data-state={s.word} title={host && "error" in host ? host.error : undefined}>
      <span className={`dot ${s.dot}`} aria-hidden="true" />{s.word}{s.since && <> <span className="num">{s.since}</span></>}
    </span>
  );
}

const loadedNothing = (h?: Host) => !!h && "status" in h && h.status.gpus.every((g) => !g.models.length);
const paused = (h?: Host) => !!h && "status" in h && (h.status.state === "paused" || h.status.state === "pausing");
/** The host has revoked this server: pairing again is the fix. */
const unpaired = (h?: Host) => !!h && "error" in h && !!h.unpaired;

/** The Models area, at one of its tabs. */
export function ModelsArea({ ctx: shell, tab = "overview", add }: { ctx: ShellContext; tab?: ModelsTab; add?: ModelsPageUnder }) {
  const models = useModelsPage(shell);
  const ctx: MCtx = { ...shell, models };
  const { reload } = models;
  // Fresh status on each tab after the first.
  const first = useRef(true);
  useEffect(() => { if (first.current) first.current = false; else reload(); }, [tab, reload]);
  if (tab === "hosts" && add === "host") return <AddHost ctx={ctx} />;
  if (tab === "tasks") return <Tasks ctx={ctx} />;
  if (tab === "text") return <TextModels ctx={ctx} />;
  if (tab === "images" && add === "review") return <ImageReview ctx={ctx} />;
  if (tab === "images" && add === "image") return <DownloadImage ctx={ctx} />;
  if (tab === "images") return <ImageModels ctx={ctx} />;
  if (tab === "hosts") return <Hosts ctx={ctx} />;
  if (tab === "downloads" && add === "text") return <DownloadText ctx={ctx} />;
  if (tab === "downloads") return <Downloads ctx={ctx} />;
  if (tab === "cleanup") return <Cleanup ctx={ctx} />;
  if (tab === "calls") return <Calls ctx={ctx} />;
  return <Overview ctx={ctx} />;
}

/* ---- Overview ---- */

function Overview({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const p = ctx.models.page;
  const eps = p?.endpoints ?? [];
  const facts = p && <>{plural(eps.filter((e) => e.kind === "local").length, "local", "local")} and {plural(eps.filter((e) => e.kind === "cloud").length, "cloud endpoint", "cloud endpoints")} · {plural(textModels(eps), "text model", "text models")}</>;
  return (
    <Frame ctx={ctx} tab="overview" title="Models" facts={facts}>
      <ErrorText error={ctx.models.error} />
      {p && <>
        <Banner ctx={ctx} p={p} />
        <Tiles ctx={ctx} p={p} />
        <section className="section" aria-labelledby="h-models-hosts">
          <div className="section-head"><h2 id="h-models-hosts">Hosts and endpoints</h2><a href={href({ page: "models", userId, tab: "hosts" })}>All details</a></div>
          {eps.length ? (
            <ul className="list">
              {eps.map((ep) => ep.api === "host" ? <HostRow key={ep.id} ctx={ctx} ep={ep} host={hostOf(p, ep.id)} /> : (
                <li key={ep.id} className="hostrow" data-endpoint={ep.id}>
                  <span className={`dot ${stateOf(ep).dot}`} aria-hidden="true" />
                  <div className="main-col">
                    <span className="name">{ep.name} <Kind kind={ep.kind} /></span>
                    <span className="meta">{ep.state === "up" ? plural(ep.models.length, "model", "models") : <StateWord ep={ep} />}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="empty">No endpoints yet.</p>}
        </section>
        <section className="section" aria-labelledby="h-models-calls">
          <div className="section-head"><h2 id="h-models-calls">Recent calls</h2><a href={href({ page: "models", userId, tab: "calls" })}>All calls</a></div>
          <CallsTable ctx={ctx} calls={p.calls} limit={5} />
        </section>
      </>}
    </Frame>
  );
}

/** One line when a host is paused or an endpoint is stale, with what fixes it. */
function Banner({ ctx, p }: { ctx: MCtx; p: ModelsPage }) {
  const [run, busy, error] = useAction();
  const host = p.endpoints.find((ep) => ep.api === "host" && paused(hostOf(p, ep.id)));
  if (host) {
    return (
      <div className="banner" role="status">
        <span className="dot away" aria-hidden="true" />
        <span><b>{host.name} is paused.</b> Its tasks use a fallback until you resume it.</span>
        {canEdit(ctx, host) && <button type="button" className="sm" disabled={busy} onClick={() => void run(() => control(ctx, host.id, "resume"))}>Resume</button>}
        <ErrorText error={error} />
      </div>
    );
  }
  const stale = p.endpoints.find((ep) => ep.stale);
  if (!stale) return null;
  const since = stale.downSince ? duration(Date.now() - Date.parse(stale.downSince)) : undefined;
  return (
    <div className="banner" role="status">
      <span className="dot down" aria-hidden="true" />
      <span><b>{stale.name} has been unreachable{since && <> for <span className="num">{since}</span></>}.</b> Clean up can remove it.</span>
      <button type="button" className="sm" onClick={() => go({ page: "models", userId: ctx.user.id, tab: "cleanup" })}>Clean up</button>
    </div>
  );
}

/** Pauses or resumes a host, and puts its new status into the page. */
async function control(ctx: MCtx, endpointId: string, action: "pause" | "resume") {
  const status = await post<HostStatus>(u(ctx.user.id, "hosts", endpointId, action));
  const p = ctx.models.page;
  if (p) ctx.models.set({ ...p, hosts: p.hosts.map((h) => (h.endpointId === endpointId ? { endpointId, status } : h)) });
}

/** The first model of a profile's chat list, following Same as. */
function firstChat(p: ModelsPage, profile: "cloud" | "custom" | "local") {
  let entry = p.profiles[profile].chat;
  for (let i = 0; entry && !Array.isArray(entry) && i < 5; i++) entry = p.profiles[profile][entry.same];
  const ref = Array.isArray(entry) ? entry[0] : undefined;
  if (!ref) return undefined;
  if ("groupId" in ref) return { groupId: ref.groupId };
  for (const ep of p.endpoints) {
    const m = ep.models.find((o) => o.id === ref.offeringId);
    if (m) return { model: m.modelId, endpoint: ep.name, kind: ep.kind };
  }
  return undefined;
}

export function BackendCard({ ctx }: { ctx: ShellContext }) {
  const models = useModelsPage(ctx);
  const p = models.page;
  const userId = ctx.user.id;
  const general = p && firstChat(p, p.profiles.default);
  const local = p && firstChat(p, "local");
  const needGroups = !!(general && "groupId" in general) || !!(local && "groupId" in local);
  const groups = useLoad(() => (needGroups ? get<GroupInfo[]>(u(userId, "groups")) : Promise.resolve([])), [userId, needGroups]);
  const line = (c: ReturnType<typeof firstChat>, profile: "cloud" | "custom" | "local") => {
    if (c && "groupId" in c) {
      const groupId = c.groupId;
      const group = groups.data?.find((g) => g.id === groupId);
      c = group?.members.flatMap((id) => (p?.endpoints ?? []).flatMap((ep) => {
        const m = ep.models.find((m) => m.id === id);
        return m && (profile === "custom" || ep.kind === profile) ? [{ model: m.modelId, endpoint: ep.name, kind: ep.kind }] : [];
      }))[0];
    }
    return <>{c && "model" in c ? <><span className={`badge kind ${c.kind}`}>{c.kind}</span> {c.model} · {c.endpoint}</> : "No model"} · {PROFILE_WORD[profile]}</>;
  };
  return (
    <section className="card" aria-labelledby="h-home-backend">
      <div className="section-head"><h2 id="h-home-backend">Backend</h2><a href={href({ page: "models", userId })}>Models</a></div>
      <ErrorText error={models.error || groups.error} />
      {p && <dl className="facts">
        <dt>General threads</dt><dd>{line(general, p.profiles.default)}</dd>
        <dt>Private threads</dt><dd>{line(local, "local")}</dd>
        <dt>Hosts</dt><dd>{p.hosts.length ? p.hosts.map((h) => {
          const ep = p.endpoints.find((e) => e.id === h.endpointId);
          return ep && <div key={h.endpointId} className="backend-host"><span>{ep.name}</span> <StateWord ep={ep} host={h} /></div>;
        }) : "None"}</dd>
      </dl>}
    </section>
  );
}

function Tiles({ ctx, p }: { ctx: MCtx; p: ModelsPage }) {
  const userId = ctx.user.id;
  const up = p.endpoints.filter((e) => e.state === "up");
  const down = p.endpoints.filter((e) => e.state !== "up");
  const first = down[0];
  const reach = !first ? { dot: "up", word: "All reachable" }
    : paused(hostOf(p, first.id)) ? { dot: "away", word: `${first.name} paused` }
    : unpaired(hostOf(p, first.id)) ? { dot: "down", word: `${first.name} unpaired` } : { dot: "down", word: `${first.name} unreachable` };
  const general = firstChat(p, p.profiles.default);
  const local = firstChat(p, "local");
  const needGroups = !!(general && "groupId" in general) || !!(local && "groupId" in local);
  const groups = useLoad(() => (needGroups ? get<GroupInfo[]>(u(userId, "groups")) : Promise.resolve([])), [userId, needGroups]);
  const line = (c: ReturnType<typeof firstChat>) => !c ? "No model"
    : "groupId" in c ? groups.data?.find((g) => g.id === c.groupId)?.name ?? "A group"
    : <>{c.model} <span className="muted">· {c.endpoint}</span></>;
  const cleanup = p.cleanup;
  return (
    <div className="tiles">
      <a className="tile" href={href({ page: "models", userId, tab: "hosts" })} data-tile="endpoints">
        <span className="cap">Endpoints</span>
        <span className="big num">{up.length}<small>of {p.endpoints.length} up</small></span>
        <span className="cap"><span className={`dot ${reach.dot}`} aria-hidden="true" /> {reach.word}{down.length > 1 && <> +<span className="num">{down.length - 1}</span></>}</span>
      </a>
      <a className="tile" href={href({ page: "models", userId, tab: "tasks" })} data-tile="backend">
        <span className="cap">Backend</span>
        <span className="line" title="General threads">{line(general)}</span>
        <span className="cap">general threads · {PROFILE_WORD[p.profiles.default]}</span>
        <span className="line" title="Private threads">{line(local)}</span>
        <span className="cap">private threads · Local</span>
      </a>
      <a className="tile" href={href({ page: "models", userId, tab: "cleanup" })} data-tile="cleanup" title={cleanup ? "To decide" : "Nothing to clean up"}>
        <span className="cap">Clean up</span>
        <span className="big num">{cleanup}<small>{cleanup === 1 ? "item" : "items"}</small></span>
      </a>
    </div>
  );
}

/** Each GPU's models as bar segments: pinned, vLLM's share on a vLLM GPU, or loaded on demand. */
const segments = (g: Gpu) => g.models.filter((m) => m.vram).map((m) => ({ id: m.id, kind: m.pinned ? "pinned" : g.role === "vllm" ? "vllm" : "loaded", bytes: m.vram! }));

function Bar({ gpus }: { gpus: Gpu[] }) {
  const total = gpus.reduce((n, g) => n + g.vram.total, 0);
  const used = gpus.reduce((n, g) => n + g.vram.used, 0);
  return (
    <div className="bar" role="img" aria-label={`${gb(used)} of ${gbTotal(total)} GB in use`}>
      {total > 0 && gpus.flatMap((g) => segments(g).map((s) => <span key={`${g.index}/${s.id}`} className={`seg-${s.kind}`} style={{ width: `${(s.bytes / total) * 100}%` }} />))}
    </div>
  );
}

/** Pause or Resume, as the host's state says. Disabled when the host reports nothing loaded. */
function PauseButton({ ctx, ep, host }: { ctx: MCtx; ep: Endpoint; host?: Host }) {
  const [run, busy, error] = useAction();
  if (!host || !("status" in host)) return null;
  const isPaused = paused(host);
  const empty = !isPaused && loadedNothing(host);
  return (
    <>
      <button type="button" className="sm" disabled={busy || empty || host.status.state === "restarting"} title={empty ? "Nothing is loaded" : undefined}
        onClick={() => void run(() => control(ctx, ep.id, isPaused ? "resume" : "pause"))}>{isPaused ? "Resume" : "Pause"}</button>
      {error && <ErrorText error={error} />}
    </>
  );
}

/** Dashboard: the host's own page, in a new tab. The tab opens at once, so the browser doesn't block it. */
function DashboardButton({ ctx, ep }: { ctx: MCtx; ep: Endpoint }) {
  const [run, busy, error] = useAction();
  const open = () => {
    const w = window.open("about:blank", "_blank");
    void run(async () => {
      try {
        const { url } = await get<{ url: string }>(u(ctx.user.id, "hosts", ep.id, "dashboard"));
        if (w) { w.opener = null; w.location.href = url; }
      } catch (e) { w?.close(); throw e; }
    });
  };
  return <>{<button type="button" className="sm" disabled={busy} onClick={open}>Dashboard</button>}{error && <ErrorText error={error} />}</>;
}

/** A host in the Overview: its state, what's loaded, the VRAM it uses, Pause or Resume and Dashboard. */
function HostRow({ ctx, ep, host }: { ctx: MCtx; ep: Endpoint; host?: Host }) {
  const gpus = host && "status" in host ? host.status.gpus : [];
  const loaded = gpus.flatMap((g) => g.models.map((m) => shortId(m.id)));
  const total = gpus.reduce((n, g) => n + g.vram.total, 0), used = gpus.reduce((n, g) => n + g.vram.used, 0);
  const s = stateOf(ep, host);
  return (
    <li className="hostrow" data-endpoint={ep.id}>
      <span className={`dot ${s.dot}`} aria-hidden="true" />
      <div className="main-col">
        <span className="name">{ep.name} <Kind kind="local" /></span>
        <span className="meta">{s.word !== "Online" ? <StateWord ep={ep} host={host} /> : loaded.length ? [...new Set(loaded)].join(", ") : "nothing loaded"}</span>
      </div>
      <div className="main-col usage">
        {gpus.length > 0 && <><Bar gpus={gpus} /><span className="cap num">{gb(used)} / {gbTotal(total)} GB</span></>}
      </div>
      <div className="actions">
        {canEdit(ctx, ep) && <PauseButton ctx={ctx} ep={ep} host={host} />}
        <DashboardButton ctx={ctx} ep={ep} />
      </div>
    </li>
  );
}

/* ---- Tasks ---- */

type ProfileName = "cloud" | "local" | "custom";
type ProfileMap = Partial<Record<Task, ProfileEntry>>;

/** The table's rows, under their eyebrows, each with a hint that is its name's tooltip (docs/ux.md §4). */
const TASK_ROWS: { group: string; tasks: { task: Task; hint: string }[] }[] = [
  { group: "Conversation", tasks: [
    { task: "chat", hint: "The main conversation" },
    { task: "subagent.cheap", hint: "Searching, reading, checking" },
    { task: "subagent.strong", hint: "Writing, judgment, code" },
    { task: "compaction", hint: "Summarising long threads" },
    { task: "title", hint: "Naming new threads" },
    { task: "watching", hint: "A project chat's look at its threads" },
  ] },
  { group: "Memory", tasks: [{ task: "embedding", hint: "Recall and search" }] },
  { group: "Sleep", tasks: [
    { task: "sleep.consolidate", hint: "The day into memory" },
    { task: "sleep.dream", hint: "Her own time" },
    { task: "sleep.wake", hint: "Writing WAKE" },
  ] },
  { group: "Images", tasks: [{ task: "image.create", hint: "New images" }, { task: "image.edit", hint: "Changing an image" }] },
  { group: "Speech", tasks: [{ task: "speech.transcribe", hint: "Speech to text" }, { task: "speech.speak", hint: "Text to speech" }] },
];
const TASK_ORDER = TASK_ROWS.flatMap((g) => g.tasks.map((t) => t.task));

/** What a task needs (core/models): Same as stays within one, and pickers offer only models that have it. */
const capability = (t: Task) => (t === "embedding" ? "embedding" : t === "image.create" ? "image" : t === "image.edit" ? "edit"
  : t === "speech.transcribe" ? "transcribe" : t === "speech.speak" ? "speak" : "text");
const suits = (task: Task, m: OfferingInfo) => {
  if (m.status === "gone") return false;
  switch (capability(task)) {
    case "embedding": return !!m.embedding;
    case "image": return !!m.image;
    case "edit": return !!m.edit;
    case "transcribe": return !!m.transcribe;
    case "speak": return !!m.speak?.voices.length;
    default: return !m.embedding && !m.image && !m.edit && !m.transcribe && !m.speak;
  }
};

/** A task's entry as lyricad reads it: a text task with none follows Chat. */
function entryOf(prof: ProfileMap, task: Task): ProfileEntry | undefined {
  return prof[task] ?? (task !== "chat" && capability(task) === "text" ? { same: "chat" } : undefined);
}
/** The list that decides a task, after Same as. */
function listOf(prof: ProfileMap, task: Task, depth = 0): ModelRef[] {
  const e = entryOf(prof, task);
  if (Array.isArray(e)) return e;
  return e && depth < 2 ? listOf(prof, e.same, depth + 1) : [];
}

type Copy = { m: OfferingInfo; ep: Endpoint };
function copies(p: ModelsPage): Map<string, Copy> {
  const out = new Map<string, Copy>();
  for (const ep of p.endpoints) for (const m of ep.models) out.set(m.id, { m, ep });
  return out;
}
const answers = (p: ModelsPage, c: Copy) => c.ep.state === "up" && !c.ep.stale && c.m.status !== "gone" && !paused(hostOf(p, c.ep.id));

/** A list entry's models: an offering, or a group's members, each marked when the profile skips its kind. */
function membersOf(ref: ModelRef, all: Map<string, Copy>, groups: GroupInfo[], profile: ProfileName): (Copy & { off: boolean })[] {
  const ids = "offeringId" in ref ? [ref.offeringId] : groups.find((g) => g.id === ref.groupId)?.members ?? [];
  return ids.flatMap((id) => { const c = all.get(id); return c ? [{ ...c, off: profile !== "custom" && c.ep.kind !== profile }] : []; });
}
const refUp = (p: ModelsPage, ms: (Copy & { off: boolean })[]) => ms.some((c) => !c.off && answers(p, c));
const refKind = (ms: (Copy & { off: boolean })[]) => (ms.find((c) => !c.off) ?? ms[0])?.ep.kind;
const refKey = (r: ModelRef) => ("offeringId" in r ? r.offeringId : `g:${r.groupId}`);

function RefLabel({ refx, all, groups }: { refx: ModelRef; all: Map<string, Copy>; groups: GroupInfo[] }) {
  if ("groupId" in refx) return <>{groups.find((g) => g.id === refx.groupId)?.name ?? "A group"}</>;
  const c = all.get(refx.offeringId);
  return c ? <>{c.m.modelId} <span className="muted">· {c.ep.name}</span></> : <>A model that no longer exists</>;
}

/** "A", "A and B", "A, B and C". */
const andList = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "");
/** Context windows as "128k". */
const contextWord = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

function Tasks({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const p = ctx.models.page;
  const groups = useLoad(() => get<GroupInfo[]>(u(userId, "groups")), [userId]);
  const [showOther, setShowOther] = useState(false);
  const [editing, setEditing] = useState<{ profile: ProfileName; task: Task }>();
  const [run, busy, error] = useAction();
  const close = useCallback(() => setEditing(undefined), []);
  const general = p?.profiles.default ?? "cloud";
  const other = general === "custom" ? "cloud" : "custom";
  const G = PROFILE_WORD[general], O = PROFILE_WORD[other];
  const actions = p && <button type="button" className="sm" onClick={() => setShowOther(!showOther)}>{showOther ? `Hide ${O}` : `Show ${O} too`}</button>;
  const useOther = () => run(async () => {
    const profiles = await patch<Profiles>(u(userId, "profiles"), { default: other });
    const cur = ctx.models.page;
    if (cur) ctx.models.set({ ...cur, profiles });
    setEditing(undefined);
  });
  const all = p ? copies(p) : new Map<string, Copy>();
  const gs = groups.data ?? [];
  const cell = (profile: ProfileName, task: Task, col: string) => {
    if (task === "speech.transcribe" && profile !== "local") return <td />;
    const prof = p!.profiles[profile];
    const entry = entryOf(prof, task);
    const list = listOf(prof, task);
    const first = list[0];
    const ups = list.map((r) => refUp(p!, membersOf(r, all, gs, profile)));
    const dot = !first ? "down" : ups[0] ? "up" : ups.some(Boolean) ? "away" : "down";
    const kind = first && profile === "custom" ? refKind(membersOf(first, all, gs, profile)) : undefined;
    const on = editing?.profile === profile && editing.task === task;
    return (
      <td>
        <button type="button" className={`cell${profile === other ? " other" : ""}`} data-cell={`${profile}:${task}`} data-col={col} aria-pressed={on}
          onClick={() => setEditing(on ? undefined : { profile, task })}>
          <span className="m"><span className={`dot ${dot}`} aria-hidden="true" /><span>{first ? <RefLabel refx={first} all={all} groups={gs} /> : "No model"}</span>{kind && <Kind kind={kind} />}</span>
          <span className="sub">
            {entry && !Array.isArray(entry) ? `= ${TASK_WORD[entry.same]}`
              : list.length > 1 ? <>+<span className="num">{list.length - 1}</span> {list.length > 2 ? "fallbacks" : "fallback"}</>
              : list.length === 1 ? <span className="warn-text">no fallback</span> : null}
          </span>
        </button>
      </td>
    );
  };
  const cols = showOther ? 4 : 3;
  return (
    <Frame ctx={ctx} tab="tasks" title="Tasks" actions={actions}>
      <ErrorText error={ctx.models.error || groups.error || error} />
      {p && (
        <div className="tablewrap tasks">
          <table className="ttable">
            <thead>
              <tr>
                <th>Task</th>
                <th><b title="Local profile · local models only">Private threads</b></th>
                <th>
                  <b title={`${G} profile · ${general === "custom" ? "local and cloud, falls back across" : "cloud models only"}`}>General threads</b>
                  <div className="actions"><button type="button" className="sm" disabled={busy} onClick={() => void useOther()}>Use {O} instead</button></div>
                </th>
                {showOther && <th><b title="Not the default. A general thread can switch to it.">{O} profile</b></th>}
              </tr>
            </thead>
            <tbody>
              {TASK_ROWS.map((g) => (
                <Fragment key={g.group}>
                  <tr className="tgroup"><td colSpan={cols}><span className="eyebrow">{g.group}</span></td></tr>
                  {g.tasks.map(({ task, hint }) => (
                    <tr key={task} data-task={task}>
                      <td className="task"><b title={hint}>{TASK_WORD[task]}</b></td>
                      {cell("local", task, "Private threads")}
                      {cell(general, task, "General threads")}
                      {showOther && cell(other, task, `${O} profile`)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && p && (
        <>
          <TaskDrawer key={`${editing.profile}:${editing.task}`} ctx={ctx} p={p} all={all} groups={gs} profile={editing.profile} task={editing.task} onClose={close} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={close} />
        </>
      )}
    </Frame>
  );
}

/** Edit a task: its own list or Same as another task, saved at once; Add… opens the picker inside the drawer. */
function TaskDrawer({ ctx, p, all, groups, profile, task, onClose }: {
  ctx: MCtx; p: ModelsPage; all: Map<string, Copy>; groups: GroupInfo[]; profile: ProfileName; task: Task; onClose: () => void;
}) {
  const userId = ctx.user.id;
  const [run, busy, error] = useAction();
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<Task>();
  const ref = useRef<HTMLElement>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  useEffect(() => {
    ref.current?.focus();
    // Escape closes the picker first, then the drawer.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { if (pickingRef.current) setPicking(false); else onClose(); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const prof = p.profiles[profile];
  const entry = entryOf(prof, task);
  const own = !entry || Array.isArray(entry);
  const list = Array.isArray(entry) ? entry : [];
  const name = TASK_WORD[task];
  const followers = TASK_ORDER.filter((t) => { const e = prof[t]; return !!e && !Array.isArray(e) && e.same === task; });
  // Same as: a task of the same kind that doesn't itself follow another. Chat can't follow a task that follows Chat.
  const options = TASK_ORDER.filter((t) => t !== task && capability(t) === capability(task) && (
    (!own && entry.same === t) || (prof[t] ? Array.isArray(prof[t]) : task !== "chat" && capability(t) === "text")));
  const sel = !own ? entry.same : target && options.includes(target) ? target : options[0];
  const save = (change: ProfileEntryChange) => run(async () => {
    const profiles = await put<Profiles>(u(userId, "profiles", profile, task), change);
    const cur = ctx.models.page;
    if (cur) ctx.models.set({ ...cur, profiles });
  });
  const saveList = (next: ModelRef[]) => save({ models: next });
  const move = (i: number, by: number) => { const next = [...list]; [next[i], next[i + by]] = [next[i + by]!, next[i]!]; void saveList(next); };
  const add = (r: ModelRef) => { setPicking(false); setQ(""); void saveList([...list, r]); };
  const about = `${PROFILE_WORD[profile]} profile · ${profile === "local" ? "private and local-only threads" : profile === p.profiles.default ? "general threads by default" : "general threads that choose it"}`;
  // Why Same as is off: other tasks follow this one. A fact about the list, so it stays in view (a tooltip doesn't show on a phone).
  const followed = followers.length ? `${andList(followers.map((t) => TASK_WORD[t]))} ${followers.length > 1 ? "use" : "uses"} this list.` : undefined;
  let prevKind: string | undefined;
  return (
    <aside ref={ref} tabIndex={-1} className="drawer task-drawer" aria-label={`Edit ${name}`}>
      <div className="drawer-head">
        <h2 title={about}>{name}</h2>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="drawer-body">
        {options.length > 0 && (
          <div className="follow-block">
            <div className="follow" role="radiogroup" aria-label={`Models for ${name}`}>
              <label><input type="radio" name="follow" checked={own} disabled={busy} onChange={() => void saveList(listOf(prof, task))} /> Its own list</label>
              <label><input type="radio" name="follow" checked={!own} disabled={busy || !!followed} aria-describedby={followed ? "follow-why" : undefined} onChange={() => sel && void save({ same: sel })} /> Same as</label>
              <select aria-label="Task to share with" value={sel} disabled={own || busy}
                onChange={(e) => { const t = e.target.value as Task; setTarget(t); if (!own) void save({ same: t }); }}>
                {options.map((t) => <option key={t} value={t}>{TASK_WORD[t]}</option>)}
              </select>
            </div>
            {followed && <p className="cap" id="follow-why">{followed}</p>}
          </div>
        )}
        <ErrorText error={error} />
        {own && (
          <>
            {list.length > 0 && (
              <ol className="olist" aria-label={`${name} list`}>
                {list.map((r, i) => {
                  const ms = membersOf(r, all, groups, profile);
                  const kind = refKind(ms);
                  const cross = profile === "custom" && prevKind && kind && kind !== prevKind;
                  prevKind = kind ?? prevKind;
                  const group = "groupId" in r ? groups.find((g) => g.id === r.groupId) : undefined;
                  return (
                    <Fragment key={refKey(r)}>
                      {cross && <li className="crossline">Falls back to {kind} from here</li>}
                      <li className="oentry" data-ref={refKey(r)}>
                        <span className="onum num">{i + 1}</span>
                        <div className="obody">
                          <div className="oname">
                            {!group && <span className={`dot ${refUp(p, ms) ? "up" : "away"}`} aria-hidden="true" />}
                            {profile === "custom" && kind && <Kind kind={kind} />}
                            {group ? <><b>{group.name}</b><span className="cap">group of <span className="num">{ms.length}</span></span></> : <span><RefLabel refx={r} all={all} groups={groups} /></span>}
                          </div>
                          {group && (
                            <div className="members">
                              {ms.map((c) => (
                                <span key={c.m.id} className={c.off ? "off" : undefined}>
                                  <span className={`dot${c.off ? "" : answers(p, c) ? " up" : " away"}`} aria-hidden="true" /> {c.m.modelId} · {c.ep.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="octl">
                          <button type="button" className="icon sm" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                          <button type="button" className="icon sm" aria-label="Move down" disabled={busy || i === list.length - 1} onClick={() => move(i, 1)}><Icon name="arrow-down" /></button>
                          <button type="button" className="icon sm" aria-label="Remove" disabled={busy || list.length === 1} onClick={() => void saveList(list.filter((_, j) => j !== i))}><Icon name="close" /></button>
                        </div>
                      </li>
                    </Fragment>
                  );
                })}
              </ol>
            )}
            {picking
              ? <Picker p={p} groups={groups} profile={profile} task={task} list={list} q={q} setQ={setQ} busy={busy} onAdd={add} onCancel={() => { setPicking(false); setQ(""); }} />
              : <div className="actions"><button type="button" disabled={busy} onClick={() => setPicking(true)}>Add…</button></div>}
          </>
        )}
      </div>
    </aside>
  );
}

/** Add…: suitable models of the profile's kinds, by endpoint, with a search; groups with a suitable member as chips. */
function Picker({ p, groups, profile, task, list, q, setQ, busy, onAdd, onCancel }: {
  p: ModelsPage; groups: GroupInfo[]; profile: ProfileName; task: Task; list: ModelRef[]; q: string; setQ: (q: string) => void;
  busy: boolean; onAdd: (r: ModelRef) => void; onCancel: () => void;
}) {
  const kindOk = (k: "local" | "cloud") => profile === "custom" || k === profile;
  const taken = new Set(list.map(refKey));
  const needle = q.trim().toLowerCase();
  const eps = p.endpoints.filter((ep) => kindOk(ep.kind)).map((ep) => ({
    ep,
    models: ep.models.filter((m) => suits(task, m) && !taken.has(m.id) && (!needle || `${m.modelId} ${ep.name}`.toLowerCase().includes(needle))),
  })).filter((x) => x.models.length);
  const all = copies(p);
  const gs = groups.filter((g) => !taken.has(`g:${g.id}`) && g.members.some((id) => { const c = all.get(id); return !!c && kindOk(c.ep.kind) && suits(task, c.m); }));
  const count = eps.reduce((n, x) => n + x.models.length, 0);
  return (
    <section className="pick" aria-label={`Add to ${TASK_WORD[task]}`}>
      <div className="section-head"><h3>Add to {TASK_WORD[task]}</h3><button type="button" className="sm" onClick={onCancel}>Cancel</button></div>
      {gs.length > 0 && (
        <div className="pick-groups">
          {gs.map((g) => <button key={g.id} type="button" className="chip" disabled={busy} onClick={() => onAdd({ groupId: g.id })}>+ Group: {g.name}</button>)}
        </div>
      )}
      <input type="search" aria-label="Search models" autoFocus placeholder={`Search ${count} models`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list picklist">
        {eps.length ? eps.map(({ ep, models }) => (
          <Fragment key={ep.id}>
            <div className="group-head eyebrow">{ep.name} · {ep.kind}</div>
            {models.map((m) => (
              <div key={m.id} className="pick-row" data-offering={m.id}>
                <div className="main-col">
                  <span className="name">{m.modelId}</span>
                  <span className="meta muted">
                    {[
                      m.contextWindow ? <><span className="num">{contextWord(m.contextWindow)}</span> context</> : null,
                      m.tools ? "tools" : null, m.vision ? "vision" : null, m.reasoning?.length ? "thinking" : null,
                      m.speak?.voices.length ? <><span className="num">{m.speak.voices.length}</span> {m.speak.voices.length === 1 ? "voice" : "voices"}</> : null,
                    ].filter(Boolean).map((x, i) => <Fragment key={i}>{i > 0 && " · "}{x}</Fragment>)}
                  </span>
                </div>
                <button type="button" className="sm" disabled={busy} onClick={() => onAdd({ offeringId: m.id })}>Add</button>
              </div>
            ))}
          </Fragment>
        )) : <p className="empty">No models match.</p>}
      </div>
    </section>
  );
}

/* ---- Hosts and endpoints ---- */

function Hosts({ ctx }: { ctx: MCtx }) {
  const p = ctx.models.page;
  const eps = p?.endpoints ?? [];
  const hosts = eps.filter((e) => e.api === "host"), plain = eps.filter((e) => e.api !== "host");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Endpoint>();
  const [signIn, setSignIn] = useState(false);
  const [voice, setVoice] = useState<OfferingInfo>();
  const close = useCallback(() => { setAdding(false); setEditing(undefined); setSignIn(false); }, []);
  const closeVoice = useCallback(() => setVoice(undefined), []);
  const facts = p && <>{plural(hosts.length, "paired host", "paired hosts")} · {plural(plain.length, "plain endpoint", "plain endpoints")}</>;
  const actions = <>
    <button type="button" onClick={() => setAdding(true)}>Add endpoint</button>
    <button type="button" className="primary" onClick={() => go({ page: "models", userId: ctx.user.id, tab: "hosts", add: "host" })}>Add model host</button>
  </>;
  return (
    <Frame ctx={ctx} tab="hosts" title="Hosts and endpoints" facts={facts} actions={actions}>
      <ErrorText error={ctx.models.error} />
      {p && hosts.length > 0 && (
        <section className="section" aria-labelledby="h-model-hosts">
          <div className="section-head">
            <h2 id="h-model-hosts">Model hosts</h2>
            <span className="cap legend"><span><i className="seg-pinned" />Pinned</span><span><i className="seg-loaded" />Loaded on demand</span><span><i className="seg-vllm" />vLLM share</span></span>
          </div>
          {hosts.map((ep) => <HostCard key={ep.id} ctx={ctx} ep={ep} host={hostOf(p, ep.id)} others={eps} onVoice={setVoice} />)}
        </section>
      )}
      {p && (
        <section className="section" aria-labelledby="h-plain-endpoints">
          <div className="section-head"><h2 id="h-plain-endpoints">Plain endpoints</h2></div>
          {plain.length ? (
            <ul className="list">
              {plain.map((ep) => <EndpointRow key={ep.id} ctx={ctx} ep={ep} others={eps} onEdit={(again) => { setEditing(ep); setSignIn(!!again); }} onVoice={setVoice} />)}
            </ul>
          ) : <p className="empty">No endpoints yet.</p>}
        </section>
      )}
      {(adding || editing) && (
        <>
          <EndpointDrawer key={editing?.id ?? "new"} ctx={ctx} ep={editing} signIn={signIn} onClose={close} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={close} />
        </>
      )}
      {voice && <VoiceDrawer userId={ctx.user.id} model={voice} onClose={closeVoice} />}
      {voice && <div className="scrim drawer-scrim" aria-hidden="true" onClick={closeVoice} />}
    </Frame>
  );
}

/** An endpoint's models, each by its ID; a speaking model has its Settings. */
function ModelList({ ep, onVoice }: { ep: EndpointInfo; onVoice: (m: OfferingInfo) => void }) {
  if (!ep.models.length) return <p className="muted small wide">No models yet.</p>;
  return (
    <ul className="model-list wide" aria-label={`${ep.name} models`}>
      {ep.models.map((m) => (
        <li key={m.id} data-offering={m.id}>
          <code>{m.modelId}</code>
          {m.status !== "listed" && <span className="pill warn">{m.status}</span>}
          {m.speak?.voices.length ? <button type="button" className="link sm" aria-label={`${m.modelId} settings`} onClick={() => onVoice(m)}>Settings</button> : null}
        </li>
      ))}
    </ul>
  );
}

/** The ⋯ menu's actions on any endpoint, and the fields and dialogs they open. */
const PLAN_NAMES = { chatgpt: "ChatGPT", grok: "Grok" } as const;
type PlanKind = keyof typeof PLAN_NAMES;
const planOf = (api: string): PlanKind | undefined => api === "chatgpt" || api === "grok" ? api : undefined;

function useEndpointActions(ctx: MCtx, ep: Endpoint, others: Endpoint[], onSignIn?: () => void) {
  const userId = ctx.user.id;
  const path = u(userId, "endpoints", ep.id);
  const [run, busy, error] = useAction();
  const [model, setModel] = useState<string>();
  const [into, setInto] = useState<string>();
  const [asking, setAsking] = useState<"reset" | "merge" | "remove">();
  const done = () => ctx.models.reload();
  // Merging folds an endpoint into another of the same kind and place.
  const targets = others.filter((o) => o.id !== ep.id && o.kind === ep.kind && o.shared === ep.shared && o.api === ep.api);
  const items = [
    ...(planOf(ep.api) && onSignIn ? [{ label: "Sign in again", onPick: onSignIn }] : []),
    { label: "Read its models", onPick: () => void run(async () => { await post(`${path}/discover`); done(); }) },
    { label: "Add a model by hand", onPick: () => setModel("") },
    { label: "Reset IDs…", onPick: () => setAsking("reset") },
    ...(targets.length ? [{ label: "Merge into…", onPick: () => setInto(targets[0]!.id) }] : []),
    { label: "Remove", danger: true, onPick: () => setAsking("remove") },
  ];
  const target = targets.find((t) => t.id === into);
  const forms = <>
    {model !== undefined && (
      <form className="inline wide" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`${path}/models`, { modelId: model.trim() }); setModel(undefined); done(); }); }}>
        <label className="field grow"><span>Model ID</span><input className="mono" autoFocus value={model} onChange={(e) => setModel(e.target.value)} /></label>
        <button className="sm" disabled={busy || !model.trim()}>Add</button>
        <button type="button" className="sm" onClick={() => setModel(undefined)}>Cancel</button>
      </form>
    )}
    {into !== undefined && (
      <form className="inline wide" onSubmit={(e) => { e.preventDefault(); setAsking("merge"); }}>
        <label className="field grow"><span>Merge into</span>
          <select value={into} onChange={(e) => setInto(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <button className="sm" disabled={busy || !target}>Merge</button>
        <button type="button" className="sm" onClick={() => setInto(undefined)}>Cancel</button>
      </form>
    )}
    <ErrorText error={error} />
    {asking === "reset" && (
      <ConfirmDialog title={`Reset IDs of ${ep.name}?`} sentence="Its models get new IDs. Your lists and groups follow at once; other people's follow when they next unlock."
        confirm="Reset IDs" onCancel={() => setAsking(undefined)}
        onConfirm={() => { setAsking(undefined); void run(async () => { await post(`${path}/reset-ids`); done(); }); }} />
    )}
    {asking === "merge" && target && (
      <ConfirmDialog title={`Merge ${ep.name} into ${target.name}?`} sentence={`${ep.name} goes, and lists that name its models name ${target.name}'s instead.`}
        confirm="Merge" onCancel={() => setAsking(undefined)}
        onConfirm={() => { setAsking(undefined); const to = target.id; void run(async () => { await post(`${path}/merge`, { into: to }); setInto(undefined); done(); }); }} />
    )}
    {asking === "remove" && (
      <ConfirmDialog title={`Remove ${ep.name}?`} sentence={ep.api === "host"
        ? "Its models leave every list that names them. The host keeps listing this server until you revoke it there."
        : planOf(ep.api) ? `Its models leave every list that names them. Lyrica stays connected in your ${PLAN_NAMES[planOf(ep.api)!]} account until you disconnect it there.`
        : "Its models leave every list that names them, so threads that used them fall back to the next model."}
        confirm="Remove" danger onCancel={() => setAsking(undefined)}
        onConfirm={() => { setAsking(undefined); void run(async () => { await del(path); done(); }); }} />
    )}
  </>;
  return { items, forms };
}

/** A paired model host: its state, Pause or Resume (Pair again… once it has revoked this server), Dashboard, its models, addresses and each GPU. */
function HostCard({ ctx, ep, host, others, onVoice }: { ctx: MCtx; ep: Endpoint; host?: Host; others: Endpoint[]; onVoice: (m: OfferingInfo) => void }) {
  const userId = ctx.user.id;
  const editable = canEdit(ctx, ep);
  const [open, setOpen] = useState(false);
  const [addresses, setAddresses] = useState<string>();
  const [code, setCode] = useState<string>();
  const [run, busy, error] = useAction();
  const actions = useEndpointActions(ctx, ep, others);
  const status = host && "status" in host ? host.status : undefined;
  const revoked = unpaired(host);
  const id = `h-host-${ep.id}`;
  const saveAddresses = () => run(async () => {
    await put(u(userId, "hosts", ep.id, "addresses"), { addresses: (addresses ?? "").split(/[\s,]+/).filter(Boolean) });
    setAddresses(undefined); ctx.models.reload();
  });
  const pair = () => run(async () => { await post(u(userId, "hosts", ep.id, "pair"), { code: (code ?? "").trim() }); setCode(undefined); ctx.models.reload(); });
  return (
    <article className="card host" data-endpoint={ep.id} aria-labelledby={id}>
      <div className="host-top">
        <h3 id={id}>{ep.name}</h3><Kind kind="local" /><StateWord ep={ep} host={host} />
        <span className="spacer" />
        <div className="actions">
          {editable && (revoked
            ? <button type="button" className="sm" aria-expanded={code !== undefined} aria-controls={`${id}-pair`} onClick={() => setCode(code === undefined ? "" : undefined)}>Pair again…</button>
            : <PauseButton ctx={ctx} ep={ep} host={host} />)}
          <DashboardButton ctx={ctx} ep={ep} />
          <button type="button" className="link sm" aria-expanded={open} onClick={() => setOpen(!open)}>{plural(ep.models.length, "model", "models")}</button>
          {editable && <RowMenu label={`Actions for ${ep.name}`} items={revoked ? actions.items : [actions.items[0]!, { label: "Pair again…", onPick: () => setCode("") }, ...actions.items.slice(1)]} />}
        </div>
      </div>
      {addresses === undefined ? (
        <div className="addrs">
          <span className="muted">{ep.shared ? "Shared with every user" : "Only you"}{revoked ? "" : " · paired"} · ID</span><code>{ep.id}</code>
          <span className="muted">· addresses</span>{(ep.addresses ?? []).map((a) => <code key={a}>{a}</code>)}
          {editable && <button type="button" className="link sm" onClick={() => setAddresses((ep.addresses ?? []).join(" "))}>Edit</button>}
        </div>
      ) : (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void saveAddresses(); }}>
          <label className="field grow"><span>Addresses</span><input className="mono" autoFocus value={addresses} onChange={(e) => setAddresses(e.target.value)} /></label>
          <button className="sm" disabled={busy || !addresses.trim()}>Save</button>
          <button type="button" className="sm" onClick={() => setAddresses(undefined)}>Cancel</button>
        </form>
      )}
      {code !== undefined && (
        <form className="inline" id={`${id}-pair`} onSubmit={(e) => { e.preventDefault(); void pair(); }}>
          <label className="field grow"><span>Pairing code</span><input className="mono" autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="sm" disabled={busy || !code.trim()}>Pair</button>
          <button type="button" className="sm" onClick={() => setCode(undefined)}>Cancel</button>
        </form>
      )}
      <ErrorText error={error} />
      {actions.forms}
      {status?.gpus.map((g) => <GpuBlock key={g.index} g={g} />)}
      {open && <ModelList ep={ep} onVoice={onVoice} />}
    </article>
  );
}

function GpuBlock({ g }: { g: Gpu }) {
  const queued = (["chat", "image", "background"] as const).filter((k) => g.queue[k] > 0);
  return (
    <div className="gpu" data-gpu={g.index}>
      <div className="gpu-line"><span>GPU <span className="num">{g.index}</span> · {g.name}</span><span className="num muted">{gb(g.vram.used)} / {gbTotal(g.vram.total)} GB</span></div>
      <Bar gpus={[g]} />
      <span className="meta">
        {g.models.length ? g.models.map((m, i) => (
          <Fragment key={m.id}>{i > 0 && " · "}{shortId(m.id)} <span className="cap">({m.pinned ? "pinned" : m.state === "loading" ? "loading" : g.role === "vllm" ? "vLLM" : "loaded"})</span></Fragment>
        )) : "nothing loaded"}
      </span>
      {queued.length > 0 && <span className="cap">Waiting: {queued.map((k, i) => <Fragment key={k}>{i > 0 && " · "}<span className="num">{g.queue[k]}</span> {k}</Fragment>)}</span>}
    </div>
  );
}

/** A plain OpenAI-compatible endpoint: its URL and ID, its state, its models, Edit and ⋯. */
function EndpointRow({ ctx, ep, others, onEdit, onVoice }: { ctx: MCtx; ep: Endpoint; others: Endpoint[]; onEdit: (signIn?: boolean) => void; onVoice: (m: OfferingInfo) => void }) {
  const [open, setOpen] = useState(false);
  const actions = useEndpointActions(ctx, ep, others, () => onEdit(true));
  const editable = canEdit(ctx, ep);
  return (
    <li className="ep-row" data-endpoint={ep.id}>
      <div className="main-col">
        <span className="name">{ep.name} <Kind kind={ep.kind} />{planOf(ep.api) && <span className="pill">{PLAN_NAMES[planOf(ep.api)!]} plan</span>}{ep.unencrypted && <span className="pill warn">unencrypted</span>}{ep.stale && <span className="pill bad">stale</span>}</span>
        <span className="meta muted"><code className="url">{ep.baseUrl}</code> · {ep.shared ? "shared" : "only you"} · ID <span className="mono">{ep.id}</span></span>
        {ep.warning && <span className="warn-text">{ep.warning}</span>}
      </div>
      <div className="actions">
        <StateWord ep={ep} />
        <button type="button" className="link sm" aria-expanded={open} onClick={() => setOpen(!open)}>{plural(ep.models.length, "model", "models")}</button>
        {editable && <button type="button" className="sm" onClick={() => onEdit()}>Edit</button>}
        {editable && <RowMenu label={`Actions for ${ep.name}`} items={actions.items} />}
      </div>
      {actions.forms}
      {open && <ModelList ep={ep} onVoice={onVoice} />}
    </li>
  );
}

/** Plain HTTP to somewhere other than this machine or the tailnet, as the server marks `unencrypted`. */
function plainHttp(url: string): boolean {
  let host: string;
  try { const x = new URL(url.trim()); if (x.protocol !== "http:") return false; host = x.hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host) || host.endsWith(".ts.net")) return false;
  const m = /^100\.(\d+)\./.exec(host);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return false;
  return !/^fd7a:115c:a1e0:/i.test(host);
}

/** Add endpoint, or Edit one: in the drawer, with one Save at its foot. */
function EndpointDrawer({ ctx, ep, signIn, onClose }: { ctx: MCtx; ep?: EndpointInfo; signIn?: boolean; onClose: () => void }) {
  const userId = ctx.user.id;
  const [name, setName] = useState(ep?.name ?? "");
  // A plan is a kind of its own here: always cloud, signed in rather than given a URL and key.
  const [kind, setKind] = useState<"local" | "cloud" | "openrouter" | PlanKind>(ep ? planOf(ep.api) ?? ep.kind : "local");
  const [baseUrl, setBaseUrl] = useState(ep?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [shared, setShared] = useState(false);
  const [run, busy, error] = useAction();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const change: EndpointChange = ep ? {
    ...(name.trim() !== ep.name ? { name: name.trim() } : {}),
    ...(baseUrl.trim() !== ep.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
    ...(removeKey ? { apiKey: null } : apiKey ? { apiKey } : {}),
  } : {};
  const openrouter = !ep && kind === "openrouter";
  const plan = kind === "local" || kind === "cloud" || kind === "openrouter" ? undefined : kind;
  const ready = plan ? !!ep && !!name.trim() && name.trim() !== ep.name
    : ep ? Object.keys(change).length > 0 && !!name.trim() && !!baseUrl.trim() : !!name.trim() && !!baseUrl.trim();
  const save = () => run(async () => {
    if (ep) await patch(u(userId, "endpoints", ep.id), change);
    else if (!plan) await post(u(userId, "endpoints"), { name: name.trim(), kind, baseUrl: baseUrl.trim(), ...(apiKey ? { apiKey } : {}), ...(shared ? { shared } : {}) });
    ctx.models.reload();
    onClose();
  });
  const title = ep ? ep.name : "Add endpoint";
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={ep ? `Edit ${ep.name}` : "Add endpoint"}>
      <div className="drawer-head">
        <h2>{title}</h2>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
        <fieldset className="group" disabled={busy}>
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          {!ep && (
            <label className="field"><span>Kind</span>
              <select value={kind} title="Local means on your own network: this machine, the LAN or the tailnet." onChange={(e) => setKind(e.target.value as "local" | "cloud" | "openrouter" | PlanKind)}>
                <option value="local">Local</option><option value="cloud">Cloud</option><option value="chatgpt">ChatGPT plan</option><option value="grok">Grok plan</option><option value="openrouter">OpenRouter</option>
              </select>
            </label>
          )}
          {plan && (!ep || signIn) && <PlanSignIn key={plan} ctx={ctx} plan={plan} name={name.trim()} ep={ep} onDone={onClose} />}
          {openrouter && <OpenRouterSignIn ctx={ctx} name={name.trim()} shared={shared} onShared={setShared} onDone={onClose} />}
          {!plan && !openrouter && <>
          <label className="field"><span>Base URL</span><input className="mono" inputMode="url" autoCapitalize="none" placeholder="http://192.168.1.50:1234/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
          {(ep?.kind ?? kind) === "local" && plainHttp(baseUrl) && <p className="warn-text" role="note">Plain HTTP: the API key and every message cross the network unencrypted.</p>}
          <label className="field"><span>API key</span>
            <input type="password" autoComplete="off" disabled={removeKey} placeholder={ep?.hasApiKey ? "leave blank to keep" : undefined} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          {ep?.hasApiKey && <label className="check"><input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} /> Remove key</label>}
          {!ep && ctx.user.admin && <Switch label="Shared" hint="Every user on this server can use it" checked={shared} onChange={setShared} />}
          </>}
        </fieldset>
        <ErrorText error={error} />
        {!(plan && !ep) && !openrouter && <div className="row drawer-foot"><button type="submit" className="primary" disabled={busy || !ready}>Save</button></div>}
      </form>
    </aside>
  );
}

/**
 * A plan's sign-in, for a new plan (`name`) or one signed out (`ep`), opening the provider's page in a
 * new tab. ChatGPT: after approving, the browser lands on an address on this server's loopback it
 * can't open, which the person pastes back as Redirect URL. Grok: the page asks for the Code shown
 * here. Finish saves the plan once the provider confirms. Leaving cancels the sign-in.
 */
function PlanSignIn({ ctx, plan, name, ep, onDone }: { ctx: MCtx; plan: PlanKind; name: string; ep?: EndpointInfo; onDone: () => void }) {
  const userId = ctx.user.id;
  const [started, setStarted] = useState<PlanSignInStarted>();
  const [redirect, setRedirect] = useState("");
  const [run, busy, error] = useAction();
  const live = useRef<string | undefined>(undefined);
  useEffect(() => () => { if (live.current) void del(u(userId, "plans", "sign-in", live.current)).catch(() => {}); }, [userId]);
  const start = () => run(async () => {
    const tab = open("about:blank", "_blank");
    const s = await post<PlanSignInStarted>(u(userId, "plans", "sign-in"), ep ? { endpointId: ep.id } : { plan, name });
    live.current = s.id;
    setStarted(s);
    if (tab) { tab.opener = null; tab.location.href = s.url; } else open(s.url, "_blank", "noopener");
  });
  const finish = () => run(async () => {
    const id = started!.id;
    live.current = undefined;
    try {
      await post(u(userId, "plans", "sign-in", id), plan === "chatgpt" ? { redirectUrl: redirect.trim() } : {});
    } catch (e) {
      setStarted(undefined);
      setRedirect("");
      throw e;
    }
    ctx.models.reload();
    onDone();
  });
  return <>
    <button type="button" className={started ? undefined : "primary"} disabled={busy || (!ep && !name)} onClick={() => void start()}>Sign in with {PLAN_NAMES[plan]}</button>
    {started?.code && <p className="field"><span>Code</span><code className="mono">{started.code}</code></p>}
    {started && plan === "grok" && <div className="row drawer-foot"><button type="button" className="primary" disabled={busy} onClick={() => void finish()}>Finish</button></div>}
    {started && plan === "chatgpt" && <>
      <label className="field"><span>Redirect URL</span>
        <input className="mono" inputMode="url" autoCapitalize="none" autoComplete="off" title="The address your browser was sent to after you approved, starting http://127.0.0.1:1455/auth/callback" placeholder="http://127.0.0.1:1455/auth/callback?…" value={redirect} onChange={(e) => setRedirect(e.target.value)} />
      </label>
      <div className="row drawer-foot"><button type="button" className="primary" disabled={busy || !redirect.trim()} onClick={() => void finish()}>Finish</button></div>
    </>}
    <ErrorText error={error} />
  </>;
}

/** OpenRouter's sign-in for a new endpoint: its page opens in a new tab and shows a Code to paste here; Finish saves the endpoint. */
function OpenRouterSignIn({ ctx, name, shared, onShared, onDone }: { ctx: MCtx; name: string; shared: boolean; onShared: (v: boolean) => void; onDone: () => void }) {
  const userId = ctx.user.id;
  const [started, setStarted] = useState<PlanSignInStarted>();
  const [code, setCode] = useState("");
  const [run, busy, error] = useAction();
  const live = useRef<string | undefined>(undefined);
  useEffect(() => () => { if (live.current) void del(u(userId, "openrouter", "sign-in", live.current)).catch(() => {}); }, [userId]);
  const start = () => run(async () => {
    const tab = open("about:blank", "_blank");
    try {
      const s = await post<PlanSignInStarted>(u(userId, "openrouter", "sign-in"), { name, ...(shared ? { shared } : {}) });
      live.current = s.id;
      setStarted(s);
      if (tab) { tab.opener = null; tab.location.href = s.url; } else open(s.url, "_blank", "noopener");
    } catch (e) {
      tab?.close();
      throw e;
    }
  });
  const finish = () => run(async () => {
    const id = started!.id;
    live.current = undefined;
    try {
      await post(u(userId, "openrouter", "sign-in", id), { code: code.trim() });
    } catch (e) {
      setStarted(undefined);
      setCode("");
      throw e;
    }
    ctx.models.reload();
    onDone();
  });
  return <>
    {ctx.user.admin && <Switch label="Shared" hint="Every user on this server can use it" checked={shared} disabled={!!started} onChange={onShared} />}
    <button type="button" className={started ? undefined : "primary"} disabled={busy || !name} onClick={() => void start()}>Sign in with OpenRouter</button>
    {started && <>
      <label className="field"><span>Code</span><input className="mono" autoCapitalize="none" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <div className="row drawer-foot"><button type="button" className="primary" disabled={busy || !code.trim()} onClick={() => void finish()}>Finish</button></div>
    </>}
    <ErrorText error={error} />
  </>;
}

/** Add model host: name, addresses and the code its dashboard shows; then the fingerprint it paired with. */
function AddHost({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const [name, setName] = useState("");
  const [addresses, setAddresses] = useState("");
  const [code, setCode] = useState("");
  const [shared, setShared] = useState(false);
  const [paired, setPaired] = useState<EndpointInfo>();
  const [run, busy, error] = useAction();
  const list = addresses.split(/[\s,]+/).filter(Boolean);
  const pair = () => run(async () => {
    setPaired(await post<EndpointInfo>(u(userId, "hosts"), { name: name.trim(), addresses: list, code: code.trim(), ...(shared ? { shared } : {}) }));
    ctx.models.reload();
  });
  const back = href({ page: "models", userId, tab: "hosts" });
  return (
    <Frame ctx={ctx} tab="hosts" title="Add model host">
      <div className="steps add-host">
        <form className="step" onSubmit={(e) => { e.preventDefault(); void pair(); }}>
          <h2 className="eyebrow">Host</h2>
          <fieldset className="stack" disabled={busy || !!paired}>
            <label className="field"><span>Name</span><input value={name} autoFocus onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span>Addresses</span><textarea className="mono" rows={3} autoCapitalize="none" placeholder={"192.168.1.40\nblackwell.tailnet.ts.net"} value={addresses} onChange={(e) => setAddresses(e.target.value)} /></label>
            <label className="field"><span>Pairing code</span><input className="mono" autoComplete="off" autoCapitalize="none" value={code} onChange={(e) => setCode(e.target.value)} /></label>
            {ctx.user.admin && <Switch label="Shared" hint="Every user on this server can use it" checked={shared} onChange={setShared} />}
          </fieldset>
          <ErrorText error={error} />
          <div className="row">
            <button className={paired ? "" : "primary"} disabled={busy || !!paired || !name.trim() || !list.length || !code.trim()}>Pair</button>
            {!paired && <a className="link" href={back}>Cancel</a>}
          </div>
        </form>
        {paired && (
          <section className="step" aria-labelledby="h-fingerprint">
            <h2 id="h-fingerprint" className="eyebrow">Fingerprint</h2>
            <p className="fingerprint mono" data-fingerprint>{paired.fingerprint}</p>
            <p className="meta">{plural(paired.models.length, "model", "models")}</p>
            <a href={back}>Hosts and endpoints</a>
          </section>
        )}
      </div>
    </Frame>
  );
}

/* ---- Clean up ---- */

function Cleanup({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const items = useLoad(() => get<CleanupItem[]>(u(userId, "models", "cleanup")), [userId]);
  const notice = useLoad(() => get<ModelsNotice>(u(userId, "models", "notice")), [userId]);
  const [run, busy, error] = useAction();
  const [removing, setRemoving] = useState<CleanupItem>();
  const words = useWords(ctx);
  const list = items.data ?? [];
  const done = () => { items.reload(); ctx.models.reload(); };
  const removePath = (it: CleanupItem) => it.endpoint ? u(userId, "endpoints", it.endpoint.id) : it.offering ? u(userId, "offerings", it.offering.id) : u(userId, "groups", it.group!.id);
  const facts = items.data && plural(list.length, "thing to decide", "things to decide");
  return (
    <Frame ctx={ctx} tab="cleanup" title="Clean up" facts={facts}>
      <ErrorText error={items.error || notice.error || error} />
      {notice.data && notice.data.lines.length > 0 && (
        <div className="note models-notice" role="status">
          <ul className="plain">{notice.data.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <button type="button" className="sm" onClick={() => void run(async () => { await del(u(userId, "models", "notice")); notice.set({ lines: [] }); })}>Dismiss</button>
        </div>
      )}
      {items.data && (
        <ul className="list cleanup">
          {list.length ? list.map((it) => {
            const pill = it.endpoint ? "stale" : it.offering ? (it.offering.status === "listed" ? "gone" : it.offering.status) : "empty";
            const shared = it.endpoint?.shared ?? it.group?.shared ?? it.offering?.label.startsWith("shared.") ?? false;
            const since = it.endpoint?.downSince ?? it.offering?.missingSince;
            const detail = it.endpoint ? "Unreachable" : it.offering ? "Missing" : "No members left";
            const used = it.usedIn.map(words.use);
            if (it.otherUsers > 0) used.push(`${it.otherUsers} other ${it.otherUsers === 1 ? "person's" : "people's"} lists`);
            return (
              <li key={it.endpoint?.id ?? it.offering?.id ?? it.group?.id} className="ep-row" data-cleanup={pill}>
                <div className="main-col">
                  <span className="name">{it.label}<span className={`pill ${pill === "stale" ? "bad" : "warn"}`} title={pill === "stale" ? "Unreachable for 14 days or more" : pill === "gone" ? "Missing for 30 days or more" : undefined}>{pill}</span></span>
                  <span className="meta muted">
                    {detail}{since && <> for <span className="num">{duration(Date.now() - Date.parse(since))}</span></>}. {used.length ? `Used in ${used.join(", ")}.` : "Nothing uses it."}
                  </span>
                </div>
                {(!shared || ctx.user.admin) && (
                  <div className="actions">
                    {it.offering && it.suggestion && (
                      <button type="button" className="sm" disabled={busy} title="Leaves a redirect, so other people's settings follow at once."
                        onClick={() => void run(async () => { await post(u(userId, "offerings", it.offering!.id, "replace"), { with: it.suggestion!.offeringId }); done(); })}>
                        Replace with {modelAndEndpoint(it.suggestion.label)}
                      </button>
                    )}
                    <button type="button" className="sm danger" disabled={busy} onClick={() => setRemoving(it)}>Remove</button>
                  </div>
                )}
              </li>
            );
          }) : <li className="empty">Nothing to clean up.</li>}
        </ul>
      )}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.label}?`}
          sentence={removing.usedIn.length || removing.otherUsers ? "Every list that names it drops it." : "Nothing uses it, so nothing else changes."}
          confirm="Remove" danger onCancel={() => setRemoving(undefined)}
          onConfirm={() => { const it = removing; setRemoving(undefined); void run(async () => { await del(removePath(it)); done(); }); }} />
      )}
    </Frame>
  );
}

/* ---- Recent calls ---- */

function Calls({ ctx }: { ctx: MCtx }) {
  const calls = useLoad(() => get<CallInfo[]>(u(ctx.user.id, "models", "calls")), [ctx.user.id]);
  const shown = (calls.data ?? []).filter((c) => !hidden(ctx.me.display, c.pool));
  return (
    <Frame ctx={ctx} tab="calls" title="Recent calls" facts={calls.data && plural(shown.length, "call", "calls")}>
      <ErrorText error={calls.error} />
      {calls.data && <CallsTable ctx={ctx} calls={calls.data} />}
    </Frame>
  );
}

/** Which model answered each call, and when a fallback did. Never any of the conversation's text. */
function CallsTable({ ctx, calls, limit }: { ctx: MCtx; calls: CallInfo[]; limit?: number }) {
  const words = useWords(ctx);
  const rows = calls.filter((c) => !hidden(ctx.me.display, c.pool)).slice(0, limit);
  if (!rows.length) return <p className="empty">No calls yet.</p>;
  return (
    <div className="tablewrap">
      <table className="stack-table calls">
        <thead><tr><th>Time</th><th>Thread</th><th>Task</th><th>Answered by</th><th>Note</th></tr></thead>
        <tbody>
          {rows.map((c, i) => {
            const t = words.thread(c.pool, c.threadId);
            return (
              <tr key={`${c.at}/${i}`} data-task={c.task}>
                <td className="num" data-h="Time">{shortTime(c.at)}</td>
                <td data-h="Thread">
                  {c.pool === "private" && <><span className="kind private">private</span> </>}
                  {t ? <a href={href({ page: "thread", userId: ctx.user.id, pool: c.pool, threadId: c.threadId })}>{t.title || "New thread"}</a> : "a forgotten thread"}
                </td>
                <td data-h="Task">{TASK_WORD[c.task] ?? c.task}</td>
                <td data-h="Answered by">{modelAndEndpoint(c.label, c.endpointName)}</td>
                <td data-h="Note" className="warn-text">{c.fallback ?? c.note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
