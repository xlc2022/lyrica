import { SELF_SCHEMA, THREAD_SHARES_SCHEMA, USER_SCHEMA, type Db } from "./db.ts";
import { DELEGATION_SCHEMA } from "./delegation.ts";
import { IDENTITY_SCHEMA } from "./models/host.ts";
import { addNotice, ENDPOINT_SCHEMA, migrate as moveModels, MODEL_CHOICE_SCHEMA, REDIRECT_SCHEMA, upgradeCalls } from "./models/schema.ts";
import { PREFS_SCHEMA } from "./prefs.ts";
import { POOL_SCHEMA, POOL_UPGRADES } from "./store/schema.ts";
import { CHANGES_SCHEMA } from "./workspace/changes.ts";
import { MACHINES_SCHEMA, upgradeWorkspace, WORKSPACE_SCHEMA } from "./workspace/settings.ts";

// Every encrypted database's schema history. Each database records its schema
// version (PRAGMA user_version) and the oldest schema that can still read it
// (meta.min_reader). A step that only adds (expand) leaves min_reader alone; one
// that removes or renames (contract) raises it to its own version, and ships
// only after the release that stopped using what it removes has passed
// probation (DESIGN.md, Updates and self-editing). A database migrates in one
// transaction that checks itself before committing, so a failure leaves it as
// it was.

/** The three kinds of encrypted database: self.db, each user.db, each pool's database. */
export type DbKind = "self" | "user" | "pool";

/** What a step may read besides its own database: user.db's step 1 looks up the shared models self.db kept. */
export interface MigrationContext { self?: Db }

export interface MigrationStep {
  version: number;
  /** Removes or renames something: raises min_reader to this version. */
  contract?: boolean;
  run(db: Db, ctx: MigrationContext): void;
}

/** A database written by a newer release that this one can't read. */
export class SchemaTooNew extends Error {
  constructor(readonly kind: DbKind, readonly minReader: number, readonly schema: number) {
    super(`this ${kind} database needs schema ${minReader} or later; this release has ${schema}`);
    this.name = "SchemaTooNew";
  }
}

/** A migration that broke the database's integrity or foreign keys; nothing was committed. */
export class MigrationFailed extends Error {
  constructor(readonly kind: DbKind, readonly check: string) {
    super(`the ${kind} database failed ${check} after migrating; it was left as it was`);
    this.name = "MigrationFailed";
  }
}

// MigrationStep 1 is the first release's schema. It is a contract because nothing
// before it was a release, and it still brings a pre-release database up in
// place, as each module did by itself before.

/** Host folders an administrator lets each user grant, per pool: in self.db, so no user can widen their own. */
const PATHS_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_paths (
  user_id TEXT NOT NULL,
  pool    TEXT NOT NULL,
  path    TEXT NOT NULL,
  PRIMARY KEY (user_id, pool, path)
);
`;

/** Persona drafts in the originating user's user.db, encrypted with their key. */
const DRAFT_SCHEMA = `
CREATE TABLE IF NOT EXISTS persona_drafts (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  text       TEXT NOT NULL,
  original   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  author     TEXT NOT NULL,
  base       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** daemon/src/projects.ts: thread pins, each project's settings, and which suggested threads were started. IDs and switches only. */
const PROJECTS_SCHEMA = `
-- Threads the user pinned to the top of the thread list.
CREATE TABLE IF NOT EXISTS pinned_threads (
  pool      TEXT NOT NULL,
  thread    TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (pool, thread)
);
-- A project's settings: paused, the model (JSON ModelRef or list), thinking and Fallback (null: the project chat's) its new threads start with, and whether she watches its threads.
CREATE TABLE IF NOT EXISTS project_settings (
  pool     TEXT NOT NULL,
  thread   TEXT NOT NULL,
  paused   INTEGER NOT NULL DEFAULT 0,
  model    TEXT,
  thinking TEXT,
  watch    INTEGER NOT NULL DEFAULT 1,
  fallback INTEGER,
  PRIMARY KEY (pool, thread)
);
-- A suggested thread the user started: the suggest call (its tool call ID), which of its threads, and the thread made.
CREATE TABLE IF NOT EXISTS started_suggestions (
  pool   TEXT NOT NULL,
  thread TEXT NOT NULL,
  call   TEXT NOT NULL,
  idx    INTEGER NOT NULL,
  child  TEXT NOT NULL,
  PRIMARY KEY (pool, thread, call, idx)
);
`;

/** daemon/src/children.ts: a row per child thread, no conversation text. */
const CHILD_THREADS_SCHEMA = `
-- A child thread Lyrica started: whether a turn was running (a restart leaves it idle and tells the parent),
-- its updates to the parent not yet seen, and for a project's thread its anchor (an entry number of the
-- parent), when it was resolved, whether it waits on the user, and whether it is queued.
CREATE TABLE IF NOT EXISTS child_threads (
  pool        TEXT NOT NULL,
  thread      TEXT NOT NULL,
  parent      TEXT NOT NULL,
  working     INTEGER NOT NULL DEFAULT 0,
  unseen      INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  anchor      INTEGER,
  resolved_at TEXT,
  needs_you   INTEGER NOT NULL DEFAULT 0,
  queued      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pool, thread)
);
`;

const hasColumn = (db: Db, table: string, column: string) => !!db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);

/** Pre-release columns added after their tables were made: [table, column, definition]. */
function addColumns(db: Db, columns: [string, string, string][]): void {
  for (const [table, column, def] of columns) if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

export const STEPS: Record<DbKind, MigrationStep[]> = {
  self: [{
    version: 1, contract: true,
    run(db) {
      db.exec(SELF_SCHEMA + PATHS_SCHEMA + IDENTITY_SCHEMA + ENDPOINT_SCHEMA + REDIRECT_SCHEMA);
      // users.recovery_wrap: the user's data key under the server's recovery key
      // (`settings` 'recovery.key'), so an administrator can set a new password
      // without losing their data; password_set_by/_at: an administrator set it
      // and the user hasn't changed it since.
      addColumns(db, [["users", "recovery_wrap", "TEXT"], ["users", "password_set_by", "TEXT"], ["users", "password_set_at", "TEXT"]]);
      moveModels(db, {
        legacy: (pairs) => { for (const p of pairs) db.prepare("INSERT OR IGNORE INTO legacy_refs (endpoint, model, offering) VALUES (?, ?, ?)").run(p.endpoint, p.model, p.offering); },
      });
    },
  }, {
    // Share with (DESIGN.md, "Where things are"): a thread in transit between two users. Expands only.
    version: 2,
    run(db) { db.exec(THREAD_SHARES_SCHEMA); },
  }],
  user: [{
    version: 1, contract: true,
    run(db, { self }) {
      upgradeWorkspace(db);
      db.exec(USER_SCHEMA + PREFS_SCHEMA + WORKSPACE_SCHEMA + MACHINES_SCHEMA + CHANGES_SCHEMA + DELEGATION_SCHEMA + DRAFT_SCHEMA + PROJECTS_SCHEMA);
      db.exec(CHILD_THREADS_SCHEMA);
      addColumns(db, [
        ["subagent_runs", "pick", "TEXT"], ["subagent_runs", "narrowing", "TEXT"], ["subagent_runs", "offering", "TEXT"],
        ["project_settings", "watch", "INTEGER NOT NULL DEFAULT 1"], ["project_settings", "fallback", "INTEGER"],
        ["child_threads", "anchor", "INTEGER"], ["child_threads", "resolved_at", "TEXT"],
        ["child_threads", "needs_you", "INTEGER NOT NULL DEFAULT 0"], ["child_threads", "queued", "INTEGER NOT NULL DEFAULT 0"],
      ]);
      db.exec(ENDPOINT_SCHEMA);
      const dropped = moveModels(db, {
        shared: (endpoint, model) => (self?.prepare("SELECT offering FROM legacy_refs WHERE endpoint = ? AND model = ?").get(endpoint, model) as { offering: string } | undefined)?.offering,
      });
      db.exec(MODEL_CHOICE_SCHEMA);
      upgradeCalls(db);
      if (dropped.length) addNotice(db, [`Models that no longer existed were taken out of your lists: ${dropped.join(", ")}.`]);
    },
  }],
  pool: [{
    version: 1, contract: true,
    run(db) {
      db.exec(POOL_SCHEMA);
      for (const u of POOL_UPGRADES) if (!db.prepare(u.check).get()) db.exec(u.sql);
    },
  }],
};

const last = (steps: MigrationStep[]) => steps[steps.length - 1]!.version;
const lastContract = (steps: MigrationStep[]) => steps.filter((s) => s.contract).reduce((m, s) => Math.max(m, s.version), 0);

/** This release's schema version for each kind of database. */
export const SCHEMA: Record<DbKind, number> = { self: last(STEPS.self), user: last(STEPS.user), pool: last(STEPS.pool) };

/** The min_reader this release leaves on a database it migrated: the oldest schema that can read it. */
export const MIN_READER: Record<DbKind, number> = { self: lastContract(STEPS.self), user: lastContract(STEPS.user), pool: lastContract(STEPS.pool) };

/** A database's schema version and the oldest schema that can read it (0 for a database from before versions). */
export function schemaOf(db: Db): { version: number; minReader: number } {
  const version = db.pragma("user_version", { simple: true }) as number;
  const hasMeta = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const row = hasMeta ? db.prepare("SELECT value FROM meta WHERE key = 'min_reader'").get() as { value: string } | undefined : undefined;
  return { version, minReader: row ? Number(row.value) : 0 };
}

/** Throws SchemaTooNew when this release can't read the database. For read-only opens, which never migrate. */
export function checkReadable(db: Db, kind: DbKind, steps = STEPS[kind]): void {
  const { minReader } = schemaOf(db);
  if (minReader > last(steps)) throw new SchemaTooNew(kind, minReader, last(steps));
}

/**
 * Brings a database up to this release's schema. Refuses one it can't read
 * (SchemaTooNew); leaves a newer one it can read as it is. Otherwise runs the
 * missing steps in one transaction, with foreign keys off as SQLite's ALTER
 * TABLE procedure asks, and commits only if `integrity_check` and
 * `foreign_key_check` pass. Returns the versions it went from and to.
 */
export function migrate(db: Db, kind: DbKind, ctx: MigrationContext = {}, steps = STEPS[kind]): { from: number; to: number } {
  const target = last(steps);
  const { version, minReader } = schemaOf(db);
  if (minReader > target) throw new SchemaTooNew(kind, minReader, target);
  if (version >= target) return { from: version, to: version };
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      let reader = minReader;
      for (const step of steps) {
        if (step.version <= version) continue;
        step.run(db, ctx);
        if (step.contract) reader = Math.max(reader, step.version);
      }
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('min_reader', ?)").run(String(reader));
      db.pragma(`user_version = ${target}`);
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new MigrationFailed(kind, "integrity_check");
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new MigrationFailed(kind, "foreign_key_check");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return { from: version, to: target };
}
