import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashRaw } from "@node-rs/argon2";

const ARGON2ID = 2; // Algorithm.Argon2id, a const enum
import type { CredentialStore } from "./credentials.ts";
import { openEncrypted, type Db } from "./db.ts";
import { migrate } from "./migrations.ts";

export interface Argon2Params {
  memoryCost: number; // KiB
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Argon2Params = { memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };

/** A user's data key, encrypted (AES-256-GCM) under Argon2id of their password. */
export interface WrappedKey {
  salt: string;
  nonce: string;
  ct: string;
  tag: string;
  argon2: Argon2Params;
}

/** What a subkey is for. Each purpose gets its own key, derived from the user's data key. */
export type SubkeyPurpose = "pool:general" | "pool:private" | "home";

export class WrongPassword extends Error {
  constructor() { super("wrong password"); }
}

export class Locked extends Error {}

/**
 * Holds unlocked keys in process memory only. self.db is opened with the
 * operator's passphrase; each user's data key is unwrapped with their password.
 */
export class Keyring {
  private selfDb: Db | undefined;
  private readonly keys = new Map<string, Buffer>();
  /** Where "save credentials" keeps the self.db passphrase and users' keys. lyricad sets it. */
  credentials: CredentialStore | undefined;

  /** kdfIter: SQLCipher's rounds for the self.db passphrase. Only tests set it, to skip 256,000 rounds of PBKDF2 per open. */
  constructor(readonly home: string, private readonly argon2: Argon2Params = DEFAULT_ARGON2, private readonly kdfIter?: number) {}

  get selfPath(): string { return join(this.home, "self.db"); }
  selfExists(): boolean { return existsSync(this.selfPath); }

  /** Creates self.db. Refuses if it already exists. */
  async initSelf(passphrase: string): Promise<void> {
    if (this.selfExists()) throw new Error(`${this.selfPath} already exists`);
    if (!passphrase) throw new Error("passphrase must not be empty");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.openSelf(passphrase);
  }

  async unlockSelf(passphrase: string): Promise<void> {
    if (!this.selfExists()) throw new Error(`${this.selfPath} does not exist; set Lyrica up first`);
    this.openSelf(passphrase);
  }

  /** Opens self.db and brings it up to this release's schema. A wrong passphrase is WrongPassword; SchemaTooNew and MigrationFailed pass through. */
  private openSelf(passphrase: string): void {
    this.selfDb?.close();
    this.selfDb = undefined;
    let db: Db;
    try {
      db = openEncrypted(this.selfPath, { passphrase, kdfIter: this.kdfIter });
    } catch {
      throw new WrongPassword();
    }
    try {
      migrate(db, "self");
    } catch (err) {
      db.close();
      throw err;
    }
    this.selfDb = db;
  }

  self(): Db {
    if (!this.selfDb) throw new Locked("self.db is locked");
    return this.selfDb;
  }

  /** Closes self.db, if open: it is locked again. */
  closeSelf(): void {
    this.selfDb?.close();
    this.selfDb = undefined;
  }

  async unlockUser(userId: string, password: string): Promise<void> {
    const row = this.self().prepare("SELECT wrapped_key FROM users WHERE id = ?").get(userId) as
      | { wrapped_key: string } | undefined;
    if (!row) throw new Error(`no such user: ${userId}`);
    this.keys.set(userId, await this.unwrap(JSON.parse(row.wrapped_key), password));
  }

  hasUserKey(userId: string): boolean { return this.keys.has(userId); }

  userKey(userId: string): Buffer {
    const key = this.keys.get(userId);
    if (!key) throw new Locked(`user ${userId} is locked`);
    return key;
  }

  /**
   * A 256-bit key for one purpose (a pool database, the encrypted home
   * workspace), derived with HKDF-SHA256 from the user's data key. Purposes
   * never share a key. Throws Locked if the user is locked.
   */
  subkey(userId: string, purpose: SubkeyPurpose): Buffer {
    return Buffer.from(hkdfSync("sha256", this.userKey(userId), Buffer.alloc(0), `lyrica:${purpose}`, 32));
  }

  lockUser(userId: string): void {
    this.keys.get(userId)?.fill(0);
    this.keys.delete(userId);
  }

  /** Saves the user's unlocked data key, so it is available at the next start without their password. */
  async saveUserKey(userId: string): Promise<void> {
    await this.store().save(`user-${userId}`, this.userKey(userId));
  }

  async forgetSavedKey(userId: string): Promise<void> { await this.store().remove(`user-${userId}`); }

  hasSavedKey(userId: string): boolean { return this.credentials?.saved(`user-${userId}`) ?? false; }

  /** Takes the key saved for the user, if one is saved. Returns whether it did. */
  async loadSavedKey(userId: string): Promise<boolean> {
    const key = await this.credentials?.load(`user-${userId}`);
    if (!key) return false;
    if (key.length !== 32) { key.fill(0); return false; }
    this.keys.set(userId, key);
    return true;
  }

  /** Saves the self.db passphrase after checking it, so lyricad can start unlocked. */
  async saveSelfPassphrase(passphrase: string): Promise<void> {
    try {
      openEncrypted(this.selfPath, { passphrase, kdfIter: this.kdfIter }, { readonly: true }).close();
    } catch {
      throw new WrongPassword();
    }
    await this.store().save("self", Buffer.from(passphrase));
  }

  async forgetSelfPassphrase(): Promise<void> { await this.store().remove("self"); }

  hasSavedPassphrase(): boolean { return this.credentials?.saved("self") ?? false; }

  /**
   * Rekeys self.db from `current` to `next`. A wrong current is WrongPassword and changes nothing; an empty next is refused. SQLCipher's rekey takes the new key on the open connection, which the daemon's services hold, so it isn't closed and reopened; a read-only open proves the file opens with `next`. A saved passphrase is re-saved. Neither passphrase is ever logged.
   */
  async changeSelfPassphrase(current: string, next: string): Promise<{ savedCopyRemoved?: true }> {
    if (!next) throw new Error("passphrase must not be empty");
    try {
      openEncrypted(this.selfPath, { passphrase: current, kdfIter: this.kdfIter }, { readonly: true }).close();
    } catch {
      throw new WrongPassword();
    }
    this.self().pragma(`rekey = '${next.replaceAll("'", "''")}'`);
    try {
      openEncrypted(this.selfPath, { passphrase: next, kdfIter: this.kdfIter }, { readonly: true }).close();
    } catch {
      throw new Error("self.db didn't reopen with the new passphrase");
    }
    if (!this.hasSavedPassphrase()) return {};
    // self.db already has the new key: a failed re-save mustn't undo that, and a stale copy must not stay.
    try {
      await this.store().save("self", Buffer.from(next));
      return {};
    } catch {
      await this.forgetSelfPassphrase().catch(() => {});
      return { savedCopyRemoved: true };
    }
  }

  /** Unlocks self.db with the saved passphrase, if there is one. Returns whether it did. */
  async unlockSaved(): Promise<boolean> {
    const saved = await this.credentials?.load("self");
    if (!saved) return false;
    try {
      await this.unlockSelf(saved.toString());
      return true;
    } finally {
      saved.fill(0);
    }
  }

  private store(): CredentialStore {
    if (!this.credentials) throw new Error("saving credentials isn't set up here");
    const why = this.credentials.unavailable();
    if (why) throw new Error(`can't save credentials: ${why}`);
    return this.credentials;
  }

  async wrap(dataKey: Buffer, password: string): Promise<WrappedKey> {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const kek = await this.derive(password, salt, this.argon2);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    const ct = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const b64 = (b: Buffer) => b.toString("base64");
    return { salt: b64(salt), nonce: b64(nonce), ct: b64(ct), tag: b64(cipher.getAuthTag()), argon2: this.argon2 };
  }

  async unwrap(w: WrappedKey, password: string): Promise<Buffer> {
    const b = (s: string) => Buffer.from(s, "base64");
    const kek = await this.derive(password, b(w.salt), w.argon2);
    const decipher = createDecipheriv("aes-256-gcm", kek, b(w.nonce));
    decipher.setAuthTag(b(w.tag));
    try {
      return Buffer.concat([decipher.update(b(w.ct)), decipher.final()]);
    } catch {
      throw new WrongPassword();
    }
  }

  private async derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
    return hashRaw(password, { ...p, salt, outputLen: 32, algorithm: ARGON2ID });
  }
}
