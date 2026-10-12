// Set up Lyrica (docs/ux.md §6 "Setting her up"): the page in the unlock page's place while there is no self.db.
// Steps as sections with eyebrows; the current step's button is the one primary, a done step's secondary; each
// step's button applies at once. From Create on, lyricad is unlocked and this administrator is signed in; the page
// stays until Done.
import { useEffect, useState } from "react";
import {
  get, HttpError, post, put, u,
  type EndpointInfo, type LoginResponse, type Pronouns, type State, type Tailnet, type TailnetJoin, type WebAccess,
} from "./api.ts";
import { Gate } from "./App.tsx";
import { her, setHer } from "./name.ts";
import { PronounFields, PRESETS } from "./Panel.tsx";
import { tailnetReason, TailnetState } from "./Tailnet.tsx";
import { ErrorText, Switch } from "./ui.tsx";

/** Like useAction, keeping the error itself, so its status can say what happened in the page's words. */
function useTry(): [(fn: () => Promise<unknown>) => Promise<void>, boolean, Error | undefined] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await fn(); } catch (e) { setError(e as Error); } finally { setBusy(false); }
  };
  return [run, busy, error];
}

type StepKey = "code" | "name" | "admin" | "tailnet" | "models" | "done";
const ORDER: StepKey[] = ["code", "name", "admin", "tailnet", "models", "done"];

/** What a wrong answer from lyricad means here, in the page's words (docs/ux.md §4: what happened, why, what to do). */
function explain(e: Error, step: StepKey): string {
  const status = e instanceof HttpError ? e.status : 0;
  if (step === "admin" && status === 403) return "The code doesn't match. Run lyrica admin setup-code on the server to see it.";
  if (step === "admin" && status === 429) return "Too many wrong codes. Wait before trying again: the wait grows with each wrong code, up to 15 minutes.";
  if (step === "tailnet" && status === 409 && /cut this connection/.test(e.message)) return "This page is reached over the tailnet, so joining another one would cut it off. Open her LAN address and do it there.";
  if (step === "tailnet") return tailnetReason(e.message);
  return e.message;
}

export function Setup({ userId, onCreated, onDone }: { userId?: string; onCreated: (r: LoginResponse) => void; onDone: () => void }) {
  const [step, setStep] = useState<StepKey>(userId ? "tailnet" : "code");
  const at = ORDER.indexOf(step);
  const done = (k: StepKey) => ORDER.indexOf(k) < at;
  const [state, setState] = useState<State>();
  useEffect(() => { get<State>("/api/state").then(setState, () => {}); }, []);
  const creds = state?.credentials ?? { available: true };

  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [unlocked, setUnlocked] = useState(creds.available);
  useEffect(() => { if (!creds.available) setUnlocked(false); }, [creds.available]);
  const [name, setName] = useState(her());
  const [admin, setAdmin] = useState({ login: "", password: "", displayName: "", pronouns: PRESETS["she/her"]! as Pronouns });
  const [mismatch, setMismatch] = useState("");
  const [run, busy, error] = useTry();

  const create = () => run(async () => {
    const r = await post<LoginResponse>("/api/setup", { code: code.trim(), passphrase, saveCredentials: unlocked, name: name.trim() || "Lyrica", admin: { ...admin, login: admin.login.trim(), displayName: admin.displayName.trim() || admin.login.trim() } });
    setHer(name);
    onCreated(r);
    setStep("tailnet");
  });

  return (
    <Gate title={`Set up ${her()}`} wide>
      <div className="steps setup-steps">
        <form className="step" aria-labelledby="s-code" onSubmit={(e) => { e.preventDefault(); if (passphrase !== repeat) return setMismatch("The passphrases don't match."); setMismatch(""); if (!done("code") && step === "code") setStep("name"); }}>
          <h2 className="eyebrow" id="s-code">Code and passphrase</h2>
          <label className="field"><span>Code</span><input className="mono" value={code} autoFocus autoComplete="off" autoCapitalize="characters" disabled={!!userId} onChange={(e) => setCode(e.target.value)} /></label>
          <div className="row wrap">
            <label className="field grow"><span>Passphrase</span><input type="password" autoComplete="new-password" value={passphrase} disabled={!!userId} onChange={(e) => setPassphrase(e.target.value)} /></label>
            <label className="field grow"><span>Repeat</span><input type="password" autoComplete="new-password" value={repeat} disabled={!!userId} onChange={(e) => setRepeat(e.target.value)} /></label>
          </div>
          <Switch label="Start unlocked" checked={unlocked} disabled={!creds.available || !!userId} onChange={setUnlocked}
            hint={creds.available ? "The passphrase is saved with systemd-creds, so she comes up unlocked after a restart." : creds.reason ?? "This machine can't save credentials."} />
          <ErrorText error={mismatch} />
          {!userId && <div className="row"><button className={step === "code" ? "primary" : ""} disabled={!code.trim() || !passphrase || !repeat}>Continue</button></div>}
        </form>

        {at >= 1 && (
          <form className="step" aria-labelledby="s-name" onSubmit={(e) => { e.preventDefault(); if (step === "name") setStep("admin"); }}>
            <h2 className="eyebrow" id="s-name">{her()}</h2>
            <label className="field"><span>Name</span><input value={name} disabled={!!userId} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
            {!userId && <div className="row"><button className={step === "name" ? "primary" : ""} disabled={!name.trim()}>Continue</button></div>}
          </form>
        )}

        {at >= 2 && (
          <form className="step" aria-labelledby="s-admin" onSubmit={(e) => { e.preventDefault(); if (!userId) void create(); }}>
            <h2 className="eyebrow" id="s-admin">Administrator</h2>
            <div className="row wrap">
              <label className="field grow"><span>Login name</span><input className="mono" value={admin.login} autoComplete="username" autoCapitalize="none" disabled={!!userId} onChange={(e) => setAdmin({ ...admin, login: e.target.value })} /></label>
              <label className="field grow"><span>Password</span><input type="password" autoComplete="new-password" value={admin.password} disabled={!!userId} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} /></label>
            </div>
            <label className="field"><span>Name</span><input value={admin.displayName} autoComplete="name" disabled={!!userId} onChange={(e) => setAdmin({ ...admin, displayName: e.target.value })} /></label>
            {!userId && <PronounFields value={admin.pronouns} onChange={(pronouns) => setAdmin({ ...admin, pronouns })} />}
            {step === "admin" && error && <ErrorText error={explain(error, "admin")} />}
            {!userId && <div className="row"><button className={step === "admin" ? "primary" : ""} disabled={busy || !admin.login.trim() || !admin.password}>Create</button></div>}
            {userId && <span className="state-word"><span className="dot up" aria-hidden="true" />Created</span>}
          </form>
        )}

        {at >= 3 && userId && <TailnetStep userId={userId} current={step === "tailnet"} name={name} onNext={() => setStep("models")} />}
        {at >= 4 && userId && <ModelsStep userId={userId} current={step === "models"} onNext={() => setStep("done")} />}
        {at >= 5 && userId && <DoneStep userId={userId} login={admin.login.trim()} unlocked={unlocked} onDone={onDone} />}
      </div>
    </Gate>
  );
}

/** Tailnet: join with an auth key, see the state, and turn Web access over the tailnet on (the default once connected). */
function TailnetStep({ userId, current, name, onNext }: { userId: string; current: boolean; name: string; onNext: () => void }) {
  const path = u(userId, "admin", "tailnet");
  const [tn, setTn] = useState<Tailnet>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => { get<Tailnet>(path).then(setTn, (e: Error) => setLoadError(explain(e, "tailnet"))); }, [path]);
  const [join, setJoin] = useState<TailnetJoin>({ authKey: "", hostname: name.trim().toLowerCase().replace(/\s+/g, "-") || "lyrica", controlServer: "" });
  const [web, setWeb] = useState(true);
  const [run, busy, error] = useTry();
  const connected = tn?.state === "connected";
  const connect = () => run(async () => {
    setTn(await put<Tailnet>(path, { authKey: join.authKey.trim(), ...(join.hostname?.trim() ? { hostname: join.hostname.trim() } : {}), ...(join.controlServer?.trim() ? { controlServer: join.controlServer.trim() } : {}) }));
  });
  const next = () => run(async () => {
    if (connected && web) await put<WebAccess>(u(userId, "admin", "web-access"), { mode: "tailnet" });
    onNext();
  });
  const notInstalled = tn?.state === "notInstalled";
  return (
    <form className="step" aria-labelledby="s-tailnet" onSubmit={(e) => { e.preventDefault(); if (current) void (connected ? next() : connect()); }}>
      <h2 className="eyebrow" id="s-tailnet">Tailnet</h2>
      {!connected && !notInstalled && (
        <>
          <label className="field"><span>Auth key</span><input className="mono" type="password" autoComplete="off" value={join.authKey} disabled={!current} onChange={(e) => setJoin({ ...join, authKey: e.target.value })} /></label>
          <label className="field"><span>Hostname</span><input className="mono" value={join.hostname} disabled={!current} onChange={(e) => setJoin({ ...join, hostname: e.target.value })} /></label>
          <details className="advanced"><summary>Advanced</summary>
            <label className="field"><span>Control server</span><input className="mono" placeholder="https://headscale.example.net" value={join.controlServer} disabled={!current} onChange={(e) => setJoin({ ...join, controlServer: e.target.value })} /></label>
          </details>
        </>
      )}
      {tn && <TailnetState tn={tn} />}
      {connected && <Switch label="Web access" checked={web} disabled={!current} onChange={setWeb} hint={`HTTPS at https://${tn.dnsName ?? join.hostname} through Tailscale, for every device on the tailnet.`} />}
      <ErrorText error={loadError || (current && error ? explain(error, "tailnet") : "")} />
      {current && (
        <div className="row">
          {connected
            ? <button className="primary" disabled={busy}>Continue</button>
            : <button className="primary" disabled={busy || notInstalled || !join.authKey.trim()}>Connect</button>}
          {!connected && <button type="button" className="link" disabled={busy} onClick={onNext}>Skip</button>}
        </div>
      )}
      {!current && <span className="state-word muted">{connected ? (web ? "Web access on" : "Web access off") : "Skipped"}</span>}
    </form>
  );
}

/** Models: one endpoint, shared, and its first model first in the administrator's profile for the main conversation. */
function ModelsStep({ userId, current, onNext }: { userId: string; current: boolean; onNext: () => void }) {
  const [form, setForm] = useState({ kind: "cloud" as "cloud" | "local", baseUrl: "", apiKey: "", name: "" });
  const [added, setAdded] = useState<EndpointInfo>();
  const [run, busy, error] = useTry();
  const add = () => run(async () => {
    const ep = await post<EndpointInfo>(u(userId, "endpoints"), { name: form.name.trim(), kind: form.kind, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey || undefined, shared: true });
    const first = ep.models[0];
    if (!first) throw new Error("No models were listed at that address. Check the URL and the key; the Models area lists what she finds.");
    await put(u(userId, "profiles", form.kind, "chat"), { model: { offeringId: first.id } });
    setAdded(ep);
    onNext();
  });
  return (
    <form className="step" aria-labelledby="s-models" onSubmit={(e) => { e.preventDefault(); if (current) void add(); }}>
      <h2 className="eyebrow" id="s-models">Models</h2>
      {!added && (
        <>
          <div className="seg" role="group" aria-label="Kind">
            {(["cloud", "local"] as const).map((k) => <button key={k} type="button" aria-pressed={form.kind === k} disabled={!current} onClick={() => setForm({ ...form, kind: k })}>{k === "cloud" ? "Cloud" : "Local"}</button>)}
          </div>
          <label className="field"><span>Base URL</span><input className="mono" value={form.baseUrl} placeholder={form.kind === "cloud" ? "https://api.openai.com/v1" : "http://192.168.1.50:1234/v1"} disabled={!current} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
          <div className="row wrap">
            <label className="field grow"><span>API key</span><input type="password" autoComplete="off" value={form.apiKey} disabled={!current} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
            <label className="field grow"><span>Name</span><input value={form.name} disabled={!current} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
        </>
      )}
      {added && <span className="state-word"><span className="dot up" aria-hidden="true" /><span className="mono">{added.models[0]?.modelId}</span> · {added.name}</span>}
      {current && <ErrorText error={error?.message} />}
      {current && (
        <div className="row">
          <button className="primary" disabled={busy || !form.baseUrl.trim() || !form.name.trim()}>Add</button>
          <button type="button" className="link" disabled={busy} onClick={onNext}>Skip</button>
        </div>
      )}
      {!current && !added && <span className="state-word muted">Skipped</span>}
    </form>
  );
}

/** Done: the facts that matter now, and Start a chat. */
function DoneStep({ userId, login, unlocked, onDone }: { userId: string; login: string; unlocked: boolean; onDone: () => void }) {
  const [access, setAccess] = useState<WebAccess>();
  const [tn, setTn] = useState<Tailnet>();
  useEffect(() => {
    get<WebAccess>(u(userId, "admin", "web-access")).then(setAccess, () => {});
    get<Tailnet>(u(userId, "admin", "tailnet")).then(setTn, () => {});
  }, [userId]);
  const addresses = [
    ...(access?.mode === "tailnet" && access.tailnet ? [`https://${access.tailnet.dnsName}`] : []),
    ...(access?.direct ? access.direct.addresses.map((a) => `https://${a.includes(":") ? `[${a}]` : a}:${access.direct!.port}`) : []),
  ];
  return (
    <section className="step" aria-labelledby="s-done">
      <h2 className="eyebrow" id="s-done">Done</h2>
      <dl className="facts">
        <dt>Address{addresses.length === 1 ? "" : "es"}</dt><dd className="mono">{addresses.length ? addresses.map((a) => <div key={a}>{a}</div>) : window.location.origin}</dd>
        {access?.direct && access.direct.addresses.length > 0 && <><dt>Fingerprint</dt><dd className="mono small">{access.direct.fingerprint}</dd></>}
        <dt>Administrator</dt><dd className="mono">{login}</dd>
        {tn?.state === "connected" && <><dt>Tailnet</dt><dd className="mono">{tn.tailnet}{tn.dnsName ? ` · ${tn.dnsName}` : ""}</dd></>}
      </dl>
      {!unlocked && <p>She starts locked after each restart; the passphrase unlocks her.</p>}
      <div className="row"><button type="button" className="primary" onClick={onDone}>Start a chat</button></div>
    </section>
  );
}
