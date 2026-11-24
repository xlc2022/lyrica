// Her browsing through Mullvad (docs/workspace.md, "Mullvad"). An administrator
// pastes a WireGuard configuration from Mullvad's site; lyricad runs wireproxy
// (a userspace WireGuard client: no root, no interface, no change to this
// machine's routes) with it, listening for SOCKS5 on loopback with a random
// login only lyricad knows. A run with the thread's Mullvad switch on reaches
// the internet only through its relay, and the relay connects through here, so
// nothing it sends leaves from this machine's own address. Names are looked up
// inside the tunnel (wireproxy's DNS, which is always set). One tunnel serves
// every run, since a WireGuard key used by two tunnels at once loses packets to
// whichever spoke last. `egress` is a second SOCKS5 listener, on a fixed port,
// for SearXNG: through Mullvad while Administration's switch is on, direct
// otherwise, so the switch needs no restart of SearXNG.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { connect, createServer, isIP, type AddressInfo, type Server, type Socket } from "node:net";
import * as tls from "node:tls";
import type { Db } from "../db.ts";

/** Mullvad's resolver inside the tunnel, used when a configuration names none, so no lookup leaves outside it. */
export const MULLVAD_DNS = "10.64.0.1";
/** SearXNG's SOCKS5 proxy (`egress`), on loopback. The NixOS module and searxng-settings.yml name it. */
export const EGRESS_PORT = 1058;
/** Where the tunnel's state is read: Mullvad's own check, which says whether the address it sees is one of Mullvad's. */
const CHECK = { host: "am.i.mullvad.net", path: "/json" };
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;

/** The parts of a WireGuard configuration wireproxy needs. */
export interface WireGuardConf {
  privateKey: string;
  addresses: string[];
  dns: string[];
  mtu?: number;
  peer: { publicKey: string; endpoint: string; presharedKey?: string; allowedIPs: string[] };
}

/**
 * Reads a wg-quick configuration (Mullvad's download, or one made by its mullvad-wg.sh). Throws with a sentence for
 * the person when it isn't one. Lines wireproxy has no use for (PostUp, Table, a kill switch's iptables) are left out.
 */
export function parseWireGuard(text: string): WireGuardConf {
  let section = "";
  const iface: Record<string, string> = {}, peers: Record<string, string>[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) {
      section = head[1]!.toLowerCase();
      if (section === "peer") peers.push({});
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error("This isn't a WireGuard configuration: every line is a [section] or a Key = value.");
    const key = line.slice(0, eq).trim().toLowerCase(), value = line.slice(eq + 1).trim();
    if (section === "interface") iface[key] = value;
    else if (section === "peer") peers.at(-1)![key] = value;
  }
  if (!iface.privatekey) throw new Error("The configuration has no [Interface] with a PrivateKey.");
  if (peers.length !== 1) throw new Error("The configuration needs exactly one [Peer]: one Mullvad server.");
  const peer = peers[0]!;
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!KEY.test(iface.privatekey)) throw new Error("The PrivateKey isn't a WireGuard key.");
  if (!peer.publickey || !KEY.test(peer.publickey)) throw new Error("The [Peer]'s PublicKey isn't a WireGuard key.");
  if (peer.presharedkey && !KEY.test(peer.presharedkey)) throw new Error("The [Peer]'s PresharedKey isn't a WireGuard key.");
  const addresses = list(iface.address);
  if (!addresses.length || addresses.some((a) => !isIP(a.split("/")[0]!))) throw new Error("The [Interface]'s Address should be the tunnel's addresses, such as 10.64.1.2/32.");
  const endpoint = peer.endpoint ?? "";
  if (!/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(endpoint)) throw new Error("The [Peer]'s Endpoint should be the server's address and port, such as 185.213.154.68:51820.");
  const dns = list(iface.dns).filter((d) => isIP(d));
  const mtu = iface.mtu ? Number(iface.mtu) : undefined;
  if (mtu !== undefined && !(Number.isInteger(mtu) && mtu >= 576 && mtu <= 9000)) throw new Error("The [Interface]'s MTU should be a number from 576 to 9000.");
  return {
    privateKey: iface.privatekey, addresses, dns: dns.length ? dns : [MULLVAD_DNS], ...mtu ? { mtu } : {},
    peer: { publicKey: peer.publickey, endpoint, ...peer.presharedkey ? { presharedKey: peer.presharedkey } : {}, allowedIPs: list(peer.allowedips).length ? list(peer.allowedips) : ["0.0.0.0/0", "::/0"] },
  };
}

/** wireproxy's configuration: the tunnel, its DNS always set (no lookup outside it), and one SOCKS5 listener with a login. */
export function wireproxyConfig(c: WireGuardConf, socks: { port: number; user: string; password: string }): string {
  return [
    "[Interface]",
    `PrivateKey = ${c.privateKey}`,
    `Address = ${c.addresses.join(", ")}`,
    `DNS = ${c.dns.join(", ")}`,
    ...c.mtu ? [`MTU = ${c.mtu}`] : [],
    // Mullvad's resolver answers inside the tunnel; wireproxy pings it to say whether the tunnel is up (`/readyz`).
    `CheckAlive = ${c.dns[0]}`,
    "",
    "[Peer]",
    `PublicKey = ${c.peer.publicKey}`,
    ...c.peer.presharedKey ? [`PresharedKey = ${c.peer.presharedKey}`] : [],
    `Endpoint = ${c.peer.endpoint}`,
    `AllowedIPs = ${c.peer.allowedIPs.join(", ")}`,
    "PersistentKeepalive = 25",
    "",
    // IPv4 first, as the sandbox is IPv4 only.
    "[Resolve]",
    "ResolveStrategy = ipv4",
    "",
    "[Socks5]",
    `BindAddress = 127.0.0.1:${socks.port}`,
    `Username = ${socks.user}`,
    `Password = ${socks.password}`,
    "",
  ].join("\n");
}

const REPLIES: Record<number, string> = {
  1: "the connection failed", 2: "it isn't allowed", 3: "the network can't be reached", 4: "the host can't be reached",
  5: "the connection was refused", 6: "it took too long", 7: "the proxy can't do that", 8: "the address type isn't supported",
};

/** Reads exactly `n` bytes from a socket that is paused between reads. */
function read(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const done = (err?: Error) => { socket.off("data", data).off("error", done).off("close", closed); if (err) reject(err); };
    const closed = () => done(new Error("the proxy closed the connection"));
    const data = (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length < n) return;
      socket.pause();
      done();
      if (got.length > n) socket.unshift(got.subarray(n));
      resolve(got.subarray(0, n));
    };
    socket.on("data", data).on("error", done).on("close", closed);
    socket.resume();
  });
}

/** host:port as SOCKS5 asks for it: an IPv4 or IPv6 address, or a name the proxy looks up. */
function socksAddress(host: string, port: number): Buffer {
  const p = Buffer.from([port >> 8, port & 0xff]);
  if (isIP(host) === 4) return Buffer.concat([Buffer.from([1, ...host.split(".").map(Number)]), p]);
  if (isIP(host) === 6) {
    const halves = host.split("::");
    const words = (s: string | undefined) => (s ? s.split(":").map((w) => parseInt(w, 16)) : []);
    const head = words(halves[0]), tail = words(halves[1]);
    const all = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
    return Buffer.concat([Buffer.from([4]), Buffer.from(all.flatMap((w) => [w >> 8, w & 0xff])), p]);
  }
  const name = Buffer.from(host);
  if (!name.length || name.length > 255) throw new Error("the name is too long");
  return Buffer.concat([Buffer.from([3, name.length]), name, p]);
}

/** A TCP connection to host:port through a SOCKS5 proxy with a username and password (RFC 1928, 1929). */
export async function socksConnect(proxy: { port: number; user: string; password: string }, host: string, port: number, timeoutMs = 20_000): Promise<Socket> {
  const socket = connect(proxy.port, "127.0.0.1");
  socket.pause();
  const timer = setTimeout(() => socket.destroy(new Error("Mullvad didn't answer in time")), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve).once("error", reject); });
    socket.write(Buffer.from([5, 1, 2]));
    const [v, method] = await read(socket, 2);
    if (v !== 5 || method !== 2) throw new Error("the proxy won't take a login");
    const u = Buffer.from(proxy.user), pw = Buffer.from(proxy.password);
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    if ((await read(socket, 2))[1] !== 0) throw new Error("the proxy refused its login");
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host, port)]));
    const [, rep, , atyp] = await read(socket, 4);
    if (rep !== 0) throw new Error(`${host} couldn't be reached through Mullvad: ${REPLIES[rep!] ?? "the proxy refused"}`);
    await read(socket, atyp === 1 ? 6 : atyp === 4 ? 18 : (await read(socket, 1))[0]! + 2);
    clearTimeout(timer);
    socket.resume();
    return socket;
  } catch (err) {
    clearTimeout(timer);
    socket.destroy();
    throw err;
  }
}

/** A connection to host:port that leaves through Mullvad, or an error saying why it can't. */
export type Dialer = (host: string, port: number) => Promise<Socket>;

export type MullvadState = "off" | "connecting" | "connected" | "failed";
export interface MullvadStatus {
  state: MullvadState;
  /** Where Mullvad's check sees the connection come from, once connected. */
  city?: string;
  country?: string;
  ip?: string;
  /** Why it failed, in a sentence. */
  reason?: string;
}

export interface MullvadOptions {
  /** wireproxy's path; "wireproxy" on the PATH by default. */
  binary?: string;
  log?: (line: string) => void;
  /** For tests: how the check is read. */
  check?: (dial: Dialer) => Promise<{ ip: string; city?: string; country?: string; mullvad: boolean }>;
}

/** Mullvad's check, read through the tunnel. */
async function readCheck(dial: Dialer): Promise<{ ip: string; city?: string; country?: string; mullvad: boolean }> {
  const raw = await dial(CHECK.host, 443);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: CHECK.host, path: CHECK.path, agent: false, timeout: 15_000, headers: { accept: "application/json" },
      createConnection: () => tls.connect({ socket: raw, servername: CHECK.host }) }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c: string) => { if (body.length < 65_536) body += c; }).on("end", () => {
        try {
          const j = JSON.parse(body) as { ip?: string; city?: string; country?: string; mullvad_exit_ip?: boolean };
          resolve({ ip: String(j.ip ?? ""), ...j.city ? { city: String(j.city) } : {}, ...j.country ? { country: String(j.country) } : {}, mullvad: j.mullvad_exit_ip === true });
        } catch { reject(new Error("Mullvad's check didn't answer with JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Mullvad's check took too long"))).on("error", reject).end();
  });
}

/** The one tunnel: wireproxy, started and kept running while a configuration is set. */
export class Mullvad {
  private child?: ChildProcess;
  private socks?: { port: number; user: string; password: string };
  private conf?: WireGuardConf;
  private state: MullvadState = "off";
  private reason?: string;
  private seen?: { ip: string; city?: string; country?: string; at: number };
  private restart?: NodeJS.Timeout;
  private backoff = 2_000;
  private generation = 0;

  constructor(private readonly opts: MullvadOptions = {}) {}

  /** Whether a configuration is set: the switches can be turned on only then. */
  get configured(): boolean { return !!this.conf; }

  /** The SOCKS5 port wireproxy listens on, kept from every sandbox as lyricad's own ports are. */
  get port(): number | undefined { return this.socks?.port; }

  /** Sets the configuration (or none), starting, restarting or stopping wireproxy. */
  async configure(conf: WireGuardConf | null): Promise<void> {
    this.stop();
    this.conf = conf ?? undefined;
    this.seen = undefined;
    this.reason = undefined;
    this.state = conf ? "connecting" : "off";
    if (conf) await this.start();
  }

  /** A connection through the tunnel. Refused, never sent directly, while the tunnel isn't up. */
  readonly dial: Dialer = async (host, port) => {
    if (!this.conf || !this.socks || !this.child) throw new Error(this.conf ? "Mullvad isn't connected yet" : "Mullvad isn't set up in Administration");
    return socksConnect(this.socks, host, port);
  };

  /** Where the tunnel leaves, read from Mullvad's check at most once a minute. */
  async status(fresh = false): Promise<MullvadStatus> {
    if (!this.conf) return { state: "off" };
    if (!this.child) return { state: this.state, ...this.reason ? { reason: this.reason } : {} };
    if (!fresh && this.seen && Date.now() - this.seen.at < 60_000) return { state: "connected", ...this.place() };
    try {
      const c = await (this.opts.check ?? readCheck)(this.dial);
      if (!c.mullvad) { this.state = "failed"; this.reason = `Traffic leaves from ${c.ip}, which Mullvad says isn't one of its addresses.`; return { state: "failed", reason: this.reason, ip: c.ip }; }
      this.seen = { ...c, at: Date.now() };
      this.state = "connected";
      this.reason = undefined;
      return { state: "connected", ...this.place() };
    } catch (err) {
      return { state: this.state === "connected" ? "connecting" : this.state, reason: (err as Error).message };
    }
  }

  private place() {
    const s = this.seen!;
    return { ip: s.ip, ...s.city ? { city: s.city } : {}, ...s.country ? { country: s.country } : {} };
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    const port = await freePort();
    if (generation !== this.generation || !this.conf) return;
    this.socks = { port, user: "lyrica", password: randomBytes(24).toString("base64url") };
    // The configuration (its private key, and the SOCKS login) goes through a FIFO in a folder only lyricad can open,
    // so it is never written to disk; wireproxy can't open a pipe Node made as its stdin (a socket).
    const dir = mkdtempSync(join(tmpdir(), "lyrica-mullvad-"));
    const fifo = join(dir, "wireproxy.conf");
    const made = spawnSync("mkfifo", ["-m", "0600", fifo]);
    if (made.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      this.state = "failed";
      this.reason = "mkfifo didn't run, so wireproxy can't be given its configuration.";
      return;
    }
    const child = spawn(this.opts.binary ?? "wireproxy", ["-s", "-c", fifo], { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    const gone = () => rmSync(dir, { recursive: true, force: true });
    let last = "";
    // wireproxy's log holds no traffic, only the tunnel's own events; its last line is kept as the reason it stopped.
    child.stderr!.setEncoding("utf8").on("data", (c: string) => { last = (last + c).slice(-2000); });
    // A child that never started (no binary) reports only `error`; one that did reports `exit`. Either ends it once.
    let over = false;
    const ended = (why: string | undefined, code: number | null) => {
      if (over) return;
      over = true;
      gone();
      if (this.child !== child) return;
      this.child = undefined;
      this.state = "failed";
      this.reason ??= why ?? `wireproxy stopped (${code ?? "signal"}): ${last.trim().split("\n").at(-1)?.replace(/^\S+ \S+ /, "") ?? ""}`.trim();
      this.opts.log?.(`Mullvad: ${this.reason}`);
      if (generation !== this.generation) return;
      this.restart = setTimeout(() => { this.reason = undefined; this.state = "connecting"; void this.start(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
    child.on("error", (err) => ended(/ENOENT/.test(String(err)) ? "wireproxy isn't installed on this machine." : err.message, null));
    child.on("exit", (code) => ended(undefined, code));
    // A blocking open of the FIFO would hold one of libuv's four threads until a reader came, for good if wireproxy
    // never does: it is opened without blocking, tried again until wireproxy has it open, and given up if it ends.
    const fed = await this.feed(fifo, wireproxyConfig(this.conf, this.socks), () => over || this.child !== child);
    gone();
    // One that never opened it waits for ever: stopping it lets its exit say so and try again.
    if (!fed && this.child === child) { this.reason = "wireproxy didn't read its configuration."; child.kill("SIGTERM"); return; }
    // Started: wait for the SOCKS listener, then say connected once the check agrees.
    for (let i = 0; i < 50 && this.child === child; i++) {
      if (await listening(port)) { this.backoff = 2_000; void this.status(true); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async feed(fifo: string, text: string, ended: () => boolean): Promise<boolean> {
    for (let tries = 0; tries < 100 && !ended(); tries++) {
      try {
        const f = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        // The text is far below a pipe's 64 KiB, so one write goes in whole.
        try { await f.write(text); } finally { await f.close(); }
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENXIO") return false;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return false;
  }

  /** Stops wireproxy; dials fail until a configuration is set again. */
  stop(): void {
    this.generation++;
    clearTimeout(this.restart);
    const c = this.child;
    this.child = undefined;
    this.socks = undefined;
    c?.kill("SIGTERM");
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); }).once("error", () => resolve(false));
  });
}

/**
 * SearXNG's way out: a SOCKS5 listener (no login: SearXNG's settings can't hold a secret made here) on loopback,
 * kept from every sandbox. Each connection goes through `route()` when it gives a dialer (Mullvad on for SearXNG,
 * failing while the tunnel is down rather than going direct), or straight to the host otherwise.
 */
export function egress(route: () => Dialer | undefined, port = EGRESS_PORT, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((client) => {
    client.on("error", () => client.destroy());
    // A client that never finishes its greeting doesn't keep a socket.
    const idle = setTimeout(() => client.destroy(), 15_000);
    client.on("close", () => clearTimeout(idle));
    client.pause();
    void (async () => {
      const [v, n] = await read(client, 2);
      if (v !== 5) return client.destroy();
      const methods = await read(client, n!);
      if (!methods.includes(0)) { client.end(Buffer.from([5, 0xff])); return; }
      client.write(Buffer.from([5, 0]));
      const [, cmd, , atyp] = await read(client, 4);
      let to: string;
      if (atyp === 1) to = [...await read(client, 4)].join(".");
      else if (atyp === 3) to = (await read(client, (await read(client, 1))[0]!)).toString();
      else if (atyp === 4) { const b = await read(client, 16); to = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(":"); }
      else { client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const toPort = (await read(client, 2)).readUInt16BE(0);
      if (cmd !== 1) { client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const dial = route();
      let up: Socket;
      try {
        up = dial ? await dial(to, toPort) : await new Promise<Socket>((resolve, reject) => { const s = connect(toPort, to); s.once("connect", () => resolve(s)).once("error", reject); });
      } catch {
        client.end(Buffer.from([5, dial ? 4 : 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      up.on("error", () => client.destroy());
      client.on("close", () => up.destroy());
      clearTimeout(idle);
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      up.pipe(client).pipe(up);
      client.resume();
    })().catch(() => client.destroy());
  });
  return new Promise((resolve, reject) => { server.once("error", reject).listen(port, host, () => resolve(server)); });
}

const CONFIG = "mullvad.config";
const SEARXNG = "mullvad.searxng";

/** The stored WireGuard configuration (in self.db, encrypted), or none. */
export function mullvadConfig(self: Db): WireGuardConf | null {
  const row = self.prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG) as { value: string } | undefined;
  if (!row) return null;
  try { return parseWireGuard(row.value); } catch { return null; }
}

/** Stores a configuration as pasted, after reading it (throws with the reason), or removes it. */
export function setMullvadConfig(self: Db, text: string | null): WireGuardConf | null {
  if (text === null || !text.trim()) {
    self.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(CONFIG, SEARXNG);
    return null;
  }
  const conf = parseWireGuard(text);
  self.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(CONFIG, text.trim());
  return conf;
}

/** Whether SearXNG's searches go through Mullvad (Administration → Web search). */
export function searxngThroughMullvad(self: Db): boolean {
  return !!self.prepare("SELECT 1 FROM settings WHERE key = ?").get(SEARXNG);
}

export function setSearxngThroughMullvad(self: Db, on: boolean): void {
  if (on && !mullvadConfig(self)) throw new Error("Mullvad isn't set up");
  if (on) self.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(SEARXNG, "1");
  else self.prepare("DELETE FROM settings WHERE key = ?").run(SEARXNG);
}
