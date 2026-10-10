// The control panel: your profile and models, and the administrator's settings.
import { useState } from "react";
import {
  del, get, patch, post, put, u,
  type AdminStatus, type AllowedPaths, type EndpointInfo, type Me, type ModeDefault, type NetworkDefaults, type PersonaProposal,
  type Pool, type Probe, type Profiles, type ProposalDraft, type Pronouns, type SleepTime, type SshTargetInfo, type Task, type Theme, type UserCard,
} from "./api.ts";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import type { ShellContext } from "./Shell.tsx";
import { WebAccessSection } from "./WebAccess.tsx";
import { Confirm, ErrorText, Switch, useAction, useLoad } from "./ui.tsx";

const PRESETS: Record<string, Pronouns> = {
  "she/her": { subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself" },
  "he/him": { subj: "he", obj: "him", poss: "his", possPro: "his", refl: "himself" },
  "they/them": { subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themself" },
};
const TASKS: { task: Task; label: string }[] = [
  { task: "chat", label: "Main conversation" },
  { task: "subagent.cheap", label: "Cheap subagents" },
  { task: "subagent.strong", label: "Strong subagents" },
  { task: "title", label: "Titles" },
  { task: "embedding", label: "Embeddings" },
  { task: "sleep.consolidate", label: "Sleep: consolidate" },
  { task: "sleep.dream", label: "Sleep: dream" },
  { task: "sleep.wake", label: "Sleep: wake" },
];

export function Panel({ ctx }: { ctx: ShellContext }) {
  const admin = ctx.user.admin;
  const sections = ["Profile", "Password", "Your personas", "Your suggestions for Lyrica's persona", "Endpoints", "Model profiles", "Network", "SSH targets", ...(admin ? ["Server", "Web access", "Users", "Changes to Lyrica's persona"] : [])];
  return (
    <main className="main panel">
      <header className="head">
        <button type="button" className="menu-btn" aria-label="Show threads" onClick={ctx.openSide}>☰</button>
        <div className="head-title"><h1>Control panel</h1></div>
      </header>
      <div className="scroll panel-body">
        <nav className="panel-nav" aria-label="Sections">
          {sections.map((s) => <a key={s} href={`#panel-${slug(s)}`} onClick={(e) => { e.preventDefault(); document.getElementById(`panel-${slug(s)}`)?.scrollIntoView(); }}>{s}</a>)}
        </nav>
        <ProfileSection ctx={ctx} />
        <PasswordSection ctx={ctx} />
        <LinksSection ctx={ctx} />
        <DraftsSection ctx={ctx} />
        <EndpointsSection ctx={ctx} />
        <ProfilesSection ctx={ctx} />
        <NetworkSection ctx={ctx} />
        <SshSection ctx={ctx} />
        {admin && <ServerSection ctx={ctx} />}
        {admin && <Section title="Web access"><WebAccessSection userId={ctx.user.id} /></Section>}
        {admin && <UsersSection ctx={ctx} />}
        {admin && <ProposalsSection ctx={ctx} />}
      </div>
    </main>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/\W+/g, "-");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="card" id={`panel-${slug(title)}`} aria-labelledby={`h-${slug(title)}`}><h2 id={`h-${slug(title)}`}>{title}</h2>{children}</section>;
}

function PronounFields({ value, onChange }: { value: Pronouns; onChange: (p: Pronouns) => void }) {
  const preset = Object.entries(PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(value))?.[0] ?? "custom";
  return (
    <>
      <label className="field"><span>Pronouns</span>
        <select value={preset} onChange={(e) => { const p = PRESETS[e.target.value]; if (p) onChange(p); }}>
          {Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {preset === "custom" && (
        <div className="row wrap">
          {(["subj", "obj", "poss", "possPro", "refl"] as const).map((k) => (
            <label key={k} className="field narrow"><span>{{ subj: "she", obj: "her", poss: "her (book)", possPro: "hers", refl: "herself" }[k]}</span>
              <input value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
    </>
  );
}

function ProfileSection({ ctx }: { ctx: ShellContext }) {
  const { me } = ctx;
  const [name, setName] = useState(me.user.displayName);
  const [pronouns, setPronouns] = useState(me.user.pronouns);
  const [accent, setAccent] = useState(me.user.accent ?? "");
  const [monogram, setMonogram] = useState(me.user.monogram ?? "");
  const [run, busy, error] = useAction();
  const path = u(me.user.id, "me");
  const save = () => run(async () => ctx.setMe(await patch<Me>(`${path}/profile`, {
    displayName: name, pronouns, accent: accent || null, monogram: monogram || null,
  })));
  return (
    <Section title="Profile">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span>Display name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {me.previousNames.length > 0 && <p className="muted small">Before: {me.previousNames.map((p) => `${p.name} (until ${p.until.slice(0, 10)})`).join(", ")}</p>}
        <PronounFields value={pronouns} onChange={setPronouns} />
        <div className="row wrap top">
          <div className="field narrow swatch">
            <label className="field"><span>Accent colour</span>
              <input type="color" value={accent || "#1f6f78"} onChange={(e) => setAccent(e.target.value)} />
            </label>
            {accent && <button type="button" className="quiet small" onClick={() => setAccent("")}>Default colour</button>}
          </div>
          <label className="field narrow"><span>Monogram</span>
            <input maxLength={2} value={monogram} placeholder={name.slice(0, 2)} onChange={(e) => setMonogram(e.target.value)} />
          </label>
        </div>
        <ErrorText error={error} />
        <div className="row"><button className="primary" disabled={busy || !name.trim()}>Save profile</button></div>
      </form>
      <label className="field"><span>Theme</span>
        <select value={me.display.theme} onChange={(e) => run(async () => ctx.setMe(await patch<Me>(`${path}/display`, { theme: e.target.value as Theme })))}>
          <option value="device">Follow the device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <Switch label="Unlock me when Lyrica starts" checked={me.savedCredentials}
        hint="Saves your key with the server's credentials (sealed to its TPM where there is one), so sleep can run after a restart."
        onChange={(save) => run(async () => ctx.setMe(await put<Me>(`${path}/credentials`, { save })))} />
      <Switch label="Stay unlocked after logout" checked={me.stayUnlocked}
        hint="Keeps your key in memory when you log out, so sleep can run. Lock always drops it."
        onChange={(stayUnlocked) => run(async () => ctx.setMe(await put<Me>(`${path}/stay-unlocked`, { stayUnlocked })))} />
      {me.warning && <p className="warn-text" role="status">{me.warning}</p>}
    </Section>
  );
}

function PasswordSection({ ctx }: { ctx: ShellContext }) {
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const [run, busy, error] = useAction();
  const mismatch = again !== "" && again !== newPassword;
  return (
    <Section title="Password">
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => { await post(u(ctx.user.id, "me", "password"), { oldPassword, newPassword }); setOld(""); setNew(""); setAgain(""); setDone(true); });
      }}>
        <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} /></label>
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => { setNew(e.target.value); setDone(false); }} /></label>
        <label className="field"><span>New password again</span><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
        {mismatch && <p className="error">The new passwords don't match.</p>}
        {done && <p className="ok" role="status">Password changed.</p>}
        <ErrorText error={error} />
        <div className="row"><button className="primary" disabled={busy || !oldPassword || !newPassword || newPassword !== again}>Change password</button></div>
      </form>
    </Section>
  );
}

function EndpointsSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const eps = useLoad(() => get<EndpointInfo[]>(u(userId, "endpoints")), [userId]);
  const [run, busy, error] = useAction();
  const [form, setForm] = useState({ name: "", kind: "local" as "cloud" | "local", baseUrl: "", apiKey: "", shared: false });
  const add = () => run(async () => {
    await post(u(userId, "endpoints"), { ...form, apiKey: form.apiKey || undefined });
    setForm({ name: "", kind: "local", baseUrl: "", apiKey: "", shared: false });
    eps.reload();
  });
  return (
    <Section title="Endpoints">
      <ErrorText error={eps.error || error} />
      <ul className="list">
        {(eps.data ?? []).map((ep) => <EndpointRow key={ep.id} userId={userId} ep={ep} canEdit={!ep.shared || ctx.user.admin} onChange={eps.reload} />)}
      </ul>
      <form className="stack sub-card" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <h3>Add an endpoint</h3>
        <div className="row wrap">
          <label className="field"><span>Name</span><input value={form.name} placeholder="Blackwell host" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field narrow"><span>Kind</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "cloud" | "local" })}>
              <option value="local">Local</option><option value="cloud">Cloud</option>
            </select>
          </label>
        </div>
        <label className="field"><span>Base URL</span><input value={form.baseUrl} placeholder="http://192.168.1.50:1234/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <label className="field"><span>API key (optional)</span><input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
        {ctx.user.admin && <Switch label="Shared with every user" checked={form.shared} onChange={(shared) => setForm({ ...form, shared })} />}
        <p className="muted small">Local means on your own network: the LAN or your tailnet. You decide; Lyrica warns if a local endpoint looks public.</p>
        <div className="row"><button className="primary" disabled={busy || !form.name || !form.baseUrl}>Add endpoint</button></div>
      </form>
    </Section>
  );
}

function EndpointRow({ userId, ep, canEdit, onChange }: { userId: string; ep: EndpointInfo; canEdit: boolean; onChange: () => void }) {
  const path = u(userId, "endpoints", ep.id);
  const probe = useLoad(() => get<Probe>(`${path}/probe`), [path]);
  const [run, busy, error] = useAction();
  const [model, setModel] = useState("");
  return (
    <li className="endpoint">
      <div className="row between">
        <span><span className={`k ${ep.kind}`}>{ep.kind}</span> <b>{ep.name}</b>{ep.shared && <span className="muted"> · shared</span>}</span>
        <span className="probe" data-state={probe.data?.state ?? "unknown"}>{probe.data ? (probe.data.state === "up" ? "Up" : "Down") : probe.error ? "Unknown" : "Checking…"}</span>
      </div>
      <code className="url">{ep.baseUrl}</code>
      {probe.data?.warning && <p className="warn-text">{probe.data.warning}</p>}
      <p className="muted small">{ep.models.length ? ep.models.map((m) => m.modelId).join(", ") : "No models yet."}</p>
      <ErrorText error={error} />
      {canEdit && (
        <div className="row wrap">
          <button type="button" disabled={busy} onClick={() => run(async () => { await post(`${path}/discover`); onChange(); probe.reload(); })}>Read its models</button>
          <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`${path}/models`, { modelId: model }); setModel(""); onChange(); }); }}>
            <input aria-label={`Add a model to ${ep.name}`} placeholder="Model ID" value={model} onChange={(e) => setModel(e.target.value)} />
            <button disabled={!model || busy}>Add model</button>
          </form>
          <Confirm label="Remove" danger confirm="Remove it" question={`Remove ${ep.name}? Threads using its models fall back to the profile.`}
            onConfirm={() => run(async () => { await del(path); onChange(); })} />
        </div>
      )}
    </li>
  );
}

function ProfilesSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const profiles = useLoad(() => get<Profiles>(u(userId, "profiles")), [userId]);
  const eps = useLoad(() => get<EndpointInfo[]>(u(userId, "endpoints")), [userId]);
  const [run, , error] = useAction();
  if (!profiles.data) return <Section title="Model profiles"><ErrorText error={profiles.error} /></Section>;
  const set = (profile: "cloud" | "local" | "custom", task: Task, value: string) => run(async () => {
    profiles.set(await put<Profiles>(u(userId, "profiles", profile, task), { model: value ? { offeringId: value } : null }));
  });
  return (
    <Section title="Model profiles">
      <p className="muted">Threads use these unless they choose their own. Private and local-only threads use the local profile; general threads use the {profiles.data.default} profile.</p>
      <ErrorText error={error} />
      <div className="profiles">
        {(["local", "cloud", "custom"] as const).map((profile) => (
          <fieldset key={profile} className="group">
            <legend>{profile === "cloud" ? "Cloud profile" : profile === "local" ? "Local profile" : "Custom profile"}</legend>
            {TASKS.map(({ task, label }) => {
              const cur = profiles.data![profile][task];
              const first = Array.isArray(cur) && cur[0] && "offeringId" in cur[0] ? cur[0].offeringId : "";
              return (
                <label key={task} className="field"><span>{label}</span>
                  <select value={first} onChange={(e) => set(profile, task, e.target.value)}>
                    <option value="">{cur && !Array.isArray(cur) ? `Same as ${cur.same}` : "Not set"}</option>
                    {(eps.data ?? []).filter((ep) => profile === "custom" || ep.kind === profile).map((ep) => (
                      <optgroup key={ep.id} label={`${ep.name} (${ep.kind})`}>
                        {ep.models.map((m) => <option key={m.id} value={m.id}>{m.modelId}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
    </Section>
  );
}

function NetworkSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const net = useLoad(() => get<NetworkDefaults>(u(userId, "network")), [userId]);
  const mode = useLoad(() => get<ModeDefault>(u(userId, "mode")), [userId]);
  const [run, , error] = useAction();
  const [host, setHost] = useState<Record<Pool, string>>({ general: "", private: "" });
  if (!net.data) return <Section title="Network"><ErrorText error={net.error} /></Section>;
  const change = (pool: Pool, c: Partial<NetworkDefaults[Pool]>) => run(async () => net.set(await patch<NetworkDefaults>(u(userId, "network", pool), c)));
  return (
    <Section title="Network">
      <p className="muted">Defaults for new threads' tools. Each thread can change them in its settings.</p>
      <ErrorText error={error} />
      {mode.data && (
        <label className="field"><span>Mode</span>
          <select value={mode.data.mode} onChange={(e) => run(async () => mode.set(await put<ModeDefault>(u(userId, "mode"), { mode: e.target.value })))}>
            {MODE_ORDER.map((m) => <option key={m} value={m} title={MODES[m].description}>{MODES[m].label}</option>)}
          </select>
        </label>
      )}
      <div className="profiles">
        {(["general", "private"] as const).map((pool) => {
          const n = net.data![pool];
          return (
            <fieldset key={pool} className="group">
              <legend>{pool === "general" ? "General threads" : "Private threads"}</legend>
              <Switch label="Internet" checked={n.internet} onChange={(internet) => change(pool, { internet })} />
              <Switch label="This machine's services" checked={n.services} onChange={(services) => change(pool, { services })} />
              <div className="field"><span>Allowed hosts</span>
                <ul className="chips">{n.hosts.map((h) => <li key={h}>{h}<button type="button" className="quiet" aria-label={`Remove ${h}`} onClick={() => change(pool, { hosts: n.hosts.filter((x) => x !== h) })}>✕</button></li>)}</ul>
                <form className="inline" onSubmit={(e) => { e.preventDefault(); void change(pool, { hosts: [...n.hosts, host[pool].trim()] }).then((ok) => ok && setHost({ ...host, [pool]: "" })); }}>
                  <input aria-label={`Add an allowed host for ${pool} threads`} value={host[pool]} onChange={(e) => setHost({ ...host, [pool]: e.target.value })} />
                  <button disabled={!host[pool].trim()}>Add</button>
                </form>
              </div>
            </fieldset>
          );
        })}
      </div>
    </Section>
  );
}

function SshSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const targets = useLoad(() => get<SshTargetInfo[]>(u(userId, "ssh")), [userId]);
  const [run, busy, error] = useAction();
  const [form, setForm] = useState({ name: "", address: "", root: "" });
  return (
    <Section title="SSH targets">
      <p className="muted">Machines her commands can run on. Install each target's public key on its account.</p>
      <ErrorText error={targets.error || error} />
      <ul className="list">
        {(targets.data ?? []).map((t) => (
          <li key={t.name}>
            <div className="row between"><b>{t.name}</b><span className="muted">{t.username}@{t.host}:{t.port}{t.root && ` · ${t.root}`}</span></div>
            <label className="field"><span>Public key</span><textarea readOnly rows={2} value={t.publicKey} onFocus={(e) => e.target.select()} /></label>
            <p className="muted small">{t.hostKey ? `Host key ${t.hostKey}` : "Host key is pinned on first connection."}</p>
            <Confirm label="Remove" danger confirm="Remove it" question={`Remove ${t.name}? Threads that run commands there go back to the sandbox.`}
              onConfirm={() => run(async () => { await del(u(userId, "ssh", t.name)); targets.reload(); })} />
          </li>
        ))}
      </ul>
      <form className="stack sub-card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(u(userId, "ssh"), { ...form, root: form.root || undefined }); setForm({ name: "", address: "", root: "" }); targets.reload(); }); }}>
        <h3>Add a target</h3>
        <div className="row wrap">
          <label className="field"><span>Name</span><input value={form.name} placeholder="nas" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Address</span><input value={form.address} placeholder="lyrica@nas.lan:22" onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
          <label className="field"><span>Folder (optional)</span><input value={form.root} placeholder="/srv/share" onChange={(e) => setForm({ ...form, root: e.target.value })} /></label>
        </div>
        <div className="row"><button className="primary" disabled={busy || !form.name || !form.address}>Add target</button></div>
      </form>
    </Section>
  );
}

function ServerSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const status = useLoad(() => get<AdminStatus>(u(userId, "admin", "status")), [userId]);
  const sleep = useLoad(() => get<SleepTime>(u(userId, "admin", "sleep")), [userId]);
  const [run, busy, error] = useAction();
  const [passphrase, setPassphrase] = useState("");
  const [time, setTime] = useState<string>();
  const s = status.data;
  return (
    <Section title="Server">
      <ErrorText error={status.error || error} />
      {s?.networkRefused && (
        <div className="notice" role="alert">
          <b>Her tools have no network on this server.</b>
          <p>{s.networkRefused}</p>
        </div>
      )}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => sleep.set(await put<SleepTime>(u(userId, "admin", "sleep"), { time: time ?? sleep.data?.time }))); }}>
        <label className="field"><span>Sleep time</span><input type="time" value={time ?? sleep.data?.time ?? ""} onChange={(e) => setTime(e.target.value)} /></label>
        <button disabled={busy || !time || time === sleep.data?.time}>Save</button>
      </form>
      {s && (
        <div className="stack">
          <h3>Start unlocked</h3>
          {!s.credentials.available && <p className="muted small">This server can't save credentials{s.credentials.reason ? `: ${s.credentials.reason}` : "."}</p>}
          {s.savedPassphrase ? (
            <div className="row"><span>The passphrase is saved, so Lyrica starts unlocked.</span>
              <button type="button" disabled={busy} onClick={() => run(async () => status.set(await put<AdminStatus>(u(userId, "admin", "passphrase"), { save: false })))}>Forget it</button></div>
          ) : (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { status.set(await put<AdminStatus>(u(userId, "admin", "passphrase"), { save: true, passphrase })); setPassphrase(""); }); }}>
              <label className="field grow"><span>Save the passphrase</span><input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></label>
              <button disabled={busy || !passphrase || !s.credentials.available}>Save</button>
            </form>
          )}
        </div>
      )}
    </Section>
  );
}

function UsersSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const users = useLoad(() => get<UserCard[]>(u(userId, "admin", "users")), [userId]);
  const [run, busy, error] = useAction();
  const [form, setForm] = useState({ login: "", password: "", displayName: "", pronouns: PRESETS["she/her"]!, admin: false });
  return (
    <Section title="Users">
      <ErrorText error={users.error || error} />
      <ul className="list">
        {(users.data ?? []).map((x) => (
          <li key={x.id}>
            <div className="row between">
              <span><b>{x.displayName}</b> <span className="muted">({x.login})</span></span>
              <Switch label="Administrator" checked={x.admin}
                onChange={(admin) => run(async () => { await put(u(userId, "admin", "users", x.id, "admin"), { admin }); users.reload(); })} />
            </div>
            <AllowedPathsEditor userId={userId} target={x.id} />
          </li>
        ))}
      </ul>
      <form className="stack sub-card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(u(userId, "admin", "users"), form); setForm({ ...form, login: "", password: "", displayName: "" }); users.reload(); }); }}>
        <h3>Add a user</h3>
        <div className="row wrap">
          <label className="field"><span>Login name</span><input autoCapitalize="none" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} /></label>
          <label className="field"><span>Display name</span><input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        </div>
        <label className="field"><span>Password</span><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <PronounFields value={form.pronouns} onChange={(pronouns) => setForm({ ...form, pronouns })} />
        <Switch label="Administrator" checked={form.admin} onChange={(admin) => setForm({ ...form, admin })} />
        <div className="row"><button className="primary" disabled={busy || !form.login || !form.password || !form.displayName}>Add user</button></div>
      </form>
    </Section>
  );
}

function AllowedPathsEditor({ userId, target }: { userId: string; target: string }) {
  const path = u(userId, "admin", "users", target, "paths");
  const paths = useLoad(() => get<AllowedPaths>(path), [path]);
  const [run, , error] = useAction();
  const [draft, setDraft] = useState<Record<Pool, string>>({ general: "", private: "" });
  if (!paths.data) return <ErrorText error={paths.error} />;
  return (
    <details className="paths">
      <summary>Folders they may grant</summary>
      <ErrorText error={error} />
      {(["general", "private"] as const).map((pool) => (
        <div key={pool} className="field">
          <span>{pool === "general" ? "General threads" : "Private threads"}</span>
          <ul className="chips">
            {paths.data![pool].map((p) => (
              <li key={p}>{p}<button type="button" className="quiet" aria-label={`Remove ${p}`}
                onClick={() => run(async () => paths.set(await del<AllowedPaths>(path, { pool, path: p })))}>✕</button></li>
            ))}
          </ul>
          <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { paths.set(await post<AllowedPaths>(path, { pool, path: draft[pool] })); setDraft({ ...draft, [pool]: "" }); }); }}>
            <input aria-label={`Allow a folder for ${pool} threads`} placeholder="/srv/homelab" value={draft[pool]} onChange={(e) => setDraft({ ...draft, [pool]: e.target.value })} />
            <button disabled={!draft[pool]}>Allow</button>
          </form>
        </div>
      ))}
    </details>
  );
}

function ProposalsSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const proposals = useLoad(() => get<PersonaProposal[]>(u(userId, "admin", "proposals")), [userId]);
  const users = useLoad(() => get<UserCard[]>(u(userId, "admin", "users")), [userId]);
  const [run, busy, error] = useAction();
  const decide = (id: number, approve: boolean, overwrite?: boolean) =>
    run(async () => { await post(u(userId, "admin", "proposals", String(id)), { approve, ...(overwrite && { overwrite }) }); proposals.reload(); });
  const who = (sentBy: string) => users.data?.find((x) => `user:${x.id}` === sentBy)?.displayName ?? sentBy;
  return (
    <Section title="Changes to Lyrica's persona">
      <p className="muted">Suggestions for Lyrica's persona that users have sent on from their conversations.</p>
      <ErrorText error={proposals.error || error} />
      {proposals.data && !proposals.data.length && <p className="muted">No suggestions waiting.</p>}
      <ul className="list">
        {(proposals.data ?? []).map((p) => (
          <li key={p.id}>
            <div className="row between"><code>{p.path}</code><span className="muted small">Sent by {who(p.sentBy)} · {p.createdAt.slice(0, 10)}</span></div>
            {p.edited && <p className="muted small">{who(p.sentBy)} changed its text before sending it: the words are theirs.</p>}
            <p>{p.reason}</p>
            <div className="diff">
              <div><h4>Now</h4><pre>{p.current || "(new topic)"}</pre></div>
              <div><h4>Proposed</h4><pre>{p.text}</pre></div>
            </div>
            {p.stale ? (
              <div className="stack">
                <p className="warn-text">The file has changed since this was proposed. Approving replaces those changes.</p>
                <div className="row">
                  <Confirm label="Approve anyway" confirm="Replace the file" question={`Replace ${p.path}, including the changes made since this was proposed?`}
                    onConfirm={() => decide(p.id, true, true)} />
                  <button type="button" disabled={busy} onClick={() => decide(p.id, false)}>Reject</button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button type="button" className="primary" disabled={busy} onClick={() => decide(p.id, true)}>Approve</button>
                <button type="button" disabled={busy} onClick={() => decide(p.id, false)}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Users of the same person, linked with both passwords, can share a browser. */
function LinksSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const links = useLoad(() => get<UserCard[]>(u(userId, "links")), [userId]);
  const [run, busy, error] = useAction();
  const [form, setForm] = useState({ password: "", login: "", otherPassword: "" });
  return (
    <Section title="Your personas">
      <p className="muted">Link a separate persona of yours, another user you also log in as, so one browser can switch between them without a password. Linking needs both passwords.</p>
      <h3>Linked personas</h3>
      <ErrorText error={links.error || error} />
      <ul className="list">
        {(links.data ?? []).map((x) => (
          <li key={x.id} className="row between">
            <span><b>{x.displayName}</b> <span className="muted">({x.login})</span></span>
            <Confirm label="Unlink persona" danger confirm="Unlink persona" question={`Unlink ${x.displayName}? Browsers holding you both keep only you.`}
              onConfirm={() => run(async () => links.set(await del<UserCard[]>(u(userId, "links", x.id))))} />
          </li>
        ))}
        {links.data && !links.data.length && <li className="muted">No linked personas.</li>}
      </ul>
      <form className="stack sub-card" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => { links.set(await post<UserCard[]>(u(userId, "links"), form)); setForm({ password: "", login: "", otherPassword: "" }); });
      }}>
        <h3>Link a separate persona</h3>
        <label className="field"><span>Your password</span>
          <input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <div className="row wrap">
          <label className="field"><span>Its login name</span>
            <input autoCapitalize="none" autoComplete="off" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          </label>
          <label className="field"><span>Its password</span>
            <input type="password" autoComplete="off" value={form.otherPassword} onChange={(e) => setForm({ ...form, otherPassword: e.target.value })} />
          </label>
        </div>
        <div className="row"><button className="primary" disabled={busy || !form.password || !form.login || !form.otherPassword}>Link separate persona</button></div>
      </form>
    </Section>
  );
}

/** Suggestions for Lyrica's persona from this user's conversations: only they see them, until they send one on. */
function DraftsSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const drafts = useLoad(() => get<ProposalDraft[]>(u(userId, "proposals")), [userId]);
  const [run, , error] = useAction();
  return (
    <Section title="Your suggestions for Lyrica's persona">
      <p className="muted">Changes to her own persona that Lyrica suggested in your conversations. Administrators see a suggestion only after you send it on, so edit out anything private first.</p>
      <ErrorText error={drafts.error || error} />
      {drafts.data && !drafts.data.length && <p className="muted">No suggestions.</p>}
      <ul className="list">
        {(drafts.data ?? []).map((d) => (
          <Draft key={d.id} draft={d} path={u(userId, "proposals", String(d.id))} run={run} onChange={drafts.reload} />
        ))}
      </ul>
    </Section>
  );
}

function Draft({ draft, path, run, onChange }: {
  draft: ProposalDraft; path: string; run: (fn: () => Promise<unknown>) => Promise<boolean>; onChange: () => void;
}) {
  const [text, setText] = useState(draft.text);
  const [reason, setReason] = useState(draft.reason);
  const changed = text !== draft.text || reason !== draft.reason;
  return (
    <li className="stack">
      <div className="row between"><code>{draft.path}</code><span className="muted small">{draft.createdAt.slice(0, 10)}</span></div>
      <label className="field"><span>Why</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <label className="field"><span>Proposed text</span><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="row">
        <button type="button" disabled={!changed} onClick={() => run(async () => { await patch(path, { text, reason }); onChange(); })}>Save</button>
        <button type="button" className="primary" disabled={changed} title={changed ? "Save your changes first" : undefined}
          onClick={() => run(async () => { await post(`${path}/send`); onChange(); })}>Send to administrators</button>
        <Confirm label="Drop" danger confirm="Drop it" question="Drop this suggestion? It can't be brought back."
          onConfirm={() => run(async () => { await del(path); onChange(); })} />
      </div>
    </li>
  );
}
