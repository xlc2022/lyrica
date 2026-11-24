// Administration → Web search (docs/ux.md §6 "A web search provider"): the
// server's one SearXNG address, the kiwix-serve with its offline copy of Wikipedia, whether browse may
// tick a simple bot-check box, and Mullvad (docs/ux.md, "Mullvad"): the WireGuard configuration the
// threads' Mullvad switch uses, its state, and whether SearXNG goes through it too.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
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
      {s && <MullvadPart s={s} apply={async (c) => { const next = await put<WebSearch>(path, c); search.set(next); ctx.setMe({ ...ctx.me, mullvad: next.mullvad }); }} />}
    </section>
  );
}

const PASTE_HINT = "A WireGuard configuration from mullvad.net/account/wireguard-config. It takes one of the account's five devices.";

/** The tunnel's line: a dot and a word, and the place muted after it. Why it isn't connected is a line of its own (MullvadPart). */
function MullvadState({ s }: { s: WebSearch }) {
  const [dot, word] = s.mullvadState === "connected" ? ["up", "Connected"] : s.mullvadState === "failed" ? ["down", "Not connected"] : ["away", "Connecting"];
  const place = [s.mullvadCity, s.mullvadCountry].filter(Boolean).join(", ");
  const title = s.mullvadState === "connected" && s.mullvadIp ? `Sites see ${s.mullvadIp}.` : undefined;
  return (
    <span className="state-word" data-for="mullvad" title={title}>
      <span className={`dot ${dot}`} aria-hidden="true" />{word}{place && <span className="muted"> · {place}</span>}
    </span>
  );
}

type MullvadChange = { mullvad?: string | null; searxngMullvad?: boolean };

/** Each of the part's actions keeps its own error: the drawer's and the dialog's go when they close, and none shows at the card's top. */
function MullvadPart({ s, apply }: { s: WebSearch; apply: (c: MullvadChange) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [run, busy, error] = useAction();
  return (
    <>
      <div className="eyebrow">Mullvad</div>
      <div className="field mullvad-row"><span>Server</span>
        <span className="mullvad-facts">
          {s.mullvad ? <><span className="mono">{s.mullvadServer}</span> <MullvadState s={s} /></> : <span className="muted">Not set up</span>}
        </span>
        {s.mullvad && s.mullvadState === "failed" && s.mullvadReason && <span className="muted small" data-for="mullvad-reason">{s.mullvadReason}</span>}
        <span className="inline">
          <button type="button" title={PASTE_HINT} onClick={() => setEditing(true)}>{s.mullvad ? "Replace…" : "Set up…"}</button>
          {s.mullvad && <button type="button" className="danger" onClick={() => setRemoving(true)}>Remove…</button>}
        </span>
      </div>
      <Switch label="SearXNG through Mullvad" hint={`On, SearXNG's searches leave through Mullvad too. Search engines refuse some Mullvad addresses.${s.mullvad ? "" : " Needs Mullvad set up."}`}
        checked={s.searxngMullvad} disabled={busy || !s.mullvad} onChange={(on) => void run(() => apply({ searxngMullvad: on }))} />
      <ErrorText error={error} />
      {editing && (
        <>
          <MullvadDrawer onClose={() => setEditing(false)} onSave={async (text) => { await apply({ mullvad: text }); setEditing(false); }} />
          <div className="scrim drawer-scrim" aria-hidden="true" onClick={() => setEditing(false)} />
        </>
      )}
      {removing && <MullvadRemove onClose={() => setRemoving(false)} onRemove={async () => { await apply({ mullvad: null }); setRemoving(false); }} />}
    </>
  );
}

function MullvadRemove({ onRemove, onClose }: { onRemove: () => Promise<void>; onClose: () => void }) {
  const [run, busy, error] = useAction();
  return (
    <Dialog labelledBy="mullvad-remove" onCancel={onClose} onSubmit={() => void run(onRemove)}>
      <h2 id="mullvad-remove">Remove Mullvad?</h2>
      <p>Threads with Mullvad on have no internet until it is set up again, and SearXNG goes direct.</p>
      <ErrorText error={error} />
      <div className="dlg-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary danger" autoFocus disabled={busy}>Remove</button></div>
    </Dialog>
  );
}

/** The configuration, pasted: the text never comes back from the server, so the field starts empty each time. */
function MullvadDrawer({ onSave, onClose }: { onSave: (text: string) => Promise<void>; onClose: () => void }) {
  const [run, busy, error] = useAction();
  const [text, setText] = useState("");
  // A reason for the last Save stays only until the text changes.
  const [edited, setEdited] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" aria-labelledby="mullvad-drawer">
      <div className="drawer-head">
        <h2 id="mullvad-drawer">Mullvad</h2>
        <button type="button" className="icon sm" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { setEdited(false); void run(() => onSave(text)); } }}>
        <label className="field" title={PASTE_HINT}><span>WireGuard configuration</span>
          <textarea className="code" name="mullvad" rows={12} spellCheck={false} autoComplete="off" autoFocus
            placeholder={"[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\nPublicKey = …\nEndpoint = …"} value={text} onChange={(e) => { setText(e.target.value); setEdited(true); }} />
        </label>
        <ErrorText error={edited ? "" : error} />
        <div className="row drawer-foot">
          <button type="submit" className="primary" disabled={busy || !text.trim()}>Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </aside>
  );
}
