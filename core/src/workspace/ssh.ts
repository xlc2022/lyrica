import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import ssh2 from "ssh2";
import { capOutput, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { cleanPath, within, type SshTargetConfig } from "./settings.ts";
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
  /** The SSH client: sandboxedTransport. */
  transport: SshTransport;
  /** Whether to go on with a server presenting this host key ("SHA256:…"). Asked on every connection. */
  hostKey: (fingerprint: string) => boolean;
}

/**
 * A named remote machine. Its SSH client runs outside lyricad, in a
 * sandboxed helper per connection (transport.ts). A failed connection, or a
 * helper that can't start, fails the operation: nothing ever falls back to
 * running locally or to a client inside lyricad.
 */
export class SshTarget implements ExecutionTarget {
  readonly name: string;
  private conn: Promise<SshSession> | undefined;

  constructor(private readonly cfg: SshTargetConfig, private readonly o: SshTargetOptions) {
    this.name = `ssh:${cfg.name}`;
  }

  folders(): string[] { return this.cfg.root ? [`${this.cfg.name}:${this.cfg.root}`] : []; }

  async cwd(): Promise<string> { return this.cfg.root ?? (await this.connect()).home; }

  close(): void {
    void this.conn?.then((c) => c.close(), () => {});
    this.conn = undefined;
  }

  private connect(): Promise<SshSession> {
    if (this.conn) return this.conn;
    const conn = (async () => {
      const session = await this.o.transport.connect(
        { host: this.cfg.host, port: this.cfg.port, username: this.cfg.username, privateKey: this.cfg.privateKey },
        this.o.hostKey,
      );
      session.onClose(() => { if (this.conn === conn) this.conn = undefined; });
      return session;
    })().catch((err: Error) => { throw new Error(`ssh ${this.cfg.name}: ${err.message}`); });
    this.conn = conn;
    conn.catch(() => { if (this.conn === conn) this.conn = undefined; });
    return conn;
  }

  /** Keeps read, write and edit inside the root, following remote symlinks. */
  private async inside(path: string): Promise<string> {
    const p = cleanPath(path);
    const root = this.cfg.root;
    if (!root) return p;
    if (!within(p, root)) throw new Error(`${p} is outside ${root} on ${this.cfg.name}`);
    const s = await this.connect();
    let probe = p;
    let resolved: string | undefined;
    while (resolved === undefined) {
      try {
        resolved = await s.realpath(probe);
      } catch (err) {
        if (!isMissing(err)) throw err;
        if (probe === root) throw new Error(`${root} is missing on ${this.cfg.name}`);
        probe = posix.dirname(probe);
      }
    }
    if (!within(resolved, await s.realpath(root))) throw new Error(`${p} leads outside ${root} on ${this.cfg.name}`);
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
    const s = await this.connect();
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
        const mine = await s.lstat(tmp);
        if (!mine || mine.uid !== old.uid) { await drop(); return inPlace(); }
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
    // The root check comes first, so a path outside it is refused before any connection.
    const readFile = async (p: string) => { const q = await this.inside(p); return (await this.connect()).readFile(q); };
    const writeFile = async (p: string, content: string | Buffer) => this.write(await this.inside(p), content);
    const check = async (p: string, mode: "r" | "r+") => { const q = await this.inside(p); return (await this.connect()).check(q, mode); };
    return {
      read: {
        readFile,
        access: (p) => check(p, "r"),
        detectImageMimeType: async (p) => { const q = await this.inside(p); return sniffImage(await (await this.connect()).readHead(q, 16)); },
      },
      write: {
        writeFile,
        mkdir: async (dir) => {
          const q = await this.inside(dir);
          const code = await (await this.connect()).exec(`mkdir -p -- ${quote(q)}`, { onData: () => {} });
          if (code !== 0) throw new Error(`could not create ${dir} on ${this.cfg.name}`);
        },
      },
      edit: { readFile, writeFile, access: (p) => check(p, "r+") },
      bash: {
        exec: async (command, cwd, { onData, signal, timeout }) => {
          const base = await this.cwd();
          const dir = within(posix.normalize(cwd), base) ? posix.normalize(cwd) : base;
          const out = capOutput(onData);
          try {
            const code = await (await this.connect()).exec(`cd ${quote(dir)} && ${command}`, { onData: (d) => out.push(d), signal, timeout });
            return { exitCode: code };
          } finally {
            out.end();
          }
        },
      },
    };
  }
}
