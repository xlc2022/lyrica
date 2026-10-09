import { randomBytes } from "node:crypto";

/** The login cookie. `__Host-` makes browsers insist on Secure, Path=/ and no Domain. */
export const COOKIE = "__Host-lyrica";
const MAX_AGE_S = 30 * 24 * 3600;

interface Session { users: Set<string>; lastSeen: number }

/**
 * Browser sessions, in memory only. One session can hold several users that
 * belong to the same person (linked users), so switching between them needs
 * no new password. One browser, one person.
 *
 * A session ID is never reused for anyone new: every login gets a fresh one
 * (`login`), and a session ends as soon as it holds no users.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>();

  /** `ended` hears the users of sessions that expired, so their keys can be dropped if they chose that. */
  constructor(private readonly now: () => number = Date.now, private readonly ended: (userIds: string[]) => void = () => {}) {}

  private alive(s: Session): boolean { return this.now() - s.lastSeen <= MAX_AGE_S * 1000; }

  /** The session's users, or undefined for an unknown or expired session. */
  users(id: string | undefined): ReadonlySet<string> | undefined {
    const s = id ? this.sessions.get(id) : undefined;
    if (!s) return undefined;
    if (!this.alive(s)) {
      this.end(id!);
      this.ended([...s.users]);
      return undefined;
    }
    s.lastSeen = this.now();
    return s.users;
  }

  /**
   * A login: a new session with a random 256-bit ID, holding the user and
   * whichever of the old session's users are linked to them. The old session
   * ends. Returns the new ID and the users that had to leave.
   */
  login(old: string | undefined, userId: string, linked: (id: string) => boolean): { id: string; left: string[] } {
    const held = [...(this.users(old) ?? [])].filter((u) => u !== userId);
    const kept = held.filter(linked);
    if (old) this.sessions.delete(old);
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { users: new Set([...kept, userId]), lastSeen: this.now() });
    return { id, left: held.filter((u) => !kept.includes(u)) };
  }

  /** Logs one user out of this session; a session left empty ends. */
  removeUser(id: string, userId: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.users.delete(userId);
    if (!s.users.size) this.sessions.delete(id);
  }

  end(id: string): void { this.sessions.delete(id); }

  /** How many live sessions hold the user: logout drops their key only when none do (and they chose not to stay unlocked). */
  holders(userId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.users.has(userId) && this.alive(s)) n++;
    return n;
  }

  /** After an unlink: no session holds both any more; `other` leaves the ones that held `userId` too. */
  separate(userId: string, other: string): void {
    for (const [id, s] of this.sessions) if (s.users.has(userId)) { s.users.delete(other); if (!s.users.size) this.sessions.delete(id); }
  }

  /** Lock: the user leaves every session; sessions left empty end. */
  dropUser(userId: string): void {
    for (const [id, s] of this.sessions) { s.users.delete(userId); if (!s.users.size) this.sessions.delete(id); }
  }

  /** Ends expired sessions, and returns their users. lyricad runs it now and then. */
  sweep(): string[] {
    const out: string[] = [];
    for (const [id, s] of this.sessions) if (!this.alive(s)) { this.sessions.delete(id); out.push(...s.users); }
    return out;
  }

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
