import { isAbsolute, posix } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";
import { parseHost } from "./net.ts";
import { certFingerprint } from "./proxmox.ts";

/** A folder a thread may touch. It is mounted at the same path inside the sandbox. */
export interface Grant {
  path: string;
  writable: boolean;
}

/**
 * How much she may do: "auto" works freely inside the grants, "acceptEdits"
 * asks before bash, "ask" before bash, write and edit, and "plan" leaves only
 * the tools that read.
 */
export type PermissionMode = "auto" | "acceptEdits" | "ask" | "plan";
/** From the least strict to the most. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "acceptEdits", "ask", "plan"];
const MODE_RANK = Object.fromEntries(PERMISSION_MODES.map((m, i) => [m, i])) as Record<PermissionMode, number>;
/** The stricter of the two. */
export const stricterMode = (a: PermissionMode, b: PermissionMode): PermissionMode => (MODE_RANK[a] >= MODE_RANK[b] ? a : b);
/** The names modes had before Plan mode, and what they became. */
const OLD_MODES: Record<string, PermissionMode> = { "ask-changes": "ask", "ask-commands": "acceptEdits" };

/** What a thread's tools may reach on the network. */
export interface Network {
  /** Anything off this machine. */
  internet: boolean;
  /** This machine's loopback services. */
  services: boolean;
  /** Hosts reachable even with internet off: IPs, CIDR ranges or hostnames, each with an optional port. */
  hosts: string[];
}

export interface ThreadWorkspace {
  grants: Grant[];
  /** Overrides of the user's per-pool defaults; null follows the default. */
  internet: boolean | null;
  services: boolean | null;
  hosts: string[] | null;
  mode: PermissionMode;
  /** Switches: web_search and web_fetch, and the image tool. Off removes the tools from the session. */
  webSearch: boolean;
  images: boolean;
  /** The machines it may work on besides the sandbox, by name, from its pool's machines. */
  machines: string[];
  /** Set for a subagent's thread: its settings can only be the parent's or stricter. */
  parent: string | null;
}

/** The loosest mode she may use on a machine. */
export type MachineLimit = Exclude<PermissionMode, "plan">;
export const MACHINE_LIMITS: readonly MachineLimit[] = ["auto", "acceptEdits", "ask"];

/** How a machine is reached: SSH with a key, or Proxmox's API with a token. */
export type MachineKind = "ssh" | "proxmox";

/** A computer she works on over SSH with an account and key, or a Proxmox she manages over its API with a token. */
export interface MachineConfig {
  name: string;
  kind: MachineKind;
  host: string;
  port: number;
  /** The SSH account, or for Proxmox the token's id (`user@realm!tokenid`). */
  username: string;
  /** The OpenSSH private key, or for Proxmox the whole API token. Lives only in user.db and in memory. */
  privateKey: string;
  /** Optional remote folder that read, write and edit stay inside. Always null for Proxmox. */
  root: string | null;
  /**
   * SHA-256 of the host key Li confirmed (`SHA256:…`), or for Proxmox of its
   * TLS certificate (`AB:CD:…`). A machine from before confirming may have
   * none, and can't be reached until it does.
   */
  hostKey: string | null;
  /** Reached only from threads of this pool. */
  pool: Pool;
  limit: MachineLimit;
  /** Its address resolved outside the LAN, loopback and tailnet at the last check; for a private machine, Li confirmed that. */
  offNetwork: boolean;
  /** When she last connected (ISO time). */
  lastUsed: string | null;
  /** The last connection's outcome and when it began; null before the first one, or after its address or host key changed. */
  state: MachineState | null;
}

/** How the last connection to a machine went: it got in, couldn't reach it, or saw a host key other than the confirmed one. */
export interface MachineState { kind: "online" | "unreachable" | "keyChanged"; since: string }

/** What adding a machine takes: the rest starts empty. */
export type NewMachine = Omit<MachineConfig, "kind" | "hostKey" | "limit" | "lastUsed" | "state"> & { kind?: MachineKind; limit?: MachineLimit };

const MACHINE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
/** The confirmed key in the form kept for its kind, or a thrown error. */
function confirmedKey(kind: MachineKind, key: string): string {
  if (kind === "proxmox") return certFingerprint(key);
  if (!HOST_KEY.test(key)) throw new Error("confirm the machine's host key (SHA256:…) before adding it");
  return key;
}

/** Workspace tables in the user's user.db. The pool databases belong to Memory. */
export const WORKSPACE_SCHEMA = `
-- What each thread was given: grants, network overrides, permission mode, switches,
-- machines, the suspect commands allowed in it, and for a subagent the parent
-- thread it can't be wider than.
CREATE TABLE IF NOT EXISTS thread_workspaces (
  thread_id  TEXT PRIMARY KEY,
  grants     TEXT NOT NULL,
  internet   INTEGER,
  services   INTEGER,
  hosts      TEXT,
  mode       TEXT NOT NULL,
  parent     TEXT,
  web_search INTEGER NOT NULL DEFAULT 1,
  images     INTEGER NOT NULL DEFAULT 1,
  machines   TEXT NOT NULL DEFAULT '[]',
  allowed    TEXT NOT NULL DEFAULT '[]'
);
-- What the Files panel added or removed since her last turn in the thread: paths only, cleared when her turn takes them.
CREATE TABLE IF NOT EXISTS panel_files (
  thread_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  path      TEXT NOT NULL,
  at        TEXT NOT NULL
);
`;

/** Machines she can work on, with the key she signs in with. Older databases call it ssh_targets; migrate renames it. */
export const MACHINES_SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  name        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'ssh',
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  username    TEXT NOT NULL,
  private_key TEXT NOT NULL,
  root        TEXT,
  host_key    TEXT,
  pool        TEXT NOT NULL DEFAULT 'general',
  mode_limit  TEXT NOT NULL DEFAULT 'ask',
  off_network INTEGER NOT NULL DEFAULT 0,
  last_used   TEXT,
  state       TEXT,
  state_since TEXT
);
`;

/** `a` is `b` or lies inside it. */
export const within = (a: string, b: string): boolean => a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

/** An absolute, normalized path with no trailing slash. */
/** `grants` as far as `outer` allows: each inside one of its folders, and read-only where that one is. */
export function narrowGrants(grants: Grant[], outer: Grant[]): Grant[] {
  return grants.flatMap((g) => {
    const from = outer.find((o) => within(g.path, o.path));
    return from ? [{ path: g.path, writable: g.writable && from.writable }] : [];
  });
}

export function cleanPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error(`not an absolute path: ${path}`);
  const clean = posix.normalize(path);
  return clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
}

/**
 * Whether `pool` may take `grant`, given the user's allowed folders. Private
 * threads may also read general folders, but never write to them, the same
 * way private memory reads general memory. General threads never touch a
 * folder that overlaps a private one.
 */
export function checkGrant(allowed: Record<Pool, string[]>, pool: Pool, grant: Grant): void {
  const path = cleanPath(grant.path);
  const inPrivate = allowed.private.some((p) => within(path, p));
  const inGeneral = allowed.general.some((p) => within(path, p));
  if (pool === "general") {
    if (allowed.private.some((p) => overlaps(path, p))) throw new Error(`${path} overlaps a private folder`);
    if (!inGeneral) throw new Error(`${path} is not in this user's general folders`);
  } else if (!inPrivate) {
    if (!inGeneral) throw new Error(`${path} is not in this user's folders`);
    if (grant.writable) throw new Error(`${path} is a general folder; a private thread can only read it`);
  }
}

/** Defaults when the user hasn't set any: general has internet, private has nothing. */
const DEFAULTS: Record<Pool, Network> = {
  general: { internet: true, services: false, hosts: [] },
  private: { internet: false, services: false, hosts: [] },
};

/**
 * One user's workspace settings, in their user.db. The folders the user may
 * grant are an administrator's, in self.db; `allowed` reads them.
 */
export class WorkspaceSettings {
  constructor(private readonly db: Db, readonly allowed: () => Record<Pool, string[]>) {}

  close(): void { this.db.close(); }

  private setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  /** The user's network defaults for threads in `pool`. */
  defaultNetwork(pool: Pool): Network {
    const stored = this.setting(`workspace.network.${pool}`);
    return stored ? JSON.parse(stored) : DEFAULTS[pool];
  }

  setDefaultNetwork(pool: Pool, change: Partial<Network>): Network {
    const next = { ...this.defaultNetwork(pool), ...change };
    next.hosts = next.hosts.map((h) => parseHost(h).entry);
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`workspace.network.${pool}`, JSON.stringify(next));
    return next;
  }

  /** The mode new threads start in. */
  defaultMode(): PermissionMode {
    const stored = this.setting("workspace.mode") as PermissionMode | undefined;
    return stored && PERMISSION_MODES.includes(stored) ? stored : "auto";
  }

  setDefaultMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`unknown permission mode: ${mode}`);
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.mode', ?)").run(mode);
  }

  /**
   * Her GitHub token (a fine-grained token for her repository), kept in
   * user.db like a machine's key and never shown back. Workspace hands it to
   * a sandbox only where `forgeEnv` allows.
   */
  githubToken(): string | undefined { return this.setting("github.token"); }

  setGithubToken(token: string | null): void {
    if (token === null) {
      this.db.prepare("DELETE FROM settings WHERE key = 'github.token'").run();
      return;
    }
    token = token.trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error("that doesn't look like a GitHub token");
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('github.token', ?)").run(token);
  }

  /** A new thread's settings: the default mode, everything else as the user's defaults say. */
  startThread(threadId: string, pool: Pool): ThreadWorkspace {
    return this.setThread(threadId, pool, { mode: this.defaultMode() });
  }

  thread(threadId: string): ThreadWorkspace {
    const row = this.db.prepare("SELECT * FROM thread_workspaces WHERE thread_id = ?").get(threadId) as ThreadRow | undefined;
    // A thread from before modes were saved for every new thread: Auto, as it had then. New threads get the default from startThread.
    if (!row) return { grants: [], internet: null, services: null, hosts: null, mode: "auto", webSearch: true, images: true, machines: [], parent: null };
    const bool = (v: number | null) => (v === null ? null : v === 1);
    return {
      grants: JSON.parse(row.grants), internet: bool(row.internet), services: bool(row.services),
      hosts: row.hosts === null ? null : JSON.parse(row.hosts), mode: row.mode, webSearch: row.web_search === 1, images: row.images === 1,
      machines: JSON.parse(row.machines), parent: row.parent,
    };
  }

  /**
   * What applies to the thread now: its own settings, with the strictest mode,
   * each switch off where any ancestor's is, only the folders and machines
   * every ancestor grants, and a folder read-only where any ancestor has it
   * read-only. A parent changed after its subagent or child thread started
   * narrows it at once; a parent gaining something gives the child nothing.
   */
  effective(threadId: string): ThreadWorkspace {
    const t = this.thread(threadId);
    for (let id = t.parent, i = 0; id && i < 100; i++) {
      const up = this.thread(id);
      t.mode = stricterMode(t.mode, up.mode);
      t.webSearch &&= up.webSearch;
      t.images &&= up.images;
      t.grants = narrowGrants(t.grants, up.grants);
      t.machines = t.machines.filter((m) => up.machines.includes(m));
      id = up.parent;
    }
    return t;
  }

  /**
   * Changes a thread's workspace. Grants are checked against the allowed
   * folders for `pool`, and a subagent's settings against its parent's.
   */
  setThread(threadId: string, pool: Pool, change: Partial<Omit<ThreadWorkspace, "parent">>): ThreadWorkspace {
    const next = { ...this.thread(threadId), ...change };
    // Folders and machines a parent has since taken away go with any other change, rather than refusing it.
    if (next.parent && (change.grants === undefined || change.machines === undefined)) {
      const now = this.effective(threadId);
      if (change.grants === undefined) next.grants = now.grants;
      if (change.machines === undefined) next.machines = now.machines;
    }
    next.grants = next.grants.map((g) => ({ path: cleanPath(g.path), writable: g.writable }));
    next.hosts = next.hosts?.map((h) => parseHost(h).entry) ?? null;
    const allowed = this.allowed();
    for (const g of next.grants) {
      checkGrant(allowed, pool, g);
      const outer = next.grants.find((o) => o !== g && within(g.path, o.path));
      if (outer) throw new Error(`${g.path} is inside ${outer.path}; grant one or the other`);
    }
    if (!PERMISSION_MODES.includes(next.mode)) throw new Error(`unknown permission mode: ${next.mode}`);
    next.machines = [...new Set(next.machines)];
    for (const name of next.machines) {
      const m = this.machine(name);
      if (!m) throw new Error(`no machine ${name}`);
      if (m.pool !== pool) throw new Error(`${name} is a ${m.pool} machine; a ${pool} thread can't use it`);
    }
    if (next.parent) this.checkNarrower(next.parent, pool, next);
    this.write(threadId, next);
    this.narrowChildren(threadId);
    return next;
  }

  /**
   * Writes what `effective` already applies into the rows of the thread's
   * subagents and child threads, so a folder or machine taken away stays
   * away: the parent getting it back later gives them nothing.
   */
  private narrowChildren(threadId: string, depth = 0): void {
    if (depth > 100) return;
    const rows = this.db.prepare("SELECT thread_id FROM thread_workspaces WHERE parent = ?").all(threadId) as { thread_id: string }[];
    for (const { thread_id: id } of rows) {
      const own = this.thread(id);
      const now = this.effective(id);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      if (!same(own.grants, now.grants) || !same(own.machines, now.machines)) this.write(id, { ...own, grants: now.grants, machines: now.machines });
      this.narrowChildren(id, depth + 1);
    }
  }

  private write(threadId: string, t: ThreadWorkspace): void {
    const int = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    // The upsert keeps the thread's allowed commands.
    this.db.prepare(`INSERT INTO thread_workspaces (thread_id, grants, internet, services, hosts, mode, parent, web_search, images, machines)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET grants = excluded.grants, internet = excluded.internet,
      services = excluded.services, hosts = excluded.hosts, mode = excluded.mode, parent = excluded.parent, web_search = excluded.web_search,
      images = excluded.images, machines = excluded.machines`).run(threadId, JSON.stringify(t.grants), int(t.internet), int(t.services),
      t.hosts === null ? null : JSON.stringify(t.hosts), t.mode, t.parent, int(t.webSearch), int(t.images), JSON.stringify(t.machines));
  }

  /**
   * Gives a subagent's thread its parent's folders, network, permission mode,
   * switches and machines, or the stricter ones in `narrower`. It works in the
   * parent's folder. Anything wider than the parent's is refused.
   */
  inheritSettings(parentThreadId: string, childThreadId: string, pool: Pool,
    narrower: Partial<Pick<ThreadWorkspace, "grants" | "mode" | "webSearch" | "images" | "machines">> & Partial<Network> = {}): ThreadWorkspace {
    const parent = this.effective(parentThreadId);
    const net = this.network(parentThreadId, pool);
    // Start from nothing, so a refused narrowing leaves the child with no access at all.
    this.write(childThreadId, {
      grants: [], internet: false, services: false, hosts: [], mode: "plan", webSearch: false, images: false, machines: [], parent: parentThreadId,
    });
    return this.setThread(childThreadId, pool, {
      grants: narrower.grants ?? parent.grants,
      internet: narrower.internet ?? net.internet,
      services: narrower.services ?? net.services,
      hosts: narrower.hosts ?? net.hosts,
      mode: narrower.mode ?? parent.mode,
      webSearch: narrower.webSearch ?? parent.webSearch,
      images: narrower.images ?? parent.images,
      machines: narrower.machines ?? parent.machines,
    });
  }

  /** A daughter kept when its parent is forgotten: its settings stay as they are, now its own. */
  detach(threadId: string): void {
    this.db.prepare("UPDATE thread_workspaces SET parent = NULL WHERE thread_id = ?").run(threadId);
  }

  /** Throws if a subagent's thread is now wider than its parent's, say because the parent was narrowed. */
  checkInherited(threadId: string, pool: Pool): void {
    const t = this.thread(threadId);
    if (t.parent) {
      this.checkInherited(t.parent, pool);
      // Folders and machines a parent dropped later are dropped from the child by `effective`, not refused.
      this.checkNarrower(t.parent, pool, { ...t, grants: [], machines: [] });
    }
  }

  private checkNarrower(parentThreadId: string, pool: Pool, child: ThreadWorkspace): void {
    const parent = this.effective(parentThreadId);
    for (const g of child.grants) {
      const from = parent.grants.find((p) => within(g.path, p.path));
      if (!from) throw new Error(`${g.path} isn't in the parent thread's folders`);
      if (g.writable && !from.writable) throw new Error(`${g.path} is read-only in the parent thread`);
    }
    const mine = this.resolve(child, pool);
    const theirs = this.network(parentThreadId, pool);
    if (mine.internet && !theirs.internet) throw new Error("the parent thread has no internet");
    if (mine.services && !theirs.services) throw new Error("the parent thread can't reach local services");
    const extra = mine.hosts.find((h) => !theirs.hosts.includes(h));
    if (extra) throw new Error(`${extra} isn't in the parent thread's hosts`);
    if (MODE_RANK[child.mode] < MODE_RANK[parent.mode]) throw new Error(`the parent thread's permission mode is ${parent.mode}`);
    if (child.webSearch && !parent.webSearch) throw new Error("the parent thread has web search off");
    if (child.images && !parent.images) throw new Error("the parent thread has images off");
    const machine = child.machines.find((m) => !parent.machines.includes(m));
    if (machine) throw new Error(`${machine} isn't in the parent thread's machines`);
  }

  private resolve(t: ThreadWorkspace, pool: Pool): Network {
    const d = this.defaultNetwork(pool);
    return { internet: t.internet ?? d.internet, services: t.services ?? d.services, hosts: t.hosts ?? d.hosts };
  }

  /** What this thread's tools may reach. */
  network(threadId: string, pool: Pool): Network {
    return this.resolve(this.thread(threadId), pool);
  }

  /** Records what the Files panel added or removed, for her next turn. */
  noteFiles(threadId: string, kind: "added" | "removed", paths: string[]): void {
    const at = new Date().toISOString();
    const insert = this.db.prepare("INSERT INTO panel_files (thread_id, kind, path, at) VALUES (?, ?, ?, ?)");
    for (const path of paths) insert.run(threadId, kind, path, at);
  }

  /** The panel's notes since her last turn, oldest first, cleared as they're taken. */
  takeFileNotes(threadId: string): { added: string[]; removed: string[] } {
    const rows = this.db.prepare("SELECT kind, path FROM panel_files WHERE thread_id = ? ORDER BY rowid").all(threadId) as { kind: string; path: string }[];
    if (rows.length) this.db.prepare("DELETE FROM panel_files WHERE thread_id = ?").run(threadId);
    return { added: rows.filter((r) => r.kind === "added").map((r) => r.path), removed: rows.filter((r) => r.kind === "removed").map((r) => r.path) };
  }

  /** The thread whose folder in the home workspace this one works in: itself, or its first ancestor. */
  folderThread(threadId: string): string {
    for (let id = threadId, i = 0; i < 100; i++) {
      const parent = this.thread(id).parent;
      if (!parent) return id;
      id = parent;
    }
    throw new Error(`thread ${threadId} has too many ancestors`);
  }

  machines(): MachineConfig[] {
    return (this.db.prepare("SELECT * FROM machines ORDER BY name").all() as MachineRow[]).map(toMachine);
  }

  machine(name: string): MachineConfig | undefined {
    const row = this.db.prepare("SELECT * FROM machines WHERE name = ?").get(name) as MachineRow | undefined;
    return row && toMachine(row);
  }

  private need(name: string): MachineConfig {
    const m = this.machine(name);
    if (!m) throw new Error(`no machine ${name}`);
    return m;
  }

  /** Adds a machine with the host key (or Proxmox certificate) Li confirmed. New machines start at Ask. */
  addMachine(m: NewMachine, confirmedHostKey: string): MachineConfig {
    if (!MACHINE_NAME.test(m.name)) throw new Error("machine names use letters, digits, '.', '_' and '-'");
    if (this.machine(m.name)) throw new Error(`machine ${m.name} already exists`);
    const kind = m.kind ?? "ssh";
    if (kind !== "ssh" && kind !== "proxmox") throw new Error(`unknown machine kind: ${String(kind)}`);
    const hostKey = confirmedKey(kind, confirmedHostKey);
    if (m.pool !== "general" && m.pool !== "private") throw new Error("a machine is general or private");
    const limit = m.limit ?? "ask";
    if (!MACHINE_LIMITS.includes(limit)) throw new Error(`unknown mode limit: ${limit}`);
    this.db.prepare(`INSERT INTO machines (name, kind, host, port, username, private_key, root, host_key, pool, mode_limit, off_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.name, kind, m.host, m.port, m.username, m.privateKey,
      m.root === null || kind === "proxmox" ? null : cleanPath(m.root), hostKey, m.pool, limit, m.offNetwork ? 1 : 0);
    return this.need(m.name);
  }

  /** Removes the machine and every thread's grant of it. */
  removeMachine(name: string): void {
    if (!this.db.prepare("DELETE FROM machines WHERE name = ?").run(name).changes) throw new Error(`no machine ${name}`);
    this.dropGrants(name);
  }

  /**
   * Changes a machine's address, root or limit. A new address keeps the
   * confirmed host key: a different machine there fails until its key is
   * confirmed with `setHostKey`.
   */
  updateMachine(name: string, change: Partial<Pick<MachineConfig, "host" | "port" | "username" | "root" | "limit">>): MachineConfig {
    const next = { ...this.need(name), ...change };
    if (next.kind === "proxmox") next.root = null;
    if (!MACHINE_LIMITS.includes(next.limit)) throw new Error(`unknown mode limit: ${next.limit}`);
    if (!next.host || !Number.isInteger(next.port) || next.port < 1 || next.port > 65535 || !next.username) throw new Error("the address looks like account@host or account@host:port");
    this.db.prepare("UPDATE machines SET host = ?, port = ?, username = ?, root = ?, mode_limit = ? WHERE name = ?")
      .run(next.host, next.port, next.username, next.root === null ? null : cleanPath(next.root), next.limit, name);
    return this.need(name);
  }

  /** Moves a machine to the other pool, taking it from every thread that grants it, so it is never reached from both. */
  setMachinePool(name: string, pool: Pool): MachineConfig {
    const m = this.need(name);
    if (pool !== "general" && pool !== "private") throw new Error("a machine is general or private");
    if (m.pool === pool) return m;
    this.db.prepare("UPDATE machines SET pool = ? WHERE name = ?").run(pool, name);
    this.dropGrants(name);
    return this.need(name);
  }

  /** Re-pairs a machine: the host key (or Proxmox certificate) Li confirmed replaces the old one. */
  setHostKey(name: string, confirmedHostKey: string): MachineConfig {
    const key = confirmedKey(this.need(name).kind, confirmedHostKey);
    this.db.prepare("UPDATE machines SET host_key = ?, state = NULL, state_since = NULL WHERE name = ?").run(key, name);
    return this.need(name);
  }

  /** A Proxmox machine's new token, with its id. */
  setToken(name: string, token: string, id: string): MachineConfig {
    if (this.need(name).kind !== "proxmox") throw new Error(`${name} isn't a Proxmox machine`);
    this.db.prepare("UPDATE machines SET private_key = ?, username = ? WHERE name = ?").run(token, id, name);
    return this.need(name);
  }

  /** Records whether the address resolved outside Li's network at the last check. */
  setOffNetwork(name: string, off: boolean): void {
    this.db.prepare("UPDATE machines SET off_network = ? WHERE name = ?").run(off ? 1 : 0, name);
  }

  /** Li accepted that a private machine is off network: it can be reached again. */
  confirmOffNetwork(name: string): MachineConfig {
    this.need(name);
    this.setOffNetwork(name, true);
    return this.need(name);
  }

  usedMachine(name: string): void {
    this.db.prepare("UPDATE machines SET last_used = ? WHERE name = ?").run(new Date().toISOString(), name);
  }

  /** Records a connection's outcome; `since` moves only when the outcome changes. */
  machineState(name: string, kind: MachineState["kind"] | null): void {
    this.db.prepare("UPDATE machines SET state = ?, state_since = ? WHERE name = ? AND state IS NOT ?")
      .run(kind, kind && new Date().toISOString(), name, kind);
  }

  private dropGrants(name: string): void {
    for (const row of this.db.prepare("SELECT thread_id, machines, allowed FROM thread_workspaces").all() as { thread_id: string; machines: string; allowed: string }[]) {
      const machines = (JSON.parse(row.machines) as string[]).filter((m) => m !== name);
      const allowed = (JSON.parse(row.allowed) as AllowedCommand[]).filter((a) => a.machine !== name);
      this.db.prepare("UPDATE thread_workspaces SET machines = ?, allowed = ? WHERE thread_id = ?").run(JSON.stringify(machines), JSON.stringify(allowed), row.thread_id);
    }
  }

  /** A suspect command Li allowed in this thread: that exact command on that machine stops asking here, and only here. */
  allowInThread(threadId: string, machine: string, command: string): void {
    if (!this.db.prepare("SELECT 1 FROM thread_workspaces WHERE thread_id = ?").get(threadId)) this.write(threadId, this.thread(threadId));
    const allowed = this.allowedInThread(threadId);
    if (allowed.some((a) => a.machine === machine && a.command === command)) return;
    this.db.prepare("UPDATE thread_workspaces SET allowed = ? WHERE thread_id = ?").run(JSON.stringify([...allowed, { machine, command }]), threadId);
  }

  allowedInThread(threadId: string): AllowedCommand[] {
    const row = this.db.prepare("SELECT allowed FROM thread_workspaces WHERE thread_id = ?").get(threadId) as { allowed: string } | undefined;
    return row ? JSON.parse(row.allowed) : [];
  }
}

export interface AllowedCommand { machine: string; command: string }

interface ThreadRow {
  grants: string; internet: number | null; services: number | null; hosts: string | null;
  mode: PermissionMode; parent: string | null; web_search: number; images: number; machines: string;
}

const columnsOf = (db: Db, table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

/**
 * Brings an older user.db's workspace tables up to date in place, before
 * WORKSPACE_SCHEMA: the switches, the old mode names, SSH targets as general
 * machines at Ask, and a thread's target as its one machine. Run by the
 * user.db migration (migrations.ts), inside its transaction.
 */
export function upgradeWorkspace(db: Db): void {
  const columns = columnsOf(db, "thread_workspaces");
  if (!columns.length) return;
  for (const c of ["web_search", "images"]) if (!columns.includes(c)) db.exec(`ALTER TABLE thread_workspaces ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 1`);
  for (const [old, mode] of Object.entries(OLD_MODES)) db.prepare("UPDATE thread_workspaces SET mode = ? WHERE mode = ?").run(mode, old);
  if (columnsOf(db, "ssh_targets").length) {
    db.exec(`ALTER TABLE ssh_targets RENAME TO machines;
      ALTER TABLE machines ADD COLUMN kind TEXT NOT NULL DEFAULT 'ssh';
      ALTER TABLE machines ADD COLUMN pool TEXT NOT NULL DEFAULT 'general';
      ALTER TABLE machines ADD COLUMN mode_limit TEXT NOT NULL DEFAULT 'ask';
      ALTER TABLE machines ADD COLUMN off_network INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE machines ADD COLUMN last_used TEXT;`);
  }
  const machineColumns = columnsOf(db, "machines");
  if (machineColumns.length && !machineColumns.includes("state")) {
    db.exec("ALTER TABLE machines ADD COLUMN state TEXT; ALTER TABLE machines ADD COLUMN state_since TEXT;");
  }
  if (columns.includes("target")) {
    db.exec(`ALTER TABLE thread_workspaces ADD COLUMN machines TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE thread_workspaces ADD COLUMN allowed TEXT NOT NULL DEFAULT '[]';
      UPDATE thread_workspaces SET machines = json_array(substr(target, 5)) WHERE target LIKE 'ssh:%';
      ALTER TABLE thread_workspaces DROP COLUMN target;`);
  }
}

interface MachineRow {
  name: string; kind: MachineKind; host: string; port: number; username: string; private_key: string; root: string | null; host_key: string | null;
  pool: Pool; mode_limit: MachineLimit; off_network: number; last_used: string | null; state: MachineState["kind"] | null; state_since: string | null;
}
const toMachine = (r: MachineRow): MachineConfig => ({
  name: r.name, kind: r.kind, host: r.host, port: r.port, username: r.username, privateKey: r.private_key, root: r.root, hostKey: r.host_key,
  pool: r.pool, limit: r.mode_limit, offNetwork: r.off_network === 1, lastUsed: r.last_used,
  state: r.state && r.state_since ? { kind: r.state, since: r.state_since } : null,
});
