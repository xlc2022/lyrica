// The Models area's Downloads tab (docs/ux.md §6, "Downloads and hub accounts"): the queue of every host's downloads,
// Active work and one finished History preview, read again every 2 s while anything runs; the Download text model page (and what Download
// image model shares with it); and Accounts, the hub tokens for gated repositories. A host's downloads need its
// management, so a shared host's need an administrator, and only those hosts are listed. Its pure parts are in
// src/downloads.ts.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { del, get, patch, post, put, u, type DownloadHistory, type GroupInfo, type GroupSuggestion, type HostStatus, type Hub, type HubTokenInfo, type ModelsPage } from "./api.ts";
import { HistoryHead, HistoryList } from "./History.tsx";
import { clearFinished, companionsOf, downloadWords, fileChoices, fileLink, HUB_WORD, isRunning, repoName, size, speed, speeds, type HostDownload, type HubFiles } from "./downloads.ts";
import { canEdit, Frame, hostOf, type MCtx } from "./ModelsFrame.tsx";
import { cameFrom, go, href, type Route } from "./route.ts";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

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
  // Every 2 s while anything runs, counted from the last answer so a slow host never stacks requests.
  useEffect(() => {
    if (!active.length) return;
    const t = setTimeout(reload, 2000);
    return () => clearTimeout(t);
  }, [lists.data, active.length, reload]);
  // A download that finished is a model now: the page's endpoints and the groups learn of it.
  const was = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(active.map(({ d }) => d.id));
    if ([...was.current].some((id) => !now.has(id))) { reloadModels(); reloadGroups(); reloadSuggestions(); }
    was.current = now;
  }, [active, reloadModels, reloadGroups, reloadSuggestions]);

  const cancel = (ep: Endpoint, d: HostDownload) => run(async () => { await del(u(userId, "hosts", ep.id, "downloads", d.id)); reload(); });
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
              {active.map(({ ep, d }) => <Item key={`${ep.id}/${d.id}`} ep={ep} d={d} busy={busy} rate={rates.get(`${ep.id}/${d.id}`)} onCancel={() => void cancel(ep, d)} />)}
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

/** One download: its file, where from and to, and its progress and speed with Cancel, or how it ended. */
function Item({ ep, d, busy, rate, onCancel, children }: { ep: Endpoint; d: HostDownload; busy: boolean; rate?: number; onCancel?: () => void; children?: React.ReactNode }) {
  const w = downloadWords(d, ep.name);
  return (
    <li className="dl" data-download={d.id}>
      <div className="dl-top"><b>{w.label}</b><span className="meta">{w.from}</span></div>
      {w.progress !== undefined ? <>
        <div className="bar" role="progressbar" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent}>
          <span className="seg-loaded" style={{ width: `${w.percent ?? 0}%` }} />
        </div>
        <div className="dl-foot">
          <span className="meta">{w.progress.phase} · <Size text={w.progress.got} />{w.progress.of && <> of <Size text={w.progress.of} /></>}{rate !== undefined && <> · <Size text={speed(rate)} /></>}</span>
          <button type="button" className="sm" aria-label={`Cancel ${w.label}`} disabled={busy} onClick={onCancel}>Cancel</button>
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

const HUBS: Hub[] = ["huggingface", "modelscope"];

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
  return (
    <label className="field"><span>Download to</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {hosts.map(({ ep, status }) => <option key={ep.id} value={ep.id}>{ep.name} · {size(status!.modelsFolder.free)} free</option>)}
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
    const name = repoName(repo);
    if (!name) { setProblem("That isn't a repository. Use owner/name, or paste the page's link."); return; }
    setProblem("");
    if (!hostId || source === "url") return;
    void run(async () => setFound(await get<HubFiles>(`${u(userId, "hosts", hostId, "hub", "files")}?${new URLSearchParams({ source, repo: name })}`)));
  };
  return { repo, type, found, lookUp, busy, error: problem || error };
}

/** The Repository field and Look up, for Hugging Face and ModelScope. */
export function RepoField({ look, placeholder }: { look: ReturnType<typeof useLookup>; placeholder: string }) {
  const id = useId();
  return (
    <form className="field repo" onSubmit={(e) => { e.preventDefault(); look.lookUp(); }}>
      <label htmlFor={id}>Repository</label>
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
    <label className="field"><span>SHA-256, if the page lists one</span>
      <input className="mono" autoCapitalize="none" spellCheck={false} value={sha} onChange={(e) => setSha(e.target.value)} />
    </label>
  </>;
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

/** Download text model: a host, then a file from Hugging Face or ModelScope, or a link. A started download goes to Downloads. */
/** What a vision projector or MTP file does, for its pill's tooltip. */
const COMPANION_TIPS = { vision: "Lets the model see images", mtp: "Multi-token prediction: faster answers" } as const;

export function DownloadText({ ctx }: { ctx: MCtx }) {
  const userId = ctx.user.id;
  const hosts = managedHosts(ctx).filter((h) => h.status);
  const [hostId, setHostId] = useState<string>();
  const host = hosts.find((h) => h.ep.id === hostId) ?? hosts[0];
  const [source, setSource] = useState<Hub | "url">("huggingface");
  const look = useLookup(userId, host?.ep.id, source);
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
  const saved = source === "url" ? undefined : tokenFor(tokens.data, source);
  const paused = host?.status?.state === "paused" || host?.status?.state === "pausing";

  const download = () => {
    if (!host) return;
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
      ctx.models.reload();
      go({ page: "models", userId, tab: "downloads" });
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
          {paused && <p className="meta">This host is paused. Downloading doesn't use the GPU, so it still runs.</p>}
          <div className="seg" role="group" aria-label="Source">
            {(["huggingface", "modelscope", "url"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={source === s} onClick={() => { setSource(s); setProblem(""); }}>{s === "url" ? "Link" : HUB_WORD[s]}</button>
            ))}
          </div>
          {source === "url" ? <LinkFields link={link} setLink={(t) => { setLink(t); setProblem(""); }} sha={sha} setSha={setSha} /> : <>
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
          <ErrorText error={problem || (source === "url" ? "" : look.error) || error} />
          <div className="row">
            <button type="button" className="primary" disabled={busy || look.busy} onClick={download}>Download</button>
            <a className="link" href={back}>Cancel</a>
          </div>
        </div>
      )}
    </Frame>
  );
}
