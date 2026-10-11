import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import { hostAddresses } from "./net.ts";
import { capOutput, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { Sandbox, type Sandboxed } from "./sandbox.ts";
import { cleanPath, within, type SshTargetConfig } from "./settings.ts";
import { decoder, encode, type Frame } from "./ssh-frames.ts";

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64")}`;

/** A new ed25519 key pair in OpenSSH format, generated in memory. */
export function generateSshKey(comment: string): { privateKey: string; publicKey: string } {
  const { private: privateKey, public: publicKey } = ssh2.utils.generateKeyPairSync("ed25519", { comment });
  return { privateKey, publicKey };
}

/** The public half of a stored private key, in authorized_keys form. */
export function publicKeyOf(privateKey: string): string {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0]! : parsed;
  return [key.type, key.getPublicSSH().toString("base64"), key.comment].filter(Boolean).join(" ");
}

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

export interface SshTargetOptions {
  /** Whether to go on with a server presenting this host key ("SHA256:…"). Asked on every connection. */
  hostKey: (fingerprint: string) => boolean;
  /** Read at each connection. */
  sandbox: () => HelperSandbox;
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

interface Conn { helper: Helper; home: string }

interface RemoteStats { mode: number; uid: number; gid: number; symlink: boolean }

/**
 * Reads a server's host key fingerprint without logging in, through a
 * helper like any connection, so a hostile server's packets never reach lyricad.
 */
export async function probeHostKey(target: { host: string; port: number }, sandbox: HelperSandbox): Promise<string> {
  const address = await addressOf(target.host);
  return new Promise<string>((resolve, reject) => {
    let helper: Helper | undefined;
    const timer = setTimeout(() => { helper?.fail(new Error("timed out")); reject(new Error(`ssh ${target.host}: no host key within 15 s`)); }, 15_000);
    const settle = (fn: () => void) => { clearTimeout(timer); helper?.close(); fn(); };
    Helper.start(address, target.port, sandbox, (f) => {
      if (f.head.ev === "hostkey") settle(() => resolve(fingerprint(f.body)));
      else if (f.head.ev === "error") settle(() => reject(new Error(`ssh ${target.host}: ${String(f.head.message)}`)));
    }, (err) => settle(() => reject(new Error(`ssh ${target.host}: ${err.message}`)))).then((h) => {
      helper = h;
      h.send({ op: "connect", host: address, port: target.port, username: "lyrica-probe" });
    }, (err: Error) => settle(() => reject(new Error(`ssh ${target.host}: ${err.message}`))));
  });
}

/**
 * A named remote machine. The SSH client runs in a sandboxed helper process
 * per connection (ssh-helper.ts), handed the private key on a pipe. A failed
 * connection, or a helper that can't start, fails the operation: nothing ever
 * falls back to running locally or to a client inside lyricad.
 */
export class SshTarget implements ExecutionTarget {
  readonly name: string;
  private conn: Promise<Conn> | undefined;

  constructor(private readonly cfg: SshTargetConfig, private readonly opts: SshTargetOptions) {
    this.name = `ssh:${cfg.name}`;
  }

  folders(): string[] { return this.cfg.root ? [`${this.cfg.name}:${this.cfg.root}`] : []; }

  async cwd(): Promise<string> { return this.cfg.root ?? (await this.connect()).home; }

  close(): void {
    void this.conn?.then((c) => c.helper.close(), () => {});
    this.conn = undefined;
  }

  private connect(): Promise<Conn> {
    if (this.conn) return this.conn;
    const conn: Promise<Conn> = (async () => {
      const address = await addressOf(this.cfg.host);
      return new Promise<Conn>((resolve, reject) => {
        let refused: string | undefined;
        let helper: Helper | undefined;
        let ready = false;
        const fail = (err: Error) => {
          if (ready) return;
          clearTimeout(timer);
          helper?.fail(err);
          reject(refused ? new Error(`the host key changed (saw ${refused})`) : err);
        };
        // Starting the sandbox plus ssh2's own 10 s to connect.
        const timer = setTimeout(() => fail(new Error("timed out connecting")), 20_000);
        Helper.start(address, this.cfg.port, this.opts.sandbox(), (f, h) => {
          if (f.head.ev === "hostkey") {
            const seen = fingerprint(f.body);
            const ok = this.opts.hostKey(seen);
            if (!ok) refused = seen;
            h.send({ op: "hostkey", ok });
          } else if (f.head.ev === "ready" && typeof f.head.home === "string") {
            ready = true;
            clearTimeout(timer);
            resolve({ helper: h, home: f.head.home });
          } else if (f.head.ev === "error") {
            fail(new Error(String(f.head.message)));
          }
        }, (err) => {
          if (this.conn === conn) this.conn = undefined;
          fail(err);
        }).then((h) => {
          helper = h;
          h.send({ op: "connect", host: address, port: this.cfg.port, username: this.cfg.username }, Buffer.from(this.cfg.privateKey));
        }, fail);
      });
    })().catch((err: Error) => { throw new Error(`ssh ${this.cfg.name}: ${err.message}`); });
    this.conn = conn;
    conn.catch(() => { if (this.conn === conn) this.conn = undefined; });
    return conn;
  }

  private async call(head: Record<string, unknown>, body?: Buffer): Promise<Frame> {
    const { helper } = await this.connect();
    return helper.call(head, body);
  }

  private async lstat(path: string): Promise<RemoteStats | undefined> {
    try {
      return (await this.call({ op: "lstat", path })).head.stats as RemoteStats;
    } catch (err) {
      if ((err as { code?: number }).code === 2) return undefined; // 2 is SFTP's "no such file"
      throw err;
    }
  }

  /** Keeps read, write and edit inside the root, following remote symlinks. */
  private async inside(path: string): Promise<string> {
    const p = cleanPath(path);
    const root = this.cfg.root;
    if (!root) return p;
    if (!within(p, root)) throw new Error(`${p} is outside ${root} on ${this.cfg.name}`);
    const real = async (q: string) => String((await this.call({ op: "realpath", path: q })).head.value);
    let probe = p;
    let resolved: string | undefined;
    while (resolved === undefined) {
      try {
        resolved = await real(probe);
      } catch (err) {
        if ((err as { code?: number }).code !== 2) throw err; // 2 is SFTP's "no such file"
        if (probe === root) throw new Error(`${root} is missing on ${this.cfg.name}`);
        probe = posix.dirname(probe);
      }
    }
    if (!within(resolved, await real(root))) throw new Error(`${p} leads outside ${root} on ${this.cfg.name}`);
    return p;
  }

  private async run(command: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }): Promise<number | null> {
    const { helper } = await this.connect();
    let received = 0;
    const call = helper.call({ op: "exec", command }, undefined, (d) => {
      received += d.length;
      if (received > MAX_OUTPUT) helper.fail(new Error("the SSH helper sent more output than it should"));
      else o.onData(d);
    });
    let stopped: Error | undefined;
    const stop = (why: Error) => { stopped = why; helper.call({ op: "kill", target: call.id }).catch(() => {}); };
    const timer = o.timeout ? setTimeout(() => stop(new Error(`timeout:${o.timeout}`)), o.timeout * 1000) : undefined;
    const onAbort = () => stop(new Error("aborted"));
    o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await call;
      if (stopped) throw stopped;
      return typeof reply.head.code === "number" ? reply.head.code : null;
    } catch (err) {
      throw stopped ?? err;
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * For a file she owns (or a new one), writes a temp file in the same
   * folder with the old file's mode and group, then renames it over the
   * target, so a reader never sees a truncated file. A file someone else
   * owns, one whose group can't be kept, or one in a folder she can't create
   * files in is written in place, so it keeps its owner. A symlink at the
   * target is refused.
   */
  private async write(path: string, content: string | Buffer): Promise<void> {
    const data = Buffer.from(content);
    const old = await this.lstat(path);
    if (old?.symlink) throw new Error(`${path} is a symlink; not writing through it`);
    const inPlace = async () => { await this.call({ op: "writeFile", path }, data); };
    const tmp = posix.join(posix.dirname(path), `.${posix.basename(path)}.${randomBytes(6).toString("hex")}`);
    const drop = () => this.call({ op: "unlink", path: tmp }).catch(() => {});
    try {
      await this.call({ op: "writeFile", path: tmp, mode: 0o600 }, data);
    } catch {
      await drop();
      return inPlace();
    }
    try {
      if (old) {
        const mine = await this.lstat(tmp);
        if (!mine || mine.uid !== old.uid) { await drop(); return inPlace(); }
        if (mine.gid !== old.gid) {
          const kept = await this.call({ op: "chown", path: tmp, uid: old.uid, gid: old.gid }).then(() => true, () => false);
          if (!kept) { await drop(); return inPlace(); }
        }
      }
      await this.call({ op: "chmod", path: tmp, mode: old ? old.mode & 0o7777 : 0o644 });
      await this.call({ op: "rename", path: tmp, to: path });
    } catch (err) {
      await drop();
      throw err;
    }
  }

  ops(): ToolOps {
    const readFile = async (p: string) => (await this.call({ op: "readFile", path: await this.inside(p) })).body;
    const access = async (p: string, mode: "r" | "r+") => { await this.call({ op: "access", path: await this.inside(p), mode }); };
    const writeFile = async (p: string, content: string | Buffer) => this.write(await this.inside(p), content);
    return {
      read: {
        readFile,
        access: (p) => access(p, "r"),
        detectImageMimeType: async (p) => sniffImage((await this.call({ op: "head", path: await this.inside(p), length: 16 })).body),
      },
      write: {
        writeFile,
        mkdir: async (dir) => {
          const code = await this.run(`mkdir -p -- ${quote(await this.inside(dir))}`, { onData: () => {} });
          if (code !== 0) throw new Error(`could not create ${dir} on ${this.cfg.name}`);
        },
      },
      edit: { readFile, writeFile, access: (p) => access(p, "r+") },
      bash: {
        exec: async (command, cwd, { onData, signal, timeout }) => {
          const base = await this.cwd();
          const dir = within(posix.normalize(cwd), base) ? posix.normalize(cwd) : base;
          const out = capOutput(onData);
          const code = await this.run(`cd ${quote(dir)} && ${command}`, { onData: (d) => out.push(d), signal, timeout });
          out.end();
          return { exitCode: code };
        },
      },
    };
  }
}
