import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import ssh2, { type Client, type SFTPWrapper, type Stats } from "ssh2";
import { capOutput, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { cleanPath, within, type SshTargetConfig } from "./settings.ts";

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

interface Conn { client: Client; sftp: SFTPWrapper; home: string }

/**
 * A named remote machine, reached with ssh2 inside lyricad. The private key is
 * handed over in memory. A failed connection fails the operation: nothing
 * ever falls back to running locally.
 */
export class SshTarget implements ExecutionTarget {
  readonly name: string;
  private conn: Promise<Conn> | undefined;

  constructor(private readonly cfg: SshTargetConfig, private readonly onHostKey: (fingerprint: string) => void) {
    this.name = `ssh:${cfg.name}`;
  }

  folders(): string[] { return this.cfg.root ? [`${this.cfg.name}:${this.cfg.root}`] : []; }

  async cwd(): Promise<string> { return this.cfg.root ?? (await this.connect()).home; }

  close(): void {
    void this.conn?.then((c) => c.client.end(), () => {});
    this.conn = undefined;
  }

  private connect(): Promise<Conn> {
    if (this.conn) return this.conn;
    const conn: Promise<Conn> = new Promise<Conn>((resolve, reject) => {
      const client = new ssh2.Client();
      const fail = (err: Error) => { client.end(); reject(new Error(`ssh ${this.cfg.name}: ${err.message}`)); };
      client.on("error", fail);
      client.on("close", () => { if (this.conn === conn) this.conn = undefined; });
      client.on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) return fail(err);
          sftp.realpath(".", (err2, home) => (err2 ? fail(err2) : resolve({ client, sftp, home })));
        });
      });
      try {
        client.connect({
          host: this.cfg.host,
          port: this.cfg.port,
          username: this.cfg.username,
          privateKey: this.cfg.privateKey,
          readyTimeout: 10_000,
          agent: undefined,
          hostVerifier: (key: Buffer) => {
            const seen = fingerprint(key);
            if (!this.cfg.hostKey) { this.cfg.hostKey = seen; this.onHostKey(seen); return true; }
            return this.cfg.hostKey === seen;
          },
        });
      } catch (err) {
        fail(err as Error);
      }
    });
    this.conn = conn;
    conn.catch(() => { if (this.conn === conn) this.conn = undefined; });
    return conn;
  }

  private async sftp<T>(call: (sftp: SFTPWrapper, done: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    const { sftp } = await this.connect();
    return new Promise((resolve, reject) => call(sftp, (err, value) => (err ? reject(err) : resolve(value as T))));
  }

  /** Keeps read, write and edit inside the root, following remote symlinks. */
  private async inside(path: string): Promise<string> {
    const p = cleanPath(path);
    const root = this.cfg.root;
    if (!root) return p;
    if (!within(p, root)) throw new Error(`${p} is outside ${root} on ${this.cfg.name}`);
    const real = (q: string) => this.sftp<string>((s, done) => s.realpath(q, done));
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
    const { client } = await this.connect();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stopped: Error | undefined;
        const stop = (why: Error) => { stopped = why; stream.signal("KILL"); stream.close(); };
        const timer = o.timeout ? setTimeout(() => stop(new Error(`timeout:${o.timeout}`)), o.timeout * 1000) : undefined;
        const onAbort = () => stop(new Error("aborted"));
        o.signal?.addEventListener("abort", onAbort, { once: true });
        stream.on("data", o.onData);
        stream.stderr.on("data", o.onData);
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
          stopped ? reject(stopped) : resolve(code);
        });
      });
    });
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
    const old = await this.sftp<Stats | undefined>((s, done) =>
      s.lstat(path, (err, st) => done((err as { code?: number } | undefined)?.code === 2 ? undefined : err, st)));
    if (old?.isSymbolicLink()) throw new Error(`${path} is a symlink; not writing through it`);
    const inPlace = () => this.sftp<void>((s, done) => s.writeFile(path, content, done));
    const tmp = posix.join(posix.dirname(path), `.${posix.basename(path)}.${randomBytes(6).toString("hex")}`);
    const drop = () => this.sftp<void>((s, done) => s.unlink(tmp, () => done(undefined))).catch(() => {});
    try {
      await this.sftp<void>((s, done) => s.writeFile(tmp, content, { mode: 0o600 }, done));
    } catch {
      await drop();
      return inPlace();
    }
    try {
      if (old) {
        const mine = await this.sftp<Stats>((s, done) => s.lstat(tmp, done));
        if (mine.uid !== old.uid) { await drop(); return inPlace(); }
        if (mine.gid !== old.gid) {
          const kept = await this.sftp<void>((s, done) => s.chown(tmp, old.uid, old.gid, done)).then(() => true, () => false);
          if (!kept) { await drop(); return inPlace(); }
        }
      }
      await this.sftp<void>((s, done) => s.chmod(tmp, old ? old.mode & 0o7777 : 0o644, done));
      await this.sftp<void>((s, done) => {
        // posix-rename replaces the target in one step; plain SFTP rename refuses to.
        try { s.ext_openssh_rename(tmp, path, done); } catch { s.rename(tmp, path, done); }
      });
    } catch (err) {
      await drop();
      throw err;
    }
  }

  private async open(path: string, mode: "r" | "r+"): Promise<void> {
    const handle = await this.sftp<Buffer>((s, done) => s.open(path, mode, done));
    await this.sftp<void>((s, done) => s.close(handle, done));
  }

  ops(): ToolOps {
    const readFile = async (p: string) => { const q = await this.inside(p); return this.sftp<Buffer>((s, done) => s.readFile(q, done)); };
    const writeFile = async (p: string, content: string | Buffer) => this.write(await this.inside(p), content);
    return {
      read: {
        readFile,
        access: async (p) => this.open(await this.inside(p), "r"),
        detectImageMimeType: async (p) => {
          const q = await this.inside(p);
          const handle = await this.sftp<Buffer>((s, done) => s.open(q, "r", done));
          const head = Buffer.alloc(16);
          try {
            await this.sftp<number>((s, done) => s.read(handle, head, 0, 16, 0, (err, n) => done(err, n)));
          } finally {
            await this.sftp<void>((s, done) => s.close(handle, done));
          }
          return sniffImage(head);
        },
      },
      write: {
        writeFile,
        mkdir: async (dir) => {
          const code = await this.run(`mkdir -p -- ${quote(await this.inside(dir))}`, { onData: () => {} });
          if (code !== 0) throw new Error(`could not create ${dir} on ${this.cfg.name}`);
        },
      },
      edit: { readFile, writeFile, access: async (p) => this.open(await this.inside(p), "r+") },
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
