// Administration → Web search (docs/ux.md §6 "A web search provider"): the
// server's one SearXNG address, the kiwix-serve with its offline copy of Wikipedia, whether browse may
// tick a simple bot-check box, and Mullvad (docs/ux.md, "Mullvad"): the WireGuard configuration the
// threads' Mullvad switch uses, its state, and whether SearXNG goes through it too.
import { useState } from "react";
import { get, put, u, type WebSearch } from "./api.ts";
import { her } from "./name.ts";
import type { ShellContext } from "./Shell.tsx";
import { Dialog, ErrorText, Switch, useAction, useLoad } from "./ui.tsx";

/** The Mullvad switch's tooltip, here and in Settings → Network, with what it needs while it can't be turned on. */
export function mullvadHint(internet: boolean, setUp: boolean): string {
  return `On: her commands, fetches and browser reach the internet only through Mullvad, so sites see Mullvad's address, not this server's. Programs that ignore proxy settings get no internet.${internet ? "" : " Needs Internet."}${setUp ? "" : " Needs Mullvad set up in Administration."}`;
}


export function WebSearchSection({ ctx }: { ctx: ShellContext }) {
  const path = u(ctx.user.id, "admin", "web-search");
  const search = useLoad(() => get<WebSearch>(path), [path]);
  const [run, busy, error] = useAction();
  const [address, setAddress] = useState<string>();
  const [kiwix, setKiwix] = useState<string>();
  const s = search.data;
  const saved = s?.searxng ?? "";
  const savedKiwix = s?.kiwix ?? "";
  const changed = (address !== undefined && address.trim() !== saved) || (kiwix !== undefined && kiwix.trim() !== savedKiwix);
  // The password never comes back: the address shows with its user only, and saving it unchanged keeps the password.
  const save = () => run(async () => {
    search.set(await put<WebSearch>(path, { searxng: address ?? saved, kiwix: kiwix ?? savedKiwix }));
    setAddress(undefined);
    setKiwix(undefined);
  });
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
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field" title={s?.auth ? "Its password is kept. Type user:password@ to replace it." : "Add user:password@ to the address to use basic auth."}><span>SearXNG address</span>
          <input className="mono" name="searxng" type="url" placeholder="https://search.example.org" autoComplete="off" value={address ?? saved} onChange={(e) => setAddress(e.target.value)} />
        </label>
        {s && s.state !== "unset" && state("searxng", s.state === "reachable", s.reason)}
        <label className="field" title="The kiwix-serve with an offline copy of Wikipedia: searches add its articles, and a wikipedia.org page is read from it."><span>Kiwix address</span>
          <input className="mono" name="kiwix" type="url" placeholder="http://127.0.0.1:8889" autoComplete="off" value={kiwix ?? savedKiwix} onChange={(e) => setKiwix(e.target.value)} />
        </label>
        {s && s.kiwixState !== "unset" && state("kiwix", s.kiwixState === "reachable", s.kiwixState === "reachable" ? books : s.kiwixReason)}
        <div className="inline"><button className="primary" disabled={busy || !changed}>Save</button></div>
      </form>
      {s && <Switch label="Tick bot checks" hint={`Off, ${her()} gets no word about them. On, when a page she browses shows a simple “I'm not a robot” check box, she may tick it.`}
        checked={s.botChecks} disabled={busy} onChange={(on) => run(async () => search.set(await put<WebSearch>(path, { botChecks: on })))} />}
      {s && <MullvadPart s={s} busy={busy} save={(c) => run(async () => { const next = await put<WebSearch>(path, c); search.set(next); ctx.setMe({ ...ctx.me, mullvad: next.mullvad }); })} />}
    </section>
  );
}

const PASTE_HINT = "A WireGuard configuration from mullvad.net/account/wireguard-config. It takes one of the account's five devices.";

/** The tunnel's line: a dot and a word, the place muted after it, and why in the tooltip. */
function MullvadState({ s }: { s: WebSearch }) {
  const [dot, word] = s.mullvadState === "connected" ? ["up", "Connected"] : s.mullvadState === "failed" ? ["down", "Not connected"] : ["away", "Connecting"];
  const place = [s.mullvadCity, s.mullvadCountry].filter(Boolean).join(", ");
  const title = s.mullvadState === "connected" ? (s.mullvadIp ? `Sites see ${s.mullvadIp}.` : undefined) : s.mullvadReason;
  return (
    <span className="state-word" data-for="mullvad" title={title}>
      <span className={`dot ${dot}`} aria-hidden="true" />{word}{place && <span className="muted"> · {place}</span>}
    </span>
  );
}

function MullvadPart({ s, busy, save }: { s: WebSearch; busy: boolean; save: (c: { mullvad?: string | null; searxngMullvad?: boolean }) => Promise<boolean> }) {
  const [text, setText] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const editing = !s.mullvad || text !== undefined;
  return (
    <>
      <div className="eyebrow">Mullvad</div>
      {editing ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save({ mullvad: text ?? "" }).then((ok) => { if (ok) setText(undefined); }); }}>
          <label className="field" title={PASTE_HINT}><span>WireGuard configuration</span>
            <textarea className="code" name="mullvad" rows={7} spellCheck={false} autoComplete="off" placeholder={"[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\nPublicKey = …\nEndpoint = …"}
              value={text ?? ""} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="inline">
            <button className="primary" disabled={busy || !text?.trim()}>Save</button>
            {s.mullvad && <button type="button" onClick={() => setText(undefined)}>Cancel</button>}
          </div>
        </form>
      ) : (
        <div className="field mullvad-row"><span>Server</span>
          <span className="mullvad-facts"><span className="mono">{s.mullvadServer}</span> <MullvadState s={s} /></span>
          <span className="inline">
            <button type="button" title={PASTE_HINT} onClick={() => setText("")}>Replace…</button>
            <button type="button" className="danger" onClick={() => setRemoving(true)}>Remove…</button>
          </span>
        </div>
      )}
      <Switch label="SearXNG through Mullvad" hint={`On, SearXNG's searches leave through Mullvad too. Search engines refuse some Mullvad addresses.${s.mullvad ? "" : " Needs Mullvad set up."}`}
        checked={s.searxngMullvad} disabled={busy || !s.mullvad} onChange={(on) => void save({ searxngMullvad: on })} />
      {removing && (
        <Dialog labelledBy="mullvad-remove" onCancel={() => setRemoving(false)} onSubmit={() => void save({ mullvad: null }).then((ok) => { if (ok) setRemoving(false); })}>
          <h2 id="mullvad-remove">Remove Mullvad?</h2>
          <p>Threads with Mullvad on have no internet until it is set up again, and SearXNG goes direct.</p>
          <div className="dlg-actions"><button type="button" onClick={() => setRemoving(false)}>Cancel</button><button type="submit" className="primary danger" autoFocus disabled={busy}>Remove</button></div>
        </Dialog>
      )}
    </>
  );
}
