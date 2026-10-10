// The pairing exchange from host/PAIRING.md: codes, fingerprints and proofs.
import { X509Certificate, createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INFO = "lyrica-pair-v1";

/** A fresh 16-symbol code, normalised (no dashes). */
export function newCode(): string {
  let code = "";
  for (let i = 0; i < 16; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** `7KQ2M9XD4RTBW1HZ` → `7KQ2-M9XD-4RTB-W1HZ`. */
export function showCode(code: string): string {
  return code.match(/.{4}/g)!.join("-");
}

/** A typed code in normal form, or null if it can't be one. */
export function normaliseCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== 16 || [...code].some((c) => !ALPHABET.includes(c))) return null;
  return code;
}

/** SHA-256 of the certificate's SubjectPublicKeyInfo, lowercase hex. */
export function fingerprint(cert: X509Certificate | string | Buffer): string {
  const x509 = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  return createHash("sha256").update(x509.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

export function pairingKey(code: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(code, "ascii"), Buffer.alloc(0), Buffer.from(INFO), 32));
}

function proof(side: "client" | "host", key: Buffer, hostFp: string, clientFp: string, clientNonce: string): string {
  return createHmac("sha256", key)
    .update(`${INFO}/${side}\n${hostFp}\n${clientFp}\n${clientNonce}`)
    .digest("base64url");
}

export const clientProof = (key: Buffer, hostFp: string, clientFp: string, clientNonce: string) =>
  proof("client", key, hostFp, clientFp, clientNonce);
export const hostProof = (key: Buffer, hostFp: string, clientFp: string, clientNonce: string) =>
  proof("host", key, hostFp, clientFp, clientNonce);

/** Constant-time comparison of two base64url proofs. */
export function sameProof(a: string, b: string): boolean {
  const x = Buffer.from(a, "base64url");
  const y = Buffer.from(b, "base64url");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** The host's one pairing code at a time: 10 minutes, 5 tries. */
export class PairingCodes {
  static readonly LIFETIME_MS = 10 * 60_000;
  static readonly TRIES = 5;
  private current: { code: string; key: Buffer; expires: number; triesLeft: number } | null = null;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Makes a new code, voiding any old one. */
  make(): { code: string; expiresAt: string } {
    const code = newCode();
    const expires = this.now() + PairingCodes.LIFETIME_MS;
    this.current = { code, key: pairingKey(code), expires, triesLeft: PairingCodes.TRIES };
    return { code: showCode(code), expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Checks a client's proof. Returns the host's answering proof, or the
   * reason it failed. A right proof uses the code up; a wrong one uses a try.
   */
  check(hostFp: string, clientFp: string, clientNonce: string, proof: string): { hostProof: string } | { failed: "no_code" | "pairing_failed" } {
    const c = this.current;
    if (!c || c.expires <= this.now() || c.triesLeft <= 0) return { failed: "no_code" };
    if (!sameProof(proof, clientProof(c.key, hostFp, clientFp, clientNonce))) {
      c.triesLeft--;
      return { failed: "pairing_failed" };
    }
    this.current = null;
    return { hostProof: hostProof(c.key, hostFp, clientFp, clientNonce) };
  }

  active(): boolean {
    return !!this.current && this.current.expires > this.now() && this.current.triesLeft > 0;
  }
}
