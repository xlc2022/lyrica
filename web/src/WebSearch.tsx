// Administration → Web search (docs/ux.md §6 "A web search provider"): the
// server's one SearXNG address, and the kiwix-serve with its offline copy of Wikipedia.
import { useState } from "react";
import { get, put, u, type WebSearch } from "./api.ts";
import type { ShellContext } from "./Shell.tsx";
import { ErrorText, useAction, useLoad } from "./ui.tsx";

export function WebSearchSection({ ctx }: { ctx: ShellContext }) {
  const path = u(ctx.user.id, "admin", "web-search");
  const search = useLoad(() => get<WebSearch>(path), [path]);
  const [run, busy, error] = useAction();
  const [address, setAddress] = useState<string>();
  const [kiwix, setKiwix] = useState<string>();
  const s = search.data;
  const saved = s?.searxng ?? "";
  const savedKiwix = s?.kiwix ?? "";
  // The password never comes back: the address shows with its user only, and saving it unchanged keeps the password.
  const save = () => run(async () => { search.set(await put<WebSearch>(path, { searxng: address ?? saved })); setAddress(undefined); });
  const saveKiwix = () => run(async () => { search.set(await put<WebSearch>(path, { kiwix: kiwix ?? savedKiwix })); setKiwix(undefined); });
  const books = s?.books.map((b) => `${b.title}${b.date ? ` ${b.date.slice(0, 7)}` : ""} (${b.language})`).join(", ");
  const state = (which: "searxng" | "kiwix", up: boolean, title: string | undefined) => (
    <span className="state-word" data-for={which} title={title}>
      <span className={`dot ${up ? "up" : "away"}`} aria-hidden="true" />{up ? "Reachable" : "Unreachable"}
    </span>
  );
  return (
    <section className="card" aria-labelledby="h-web-search">
      <div className="section-head"><h2 id="h-web-search">Web search</h2></div>
      <ErrorText error={search.error || error} />
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field grow" title={s?.auth ? "Its password is kept. Type user:password@ to replace it." : "Add user:password@ to the address to use basic auth."}><span>SearXNG address</span>
          <input className="mono" name="searxng" type="url" placeholder="https://search.example.org" autoComplete="off" value={address ?? saved} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || address === undefined || address.trim() === saved}>Save</button>
      </form>
      {s && s.state !== "unset" && state("searxng", s.state === "reachable", s.reason)}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void saveKiwix(); }}>
        <label className="field grow" title="The kiwix-serve with an offline copy of Wikipedia: searches add its articles, and a wikipedia.org page is read from it."><span>Kiwix address</span>
          <input className="mono" name="kiwix" type="url" placeholder="http://127.0.0.1:8889" autoComplete="off" value={kiwix ?? savedKiwix} onChange={(e) => setKiwix(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || kiwix === undefined || kiwix.trim() === savedKiwix}>Save</button>
      </form>
      {s && s.kiwixState !== "unset" && state("kiwix", s.kiwixState === "reachable", s.kiwixState === "reachable" ? books : s.kiwixReason)}
    </section>
  );
}
