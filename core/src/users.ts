import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEncrypted, type Db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { WrongPassword, type Keyring, type WrappedKey } from "./keyring.ts";
import { checkProfile, type Profile } from "./profile.ts";

export interface User {
  id: string;
  /** Used to sign in. Separate from the display name, so renames never affect it. */
  login: string;
  admin: boolean;
  profile: Profile;
}

/** null clears the accent or monogram. */
export type ProfileChange = Partial<Pick<Profile, "displayName" | "pronouns">> & { accent?: string | null; monogram?: string | null };

export class AuthError extends Error {
  constructor() { super("wrong login or password"); }
}

export class Forbidden extends Error {}

interface Row { id: string; login: string; admin: number; profile: string }
const toUser = (r: Row): User => ({ id: r.id, login: r.login, admin: r.admin === 1, profile: JSON.parse(r.profile) });
const COLUMNS = "id, login, admin, profile";

/** Local accounts. The index lives in self.db; each user's data lives in their own user.db. */
export class Users {
  /** Unlocked against for unknown logins, so the time taken doesn't tell which names exist. */
  private dummy: Promise<WrappedKey> | undefined;
  /** Users whose user.db this process has already migrated. */
  private readonly migrated = new Set<string>();

  constructor(private readonly keyring: Keyring) {}

  private get db(): Db { return this.keyring.self(); }

  userDir(userId: string): string { return join(this.keyring.home, "users", userId); }

  async createUser(login: string, password: string, profile: Omit<Profile, "previousNames">, opts: { admin: boolean }): Promise<User> {
    login = login.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(login)) throw new Error("login names use letters, digits, '.', '_' and '-'");
    if (!password) throw new Error("password must not be empty");
    if (this.find(login)) throw new Error(`user ${login} already exists`);
    if (!opts.admin && this.adminCount() === 0) throw new Error("the first user must be an administrator");
    const full: Profile = { ...profile, displayName: profile.displayName.trim(), previousNames: [] };
    checkProfile(full);

    const user: User = { id: randomUUID(), login, admin: opts.admin, profile: full };
    const dataKey = randomBytes(32);
    const wrapped = await this.keyring.wrap(dataKey, password);
    mkdirSync(this.userDir(user.id), { recursive: true, mode: 0o700 });
    const db = openEncrypted(join(this.userDir(user.id), "user.db"), { raw: dataKey });
    try { migrate(db, "user", { self: this.db }); } finally { db.close(); }
    dataKey.fill(0);

    this.db.prepare("INSERT INTO users (id, login, admin, profile, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, user.login, user.admin ? 1 : 0, JSON.stringify(full), JSON.stringify(wrapped), new Date().toISOString());
    return user;
  }

  /** Checks the password and unlocks the user's key. */
  async authenticate(login: string, password: string): Promise<User> {
    const user = this.find(login);
    if (!user) return this.unknown(password);
    try {
      await this.keyring.unlockUser(user.id, password);
    } catch (err) {
      if (err instanceof WrongPassword) throw new AuthError();
      throw err;
    }
    return user;
  }

  /** For a login that doesn't exist: Argon2 runs anyway, so the time taken doesn't tell. Always throws AuthError. */
  private async unknown(password: string): Promise<never> {
    this.dummy ??= this.keyring.wrap(randomBytes(32), randomBytes(16).toString("hex"));
    await this.keyring.unwrap(await this.dummy, password).catch(() => {});
    throw new AuthError();
  }

  /** Checks a password without unlocking anything. Throws AuthError if it's wrong. */
  private async verify(user: User, password: string): Promise<void> {
    const row = this.db.prepare("SELECT wrapped_key FROM users WHERE id = ?").get(user.id) as { wrapped_key: string } | undefined;
    if (!row) throw new AuthError();
    try {
      (await this.keyring.unwrap(JSON.parse(row.wrapped_key), password)).fill(0);
    } catch (err) {
      if (err instanceof WrongPassword) throw new AuthError();
      throw err;
    }
  }

  /**
   * Links two users that belong to the same person, so one browser may hold
   * both. It takes both passwords: one person proves they are both. The other
   * user is named by login, and an unknown login costs the same Argon2 as a
   * known one, so linking can't be used to find which names exist.
   */
  async link(a: User, aPassword: string, otherLogin: string, bPassword: string): Promise<void> {
    await this.verify(a, aPassword);
    const b = this.find(otherLogin);
    if (!b) return this.unknown(bPassword);
    await this.verify(b, bPassword);
    if (a.id === b.id) throw new Error("a user is already themself");
    const [x, y] = [a.id, b.id].sort() as [string, string];
    this.db.prepare("INSERT OR IGNORE INTO user_links (a, b) VALUES (?, ?)").run(x, y);
  }

  /** Either of the two may undo a link. */
  unlink(actor: User, other: User): void {
    const [x, y] = [actor.id, other.id].sort() as [string, string];
    if (!this.db.prepare("DELETE FROM user_links WHERE a = ? AND b = ?").run(x, y).changes) throw new Error(`${other.login} isn't linked to ${actor.login}`);
  }

  /** The users linked to this one. */
  linked(userId: string): string[] {
    return (this.db.prepare("SELECT CASE WHEN a = ? THEN b ELSE a END AS id FROM user_links WHERE a = ? OR b = ?").all(userId, userId, userId) as { id: string }[])
      .map((r) => r.id);
  }

  /** Whether logging out keeps the user's key in memory (so sleep can run). Their choice, in their user.db; on by default. */
  stayUnlocked(userId: string): boolean {
    const db = this.openUserDb(userId);
    try {
      return (db.prepare("SELECT value FROM settings WHERE key = 'stay_unlocked'").get() as { value: string } | undefined)?.value !== "off";
    } finally {
      db.close();
    }
  }

  setStayUnlocked(userId: string, on: boolean): void {
    const db = this.openUserDb(userId);
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stay_unlocked', ?)").run(on ? "on" : "off");
    } finally {
      db.close();
    }
  }

  /** Rewraps the same data key under the new password. Data is not re-encrypted. */
  async changePassword(user: User, oldPassword: string, newPassword: string): Promise<void> {
    if (!newPassword) throw new Error("password must not be empty");
    const row = this.db.prepare("SELECT wrapped_key FROM users WHERE id = ?").get(user.id) as { wrapped_key: string };
    let dataKey: Buffer;
    try {
      dataKey = await this.keyring.unwrap(JSON.parse(row.wrapped_key), oldPassword);
    } catch (err) {
      if (err instanceof WrongPassword) throw new AuthError();
      throw err;
    }
    const wrapped = await this.keyring.wrap(dataKey, newPassword);
    dataKey.fill(0);
    this.db.prepare("UPDATE users SET wrapped_key = ? WHERE id = ?").run(JSON.stringify(wrapped), user.id);
  }

  setAdmin(actor: User, target: User, admin: boolean): void {
    if (!this.get(actor.id)?.admin) throw new Forbidden("only an administrator can change administrator status");
    const current = this.get(target.id);
    if (!current) throw new Error(`no such user: ${target.login}`);
    if (!admin && current.admin && this.adminCount() === 1) throw new Forbidden("the last administrator can't be demoted");
    this.db.prepare("UPDATE users SET admin = ? WHERE id = ?").run(admin ? 1 : 0, current.id);
  }

  /** Changes display name, pronouns, accent or monogram, as the user themself or an administrator. A rename keeps the old name. */
  updateProfile(actor: User, target: User, change: ProfileChange): Profile {
    const current = this.get(target.id);
    if (!current) throw new Error(`no such user: ${target.login}`);
    if (actor.id !== current.id && !this.get(actor.id)?.admin) throw new Forbidden("only the user or an administrator can change a profile");
    const old = current.profile;
    const next: Profile = {
      displayName: change.displayName?.trim() ?? old.displayName,
      pronouns: change.pronouns ?? old.pronouns,
      previousNames: [...old.previousNames],
    };
    const accent = change.accent === undefined ? old.accent : change.accent ?? undefined;
    const monogram = change.monogram === undefined ? old.monogram : change.monogram ?? undefined;
    if (accent !== undefined) next.accent = accent;
    if (monogram !== undefined) next.monogram = monogram;
    if (next.displayName !== old.displayName) {
      next.previousNames.push({ name: old.displayName, until: new Date().toISOString().slice(0, 10) });
    }
    checkProfile(next);
    this.db.prepare("UPDATE users SET profile = ? WHERE id = ?").run(JSON.stringify(next), current.id);
    return next;
  }

  /** Administrators see everyone; other users see themselves. */
  listUsers(actor: User): User[] {
    const all = this.all();
    return this.get(actor.id)?.admin ? all : all.filter((u) => u.id === actor.id);
  }

  /** Every user, for the operator's admin commands. */
  all(): User[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, login`).all() as Row[]).map(toUser);
  }

  find(login: string): User | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE login = ?`).get(login.trim()) as Row | undefined;
    return row && toUser(row);
  }

  get(id: string): User | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row | undefined;
    return row && toUser(row);
  }

  /** Opens the user's user.db, migrated to this release's schema the first time in this process. The user must be unlocked. */
  openUserDb(userId: string): Db {
    const db = openEncrypted(join(this.userDir(userId), "user.db"), { raw: this.keyring.userKey(userId) });
    if (!this.migrated.has(userId)) {
      try { migrate(db, "user", { self: this.db }); } catch (err) { db.close(); throw err; }
      this.migrated.add(userId);
    }
    return db;
  }

  private adminCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM users WHERE admin = 1").get() as { n: number }).n;
  }
}
