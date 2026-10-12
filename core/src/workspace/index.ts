import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Locked, type Keyring } from "../keyring.ts";
import { inOwnNetwork } from "../models/http.ts";
import type { Pool } from "../types.ts";
import type { Users } from "../users.ts";
import { FileChanges, type NewChange } from "./changes.ts";
import { cleanUploadName, ThreadFiles } from "./files.ts";
import { isMounted, mountGocryptfs, unmountGocryptfs } from "./home.ts";
import type { ExecutionTarget } from "./ops.ts";
import { Sandbox, WORKDIR } from "./sandbox.ts";
import { authorizedKeysLine, machineSetup } from "./machines.ts";
import {
  certFingerprint, ownAddress, ownNode, parseProxmoxAddress, proxmoxAction, proxmoxHttps, proxmoxSetup, thisComputer, tokenId,
  type ProxmoxAction, type ProxmoxCall, type ProxmoxTransport, type Self,
} from "./proxmox.ts";
import { parseHost } from "./net.ts";
import { mcpHost, mcpUrl, probeMcp, type McpProbe, type McpStateKind } from "./mcp.ts";
import {
  checkGrant, gitHost, type McpServerConfig, repositoryDir, repositoryName, stricterMode, WorkspaceSettings, type GitAccountConfig, type GitAccountState, type GitKind, type Grant,
  type MachineConfig, type MachineKind, type MachineLimit, type Network, type NewMachine, type PermissionMode, type ThreadRepository, type ThreadWorkspace,
} from "./settings.ts";
import { AllowedPaths } from "./paths.ts";
import { generateSshKey, SshTarget } from "./ssh.ts";
import { sandboxedTransport, type SshTransport } from "./transport.ts";

export * from "./changes.ts";
export * from "./files.ts";
export * from "./home.ts";
export * from "./machines.ts";
export * from "./mcp.ts";
export * from "./net.ts";
export * from "./paths.ts";
export * from "./ops.ts";
export * from "./proxmox.ts";
export * from "./sandbox.ts";
export * from "./settings.ts";
export * from "./ssh.ts";
export * from "./transport.ts";

/** The parts of a thread the workspace needs. */
export interface WorkspaceThread {
  userId: string;
  pool: Pool;
  threadId: string;
  /** A subagent's: the thread whose clones it works in, its parent's. Otherwise its own. */
  reposOf?: string;
  /** A read-only subagent's: its parent's clones are mounted read-only, so it can't change their working trees or commits. */
  reposReadOnly?: boolean;
}

export interface FrontDoor { ports: number[]; hosts: string[]; exclude: number[] }

export interface WorkspaceOptions {
  /**
   * lyricad's own ports (its HTTP API): never reachable from a sandbox, on any
   * address. Required, so forgetting it can't leave them open; pass [] for none.
   */
  excludePorts: number[];
  /**
   * Where lyricad's front door is now, read at every sandbox start: its ports,
   * the hosts it answers on besides this machine (an external proxy, Lyrica's
   * name), and extra ports to refuse on every address (an extra listener).
   * Without it, port 443 on this machine's addresses.
   */
  frontDoor?: () => FrontDoor;
  bwrap?: string;
  pasta?: string;
  /** The SSH client for machines. Default: sandboxedTransport, a sandboxed helper per connection. */
  sshTransport?: SshTransport;
  /** The HTTPS client for Proxmox machines. Default: Node's, in this process. */
  proxmoxTransport?: ProxmoxTransport;
  /** This computer's name, network cards, addresses and gateways, for refusing the Proxmox that runs it. Default: read now. */
  self?: () => Self;
  /** How lyricad asks a Git host's API about a token and its repositories. Default: fetch. */
  forgeFetch?: typeof fetch;
}

/** A repository as one thread sees it: where it is cloned, and through which account. */
export interface ThreadGitRepository extends ThreadRepository {
  kind: GitKind;
  host: string;
  /** Where the clone is, inside the sandbox: /workspace/repos/<last part of the name>. */
  path: string;
  /** Whether this thread's sandbox gets the account's token now: its network reaches the host, and a private host hasn't left her network. */
  reachable: boolean;
}

/** One repository an account can see, for Add repository. */
export interface GitRepositoryInfo { name: string; account: string }

/** An MCP server as one thread's session registers it: granted, of its pool, and on her network if private. */
export interface ThreadMcpServer { name: string; url: string; token: string; description: string | null }

/** A machine as one thread sees it: granted, of its pool, with its limit. */
export interface ThreadMachine { name: string; kind: MachineKind; limit: MachineLimit; root: string | null }

/** What adding a machine needs before it is saved: the key she will use and what the machine showed. */
export interface MachineProbe {
  /** SSH: refers to the key pair kept in memory for this machine until it is added. */
  draft?: string;
  /** SSH: for the machine's keys file, usable only from Lyrica's addresses. */
  keyLine?: string;
  /** The setup steps to run as root on the machine (for Proxmox, on the node). */
  setup: string;
  /** The host key the machine showed, or for Proxmox its certificate's, when it answered. */
  fingerprint?: string;
  /** Whether her key was accepted. Always false for Proxmox: the token is tried only at Confirm, against the confirmed certificate. */
  login: boolean;
  /** Why the test failed, in plain words. */
  problem?: string;
  /** The address resolves outside Li's LAN, loopback and tailnet. */
  offNetwork: boolean;
}

const DRAFT_MS = 60 * 60_000;

/** A repository's HTTPS address on its account's host. */
export const repositoryUrl = (host: string, name: string): string => `https://${host}/${name}.git`;

/**
 * Git accounts' tokens as a sandbox's environment, nothing on disk or on a
 * command line: for each repository, a git credential helper bound to that
 * repository's URL (git's `GIT_CONFIG_*` environment, with `useHttpPath` for
 * its host, so another repository on the same host never gets it), reading
 * the token from the environment; and `LYRICA_GIT_*` for the `gh` and `tea`
 * wrappers (forge.sh), which pick the one account whose repository the
 * current clone is.
 */
export function gitEnv(repos: { name: string; account: Pick<GitAccountConfig, "kind" | "host" | "account" | "token"> }[]): Record<string, string> {
  if (!repos.length) return {};
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const config: [string, string][] = [];
  for (const host of new Set(repos.map((r) => r.account.host))) config.push([`credential.https://${host}.useHttpPath`, "true"]);
  repos.forEach((r, i) => {
    env[`LYRICA_GIT_REPO_${i}`] = `${r.account.host}/${r.name}`.toLowerCase();
    env[`LYRICA_GIT_KIND_${i}`] = r.account.kind;
    env[`LYRICA_GIT_USER_${i}`] = r.account.account;
    env[`LYRICA_GIT_TOKEN_${i}`] = r.account.token;
    config.push([`credential.${repositoryUrl(r.account.host, r.name)}.helper`,
      `!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$LYRICA_GIT_USER_${i}" "$LYRICA_GIT_TOKEN_${i}"; }; f`]);
  });
  config.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  env.GIT_CONFIG_COUNT = String(config.length);
  // gh and tea get no token of their own here: GH_TOKEN is one value, so the
  // wrappers (forge.sh) pick the account by the clone's origin.
  env.LYRICA_GIT_COUNT = String(repos.length);
  return env;
}

/** Whether a sandbox on `net` can reach a Git host: internet on, or the host (and its port, if the entry names one) an allowed host. */
export function reachesHost(net: Network, host: string): boolean {
  if (net.internet) return true;
  const want = parseHost(host);
  const port = want.port ?? 443;
  return net.hosts.some((h) => {
    try {
      const e = parseHost(h);
      return e.host === want.host && (e.port === undefined || e.port === port);
    } catch { return false; }
  });
}
/** account@host or account@host:port, with [v6] in brackets. */
export function parseMachineAddress(address: string): { username: string; host: string; port: number } {
  const m = /^([^@\s]+)@(\[[0-9a-fA-F:.]+\]|[^:\s@\[\]]+)(?::(\d+))?$/.exec(address.trim());
  const port = Number(m?.[3] ?? 22);
  if (!m || port < 1 || port > 65535) throw new Error("the address looks like account@host or account@host:port");
  return { username: m[1]!, host: m[2]!.replace(/^\[|\]$/g, ""), port };
}

/** A host's addresses, and whether any is outside Li's own network. A resolver that never answers is no answer. */
async function resolveHost(host: string): Promise<{ addresses: string[]; outside: boolean }> {
  const addresses = isIP(host) ? [host] : await Promise.race([
    lookup(host, { all: true }).then((all) => all.map((a) => a.address)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${host} doesn't resolve`)), 5000).unref()),
  ]);
  if (!addresses.length) throw new Error(`${host} doesn't resolve`);
  return { addresses, outside: addresses.some((a) => !inOwnNetwork(a)) };
}

/**
 * Where Lyrica's file and command tools run, and what they may touch. One per
 * lyricad. Thread settings come from each user's user.db, so the user must be
 * unlocked; the folders each user may grant are in self.db.
 */
export class Workspace {
  private readonly settingsByUser = new Map<string, WorkspaceSettings>();
  private readonly changesByUser = new Map<string, FileChanges>();
  private readonly sshTargets = new Map<string, SshTarget>();
  /** Private Git accounts whose host has newly left her network, by `<userId>/<name>`: no token goes out until Li confirms. */
  private readonly gitRefused = new Set<string>();
  /** Private MCP servers whose host has newly left her network, by `<userId>/<name>`: not used until Li confirms. */
  private readonly mcpRefused = new Set<string>();
  /** Key pairs for machines being added, by draft id, never saved before the machine is. */
  private readonly drafts = new Map<string, { userId: string; privateKey: string; publicKey: string; expires: number }>();
  /**
   * The SSH client: a sandboxed helper per connection, under the same front
   * door and self-test as the sandbox. Tests may pass their own.
   */
  readonly sshTransport: SshTransport;
  /** Which folders each user may grant. Only administrators change them. */
  readonly allowedPaths: AllowedPaths;

  constructor(private readonly keyring: Keyring, private readonly users: Users, private readonly opts: WorkspaceOptions) {
    this.allowedPaths = new AllowedPaths(keyring.self(), users, keyring.home);
    this.sshTransport = opts.sshTransport
      ?? sandboxedTransport(() => ({ ...this.door(), bwrap: this.opts.bwrap, pasta: this.opts.pasta, refused: this.networkRefused }));
  }

  settings(userId: string): WorkspaceSettings {
    let s = this.settingsByUser.get(userId);
    if (!s) {
      s = new WorkspaceSettings(this.users.openUserDb(userId), () => this.allowedPaths.list(userId));
      this.settingsByUser.set(userId, s);
    }
    return s;
  }

  /** What her write and edit calls did to the user's files, with snapshots in their home workspace. */
  changes(userId: string): FileChanges {
    let c = this.changesByUser.get(userId);
    if (!c) {
      c = new FileChanges(this.users.openUserDb(userId), () => {
        const home = this.homeDir(userId);
        if (!isMounted(home)) throw new Locked("the home workspace is not mounted");
        return home;
      });
      this.changesByUser.set(userId, c);
    }
    return c;
  }

  /** The front door and excluded ports as they are now. */
  private door(): { exclude: number[]; front: number[]; frontHosts: string[] } {
    const d = this.opts.frontDoor?.();
    return {
      exclude: [...new Set([...this.opts.excludePorts, ...(d?.exclude ?? [])])],
      front: d?.ports ?? [443],
      frontHosts: d?.hosts ?? [],
    };
  }

  /** Where the user's home workspace is mounted. */
  homeDir(userId: string): string { return join(realpathSync(this.users.userDir(userId)), "home"); }

  /** Mounts the user's encrypted home workspace. Call when their key becomes available. */
  async mountHome(userId: string): Promise<string> {
    const key = this.keyring.subkey(userId, "home");
    try {
      await mountGocryptfs(join(this.users.userDir(userId), "home.crypt"), this.homeDir(userId), key);
    } finally {
      key.fill(0);
    }
    return this.homeDir(userId);
  }

  /** Unmounts it and drops the user's open settings and SSH connections. Call when their key is dropped. */
  async unmountHome(userId: string): Promise<void> {
    for (const [k, t] of this.sshTargets) if (k.startsWith(`${userId}/`)) { t.close(); this.sshTargets.delete(k); }
    this.settingsByUser.get(userId)?.close();
    this.settingsByUser.delete(userId);
    this.changesByUser.get(userId)?.close();
    this.changesByUser.delete(userId);
    await unmountGocryptfs(this.homeDir(userId));
  }

  /** The thread's folder in the home workspace, on the host. */
  threadDir(t: WorkspaceThread): string {
    const home = this.homeDir(t.userId);
    if (!isMounted(home)) throw new Locked("the home workspace is not mounted");
    const id = this.settings(t.userId).folderThread(t.threadId);
    // Thread IDs may contain "/"; encoding keeps each one a single path component.
    const name = encodeURIComponent(id);
    if (!name || name === "." || name === "..") throw new Error(`unusable thread id: ${id}`);
    const dir = join(home, "threads", name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * One thread's target, settings, internet switch and folders, each read
   * fresh when called. Its settings are what applies now: the strictest mode
   * and switches of it and its ancestors.
   */
  forThread(t: WorkspaceThread) {
    return {
      target: (machine?: string) => this.targetFor(t, machine),
      settings: () => this.settings(t.userId).effective(t.threadId),
      machines: () => this.machinesFor(t),
      /** The thread's repositories, where each is cloned and whether its token reaches the sandbox now. */
      repositories: () => this.repositoriesFor(t),
      /** Clones or fetches the thread's repositories, at the start of a turn: what failed, in plain words. */
      cloneRepositories: () => this.cloneFor(t),
      /** She adds a repository to the thread, after Li approved it. */
      addRepository: (r: ThreadRepository) => this.addRepository(t, r),
      /** What the thread's pool's Git accounts can see, for her to pick from. */
      gitAccounts: () => this.settings(t.userId).gitAccounts().filter((a) => a.pool === t.pool).map((a) => ({ name: a.name, kind: a.kind, host: a.host })),
      /** One action on one of the thread's Proxmox machines. */
      proxmox: (machine: string, action: ProxmoxAction, vm?: string) => this.proxmox(t, machine, action, vm),
      /** Whether Li allowed this exact suspect command on this machine in this thread. */
      allowedInThread: (machine: string, command: string) =>
        this.settings(t.userId).allowedInThread(t.threadId).some((a) => a.machine === machine && a.command === command),
      /** The MCP servers the thread may use now, read at every call. */
      mcpServers: () => this.mcpServersFor(t),
      /** Checks each private server's host at the start of a turn: one that left her network is held back until Li confirms. */
      checkMcpServers: () => this.checkMcpServers(t),
      /** How a connection to one of its servers went, for Settings. */
      mcpServerState: (name: string, kind: McpStateKind) => { try { this.settings(t.userId).mcpServerState(name, kind); } catch { /* locked: shown only */ } },
      /** Whether Li allowed this MCP tool on this server in this thread. */
      toolAllowedInThread: (server: string, tool: string) => this.settings(t.userId).toolAllowedInThread(t.threadId, server, tool),
      /** An approved plan switching the thread's mode. */
      setMode: (mode: PermissionMode) => { this.settings(t.userId).setThread(t.threadId, t.pool, { mode }); },
      network: (): Network => this.network(t),
      folders: () => this.folders(t),
      /** Called after her write or edit tool changed a file, so removing the turn can undo it. */
      recordChange: (c: NewChange) => { this.changes(t.userId).record(t.pool, t.threadId, c); },
      /** Files the panel added or removed since her last turn, names only; taking them clears them. */
      fileNotes: () => this.settings(t.userId).takeFileNotes(t.threadId),
    };
  }

  /**
   * The thread's Files panel: its folder and grants, every operation in a
   * fresh sandbox with no network. Grants are checked against the allowed
   * paths as they are now, as for her tools.
   */
  files(t: WorkspaceThread): ThreadFiles {
    const s = this.settings(t.userId);
    s.checkInherited(t.threadId, t.pool);
    const tw = s.effective(t.threadId);
    const box = new Sandbox({
      workdir: this.threadDir(t), grants: tw.grants, network: { internet: false, services: false, hosts: [] },
      check: (g) => checkGrant(s.allowed(), t.pool, g), bwrap: this.opts.bwrap,
    });
    return new ThreadFiles(box, tw.grants, (kind, names) => s.noteFiles(t.threadId, kind, names));
  }

  /** What the thread's tools may reach: its settings, or nothing while the self-test has refused network. */
  network(t: WorkspaceThread): Network {
    if (this.networkRefused) return { internet: false, services: false, hosts: [] };
    return this.settings(t.userId).network(t.threadId, t.pool);
  }

  /** Why network modes are refused on this host, if the self-test found a reason. */
  networkRefused: string | undefined;

  /**
   * Checks, on this host, that a sandbox can't undo its own firewall: it
   * tries a nested user namespace followed by `nft flush ruleset`, and a
   * connection the rules block. If any of it works, or a networked sandbox
   * can't start at all, every thread runs with network off and the reason is
   * kept in `networkRefused`. lyricad calls this at startup.
   */
  async selfTest(): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-selftest-"));
    const probe = [
      "unshare -r nft flush ruleset >/dev/null 2>&1 && echo ESCAPE:flushed the rules from a nested user namespace",
      "nft flush ruleset >/dev/null 2>&1 && echo ESCAPE:flushed the rules",
      "timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && echo ESCAPE:reached a blocked address",
      "echo DONE",
    ].join("; ");
    try {
      // One allowed host that answers nothing: enough to start pasta and load the rules.
      const box = new Sandbox({
        workdir: dir, grants: [], network: { internet: false, services: false, hosts: ["192.0.2.1:9"] },
        ...this.door(), bwrap: this.opts.bwrap, pasta: this.opts.pasta,
      });
      const r = await box.run(["bash", "-c", probe], { timeoutMs: 30_000 });
      const out = r.stdout.toString();
      const escape = /ESCAPE:(.*)/.exec(out)?.[1];
      if (escape) this.networkRefused = `the sandbox ${escape}`;
      else if (r.code !== 0 || !out.includes("DONE")) this.networkRefused = `a networked sandbox didn't start: ${r.stderr.toString().trim() || `exit ${r.code}`}`;
      else this.networkRefused = undefined;
    } catch (err) {
      this.networkRefused = `a networked sandbox didn't start: ${(err as Error).message}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return this.networkRefused;
  }

  /** A subagent's thread gets its parent's settings, or stricter ones. See WorkspaceSettings.inheritSettings. */
  inheritSettings(parent: WorkspaceThread, childThreadId: string, narrower?: Parameters<WorkspaceSettings["inheritSettings"]>[3]): ThreadWorkspace {
    return this.settings(parent.userId).inheritSettings(parent.threadId, childThreadId, parent.pool, narrower);
  }

  /** The folders the thread may use now: its own, as far as every ancestor still grants them. */
  grantsFor(t: WorkspaceThread): Grant[] { return this.settings(t.userId).effective(t.threadId).grants; }

  /** What the thread works in: host folders, and `<machine>:<root>` for its machines with a root. Memory loads pages about them. */
  folders(t: WorkspaceThread): string[] {
    return [...this.grantsFor(t).map((g) => g.path), ...this.machinesFor(t).filter((m) => m.root).map((m) => `${m.name}:${m.root}`)];
  }

  /**
   * The machines the thread may use now: granted by it and every ancestor,
   * and of its pool, whatever an older row says.
   */
  machinesFor(t: WorkspaceThread): ThreadMachine[] {
    const s = this.settings(t.userId);
    return s.effective(t.threadId).machines.map((name) => s.machine(name))
      .filter((m): m is MachineConfig => !!m && m.pool === t.pool).map((m) => ({ name: m.name, kind: m.kind, limit: m.limit, root: m.root }));
  }

  /** The mode a call runs in: the thread's, or on a machine the stricter of it and the machine's limit, read now. */
  callMode(t: WorkspaceThread, machine?: string): PermissionMode {
    const mode = this.settings(t.userId).effective(t.threadId).mode;
    if (!machine) return mode;
    const m = this.machinesFor(t).find((x) => x.name === machine);
    if (!m) throw new Error(`${machine} isn't one of this thread's machines`);
    return stricterMode(mode, m.limit);
  }

  /**
   * Where the thread's clones are on the host: its own folder's repos/, in
   * the home workspace, so a child thread that shares its project's folder
   * still has clones of its own (a subagent works in its parent's). The
   * sweep removes it with the thread.
   */
  reposDir(t: WorkspaceThread): string {
    const home = this.homeDir(t.userId);
    if (!isMounted(home)) throw new Locked("the home workspace is not mounted");
    const dir = join(home, "threads", encodeURIComponent(t.reposOf ?? t.threadId), "repos");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Where it is mounted, in the folder the thread works in (its project's, for a project's thread).
    mkdirSync(join(this.threadDir(t), "repos"), { recursive: true, mode: 0o700 });
    return dir;
  }

  /** The thread's repositories now: granted by it and every ancestor, of an account of its pool. */
  repositoriesFor(t: WorkspaceThread): ThreadGitRepository[] {
    const s = this.settings(t.userId);
    const net = this.network(t);
    return s.effective(t.threadId).repositories.flatMap((r) => {
      const a = s.gitAccount(r.account);
      if (!a || a.pool !== t.pool) return [];
      const refused = this.gitRefused.has(`${t.userId}/${a.name}`) || (a.pool === "private" && a.kind === "github");
      return [{ ...r, kind: a.kind, host: a.host, path: `${WORKDIR}/repos/${repositoryDir(r.name)}`, reachable: !refused && reachesHost(net, a.host) }];
    });
  }

  /** Where a call runs: the sandbox, or one of the thread's machines. */
  targetFor(t: WorkspaceThread, machine?: string): ExecutionTarget {
    const s = this.settings(t.userId);
    s.checkInherited(t.threadId, t.pool);
    if (machine) {
      const m = this.machinesFor(t).find((x) => x.name === machine);
      if (!m) throw new Error(`${machine} isn't one of this thread's machines`);
      if (m.kind === "proxmox") throw new Error(`${machine} is a Proxmox machine: use the proxmox tool`);
      return this.ssh(t.userId, machine);
    }
    return new Sandbox({
      workdir: this.threadDir(t),
      grants: s.effective(t.threadId).grants,
      network: this.network(t),
      repos: this.reposDir(t),
      reposReadOnly: t.reposReadOnly,
      env: this.forgeEnv(t),
      ...this.door(),
      check: (g) => checkGrant(s.allowed(), t.pool, g),
      bwrap: this.opts.bwrap,
      pasta: this.opts.pasta,
    });
  }

  /**
   * The tokens of the thread's repositories, as its sandbox's environment
   * (`gitEnv`): only for a repository the thread has, of an account of its
   * pool, whose host its network reaches; a private account whose host has
   * left her network gives nothing until Li confirms. Anywhere else nothing.
   */
  forgeEnv(t: WorkspaceThread): Record<string, string> {
    const s = this.settings(t.userId);
    const repos = this.repositoriesFor(t).filter((r) => r.reachable);
    return gitEnv(repos.map((r) => ({ name: r.name, account: s.gitAccount(r.account)! })));
  }

  /**
   * Clones each of the thread's repositories into its repos/ (or fetches it,
   * once cloned), in the thread's sandbox with that run's credentials, and
   * records how each account did. A private account's host is checked first:
   * one that has left her network gets no token until Li confirms. Returns
   * what failed, one plain line each; nothing failing returns none.
   */
  async cloneFor(t: WorkspaceThread): Promise<string[]> {
    const s = this.settings(t.userId);
    const wanted = s.effective(t.threadId).repositories;
    if (!wanted.length) return [];
    const problems: string[] = [];
    for (const name of new Set(wanted.map((r) => r.account))) {
      const a = s.gitAccount(name);
      if (!a || a.pool !== t.pool) continue;
      const refused = await this.checkGitHost(t.userId, a).then(() => undefined, (err: Error) => err.message);
      if (refused) problems.push(refused);
    }
    const box = this.targetFor(t) as Sandbox;
    // Fetches when the folder is a clone already; otherwise clones into it, which git refuses if something else is there.
    const script = 'if [ -e "$1/.git" ]; then git -C "$1" fetch --prune --quiet origin; else mkdir -p "$(dirname "$1")" && git clone --quiet "$2" "$1"; fi';
    for (const r of this.repositoriesFor(t)) {
      const a = s.gitAccount(r.account)!;
      if (!r.reachable) {
        if (!this.gitRefused.has(`${t.userId}/${a.name}`)) problems.push(`${r.name}: this thread can't reach ${a.host}; allow it in the thread's hosts (or turn the internet on) to use it.`);
        continue;
      }
      let out: { code: number | null; stderr: Buffer };
      try {
        out = await box.run(["sh", "-c", script, "sh", r.path, repositoryUrl(a.host, r.name)], { timeoutMs: 10 * 60_000 });
      } catch (err) {
        problems.push(`${r.name}: ${(err as Error).message}`);
        continue;
      }
      const err = out.stderr.toString();
      const state = out.code === 0 ? "signedIn" : gitFailure(err);
      if (state) s.gitAccountState(a.name, state);
      if (out.code !== 0) problems.push(`${r.name} couldn't be ${/fetch/.test(err) ? "fetched" : "cloned"}: ${lastLine(err)}`);
    }
    return problems;
  }

  /** She adds a repository to the thread, once Li approved it: checked like any change to the thread's settings. */
  addRepository(t: WorkspaceThread, r: ThreadRepository): ThreadRepository[] {
    const s = this.settings(t.userId);
    const now = s.thread(t.threadId).repositories;
    return s.setThread(t.threadId, t.pool, { repositories: [...now, { name: repositoryName(r.name), account: r.account }] }).repositories;
  }

  /**
   * Checks a Git account's host before it is used. A private account whose
   * host has newly left her network is refused until Li confirms, so a DNS
   * change can't get past the warning; a general one only records it.
   */
  private async checkGitHost(userId: string, a: GitAccountConfig): Promise<void> {
    const s = this.settings(userId);
    const key = `${userId}/${a.name}`;
    let outside: boolean;
    try {
      outside = (await resolveHost(parseHost(a.host).host)).outside;
    } catch {
      s.gitAccountState(a.name, "unreachable");
      return;
    }
    if (outside && a.pool === "private" && !a.offNetwork) {
      this.gitRefused.add(key);
      throw new Error(`${a.host} now resolves outside your network, so ${a.name}'s token isn't used; confirm it in Settings → Git accounts to use it again.`);
    }
    this.gitRefused.delete(key);
    if (outside !== a.offNetwork) s.setGitOffNetwork(a.name, outside);
  }

  private forge(): typeof fetch { return this.opts.forgeFetch ?? fetch; }

  /** One call to a Git host's API with an account's token: GitHub's REST API, or Gitea's (which Forgejo shares). */
  private async forgeApi(a: Pick<GitAccountConfig, "kind" | "host" | "token">, path: string): Promise<unknown> {
    const base = a.kind === "github" ? (a.host === "github.com" ? "https://api.github.com" : `https://${a.host}/api/v3`) : `https://${a.host}/api/v1`;
    let res: Response;
    try {
      res = await this.forge()(`${base}${path}`, {
        headers: { Accept: "application/json", "User-Agent": "lyrica", Authorization: a.kind === "github" ? `Bearer ${a.token}` : `token ${a.token}` },
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
    } catch {
      throw new GitAccountProblem("unreachable", `${a.host} didn't answer`);
    }
    if (res.status === 401 || res.status === 403) throw new GitAccountProblem("rejected", `${a.host} rejected the token`);
    if (!res.ok) throw new GitAccountProblem("unreachable", `${a.host} answered ${res.status}`);
    return res.json();
  }

  /**
   * Checks a token against its host before anything is saved: GitHub's and
   * Gitea's (Forgejo's) user endpoint, which must name the account; for
   * Other, only that the host answers HTTPS. Throws GitAccountProblem.
   */
  async probeGitAccount(a: Pick<GitAccountConfig, "kind" | "host" | "account" | "token">): Promise<void> {
    const host = gitHost(a.host);
    if (a.kind === "other") {
      try {
        await this.forge()(`https://${host}/`, { method: "HEAD", signal: AbortSignal.timeout(15_000), redirect: "manual" });
      } catch {
        throw new GitAccountProblem("unreachable", `${host} didn't answer`);
      }
      return;
    }
    const me = await this.forgeApi({ ...a, host }, "/user") as { login?: string };
    if (String(me.login ?? "").toLowerCase() !== a.account.trim().toLowerCase()) {
      throw new GitAccountProblem("rejected", `that token is ${me.login ? `${me.login}'s` : "no account's"}, not ${a.account}'s`);
    }
  }

  /**
   * Saves a Git account once its token works. A private account's host must
   * resolve on her own network, or `offNetworkConfirmed` (the Add anyway
   * dialog); a GitHub account is general only.
   */
  async addGitAccount(userId: string, input: Omit<GitAccountConfig, "offNetwork" | "state"> & { offNetworkConfirmed?: boolean }): Promise<GitAccountConfig> {
    const s = this.settings(userId);
    if (s.gitAccount(input.name)) throw new Error(`Git account ${input.name} already exists`);
    if (input.kind === "github" && input.pool === "private") throw new Error("a GitHub account is general. Private threads use only self-hosted accounts on your own network.");
    const host = gitHost(input.host);
    const { outside } = await resolveHost(parseHost(host).host);
    if (outside && input.pool === "private" && !input.offNetworkConfirmed) throw new Error(`${host} resolves outside your network; confirm adding it anyway`);
    await this.probeGitAccount({ ...input, host });
    const { offNetworkConfirmed: _, ...a } = input;
    return s.addGitAccount({ ...a, host, offNetwork: outside }, "signedIn");
  }

  /** Changes a Git account's name, host, account or pool; a private one moved to a host off her network needs `offNetworkConfirmed`. */
  async updateGitAccount(userId: string, name: string, change: Partial<Pick<GitAccountConfig, "name" | "host" | "account" | "pool">> & { offNetworkConfirmed?: boolean }): Promise<GitAccountConfig> {
    const s = this.settings(userId);
    const before = s.gitAccount(name);
    if (!before) throw new Error(`no Git account ${name}`);
    const { offNetworkConfirmed, ...rest } = change;
    const host = rest.host === undefined ? before.host : gitHost(rest.host);
    const pool = rest.pool ?? before.pool;
    let outside = before.offNetwork;
    if (host !== before.host || pool !== before.pool) {
      outside = (await resolveHost(parseHost(host).host)).outside;
      if (outside && pool === "private" && !offNetworkConfirmed) throw new Error(`${host} resolves outside your network; confirm it anyway`);
    }
    const a = s.updateGitAccount(name, rest);
    s.setGitOffNetwork(a.name, outside);
    this.gitRefused.delete(`${userId}/${name}`);
    return s.gitAccount(a.name)!;
  }

  /** Replace token: the new one is checked against the host before it replaces the old. */
  async setGitToken(userId: string, name: string, token: string): Promise<GitAccountConfig> {
    const s = this.settings(userId);
    const a = s.gitAccount(name);
    if (!a) throw new Error(`no Git account ${name}`);
    await this.probeGitAccount({ ...a, token });
    return s.setGitToken(name, token, "signedIn");
  }

  confirmGitOffNetwork(userId: string, name: string): GitAccountConfig {
    this.gitRefused.delete(`${userId}/${name}`);
    return this.settings(userId).confirmGitOffNetwork(name);
  }

  removeGitAccount(userId: string, name: string): void {
    this.settings(userId).removeGitAccount(name);
    this.gitRefused.delete(`${userId}/${name}`);
  }

  /**
   * The repositories a Git account can see, matching `q`, for Add
   * repository: from its forge's API. Other has none to list; the person
   * pastes a URL. Records the account's state.
   */
  async listRepositories(userId: string, name: string, q = ""): Promise<GitRepositoryInfo[]> {
    const s = this.settings(userId);
    const a = s.gitAccount(name);
    if (!a) throw new Error(`no Git account ${name}`);
    if (a.kind === "other") return [];
    if (this.gitRefused.has(`${userId}/${a.name}`)) return [];
    let names: string[];
    try {
      const path = a.kind === "github" ? "/user/repos?per_page=100&sort=pushed" : `/repos/search?limit=50&q=${encodeURIComponent(q)}`;
      const body = await this.forgeApi(a, path) as { full_name?: string }[] | { data?: { full_name?: string }[] };
      names = (Array.isArray(body) ? body : body.data ?? []).map((r) => String(r.full_name ?? "")).filter(Boolean);
      s.gitAccountState(a.name, "signedIn");
    } catch (err) {
      if (err instanceof GitAccountProblem) s.gitAccountState(a.name, err.state);
      throw err;
    }
    const want = q.trim().toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(want)).slice(0, 50).map((n) => ({ name: n, account: a.name }));
  }

  /**
   * The MCP servers the thread may use now: granted by it and every
   * ancestor, of its pool, and not held back because a private one's host
   * left her network. Its session registers exactly these.
   */
  mcpServersFor(t: WorkspaceThread): ThreadMcpServer[] {
    const s = this.settings(t.userId);
    return s.effective(t.threadId).mcpServers.flatMap((name) => {
      const m = s.mcpServer(name);
      if (!m || m.pool !== t.pool || this.mcpRefused.has(`${t.userId}/${m.name}`)) return [];
      return [{ name: m.name, url: m.url, token: m.token, description: m.description }];
    });
  }

  /** Checks the thread's private servers' hosts, as for a private Git account: what is held back, one plain line each. */
  async checkMcpServers(t: WorkspaceThread): Promise<string[]> {
    const s = this.settings(t.userId);
    const problems: string[] = [];
    for (const name of s.effective(t.threadId).mcpServers) {
      const m = s.mcpServer(name);
      if (!m || m.pool !== t.pool) continue;
      const refused = await this.checkMcpHost(t.userId, m).then(() => undefined, (err: Error) => err.message);
      if (refused) problems.push(refused);
    }
    return problems;
  }

  private async checkMcpHost(userId: string, m: McpServerConfig): Promise<void> {
    const s = this.settings(userId);
    const key = `${userId}/${m.name}`;
    let outside: boolean;
    try {
      outside = (await resolveHost(parseHost(mcpHost(m.url)).host)).outside;
    } catch {
      s.mcpServerState(m.name, "unreachable");
      return;
    }
    if (outside && m.pool === "private" && !m.offNetwork) {
      this.mcpRefused.add(key);
      throw new Error(`${mcpHost(m.url)} now resolves outside your network, so the MCP server ${m.name} isn't used; confirm it in Settings → MCP servers to use it again.`);
    }
    this.mcpRefused.delete(key);
    if (outside !== m.offNetwork) s.setMcpOffNetwork(m.name, outside);
  }

  /** A server's check before anything is saved: `initialize` and `tools/list` must answer. Throws McpServerProblem. */
  probeMcpServer(url: string, token?: string): Promise<McpProbe> {
    return probeMcp(mcpUrl(url), token?.trim() || undefined, this.opts.forgeFetch);
  }

  /** Whether a server's host resolves outside her network; a private one needs Li's confirmation then. */
  private async mcpOutside(url: string, pool: Pool, confirmed: boolean | undefined): Promise<boolean> {
    const host = mcpHost(url);
    const { outside } = await resolveHost(parseHost(host).host);
    if (outside && pool === "private" && !confirmed) throw new Error(`${host} resolves outside your network; confirm adding it anyway`);
    return outside;
  }

  /** Saves a server once it answers. A private server's host must resolve on her own network, or `offNetworkConfirmed` (the Add anyway dialog). */
  async addMcpServer(userId: string, input: { name: string; url: string; token?: string; pool: Pool; offNetworkConfirmed?: boolean }): Promise<McpServerConfig> {
    const s = this.settings(userId);
    if (s.mcpServer(input.name)) throw new Error(`MCP server ${input.name} already exists`);
    const url = mcpUrl(input.url, input.pool, input.token?.trim());
    const outside = await this.mcpOutside(url, input.pool, input.offNetworkConfirmed);
    const token = input.token?.trim() ?? "";
    const probe = await this.probeMcpServer(url, token);
    return s.addMcpServer({ name: input.name, url, token, pool: input.pool, description: probe.description, tools: probe.tools, offNetwork: outside }, "online");
  }

  /** Changes a server's name, URL or pool. A new URL is checked again; a private one moved off her network needs `offNetworkConfirmed`. */
  async updateMcpServer(userId: string, name: string, change: { name?: string; url?: string; pool?: Pool; offNetworkConfirmed?: boolean }): Promise<McpServerConfig> {
    const s = this.settings(userId);
    const before = s.mcpServer(name);
    if (!before) throw new Error(`no MCP server ${name}`);
    const pool = change.pool ?? before.pool;
    const url = change.url === undefined ? before.url : mcpUrl(change.url, pool, before.token);
    let outside = before.offNetwork;
    let probe: McpProbe | undefined;
    if (url !== before.url || pool !== before.pool) outside = await this.mcpOutside(url, pool, change.offNetworkConfirmed);
    if (url !== before.url) probe = await this.probeMcpServer(url, before.token);
    const m = s.updateMcpServer(name, { ...(change.name !== undefined ? { name: change.name } : {}), url, pool, ...(probe ? { description: probe.description, tools: probe.tools } : {}) });
    s.setMcpOffNetwork(m.name, outside);
    if (probe) s.mcpServerState(m.name, "online");
    this.mcpRefused.delete(`${userId}/${name}`);
    return s.mcpServer(m.name)!;
  }

  /** Replace token: the server is checked with the new one before it replaces the old. An empty token sends none. */
  async setMcpToken(userId: string, name: string, token: string): Promise<McpServerConfig> {
    const s = this.settings(userId);
    const m = s.mcpServer(name);
    if (!m) throw new Error(`no MCP server ${name}`);
    const probe = await this.probeMcpServer(m.url, token);
    s.updateMcpServer(name, { description: probe.description, tools: probe.tools });
    return s.setMcpToken(name, token.trim(), "online");
  }

  confirmMcpOffNetwork(userId: string, name: string): McpServerConfig {
    this.mcpRefused.delete(`${userId}/${name}`);
    return this.settings(userId).confirmMcpOffNetwork(name);
  }

  removeMcpServer(userId: string, name: string): void {
    this.settings(userId).removeMcpServer(name);
    this.mcpRefused.delete(`${userId}/${name}`);
  }

  private ssh(userId: string, name: string): SshTarget {
    const key = `${userId}/${name}`;
    let target = this.sshTargets.get(key);
    if (!target) {
      const s = this.settings(userId);
      const cfg = s.machine(name);
      if (!cfg) throw new Error(`no machine ${name}`);
      target = new SshTarget(cfg, {
        transport: this.sshTransport,
        address: () => this.checkAddress(userId, name),
        connected: () => { s.usedMachine(name); s.machineState(name, "online"); },
        failed: (keyChanged) => s.machineState(name, keyChanged ? "keyChanged" : "unreachable"),
      });
      this.sshTargets.set(key, target);
    }
    return target;
  }

  /** Drops a machine's open connection, so a changed setting applies to the next call. */
  private disconnect(userId: string, name: string): void {
    this.sshTargets.get(`${userId}/${name}`)?.close();
    this.sshTargets.delete(`${userId}/${name}`);
  }

  /**
   * Checks a machine's address before each connection and returns the one to
   * connect to. A private machine that has newly gone off network is refused
   * until Li confirms again, so a DNS change can't get past the warning.
   */
  private async checkAddress(userId: string, name: string): Promise<string> {
    const s = this.settings(userId);
    const m = s.machine(name);
    if (!m) throw new Error(`no machine ${name}`);
    let resolved: { addresses: string[]; outside: boolean };
    try {
      resolved = await resolveHost(m.host);
    } catch (err) {
      // A name that no longer resolves can't be reached; the off-network refusal below has its own state.
      try { s.machineState(name, "unreachable"); } catch { /* shown only */ }
      throw err;
    }
    const { addresses, outside } = resolved;
    if (outside && m.pool === "private" && !m.offNetwork) {
      throw new Error(`${m.host} now resolves outside your network (${addresses.join(", ")}); confirm it in Settings to use it again`);
    }
    if (outside !== m.offNetwork) s.setOffNetwork(name, outside);
    return addresses[0]!;
  }

  /**
   * The first steps of adding a machine: a key pair kept in memory for it
   * (or the one from an earlier probe), its setup steps, and a test that
   * reads the host key and tries the key. Nothing is saved.
   */
  async probeMachine(userId: string, login: string, input: { kind?: MachineKind; name: string; address: string; draft?: string }): Promise<MachineProbe> {
    if (input.kind === "proxmox") return this.probeProxmox(input.address);
    const now = Date.now();
    for (const [id, d] of this.drafts) if (d.expires < now) this.drafts.delete(id);
    const { username, host, port } = parseMachineAddress(input.address);
    let draft = input.draft;
    let pair = draft ? this.drafts.get(draft) : undefined;
    if (!pair || pair.userId !== userId) {
      draft = randomBytes(12).toString("hex");
      pair = { userId, ...generateSshKey(`lyrica:${login}:${input.name}`), expires: 0 };
      this.drafts.set(draft, pair);
    }
    pair.expires = now + DRAFT_MS;
    const keyLine = authorizedKeysLine(pair.publicKey);
    const base = { draft: draft!, keyLine, setup: machineSetup(username, keyLine) };
    let resolved: { addresses: string[]; outside: boolean };
    try {
      resolved = await resolveHost(host);
    } catch (err) {
      return { ...base, login: false, offNetwork: false, problem: (err as Error).message };
    }
    let fingerprint: string | undefined;
    try {
      // The key it shows is only reported: nothing runs, and the connection closes once she's in.
      const session = await this.sshTransport.connect(
        { host: resolved.addresses[0]!, port, username, privateKey: pair.privateKey }, (fp) => { fingerprint = fp; return true; });
      session.close();
      return { ...base, fingerprint, login: true, offNetwork: resolved.outside };
    } catch (err) {
      return { ...base, ...(fingerprint ? { fingerprint } : {}), login: false, offNetwork: resolved.outside, problem: (err as Error).message };
    }
  }

  /** Proxmox's Test step: its certificate's fingerprint and the setup steps. The token isn't sent before Li confirms the certificate. */
  private async probeProxmox(address: string): Promise<MachineProbe> {
    const { host, port } = parseProxmoxAddress(address);
    const base = { setup: proxmoxSetup(), login: false };
    let resolved: { addresses: string[]; outside: boolean };
    try {
      resolved = await resolveHost(host);
    } catch (err) {
      return { ...base, offNetwork: false, problem: (err as Error).message };
    }
    try {
      return { ...base, fingerprint: await this.proxmoxTransport().fingerprint(resolved.addresses[0]!, port), offNetwork: resolved.outside };
    } catch (err) {
      return { ...base, offNetwork: resolved.outside, problem: (err as Error).message };
    }
  }

  private proxmoxTransport(): ProxmoxTransport { return this.opts.proxmoxTransport ?? proxmoxHttps; }

  /** Calls to a Proxmox at `address` with `token`, sent only to the certificate `pinned`. */
  private proxmoxApi(address: string, port: number, token: string, pinned: string): ProxmoxCall {
    const transport = this.proxmoxTransport();
    return (method, path) => transport.call({ host: address, port, token }, method, path, (fp) => !!fp && fp.toUpperCase() === pinned);
  }

  /**
   * Tries a Proxmox token against the confirmed certificate, and refuses the
   * Proxmox that runs Lyrica's own VM where it can tell.
   */
  private async checkProxmox(addresses: string[], port: number, token: string, pinned: string): Promise<void> {
    const api = this.proxmoxApi(addresses[0]!, port, token, pinned);
    try {
      await api("GET", "/version");
    } catch (err) {
      throw new Error(`the token didn't work: ${(err as Error).message}`);
    }
    this.refuseOwn(await ownNode(api, addresses, this.self()));
  }

  private self(): Self { return (this.opts.self ?? thisComputer)(); }

  private refuseOwn(why: string | undefined): void {
    if (why) throw new Error(`this Proxmox can't be used: ${why}. Stopping it would stop her, so it stays off the list for now.`);
  }

  /** One action on a thread's Proxmox machine, after its address check, sent only to the certificate Li confirmed. */
  async proxmox(t: WorkspaceThread, machine: string, action: ProxmoxAction, vm?: string): Promise<string> {
    this.settings(t.userId).checkInherited(t.threadId, t.pool);
    if (!this.machinesFor(t).some((m) => m.name === machine && m.kind === "proxmox")) throw new Error(`${machine} isn't one of this thread's Proxmox machines`);
    const s = this.settings(t.userId);
    const cfg = s.machine(machine)!;
    if (!cfg.hostKey) throw new Error(`confirm ${machine}'s certificate in Settings first`);
    const address = await this.checkAddress(t.userId, machine);
    // A changed address or name can point at her own node later: checked on every call.
    this.refuseOwn(ownAddress([address], this.self()));
    const result = await proxmoxAction(this.proxmoxApi(address, cfg.port, cfg.privateKey, cfg.hostKey), action, vm);
    s.usedMachine(machine);
    return result;
  }

  /**
   * Saves a machine with the key from its probe (for Proxmox, the token) and
   * the host key or certificate Li confirmed. Its address is checked now: a
   * private machine off network needs `offNetworkConfirmed`, which the Add
   * anyway dialog gives. A Proxmox token is tried first, and the Proxmox
   * that runs Lyrica is refused.
   */
  async addMachine(userId: string, input: Omit<NewMachine, "privateKey" | "offNetwork" | "host" | "port" | "username"> & {
    address: string; draft?: string; token?: string; hostKey: string; offNetworkConfirmed?: boolean;
  }): Promise<MachineConfig> {
    if (input.kind === "proxmox") {
      const { host, port } = parseProxmoxAddress(input.address);
      const token = String(input.token ?? "").trim();
      const id = tokenId(token);
      const pinned = certFingerprint(input.hostKey);
      const { addresses, outside } = await resolveHost(host);
      if (outside && input.pool === "private" && !input.offNetworkConfirmed) throw new Error(`${host} resolves outside your network; confirm adding it anyway`);
      if (this.settings(userId).machine(input.name)) throw new Error(`machine ${input.name} already exists`);
      await this.checkProxmox(addresses, port, token, pinned);
      return this.settings(userId).addMachine({
        kind: "proxmox", name: input.name, host, port, username: id, privateKey: token, root: null, pool: input.pool, limit: input.limit, offNetwork: outside,
      }, pinned);
    }
    if (!input.draft) throw new Error("test the machine first");
    const pair = this.drafts.get(input.draft);
    if (!pair || pair.userId !== userId || pair.expires < Date.now()) throw new Error("test the machine again: its key has expired");
    const { username, host, port } = parseMachineAddress(input.address);
    const { outside } = await resolveHost(host);
    if (outside && input.pool === "private" && !input.offNetworkConfirmed) throw new Error(`${host} resolves outside your network; confirm adding it anyway`);
    const m = this.settings(userId).addMachine({
      name: input.name, host, port, username, privateKey: pair.privateKey, root: input.root, pool: input.pool, limit: input.limit, offNetwork: outside,
    }, input.hostKey);
    this.drafts.delete(input.draft);
    return m;
  }

  /** Changes a machine's address, root, limit or pool; a new pool takes it from every thread that granted it. */
  async updateMachine(userId: string, name: string, change: { address?: string; root?: string | null; limit?: MachineLimit; pool?: Pool }): Promise<MachineConfig> {
    const s = this.settings(userId);
    const before = s.machine(name);
    const kind = before?.kind;
    const address = change.address === undefined ? {} : kind === "proxmox" ? parseProxmoxAddress(change.address) : parseMachineAddress(change.address);
    // A Proxmox moved onto her own node's address is refused, as when adding.
    if (kind === "proxmox" && change.address !== undefined) this.refuseOwn(ownAddress((await resolveHost(parseProxmoxAddress(change.address).host)).addresses, this.self()));
    let m = s.updateMachine(name, { ...address, ...(change.root !== undefined ? { root: change.root || null } : {}), ...(change.limit ? { limit: change.limit } : {}) });
    if (change.pool) m = s.setMachinePool(name, change.pool);
    if (change.address !== undefined && (m.host !== before?.host || m.port !== before?.port || m.username !== before?.username)) {
      s.machineState(name, null);
      m = s.machine(name)!;
    }
    this.disconnect(userId, name);
    return m;
  }

  /**
   * Re-pairs a machine whose host key (or certificate) changed, with the one
   * Li confirmed. A Proxmox machine may get a new token too, tried against
   * that certificate before anything is saved.
   */
  async setHostKey(userId: string, name: string, confirmedHostKey: string, token?: string): Promise<MachineConfig> {
    const s = this.settings(userId);
    const m = s.machine(name);
    if (!m) throw new Error(`no machine ${name}`);
    if (token !== undefined && m.kind !== "proxmox") throw new Error(`${name} isn't a Proxmox machine`);
    if (m.kind === "proxmox") {
      const pinned = certFingerprint(confirmedHostKey);
      const next = token?.trim() || m.privateKey;
      const id = tokenId(next);
      await this.checkProxmox([await this.checkAddress(userId, name)], m.port, next, pinned);
      if (token !== undefined) s.setToken(name, next, id);
    }
    const done = s.setHostKey(name, confirmedHostKey);
    this.disconnect(userId, name);
    return done;
  }

  confirmOffNetwork(userId: string, name: string): MachineConfig {
    return this.settings(userId).confirmOffNetwork(name);
  }

  removeMachine(userId: string, name: string): void {
    this.settings(userId).removeMachine(name);
    this.disconnect(userId, name);
  }

  /**
   * Saves an uploaded file into the thread's uploads/ folder, from inside a
   * sandbox. The name is cleaned, and a name already taken gets a suffix
   * ("image-2.jpg"), so nothing is overwritten. Returns the path she sees.
   */
  async saveUpload(t: WorkspaceThread, name: string, bytes: Buffer): Promise<string> {
    const clean = cleanUploadName(name);
    const dot = clean.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    // noclobber makes taking the name atomic: a file that appears meanwhile is never overwritten.
    const script = 'mkdir -p uploads && n="$1$2" && i=2 && until (set -C; cat > "uploads/$n") 2>/dev/null; do ' +
      '[ "$i" -gt 999 ] && exit 1; n="$1-$i$2"; i=$((i+1)); done && printf %s "$n"';
    const box = new Sandbox({ workdir: this.threadDir(t), grants: [], network: { internet: false, services: false, hosts: [] }, bwrap: this.opts.bwrap });
    const r = await box.run(["sh", "-c", script, "sh", stem, ext], { input: bytes });
    if (r.code !== 0) throw new Error(`could not save ${clean}: ${r.stderr.toString().trim()}`);
    return `${WORKDIR}/uploads/${r.stdout.toString()}`;
  }
}

/** A token that didn't work, or a host that didn't answer: the state it leaves the account in, and why. */
export class GitAccountProblem extends Error {
  constructor(readonly state: Exclude<GitAccountState["kind"], "signedIn">, message: string) { super(message); this.name = "GitAccountProblem"; }
}

/** What a failed clone or fetch says about the account: its token refused, its host away, or neither. */
function gitFailure(stderr: string): GitAccountState["kind"] | undefined {
  if (/Authentication failed|could not read Username|terminal prompts disabled|returned error: 40[13]|HTTP 40[13]/i.test(stderr)) return "rejected";
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused)|Network is unreachable|Operation timed out/i.test(stderr)) return "unreachable";
  return undefined;
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.replace(/^fatal: /, "").slice(0, 300) || "git failed";
