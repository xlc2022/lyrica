import { spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { connect as connectTcp, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { connect as connectTls } from "node:tls";
import type { Db, FrontDoor } from "@lyrica/core";
import type * as Api from "../api.ts";
import { adminOnly, CaddyAdmin, caddyConfig, type CaddyPaths, type CaddySite } from "./caddy.ts";
import { provider, PROVIDERS } from "./providers.ts";

// How Lyrica is reached from other machines: a built-in Caddy that lyricad
// configures, or an external proxy that reaches an extra listener. Settings
// live in self.db (encrypted with the rest of it), under `web.access`.

interface Stored {
  mode: Api.WebMode;
  name: string;
  builtin?: { addresses: string[]; provider: string; credentials: Record<string, string>; email?: string; staging: boolean };
  external?: { address: string; port: number; proxies: string[]; tls?: { key: string; cert: string } };
}

const OFF: Stored = { mode: "off", name: "" };
const KEY = "web.access";

/** The extra listener for external mode. lyricad opens it; WebAccess decides when. */
export type OpenListener = (o: { address: string; port: number; tls?: { key: string; cert: string } }) => Promise<Server>;

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
  open: OpenListener;
  log: (line: string) => void;
}

/** 100.64.0.0/10: Tailscale's addresses. Traffic there is already encrypted by WireGuard. */
export function isTailnet(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b! >= 64 && b! < 128;
}

const isLan = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! < 32) || (a === 192 && b === 168);
};

/** This machine's Tailscale and LAN addresses, from its interfaces. */
export function hostAddresses(): Api.HostAddress[] {
  const out: Api.HostAddress[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (isTailnet(i.address) || name.startsWith("tailscale")) out.push({ address: i.address, kind: "tailscale", interface: name });
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
  private server: Server | undefined;
  private serverAt: string | undefined;
  private readonly caddy: CaddyAdmin;

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
    const e = s.external;
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
        address: e.address, port: e.port, proxies: e.proxies, https: !!e.tls,
        ...(e.tls ? { fingerprint: new X509Certificate(e.tls.cert).fingerprint256, pem: e.tls.cert } : {}),
      } : null,
      addresses: this.addresses(),
      providers: PROVIDERS.map(({ module: _m, ...p }) => p),
    };
  }

  /** Checks a change, applies it, and saves it only if it works. A failure leaves the previous setup running. */
  async set(change: Api.WebAccessChange): Promise<Api.WebAccess> {
    const prev = this.load();
    const { next, makeCert } = this.validate(change, prev);
    try {
      if (makeCert) next.external!.tls = await makeCertificate(next.external!.address, next.name);
      await this.apply(next, prev);
    } catch (err) {
      throw new Error(this.redact((err as Error).message, next));
    }
    this.save(next);
    return this.view();
  }

  /** The new settings, and whether the extra listener needs a new certificate. */
  private validate(c: Api.WebAccessChange, prev: Stored): { next: Stored; makeCert: boolean } {
    if (c.mode !== "off" && c.mode !== "builtin" && c.mode !== "external") throw new Error("the mode is off, builtin or external");
    if (c.mode === "off") return { next: { ...prev, mode: "off" }, makeCert: false };
    const name = String(c.name ?? prev.name).trim().toLowerCase();
    if (!NAME.test(name)) throw new Error("the name is a domain name, like lyrica.example.net");
    const mine = this.addresses();
    const known = (a: string) => mine.some((m) => m.address === a);
    if (c.mode === "builtin") {
      const b = c.builtin;
      if (!b) throw new Error("built-in mode needs its settings");
      const addresses = [...new Set((b.addresses ?? []).map(String))];
      if (!addresses.length) throw new Error("choose at least one address to serve on");
      for (const a of addresses) if (!known(a)) throw new Error(`${a} isn't one of this machine's Tailscale or LAN addresses`);
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
      return { next: { ...prev, mode: "builtin", name, builtin: { addresses, provider: p.id, credentials, staging: !!b.staging, ...(email ? { email } : {}) } }, makeCert: false };
    }
    const e = c.external;
    if (!e) throw new Error("external mode needs its settings");
    const address = String(e.address ?? "");
    if (!known(address)) throw new Error(`${address} isn't one of this machine's Tailscale or LAN addresses`);
    const port = Number(e.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("the port is a number from 1024 to 65535");
    if (this.o.reserved.includes(port)) throw new Error(`port ${port} is lyricad's own`);
    const proxies = [...new Set((e.proxies ?? []).map((p) => String(p).trim()))];
    if (!proxies.length) throw new Error("list the proxy's address");
    for (const p of proxies) if (isIP(p) !== 4) throw new Error(`${p} isn't an IPv4 address`);
    // Plain HTTP only inside the tailnet; on a LAN address, HTTPS with a certificate the proxy pins.
    const keep = prev.external?.tls && prev.external.address === address && prev.name === name ? prev.external.tls : undefined;
    const https = !isTailnet(address);
    return { next: { ...prev, mode: "external", name, external: { address, port, proxies, ...(https && keep ? { tls: keep } : {}) } }, makeCert: https && !keep };
  }

  /** Makes the change live. The new way in is up and checked before the old one goes. */
  private async apply(next: Stored, prev: Stored): Promise<void> {
    if (next.mode === "external") {
      await this.listen(next.external!);
      if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch((err: Error) => this.o.log(`Caddy kept its old site: ${err.name}`));
      return;
    }
    if (next.mode === "builtin") {
      const before = await this.caddy.config();
      if (before === undefined) throw new Error(`Caddy doesn't answer on ${this.o.caddy.socket}; is lyrica-caddy running?`);
      await this.caddy.load(this.config(next));
      const down = await this.serving(next.builtin!.addresses);
      if (down) {
        await this.caddy.load(before).catch(() => {});
        throw new Error(`Caddy didn't start serving on ${down}, so the previous setup stays`);
      }
      this.close();
      return;
    }
    // Off: only lyricad's local listeners stay.
    this.close();
    if (prev.mode === "builtin") await this.caddy.load(adminOnly(this.o.caddy)).catch(() => {});
  }

  private config(s: Stored): Record<string, unknown> {
    const b = s.builtin!;
    const site: CaddySite = {
      name: s.name, addresses: b.addresses, port: this.o.httpsPort, provider: b.provider, credentials: b.credentials,
      staging: b.staging, upstream: this.o.upstream, ...(b.email ? { email: b.email } : {}),
    };
    return caddyConfig(site, this.o.caddy);
  }

  /** The first address Caddy isn't listening on, if any. */
  private async serving(addresses: string[]): Promise<string | undefined> {
    for (const a of addresses) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = connectTcp({ host: a, port: this.o.httpsPort, timeout: 3000 }, () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
        s.on("timeout", () => { s.destroy(); resolve(false); });
      });
      if (!ok) return `${a}:${this.o.httpsPort}`;
    }
    return undefined;
  }

  private async listen(e: NonNullable<Stored["external"]>): Promise<void> {
    const at = `${e.address}:${e.port}:${e.tls ? new X509Certificate(e.tls.cert).fingerprint256 : "http"}`;
    if (this.server && this.serverAt === at) return; // only the proxies changed; they're read per connection
    const old = this.server;
    const same = old && this.serverAt?.startsWith(`${e.address}:${e.port}:`);
    if (same) await closeServer(old);
    try {
      this.server = await this.o.open({ address: e.address, port: e.port, tls: e.tls });
      this.serverAt = at;
    } catch (err) {
      if (same) this.server = undefined;
      throw new Error(`couldn't listen on ${e.address}:${e.port}: ${(err as Error).message}`);
    }
    if (old && !same) await closeServer(old);
  }

  /** The proxies allowed on the extra listener, read for every connection. */
  proxies(): string[] {
    const s = this.load();
    return s.mode === "external" ? s.external!.proxies : [];
  }

  /** After unlock: the saved setup, live again. Caddy is reloaded only if its config differs. */
  async resume(): Promise<void> {
    const s = this.load();
    try {
      if (s.mode === "builtin") {
        const want = this.config(s);
        const have = await this.caddy.config();
        if (have === undefined) this.o.log("Caddy doesn't answer; web access waits for it");
        else if (canonical(have) !== canonical(want)) await this.caddy.load(want);
      } else if (s.mode === "external") {
        await this.listen(s.external!);
      }
    } catch (err) {
      this.o.log(`web access didn't come back: ${this.redact((err as Error).message, s).split("\n")[0]}`);
    }
  }

  async status(): Promise<Api.WebAccessStatus> {
    const s = this.load();
    const out: Api.WebAccessStatus = { mode: s.mode, name: s.name };
    if (s.mode === "builtin") {
      const have = await this.caddy.config();
      out.caddy = { answers: have !== undefined, applied: have !== undefined && canonical(have) === canonical(this.config(s)) };
      out.certificate = await peerCertificate(s.builtin!.addresses[0]!, this.o.httpsPort, s.name);
      const last = lastError(this.o.caddy.tlsLog);
      if (last) out.lastAcmeError = { ...last, message: this.redact(last.message, s) };
    }
    if (s.mode === "external") out.external = { listening: !!this.server?.listening, address: s.external!.address, port: s.external!.port };
    return out;
  }

  /** The external proxy's site, as a Caddyfile. */
  snippet(): string {
    const s = this.load();
    if (s.mode !== "external") throw new Error("the snippet is for external mode");
    const e = s.external!;
    const upstream = e.tls
      ? `\treverse_proxy https://${e.address}:${e.port} {\n\t\ttransport http {\n\t\t\t# lyricad's certificate, from the control panel\n\t\t\ttls_trust_pool file /etc/caddy/lyricad.pem\n\t\t}\n\t}`
      : `\treverse_proxy ${e.address}:${e.port}`;
    return `${s.name} {\n${upstream}\n}\n`;
  }

  /** Where sandboxes must never reach: the front door's ports and hosts, and the extra listener's port everywhere. */
  frontDoor(): FrontDoor {
    const s = this.load();
    if (s.mode === "builtin") return { ports: [this.o.httpsPort], hosts: [s.name], exclude: [] };
    if (s.mode === "external") return { ports: [443], hosts: [s.name, ...s.external!.proxies], exclude: [s.external!.port] };
    return { ports: [443], hosts: [], exclude: [] };
  }

  close(): void {
    if (this.server) void closeServer(this.server);
    this.server = undefined;
    this.serverAt = undefined;
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

/** A self-signed certificate for the extra listener: a new P-256 key, made in memory, and openssl signing it from stdin. */
export async function makeCertificate(address: string, name: string): Promise<{ key: string; cert: string }> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cert = await new Promise<string>((resolve, reject) => {
    // Node's stdin pipe is a socket, which openssl can't open as /dev/stdin; `cat |` gives it a real pipe. The key never touches disk.
    const child = spawn("sh", ["-c", 'cat | openssl "$@"', "sh", "req", "-new", "-x509", "-key", "/dev/stdin", "-subj", "/CN=lyricad",
      "-days", "3650", "-sha256", "-addext", `subjectAltName=IP:${address},DNS:${name}`], { stdio: ["pipe", "pipe", "pipe"] });
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

/** The certificate served for `name` at an address, read by connecting there. */
function peerCertificate(address: string, port: number, name: string): Promise<Api.WebAccessStatus["certificate"]> {
  return new Promise((resolve) => {
    const s = connectTls({ host: address, port, servername: name, rejectUnauthorized: false, timeout: 5000 }, () => {
      const c = s.getPeerCertificate();
      s.destroy();
      if (!c || !c.valid_to) return resolve({ error: "no certificate yet" });
      const issuer = [c.issuer?.O, c.issuer?.CN].flat().filter(Boolean).join(", ");
      resolve({ issuer, subject: [c.subject?.CN].flat().filter(Boolean).join(", "), notAfter: new Date(c.valid_to).toISOString() });
    });
    s.on("error", (err) => resolve({ error: err.message }));
    s.on("timeout", () => { s.destroy(); resolve({ error: "no answer" }); });
  });
}

/** The newest error in Caddy's TLS log. */
function lastError(path: string): { at: string; message: string } | undefined {
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
        if (e.level === "error") return { at: new Date((e.ts ?? 0) * 1000).toISOString(), message: [e.msg, e.error].filter(Boolean).join(": ") };
      } catch { /* a partial line */ }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
