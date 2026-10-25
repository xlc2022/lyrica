import { StaleUnitsLine } from "./StaleUnitsLine.tsx";
import { ModelCallFacts } from "./ModelCallFacts.tsx";
// Settings (the user's own) and Administration (server-wide), each a page with
// its sections listed at the left. The old control panel's cards moved here.
import { useState } from "react";
import {
  del, get, HttpError, patch, post, put, saveName, u,
  type AdminStatus, type AllowedPaths, type Me, type ModeDefault, type NetworkDefaults, type PersonaProposal,
  type Pool, type Presets, type ProposalDraft, type Pronouns, type SleepTime, type Theme, type UserCard,
  type NameSetting,
} from "./api.ts";
import { PushSection } from "./Push.tsx";
import { RoutinesSection } from "./Routines.tsx";
import { SkillsSection } from "./Skills.tsx";
import { ClaudeCodeSection } from "./ClaudeCode.tsx";
import { CodexSection } from "./Codex.tsx";
import { GitAccountsSection } from "./Git.tsx";
import { McpServersSection } from "./Mcp.tsx";
import { MachinesSection } from "./Machines.tsx";
import { PortraitPhotosSection } from "./PortraitPhotos.tsx";
import { checkName, her, setHer } from "./name.ts";
import { SleepModeField, SleepTimeSection } from "./Sleep.tsx";
import { TailnetSection } from "./Tailnet.tsx";
import { UpdatesSection } from "./Updates.tsx";
import { MODE_ORDER, MODES } from "./Modes.tsx";
import { href } from "./route.ts";
import { PageHead, type ShellContext } from "./Shell.tsx";
import { WebAccessSection } from "./WebAccess.tsx";
import { WebSearchSection } from "./WebSearch.tsx";
import { WipeSection } from "./Wipe.tsx";
import { browserZone, Confirm, ErrorText, Prose, Switch, useAction, useLoad } from "./ui.tsx";

export const PRESETS: Record<string, Pronouns> = {
  "she/her": { subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself" },
  "he/him": { subj: "he", obj: "him", poss: "his", possPro: "his", refl: "himself" },
  "they/them": { subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themself" },
};
/** `rest` is what follows the section's key in the hash (settings/machines/new → "new"), for a section with pages of its own. */
/** `aliases`: older keys that open the same section. */
type SectionDef = { key: string; label: string; aliases?: string[]; body: (ctx: ShellContext, rest: string) => React.ReactNode };

const SETTINGS: SectionDef[] = [
  { key: "profile", label: "Profile", body: (ctx) => <ProfileSection ctx={ctx} /> },
  { key: "appearance", label: "Appearance", body: (ctx) => <AppearanceSection ctx={ctx} /> },
  { key: "push", label: "Push", body: (ctx) => <PushSection key={ctx.user.id} userId={ctx.user.id} /> },
  { key: "unlock", label: "Unlock and lock", body: (ctx) => <UnlockSection ctx={ctx} /> },
  { key: "password", label: "Password", body: (ctx) => <PasswordSection ctx={ctx} /> },
  { key: "personas", label: "Your personas", body: (ctx) => <LinksSection ctx={ctx} /> },
  { key: "suggestions", label: "Persona suggestions", body: (ctx) => <DraftsSection ctx={ctx} /> },
  { key: "sleep", label: "Sleep", body: (ctx) => <SleepSection ctx={ctx} /> },
  { key: "network", label: "Network", body: (ctx) => <NetworkSection ctx={ctx} /> },
  { key: "machines", label: "Machines", body: (ctx, rest) => <MachinesSection ctx={ctx} rest={rest} /> },
  { key: "git", label: "Git accounts", body: (ctx) => <GitAccountsSection ctx={ctx} /> },
  { key: "mcp", label: "MCP servers", body: (ctx) => <McpServersSection ctx={ctx} /> },
  { key: "claude-code", label: "Claude Code and Codex", aliases: ["codex"], body: (ctx) => <><ClaudeCodeSection ctx={ctx} /><CodexSection ctx={ctx} /></> },
  { key: "routines", label: "Routines", body: (ctx) => <RoutinesSection ctx={ctx} /> },
  { key: "skills", label: "Skills", body: (ctx) => <SkillsSection ctx={ctx} /> },
  { key: "portraits", label: "Portrait photos", body: (ctx) => <PortraitPhotosSection key={ctx.user.id} userId={ctx.user.id} /> },
  { key: "reset", label: "Reset", body: (ctx) => <WipeSection ctx={ctx} mine /> },
];
const ADMIN: SectionDef[] = [
  { key: "status", label: "Status", body: (ctx) => <StatusSection key={`${ctx.user.id}:${ctx.me.display.showGeneral}:${ctx.me.display.showPrivate}`} ctx={ctx} /> },
  { key: "name", label: "Her name", body: (ctx) => <Section title="Her name"><NameForm ctx={ctx} /></Section> },
  { key: "users", label: "Users", body: (ctx) => <UsersSection ctx={ctx} /> },
  { key: "sleep", label: "Sleep", body: (ctx) => <SleepTimeSection ctx={ctx} /> },
  { key: "unlocked", label: "Start unlocked", body: (ctx) => <UnlockedSection ctx={ctx} /> },
  { key: "tailnet", label: "Tailnet", body: (ctx) => <TailnetSection ctx={ctx} /> },
  { key: "web", label: "Web access", body: (ctx) => <Section title="Web access"><WebAccessSection userId={ctx.user.id} /></Section> },
  { key: "search", label: "Web search", body: (ctx) => <WebSearchSection ctx={ctx} /> },
  { key: "updates", label: "Updates", body: (ctx) => <UpdatesSection ctx={ctx} /> },
  { key: "persona", label: "Persona", body: (ctx) => <ProposalsSection ctx={ctx} /> },
  { key: "reset", label: "Reset", body: (ctx) => <WipeSection ctx={ctx} /> },
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
  const cur = sections.find((s) => s.key === key || s.aliases?.includes(key!)) ?? sections[0]!;
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

/** A settings card. `hint` is the heading's tooltip, never a caption under it (docs/ux.md). */
export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  const id = `h-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return <section className="card" aria-labelledby={id}><h2 id={id} {...(hint ? { title: hint } : {})}>{title}</h2>{children}</section>;
}

export function PronounFields({ value, onChange }: { value: Pronouns; onChange: (p: Pronouns) => void }) {
  const matched = Object.entries(PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(value))?.[0];
  // Custom… is a choice of its own: picking it keeps the current words and opens them for editing, even while they still match a preset.
  const [chosen, setChosen] = useState(!matched);
  const preset = chosen || !matched ? "custom" : matched;
  return (
    <>
      <label className="field"><span>Pronouns</span>
        <select value={preset} onChange={(e) => { const p = PRESETS[e.target.value]; setChosen(!p); if (p) onChange(p); }}>
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

/** The time zones this browser knows, for the Time zone field's suggestions. */
const ZONES: string[] = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];

function ProfileSection({ ctx }: { ctx: ShellContext }) {
  const { me } = ctx;
  const [name, setName] = useState(me.user.displayName);
  const [pronouns, setPronouns] = useState(me.user.pronouns);
  const [accent, setAccent] = useState(me.user.accent ?? "");
  const [monogram, setMonogram] = useState(me.user.monogram ?? "");
  const [zone, setZone] = useState(me.timeZone ?? "");
  const [run, busy, error] = useAction();
  const path = u(me.user.id, "me");
  const save = () => run(async () => ctx.setMe(await patch<Me>(`${path}/profile`, {
    displayName: name, pronouns, accent: accent || null, monogram: monogram || null, timeZone: zone.trim() || browserZone(),
  })));
  return (
    <Section title="Profile">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span>Display name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {me.previousNames.length > 0 && <p className="cap">Before: {me.previousNames.map((p) => `${p.name} (until ${p.until.slice(0, 10)})`).join(", ")}</p>}
        <PronounFields value={pronouns} onChange={setPronouns} />
        <label className="field"><span title={`Times you see, the date ${her()} is told, routines and your nightly sleep all follow it.`}>Time zone</span>
          <input className="mono" list="time-zones" value={zone} placeholder={browserZone()} spellCheck={false} autoComplete="off" onChange={(e) => setZone(e.target.value)} />
          <datalist id="time-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
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
  const presets = useLoad(() => get<Presets>(u(me.user.id, "presets")), [me.user.id]);
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
      {/* Off, the API sends no steps, so every card and header shows none; the thread list reloads to drop them. */}
      <Switch label="Checklists" hint="When off, no thread shows a checklist and the agent isn't offered one."
        checked={me.display.checklists} onChange={(checklists) => run(async () => { ctx.setMe(await patch<Me>(u(me.user.id, "me", "display"), { checklists })); ctx.refreshThreads(); })} />
      {presets.data && (
        <>
          <div className="eyebrow">Speech</div>
          <Switch label="Read aloud while agent writes" hint="Offers Read aloud on her reply while she is still writing it."
            checked={presets.data.readAloudLive} onChange={(readAloudLive) => run(async () => presets.set(await patch<Presets>(u(me.user.id, "presets"), { readAloudLive })))} />
        </>
      )}
      <ErrorText error={presets.error || error} />
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

/** Settings → Sleep: when sleep happens for this user, and Sleep fallback. Each saved at once. */
function SleepSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const presets = useLoad(() => get<Presets>(u(userId, "presets")), [userId]);
  const [run, , error] = useAction();
  return (
    <Section title="Sleep">
      <ErrorText error={presets.error || error} />
      <SleepModeField ctx={ctx} />
      {presets.data && (
        <Switch label="Sleep fallback" hint="When off, each sleep phase uses its first model only; if that one is away, sleep waits for the next night."
          checked={presets.data.sleepFallback} onChange={(sleepFallback) => run(async () => presets.set(await patch<Presets>(u(userId, "presets"), { sleepFallback })))} />
      )}
    </Section>
  );
}

function NetworkSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const net = useLoad(() => get<NetworkDefaults>(u(userId, "network")), [userId]);
  const mode = useLoad(() => get<ModeDefault>(u(userId, "mode")), [userId]);
  const presets = useLoad(() => get<Presets>(u(userId, "presets")), [userId]);
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
        {presets.data && (
          <Switch label="Fallback" hint="When off, only the first model in each list answers; if it can't, the message waits for it."
            checked={presets.data.fallback} onChange={(fallback) => run(async () => presets.set(await patch<Presets>(u(userId, "presets"), { fallback })))} />
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
      <StaleUnitsLine units={s?.unitsStale} />
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
      {s?.modelFacts && <ModelCallFacts facts={s.modelFacts} />}
    </Section>
  );
}

function UnlockedSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const status = useLoad(() => get<AdminStatus>(u(userId, "admin", "status")), [userId]);
  const [run, busy, error] = useAction();
  const [passphrase, setPassphrase] = useState("");
  const [changing, setChanging] = useState(false);
  const s = status.data;
  return (
    <Section title="Start unlocked">
      <ErrorText error={status.error || error} />
      {s && !s.credentials.available && <p className="meta muted">This server can't save credentials{s.credentials.reason ? `: ${s.credentials.reason}` : "."}</p>}
      {s?.savedPassphrase ? (
        <div className="row"><span>The passphrase is saved, so {her()} starts unlocked.</span>
          <button type="button" className="danger" disabled={busy} onClick={() => run(async () => status.set(await put<AdminStatus>(u(userId, "admin", "passphrase"), { save: false })))}>Forget it</button></div>
      ) : s && !changing && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { status.set(await put<AdminStatus>(u(userId, "admin", "passphrase"), { save: true, passphrase })); setPassphrase(""); }); }}>
          <label className="field grow"><span>Passphrase</span><input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></label>
          <button className="primary" disabled={busy || !passphrase || !s.credentials.available}>Save</button>
        </form>
      )}
      {s && <PassphraseChanger userId={userId} open={changing} setOpen={setChanging} onChanged={status.set} />}
    </Section>
  );
}

/** Minutes left from a rate-limit refusal ("… try again in <n> s"), at least 1. */
export function retryMinutes(message: string): number {
  const seconds = Number(/(\d+)\s*s\b/.exec(message)?.[1] ?? 60);
  return Math.max(1, Math.ceil(seconds / 60));
}

/** Change passphrase… under Start unlocked (docs/ux.md, "Changing the server passphrase"): three fields in place, no dialog; nothing is kept after a success or Cancel. */
function PassphraseChanger({ userId, open, setOpen, onChanged }: { userId: string; open: boolean; setOpen: (open: boolean) => void; onChanged: (s: AdminStatus) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ wrong?: true; minutes?: number; text?: string }>({});
  const [done, setDone] = useState<"" | "changed" | "removed">("");
  const clear = () => { setCurrent(""); setNext(""); setAgain(""); };
  const submit = async () => {
    setBusy(true); setProblem({});
    try {
      const result = await post<AdminStatus & { note?: string }>(u(userId, "admin", "passphrase", "change"), { current, next });
      clear(); setOpen(false);
      setDone(result.note ? "removed" : "changed");
      onChanged(result);
    } catch (e) {
      const err = e as Error;
      if (err instanceof HttpError && err.status === 403) setProblem({ wrong: true });
      else if (err instanceof HttpError && err.status === 429) {
        const minutes = retryMinutes(err.message);
        setProblem({ minutes });
        window.setTimeout(() => setProblem((p) => (p.minutes ? {} : p)), minutes * 60_000);
      } else setProblem({ text: err.message });
    } finally { setBusy(false); }
  };
  const status = done && (
    <p className="muted small" role="status">{done === "removed"
      ? "Passphrase changed. It couldn't be saved for Start unlocked, so the saved copy was removed: save it again. Snapshots taken before now still open with the old one."
      : "Passphrase changed. Snapshots taken before now still open with the old one."}</p>
  );
  if (!open) {
    return (
      <>
        <div className="row"><button type="button" className="sm" onClick={() => { setOpen(true); setDone(""); setProblem({}); }}>Change passphrase…</button></div>
        {status}
      </>
    );
  }
  const ready = !!next && next === again && next !== current && !!current;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ready && !problem.minutes) void submit(); }}>
      <label className="field"><span>Current passphrase</span>
        <input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field"><span>New passphrase</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field"><span>New passphrase again</span>
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="primary sm" disabled={busy || !ready || !!problem.minutes}>Change passphrase</button>
        <button type="button" className="sm" onClick={() => { clear(); setProblem({}); setOpen(false); }}>Cancel</button>
      </div>
      {problem.wrong && <p className="error" role="alert">That isn't the current passphrase.</p>}
      {problem.minutes && <p className="error" role="alert">Too many tries. Try again in <span className="num">{problem.minutes}</span> min.</p>}
      <ErrorText error={problem.text ?? ""} />
    </form>
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

/** Her name (docs/ux.md §6 "Her name"): one field and one Save. */
function NameForm({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const current = useLoad(() => get<NameSetting>(u(userId, "admin", "name")), [userId]);
  const [name, setName] = useState<string>();
  const [run, busy, error] = useAction();
  const value = name ?? current.data?.name ?? "";
  let invalid = "";
  try { checkName(value); } catch (e) { invalid = (e as Error).message; }
  const changed = !!current.data && value.trim() !== current.data.name;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (busy || invalid || !changed) return; void run(async () => { const saved = await saveName(userId, checkName(value)); current.set(saved); setHer(saved.name); setName(undefined); ctx.refreshState(); }); }}>
      <ErrorText error={current.error || error || (name !== undefined ? invalid : "")} />
      <div className="inline">
        <label className="field grow"><span className="wl" tabIndex={0} aria-describedby="name-consequence" onClick={(e) => { e.preventDefault(); e.currentTarget.focus(); }}>Name<span className="preview" role="tooltip" id="name-consequence">Memories and threads written so far keep the old name.</span></span><input aria-label="Name" aria-describedby="name-consequence" value={value} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <button className="primary" disabled={busy || !!invalid || !changed} title="Memories and threads written so far keep the old name.">Save</button>
      </div>
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
              <div><h4>Now</h4>{p.current ? <div className="prose small"><Prose text={p.current} /></div> : <p className="muted">(new topic)</p>}</div>
              <div><h4>Proposed</h4><div className="prose small"><Prose text={p.text} /></div></div>
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
