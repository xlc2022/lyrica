import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import ssh2 from "ssh2";
import { cleanOutput, maskKeys, onFloor } from "./machines.ts";
import { capOutput, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { cleanPath, within, type MachineConfig } from "./settings.ts";
import { isMissing, type SshSession, type SshTransport } from "./transport.ts";

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

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

export interface SshTargetOptions {
  /** The SSH client: Workspace.sshTransport, a sandboxed helper per connection. */
  transport: SshTransport;
  /**
   * The address to connect to, checked before every connection (the
   * machine's network check). Default: the configured host.
   */
  address?: () => Promise<string>;
  /** Called after each connection is made. */
  connected?: () => void;
  /** Called when a connection fails: the machine couldn't be reached or logged in to, or showed another host key. */
  failed?: (keyChanged: boolean) => void;
}

/**
 * A machine reached over SSH. The private key is handed over in memory, and
 * the host key must be the one Li confirmed. A failed connection fails the
 * operation: nothing ever falls back to running locally. Command output is
 * cleaned of terminal control and private keys, and write and edit never
 * touch SSH's or sudo's files.
 */
export class SshTarget implements ExecutionTarget {
  readonly name: string;
  private conn: Promise<SshSession> | undefined;
  /** Set by close(): a connection still in flight then reports nothing, so it can't overwrite a cleared state. */
  private closed = false;

  constructor(private readonly cfg: MachineConfig, private readonly o: SshTargetOptions) {
    this.name = `ssh:${cfg.name}`;
  }

  folders(): string[] { return this.cfg.root ? [`${this.cfg.name}:${this.cfg.root}`] : []; }

  async cwd(): Promise<string> { return this.cfg.root ?? (await this.connect()).home; }

  close(): void {
    this.closed = true;
    void this.conn?.then((c) => c.close(), () => {});
    this.conn = undefined;
  }

  private connect(): Promise<SshSession> {
    if (this.conn) return this.conn;
    const { name, hostKey } = this.cfg;
    const conn = (async () => {
      if (!hostKey) throw new Error("its host key hasn't been confirmed");
      const host = this.o.address ? await this.o.address() : this.cfg.host;
      let seen: string | undefined;
      const session = await this.o.transport.connect(
        { host, port: this.cfg.port, username: this.cfg.username, privateKey: this.cfg.privateKey },
        (fp) => { seen = fp; return fp === hostKey; },
      ).catch((err: Error) => {
        const changed = seen !== undefined && seen !== hostKey;
        this.report(() => this.o.failed?.(changed));
        throw changed ? new Error(`its host key changed (now ${seen}); confirm the new key to use it again`) : err;
      });
      session.onClose(() => { if (this.conn === conn) this.conn = undefined; });
      this.report(() => this.o.connected?.());
      return session;
    })().catch((err: Error) => { throw new Error(`ssh ${name}: ${err.message}`); });
    this.conn = conn;
    conn.catch(() => { if (this.conn === conn) this.conn = undefined; });
    return conn;
  }

  /** Runs a state callback unless closed; its own failure never changes the connection's outcome. */
  private report(fn: () => void): void {
    if (this.closed) return;
    try { fn(); } catch { /* the state is only shown, never relied on */ }
  }

  private async session(): Promise<SshSession> { return this.connect(); }

  /** The path itself, after its deepest existing folder's symlinks are followed. */
  private async resolved(p: string): Promise<string> {
    const s = await this.session();
    let probe = p;
    const rest: string[] = [];
    for (;;) {
      try {
        return posix.join(await s.realpath(probe), ...rest.reverse());
      } catch (err) {
        if (!isMissing(err) || probe === "/") throw err;
        rest.push(posix.basename(probe));
        probe = posix.dirname(probe);
      }
    }
  }

  /** Keeps read, write and edit inside the root, following remote symlinks. */
  private async inside(path: string): Promise<string> {
    const p = cleanPath(path);
    const root = this.cfg.root;
    if (!root) return p;
    if (!within(p, root)) throw new Error(`${p} is outside ${root} on ${this.cfg.name}`);
    const real = await this.resolved(p).catch((err) => {
      if (isMissing(err)) throw new Error(`${root} is missing on ${this.cfg.name}`);
      throw err;
    });
    if (!within(real, await (await this.session()).realpath(root))) throw new Error(`${p} leads outside ${root} on ${this.cfg.name}`);
    return p;
  }

  /** Like inside, and refuses SSH's and sudo's files, before and after symlinks. */
  private async writable(path: string): Promise<string> {
    const p = await this.inside(path);
    if (onFloor(p) || onFloor(await this.resolved(p))) throw new Error(`${p} is SSH's or sudo's; write and edit never change it on a machine`);
    return p;
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
    const s = await this.session();
    const old = await s.lstat(path);
    if (old?.symlink) throw new Error(`${path} is a symlink; not writing through it`);
    const inPlace = () => s.writeFile(path, content);
    const tmp = posix.join(posix.dirname(path), `.${posix.basename(path)}.${randomBytes(6).toString("hex")}`);
    const drop = () => s.unlink(tmp).catch(() => {});
    try {
      await s.writeFile(tmp, content, 0o600);
    } catch {
      await drop();
      return inPlace();
    }
    try {
      if (old) {
        const mine = (await s.lstat(tmp))!;
        if (mine.uid !== old.uid) { await drop(); return inPlace(); }
        if (mine.gid !== old.gid) {
          const kept = await s.chown(tmp, old.uid, old.gid).then(() => true, () => false);
          if (!kept) { await drop(); return inPlace(); }
        }
      }
      await s.chmod(tmp, old ? old.mode & 0o7777 : 0o644);
      await s.rename(tmp, path);
    } catch (err) {
      await drop();
      throw err;
    }
  }

  ops(): ToolOps {
    // edit reads the file as it is, so writing it back keeps any key in it; read masks keys.
    // The path is checked before anything else happens.
    const at = async (p: string, check: (p: string) => Promise<string>) => { const q = await check(p); return { s: await this.session(), q }; };
    const inside = (p: string) => at(p, (x) => this.inside(x));
    const writable = (p: string) => at(p, (x) => this.writable(x));
    const rawRead = async (p: string) => { const { s, q } = await inside(p); return s.readFile(q); };
    const writeFile = async (p: string, content: string | Buffer) => this.write(await this.writable(p), content);
    return {
      read: {
        readFile: async (p) => maskKeys(await rawRead(p)),
        access: async (p) => { const { s, q } = await inside(p); return s.check(q, "r"); },
        detectImageMimeType: async (p) => { const { s, q } = await inside(p); return sniffImage(await s.readHead(q, 16)); },
      },
      write: {
        writeFile,
        mkdir: async (dir) => {
          const { s, q } = await writable(dir);
          if (await s.exec(`mkdir -p -- ${quote(q)}`, { onData: () => {} }) !== 0) throw new Error(`could not create ${dir} on ${this.cfg.name}`);
        },
      },
      edit: { readFile: rawRead, writeFile, access: async (p) => { const { s, q } = await writable(p); return s.check(q, "r+"); } },
      bash: {
        exec: async (command, cwd, { onData, signal, timeout }) => {
          const base = await this.cwd();
          const dir = within(posix.normalize(cwd), base) ? posix.normalize(cwd) : base;
          const out = capOutput(onData);
          const clean = cleanOutput((d) => out.push(d));
          try {
            const code = await (await this.session()).exec(`cd ${quote(dir)} && ${command}`, { onData: (d) => clean.push(d), signal, timeout });
            return { exitCode: code };
          } finally {
            clean.end();
            out.end();
          }
        },
      },
    };
  }
}
