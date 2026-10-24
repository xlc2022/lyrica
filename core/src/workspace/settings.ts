import type { Worktree } from "./worktree.ts";
import { randomBytes } from "node:crypto";
import { commandRules as checkCommandRules, type CommandRule } from "./rules.ts";
import { isAbsolute, posix } from "node:path";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";
import { parseHost } from "./net.ts";
import { MCP_NAME, mcpNamespace, mcpUrl, type McpStateKind } from "./mcp.ts";
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

export interface ThreadWork {
  base?: boolean;
  worktrees: Worktree[];
  reason?: string;
  cleaned?: boolean;
}

export interface ThreadWorkspace {
  /** Internal project-thread placement, stored in encrypted settings, never accepted from a settings request. */
  threadWork?: ThreadWork;
  grants: Grant[];
  /** Overrides of the user's per-pool defaults; null follows the default. */
  internet: boolean | null;
  services: boolean | null;
  hosts: string[] | null;
  mode: PermissionMode;
  /** Switches: web_search and web_fetch, and the image tool. Off removes the tools from the session. */
  webSearch: boolean;
  images: boolean;
  /** Claude Code on the user's Claude plan in its sandbox runs (docs/workspace.md, "Claude Code"). Off by default; never in a private thread. */
  claudeCode: boolean;
  /** Coding preference: copied at creation, editable independently of ancestors. */
  code: boolean;
  /** The machines it may work on besides the sandbox, by name, from its pool's machines. */
  machines: string[];
  /** The repositories it clones, each with the Git account of its pool that reaches it. */
  repositories: ThreadRepository[];
  /** The MCP servers it may use, by name, from its pool's servers. */
  mcpServers: string[];
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
  /** SSH only: `username` is the user's own account, not one made for her (docs/workspace.md, "Your own account"). */
  asUser: boolean;
  /**
   * SHA-256 of the host key the user confirmed (`SHA256:…`), or for Proxmox of its
   * TLS certificate (`AB:CD:…`). A machine from before confirming may have
   * none, and can't be reached until it does.
   */
  hostKey: string | null;
  /** Reached only from threads of this pool. */
  pool: Pool;
  limit: MachineLimit;
  /** Its address resolved outside the LAN, loopback and tailnet at the last check; for a private machine, the user confirmed that. */
  offNetwork: boolean;
  /** When she last connected (ISO time). */
  lastUsed: string | null;
  /** The last connection's outcome and when it began; null before the first one, or after its address or host key changed. */
  state: MachineState | null;
}

/** How the last connection to a machine went: it got in, couldn't reach it, or saw a host key other than the confirmed one. */
export interface MachineState { kind: "online" | "unreachable" | "keyChanged"; since: string }

/** A repository a thread clones: `owner/name` on its account's host (a path with more parts on some hosts), and the account's name. */
export interface ThreadRepository { name: string; account: string }

/** What a Git account's host runs: its API and command-line client follow (`gh` for GitHub, `tea` for Gitea and Forgejo, plain git for Other). */
export type GitKind = "github" | "forgejo" | "gitea" | "other";
export const GIT_KINDS: readonly GitKind[] = ["github", "forgejo", "gitea", "other"];

/** A token for one account on one Git host, reached over HTTPS. */
export interface GitAccountConfig {
  name: string;
  kind: GitKind;
  /** host or host:port, lowercase. */
  host: string;
  /** The account's name on the host. */
  account: string;
  /** Lives only in user.db and in memory, and reaches only a sandbox run's relay, through `Workspace.credentialsFor`. */
  token: string;
  /** Used only by threads of this pool. A GitHub account is always general. */
  pool: Pool;
  /** The host resolved outside the LAN, loopback and tailnet at the last check; for a private account, the user confirmed that. */
  offNetwork: boolean;
  /** How the last use went, and since when; null before the first, or after its host, account or token changed. */
  state: GitAccountState | null;
  /** The random secret the host signs webhooks with, for Forgejo/Gitea; null for GitHub and Other (docs/briefs/ci-wakes.md). */
  webhookSecret: string | null;
}

export interface GitAccountState { kind: "signedIn" | "rejected" | "unreachable"; since: string }

export type NewGitAccount = Omit<GitAccountConfig, "state" | "webhookSecret">;

/** An MCP server she can use: a URL (streamable HTTP) and an optional token, in one pool. */
export interface McpServerConfig {
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer`. Lives only in user.db and in memory; empty for none. */
  token: string;
  /** Used only by threads of this pool. A private one must be on her own network. */
  pool: Pool;
  /** The line Pi lists it with: the first line of its instructions, or its title, from the last check. */
  description: string | null;
  /** How many tools it offered at the last check. */
  tools: number;
  /** Its host resolved outside the LAN, loopback and tailnet at the last check; for a private server, the user confirmed that. */
  offNetwork: boolean;
  /** How the last connection went, and since when; null before the first, or after its URL changed. */
  state: McpServerState | null;
}

export interface McpServerState { kind: McpStateKind; since: string }

export type NewMcpServer = Omit<McpServerConfig, "state">;

const GIT_ACCOUNT = /^[A-Za-z0-9._-]{1,100}$/;
const REPO_PART = /^[A-Za-z0-9_.-]+$/;

/** host or host:port as stored: a scheme and trailing slash are dropped. */
export function gitHost(raw: string): string {
  const s = raw.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "");
  if (!s || /[/@\s]/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error("the host looks like git.example.com or git.lan:3000");
  const h = parseHost(s);
  if (h.host.includes("/")) throw new Error("the host looks like git.example.com or git.lan:3000");
  return h.entry;
}

/** A repository's name as kept: `owner/name`, without `.git`. */
export function repositoryName(raw: string): string {
  const name = raw.trim().replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = name.split("/");
  if (parts.length < 2 || parts.some((p) => !REPO_PART.test(p) || p === "." || p === "..")) throw new Error(`${raw} doesn't look like owner/name`);
  return name;
}

/** The folder a repository is cloned into, under the thread's repos/: its last part. */
export const repositoryDir = (name: string): string => name.split("/").at(-1)!;

/** What adding a machine takes: the rest starts empty. */
export type NewMachine = Omit<MachineConfig, "kind" | "hostKey" | "limit" | "lastUsed" | "state" | "asUser"> & { kind?: MachineKind; limit?: MachineLimit; asUser?: boolean };

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

/**
 * Which thread last wrote each file in a thread's folder (DESIGN, "Files and images"): `folder` is the id of the
 * thread whose folder holds it (its name under threads/), `path` the file's path inside that folder. Paths and ids
 * only, never content. Rows go with the file (the panel's Delete and Rename, a listing that no longer has it) and
 * with the thread or the folder.
 */
export const ORIGINS_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_origins (
  folder TEXT NOT NULL,
  path   TEXT NOT NULL,
  thread TEXT NOT NULL,
  at     TEXT NOT NULL,
  PRIMARY KEY (folder, path)
);
CREATE INDEX IF NOT EXISTS file_origins_thread ON file_origins (thread);
`;

/** Everything under `path`, as a LIKE pattern (with ESCAPE '\\'). */
const under = (path: string) => `${path.replace(/[\\%_]/g, "\\$&")}/%`;

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
  state_since TEXT,
  as_user     INTEGER NOT NULL DEFAULT 0
);
`;

/** `a` is `b` or lies inside it. */
export const within = (a: string, b: string): boolean => a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

/** An absolute, normalized path with no trailing slash. */
/** `grants` as far as `outer` allows: each inside one of its folders, and read-only where that one is. */
export function narrowGrants(grants: Grant[], outer: Grant[]): Grant[] {
  return grants.flatMap((g) => {
    const from = [...outer].sort((a, b) => b.path.length - a.path.length).find((o) => within(g.path, o.path));
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

export const MAX_CHECKS = 8;
export const MAX_CHECK_LENGTH = 300;

/** At most 8 commands, each one line of at most 300 characters with no control characters; empty ones dropped. */
export function checkChecks(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("checks must be a list of commands");
  const checks = value.map((c) => {
    if (typeof c !== "string") throw new Error("a check is a command");
    return c.trim();
  }).filter(Boolean);
  // eslint-disable-next-line no-control-regex
  if (checks.some((c) => c.length > MAX_CHECK_LENGTH || /[\x00-\x1f\x7f]/.test(c))) throw new Error(`A check is one line of at most ${MAX_CHECK_LENGTH} characters, with no control characters.`);
  if (checks.length > MAX_CHECKS) throw new Error(`A project has at most ${MAX_CHECKS} checks.`);
  return checks;
}

/** Defaults when the user hasn't set any: general has internet, private has nothing. */
const DEFAULTS: Record<Pool, Network> = {
  general: { internet: true, services: false, hosts: [] },
  private: { internet: false, services: false, hosts: [] },
};

export type PhotoCloudPolicy = "never" | "ask" | "always";

/**
 * One user's workspace settings, in their user.db. The folders the user may
 * grant are an administrator's, in self.db; `allowed` reads them.
 */
export class WorkspaceSettings {
  commandRules(pool: Pool, project: string): CommandRule[] {
    const row = this.db.prepare("SELECT command_rules FROM project_settings WHERE pool = ? AND thread = ?").get(pool, project) as { command_rules: string } | undefined;
    return row ? JSON.parse(row.command_rules) : [];
  }

  setCommandRules(pool: Pool, project: string, rules: unknown): CommandRule[] {
    const checked = checkCommandRules(rules);
    this.db.prepare("INSERT INTO project_settings (pool, thread, command_rules) VALUES (?, ?, ?) ON CONFLICT(pool, thread) DO UPDATE SET command_rules = excluded.command_rules").run(pool, project, JSON.stringify(checked));
    return checked;
  }

  /** The person's commands that run when a code turn in the project ends (docs/workspace.md, "Project checks"). */
  checks(pool: Pool, project: string): string[] {
    const row = this.db.prepare("SELECT checks FROM project_settings WHERE pool = ? AND thread = ?").get(pool, project) as { checks: string } | undefined;
    return row ? JSON.parse(row.checks) : [];
  }

  setChecks(pool: Pool, project: string, checks: unknown): string[] {
    const checked = checkChecks(checks);
    this.db.prepare("INSERT INTO project_settings (pool, thread, checks) VALUES (?, ?, ?) ON CONFLICT(pool, thread) DO UPDATE SET checks = excluded.checks").run(pool, project, JSON.stringify(checked));
    return checked;
  }

  addCommandRule(pool: Pool, project: string, rule: CommandRule): void {
    this.db.transaction(() => {
      const checked = checkCommandRules([rule])[0]!;
      const rules = this.commandRules(pool, project).filter(r => r.prefix !== checked.prefix);
      this.setCommandRules(pool, project, [...rules, checked]);
    })();
  }

  constructor(private readonly db: Db, readonly allowed: () => Record<Pool, string[]>) {}

  close(): void { this.db.close(); }

  private setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  /** Her skills are active at once instead of waiting for approval (docs/briefs/skills.md). */
  skillsAutoApprove(): boolean { return this.setting("skills.auto_approve") === "1"; }
  setSkillsAutoApprove(on: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('skills.auto_approve', ?)").run(on ? "1" : "0");
  }

  threadWork(threadId: string): ThreadWork | undefined {
    const value = this.setting(`workspace.threadWork.${threadId}`);
    return value ? JSON.parse(value) : undefined;
  }

  setThreadWork(threadId: string, work: ThreadWork): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`workspace.threadWork.${threadId}`, JSON.stringify(work));
  }

  /** Portrait photos sent by the image tool; ask once per server-local calendar day. */
  photoCloudPolicy(): PhotoCloudPolicy {
    const policy = this.setting("images.photos.cloud");
    return policy === "never" || policy === "always" ? policy : "ask";
  }

  setPhotoCloudPolicy(policy: PhotoCloudPolicy): void {
    if (!["never", "ask", "always"].includes(policy)) throw new Error("photo cloud policy is never, ask or always");
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('images.photos.cloud', ?)").run(policy);
      this.db.prepare("DELETE FROM settings WHERE key = 'images.photos.approved_day'").run();
    })();
  }

  photoCloudApproved(day: string): boolean { return this.setting("images.photos.approved_day") === day; }
  approvePhotoCloud(day: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('images.photos.approved_day', ?)").run(day);
  }

  /** Principle 2: derived portraits retain their cloud policy across copies and renames. */
  isPortraitImage(hash: string): boolean { return this.setting(`images.portrait.sha256.${hash}`) === "1"; }
  recordPortraitImage(hash: string): void {
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(`images.portrait.sha256.${hash}`);
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

  /**
   * The token Claude Code signs in with, from `claude setup-token` on the
   * user's own computer (docs/workspace.md, "Claude Code"). Only here and in
   * the environment of a run that may use it; never shown back.
   */
  claudeCodeToken(): string | undefined {
    return this.setting("claude_code.token");
  }

  setClaudeCodeToken(token: string | null): void {
    if (token === null) {
      this.db.prepare("DELETE FROM settings WHERE key = 'claude_code.token'").run();
      return;
    }
    const t = token.trim();
    if (t.length < 20 || t.length > 1024 || /[\s\0-\x1f\x7f]/.test(t)) throw new Error("that doesn't look like the token claude setup-token prints");
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('claude_code.token', ?)").run(t);
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
    if (!row) return { grants: [], internet: null, services: null, hosts: null, mode: "auto", webSearch: true, images: true, claudeCode: false, code: false, machines: [], repositories: [], mcpServers: [], parent: null };
    const threadWork = this.threadWork(threadId);
    const bool = (v: number | null) => (v === null ? null : v === 1);
    return {
      grants: JSON.parse(row.grants), internet: bool(row.internet), services: bool(row.services),
      hosts: row.hosts === null ? null : JSON.parse(row.hosts), mode: row.mode, webSearch: row.web_search === 1, images: row.images === 1,
      claudeCode: row.claude_code === 1, code: row.code === 1, machines: JSON.parse(row.machines), repositories: JSON.parse(row.repositories), mcpServers: JSON.parse(row.mcp_servers), parent: row.parent, ...(threadWork ? { threadWork } : {}),
    };
  }

  /**
   * What applies to the thread now: its own settings, with the strictest mode,
   * each switch off where any ancestor's is, only the folders, machines,
   * repositories and MCP servers every ancestor grants, and a folder read-only where any ancestor has it
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
      t.claudeCode &&= up.claudeCode;
      t.grants = narrowGrants(t.grants, up.grants);
      t.machines = t.machines.filter((m) => up.machines.includes(m));
      t.repositories = t.repositories.filter((r) => up.repositories.some((u) => sameRepository(r, u)));
      t.mcpServers = t.mcpServers.filter((m) => up.mcpServers.includes(m));
      id = up.parent;
    }
    return t;
  }

  /**
   * Changes a thread's workspace. Grants are checked against the allowed
   * folders for `pool`, and a subagent's settings against its parent's.
   */
  setThread(threadId: string, pool: Pool, change: Partial<Omit<ThreadWorkspace, "parent">>): ThreadWorkspace {
    const before = this.thread(threadId).repositories;
    const next = { ...this.thread(threadId), ...change };
    // Folders, machines, repositories and MCP servers a parent has since taken away go with any other change, rather than refusing it.
    if (next.parent && (change.grants === undefined || change.machines === undefined || change.repositories === undefined || change.mcpServers === undefined)) {
      const now = this.effective(threadId);
      if (change.grants === undefined) next.grants = now.grants;
      if (change.machines === undefined) next.machines = now.machines;
      if (change.repositories === undefined) next.repositories = now.repositories;
      if (change.mcpServers === undefined) next.mcpServers = now.mcpServers;
    }
    next.grants = next.grants.map((g) => ({ path: cleanPath(g.path), writable: g.writable }));
    next.hosts = next.hosts?.map((h) => parseHost(h).entry) ?? null;
    const allowed = this.allowed();
    for (const g of next.grants) {
      checkGrant(allowed, pool, g);
      const outer = next.grants.find((o) => o !== g && within(g.path, o.path));
      if (outer && !(g.path === `${outer.path}/.git` && !outer.writable)) throw new Error(`${g.path} is inside ${outer.path}; grant one or the other`);
    }
    if (!PERMISSION_MODES.includes(next.mode)) throw new Error(`unknown permission mode: ${next.mode}`);
    if (next.claudeCode && pool !== "general") throw new Error("a private thread can't use Claude Code: it sends what it reads to Anthropic");
    next.machines = [...new Set(next.machines)];
    for (const name of next.machines) {
      const m = this.machine(name);
      if (!m) throw new Error(`no machine ${name}`);
      if (m.pool !== pool) throw new Error(`${name} is a ${m.pool} machine; a ${pool} thread can't use it`);
    }
    next.repositories = this.checkRepositories(next.repositories, pool);
    next.mcpServers = [...new Set((next.mcpServers ?? []).map(String))];
    for (const name of next.mcpServers) {
      const m = this.mcpServer(name);
      if (!m) throw new Error(`no MCP server ${name}`);
      if (m.pool !== pool) throw new Error(`${name} is a ${m.pool} MCP server; a ${pool} thread can't use it`);
    }
    if (next.parent) this.checkNarrower(next.parent, pool, next);
    this.write(threadId, next);
    this.carryAccounts(threadId, before, next.repositories);
    this.narrowChildren(threadId);
    return next;
  }

  /**
   * A repository moved to another Git account keeps its place in the
   * thread's subagents and child threads: theirs moves too, rather than
   * being taken away for not matching.
   */
  private carryAccounts(threadId: string, before: ThreadRepository[], after: ThreadRepository[]): void {
    const moved = new Map<string, { from: string; to: string }>();
    for (const r of before) {
      if (after.some((a) => sameRepository(a, r))) continue;
      const to = after.find((a) => a.name === r.name);
      if (to) moved.set(`${r.name}\n${r.account}`, { from: r.account, to: to.account });
    }
    if (!moved.size) return;
    const carry = (id: string, depth: number): void => {
      if (depth > 100) return;
      for (const { thread_id: child } of this.db.prepare("SELECT thread_id FROM thread_workspaces WHERE parent = ?").all(id) as { thread_id: string }[]) {
        const own = this.thread(child);
        const repositories: ThreadRepository[] = [];
        for (const r of own.repositories) {
          const m = moved.get(`${r.name}\n${r.account}`);
          const repo = m ? { name: r.name, account: m.to } : r;
          if (!repositories.some((o) => sameRepository(o, repo))) repositories.push(repo);
        }
        if (JSON.stringify(repositories) !== JSON.stringify(own.repositories)) this.write(child, { ...own, repositories });
        carry(child, depth + 1);
      }
    };
    carry(threadId, 0);
  }

  /**
   * Writes what `effective` already applies into the rows of the thread's
   * subagents and child threads, so a folder, machine, repository or MCP server taken away stays
   * away: the parent getting it back later gives them nothing.
   */
  private narrowChildren(threadId: string, depth = 0): void {
    if (depth > 100) return;
    const rows = this.db.prepare("SELECT thread_id FROM thread_workspaces WHERE parent = ?").all(threadId) as { thread_id: string }[];
    for (const { thread_id: id } of rows) {
      const own = this.thread(id);
      const now = this.effective(id);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      if (!same(own.grants, now.grants) || !same(own.machines, now.machines) || !same(own.repositories, now.repositories) || !same(own.mcpServers, now.mcpServers)) {
        this.write(id, { ...own, grants: now.grants, machines: now.machines, repositories: now.repositories, mcpServers: now.mcpServers });
      }
      this.narrowChildren(id, depth + 1);
    }
  }

  private write(threadId: string, t: ThreadWorkspace): void {
    const int = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    // The upsert keeps the thread's allowed commands.
    this.db.prepare(`INSERT INTO thread_workspaces (thread_id, grants, internet, services, hosts, mode, parent, web_search, images, claude_code, code, machines, repositories, mcp_servers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET grants = excluded.grants, internet = excluded.internet,
      services = excluded.services, hosts = excluded.hosts, mode = excluded.mode, parent = excluded.parent, web_search = excluded.web_search,
      images = excluded.images, claude_code = excluded.claude_code, code = excluded.code, machines = excluded.machines, repositories = excluded.repositories, mcp_servers = excluded.mcp_servers`).run(threadId,
      JSON.stringify(t.grants), int(t.internet), int(t.services), t.hosts === null ? null : JSON.stringify(t.hosts), t.mode, t.parent, int(t.webSearch), int(t.images),
      int(t.claudeCode), int(t.code), JSON.stringify(t.machines), JSON.stringify(t.repositories), JSON.stringify(t.mcpServers));
  }

  /**
   * Gives a subagent's thread its parent's folders, network, permission mode,
   * switches, machines, repositories and MCP servers, or the stricter ones in `narrower`. It works in the
   * parent's folder. Anything wider than the parent's is refused.
   */
  inheritSettings(parentThreadId: string, childThreadId: string, pool: Pool,
    narrower: Partial<Pick<ThreadWorkspace, "grants" | "mode" | "webSearch" | "images" | "claudeCode" | "machines" | "repositories" | "mcpServers">> & Partial<Network> = {}): ThreadWorkspace {
    const parent = this.effective(parentThreadId);
    const net = this.network(parentThreadId, pool);
    // Start from nothing, so a refused narrowing leaves the child with no access at all.
    this.write(childThreadId, {
      grants: [], internet: false, services: false, hosts: [], mode: "plan", webSearch: false, images: false, claudeCode: false, code: false, machines: [], repositories: [], mcpServers: [], parent: parentThreadId,
    });
    return this.setThread(childThreadId, pool, {
      grants: narrower.grants ?? parent.grants,
      internet: narrower.internet ?? net.internet,
      services: narrower.services ?? net.services,
      hosts: narrower.hosts ?? net.hosts,
      mode: narrower.mode ?? parent.mode,
      webSearch: narrower.webSearch ?? parent.webSearch,
      images: narrower.images ?? parent.images,
      claudeCode: narrower.claudeCode ?? parent.claudeCode,
      code: parent.code,
      machines: narrower.machines ?? parent.machines,
      repositories: narrower.repositories ?? parent.repositories,
      mcpServers: narrower.mcpServers ?? parent.mcpServers,
    });
  }

  /** Existing work moved into a project keeps its grants, narrowed by its new parent. */
  reparent(threadId: string, projectId: string, pool: Pool): void {
    const mine = this.network(threadId, pool), parent = this.network(projectId, pool);
    this.write(threadId, { ...this.effective(threadId), parent: projectId,
      internet: mine.internet && parent.internet, services: mine.services && parent.services,
      hosts: mine.hosts.filter(host => parent.hosts.includes(host)),
    });
    this.write(threadId, this.effective(threadId));
    this.narrowChildren(threadId);
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
      // Folders, machines, repositories and MCP servers a parent dropped later are dropped from the child by `effective`, not refused.
      this.checkNarrower(t.parent, pool, { ...t, grants: [], machines: [], repositories: [], mcpServers: [] });
    }
  }

  private checkNarrower(parentThreadId: string, pool: Pool, child: ThreadWorkspace): void {
    const parent = this.effective(parentThreadId);
    for (const g of child.grants) {
      const from = [...parent.grants].sort((a, b) => b.path.length - a.path.length).find((p) => within(g.path, p.path));
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
    if (child.claudeCode && !parent.claudeCode) throw new Error("the parent thread has Claude Code off");
    const machine = child.machines.find((m) => !parent.machines.includes(m));
    if (machine) throw new Error(`${machine} isn't in the parent thread's machines`);
    const repository = child.repositories.find((r) => !parent.repositories.some((p) => sameRepository(r, p)));
    if (repository) throw new Error(`${repository.name} isn't in the parent thread's repositories`);
    const server = child.mcpServers.find((m) => !parent.mcpServers.includes(m));
    if (server) throw new Error(`${server} isn't in the parent thread's MCP servers`);
  }

  /** Repositories cleaned and checked: each of a Git account of the thread's pool, and no two in one folder. */
  private checkRepositories(list: ThreadRepository[], pool: Pool): ThreadRepository[] {
    const out: ThreadRepository[] = [];
    for (const r of list) {
      const repo = { name: repositoryName(String(r.name ?? "")), account: String(r.account ?? "") };
      const a = this.gitAccount(repo.account);
      if (!a) throw new Error(`no Git account ${repo.account}`);
      if (a.pool !== pool) throw new Error(`${a.name} is a ${a.pool} Git account; a ${pool} thread can't use it`);
      if (out.some((o) => sameRepository(o, repo))) continue;
      const clash = out.find((o) => repositoryDir(o.name) === repositoryDir(repo.name));
      if (clash) throw new Error(`${clash.name} and ${repo.name} would both be cloned into repos/${repositoryDir(repo.name)}; keep one`);
      out.push(repo);
    }
    return out;
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

  /**
   * Records that `thread` wrote these files in `folder`'s folder. With `since` (an ISO time), a row another thread
   * wrote at or after it is kept: a command's sweep for new files can't tell its own writes from a concurrent one's.
   */
  recordOrigins(folder: string, paths: string[], thread: string, since?: string): void {
    const at = new Date().toISOString();
    const put = this.db.prepare(`INSERT INTO file_origins (folder, path, thread, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (folder, path) DO UPDATE SET thread = excluded.thread, at = excluded.at
      WHERE ? IS NULL OR file_origins.thread = excluded.thread OR file_origins.at < ?`);
    for (const path of paths) put.run(folder, path, thread, at, since ?? null, since ?? null);
  }

  /** Which thread wrote each of these files in `folder`'s folder, for those with a record. */
  origins(folder: string, paths: string[]): Map<string, string> {
    const get = this.db.prepare("SELECT thread FROM file_origins WHERE folder = ? AND path = ?");
    const out = new Map<string, string>();
    for (const path of paths) { const row = get.get(folder, path) as { thread: string } | undefined; if (row) out.set(path, row.thread); }
    return out;
  }

  /** A file or folder moved within `folder`'s folder: its records, and those of everything under it, move with it. */
  moveOrigins(folder: string, from: string, to: string): void {
    this.db.prepare("DELETE FROM file_origins WHERE folder = ? AND (path = ? OR path LIKE ? ESCAPE '\\')").run(folder, to, under(to));
    this.db.prepare("UPDATE file_origins SET path = ? || substr(path, ?) WHERE folder = ? AND (path = ? OR path LIKE ? ESCAPE '\\')")
      .run(to, from.length + 1, folder, from, under(from));
  }

  /** Files or folders gone from `folder`'s folder: their records and those of everything under them. */
  dropOrigins(folder: string, paths: string[]): void {
    const drop = this.db.prepare("DELETE FROM file_origins WHERE folder = ? AND (path = ? OR path LIKE ? ESCAPE '\\')");
    for (const path of paths) drop.run(folder, path, under(path));
  }

  /** A whole listing of `dir` in `folder`'s folder: records of what it no longer holds go (her command may have deleted it). */
  pruneOrigins(folder: string, dir: string, present: string[]): void {
    const prefix = dir ? `${dir}/` : "";
    const rows = this.db.prepare("SELECT path FROM file_origins WHERE folder = ? AND path LIKE ? ESCAPE '\\'")
      .all(folder, prefix ? under(dir) : "%") as { path: string }[];
    const here = new Set(present);
    const gone = new Set<string>();
    for (const { path } of rows) {
      const name = path.slice(prefix.length).split("/")[0]!;
      if (!here.has(name)) gone.add(prefix + name);
    }
    this.dropOrigins(folder, [...gone]);
  }

  /** Threads forgotten: the records they wrote, and those of the folders that went with them. */
  forgetOrigins(threads: string[], folders: string[] = threads): void {
    const byThread = this.db.prepare("DELETE FROM file_origins WHERE thread = ?");
    const byFolder = this.db.prepare("DELETE FROM file_origins WHERE folder = ?");
    for (const id of threads) byThread.run(id);
    for (const id of folders) byFolder.run(id);
  }

  /** The nightly sweep: records naming a thread or a folder that no longer exists. Returns how many went. */
  sweepOrigins(exists: (thread: string) => boolean): number {
    const rows = this.db.prepare("SELECT DISTINCT thread AS id FROM file_origins UNION SELECT DISTINCT folder FROM file_origins").all() as { id: string }[];
    const gone = rows.map((r) => r.id).filter((id) => !exists(id));
    let n = 0;
    const drop = this.db.prepare("DELETE FROM file_origins WHERE thread = ? OR folder = ?");
    for (const id of gone) n += Number(drop.run(id, id).changes);
    return n;
  }

  /** The thread whose folder in the home workspace this one works in: itself for a code child thread, otherwise its nearest ancestor with its own folder. */
  folderThread(threadId: string): string {
    for (let id = threadId, i = 0; i < 100; i++) {
      if (this.threadWork(id)) return id;
      const parent = this.thread(id).parent;
      if (!parent) return id;
      id = parent;
    }
    throw new Error(`thread ${threadId} has too many ancestors`);
  }

  /** The topmost thread above this one (a project's chat for its threads): its family shares one folder. */
  familyRoot(threadId: string): string {
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

  /** Adds a machine with the host key (or Proxmox certificate) the user confirmed. New machines start at Ask. */
  addMachine(m: NewMachine, confirmedHostKey: string): MachineConfig {
    if (!MACHINE_NAME.test(m.name)) throw new Error("machine names use letters, digits, '.', '_' and '-'");
    if (this.machine(m.name)) throw new Error(`machine ${m.name} already exists`);
    const kind = m.kind ?? "ssh";
    if (kind !== "ssh" && kind !== "proxmox") throw new Error(`unknown machine kind: ${String(kind)}`);
    const hostKey = confirmedKey(kind, confirmedHostKey);
    if (m.pool !== "general" && m.pool !== "private") throw new Error("a machine is general or private");
    const limit = m.limit ?? "ask";
    if (!MACHINE_LIMITS.includes(limit)) throw new Error(`unknown mode limit: ${limit}`);
    this.db.prepare(`INSERT INTO machines (name, kind, host, port, username, private_key, root, host_key, pool, mode_limit, off_network, as_user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.name, kind, m.host, m.port, m.username, m.privateKey,
      m.root === null || kind === "proxmox" ? null : cleanPath(m.root), hostKey, m.pool, limit, m.offNetwork ? 1 : 0, m.asUser && kind === "ssh" ? 1 : 0);
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

  /** Re-pairs a machine: the host key (or Proxmox certificate) the user confirmed replaces the old one. */
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

  /** Records whether the address resolved outside the operator's network at the last check. */
  setOffNetwork(name: string, off: boolean): void {
    this.db.prepare("UPDATE machines SET off_network = ? WHERE name = ?").run(off ? 1 : 0, name);
  }

  /** the user accepted that a private machine is off network: it can be reached again. */
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

  gitAccounts(): GitAccountConfig[] {
    return (this.db.prepare("SELECT * FROM git_accounts ORDER BY name").all() as GitAccountRow[]).map(toGitAccount);
  }

  gitAccount(name: string): GitAccountConfig | undefined {
    const row = this.db.prepare("SELECT * FROM git_accounts WHERE name = ?").get(name) as GitAccountRow | undefined;
    return row && toGitAccount(row);
  }

  private needGit(name: string): GitAccountConfig {
    const a = this.gitAccount(name);
    if (!a) throw new Error(`no Git account ${name}`);
    return a;
  }

  /** Saves a Git account whose token was checked against its host (`Workspace.addGitAccount` does that first). */
  addGitAccount(a: NewGitAccount, state: GitAccountState["kind"] | null = null): GitAccountConfig {
    if (!GIT_ACCOUNT.test(a.name)) throw new Error("account names use letters, digits, '.', '_' and '-'");
    if (this.gitAccount(a.name)) throw new Error(`Git account ${a.name} already exists`);
    const next = checkGitAccount(a);
    // A Forgejo or Gitea account gets its webhook secret when it is made; it stays with the account like the token.
    const webhookSecret = next.kind === "forgejo" || next.kind === "gitea" ? randomBytes(32).toString("base64url") : null;
    this.db.prepare(`INSERT INTO git_accounts (name, kind, host, account, token, pool, off_network, state, state_since, webhook_secret)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(next.name, next.kind, next.host, next.account, next.token, next.pool, next.offNetwork ? 1 : 0,
      state, state && new Date().toISOString(), webhookSecret);
    return this.needGit(a.name);
  }

  /**
   * Renames a Git account or changes its host, account name or pool. A new
   * pool takes its repositories from every thread, so a token is never
   * reached from both pools; a new name follows into the threads that use it.
   */
  updateGitAccount(name: string, change: Partial<Pick<GitAccountConfig, "name" | "host" | "account" | "pool">>): GitAccountConfig {
    const before = this.needGit(name);
    const next = checkGitAccount({ ...before, ...change });
    if (next.name !== name) {
      if (!GIT_ACCOUNT.test(next.name)) throw new Error("account names use letters, digits, '.', '_' and '-'");
      if (this.gitAccount(next.name)) throw new Error(`Git account ${next.name} already exists`);
    }
    const moved = next.host !== before.host || next.account !== before.account;
    this.db.prepare(`UPDATE git_accounts SET name = ?, host = ?, account = ?, pool = ?${moved ? ", state = NULL, state_since = NULL" : ""} WHERE name = ?`)
      .run(next.name, next.host, next.account, next.pool, name);
    if (next.pool !== before.pool) this.dropRepositories(name);
    else if (next.name !== name) this.renameRepositories(name, next.name);
    return this.needGit(next.name);
  }

  /** Replace token: the new one, checked against the host by `Workspace.setGitToken` first. */
  setGitToken(name: string, token: string, state: GitAccountState["kind"] | null = null): GitAccountConfig {
    const a = this.needGit(name);
    const next = checkGitAccount({ ...a, token });
    this.db.prepare("UPDATE git_accounts SET token = ?, state = ?, state_since = ? WHERE name = ?").run(next.token, state, state && new Date().toISOString(), name);
    return this.needGit(name);
  }

  /** Removes the account and every thread's repositories that use it. */
  removeGitAccount(name: string): void {
    if (!this.db.prepare("DELETE FROM git_accounts WHERE name = ?").run(name).changes) throw new Error(`no Git account ${name}`);
    this.dropRepositories(name);
  }

  /** Records how a use went; `since` moves only when the outcome changes. */
  gitAccountState(name: string, kind: GitAccountState["kind"] | null): void {
    this.db.prepare("UPDATE git_accounts SET state = ?, state_since = ? WHERE name = ? AND state IS NOT ?")
      .run(kind, kind && new Date().toISOString(), name, kind);
  }

  /** Records whether the host resolved outside the operator's network at the last check. */
  setGitOffNetwork(name: string, off: boolean): void {
    this.db.prepare("UPDATE git_accounts SET off_network = ? WHERE name = ?").run(off ? 1 : 0, name);
  }

  /** the user accepted that a private account's host is off network: it can be used again. */
  confirmGitOffNetwork(name: string): GitAccountConfig {
    this.needGit(name);
    this.setGitOffNetwork(name, true);
    return this.needGit(name);
  }

  private eachRepositories(f: (list: ThreadRepository[]) => ThreadRepository[]): void {
    for (const row of this.db.prepare("SELECT thread_id, repositories FROM thread_workspaces").all() as { thread_id: string; repositories: string }[]) {
      const list = JSON.parse(row.repositories) as ThreadRepository[];
      const next = f(list);
      if (JSON.stringify(next) !== row.repositories) this.db.prepare("UPDATE thread_workspaces SET repositories = ? WHERE thread_id = ?").run(JSON.stringify(next), row.thread_id);
    }
  }

  private dropRepositories(account: string): void { this.eachRepositories((list) => list.filter((r) => r.account !== account)); }

  private renameRepositories(from: string, to: string): void {
    this.eachRepositories((list) => list.map((r) => (r.account === from ? { ...r, account: to } : r)));
  }

  mcpServers(): McpServerConfig[] {
    return (this.db.prepare("SELECT * FROM mcp_servers ORDER BY name").all() as McpServerRow[]).map(toMcpServer);
  }

  mcpServer(name: string): McpServerConfig | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as McpServerRow | undefined;
    return row && toMcpServer(row);
  }

  private needMcp(name: string): McpServerConfig {
    const m = this.mcpServer(name);
    if (!m) throw new Error(`no MCP server ${name}`);
    return m;
  }

  /** A name no other server has, in Pi's eyes too: names that differ only in '-' and '_' are one server to it. */
  private checkMcpName(name: string, except?: string): void {
    if (!MCP_NAME.test(name)) throw new Error("server names use letters, digits, '_' and '-'");
    const clash = this.mcpServers().find((m) => m.name !== except && mcpNamespace(m.name) === mcpNamespace(name));
    if (clash) throw new Error(`MCP server ${clash.name} already exists`);
  }

  /** Saves a server that answered its check (`Workspace.addMcpServer` does that first). */
  addMcpServer(m: NewMcpServer, state: McpStateKind | null = null): McpServerConfig {
    this.checkMcpName(m.name);
    const next = checkMcpServer(m);
    this.db.prepare(`INSERT INTO mcp_servers (name, url, token, pool, description, tools, off_network, state, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(next.name, next.url, next.token, next.pool, next.description, next.tools, next.offNetwork ? 1 : 0,
      state, state && new Date().toISOString());
    return this.needMcp(m.name);
  }

  /**
   * Renames a server or changes its URL or pool. A new pool takes it from
   * every thread, so it is never reached from both pools; a new name follows
   * into the threads that use it.
   */
  updateMcpServer(name: string, change: Partial<Pick<McpServerConfig, "name" | "url" | "pool" | "description" | "tools">>): McpServerConfig {
    const before = this.needMcp(name);
    const next = checkMcpServer({ ...before, ...change });
    if (next.name !== name) this.checkMcpName(next.name, name);
    const moved = next.url !== before.url;
    this.db.prepare(`UPDATE mcp_servers SET name = ?, url = ?, pool = ?, description = ?, tools = ?${moved ? ", state = NULL, checked_at = NULL" : ""} WHERE name = ?`)
      .run(next.name, next.url, next.pool, next.description, next.tools, name);
    if (next.pool !== before.pool) this.dropMcpServer(name);
    else if (next.name !== name) this.renameMcpServer(name, next.name);
    return this.needMcp(next.name);
  }

  /** Replace token: the new one, checked against the server by `Workspace.setMcpToken` first. */
  setMcpToken(name: string, token: string, state: McpStateKind | null = null): McpServerConfig {
    const next = checkMcpServer({ ...this.needMcp(name), token });
    this.db.prepare("UPDATE mcp_servers SET token = ?, state = ?, checked_at = ? WHERE name = ?").run(next.token, state, state && new Date().toISOString(), name);
    return this.needMcp(name);
  }

  /** Removes the server, every thread's grant of it, and the tools allowed on it in a thread. */
  removeMcpServer(name: string): void {
    if (!this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name).changes) throw new Error(`no MCP server ${name}`);
    this.dropMcpServer(name);
  }

  /** Records how a connection went; `checked_at` moves only when the outcome changes. */
  mcpServerState(name: string, kind: McpStateKind | null): void {
    this.db.prepare("UPDATE mcp_servers SET state = ?, checked_at = ? WHERE name = ? AND state IS NOT ?")
      .run(kind, kind && new Date().toISOString(), name, kind);
  }

  /** Records whether the host resolved outside the operator's network at the last check. */
  setMcpOffNetwork(name: string, off: boolean): void {
    this.db.prepare("UPDATE mcp_servers SET off_network = ? WHERE name = ?").run(off ? 1 : 0, name);
  }

  /** The user accepted that a private server's host is off network: it can be used again. */
  confirmMcpOffNetwork(name: string): McpServerConfig {
    this.needMcp(name);
    this.setMcpOffNetwork(name, true);
    return this.needMcp(name);
  }

  /** The threads that grant the server themselves. */
  threadsWithMcpServer(name: string): string[] {
    return (this.db.prepare("SELECT thread_id, mcp_servers FROM thread_workspaces").all() as { thread_id: string; mcp_servers: string }[])
      .filter((r) => (JSON.parse(r.mcp_servers) as string[]).includes(name)).map((r) => r.thread_id);
  }

  private eachMcp(f: (list: string[], allowed: AllowedCommand[]) => [string[], AllowedCommand[]]): void {
    for (const row of this.db.prepare("SELECT thread_id, mcp_servers, allowed FROM thread_workspaces").all() as { thread_id: string; mcp_servers: string; allowed: string }[]) {
      const [list, allowed] = f(JSON.parse(row.mcp_servers), JSON.parse(row.allowed));
      if (JSON.stringify(list) !== row.mcp_servers || JSON.stringify(allowed) !== row.allowed) {
        this.db.prepare("UPDATE thread_workspaces SET mcp_servers = ?, allowed = ? WHERE thread_id = ?").run(JSON.stringify(list), JSON.stringify(allowed), row.thread_id);
      }
    }
  }

  private dropMcpServer(name: string): void {
    this.eachMcp((list, allowed) => [list.filter((m) => m !== name), allowed.filter((a) => a.machine !== mcpKey(name))]);
  }

  private renameMcpServer(from: string, to: string): void {
    this.eachMcp((list, allowed) => [list.map((m) => (m === from ? to : m)), allowed.map((a) => (a.machine === mcpKey(from) ? { ...a, machine: mcpKey(to) } : a))]);
  }

  /** An MCP tool the user allowed in this thread: that tool on that server stops asking here, and only here. */
  allowToolInThread(threadId: string, server: string, tool: string): void {
    this.allowInThread(threadId, mcpKey(server), tool);
  }

  toolAllowedInThread(threadId: string, server: string, tool: string): boolean {
    return this.allowedInThread(threadId).some((a) => a.machine === mcpKey(server) && a.command === tool);
  }

  /** A suspect command the user allowed in this thread: that exact command on that machine stops asking here, and only here. */
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

/** A suspect command allowed on a machine; for an MCP tool, `machine` is `mcp:<server>` (no machine's name has a colon) and `command` the tool. */
export interface AllowedCommand { machine: string; command: string }

const mcpKey = (server: string) => `mcp:${server}`;

interface ThreadRow {
  grants: string; internet: number | null; services: number | null; hosts: string | null;
  mode: PermissionMode; parent: string | null; web_search: number; images: number; claude_code: number; code: number; machines: string; repositories: string; mcp_servers: string;
}

export const sameRepository = (a: ThreadRepository, b: ThreadRepository): boolean => a.name === b.name && a.account === b.account;

/** A Git account's fields cleaned and checked. A GitHub account can't be private. */
function checkGitAccount(a: NewGitAccount): NewGitAccount {
  if (!GIT_KINDS.includes(a.kind)) throw new Error(`unknown kind of Git account: ${String(a.kind)}`);
  if (a.pool !== "general" && a.pool !== "private") throw new Error("a Git account is general or private");
  if (a.kind === "github" && a.pool === "private") throw new Error("a GitHub account is general. Private threads use only self-hosted accounts on your own network.");
  const account = String(a.account ?? "").trim();
  if (!GIT_ACCOUNT.test(account)) throw new Error("the account is its name on the host, like xlc2022");
  const token = String(a.token ?? "").trim();
  if (!token || token.length > 1024 || /[\s\0-\x1f\x7f]/.test(token)) throw new Error("that doesn't look like a token");
  return { ...a, host: gitHost(a.host), account, token };
}

/** An MCP server's fields cleaned and checked: a URL its pool allows, and a token with no spaces. */
function checkMcpServer(m: NewMcpServer): NewMcpServer {
  if (m.pool !== "general" && m.pool !== "private") throw new Error("an MCP server is general or private");
  const token = String(m.token ?? "").trim();
  if (token.length > 4096 || /[\s\0-\x1f\x7f]/.test(token)) throw new Error("that doesn't look like a token");
  return { ...m, url: mcpUrl(m.url, m.pool, token), token };
}

interface McpServerRow {
  name: string; url: string; token: string; pool: Pool; description: string | null; tools: number; off_network: number;
  state: McpStateKind | null; checked_at: string | null;
}
const toMcpServer = (r: McpServerRow): McpServerConfig => ({
  name: r.name, url: r.url, token: r.token, pool: r.pool, description: r.description, tools: r.tools, offNetwork: r.off_network === 1,
  state: r.state && r.checked_at ? { kind: r.state, since: r.checked_at } : null,
});

interface GitAccountRow {
  name: string; kind: GitKind; host: string; account: string; token: string; pool: Pool; off_network: number;
  state: GitAccountState["kind"] | null; state_since: string | null; webhook_secret: string | null;
}
const toGitAccount = (r: GitAccountRow): GitAccountConfig => ({
  name: r.name, kind: r.kind, host: r.host, account: r.account, token: r.token, pool: r.pool, offNetwork: r.off_network === 1,
  state: r.state && r.state_since ? { kind: r.state, since: r.state_since } : null,
  webhookSecret: r.webhook_secret,
});

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
  as_user: number;
}
const toMachine = (r: MachineRow): MachineConfig => ({
  name: r.name, kind: r.kind, host: r.host, port: r.port, username: r.username, privateKey: r.private_key, root: r.root, asUser: r.as_user === 1, hostKey: r.host_key,
  pool: r.pool, limit: r.mode_limit, offNetwork: r.off_network === 1, lastUsed: r.last_used,
  state: r.state && r.state_since ? { kind: r.state, since: r.state_since } : null,
});

/** A repository's HTTPS address on its account's host. */
export const repositoryUrl = (host: string, name: string): string => `https://${host}/${name}.git`;
