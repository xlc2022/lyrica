import { randomUUID } from "node:crypto";
import { SELF_SCHEMA, THREAD_SHARES_SCHEMA, USER_SCHEMA, type Db } from "./db.ts";
import { DELEGATION_SCHEMA } from "./delegation.ts";
import { IDENTITY_SCHEMA } from "./models/host.ts";
import { addNotice, ENDPOINT_SCHEMA, MIXED_PRESET, migrate as moveModels, MODEL_CHOICE_SCHEMA, PRESET_SCHEMA, REDIRECT_SCHEMA, upgradeCalls, upgradeEndpoints } from "./models/schema.ts";
import { PREFS_SCHEMA } from "./prefs.ts";
import { POOL_SCHEMA, POOL_UPGRADES, ROUTINES_SCHEMA, WAKEUPS_SCHEMA, WATCHES_SCHEMA } from "./store/schema.ts";
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

/** Tokens for Git hosts, one row per account (core/src/workspace/settings.ts, GitAccountConfig). */
const GIT_ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS git_accounts (
  name        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  host        TEXT NOT NULL,
  account     TEXT NOT NULL,
  token       TEXT NOT NULL,
  pool        TEXT NOT NULL,
  off_network INTEGER NOT NULL DEFAULT 0,
  state       TEXT,
  state_since TEXT
);
`;

/** MCP servers she can use, one row per server (core/src/workspace/settings.ts, McpServerConfig). */
const MCP_SERVERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  name        TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  token       TEXT NOT NULL DEFAULT '',
  pool        TEXT NOT NULL,
  description TEXT,
  tools       INTEGER NOT NULL DEFAULT 0,
  off_network INTEGER NOT NULL DEFAULT 0,
  state       TEXT,
  checked_at  TEXT
);
`;

const hasColumn =(db: Db, table: string, column: string) => !!db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);

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
  }, {
    // Principle 1: endpoints.paused_at for a database past step 1 before that step added it, so editing a shared endpoint works. Adds a column only.
    version: 3,
    run(db) { upgradeEndpoints(db); },
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
  }, {
    // Git accounts and each thread's repositories (docs/briefs/repositories.md). Adds only.
    version: 2,
    run(db) {
      db.exec(GIT_ACCOUNTS_SCHEMA);
      addColumns(db, [["thread_workspaces", "repositories", "TEXT NOT NULL DEFAULT '[]'"]]);
    },
  }, {
    // MCP servers and each thread's grants of them (docs/briefs/mcp.md). Adds only.
    version: 3,
    run(db) {
      db.exec(MCP_SERVERS_SCHEMA);
      addColumns(db, [["thread_workspaces", "mcp_servers", "TEXT NOT NULL DEFAULT '[]'"]]);
    },
  }, {
    // Each thread's Claude Code switch (docs/workspace.md, "Claude Code"), off for every thread. Adds only.
    version: 4,
    run(db) { addColumns(db, [["thread_workspaces", "claude_code", "INTEGER NOT NULL DEFAULT 0"]]); },
  }, {
    // Principle 2: the user's portrait-photo cloud choice, default Ask once a day. Expand only.
    version: 5,
    run(db) { db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('images.photos.cloud', 'ask')").run(); },
  }, {
    // Principles 6 and 2: project command rules, expand only.
    version: 6,
    run(db) { addColumns(db, [["project_settings", "command_rules", "TEXT NOT NULL DEFAULT '[]'"]]); },
  }, {
    // A webhook secret per Forgejo/Gitea account (docs/briefs/ci-wakes.md). Adds a column only.
    version: 7,
    run(db) { addColumns(db, [["git_accounts", "webhook_secret", "TEXT"]]); },
  }, {
    // Model presets replace profiles (docs/briefs/model-presets.md). Expands only: the
    // legacy profile tables and thread choices stay, kept in step, so a rollback keeps the user's choices.
    version: 8,
    run(db) {
      addColumns(db, [["thread_choices", "preset", "TEXT"]]);
      db.exec(PRESET_SCHEMA);
      migrateProfilesToPresets(db);
    },
  }, {
    // Principle 1: editable project welcome drafts; expand only.
    version: 9,
    run(db) { addColumns(db, [["project_settings", "draft_goal", "TEXT"], ["project_settings", "draft_instructions", "TEXT"]]); },
  }, {
    // Principles 1 and 2: durable token totals within each pool. Expand only.
    version: 10,
    run(db) {
      addColumns(db, [["model_calls", "read_tokens", "INTEGER"]]);
      db.exec(`CREATE TABLE IF NOT EXISTS call_totals (
        pool TEXT NOT NULL, thread TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0, gpu_ms INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pool, thread, label, kind)
      )`);
    },
  }, {
    // Principles 2 and 6: pushed decision IDs only, in encrypted user.db. Expand only.
    version: 11,
    run(db) { db.exec("CREATE TABLE IF NOT EXISTS push_sent (id TEXT PRIMARY KEY, at INTEGER NOT NULL)"); },
  }, {
    // Principle 1: endpoints.paused_at for a database past step 1 before that step added it, so editing an endpoint works. Adds a column only.
    version: 12,
    run(db) { upgradeEndpoints(db); },
  }, {
    // Principle 1: a thread's own context limit, asked for in plain words. Expand only.
    version: 13,
    run(db) { addColumns(db, [["thread_choices", "context", "INTEGER"]]); },
  }],
  pool: [{
    version: 1, contract: true,
    run(db) {
      db.exec(POOL_SCHEMA);
      for (const u of POOL_UPGRADES) if (!db.prepare(u.check).get()) db.exec(u.sql);
    },
  }, {
    // Reactions on messages (DESIGN.md, Threads): the emoji and who reacted, as JSON; null means none.
    version: 2,
    run(db) { db.exec("ALTER TABLE entries ADD COLUMN reactions TEXT"); },
  }, {
    // The user's unsent composer text, one per thread: kept here, encrypted, never in the browser. Expands only.
    version: 3,
    run(db) {
      db.exec(`CREATE TABLE drafts (
        thread     TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    },
  }, {
    // Wake-ups (DESIGN.md, Projects): a thread's note to itself for later. Adds a table only.
    version: 4,
    run(db) { db.exec(WAKEUPS_SCHEMA); },
  }, {
    // A thread's checklist (DESIGN.md, Projects): the steps she keeps as JSON, encrypted with the pool. Adds a table only.
    version: 5,
    run(db) {
      db.exec(`CREATE TABLE thread_steps (
        thread     TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
        steps      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    },
  }, {
    version: 6,
    run(db) { db.exec(ROUTINES_SCHEMA); },
  }, {
    // Pull requests a thread opened, watched until CI and reviews land (docs/briefs/ci-wakes.md). Adds a table only.
    version: 7,
    run(db) { db.exec(WATCHES_SCHEMA); },
  }, {
    // Principles 1 and 6: question pointers only; all words stay in entries. Expand only.
    version: 8,
    run(db) { db.exec(`CREATE TABLE questions (
      thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      n INTEGER NOT NULL, asked TEXT NOT NULL, closed TEXT, answer TEXT,
      PRIMARY KEY (thread, n)
    ); CREATE UNIQUE INDEX questions_open ON questions(thread) WHERE closed IS NULL`); },
  }],
};

const last = (steps: MigrationStep[]) => steps[steps.length - 1]!.version;
const lastContract = (steps: MigrationStep[]) => steps.filter((s) => s.contract).reduce((m, s) => Math.max(m, s.version), 0);

/**
 * Builds the preset tables from the legacy profiles, once per user: Local and
 * Cloud become built-in presets, a non-empty Custom becomes a general preset
 * named Mixed. The Private column follows Local; the General column follows
 * Cloud or Mixed, as the old default said. Thread choices of cloud/custom
 * become those presets. The legacy tables and settings stay, kept in step by
 * `syncLegacy`, so a rollback keeps the user's choices.
 */
function migrateProfilesToPresets(db: Db): void {
  const now = new Date().toISOString();
  const read = (profile: string) => {
    const out: Record<string, unknown> = {};
    for (const r of db.prepare("SELECT task, entry FROM model_profiles WHERE profile = ?").all(profile) as { task: string; entry: string }[]) {
      out[r.task] = JSON.parse(r.entry);
    }
    return out;
  };
  db.prepare("INSERT INTO model_presets (id, name, scope, builtin, entries, updated_at) VALUES ('builtin.local', 'Local', 'private', 'local', ?, ?)").run(JSON.stringify(read("local")), now);
  db.prepare("INSERT INTO model_presets (id, name, scope, builtin, entries, updated_at) VALUES ('builtin.cloud', 'Cloud', 'general', 'cloud', ?, ?)").run(JSON.stringify(read("cloud")), now);
  let mixed: string | null = null;
  const custom = read("custom");
  if (Object.keys(custom).length) {
    mixed = randomUUID();
    db.prepare("INSERT INTO model_presets (id, name, scope, builtin, entries, updated_at) VALUES (?, 'Mixed', 'general', NULL, ?, ?)").run(mixed, JSON.stringify(custom), now);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(MIXED_PRESET, mixed);
  }
  const generalProfile = (db.prepare("SELECT value FROM settings WHERE key = 'general_profile'").get() as { value: string } | undefined)?.value;
  const generalPreset = generalProfile === "custom" && mixed ? mixed : "builtin.cloud";
  db.prepare("INSERT INTO model_columns (column, preset, from_preset, entries) VALUES ('private', 'builtin.local', NULL, '{}')").run();
  db.prepare("INSERT INTO model_columns (column, preset, from_preset, entries) VALUES ('general', ?, NULL, '{}')").run(generalPreset);
  db.prepare("UPDATE thread_choices SET preset = CASE WHEN profile = 'cloud' THEN 'builtin.cloud' WHEN profile = 'custom' THEN ? ELSE NULL END").run(mixed);
}/** This release's schema version for each kind of database. */
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
