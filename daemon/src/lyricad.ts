import { UserEvents } from "./user-events.ts";
import { Push } from "./push.ts";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adoptLocalSearxng, bootstrap, isMounted, codexImage, DEFAULT_NAME, HostRefused, isRestricted, Keyring, Memory, Models, Offline, PersonaProposals, PersonaStore, PRONOUN_PRESETS, searxngAddress, selfName, setSelfName,
  SystemdCredentials, ThreadPrefs, ThreadShares, Users, WrongPassword, Workspace, finishWipe, homeWiped, homeWipePending, wipePending, wipePools,
  type Argon2Params, type CredentialStore, type Pool, type ThreadsLimits, type User,
} from "@lyrica/core";
import { Delegation, planCatalog, Sleep, type Limits, type SleepLimits } from "@lyrica/extension";
import { ChildThreads } from "./children.ts";
import { Routines } from "./routines.ts";
import { Wakeups } from "./wakeups.ts";
import { ForgeWatcher } from "./forge-watch.ts";
import { Projects } from "./projects.ts";
import { Watcher } from "./watch.ts";
import type { BusyItem, Health, SetupRequest, State, UserCard } from "./api.ts";
import { RateLimiter, Sessions } from "./auth.ts";
import { ThreadHost } from "./hosted.ts";

/** Model host refusals the web UI acts on, so their code goes with the message. */
const HOST_CODES = ["need_repo", "above_recommended"];
/** Changes no list in the shell shows, so they don't tell the user's other tabs: a draft saves after each pause in typing. */
const UNLISTED = new Set(["/api/u/:userId/threads/:pool/:threadId/draft"]);
import {
  checkOrigin, fromLoopback, HttpError, makeRequest, match, plainAddress, readBody, secureServer, sendJson, serveStatic, statusOf, Updating,
  type Listener, type Request, type Route, type TrustForwarded,
} from "./http.ts";
import { TailnetControl } from "./tailnet.ts";
import { listenUpdateSocket, type Drainable, type UpdatePaths } from "./updates.ts";
import { DIRECT_PORT, directFor, ExternalListener, hostAddresses, WebAccess, type Bind } from "./web/access.ts";
import { apiRoutes } from "./routes.ts";
import { sweepUser, wipeHome } from "./sweep.ts";

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
    /** Direct's port on this machine's addresses (default 7340, lyricad's own). */
    directPort?: number;
    /** The loopback port only `tailscale serve` targets (default 7342, or a free one when `port` is 0). */
    servePort?: number;
  };
  /** Her tailscaled: the `tailscale` binary (default: on PATH) and her socket. */
  tailnet?: { binary?: string; socket?: string };
  /** The persona seed for setup. Defaults to `persona/` in the repository. */
  seed?: string;
  /** The Unix socket for local clients; false for none. Defaults to `<home>/lyricad.sock`. */
  socket?: string | false;
  /** The built web UI. Defaults to `web/dist` in the repository. */
  webDir?: string;
  /** Where saved credentials live. Defaults to systemd credentials under `<home>/credentials`. */
  credentials?: CredentialStore;
  argon2?: Argon2Params;
  /** Tests only: SQLCipher's rounds for the self.db passphrase (Keyring). Default SQLCipher's 256,000. */
  kdfIter?: number;
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
  /**
   * Updates: the socket root's updater uses (default `<home>/update.sock`;
   * false for none), the updater's state folder (default
   * /var/lib/lyrica-update) and where requests go (default `<home>/updates`).
   */
  update?: { socket?: string | false; state?: string; requests?: string };
}

/** What exists once self.db is unlocked. */
export interface Services {
  wakeups: Wakeups;
  routines: Routines;
  /** CI wakes: polls each thread's open pull requests and hands the notes to the wake-up path. */
  forge: ForgeWatcher;
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
  /** Her own tailscaled. */
  tailnet: TailnetControl;
  /** The user's own groups and unread marks on threads, in user.db. */
  prefs: ThreadPrefs;
  /** Threads shared with a user, waiting in self.db for them to add or decline. */
  shares: ThreadShares;
}

const DEFAULT_WEB = fileURLToPath(new URL("../../web/dist", import.meta.url));
const DEFAULT_SEED = fileURLToPath(new URL("../../persona", import.meta.url));
/** The setup code's 32 symbols: digits and capitals without 0, O, 1 and I. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SERVE_PORT = 7342;

/**
 * The version from the repository's package.json, and the build: the commit in
 * RELEASE.json (written when a release is built), else LYRICA_BUILD (the NixOS
 * module), else the git commit, else "dev".
 */
export const BUILD: Pick<State, "version" | "build"> = (() => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let version = "0";
  try { version = String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0"); } catch { /* no package.json beside us */ }
  let build = "";
  try { build = String((JSON.parse(readFileSync(join(root, "RELEASE.json"), "utf8")) as { commit?: string }).commit ?? "").slice(0, 12); } catch { /* not a built release */ }
  build ||= process.env.LYRICA_BUILD?.trim() || "";
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
export class Lyricad implements Drainable {
  readonly userEvents = new UserEvents();
  readonly push = new Push(this);
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
  readonly tailnet: TailnetControl;
  port = 0;
  /** The loopback port only `tailscale serve` targets: requests on it came through her tailnet address. */
  servePort = 0;
  /** While setting up: the one-time code the setup page asks for. */
  private setupCode: string | undefined;
  /** Her name, as last read or set: answered while locked, from a copy beside self.db. */
  private nameSeen: string | undefined;
  private readonly nightly: NodeJS.Timeout;
  /** The day the scheduled sleep last ran, so it runs once a night. */
  private sleptOn = "";
  /** When sleep's old phase threads were last forgotten: once an hour. */
  private prunedAt = 0;
  /** The scheduled sleep came due during an update's drain: it runs at undrain. */
  private sleepDue = false;
  private drainingNow = false;
  /** A memory wipe is running: new turns are refused and scheduled work waits, as while draining. */
  private wipingNow = false;
  /** Why unlocking failed, other than a wrong passphrase (a database this release can't read or migrate): a failed health check. */
  private unlockError: string | undefined;
  readonly updatePaths: UpdatePaths;

  constructor(readonly opts: LyricadOptions) {
    this.keyring = new Keyring(opts.home, opts.argon2, opts.kdfIter);
    this.keyring.credentials = opts.credentials ?? new SystemdCredentials(join(opts.home, "credentials"), undefined, undefined, (line) => this.log(line));
    this.limiter = new RateLimiter(opts.rateLimit);
    // An expired session's users are logged out like any others: keys go for those who chose that.
    this.sessions = new Sessions(Date.now, (ids) => void this.loggedOut(ids));
    setInterval(() => void this.loggedOut(this.sessions.sweep()), 10 * 60_000).unref();
    this.nightly = setInterval(() => this.tick(), 20_000);
    this.nightly.unref();
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.routes = apiRoutes(this);
    this.external = new ExternalListener(join(opts.home, "web-external.json"), (o) => this.listenExternal(o));
    this.updatePaths = { state: opts.update?.state ?? "/var/lib/lyrica-update", requests: opts.update?.requests ?? join(opts.home, "updates") };
    this.tailnet = new TailnetControl({ binary: opts.tailnet?.binary, socket: opts.tailnet?.socket, runtime: opts.home });
  }

  get locked(): boolean { return !this.services; }

  /** Setting up: there is no self.db yet. */
  get settingUp(): boolean { return !this.services && !this.keyring.selfExists(); }

  private get codePath(): string { return join(this.opts.home, "setup-code"); }
  private get namePath(): string { return join(this.opts.home, "name"); }

  /** Listens, then unseals a saved passphrase and unlocks if it is available. */
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
    const updateSocket = this.opts.update?.socket === false ? undefined : this.opts.update?.socket ?? join(this.opts.home, "update.sock");
    if (updateSocket) this.servers.push(await listenUpdateSocket(updateSocket, this, this.log));
    // Only her tailscaled's `serve` targets this one, so a request on it came through her tailnet address.
    const serve = createServer((req, res) => void this.handle(req, res, fromLoopback, "tailnet"));
    await new Promise<void>((resolve, reject) => { serve.once("error", reject); serve.listen(this.opts.web?.servePort ?? (this.opts.port === 0 ? 0 : SERVE_PORT), "127.0.0.1", resolve); });
    this.servePort = (serve.address() as AddressInfo).port;
    this.servers.push(serve);
    this.log(`lyricad listening on 127.0.0.1:${this.port}${socket ? ` and ${socket}` : ""}, and on 127.0.0.1:${this.servePort} for her tailnet`);
    mkdirSync(this.opts.home, { recursive: true, mode: 0o700 });
    if (this.settingUp) await this.beginSetup();
    await this.directAddresses();
    // While locked it answers only state, unlock and the web UI's files here too, so the proxy can show the unlock page.
    await this.external.start().catch((err: Error) => this.log(`the extra listener didn't open everywhere: ${firstLine(err)}`));
    if (this.settingUp) {
      this.log("lyricad is setting up");
      return;
    }
    if (await this.keyring.unlockSaved().catch((err: Error) => { this.unlockFailed(err); this.log(`the saved passphrase didn't unlock self.db: ${firstLine(err)}`); return false; })) {
      await this.unlocked();
    } else {
      this.log("lyricad is locked");
    }
  }

  /**
   * Setting up: a new one-time code, logged once and written to
   * `<home>/setup-code` (0600), and Direct, if no web access was set.
   */
  private async beginSetup(): Promise<void> {
    const bytes = randomBytes(5);
    let bits = 0n;
    for (const b of bytes) bits = (bits << 8n) | BigInt(b);
    let code = "";
    for (let i = 0; i < 8; i++) code = CODE_ALPHABET[Number(bits & 31n)]! + code, bits >>= 5n;
    this.setupCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    rmSync(this.codePath, { force: true });
    writeFileSync(this.codePath, `${this.setupCode}\n`, { mode: 0o600 });
    chmodSync(this.codePath, 0o600);
    if (!existsSync(join(this.opts.home, "web-external.json"))) {
      const addresses = (this.opts.web?.addresses ?? hostAddresses)().map((a) => a.address);
      this.external.adopt(await directFor(addresses, this.opts.web?.directPort ?? DIRECT_PORT));
    }
    const dir = this.external.direct();
    const where = [`http://127.0.0.1:${this.port}`, ...(dir?.addresses ?? []).map((a) => `https://${a}:${dir!.port}`)].join(", ");
    this.log(`Set up Lyrica at ${where} with the code in ${this.codePath}`);
  }

  /**
   * Direct listens on the addresses this machine has now. If they changed,
   * a new certificate names them (its fingerprint changes too, and is logged).
   */
  private async directAddresses(): Promise<void> {
    const dir = this.external.direct();
    if (!dir) return;
    const now = (this.opts.web?.addresses ?? hostAddresses)().map((a) => a.address);
    const next = await directFor(now, dir.port, dir);
    if (next.tls !== dir.tls) {
      this.external.adopt(next);
      this.log(`Direct: this machine's addresses changed; the new certificate's fingerprint is ${new X509Certificate(next.tls.cert).fingerprint256}`);
    }
  }

  /** Whether the code is the setup code. Case, spaces and dashes don't matter. */
  private codeMatches(given: unknown): boolean {
    const norm = (c: string) => c.toUpperCase().replace(/[\s-]/g, "");
    if (!this.setupCode) return false;
    const a = Buffer.from(norm(String(given ?? "")));
    const b = Buffer.from(norm(this.setupCode));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * POST /api/setup: checks the code (a wrong one throws WrongPassword, for
   * the unlock limiter), runs bootstrap(), saves the passphrase if asked,
   * and unlocks. Returns the first administrator, whose key is in memory.
   */
  async setup(req: SetupRequest): Promise<User> {
    if (!this.settingUp) throw new HttpError(409, "Lyrica is set up already");
    if (this.unlocking) throw new HttpError(409, "setup is already running");
    if (!this.codeMatches(req.code)) throw new WrongPassword();
    const passphrase = String(req.passphrase ?? "");
    const a = req.admin ?? ({} as SetupRequest["admin"]);
    if (req.saveCredentials) {
      const why = this.keyring.credentials ? this.keyring.credentials.unavailable() : "saving credentials isn't set up here";
      if (why) throw new Error(`can't save credentials: ${why}`);
    }
    let admin!: User;
    this.unlocking = (async () => {
      admin = await bootstrap(this.keyring, {
        passphrase, name: req.name ?? DEFAULT_NAME, seed: this.opts.seed ?? DEFAULT_SEED,
        admin: { login: String(a.login ?? ""), password: String(a.password ?? ""), profile: { displayName: String(a.displayName ?? ""), pronouns: a.pronouns ?? PRONOUN_PRESETS.they } },
      });
      if (req.saveCredentials) await this.keyring.saveSelfPassphrase(passphrase).catch((err: Error) => this.log(`the passphrase wasn't saved: ${firstLine(err)}`));
      this.rememberName(selfName(this.keyring.self()));
      this.setupCode = undefined;
      rmSync(this.codePath, { force: true });
      await this.unlocked();
    })();
    try {
      await this.unlocking;
    } finally {
      this.unlocking = undefined;
    }
    this.log("lyricad is set up");
    return admin;
  }

  /**
   * install.sh leaves `searxng-address` beside self.db when it runs SearXNG
   * here (docs/guides/searxng.md): it becomes Administration's address while
   * none is set.
   */
  private adoptSearxng(): void {
    let address: string;
    try { address = readFileSync(join(this.opts.home, "searxng-address"), "utf8").trim(); } catch { return; }
    try {
      if (adoptLocalSearxng(this.keyring.self(), address)) this.log("web search uses the SearXNG install.sh runs here");
    } catch (err) {
      this.log(`searxng-address isn't a SearXNG address: ${firstLine(err as Error)}`);
    }
  }

  /** Her name: from self.db once unlocked, else the copy beside it. */
  name(): string {
    if (this.services) return selfName(this.keyring.self());
    if (this.nameSeen === undefined) {
      try { this.nameSeen = readFileSync(this.namePath, "utf8").trim() || DEFAULT_NAME; } catch { this.nameSeen = DEFAULT_NAME; }
    }
    return this.nameSeen;
  }

  /** Sets her name (administrators). Nothing already written is rewritten. */
  setName(name: string): string {
    const n = setSelfName(this.keyring.self(), name);
    this.rememberName(n);
    return n;
  }

  /** Her name isn't memory: a copy beside self.db lets the unlock page say it. */
  private rememberName(name: string): void {
    this.nameSeen = name;
    writeFileSync(this.namePath, `${name}\n`, { mode: 0o600 });
  }

  get socketPath(): string | undefined {
    return this.opts.socket === false ? undefined : this.opts.socket ?? join(this.opts.home, "lyricad.sock");
  }

  private unlocking: Promise<void> | undefined;

  /** Unlocks self.db. One unlock at a time: the self-test can take a while, and a second open would close the first. */
  async unlock(passphrase: string): Promise<void> {
    if (this.services || this.unlocking) throw new HttpError(409, "already unlocked or unlocking");
    this.unlocking = (async () => {
      try {
        await this.keyring.unlockSelf(passphrase);
      } catch (err) {
        this.unlockFailed(err as Error);
        throw err;
      }
      this.unlockError = undefined;
      await this.unlocked();
    })();
    try {
      await this.unlocking;
    } finally {
      this.unlocking = undefined;
    }
  }

  /** A database this release can't read or migrate fails the health check; a wrong passphrase doesn't. */
  private unlockFailed(err: Error): void {
    if (err.name === "SchemaTooNew" || err.name === "MigrationFailed") this.unlockError = `${err.name}: ${err.message}`;
  }

  /** Builds everything that needs self.db, runs the network self-test, and takes saved user keys. */
  private async unlocked(): Promise<void> {
    const { keyring } = this;
    this.adoptSearxng();
    const users = new Users(keyring);
    const w = this.opts.web ?? {};
    const web: WebAccess = new WebAccess({
      self: () => keyring.self(), tailnet: this.tailnet, servePort: this.servePort, directPort: w.directPort,
      caddy: { socket: w.caddySocket ?? "/run/lyrica-caddy/admin.sock", tlsLog: w.tlsLog ?? "/run/lyrica-caddy/tls.log" },
      httpsPort: w.httpsPort ?? 443, upstream: this.port, reserved: [this.port, this.servePort], addresses: w.addresses,
      external: this.external, certWaitMs: w.certWaitMs, trustCa: w.trustCa, log: this.log,
    });
    // Where the front door is, read at every sandbox start, so a change in web access applies to the next command.
    const workspace = new Workspace(keyring, users, {
      excludePorts: [this.port, this.servePort], frontDoor: () => web.frontDoor(), bwrap: this.opts.bwrap, pasta: this.opts.pasta,
      // A private or local-only thread never gets Claude Code. Asked at each run, once the models below exist.
      restricted: (u, p, thread) => isRestricted(models.callContext(u, p, thread)),
      // A run's relay opened a pull request: the CI-watch poller records it (docs/briefs/ci-wakes.md).
      onPullCreate: (t, pr) => forge.record(t.userId, t.pool, t.threadId, pr.repo, pr.number),
    });
    if (this.opts.selfTest !== false) {
      const refused = await workspace.selfTest();
      if (refused) this.log(`network is off for every thread: ${refused}`);
    }
    const memory = new Memory(keyring, users);
    const models = new Models(keyring, users);
    models.setPlanCatalog(planCatalog);
    models.setCodexImages((userId, request, signal) => codexImage({ ...workspace.codexBox(userId), log: this.log }, request, signal));
    const persona = new PersonaStore(keyring.self());
    const cwd = join(this.opts.home, "run");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    // A subagent's approvals are asked in its thread and its parent's, through the host built next.
    let host!: ThreadHost;
    let forge!: ForgeWatcher;
    const delegation = new Delegation({ users, memory, models, workspace, cwd, limits: this.opts.delegation, approve: (r, signal) => host.approveSubagent(r, signal), name: () => selfName(keyring.self()), searxng: () => searxngAddress(keyring.self()) });
    const projects = new Projects(users);
    // A hidden project stops as a paused one does.
    const stopped = (u: string, p: Pool, project: string) => projects.paused(u, p, project) || hiddenThread(memory, u, p, project);
    const watcher = new Watcher({ memory, models, host: () => host, delayMs: this.opts.watchMs, log: this.log, name: () => selfName(keyring.self()),
      wanted: (u, p, project) => projects.settings(u, p, project).watch && !stopped(u, p, project),
      restricted: (u, p, thread) => isRestricted(models.callContext(u, p, thread)),
      threads: (u, p, project) => ({
        open: children.projectThreads(u, p, project).filter((t) => t.state !== "resolved").map((t) => t.id), lines: children.projectLines(u, p, project),
      }),
      tell: async (u, p, project, thread, text) => { await children.tellFromProject(u, p, project, thread, text); },
      store: (u, p, project, content, details) => children.storeLook(u, p, project, content, details),
    });
    // A project's thread whose turn ended with an error, or that waits for an approval, is a trigger for a look.
    const projectOf = (u: string, p: Pool, thread: string) => {
      try { const v = memory.openThreadView(u, p); try { return v.own.projectOf(thread); } finally { v.close(); } } catch { return undefined; }
    };
    /** Threads whose turn's last word so far is an error, by `user/pool/thread`: a retry that answers clears it. */
    const erred = new Set<string>();
    /** Threads whose last turn was stopped, by `user/pool/thread`. */
    const aborted = new Set<string>();
    const children = new ChildThreads({
      users, memory, models, workspace, delegation, host: () => host, limits: this.opts.threads,
      paused: stopped,
      project: (u, p, project) => projects.settings(u, p, project),
      draft: (u, p, project, change) => { projects.set(u, p, project, { draftGoal: change.goal, draftInstructions: change.instructions }); },
      updated: (u, p, project, thread) => watcher.updated(u, p, project, thread),
      wakeups: (): Wakeups => wakeups,
    });
    const wakeups: Wakeups = new Wakeups({ memory, host: () => host, children, log: this.log });
    forge = new ForgeWatcher({ memory, workspace, wakeups, log: this.log });
    host = new ThreadHost({
      users, memory, models, workspace, persona, delegation, cwd, log: this.log, searxng: () => searxngAddress(keyring.self()), name: () => selfName(keyring.self()),
      idleMs: this.opts.idleMs ?? 15 * 60_000, permissionMs: this.opts.permissionMs ?? 5 * 60_000, offlineRetryMs: this.opts.offlineRetryMs,
      codePulls: (u, p, t) => forge.codePulls(u, p, t),
      threads: children, onTurn: (u, p, t, working, byPerson) => {
        children.turn(u, p, t, working);
        if (!working) routines.ended(u, p, t);
        const k = `${u}/${p}/${t}`;
        if (working) { erred.delete(k); aborted.delete(k); if (byPerson) watcher.wrote(u, p, t); return watcher.turnStarted(u, p, t); }
        // Only a turn the person wrote in resets the run of looks; a child's wake or a marked message isn't one.
        if (byPerson ?? true) watcher.turnEnded(u, p, t);
        const failed = erred.delete(k);
        children.ended(u, p, t, failed ? "error" : aborted.delete(k) ? "stopped" : "done");
        if (!failed) return;
        const project = projectOf(u, p, t);
        if (project) watcher.failed(u, p, project, t);
      },
      onEvent: (u, p, t, e) => {
        if (["turn_start", "turn_end", "title", "settings", "permission", "permission_end", "child"].includes(e.type)) this.userEvents.changed(u);
        if (e.type === "permission" || e.type === "settings") queueMicrotask(() => this.push.tick());
        const k = `${u}/${p}/${t}`;
        if (e.type === "error" && host.busy(u, p, t)) erred.add(k);
        else if (e.type === "message_start" || e.type === "turn_start") { erred.delete(k); aborted.delete(k); }
        else if (e.type === "turn_end" && e.aborted) aborted.add(k);
        else if (e.type === "permission") {
          const project = projectOf(u, p, t);
          if (project) watcher.waiting(u, p, project, t);
        }
      },
      projectThreads: (u, p, project) => children.projectLines(u, p, project),
    });
    const proposals = new PersonaProposals(keyring.self(), users, persona);
    const sleep = new Sleep({ users, memory, models, persona, proposals, hasKey: (id) => keyring.hasUserKey(id), cwd, limits: this.opts.sleep, log: this.log });
    sleep.events.on("event", (e) => this.userEvents.changed(e.userId));
    const prefs = new ThreadPrefs((id) => users.openUserDb(id));
    host.draining = this.drainingNow;
    const shares = new ThreadShares(keyring.self());
    const routines = new Routines({ memory, host: () => host, children, log: this.log });
    this.services = { routines, wakeups, forge, users, memory, models, workspace, persona, proposals, delegation, children, projects, watcher, sleep, host, web, tailnet: this.tailnet, prefs, shares };
    this.rememberName(selfName(keyring.self()));
    await web.resume();
    for (const u of users.all()) {
      if (await keyring.loadSavedKey(u.id)) {
        await this.keyAvailable(u.id);
        this.log(`unlocked a user with saved credentials`);
      }
    }
    this.log("lyricad is unlocked");
  }

  /** The user's key is in memory: mount their home workspace. A failed mount leaves tools failing with the reason. */
  async keyAvailable(userId: string): Promise<void> {
    if (this.mounted.has(userId)) return;
    const pushUser = this.services!.users.get(userId);
    if (pushUser) void this.push.check(pushUser, true).catch(() => this.log("push check failed"));
    // Local endpoints read again once per run, in the background, so stored model details catch up with discovery.
    if (pushUser) void this.services!.models.rereadLocal(pushUser).catch(() => {});
    this.services!.users.ensureRecoveryCopy(userId);
    try {
      await this.services!.workspace.mountHome(userId);
      this.mounted.add(userId);
    } catch (err) {
      this.log(`the home workspace didn't mount: ${(err as Error).message.split("\n")[0]}`);
    }
    // A wipe made while this user was locked finishes before anything reads their threads.
    try {
      this.finishWipe(userId);
    } catch (err) {
      this.log(`finishing a memory wipe failed: ${(err as Error).name}`);
    }
    // Scheduled turns wait in the encrypted pools and fire on the tick while unlocked.
    try {
      this.services!.wakeups.load(userId);
      this.services!.routines.load(userId);
      this.services!.forge.load(userId);
    } catch (err) {
      this.log(`loading scheduled turns failed: ${(err as Error).name}`);
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
    // First, at once: no request or stream gets past userFor from here on.
    this.sessions.dropUser(userId);
    await this.stopWork(userId);
    this.keyring.lockUser(userId);
    await this.services!.host.close(userId);
    await this.services!.workspace.unmountHome(userId).catch((err: Error) => this.log(`unmounting a home workspace failed: ${firstLine(err)}`));
    this.mounted.delete(userId);
  }

  /** Stops everything running for the user: scheduled turns, subagents, child threads, sleep. Their key stays. */
  private async stopWork(userId: string): Promise<void> {
    const s = this.services!;
    s.wakeups.drop(userId);
    s.routines.drop(userId);
    s.forge.drop(userId);
    // Subagent runs record how they ended in user.db, and a sleep run in the pool, so they stop before the key goes.
    await s.delegation.stopAll(userId);
    await s.children.lock(userId);
    s.watcher.close(userId);
    await s.sleep.stop(userId);
  }

  /**
   * Wipe memory (DESIGN.md, "Wiping memory"): every user's threads and
   * memories in both pools, and their thread files. Running work stops first;
   * a locked user's user.db and home are cleaned at their next unlock. Users
   * stay signed in. Logs a count only. While anything is running (a turn, a
   * subagent, a sleep run) it is sent a stop and nothing is wiped: the
   * result lists what was running, and the wipe is asked for again.
   */
  async wipeMemory(): Promise<{ wiped: boolean; busy: BusyItem[] }> {
    const s = this.services!;
    if (this.wipingNow) throw new HttpError(409, "a wipe is already running");
    // From here no new turn starts (refuseWhileDraining, host.draining) and ticks and sleep wait, until the wipe is done or gives way.
    this.wipingNow = true;
    s.host.draining = true;
    try {
      const busy = this.busy();
      if (busy.length) {
        for (const b of busy) {
          if (b.kind === "turn" && b.pool && b.threadId) await s.host.get(b.userId, b.pool, b.threadId).stop();
          else if (b.kind === "subagent") await s.delegation.stopAll(b.userId);
          else if (b.kind === "sleep") await s.sleep.stop(b.userId);
        }
        return { wiped: false, busy };
      }
      const unlocked = s.users.all().map((u) => u.id).filter((id) => this.keyring.hasUserKey(id));
      for (const id of unlocked) {
        await this.stopWork(id);
        await s.host.close(id);
      }
      const n = wipePools(this.keyring, s.users);
      for (const id of unlocked) {
        try {
          this.finishWipe(id, true);
          s.wakeups.load(id);
          s.routines.load(id);
          s.forge.load(id);
        } catch (err) {
          this.log(`finishing a memory wipe failed: ${(err as Error).name}`);
        }
        this.userEvents.changed(id);
      }
      this.log(`wiped memory for ${n} users`);
      return { wiped: true, busy: [] };
    } finally {
      this.wipingNow = false;
      s.host.draining = this.drainingNow;
      if (!this.drainingNow) this.undrained();
    }
  }

  /**
   * The key-needing half of a wipe, when this user waits for one: their
   * user.db rows, then their thread folders once the home is mounted. Right
   * after the wipe (`now`) every folder goes; at a later unlock, as the
   * nightly sweep does, only the folders of threads that don't exist, so
   * threads made since keep theirs.
   */
  private finishWipe(userId: string, now = false): void {
    const s = this.services!;
    const self = this.keyring.self();
    if (wipePending(self, userId)) {
      const db = s.users.openUserDb(userId);
      try { finishWipe(self, userId, db); } finally { db.close(); }
    }
    if (!homeWipePending(self, userId) || !isMounted(s.workspace.homeDir(userId))) return;
    if (now) wipeHome(s, userId);
    else sweepUser(s, userId);
    homeWiped(self, userId);
  }

  /** The nightly sleep time, `HH:MM` local time (self.db `settings`). */
  sleepTime(): string {
    const row = this.keyring.self().prepare("SELECT value FROM settings WHERE key = 'sleep.time'").get() as { value: string } | undefined;
    return row?.value ?? "04:00";
  }

  private tick(): void {
    if (!this.services) return;
    this.push.tick();
    const now = new Date();
    if (!this.draining && !this.wipingNow) {
      this.services.children.drainWakes();
      this.services.wakeups.tick(now);
      this.services.routines.tick(now);
      this.services.forge.tick(now);
      if (now.getTime() - this.prunedAt >= 3600_000) {
        this.prunedAt = now.getTime();
        try {
          const n = this.services.sleep.prune(now);
          if (n) this.log(`sleep: ${n} old phase threads forgotten`);
        } catch (err) { this.log(`forgetting old sleep threads failed: ${(err as Error).name}`); }
      }
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` !== this.sleepTime() || this.sleptOn === now.toDateString()) return;
    this.sleptOn = now.toDateString();
    if (this.draining || this.wipingNow) { this.sleepDue = true; return; }
    this.night(now);
  }

  /** The night's work: model cleanup, the sweep, idle project threads, then sleep. */
  private night(now: Date): void {
    if (!this.services) return;
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

  // --- Updates (updates.ts) ---

  get draining(): boolean { return this.drainingNow; }
  set draining(on: boolean) {
    this.drainingNow = on;
    if (this.services) this.services.host.draining = on || this.wipingNow;
  }

  /** New turns from outside are refused while an update drains or a memory wipe runs. */
  refuseWhileDraining(): void {
    if (this.drainingNow) throw new Updating();
    if (this.wipingNow) throw new HttpError(409, "Lyrica is wiping memory");
  }

  /** Back from a drain that gave up: the sleep that came due meanwhile runs now. */
  undrained(): void {
    if (this.sleepDue && this.services) {
      this.sleepDue = false;
      this.night(new Date());
    }
  }

  /** What a drain waits for: turns (and messages waiting for a model), subagent runs and sleep runs. IDs only. */
  busy(): BusyItem[] {
    const s = this.services;
    if (!s) return [];
    return [
      ...s.host.working().map((t) => ({ kind: "turn" as const, ...t })),
      ...s.delegation.working().map((t) => ({ kind: "subagent" as const, ...t })),
      ...s.sleep.working().map((userId) => ({ kind: "sleep" as const, userId })),
    ];
  }

  /**
   * The checks probation waits for once unlocked: every open database
   * migrates and opens, the workspace self-test, the model router for each
   * user whose key is here, and the web UI's files. Check names and error
   * names only.
   */
  async health(): Promise<Health> {
    const commit = BUILD.build ?? "dev";
    const s = this.services;
    if (!s) return { commit, locked: true, checks: this.unlockError ? [{ name: "databases", ok: false, error: this.unlockError }] : [] };
    const checks: Health["checks"] = [];
    const check = (name: string, fn: () => void) => {
      try { fn(); checks.push({ name, ok: true }); } catch (err) { checks.push({ name, ok: false, error: `${(err as Error).name}: ${(err as Error).message.split("\n")[0]}` }); }
    };
    const keyed = s.users.all().filter((u) => this.keyring.hasUserKey(u.id));
    check("databases", () => {
      this.keyring.self().prepare("SELECT count(*) FROM users").get();
      for (const u of keyed) {
        s.users.openUserDb(u.id).close();
        s.memory.openOwnerView(u.id).close();
      }
    });
    check("workspace", () => { if (s.workspace.networkRefused) throw new Error(s.workspace.networkRefused); });
    check("models", () => {
      for (const u of keyed) {
        s.models.callContext(u.id, "general", "update-health");
        s.models.presets(u.id);
      }
    });
    check("web", () => { readFileSync(join(this.opts.webDir ?? DEFAULT_WEB, "index.html")); });
    return { commit, locked: false, checks };
  }

  state(cookie: string | undefined): State {
    if (this.settingUp) {
      const why = this.keyring.credentials ? this.keyring.credentials.unavailable() : "saving credentials isn't set up here";
      return { locked: true, setup: true, name: this.name(), users: [], credentials: why ? { available: false, reason: why } : { available: true } };
    }
    if (!this.services) return { locked: true, name: this.name(), users: [] };
    const ids = this.sessions.users(cookie) ?? new Set<string>();
    const users = [...ids].map((id) => this.services!.users.get(id)).filter((u): u is User => !!u && this.keyring.hasUserKey(u.id));
    return { locked: false, name: this.name(), users: users.map(card), ...BUILD };
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
    this.userEvents.close();
    this.mounted.clear();
    this.services = undefined;
    try { this.keyring.self().close(); } catch { /* already locked */ }
    const socket = this.socketPath;
    if (socket && existsSync(socket)) rmSync(socket, { force: true });
  }

  /**
   * The extra listener. For an external proxy: only the listed proxies may
   * connect, and only their X-Forwarded-For is believed; HTTPS with lyricad's
   * own certificate, or plain HTTP on a Tailscale address. Direct: anyone may
   * connect, over HTTPS, and the client's own address is its address.
   */
  private listenExternal(o: Bind): Promise<Listener> {
    const trust: TrustForwarded = o.direct ? () => false : (remote) => this.external.proxies().includes(plainAddress(remote));
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res, trust);
    const server: Listener = o.tls ? secureServer(o.tls, handler) : createServer(handler);
    if (!o.direct) server.on("connection", (socket) => { if (!trust(socket.remoteAddress ?? "")) socket.destroy(); });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(o.port, o.address, () => { server.off("error", reject); resolve(server); });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, trust: TrustForwarded = fromLoopback, via?: "tailnet"): Promise<void> {
    const started = performance.now();
    const method = req.method ?? "GET";
    let routeName = "(static)";
    res.once("close", () => this.log(`${method} ${routeName} ${res.statusCode} ${(performance.now() - started).toFixed(0)}ms`));
    try {
      const url = new URL(req.url ?? "/", "http://lyricad");
      const path = url.pathname;
      // The Forgejo/Gitea webhook answers only on her tailnet listener: a signed nudge to poll at once.
      if (method === "POST" && path.startsWith("/hooks/forge/")) {
        routeName = "/hooks/forge/:account";
        if (via !== "tailnet") throw new HttpError(404, "not found");
        sendJson(res, 200, await this.forgeHook(req, path));
        return;
      }
      if (!path.startsWith("/api/")) {
        if ((method === "GET" || method === "HEAD") && serveStatic(this.opts.webDir ?? DEFAULT_WEB, path, res)) return;
        throw new HttpError(404, "not found");
      }
      const found = match(this.routes, method, path);
      if (found === "method") throw new HttpError(405, "method not allowed");
      if (!found) throw new HttpError(404, "not found");
      routeName = found.route.pattern;
      // Setting up, only state and setup answer; locked, only state, unlock and setup (which says it's done).
      if (this.settingUp && routeName !== "/api/state" && routeName !== "/api/setup") throw new HttpError(503, "Lyrica isn't set up yet");
      const open = routeName === "/api/state" || routeName === "/api/unlock" || routeName === "/api/setup";
      if (!open && !this.services) throw new HttpError(503, "lyricad is locked");
      if (method !== "GET" && method !== "HEAD") checkOrigin(req);
      const r: Request = makeRequest(req, res, routeName, found.params, url, trust, via);
      const body = await found.route.handler(r);
      if (method !== "GET" && method !== "HEAD" && found.params.userId && res.statusCode >= 200 && res.statusCode < 300 && !UNLISTED.has(routeName)) this.userEvents.changed(found.params.userId);
      if (res.headersSent) return; // a stream, or a handler that answered itself
      sendJson(res, 200, body);
    } catch (err) {
      const status = err instanceof URIError ? 400 : statusOf(err);
      const message = status === 500 ? "internal error" : (err as Error).message;
      if (status === 500) this.log(`error in ${method} ${routeName}: ${(err as Error).name}: ${(err as Error).message.split("\n")[0]}`);
      // Offline says which models were tried, so the interface can show it the same way for chat, images and speech.
      const offline = err instanceof Offline ? { code: err.code, task: err.task, tried: err.tried } : {};
      const updating = err instanceof Updating ? { updating: true } : {};
      // A model host's refusal keeps its code: need_repo opens the Repository field, above_recommended asks Save anyway.
      const refused = err instanceof HostRefused && HOST_CODES.includes(err.code) ? { code: err.code } : {};
      if (!res.headersSent) sendJson(res, status, { error: message, ...refused, ...offline, ...updating }, err instanceof HttpError ? err.headers : {});
      else res.end();
    }
  }

  /**
   * The Forgejo/Gitea tailnet webhook (docs/briefs/ci-wakes.md step 4): a
   * signed nudge that makes the poller ask at once. One secret per Git
   * account; the signature says which account sent it. Nothing from the body
   * is kept or logged. During an update's drain it only answers, so no turn
   * starts.
   */
  private async forgeHook(req: IncomingMessage, path: string): Promise<{ ok: boolean }> {
    const accountName = decodeURIComponent(path.slice("/hooks/forge/".length));
    if (!accountName || accountName.includes("/")) throw new HttpError(404, "not found");
    const s = this.services;
    if (!s) throw new HttpError(503, "lyricad is locked");
    const body = await readBody(req, 256 * 1024);
    const got = req.headers["x-forgejo-signature"] ?? req.headers["x-gitea-signature"];
    if (typeof got !== "string") throw new HttpError(401, "unsigned");
    const matches: { userId: string; account: string }[] = [];
    for (const u of s.users.all()) {
      if (!this.keyring.hasUserKey(u.id)) continue;
      const a = s.workspace.settings(u.id).gitAccount(accountName);
      if (!a || (a.kind !== "forgejo" && a.kind !== "gitea") || !a.webhookSecret) continue;
      const want = createHmac("sha256", a.webhookSecret).update(body).digest("hex");
      const x = Buffer.from(want);
      const y = Buffer.from(got);
      if (x.length === y.length && timingSafeEqual(x, y)) matches.push({ userId: u.id, account: a.name });
    }
    if (!matches.length) throw new HttpError(401, "bad signature");
    let repo: string | undefined;
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { repository?: { full_name?: unknown } };
      if (typeof parsed.repository?.full_name === "string") repo = parsed.repository.full_name;
    } catch { /* not JSON: no nudge */ }
    if (!repo) throw new HttpError(400, "no repository");
    if (this.draining) return { ok: true };
    for (const m of matches) await s.forge.webhook(m.userId, m.account, repo);
    return { ok: true };
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

/** An error's first line, for the journal: an outside tool's full output stays out of it. */
const firstLine = (err: Error): string => err.message.split("\n")[0]!.slice(0, 300);
