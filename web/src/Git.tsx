// Git accounts and repositories (DESIGN.md "Updates and self-editing", docs/ux.md §6):
// the Git accounts section of Settings with a row per account and its drawer
// (Add account opens the same drawer with a Token field), and the Repositories
// list the thread drawer and Project settings share.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  del, get, HttpError, patch, post, u,
  type GitAccountChange, type GitAccountInfo, type GitAccountInput, type GitKind, type GitRepository, type Pool,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { duration } from "./Machines.tsx";
import { her } from "./name.ts";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, useAction, useDismiss, useLoad } from "./ui.tsx";

export const KINDS: Record<GitKind, string> = { github: "GitHub", forgejo: "Forgejo", gitea: "Gitea", other: "Other" };
const POOLS: Record<Pool, string> = { general: "General", private: "Private" };
const GITHUB_POOL = "A GitHub account is general. Private threads use only self-hosted accounts on your own network.";
const PRIVATE_POOL = "A private account must be on your own network: LAN, this machine or the tailnet.";

/** At most one state per row: Signed in, Token rejected, Unreachable with how long, or Off network for a private one. */
export function gitState(a: GitAccountInfo, now = Date.now()): { tone: "ok" | "warn" | "bad"; word: string; detail?: string } | undefined {
  if (a.state?.kind === "rejected") return { tone: "bad", word: "Token rejected" };
  if (a.state?.kind === "unreachable") return { tone: "warn", word: "Unreachable", detail: duration(now - Date.parse(a.state.since)) };
  if (a.offNetwork && a.pool === "private") return { tone: "warn", word: "Off network" };
  if (a.state?.kind === "signedIn") return { tone: "ok", word: "Signed in" };
  return undefined;
}

const DOT: Record<"ok" | "warn" | "bad", string> = { ok: "up", warn: "away", bad: "down" };

function StateWord({ a }: { a: GitAccountInfo }) {
  const state = gitState(a);
  if (!state) return null;
  return <span className="state-word"><span className={`dot ${DOT[state.tone]}`} aria-hidden="true" />{state.word}{state.detail && <span className="num mono"> {state.detail}</span>}</span>;
}

/** The facts line under an account's name: host, pool, kind and the account's name on the host. */
function facts(a: GitAccountInfo) {
  return <>{a.host} · {a.pool} · {KINDS[a.kind]} · {a.account}</>;
}

/** The dialog's sentence for a private account whose host is outside her network. */
const offNetworkSentence = (name: string) => `${name}'s host is outside your network, so a private thread's code would leave it.`;

export function GitAccountsSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const accounts = useLoad(() => get<GitAccountInfo[]>(u(userId, "git-accounts")), [userId]);
  // The drawer: an account by name, or a new one.
  const [open, setOpen] = useState<string | { adding: true }>();
  const list = accounts.data ?? [];
  const current = typeof open === "string" ? list.find((a) => a.name === open) : undefined;
  const close = useCallback(() => setOpen(undefined), []);
  return (
    <section className="card" aria-labelledby="h-git">
      <h2 id="h-git">Git accounts</h2>
      <ErrorText error={accounts.error} />
      {accounts.data && !list.length && <p className="muted">None yet.</p>}
      {list.length > 0 && (
        <ul className="list machines">
          {list.map((a) => (
            <li key={a.name} className="machine-row git-row">
              <button type="button" className="machine-open" aria-haspopup="dialog" aria-expanded={open === a.name} onClick={() => setOpen(a.name)}>
                <span className="machine-name">{a.name}</span>
                <span className="machine-facts">{facts(a)}</span>
              </button>
              <StateWord a={a} />
            </li>
          ))}
        </ul>
      )}
      <div className="row"><button type="button" onClick={() => setOpen({ adding: true })}><Icon name="plus" /> Add account</button></div>
      {(current || (open && typeof open !== "string")) && (
        <>
          <GitDrawer key={current?.name ?? "new"} userId={userId} account={current} onClose={close}
            onSaved={() => { accounts.reload(); close(); }} onRemoved={() => { accounts.reload(); close(); }} onChanged={() => accounts.reload()} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={close} />
        </>
      )}
    </section>
  );
}

/**
 * One account's drawer: Name, Kind, Host, Account and Pool, with Replace
 * token and Remove behind ⋯. Without `account` it is Add account: a Token
 * field too, and the token is checked against the host before the row is saved.
 */
function GitDrawer({ userId, account, onSaved, onRemoved, onChanged, onClose }: {
  userId: string; account?: GitAccountInfo; onSaved: () => void; onRemoved: () => void; onChanged: () => void; onClose: () => void;
}) {
  const adding = !account;
  const [form, setForm] = useState({
    name: account?.name ?? "", kind: account?.kind ?? "github" as GitKind, host: account?.host ?? "github.com", account: account?.account ?? "",
    pool: account?.pool ?? "general" as Pool, token: "",
  });
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [offNetwork, setOffNetwork] = useState<"save" | "use">();
  const [run, busy, error] = useAction();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const set = (k: keyof typeof form, v: string) => setForm((f) => {
    const next = { ...f, [k]: v };
    // GitHub is general only, and its host is github.com unless it's an Enterprise server.
    if (k === "kind") { if (v === "github") next.pool = "general"; if (v === "github" && !f.host) next.host = "github.com"; if (v !== "github" && f.host === "github.com") next.host = ""; }
    return next;
  });
  const change: GitAccountChange = account ? {
    ...(form.name.trim() !== account.name ? { name: form.name.trim() } : {}),
    ...(form.host.trim() !== account.host ? { host: form.host.trim() } : {}),
    ...(form.account.trim() !== account.account ? { account: form.account.trim() } : {}),
    ...(form.pool !== account.pool ? { pool: form.pool } : {}),
  } : {};
  const ready = adding
    ? !!(form.name.trim() && form.host.trim() && form.account.trim() && form.token.trim())
    : replacing ? !!form.token.trim() : Object.keys(change).length > 0;
  // A private host outside her network is refused until its dialog is confirmed.
  const outside = (err: unknown) => err instanceof HttpError && /outside your network/.test(err.message);
  const save = (offNetworkConfirmed = false) => run(async () => {
    try {
      if (adding) {
        const input: GitAccountInput = { name: form.name.trim(), kind: form.kind, host: form.host.trim(), account: form.account.trim(), token: form.token.trim(), pool: form.pool, offNetworkConfirmed };
        await post<GitAccountInfo>(u(userId, "git-accounts"), input);
      } else if (replacing) {
        await post<GitAccountInfo>(u(userId, "git-accounts", account.name, "token"), { token: form.token.trim() });
      } else {
        await patch<GitAccountInfo>(u(userId, "git-accounts", account.name), { ...change, offNetworkConfirmed });
      }
    } catch (err) {
      if (outside(err) && !offNetworkConfirmed) { setOffNetwork("save"); return; }
      throw err;
    }
    onSaved();
  });
  const github = form.kind === "github";
  const name = form.name.trim() || "This account";
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={adding ? "Add account" : account.name}>
      <div className="drawer-head">
        <h2>{adding ? "Add account" : account.name}</h2>
        {account && <DrawerMenu label={`Actions for ${account.name}`} items={[
          { label: "Replace token", onPick: () => setReplacing(true) },
          ...(account.pool === "private" && account.offNetwork && !account.state ? [{ label: "Use anyway", onPick: () => setOffNetwork("use") }] : []),
          { label: "Remove", danger: true, onPick: () => setRemoving(true) },
        ]} />}
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
        {account && <StateWord a={account} />}
        <fieldset className="group" disabled={busy}>
          <label className="field"><span>Name</span><input value={form.name} autoFocus={adding} onChange={(e) => set("name", e.target.value)} /></label>
          <label className="field"><span>Kind</span>
            <select value={form.kind} disabled={!adding} onChange={(e) => set("kind", e.target.value)}>
              {(Object.keys(KINDS) as GitKind[]).map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}
            </select>
          </label>
          <label className="field"><span>Host</span><input className="mono" value={form.host} placeholder={github ? "github.com" : "git.lan"} onChange={(e) => set("host", e.target.value)} /></label>
          <label className="field"><span>Account</span><input value={form.account} onChange={(e) => set("account", e.target.value)} /></label>
          {(adding || replacing) && (
            <label className="field"><span>Token</span>
              <input className="mono" type="password" value={form.token} autoComplete="off" spellCheck={false} autoFocus={replacing}
                title={github ? `A fine-grained token for the repositories ${her()} works on, with Contents and Pull requests, and Actions read for CI logs.` : "An access token with read and write access to repositories."}
                onChange={(e) => set("token", e.target.value)} />
            </label>
          )}
          {github ? (
            <div className="field"><span>Pool</span>
              <span className="field-fact" title={GITHUB_POOL}>General<span className="sr-only">. {GITHUB_POOL}</span></span>
            </div>
          ) : (
            <label className="field"><span>Pool</span>
              <select value={form.pool} disabled={replacing} aria-describedby="git-pool-why" onChange={(e) => set("pool", e.target.value)}>
                {(Object.keys(POOLS) as Pool[]).map((p) => <option key={p} value={p}>{POOLS[p]}</option>)}
              </select>
              <span id="git-pool-why" className="sr-only">{PRIVATE_POOL}</span>
            </label>
          )}
        </fieldset>
        <ErrorText error={error} />
        <div className="row drawer-foot">
          <button type="submit" className="primary" disabled={busy || !ready}
            title={account && form.pool !== account.pool ? "A new pool takes its repositories from every thread that has them" : undefined}>
            {adding ? "Add account" : "Save"}
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
      {removing && account && (
        <ConfirmDialog title={`Remove “${account.name}”?`} sentence="Its repositories leave every project and thread that has them, at once."
          cancel="Keep" confirm="Remove" danger onCancel={() => setRemoving(false)}
          onConfirm={() => { setRemoving(false); void run(async () => { await del(u(userId, "git-accounts", account.name)); onRemoved(); }); }} />
      )}
      {offNetwork && (
        <ConfirmDialog title="Use a host outside your network?" sentence={offNetworkSentence(name)}
          confirm={offNetwork === "use" ? "Use anyway" : adding ? "Add anyway" : "Save anyway"} onCancel={() => setOffNetwork(undefined)}
          onConfirm={() => {
            const which = offNetwork;
            setOffNetwork(undefined);
            if (which === "save") void save(true);
            else void run(async () => { await post(u(userId, "git-accounts", account!.name, "confirm-off-network"), {}); onChanged(); });
          }} />
      )}
    </aside>
  );
}

/** The drawer's ⋯: rare actions, Remove last and in danger text. */
function DrawerMenu({ label, items }: { label: string; items: { label: string; danger?: boolean; onPick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <span className="row-menu" ref={ref}>
      <button type="button" className="icon sm" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" /></button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : ""} onClick={() => { close(); it.onPick(); }}>{it.label}</button>)}
        </div>
      )}
    </span>
  );
}

const same = (a: GitRepository, b: GitRepository) => a.name === b.name && a.account === b.account;

/** owner/name from a pasted https URL on one of these accounts' hosts, for each account there. */
export function fromUrl(text: string, accounts: GitAccountInfo[]): GitRepository[] {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return []; }
  if (url.protocol !== "https:") return [];
  const name = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (name.split("/").length < 2) return [];
  return accounts.filter((a) => a.host === url.host.toLowerCase()).map((a) => ({ name, account: a.name }));
}

/**
 * A thread's repositories, each `owner/name` in mono with its account's name
 * muted and an ✕; + (Add repository) opens a search of what each of the
 * pool's accounts can see, grouped by account, or takes a pasted URL. Also
 * on the Project settings page.
 */
export function Repositories({ userId, pool, granted, onChange }: { userId: string; pool: Pool; granted: GitRepository[]; onChange: (list: GitRepository[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useDismiss(anchor, open, close);
  const all = useLoad(() => get<GitAccountInfo[]>(u(userId, "git-accounts")), [userId]);
  const accounts = (all.data ?? []).filter((a) => a.pool === pool);
  // What each account can see, asked again as the search changes (an account that fails shows its error).
  const [found, setFound] = useState<Record<string, GitRepository[] | string>>({});
  useEffect(() => {
    if (!open) return;
    let live = true;
    const q = query.trim();
    const t = setTimeout(() => {
      for (const a of accounts.filter((x) => x.kind !== "other")) {
        get<GitRepository[]>(`${u(userId, "git-accounts", a.name, "repositories")}?q=${encodeURIComponent(q)}`)
          .then((list) => live && setFound((f) => ({ ...f, [a.name]: list })), (err: Error) => live && setFound((f) => ({ ...f, [a.name]: err.message })));
      }
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, query, userId, all.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pasted = fromUrl(query, accounts);
  const add = (r: GitRepository) => { if (!granted.some((g) => same(g, r))) onChange([...granted, r]); close(); plus.current?.focus(); };
  const choices = pasted.length ? pasted : accounts.flatMap((a) => (Array.isArray(found[a.name]) ? (found[a.name] as GitRepository[]) : []));
  const label = (name: string) => accounts.find((a) => a.name === name)?.name ?? name;
  return (
    <>
      {granted.map((r) => {
        const known = (all.data ?? []).some((a) => a.name === r.account && a.pool === pool);
        return (
          <div key={`${r.account}/${r.name}`} className="folder">
            <span className="path">{r.name}</span>
            <span className="muted small">{known ? label(r.account) : "removed"}</span>
            <button type="button" className="icon sm" aria-label={`Remove ${r.name}`} title={known ? undefined : "Its Git account is gone."}
              onClick={() => onChange(granted.filter((g) => !same(g, r)))}><Icon name="close" /></button>
          </div>
        );
      })}
      <span className="picker-anchor machine-add" ref={anchor}>
        <button ref={plus} type="button" className="icon sm" aria-label="Add repository" title="Add repository" aria-haspopup="dialog" aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}><Icon name="plus" /></button>
        {open && (
          <div className="picker repo-pick" role="dialog" aria-label="Add repository"
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); plus.current?.focus(); } }}>
            <input type="search" aria-label="Search repositories" placeholder="Search, or paste a URL" autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const first = choices.find((c) => !granted.some((g) => same(g, c))); if (first) add(first); } }} />
            {!accounts.length && all.data && <p className="muted small">No {pool} Git account yet</p>}
            {/* A pasted URL is listed under each account on its host, so the pick names the account. */}
            {(pasted.length ? accounts.filter((a) => pasted.some((r) => r.account === a.name)) : accounts).map((a) => {
                const list = pasted.length ? pasted.filter((r) => r.account === a.name) : found[a.name];
                return (
                  <div key={a.name} className="repo-group" role="group" aria-label={a.name}>
                    <div className="eyebrow">{a.name} <span className="muted small">· {a.host}</span></div>
                    {a.kind === "other" && !pasted.length ? <p className="muted small">Paste its URL.</p>
                      : typeof list === "string" ? <p className="muted small">{/rejected/i.test(list) ? "Token rejected" : /outside your network/i.test(list) ? "Off network" : "Unreachable"}, see Git accounts.</p>
                      : list === undefined ? <p className="muted small">Asking {a.host}…</p>
                      : !list.length ? <p className="muted small">No repository matches.</p>
                      : list.map((r) => <RepoItem key={r.name} r={r} granted={granted} onAdd={add} />)}
                  </div>
                );
              })}
            <a className="picker-foot" href={href({ page: "settings", userId, section: "git" })}>Git accounts ›</a>
          </div>
        )}
      </span>
    </>
  );
}

function RepoItem({ r, granted, onAdd }: { r: GitRepository; granted: GitRepository[]; onAdd: (r: GitRepository) => void }) {
  const has = granted.some((g) => same(g, r));
  return <button type="button" className="picker-item" disabled={has} title={has ? "Already here" : undefined} onClick={() => onAdd(r)}><span className="mono">{r.name}</span></button>;
}
