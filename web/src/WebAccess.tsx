// Administration: how Lyrica is reached, through the built-in Caddy or a proxy elsewhere.
import { useEffect, useState } from "react";
import {
  get, put, u,
  type WebAccess, type WebAccessChange, type WebAccessSnippet, type WebAccessStatus, type WebMode,
} from "./api.ts";
import { ErrorText, Switch, useAction, useLoad } from "./ui.tsx";

const MODES: { mode: WebMode; label: string; hint: string }[] = [
  { mode: "off", label: "Only this machine", hint: "Nothing listens beyond 127.0.0.1." },
  { mode: "builtin", label: "Built-in Caddy", hint: "Lyrica runs Caddy on the addresses you pick, with a certificate for your hostname from a DNS challenge." },
  { mode: "external", label: "A proxy elsewhere", hint: "Another machine's proxy forwards to an address here." },
];

export function WebAccessSection({ userId }: { userId: string }) {
  const path = u(userId, "admin", "web-access");
  const access = useLoad(() => get<WebAccess>(path), [path]);
  const status = useLoad(() => get<WebAccessStatus>(`${path}/status`), [path]);
  if (!access.data) return <ErrorText error={access.error} />;
  return (
    <>
      <WebAccessForm key={JSON.stringify(access.data)} path={path} access={access.data}
        onSaved={(a) => { access.set(a); status.reload(); }} />
      <Status status={status.data} error={status.error} onRefresh={status.reload}
        staging={access.data.mode === "builtin" && !!access.data.builtin?.staging} />
      {access.data.mode === "external" && <Snippet path={path} />}
    </>
  );
}

function WebAccessForm({ path, access, onSaved }: { path: string; access: WebAccess; onSaved: (a: WebAccess) => void }) {
  const [mode, setMode] = useState(access.mode);
  const [name, setName] = useState(access.name);
  const b = access.builtin;
  const [addresses, setAddresses] = useState<string[]>(b?.addresses ?? []);
  const [provider, setProvider] = useState(b?.provider ?? access.providers[0]?.id ?? "");
  const [credentials, setCredentials] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(b?.credentials ?? {}).flatMap(([k, v]) => (v.value !== undefined ? [[k, v.value]] : []))));
  const [email, setEmail] = useState(b?.email ?? "");
  const [staging, setStaging] = useState(b?.staging ?? false);
  const e = access.external;
  const [extAddress, setExtAddress] = useState(e?.address ?? access.addresses[0]?.address ?? "");
  const [port, setPort] = useState(String(e?.port ?? 8443));
  const [proxies, setProxies] = useState((e?.proxies ?? []).join(", "));
  const [proxyPort, setProxyPort] = useState(String(e?.proxyPort ?? 443));
  const [run, busy, error] = useAction();
  const elapsed = useElapsed(busy);
  const chosen = access.providers.find((p) => p.id === provider);
  const saved = (field: string) => b?.provider === provider && b.credentials[field]?.set;

  const save = () => run(async () => {
    const change: WebAccessChange = { mode, ...(mode !== "off" && { name: name.trim() }) };
    if (mode === "builtin") {
      // Secret fields left empty keep their saved values.
      const creds = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v !== ""));
      change.builtin = { addresses, provider, credentials: creds, ...(email && { email }), staging };
    }
    if (mode === "external") {
      change.external = {
        address: extAddress, port: Number(port), proxyPort: Number(proxyPort),
        proxies: proxies.split(/[\s,]+/).filter(Boolean),
      };
    }
    onSaved(await put<WebAccess>(path, change));
  });

  return (
    <form className="stack" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
      <fieldset className="group" disabled={busy}>
        <legend>How Lyrica is reached</legend>
        {MODES.map((m) => (
          <label key={m.mode} className="switch">
            <input type="radio" name="web-mode" checked={mode === m.mode} onChange={() => setMode(m.mode)} />
            <span>{m.label}</span>
            <small>{m.hint}</small>
          </label>
        ))}
      </fieldset>

      {mode !== "off" && (
        <label className="field"><span>Hostname</span>
          <input value={name} placeholder="lyrica.example.net" autoCapitalize="none" disabled={busy} onChange={(ev) => setName(ev.target.value)} />
          <small className="muted">The address you'll open in the browser, for example lyrica.example.net. Its DNS record should point at this machine's Tailscale address.</small>
        </label>
      )}

      {mode === "builtin" && (
        <fieldset className="group" disabled={busy}>
          <legend>Built-in Caddy</legend>
          <div className="field"><span>Serve on</span>
            {access.addresses.map((a) => (
              <label key={a.address} className="check">
                <input type="checkbox" checked={addresses.includes(a.address)}
                  onChange={(ev) => setAddresses(ev.target.checked ? [...addresses, a.address] : addresses.filter((x) => x !== a.address))} />
                <code>{a.address}</code> <span className="muted">{a.kind === "tailscale" ? "Tailscale" : "LAN"} · {a.interface}</span>
              </label>
            ))}
            {!access.addresses.length && <span className="muted small">This machine has no Tailscale or LAN address.</span>}
          </div>
          <label className="field"><span>DNS provider</span>
            <select value={provider} onChange={(ev) => { setProvider(ev.target.value); setCredentials({}); }}>
              {access.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {chosen?.fields.map((f) => (
            <label key={f.name} className="field"><span>{f.label}{f.optional && " (optional)"}</span>
              <input type={f.secret ? "password" : "text"} autoComplete="off" value={credentials[f.name] ?? ""}
                placeholder={f.secret && saved(f.name) ? "Saved; leave empty to keep it" : ""}
                onChange={(ev) => setCredentials({ ...credentials, [f.name]: ev.target.value })} />
            </label>
          ))}
          {chosen?.hint && <p className="muted small">{chosen.hint}</p>}
          <label className="field"><span>Email for certificate warnings (optional)</span>
            <input type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} />
            <small className="muted">Let's Encrypt may write to this address if a certificate can't be renewed. It isn't used for anything else.</small>
          </label>
          <details className="advanced" open={staging || undefined}>
            <summary>Advanced</summary>
            <Switch label="Test with untrusted certificates"
              hint="Uses Let's Encrypt's test service while you try out DNS settings. It has much higher rate limits, but browsers won't trust its certificates, so turn it off once it works."
              checked={staging} onChange={setStaging} />
          </details>
        </fieldset>
      )}

      {mode === "external" && (
        <fieldset className="group" disabled={busy}>
          <legend>Proxy elsewhere</legend>
          <label className="field"><span>Listen for the proxy on</span>
            <select value={extAddress} onChange={(ev) => setExtAddress(ev.target.value)}>
              {access.addresses.map((a) => <option key={a.address} value={a.address}>{a.address} ({a.kind === "tailscale" ? "Tailscale: plain HTTP" : "LAN: HTTPS"})</option>)}
            </select>
          </label>
          <div className="row wrap">
            <label className="field narrow"><span>Port</span><input inputMode="numeric" value={port} onChange={(ev) => setPort(ev.target.value)} /></label>
            <label className="field narrow"><span>Proxy's HTTPS port</span><input inputMode="numeric" value={proxyPort} onChange={(ev) => setProxyPort(ev.target.value)} /></label>
          </div>
          <label className="field"><span>Proxy addresses</span>
            <input value={proxies} placeholder="192.168.1.10" onChange={(ev) => setProxies(ev.target.value)} />
            <small className="muted">Only these may connect, and only their X-Forwarded-For is trusted.</small>
          </label>
          {e?.https && e.fingerprint && (
            <div className="field"><span>Certificate for the proxy to pin</span>
              <code className="url">{e.fingerprint}</code>
              {e.pem && <textarea readOnly rows={4} value={e.pem} onFocus={(ev) => ev.target.select()} />}
            </div>
          )}
        </fieldset>
      )}

      <ErrorText error={error} />
      {busy && <p className="muted" role="status">Applying… {elapsed} s. A new hostname can take up to 90 s while its certificate is checked; the old setup keeps running until then.</p>}
      <div className="row"><button className="primary" disabled={busy || (mode !== "off" && !name.trim())}>Apply</button></div>
    </form>
  );
}

function useElapsed(running: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    setS(0);
    const t = setInterval(() => setS((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  return s;
}

function Status({ status, error, onRefresh, staging }: { status?: WebAccessStatus; error: string; onRefresh: () => void; staging: boolean }) {
  return (
    <section className="stack sub-card" aria-label="Web access status">
      <div className="row between"><h3>Status</h3><button type="button" onClick={onRefresh}>Check again</button></div>
      <ErrorText error={error} />
      {staging && <p className="warn-text" role="status">Testing with untrusted certificates: browsers will warn about this hostname until you turn it off under Advanced.</p>}
      {status && (
        <dl className="facts">
          {status.name && <><dt>Hostname</dt><dd>{status.name}</dd></>}
          {status.caddy && (
            <>
              <dt>Caddy</dt>
              <dd>{!status.caddy.answers ? "Not answering" : !status.caddy.configured ? "Running without a site: its saved setup couldn't load" : status.caddy.applied ? "Running Lyrica's setup" : "Running a different setup"}</dd>
            </>
          )}
          {status.certificate && (
            <>
              <dt>Certificate</dt>
              <dd>{"error" in status.certificate ? <span className="error">{status.certificate.error}</span>
                : `${status.certificate.subject}, from ${status.certificate.issuer}, until ${status.certificate.notAfter.slice(0, 10)}`}</dd>
            </>
          )}
          {status.lastAcmeError && (
            <>
              <dt>Last certificate error</dt>
              <dd className="error">{status.lastAcmeError.message} <span className="muted">({status.lastAcmeError.at.slice(0, 16).replace("T", " ")})</span></dd>
            </>
          )}
          {status.external && (
            <>
              <dt>For the proxy</dt>
              <dd>{status.external.listening ? "Listening" : "Not listening"} on {status.external.address}:{status.external.port}</dd>
            </>
          )}
          {status.mode === "off" && <><dt>Reachable</dt><dd>Only on this machine</dd></>}
        </dl>
      )}
    </section>
  );
}

function Snippet({ path }: { path: string }) {
  const snippet = useLoad(() => get<WebAccessSnippet>(`${path}/snippet`), [path]);
  return (
    <section className="stack sub-card" aria-label="Proxy configuration">
      <h3>For the proxy's Caddyfile</h3>
      <ErrorText error={snippet.error} />
      {snippet.data && <textarea readOnly rows={10} className="code" value={snippet.data.caddyfile} onFocus={(ev) => ev.target.select()} />}
    </section>
  );
}
