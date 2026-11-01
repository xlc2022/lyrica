// MCP servers (DESIGN.md "MCP servers", docs/ux.md §6): the MCP servers
// section of Settings with a row per server and its drawer (Add server opens
// the same drawer with a Token or Environment field), and the MCP servers
// list the thread drawer and Project settings share. Copied from Git accounts
// and Repositories. A server is a URL or a command (a local server, started
// in the thread's sandbox); the drawer takes one of the two.
import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, HttpError, patch, post, u, type McpServerChange, type McpServerInfo, type McpServerInput, type Pool } from "./api.ts";
import { DrawerMenu } from "./Git.tsx";
import { Icon } from "./icons.tsx";
import { duration } from "./Machines.tsx";
import { href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, useAction, useDismiss, useLoad } from "./ui.tsx";

const POOLS: Record<Pool, string> = { general: "General", private: "Private" };
const PRIVATE_POOL = "A private server must be on your own network: LAN, this machine or the tailnet.";
const COMMAND_TIP = "A local server: the program and its arguments, started in the thread's sandbox with the thread's folders and network. Give a URL or a command, not both.";
const ENV_TIP = "The program's own variables, one KEY=value per line, such as its API keys. Never shown again.";

/** At most one state per row: Online, Token rejected, Unreachable with how long, or Off network for a private one. */
export function mcpState(m: McpServerInfo, now = Date.now()): { tone: "ok" | "warn" | "bad"; word: string; detail?: string } | undefined {
  if (m.state?.kind === "rejected") return { tone: "bad", word: "Token rejected" };
  if (m.state?.kind === "unreachable") return { tone: "warn", word: "Unreachable", detail: duration(now - Date.parse(m.state.since)) };
  if (m.offNetwork && m.pool === "private") return { tone: "warn", word: "Off network" };
  if (m.state?.kind === "online") return { tone: "ok", word: "Online" };
  return undefined;
}

const DOT: Record<"ok" | "warn" | "bad", string> = { ok: "up", warn: "away", bad: "down" };

function StateWord({ m }: { m: McpServerInfo }) {
  const state = mcpState(m);
  if (!state) return null;
  return <span className="state-word"><span className={`dot ${DOT[state.tone]}`} aria-hidden="true" />{state.word}{state.detail && <span className="num mono"> {state.detail}</span>}</span>;
}

/** The facts line under a server's name: host, pool and tool count. */
const facts = (m: McpServerInfo) => <>{m.host} · {m.pool} · {m.tools} {m.tools === 1 ? "tool" : "tools"}</>;

const offNetworkSentence = (name: string) => `${name}'s host is outside your network, so a private thread's requests would leave it.`;

export function McpServersSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const servers = useLoad(() => get<McpServerInfo[]>(u(userId, "mcp-servers")), [userId]);
  const [open, setOpen] = useState<string | { adding: true }>();
  const list = servers.data ?? [];
  const current = typeof open === "string" ? list.find((m) => m.name === open) : undefined;
  const close = useCallback(() => setOpen(undefined), []);
  return (
    <section className="card" aria-labelledby="h-mcp">
      <h2 id="h-mcp">MCP servers</h2>
      <ErrorText error={servers.error} />
      {servers.data && !list.length && <p className="muted">None yet.</p>}
      {list.length > 0 && (
        <ul className="list machines">
          {list.map((m) => (
            <li key={m.name} className="machine-row git-row">
              <button type="button" className="machine-open" aria-haspopup="dialog" aria-expanded={open === m.name} onClick={() => setOpen(m.name)}>
                <span className="machine-name">{m.name}</span>
                <span className="machine-facts">{facts(m)}</span>
              </button>
              <StateWord m={m} />
            </li>
          ))}
        </ul>
      )}
      <div className="row"><button type="button" onClick={() => setOpen({ adding: true })}><Icon name="plus" /> Add server</button></div>
      {(current || (open && typeof open !== "string")) && (
        <>
          <McpDrawer key={current?.name ?? "new"} userId={userId} server={current} onClose={close}
            onSaved={() => { servers.reload(); close(); }} onChanged={() => servers.reload()} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={close} />
        </>
      )}
    </section>
  );
}

/**
 * One server's drawer: Name, URL or Command, and Pool, with Replace token
 * (a URL) or Replace environment (a command) and Remove behind ⋯. Without
 * `server` it is Add server: a Token field (optional) or an Environment
 * field too, and the server is checked before the row is saved.
 */
function McpDrawer({ userId, server, onSaved, onChanged, onClose }: {
  userId: string; server?: McpServerInfo; onSaved: () => void; onChanged: () => void; onClose: () => void;
}) {
  const adding = !server;
  const [form, setForm] = useState({ name: server?.name ?? "", url: server?.url ?? "", command: server?.command ?? "", pool: server?.pool ?? "general" as Pool, token: "", env: "" });
  const [replacing, setReplacing] = useState(false);
  const local = !!form.command.trim();
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
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const change: McpServerChange = server ? {
    ...(form.name.trim() !== server.name ? { name: form.name.trim() } : {}),
    ...(form.url.trim() !== server.url ? { url: form.url.trim() } : {}),
    ...(form.command.trim() !== server.command ? { command: form.command.trim() } : {}),
    ...(form.pool !== server.pool ? { pool: form.pool } : {}),
  } : {};
  const one = !!form.url.trim() !== local;
  const ready = adding ? !!(form.name.trim() && one) : replacing ? true : Object.keys(change).length > 0 && one;
  const outside = (err: unknown) => err instanceof HttpError && /outside your network/.test(err.message);
  const save = (offNetworkConfirmed = false) => run(async () => {
    try {
      if (adding) {
        const input: McpServerInput = local
          ? { name: form.name.trim(), command: form.command.trim(), pool: form.pool, ...(form.env.trim() ? { env: form.env } : {}) }
          : { name: form.name.trim(), url: form.url.trim(), pool: form.pool, offNetworkConfirmed, ...(form.token.trim() ? { token: form.token.trim() } : {}) };
        await post<McpServerInfo>(u(userId, "mcp-servers"), input);
      } else if (replacing && server.command) {
        await post<McpServerInfo>(u(userId, "mcp-servers", server.name, "env"), { env: form.env });
      } else if (replacing) {
        await post<McpServerInfo>(u(userId, "mcp-servers", server.name, "token"), { token: form.token.trim() });
      } else {
        await patch<McpServerInfo>(u(userId, "mcp-servers", server.name), { ...change, offNetworkConfirmed });
      }
    } catch (err) {
      if (outside(err) && !offNetworkConfirmed) { setOffNetwork("save"); return; }
      throw err;
    }
    onSaved();
  });
  const name = form.name.trim() || "This server";
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={adding ? "Add server" : server.name}>
      <div className="drawer-head">
        <h2>{adding ? "Add server" : server.name}</h2>
        {server && <DrawerMenu label={`Actions for ${server.name}`} items={[
          { label: server.command ? "Replace environment" : "Replace token", onPick: () => setReplacing(true) },
          ...(server.pool === "private" && server.offNetwork && !server.state ? [{ label: "Use anyway", onPick: () => setOffNetwork("use") }] : []),
          { label: "Remove", danger: true, onPick: () => setRemoving(true) },
        ]} />}
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
        {server && <StateWord m={server} />}
        <fieldset className="group" disabled={busy}>
          <label className="field"><span>Name</span><input value={form.name} autoFocus={adding} spellCheck={false} onChange={(e) => set("name", e.target.value)} /></label>
          {!(replacing && server?.command) && (
            <label className="field"><span>URL</span>
              <input className="mono" value={form.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} disabled={replacing || local} onChange={(e) => set("url", e.target.value)} />
            </label>
          )}
          {!(replacing && server && !server.command) && (
            <label className="field"><span>Command</span>
              <input className="mono" value={form.command} placeholder="ebay-mcp-server" spellCheck={false} disabled={replacing || !!form.url.trim()} title={COMMAND_TIP} onChange={(e) => set("command", e.target.value)} />
            </label>
          )}
          {(adding || replacing) && !(local || server?.command) && (
            <label className="field"><span>Token</span>
              <input className="mono" type="password" value={form.token} autoComplete="off" spellCheck={false} autoFocus={replacing}
                placeholder="Optional" title="Sent as a bearer token. Leave it empty for a server that takes none." onChange={(e) => set("token", e.target.value)} />
            </label>
          )}
          {(adding || replacing) && (local || server?.command) && (
            <label className="field"><span>Environment</span>
              <textarea className="mono" rows={3} value={form.env} autoComplete="off" spellCheck={false} autoFocus={replacing}
                placeholder={"KEY=value"} title={ENV_TIP} onChange={(e) => set("env", e.target.value)} />
            </label>
          )}
          <label className="field"><span>Pool</span>
            <select value={form.pool} disabled={replacing} aria-describedby="mcp-pool-why" onChange={(e) => set("pool", e.target.value)}>
              {(Object.keys(POOLS) as Pool[]).map((p) => <option key={p} value={p}>{POOLS[p]}</option>)}
            </select>
          </label>
          <p id="mcp-pool-why" className="muted small">{PRIVATE_POOL}</p>
        </fieldset>
        <ErrorText error={error} />
        <div className="row drawer-foot">
          <button type="submit" className="primary" disabled={busy || !ready}
            title={server && form.pool !== server.pool ? "A new pool takes it from every thread that has it" : undefined}>
            {adding ? "Add server" : "Save"}
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
      {removing && server && (
        <ConfirmDialog title={`Remove “${server.name}”?`} sentence="It leaves every project and thread that has it, at once."
          cancel="Keep" confirm="Remove" danger onCancel={() => setRemoving(false)}
          onConfirm={() => { setRemoving(false); void run(async () => { await del(u(userId, "mcp-servers", server.name)); onSaved(); }); }} />
      )}
      {offNetwork && (
        <ConfirmDialog title="Use a host outside your network?" sentence={offNetworkSentence(name)}
          confirm={offNetwork === "use" ? "Use anyway" : adding ? "Add anyway" : "Save anyway"} onCancel={() => setOffNetwork(undefined)}
          onConfirm={() => {
            const which = offNetwork;
            setOffNetwork(undefined);
            if (which === "save") void save(true);
            else void run(async () => { await post(u(userId, "mcp-servers", server!.name, "confirm-off-network"), {}); onChanged(); });
          }} />
      )}
    </aside>
  );
}

/**
 * A thread's MCP servers, each name in mono with its host muted and an ✕;
 * + (Add server) opens a search of the pool's other servers. Also on the
 * Project settings page.
 */
export function McpServers({ userId, pool, granted, onChange }: { userId: string; pool: Pool; granted: string[]; onChange: (names: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useDismiss(anchor, open, close);
  const all = useLoad(() => get<McpServerInfo[]>(u(userId, "mcp-servers")), [userId]);
  const mine = (all.data ?? []).filter((m) => m.pool === pool);
  const q = query.trim().toLowerCase();
  const choices = mine.filter((m) => !granted.includes(m.name) && (!q || m.name.toLowerCase().includes(q) || m.host.toLowerCase().includes(q)));
  const add = (name: string) => { onChange([...granted, name]); close(); plus.current?.focus(); };
  return (
    <>
      {granted.map((name) => {
        const m = mine.find((x) => x.name === name);
        return (
          <div key={name} className="folder">
            <span className="path">{name}</span>
            <span className="muted small">{m ? m.host : all.data ? "removed" : ""}</span>
            <button type="button" className="icon sm" aria-label={`Remove ${name}`} onClick={() => onChange(granted.filter((g) => g !== name))}><Icon name="close" /></button>
          </div>
        );
      })}
      <span className="picker-anchor machine-add" ref={anchor}>
        <button ref={plus} type="button" className="icon sm" aria-label="Add server" title="Add server" aria-haspopup="dialog" aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}><Icon name="plus" /></button>
        {open && (
          <div className="picker repo-pick" role="dialog" aria-label="Add server"
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); plus.current?.focus(); } }}>
            <input type="search" aria-label="Search MCP servers" placeholder="Search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (choices[0]) add(choices[0].name); } }} />
            {all.data && !mine.length && <p className="muted small">No {pool} MCP server yet</p>}
            {mine.length > 0 && !choices.length && <p className="muted small">No other server matches.</p>}
            {choices.map((m) => (
              <button key={m.name} type="button" className="picker-item" onClick={() => add(m.name)}>
                <span className="mono">{m.name}</span> <span className="muted small">{m.host}</span>
              </button>
            ))}
            <a className="picker-foot" href={href({ page: "settings", userId, section: "mcp" })}>MCP servers ›</a>
          </div>
        )}
      </span>
    </>
  );
}
