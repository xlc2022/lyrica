// Principles 6 and 2: decision requests reach the user without exposing their words.
import { useState } from "react";
import { del, errorFrom, get, put, u, type PushInfo, type PushSettings } from "./api.ts";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

export const PUSH_DESCRIPTION = "Pushes say only that something waits, never what. A link shows the receiver this server's address.";
const OFF: PushInfo = { host: "", path: "", set: false, token: false, link: false };

/** Replace the saved destination; the origin is captured when Save is pressed. */
export const savePush = (userId: string, settings: PushSettings) => put<PushInfo>(u(userId, "push"), settings);
export const turnOffPush = (userId: string) => del<void>(u(userId, "push"));

/** The test endpoint's 502 body describes the receiver, rather than an ordinary API error. */
export async function testPush(userId: string): Promise<string> {
  const res = await fetch(`${u(userId, "push")}/test`, { method: "POST", credentials: "same-origin" });
  if (res.status === 502) {
    const result = await res.json() as { status: number; reason: string };
    return `${result.status}: ${result.reason}`;
  }
  if (!res.ok) throw await errorFrom(res);
  return "Sent";
}

export function PushFailure({ failure }: { failure?: PushInfo["lastFailure"] }) {
  if (!failure) return null;
  const date = new Date(failure.at);
  return <p className="warn-text" role="status">Last push failed at <time className="num" dateTime={failure.at} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>: <span className="num">{failure.status}</span></p>;
}

export function PushSection({ userId }: { userId: string }) {
  const path = u(userId, "push");
  const saved = useLoad(() => get<PushInfo>(path), [path]);
  const [run, busy, error] = useAction();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [link, setLink] = useState<boolean>();
  const [result, setResult] = useState("");
  const info = saved.data;
  const clearDraft = () => { setUrl(""); setToken(""); setLink(undefined); setResult(""); };
  return <section className="card" aria-labelledby="h-push" aria-describedby="push-description">
    <h2 id="h-push" title={PUSH_DESCRIPTION}>Push</h2>
    <p id="push-description" className="sr-only">{PUSH_DESCRIPTION}</p>
    <ErrorText error={saved.error || error} />
    {info && <>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        saved.set(await savePush(userId, { url: url.trim(), ...(token ? { token } : {}), link: link ?? info.link, origin: location.origin } satisfies PushSettings));
        clearDraft();
      }); }}>
        <label className="field" title={info.set ? "Enter the full URL and optional token again to replace the saved settings." : undefined}><span>URL</span>
          <input className="mono" type="url" required autoComplete="off" placeholder={info.set ? `${info.host}${info.path}` : "https://ntfy.sh/<topic>"} value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
        </label>
        <label className="field"><span>Token <span className="muted">(optional)</span></span>
          <input className="mono" type="password" autoComplete="new-password" placeholder={info.token ? "Set" : ""} value={token} onChange={(e) => setToken(e.target.value)} disabled={busy} />
        </label>
        <label className="check"><input type="checkbox" checked={link ?? info.link} disabled={busy} onChange={(e) => setLink(e.target.checked)} /> Include a link</label>
        <div className="row"><button className="primary" disabled={busy || !url.trim()}>Save</button></div>
      </form>
      {info.set && <div className="row wrap">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          setResult("");
          setResult(await testPush(userId));
          saved.set(await get<PushInfo>(path));
        })}>Send a test</button>
        <button type="button" disabled={busy} onClick={() => run(async () => { await turnOffPush(userId); saved.set({ ...OFF }); clearDraft(); })}>Turn off</button>
      </div>}
      {result && <p role="status">{result}</p>}
      <PushFailure failure={info.lastFailure} />
    </>}
  </section>;
}
