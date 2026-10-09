import { spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { checkServerIdentity, connect as connectTls, type PeerCertificate } from "node:tls";
import type { Db, FrontDoor } from "@lyrica/core";
import type * as Api from "../api.ts";
import { adminOnly, CaddyAdmin, caddyConfig, type CaddyPaths, type CaddySite } from "./caddy.ts";
import { provider, PROVIDERS } from "./providers.ts";

// How Lyrica is reached from other machines: a built-in Caddy that lyricad
// configures, or an external proxy that reaches an extra listener. The mode,
// name and built-in settings (with the DNS credentials) live in self.db under
// `web.access`. The extra listener's settings and TLS key live in a 0600 file
// in lyricad's state directory instead, so the listener opens before unlock.

interface Builtin { addresses: string[]; provider: string; credentials: Record<string, string>; email?: string; staging: boolean }
interface Stored {
  mode: Api.WebMode;
  name: string;
  builtin?: Builtin;
  /** When the setup last changed (ms). Caddy's TLS errors from before don't count. */
  appliedAt?: number;
}

/** The extra listener for an external proxy. */
export interface External {
  address: string;
  port: number;
  /** The only addresses that may connect, and whose X-Forwarded-For is believed. */
  proxies: string[];
  /** The proxy's own HTTPS port, which sandboxes never reach on its addresses. */
  proxyPort: number;
  /** HTTPS with lyricad's own certificate, for an address that isn't on the tailnet. */
  tls?: { key: string; cert: string };
}

const OFF: Stored = { mode: "off", name: "" };
const KEY = "web.access";
/** How long a new name may take to get its certificate before the change is undone. */
export const CERT_WAIT_MS = 90_000;

export type OpenListener = (o: External) => Promise<Server>;

/**
 * The extra listener and its settings file. It exists before unlock: at
 * start lyricad opens it from the file, and while locked it serves only
 * state, unlock and the web UI's files, like every other listener.
 */
export class ExternalListener {
  private cfg: External | undefined;
  private server: Server | undefined;

  constructor(private readonly path: string, private readonly open: OpenListener) {
    try {
      this.cfg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    } catch {
      this.cfg = undefined;
    }
  }

  config(): External | undefined { return this.cfg; }
  proxies(): string[] { return this.cfg?.proxies ?? []; }
  get listening(): boolean { return !!this.server?.listening; }

  /** Opens the saved listener, at start. */
  async start(): Promise<void> {
    if (this.cfg && !this.server) this.server = await this.open(this.cfg);
  }

  /**
   * Makes `next` the listener (undefined: none). The new one opens before the
   * old one closes; if it can't open, the old one stays (or is reopened if it
   * had to close first), and nothing is saved.
   */
  async set(next: External | undefined): Promise<void> {
    const prev = this.cfg;
    const same = (a?: External, b?: External) => !!a && !!b && a.address === b.address && a.port === b.port && a.tls?.cert === b.tls?.cert;
    if (next && same(prev, next) && this.server) {
      this.save(next); // only the proxies changed; they're read per connection
      return;
    }
    const old = this.server;
    const sameSocket = !!(old && next && prev && prev.address === next.address && prev.port === next.port);
    if (sameSocket) await closeServer(old!);
    if (next) {
      try {
        this.server = await this.open(next);
      } catch (err) {
        if (sameSocket) this.server = await this.open(prev!).catch(() => undefined);
        throw new Error(`couldn't listen on ${next.address}:${next.port}: ${(err as Error).message}`);
      }
    } else {
      this.server = undefined;
    }
    if (old && !sameSocket) await closeServer(old);
    this.save(next);
  }

  close(): void {
    if (this.server) void closeServer(this.server);
    this.server = undefined;
  }

  private save(next: External | undefined): void {
    this.cfg = next;
    if (!next) return rmSync(this.path, { force: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

export interface WebAccessOptions {
  self: () => Db;
  caddy: CaddyPaths;
  /** Caddy's HTTPS port. 443 outside tests. */
  httpsPort: number;
  /** lyricad's own port on 127.0.0.1, which Caddy proxies to. */
  upstream: number;
  /** lyricad's other ports, which the extra listener mustn't take. */
  reserved: number[];
  /** This machine's Tailscale and LAN addresses. Read from its interfaces unless a test gives them. */
  addresses?: () => Api.HostAddress[];
  external: ExternalListener;
  /** How long to wait for a new name's certificate. */
  certWaitMs?: number;
  /** Extra CA to trust when checking the certificate (tests). */
  trustCa?: string;
  log: (line: string) => void;
}

/** 100.64.0.0/10, shared by Tailscale, other overlays and carrier-grade NAT. */
export function inTailnetRange(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b! >= 64 && b! < 128;
}

const isLan = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! < 32) || (a === 192 && b === 168);
};

/** This machine's Tailscale and LAN addresses, from its interfaces. Tailscale's are the ones on its interface. */
export function hostAddresses(): Api.HostAddress[] {
  const out: Api.HostAddress[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (name.startsWith("tailscale") && inTailnetRange(i.address)) out.push({ address: i.address, kind: "tailscale", interface: name });
      else if (isLan(i.address)) out.push({ address: i.address, kind: "lan", interface: name });
    }
  }
  return out;
}

const NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** JSON with sorted keys, so two configs compare by content. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
}

export class WebAccess {
  private readonly caddy: CaddyAdmin;
  /** Changes run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: WebAccessOptions) {
    this.caddy = new CaddyAdmin(o.caddy.socket);
  }

  private load(): Stored {
    const row = this.o.self().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : OFF;
  }

  private save(s: Stored): void {
    this.o.self().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(KEY, JSON.stringify(s));
  }

  private addresses(): Api.HostAddress[] { return (this.o.addresses ?? hostAddresses)(); }

  /** The settings as the control panel shows them. Secret credentials are never sent back, only whether they're set. */
  view(): Api.WebAccess {
    const s = this.load();
    const b = s.builtin;
    const e = s.mode === "external" ? this.o.external.config() : undefined;
    return {
      mode: s.mode, name: s.name,
      builtin: b ? {
        addresses: b.addresses, provider: b.provider, staging: b.staging, ...(b.email ? { email: b.email } : {}),
        credentials: Object.fromEntries(provider(b.provider).fields.map((f) => {
          const v = b.credentials[f.name];
          return [f.name, f.secret ? { set: !!v } : { set: !!v, ...(v ? { value: v } : {}) }];
        })),
      } : null,
      external: e ? {
        address: e.address, port: e.port, proxies: e.proxies, proxyPort: e.proxyPort, https: !!e.tls,
        ...(e.tls ? { fingerprint: new X509Certificate(e.tls.cert).fingerprint256, pem: e.tls.cert } : {}),
      } : null,
      addresses: this.addresses(),
      providers: PROVIDERS.map(({ module: _m, ...p }) => p),
    };
  }

  /** Checks a change, applies it, and saves it only if it works. A failure leaves the previous setup running. */
  set(change: Api.WebAccessChange): Promise<Api.WebAccess> {
    const run = this.queue.then(() => this.change(change));
    this.queue = run.catch(() => {});
    return run;
  }

  private async change(change: Api.WebAccessChange): Promise<Api.WebAccess> {
    const prev = this.load();
    const { next, external } = await this.validate(change, prev);
    try {
      await this.apply(next, prev, external);
    } catch (err) {
      throw new Error(this.redact((err as Error).message, next));
    }
    this.save({ ...next, appliedAt: Date.now() });
    return this.view();
  }

  private async validate(c: Api.WebAccessChange, prev: Stored): Promise<{ next: Stored; external?: External }> {
    if (c.mode !== "off" && c.mode !== "builtin" && c.mode !== "external") throw new Error("the mode is off, builtin or external");
    if (c.mode === "off") return { next: { ...prev, mode: "off" } };
    const name = String(c.name ?? prev.name).trim().toLowerCase();
    if (!NAME.test(name)) throw new Error("the hostname is a domain name, like lyrica.example.net");
    const mine = this.addresses();
    const kindOf = (a: string) => mine.find((m) => m.address === a)?.kind;
    if (c.mode === "builtin") {
      const b = c.builtin;
      if (!b) throw new Error("built-in mode needs its settings");
      const addresses = [...new Set((b.addresses ?? []).map(String))];
      if (!addresses.length) throw new Error("choose at least one address to serve on");
      for (const a of addresses) if (!kindOf(a)) throw new Error(`${a} isn't one of this machine's Tailscale or LAN addresses`);
      const p = provider(String(b.provider));
      const old = prev.builtin?.provider === p.id ? prev.builtin.credentials : {};
      const credentials: Record<string, string> = {};
      for (const f of p.fields) {
        const given = b.credentials?.[f.name];
        const value = given === undefined ? old[f.name] : String(given).trim();
        if (value) credentials[f.name] = value;
        else if (!f.optional) throw new Error(`${p.name} needs ${f.label}`);
      }
      const email = b.email?.trim();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("that ACME email doesn't look like an email address");
      return { next: { ...prev, mode: "builtin", name, builtin: { addresses, provider: p.id, credentials, staging: !!b.staging, ...(email ? { email } : {}) } } };
    }
    const e = c.external;
    if (!e) throw new Error("external mode needs its settings");
    const address = String(e.address ?? "");
    const kind = kindOf(address);
    if (!kind) throw new Error(`${address} isn't one of this machine's Tailscale or LAN addresses`);
    const port = Number(e.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("the port is a number from 1024 to 65535");
    if (this.o.reserved.includes(port)) throw new Error(`port ${port} is lyricad's own`);
    const proxyPort = Number(e.proxyPort ?? 443);
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("the proxy's port is a number from 1 to 65535");
    const proxies = [...new Set((e.proxies ?? []).map((p) => String(p).trim()))];
    if (!proxies.length) throw new Error("list the proxy's address");
    for (const p of proxies) if (isIP(p) !== 4) throw new Error(`${p} isn't an IPv4 address`);
    // Plain HTTP only on Tailscale's own interface, which encrypts; elsewhere HTTPS the proxy pins.
    // The certificate names only the address, so it stays (and so does the proxy's pin) until the address changes.
    const prevExt = this.o.external.config();
    let tls: External["tls"];
    if (kind !== "tailscale") tls = prevExt?.tls && prevExt.address === address ? prevExt.tls : await makeCertificate(address);
    return { next: { ...prev, mode: "external", name }, external: { address, port, proxies, proxyPort, ...(tls ? { tls } : {}) } };
  }

  /** Makes the change live. The new way in is up and checked before the old one goes. */
  private async apply(next: Stored, prev: Stored, external?: External): Promise<void> {
    if (next.mode === "external") {
      await this.o.external.set(external);
      if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch((err: Error) => this.o.log(`Caddy kept its old site: ${err.name}`));
      return;
    }
    if (next.mode === "builtin") {
      const before = await this.caddy.config();
      if (before === undefined) throw new Error(`Caddy doesn't answer on ${this.o.caddy.socket}; is lyrica-caddy running?`);
      // The old name keeps its route until the new one has a certificate that verifies.
      const keep = prev.mode === "builtin" && prev.name !== next.name ? [this.site(prev)] : [];
      const since = Date.now();
      await this.caddy.load(caddyConfig(this.site(next), this.o.caddy, keep));
      const why = await this.certificate(next);
      if (why) {
        await this.caddy.load(before).catch(() => {});
        const tls = lastError(this.o.caddy.tlsLog, since);
        throw new Error(`no certificate for ${next.name} came within ${Math.round((this.o.certWaitMs ?? CERT_WAIT_MS) / 1000)} s (${why}${tls ? `; Caddy: ${tls.message}` : ""}), so the previous setup stays`);
      }
      if (keep.length) await this.caddy.load(caddyConfig(this.site(next), this.o.caddy));
      await this.o.external.set(undefined);
      return;
    }
    // Off: only lyricad's local listeners stay.
    await this.o.external.set(undefined);
    if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch(() => {});
  }

  private site(s: Stored): CaddySite {
    const b = s.builtin!;
    return {
      name: s.name, addresses: b.addresses, port: this.o.httpsPort, provider: b.provider, credentials: b.credentials,
      staging: b.staging, upstream: this.o.upstream, ...(b.email ? { email: b.email } : {}),
    };
  }

  /**
   * Waits until Caddy serves a certificate for the name that verifies (any
   * matching one, with staging), on its first address. The reason if none came.
   */
  private async certificate(s: Stored): Promise<string | undefined> {
    const deadline = Date.now() + (this.o.certWaitMs ?? CERT_WAIT_MS);
    let why = "no answer";
    for (;;) {
      const r = await peer(s.builtin!.addresses[0]!, this.o.httpsPort, s.name, s.builtin!.staging ? undefined : { ca: this.o.trustCa });
      if (r.ok) return undefined;
      why = r.error;
      if (Date.now() >= deadline) return why;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(100, deadline - Date.now()))));
    }
  }

  /** After unlock: the saved built-in setup, live again. Caddy is reloaded only if its config differs. */
  async resume(): Promise<void> {
    const s = this.load();
    if (s.mode !== "builtin") return;
    try {
      const want = caddyConfig(this.site(s), this.o.caddy);
      const have = await this.caddy.config();
      if (have === undefined) this.o.log("Caddy doesn't answer; web access waits for it");
      else if (canonical(have) !== canonical(want)) await this.caddy.load(want);
    } catch (err) {
      this.o.log(`web access didn't come back: ${this.redact((err as Error).message, s).split("\n")[0]}`);
    }
  }

  async status(): Promise<Api.WebAccessStatus> {
    const s = this.load();
    const out: Api.WebAccessStatus = { mode: s.mode, name: s.name };
    if (s.mode === "builtin") {
      const have = await this.caddy.config() as { apps?: { http?: unknown } } | undefined;
      out.caddy = {
        answers: have !== undefined,
        // Running with no site: its saved config couldn't load at start and was moved aside.
        configured: !!have?.apps?.http,
        applied: have !== undefined && canonical(have) === canonical(caddyConfig(this.site(s), this.o.caddy)),
      };
      const c = await peer(s.builtin!.addresses[0]!, this.o.httpsPort, s.name);
      out.certificate = c.cert ? { issuer: c.cert.issuer, subject: c.cert.subject, notAfter: c.cert.notAfter } : { error: c.error };
      const last = lastError(this.o.caddy.tlsLog, s.appliedAt ?? 0);
      if (last) out.lastAcmeError = { ...last, message: this.redact(last.message, s) };
    }
    const e = this.o.external.config();
    if (s.mode === "external" && e) out.external = { listening: this.o.external.listening, address: e.address, port: e.port };
    return out;
  }

  /** The external proxy's site, as a Caddyfile. */
  snippet(): string {
    const s = this.load();
    const e = this.o.external.config();
    if (s.mode !== "external" || !e) throw new Error("the snippet is for external mode");
    const upstream = e.tls
      ? `\treverse_proxy https://${e.address}:${e.port} {\n\t\ttransport http {\n\t\t\t# lyricad's certificate, from the control panel\n\t\t\ttls_trust_pool file /etc/caddy/lyricad.pem\n\t\t}\n\t}`
      : `\treverse_proxy ${e.address}:${e.port}`;
    const tls = "\t# The certificate has to come by DNS-01: HTTP-01 can't reach a tailnet or split-DNS hostname.\n"
      + "\t# With your DNS provider's plugin, for example:\n\t# tls {\n\t# \tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n\t# }\n";
    return `${s.name} {\n${tls}${upstream}\n}\n`;
  }

  /** Where sandboxes must never reach: the front door's ports and hosts, and the extra listener's port everywhere. */
  frontDoor(): FrontDoor {
    const s = this.load();
    const e = this.o.external.config();
    if (s.mode === "builtin") return { ports: [this.o.httpsPort], hosts: [s.name], exclude: [] };
    if (s.mode === "external" && e) return { ports: [e.proxyPort], hosts: [s.name, ...e.proxies], exclude: [e.port] };
    return { ports: [443], hosts: [], exclude: [] };
  }

  /** Caddy's messages can quote a token; never pass one on. */
  private redact(text: string, s: Stored): string {
    let out = text;
    for (const v of Object.values(s.builtin?.credentials ?? {})) if (v.length >= 4) out = out.split(v).join("[hidden]");
    return out;
  }
}

function closeServer(s: Server): Promise<void> {
  return new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
}

/**
 * A self-signed certificate for the extra listener, naming only its address:
 * a new P-256 key, made in memory, and openssl signing it from a pipe.
 */
export async function makeCertificate(address: string): Promise<{ key: string; cert: string }> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cert = await new Promise<string>((resolve, reject) => {
    // Node's stdin pipe is a socket, which openssl can't open as /dev/stdin; `cat |` gives it a real pipe. The key never touches disk.
    const child = spawn("sh", ["-c", 'cat | openssl "$@"', "sh", "req", "-new", "-x509", "-key", "/dev/stdin", "-subj", "/CN=lyricad",
      "-days", "3650", "-sha256", "-addext", `subjectAltName=IP:${address}`], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`openssl failed: ${err.trim()}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(key);
  });
  return { key, cert };
}

interface Peer { ok: boolean; error: string; cert?: { issuer: string; subject: string; notAfter: string } }

/**
 * Connects to the name at an address and reads its certificate. With
 * `verify`, `ok` means it verifies against the system CAs (and `ca`);
 * without, that it is for the name.
 */
function peer(address: string, port: number, name: string, verify?: { ca?: string }): Promise<Peer> {
  return new Promise((resolve) => {
    const s = connectTls({
      host: address, port, servername: name, timeout: 5000, rejectUnauthorized: false,
      ...(verify?.ca ? { ca: verify.ca } : {}),
    }, () => {
      const c = s.getPeerCertificate() as PeerCertificate | undefined;
      const verified = s.authorized;
      const authError = s.authorizationError?.toString();
      s.destroy();
      if (!c?.valid_to) return resolve({ ok: false, error: "no certificate yet" });
      const cert = {
        issuer: [c.issuer?.O, c.issuer?.CN].flat().filter(Boolean).join(", "),
        subject: [c.subject?.CN].flat().filter(Boolean).join(", "),
        notAfter: new Date(c.valid_to).toISOString(),
      };
      const mismatch = checkServerIdentity(name, c);
      if (mismatch) return resolve({ ok: false, error: mismatch.message, cert });
      if (verify && !verified) return resolve({ ok: false, error: `it doesn't verify: ${authError}`, cert });
      resolve({ ok: true, error: "", cert });
    });
    s.on("error", (err) => resolve({ ok: false, error: err.message }));
    s.on("timeout", () => { s.destroy(); resolve({ ok: false, error: "no answer" }); });
  });
}

/** The newest error in Caddy's TLS log at or after `since` (ms). */
function lastError(path: string, since: number): { at: string; message: string } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      try {
        const e = JSON.parse(line) as { level?: string; ts?: number; msg?: string; error?: string };
        if ((e.ts ?? 0) * 1000 < since) return undefined;
        if (e.level === "error") return { at: new Date((e.ts ?? 0) * 1000).toISOString(), message: [e.msg, e.error].filter(Boolean).join(": ") };
      } catch { /* a partial line */ }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
