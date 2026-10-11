// Machines (DESIGN.md "Machines", docs/ux.md section 6): the Machines section
// of Settings with a row per machine and its drawer, and under it the Add
// machine page (settings/machines/new), which Replace key
// (settings/machines/<name>/key) opens at its Fingerprint step.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  del, get, patch, post, u,
  type MachineChange, type MachineInfo, type MachineInput, type MachineLimit, type MachineProbe, type Pool,
} from "./api.ts";
import { ModeItem, MODES } from "./Modes.tsx";
import { Icon } from "./icons.tsx";
import { go, href } from "./route.ts";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, useAction, useDismiss, useLoad } from "./ui.tsx";

/** The three modes a machine's limit can be, loosest last. */
const LIMITS: MachineLimit[] = ["ask", "acceptEdits", "auto"];
const POOLS: Record<Pool, string> = { general: "General", private: "Private" };

/**
 * The last connection's outcome, for the row's state. The Machines back end
 * is asked to add it to MachineInfo; until then it is absent and the row
 * shows Off network or nothing.
 */
export interface MachineState { kind: "online" | "unreachable" | "keyChanged"; since: string }
export type MachineRow = MachineInfo & { state?: MachineState };

/** At most one state per row: a dot's colour and its word, with the duration in mono where there is one. */
export function machineState(m: MachineRow, now = Date.now()): { tone: "ok" | "warn" | "bad"; word: string; detail?: string } | undefined {
  if (m.state?.kind === "keyChanged" || m.hostKey === null) return { tone: "bad", word: "Key changed" };
  if (m.state?.kind === "unreachable") return { tone: "warn", word: "Unreachable", detail: duration(now - Date.parse(m.state.since)) };
  if (m.offNetwork) return { tone: "warn", word: "Off network" };
  if (m.state?.kind === "online") return { tone: "ok", word: "Online" };
  return undefined;
}

/** "16 days", "3 h", "20 min": one unit, no decimals. */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** The facts line under a machine's name: address, pool, how she reaches it, and its limit as a phrase. */
function facts(m: MachineInfo): string {
  return [m.address, POOLS[m.pool], m.kind === "proxmox" ? "Proxmox API · token" : "SSH · key", `up to ${MODES[m.limit].label}`].join(" · ");
}

/** The row's state as a dot class (docs/ux.md: green ok, amber warn, red bad). */
const DOT: Record<"ok" | "warn" | "bad", string> = { ok: "up", warn: "away", bad: "down" };

/** Where the Machines section's own pages live: `rest` is what follows `settings/machines/` in the hash. */
export function MachinesSection({ ctx, rest }: { ctx: ShellContext; rest: string }) {
  const [first, second] = rest.split("/");
  if (first === "new" && !second) return <MachinePage ctx={ctx} />;
  if (first && second === "key") return <MachinePage ctx={ctx} name={first} />;
  return <MachinesList ctx={ctx} />;
}

function MachinesList({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const machines = useLoad(() => get<MachineRow[]>(u(userId, "machines")), [userId]);
  const [run, , error] = useAction();
  const [open, setOpen] = useState<string>();
  const [removing, setRemoving] = useState<MachineRow>();
  // An off-network private machine her threads may use again, once its dialog is confirmed.
  const [using, setUsing] = useState<MachineRow>();
  const list = machines.data ?? [];
  const current = list.find((m) => m.name === open);
  const replace = (m: MachineInfo) => machines.set(list.map((x) => (x.name === m.name ? { ...x, ...m } : x)));
  return (
    <section className="card" aria-labelledby="h-machines">
      <div className="section-head">
        <h2 id="h-machines">Machines</h2>
        <a href={href({ page: "settings", userId, section: "machines/new" })}>Add machine</a>
      </div>
      <ErrorText error={machines.error || error} />
      {machines.data && !list.length && <p className="muted">None yet.</p>}
      {list.length > 0 && (
        <ul className="list machines">
          {list.map((m) => {
            const state = machineState(m);
            return (
              <li key={m.name} className="machine-row">
                <button type="button" className="machine-open" aria-haspopup="dialog" aria-expanded={open === m.name} onClick={() => setOpen(m.name)}>
                  <span className="machine-name">{m.name}</span>
                  <span className="machine-facts">{facts(m)}</span>
                </button>
                {state && (
                  <span className="state-word">
                    <span className={`dot ${DOT[state.tone]}`} aria-hidden="true" />{state.word}{state.detail && <span className="num mono"> {state.detail}</span>}
                  </span>
                )}
                <RowMenu label={`Actions for ${m.name}`} items={[
                  { label: "Replace key", onPick: () => go({ page: "settings", userId, section: `machines/${encodeURIComponent(m.name)}/key` }) },
                  ...(state?.word === "Off network" && m.pool === "private" ? [{ label: "Use anyway", onPick: () => setUsing(m) }] : []),
                  { label: "Remove", danger: true, onPick: () => setRemoving(m) },
                ]} />
              </li>
            );
          })}
        </ul>
      )}
      {current && (
        <>
          <MachineDrawer userId={userId} machine={current} onSaved={(m) => { replace(m); setOpen(undefined); }} onClose={() => setOpen(undefined)} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={() => setOpen(undefined)} />
        </>
      )}
      {removing && (
        <ConfirmDialog title="Remove machine" sentence={`Remove ${removing.name}? Every thread that uses it loses it, and her key for it is forgotten.`}
          confirm="Remove" danger onCancel={() => setRemoving(undefined)}
          onConfirm={() => { const m = removing; setRemoving(undefined); void run(async () => { await del(u(userId, "machines", m.name)); machines.reload(); }); }} />
      )}
      {using && (
        <ConfirmDialog title="Outside your network" sentence={offNetworkSentence(using.name, "Use it anyway?")}
          confirm="Use anyway" onCancel={() => setUsing(undefined)}
          onConfirm={() => { const m = using; setUsing(undefined); void run(async () => { replace(await post<MachineInfo>(u(userId, "machines", m.name, "confirm-off-network"), {})); }); }} />
      )}
    </section>
  );
}

/** The dialog's one sentence for a private machine outside the network, ending in its question. */
function offNetworkSentence(name: string, question: string): string {
  return `${name} is outside your network, so a private thread's commands and files would leave it. ${question}`;
}

/** The row's ⋯: rare actions, Remove last and in danger text. */
function RowMenu({ label, items }: { label: string; items: { label: string; danger?: boolean; onPick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <span className="row-menu" ref={ref}>
      <button type="button" className="icon sm" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : ""} onClick={() => { close(); it.onPick(); }}>{it.label}</button>)}
        </div>
      )}
    </span>
  );
}

/** Editing one machine: its address, folder and pool, and Mode limit as the message box's three-item mode list. Save at the foot. */
function MachineDrawer({ userId, machine, onSaved, onClose }: { userId: string; machine: MachineRow; onSaved: (m: MachineInfo) => void; onClose: () => void }) {
  const [address, setAddress] = useState(machine.address);
  const [root, setRoot] = useState(machine.root ?? "");
  const [pool, setPool] = useState(machine.pool);
  const [limit, setLimit] = useState(machine.limit);
  const [run, busy, error] = useAction();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const change: MachineChange = {
    ...(address !== machine.address ? { address } : {}),
    ...(machine.kind === "ssh" && (root || null) !== machine.root ? { root: root || null } : {}),
    ...(pool !== machine.pool ? { pool } : {}),
    ...(limit !== machine.limit ? { limit } : {}),
  };
  const changed = Object.keys(change).length > 0;
  const save = () => run(async () => onSaved(await patch<MachineInfo>(u(userId, "machines", machine.name), change)));
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={machine.name}>
      <div className="drawer-head">
        <h2>{machine.name}</h2>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (changed) void save(); }}>
        <fieldset className="group" disabled={busy}>
          <legend>{machine.kind === "proxmox" ? "Proxmox" : "SSH"}</legend>
          <label className="field"><span>Address</span><input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          {machine.kind === "ssh" && <label className="field"><span>Folder</span><input className="mono" value={root} placeholder="/" onChange={(e) => setRoot(e.target.value)} /></label>}
          {machine.kind === "proxmox" && <p className="muted small mono">{machine.tokenId}</p>}
          <label className="field"><span>Pool</span>
            <select value={pool} onChange={(e) => setPool(e.target.value as Pool)}>
              {(Object.keys(POOLS) as Pool[]).map((p) => <option key={p} value={p}>{POOLS[p]}</option>)}
            </select>
          </label>
        </fieldset>
        <fieldset className="group" disabled={busy}>
          <legend>Mode limit</legend>
          <div className="mode-list" role="radiogroup" aria-label="Mode limit">
            {LIMITS.map((m) => <ModeItem key={m} mode={m} role="radio" checked={m === limit} onClick={() => setLimit(m)} />)}
          </div>
        </fieldset>
        <ErrorText error={error} />
        <div className="row drawer-foot">
          <button type="submit" className="primary" disabled={busy || !changed} title={pool !== machine.pool ? "A new pool takes it from every thread that has it" : undefined}>Save</button>
        </div>
      </form>
    </aside>
  );
}

type Kind = "ssh" | "proxmox";
type Step = "address" | "key" | "test" | "fingerprint";

/**
 * Add machine, and Replace key (`name` set): one card in the Machines
 * section with a kind segment, the steps as sections with eyebrows, and one
 * primary, the current step's action. Nothing is saved before Confirm.
 */
export function MachinePage({ ctx, name }: { ctx: ShellContext; name?: string }) {
  const userId = ctx.user.id;
  const replacing = name !== undefined;
  const existing = useLoad(() => (replacing ? get<MachineInfo[]>(u(userId, "machines")).then((l) => l.find((m) => m.name === name) ?? null) : Promise.resolve(null)), [userId, name]);
  const [kind, setKind] = useState<Kind>("ssh");
  const [form, setForm] = useState({ name: "", address: "", root: "", pool: "general" as Pool, token: "" });
  // The probe's answer: her key's setup steps and, after Test, the fingerprint and whether the login worked.
  const [probe, setProbe] = useState<MachineProbe>();
  const [copied, setCopied] = useState(false);
  const [tested, setTested] = useState(false);
  const [offNetwork, setOffNetwork] = useState(false);
  const [run, busy, error] = useAction();
  const [probing, probingBusy, probeError] = useAction();
  const machine = existing.data ?? undefined;
  useEffect(() => {
    if (!machine) return;
    setKind(machine.kind);
    setForm((f) => ({ ...f, name: machine.name, address: machine.address, root: machine.root ?? "", pool: machine.pool }));
  }, [machine]);

  const setField = (k: keyof typeof form, v: string) => { setForm((f) => ({ ...f, [k]: v })); if (k === "address" || k === "name") { setProbe(undefined); setCopied(false); setTested(false); } };
  const ready = form.name.trim() !== "" && form.address.trim() !== "";
  const probeNow = (draft?: string) => probing(async () => {
    const p = await post<MachineProbe>(u(userId, "machines", "probe"), { kind, name: form.name.trim(), address: form.address.trim(), draft });
    setProbe(p);
    return p;
  });
  // Leaving the address, or Enter in it, fetches her key for the machine, so the Key step can show its setup steps.
  const reach = () => { if (ready && !probe && !probingBusy) void probeNow(); };
  const test = () => probing(async () => {
    const p = await post<MachineProbe>(u(userId, "machines", "probe"), { kind, name: form.name.trim(), address: form.address.trim(), draft: probe?.draft });
    setProbe(p);
    setTested(true);
  });
  // Where the clipboard is refused (no HTTPS, say), the block is selected so it can be copied by hand; the step is done either way.
  const setupRef = useRef<HTMLPreElement>(null);
  const copy = () => {
    if (!probe) return;
    navigator.clipboard.writeText(probe.setup).catch(() => {
      const range = document.createRange();
      if (setupRef.current) { range.selectNodeContents(setupRef.current); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); }
    }).finally(() => setCopied(true));
  };

  const loginOk = kind === "proxmox" ? !!probe?.fingerprint : !!probe?.login;
  const tokenOk = kind === "ssh" || form.token.trim() !== "" || replacing;
  const step: Step = !probe ? "address" : !copied && !replacing ? "key" : !tested || !loginOk ? "test" : "fingerprint";
  // Replace key goes straight to the fingerprint: the machine is known, only its key is confirmed again.
  useEffect(() => { if (machine && !probe && !probingBusy) void probeNow(); }, [machine]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (offNetworkConfirmed = false) => run(async () => {
    if (!probe?.fingerprint) return;
    if (replacing) {
      await post(u(userId, "machines", name, "key"), { hostKey: probe.fingerprint, ...(kind === "proxmox" && form.token.trim() ? { token: form.token.trim() } : {}) });
    } else {
      const input: MachineInput = {
        kind, name: form.name.trim(), address: form.address.trim(), root: kind === "ssh" && form.root.trim() ? form.root.trim() : undefined, pool: form.pool,
        hostKey: probe.fingerprint, offNetworkConfirmed, ...(kind === "proxmox" ? { token: form.token.trim() } : { draft: probe.draft }),
      };
      await post<MachineInfo>(u(userId, "machines"), input);
    }
    go({ page: "settings", userId, section: "machines" });
  });
  const confirm = () => {
    if (!replacing && probe?.offNetwork && form.pool === "private") setOffNetwork(true);
    else void save();
  };

  const keyLabel = kind === "proxmox" ? "Token" : "Key";
  const title = replacing ? "Replace key" : "Add machine";
  const back = href({ page: "settings", userId, section: "machines" });
  return (
    <section className="card page-card" aria-labelledby="h-machine-page">
      <div className="section-head">
        <h2 id="h-machine-page">{title}</h2>
        {replacing && machine && <span className="fact mono">{machine.name} · {machine.address}</span>}
        <a href={back}>Machines</a>
      </div>
      <div className="steps">
        <ErrorText error={existing.error} />
        {replacing && existing.data === null && <p className="error">That machine doesn't exist any more.</p>}
        {!replacing && (
          <div className="seg" role="group" aria-label="Kind">
            {(["ssh", "proxmox"] as Kind[]).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => { if (kind !== k) { setKind(k); setProbe(undefined); setCopied(false); setTested(false); } }}>{k === "ssh" ? "SSH" : "Proxmox"}</button>
            ))}
          </div>
        )}
        {!replacing && (
          <form className="step" onSubmit={(e) => { e.preventDefault(); reach(); }} onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); reach(); } }} aria-labelledby="step-address">
            <h2 className="eyebrow" id="step-address">Name and address</h2>
            <div className="row wrap top">
              <label className="field narrow"><span>Name</span><input value={form.name} autoFocus onBlur={reach} onChange={(e) => setField("name", e.target.value)} /></label>
              <label className="field grow"><span>Address</span>
                <input className="mono" value={form.address} placeholder={kind === "proxmox" ? "https://pve.lan:8006" : "lyrica@build-box.lan"} onBlur={reach} onChange={(e) => setField("address", e.target.value)} />
              </label>
            </div>
            <div className="row wrap top">
              {kind === "ssh" && <label className="field grow"><span>Folder</span><input className="mono" value={form.root} placeholder="/" onChange={(e) => setField("root", e.target.value)} /></label>}
              <label className="field narrow"><span>Pool</span>
                <select value={form.pool} onChange={(e) => setField("pool", e.target.value)}>
                  {(Object.keys(POOLS) as Pool[]).map((p) => <option key={p} value={p}>{POOLS[p]}</option>)}
                </select>
              </label>
            </div>
            {step === "address" && <ErrorText error={probeError} />}
          </form>
        )}
        {probe && !replacing && (
          <section className="step" aria-labelledby="step-key">
            <h2 className="eyebrow" id="step-key">{keyLabel}</h2>
            <pre className="setup" ref={setupRef}><code>{probe.setup}</code></pre>
            <div className="row">
              <button type="button" className={step === "key" ? "primary" : ""} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            </div>
            {kind === "proxmox" && (
              <label className="field"><span>Token</span>
                <input className="mono" value={form.token} placeholder="lyrica@pve!agent=…" autoComplete="off" onChange={(e) => setField("token", e.target.value)} />
              </label>
            )}
          </section>
        )}
        {probe && !replacing && (
          <section className="step" aria-labelledby="step-test">
            <h2 className="eyebrow" id="step-test">Test</h2>
            <div className="row">
              <button type="button" className={step === "test" ? "primary" : ""} disabled={probingBusy} onClick={() => void test()}>Test</button>
              {tested && loginOk && <span className="state-word"><span className="dot up" aria-hidden="true" />{kind === "proxmox" ? "Reached" : "Logged in"}</span>}
            </div>
            {tested && !loginOk && <ErrorText error={probe.problem ?? "The login didn't work."} />}
            {step !== "address" && <ErrorText error={probeError} />}
          </section>
        )}
        {replacing && kind === "proxmox" && (
          <section className="step" aria-labelledby="step-token">
            <h2 className="eyebrow" id="step-token">Token</h2>
            <label className="field"><span>Replace token</span>
              <input className="mono" value={form.token} placeholder="Keep the current token" autoComplete="off" onChange={(e) => setField("token", e.target.value)} />
            </label>
          </section>
        )}
        {(replacing || (tested && loginOk)) && (
          <section className="step" aria-labelledby="step-fingerprint">
            <h2 className="eyebrow" id="step-fingerprint">Fingerprint</h2>
            {probe?.fingerprint ? <p className="fingerprint mono">{probe.fingerprint}</p> : replacing && probe?.problem ? <ErrorText error={probe.problem} /> : <p className="muted">Reaching it…</p>}
            {replacing && probeError && <ErrorText error={probeError} />}
            <div className="row">
              <button type="button" className={step === "fingerprint" || replacing ? "primary" : ""} disabled={busy || !probe?.fingerprint || !tokenOk} onClick={confirm}>Confirm</button>
              {replacing && <button type="button" onClick={() => go({ page: "settings", userId, section: "machines" })}>Cancel</button>}
            </div>
            <ErrorText error={error} />
          </section>
        )}
      </div>
      {offNetwork && (
        <ConfirmDialog title="Outside your network" sentence={offNetworkSentence(form.name.trim(), "Add it anyway?")}
          confirm="Add anyway" onCancel={() => setOffNetwork(false)} onConfirm={() => { setOffNetwork(false); void save(true); }} />
      )}
    </section>
  );
}
