import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEncrypted, USER_SCHEMA, type Db } from "./db.ts";
import { WrongPassword, type Keyring } from "./keyring.ts";

export interface User {
  id: string;
  name: string;
  admin: boolean;
}

export class AuthError extends Error {
  constructor() { super("wrong name or password"); }
}

export class Forbidden extends Error {}

interface Row { id: string; name: string; admin: number }
const toUser = (r: Row): User => ({ id: r.id, name: r.name, admin: r.admin === 1 });

/** Local accounts. The index lives in self.db; each user's data lives in their own user.db. */
export class Users {
  constructor(private readonly keyring: Keyring) {}

  private get db(): Db { return this.keyring.self(); }

  userDir(userId: string): string { return join(this.keyring.home, "users", userId); }

  async createUser(name: string, password: string, opts: { admin: boolean }): Promise<User> {
    name = name.trim();
    if (!name) throw new Error("name must not be empty");
    if (!password) throw new Error("password must not be empty");
    if (this.find(name)) throw new Error(`user ${name} already exists`);
    if (!opts.admin && this.adminCount() === 0) throw new Error("the first user must be an administrator");

    const user: User = { id: randomUUID(), name, admin: opts.admin };
    const dataKey = randomBytes(32);
    const wrapped = await this.keyring.wrap(dataKey, password);
    mkdirSync(this.userDir(user.id), { recursive: true, mode: 0o700 });
    const udb = openEncrypted(join(this.userDir(user.id), "user.db"), { raw: dataKey });
    udb.exec(USER_SCHEMA);
    udb.prepare("INSERT INTO settings (key, value) VALUES ('display_name', ?)").run(name);
    udb.close();
    dataKey.fill(0);

    this.db.prepare("INSERT INTO users (id, name, admin, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.name, user.admin ? 1 : 0, JSON.stringify(wrapped), new Date().toISOString());
    return user;
  }

  /** Checks the password and unlocks the user's key. */
  async authenticate(name: string, password: string): Promise<User> {
    const user = this.find(name);
    if (!user) throw new AuthError();
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
    if (!this.find(actor.name)?.admin) throw new Forbidden("only an administrator can change administrator status");
    const current = this.find(target.name);
    if (!current) throw new Error(`no such user: ${target.name}`);
    if (!admin && current.admin && this.adminCount() === 1) throw new Forbidden("the last administrator can't be demoted");
    this.db.prepare("UPDATE users SET admin = ? WHERE id = ?").run(admin ? 1 : 0, current.id);
  }

  /** Administrators see everyone; other users see themselves. */
  listUsers(actor: User): User[] {
    const all = this.all();
    return this.find(actor.name)?.admin ? all : all.filter((u) => u.id === actor.id);
  }

  /** Every user, for the operator's admin commands. */
  all(): User[] {
    return (this.db.prepare("SELECT id, name, admin FROM users ORDER BY created_at, name").all() as Row[]).map(toUser);
  }

  find(name: string): User | undefined {
    const row = this.db.prepare("SELECT id, name, admin FROM users WHERE name = ?").get(name.trim()) as Row | undefined;
    return row && toUser(row);
  }

  /** Opens the user's user.db. The user must be unlocked. */
  openUserDb(userId: string): Db {
    const db = openEncrypted(join(this.userDir(userId), "user.db"), { raw: this.keyring.userKey(userId) });
    db.exec(USER_SCHEMA);
    return db;
  }

  displayName(user: User): string {
    const db = this.openUserDb(user.id);
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'display_name'").get() as { value: string } | undefined;
      return row?.value ?? user.name;
    } finally {
      db.close();
    }
  }

  private adminCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM users WHERE admin = 1").get() as { n: number }).n;
  }
}
