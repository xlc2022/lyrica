import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, openSync, readlinkSync } from "node:fs";
import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { capOutput, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { hostAddresses, nftRules, pastaArgs, resolveAddresses, resolveHosts, SANDBOX_GATEWAY } from "./net.ts";
import { cleanPath, within, type Grant, type Network } from "./settings.ts";

/** The thread's folder in the home workspace, as she sees it. */
export const WORKDIR = "/workspace";

export interface SandboxSpec {
  /** Host path of the thread's folder in the home workspace. Mounted read-write at /workspace. */
  workdir: string;
  grants: Grant[];
  network: Network;
  /** Ports never reachable on any address, whatever the switches say: lyricad's own. */
  exclude?: number[];
  /** Ports never reachable on this machine's own addresses: lyricad's front door (Caddy). */
  front?: number[];
  /** This machine's own addresses. Defaults to the host's, read at each run. */
  self?: string[];
  /** Other hosts (IPs or names, resolved at each run) where the front ports are never reachable: an external proxy, Lyrica's name. */
  frontHosts?: string[];
  /**
   * Called with each grant's real path just before it is mounted, so the
   * grant can be checked against the current settings. Throws to refuse.
   */
  check?: (grant: Grant) => void;
  bwrap?: string;
  pasta?: string;
}

// A minimal read-only system. /etc is picked file by file, so host secrets
// that happen to be world-readable stay out.
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64"];
const ETC = [
  "alternatives", "ssl", "ca-certificates", "pki", "nsswitch.conf", "localtime",
  "passwd", "group", "ld.so.cache", "ld.so.conf", "ld.so.conf.d", "os-release",
].map((f) => `/etc/${f}`);
// /usr/sbin is for nft, which runs before bwrap; the sandbox's PATH is the same.
const ENV = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: WORKDIR, LANG: "C.UTF-8", TERM: "dumb" };
// Loads the firewall into pasta's namespace, then starts bwrap. Fails closed if nft fails.
const LOAD_RULES = 'printf "%s" "$1" | nft -f - || exit 125; shift; exec "$@"';

export class SandboxDenied extends Error {}

/**
 * Writes stdin to "$1". For a file she owns (or a new one), atomically: a
 * temp file in the same folder with the old file's mode and group (or the
 * usual mode for a new file), then a rename over the target, so a reader
 * sees the old content or the new, never a truncated file. A file someone
 * else owns, one whose group can't be kept, or one in a folder she can't
 * create files in is written in place, so it keeps its owner, group and
 * permissions. A symlink at the target is refused rather than followed.
 */
const WRITE = [
  't="$1"',
  'if [ -L "$t" ]; then echo "$t is a symlink; not writing through it" >&2; exit 1; fi',
  'if [ -e "$t" ] && [ ! -O "$t" ]; then exec cat > "$t"; fi',
  'tmp=$(mktemp "$(dirname -- "$t")/.$(basename -- "$t").XXXXXX" 2>/dev/null) || exec cat > "$t"',
  "trap 'rm -f -- \"$tmp\"' EXIT",
  'if [ -e "$t" ]; then',
  '  chmod --reference="$t" -- "$tmp" || exit 1',
  '  if [ "$(stat -c %g -- "$t")" != "$(stat -c %g -- "$tmp")" ] && ! chgrp --reference="$t" -- "$tmp" 2>/dev/null; then',
  '    rm -f -- "$tmp"; trap - EXIT; exec cat > "$t"',
  '  fi',
  'else',
  '  chmod "$(printf %o $((0666 & ~$(umask))))" -- "$tmp" || exit 1',
  'fi',
  'cat > "$tmp" && mv -f -T -- "$tmp" "$t"',
].join("\n");

interface RunOptions {
  cwd?: string;
  input?: string | Buffer;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Runs commands in bubblewrap with every namespace unshared. Only the
 * thread's folder, its grants and a read-only system exist inside. Each
 * operation, including file reads and writes, is a fresh sandbox, so paths
 * and symlinks resolve inside it, never on the host.
 */
export class Sandbox implements ExecutionTarget {
  readonly name = "sandbox";
  private readonly grants: Grant[];

  constructor(private readonly spec: SandboxSpec) {
    // Shallow first, so a read-only grant inside a writable one stays read-only.
    this.grants = spec.grants.map((g) => ({ ...g, path: cleanPath(g.path) }))
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  }

  async cwd(): Promise<string> { return WORKDIR; }

  folders(): string[] { return this.grants.map((g) => g.path); }

  /** Refuses paths outside the thread's folder and grants. The mounts confine her regardless. */
  private allow(path: string, write: boolean): string {
    const p = cleanPath(path);
    if (within(p, WORKDIR)) return p;
    const grant = [...this.grants].reverse().find((g) => within(p, g.path));
    if (!grant) throw new SandboxDenied(`${p} is outside this thread's folders`);
    if (write && !grant.writable) throw new SandboxDenied(`${grant.path} is read-only in this thread`);
    return p;
  }

  /** Runs argv inside a fresh sandbox. */
  async run(argv: string[], o: RunOptions = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }> {
    let { internet, services, hosts } = this.spec.network;
    // The front door's names must resolve (now or before), or this run gets no network at all: its rules can't be trusted.
    const frontAddresses = internet || services || hosts.length ? await resolveAddresses(this.spec.frontHosts ?? []) : [];
    if (!frontAddresses) [internet, services, hosts] = [false, false, []];
    const networked = internet || services || hosts.length > 0;
    const resolved = await resolveHosts(hosts);
    // Files written into the sandbox's /etc. Hostnames are pinned when it starts;
    // with internet off there is no resolver at all, so DNS can't carry data out.
    const data = [
      ["/etc/hosts", ["127.0.0.1 localhost", "::1 localhost", ...resolved.pinned].join("\n") + "\n"],
      ["/etc/resolv.conf", internet ? `nameserver ${SANDBOX_GATEWAY}\n` : ""],
    ] as const;
    const fds: number[] = [];
    let args: string[];
    try {
      args = this.args(fds, o.cwd ?? WORKDIR, networked);
    } catch (err) {
      for (const fd of fds) closeSync(fd);
      throw err;
    }
    data.forEach(([dest], i) => args.push("--ro-bind-data", String(3 + fds.length + i), dest));
    let cmd = [this.spec.bwrap ?? "bwrap", ...args, "--", ...argv];
    if (networked) {
      const exclude = this.spec.exclude ?? [];
      const rules = nftRules(internet, resolved.rules, exclude, {
        addresses: this.spec.self ?? hostAddresses(), services, front: this.spec.front ?? [],
        frontAddresses: frontAddresses ?? [],
      });
      // The front ports are never forwarded from loopback either, in case the proxy listens on every address.
      cmd = [this.spec.pasta ?? "pasta", ...pastaArgs({ internet, services, hosts: hosts.length > 0 }, [...exclude, ...(this.spec.front ?? [])]),
        "--", "sh", "-c", LOAD_RULES, "sh", rules, ...cmd];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(cmd[0]!, cmd.slice(1), {
        env: ENV,
        stdio: ["pipe", "pipe", "pipe", ...fds, ...data.map(() => "pipe" as const)],
      });
      for (const fd of fds) closeSync(fd);
      data.forEach(([, text], i) => {
        const pipe = child.stdio[3 + fds.length + i] as Writable;
        pipe.on("error", () => {}); // if bwrap or pasta never starts, the spawn error is what's reported
        pipe.end(text);
      });
      const { stdin, stdout, stderr } = child as unknown as { stdin: Writable; stdout: Readable; stderr: Readable };
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      stdout.on("data", (d: Buffer) => (o.onData ? o.onData(d) : out.push(d)));
      stderr.on("data", (d: Buffer) => (o.onData ? o.onData(d) : err.push(d)));
      stdin.on("error", () => {}); // the command may exit without reading its input
      stdin.end(o.input ?? "");
      let stopped: Error | undefined;
      const stop = (why: Error) => { stopped = why; child.kill("SIGKILL"); };
      const timer = o.timeoutMs ? setTimeout(() => stop(new Error(`timeout:${o.timeoutMs! / 1000}`)), o.timeoutMs) : undefined;
      const onAbort = () => stop(new Error("aborted"));
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.signal?.aborted) onAbort();
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (stopped) reject(stopped);
        else resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      });
    });
  }

  /** bwrap arguments. Opens each folder to mount and appends its fd to `fds` (child fd 3, 4, …). */
  private args(fds: number[], cwd: string, networked: boolean): string[] {
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"];
    // With network on, bwrap runs inside pasta's own namespace and keeps it.
    // The host's network is never shared.
    if (networked) args.push("--share-net");
    for (const dir of SYSTEM_DIRS) {
      if (!existsSync(dir)) continue;
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(dir), dir);
      else args.push("--ro-bind", dir, dir);
    }
    for (const f of ETC) args.push("--ro-bind-try", f, f);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

    // Folders are opened here and mounted by fd. The path the fd really
    // points to is checked, so a symlink swapped in by a running command
    // can't redirect a mount.
    const mount = (path: string, writable: boolean, dest: string, check?: () => void) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fds.push(fd);
      const real = readlinkSync(`/proc/self/fd/${fd}`);
      if (real !== path) throw new SandboxDenied(`${path} now resolves to ${real}; refusing to mount it`);
      check?.();
      args.push(writable ? "--bind-fd" : "--ro-bind-fd", String(fds.length + 2), dest);
    };
    mount(cleanPath(this.spec.workdir), true, WORKDIR);
    for (const g of this.grants) mount(g.path, g.writable, g.path, () => this.spec.check?.(g));

    const visible = within(cwd, WORKDIR) || this.grants.some((g) => within(cwd, g.path));
    args.push("--chdir", visible ? cwd : WORKDIR);
    return args;
  }

  /** Runs a file operation and throws its error output if it fails. */
  private async file(argv: string[], input?: string | Buffer): Promise<Buffer> {
    const r = await this.run(argv, { input });
    if (r.code !== 0) throw new Error(r.stderr.toString().trim() || `${argv[0]} failed`);
    return r.stdout;
  }

  ops(): ToolOps {
    const readFile = async (p: string) => this.file(["cat", "--", this.allow(p, false)]);
    const writeFile = async (p: string, content: string | Buffer) => {
      await this.file(["sh", "-c", WRITE, "sh", this.allow(p, true)], content);
    };
    return {
      read: {
        readFile,
        access: async (p) => { await this.file(["sh", "-c", 'test -r "$1" || { echo "cannot read $1" >&2; exit 1; }', "sh", this.allow(p, false)]); },
        detectImageMimeType: async (p) => sniffImage(await this.file(["head", "-c", "16", "--", this.allow(p, false)])),
      },
      write: {
        writeFile,
        mkdir: async (dir) => { await this.file(["mkdir", "-p", "--", this.allow(dir, true)]); },
      },
      edit: {
        readFile,
        writeFile,
        access: async (p) => {
          await this.file(["sh", "-c", 'test -r "$1" && test -w "$1" || { echo "cannot edit $1" >&2; exit 1; }', "sh", this.allow(p, true)]);
        },
      },
      bash: {
        exec: async (command, cwd, { onData, signal, timeout }) => {
          const out = capOutput(onData);
          const r = await this.run(["bash", "-c", command], {
            cwd: posix.normalize(cwd), onData: (d) => out.push(d), signal, timeoutMs: timeout ? timeout * 1000 : undefined,
          });
          out.end();
          return { exitCode: r.code ?? (r.signal ? 128 + (signalNumbers[r.signal] ?? 0) : null) };
        },
      },
    };
  }
}

const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };
