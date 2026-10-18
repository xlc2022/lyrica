// Settings → Codex (docs/ux.md §6): the user's own Codex, which makes ChatGPT Images. Codex's device sign-in, shown as its link and code.
import { useEffect } from "react";
import { del, get, post, u, type CodexStatus } from "./api.ts";
import type { ShellContext } from "./Shell.tsx";
import { Confirm, ErrorText, useAction, useLoad } from "./ui.tsx";

const CODEX_DESCRIPTION = "ChatGPT Images runs your own Codex, on your ChatGPT plan.";
const NOT_INSTALLED = "ChatGPT Images can't work until Codex is installed on this server.";

export function CodexSection({ ctx }: { ctx: ShellContext }) {
  const path = u(ctx.user.id, "codex");
  const status = useLoad(() => get<CodexStatus>(path), [path]);
  const [run, busy, error] = useAction();
  const s = status.data;
  // While a sign-in waits on the user, look again every few seconds for it to finish.
  const waiting = !!s?.signIn;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void get<CodexStatus>(path).then(status.set, () => {}), 3000);
    return () => clearInterval(timer);
  }, [waiting, path]);
  return (
    <section className="card" aria-labelledby="h-codex" aria-describedby="codex-description">
      <div className="section-head"><h2 id="h-codex" title={CODEX_DESCRIPTION}>Codex</h2></div>
      <p id="codex-description" className="sr-only">{CODEX_DESCRIPTION}</p>
      <ErrorText error={status.error || error} />
      {s?.signedIn ? (
        <div className="row">
          <span className="state-word"><span className="dot up" aria-hidden="true" />Signed in</span>
          <Confirm label="Sign out" danger question="ChatGPT Images stops working until you sign in again." confirm="Sign out"
            onConfirm={() => run(async () => { status.set(await del<CodexStatus>(path)); })} />
        </div>
      ) : s?.signIn ? (
        <>
          <p className="field"><span>Sign-in page</span><a href={s.signIn.url} target="_blank" rel="noopener noreferrer">{s.signIn.url}</a></p>
          <p className="field"><span>Code</span><code className="mono">{s.signIn.code}</code></p>
          <span className="state-word" role="status"><span className="dot info" aria-hidden="true" />Waiting for Codex</span>
        </>
      ) : s?.installed ? (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { status.set(await post<CodexStatus>(u(ctx.user.id, "codex", "sign-in"), {})); })}>Sign in</button>
          <span className="muted">What you ask it for goes to OpenAI.</span>
        </div>
      ) : s && (
        <span className="state-word" title={NOT_INSTALLED}>
          <span className="dot away" aria-hidden="true" />Not installed<span className="sr-only">. {NOT_INSTALLED}</span>
        </span>
      )}
    </section>
  );
}
