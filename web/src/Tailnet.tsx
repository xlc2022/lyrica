// Administration → Tailnet (docs/ux.md §6 "The tailnet"): her own tailscaled, read each time. Lyrica stores nothing
// about the tailnet herself; the facts line and the state are what tailscaled reports.
import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, HttpError, post, put, u, type Tailnet, type TailnetJoin } from "./api.ts";
import { Icon } from "./icons.tsx";
import { her } from "./name.ts";
import type { ShellContext } from "./Shell.tsx";
import { ConfirmDialog, ErrorText, useDismiss, useLoad } from "./ui.tsx";

const CUT = "This page is reached over the tailnet, so disconnecting would cut it off. Open her LAN address and do it there.";

/** The 409 for a change asked over her own tailnet address, in the page's words; anything else as lyricad said it. */
export function tailnetError(e: Error): string {
  return e instanceof HttpError && e.status === 409 && /cut this connection/.test(e.message) ? CUT : tailnetReason(e.message);
}

/** The server's reason in the page's words (docs/ux.md §4: what happened and what to do). */
export function tailnetReason(reason: string): string {
  if (/isn't installed|not installed|no tailscale/i.test(reason)) return "Tailscale isn't installed on this machine. Run install.sh again.";
  if (/isn't running|not running/i.test(reason)) return "Her tailscaled isn't running: systemctl status lyrica-tailscaled.";
  if (/certificate/i.test(reason)) return "HTTPS certificates are off in this tailnet. Turn them on under DNS in the admin console, then turn Web access on.";
  return reason;
}

/** One state: a dot and a word (docs/ux.md §2), with the reason as the word's tooltip where there is one. */
export function TailnetState({ tn }: { tn: Tailnet }) {
  const word = tn.state === "connected" ? ["up", "Connected"] : tn.state === "disconnected" ? ["away", `Disconnected${tn.tailnet ? ` · member of ${tn.tailnet}` : ""}`]
    : tn.state === "notInstalled" ? ["down", "Not installed"] : ["", "Not joined"];
  return (
    <div className="stack tailnet-state">
      <span className="state-word">{word[0] && <span className={`dot ${word[0]}`} aria-hidden="true" />}{word[1]}</span>
      {tn.state !== "connected" && tn.reason && <span className="muted small">{tailnetReason(tn.reason)}</span>}
      {tn.state === "connected" && <TailnetFacts tn={tn} />}
    </div>
  );
}

function TailnetFacts({ tn }: { tn: Tailnet }) {
  const facts = [tn.tailnet, tn.address, tn.dnsName, tn.controlServer, tn.version && `Tailscale ${tn.version}`].filter(Boolean);
  return <p className="fact">{facts.join(" · ")}</p>;
}

export function TailnetSection({ ctx }: { ctx: ShellContext }) {
  const userId = ctx.user.id;
  const path = u(userId, "admin", "tailnet");
  const tailnet = useLoad(() => get<Tailnet>(path), [path]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<false | "join" | "another">(false);
  const [dialog, setDialog] = useState<"disconnect" | "leave">();
  const tn = tailnet.data;
  const act = async (fn: () => Promise<Tailnet>) => {
    setBusy(true); setError("");
    try { tailnet.set(await fn()); return true; } catch (e) { setError(tailnetError(e as Error)); return false; } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="h-tailnet">
      <div className="section-head"><h2 id="h-tailnet">Tailnet</h2>{tn && tn.state !== "notInstalled" && tn.state !== "notJoined" && <Dots onLeave={() => setDialog("leave")} onAnother={() => setDrawer("another")} busy={busy} />}</div>
      <ErrorText error={tailnet.error || error} />
      {tn && <TailnetState tn={tn} />}
      {tn && (
        <div className="row">
          {tn.state === "notJoined" && <button type="button" className="primary" disabled={busy} onClick={() => setDrawer("join")}>Connect</button>}
          {tn.state === "disconnected" && <button type="button" className="primary" disabled={busy} onClick={() => void act(() => post<Tailnet>(`${path}/connect`, {}))}>Connect</button>}
          {tn.state === "connected" && <button type="button" disabled={busy} onClick={() => setDialog("disconnect")}>Disconnect</button>}
        </div>
      )}
      {drawer && (
        <JoinDrawer path={path} another={drawer === "another"} tailnet={tn?.tailnet} defaultHostname={her().toLowerCase().replace(/\s+/g, "-")}
          onJoined={(t) => { tailnet.set(t); setDrawer(false); }} onClose={() => setDrawer(false)} />
      )}
      {dialog === "disconnect" && (
        <ConfirmDialog title={`Disconnect from ${tn?.tailnet ?? "the tailnet"}?`} sentence="She can't be reached there until she connects again." confirm="Disconnect" cancel="Stay connected"
          onCancel={() => setDialog(undefined)} onConfirm={() => { setDialog(undefined); void act(() => post<Tailnet>(`${path}/disconnect`, {})); }} />
      )}
      {dialog === "leave" && (
        <ConfirmDialog title={`Leave ${tn?.tailnet ?? "the tailnet"}?`} sentence="Her key there is removed, Web access over the tailnet stops, and connecting again needs a new auth key." confirm="Leave" cancel="Stay" danger
          onCancel={() => setDialog(undefined)} onConfirm={() => { setDialog(undefined); void act(() => del<Tailnet>(path)); }} />
      )}
    </section>
  );
}

/** Leave and Connect to another tailnet, behind ⋯ (docs/ux.md §3: two visible controls at most). */
function Dots({ onLeave, onAnother, busy }: { onLeave: () => void; onAnother: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <span className="msg-menu" ref={ref}>
      <button type="button" className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}><Icon name="more" /></button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { close(); onAnother(); }}>Connect to another tailnet</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { close(); onLeave(); }}>Leave</button>
        </div>
      )}
    </span>
  );
}

/** Joining happens in the drawer: Auth key, Hostname, Advanced → Control server, Connect at its foot. */
function JoinDrawer({ path, another, tailnet, defaultHostname, onJoined, onClose }: {
  path: string; another: boolean; tailnet?: string; defaultHostname: string; onJoined: (t: Tailnet) => void; onClose: () => void;
}) {
  const [join, setJoin] = useState<TailnetJoin>({ authKey: "", hostname: defaultHostname, controlServer: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && !confirm && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose, confirm]);
  const go = async (leave: boolean) => {
    setBusy(true); setError("");
    try {
      onJoined(await put<Tailnet>(path, { authKey: join.authKey.trim(), ...(join.hostname?.trim() ? { hostname: join.hostname.trim() } : {}), ...(join.controlServer?.trim() ? { controlServer: join.controlServer.trim() } : {}), ...(leave ? { leave: true } : {}) }));
    } catch (e) { setError(tailnetError(e as Error)); } finally { setBusy(false); }
  };
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-label={another ? "Connect to another tailnet" : "Connect"}>
      <div className="drawer-head">
        <h2>{another ? "Connect to another tailnet" : "Connect"}</h2>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (another) setConfirm(true); else void go(false); }}>
        <fieldset className="group" disabled={busy}>
          <legend>Tailnet</legend>
          <label className="field"><span>Auth key</span><input className="mono" type="password" autoComplete="off" autoFocus value={join.authKey} onChange={(e) => setJoin({ ...join, authKey: e.target.value })} /></label>
          <label className="field"><span>Hostname</span><input className="mono" value={join.hostname} onChange={(e) => setJoin({ ...join, hostname: e.target.value })} /></label>
          <details className="advanced"><summary>Advanced</summary>
            <label className="field"><span>Control server</span><input className="mono" placeholder="https://headscale.example.net" value={join.controlServer} onChange={(e) => setJoin({ ...join, controlServer: e.target.value })} /></label>
          </details>
        </fieldset>
        <ErrorText error={error} />
        <div className="row drawer-foot"><button type="submit" className="primary" disabled={busy || !join.authKey.trim()}>Connect</button></div>
      </form>
      {confirm && (
        <ConfirmDialog title={`Leave ${tailnet ?? "the tailnet"}?`} sentence="Her key there is removed, Web access over the tailnet stops, and connecting again needs a new auth key, and she joins the new one with this key." confirm="Leave" cancel="Stay" danger
          onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void go(true); }} />
      )}
    </aside>
  );
}
