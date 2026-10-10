// The model host client: Lyrica's own key and certificate, pairing, and
// calls over mutual TLS with the host's pinned key, exactly as host/PAIRING.md
// specifies. Nothing here logs request or response bodies.

import { createHash, createHmac, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { request } from "node:http";
import { connect, type TLSSocket } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import type { Db } from "../db.ts";

/** The host presented a key other than the pinned one. The connection is closed before anything is sent. */
export class HostIdentityChanged extends Error {
  constructor() { super("This host's identity changed. Pair it again."); }
}
/** Pairing was refused or couldn't be completed, with a plain reason. */
export class PairingFailed extends Error {}

export interface Identity { key: string; cert: string; fingerprint: string }

/** The host's default port. */
export const HOST_PORT = 7236;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** SHA-256 of the certificate's DER SubjectPublicKeyInfo, as lowercase hex. */
export function fingerprint(cert: string | Buffer | X509Certificate): string {
  const x = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  return createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

/** A typed pairing code, normalised; throws without contacting anyone if it can't be one. */
export function normaliseCode(typed: string): string {
  const code = typed.toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== 16 || [...code].some((c) => !ALPHABET.includes(c))) throw new PairingFailed("A pairing code is 16 letters and digits, as the host's dashboard shows it.");
  return code;
}

const b64u = (b: Buffer) => b.toString("base64url");

/** Both pairing proofs for one exchange. */
export function pairingProofs(code: string, hostFp: string, clientFp: string, clientNonce: string): { client: string; host: string } {
  const k = Buffer.from(hkdfSync("sha256", Buffer.from(code, "ascii"), Buffer.alloc(0), "lyrica-pair-v1", 32));
  const mac = (who: string) => b64u(createHmac("sha256", k).update(`lyrica-pair-v1/${who}\n${hostFp}\n${clientFp}\n${clientNonce}`).digest());
  return { client: mac("client"), host: mac("host") };
}

// --- Lyrica's own key and certificate, one per lyricad, in self.db ---

const IDENTITY_SCHEMA = `
-- This lyricad's key and self-signed certificate, presented to model hosts.
CREATE TABLE IF NOT EXISTS host_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  key        TEXT NOT NULL,
  cert       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** This lyricad's identity, made on first use and kept in self.db. */
export function lyricaIdentity(self: Db, name = "Lyrica"): Identity {
  self.exec(IDENTITY_SCHEMA);
  let row = self.prepare("SELECT key, cert FROM host_identity WHERE id = 1").get() as { key: string; cert: string } | undefined;
  if (!row) {
    const made = makeIdentity(name);
    self.prepare("INSERT INTO host_identity (id, key, cert, created_at) VALUES (1, ?, ?, ?)").run(made.key, made.cert, new Date().toISOString());
    row = made;
  }
  return { key: row.key, cert: row.cert, fingerprint: fingerprint(row.cert) };
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const ECDSA_SHA256 = der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
const COMMON_NAME = der(0x06, Buffer.from([0x55, 0x04, 0x03]));
const dname = (cn: string) => seq(der(0x31, seq(COMMON_NAME, der(0x0c, Buffer.from(cn, "utf8")))));
const time = (d: Date) => {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(s.slice(2))) : der(0x18, Buffer.from(s));
};

/** An ECDSA P-256 key and a self-signed certificate for it. Node has no certificate builder, so this writes the DER. */
export function makeIdentity(commonName: string): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), seq(ECDSA_SHA256), dname(commonName),
    seq(time(new Date(Date.now() - 86_400_000)), time(new Date("9999-12-31T23:59:59Z"))), dname(commonName),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const cert = seq(tbs, seq(ECDSA_SHA256), der(0x03, Buffer.from([0]), sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" })));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: pem, fingerprint: fingerprint(pem) };
}

// --- Addresses and connections ---

/** An address as typed (a LAN address, a tailnet name, with or without a port) as an https origin. */
export function hostOrigin(address: string): string {
  const a = address.trim();
  if (/^[a-z]+:\/\//i.test(a)) {
    const u = new URL(a);
    if (u.protocol !== "https:") throw new Error("a model host is reached over https");
    return `https://${u.hostname.includes(":") ? `[${u.hostname.replace(/^\[|\]$/g, "")}]` : u.hostname}:${u.port || HOST_PORT}`;
  }
  if (isIP(a) === 6) return `https://[${a}]:${HOST_PORT}`;
  const u = new URL(`https://${a}`);
  if (!u.hostname || u.pathname !== "/" || u.search) throw new Error(`${address} isn't a host address`);
  return `https://${u.hostname}:${u.port || HOST_PORT}`;
}

/**
 * An undici dispatcher that presents Lyrica's certificate over TLS 1.3 and,
 * before handing the socket over (so before any request byte is written),
 * checks the host's key against the pin. No session resumption, so every
 * connection presents and checks a certificate.
 */
function pinnedAgent(id: Identity, pin: string): Agent {
  return new Agent({
    connect: (opts, callback) => {
      const host = String(opts.hostname);
      open(id, `https://${isIP(host) === 6 ? `[${host}]` : host}:${Number(opts.port) || HOST_PORT}`).then(({ socket, fingerprint: fp }) => {
        if (fp !== pin) {
          socket.destroy();
          return callback(new HostIdentityChanged(), null);
        }
        callback(null, socket as never);
      }, (err: Error) => callback(err, null));
    },
  });
}

/** The host error a call failed with, when it is one of the host's own (host/API.md "Errors"). */
export async function hostError(res: Response): Promise<{ code: string; message: string } | undefined> {
  if (res.ok) return undefined;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") return { code: body.error.code, message: String(body.error.message ?? body.error.code) };
  } catch { /* not the host's JSON */ }
  return undefined;
}

/** A socket closed under a request: a kept-alive connection the other side had already closed. */
const reset = (e: unknown) => /ECONNRESET|UND_ERR_SOCKET|other side closed|socket hang up/i.test(`${(e as Error)?.message} ${((e as Error)?.cause as { code?: string; message?: string } | undefined)?.code ?? ""} ${((e as Error)?.cause as Error | undefined)?.message ?? ""}`);

/** Codes after which another model should answer for a while. */
const AWAY = new Set(["paused", "busy", "restarting", "unavailable", "unpaired"]);

/**
 * A fetch for one paired host: each request tries the addresses in order with
 * the pinned key. A changed key ends it at once with the plain reason, never
 * trying the next address. A host that is unreachable, paused, busy,
 * restarting or that no longer knows this server is reported `away`.
 */
export function hostFetch(id: Identity, host: { addresses: string[]; pin: string }, away: (reason: string) => void): typeof fetch {
  const dispatcher = pinnedAgent(id, host.pin);
  const origins = host.addresses.map(hostOrigin);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let last: unknown;
    const method = (init?.method ?? "GET").toUpperCase();
    // A kept-alive connection the host already closed fails before any answer; a GET is safe to send again on a fresh one.
    const attempts = method === "GET" || method === "HEAD" ? 2 : 1;
    for (const origin of origins) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          // undici's own fetch, so the dispatcher and the fetch are the same version.
          const res = (await undiciFetch(new URL(url.pathname + url.search, origin), { ...(init as object), dispatcher })) as unknown as Response;
          const err = await hostError(res);
          if (err && AWAY.has(err.code)) away(err.message);
          return res;
        } catch (e) {
          if ((e as Error).cause instanceof HostIdentityChanged || e instanceof HostIdentityChanged) {
            const message = new HostIdentityChanged().message;
            away(message);
            return new Response(JSON.stringify({ error: { code: "identity_changed", message } }), { status: 502, headers: { "content-type": "application/json" } });
          }
          if ((e as Error).name === "AbortError") throw e;
          last = e;
          if (!reset(e)) break;
        }
      }
    }
    away("it can't be reached");
    throw last;
  }) as typeof fetch;
}

/** One TLS connection presenting Lyrica's certificate, open and checked, with the host's fingerprint. */
function open(id: Identity, origin: string): Promise<{ socket: TLSSocket; fingerprint: string }> {
  const u = new URL(origin);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const socket = connect({
      host, port: Number(u.port) || HOST_PORT, ...(isIP(host) ? {} : { servername: host }),
      key: id.key, cert: id.cert, minVersion: "TLSv1.3", rejectUnauthorized: false, ALPNProtocols: ["http/1.1"],
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error(`connect ETIMEDOUT ${host}`)));
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      const peer = socket.getPeerX509Certificate();
      if (!peer) return socket.destroy(new Error("the host presented no certificate"));
      resolve({ socket, fingerprint: fingerprint(peer) });
    });
    socket.once("error", reject);
  });
}

/** POST of a JSON body on an open socket. */
function post(socket: TLSSocket, origin: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      createConnection: () => socket, method: "POST", path, host: new URL(origin).host,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), connection: "close" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }); } catch { resolve({ status: res.statusCode ?? 0, body: {} }); } });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * Pairs with a host at one of `addresses`, in order: on one TLS connection
 * that presents Lyrica's certificate, reads the host's fingerprint, sends
 * the proof of the code bound to both keys, and checks the host's proof.
 * Returns the host's fingerprint (to pin) and name. Nothing is pinned here;
 * on any failure the caller pins nothing.
 */
export async function pair(id: Identity, addresses: string[], typedCode: string, name: string): Promise<{ fingerprint: string; name: string; address: string }> {
  const code = normaliseCode(typedCode);
  let unreachable: unknown;
  for (const address of addresses) {
    const origin = hostOrigin(address);
    let conn: { socket: TLSSocket; fingerprint: string };
    try {
      conn = await open(id, origin);
    } catch (e) {
      unreachable = e;
      continue;
    }
    try {
      const clientNonce = b64u(randomBytes(32));
      const proofs = pairingProofs(code, conn.fingerprint, id.fingerprint, clientNonce);
      const res = await post(conn.socket, origin, "/pair/v1", { name: name.slice(0, 80), clientNonce, proof: proofs.client });
      const body = res.body as { error?: { code?: string; message?: string }; host?: { name?: string }; proof?: string };
      if (body.error?.code === "no_code") throw new PairingFailed("There is no pairing code on that host now. Make one on its dashboard.");
      if (body.error?.code === "pairing_failed") throw new PairingFailed("The pairing code didn't match. Check it, or make a new one on the host's dashboard.");
      if (res.status !== 200) throw new PairingFailed(body.error?.message ?? `The host refused pairing (${res.status}).`);
      const expected = Buffer.from(proofs.host);
      const got = Buffer.from(String(body.proof ?? ""));
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new PairingFailed("Pairing failed: the host couldn't prove it knows the code.");
      return { fingerprint: conn.fingerprint, name: String(body.host?.name ?? address), address };
    } catch (e) {
      if (e instanceof PairingFailed) throw e;
      unreachable = e;
    } finally {
      conn.socket.destroy();
    }
  }
  throw new PairingFailed(`Couldn't reach the host at ${addresses.join(" or ")}${unreachable instanceof Error && unreachable.message ? ` (${unreachable.message})` : ""}.`);
}
