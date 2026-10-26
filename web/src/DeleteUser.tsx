// Administration → Users (docs/ux.md §6 "Deleting a user"): Delete user… on
// another user's row opens a dialog with its sentence, an unticked box and the
// administrator's own password. While the user's work runs, the server sends it
// a stop and the dialog waits, showing what it is stopping, as a wipe does.
import { useEffect, useState } from "react";
import { get, HttpError, post, u, type DeleteUserResult, type UserCard, type WipeBusy } from "./api.ts";
import { retryMinutes } from "./Panel.tsx";
import { Dialog, ErrorText } from "./ui.tsx";
import { KIND, POLL_MS, POOL } from "./Wipe.tsx";

export function DeleteUserButton({ userId, target, onDeleted }: { userId: string; target: UserCard; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="sm danger" onClick={() => setOpen(true)}>Delete user…</button>
      {open && <DeleteUserDialog userId={userId} target={target} onCancel={() => setOpen(false)} onDeleted={() => { setOpen(false); onDeleted(); }} />}
    </>
  );
}

function DeleteUserDialog({ userId, target, onCancel, onDeleted }: { userId: string; target: UserCard; onCancel: () => void; onDeleted: () => void }) {
  const [understood, setUnderstood] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set once a stop went out: what of theirs is still running, polled until nothing is.
  const [stopping, setStopping] = useState<WipeBusy[] | undefined>();
  const path = u(userId, "admin", "users", target.id, "delete");
  const name = target.displayName;

  useEffect(() => {
    if (!stopping?.length) return;
    const timer = setInterval(() => { void get<DeleteUserResult>(path).then((r) => setStopping(r.busy)).catch(() => {}); }, POLL_MS);
    return () => clearInterval(timer);
  }, [path, stopping?.length]);

  const remove = async () => {
    setBusy(true); setError("");
    try {
      const r = await post<DeleteUserResult>(path, { password, understood });
      if (r.deleted) onDeleted();
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
    <Dialog labelledBy="delete-user-title" onCancel={onCancel} onSubmit={() => { if (!waiting && understood && password) void remove(); }}>
      {stopping ? (
        <>
          <h2 id="delete-user-title">{waiting ? `Stopping ${name}'s work` : "Everything has stopped"}</h2>
          {waiting ? (
            <p className="wipe-wait"><span className="spinner" role="status" aria-label="Stopping" />A stop was sent to {name}'s running work. The delete can go ahead once all of it has stopped.</p>
          ) : <p>Nothing of {name}'s is running now. The delete can go ahead.</p>}
          {waiting && (
            <details className="wipe-busy">
              <summary><span className="num">{stopping.length}</span> running <span className="caret" aria-hidden="true">▾</span></summary>
              <ul>{stopping.map((b, i) => <li key={i}>{KIND[b.kind]}{b.pool ? ` · ${POOL[b.pool]}` : ""}</li>)}</ul>
            </details>
          )}
        </>
      ) : (
        <>
          <h2 id="delete-user-title">Delete {name}?</h2>
          <p>{name}'s login, threads, projects, memories, files, photos and settings are deleted. Threads {name} already shared stay with the people who accepted them. This can't be undone.</p>
          <label className="check"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand this can't be undone</label>
          <label className="field"><span>Your password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        </>
      )}
      <ErrorText error={error} />
      <div className="dlg-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="danger primary" disabled={busy || waiting || !understood || !password}>Delete user</button>
      </div>
    </Dialog>
  );
}
