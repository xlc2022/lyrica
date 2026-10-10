// A long-lived key and a self-signed certificate for it (PAIRING.md, "Keys").
// Node has no certificate builder, so this writes the few DER structures one needs.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fingerprint } from "./pairing.ts";

export interface Identity {
  key: string; // PEM
  cert: string; // PEM
  fingerprint: string;
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const ECDSA_SHA256 = oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2
const COMMON_NAME = oid([0x55, 0x04, 0x03]); // 2.5.4.3
const SUBJECT_ALT_NAME = oid([0x55, 0x1d, 0x11]); // 2.5.29.17

function name(cn: string): Buffer {
  return seq(der(0x31, seq(COMMON_NAME, der(0x0c, Buffer.from(cn, "utf8")))));
}

function time(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(s.slice(2))) : der(0x18, Buffer.from(s));
}

/** A new ECDSA P-256 key and a self-signed certificate that never expires, optionally for some DNS names. */
export function makeIdentity(commonName: string, dnsNames: string[] = []): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, with no leading zero byte (DER wants the shortest form)
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    seq(ECDSA_SHA256),
    name(commonName),
    seq(time(new Date(Date.now() - 86_400_000)), time(new Date("9999-12-31T23:59:59Z"))),
    name(commonName),
    publicKey.export({ type: "spki", format: "der" }),
    ...(dnsNames.length
      ? [der(0xa3, seq(seq(SUBJECT_ALT_NAME, der(0x04, seq(...dnsNames.map((n) => der(0x82, Buffer.from(n, "ascii"))))))))]
      : []),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const cert = seq(tbs, seq(ECDSA_SHA256), der(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: pem, fingerprint: fingerprint(pem) };
}

/** The host's identity from its data folder, made on first start, readable only by its user. */
export function loadIdentity(dir: string, commonName: string): Identity {
  const keyPath = join(dir, "host.key");
  const certPath = join(dir, "host.crt");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const made = makeIdentity(commonName);
    writeFileSync(keyPath, made.key, { mode: 0o600 });
    writeFileSync(certPath, made.cert, { mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  // Refuse a certificate that isn't for this key.
  if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) throw new Error(`${certPath} doesn't match ${keyPath}`);
  return { key, cert, fingerprint: fingerprint(cert) };
}
