// The seam between a machine's policy (SshTarget: root, writes, host key
// pin) and the SSH client that talks to it. The only client is a sandboxed
// helper process per connection (ssh-helper.ts): lyricad holds every user's
// unlocked keys, so ssh2 never parses a server's packets in lyricad.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostAddresses } from "./net.ts";
import { Sandbox, type Sandboxed } from "./sandbox.ts";
import { decoder, encode, type Frame } from "./ssh-frames.ts";

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  /** OpenSSH private key, handed over in memory. */
  privateKey: string;
}

export interface RemoteStat { uid: number; gid: number; mode: number; symlink: boolean }

/** Thrown for a path that doesn't exist. */
export class RemoteMissing extends Error { readonly code = "ENOENT"; }
export const isMissing = (err: unknown): boolean => err instanceof RemoteMissing;

/** One open connection: a command channel and the SFTP calls SshTarget uses. */
export interface SshSession {
  /** The account's home folder, as the server reports it. */
  readonly home: string;
  /** Runs a command; output streams to `onData` (stdout and stderr together, capped). Resolves to the exit code. */
  exec(command: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }): Promise<number | null>;
  realpath(path: string): Promise<string>;
  /** Undefined when nothing is there. */
  lstat(path: string): Promise<RemoteStat | undefined>;
  readFile(path: string): Promise<Buffer>;
  /** The first `n` bytes. */
  readHead(path: string, n: number): Promise<Buffer>;
  /** Opens and closes the file, to check it can be read ("r") or written ("r+"). */
  check(path: string, mode: "r" | "r+"): Promise<void>;
  writeFile(path: string, content: string | Buffer, mode?: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  /** Replaces `to` in one step where the server can. */
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  close(): void;
  /** Called once when the connection ends, for any reason. */
  onClose(listener: () => void): void;
}

export interface SshTransport {
  /**
   * Opens a connection. `verify` gets the host key's SHA-256 fingerprint
   * ("SHA256:…") and says whether to go on; strict key exchange is required.
   * No agent, no forwarding.
   */
  connect(to: SshEndpoint, verify: (fingerprint: string) => boolean): Promise<SshSession>;
}

const fingerprint = (key: Buffer): string => `SHA256:${createHash("sha256").update(key).digest("base64")}`;

/** Where the helper's sandbox may not reach, and how to start it: Workspace's front door and tools. */
export interface HelperSandbox {
  /** lyricad's own ports, refused on every address. */
  exclude: number[];
  front?: number[];
  frontHosts?: string[];
  bwrap?: string;
  pasta?: string;
  /** Why the sandbox self-test refused network: then no helper starts and the call fails. */
  refused?: string;
}

const HELPER = fileURLToPath(new URL("./ssh-helper.ts", import.meta.url));

/**
 * The files the helper needs and nothing else of the install: its code, the
 * package.json that makes it a module, Node, and ssh2 with its dependencies.
 */
function helperFiles(): string[] {
  const here = dirname(HELPER);
  const files = [HELPER, join(here, "ssh-frames.ts"), join(here, "ops.ts"), realpathSync(process.execPath)];
  for (let d = here; ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) { files.push(join(d, "package.json")); break; }
    if (d === dirname(d)) break;
  }
  const seen = new Set<string>();
  const add = (name: string, from: string, optional: boolean) => {
    for (let d = from; ; d = dirname(d)) {
      const dir = join(d, "node_modules", name);
      if (existsSync(join(dir, "package.json"))) {
        const real = realpathSync(dir);
        if (seen.has(real)) return;
        seen.add(real);
        const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as { dependencies?: object; optionalDependencies?: object };
        for (const dep of Object.keys(pkg.dependencies ?? {})) add(dep, real, false);
        for (const dep of Object.keys(pkg.optionalDependencies ?? {})) add(dep, real, true);
        return;
      }
      if (d === dirname(d)) {
        if (optional) return;
        throw new Error(`ssh helper: can't find ${name}`);
      }
    }
  };
  add("ssh2", here, false);
  return [...files, ...seen];
}
let files: string[] | undefined;

/** The address SSH connects to: the IPv4 address the host resolves to now, so the firewall and the connection agree. */
async function addressOf(host: string): Promise<string> {
  if (isIP(host) === 4) return host;
  if (isIP(host)) throw new Error("IPv6 machines aren't supported yet");
  return (await lookup(host, { family: 4 })).address;
}

/**
 * The sandbox one helper runs in: a read-only system, the helper's own files,
 * no workspace, and network to exactly one address and port. A machine on this
 * host's loopback is reached through one forwarded port; one on this host's
 * own LAN address is still refused lyricad's front door there.
 */
export function helperSandbox(address: string, port: number, o: HelperSandbox): Sandbox {
  const loopback = address.startsWith("127.");
  const self = hostAddresses().filter((a) => a !== address);
  return new Sandbox({
    grants: [],
    network: { internet: false, services: false, hosts: loopback ? [] : [`${address}:${port}`] },
    forward: loopback ? [port] : [],
    exclude: o.exclude,
    front: o.front,
    self,
    frontHosts: self.length === hostAddresses().length ? o.frontHosts : [...(o.frontHosts ?? []), address],
    files: (files ??= helperFiles()),
    bwrap: o.bwrap,
    pasta: o.pasta,
  });
}

type Pending = { resolve: (f: Frame) => void; reject: (e: Error) => void; onData?: (d: Buffer) => void };

/** Output from one command larger than this means the helper isn't capping it: the connection ends. */
const MAX_OUTPUT = 256 * 1024;

/**
 * lyricad's end of one helper: frames out, replies matched by id. Everything
 * the helper sends is checked as untrusted.
 */
class Helper {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private dead: Error | undefined;
  private constructor(private readonly child: Sandboxed) {}

  static async start(address: string, port: number, sandbox: HelperSandbox, onEvent: (f: Frame, h: Helper) => void, onExit: (err: Error) => void): Promise<Helper> {
    if (sandbox.refused) throw new Error(`no sandbox for the SSH client: ${sandbox.refused}`);
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    if (major === 22 && minor < 6) throw new Error("the SSH helper needs Node 22.6 or later (type stripping)");
    const child = await helperSandbox(address, port, sandbox)
      .start([realpathSync(process.execPath), "--experimental-strip-types", "--disable-warning=ExperimentalWarning", HELPER]);
    const h = new Helper(child);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
    child.stdin.on("error", () => {});
    const feed = decoder((f) => {
      const id = f.head.id;
      if (typeof id !== "number") return onEvent(f, h);
      const p = h.pending.get(id);
      if (!p) return;
      if (f.head.ev === "data") return p.onData?.(f.body);
      h.pending.delete(id);
      if (f.head.ok === true) p.resolve(f);
      else p.reject(Object.assign(new Error(String(f.head.error ?? "ssh helper error")), { code: f.head.code }));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try { feed(chunk); } catch (err) { h.fail(err as Error); }
    });
    const exited = (err: Error) => {
      h.dead ??= err;
      for (const p of h.pending.values()) p.reject(h.dead);
      h.pending.clear();
      onExit(h.dead);
    };
    child.on("error", (err) => exited(new Error(`the SSH helper didn't start: ${err.message}`)));
    child.on("close", (code) => exited(new Error(stderr.trim() ? `the SSH helper stopped: ${stderr.trim().split("\n").pop()}` : `the SSH helper stopped (exit ${code})`)));
    return h;
  }

  send(head: object, body?: Buffer): void {
    if (!this.dead) this.child.stdin.write(encode(head, body));
  }

  call(head: Record<string, unknown>, body?: Buffer, onData?: (d: Buffer) => void): Promise<Frame> & { id: number } {
    const id = this.next++;
    const p = new Promise<Frame>((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      this.pending.set(id, { resolve, reject, onData });
      this.send({ ...head, id }, body);
    });
    return Object.assign(p, { id });
  }

  fail(err: Error): void {
    this.dead ??= err;
    this.child.kill("SIGKILL");
  }

  /** Closing stdin ends the helper; the kill makes sure. */
  close(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill("SIGKILL"), 2000).unref();
  }
}

/** 2 is SFTP's "no such file". */
const NO_SUCH_FILE = 2;

/**
 * The SSH client: a helper process per connection, in its own sandbox, handed
 * the private key on its stdin. If it can't start, or the network self-test
 * refused sandboxes, connect fails; there is no client in lyricad.
 */
export function sandboxedTransport(sandbox: () => HelperSandbox): SshTransport {
  return {
    async connect(to, verify) {
      const address = await addressOf(to.host);
      return new Promise<SshSession>((resolve, reject) => {
        let refused: string | undefined;
        let helper: Helper | undefined;
        let session: SshSession | undefined;
        const closed: (() => void)[] = [];
        const fail = (err: Error) => {
          clearTimeout(timer);
          helper?.fail(err);
          reject(refused ? new Error(`the host key changed (saw ${refused})`) : err);
        };
        // Starting the sandbox, which can hang if pasta can't make its device, plus ssh2's own 10 s.
        const timer = setTimeout(() => fail(new Error("timed out connecting")), 20_000);
        Helper.start(address, to.port, sandbox(), (f, h) => {
          if (session) return;
          if (f.head.ev === "hostkey") {
            const seen = fingerprint(f.body);
            const ok = verify(seen);
            if (!ok) refused = seen;
            h.send({ op: "hostkey", ok });
          } else if (f.head.ev === "ready" && typeof f.head.home === "string") {
            clearTimeout(timer);
            session = sessionOf(h, f.head.home, closed);
            resolve(session);
          } else if (f.head.ev === "error") {
            fail(new Error(String(f.head.message)));
          }
        }, (err) => {
          if (session) for (const l of closed.splice(0)) l();
          else fail(err);
        }).then((h) => {
          helper = h;
          h.send({ op: "connect", host: address, port: to.port, username: to.username }, Buffer.from(to.privateKey));
        }, fail);
      });
    },
  };
}

function sessionOf(h: Helper, home: string, closed: (() => void)[]): SshSession {
  const call = async (head: Record<string, unknown>, body?: Buffer): Promise<Frame> => {
    try {
      return await h.call(head, body);
    } catch (err) {
      if ((err as { code?: unknown }).code === NO_SUCH_FILE) throw new RemoteMissing(`${String(head.path)}: no such file`);
      throw err;
    }
  };
  return {
    home,
    async exec(command, o) {
      let received = 0;
      const run = h.call({ op: "exec", command }, undefined, (d) => {
        received += d.length;
        if (received > MAX_OUTPUT) h.fail(new Error("the SSH helper sent more output than it should"));
        else o.onData(d);
      });
      let stopped: Error | undefined;
      const stop = (why: Error) => { stopped = why; h.call({ op: "kill", target: run.id }).catch(() => {}); };
      const timer = o.timeout ? setTimeout(() => stop(new Error(`timeout:${o.timeout}`)), o.timeout * 1000) : undefined;
      const onAbort = () => stop(new Error("aborted"));
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.signal?.aborted) onAbort();
      try {
        const reply = await run;
        if (stopped) throw stopped;
        return typeof reply.head.code === "number" ? reply.head.code : null;
      } catch (err) {
        throw stopped ?? err;
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
    },
    realpath: async (path) => String((await call({ op: "realpath", path })).head.value),
    lstat: async (path) => {
      try {
        return (await call({ op: "lstat", path })).head.stats as RemoteStat;
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    readFile: async (path) => (await call({ op: "readFile", path })).body,
    readHead: async (path, length) => (await call({ op: "head", path, length })).body.subarray(0, length),
    check: async (path, mode) => { await call({ op: "access", path, mode }); },
    writeFile: async (path, content, mode) => { await call({ op: "writeFile", path, mode }, Buffer.from(content)); },
    chmod: async (path, mode) => { await call({ op: "chmod", path, mode }); },
    chown: async (path, uid, gid) => { await call({ op: "chown", path, uid, gid }); },
    rename: async (path, to) => { await call({ op: "rename", path, to }); },
    unlink: async (path) => { await call({ op: "unlink", path }); },
    close: () => h.close(),
    onClose: (listener) => { closed.push(listener); },
  };
}
