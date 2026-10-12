// Settings → Claude Code (docs/ux.md §6): the token `claude setup-token` prints, so threads with the switch on run Claude Code on the user's Claude plan.
import { useState } from "react";
import { del, get, put, u, type ClaudeCodeStatus } from "./api.ts";
import type { ShellContext } from "./Shell.tsx";
import { Confirm, ErrorText, useAction, useLoad } from "./ui.tsx";

export function ClaudeCodeSection({ ctx }: { ctx: ShellContext }) {
  const path = u(ctx.user.id, "claude-code");
  const status = useLoad(() => get<ClaudeCodeStatus>(path), [path]);
  const [run, busy, error] = useAction();
  const [token, setToken] = useState("");
  const s = status.data;
  // The token never comes back: a saved one shows only as Signed in.
  return (
    <section className="card" aria-labelledby="h-claude-code">
      <div className="section-head"><h2 id="h-claude-code">Claude Code</h2></div>
      <ErrorText error={status.error || error} />
      {s?.token ? (
        <div className="row">
          <span className="state-word"><span className="dot up" aria-hidden="true" />Signed in</span>
          <Confirm label="Remove" danger question="Threads stop getting Claude Code at their next command." confirm="Remove"
            onConfirm={() => run(async () => { status.set(await del<ClaudeCodeStatus>(path)); })} />
        </div>
      ) : (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { status.set(await put<ClaudeCodeStatus>(path, { token })); setToken(""); }); }}>
          <label className="field grow" title="Run claude setup-token on your own computer and paste the token it prints."><span>Token</span>
            <input className="mono" name="claude-code-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <button className="primary" disabled={busy || !token.trim()}>Save token</button>
        </form>
      )}
      {s && !s.installed && (
        <span className="state-word" title="No thread can use Claude Code until it is installed on this server.">
          <span className="dot away" aria-hidden="true" />Not installed
        </span>
      )}
    </section>
  );
}
