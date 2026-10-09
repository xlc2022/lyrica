import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Locked, type Keyring } from "../keyring.ts";
import type { Pool } from "../types.ts";
import type { Users } from "../users.ts";
import { isMounted, mountGocryptfs, unmountGocryptfs } from "./home.ts";
import type { ExecutionTarget } from "./ops.ts";
import { Sandbox, WORKDIR } from "./sandbox.ts";
import { checkGrant, WorkspaceSettings, type Grant, type Network, type ThreadWorkspace } from "./settings.ts";
import { AllowedPaths } from "./paths.ts";
import { SshTarget } from "./ssh.ts";

export * from "./home.ts";
export * from "./net.ts";
export * from "./paths.ts";
export * from "./ops.ts";
export * from "./sandbox.ts";
export * from "./settings.ts";
export * from "./ssh.ts";

/** The parts of a thread the workspace needs. */
export interface WorkspaceThread {
  userId: string;
  pool: Pool;
  threadId: string;
}

/** An uploaded file's name made safe: no path, no control characters, at most 120 characters. */
export function cleanUploadName(name: string): string {
  const base = name.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N}._:@ ()+,'&-]/gu, "_").replace(/^[.\s]+/, "").trim().slice(0, 120);
  return clean || "upload";
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
}

/**
 * Where Lyrica's file and command tools run, and what they may touch. One per
 * lyricad. Thread settings come from each user's user.db, so the user must be
 * unlocked; the folders each user may grant are in self.db.
 */
export class Workspace {
  private readonly settingsByUser = new Map<string, WorkspaceSettings>();
  private readonly sshTargets = new Map<string, SshTarget>();
  /** Which folders each user may grant. Only administrators change them. */
  readonly allowedPaths: AllowedPaths;

  constructor(private readonly keyring: Keyring, private readonly users: Users, private readonly opts: WorkspaceOptions) {
    this.allowedPaths = new AllowedPaths(keyring.self(), users, keyring.home);
  }

  settings(userId: string): WorkspaceSettings {
    let s = this.settingsByUser.get(userId);
    if (!s) {
      s = new WorkspaceSettings(this.users.openUserDb(userId), () => this.allowedPaths.list(userId));
      this.settingsByUser.set(userId, s);
    }
    return s;
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

  /** One thread's target, settings, internet switch and folders, each read fresh when called. */
  forThread(t: WorkspaceThread) {
    return {
      target: () => this.targetFor(t),
      settings: () => this.settings(t.userId).thread(t.threadId),
      network: (): Network => this.network(t),
      folders: () => this.folders(t),
    };
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

  /** What the thread works in: host folders, or `<ssh name>:<root>`. Memory loads pages about them. */
  folders(t: WorkspaceThread): string[] {
    const tw = this.settings(t.userId).thread(t.threadId);
    if (tw.target === "sandbox") return tw.grants.map((g) => g.path);
    const root = this.settings(t.userId).ssh(tw.target.slice(4))?.root;
    return root ? [`${tw.target.slice(4)}:${root}`] : [];
  }

  targetFor(t: WorkspaceThread): ExecutionTarget {
    const s = this.settings(t.userId);
    const tw = s.thread(t.threadId);
    s.checkInherited(t.threadId, t.pool);
    if (tw.target !== "sandbox") return this.ssh(t.userId, tw.target.slice(4));
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
      const cfg = s.ssh(name);
      if (!cfg) throw new Error(`no ssh target ${name}`);
      target = new SshTarget(cfg, (fp) => s.recordHostKey(name, fp));
      this.sshTargets.set(key, target);
    }
    return target;
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
