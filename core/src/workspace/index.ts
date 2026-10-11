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
import { checkGrant, stricterMode, WorkspaceSettings, type Grant, type MachineConfig, type MachineKind, type MachineLimit, type Network, type NewMachine, type PermissionMode, type ThreadWorkspace } from "./settings.ts";
import { AllowedPaths } from "./paths.ts";
import { generateSshKey, SshTarget } from "./ssh.ts";
import { sandboxedTransport, type SshTransport } from "./transport.ts";

export * from "./changes.ts";
export * from "./files.ts";
export * from "./home.ts";
export * from "./machines.ts";
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
}

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
      /** One action on one of the thread's Proxmox machines. */
      proxmox: (machine: string, action: ProxmoxAction, vm?: string) => this.proxmox(t, machine, action, vm),
      /** Whether Li allowed this exact suspect command on this machine in this thread. */
      allowedInThread: (machine: string, command: string) =>
        this.settings(t.userId).allowedInThread(t.threadId).some((a) => a.machine === machine && a.command === command),
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
    const tw = s.thread(t.threadId);
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

  grantsFor(t: WorkspaceThread): Grant[] { return this.settings(t.userId).thread(t.threadId).grants; }

  /** What the thread works in: host folders, and `<machine>:<root>` for its machines with a root. Memory loads pages about them. */
  folders(t: WorkspaceThread): string[] {
    const tw = this.settings(t.userId).thread(t.threadId);
    return [...tw.grants.map((g) => g.path), ...this.machinesFor(t).filter((m) => m.root).map((m) => `${m.name}:${m.root}`)];
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
    const tw = s.thread(t.threadId);
    return new Sandbox({
      workdir: this.threadDir(t),
      grants: tw.grants,
      network: this.network(t),
      ...this.door(),
      check: (g) => checkGrant(s.allowed(), t.pool, g),
      bwrap: this.opts.bwrap,
      pasta: this.opts.pasta,
    });
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
