// The Models area (docs/ux.md §6, "Models, hosts, downloads, clean-up"): Overview, Tasks, Text models (TextModels.tsx),
// Image models (ImageModels.tsx), Hosts and endpoints (with the Add model host page), Downloads (Downloads.tsx), Clean
// up and Recent calls, with its sections listed at the left (the frame and what the tabs share are in ModelsFrame.tsx).
// The shell polls GET …/models/cleanup for the sidebar's count; GET …/models/page, which probes every
// endpoint, is shared by Shell and polled every 30 s; opening Models and Hosts tab changes reload it.
import { ModelLabel, modelName } from "./ModelLabel.tsx";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  del, get, patch, post, put, u,
  type CallInfo, type CleanupItem, type Column, type ColumnState, type ColumnTaskChange, type EndpointChange, type EndpointInfo, type Entry, type GroupInfo, type HostStatus, type ModelsNotice, type ModelsPage,
  type ModelRef, type OfferingInfo, type PlanSignInStarted, type PresetInfo, type Presets, type PresetScope, type Task, type ThreadSummary,
} from "./api.ts";
import { HistoryList } from "./History.tsx";
import { Icon } from "./icons.tsx";
import { Downloads, DownloadText, Size } from "./Downloads.tsx";
import { size } from "./downloads.ts";
import { DownloadImage, ImageModels, ImageReview } from "./ImageModels.tsx";
import { duration, RowMenu } from "./Machines.tsx";
import {
  canEdit, Frame, GB, gb, hostOf, Kind, plural, TASK_WORD, useWords, VoiceDrawer,
  Price, Retires, type Host, type MCtx, type ModelsState,
} from "./ModelsFrame.tsx";
import { go, href, type ModelsPageUnder, type ModelsTab, type Route } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { TextModels } from "./TextModels.tsx";
import { clock, ConfirmDialog, ErrorText, hidden, shortTime, Switch, useAction, useDismiss, useLoad } from "./ui.tsx";

/** The sidebar's Clean up count, from GET …/models/cleanup: a plain read, so the shell can poll it without probing any endpoint. */
export function useCleanupCount(userId: string): { count: number; reload: () => void } {
  const c = useLoad(() => get<CleanupItem[]>(u(userId, "models", "cleanup")), [userId]);
  return { count: c.data?.length ?? 0, reload: c.reload };
}

/**
 * GET …/models/page for the shell (Shell): it probes every endpoint, so the shell reads it once and polls it with
 * everything else in its tick, which keeps the sidebar's status panel live on every page. A reload also refreshes
 * the Clean up count; the Models area reloads on opening and on each tab.
 */
export function useModelsPage(userId: string, reloadCleanup: () => void, showGeneral: boolean, showPrivate: boolean): ModelsState {
  const p = useLoad(() => get<ModelsPage>(u(userId, "models", "page")), [userId, showGeneral, showPrivate]);
  const reload = useCallback(() => { p.reload(); reloadCleanup(); }, [p.reload, reloadCleanup]);
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

/** A text model: not one that draws, embeds, hears or speaks, and not gone. */
export const isTextModel = (m: EndpointInfo["models"][number]) => m.status !== "gone" && !m.image && !m.edit && !m.embedding && !m.transcribe && !m.speak;

/** The text models, counted once per model ID. */
function textModels(eps: EndpointInfo[]): number {
  const ids = new Set<string>();
  for (const ep of eps) for (const m of ep.models) if (isTextModel(m)) ids.add(m.modelId.toLowerCase());
  return ids.size;
}

/** An endpoint's one state: a dot's class and its word, with a duration in mono where there is one. The sidebar's status panel shares these words (SideStatus.tsx). */
export function stateOf(ep: Endpoint, host?: Host): { dot: string; word: string; since?: string } {
  const since = ep.downSince ? duration(Date.now() - Date.parse(ep.downSince)) : undefined;
  if (ep.api === "host" && host && "status" in host) {
    const s = host.status.state;
    if (hostUpdating(host.status)) return { dot: "info", word: host.status.update!.models ? "Moving" : "Updating" };
    if (s === "running") return { dot: "up", word: "Online" };
    if (s === "restarting") return { dot: "info", word: "Restarting" };
    return { dot: "away", word: s === "pausing" ? "Pausing" : "Paused" };
  }
  if (ep.pausedAt) return { dot: "away", word: "Paused" };
  if (unpaired(host)) return { dot: "down", word: "Unpaired" };
  if (ep.signedOut) return { dot: "down", word: "Signed out" };
  if (ep.limitedUntil && Date.parse(ep.limitedUntil) > Date.now()) return { dot: "away", word: "Limit reached until", since: clock(ep.limitedUntil) };
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

/** The host's updater is at work: it pauses, restarts and comes back on Lyrica's release. */
const hostUpdating = (s: HostStatus) => !!s.update && ["requested", "fetching", "draining", "building", "rolling-back"].includes(s.update.state);
/** Why a host's update failed, from the updater's step (host/API.md, "POST /host/v1/update"). */
function updateFailure(step: string | undefined): string {
  if (step === "fetch") return "it couldn't fetch the release; check that its deploy key is added";
  if (step === "drain") return "jobs were still running after 10 minutes, so nothing changed";
  if (step === "probation") return "the new version didn't start, so it went back to the one before";
  if (step?.startsWith("no ")) return "the host's updater isn't set up; run install.sh on the host again";
  if (step?.startsWith("not ")) return "the host refused the release, so nothing changed";
  return "something went wrong on the host, so nothing changed";
}
/** Why moving a host to another models folder failed, from the updater's step. */
function folderFailure(step: string | undefined): string {
  if (step === "not a folder") return "it isn't a folder on the host";
  if (step === "a system folder") return "it's one of the system's folders";
  if (step === "holds the host's own files") return "it holds the host's own files";
  if (step === "someone else can change it") return "another user can write to it or a folder above it";
  if (step === "its lyrica subfolder isn't a folder") return "its lyrica subfolder is a link or a file";
  if (step === "probation") return "the host didn't start on it, so it went back to the folder before";
  if (step === "not on main") return "the host runs a version the updater can't install, so nothing changed";
  return updateFailure(step);
}
/** How a host's models folder changes when Lyrica can't change it: the tooltip on its facts. */
function folderHow(s: HostStatus): string | undefined {
  if (s.update?.changesFolder) return undefined;
  if (s.update?.available) return "Run install.sh on the host again to change it from here.";
  return "Change it on the host: host/install.sh --models <folder>.";
}
/** Update in a host's ⋯: when Lyrica runs a release, the host has an updater and runs another commit. */
const updateOffer = (p: ModelsPage | undefined, s: HostStatus | undefined) =>
  !!p?.release && !!s?.update?.available && !hostUpdating(s) && s.commit !== p.release.commit ? p.release : undefined;

const loadedNothing = (h?: Host) => !!h && "status" in h && h.status.gpus.every((g) => !g.models.length);
const paused = (h?: Host) => !!h && "status" in h && !hostUpdating(h.status) && (h.status.state === "paused" || h.status.state === "pausing");
/** The host has revoked this server: pairing again is the fix. */
const unpaired = (h?: Host) => !!h && "error" in h && !!h.unpaired;

/** The Models area, at one of its tabs. `route` carries history page, search and project filters. */
export function ModelsArea({ ctx: shell, tab = "overview", add, project, pool, route }: { ctx: ShellContext; tab?: ModelsTab; add?: ModelsPageUnder; project?: string; pool?: "general" | "private"; route?: Extract<Route, { page: "models" }> }) {
  const ctx: MCtx = shell;
  const { reload } = ctx.models;
  // Fresh status on opening Models and on each tab: the shared page may be up to 30 s old.
  useEffect(() => { reload(); }, [tab, reload]);
  if (tab === "hosts" && add === "host") return <AddHost ctx={ctx} again={route?.host} />;
  if (tab === "tasks") return <Tasks ctx={ctx} />;
  if (tab === "text") return <TextModels ctx={ctx} />;
  if (tab === "images" && add === "review") return <ImageReview ctx={ctx} />;
  if (tab === "images" && add === "image") return <DownloadImage ctx={ctx} />;
  if (tab === "images") return <ImageModels ctx={ctx} />;
  if (tab === "hosts") return <Hosts ctx={ctx} />;
  if (tab === "downloads" && add === "text") return <DownloadText ctx={ctx} />;
  if (tab === "downloads") return <Downloads ctx={ctx} history={add === "history"} route={route} />;
  if (tab === "cleanup") return <Cleanup ctx={ctx} />;
  if (tab === "calls") return <Calls ctx={ctx} route={route ?? { page: "models", userId: shell.user.id, tab: "calls", project, pool }} />;
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
                    <span className="meta">{ep.state === "up" && !ep.pausedAt ? plural(ep.models.length, "model", "models") : <StateWord ep={ep} />}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="empty">No endpoints yet.</p>}
        </section>
        <section className="section" aria-labelledby="h-models-calls">
          <div className="section-head"><h2 id="h-models-calls" className="eyebrow">History</h2><a href={href({ page: "models", userId, tab: "calls" })}>Show all</a></div>
          <CallsTable ctx={ctx} calls={p.calls} limit={1} />
        </section>
      </>}
    </Frame>
  );
}

/** One line when a host is paused or an endpoint is stale, with what fixes it. */
function Banner({ ctx, p }: { ctx: MCtx; p: ModelsPage }) {
  const [run, busy, error] = useAction();
  const host = p.endpoints.find((ep) => ep.pausedAt || (ep.api === "host" && paused(hostOf(p, ep.id))));
  if (host) {
    return (
      <div className="banner" role="status">
        <span className="dot away" aria-hidden="true" />
        <span><b>{host.name} is paused.</b> Its tasks use a fallback until you resume it.</span>
        {canEdit(ctx, host) && <button type="button" className="sm" disabled={busy} onClick={() => void run(() => host.api === "host" ? control(ctx, host.id, "resume") : pauseEndpoint(ctx, host.id, false))}>Resume</button>}
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

/** Pauses or resumes a plain endpoint or plan: fallbacks skip it while it's paused. */
async function pauseEndpoint(ctx: MCtx, endpointId: string, pause: boolean) {
  await patch(u(ctx.user.id, "endpoints", endpointId), { paused: pause });
  ctx.models.reload();
}

/** A column's effective table: the followed preset's, or its own Custom one. */
const columnEntries = (col: ColumnState): Partial<Record<Task, Entry>> => col.preset?.entries ?? col.entries;
/** A column's scope: its preset's, or the column's kind when Custom. */
const columnScope = (col: ColumnState): PresetScope => col.preset?.scope ?? col.column;

/** A column's chat list's first model, following Same as; a group stays as its ID for the caller to expand. */
type FirstChat = { groupId: string } | { model: string; endpoint: string; kind: "local" | "cloud" } | undefined;
function firstChat(p: ModelsPage, col: ColumnState): FirstChat {
  const entries = columnEntries(col);
  let entry = entries.chat;
  for (let i = 0; entry && !Array.isArray(entry) && i < 5; i++) entry = entries[entry.same];
  const ref = Array.isArray(entry) ? entry[0] : undefined;
  if (!ref) return undefined;
  if ("groupId" in ref) return { groupId: ref.groupId };
  for (const ep of p.endpoints) {
    const m = ep.models.find((o) => o.id === ref.offeringId);
    if (m) return { model: modelName(m), endpoint: ep.name, kind: ep.kind };
  }
  return undefined;
}

export function BackendCard({ ctx }: { ctx: ShellContext }) {
  const models = ctx.models;
  const p = models.page;
  const userId = ctx.user.id;
  const general = p && firstChat(p, p.presets.columns.general);
  const local = p && firstChat(p, p.presets.columns.private);
  const needGroups = !!(general && "groupId" in general) || !!(local && "groupId" in local);
  const groups = useLoad(() => (needGroups ? get<GroupInfo[]>(u(userId, "groups")) : Promise.resolve([])), [userId, needGroups]);
  const line = (c: FirstChat, col: ColumnState) => {
    if (c && "groupId" in c) {
      const groupId = c.groupId;
      const group = groups.data?.find((g) => g.id === groupId);
      c = group?.members.flatMap((id) => (p?.endpoints ?? []).flatMap((ep) => {
        const m = ep.models.find((m) => m.id === id);
        return m ? [{ model: modelName(m), endpoint: ep.name, kind: ep.kind }] : [];
      }))[0];
    }
    return <>{c && "model" in c ? <><span className={`badge kind ${c.kind}`}>{c.kind}</span> <ModelLabel model={c.model} endpoint={c.endpoint} /></> : "No model"} · {col.preset?.name ?? "Custom"}</>;
  };
  return (
    <section className="card" aria-labelledby="h-home-backend">
      <div className="section-head"><h2 id="h-home-backend">Backend</h2><a href={href({ page: "models", userId })}>Models</a></div>
      <ErrorText error={models.error || groups.error} />
      {p && <dl className="facts">
        <dt>General threads</dt><dd>{line(general, p.presets.columns.general)}</dd>
        <dt>Private threads</dt><dd>{line(local, p.presets.columns.private)}</dd>
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
  const up = p.endpoints.filter((e) => e.state === "up" && !e.pausedAt);
  const down = p.endpoints.filter((e) => e.state !== "up" || e.pausedAt);
  const first = down[0];
  const reach = !first ? { dot: "up", word: "All reachable" }
    : first.pausedAt || paused(hostOf(p, first.id)) ? { dot: "away", word: `${first.name} paused` }
    : unpaired(hostOf(p, first.id)) ? { dot: "down", word: `${first.name} unpaired` } : { dot: "down", word: `${first.name} unreachable` };
  const generalCol = p.presets.columns.general, privateCol = p.presets.columns.private;
  const general = firstChat(p, generalCol);
  const local = firstChat(p, privateCol);
  const needGroups = !!(general && "groupId" in general) || !!(local && "groupId" in local);
  const groups = useLoad(() => (needGroups ? get<GroupInfo[]>(u(userId, "groups")) : Promise.resolve([])), [userId, needGroups]);
  const line = (c: FirstChat) => !c ? "No model"
    : "groupId" in c ? groups.data?.find((g) => g.id === c.groupId)?.name ?? "A group"
    : <ModelLabel model={c.model} endpoint={c.endpoint} />;
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
        <span className="cap">general threads · {generalCol.preset?.name ?? "Custom"}</span>
        <span className="line" title="Private threads">{line(local)}</span>
        <span className="cap">private threads · {privateCol.preset?.name ?? "Custom"}</span>
      </a>
      <a className="tile" href={href({ page: "models", userId, tab: "cleanup" })} data-tile="cleanup" title={cleanup ? "To decide" : "Nothing to clean up"}>
        <span className="cap">Clean up</span>
        <span className="big num">{cleanup}<small>{cleanup === 1 ? "item" : "items"}</small></span>
      </a>
    </div>
  );
}

/**
 * Each GPU's models as bar segments: pinned, vLLM's share on a vLLM GPU, or loaded on demand. A model's share is what
 * it took when it loaded (or an estimate), and one that holds memory only during a job (an image recipe) can claim more
 * than the GPU now uses: the segments shrink to what it reports, so the bar never shows more than the numbers beside it.
 */
function segments(g: Gpu) {
  const segs = g.models.filter((m) => m.vram).map((m) => ({ id: m.id, kind: m.pinned ? "pinned" : g.role === "vllm" ? "vllm" : "loaded", bytes: m.vram! }));
  const claimed = segs.reduce((n, s) => n + s.bytes, 0);
  const scale = claimed > g.vram.used ? g.vram.used / claimed : 1;
  return segs.map((s) => ({ ...s, bytes: s.bytes * scale }));
}

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
      <button type="button" className="sm" disabled={busy || empty || host.status.state === "restarting" || hostUpdating(host.status)} title={empty ? "Nothing is loaded" : undefined}
        onClick={() => void run(() => control(ctx, ep.id, isPaused ? "resume" : "pause"))}>{isPaused ? "Resume" : "Pause"}</button>
      {error && <ErrorText error={error} />}
    </>
  );
}

/** Pause or Resume for a plain endpoint or plan. */
function EndpointPauseButton({ ctx, ep }: { ctx: MCtx; ep: Endpoint }) {
  const [run, busy, error] = useAction();
  return (
    <>
      <button type="button" className="sm" disabled={busy} onClick={() => void run(() => pauseEndpoint(ctx, ep.id, !ep.pausedAt))}>{ep.pausedAt ? "Resume" : "Pause"}</button>
      {error && <ErrorText error={error} />}
    </>
  );
}

/** Dashboard: the host's own page, in a new tab, so it looks like a link. The tab opens at once, so the browser doesn't block it. */
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
  return <>{<button type="button" className="link sm" disabled={busy} onClick={open}>Dashboard</button>}{error && <ErrorText error={error} />}</>;
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
        <span className="name">{ep.name}</span>
        <span className="meta">{s.word !== "Online" ? <StateWord ep={ep} host={host} /> : loaded.length ? [...new Set(loaded)].join(", ") : "nothing loaded"}</span>
      </div>
      <div className="main-col usage">
        {gpus.length > 0 && <><Bar gpus={gpus} /><span className="cap num">{gb(used)} / {gbTotal(total)} GB</span></>}
      </div>
      <div className="actions">
        {canEdit(ctx, ep) && <PauseButton ctx={ctx} ep={ep} host={host} />}
        {canEdit(ctx, ep) && <DashboardButton ctx={ctx} ep={ep} />}
      </div>
    </li>
  );
}

/* ---- Tasks ---- */

/** A preset's or column's table: task to entry. */
type Table = Partial<Record<Task, Entry>>;

/** The table's rows, under their eyebrows, each with a hint that is its name's tooltip (docs/ux.md §4). */
const TASK_ROWS: { group: string; tasks: { task: Task; hint: string }[] }[] = [
  { group: "Conversation", tasks: [
    { task: "chat", hint: "The main conversation" },
    { task: "code", hint: "Code changes: edit, test, fix" },
    { task: "subagent.cheap", hint: "Searching, reading, checking" },
    { task: "subagent.strong", hint: "Writing and judgment" },
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
    default: return !m.embedding && !m.image && !m.edit && !m.transcribe && !m.speak && !m.recipe && !companion(m.modelId);
  }
};
/** A vision projector or MTP draft a host listed before it knew them as companions (host/API.md): never a model to pick. */
const companion = (id: string) => /(^|\/)(mtp\/|mtp[-_.][^/]*$|[^/]*mmproj[^/]*$)/i.test(id);

/** A task's entry as lyricad reads it: a text task with none follows Chat. */
function entryOf(table: Table, task: Task): Entry | undefined {
  return table[task] ?? (task !== "chat" && capability(task) === "text" ? { same: "chat" } : undefined);
}
/** The list that decides a task, after Same as. */
function listOf(table: Table, task: Task, depth = 0): ModelRef[] {
  const e = entryOf(table, task);
  if (Array.isArray(e)) return e;
  return e && depth < 2 ? listOf(table, e.same, depth + 1) : [];
}

type Copy = { m: OfferingInfo; ep: Endpoint };
function copies(p: ModelsPage): Map<string, Copy> {
  const out = new Map<string, Copy>();
  for (const ep of p.endpoints) for (const m of ep.models) out.set(m.id, { m, ep });
  return out;
}
const answers = (p: ModelsPage, c: Copy) => c.ep.state === "up" && !c.ep.stale && c.m.status !== "gone" && !c.ep.pausedAt && !paused(hostOf(p, c.ep.id));

/** A list entry's models: an offering, or a group's members. A private table's groups hold only local members, so none are skipped here. */
function membersOf(ref: ModelRef, all: Map<string, Copy>, groups: GroupInfo[]): Copy[] {
  const ids = "offeringId" in ref ? [ref.offeringId] : groups.find((g) => g.id === ref.groupId)?.members ?? [];
  return ids.flatMap((id) => { const c = all.get(id); return c ? [c] : []; });
}
const refUp = (p: ModelsPage, ms: Copy[]) => ms.some((c) => answers(p, c));
const refKind = (ms: Copy[]) => ms[0]?.ep.kind;
const refKey = (r: ModelRef) => ("offeringId" in r ? r.offeringId : `g:${r.groupId}`);

function RefLabel({ refx, all, groups }: { refx: ModelRef; all: Map<string, Copy>; groups: GroupInfo[] }) {
  if ("groupId" in refx) return <>{groups.find((g) => g.id === refx.groupId)?.name ?? "A group"}</>;
  const c = all.get(refx.offeringId);
  return c ? <><ModelLabel model={modelName(c.m)} endpoint={c.ep.name} />{c.m.status === "gone" && <span className="pill bad">gone</span>}</> : <>A model that no longer exists</>;
}

/** "A", "A and B", "A, B and C". */
const andList = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "");
/** Context windows as "128k". */
const contextWord = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

function Tasks({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const p = ctx.models.page;
  const groups = useLoad(() => get<GroupInfo[]>(u(userId, "groups")), [userId]);
  const [editing, setEditing] = useState<{ column: Column; task: Task }>();
  const [presetDrawer, setPresetDrawer] = useState<{ column: Column; mode: "new" | "saveAs" | "edit"; preset?: PresetInfo }>();
  const close = useCallback(() => setEditing(undefined), []);
  const closePreset = useCallback(() => setPresetDrawer(undefined), []);
  const [run, , error] = useAction();
  const all = p ? copies(p) : new Map<string, Copy>();
  const gs = groups.data ?? [];
  const apply = (next: Presets) => { const cur = ctx.models.page; if (cur) ctx.models.set({ ...cur, presets: next }); };
  const cell = (column: Column, task: Task) => {
    // Dictation is always local (core/models voiceContext), so the General column has no cell for it.
    if (task === "speech.transcribe" && column === "general") return <td />;
    const col = p!.presets.columns[column];
    const table = columnEntries(col);
    const mixed = columnScope(col) === "general";
    const entry = entryOf(table, task);
    const list = listOf(table, task);
    const first = list[0];
    const ups = list.map((r) => refUp(p!, membersOf(r, all, gs)));
    const dot = !first ? "down" : ups[0] ? "up" : ups.some(Boolean) ? "away" : "down";
    const kind = first && mixed ? refKind(membersOf(first, all, gs)) : undefined;
    const on = editing?.column === column && editing.task === task;
    return (
      <td>
        <button type="button" className="cell" data-col={column === "private" ? "Private threads" : "General threads"} aria-pressed={on}
          onClick={() => setEditing(on ? undefined : { column, task })}>
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
  const head = (column: Column) => (
    <ColumnHead ctx={ctx} column={column} col={p!.presets.columns[column]} onApply={apply}
      onNew={() => setPresetDrawer({ column, mode: "new" })} onSaveAs={() => setPresetDrawer({ column, mode: "saveAs" })}
      onEdit={(preset) => setPresetDrawer({ column, mode: "edit", preset })} />
  );
  return (
    <Frame ctx={ctx} tab="tasks" title="Tasks" actions={p && (
      <Switch label="Free models only" hint="Every list skips a model that costs money. A model with no known price, such as one from an API key, isn't skipped."
        checked={p.presets.freeOnly} onChange={(freeOnly) => run(async () => apply(await patch<Presets>(u(userId, "presets"), { freeOnly })))} />
    )}>
      <ErrorText error={ctx.models.error || groups.error || error} />
      {p && (
        <div className="tablewrap tasks">
          <table className="ttable">
            <thead>
              <tr>
                <th>Task</th>
                <th>{head("private")}</th>
                <th>{head("general")}</th>
              </tr>
            </thead>
            <tbody>
              {TASK_ROWS.map((g) => (
                <Fragment key={g.group}>
                  <tr className="tgroup"><td colSpan={3}><span className="eyebrow">{g.group}</span></td></tr>
                  {g.tasks.map(({ task, hint }) => (
                    <tr key={task} data-task={task}>
                      <td className="task"><b title={hint}>{TASK_WORD[task]}</b></td>
                      {cell("private", task)}
                      {cell("general", task)}
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
          <TaskDrawer key={`${editing.column}:${editing.task}`} ctx={ctx} p={p} all={all} groups={gs} column={editing.column} task={editing.task} onClose={close} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={close} />
        </>
      )}
      {presetDrawer && p && (
        <>
          <PresetDrawer key={`${presetDrawer.mode}:${presetDrawer.column}:${presetDrawer.preset?.id ?? ""}`} ctx={ctx} p={p} all={all} groups={gs}
            column={presetDrawer.column} mode={presetDrawer.mode} preset={presetDrawer.preset} onClose={closePreset} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={closePreset} />
        </>
      )}
    </Frame>
  );
}

/** A column head: its name, then the Preset menu that shows and switches its preset. */
function ColumnHead({ ctx, column, col, onNew, onSaveAs, onEdit, onApply }: {
  ctx: MCtx; column: Column; col: ColumnState;
  onNew: () => void; onSaveAs: () => void; onEdit: (p: PresetInfo) => void; onApply: (next: Presets) => void;
}) {
  return (
    <>
      <b title={column === "private" ? "local models only" : "local and cloud, falls back across"}>{column === "private" ? "Private threads" : "General threads"}</b>
      <PresetMenu ctx={ctx} column={column} col={col} onNew={onNew} onSaveAs={onSaveAs} onEdit={onEdit} onApply={onApply} />
    </>
  );
}

/** The column's Preset menu: search, the presets it can use, Save to/Save as while Custom, New preset last (docs/ux.md §6). */
function PresetMenu({ ctx, column, col, onNew, onSaveAs, onEdit, onApply }: {
  ctx: MCtx; column: Column; col: ColumnState;
  onNew: () => void; onSaveAs: () => void; onEdit: (p: PresetInfo) => void; onApply: (next: Presets) => void;
}) {
  const userId = ctx.user.id;
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number }>();
  const [q, setQ] = useState("");
  const [run, busy, error] = useAction();
  const headRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const presets = ctx.models.page?.presets.presets ?? [];
  const current = col.preset?.id;
  const custom = !col.preset;
  const close = useCallback(() => { setOpen(false); setQ(""); buttonRef.current?.focus(); }, []);
  useDismiss(headRef, open, close);
  useEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (el) {
      if (innerWidth < 760) {
        el.style.left = "16px";
        el.style.right = "16px";
      } else {
        el.style.left = `${Math.max(8, Math.min(at!.x, innerWidth - el.offsetWidth - 8))}px`;
        el.style.right = "";
      }
      el.style.top = `${Math.max(8, Math.min(at!.y, innerHeight - el.offsetHeight - 8))}px`;
    }
    searchRef.current?.focus();
  }, [open, at]);
  const toggle = () => {
    if (open) { close(); return; }
    const r = buttonRef.current!.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 4 });
    setOpen(true);
  };
  const needle = q.trim().toLowerCase();
  const matches = (x: PresetInfo) => !needle || x.name.toLowerCase().includes(needle);
  const generalList = column === "general" ? presets.filter((x) => x.scope === "general" && matches(x)) : [];
  const privateList = presets.filter((x) => x.scope === "private" && matches(x));
  const shown = column === "general" ? [...generalList, ...privateList] : privateList;
  const pick = (id: string) => run(async () => { onApply(await put<Presets>(u(userId, "columns", column), { preset: id })); close(); });
  const saveTo = () => run(async () => {
    if (!col.fromPreset) return;
    onApply(await post<Presets>(u(userId, "columns", column, "save"), { preset: col.fromPreset.id }));
    close();
  });
  const row = (x: PresetInfo) => (
    <div key={x.id} className="preset-row">
      <button type="button" className="preset-item" data-item data-preset={x.id} data-user={x.builtin ? undefined : "true"}
        aria-pressed={current === x.id} onClick={() => void pick(x.id)}>
        <span className="tick">{current === x.id ? <Icon name="check" /> : null}</span>
        <span className="preset-name">{x.name}</span>
      </button>
      {!x.builtin && (
        <button type="button" className="icon sm" aria-label={`Edit ${x.name}`} title={`Edit ${x.name} (E)`} onClick={() => { onEdit(x); close(); }}>
          <Icon name="edit" />
        </button>
      )}
    </div>
  );
  const onKey = (e: React.KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])];
      if (!items.length) return;
      const atItem = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
        : atItem < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1)
        : e.key === "ArrowDown" ? (atItem + 1) % items.length : (atItem - 1 + items.length) % items.length;
      e.preventDefault();
      items[next]!.focus();
      return;
    }
    if (e.key === "e" || e.key === "E") {
      const el = document.activeElement as HTMLElement | null;
      if (el?.dataset.user === "true") {
        const x = presets.find((p) => p.id === el.dataset.preset);
        if (x) { e.preventDefault(); onEdit(x); close(); }
      }
    }
  };
  return (
    <span className="preset-head" ref={headRef}>
      <button type="button" ref={buttonRef} className="preset-button" aria-haspopup="dialog" aria-expanded={open} title={col.preset?.name ?? "Custom"} onClick={toggle}>
        <span className="preset-name">{col.preset?.name ?? "Custom"}</span>
        <Icon name="down" className="preset-chev" />
      </button>
      {open && at && (
        <div ref={menuRef} className="preset-menu" role="dialog" aria-label="Preset" onKeyDown={onKey} style={{ left: at.x, top: at.y }}>
          <input ref={searchRef} type="search" aria-label="Search presets" placeholder="Search presets" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="preset-list">
            {column === "general" && generalList.length > 0 && <div className="eyebrow">General</div>}
            {generalList.map(row)}
            {column === "general" && privateList.length > 0 && <div className="eyebrow">Private</div>}
            {privateList.map(row)}
            {shown.length === 0 && <p className="muted preset-none">Nothing matches</p>}
          </div>
          {custom && col.fromPreset && <button type="button" data-item className="preset-action" disabled={busy} onClick={() => void saveTo()}>Save to {col.fromPreset.name}</button>}
          {custom && <button type="button" data-item className="preset-action" onClick={() => { close(); onSaveAs(); }}>Save as preset…</button>}
          <button type="button" data-item className="preset-action" onClick={() => { close(); onNew(); }}>New preset…</button>
          <ErrorText error={error} />
        </div>
      )}
    </span>
  );
}

/** Edit a task: its own list or Same as another task, saved at once; Add… opens the picker inside the drawer. */
function TaskDrawer({ ctx, p, all, groups, column, task, onClose }: {
  ctx: MCtx; p: ModelsPage; all: Map<string, Copy>; groups: GroupInfo[]; column: Column; task: Task; onClose: () => void;
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
  const col = p.presets.columns[column];
  const table = columnEntries(col);
  const mixed = columnScope(col) === "general";
  const entry = entryOf(table, task);
  const own = !entry || Array.isArray(entry);
  const list = Array.isArray(entry) ? entry : [];
  const name = TASK_WORD[task];
  const followers = TASK_ORDER.filter((t) => { const e = table[t]; return !!e && !Array.isArray(e) && e.same === task; });
  // Same as: a task of the same kind that doesn't itself follow another. Chat can't follow a task that follows Chat.
  const options = TASK_ORDER.filter((t) => t !== task && capability(t) === capability(task) && (
    (!own && entry.same === t) || (table[t] ? Array.isArray(table[t]) : task !== "chat" && capability(t) === "text")));
  const sel = !own ? entry.same : target && options.includes(target) ? target : options[0];
  const save = (change: ColumnTaskChange) => run(async () => {
    const next = await put<Presets>(u(userId, "columns", column, task), change);
    const cur = ctx.models.page;
    if (cur) ctx.models.set({ ...cur, presets: next });
  });
  const saveList = (next: ModelRef[]) => save({ models: next });
  const move = (i: number, by: number) => { const next = [...list]; [next[i], next[i + by]] = [next[i + by]!, next[i]!]; void saveList(next); };
  const add = (r: ModelRef) => { setPicking(false); setQ(""); void saveList([...list, r]); };
  const about = `${column === "private" ? "Private threads" : "General threads"} column · ${col.preset?.name ?? "Custom"}`;
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
              <label><input type="radio" name="follow" checked={own} disabled={busy} onChange={() => void saveList(listOf(table, task))} /> Its own list</label>
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
                  const ms = membersOf(r, all, groups);
                  const kind = refKind(ms);
                  const cross = mixed && prevKind && kind && kind !== prevKind;
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
                            {mixed && kind && <Kind kind={kind} />}
                            {group ? <><b>{group.name}</b><span className="cap">group of <span className="num">{ms.length}</span></span></> : <span><RefLabel refx={r} all={all} groups={groups} /></span>}
                          </div>
                          {group && (
                            <div className="members">
                              {ms.map((c) => (
                                <span key={c.m.id}>
                                  <span className={`dot${answers(p, c) ? " up" : " away"}`} aria-hidden="true" /> <ModelLabel model={modelName(c.m)} endpoint={c.ep.name} />
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="octl">
                          <button type="button" className="icon sm" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                          <button type="button" className="icon sm" aria-label="Move down" disabled={busy || i === list.length - 1} onClick={() => move(i, 1)}><Icon name="arrow-down" /></button>
                          <button type="button" className="icon sm" aria-label="Remove" disabled={busy || (task === "chat" && list.length === 1)} onClick={() => void saveList(list.filter((_, j) => j !== i))}><Icon name="close" /></button>
                        </div>
                      </li>
                    </Fragment>
                  );
                })}
              </ol>
            )}
            {picking
              ? <Picker p={p} groups={groups} column={column} task={task} list={list} q={q} setQ={setQ} busy={busy} onAdd={add} onCancel={() => { setPicking(false); setQ(""); }} />
              : <div className="actions"><button type="button" disabled={busy} onClick={() => setPicking(true)}>Add…</button></div>}
          </>
        )}
      </div>
    </aside>
  );
}

/** Add…: suitable models of the column's kinds, by endpoint, with a search; groups with a suitable member as chips. */
function Picker({ p, groups, column, task, list, q, setQ, busy, onAdd, onCancel }: {
  p: ModelsPage; groups: GroupInfo[]; column: Column; task: Task; list: ModelRef[]; q: string; setQ: (q: string) => void;
  busy: boolean; onAdd: (r: ModelRef) => void; onCancel: () => void;
}) {
  const kindOk = (k: "local" | "cloud") => column === "general" || k === "local";
  const taken = new Set(list.map(refKey));
  const needle = q.trim().toLowerCase();
  const eps = p.endpoints.filter((ep) => kindOk(ep.kind)).map((ep) => ({
    ep,
    models: ep.models.filter((m) => suits(task, m) && !taken.has(m.id) && (!needle || `${modelName(m)} ${m.modelId} ${ep.name}`.toLowerCase().includes(needle))),
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
                  <span className="name"><ModelLabel model={modelName(m)} endpoint={ep.name} /></span>
                  <span className="meta muted">
                    {[
                      m.contextWindow ? <><span className="num">{contextWord(m.contextWindow)}</span> context</> : null,
                      m.tools ? "tools" : null, m.vision ? "vision" : null, m.reasoning?.length ? "thinking" : null,
                      m.price ? <Price m={m} /> : null, m.retiresAt ? <Retires m={m} /> : null,
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

/** New preset, Save as preset, or a preset's Edit: Name, then (creating) the column's table it will copy, then Save; Edit adds Delete preset…. */
function PresetDrawer({ ctx, p, all, groups, column, mode, preset, onClose }: {
  ctx: MCtx; p: ModelsPage; all: Map<string, Copy>; groups: GroupInfo[]; column: Column; mode: "new" | "saveAs" | "edit"; preset?: PresetInfo; onClose: () => void;
}) {
  const userId = ctx.user.id;
  const [name, setName] = useState(preset?.name ?? "");
  const [deleting, setDeleting] = useState(false);
  const [run, busy, error] = useAction();
  const ref = useRef<HTMLElement>(null);
  const col = p.presets.columns[column];
  const table = columnEntries(col);
  const trimmed = name.trim();
  const taken = p.presets.presets.some((x) => x.id !== preset?.id && x.name.toLowerCase() === trimmed.toLowerCase());
  const reserved = trimmed.toLowerCase() === "custom";
  const invalid = trimmed.length < 1 || trimmed.length > 40 || taken || reserved;
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const apply = (next: Presets) => { const cur = ctx.models.page; if (cur) ctx.models.set({ ...cur, presets: next }); };
  const save = () => run(async () => {
    apply(mode === "edit"
      ? await patch<Presets>(u(userId, "presets", preset!.id), { name: trimmed })
      : mode === "new"
        ? await post<Presets>(u(userId, "presets"), { name: trimmed, column })
        : await post<Presets>(u(userId, "columns", column, "save"), { name: trimmed }));
    onClose();
  });
  const remove = () => run(async () => {
    apply(await del<Presets>(u(userId, "presets", preset!.id)));
    onClose();
  });
  const title = mode === "edit" ? preset!.name : mode === "new" ? "New preset" : "Save as preset";
  const scope = mode === "edit" ? preset!.scope : column;
  const fact = scope === "private" ? "Private preset · local models only" : "General preset · local and cloud";
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={title}>
      <div className="drawer-head">
        <div>
          <h2>{title}</h2>
          <p className="cap">{fact}</p>
        </div>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (!invalid) void save(); }}>
        <label className="field"><span>Name</span>
          <input value={name} maxLength={40} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        {taken && <p className="error" role="alert">A preset called {trimmed} already exists.</p>}
        {reserved && <p className="error" role="alert">A preset can't be called Custom.</p>}
        {mode !== "edit" && <PresetSummary entries={table} all={all} groups={groups} />}
        <ErrorText error={error} />
        <div className="row drawer-foot">
          {mode === "edit" && <button type="button" className="danger" disabled={busy} onClick={() => setDeleting(true)}>Delete preset…</button>}
          <button type="submit" className="primary" disabled={busy || invalid}>Save</button>
        </div>
      </form>
      {deleting && (
        <ConfirmDialog title={`Delete ${preset!.name}?`}
          sentence="Each column that followed it becomes Custom with the same lists, and each thread that chose it uses its column again."
          confirm="Delete" danger onCancel={() => setDeleting(false)} onConfirm={() => { setDeleting(false); void remove(); }} />
      )}
    </aside>
  );
}

/** A read-only summary of the column's table a new preset will copy: task, first model, "+N fallbacks". */
function PresetSummary({ entries, all, groups }: { entries: Table; all: Map<string, Copy>; groups: GroupInfo[] }) {
  const rows = TASK_ORDER.flatMap((task) => {
    const list = listOf(entries, task);
    if (!list.length) return [];
    return [{ task, node: <RefLabel refx={list[0]!} all={all} groups={groups} />, extra: list.length > 1 ? `+${list.length - 1} ${list.length > 2 ? "fallbacks" : "fallback"}` : "" }];
  });
  return (
    <ul className="preset-summary" aria-label="This column's table">
      {rows.map((r) => (
        <li key={r.task}><b>{TASK_WORD[r.task]}</b><span className="muted">{r.node}{r.extra && <> · <span className="num">{r.extra}</span></>}</span></li>
      ))}
    </ul>
  );
}

/* ---- Hosts and endpoints ---- */

function Hosts({ ctx }: { ctx: MCtx }) {
  const p = ctx.models.page;
  const eps = p?.endpoints ?? [];
  const hosts = eps.filter((e) => e.api === "host"), plain = eps.filter((e) => e.api !== "host");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Endpoint>();
  const [editingHost, setEditingHost] = useState<Endpoint>();
  const [signIn, setSignIn] = useState(false);
  const [voice, setVoice] = useState<OfferingInfo>();
  const close = useCallback(() => { setAdding(false); setEditing(undefined); setEditingHost(undefined); setSignIn(false); }, []);
  const closeVoice = useCallback(() => setVoice(undefined), []);
  const [run, , error] = useAction();
  const facts = p && <>{plural(hosts.length, "paired host", "paired hosts")} · {plural(plain.length, "plain endpoint", "plain endpoints")}</>;
  const actions = <>
    {p && <Switch label="Read model lists daily" hint={`Once a day Lyrica reads the model list of ${ctx.user.admin ? "every endpoint, shared ones included" : "each of your own endpoints"}, so new models appear and dropped ones go to Clean up. No model is called.`}
      checked={p.presets.readDaily} onChange={(readDaily) => run(async () => { const next = await patch<Presets>(u(ctx.user.id, "presets"), { readDaily }); const cur = ctx.models.page; if (cur) ctx.models.set({ ...cur, presets: next }); })} />}
    <button type="button" onClick={() => setAdding(true)}>Add endpoint</button>
    <button type="button" className="primary" onClick={() => go({ page: "models", userId: ctx.user.id, tab: "hosts", add: "host" })}>Add model host</button>
  </>;
  return (
    <Frame ctx={ctx} tab="hosts" title="Hosts and endpoints" facts={facts} actions={actions}>
      <ErrorText error={ctx.models.error || error} />
      {p && hosts.length > 0 && (
        <section className="section" aria-labelledby="h-model-hosts">
          <div className="section-head">
            <h2 id="h-model-hosts">Model hosts</h2>
            <span className="cap legend"><span><i className="seg-pinned" />Pinned</span><span><i className="seg-loaded" />Loaded on demand</span><span><i className="seg-vllm" />vLLM share</span></span>
          </div>
          {hosts.map((ep) => <HostCard key={ep.id} ctx={ctx} ep={ep} host={hostOf(p, ep.id)} others={eps} onVoice={setVoice} onEdit={() => setEditingHost(ep)} />)}
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
      {editingHost && p && (
        <>
          <HostDrawer key={editingHost.id} ctx={ctx} ep={editingHost} host={hostOf(p, editingHost.id)} onClose={close} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={close} />
        </>
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
function ModelList({ ctx, ep, onVoice }: { ctx: MCtx; ep: EndpointInfo; onVoice: (m: OfferingInfo) => void }) {
  if (!ep.models.length) return <p className="muted small wide">No models yet.</p>;
  return (
    <ul className="model-list wide" aria-label={`${ep.name} models`}>
      {ep.models.map((m) => (
        <li key={m.id} data-offering={m.id}>
          <ModelLabel model={m.modelId} endpoint={ep.name} raw />
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

/**
 * A paired model host: its name, state and "update available"; Pause or Resume (Pair again… once it has revoked this
 * server), Edit and ⋯; one facts line (address, version, models folder, free space, who can use it, its models,
 * Dashboard); a failed update or move; each GPU.
 */
function HostCard({ ctx, ep, host, others, onVoice, onEdit }: { ctx: MCtx; ep: Endpoint; host?: Host; others: Endpoint[]; onVoice: (m: OfferingInfo) => void; onEdit: () => void }) {
  const userId = ctx.user.id;
  const editable = canEdit(ctx, ep);
  const [open, setOpen] = useState(false);
  const [run, , error] = useAction();
  const actions = useEndpointActions(ctx, ep, others);
  const status = host && "status" in host ? host.status : undefined;
  const revoked = unpaired(host);
  const id = `h-host-${ep.id}`;
  const pairAgain = () => go({ page: "models", userId, tab: "hosts", add: "host", host: ep.id });
  const offer = updateOffer(ctx.models.page, status);
  const update = () => run(async () => {
    const next = await post<HostStatus>(u(userId, "hosts", ep.id, "update"));
    const p = ctx.models.page;
    if (p) ctx.models.set({ ...p, hosts: p.hosts.map((h) => (h.endpointId === ep.id ? { endpointId: ep.id, status: next } : h)) });
  });
  const menu = revoked ? actions.items : [...(offer ? [{ label: "Update", onPick: () => void update() }] : []), actions.items[0]!, { label: "Pair again…", onPick: pairAgain }, ...actions.items.slice(1)];
  const failed = status?.update?.state === "failed" ? status.update : undefined;
  const addresses = ep.addresses ?? [];
  const why = status?.update && !status.update.available ? status.update.reason : undefined;
  return (
    <article className="card host" data-endpoint={ep.id} aria-labelledby={id}>
      <div className="host-top">
        <h3 id={id} title={`ID ${ep.id}`}>{ep.name}</h3><StateWord ep={ep} host={host} />
        {editable && offer && <span className="pill info" title={`Lyrica runs ${offer.tag}; this host runs ${status!.version}`}>update available</span>}
        <span className="spacer" />
        {editable && (
          <div className="actions">
            {revoked
              ? <button type="button" className="sm" onClick={pairAgain}>Pair again…</button>
              : <PauseButton ctx={ctx} ep={ep} host={host} />}
            <button type="button" className="sm" onClick={onEdit}>Edit</button>
            <RowMenu label={`Actions for ${ep.name}`} items={menu} />
          </div>
        )}
      </div>
      <div className="host-facts">
        {addresses.length > 0 && <><code title={addresses.join("\n")}>{addresses[0]}</code>
          {addresses.length > 1 && <span title={addresses.slice(1).join("\n")}>+<span className="num">{addresses.length - 1}</span></span>}</>}
        {status && <><span className="sep">·</span><span title={why}>version</span><code>{status.version}</code>{why && <span className="sr-only">. {why}</span>}</>}
        {editable && status && <><span className="sep">·</span><span title={folderHow(status)}>models folder</span><code>{status.modelsFolder.path}</code>
          {folderHow(status) && <span className="sr-only">. {folderHow(status)}</span>}
          <span className="sep">·</span><span><Size text={size(status.modelsFolder.free)} /> free</span></>}
        <span className="sep">·</span><span>{ep.shared ? "shared" : "only you"}</span>
        <span className="sep">·</span><button type="button" className="link sm" aria-expanded={open} onClick={() => setOpen(!open)}>{plural(ep.models.length, "model", "models")}</button>
        {editable && <><span className="sep">·</span><DashboardButton ctx={ctx} ep={ep} /></>}
      </div>
      <ErrorText error={error} />
      {failed && (failed.models
        ? <p className="warn-text" role="note">Moving to <code>{failed.models}</code> failed: {folderFailure(failed.error)}.</p>
        : <p className="warn-text" role="note">The update to <code>{failed.tag}</code> failed: {updateFailure(failed.error)}.</p>)}
      {actions.forms}
      {status?.gpus.map((g) => <GpuBlock key={g.index} g={g} />)}
      {open && <ModelList ctx={ctx} ep={ep} onVoice={onVoice} />}
    </article>
  );
}

/** Edit on a host card: its name, addresses and models folder, with one Save. A new folder is asked about first, since the host restarts on it. */
function HostDrawer({ ctx, ep, host, onClose }: { ctx: MCtx; ep: Endpoint; host?: Host; onClose: () => void }) {
  const userId = ctx.user.id;
  const status = host && "status" in host ? host.status : undefined;
  const [name, setName] = useState(ep.name);
  const [addresses, setAddresses] = useState((ep.addresses ?? []).join("\n"));
  const [folder, setFolder] = useState(status?.modelsFolder.path ?? "");
  const [asking, setAsking] = useState(false);
  const [run, busy, error] = useAction();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && !asking && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose, asking]);
  const list = addresses.split(/[\s,]+/).filter(Boolean);
  const renamed = name.trim() !== ep.name;
  const readdressed = list.join(" ") !== (ep.addresses ?? []).join(" ");
  const changesFolder = !!status?.update?.changesFolder && !hostUpdating(status);
  const moved = !!status && changesFolder && folder.trim() !== status.modelsFolder.path;
  const ready = !!name.trim() && list.length > 0 && (!moved || folder.trim().startsWith("/")) && (renamed || readdressed || moved);
  const save = () => run(async () => {
    if (renamed) await patch(u(userId, "endpoints", ep.id), { name: name.trim() } satisfies EndpointChange);
    if (readdressed) await put(u(userId, "hosts", ep.id, "addresses"), { addresses: list });
    if (moved) {
      const next = await post<HostStatus>(u(userId, "hosts", ep.id, "models-folder"), { path: folder.trim() });
      const p = ctx.models.page;
      if (p) ctx.models.set({ ...p, hosts: p.hosts.map((h) => (h.endpointId === ep.id ? { endpointId: ep.id, status: next } : h)) });
    }
    if (renamed || readdressed) ctx.models.reload();
    onClose();
  });
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={`Edit ${ep.name}`}>
      <div className="drawer-head">
        <div>
          <h2>{ep.name}</h2>
          <p className="cap">ID <span className="mono">{ep.id}</span>{ep.fingerprint && <> · <span className="mono">{ep.fingerprint}</span></>}</p>
        </div>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (!ready) return; if (moved) setAsking(true); else void save(); }}>
        <fieldset className="group" disabled={busy}>
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Addresses</span><textarea className="mono" rows={3} autoCapitalize="none" spellCheck={false} value={addresses} onChange={(e) => setAddresses(e.target.value)} /></label>
          {status && (
            <label className="field"><span title={folderHow(status) ?? "Moving it moves no files."}>Models folder</span>
              <input className="mono" autoCapitalize="none" spellCheck={false} disabled={!changesFolder} value={folder} onChange={(e) => setFolder(e.target.value)} />
            </label>
          )}
        </fieldset>
        <ErrorText error={error} />
        <div className="row drawer-foot">
          <button type="submit" className="primary" disabled={busy || !ready}>Save</button>
        </div>
      </form>
      {asking && (
        <ConfirmDialog title={`Move ${ep.name} to another models folder?`}
          sentence={`It pauses once running jobs finish and restarts on ${folder.trim()}. No files move; models that aren't in that folder leave its lists.`}
          confirm="Move" onCancel={() => setAsking(false)} onConfirm={() => { setAsking(false); void save(); }} />
      )}
    </aside>
  );
}

function GpuBlock({ g }: { g: Gpu }) {
  const queued = (["chat", "image", "background"] as const).filter((k) => g.queue[k] > 0);
  return (
    <div className="gpu" data-gpu={g.index}>
      <div className="gpu-line"><span>GPU <span className="num">{g.index}</span> · {g.name}{g.pciId && <> · <span className="num">{g.pciId}</span></>}</span><span className="num muted">{gb(g.vram.used)} / {gbTotal(g.vram.total)} GB</span></div>
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
  const plan = planOf(ep.api);
  return (
    <li className="ep-row" data-endpoint={ep.id}>
      <div className="main-col">
        <span className={ep.kind === "cloud" ? "name endpoint-name" : "name"}>
          {ep.name} <Kind kind={ep.kind} />
          {plan ? <span className="pill">{PLAN_NAMES[plan]} plan</span> : ep.kind === "cloud" && ep.hasApiKey ? <span className="pill">API key</span> : null}
          {!!ep.cloudCapabilities?.length && <span className="endpoint-capabilities">{ep.cloudCapabilities.map(cap => cap === "Image"
            // Its image models are set on Image models.
            ? <a className="pill" key={cap} href={href({ page: "models", userId: ctx.user.id, tab: "images" })}>{cap}</a>
            : <span className="pill" key={cap}>{cap}</span>)}</span>}
          {ep.unencrypted && <span className="pill warn">unencrypted</span>}{ep.stale && <span className="pill bad">stale</span>}</span>
        <span className="meta muted">{plan ? <>{PLAN_NAMES[plan]} plan · only you{ep.planAccount && <> · <span className="mono">{ep.planAccount}</span></>}</> : <><code className="url">{ep.baseUrl}</code> · {ep.shared ? "shared" : "only you"}{ep.hasApiKey && <> · <span className="mono">key ••••{ep.keyLast4}</span></>}</>} · ID <span className="mono">{ep.id}</span></span>
        {ep.warning && <span className="warn-text">{ep.warning}</span>}
      </div>
      <div className="actions">
        <StateWord ep={ep} />
        <button type="button" className="link sm" aria-expanded={open} onClick={() => setOpen(!open)}>{plural(ep.models.length, "model", "models")}</button>
        {editable && <EndpointPauseButton ctx={ctx} ep={ep} />}
        {editable && <button type="button" className="sm" onClick={() => onEdit()}>Edit</button>}
        {editable && <RowMenu label={`Actions for ${ep.name}`} items={actions.items} />}
      </div>
      {actions.forms}
      {open && <ModelList ctx={ctx} ep={ep} onVoice={onVoice} />}
    </li>
  );
}

/** Plain HTTP to somewhere other than this machine or the tailnet, as the server marks `unencrypted`. */
function plainHttp(url: string): boolean {
  let host: string;
  // The server adds http:// to a local endpoint's address that has no scheme.
  try { const x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`); if (x.protocol !== "http:") return false; host = x.hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
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
  const defaultName = useRef("");
  const suggestName = (suggested: string) => {
    if (!ep && (!name.trim() || name === defaultName.current)) { setName(suggested); defaultName.current = suggested; }
  };
  const [kind, setKind] = useState<"custom" | "openrouter" | PlanKind>(ep ? planOf(ep.api) ?? "custom" : "custom");
  // Local and Cloud are exclusive checkboxes of a custom endpoint: ticking one clears the other.
  const [place, setPlace] = useState<"local" | "cloud" | undefined>(ep?.kind);
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
  const plan = kind === "custom" || kind === "openrouter" ? undefined : kind;
  const ready = plan ? !!ep && !!name.trim() && name.trim() !== ep.name
    : ep ? Object.keys(change).length > 0 && !!name.trim() && !!baseUrl.trim() : !!name.trim() && !!baseUrl.trim() && !!place;
  const save = () => run(async () => {
    if (ep) await patch(u(userId, "endpoints", ep.id), change);
    else if (!plan) await post(u(userId, "endpoints"), { name: name.trim(), kind: place, baseUrl: baseUrl.trim(), ...(apiKey ? { apiKey } : {}), ...(shared ? { shared } : {}) });
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
              <select value={kind} onChange={(e) => { setKind(e.target.value as "custom" | "openrouter" | PlanKind); suggestName(e.target.value === "chatgpt" ? "ChatGPT" : ""); }}>
                <option value="custom">Custom</option><option value="chatgpt">ChatGPT plan</option><option value="grok">Grok plan</option><option value="openrouter">OpenRouter</option>
              </select>
            </label>
          )}
          {plan && (!ep || signIn) && <PlanSignIn key={plan} ctx={ctx} plan={plan} name={name.trim()} ep={ep} onDone={onClose} />}
          {openrouter && <OpenRouterSignIn ctx={ctx} name={name.trim()} shared={shared} onShared={setShared} onDone={onClose} />}
          {!plan && !openrouter && <>
          <label className="field"><span>Base URL</span><input className="mono" inputMode="url" autoCapitalize="none" placeholder="http://192.168.1.50:1234/v1" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); try { suggestName(new URL(e.target.value).hostname === "api.openai.com" ? "OpenAI" : ""); } catch { /* An incomplete URL has no suggested name. */ } }} /></label>
          {place === "local" && plainHttp(baseUrl) && <p className="warn-text" role="note">Plain HTTP: the API key and every message cross the network unencrypted.</p>}
          <label className="field"><span>API key</span>
            <input type="password" autoComplete="off" disabled={removeKey} placeholder={ep?.hasApiKey ? "leave blank to keep" : undefined} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          {ep?.hasApiKey && <label className="check"><input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} /> Remove key</label>}
          {!ep && <>
            <label className="check" title="On your own network: this machine, the LAN or the tailnet."><input type="checkbox" checked={place === "local"} onChange={(e) => setPlace(e.target.checked ? "local" : undefined)} /> Local</label>
            <label className="check"><input type="checkbox" checked={place === "cloud"} onChange={(e) => setPlace(e.target.checked ? "cloud" : undefined)} /> Cloud</label>
          </>}
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
    let s: PlanSignInStarted;
    try { s = await post<PlanSignInStarted>(u(userId, "plans", "sign-in"), ep ? { endpointId: ep.id } : { plan, name }); } catch (e) { tab?.close(); throw e; }
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

/**
 * Add model host: name, addresses and the code its dashboard shows; then the fingerprint it paired with.
 * Pair again… opens it for one host (`again`): only the code, since the name and addresses stay.
 */
function AddHost({ ctx, again }: { ctx: MCtx; again?: string }) {
  const userId = ctx.user.id;
  const known = again ? ctx.models.page?.endpoints.find((e) => e.id === again && e.api === "host") : undefined;
  const [name, setName] = useState("");
  const [addresses, setAddresses] = useState("");
  const [code, setCode] = useState("");
  const [shared, setShared] = useState(false);
  const [paired, setPaired] = useState<EndpointInfo>();
  const [run, busy, error] = useAction();
  const list = addresses.split(/[\s,]+/).filter(Boolean);
  const pair = () => run(async () => {
    setPaired(known
      ? await post<EndpointInfo>(u(userId, "hosts", known.id, "pair"), { code: code.trim() })
      : await post<EndpointInfo>(u(userId, "hosts"), { name: name.trim(), addresses: list, code: code.trim(), ...(shared ? { shared } : {}) }));
    ctx.models.reload();
  });
  const back = href({ page: "models", userId, tab: "hosts" });
  const ready = !!code.trim() && (known ? true : !!name.trim() && list.length > 0);
  if (again && !known) return <Frame ctx={ctx} tab="hosts" title="Pair again">{ctx.models.page ? <p className="empty">That host isn't paired with this server. <a href={back}>Hosts and endpoints</a></p> : null}</Frame>;
  return (
    <Frame ctx={ctx} tab="hosts" title={known ? `Pair ${known.name} again` : "Add model host"} facts={known && (known.addresses ?? []).map((a, i) => <Fragment key={a}>{i > 0 && " · "}<span className="mono">{a}</span></Fragment>)}>
      <div className="steps add-host">
        <form className="step" onSubmit={(e) => { e.preventDefault(); void pair(); }}>
          <h2 className="eyebrow">{known ? "Pair" : "Host"}</h2>
          <fieldset className="stack" disabled={busy || !!paired}>
            {!known && <>
              <label className="field"><span>Name</span><input value={name} autoFocus onChange={(e) => setName(e.target.value)} /></label>
              <label className="field"><span>Addresses</span><textarea className="mono" rows={3} autoCapitalize="none" placeholder={"192.168.1.40\nblackwell.tailnet.ts.net"} value={addresses} onChange={(e) => setAddresses(e.target.value)} /></label>
            </>}
            <label className="field"><span>Pairing code</span><input className="mono" autoComplete="off" autoCapitalize="none" autoFocus={!!known} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            {!known && ctx.user.admin && <Switch label="Shared" hint="Every user on this server can use it" checked={shared} onChange={setShared} />}
          </fieldset>
          <ErrorText error={error} />
          <div className="row">
            <button className={paired ? "" : "primary"} disabled={busy || !!paired || !ready}>Pair</button>
            {!paired && <button type="button" onClick={() => go({ page: "models", userId, tab: "hosts" })}>Cancel</button>}
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

function Calls({ ctx, route }: { ctx: MCtx; route?: Extract<Route, { page: "models" }> }) {
  const { project, pool } = route ?? {};
  const allThreads = useLoad(() => get<ThreadSummary[]>(u(ctx.user.id, "threads") + "?all=1"), [ctx.user.id, ctx.threads]);
  const projects = (allThreads.data ?? ctx.threads).filter(t => t.project && !hidden(ctx.me.display, t.pool) && (ctx.me.display.showHidden || !t.hidden)).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  const selected = projects.find(t => t.id === project && t.pool === pool);
  const filter = selected ? `?project=${encodeURIComponent(selected.id)}&pool=${selected.pool}` : "";
  return (
    <Frame ctx={ctx} tab="calls" title="Call history" actions={
      <label className="project-filter">Project <select aria-label="Project" value={selected ? `${selected.pool}/${selected.id}` : ""} onChange={e => {
        const t = projects.find(t => `${t.pool}/${t.id}` === e.target.value);
        go({ page: "models", userId: ctx.user.id, tab: "calls", ...(t ? { project: t.id, pool: t.pool } : {}) });
      }}><option value="">All projects</option>{(["general", "private"] as const).map(p => {
        const list = projects.filter(t => t.pool === p);
        return list.length ? <optgroup key={p} label={p === "general" ? "General" : "Private"}>{list.map(t => <option key={t.id} value={`${p}/${t.id}`}>{t.title || "New project"}</option>)}</optgroup> : null;
      })}</select></label>
    }>
      <HistoryList<CallInfo> key={`${ctx.user.id}/${ctx.me.display.showGeneral}/${ctx.me.display.showPrivate}/${filter}`} route={route} path={u(ctx.user.id, "models", "calls", "history") + filter} render={(page) => <CallsTable ctx={ctx} calls={page.entries} />} />
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
