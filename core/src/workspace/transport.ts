// The seam between a machine's policy (SshTarget: root, floor, output
// cleaning, host key pin) and the SSH client that talks to it. The SSH
// helper brief replaces the client behind this interface with a sandboxed
// process per connection; SshTarget doesn't change.

import { createHash } from "node:crypto";
import ssh2, { type Client, type SFTPWrapper } from "ssh2";

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  /** OpenSSH private key, handed over in memory. */
  privateKey: string;
}

export interface RemoteStat { uid: number; gid: number; mode: number; symlink: boolean }

/** Thrown for a path that doesn't exist, by every transport. */
export class RemoteMissing extends Error { readonly code = "ENOENT"; }
export const isMissing = (err: unknown): boolean => err instanceof RemoteMissing;

/** One open connection: a command channel and the SFTP calls SshTarget uses. */
export interface SshSession {
  /** The account's home folder, as the server reports it. */
  readonly home: string;
  /** Runs a command; output streams to `onData` (stdout and stderr together). Resolves to the exit code. */
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
   * No agent, no forwarding. Fails after 10 s.
   */
  connect(to: SshEndpoint, verify: (fingerprint: string) => boolean): Promise<SshSession>;
}

const fingerprint = (key: Buffer): string => `SHA256:${createHash("sha256").update(key).digest("base64")}`;

/** ssh2 in this process. */
export const inProcess: SshTransport = {
  connect(to, verify) {
    return new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      let strict = true;
      const fail = (err: Error) => {
        client.end();
        reject(strict ? err : new Error("the server doesn't support strict key exchange"));
      };
      client.on("error", fail);
      client.on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) return fail(err);
          sftp.realpath(".", (err2, home) => (err2 ? fail(err2) : resolve(session(client, sftp, home))));
        });
      });
      try {
        client.connect({
          host: to.host, port: to.port, username: to.username, privateKey: to.privateKey,
          readyTimeout: 10_000, agent: undefined,
          hostVerifier: (key: Buffer) => {
            // ssh2 offers strict key exchange and decides it from the server's offer before verifying the key.
            strict = (client as unknown as { _protocol?: { _strictMode?: boolean } })._protocol?._strictMode === true;
            return strict && verify(fingerprint(key));
          },
        });
      } catch (err) {
        fail(err as Error);
      }
    });
  },
};

const NO_SUCH_FILE = 2;
function wrap(err: Error | null | undefined, path: string): Error | null {
  if (!err) return null;
  return (err as { code?: number }).code === NO_SUCH_FILE ? new RemoteMissing(`${path}: no such file`) : err;
}

function session(client: Client, sftp: SFTPWrapper, home: string): SshSession {
  const call = <T>(path: string, fn: (done: (err: Error | null | undefined, value?: T) => void) => void) =>
    new Promise<T>((resolve, reject) => fn((err, value) => { const e = wrap(err, path); e ? reject(e) : resolve(value as T); }));
  return {
    home,
    exec: (command, o) => new Promise((resolve, reject) => {
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
    }),
    realpath: (p) => call(p, (done) => sftp.realpath(p, done)),
    lstat: (p) => new Promise((resolve, reject) => sftp.lstat(p, (err, st) => {
      const e = wrap(err, p);
      if (e) return isMissing(e) ? resolve(undefined) : reject(e);
      resolve({ uid: st.uid, gid: st.gid, mode: st.mode, symlink: st.isSymbolicLink() });
    })),
    readFile: (p) => call(p, (done) => sftp.readFile(p, done)),
    readHead: async (p, n) => {
      const handle = await call<Buffer>(p, (done) => sftp.open(p, "r", done));
      const head = Buffer.alloc(n);
      try {
        const got = await call<number>(p, (done) => sftp.read(handle, head, 0, n, 0, (err, bytes) => done(err, bytes)));
        return head.subarray(0, got);
      } finally {
        await call<void>(p, (done) => sftp.close(handle, done));
      }
    },
    check: async (p, mode) => {
      const handle = await call<Buffer>(p, (done) => sftp.open(p, mode, done));
      await call<void>(p, (done) => sftp.close(handle, done));
    },
    writeFile: (p, content, mode) => call(p, (done) => (mode === undefined ? sftp.writeFile(p, content, done) : sftp.writeFile(p, content, { mode }, done))),
    chmod: (p, mode) => call(p, (done) => sftp.chmod(p, mode, done)),
    chown: (p, uid, gid) => call(p, (done) => sftp.chown(p, uid, gid, done)),
    rename: (from, to) => call(to, (done) => {
      // posix-rename replaces the target in one step; plain SFTP rename refuses to.
      try { sftp.ext_openssh_rename(from, to, done); } catch { sftp.rename(from, to, done); }
    }),
    unlink: (p) => call(p, (done) => sftp.unlink(p, done)),
    close: () => client.end(),
    onClose: (listener) => { client.once("close", listener); },
  };
}
