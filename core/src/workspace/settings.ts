import { isAbsolute, posix } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";
import { parseHost } from "./net.ts";

/** A folder a thread may touch. It is mounted at the same path inside the sandbox. */
export interface Grant {
  path: string;
  writable: boolean;
}

/** "ask-commands" asks before bash; "ask-changes" before bash, write and edit. */
export type PermissionMode = "auto" | "ask-changes" | "ask-commands";
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "ask-changes", "ask-commands"];
const MODE_RANK: Record<PermissionMode, number> = { auto: 0, "ask-commands": 1, "ask-changes": 2 };

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
-- What each thread was given: grants, network overrides, permission mode, target,
-- and for a subagent the parent thread it can't be wider than.
CREATE TABLE IF NOT EXISTS thread_workspaces (
  thread_id TEXT PRIMARY KEY,
  grants    TEXT NOT NULL,
  internet  INTEGER,
  services  INTEGER,
  hosts     TEXT,
  mode      TEXT NOT NULL,
  target    TEXT NOT NULL,
  parent    TEXT
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

  thread(threadId: string): ThreadWorkspace {
    const row = this.db.prepare("SELECT * FROM thread_workspaces WHERE thread_id = ?").get(threadId) as ThreadRow | undefined;
    if (!row) return { grants: [], internet: null, services: null, hosts: null, mode: "auto", target: "sandbox", parent: null };
    const bool = (v: number | null) => (v === null ? null : v === 1);
    return {
      grants: JSON.parse(row.grants), internet: bool(row.internet), services: bool(row.services),
      hosts: row.hosts === null ? null : JSON.parse(row.hosts), mode: row.mode, target: row.target, parent: row.parent,
    };
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
    this.db.prepare(`INSERT OR REPLACE INTO thread_workspaces (thread_id, grants, internet, services, hosts, mode, target, parent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(threadId, JSON.stringify(t.grants), int(t.internet), int(t.services),
      t.hosts === null ? null : JSON.stringify(t.hosts), t.mode, t.target, t.parent);
  }

  /**
   * Gives a subagent's thread its parent's folders, network, permission mode
   * and target, or the stricter ones in `narrower`. It works in the parent's
   * folder. Anything wider than the parent's is refused.
   */
  inheritSettings(parentThreadId: string, childThreadId: string, pool: Pool,
    narrower: Partial<Pick<ThreadWorkspace, "grants" | "mode">> & Partial<Network> = {}): ThreadWorkspace {
    const parent = this.thread(parentThreadId);
    const net = this.network(parentThreadId, pool);
    // Start from nothing, so a refused narrowing leaves the child with no access at all.
    this.write(childThreadId, { grants: [], internet: false, services: false, hosts: [], mode: "ask-changes", target: parent.target, parent: parentThreadId });
    return this.setThread(childThreadId, pool, {
      grants: narrower.grants ?? parent.grants,
      internet: narrower.internet ?? net.internet,
      services: narrower.services ?? net.services,
      hosts: narrower.hosts ?? net.hosts,
      mode: narrower.mode ?? parent.mode,
      target: parent.target,
    });
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
    const parent = this.thread(parentThreadId);
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
  mode: PermissionMode; target: string; parent: string | null;
}
interface SshRow { name: string; host: string; port: number; username: string; private_key: string; root: string | null; host_key: string | null }
const toSsh = (r: SshRow): SshTargetConfig =>
  ({ name: r.name, host: r.host, port: r.port, username: r.username, privateKey: r.private_key, root: r.root, hostKey: r.host_key });
