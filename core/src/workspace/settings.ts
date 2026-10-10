import { isAbsolute, posix } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";
import { parseHost } from "./net.ts";

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
  /** "sandbox" or "ssh:<name>". */
  target: string;
  /** Set for a subagent's thread: its settings can only be the parent's or stricter. */
  parent: string | null;
}

export interface SshTargetConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  /** OpenSSH private key. Lives only in user.db and in memory. */
  privateKey: string;
  /** Optional remote folder that read, write and edit stay inside. */
  root: string | null;
  /** SHA-256 of the host key, recorded on first connection. */
  hostKey: string | null;
}

/** Workspace tables in the user's user.db. The pool databases belong to Memory. */
export const WORKSPACE_SCHEMA = `
-- What each thread was given: grants, network overrides, permission mode, switches,
-- target, and for a subagent the parent thread it can't be wider than.
CREATE TABLE IF NOT EXISTS thread_workspaces (
  thread_id  TEXT PRIMARY KEY,
  grants     TEXT NOT NULL,
  internet   INTEGER,
  services   INTEGER,
  hosts      TEXT,
  mode       TEXT NOT NULL,
  target     TEXT NOT NULL,
  parent     TEXT,
  web_search INTEGER NOT NULL DEFAULT 1,
  images     INTEGER NOT NULL DEFAULT 1
);
-- Remote machines she can work on, with the key she signs in with.
CREATE TABLE IF NOT EXISTS ssh_targets (
  name        TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  username    TEXT NOT NULL,
  private_key TEXT NOT NULL,
  root        TEXT,
  host_key    TEXT
);
`;

/** `a` is `b` or lies inside it. */
export const within = (a: string, b: string): boolean => a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

/** An absolute, normalized path with no trailing slash. */
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
  constructor(private readonly db: Db, readonly allowed: () => Record<Pool, string[]>) {
    db.exec(WORKSPACE_SCHEMA);
    migrate(db);
  }

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

  /** A new thread's settings: the default mode, everything else as the user's defaults say. */
  startThread(threadId: string, pool: Pool): ThreadWorkspace {
    return this.setThread(threadId, pool, { mode: this.defaultMode() });
  }

  thread(threadId: string): ThreadWorkspace {
    const row = this.db.prepare("SELECT * FROM thread_workspaces WHERE thread_id = ?").get(threadId) as ThreadRow | undefined;
    // A thread from before modes were saved for every new thread: Auto, as it had then. New threads get the default from startThread.
    if (!row) return { grants: [], internet: null, services: null, hosts: null, mode: "auto", webSearch: true, images: true, target: "sandbox", parent: null };
    const bool = (v: number | null) => (v === null ? null : v === 1);
    return {
      grants: JSON.parse(row.grants), internet: bool(row.internet), services: bool(row.services),
      hosts: row.hosts === null ? null : JSON.parse(row.hosts), mode: row.mode, webSearch: row.web_search === 1, images: row.images === 1,
      target: row.target, parent: row.parent,
    };
  }

  /**
   * What applies to the thread now: its own settings, with the strictest mode
   * and each switch off where any ancestor's is. A parent changed after its
   * subagent or child thread started narrows it at once.
   */
  effective(threadId: string): ThreadWorkspace {
    const t = this.thread(threadId);
    for (let id = t.parent, i = 0; id && i < 100; i++) {
      const up = this.thread(id);
      t.mode = stricterMode(t.mode, up.mode);
      t.webSearch &&= up.webSearch;
      t.images &&= up.images;
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
    next.grants = next.grants.map((g) => ({ path: cleanPath(g.path), writable: g.writable }));
    next.hosts = next.hosts?.map((h) => parseHost(h).entry) ?? null;
    const allowed = this.allowed();
    for (const g of next.grants) {
      checkGrant(allowed, pool, g);
      const outer = next.grants.find((o) => o !== g && within(g.path, o.path));
      if (outer) throw new Error(`${g.path} is inside ${outer.path}; grant one or the other`);
    }
    if (!PERMISSION_MODES.includes(next.mode)) throw new Error(`unknown permission mode: ${next.mode}`);
    if (next.target !== "sandbox" && !this.ssh(next.target.replace(/^ssh:/, ""))) throw new Error(`unknown target: ${next.target}`);
    if (next.parent) this.checkNarrower(next.parent, pool, next);
    this.write(threadId, next);
    return next;
  }

  private write(threadId: string, t: ThreadWorkspace): void {
    const int = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    this.db.prepare(`INSERT OR REPLACE INTO thread_workspaces (thread_id, grants, internet, services, hosts, mode, target, parent, web_search, images)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(threadId, JSON.stringify(t.grants), int(t.internet), int(t.services),
      t.hosts === null ? null : JSON.stringify(t.hosts), t.mode, t.target, t.parent, int(t.webSearch), int(t.images));
  }

  /**
   * Gives a subagent's thread its parent's folders, network, permission mode,
   * switches and target, or the stricter ones in `narrower`. It works in the
   * parent's folder. Anything wider than the parent's is refused.
   */
  inheritSettings(parentThreadId: string, childThreadId: string, pool: Pool,
    narrower: Partial<Pick<ThreadWorkspace, "grants" | "mode" | "webSearch" | "images">> & Partial<Network> = {}): ThreadWorkspace {
    const parent = this.effective(parentThreadId);
    const net = this.network(parentThreadId, pool);
    // Start from nothing, so a refused narrowing leaves the child with no access at all.
    this.write(childThreadId, {
      grants: [], internet: false, services: false, hosts: [], mode: "plan", webSearch: false, images: false, target: parent.target, parent: parentThreadId,
    });
    return this.setThread(childThreadId, pool, {
      grants: narrower.grants ?? parent.grants,
      internet: narrower.internet ?? net.internet,
      services: narrower.services ?? net.services,
      hosts: narrower.hosts ?? net.hosts,
      mode: narrower.mode ?? parent.mode,
      webSearch: narrower.webSearch ?? parent.webSearch,
      images: narrower.images ?? parent.images,
      target: parent.target,
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
      this.checkNarrower(t.parent, pool, t);
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
    if (mine.services && !theirs.services) throw new Error("the parent thread can't reach this machine's services");
    const extra = mine.hosts.find((h) => !theirs.hosts.includes(h));
    if (extra) throw new Error(`${extra} isn't in the parent thread's hosts`);
    if (MODE_RANK[child.mode] < MODE_RANK[parent.mode]) throw new Error(`the parent thread's permission mode is ${parent.mode}`);
    if (child.webSearch && !parent.webSearch) throw new Error("the parent thread has web search off");
    if (child.images && !parent.images) throw new Error("the parent thread has images off");
    if (child.target !== parent.target) throw new Error(`a subagent works where its parent does (${parent.target})`);
  }

  private resolve(t: ThreadWorkspace, pool: Pool): Network {
    const d = this.defaultNetwork(pool);
    return { internet: t.internet ?? d.internet, services: t.services ?? d.services, hosts: t.hosts ?? d.hosts };
  }

  /** What this thread's tools may reach. */
  network(threadId: string, pool: Pool): Network {
    return this.resolve(this.thread(threadId), pool);
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

  sshTargets(): SshTargetConfig[] {
    return (this.db.prepare("SELECT * FROM ssh_targets ORDER BY name").all() as SshRow[]).map(toSsh);
  }

  ssh(name: string): SshTargetConfig | undefined {
    const row = this.db.prepare("SELECT * FROM ssh_targets WHERE name = ?").get(name) as SshRow | undefined;
    return row && toSsh(row);
  }

  addSsh(t: Omit<SshTargetConfig, "hostKey">): void {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(t.name)) throw new Error("target names use letters, digits, '.', '_' and '-'");
    if (this.ssh(t.name)) throw new Error(`ssh target ${t.name} already exists`);
    this.db.prepare("INSERT INTO ssh_targets (name, host, port, username, private_key, root) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.name, t.host, t.port, t.username, t.privateKey, t.root === null ? null : cleanPath(t.root));
  }

  removeSsh(name: string): void {
    if (!this.db.prepare("DELETE FROM ssh_targets WHERE name = ?").run(name).changes) throw new Error(`no ssh target ${name}`);
  }

  recordHostKey(name: string, hostKey: string): void {
    this.db.prepare("UPDATE ssh_targets SET host_key = ? WHERE name = ? AND host_key IS NULL").run(hostKey, name);
  }
}

interface ThreadRow {
  grants: string; internet: number | null; services: number | null; hosts: string | null;
  mode: PermissionMode; target: string; parent: string | null; web_search: number; images: number;
}

/** Adds the switches to an older table, and renames the old modes in place. */
function migrate(db: Db): void {
  const columns = (db.prepare("SELECT name FROM pragma_table_info('thread_workspaces')").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["web_search", "images"]) if (!columns.includes(c)) db.exec(`ALTER TABLE thread_workspaces ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 1`);
  for (const [old, mode] of Object.entries(OLD_MODES)) db.prepare("UPDATE thread_workspaces SET mode = ? WHERE mode = ?").run(mode, old);
}
interface SshRow { name: string; host: string; port: number; username: string; private_key: string; root: string | null; host_key: string | null }
const toSsh = (r: SshRow): SshTargetConfig =>
  ({ name: r.name, host: r.host, port: r.port, username: r.username, privateKey: r.private_key, root: r.root, hostKey: r.host_key });
