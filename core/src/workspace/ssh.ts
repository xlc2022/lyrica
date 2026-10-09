import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Client, utils, type SFTPWrapper } from "ssh2";
import { capOutput, sniffImage, type ExecutionTarget, type ToolOps } from "./ops.ts";
import { cleanPath, within, type SshTargetConfig } from "./settings.ts";

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64")}`;

/** A new ed25519 key pair in OpenSSH format, generated in memory. */
export function generateSshKey(comment: string): { privateKey: string; publicKey: string } {
  const { private: privateKey, public: publicKey } = utils.generateKeyPairSync("ed25519", { comment });
  return { privateKey, publicKey };
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
      const client = new Client();
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

  private async open(path: string, mode: "r" | "r+"): Promise<void> {
    const handle = await this.sftp<Buffer>((s, done) => s.open(path, mode, done));
    await this.sftp<void>((s, done) => s.close(handle, done));
  }

  ops(): ToolOps {
    const readFile = async (p: string) => { const q = await this.inside(p); return this.sftp<Buffer>((s, done) => s.readFile(q, done)); };
    const writeFile = async (p: string, content: string) => { const q = await this.inside(p); await this.sftp<void>((s, done) => s.writeFile(q, content, done)); };
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
