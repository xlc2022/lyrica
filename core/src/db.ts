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

/**
 * Columns added to self.db since its first release, applied when it opens if
 * missing (expand only; DESIGN.md, Updates and self-editing). users.recovery_wrap:
 * the user's data key under the server's recovery key (`settings` 'recovery.key'),
 * so an administrator can set them a new password without losing their data;
 * users.password_set_by/_at: an administrator set the password and the user hasn't
 * changed it since.
 */
export const SELF_UPGRADES: readonly { table: string; column: string; sql: string }[] = [
  { table: "users", column: "recovery_wrap", sql: "ALTER TABLE users ADD COLUMN recovery_wrap TEXT" },
  { table: "users", column: "password_set_by", sql: "ALTER TABLE users ADD COLUMN password_set_by TEXT" },
  { table: "users", column: "password_set_at", sql: "ALTER TABLE users ADD COLUMN password_set_at TEXT" },
];

/** Runs a schema, then adds the columns later releases introduced. */
export function applySchema(db: Db, schema: string, upgrades: typeof SELF_UPGRADES): void {
  db.exec(schema);
  for (const u of upgrades) {
    const has = (db.pragma(`table_info(${u.table})`) as { name: string }[]).some((c) => c.name === u.column);
    if (!has) db.exec(u.sql);
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
-- Changes to the persona sent on to the administrators. Approving applies one as a revision.
-- They start as drafts in the originating user's user.db (persona_drafts).
-- sent_by: the user who sent it on; edited: whether they changed its text; base: the file's
-- revision when it was drafted, so approving it after the file changed can't silently undo that.
CREATE TABLE IF NOT EXISTS persona_proposals (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  text       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  author     TEXT NOT NULL,
  sent_by    TEXT NOT NULL,
  edited     INTEGER NOT NULL,
  base       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
-- Users that belong to the same person, so one browser may hold them together.
-- One row per pair, smaller ID first: a link is mutual.
CREATE TABLE IF NOT EXISTS user_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
-- A thread one user sent to another (Share with), held here until the recipient adds it to a
-- pool or declines: each user's pools open only with their own key, and self.db is the one place
-- both can reach. entries: the conversation as it was sent, as JSON; nothing of the sender's memory.
-- Accepting or declining deletes the row.
CREATE TABLE IF NOT EXISTS thread_shares (
  id         TEXT PRIMARY KEY,
  from_user  TEXT NOT NULL,
  to_user    TEXT NOT NULL,
  title      TEXT,
  unlogged   INTEGER NOT NULL,
  entries    TEXT NOT NULL,
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
