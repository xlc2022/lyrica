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
import { decoder, encode, MAX_BODY, type Frame } from "./ssh-frames.ts";

const send = (head: object, body?: Buffer) => { process.stdout.write(encode(head, body)); };
const client = new ssh2.Client();
const streams = new Map<number, ClientChannel>();
let sftp: SFTPWrapper | undefined;
let answerHostKey: ((ok: boolean) => void) | undefined;
/** The private key: lyricad sends it only with its yes to the host key. */
let key: Buffer | undefined;

function connect(head: Frame["head"]): void {
  const username = String(head.username);
  client.on("error", (err) => send({ ev: "error", message: err.message }));
  client.on("close", () => { send({ ev: "closed" }); process.exit(0); });
  client.on("ready", () => {
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
    readyTimeout: 10_000,
    agent: undefined,
    hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => {
      // Strict key exchange (the Terrapin fix) is required, not just preferred: checked
      // here, where ssh2 has settled it, before the host key is judged or anything is sent.
      if ((client as unknown as { _protocol?: { _strictMode?: boolean } })._protocol?._strictMode !== true) {
        send({ ev: "error", message: "the server doesn't offer strict key exchange; update its OpenSSH" });
        return verify(false);
      }
      answerHostKey = verify;
      send({ ev: "hostkey" }, hostKey);
    },
    // Runs only after the host key was accepted, which is when lyricad sends the key.
    authHandler: (_methods, _partial, next) => {
      const k = key;
      key = undefined;
      // false ends authentication; ssh2's types leave it out.
      (next as (method: unknown) => void)(k ? { type: "publickey", username, key: k } : false);
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
    case "readFile": {
      // Refused here rather than as an oversized frame, which would end the connection.
      return s.stat(path, (err, st) => {
        if (err) return done(err);
        if (st.size > MAX_BODY) return done(new Error(`${path} is larger than ${MAX_BODY / 1024 / 1024} MB`));
        s.readFile(path, (err2, data) => {
          if (err2) return done(err2);
          if (data.length > MAX_BODY) return done(new Error(`${path} grew too large to read`));
          done(null, {}, data);
        });
      });
    }
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
  if (head.op === "connect") return connect(head);
  if (head.op === "hostkey") {
    if (head.ok === true && body.length) key = body;
    answerHostKey?.(head.ok === true);
    answerHostKey = undefined;
    return;
  }
  request(Number(head.id), head, body);
});
process.stdin.on("data", (chunk: Buffer) => feed(chunk));
process.stdin.on("end", () => process.exit(0));
