// Settings (the user's own) and Administration (server-wide), each a page with
// its sections listed at the left. The old control panel's cards moved here.
import { useEffect, useRef, useState } from "react";
import {
  del, get, patch, post, put, u,
  type AdminStatus, type AllowedPaths, type EndpointInfo, type Me, type ModeDefault, type NetworkDefaults, type PersonaProposal,
  type OfferingInfo, type OfferingSettings, type Pool, type Probe, type Profiles, type ProposalDraft, type Pronouns, type SleepTime, type Task, type Theme, type UserCard,
  type NameSetting,
} from "./api.ts";
import { MachinesSection } from "./Machines.tsx";
import { her } from "./name.ts";
import { SleepModeField, SleepTimeSection } from "./Sleep.tsx";
import { TailnetSection } from "./Tailnet.tsx";
import { UpdatesSection } from "./Updates.tsx";
import { NotificationsSection } from "./Notifications.tsx";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import { href } from "./route.ts";
import { PageHead, type ShellContext } from "./Shell.tsx";
import { WebAccessSection } from "./WebAccess.tsx";
import { Confirm, ErrorText, Switch, useAction, useLoad } from "./ui.tsx";

export const PRESETS: Record<string, Pronouns> = {
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
  { task: "speech.transcribe", label: "Dictation" },
  { task: "speech.speak", label: "Read aloud" },
];
/** The models a task's select offers: speech tasks take only models that transcribe or speak. */
const fits = (task: Task, m: OfferingInfo) => (task === "speech.transcribe" ? !!m.transcribe : task === "speech.speak" ? !!m.speak?.voices.length : true);

/** `rest` is what follows the section's key in the hash (settings/machines/new → "new"), for a section with pages of its own. */
type SectionDef = { key: string; label: string; body: (ctx: ShellContext, rest: string) => React.ReactNode };

const SETTINGS: SectionDef[] = [
  { key: "notifications", label: "Notifications", body: (ctx) => <NotificationsSection ctx={ctx} /> },
  { key: "profile", label: "Profile", body: (ctx) => <ProfileSection ctx={ctx} /> },
  { key: "appearance", label: "Appearance", body: (ctx) => <AppearanceSection ctx={ctx} /> },
  { key: "unlock", label: "Unlock and lock", body: (ctx) => <UnlockSection ctx={ctx} /> },
  { key: "password", label: "Password", body: (ctx) => <PasswordSection ctx={ctx} /> },
  { key: "personas", label: "Your personas", body: (ctx) => <LinksSection ctx={ctx} /> },
  { key: "suggestions", label: "Persona suggestions", body: (ctx) => <DraftsSection ctx={ctx} /> },
  { key: "endpoints", label: "Endpoints", body: (ctx) => <EndpointsSection ctx={ctx} /> },
  { key: "profiles", label: "Model profiles", body: (ctx) => <ProfilesSection ctx={ctx} /> },
  { key: "network", label: "Network", body: (ctx) => <NetworkSection ctx={ctx} /> },
  { key: "machines", label: "Machines", body: (ctx, rest) => <MachinesSection ctx={ctx} rest={rest} /> },
];
const ADMIN: SectionDef[] = [
  { key: "status", label: "Status", body: (ctx) => <StatusSection ctx={ctx} /> },
  { key: "users", label: "Users", body: (ctx) => <UsersSection ctx={ctx} /> },
  { key: "sleep", label: "Sleep", body: (ctx) => <SleepTimeSection ctx={ctx} /> },
  { key: "unlocked", label: "Start unlocked", body: (ctx) => <UnlockedSection ctx={ctx} /> },
  { key: "tailnet", label: "Tailnet", body: (ctx) => <TailnetSection ctx={ctx} /> },
  { key: "web", label: "Web access", body: (ctx) => <Section title="Web access"><WebAccessSection userId={ctx.user.id} /></Section> },
  { key: "updates", label: "Updates", body: (ctx) => <UpdatesSection ctx={ctx} /> },
  { key: "persona", label: "Persona", body: (ctx) => <ProposalsSection ctx={ctx} /> },
];

/** The user's own settings: a page with its sections listed at the left (docs/ux.md §6). */
export function SettingsPage({ ctx, section }: { ctx: ShellContext; section?: string }) {
  return <Sections ctx={ctx} page="settings" title="Settings" sections={SETTINGS} current={section} />;
}

/** Server-wide settings, for administrators only. */
export function AdminPage({ ctx, section }: { ctx: ShellContext; section?: string }) {
  if (!ctx.user.admin) {
    return <main className="main"><PageHead ctx={ctx} title="Administration" /><div className="welcome"><p>Only administrators can change the server's settings.</p></div></main>;
  }
  return <Sections ctx={ctx} page="admin" title="Administration" sections={ADMIN} current={section} />;
}

function Sections({ ctx, page, title, sections, current }: { ctx: ShellContext; page: "settings" | "admin"; title: string; sections: SectionDef[]; current?: string }) {
  const [key, ...rest] = (current ?? "").split("/");
  const cur = sections.find((s) => s.key === key) ?? sections[0]!;
  return (
    <main className="main">
      <PageHead ctx={ctx} title={title} />
      <div className="page-body">
        <nav className="subnav" aria-label={`${title} sections`}>
          {sections.map((s) => <a key={s.key} href={href({ page, userId: ctx.user.id, section: s.key })} aria-current={s.key === cur.key ? "page" : undefined}>{s.label}</a>)}
        </nav>
        <div className="content">{cur.body(ctx, rest.join("/"))}</div>
      </div>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `h-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return <section className="card" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

export function PronounFields({ value, onChange }: { value: Pronouns; onChange: (p: Pronouns) => void }) {
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
        {me.previousNames.length > 0 && <p className="cap">Before: {me.previousNames.map((p) => `${p.name} (until ${p.until.slice(0, 10)})`).join(", ")}</p>}
        <PronounFields value={pronouns} onChange={setPronouns} />
        <div className="row wrap top">
          <div className="field narrow swatch">
            <label className="field"><span>Accent colour</span>
              <input type="color" value={accent || "#1f6f78"} onChange={(e) => setAccent(e.target.value)} />
            </label>
            {accent && <button type="button" className="link sm" onClick={() => setAccent("")}>Reset</button>}
          </div>
          <label className="field narrow"><span>Monogram</span>
            <input maxLength={2} value={monogram} placeholder={name.slice(0, 2)} onChange={(e) => setMonogram(e.target.value)} />
          </label>
        </div>
        <ErrorText error={error} />
        <div className="row"><button className="primary" disabled={busy || !name.trim()}>Save</button></div>
      </form>
    </Section>
  );
}

function AppearanceSection({ ctx }: { ctx: ShellContext }) {
  const { me } = ctx;
  const profiles = useLoad(() => get<Profiles>(u(me.user.id, "profiles")), [me.user.id]);
  const [run, , error] = useAction();
  return (
    <Section title="Appearance">
      <label className="field"><span>Theme</span>
        <select value={me.display.theme} onChange={(e) => run(async () => ctx.setMe(await patch<Me>(u(me.user.id, "me", "display"), { theme: e.target.value as Theme })))}>
          <option value="device">Follow the device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      {profiles.data && (
        <>
          <div className="eyebrow">Speech</div>
          <Switch label="Read aloud while agent writes" hint="Offers Read aloud on her reply while she is still writing it."
            checked={profiles.data.readAloudLive} onChange={(readAloudLive) => run(async () => profiles.set(await patch<Profiles>(u(me.user.id, "profiles"), { readAloudLive })))} />
        </>
      )}
      <ErrorText error={profiles.error || error} />
    </Section>
  );
}

function UnlockSection({ ctx }: { ctx: ShellContext }) {
  const { me } = ctx;
  const [run, , error] = useAction();
  const path = u(me.user.id, "me");
  return (
    <Section title="Unlock and lock">
      <Switch label={`Unlock me when ${her()} starts`} checked={me.savedCredentials}
        hint="Saves your key with the server's credentials, sealed to its TPM where there is one, so sleep can run after a restart."
        onChange={(save) => run(async () => ctx.setMe(await put<Me>(`${path}/credentials`, { save })))} />
      <Switch label="Stay unlocked after logout" checked={me.stayUnlocked}
        hint="Keeps your key in memory when you log out, so sleep can run. Lock always drops it."
        onChange={(stayUnlocked) => run(async () => ctx.setMe(await put<Me>(`${path}/stay-unlocked`, { stayUnlocked })))} />
      {me.warning && <p className="warn-text" role="status">{me.warning}</p>}
      <ErrorText error={error} />
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
        <p className="meta muted">There is no reset that keeps your data: a forgotten password loses it.</p>
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
        <h3>Add endpoint</h3>
        <div className="row wrap">
          <label className="field"><span>Name</span><input value={form.name} placeholder="Blackwell host" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field narrow"><span>Kind</span>
            <select value={form.kind} title={`Local means on your own network: the LAN or your tailnet. ${her()} warns if a local endpoint looks public.`} onChange={(e) => setForm({ ...form, kind: e.target.value as "cloud" | "local" })}>
              <option value="local">Local</option><option value="cloud">Cloud</option>
            </select>
          </label>
        </div>
        <label className="field"><span>Base URL</span><input value={form.baseUrl} placeholder="http://192.168.1.50:1234/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <label className="field"><span>API key</span><input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
        {ctx.user.admin && <Switch label="Shared" hint="Every user on this server can use it" checked={form.shared} onChange={(shared) => setForm({ ...form, shared })} />}
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
  const [voice, setVoice] = useState<OfferingInfo>();
  return (
    <li className="endpoint">
      <div className="row between">
        <span><span className={`k ${ep.kind}`}>{ep.kind}</span> <b>{ep.name}</b>{ep.shared && <span className="muted"> · shared</span>}</span>
        <span className="probe" data-state={probe.data?.state ?? "unknown"}>{probe.data ? (probe.data.state === "up" ? "Up" : "Down") : probe.error ? "Unknown" : "Checking…"}</span>
      </div>
      <code className="url">{ep.baseUrl}</code>
      {probe.data?.warning && <p className="warn-text">{probe.data.warning}</p>}
      <p className="meta muted models">
        {ep.models.length ? ep.models.map((m, i) => (
          <span key={m.id}>{i > 0 && ", "}{m.modelId}{m.speak?.voices.length ? <> <button type="button" className="link sm" aria-label={`${m.modelId} settings`} onClick={() => setVoice(m)}>Settings</button></> : null}</span>
        )) : "No models yet."}
      </p>
      {voice && <VoiceDrawer userId={userId} model={voice} onClose={() => setVoice(undefined)} />}
      {voice && <div className="scrim drawer-scrim" aria-hidden="true" onClick={() => setVoice(undefined)} />}
      <ErrorText error={error} />
      {canEdit && (
        <div className="row wrap">
          <button type="button" disabled={busy} onClick={() => run(async () => { await post(`${path}/discover`); onChange(); probe.reload(); })}>Read its models</button>
          <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`${path}/models`, { modelId: model }); setModel(""); onChange(); }); }}>
            <input aria-label={`Add a model to ${ep.name}`} placeholder="Model ID" value={model} onChange={(e) => setModel(e.target.value)} />
            <button disabled={!model || busy}>Add model</button>
          </form>
          <Confirm label="Remove" danger confirm="Remove" question={`Remove ${ep.name}? Threads using its models fall back to the profile.`}
            onConfirm={() => run(async () => { await del(path); onChange(); })} />
        </div>
      )}
    </li>
  );
}

const LANGUAGES: Record<string, string> = { en: "English", zh: "Mandarin" };
const MAX_SPEED = 4;
const MIN_SPEED = 0.25;

/** A speech model's Settings drawer: its voice per language and its speed, yours over the shared ones. */
function VoiceDrawer({ userId, model, onClose }: { userId: string; model: OfferingInfo; onClose: () => void }) {
  const path = u(userId, "offerings", model.id, "settings");
  const settings = useLoad(() => get<OfferingSettings>(path), [path]);
  const [run, busy, error] = useAction();
  const [speed, setSpeed] = useState<string>();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const voices = model.speak?.voices ?? [];
  const languages = [...new Set(voices.map((v) => v.language))];
  const s = settings.data;
  const save = (values: { voices?: Record<string, string> | null; speed?: number | null }) => run(async () => settings.set(await put<OfferingSettings>(path, { values })));
  const source = (k: "voices" | "speed") => s?.sources[k] && <span className="muted meta source"> {s.sources[k]}</span>;
  // The field clamps to its range when it is left; empty goes back to the default.
  const commitSpeed = () => {
    if (speed === undefined) return;
    const n = Number(speed);
    setSpeed(undefined);
    if (speed.trim() === "") { if (s?.values.speed !== undefined) void save({ speed: null }); return; }
    if (!Number.isFinite(n)) return;
    void save({ speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) });
  };
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={`${model.modelId} settings`}>
      <div className="drawer-head">
        <h2>{model.modelId}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="drawer-body">
        <ErrorText error={settings.error || error} />
        <fieldset className="group" disabled={!s || busy}>
          <legend>Voice{source("voices")}</legend>
          {languages.map((lang) => (
            <label key={lang} className="field"><span>{LANGUAGES[lang] ?? lang}</span>
              <select value={s?.values.voices?.[lang] ?? ""} onChange={(e) => save({ voices: { ...s?.values.voices, [lang]: e.target.value } })}>
                {!s?.values.voices?.[lang] && <option value="">Default</option>}
                {voices.filter((v) => v.language === lang).map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
              </select>
            </label>
          ))}
          {s?.sources.voices === "yours" && <button type="button" className="link sm" onClick={() => save({ voices: null })}>Reset</button>}
        </fieldset>
        <fieldset className="group" disabled={!s || busy}>
          <legend>Speed{source("speed")}</legend>
          <div className="field">
            <span className="unit-field">
              <input type="number" inputMode="decimal" min={MIN_SPEED} max={MAX_SPEED} step={0.05} placeholder="1" aria-label="Speed"
                value={speed ?? s?.values.speed ?? ""} onChange={(e) => setSpeed(e.target.value)} onBlur={commitSpeed}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitSpeed(); } }} />
              <span className="muted meta">of {MAX_SPEED}</span>
            </span>
          </div>
          {s?.sources.speed === "yours" && <button type="button" className="link sm" onClick={() => save({ speed: null })}>Reset</button>}
        </fieldset>
      </div>
    </aside>
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
      <p className="meta muted">General threads: {profiles.data.default} profile. Private and local-only threads: local profile.</p>
      <ErrorText error={error} />
      <SleepModeField ctx={ctx} />
      <Switch label="Sleep fallback" hint="When off, each sleep phase uses its first model only; if that one is away, sleep waits for the next night."
        checked={profiles.data.sleepFallback} onChange={(sleepFallback) => run(async () => profiles.set(await patch<Profiles>(u(userId, "profiles"), { sleepFallback })))} />
      <div className="profiles">
        {(["local", "cloud", "custom"] as const).map((profile) => (
          <fieldset key={profile} className="group">
            <legend>{profile === "cloud" ? "Cloud profile" : profile === "local" ? "Local profile" : "Custom profile"}</legend>
            {/* Dictation without a thread's own pick always uses the local profile's, so only Local offers it. */}
            {TASKS.filter(({ task }) => task !== "speech.transcribe" || profile === "local").map(({ task, label }) => {
              const cur = profiles.data![profile][task];
              const first = Array.isArray(cur) && cur[0] && "offeringId" in cur[0] ? cur[0].offeringId : "";
              return (
                <label key={task} className="field"><span>{label}</span>
                  <select value={first} onChange={(e) => set(profile, task, e.target.value)}>
                    <option value="">{cur && !Array.isArray(cur) ? `Same as ${cur.same}` : "Not set"}</option>
                    {(eps.data ?? []).filter((ep) => profile === "custom" || ep.kind === profile).map((ep) => (
                      <optgroup key={ep.id} label={`${ep.name} (${ep.kind})`}>
                        {ep.models.filter((m) => fits(task, m)).map((m) => <option key={m.id} value={m.id}>{m.modelId}</option>)}
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
  const profiles = useLoad(() => get<Profiles>(u(userId, "profiles")), [userId]);
  const [run, , error] = useAction();
  const [host, setHost] = useState<Record<Pool, string>>({ general: "", private: "" });
  if (!net.data) return <Section title="Network"><ErrorText error={net.error} /></Section>;
  const change = (pool: Pool, c: Partial<NetworkDefaults[Pool]>) => run(async () => net.set(await patch<NetworkDefaults>(u(userId, "network", pool), c)));
  return (
    <Section title="Network">
      <ErrorText error={error} />
      <div className="eyebrow">New threads</div>
      <div className="row top defaults">
        {mode.data && (
          <label className="field"><span>Mode</span>
            <select value={mode.data.mode} onChange={(e) => run(async () => mode.set(await put<ModeDefault>(u(userId, "mode"), { mode: e.target.value })))}>
              {MODE_ORDER.map((m) => <option key={m} value={m} title={MODES[m].description}>{MODES[m].label}</option>)}
            </select>
          </label>
        )}
        {profiles.data && (
          <Switch label="Fallback" hint="When off, only the first model in each list answers; if it can't, the message waits for it."
            checked={profiles.data.fallback} onChange={(fallback) => run(async () => profiles.set(await patch<Profiles>(u(userId, "profiles"), { fallback })))} />
        )}
      </div>
      <div className="profiles">
        {(["general", "private"] as const).map((pool) => {
          const n = net.data![pool];
          return (
            <fieldset key={pool} className="group">
              <legend>{pool === "general" ? "General threads" : "Private threads"}</legend>
              <Switch label="Internet" checked={n.internet} onChange={(internet) => change(pool, { internet })} />
              <Switch label="Local services (localhost)" hint={`Programs running on ${her()}'s own server, such as a database. Never ${her()}'s own page.`} checked={n.services} onChange={(services) => change(pool, { services })} />
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


function StatusSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const status = useLoad(() => get<AdminStatus>(u(userId, "admin", "status")), [userId]);
  const sleep = useLoad(() => get<SleepTime>(u(userId, "admin", "sleep")), [userId]);
  const s = status.data;
  return (
    <Section title="Status">
      <ErrorText error={status.error} />
      {s?.networkRefused && (
        <div className="notice" role="alert">
          <b>Her tools have no network on this server.</b>
          <p>{s.networkRefused}</p>
        </div>
      )}
      <dl className="facts">
        <dt>Her tools' network</dt><dd>{s ? (s.networkRefused ? <span className="status-word"><span className="dot down" />Refused</span> : <span className="status-word"><span className="dot up" />Self-test passed</span>) : "…"}</dd>
        <dt>Sleep time</dt><dd className="num">{sleep.data?.time ?? "…"}</dd>
        <dt>Start unlocked</dt><dd>{s ? (s.savedPassphrase ? "Passphrase saved" : "Passphrase not saved") : "…"}</dd>
      </dl>
    </Section>
  );
}

function UnlockedSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const status = useLoad(() => get<AdminStatus>(u(userId, "admin", "status")), [userId]);
  const [run, busy, error] = useAction();
  const [passphrase, setPassphrase] = useState("");
  const s = status.data;
  return (
    <Section title="Start unlocked">
      <ErrorText error={status.error || error} />
      {s && !s.credentials.available && <p className="meta muted">This server can't save credentials{s.credentials.reason ? `: ${s.credentials.reason}` : "."}</p>}
      {s?.savedPassphrase ? (
        <div className="row"><span>The passphrase is saved, so {her()} starts unlocked.</span>
          <button type="button" className="danger" disabled={busy} onClick={() => run(async () => status.set(await put<AdminStatus>(u(userId, "admin", "passphrase"), { save: false })))}>Forget it</button></div>
      ) : s && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { status.set(await put<AdminStatus>(u(userId, "admin", "passphrase"), { save: true, passphrase })); setPassphrase(""); }); }}>
          <label className="field grow"><span>Passphrase</span><input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></label>
          <button className="primary" disabled={busy || !passphrase || !s.credentials.available}>Save</button>
        </form>
      )}
    </Section>
  );
}

/** Change password… on a user's row (docs/ux.md §6, editing in place): the new password, the administrator's own, one button; the user's data stays. */
function PasswordSetter({ userId, target }: { userId: string; target: UserCard }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [own, setOwn] = useState("");
  const [done, setDone] = useState(false);
  const [run, busy, error] = useAction();
  if (!open) {
    return (
      <div className="row">
        <button type="button" className="sm" onClick={() => { setOpen(true); setDone(false); }}>Change password…</button>
        {done && <span className="muted small" role="status">Password changed. {target.displayName} is logged out and told at their next visit.</span>}
      </div>
    );
  }
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await put(u(userId, "admin", "users", target.id, "password"), { password, yourPassword: own }); setPassword(""); setOwn(""); setOpen(false); setDone(true); }); }}>
      <label className="field"><span>New password for {target.displayName}</span>
        <input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="field"><span>Your password</span>
        <input type="password" autoComplete="current-password" value={own} onChange={(e) => setOwn(e.target.value)} />
      </label>
      <button type="submit" className="primary sm" disabled={busy || !password || !own}>Change password</button>
      <button type="button" className="sm" onClick={() => { setOpen(false); setPassword(""); setOwn(""); }}>Cancel</button>
      <ErrorText error={error} />
    </form>
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
            {x.id !== userId && <PasswordSetter userId={userId} target={x} />}
            <AllowedPathsEditor userId={userId} target={x.id} />
          </li>
        ))}
      </ul>
      <form className="stack sub-card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(u(userId, "admin", "users"), form); setForm({ ...form, login: "", password: "", displayName: "" }); users.reload(); }); }}>
        <h3>Add user</h3>
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

/** Her name (docs/ux.md §6 "Her name"): one field and one Save, with its one sentence, above the persona changes. */
function NameForm({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const current = useLoad(() => get<NameSetting>(u(userId, "admin", "name")), [userId]);
  const [name, setName] = useState<string>();
  const [run, busy, error] = useAction();
  const value = name ?? current.data?.name ?? "";
  const changed = !!current.data && value.trim() !== current.data.name && value.trim() !== "";
  return (
    <form className="stack sub-card" onSubmit={(e) => { e.preventDefault(); void run(async () => { current.set(await put<NameSetting>(u(userId, "admin", "name"), { name: value.trim() })); setName(undefined); ctx.refreshState(); }); }}>
      <ErrorText error={current.error || error} />
      <div className="inline">
        <label className="field grow"><span>Name</span><input value={value} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <button className="primary" disabled={busy || !changed}>Save</button>
      </div>
      {changed && current.data && <p className="muted small">Memories and threads written so far keep the name {current.data.name}.</p>}
    </form>
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
    <Section title="Persona">
      <NameForm ctx={ctx} />
      <h3>Changes to her persona</h3>
      <ErrorText error={proposals.error || error} />
      {proposals.data && !proposals.data.length && <p className="muted">No suggestions waiting.</p>}
      <ul className="list">
        {(proposals.data ?? []).map((p) => (
          <li key={p.id}>
            <div className="row between"><code>{p.path}</code><span className="meta muted">Sent by {who(p.sentBy)} · <span className="num">{p.createdAt.slice(0, 10)}</span></span></div>
            {p.edited && <p className="meta muted">{who(p.sentBy)} changed its text before sending it: the words are theirs.</p>}
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
      <ErrorText error={links.error || error} />
      <ul className="list">
        {(links.data ?? []).map((x) => (
          <li key={x.id} className="row between">
            <span><b>{x.displayName}</b> <span className="muted">({x.login})</span></span>
            <Confirm label="Unlink" danger confirm="Unlink" question={`Unlink ${x.displayName}? Browsers holding you both keep only you.`}
              onConfirm={() => run(async () => links.set(await del<UserCard[]>(u(userId, "links", x.id))))} />
          </li>
        ))}
        {links.data && !links.data.length && <li className="muted">No linked personas.</li>}
      </ul>
      <form className="stack sub-card" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => { links.set(await post<UserCard[]>(u(userId, "links"), form)); setForm({ password: "", login: "", otherPassword: "" }); });
      }}>
        <h3>Link separate persona</h3>
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
    <Section title={`Your suggestions for ${her()}'s persona`}>
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
        <button type="button" className="primary" disabled={changed} title={changed ? "Save your changes first. Administrators see it only once you send it on, so edit out anything private." : "Administrators see it only once you send it on, so edit out anything private."}
          onClick={() => run(async () => { await post(`${path}/send`); onChange(); })}>Send to administrators</button>
        <Confirm label="Drop" danger confirm="Drop" question="Drop this suggestion? It can't be brought back."
          onConfirm={() => run(async () => { await del(path); onChange(); })} />
      </div>
    </li>
  );
}
