import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keyring, Memory, Models, PersonaStore, SystemdCredentials, Users, Workspace,
  type Argon2Params, type CredentialStore, type User,
} from "@lyrica/core";
import { Delegation, type Limits } from "@lyrica/extension";
import type { State, UserCard } from "./api.ts";
import { RateLimiter, Sessions } from "./auth.ts";
import { ThreadHost } from "./hosted.ts";
import {
  checkOrigin, fromLoopback, HttpError, makeRequest, match, plainAddress, sendJson, serveStatic, statusOf,
  type Request, type Route, type TrustForwarded,
} from "./http.ts";
import { ExternalListener, WebAccess, type External } from "./web/access.ts";
import { apiRoutes } from "./routes.ts";

export interface LyricadOptions {
  /** LYRICA_HOME: self.db, users/, and the Unix socket. */
  home: string;
  /** TCP port on 127.0.0.1. 0 picks a free one. */
  port: number;
  /** Web access: the built-in Caddy's admin socket and TLS log, its HTTPS port, and (for tests) this machine's addresses. */
  web?: {
    caddySocket?: string;
    tlsLog?: string;
    httpsPort?: number;
    addresses?: () => import("./api.ts").HostAddress[];
    /** How long a new name may take to get its certificate (default 90 s). */
    certWaitMs?: number;
    /** An extra CA trusted when checking that certificate (tests). */
    trustCa?: string;
  };
  /** The Unix socket for local clients; false for none. Defaults to `<home>/lyricad.sock`. */
  socket?: string | false;
  /** The built web UI. Defaults to `web/dist` in the repository. */
  webDir?: string;
  /** Where saved credentials live. Defaults to systemd credentials under `<home>/credentials`. */
  credentials?: CredentialStore;
  argon2?: Argon2Params;
  /** Run Workspace's network self-test when unlocking. Default true. */
  selfTest?: boolean;
  bwrap?: string;
  pasta?: string;
  /** Idle sessions are disposed after this long. Default 15 minutes. */
  idleMs?: number;
  /** Unanswered permission requests are denied after this long. Default 5 minutes. */
  permissionMs?: number;
  /** Subagent limits (depth, concurrency, runs per request, timeout). Delegation's defaults otherwise. */
  delegation?: Partial<Limits>;
  /** Largest upload, in bytes. Default 50 MB. */
  uploadLimit?: number;
  rateLimit?: ConstructorParameters<typeof RateLimiter>[0];
  /** Where log lines go. They carry method, route, status and timing, never text. */
  log?: (line: string) => void;
}

/** What exists once self.db is unlocked. */
export interface Services {
  users: Users;
  memory: Memory;
  models: Models;
  workspace: Workspace;
  persona: PersonaStore;
  delegation: Delegation;
  host: ThreadHost;
  web: WebAccess;
}

const DEFAULT_WEB = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * lyricad: one process that unlocks, logs users in, hosts their threads as
 * in-process Pi sessions, and serves the HTTP and SSE API on 127.0.0.1 and a
 * Unix socket. It starts locked unless the self.db passphrase was saved.
 */
export class Lyricad {
  readonly keyring: Keyring;
  readonly sessions = new Sessions();
  readonly limiter: RateLimiter;
  readonly log: (line: string) => void;
  services: Services | undefined;
  private readonly servers: Server[] = [];
  private readonly routes: Route[];
  private readonly mounted = new Set<string>();
  /** The external proxy's listener, from its settings file: it opens at start, before unlock. */
  readonly external: ExternalListener;
  port = 0;

  constructor(readonly opts: LyricadOptions) {
    this.keyring = new Keyring(opts.home, opts.argon2);
    this.keyring.credentials = opts.credentials ?? new SystemdCredentials(join(opts.home, "credentials"));
    this.limiter = new RateLimiter(opts.rateLimit);
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.routes = apiRoutes(this);
    this.external = new ExternalListener(join(opts.home, "web-external.json"), (o) => this.listenExternal(o));
  }

  get locked(): boolean { return !this.services; }

  /** Listens, then unlocks with a saved passphrase if one was handed over. */
  async start(): Promise<void> {
    const tcp = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(this.opts.port, "127.0.0.1", resolve); });
    this.port = (tcp.address() as AddressInfo).port;
    this.servers.push(tcp);
    const socket = this.socketPath;
    if (socket) {
      rmSync(socket, { force: true });
      const local = createServer((req, res) => void this.handle(req, res));
      // Created owner-only, then made explicit: no window where others could connect.
      const umask = process.umask(0o177);
      try {
        await new Promise<void>((resolve, reject) => { local.once("error", reject); local.listen(socket, resolve); });
      } finally {
        process.umask(umask);
      }
      chmodSync(socket, 0o600);
      this.servers.push(local);
    }
    this.log(`lyricad listening on 127.0.0.1:${this.port}${socket ? ` and ${socket}` : ""}`);
    // While locked it answers only state, unlock and the web UI's files here too, so the proxy can show the unlock page.
    await this.external.start().catch((err: Error) => this.log(`the external proxy's listener didn't open: ${err.message}`));
    if (await this.keyring.unlockSaved().catch((err: Error) => { this.log(`the saved passphrase didn't unlock self.db: ${err.message}`); return false; })) {
      await this.unlocked();
    } else {
      this.log("lyricad is locked");
    }
  }

  get socketPath(): string | undefined {
    return this.opts.socket === false ? undefined : this.opts.socket ?? join(this.opts.home, "lyricad.sock");
  }

  private unlocking: Promise<void> | undefined;

  /** Unlocks self.db. One unlock at a time: the self-test can take a while, and a second open would close the first. */
  async unlock(passphrase: string): Promise<void> {
    if (this.services || this.unlocking) throw new HttpError(409, "already unlocked or unlocking");
    this.unlocking = (async () => {
      await this.keyring.unlockSelf(passphrase);
      await this.unlocked();
    })();
    try {
      await this.unlocking;
    } finally {
      this.unlocking = undefined;
    }
  }

  /** Builds everything that needs self.db, runs the network self-test, and takes saved user keys. */
  private async unlocked(): Promise<void> {
    const { keyring } = this;
    const users = new Users(keyring);
    const w = this.opts.web ?? {};
    const web: WebAccess = new WebAccess({
      self: () => keyring.self(),
      caddy: { socket: w.caddySocket ?? "/run/lyrica-caddy/admin.sock", tlsLog: w.tlsLog ?? "/run/lyrica-caddy/tls.log" },
      httpsPort: w.httpsPort ?? 443, upstream: this.port, reserved: [this.port], addresses: w.addresses,
      external: this.external, certWaitMs: w.certWaitMs, trustCa: w.trustCa, log: this.log,
    });
    // Where the front door is, read at every sandbox start, so a change in web access applies to the next command.
    const workspace = new Workspace(keyring, users, {
      excludePorts: [this.port], frontDoor: () => web.frontDoor(), bwrap: this.opts.bwrap, pasta: this.opts.pasta,
    });
    if (this.opts.selfTest !== false) {
      const refused = await workspace.selfTest();
      if (refused) this.log(`network is off for every thread: ${refused}`);
    }
    const memory = new Memory(keyring, users);
    const models = new Models(keyring, users);
    const persona = new PersonaStore(keyring.self());
    const cwd = join(this.opts.home, "run");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const delegation = new Delegation({ users, memory, models, workspace, cwd, limits: this.opts.delegation });
    const host = new ThreadHost({
      users, memory, models, workspace, persona, delegation, cwd, log: this.log,
      idleMs: this.opts.idleMs ?? 15 * 60_000, permissionMs: this.opts.permissionMs ?? 5 * 60_000,
    });
    this.services = { users, memory, models, workspace, persona, delegation, host, web };
    await web.resume();
    for (const u of users.all()) {
      if (keyring.loadSavedKey(u.id)) {
        await this.keyAvailable(u.id);
        this.log(`unlocked a user with saved credentials`);
      }
    }
    this.log("lyricad is unlocked");
  }

  /** The user's key is in memory: mount their home workspace. A failed mount leaves tools failing with the reason. */
  async keyAvailable(userId: string): Promise<void> {
    if (this.mounted.has(userId)) return;
    try {
      await this.services!.workspace.mountHome(userId);
      this.mounted.add(userId);
    } catch (err) {
      this.log(`the home workspace didn't mount: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  /** Lock: stops the user's threads, unmounts their home, drops their key and every session of theirs. */
  async lockUser(userId: string): Promise<void> {
    const s = this.services!;
    // First, at once: no request or stream gets past userFor from here on.
    this.sessions.dropUser(userId);
    // Subagent runs record how they ended in user.db, so they stop before the key goes.
    await s.delegation.stopAll(userId);
    this.keyring.lockUser(userId);
    await s.host.close(userId);
    await s.workspace.unmountHome(userId).catch((err: Error) => this.log(`unmounting a home workspace failed: ${err.message}`));
    this.mounted.delete(userId);
  }

  state(cookie: string | undefined): State {
    if (!this.services) return { locked: true, users: [] };
    const ids = this.sessions.users(cookie) ?? new Set<string>();
    const users = [...ids].map((id) => this.services!.users.get(id)).filter((u): u is User => !!u && this.keyring.hasUserKey(u.id));
    return { locked: false, users: users.map(card) };
  }

  /** On SIGTERM: stop sessions, close databases, stop listening. */
  async stop(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); })));
    this.servers.length = 0;
    const s = this.services;
    this.external.close();
    if (s) {
      await s.delegation.stopAll();
      await s.host.close();
      for (const id of this.mounted) await s.workspace.unmountHome(id).catch(() => {});
      for (const u of s.users.all()) this.keyring.lockUser(u.id);
    }
    this.mounted.clear();
    this.services = undefined;
    try { this.keyring.self().close(); } catch { /* already locked */ }
    const socket = this.socketPath;
    if (socket && existsSync(socket)) rmSync(socket, { force: true });
  }

  /**
   * The extra listener for an external proxy: only the listed proxies may
   * connect, and only their X-Forwarded-For is believed. HTTPS with lyricad's
   * own certificate, or plain HTTP on a Tailscale address.
   */
  private listenExternal(o: External): Promise<Server> {
    const trust: TrustForwarded = (remote) => this.external.proxies().includes(plainAddress(remote));
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res, trust);
    const server: Server = o.tls ? createHttpsServer({ key: o.tls.key, cert: o.tls.cert, minVersion: "TLSv1.2" }, handler) : createServer(handler);
    server.on("connection", (socket) => { if (!trust(socket.remoteAddress ?? "")) socket.destroy(); });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(o.port, o.address, () => { server.off("error", reject); resolve(server); });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, trust: TrustForwarded = fromLoopback): Promise<void> {
    const started = performance.now();
    const method = req.method ?? "GET";
    let routeName = "(static)";
    res.once("close", () => this.log(`${method} ${routeName} ${res.statusCode} ${(performance.now() - started).toFixed(0)}ms`));
    try {
      const url = new URL(req.url ?? "/", "http://lyricad");
      const path = url.pathname;
      if (!path.startsWith("/api/")) {
        if ((method === "GET" || method === "HEAD") && serveStatic(this.opts.webDir ?? DEFAULT_WEB, path, res)) return;
        throw new HttpError(404, "not found");
      }
      const found = match(this.routes, method, path);
      if (found === "method") throw new HttpError(405, "method not allowed");
      if (!found) throw new HttpError(404, "not found");
      routeName = found.route.pattern;
      const open = routeName === "/api/state" || routeName === "/api/unlock";
      if (!open && !this.services) throw new HttpError(503, "lyricad is locked");
      if (method !== "GET" && method !== "HEAD") checkOrigin(req);
      const r: Request = makeRequest(req, res, routeName, found.params, url, trust);
      const body = await found.route.handler(r);
      if (res.headersSent) return; // a stream, or a handler that answered itself
      sendJson(res, 200, body);
    } catch (err) {
      const status = err instanceof URIError ? 400 : statusOf(err);
      const message = status === 500 ? "internal error" : (err as Error).message;
      if (status === 500) this.log(`error in ${method} ${routeName}: ${(err as Error).name}: ${(err as Error).message.split("\n")[0]}`);
      if (!res.headersSent) sendJson(res, status, { error: message }, err instanceof HttpError ? err.headers : {});
      else res.end();
    }
  }

  /** The user named in the path, if this browser session is logged in as them and their key is in memory. */
  userFor(r: Request): User {
    const ids = this.sessions.users(r.cookie);
    if (!ids) throw new HttpError(401, "not logged in");
    const id = r.params.userId!;
    const user = this.services!.users.get(id);
    if (!user || !ids.has(id) || !this.keyring.hasUserKey(id)) throw new HttpError(401, "not logged in as this user");
    return user;
  }

  adminFor(r: Request): User {
    const user = this.userFor(r);
    if (!user.admin) throw new HttpError(403, "only an administrator can do this");
    return user;
  }
}

export function card(u: User): UserCard {
  const p = u.profile;
  return {
    id: u.id, login: u.login, displayName: p.displayName, pronouns: p.pronouns, admin: u.admin,
    ...(p.accent ? { accent: p.accent } : {}), ...(p.monogram ? { monogram: p.monogram } : {}),
  };
}
