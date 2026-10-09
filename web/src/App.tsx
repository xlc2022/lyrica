// Unlock, login, and the signed-in shell.
import { useCallback, useEffect, useState } from "react";
import { get, post, whenAuthLost, type LoginResponse, type State } from "./api.ts";
import { go, useRoute } from "./route.ts";
import { Shell } from "./Shell.tsx";
import { ErrorText, useAction } from "./ui.tsx";

export function App() {
  const [state, setState] = useState<State>();
  const [unreachable, setUnreachable] = useState("");
  const route = useRoute();

  const refresh = useCallback(() => {
    get<State>("/api/state").then((s) => { setState(s); setUnreachable(""); }, (e: Error) => setUnreachable(e.message));
  }, []);
  useEffect(() => { refresh(); whenAuthLost(refresh); }, [refresh]);

  if (!state) return <Gate title="Lyrica">{unreachable ? <ErrorText error={unreachable} /> : <p className="muted">Connecting…</p>}</Gate>;
  if (state.locked) return <Unlock onDone={setState} />;
  const user = state.users.find((x) => "userId" in route && x.id === route.userId) ?? state.users[0];
  if (!user || route.page === "login") {
    return <Login canCancel={state.users.length > 0} onDone={(id) => { refresh(); go({ page: "home", userId: id }); }} />;
  }
  return <Shell key={user.id} user={user} users={state.users} route={route} onAuthChange={refresh} />;
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

function Login({ canCancel, onDone }: { canCancel: boolean; onDone: (userId: string) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [run, busy, error] = useAction();
  return (
    <Gate title={canCancel ? "Add a user" : "Log in"}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(() => post<LoginResponse>("/api/login", { login, password }).then((r) => onDone(r.user.id))); }}>
        <label className="field"><span>Login name</span>
          <input autoComplete="username" autoCapitalize="none" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className="field"><span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorText error={error} />
        <button className="primary" disabled={busy || !login || !password}>Log in</button>
        {canCancel && <a className="quiet" href="#/">Cancel</a>}
      </form>
    </Gate>
  );
}
