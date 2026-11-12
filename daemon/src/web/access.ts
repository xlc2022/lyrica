import { spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { promises as dns } from "node:dns";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { checkServerIdentity, connect as connectTls, type PeerCertificate } from "node:tls";
import type { Db, FrontDoor } from "@lyrica/core";
import type * as Api from "../api.ts";
import type { Listener } from "../http.ts";
import { adminOnly, CaddyAdmin, caddyConfig, type CaddyPaths, type CaddySite, type CaddyTailnet } from "./caddy.ts";
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
  /**
   * Tailnet: her DNS name and address when it was turned on, and whether its
   * certificate answered. `beside`: in Built-in mode, Tailnet stays on beside
   * Caddy, so her ts.net name and the custom name both work.
   */
  tailnet?: { dnsName: string; address?: string; certificates: boolean; beside?: boolean };
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

/**
 * Which plain loopback listeners have a proxy in front of them: the built-in
 * Caddy on lyricad's main port, `tailscale serve` on its serve port, both
 * (Built-in with Tailnet beside it), or neither. Only those listeners believe
 * loopback's forwarded headers, since her userspace tailscaled hands every
 * tailnet peer to loopback too. The mode is in self.db, so this is also kept
 * in a plain file in lyricad's state directory, for the listeners before
 * unlock. A release from before `both` reads it as no file at all, and
 * believes loopback on both listeners until its first unlock writes it again.
 */
export type Front = "builtin" | "tailnet" | "both" | "none";

/** Whether this proxy is in front of its listener. */
export const fronts = (f: Front, proxy: "builtin" | "tailnet"): boolean => f === proxy || f === "both";
export const FRONT_FILE = "web-front";

/** The front as last saved, or undefined when the file isn't there (an install from before it, until its first unlock). */
export function readFront(path: string): Front | undefined {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v === "builtin" || v === "tailnet" || v === "both" || v === "none" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The names the front's proxies are reached by (the built-in Caddy's name,
 * the Tailnet mode's name and address, or both), kept beside the front's own file so
 * the listeners know them before unlock too. Behind its proxy, a plain
 * listener accepts only these names (and loopback's) in Host and
 * X-Forwarded-Host: a page that rebinds its own name to 127.0.0.1 can forge
 * the forwarded headers, but not the Host its browser sends.
 */
export const FRONT_NAMES_FILE = "web-front-names";

/** The front's names as last saved, or undefined when the file isn't there (an install from before it, until its first unlock). */
export function readFrontNames(path: string): string[] | undefined {
  try {
    return readFileSync(path, "utf8").split("\n").map((n) => n.trim().toLowerCase()).filter(Boolean);
  } catch {
    return undefined;
  }
}

export function writeFront(path: string, front: Front, names: string[] = []): void {
  const put = (file: string, text: string) => {
    const tmp = join(dirname(file), `.${basename(file)}.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  };
  // The names first: a crash between the two leaves the old front with names that are at worst too few.
  put(join(dirname(path), FRONT_NAMES_FILE), names.map((n) => `${n}\n`).join(""));
  put(path, `${front}\n`);
}

/** Whether `tailscale serve` is on: the Tailnet mode, or Built-in with Tailnet beside it. */
const tailnetOn = (s: Stored): boolean => !!s.tailnet && (s.mode === "tailnet" || (s.mode === "builtin" && !!s.tailnet.beside));
const frontOf = (s: Stored): Front => (s.mode === "builtin" ? (tailnetOn(s) ? "both" : "builtin") : s.mode === "tailnet" ? "tailnet" : "none");
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

/** How often Tailnet beside Built-in asks her tailscaled for her certificate again (it renews it itself). */
const RENEW_MS = 12 * 60 * 60 * 1000;

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
  /** Where a name points, as this machine's resolver answers. Its own unless a test gives one. */
  resolve?: (name: string) => Promise<string[]>;
  external: ExternalListener;
  /** Where the proxied listener (Front) is kept for the listeners before unlock. */
  frontFile?: string;
  /** How long to wait for a new name's certificate. */
  certWaitMs?: number;
  /** How often Tailnet beside Built-in asks her tailscaled for her certificate again (12 hours outside tests). */
  renewMs?: number;
  /** Extra CA to trust when checking the certificate (tests). */
  trustCa?: string;
  log: (line: string) => void;
}

/** Where a name points, as this machine's resolver answers it. */
const lookup = async (name: string): Promise<string[]> => (await dns.lookup(name, { all: true, verbatim: true })).map((r) => r.address);

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
    this.cachedFront = undefined;
    this.cachedNames = undefined;
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
      tailnet: tailnetOn(s) ? { dnsName: s.tailnet!.dnsName, certificates: s.tailnet!.certificates } : null,
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
    this.rememberFront();
    return this.view();
  }

  /** Which plain listener has its proxy in front now. Asked on every request, so it is read once per change. */
  private cachedFront: Front | undefined;
  front(): Front { return this.cachedFront ??= frontOf(this.load()); }

  /** Writes the front to its file, so the listeners know it before the next unlock. */
  rememberFront(): Front {
    const f = this.front();
    if (this.o.frontFile) writeFront(this.o.frontFile, f, this.frontNames());
    return f;
  }

  /**
   * The names the front's proxies are reached by: what a plain listener
   * behind one accepts in Host and X-Forwarded-Host. With both on, both
   * listeners accept both lists: each name is this machine's own, and the
   * check is there to refuse a name that isn't (DNS rebinding).
   */
  frontNames(): string[] {
    return this.cachedNames ??= ((s) => [
      ...(s.mode === "builtin" ? [s.name.toLowerCase()] : []),
      ...(tailnetOn(s) ? [s.tailnet!.dnsName.toLowerCase(), ...(s.tailnet!.address ? [s.tailnet!.address] : [])] : []),
    ])(this.load());
  }
  private cachedNames: string[] | undefined;

  private async validate(c: Api.WebAccessChange, prev: Stored): Promise<{ next: Stored; external?: External | Direct }> {
    if (!["off", "direct", "tailnet", "builtin", "external"].includes(c.mode)) throw new Error("the mode is off, direct, tailnet, builtin or external");
    if (c.mode === "off") return { next: { ...prev, mode: "off" } };
    if (c.mode === "direct") {
      const addresses = this.addresses().map((a) => a.address);
      if (!addresses.length) throw new Error("this machine has no LAN or Tailscale address to listen on");
      return { next: { ...prev, mode: "direct" }, external: await directFor(addresses, this.o.directPort ?? DIRECT_PORT, this.o.external.direct()) };
    }
    if (c.mode === "tailnet") return { next: { ...prev, mode: "tailnet", tailnet: await this.tailnetFor(prev) } };
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
      // Tailnet beside Caddy: her ts.net name keeps working too, with no change while it was already on.
      const tailnet = (c.tailnet ?? tailnetOn(prev)) ? { ...(tailnetOn(prev) ? prev.tailnet! : await this.tailnetFor(prev)), beside: true } : prev.tailnet && { ...prev.tailnet, beside: false };
      return { next: { ...prev, mode: "builtin", name, builtin: { addresses, provider: p.id, credentials, staging: !!b.staging, ...(email ? { email } : {}) }, ...(tailnet ? { tailnet } : {}) } };
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

  /** Her tailnet name and address for `tailscale serve`, once MagicDNS and HTTPS certificates are on. */
  private async tailnetFor(prev: Stored): Promise<NonNullable<Stored["tailnet"]>> {
    if (!this.o.tailnet || this.o.servePort === undefined) throw new Error("the tailnet isn't available here");
    const t = await this.o.tailnet.serveName();
    if (!t.magicDns) throw new Error("MagicDNS is off in her tailnet; turn it on in the tailnet's DNS settings");
    if (!t.certificates) throw new Error("HTTPS certificates are off in her tailnet; turn them on in the tailnet's DNS settings");
    // The same name keeps what its certificate check found.
    const certificates = tailnetOn(prev) && prev.tailnet!.dnsName === t.dnsName && prev.tailnet!.certificates;
    return { dnsName: t.dnsName, ...(t.address ? { address: t.address } : {}), certificates };
  }

  /** Makes the change live. The new way in is up and checked before the old one goes. */
  private async apply(next: Stored, prev: Stored, external?: External | Direct): Promise<void> {
    await this.applyMode(next, prev, external);
    if (tailnetOn(prev) && !tailnetOn(next)) await this.o.tailnet?.serveReset().catch((err: Error) => this.o.log(`tailscale serve didn't reset: ${err.message}`));
  }

  private async applyMode(next: Stored, prev: Stored, external?: External | Direct): Promise<void> {
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
      // Tailnet beside it: Caddy serves her ts.net name too, with her tailnet certificate, so both
      // names share 443 on her tailnet address. No certificate, no change: the previous setup stays.
      const ts = await this.tailnetSite(next);
      // The old name keeps its route until the new one has a certificate that verifies.
      const keep = prev.mode === "builtin" && prev.name !== next.name ? [this.site(prev)] : [];
      const since = Date.now();
      await this.caddy.load(caddyConfig(this.site(next), this.o.caddy, keep, ts)).catch((err: Error) => {
        // Another service on this machine holds loopback's port: say whose door it is.
        if (/127\.0\.0\.1:\d+.*address already in use/.test(err.message)) {
          throw new Error(`something else on this machine listens on 127.0.0.1:${this.o.httpsPort}, where her tailnet address reaches Caddy; stop it or move it, then try again`);
        }
        throw err;
      });
      const why = await this.certificate(next);
      if (why) {
        await this.caddy.load(before).catch(() => {});
        const tls = lastError(this.o.caddy.tlsLog, since);
        throw new Error(`no certificate for ${next.name} came within ${Math.round((this.o.certWaitMs ?? CERT_WAIT_MS) / 1000)} s (${why}${tls ? `; Caddy: ${tls.message}` : ""}), so the previous setup stays`);
      }
      if (keep.length) await this.caddy.load(caddyConfig(this.site(next), this.o.caddy, [], ts));
      await this.o.external.set(undefined);
      if (ts) {
        // `tailscale serve` (the Tailnet mode, or Tailnet beside from a release before this) held 443 on her
        // address; with it reset, her tailscaled hands 443 to Caddy on 127.0.0.1, which now has both names.
        await this.o.tailnet!.serveReset().catch((err: Error) => this.o.log(`tailscale serve didn't reset: ${err.message}`));
        next.tailnet!.certificates = !(await answers(next.tailnet!.dnsName, 5000));
      }
      return;
    }
    // Off: only lyricad's local listeners stay.
    await this.o.external.set(undefined);
    if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch(() => {});
  }

  /** Her ts.net name for Caddy while Tailnet is on beside it, with her tailnet certificate as her tailscaled has it now. */
  private async tailnetSite(s: Stored): Promise<CaddyTailnet | undefined> {
    if (!tailnetOn(s)) return undefined;
    const name = s.tailnet!.dnsName;
    const pair = await this.o.tailnet!.cert(name);
    this.tailnetPair = { name, ...pair };
    // Whether it came from a change or from unlock, the certificate is asked for again on a timer.
    this.renewal ??= setInterval(() => { this.queue = this.queue.then(() => this.resume()).catch(() => {}); }, this.o.renewMs ?? RENEW_MS).unref();
    return { name, upstream: this.o.servePort!, ...pair };
  }

  /** Stops asking her tailscaled for the certificate (lyricad stopping or locking). */
  close(): void {
    clearInterval(this.renewal);
    this.renewal = undefined;
  }

  /** The tailnet certificate last given to Caddy, for comparing its config without asking tailscaled again. */
  private tailnetPair: { name: string; cert: string; key: string } | undefined;
  private lastTailnetSite(s: Stored): CaddyTailnet | undefined {
    const p = this.tailnetPair;
    return tailnetOn(s) && p?.name === s.tailnet!.dnsName ? { ...p, upstream: this.o.servePort! } : undefined;
  }

  /** Tailscale renews her certificate well before it expires; this picks the new one up. */
  private renewal: NodeJS.Timeout | undefined;

  private site(s: Stored): CaddySite {
    const b = s.builtin!;
    return {
      name: s.name, addresses: b.addresses, port: this.o.httpsPort, provider: b.provider, credentials: b.credentials,
      staging: b.staging, upstream: this.o.upstream, ...(b.email ? { email: b.email } : {}),
    };
  }

  /**
   * Where the name points, and whether Caddy listens on any of those
   * addresses. The status says both: a certificate read at one address says
   * nothing about where the name a browser types lands.
   */
  private async dnsRecord(s: Stored): Promise<NonNullable<Api.WebAccessStatus["dns"]>> {
    let list: string[];
    try {
      list = await (this.o.resolve ?? lookup)(s.name);
    } catch (err) {
      // Nothing answers at all (no record) is worth saying; a resolver that
      // didn't reply is this machine's, not her name's, problem.
      const code = (err as { code?: string }).code;
      if (code === "EAI_AGAIN") return { error: `this machine's resolver didn't answer about ${s.name}` };
      if (code === "ENOTFOUND") return { error: `this machine can't resolve ${s.name}` };
      return { error: (err as Error).message };
    }
    if (!list.length) return { error: `this machine can't resolve ${s.name}` };
    const served = new Set(s.builtin!.addresses);
    if (list.some((a) => served.has(a))) return { addresses: list, served: true };
    // Her own tailnet address: her tailscaled hands 443 there to Caddy on 127.0.0.1.
    const hers = await this.tailnetAddress(s);
    if (hers && list.includes(hers)) return { addresses: list, served: true, tailnet: "forwarded" };
    return { addresses: list, served: false };
  }

  /** Her own tailnet address, if she is on a tailnet. */
  private async tailnetAddress(s: Stored): Promise<string | undefined> {
    if (tailnetOn(s) && s.tailnet!.address) return s.tailnet!.address;
    return (await this.o.tailnet?.serveName().catch(() => undefined))?.address;
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
      let ts: CaddyTailnet | undefined;
      if (tailnetOn(s)) {
        ts = await this.tailnetSite(s).catch((err: Error) => { this.o.log(`her tailnet certificate didn't come (${err.message}); Caddy keeps what it has`); return undefined; });
        if (!ts) return;
      }
      const want = caddyConfig(this.site(s), this.o.caddy, [], ts);
      const have = await this.caddy.config();
      if (have === undefined) this.o.log("Caddy doesn't answer; web access waits for it");
      else if (canonical(have) !== canonical(want)) await this.caddy.load(want);
      // Tailnet beside from a release before this one ran `tailscale serve` on 443; Caddy has her name now.
      if (ts && have !== undefined) await this.o.tailnet!.serveReset().catch((err: Error) => this.o.log(`tailscale serve didn't reset: ${err.message}`));
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
        applied: have !== undefined && canonical(have) === canonical(caddyConfig(this.site(s), this.o.caddy, [], this.lastTailnetSite(s))),
      };
      const readAt = s.builtin!.addresses[0]!;
      const c = await peer(readAt, this.o.httpsPort, s.name);
      out.certificate = c.cert ? { address: readAt, issuer: c.cert.issuer, subject: c.cert.subject, notAfter: c.cert.notAfter } : { address: readAt, error: c.error };
      out.dns = await this.dnsRecord(s);
      const last = lastError(this.o.caddy.tlsLog, s.appliedAt ?? 0);
      if (last) out.lastAcmeError = { ...last, message: this.redact(last.message, s) };
    }
    const e = this.o.external.config();
    if (s.mode === "external" && e) out.external = { listening: this.o.external.listening, address: e.address, port: e.port };
    const dir = this.o.external.direct();
    if (dir) out.direct = { listening: this.o.external.listeningOn(), port: dir.port, fingerprint: certOf(dir.tls.cert).fingerprint };
    if (tailnetOn(s) && s.tailnet) {
      const why = await answers(s.tailnet.dnsName, 5000);
      out.tailnet = { dnsName: s.tailnet.dnsName, answers: !why, ...(why ? { error: why } : {}) };
      // The certificate often issues after the switch (the first one takes a while): once the name answers, the panel says so.
      if (!why && !s.tailnet.certificates) this.save({ ...s, tailnet: { ...s.tailnet, certificates: true } });
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

  /** Her tailnet DNS name and address while `tailscale serve` is on: where a plain request at her tailnet address is sent. */
  tailnetHosts(): { dnsName: string; address?: string } | undefined {
    const s = this.load();
    return tailnetOn(s) && s.tailnet ? { dnsName: s.tailnet.dnsName, ...(s.tailnet.address ? { address: s.tailnet.address } : {}) } : undefined;
  }

  /**
   * Leaving the tailnet: Tailnet beside Built-in goes off, and Caddy keeps
   * only the custom name. True if it was on. The Tailnet mode itself is
   * switched by the caller, to Direct or off.
   */
  dropTailnet(): Promise<boolean> {
    const run = this.queue.then(async () => {
      const s = this.load();
      if (s.mode !== "builtin" || !tailnetOn(s)) return false;
      await this.caddy.load(caddyConfig(this.site(s), this.o.caddy)).catch((err: Error) => this.o.log(`Caddy kept her ts.net name: ${this.redact(err.message, s).split("\n")[0]}`));
      this.save({ ...s, tailnet: { ...s.tailnet!, beside: false } });
      this.rememberFront();
      return true;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Where sandboxes must never reach: the front door's ports and hosts, and the extra listener's port everywhere. */
  frontDoor(): FrontDoor {
    const s = this.load();
    const e = this.o.external.config();
    if (s.mode === "builtin") {
      // With Tailnet beside it, her Tailscale address too, standing for her MagicDNS name (below).
      const t = tailnetOn(s) ? s.tailnet! : undefined;
      return { ports: [...new Set([this.o.httpsPort, ...(t ? [443] : [])])], hosts: [s.name, ...(t ? [t.address ?? t.dnsName] : [])], exclude: [] };
    }
    if (s.mode === "external" && e) return { ports: [e.proxyPort], hosts: [s.name, ...e.proxies], exclude: [e.port] };
    // Direct, also while it stays on beside Tailnet: its port on this machine's addresses.
    const dir = this.o.external.direct();
    const ports = dir ? [443, dir.port] : [443];
    if (s.mode === "tailnet" && s.tailnet) {
      // Her name is a MagicDNS name this machine's resolver needn't know (her tailscaled is
      // userspace, so the host has no MagicDNS). Her tailscaled said what it stands for when
      // the mode was switched on, so that address is the front door; the name would only
      // fail to resolve and take every sandbox offline.
      return { ports, hosts: [s.tailnet.address ?? s.tailnet.dnsName], exclude: [] };
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
