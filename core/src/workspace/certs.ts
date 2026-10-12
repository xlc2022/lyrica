import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

// Certificates for one run's relay (relay.ts): a certificate authority made
// when the run starts, and a certificate it signs for each Git host the relay
// answers for. They live only in memory and only for the run, so there is no
// key to keep or leak afterwards. Node has no API to make a certificate, so
// this writes the few DER structures by hand: ECDSA P-256, SHA-256.

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
};
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};
const name = (cn: string) => seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))));
const time = (d: Date) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...critical ? [der(0x01, Buffer.from([0xff]))] : [], der(0x04, value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const keyId = (spki: Buffer) => createHash("sha1").update(spki).digest();

function certificate(o: { subject: string; spki: Buffer; issuer: string; issuerKey: KeyObject; issuerId: Buffer; extensions: Buffer[] }): string {
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_SHA256,
    name(o.issuer),
    seq(time(new Date(now - 3_600_000)), time(new Date(now + 7 * 86_400_000))),
    name(o.subject),
    o.spki,
    der(0xa3, seq(...o.extensions, ext("2.5.29.35", false, seq(der(0x80, o.issuerId))))),
  );
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign("sha256", tbs, o.issuerKey)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`.replace("\n\n", "\n");
}

/** An IPv6 address's 16 bytes. */
function ipv6(raw: string): Buffer {
  // The URL parser writes an IPv4 tail (::ffff:192.0.2.1) in hex groups.
  const host = new URL(`http://[${raw}]`).hostname.slice(1, -1);
  const [head = "", tail] = host.split("::");
  const groups = (s: string) => s ? s.split(":").map((g) => parseInt(g, 16)) : [];
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  const out = Buffer.alloc(16);
  all.forEach((g, i) => out.writeUInt16BE(g, i * 2));
  return out;
}

const keyPair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/** A run's certificate authority. `cert` is what the run trusts; `issue` makes a host's certificate and key. */
export function makeAuthority(): { cert: string; issue(host: string): { cert: string; key: string } } {
  const ca = keyPair();
  const caSpki = ca.publicKey.export({ type: "spki", format: "der" });
  const caId = keyId(caSpki);
  const subject = "Lyrica sandbox run";
  const cert = certificate({
    subject, spki: caSpki, issuer: subject, issuerKey: ca.privateKey, issuerId: caId,
    extensions: [
      ext("2.5.29.19", true, seq(der(0x01, Buffer.from([0xff])))), // a CA
      ext("2.5.29.15", true, der(0x03, Buffer.from([0x01, 0x06]))), // signs certificates
      ext("2.5.29.14", false, der(0x04, caId)),
    ],
  });
  // One key for every host's certificate: they share the run and its fate.
  const leaf = keyPair();
  const leafSpki = leaf.publicKey.export({ type: "spki", format: "der" });
  const key = leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    cert,
    issue(host) {
      const ip = isIP(host) === 4 ? Buffer.from(host.split(".").map(Number)) : isIP(host) === 6 ? ipv6(host) : undefined;
      return {
        key,
        cert: certificate({
          subject: host, spki: leafSpki, issuer: subject, issuerKey: ca.privateKey, issuerId: caId,
          extensions: [
            ext("2.5.29.19", true, seq()),
            ext("2.5.29.15", true, der(0x03, Buffer.from([0x07, 0x80]))), // signs handshakes
            ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // a TLS server
            ext("2.5.29.17", false, seq(ip ? der(0x87, ip) : der(0x82, Buffer.from(host)))),
            ext("2.5.29.14", false, der(0x04, keyId(leafSpki))),
          ],
        }),
      };
    },
  };
}
