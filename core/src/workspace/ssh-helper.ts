// The SSH client for one connection, run by SshTarget (ssh.ts) as its own
// process inside a sandbox that reaches only that machine's address and port.
// It holds that machine's key and nothing else of lyricad's, so a server that
// breaks the SSH library gets a key it could already use, not lyricad's memory.
//
// It speaks frames (ssh-frames.ts) on stdin and stdout. The first frame is
// `connect`, with the private key as its body. The host key is sent back for
// lyricad to judge; the connection goes on only on a yes. It exits when stdin
// closes, so it never outlives lyricad.
//
// Run with Node's type stripping, so only erasable TypeScript here.

import ssh2 from "ssh2";
import type { ClientChannel, SFTPWrapper, Stats } from "ssh2";
import { capOutput } from "./ops.ts";
import { decoder, encode, type Frame } from "./ssh-frames.ts";

const send = (head: object, body?: Buffer) => { process.stdout.write(encode(head, body)); };
const client = new ssh2.Client();
const streams = new Map<number, ClientChannel>();
let sftp: SFTPWrapper | undefined;
let answerHostKey: ((ok: boolean) => void) | undefined;

function connect(head: Frame["head"], key: Buffer): void {
  client.on("error", (err) => send({ ev: "error", message: err.message }));
  client.on("close", () => { send({ ev: "closed" }); process.exit(0); });
  client.on("ready", () => {
    // Strict key exchange (the Terrapin fix) is required, not just preferred.
    if ((client as unknown as { _protocol?: { _strictMode?: boolean } })._protocol?._strictMode !== true) {
      send({ ev: "error", message: "the server doesn't offer strict key exchange; update its OpenSSH" });
      return void client.end();
    }
    client.sftp((err, s) => {
      if (err) return send({ ev: "error", message: err.message });
      sftp = s;
      s.realpath(".", (err2, home) => send(err2 ? { ev: "error", message: err2.message } : { ev: "ready", home }));
    });
  });
  client.connect({
    host: String(head.host),
    port: Number(head.port),
    username: String(head.username),
    privateKey: key.length ? key : undefined,
    readyTimeout: 10_000,
    agent: undefined,
    hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => {
      answerHostKey = verify;
      send({ ev: "hostkey" }, hostKey);
    },
  });
}

const statsOf = (st: Stats) => ({ mode: st.mode, uid: st.uid, gid: st.gid, symlink: st.isSymbolicLink() });

/** One SFTP or exec request. Replies with the same id: `ok`, or `error` with SFTP's status code. */
function request(id: number, head: Frame["head"], body: Buffer): void {
  const done = (err: (Error & { code?: unknown }) | null | undefined, reply: object = {}, out?: Buffer) =>
    send(err ? { id, error: err.message, code: typeof err.code === "number" ? err.code : undefined } : { id, ok: true, ...reply }, out);
  const s = sftp;
  if (!s) return done(new Error("not connected"));
  const path = String(head.path);
  switch (head.op) {
    case "realpath": return s.realpath(path, (err, value) => done(err, { value }));
    case "lstat": return s.lstat(path, (err, st) => done(err, err ? {} : { stats: statsOf(st) }));
    case "readFile": return s.readFile(path, (err, data) => done(err, {}, data));
    case "head": {
      return s.open(path, "r", (err, handle) => {
        if (err) return done(err);
        const buf = Buffer.alloc(Number(head.length));
        s.read(handle, buf, 0, buf.length, 0, (err2, n) => s.close(handle, () => done(err2, {}, buf.subarray(0, n))));
      });
    }
    case "access": {
      const mode = head.mode === "r+" ? "r+" : "r";
      return s.open(path, mode, (err, handle) => (err ? done(err) : s.close(handle, (err2) => done(err2))));
    }
    case "writeFile": {
      const opts = typeof head.mode === "number" ? { mode: head.mode } : {};
      return s.writeFile(path, body, opts, (err) => done(err));
    }
    case "chmod": return s.chmod(path, Number(head.mode), (err) => done(err));
    case "chown": return s.chown(path, Number(head.uid), Number(head.gid), (err) => done(err));
    case "unlink": return s.unlink(path, (err) => done(err));
    case "rename": {
      // posix-rename replaces the target in one step; plain SFTP rename refuses to.
      const to = String(head.to);
      try { return s.ext_openssh_rename(path, to, (err) => done(err)); } catch { return s.rename(path, to, (err) => done(err)); }
    }
    case "exec": {
      client.exec(String(head.command), (err, stream) => {
        if (err) return done(err);
        streams.set(id, stream);
        // Capped here, before it crosses the pipe.
        const out = capOutput((d) => send({ id, ev: "data" }, d));
        stream.on("data", (d: Buffer) => out.push(d));
        stream.stderr.on("data", (d: Buffer) => out.push(d));
        stream.on("close", (code: number | null) => {
          streams.delete(id);
          out.end();
          done(null, { code: typeof code === "number" ? code : null });
        });
      });
      return;
    }
    case "kill": {
      const stream = streams.get(Number(head.target));
      stream?.signal("KILL");
      stream?.close();
      return done(null);
    }
    default: return done(new Error(`unknown request ${String(head.op)}`));
  }
}

const feed = decoder(({ head, body }) => {
  if (head.op === "connect") return connect(head, body);
  if (head.op === "hostkey") { answerHostKey?.(head.ok === true); answerHostKey = undefined; return; }
  request(Number(head.id), head, body);
});
process.stdin.on("data", (chunk: Buffer) => feed(chunk));
process.stdin.on("end", () => process.exit(0));
