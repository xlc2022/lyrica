// host-api's two listeners and their routes.
// - TLS on 7443 (published on the LAN address as 7236): paired clients over
//   mutual TLS, pairing, and the dashboard behind its password.
// - Plain HTTP on 7080 (published on 127.0.0.1:7236): the dashboard at the
//   machine, accepted only from the address Docker's port publishing uses.
import { readFileSync, statfsSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { LoginLimit, Sessions, browserCheck, checkPassword, cookie, hashPassword } from "./dashboard-auth.ts";
import { HostError, invalid, notFound, onlyFields, readJson, refused, sendError, sendJson } from "./http.ts";
import { loadIdentity, type Identity } from "./identity.ts";
import type { Logger } from "./log.ts";
import { PairingCodes, fingerprint } from "./pairing.ts";
import type { Downloads } from "./downloads.ts";
import type { Images } from "./images.ts";
import type { Runtime } from "./runtime.ts";
import { StateFile } from "./state.ts";

export interface HostOptions {
  dataDir: string;
  /** This host's name, shown to Lyrica and on the dashboard. */
  name: string;
  version: string;
  /** Host names and addresses the dashboard may be reached by over TLS. */
  names: string[];
  /** The host's Tailscale device name: `<name>.<tailnet>.ts.net` is ours too. */
  tailnetName?: string;
  /** Peer addresses the local listener accepts: Docker's gateway for the published loopback port. */
  localPeers: string[];
  /** The models folder inside the container, and as the host machine sees it. */
  modelsDir: string;
  modelsHostPath: string;
  log: Logger;
  now?: () => number;
}

// A request with a client certificate is Lyrica: paired, or "unpaired". One
// without is a browser: at the machine, signed in, or nobody yet.
type Access = "client" | "unpaired" | "local" | "password" | null;

const SESSION_COOKIE = "lyrica_host";
const LOCAL_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const STATIC: Record<string, [string, string]> = {
  "/": ["dashboard.html", "text/html; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
};
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const plainAddress = (a: string | undefined) => (a ?? "").replace(/^::ffff:/, "");

export class Host {
  readonly identity: Identity;
  readonly state: StateFile;
  readonly codes: PairingCodes;
  readonly sessions: Sessions;
  readonly tls: https.Server;
  readonly local: http.Server;
  runtime: Runtime | null = null;
  /** Addresses host-api never talks to, whatever they send: fetch's, which goes out to the internet. */
  /** Peers that may not call in (fetch), checked on every request. */
  refusePeer: (address: string) => Promise<boolean> = async () => false;
  downloads: Downloads | null = null;
  images: Images | null = null;
  private readonly limit: LoginLimit;
  private readonly isOurs: (name: string) => boolean;

  readonly opts: HostOptions;

  constructor(opts: HostOptions) {
    this.opts = opts;
    const now = opts.now ?? Date.now;
    this.identity = loadIdentity(opts.dataDir, opts.name);
    this.state = new StateFile(opts.dataDir);
    this.codes = new PairingCodes(now);
    this.sessions = new Sessions(now);
    this.limit = new LoginLimit(now);
    const names = new Set(opts.names.map((n) => n.toLowerCase()));
    const tailnet = opts.tailnetName ? new RegExp(`^${opts.tailnetName.toLowerCase().replace(/[^a-z0-9-]/g, "")}\\.[a-z0-9-]+\\.ts\\.net$`) : null;
    this.isOurs = (name) => names.has(name) || !!tailnet?.test(name);
    this.tls = https.createServer(
      { key: this.identity.key, cert: this.identity.cert, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" },
      (req, res) => void this.handle(req, res, "tls"),
    );
    this.local = http.createServer((req, res) => void this.handle(req, res, "local"));
  }

  async listen(tlsPort: number, localPort: number, address = "0.0.0.0"): Promise<{ tls: number; local: number }> {
    await new Promise<void>((r) => this.tls.listen(tlsPort, address, r));
    await new Promise<void>((r) => this.local.listen(localPort, address, r));
    this.opts.log("listening", { tls: (this.tls.address() as AddressInfo).port, local: (this.local.address() as AddressInfo).port, fingerprint: this.identity.fingerprint });
    return { tls: (this.tls.address() as AddressInfo).port, local: (this.local.address() as AddressInfo).port };
  }

  async close(): Promise<void> {
    this.runtime?.close();
    this.downloads?.close();
    this.images?.close();
    this.tls.closeAllConnections();
    this.local.closeAllConnections();
    await Promise.all([new Promise((r) => this.tls.close(r)), new Promise((r) => this.local.close(r))]);
  }

  private clientFingerprint(req: IncomingMessage): string | null {
    const cert = (req.socket as TLSSocket).getPeerX509Certificate?.();
    return cert ? fingerprint(cert) : null;
  }

  private access(req: IncomingMessage, via: "tls" | "local"): Access {
    if (via === "local") return "local";
    const fp = this.clientFingerprint(req);
    if (fp) {
      const client = this.state.client(fp);
      if (!client) return "unpaired";
      this.seen(client.fingerprint, client.lastSeen);
      return "client";
    }
    return this.sessions.valid(cookie(req, SESSION_COOKIE)) ? "password" : null;
  }

  /** Notes when a client was last seen, at most every five minutes. */
  private seen(fp: string, lastSeen: string | null): void {
    const now = (this.opts.now ?? Date.now)();
    if (lastSeen && now - Date.parse(lastSeen) < 5 * 60_000) return;
    this.state.update((s) => {
      const c = s.clients.find((x) => x.fingerprint === fp);
      if (c) c.lastSeen = new Date(now).toISOString();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, via: "tls" | "local"): Promise<void> {
    try {
      if (await this.refusePeer(plainAddress(req.socket.remoteAddress))) {
        res.socket?.destroy();
        return;
      }
      if (via === "local" && !this.opts.localPeers.includes(plainAddress(req.socket.remoteAddress))) {
        res.socket?.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://host");
      const access = this.access(req, via);
      if (access !== "client" && access !== "unpaired") {
        const problem = browserCheck(req, via === "local" ? "http" : "https", via === "local" ? (n) => LOCAL_NAMES.has(n) : this.isOurs);
        if (problem) throw refused(problem);
      }
      await this.route(req, res, url, via, access);
    } catch (err) {
      if (err instanceof HostError) sendError(res, err);
      else {
        this.opts.log("error", { kind: err instanceof Error ? err.name : "unknown" });
        sendError(res, new HostError(500, "internal", "Something went wrong on the host."));
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL, via: "tls" | "local", access: Access): Promise<void> {
    const { pathname } = url;
    const method = req.method ?? "GET";

    const page = STATIC[pathname];
    if (page && method === "GET") {
      res.writeHead(200, { "content-type": page[1], "cache-control": "no-store", ...SECURITY_HEADERS });
      res.end(readFileSync(new URL(`./dashboard/${page[0]}`, import.meta.url)));
      return;
    }

    if (pathname === "/pair/v1" && method === "POST") {
      if (via !== "tls") throw notFound();
      return this.pair(req, res);
    }

    if (pathname === "/dashboard/me" && method === "GET") {
      return sendJson(res, 200, { access, passwordSet: !!this.state.get().password, name: this.opts.name, fingerprint: this.identity.fingerprint });
    }
    if (pathname === "/dashboard/login" && method === "POST" && access !== "unpaired") return this.login(req, res, via);
    if (pathname === "/dashboard/logout" && method === "POST") {
      this.sessions.end(cookie(req, SESSION_COOKIE));
      return sendJson(res, 200, {}, { "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict` });
    }

    if (access === "unpaired") throw new HostError(401, "unpaired", "This Lyrica server isn't paired with this host.");
    if (access === null) throw new HostError(401, "login", "Sign in to the dashboard first.");

    // Dashboard-only: pairing codes, paired clients and the password.
    if (pathname.startsWith("/dashboard/")) {
      if (access === "client") throw refused("Only the host's dashboard can do this.");
      return this.dashboard(req, res, pathname, method, access);
    }

    if (pathname === "/host/v1/status" && method === "GET") return sendJson(res, 200, await this.status());
    // /v1 carries prompts: only a paired Lyrica server may use it.
    if (pathname.startsWith("/v1/") && access !== "client") throw refused("Only a paired Lyrica server can use /v1.");
    if (this.runtime && (await this.runtime.route(req, res, pathname, method))) return;
    if (this.downloads && (await this.downloads.route(req, res, url, method))) return;
    if (this.images && (await this.images.route(req, res, url, method))) return;
    throw notFound();
  }

  async status() {
    let free: number | null = null;
    try {
      const s = statfsSync(this.opts.modelsDir);
      free = s.bavail * s.bsize;
    } catch {}
    return {
      name: this.opts.name,
      version: this.opts.version,
      fingerprint: this.identity.fingerprint,
      state: this.runtime?.scheduler.runState ?? (this.state.get().paused ? "paused" : "running"),
      backend: this.runtime?.scheduler.gpuBackend ?? null,
      servers: this.runtime?.scheduler.servers ?? [],
      gpus: (await this.runtime?.scheduler.status()) ?? [],
      problems: this.runtime?.scheduler.problems ?? [],
      downloads: { active: this.downloads?.active ?? 0 },
      modelsFolder: { path: this.opts.modelsHostPath, free },
    };
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clientFp = this.clientFingerprint(req);
    if (!clientFp) throw new HostError(400, "client_certificate_required", "Pairing needs Lyrica's client certificate.");
    const body = await readJson(req);
    onlyFields(body, ["name", "clientNonce", "proof"]);
    const { name, clientNonce, proof } = body;
    if (typeof name !== "string" || name.trim().length < 1 || name.length > 80) throw invalid("name must be 1 to 80 characters.");
    if (typeof clientNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(clientNonce)) throw invalid("clientNonce must be 32 bytes, base64url.");
    if (typeof proof !== "string") throw invalid("proof is missing.");

    const result = this.codes.check(this.identity.fingerprint, clientFp, clientNonce, proof);
    if ("failed" in result) {
      this.opts.log("pairing refused", { reason: result.failed });
      throw result.failed === "no_code"
        ? new HostError(403, "no_code", "There's no pairing code. Make one on the host's dashboard.")
        : new HostError(403, "pairing_failed", "The pairing code doesn't match.");
    }
    const cert = (req.socket as TLSSocket).getPeerX509Certificate()!.toString();
    this.state.update((s) => {
      s.clients = s.clients.filter((c) => c.fingerprint !== clientFp);
      s.clients.push({ fingerprint: clientFp, name: name.trim(), cert, pairedAt: new Date().toISOString(), lastSeen: null });
    });
    this.opts.log("paired", { client: clientFp });
    sendJson(res, 200, { host: { name: this.opts.name, fingerprint: this.identity.fingerprint }, proof: result.hostProof });
  }

  private async login(req: IncomingMessage, res: ServerResponse, via: "tls" | "local"): Promise<void> {
    if (via !== "tls") return sendJson(res, 200, {});
    const address = plainAddress(req.socket.remoteAddress);
    // All sign-ins over Tailscale come from the tailscale container's address,
    // so there they share one limit.
    const stored = this.state.get().password;
    if (!stored) throw refused("No password is set. Set one on the dashboard at the machine.");
    if (!this.limit.begin(address)) throw new HostError(429, "too_many", "Too many tries. Wait 15 minutes.");
    let ok = false;
    try {
      const body = await readJson(req);
      onlyFields(body, ["password"]);
      ok = typeof body.password === "string" && (await checkPassword(body.password, stored));
    } finally {
      this.limit.end(address, ok);
    }
    if (!ok) {
      this.opts.log("login refused", {});
      throw new HostError(401, "login", "Wrong password.");
    }
    const token = this.sessions.start();
    sendJson(res, 200, {}, {
      "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Sessions.LIFETIME_MS / 1000}; Secure; HttpOnly; SameSite=Strict`,
    });
  }

  private async dashboard(req: IncomingMessage, res: ServerResponse, pathname: string, method: string, access: Access): Promise<void> {
    if (pathname === "/dashboard/pairing" && method === "POST") {
      const made = this.codes.make();
      this.opts.log("pairing code", { code: made.code, expiresAt: made.expiresAt });
      return sendJson(res, 200, made);
    }
    if (pathname === "/dashboard/clients" && method === "GET") {
      return sendJson(res, 200, {
        clients: this.state.get().clients.map(({ fingerprint, name, pairedAt, lastSeen }) => ({ fingerprint, name, pairedAt, lastSeen })),
      });
    }
    const revoke = pathname.match(/^\/dashboard\/clients\/([0-9a-f]{64})$/);
    if (revoke && method === "DELETE") {
      const fp = revoke[1]!;
      if (!this.state.client(fp)) throw notFound("No such client.");
      this.state.update((s) => {
        s.clients = s.clients.filter((c) => c.fingerprint !== fp);
      });
      this.opts.log("revoked", { client: fp });
      return sendJson(res, 200, {});
    }
    if (pathname === "/dashboard/password" && method === "POST") {
      const body = await readJson(req);
      onlyFields(body, ["password", "current"]);
      const stored = this.state.get().password;
      // Remotely, changing it needs the current one.
      if (access !== "local" && stored && (typeof body.current !== "string" || !(await checkPassword(body.current, stored)))) {
        throw new HostError(401, "login", "Wrong password.");
      }
      if (typeof body.password !== "string" || body.password.length < 10) throw invalid("Use at least 10 characters.");
      const hash = await hashPassword(body.password);
      this.state.update((s) => {
        s.password = hash;
      });
      this.sessions.endAll();
      this.opts.log("password set", {});
      return sendJson(res, 200, {});
    }
    throw notFound();
  }
}
