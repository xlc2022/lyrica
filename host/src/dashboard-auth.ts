// Who may use the dashboard: anyone at the machine, or someone remote with the
// password, from a page the host served itself (Host and Origin checks).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const N = 1 << 15;
const SCRYPT = { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString("base64")}$${scryptSync(password, salt, 32, SCRYPT).toString("base64")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [kind, n, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), want.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(want, got);
}

/** Login sessions, in memory only: a restart signs everyone out. */
export class Sessions {
  static readonly LIFETIME_MS = 12 * 3_600_000;
  private readonly live = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  start(): string {
    const token = randomBytes(32).toString("base64url");
    this.live.set(token, this.now() + Sessions.LIFETIME_MS);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.live.get(token);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.live.delete(token);
      return false;
    }
    return true;
  }

  end(token: string | undefined): void {
    if (token) this.live.delete(token);
  }

  endAll(): void {
    this.live.clear();
  }
}

/** Failed logins: 5 per address and 20 in all per 15 minutes. */
export class LoginLimit {
  static readonly WINDOW_MS = 15 * 60_000;
  private failures: { address: string; at: number }[] = [];

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  allowed(address: string): boolean {
    const since = this.now() - LoginLimit.WINDOW_MS;
    this.failures = this.failures.filter((f) => f.at > since);
    return this.failures.length < 20 && this.failures.filter((f) => f.address === address).length < 5;
  }

  failed(address: string): void {
    this.failures.push({ address, at: this.now() });
  }
}

export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function hostname(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The browser checks: the Host header must name this host, and a request
 * from a page must come from one of this host's own origins. A page elsewhere
 * (or a DNS-rebinding name) can't drive the dashboard.
 */
export function browserCheck(req: IncomingMessage, scheme: "http" | "https", isOurs: (name: string) => boolean): string | null {
  const host = hostname(req.headers.host ?? "");
  if (!host || !isOurs(host)) return "Unknown Host header.";
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return "Cross-site requests aren't accepted.";
  const origin = req.headers.origin;
  if (origin === undefined) {
    // Browsers send Origin on every non-GET request; tools like curl send neither.
    return req.method === "GET" || req.method === "HEAD" || site === undefined ? null : "Missing Origin header.";
  }
  try {
    const url = new URL(origin);
    if (url.protocol !== `${scheme}:` || !isOurs(url.hostname.replace(/^\[|\]$/g, "").toLowerCase())) return "Foreign Origin.";
  } catch {
    return "Foreign Origin.";
  }
  return null;
}
