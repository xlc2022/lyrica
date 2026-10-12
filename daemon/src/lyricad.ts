import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRestricted, Keyring, Memory, Models, Offline, PersonaProposals, PersonaStore, SystemdCredentials, ThreadPrefs, Users, Workspace,
  type Argon2Params, type CredentialStore, type Pool, type ThreadsLimits, type User,
} from "@lyrica/core";
import { Delegation, Sleep, type Limits, type SleepLimits } from "@lyrica/extension";
import { ChildThreads } from "./children.ts";
import { Projects } from "./projects.ts";
import { Watcher } from "./watch.ts";
import type { State, UserCard } from "./api.ts";
import { RateLimiter, Sessions } from "./auth.ts";
import { ThreadHost } from "./hosted.ts";
import {
  checkOrigin, fromLoopback, HttpError, makeRequest, match, plainAddress, sendJson, serveStatic, statusOf,
  type Request, type Route, type TrustForwarded,
} from "./http.ts";
import { ExternalListener, WebAccess, type External } from "./web/access.ts";
import { apiRoutes } from "./routes.ts";
import { sweepUser } from "./sweep.ts";

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
  /** A message waiting because no model could be reached: how often to ask again. Default 30 seconds. */
  offlineRetryMs?: number;
  /** Subagent limits (depth, concurrency, runs per request, timeout). Delegation's defaults otherwise. */
  delegation?: Partial<Limits>;
  /** Child thread limits (per request, working at once). */
  threads?: Partial<ThreadsLimits>;
  /** How long after the first trigger a project chat looks at its threads (default 30 s). */
  watchMs?: number;
  /** Sleep's per-phase limits and retries. Sleep's defaults otherwise. */
  sleep?: Partial<SleepLimits>;
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
  /** Persona proposals: drafts in each user's user.db until they send them on. */
  proposals: PersonaProposals;
  delegation: Delegation;
  /** Child threads Lyrica starts, and a project's threads. */
  children: ChildThreads;
  /** Thread pins and project settings, per user. */
  projects: Projects;
  /** A project chat's looks at what was said in its threads. */
  watcher: Watcher;
  /** Each pool's consolidate → dream → wake, one run at a time. */
  sleep: Sleep;
  host: ThreadHost;
  web: WebAccess;
  /** The user's own groups and unread marks on threads, in user.db. */
  prefs: ThreadPrefs;
}

const DEFAULT_WEB = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The version from the repository's package.json, and the build: LYRICA_BUILD (set when building a release), else the git commit, else "dev". */
const BUILD: Pick<State, "version" | "build"> = (() => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let version = "0";
  try { version = String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0"); } catch { /* no package.json beside us */ }
  let build = process.env.LYRICA_BUILD?.trim() || "";
  if (!build) {
    try { build = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim(); } catch { /* not a checkout */ }
  }
  return { version, build: build || "dev" };
})();

/**
 * lyricad: one process that unlocks, logs users in, hosts their threads as
 * in-process Pi sessions, and serves the HTTP and SSE API on 127.0.0.1 and a
 * Unix socket. It starts locked unless the self.db passphrase was saved.
 */
export class Lyricad {
  readonly keyring: Keyring;
  readonly sessions: Sessions;
  readonly limiter: RateLimiter;
  readonly log: (line: string) => void;
  services: Services | undefined;
  private readonly servers: Server[] = [];
  private readonly routes: Route[];
  private readonly mounted = new Set<string>();
  /** The external proxy's listener, from its settings file: it opens at start, before unlock. */
  readonly external: ExternalListener;
  port = 0;
  private readonly nightly: NodeJS.Timeout;
  /** The day the scheduled sleep last ran, so it runs once a night. */
  private sleptOn = "";

  constructor(readonly opts: LyricadOptions) {
    this.keyring = new Keyring(opts.home, opts.argon2);
    this.keyring.credentials = opts.credentials ?? new SystemdCredentials(join(opts.home, "credentials"));
    this.limiter = new RateLimiter(opts.rateLimit);
    // An expired session's users are logged out like any others: keys go for those who chose that.
    this.sessions = new Sessions(Date.now, (ids) => void this.loggedOut(ids));
    setInterval(() => void this.loggedOut(this.sessions.sweep()), 10 * 60_000).unref();
    this.nightly = setInterval(() => this.tick(), 20_000);
    this.nightly.unref();
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
    // A subagent's approvals are asked in its thread and its parent's, through the host built next.
    let host!: ThreadHost;
    const delegation = new Delegation({ users, memory, models, workspace, cwd, limits: this.opts.delegation, approve: (r, signal) => host.approveSubagent(r, signal) });
    const projects = new Projects(users);
    // A hidden project stops as a paused one does.
    const stopped = (u: string, p: Pool, project: string) => projects.paused(u, p, project) || hiddenThread(memory, u, p, project);
    const watcher = new Watcher({ memory, host: () => host, delayMs: this.opts.watchMs, wanted: (u, p, project) => projects.settings(u, p, project).watch && !stopped(u, p, project),
      restricted: (u, p, thread) => isRestricted(models.callContext(u, p, thread)),
    });
    const children = new ChildThreads({
      users, memory, models, workspace, delegation, host: () => host, limits: this.opts.threads,
      paused: stopped,
      project: (u, p, project) => projects.settings(u, p, project),
      updated: (u, p, project, thread) => watcher.updated(u, p, project, thread),
    });
    host = new ThreadHost({
      users, memory, models, workspace, persona, delegation, cwd, log: this.log,
      idleMs: this.opts.idleMs ?? 15 * 60_000, permissionMs: this.opts.permissionMs ?? 5 * 60_000, offlineRetryMs: this.opts.offlineRetryMs,
      threads: children, onTurn: (u, p, t, working) => {
        children.turn(u, p, t, working);
        if (!working) watcher.turnEnded(u, p, t);
      },
      projectThreads: (u, p, project) => children.projectLines(u, p, project),
    });
    const proposals = new PersonaProposals(keyring.self(), users, persona);
    const sleep = new Sleep({ users, memory, models, persona, proposals, hasKey: (id) => keyring.hasUserKey(id), cwd, limits: this.opts.sleep, log: this.log });
    const prefs = new ThreadPrefs((id) => users.openUserDb(id));
    this.services = { users, memory, models, workspace, persona, proposals, delegation, children, projects, watcher, sleep, host, web, prefs };
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
    this.services!.users.ensureRecoveryCopy(userId);
    try {
      await this.services!.workspace.mountHome(userId);
      this.mounted.add(userId);
    } catch (err) {
      this.log(`the home workspace didn't mount: ${(err as Error).message.split("\n")[0]}`);
    }
    // Child threads a restart left working are idle now, and their parents are told.
    try {
      this.services!.children.recover(userId);
    } catch (err) {
      this.log(`recovering child threads failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  /**
   * After users leave a browser session: anyone who turned "stay unlocked" off
   * and is in no other session is locked, as with Lock.
   */
  async loggedOut(userIds: string[]): Promise<void> {
    if (!this.services) return;
    for (const id of userIds) {
      if (!this.keyring.hasUserKey(id) || this.sessions.holders(id) > 0) continue;
      if (!this.services!.users.stayUnlocked(id)) await this.lockUser(id);
    }
  }

  /** Lock: stops the user's threads, unmounts their home, drops their key and every session of theirs. */
  async lockUser(userId: string): Promise<void> {
    const s = this.services!;
    // First, at once: no request or stream gets past userFor from here on.
    this.sessions.dropUser(userId);
    // Subagent runs record how they ended in user.db, and a sleep run in the pool, so they stop before the key goes.
    await s.delegation.stopAll(userId);
    await s.children.lock(userId);
    s.watcher.close(userId);
    await s.sleep.stop(userId);
    this.keyring.lockUser(userId);
    await s.host.close(userId);
    await s.workspace.unmountHome(userId).catch((err: Error) => this.log(`unmounting a home workspace failed: ${err.message}`));
    this.mounted.delete(userId);
  }

  /** The nightly sleep time, `HH:MM` local time (self.db `settings`). */
  sleepTime(): string {
    const row = this.keyring.self().prepare("SELECT value FROM settings WHERE key = 'sleep.time'").get() as { value: string } | undefined;
    return row?.value ?? "04:00";
  }

  private tick(): void {
    if (!this.services) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` !== this.sleepTime() || this.sleptOn === now.toDateString()) return;
    this.sleptOn = now.toDateString();
    try { this.services.models.prune(); } catch (err) { this.log(`model cleanup failed: ${(err as Error).name}`); }
    this.sweep(now);
    for (const u of this.services.users.all()) {
      if (!this.keyring.hasUserKey(u.id)) continue;
      try { this.services.children.autoResolve(u.id, now); } catch (err) { this.log(`resolving idle project threads failed: ${(err as Error).name}`); }
    }
    void this.sleepNight();
  }

  /** Clears what removed turns and forgotten threads left in each mounted home workspace. Logs counts only. */
  sweep(now = new Date()): void {
    const s = this.services;
    if (!s) return;
    const total = { snapshots: 0, records: 0, folders: 0, worktrees: 0 };
    for (const id of this.mounted) {
      try {
        const c = sweepUser(s, id, now);
        for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += c[k];
      } catch (err) {
        this.log(`sweep failed: ${(err as Error).name}`);
      }
    }
    this.log(`sweep: ${total.snapshots} snapshots, ${total.records} change records, ${total.folders} thread folders, ${total.worktrees} worktrees removed`);
  }

  /**
   * The scheduled sleep: every user, each pool, one at a time. A user without
   * a key is skipped (no-key); one in manual mode isn't run; a pool with
   * nothing new is skipped (no-activity).
   */
  async sleepNight(): Promise<void> {
    const s = this.services;
    if (!s) return;
    for (const u of s.users.all()) {
      if (this.keyring.hasUserKey(u.id) && s.sleep.mode(u.id) === "manual") continue;
      for (const pool of ["general", "private"] as const) {
        await s.sleep.run(u.id, pool, "scheduled").catch((err: Error) => this.log(`sleep failed: ${err.name}`));
      }
    }
  }

  state(cookie: string | undefined): State {
    if (!this.services) return { locked: true, users: [] };
    const ids = this.sessions.users(cookie) ?? new Set<string>();
    const users = [...ids].map((id) => this.services!.users.get(id)).filter((u): u is User => !!u && this.keyring.hasUserKey(u.id));
    return { locked: false, users: users.map(card), ...BUILD };
  }

  /** On SIGTERM: stop sessions, close databases, stop listening. */
  async stop(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); })));
    this.servers.length = 0;
    const s = this.services;
    this.external.close();
    clearInterval(this.nightly);
    if (s) {
      await s.delegation.stopAll();
      s.watcher.close();
      for (const u of s.users.all()) await s.sleep.stop(u.id);
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
      // Offline says which models were tried, so the interface can show it the same way for chat, images and speech.
      const offline = err instanceof Offline ? { code: err.code, task: err.task, tried: err.tried } : {};
      if (!res.headersSent) sendJson(res, status, { error: message, ...offline }, err instanceof HttpError ? err.headers : {});
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

function hiddenThread(memory: Memory, userId: string, pool: Pool, threadId: string): boolean {
  const view = memory.openThreadView(userId, pool);
  try { return !!view.own.getThread(threadId)?.hidden; } finally { view.close(); }
}
