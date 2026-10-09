// Unlock, login, and the signed-in shell.
import { useCallback, useEffect, useState } from "react";
import { get, post, whenAuthLost, type LoginResponse, type State } from "./api.ts";
import { go, useRoute } from "./route.ts";
import { Shell } from "./Shell.tsx";
import { ErrorText, useAction } from "./ui.tsx";

export function App() {
  const [state, setState] = useState<State>();
  const [unreachable, setUnreachable] = useState("");
  // One line about what just happened to the session, such as another user signed out.
  const [notice, setNotice] = useState("");
  const route = useRoute();

  const refresh = useCallback(() => {
    get<State>("/api/state").then((s) => { setState(s); setUnreachable(""); }, (e: Error) => setUnreachable(e.message));
  }, []);
  useEffect(() => { refresh(); whenAuthLost(refresh); }, [refresh]);

  const toast = notice && <Toast text={notice} onClose={() => setNotice("")} />;
  if (!state) return <Gate title="Lyrica">{unreachable ? <ErrorText error={unreachable} /> : <p className="muted">Connecting…</p>}</Gate>;
  if (state.locked) return <Unlock onDone={setState} />;
  const user = state.users.find((x) => "userId" in route && x.id === route.userId) ?? state.users[0];
  if (!user || route.page === "login") {
    return (
      <>
        <Login canCancel={state.users.length > 0} onDone={(r) => {
          if (r.replaced) setNotice("Signed out the previous user on this browser.");
          refresh();
          go({ page: "home", userId: r.user.id });
        }} />
        {toast}
      </>
    );
  }
  return (
    <>
      <Shell key={user.id} user={user} users={state.users} route={route}
        onAuthChange={(text) => { if (text) setNotice(text); refresh(); }} />
      {toast}
    </>
  );
}

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="gate-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Unlock({ onDone }: { onDone: (s: State) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [run, busy, error] = useAction();
  return (
    <Gate title="Unlock Lyrica">
      <p className="muted">Lyrica is locked. Enter the passphrase to unlock her.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(() => post<State>("/api/unlock", { passphrase }).then(onDone)); }}>
        <label className="field"><span>Passphrase</span>
          <input type="password" autoComplete="off" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <ErrorText error={error} />
        <button className="primary" disabled={busy || !passphrase}>Unlock</button>
      </form>
    </Gate>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      <button type="button" className="quiet" aria-label="Dismiss" onClick={onClose}>✕</button>
    </div>
  );
}

function Login({ canCancel, onDone }: { canCancel: boolean; onDone: (r: LoginResponse) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [run, busy, error] = useAction();
  return (
    <Gate title={canCancel ? "Log in as another user" : "Log in"}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(() => post<LoginResponse>("/api/login", { login, password }).then(onDone)); }}>
        <label className="field"><span>Login name</span>
          <input autoComplete="username" autoCapitalize="none" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className="field"><span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorText error={error} />
        <button className="primary" disabled={busy || !login || !password}>Log in</button>
        {canCancel && <p className="muted small">Only your linked personas can share this browser. Logging in as anyone else signs the others out here first.</p>}
        {canCancel && <a className="quiet" href="#/">Cancel</a>}
      </form>
    </Gate>
  );
}
