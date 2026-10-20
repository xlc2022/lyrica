// Administration → Reset and Settings → Reset (docs/ux.md §6 "Wiping memory"):
// Wipe memory… (everyone's) or Wipe my memory… (the user's own) opens a dialog
// with its sentence, Keep skills (ticked), an unticked box and the person's own password.
// While anything runs, the server sends it a stop and the dialog waits, showing
// what it is stopping, until the wipe can go ahead.
import { useEffect, useState } from "react";
import { get, HttpError, post, u, type WipeBusy, type WipeResult } from "./api.ts";
import { Section, retryMinutes } from "./Panel.tsx";
import type { ShellContext } from "./Shell.tsx";
import { Dialog, ErrorText } from "./ui.tsx";

const KIND: Record<WipeBusy["kind"], string> = { turn: "Reply", subagent: "Subagent", sleep: "Sleep" };
const POOL = { general: "General", private: "Private" } as const;
const POLL_MS = 1500;

/** `mine`: Settings' wipe of the user's own memory; otherwise Administration's wipe of everyone's. */
export function WipeSection({ ctx, mine }: { ctx: ShellContext; mine?: boolean }) {
  const [open, setOpen] = useState(false);
  const [wiped, setWiped] = useState(false);
  return (
    <Section title="Reset">
      <div className="row">
        <button type="button" className="danger" onClick={() => { setWiped(false); setOpen(true); }}>{mine ? "Wipe my memory…" : "Wipe memory…"}</button>
      </div>
      {wiped && <p className="meta">Memory wiped.</p>}
      {open && <WipeDialog userId={ctx.user.id} mine={!!mine} onCancel={() => setOpen(false)} onWiped={() => { setOpen(false); setWiped(true); }} />}
    </Section>
  );
}

function WipeDialog({ userId, mine, onCancel, onWiped }: { userId: string; mine: boolean; onCancel: () => void; onWiped: () => void }) {
  const [understood, setUnderstood] = useState(false);
  // Skills are procedures, not what was said: kept unless the person unticks it.
  const [keepSkills, setKeepSkills] = useState(true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set once a stop went out: what is still running, polled until nothing is.
  const [stopping, setStopping] = useState<WipeBusy[] | undefined>();
  const path = mine ? u(userId, "me", "wipe") : u(userId, "admin", "wipe");

  useEffect(() => {
    if (!stopping?.length) return;
    const timer = setInterval(() => { void get<WipeResult>(path).then((r) => setStopping(r.busy)).catch(() => {}); }, POLL_MS);
    return () => clearInterval(timer);
  }, [path, stopping?.length]);

  const wipe = async () => {
    setBusy(true); setError("");
    try {
      const r = await post<WipeResult>(path, { password, understood, keepSkills });
      if (r.wiped) onWiped();
      else setStopping(r.busy);
    } catch (e) {
      const err = e as Error;
      if (err instanceof HttpError && err.status === 401) setError("That isn't your password.");
      else if (err instanceof HttpError && err.status === 429) setError(`Too many tries. Try again in ${retryMinutes(err.message)} min.`);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const waiting = !!stopping?.length;
  return (
    <Dialog labelledBy="wipe-title" onCancel={onCancel} onSubmit={() => { if (!waiting && understood && password) void wipe(); }}>
      {stopping ? (
        <>
          <h2 id="wipe-title">{waiting ? (mine ? "Stopping your work" : "Stopping everything") : "Everything has stopped"}</h2>
          {waiting ? (
            <p className="wipe-wait"><span className="spinner" role="status" aria-label="Stopping" />{mine ? "A stop was sent to your running work." : "A stop was sent to everything running."} The wipe can go ahead once all of it has stopped.</p>
          ) : <p>Nothing is running now. The wipe can go ahead.</p>}
          {waiting && (
            <details className="wipe-busy">
              <summary><span className="num">{stopping.length}</span> running <span className="caret" aria-hidden="true">▾</span></summary>
              <ul>{stopping.map((b, i) => <li key={i}>{KIND[b.kind]} · {b.user}{b.pool ? ` · ${POOL[b.pool]}` : ""}</li>)}</ul>
            </details>
          )}
        </>
      ) : (
        <>
          <h2 id="wipe-title">{mine ? "Wipe your memory?" : "Wipe all memory?"}</h2>
          <p>{mine
            ? "Your threads, projects and memories in General and Private are deleted, with their thread files. Your password, endpoints, models and settings stay. This can't be undone."
            : "Every user's threads, projects and memories in General and Private are deleted, with their thread files. Users, passwords, endpoints, models and settings stay. This can't be undone."}</p>
          <label className="check"><input type="checkbox" checked={keepSkills} onChange={(e) => setKeepSkills(e.target.checked)} /> {mine ? "Keep my skills" : "Keep everyone's skills"}</label>
          <label className="check"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand this can't be undone</label>
          <label className="field"><span>Your password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        </>
      )}
      <ErrorText error={error} />
      <div className="dlg-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="danger primary" disabled={busy || waiting || !understood || !password}>Wipe memory</button>
      </div>
    </Dialog>
  );
}
