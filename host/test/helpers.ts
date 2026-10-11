// A reference pairing client and a host on temporary ports, for tests.
import { mkdtempSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { Host, type HostOptions, type Identity, clientProof, fingerprint, hostProof, makeIdentity, normaliseCode, pairingKey, sameProof } from "../src/index.ts";

export class HostIdentityChanged extends Error {}

export interface Reply {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

export interface Call {
  host?: string;
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  /** Sent as is, instead of body as JSON. */
  raw?: Buffer;
  headers?: Record<string, string>;
  identity?: Identity; // the client certificate to present
  pinned?: string; // refuse a host with another fingerprint
  agent?: https.Agent;
  seen?: (hostFp: string) => void;
}

/** One HTTPS request, checking the host's key before anything is written. */
export function call(c: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: c.host ?? "127.0.0.1",
        port: c.port,
        path: c.path,
        method: c.method ?? (c.body === undefined && c.raw === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json", ...c.headers },
        key: c.identity?.key,
        cert: c.identity?.cert,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        agent: c.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("error", reject);
        res.on("close", () => {
          if (!res.complete) reject(new Error("the answer was cut short"));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("socket", (socket) => {
      const check = () => {
        const fp = fingerprint((socket as TLSSocket).getPeerX509Certificate()!);
        c.seen?.(fp);
        if (c.pinned && fp !== c.pinned) req.destroy(new HostIdentityChanged("This host's identity changed. Pair it again."));
      };
      if ((socket as TLSSocket).encrypted && (socket as TLSSocket).getPeerX509Certificate()) check();
      else socket.once("secureConnect", check);
    });
    req.on("error", reject);
    if (c.raw !== undefined) req.write(c.raw);
    else if (c.body !== undefined) req.write(JSON.stringify(c.body));
    req.end();
  });
}

/** Pairs as PAIRING.md says. Returns the host fingerprint to pin. */
export async function pair(port: number, identity: Identity, typed: string, name = "Lyrica test", host?: string): Promise<string> {
  const code = normaliseCode(typed);
  if (!code) throw new Error("not a pairing code");
  const key = pairingKey(code);
  const clientFp = fingerprint(identity.cert);
  const clientNonce = randomBytes(32).toString("base64url");
  let hostFp = "";
  // The proof needs hostFp, which is known only once connected: compute it in a first call.
  await call({ host, port, path: "/dashboard/me", identity, seen: (fp) => (hostFp = fp) });
  const reply = await call({
    host,
    port,
    path: "/pair/v1",
    identity,
    pinned: hostFp,
    body: { name, clientNonce, proof: clientProof(key, hostFp, clientFp, clientNonce) },
  });
  if (reply.status !== 200) throw Object.assign(new Error(reply.body?.error?.code ?? "pairing failed"), { reply });
  if (!sameProof(reply.body.proof, hostProof(key, hostFp, clientFp, clientNonce))) throw new Error("the host's proof is wrong");
  return hostFp;
}

export const quietLog = () => {};

export async function startHost(overrides: Partial<HostOptions> = {}) {
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), "lyrica-host-"));
  const host = new Host({
    dataDir,
    name: "test-host",
    version: "test",
    names: ["127.0.0.1", "test-host"],
    localPeers: ["127.0.0.1"],
    modelsDir: tmpdir(),
    modelsHostPath: "/srv/models",
    log: quietLog,
    ...overrides,
  });
  const ports = await host.listen(0, 0, "127.0.0.1");
  return { host, dataDir, ...ports };
}

export function lyrica(): Identity {
  return makeIdentity("lyrica");
}
