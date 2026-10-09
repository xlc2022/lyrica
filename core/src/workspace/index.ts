import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Locked, type Keyring } from "../keyring.ts";
import type { Pool } from "../types.ts";
import type { Users } from "../users.ts";
import { isMounted, mountGocryptfs, unmountGocryptfs } from "./home.ts";
import type { ExecutionTarget } from "./ops.ts";
import { Sandbox, WORKDIR } from "./sandbox.ts";
import { checkGrant, WorkspaceSettings, type Grant, type ThreadWorkspace } from "./settings.ts";
import { SshTarget } from "./ssh.ts";

export * from "./home.ts";
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

const safeName = (name: string, what: string) => {
  if (!/^[A-Za-z0-9._:@ ()+,-]{1,200}$/.test(name) || name === "." || name === "..") throw new Error(`unusable ${what}: ${name}`);
  return name;
};

/**
 * Where Lyrica's file and command tools run, and what they may touch. One per
 * lyricad. Settings come from each user's user.db, so the user must be unlocked.
 */
export class Workspace {
  private readonly settingsByUser = new Map<string, WorkspaceSettings>();
  private readonly sshTargets = new Map<string, SshTarget>();

  constructor(private readonly keyring: Keyring, private readonly users: Users, private readonly opts: { bwrap?: string } = {}) {}

  settings(userId: string): WorkspaceSettings {
    let s = this.settingsByUser.get(userId);
    if (!s) {
      s = new WorkspaceSettings(this.users.openUserDb(userId), this.keyring.home);
      this.settingsByUser.set(userId, s);
    }
    return s;
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
    const dir = join(home, "threads", safeName(id, "thread id"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
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
      network: s.network(t.threadId, t.pool),
      check: (g) => checkGrant(s.allowed(), t.pool, g),
      bwrap: this.opts.bwrap,
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

  /** Saves an uploaded file into the thread's uploads/ folder, from inside a sandbox. Returns the path she sees. */
  async saveUpload(t: WorkspaceThread, name: string, bytes: Buffer): Promise<string> {
    safeName(name, "file name");
    const box = new Sandbox({ workdir: this.threadDir(t), grants: [], network: false, bwrap: this.opts.bwrap });
    const r = await box.run(["sh", "-c", 'mkdir -p uploads && cat > "uploads/$1"', "sh", name], { input: bytes });
    if (r.code !== 0) throw new Error(`could not save ${name}: ${r.stderr.toString().trim()}`);
    return `${WORKDIR}/uploads/${name}`;
  }
}
