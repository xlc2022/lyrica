import { spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { checkServerIdentity, connect as connectTls, type PeerCertificate } from "node:tls";
import type { Db, FrontDoor } from "@lyrica/core";
import type * as Api from "../api.ts";
import type { Listener } from "../http.ts";
import { adminOnly, CaddyAdmin, caddyConfig, type CaddyPaths, type CaddySite } from "./caddy.ts";
import { provider, PROVIDERS } from "./providers.ts";
import type { TailnetControl } from "../tailnet.ts";

// How Lyrica is reached from other machines: lyricad's own HTTPS on the
// machine's addresses (Direct, the mode she starts in), her tailscaled's
// `tailscale serve` (Tailnet), a built-in Caddy that lyricad configures, or an
// external proxy that reaches an extra listener. The mode, name and built-in
// settings (with the DNS credentials) live in self.db under `web.access`. The
// extra listener's settings and TLS key (Direct's or the external proxy's)
// live in a 0600 file in lyricad's state directory instead, so the listener
// opens before unlock, and before setup.

interface Builtin { addresses: string[]; provider: string; credentials: Record<string, string>; email?: string; staging: boolean }
interface Stored {
  mode: Api.WebMode;
  name: string;
  builtin?: Builtin;
  /** Tailnet: her DNS name and address when it was turned on, and whether its certificate answered. */
  tailnet?: { dnsName: string; address?: string; certificates: boolean };
  /** When the setup last changed (ms). Caddy's TLS errors from before don't count. */
  appliedAt?: number;
}

/** The extra listener for an external proxy. */
export interface External {
  direct?: undefined;
  address: string;
  port: number;
  /** The only addresses that may connect, and whose X-Forwarded-For is believed. */
  proxies: string[];
  /** The proxy's own HTTPS port, which sandboxes never reach on its addresses. */
  proxyPort: number;
  /** HTTPS with lyricad's own certificate, for an address that isn't on the tailnet. */
  tls?: { key: string; cert: string };
}

/** Direct: lyricad's own HTTPS on each of these addresses, with one certificate naming them all. */
export interface Direct {
  direct: true;
  addresses: string[];
  port: number;
  tls: { key: string; cert: string };
}

/** One socket the extra listener opens. */
export interface Bind { address: string; port: number; tls?: { key: string; cert: string }; direct: boolean }

const binds = (c: External | Direct): Bind[] => (c.direct
  ? c.addresses.map((address) => ({ address, port: c.port, tls: c.tls, direct: true }))
  : [{ address: c.address, port: c.port, ...(c.tls ? { tls: c.tls } : {}), direct: false }]);

/** Direct's port, the same as lyricad's loopback one. */
export const DIRECT_PORT = 7340;

const OFF: Stored = { mode: "off", name: "" };
const KEY = "web.access";
/** How long a new name may take to get its certificate before the change is undone. */
export const CERT_WAIT_MS = 90_000;

export type OpenListener = (b: Bind) => Promise<Listener>;

/**
 * The extra listener and its settings file: the external proxy's one socket,
 * or Direct's one per address. It exists before unlock: at start lyricad opens
 * it from the file, and while locked it serves only state, unlock (or setup)
 * and the web UI's files, like every other listener.
 */
export class ExternalListener {
  private cfg: External | Direct | undefined;
  private servers: Listener[] = [];
  private open: OpenListener;

  constructor(private readonly path: string, open: OpenListener) {
    this.open = open;
    try {
      this.cfg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    } catch {
      this.cfg = undefined;
    }
  }

  /** The external proxy's listener, if that's what this is. */
  config(): External | undefined { return this.cfg && !this.cfg.direct ? this.cfg : undefined; }
  /** Direct's listener, if that's what this is. */
  direct(): Direct | undefined { return this.cfg?.direct ? this.cfg : undefined; }
  proxies(): string[] { return this.config()?.proxies ?? []; }
  get listening(): boolean { return this.servers.some((s) => s.listening); }
  /** The addresses with an open socket. */
  listeningOn(): string[] { return this.servers.filter((s) => s.listening).map((s) => plainOf(s)); }

  /**
   * Opens the saved listener, at start. Direct opens every address it can and
   * names the ones it couldn't; the external proxy's one socket must open.
   */
  async start(): Promise<void> {
    if (!this.cfg || this.servers.length) return;
    const failed: string[] = [];
    for (const b of binds(this.cfg)) {
      try {
        this.servers.push(await this.open(b));
      } catch (err) {
        failed.push(`${b.address}:${b.port} (${(err as Error).message})`);
      }
    }
    if (failed.length) throw new Error(`couldn't listen on ${failed.join(", ")}`);
  }

  /**
   * Makes `next` the listener (undefined: none). The new sockets open before
   * the old ones close, unless they share an address and port; if they can't
   * open, the old ones stay (or are reopened if they had to close first), and
   * nothing is saved. Old sockets close gracefully, so the request that asked
   * for the change still gets its answer.
   */
  async set(next: External | Direct | undefined): Promise<void> {
    const prev = this.cfg;
    const key = (b: Bind) => `${b.address}:${b.port}:${b.tls?.cert ?? ""}`;
    const same = !!prev && !!next && binds(prev).map(key).join() === binds(next).map(key).join();
    if (same && this.servers.length) {
      this.save(next); // only the proxies changed; they're read per connection
      return;
    }
    const old = this.servers;
    const overlap = !!(prev && next && binds(next).some((b) => binds(prev).some((p) => p.address === b.address && p.port === b.port)));
    if (overlap) await Promise.all(old.map((s) => closeServer(s)));
    const opened: Listener[] = [];
    if (next) {
      for (const b of binds(next)) {
        try {
          opened.push(await this.open(b));
        } catch (err) {
          await Promise.all(opened.map((s) => closeServer(s)));
          if (overlap) {
            this.servers = [];
            await this.start().catch(() => {});
          }
          throw new Error(`couldn't listen on ${b.address}:${b.port}: ${(err as Error).message}`);
        }
      }
    }
    this.servers = opened;
    if (!overlap) for (const s of old) void closeServer(s, GRACE_MS);
    this.save(next);
  }

  /** Takes these settings without opening anything (start() opens them). */
  adopt(next: External | Direct): void {
    this.save(next);
  }

  close(): void {
    for (const s of this.servers) void closeServer(s);
    this.servers = [];
  }

  private save(next: External | Direct | undefined): void {
    this.cfg = next;
    if (!next) return rmSync(this.path, { force: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

/** How long a replaced listener's open requests may take to finish. */
const GRACE_MS = 5000;

const plainOf = (s: Listener): string => {
  const a = s.address();
  return a && typeof a === "object" ? a.address.replace(/^::ffff:/, "") : "";
};

/**
 * Direct's settings for these addresses: the certificate is kept while it
 * names exactly them, so its fingerprint stays what the operator compared.
 */
export async function directFor(addresses: string[], port: number, prev?: Direct): Promise<Direct> {
  const list = [...new Set(addresses)].sort();
  const keep = prev && [...prev.addresses].sort().join() === list.join() ? prev.tls : undefined;
  return { direct: true, addresses: list, port, tls: keep ?? (list.length ? await makeCertificate(list) : { key: "", cert: "" }) };
}

export interface WebAccessOptions {
  self: () => Db;
  /** Her tailscaled, for the Tailnet mode. */
  tailnet?: TailnetControl;
  /** lyricad's loopback listener that only `tailscale serve` targets. */
  servePort?: number;
  /** Direct's port (7340 outside tests). */
  directPort?: number;
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
    if (row) return JSON.parse(row.value);
    // Set up through Direct, before self.db existed: its listener file is the setting.
    return this.o.external.direct() ? { mode: "direct", name: "" } : OFF;
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
    const dir = this.o.external.direct();
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
      direct: dir ? { addresses: dir.addresses, port: dir.port, ...certOf(dir.tls.cert) } : null,
      tailnet: s.mode === "tailnet" && s.tailnet ? { dnsName: s.tailnet.dnsName, certificates: s.tailnet.certificates } : null,
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

  private async validate(c: Api.WebAccessChange, prev: Stored): Promise<{ next: Stored; external?: External | Direct }> {
    if (!["off", "direct", "tailnet", "builtin", "external"].includes(c.mode)) throw new Error("the mode is off, direct, tailnet, builtin or external");
    if (c.mode === "off") return { next: { ...prev, mode: "off" } };
    if (c.mode === "direct") {
      const addresses = this.addresses().map((a) => a.address);
      if (!addresses.length) throw new Error("this machine has no LAN or Tailscale address to listen on");
      return { next: { ...prev, mode: "direct" }, external: await directFor(addresses, this.o.directPort ?? DIRECT_PORT, this.o.external.direct()) };
    }
    if (c.mode === "tailnet") {
      if (!this.o.tailnet || this.o.servePort === undefined) throw new Error("the tailnet isn't available here");
      const t = await this.o.tailnet.serveName();
      if (!t.magicDns) throw new Error("MagicDNS is off in her tailnet; turn it on in the tailnet's DNS settings");
      if (!t.certificates) throw new Error("HTTPS certificates are off in her tailnet; turn them on in the tailnet's DNS settings");
      return { next: { ...prev, mode: "tailnet", tailnet: { dnsName: t.dnsName, ...(t.address ? { address: t.address } : {}), certificates: false } } };
    }
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
  private async apply(next: Stored, prev: Stored, external?: External | Direct): Promise<void> {
    if (prev.mode === "tailnet" && next.mode !== "tailnet") await this.o.tailnet?.serveReset().catch((err: Error) => this.o.log(`tailscale serve didn't reset: ${err.message}`));
    if (next.mode === "direct") {
      await this.o.external.set(external);
      if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch((err: Error) => this.o.log(`Caddy kept its old site: ${err.name}`));
      return;
    }
    if (next.mode === "tailnet") {
      const t = next.tailnet!;
      await this.o.tailnet!.serve(this.o.servePort!);
      const why = await answers(t.dnsName, this.o.certWaitMs ?? CERT_WAIT_MS);
      t.certificates = !why;
      if (why) {
        // This machine may not be on her tailnet, so it can't always check: Direct, if on, stays on
        // beside it, so nobody is locked out, until a later switch to Tailnet is confirmed.
        this.o.log(`couldn't check https://${t.dnsName} from this machine (${why}); Direct stays on if it was`);
        if (!this.o.external.direct()) await this.o.external.set(undefined);
      } else {
        await this.o.external.set(undefined);
      }
      if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch((err: Error) => this.o.log(`Caddy kept its old site: ${err.name}`));
      return;
    }
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
    const dir = this.o.external.direct();
    if (dir) out.direct = { listening: this.o.external.listeningOn(), port: dir.port, fingerprint: certOf(dir.tls.cert).fingerprint };
    if (s.mode === "tailnet" && s.tailnet) {
      const why = await answers(s.tailnet.dnsName, 5000);
      out.tailnet = { dnsName: s.tailnet.dnsName, answers: !why, ...(why ? { error: why } : {}) };
    }
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

  /** The Tailnet mode's DNS name and address while it is on: where a plain request at her tailnet address is sent. */
  tailnetHosts(): { dnsName: string; address?: string } | undefined {
    const s = this.load();
    return s.mode === "tailnet" && s.tailnet ? { dnsName: s.tailnet.dnsName, ...(s.tailnet.address ? { address: s.tailnet.address } : {}) } : undefined;
  }

  /** Where sandboxes must never reach: the front door's ports and hosts, and the extra listener's port everywhere. */
  frontDoor(): FrontDoor {
    const s = this.load();
    const e = this.o.external.config();
    if (s.mode === "builtin") return { ports: [this.o.httpsPort], hosts: [s.name], exclude: [] };
    if (s.mode === "external" && e) return { ports: [e.proxyPort], hosts: [s.name, ...e.proxies], exclude: [e.port] };
    // Direct, also while it stays on beside Tailnet: its port on this machine's addresses.
    const dir = this.o.external.direct();
    const ports = dir ? [443, dir.port] : [443];
    if (s.mode === "tailnet" && s.tailnet) {
      return { ports, hosts: [s.tailnet.dnsName, ...(s.tailnet.address ? [s.tailnet.address] : [])], exclude: [] };
    }
    return { ports, hosts: [], exclude: [] };
  }

  /** Caddy's messages can quote a token; never pass one on. */
  private redact(text: string, s: Stored): string {
    let out = text;
    for (const v of Object.values(s.builtin?.credentials ?? {})) if (v.length >= 4) out = out.split(v).join("[hidden]");
    return out;
  }
}

/** Stops listening. Open requests get `graceMs` to finish (none by default). */
function closeServer(s: Listener, graceMs = 0): Promise<void> {
  return new Promise((resolve) => {
    s.close(() => resolve());
    if (!graceMs) return s.closeAllConnections();
    s.closeIdleConnections();
    setTimeout(() => s.closeAllConnections(), graceMs).unref();
  });
}

/** The certificate's fingerprint and PEM, for comparing in the browser's warning. */
function certOf(pem: string): { fingerprint: string; pem: string } {
  return { fingerprint: pem ? new X509Certificate(pem).fingerprint256 : "", pem };
}

/**
 * Whether https://<name>/api/state answers 200 with a certificate that
 * verifies, trying until `waitMs` (the first certificate can take a while).
 * The reason if not.
 */
async function answers(name: string, waitMs: number): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;
  let why = "no answer";
  for (;;) {
    try {
      const res = await fetch(`https://${name}/api/state`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return undefined;
      why = `it answered ${res.status}`;
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      why = cause?.code ?? cause?.message ?? (err as Error).message;
      // The name doesn't resolve here: this machine isn't on her tailnet, and waiting won't change it.
      if (why === "ENOTFOUND" || why === "EAI_AGAIN") return `this machine can't resolve ${name}`;
    }
    if (Date.now() >= deadline) return why;
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(100, deadline - Date.now()))));
  }
}

/**
 * A self-signed certificate for the extra listener, naming only its addresses:
 * a new P-256 key, made in memory, and openssl signing it from a pipe.
 */
export async function makeCertificate(addresses: string | string[]): Promise<{ key: string; cert: string }> {
  const san = [addresses].flat().map((a) => `IP:${a}`).join(",");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cert = await new Promise<string>((resolve, reject) => {
    // Node's stdin pipe is a socket, which openssl can't open as /dev/stdin; `cat |` gives it a real pipe. The key never touches disk.
    const child = spawn("sh", ["-c", 'cat | openssl "$@"', "sh", "req", "-new", "-x509", "-key", "/dev/stdin", "-subj", "/CN=lyricad",
      "-days", "3650", "-sha256", "-addext", `subjectAltName=${san}`], { stdio: ["pipe", "pipe", "pipe"] });
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
