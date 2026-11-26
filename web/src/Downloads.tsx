// The Models area's Downloads tab (docs/ux.md §6, "Downloads and hub accounts"): the queue of every host's downloads,
// Active work and one finished History preview, read again every 2 s while anything runs; the Download text model page (and what Download
// image model shares with it); and Accounts, the hub tokens for gated repositories. A host's downloads need its
// management, so a shared host's need an administrator, and only those hosts are listed. Its pure parts are in
// src/downloads.ts.
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { del, get, patch, post, put, u, type DownloadHistory, type GroupInfo, type GroupSuggestion, type HostStatus, type Hub, type HubTokenInfo, type ModelsPage, type TextStarter } from "./api.ts";
import { HistoryHead, HistoryList } from "./History.tsx";
import { civitaiModel, clearFinished, companionsOf, downloadWords, fileChoices, fileLink, HUB_WORD, isRunning, repoName, resumeProblem, size, speed, speeds, toSend, type HostDownload, type HubFiles } from "./downloads.ts";
import { Icon } from "./icons.tsx";
import { canEdit, Frame, hostOf, plural, type MCtx } from "./ModelsFrame.tsx";
import { cameFrom, go, href, type Route } from "./route.ts";
import { ErrorText, useAction, useLoad } from "./ui.tsx";
import { isSending, MARGIN, stopSending, upload, useSending, whyStopped } from "./uploads.ts";

type Endpoint = ModelsPage["endpoints"][number];

/** The model hosts this user manages (a shared one needs an administrator), with their status when they answered. */
export function managedHosts(ctx: MCtx): { ep: Endpoint; status?: HostStatus }[] {
  const p = ctx.models.page;
  return (p?.endpoints ?? []).filter((ep) => ep.api === "host" && canEdit(ctx, ep)).map((ep) => {
    const h = hostOf(p!, ep.id);
    return { ep, ...(h && "status" in h ? { status: h.status } : {}) };
  });
}

/** Where a page with steps goes back to: the Models address it was opened from, else its own tab. */
export function wayBack(fallback: string): string {
  const from = cameFrom();
  return /\/models(\/|$)/.test(from) && from !== location.hash ? from : fallback;
}

/** One host's downloads, or why they couldn't be read. */
type HostList = { ep: Endpoint; downloads: HostDownload[]; finishedTotal?: number; error?: string };

export function Downloads({ ctx, history = false, route }: { ctx: MCtx; history?: boolean; route?: Extract<Route, { page: "models" }> }) {
  const userId = ctx.user.id;
  const hosts = useMemo(() => managedHosts(ctx).map((h) => h.ep), [ctx]);
  const key = hosts.map((ep) => `${ep.id}:${ep.name}`).join(" ");
  const lists = useLoad(() => Promise.all(hosts.map(async (ep): Promise<HostList> => {
    try { return { ep, ...await get<{ downloads: HostDownload[]; finishedTotal: number }>(`${u(userId, "hosts", ep.id, "downloads")}?preview=1`) }; }
    catch (e) { return { ep, downloads: [], error: `${ep.name}: ${(e as Error).message}` }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [userId, key]);
  const groups = useLoad(() => get<GroupInfo[]>(u(userId, "groups")), [userId]);
  const suggestions = useLoad(() => get<GroupSuggestion[]>(u(userId, "groups", "suggestions")), [userId]);
  const [run, busy, error] = useAction();
  const sendingNow = useSending();
  const items = useMemo(() => (lists.data ?? []).flatMap(({ ep, downloads }) => downloads.map((d) => ({ ep, d })))
    .sort((a, b) => b.d.startedAt.localeCompare(a.d.startedAt)), [lists.data]);
  const active = items.filter(({ d }) => isRunning(d));
  const finished = items.filter(({ d }) => !isRunning(d));
  // Speed from one look to the next, by host and download.
  const seen = useRef(new Map<string, { received: number; at: number; rate?: number }>());
  const rates = useMemo(() => speeds(active.map(({ ep, d }) => ({ ...d, id: `${ep.id}/${d.id}` })), seen.current, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lists.data]);
  const { reload } = lists, { reload: reloadModels } = ctx.models, { reload: reloadGroups } = groups, { reload: reloadSuggestions } = suggestions;
  // An upload no tab is sending only waits, so it isn't read again for.
  // One lyricad carries from another host is paused only once it stopped.
  const paused = (ep: Endpoint, d: HostDownload) => d.state === "uploading" && (d.copyFrom ? !!d.copyStopped : !isSending(ep.id, d.id));
  const moving = active.filter(({ ep, d }) => !paused(ep, d)).length;
  // When this tab starts or stops sending an upload, read the list again: one that just finished would otherwise
  // keep its last answer, still uploading, and show Paused with nothing left to read it again for.
  const firstSending = useRef(sendingNow);
  useEffect(() => { if (sendingNow !== firstSending.current) reload(); }, [sendingNow, reload]);
  // Every 2 s while anything runs, counted from the last answer so a slow host never stacks requests.
  useEffect(() => {
    if (!moving) return;
    const t = setTimeout(reload, 2000);
    return () => clearTimeout(t);
  }, [lists.data, moving, reload]);
  // A download that finished is a model now: the page's endpoints and the groups learn of it.
  const was = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(active.map(({ d }) => d.id));
    if ([...was.current].some((id) => !now.has(id))) { reloadModels(); reloadGroups(); reloadSuggestions(); }
    was.current = now;
  }, [active, reloadModels, reloadGroups, reloadSuggestions]);

  const cancel = (ep: Endpoint, d: HostDownload) => run(async () => { stopSending(ep.id, d.id); await del(u(userId, "hosts", ep.id, "downloads", d.id)); reload(); });
  // The browser can't reopen a file by itself, so Resume… asks for it again; the host carries on from what arrived.
  const resume = (ep: Endpoint, d: HostDownload, file: File) => run(async () => {
    const why = resumeProblem(d, file);
    if (why) throw new Error(why);
    await upload(userId, ep.id, file);
  });
  const clear = () => run(async () => {
    await clearFinished(
      (offset) => get<DownloadHistory>(`${u(userId, "models", "downloads", "history")}?limit=100&offset=${offset}`),
      ({ endpointId, download }) => del(u(userId, "hosts", endpointId, "downloads", download.id)),
    );
    reload();
  });
  const addToGroup = (g: GroupInfo, offeringId: string) => run(async () => {
    await patch(u(userId, "groups", g.id), { members: [...g.members, offeringId] });
    reloadGroups(); reloadSuggestions();
  });
  /** A finished download's model, its group, or a group of the same model it could join. */
  const groupOf = (ep: Endpoint, d: HostDownload) => {
    const offering = ep.models.find((m) => m.modelId === d.path);
    if (!offering || d.state !== "done") return undefined;
    const all = groups.data ?? [];
    const inGroup = all.find((g) => g.members.includes(offering.id));
    if (inGroup) return { group: inGroup };
    const same = (suggestions.data ?? []).filter((s) => s.members.includes(offering.id)).flatMap((s) => s.members);
    const join = all.find((g) => canEdit(ctx, g) && g.members.some((m) => same.includes(m)));
    return join ? { join, offeringId: offering.id } : undefined;
  };

  const finishedRow = (ep: Endpoint, d: HostDownload) => {
    const g = groupOf(ep, d);
    return <Item key={`${ep.id}/${d.id}`} ep={ep} d={d} busy={busy}>
      {g?.group && <>{SEP}in the group “{g.group.name}”</>}
      {g?.join && <>{SEP}<button type="button" className="link" disabled={busy} onClick={() => void addToGroup(g.join, g.offeringId)}>Add to the group “{g.join.name}”</button></>}
    </Item>;
  };

  // Every finished download across the hosts, from each host's true total when it gave one (its list may be truncated).
  const finishedCount = lists.data?.reduce((n, l) => n + (l.finishedTotal ?? l.downloads.filter((d) => !isRunning(d)).length), 0);
  const facts = lists.data && <>{active.length ? <><span className="num">{active.length}</span> running</> : "Nothing running"} · <span className="num">{finishedCount}</span> finished</>;
  const actions = <>
    <button type="button" onClick={() => go({ page: "models", userId, tab: "downloads", add: "text" })}>Download text model</button>
    <button type="button" onClick={() => go({ page: "models", userId, tab: "images", add: "image" })}>Download image model</button>
  </>;
  return (
    <Frame ctx={ctx} tab="downloads" title={history ? "Download history" : "Downloads"} facts={history ? undefined : facts} actions={history ? <a href={href({ page: "models", userId, tab: "downloads" })}>Downloads</a> : actions} running={lists.data ? active.length : undefined}>
      <ErrorText error={ctx.models.error || lists.error || error} />
      {(lists.data ?? []).map((l) => l.error && <ErrorText key={l.ep.id} error={l.error} />)}
      {!history && <section className="section" aria-labelledby="h-queue">
        <div className="section-head">
          <h2 id="h-queue">Queue</h2>
          {finished.length > 0 && <button type="button" className="link" disabled={busy} onClick={() => void clear()}>Clear finished</button>}
        </div>
        <div aria-live="polite">
          {active.length ? (
            <ul className="list downloads">
              {active.length > 0 && <li className="group-head eyebrow">In progress</li>}
              {active.map(({ ep, d }) => <Item key={`${ep.id}/${d.id}`} ep={ep} d={d} busy={busy} paused={paused(ep, d)} rate={paused(ep, d) ? undefined : rates.get(`${ep.id}/${d.id}`)} onCancel={() => void cancel(ep, d)} onResume={paused(ep, d) && !d.copyFrom ? (f) => void resume(ep, d, f) : undefined} />)}
            </ul>
          ) : lists.data && !finished.length && (
            <p className="list empty">No downloads yet. Start one from a library's <b>Download model</b> button, or here.</p>
          )}
        </div>
      </section>}
      <section className="section" aria-label="History" aria-live={history ? undefined : "polite"}>
        {!history && <HistoryHead to={{ page: "models", userId, tab: "downloads", add: "history" }} count={finishedCount} />}
        {history ? <HistoryList<DownloadHistory["entries"][number], DownloadHistory> route={route} path={u(userId, "models", "downloads", "history")} render={(page) => <ul className="list downloads">{page.entries.map(({ endpointId, download }) => {
          const ep = hosts.find((h) => h.id === endpointId);
          return ep ? finishedRow(ep, download) : null;
        })}</ul>} /> : <ul className="list downloads">{finished.slice(0, 1).map(({ ep, d }) => finishedRow(ep, d))}</ul>}
      </section>
      {!history && <Accounts ctx={ctx} />}
    </Frame>
  );
}

const Dot = ({ dot, word }: { dot: string; word: string }) => <span className="status-word"><span className={`dot ${dot}`} aria-hidden="true" />{word}</span>;
/** "16.8 GB" with the number in mono. */
export const Size = ({ text }: { text: string }) => { const [n, unit] = text.split(" "); return <><span className="num">{n}</span> {unit}</>; };
const SEP = "\u00a0· ";

/** Why an upload is paused, and how to carry on, for its phase's tooltip. */
const pausedTip = (ep: Endpoint, d: HostDownload) => d.copyFrom
  ? [d.copyStopped, `Copy the model to ${ep.name} again to carry on.`].filter(Boolean).join(" ")
  : whyStopped(ep.id, d.id);

/**
 * One download: its file, where from and to, and its progress and speed with Cancel (and Resume… for a paused upload,
 * which asks for the same file again), or how it ended.
 */
function Item({ ep, d, busy, rate, paused, onCancel, onResume, children }: { ep: Endpoint; d: HostDownload; busy: boolean; rate?: number; paused?: boolean; onCancel?: () => void; onResume?: (f: File) => void; children?: React.ReactNode }) {
  const w = downloadWords(d, ep.name, paused);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <li className="dl" data-download={d.id}>
      <div className="dl-top"><b>{w.label}</b><span className="meta">{w.from}</span></div>
      {w.progress !== undefined ? <>
        <div className="bar" role="progressbar" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent}>
          <span className="seg-loaded" style={{ width: `${w.percent ?? 0}%` }} />
        </div>
        <div className="dl-foot">
          <span className="meta"><span title={paused ? pausedTip(ep, d) : undefined}>{w.progress.phase}</span> · <Size text={w.progress.got} />{w.progress.of && <> of <Size text={w.progress.of} /></>}{rate !== undefined && <> · <Size text={speed(rate)} /></>}</span>
          <span className="row">
            {onResume && <>
              <button type="button" className="sm" aria-label={`Resume ${w.label}`} title="Choose the same file to carry on." disabled={busy} onClick={() => picker.current?.click()}>Resume…</button>
              <input ref={picker} type="file" hidden aria-label={`File to resume ${w.label}`} accept=".gguf,.safetensors" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onResume(f); }} />
            </>}
            <button type="button" className="sm" aria-label={`Cancel ${w.label}`} disabled={busy} onClick={onCancel}>Cancel</button>
          </span>
        </div>
      </> : w.ending && (
        <p className="dl-end">
          <Dot dot={w.ending.dot} word={w.ending.word} />
          {w.ending.note && <span className="muted"> {w.ending.note}</span>}
          {d.state === "done" && <>{SEP}<Size text={size(d.size ?? d.received)} />{SEP}<Dot dot="up" word="Ready" />{children}</>}
        </p>
      )}
    </li>
  );
}

/* ---- Accounts: a token per hub, for gated repositories ---- */

const HUBS: Hub[] = ["huggingface", "modelscope", "civitai"];

/** The token a download from `hub` uses: the user's own, else one an administrator shared. */
export const tokenFor = (tokens: HubTokenInfo[] | undefined, hub: Hub) => tokens?.find((t) => t.hub === hub && !t.shared) ?? tokens?.find((t) => t.hub === hub);

/** A hub token as the page shows it: never more than its last four characters. */
export const Masked = ({ t }: { t: HubTokenInfo }) => <span className="mono">••••{t.last4}</span>;

function Accounts({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const tokens = useLoad(() => get<HubTokenInfo[]>(u(userId, "hub-tokens")), [userId]);
  const [editing, setEditing] = useState<{ hub: Hub; shared: boolean }>();
  const [token, setToken] = useState("");
  const [run, busy, error] = useAction();
  const close = () => { setEditing(undefined); setToken(""); };
  const save = () => run(async () => {
    tokens.set(await put<HubTokenInfo[]>(u(userId, "hub-tokens", editing!.hub), { token: token.trim(), shared: editing!.shared }));
    close();
  });
  const remove = (t: HubTokenInfo) => run(async () => tokens.set(await del<HubTokenInfo[]>(`${u(userId, "hub-tokens", t.hub)}${t.shared ? "?shared=1" : ""}`)));
  return (
    <section className="section" aria-labelledby="h-accounts">
      <div className="section-head"><h2 id="h-accounts">Accounts</h2></div>
      <ErrorText error={tokens.error || (editing ? "" : error)} />
      {tokens.data && (
        <ul className="list accounts">
          {HUBS.map((hub) => {
            const t = tokenFor(tokens.data, hub);
            if (editing?.hub === hub) return (
              <li key={hub} className="acct" data-hub={hub}>
                <form className="acct-form" onSubmit={(e) => { e.preventDefault(); if (token.trim()) void save(); }}>
                  <b>{HUB_WORD[hub]}</b>
                  <label className="field"><span>Access token</span>
                    <input type="password" className="mono" title="A read-only token is enough." autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus value={token} onChange={(e) => setToken(e.target.value)} />
                  </label>
                  {ctx.user.admin && (
                    <div className="seg" role="group" aria-label="Who can use it">
                      <button type="button" aria-pressed={!editing.shared} onClick={() => setEditing({ hub, shared: false })}>Only you</button>
                      <button type="button" aria-pressed={editing.shared} onClick={() => setEditing({ hub, shared: true })}>Every user</button>
                    </div>
                  )}
                  <ErrorText error={error} />
                  <div className="row">
                    <button className="sm primary" disabled={busy || !token.trim()}>Save</button>
                    <button type="button" className="sm" onClick={close}>Cancel</button>
                  </div>
                </form>
              </li>
            );
            return (
              <li key={hub} className="acct" data-hub={hub}>
                <div className="main-col">
                  <b>{HUB_WORD[hub]}</b>
                  <span className="meta">{t ? <>Token saved · <Masked t={t} /> · {t.shared ? "every user" : "only you"}</> : "No token"}</span>
                </div>
                <div className="actions">
                  {t ? <>
                    <button type="button" className="sm" aria-label={`Replace the ${HUB_WORD[hub]} token`} disabled={busy} onClick={() => setEditing({ hub, shared: t.shared && ctx.user.admin })}>Replace</button>
                    {(!t.shared || ctx.user.admin) && (
                      <button type="button" className="sm danger" aria-label={`Remove the ${HUB_WORD[hub]} token`} disabled={busy} onClick={() => void remove(t)}>Remove</button>
                    )}
                  </> : (
                    <button type="button" className="sm" aria-label={`Add a ${HUB_WORD[hub]} token`} disabled={busy} onClick={() => setEditing({ hub, shared: false })}>Add token</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---- What the download pages share: where to, the repository looked up, a gated one's token, a link ---- */

/** Download to: the hosts this user manages that answered, each with its free space. */
export function HostField({ hosts, value, onChange }: { hosts: { ep: Endpoint; status?: HostStatus }[]; value?: string; onChange: (id: string) => void }) {
  const isPaused = (s?: HostStatus) => s?.state === "paused" || s?.state === "pausing";
  const chosen = hosts.find((h) => h.ep.id === value)?.status;
  return (
    <label className="field"><span title={isPaused(chosen) ? "Downloading doesn't use the GPU, so it runs on a paused host too." : undefined}>Download to</span>
      <select value={value} title={chosen?.modelsFolder.path} onChange={(e) => onChange(e.target.value)}>
        {hosts.map(({ ep, status }) => <option key={ep.id} value={ep.id}>{ep.name}{isPaused(status) ? " · paused" : ""} · {size(status!.modelsFolder.free)} free</option>)}
      </select>
    </label>
  );
}

/** A repository on a hub, looked up on a host: what was typed, and the host's answer for it. */
export function useLookup(userId: string, hostId: string | undefined, source: Hub | "url") {
  const [repo, setRepo] = useState("");
  const [found, setFound] = useState<HubFiles>();
  const [problem, setProblem] = useState("");
  const [run, busy, error] = useAction();
  // Another host or hub, or another name, needs a look of its own.
  useEffect(() => { setFound(undefined); setProblem(""); }, [hostId, source]);
  const type = useCallback((text: string) => { setRepo(text); setFound(undefined); setProblem(""); }, []);
  const lookUp = () => {
    const name = source === "civitai" ? civitaiModel(repo) : repoName(repo);
    if (!name) { setProblem(source === "civitai" ? "That isn't a Civitai model. Use its number, or paste its page's link." : "That isn't a repository. Use owner/name, or paste the page's link."); return; }
    setProblem("");
    if (!hostId || source === "url") return;
    void run(async () => setFound(await get<HubFiles>(`${u(userId, "hosts", hostId, "hub", "files")}?${new URLSearchParams({ source, repo: name })}`)));
  };
  return { repo, type, found, lookUp, busy, error: problem || error };
}

/** The Repository field and Look up, for Hugging Face and ModelScope (and Civitai, where it names a model). */
export function RepoField({ look, placeholder, label = "Repository" }: { look: ReturnType<typeof useLookup>; placeholder: string; label?: string }) {
  const id = useId();
  return (
    <form className="field repo" onSubmit={(e) => { e.preventDefault(); look.lookUp(); }}>
      <label htmlFor={id}>{label}</label>
      <div className="lookup">
        <input id={id} className="mono" autoCapitalize="none" spellCheck={false} placeholder={placeholder} value={look.repo} onChange={(e) => look.type(e.target.value)} />
        <button disabled={look.busy || !look.repo.trim()}>Look up</button>
      </div>
    </form>
  );
}

/** A gated repository: the saved token it will use, or a field for one, kept for next time unless unticked. */
export function GatedNote({ hub, saved, token, setToken, keep, setKeep }: {
  hub: Hub; saved?: HubTokenInfo; token: string; setToken: (t: string) => void; keep: boolean; setKeep: (k: boolean) => void;
}) {
  const name = HUB_WORD[hub];
  if (saved) return <div className="banner" role="note"><span>Gated on {name}. Using your saved token (<Masked t={saved} />). Accept the model's licence on {name} first.</span></div>;
  return (
    <div className="note gated" role="note">
      <span>Gated on {name}. Accept the model's licence on {name} first.</span>
      <label className="field"><span>Access token</span>
        <input type="password" className="mono" autoComplete="off" autoCapitalize="none" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Save it for next time</label>
    </div>
  );
}

/** A link's two fields. */
export function LinkFields({ link, setLink, sha, setSha }: { link: string; setLink: (t: string) => void; sha: string; setSha: (t: string) => void }) {
  return <>
    <label className="field"><span>Link to the file</span>
      <input className="mono" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
    </label>
    <label className="field"><span title="If the page lists one. Without it, the download is marked unverified.">SHA-256</span>
      <input className="mono" autoCapitalize="none" spellCheck={false} value={sha} onChange={(e) => setSha(e.target.value)} />
    </label>
  </>;
}

/** The host's unfinished uploads, so picking one's file again counts only what is left to send. */
export function useUnfinishedUploads(userId: string, hostId: string | undefined, on: boolean): HostDownload[] {
  const list = useLoad(() => on && hostId ? get<{ downloads: HostDownload[] }>(u(userId, "hosts", hostId, "downloads")) : Promise.resolve(undefined), [userId, hostId, on]);
  return list.data?.downloads.filter((d) => d.source === "upload" && d.state === "uploading") ?? [];
}

/**
 * Upload: the files picked on this computer, each with its size, and whether they fit on the host (a file that carries
 * on an unfinished upload counts only what is left).
 */
export function UploadFields({ files, setFiles, free, unfinished }: { files: File[]; setFiles: (f: File[]) => void; free: number; unfinished?: HostDownload[] }) {
  const picker = useRef<HTMLInputElement>(null);
  const id = useId();
  const total = files.reduce((n, f) => n + f.size, 0);
  const need = toSend(files, unfinished);
  return (
    <div className="field upload-files">
      <span id={id}>Files</span>
      <div className="row">
        <button type="button" className="sm" aria-describedby={id} onClick={() => picker.current?.click()}>Choose files…</button>
      </div>
      <input ref={picker} type="file" multiple hidden aria-labelledby={id} accept=".gguf,.safetensors" onChange={(e) => { setFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
      {files.length > 0 && (
        <ul className="choices" aria-labelledby={id}>
          {files.map((f) => (
            <li key={f.name} className="choice plain">
              <span className="choice-name"><span className="mono">{f.name}</span></span>
              <span className="muted"><Size text={size(f.size)} /></span>
            </li>
          ))}
        </ul>
      )}
      {(files.length > 1 || need + MARGIN > free) && (
        <p className="meta">{files.length > 1 && <><Size text={size(total)} /> in all </>}{need + MARGIN > free && <span className="pill warn">not enough space</span>}</p>
      )}
    </div>
  );
}

/** Why the picked files can't be uploaded to a host, or "" when they can. */
export function uploadProblem(files: File[], free: number, host: string, unfinished?: HostDownload[]): string {
  if (!files.length) return "Choose a file.";
  if (files.some((f) => !/\.(gguf|safetensors)$/i.test(f.name))) return "Only .gguf and .safetensors files can be uploaded.";
  if (new Set(files.map((f) => f.name)).size < files.length) return "Two files have the same name.";
  if (toSend(files, unfinished) + MARGIN > free) return `Not enough space on ${host}.`;
  return "";
}

/** Starts each picked file's upload; the sending carries on in the background while the page moves to Downloads. */
export async function startUploads(userId: string, hostId: string, files: File[]) {
  for (const f of files) await upload(userId, hostId, f);
}

/** Why a link can't be downloaded, or "" when it can. */
export function linkProblem(link: string, sha: string): string {
  if (!fileLink(link)) return "Use an https link to one .gguf or .safetensors file.";
  if (sha.trim() && !/^[0-9a-f]{64}$/i.test(sha.trim())) return "A SHA-256 is 64 hex characters.";
  return "";
}

/**
 * Starts a download on a host. A gated repository's token typed here is saved first, since lyricad sends only a saved
 * one, and removed again once the host has it when Save it for next time is off. A removal that fails never fails a
 * download that started, so the page still goes to the queue rather than inviting a second start; the token then
 * shows under Accounts there.
 */
export async function startDownload(userId: string, hostId: string, body: { source: Hub; repo: string; files: string[] } | { source: "url"; url: string; sha256?: string }, token?: { text: string; keep: boolean }) {
  const hub = body.source === "url" ? undefined : body.source;
  const typed = hub && token?.text.trim() ? { hub, text: token.text.trim(), keep: token.keep } : undefined;
  if (typed) await put(u(userId, "hub-tokens", typed.hub), { token: typed.text });
  try {
    await post(u(userId, "hosts", hostId, "downloads"), body);
  } finally {
    if (typed && !typed.keep) await del(u(userId, "hub-tokens", typed.hub)).catch(() => {});
  }
}

/** The toast after a download starts: the page stays, so several can be queued from it. */
/** A link's file name, for the toast. */
export const linkName = (url: string) => { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || url); } catch { return url; } };
export const started = (what: string, host: string, upload = false) => `${upload ? "Uploading" : "Downloading"} ${what} to ${host}. Downloads shows how it goes.`;

/** What a vision projector or MTP file does, for its pill's tooltip. */
const COMPANION_TIPS = { vision: "Lets the model see images", mtp: "Multi-token prediction: faster answers" } as const;

/* ---- Starters: the host's text, embedding, voice and dictation starters (host/API.md "Text starters") ---- */

const STARTER_GROUPS = [["chat", "Chat"], ["embedding", "Embedding"], ["voice", "Voice"]] as const;
type StarterGroup = (typeof STARTER_GROUPS)[number][0];
const groupOf = (s: TextStarter): StarterGroup => (s.kind === "chat" || s.kind === "embedding" ? s.kind : "voice");
const KIND_WORD: Record<TextStarter["kind"], string> = { chat: "chat", embedding: "embedding", speak: "voice", transcribe: "transcription" };
const SERVER_WORD: Record<TextStarter["server"], string> = { llamacpp: "llama.cpp", vllm: "vLLM", speech: "Kokoro", whispercpp: "whisper.cpp" };
/** Its server's name; GLM-SGLang for one SGLang serves in vLLM's place. */
const serverWord = (s: TextStarter) => (s.engine === "sglang" ? "GLM-SGLang" : SERVER_WORD[s.server]);
/** Not currently installed: neither on the host nor on its way there. */
const installed = (s: TextStarter) => s.state !== "available";
/** Why a starter can't be picked, as its pill, or what to know before picking it. */
function starterPill(s: TextStarter, free: number): { word: string; tip?: string; warn?: boolean; off: boolean } | undefined {
  if (s.state === "here") return { word: "existing", off: true };
  if (s.state === "downloading") return { word: "downloading", off: true };
  if (s.size > free) return { word: "not enough space", tip: `${size(s.size)} to download, ${size(free)} free.`, warn: true, off: true };
  if (s.fits === "too_big") return { word: "too big for these GPUs", tip: `Needs ${size(s.needs)} of GPU memory, more than the GPUs here can give it.`, warn: true, off: true };
  if (s.fits === "ram") return { word: "uses system RAM", tip: "Runs slower: part of it stays in system RAM.", warn: true, off: false };
  return undefined;
}
const Pill = ({ p }: { p?: ReturnType<typeof starterPill> }) => p ? <span className={p.warn ? "pill warn" : "pill"} title={p.tip}>{p.word}</span> : null;

interface TextStarterRow { key: string; name: string; items: TextStarter[] }
function textStarterRows(list: TextStarter[]): TextStarterRow[] {
  const rows = new Map<string, TextStarterRow>();
  for (const s of list) {
    const key = s.variantOf ?? s.id;
    const row = rows.get(key) ?? { key, name: s.variantOf ?? s.name, items: [] };
    row.items.push(s);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Starters: searched, filtered to those not installed, grouped by kind; a model's sizes fold into one row with a Variant switch once picked. */
function TextStarters({ list, picked, setPicked, free }: { list: TextStarter[]; picked?: string; setPicked: (id: string) => void; free: number }) {
  const [q, setQ] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [open, setOpen] = useState<Set<StarterGroup>>(() => new Set());
  if (!list.length) return <p className="muted">This host has no starters for its servers.</p>;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (s: TextStarter) => {
    const text = [s.name, s.variantOf, KIND_WORD[s.kind], serverWord(s), s.vision ? "vision" : ""].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const kept = list.filter((s) => (!onlyNew || !installed(s)) && matches(s));
  const filtering = words.length > 0 || onlyNew;
  const toggle = (g: StarterGroup) => setOpen((o) => { const n = new Set(o); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  return <>
    <div className="img-filters">
      <input type="search" aria-label="Search starters" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
    <div className="chip-row" role="group" aria-label="Show">
      {([[false, "All"], [true, "Not currently installed"]] as const).map(([x, label]) => (
        <Fragment key={label}><button type="button" className="chip" aria-pressed={onlyNew === x} onClick={() => setOnlyNew(x)}>{label} <span className="num">{x ? list.filter((s) => !installed(s)).length : list.length}</span></button></Fragment>
      ))}
    </div>
    <p className="sr-only" aria-live="polite">{plural(kept.length, "starter", "starters")}</p>
    {kept.length ? (
      <div className="starter-groups" role="radiogroup" aria-label="Starters">
        {STARTER_GROUPS.map(([g, label]) => {
          const items = kept.filter((s) => groupOf(s) === g);
          if (!items.length) return null;
          const isOpen = filtering || open.has(g) || items.some((s) => s.id === picked);
          const here = items.filter((s) => s.state === "here").length;
          return (
            <details key={g} className="starter-family" open={isOpen}>
              <summary onClick={(e) => { e.preventDefault(); toggle(g); }} aria-expanded={isOpen}>
                <Icon name="right" />
                <span className="starter-family-name">{label}</span>
                <span className="cap">{plural(items.length, "starter", "starters")}{here > 0 && <> · <span className="num">{here}</span> existing</>}</span>
              </summary>
              {isOpen && textStarterRows(items).map((r) => <TextStarterChoice key={r.key} row={r} picked={picked} setPicked={setPicked} free={free} />)}
            </details>
          );
        })}
      </div>
    ) : <p className="muted">No starters match. <button type="button" className="link" onClick={() => { setQ(""); setOnlyNew(false); }}>Clear</button></p>}
  </>;
}

/** One row: a starter, or a model's sizes; a picked row with sizes shows a Variant switch. */
function TextStarterChoice({ row, picked, setPicked, free }: { row: TextStarterRow; picked?: string; setPicked: (id: string) => void; free: number }) {
  const many = row.items.length > 1;
  const isPicked = row.items.some((s) => s.id === picked);
  const off = (x: TextStarter) => !!starterPill(x, free)?.off;
  const s = row.items.find((x) => x.id === picked) ?? row.items.find((x) => !off(x)) ?? row.items[0]!;
  const allOff = row.items.every(off);
  const sizes = row.items.map((x) => x.size);
  const where = s.fits === "cpu" ? "CPU" : <>needs <Size text={size(s.needs)} /> of GPU memory</>;
  const what = [KIND_WORD[s.kind], ...(s.vision ? ["vision"] : []), serverWord(s)].join(" · ");
  const facts = many && !isPicked
    ? <>{what} · {plural(row.items.length, "size", "sizes")} · <Size text={size(Math.min(...sizes))} /> to <Size text={size(Math.max(...sizes))} /> to download</>
    : <>{what} · <Size text={size(s.size)} /> to download · {where}</>;
  // A folded row shows the pill of its shown size when none can be picked, else whether one of them exists or is downloading.
  const pill = many && !isPicked && !allOff ? row.items.map((x) => starterPill(x, free)).find((p) => p?.word === "existing" || p?.word === "downloading") : starterPill(s, free);
  return (
    <div className="starter">
      <label className="choice">
        <input type="radio" name="text-starter" checked={isPicked} disabled={many ? allOff : off(s)} onChange={() => setPicked(s.id)} />
        <span className="choice-file">
          <span className="choice-name">{row.name}<Pill p={pill} /></span>
          <span className="cap">{facts}</span>
        </span>
      </label>
      {many && isPicked && (
        <div className="seg starter-variant" role="group" aria-label="Variant">
          {row.items.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.id === s.id} disabled={off(x)} title={starterPill(x, free)?.word} onClick={() => setPicked(x.id)}>{x.variant}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Download text model: a host, then a starter, a file from Hugging Face or ModelScope, or a link. A started download goes to Downloads. */
export function DownloadText({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const hosts = managedHosts(ctx).filter((h) => h.status);
  const [hostId, setHostId] = useState<string>();
  const host = hosts.find((h) => h.ep.id === hostId) ?? hosts[0];
  const [source, setSource] = useState<Hub | "starters" | "url" | "upload">("starters");
  const look = useLookup(userId, host?.ep.id, source === "upload" || source === "starters" ? "url" : source);
  const unfinished = useUnfinishedUploads(userId, host?.ep.id, source === "upload");
  const starterHost = host?.ep.id;
  const starters = useLoad(() => (starterHost ? get<{ starters: TextStarter[]; outdated?: true }>(u(userId, "hosts", starterHost, "text-starters")) : Promise.resolve(undefined)), [userId, starterHost]);
  const [starter, setStarter] = useState<string>();
  useEffect(() => setStarter(undefined), [starterHost]);
  const pickedStarter = starters.data?.starters.find((x) => x.id === starter);
  const [files, setFiles] = useState<File[]>([]);
  const tokens = useLoad(() => get<HubTokenInfo[]>(u(userId, "hub-tokens")), [userId]);
  // The ticked files, and the companions ticked for a model rather than by hand.
  const [picked, setPicked] = useState<string[]>([]);
  const [auto, setAuto] = useState<string[]>([]);
  const [token, setToken] = useState("");
  const [keep, setKeep] = useState(true);
  const [link, setLink] = useState("");
  const [sha, setSha] = useState("");
  const [problem, setProblem] = useState("");
  const [run, busy, error] = useAction();
  const [back] = useState(() => wayBack(href({ page: "models", userId, tab: "downloads" })));
  const found = look.found;
  const offered = useMemo(() => (found ? fileChoices(found) : undefined), [found]);
  // What was said about the last try goes once the repository or its answer changes.
  useEffect(() => { setPicked([]); setAuto([]); setProblem(""); }, [found, look.repo]);
  /** Ticking a model ticks its vision projector and MTP file too; unticking the last model unticks those again. */
  const toggle = (key: string, on: boolean) => {
    if (!offered) return;
    setProblem("");
    const c = offered.choices.find((x) => x.key === key);
    if (c?.kind) {
      setAuto((a) => a.filter((k) => k !== key));
      setPicked((p) => on ? [...p, key] : p.filter((k) => k !== key));
      return;
    }
    if (on) {
      const add = companionsOf(offered.choices, key).filter((k) => !picked.includes(k));
      setPicked([...picked, key, ...add]);
      setAuto([...auto, ...add]);
    } else {
      const rest = picked.filter((k) => k !== key);
      const modelLeft = rest.some((k) => !offered.choices.find((x) => x.key === k)?.kind);
      setPicked(modelLeft ? rest : rest.filter((k) => !auto.includes(k)));
      if (!modelLeft) setAuto([]);
    }
  };
  const saved = source === "url" || source === "upload" || source === "starters" ? undefined : tokenFor(tokens.data, source);

  const download = () => {
    if (!host) return;
    if (source === "upload") {
      const why = uploadProblem(files, host.status!.modelsFolder.free, host.ep.name, unfinished);
      setProblem(why);
      if (!why) void run(async () => { await startUploads(userId, host.ep.id, files); setFiles([]); ctx.toast(started(files.length === 1 ? files[0]!.name : `${files.length} files`, host.ep.name, true)); });
      return;
    }
    if (source === "starters") {
      if (!pickedStarter) { setProblem("Choose a starter."); return; }
      setProblem("");
      void run(async () => {
        await post(u(userId, "hosts", host.ep.id, "text-starters", pickedStarter.id, "download"), {});
        setStarter(undefined);
        starters.reload();
        ctx.models.reload();
        ctx.toast(started(pickedStarter.name, host.ep.name));
      });
      return;
    }
    let body: Parameters<typeof startDownload>[2];
    if (source === "url") {
      const why = linkProblem(link, sha);
      if (why) { setProblem(why); return; }
      body = { source: "url", url: link.trim(), ...(sha.trim() ? { sha256: sha.trim() } : {}) };
    } else {
      const chosen = (offered?.choices ?? []).filter((c) => picked.includes(c.key));
      const total = chosen.reduce((n, c) => n + c.size, 0);
      const why = !found ? "Look up the repository first." : !chosen.length ? "Choose a file."
        : found.gated && !saved && !token.trim() ? "This repository needs a token."
        : total > found.free ? `Not enough space on ${host.ep.name}.` : "";
      if (why || !found || !chosen.length) { setProblem(why); return; }
      body = { source, repo: found.repo, files: chosen.flatMap((c) => c.files) };
    }
    setProblem("");
    void run(async () => {
      await startDownload(userId, host.ep.id, body, found?.gated && !saved ? { text: token, keep } : undefined);
      setToken("");
      setPicked([]); setAuto([]); setLink(""); setSha("");
      ctx.models.reload();
      ctx.toast(started(body.source === "url" ? linkName(body.url) : body.repo, host.ep.name));
    });
  };

  return (
    <Frame ctx={ctx} tab="downloads" title="Download text model">
      <ErrorText error={ctx.models.error} />
      {ctx.models.page && !host && (
        <p className="empty">No model host to download to. <a href={href({ page: "models", userId, tab: "hosts", add: "host" })}>Add model host</a></p>
      )}
      {host && (
        <div className="card dl-form">
          <HostField hosts={hosts} value={host.ep.id} onChange={setHostId} />
          <div className="seg" role="group" aria-label="Source">
            {(["starters", "huggingface", "modelscope", "url", "upload"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={source === s} onClick={() => { setSource(s); setProblem(""); }}>{s === "starters" ? "Starters" : s === "url" ? "Link" : s === "upload" ? "Upload" : HUB_WORD[s]}</button>
            ))}
          </div>
          {source === "starters" ? <>
            <ErrorText error={starters.error} />
            {starters.data?.outdated ? <p className="muted">Update {host.ep.name} to see its starters.</p>
              : starters.data && <TextStarters list={starters.data.starters} picked={starter} setPicked={(id) => { setStarter(id); setProblem(""); }} free={host.status!.modelsFolder.free} />}
          </>
          : source === "upload" ? <UploadFields files={files} setFiles={(f) => { setFiles(f); setProblem(""); }} free={host.status!.modelsFolder.free} unfinished={unfinished} />
          : source === "url" ? <LinkFields link={link} setLink={(t) => { setLink(t); setProblem(""); }} sha={sha} setSha={setSha} /> : <>
            <RepoField look={look} placeholder={source === "huggingface" ? "unsloth/Qwen3.8-27B-GGUF, or the page's link" : "Qwen/Qwen3.8-27B-GGUF, or the page's link"} />
            {found && offered && <>
              {found.gated && <GatedNote hub={source} saved={saved} token={token} setToken={setToken} keep={keep} setKeep={setKeep} />}
              <div className="field">
                <span id="h-file">Files to download</span>
                {offered.choices.length ? (
                  <div className="choices" role="group" aria-labelledby="h-file">
                    {offered.choices.map((c) => (
                      <label key={c.key} className="choice">
                        <input type="checkbox" checked={picked.includes(c.key)} disabled={c.present || !c.fits} onChange={(e) => toggle(c.key, e.target.checked)} />
                        <span className="choice-name">
                          <span className="mono">{c.label}</span>
                          {c.parts && <span className="meta"><span className="num">{c.parts}</span> files</span>}
                          {c.kind && <span className="pill" title={COMPANION_TIPS[c.kind]}>{c.kind === "vision" ? "Vision" : "MTP"}<span className="sr-only">. {COMPANION_TIPS[c.kind]}</span></span>}
                          {c.present ? <span className="pill">already on this host</span> : !c.fits && <span className="pill warn">not enough space</span>}
                        </span>
                        <span className="muted"><Size text={size(c.size)} /></span>
                      </label>
                    ))}
                  </div>
                ) : <p className="muted">Nothing in it can be downloaded.</p>}
              </div>
              {offered.refused.map((line) => <p key={line} className="meta">{line}</p>)}
            </>}
          </>}
          <ErrorText error={problem || (source === "url" || source === "upload" || source === "starters" ? "" : look.error) || error} />
          <div className={source === "starters" ? "row dl-foot" : "row"}>
            {source === "starters" && <span className="dl-picked">{pickedStarter ? <><b>{pickedStarter.name}</b><span className="cap"><Size text={size(pickedStarter.size)} /> to download</span></> : <span className="cap">No starter picked</span>}</span>}
            <button type="button" className="primary" disabled={busy || look.busy} onClick={download}>{source === "upload" ? "Upload" : "Download"}</button>
            <button type="button" onClick={() => { location.hash = back; }}>Cancel</button>
          </div>
        </div>
      )}
    </Frame>
  );
}
