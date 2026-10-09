import { randomBytes } from "node:crypto";

/** The login cookie. `__Host-` makes browsers insist on Secure, Path=/ and no Domain. */
export const COOKIE = "__Host-lyrica";
const MAX_AGE_S = 30 * 24 * 3600;

interface Session { users: Set<string>; lastSeen: number }

/**
 * Browser sessions, in memory only. One session can hold several users (Li's
 * personas), so switching between them needs no new password.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new session with a random 256-bit ID. */
  create(): string {
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { users: new Set(), lastSeen: this.now() });
    return id;
  }

  /** The session's users, or undefined for an unknown or expired session. */
  users(id: string | undefined): ReadonlySet<string> | undefined {
    const s = id ? this.sessions.get(id) : undefined;
    if (!s) return undefined;
    if (this.now() - s.lastSeen > MAX_AGE_S * 1000) {
      this.sessions.delete(id!);
      return undefined;
    }
    s.lastSeen = this.now();
    return s.users;
  }

  addUser(id: string, userId: string): void { this.sessions.get(id)?.users.add(userId); }

  /** Logs one user out of this session. */
  removeUser(id: string, userId: string): void { this.sessions.get(id)?.users.delete(userId); }

  end(id: string): void { this.sessions.delete(id); }

  /** Lock: the user leaves every session. */
  dropUser(userId: string): void { for (const s of this.sessions.values()) s.users.delete(userId); }

  static setCookie(id: string): string {
    return `${COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE_S}; Secure; HttpOnly; SameSite=Strict`;
  }

  static clearCookie(): string {
    return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
  }
}

/**
 * Slows down repeated failures, per key (a login name, an address). The first
 * few failures are free; after that each attempt waits twice as long as the
 * last, up to a cap. A success clears the key.
 */
export class RateLimiter {
  private readonly failures = new Map<string, { count: number; last: number }>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly opts: { free: number; baseMs: number; maxMs: number; now?: () => number } = { free: 3, baseMs: 1000, maxMs: 15 * 60_000 }) {}

  private get now(): number { return (this.opts.now ?? Date.now)(); }

  /** How long until any of the keys may try again, in ms; 0 if they may now. */
  wait(keys: string[]): number {
    let wait = 0;
    for (const key of keys) {
      const f = this.failures.get(key);
      if (!f || f.count < this.opts.free) continue;
      const delay = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** (f.count - this.opts.free));
      wait = Math.max(wait, f.last + delay - this.now);
    }
    return Math.max(0, wait);
  }

  fail(keys: string[]): void {
    for (const key of keys) {
      const f = this.failures.get(key) ?? { count: 0, last: 0 };
      this.failures.set(key, { count: f.count + 1, last: this.now });
    }
    // Forget old entries, so the map can't grow without bound.
    if (this.failures.size > 10_000) {
      for (const [k, f] of this.failures) if (this.now - f.last > this.opts.maxMs) this.failures.delete(k);
    }
  }

  succeed(keys: string[]): void { for (const key of keys) this.failures.delete(key); }

  /** Takes the keys for one attempt. Only one attempt per key runs at a time, so parallel guesses aren't free. */
  begin(keys: string[]): boolean {
    if (keys.some((k) => this.inFlight.has(k))) return false;
    for (const k of keys) this.inFlight.add(k);
    return true;
  }

  end(keys: string[]): void { for (const k of keys) this.inFlight.delete(k); }
}
