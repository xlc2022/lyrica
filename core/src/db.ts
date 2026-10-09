import { chmodSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";

export type Db = Database.Database;

export type DbKey = { passphrase: string } | { raw: Buffer };

/** Opens (or creates) a SQLCipher database. Throws if the key is wrong. A read-only open never creates or writes. */
export function openEncrypted(path: string, key: DbKey, opts: { readonly?: boolean } = {}): Db {
  const db = new Database(path, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    if ("raw" in key) {
      if (key.raw.length !== 32) throw new Error("database key must be 32 bytes");
      db.pragma(`key = "x'${key.raw.toString("hex")}'"`);
    } else {
      db.pragma(`key = '${key.passphrase.replaceAll("'", "''")}'`);
    }
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    if (opts.readonly) return db;
    chmodSync(path, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** self.db: shared by all users. */
export const SELF_SCHEMA = `
-- Who can log in. The wrapped key lives here because it is needed before user.db
-- can open; the profile, so admins can edit it and mentions render while a user is locked.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  admin       INTEGER NOT NULL,
  profile     TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
-- Every version of every persona file. The latest row per path is current.
CREATE TABLE IF NOT EXISTS persona_revisions (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS persona_revisions_path ON persona_revisions (path, id);
-- Changes to the persona waiting for an administrator. Approving applies one as a revision.
CREATE TABLE IF NOT EXISTS persona_proposals (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  text       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  author     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Global settings by key, such as the sleep time.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** user.db: one per user, encrypted with that user's data key. */
export const USER_SCHEMA = `
-- Small per-user settings by key, such as default network switches. Models and
-- Workspace keep their own tables.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
