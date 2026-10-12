import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { capOutput, maskSecrets, secretMasker, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { openClaudeRelay, type ClaudeRelay } from "./claude-relay.ts";
import { hostAddresses, nftRules, pastaArgs, resolveAddresses, resolveHosts, SANDBOX_GATEWAY } from "./net.ts";
import { cleanPath, within, type Grant, type Network } from "./settings.ts";

/** The thread's folder in the home workspace, as she sees it. */
export const WORKDIR = "/workspace";

export interface SandboxSpec {
  /** Host path of the thread's folder in the home workspace. Mounted read-write at /workspace. None for the SSH helper. */
  workdir?: string;
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
  /** Host files mounted read-only at the same path: the SSH helper's code. */
  files?: string[];
  /** Loopback TCP ports forwarded to the host's loopback, whatever the services switch says: an SSH machine on 127.0.0.1. */
  forward?: number[];
  /** Host path of the thread's own clones, mounted at /workspace/repos over whatever the folder holds there. */
  repos?: string;
  /** Mount `repos` read-only: a read-only subagent's view of its parent's clones. */
  reposReadOnly?: boolean;
  /** Added to the command's environment: Git tokens where Workspace.forgeEnv allows them. Never on the command line. */
  env?: Record<string, string>;
  /**
   * Claude Code for this run (Workspace.claudeCodeFor): the user's token,
   * which stays in this process. The run gets a relay (claude-relay.ts)
   * forwarded to its loopback, a capability in place of the token, and the
   * claude wrapper.
   */
  claude?: { token: string; upstream?: string };
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
// /usr/sbin is for nft, which runs in the new namespaces before bwrap; the sandbox's PATH is the same.
const PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
// On NixOS there's no /usr to share. The service sets LYRICA_SANDBOX_TOOLS to
// a Nix environment of the sandbox's tools, which becomes the sandbox's /usr,
// and LYRICA_SANDBOX_CLOSURE to the list of store paths it needs (closureInfo's
// store-paths): only those are mounted, never the whole store, which holds
// the system's generated configs. The tools' bin is first on the host's PATH
// too, for pasta, nft and bwrap.
const tools = () => process.env.LYRICA_SANDBOX_TOOLS || undefined;
const env = () => ({ PATH: tools() ? `${tools()}/bin:${PATH}` : PATH, HOME: WORKDIR, LANG: "C.UTF-8", TERM: "dumb" });
// The gh and tea wrappers for a run with repositories (forge.sh), first on its PATH.
const FORGE_BIN = "/run/lyrica/bin";
const FORGE = readFileSync(new URL("./forge.sh", import.meta.url), "utf8");
// The claude wrapper for a run with Claude Code (claude.sh), in the same folder.
const CLAUDE = readFileSync(new URL("./claude.sh", import.meta.url), "utf8");

/** Whether the `claude` program is among the sandbox's tools: in LYRICA_SANDBOX_TOOLS on NixOS, else in the host's /usr. */
export function claudeCodeInstalled(): boolean {
  const dirs = tools() ? [`${tools()}/bin`] : PATH.split(":");
  return dirs.some((d) => existsSync(`${d}/claude`));
}
const inStore = (p: string) => /^\/nix\/store\/[0-9a-z]{32}-[^/]+$/.test(p);
let closure: { file: string; paths: string[] } | undefined;
function nixSystem(dir: string): string[] {
  const file = process.env.LYRICA_SANDBOX_CLOSURE ?? "";
  if (!inStore(dir)) throw new SandboxDenied(`LYRICA_SANDBOX_TOOLS must be a /nix/store path, not ${dir}`);
  if (!file.startsWith("/nix/store/") || file.includes("..")) throw new SandboxDenied("LYRICA_SANDBOX_TOOLS needs LYRICA_SANDBOX_CLOSURE, a store-paths file in /nix/store");
  if (closure?.file !== file) {
    const paths = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const bad = paths.find((p) => !inStore(p));
    if (bad) throw new SandboxDenied(`${file} lists ${bad}, which isn't a store path`);
    closure = { file, paths };
  }
  if (!closure.paths.includes(dir)) throw new SandboxDenied(`${file} doesn't contain ${dir}`);
  return closure.paths;
}
// Loads the firewall into the new namespaces (fails closed), says so on
// fd $2, waits on fd $3 until pasta is attached, then starts bwrap.
const HOLD = 'printf "%s" "$1" | nft -f - || exit 125; r=$2; g=$3; shift 3; eval "echo ready >&$r; exec $r>&-; read -r _ <&$g; exec $g<&-"; exec "$@"';

/** Waits for the namespaces' "ready", or refuses with why they didn't come up. */
function signalled(child: ChildProcess, ready: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    // Its stderr is left to the caller, who reads the rest of the run's.
    const done = (e?: Error) => { ready.removeAllListeners("data"); child.off("exit", onExit); e ? reject(e) : resolve(); };
    const onExit = (code: number | null) => done(new Error(`a networked sandbox didn't start: ${code === 125 ? "its firewall didn't load" : `exit ${code}`}`));
    child.on("exit", onExit);
    child.on("error", (e) => done(new Error(`a networked sandbox didn't start: ${e.message}`)));
    ready.on("data", () => done());
  });
}

/**
 * Runs pasta, which forks into the background once the namespace is set up:
 * its exit says it's ready, and its PID file names the daemon. The file is
 * in a fresh private folder and holds only that number. Refuses with pasta's
 * stderr if it fails.
 */
function startPasta(cmd: string[]): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-pasta-"));
  const file = join(dir, "pid");
  return new Promise<number>((resolve, reject) => {
    const p = spawn(cmd[0]!, [...cmd.slice(1, -1), "--pid", file, cmd.at(-1)!], { env: env(), stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    p.on("error", (e) => reject(new Error(`a networked sandbox didn't start: pasta: ${e.message}`)));
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`a networked sandbox didn't start: pasta: ${err.trim() || `exit ${code}`}`));
      p.stderr.destroy();
      resolve(Number(readFileSync(file, "utf8").trim()));
    });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export class SandboxDenied extends Error {}

/** A process started in a sandbox, with its three pipes. */
export type Sandboxed = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };

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

  /** The tokens in its environment (any variable named for a token), longest first. */
  secrets(): string[] {
    return Object.entries(this.spec.env ?? {}).filter(([k, v]) => /TOKEN/.test(k) && v.length >= 8).map(([, v]) => v)
      .sort((a, b) => b.length - a.length);
  }

  /** Refuses paths outside the thread's folder and grants (SandboxDenied). The mounts confine her regardless. */
  allow(path: string, write: boolean): string {
    const p = cleanPath(path);
    if (within(p, WORKDIR)) return p;
    const grant = [...this.grants].reverse().find((g) => within(p, g.path));
    if (!grant) throw new SandboxDenied(`${p} is outside this thread's folders`);
    if (write && !grant.writable) throw new SandboxDenied(`${grant.path} is read-only in this thread`);
    return p;
  }

  /** Runs argv inside a fresh sandbox. */
  async run(argv: string[], o: RunOptions = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }> {
    const child = await this.start(argv, o.cwd);
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => (o.onData ? o.onData(d) : out.push(d)));
      child.stderr.on("data", (d: Buffer) => (o.onData ? o.onData(d) : err.push(d)));
      child.stdin.on("error", () => {}); // the command may exit without reading its input
      child.stdin.end(o.input ?? "");
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

  /**
   * Starts argv inside a fresh sandbox and hands back the process, its stdin
   * still open: run() for one command, the SSH helper for a connection.
   */
  async start(argv: string[], cwd?: string): Promise<Sandboxed> {
    let forward = this.spec.forward ?? [];
    const relay = this.spec.claude ? await openClaudeRelay(this.spec.claude.token, this.spec.claude.upstream) : undefined;
    try {
      return await this.launch(argv, cwd, forward, relay);
    } catch (err) {
      relay?.close();
      throw err;
    }
  }

  private async launch(argv: string[], cwd: string | undefined, forward: number[], relay: ClaudeRelay | undefined): Promise<Sandboxed> {
    let { internet, services, hosts } = this.spec.network;
    if (relay) forward = [...forward, relay.port];
    // The front door's names must resolve (now or before), or this run gets no network at all: its rules can't be trusted.
    const frontAddresses = internet || services || hosts.length || forward.length ? await resolveAddresses(this.spec.frontHosts ?? []) : [];
    if (!frontAddresses) [internet, services, hosts, forward] = [false, false, [], []];
    const networked = internet || services || hosts.length > 0 || forward.length > 0;
    const resolved = await resolveHosts(hosts);
    // Files written into the sandbox's /etc. Hostnames are pinned when it starts;
    // with internet off there is no resolver at all, so DNS can't carry data out.
    const forge = this.spec.env?.LYRICA_GIT_COUNT !== undefined;
    const claude = !!relay;
    // The capability and the relay's address, never the token.
    const claudeEnv = relay ? { CLAUDE_CODE_OAUTH_TOKEN: relay.capability, ANTHROPIC_BASE_URL: `http://127.0.0.1:${relay.port}` } : {};
    const data: (readonly [string, string, string?])[] = [
      ["/etc/hosts", ["127.0.0.1 localhost", "::1 localhost", ...resolved.pinned].join("\n") + "\n"],
      ["/etc/resolv.conf", internet ? `nameserver ${SANDBOX_GATEWAY}\n` : ""],
      ...forge ? [[`${FORGE_BIN}/gh`, FORGE, "0555"], [`${FORGE_BIN}/tea`, FORGE, "0555"]] as const : [],
      ...claude ? [[`${FORGE_BIN}/claude`, CLAUDE, "0555"]] as const : [],
    ];
    const fds: number[] = [];
    let args: string[];
    try {
      args = this.args(fds, cwd ?? WORKDIR, networked);
    } catch (err) {
      for (const fd of fds) closeSync(fd);
      throw err;
    }
    data.forEach(([dest, , perms], i) => args.push(...perms ? ["--perms", perms] : [], "--ro-bind-data", String(3 + fds.length + i), dest));
    // With network on, `unshare` makes the user and network namespaces and
    // bash loads the firewall into them, then waits while pasta attaches by
    // PID, then starts bwrap, which keeps the network. pasta can't start bwrap
    // itself: since 2024 it closes every file it inherits, and bwrap needs the
    // folders and data above.
    const ready = 3 + fds.length + data.length;
    let cmd = [this.spec.bwrap ?? "bwrap", ...args, "--", ...argv];
    if (networked) {
      const rules = nftRules(internet, resolved.rules, this.spec.exclude ?? [], {
        addresses: this.spec.self ?? hostAddresses(), services, front: this.spec.front ?? [],
        frontAddresses: frontAddresses ?? [],
      });
      cmd = ["unshare", "--user", "--map-root-user", "--net", "--", "bash", "-c", HOLD, "bash", rules, String(ready), String(ready + 1), ...cmd];
    }
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...this.spec.env, ...claudeEnv, ...env(), ...forge || claude ? { PATH: `${FORGE_BIN}:${env().PATH}` } : {} },
      stdio: ["pipe", "pipe", "pipe", ...fds, ...data.map(() => "pipe" as const), ...(networked ? ["pipe", "pipe"] as const : [])],
    });
    child.on("error", () => {}); // reported to the caller's own listener; never an uncaught error
    if (relay) child.on("close", () => relay.close());
    for (const fd of fds) closeSync(fd);
    data.forEach(([, text], i) => {
      const pipe = child.stdio[3 + fds.length + i] as Writable;
      pipe.on("error", () => {}); // if bwrap never starts, the spawn error is what's reported
      pipe.end(text);
    });
    if (!networked) return child as Sandboxed;

    const go = child.stdio[ready + 1] as Writable;
    go.on("error", () => {});
    try {
      await signalled(child, child.stdio[ready] as Readable);
      // The front ports are never forwarded from loopback either, in case the proxy listens on every address.
      const pastaPid = await startPasta([this.spec.pasta ?? "pasta", ...pastaArgs({ internet, services, hosts: hosts.length > 0, forward },
        [...(this.spec.exclude ?? []), ...(this.spec.front ?? [])]), String(child.pid)]);
      // pasta also quits by itself within a second of the namespace going.
      if (Number.isInteger(pastaPid) && pastaPid > 1) child.on("exit", () => { try { process.kill(pastaPid, "SIGTERM"); } catch { /* already gone */ } });
    } catch (err) {
      child.kill("SIGKILL");
      throw err;
    }
    go.end("go\n");
    return child as Sandboxed;
  }

  /** bwrap arguments. Opens each folder to mount and appends its fd to `fds` (child fd 3, 4, …). */
  private args(fds: number[], cwd: string, networked: boolean): string[] {
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"];
    // With network on, bwrap runs inside the namespace pasta serves and keeps it.
    // The host's network is never shared.
    if (networked) args.push("--share-net");

    const nix = tools();
    if (nix) {
      for (const p of nixSystem(nix)) args.push("--ro-bind", p, p);
      args.push("--ro-bind", nix, "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/bin", "/sbin");
    } else {
      for (const dir of SYSTEM_DIRS) {
        if (!existsSync(dir)) continue;
        const stat = lstatSync(dir);
        if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(dir), dir);
        else args.push("--ro-bind", dir, dir);
      }
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
    if (this.spec.workdir) mount(cleanPath(this.spec.workdir), true, WORKDIR);
    if (this.spec.workdir && this.spec.repos) mount(cleanPath(this.spec.repos), !this.spec.reposReadOnly, `${WORKDIR}/repos`);
    for (const g of this.grants) mount(g.path, g.writable, g.path, () => this.spec.check?.(g));
    for (const f of this.spec.files ?? []) args.push("--ro-bind", f, f);

    const visible = (this.spec.workdir && within(cwd, WORKDIR)) || this.grants.some((g) => within(cwd, g.path));
    args.push("--chdir", visible ? cwd : this.spec.workdir ? WORKDIR : "/");
    return args;
  }

  /** Runs a file operation and throws its error output if it fails. */
  private async file(argv: string[], input?: string | Buffer): Promise<Buffer> {
    const r = await this.run(argv, { input });
    if (r.code !== 0) throw new Error(r.stderr.toString().trim() || `${argv[0]} failed`);
    return r.stdout;
  }

  ops(): ToolOps {
    const rawRead = async (p: string) => this.file(["cat", "--", this.allow(p, false)]);
    // read hides the run's tokens; edit reads the file as it is, so writing it back keeps them.
    const readFile = async (p: string) => maskSecrets(await rawRead(p), this.secrets());
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
        readFile: rawRead,
        writeFile,
        access: async (p) => {
          await this.file(["sh", "-c", 'test -r "$1" && test -w "$1" || { echo "cannot edit $1" >&2; exit 1; }', "sh", this.allow(p, true)]);
        },
      },
      bash: {
        exec: async (command, cwd, { onData, signal, timeout }) => {
          // The run's tokens are hidden before anything reaches her (a token split across chunks too).
          const out = capOutput(onData);
          const masked = secretMasker(this.secrets(), (d) => out.push(d));
          const r = await this.run(["bash", "-c", command], {
            cwd: posix.normalize(cwd), onData: (d) => masked.push(d), signal, timeoutMs: timeout ? timeout * 1000 : undefined,
          });
          masked.end();
          out.end();
          return { exitCode: r.code ?? (r.signal ? 128 + (signalNumbers[r.signal] ?? 0) : null) };
        },
      },
    };
  }
}

const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };
