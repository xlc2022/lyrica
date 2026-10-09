import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEncrypted, USER_SCHEMA, type Db } from "./db.ts";
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
    openEncrypted(join(this.userDir(user.id), "user.db"), { raw: dataKey }).exec(USER_SCHEMA).close();
    dataKey.fill(0);

    this.db.prepare("INSERT INTO users (id, login, admin, profile, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, user.login, user.admin ? 1 : 0, JSON.stringify(full), JSON.stringify(wrapped), new Date().toISOString());
    return user;
  }

  /** Checks the password and unlocks the user's key. */
  async authenticate(login: string, password: string): Promise<User> {
    const user = this.find(login);
    if (!user) {
      this.dummy ??= this.keyring.wrap(randomBytes(32), randomBytes(16).toString("hex"));
      await this.keyring.unwrap(await this.dummy, password).catch(() => {});
      throw new AuthError();
    }
    try {
      await this.keyring.unlockUser(user.id, password);
    } catch (err) {
      if (err instanceof WrongPassword) throw new AuthError();
      throw err;
    }
    return user;
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

  /** Opens the user's user.db. The user must be unlocked. */
  openUserDb(userId: string): Db {
    const db = openEncrypted(join(this.userDir(userId), "user.db"), { raw: this.keyring.userKey(userId) });
    db.exec(USER_SCHEMA);
    return db;
  }

  private adminCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM users WHERE admin = 1").get() as { n: number }).n;
  }
}
