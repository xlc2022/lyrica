// Administration → Web search (docs/ux.md §6 "A web search provider"): the server's one SearXNG address.
import { useState } from "react";
import { get, put, u, type WebSearch } from "./api.ts";
import type { ShellContext } from "./Shell.tsx";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

export function WebSearchSection({ ctx }: { ctx: ShellContext }) {
  const path = u(ctx.user.id, "admin", "web-search");
  const search = useLoad(() => get<WebSearch>(path), [path]);
  const [run, busy, error] = useAction();
  const [address, setAddress] = useState<string>();
  const saved = search.data?.searxng ?? "";
  const save = () => run(async () => { search.set(await put<WebSearch>(path, { searxng: address ?? saved })); setAddress(undefined); });
  // The password never comes back: the address shows with its user only, and saving it unchanged keeps the password.
  const s = search.data;
  return (
    <section className="card" aria-labelledby="h-web-search">
      <div className="section-head"><h2 id="h-web-search">Web search</h2></div>
      <ErrorText error={search.error || error} />
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field grow" title={search.data?.auth ? "Its password is kept. Type user:password@ to replace it." : "Add user:password@ to the address to use basic auth."}><span>SearXNG address</span>
          <input className="mono" name="searxng" type="url" placeholder="https://search.example.org" autoComplete="off" value={address ?? saved} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || address === undefined || address.trim() === saved}>Save</button>
      </form>
      {s && s.state !== "unset" && (
        <span className="state-word" title={s.reason}>
          <span className={`dot ${s.state === "reachable" ? "up" : "away"}`} aria-hidden="true" />{s.state === "reachable" ? "Reachable" : "Unreachable"}
        </span>
      )}
    </section>
  );
}
