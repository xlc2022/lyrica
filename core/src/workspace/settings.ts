import { realpathSync, statSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";

/** A folder a thread may touch. It is mounted at the same path inside the sandbox. */
export interface Grant {
  path: string;
  writable: boolean;
}

/** "ask-commands" asks before bash; "ask-changes" before bash, write and edit. */
export type PermissionMode = "auto" | "ask-changes" | "ask-commands";
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "ask-changes", "ask-commands"];

export interface ThreadWorkspace {
  grants: Grant[];
  /** Private threads only: overrides the user's default. General threads always have network. */
  network: boolean | null;
  mode: PermissionMode;
  /** "sandbox" or "ssh:<name>". */
  target: string;
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

/** Workspace tables. They live in the user's user.db; the pool databases belong to Memory. */
export const WORKSPACE_SCHEMA = `
-- Host folders an administrator lets this user grant, per pool.
CREATE TABLE IF NOT EXISTS workspace_paths (
  pool TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (pool, path)
);
-- What each thread was given: grants, network override, permission mode, target.
CREATE TABLE IF NOT EXISTS thread_workspaces (
  thread_id TEXT PRIMARY KEY,
  grants    TEXT NOT NULL,
  network   INTEGER,
  mode      TEXT NOT NULL,
  target    TEXT NOT NULL
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

const PRIVATE_NETWORK = "workspace.private_network";

/** `a` is `b` or lies inside it. */
export const within = (a: string, b: string): boolean => a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

/** An absolute, normalized path with no trailing slash. */
export function cleanPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error(`not an absolute path: ${path}`);
  const clean = posix.normalize(path);
  return clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
}

/**
 * Whether `pool` may take `grant`, given the user's allowed paths. Private
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

/** One user's workspace settings, in their user.db. */
export class WorkspaceSettings {
  /** `runtime` is LYRICA_HOME: no grant may overlap it. */
  constructor(private readonly db: Db, private readonly runtime: string) {
    db.exec(WORKSPACE_SCHEMA);
  }

  close(): void { this.db.close(); }

  allowed(): Record<Pool, string[]> {
    const rows = this.db.prepare("SELECT pool, path FROM workspace_paths ORDER BY path").all() as { pool: Pool; path: string }[];
    return { general: rows.filter((r) => r.pool === "general").map((r) => r.path), private: rows.filter((r) => r.pool === "private").map((r) => r.path) };
  }

  /** Lets the user grant `path` in `pool`. It must be a real directory, with no symlinks on the way. */
  allow(pool: Pool, path: string): void {
    path = cleanPath(path);
    if (!statSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
    if (realpathSync(path) !== path) throw new Error(`${path} goes through a symlink; use ${realpathSync(path)}`);
    if (overlaps(path, cleanPath(realpathSync(this.runtime)))) throw new Error(`${path} overlaps Lyrica's runtime directory`);
    const other = this.allowed()[pool === "general" ? "private" : "general"].find((p) => overlaps(path, p));
    if (other) throw new Error(`${path} overlaps ${other}, which is in the ${pool === "general" ? "private" : "general"} list`);
    this.db.prepare("INSERT OR IGNORE INTO workspace_paths (pool, path) VALUES (?, ?)").run(pool, path);
  }

  disallow(pool: Pool, path: string): void {
    const n = this.db.prepare("DELETE FROM workspace_paths WHERE pool = ? AND path = ?").run(pool, cleanPath(path)).changes;
    if (!n) throw new Error(`${path} is not in the ${pool} list`);
  }

  /** The user's default for private threads' internet access. Off unless turned on. */
  privateNetwork(): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(PRIVATE_NETWORK) as { value: string } | undefined;
    return row?.value === "on";
  }

  setPrivateNetwork(on: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(PRIVATE_NETWORK, on ? "on" : "off");
  }

  thread(threadId: string): ThreadWorkspace {
    const row = this.db.prepare("SELECT grants, network, mode, target FROM thread_workspaces WHERE thread_id = ?").get(threadId) as
      | { grants: string; network: number | null; mode: PermissionMode; target: string } | undefined;
    if (!row) return { grants: [], network: null, mode: "auto", target: "sandbox" };
    return { grants: JSON.parse(row.grants), network: row.network === null ? null : row.network === 1, mode: row.mode, target: row.target };
  }

  /** Changes a thread's workspace. Grants are checked against the allowed paths for `pool`. */
  setThread(threadId: string, pool: Pool, change: Partial<ThreadWorkspace>): ThreadWorkspace {
    const next = { ...this.thread(threadId), ...change };
    next.grants = next.grants.map((g) => ({ path: cleanPath(g.path), writable: g.writable }));
    const allowed = this.allowed();
    for (const g of next.grants) {
      checkGrant(allowed, pool, g);
      const outer = next.grants.find((o) => o !== g && within(g.path, o.path));
      if (outer) throw new Error(`${g.path} is inside ${outer.path}; grant one or the other`);
    }
    if (pool === "general" && next.network !== null) throw new Error("general threads always have network access");
    if (!PERMISSION_MODES.includes(next.mode)) throw new Error(`unknown permission mode: ${next.mode}`);
    if (next.target !== "sandbox" && !this.ssh(next.target.replace(/^ssh:/, ""))) throw new Error(`unknown target: ${next.target}`);
    this.db.prepare("INSERT OR REPLACE INTO thread_workspaces (thread_id, grants, network, mode, target) VALUES (?, ?, ?, ?, ?)")
      .run(threadId, JSON.stringify(next.grants), next.network === null ? null : next.network ? 1 : 0, next.mode, next.target);
    return next;
  }

  /** Whether this thread's tools may reach the network. */
  network(threadId: string, pool: Pool): boolean {
    if (pool === "general") return true;
    return this.thread(threadId).network ?? this.privateNetwork();
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

interface SshRow { name: string; host: string; port: number; username: string; private_key: string; root: string | null; host_key: string | null }
const toSsh = (r: SshRow): SshTargetConfig =>
  ({ name: r.name, host: r.host, port: r.port, username: r.username, privateKey: r.private_key, root: r.root, hostKey: r.host_key });
