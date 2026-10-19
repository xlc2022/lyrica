import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

/** The settings key holding lines about models rewritten under the user, until they dismiss them. */
export const NOTICE = "models_notice";

export function addNotice(db: Db, lines: string[]): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOTICE) as { value: string } | undefined;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(NOTICE, JSON.stringify([...(row ? JSON.parse(row.value) : []), ...lines]));
}

/** Endpoint tables. In self.db they hold the shared endpoints; in user.db, the user's own. */
export const ENDPOINT_SCHEMA = `
-- A model server. id is permanent; name is a label that can change. kind is
-- declared by whoever adds it (cloud or local), never inferred.
CREATE TABLE IF NOT EXISTS endpoints (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('cloud', 'local')),
  api        TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  api_key    TEXT,
  created_at TEXT NOT NULL,
  -- The first failed check since the last one that answered; NULL while it answers.
  down_since TEXT,
  -- A model host (api 'host'): its addresses in order (JSON) and its pinned key fingerprint.
  addresses  TEXT,
  pin        TEXT,
  -- When a plain endpoint was paused by hand: fallbacks skip it until it is resumed. NULL while it runs.
  paused_at  TEXT
);
-- Each model an endpoint offers, with a permanent id. found: what discovery
-- reported (context window, capabilities); hand: what was set by hand, which
-- wins. manual: added by hand rather than discovered. missing_since: when
-- discovery stopped listing it.
CREATE TABLE IF NOT EXISTS offerings (
  id            TEXT PRIMARY KEY,
  endpoint      TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  found         TEXT NOT NULL DEFAULT '{}',
  hand          TEXT NOT NULL DEFAULT '{}',
  manual        INTEGER NOT NULL,
  missing_since TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (endpoint, model)
);
-- Sampling settings per offering (JSON). In self.db, a shared offering's values;
-- in user.db, the user's own: for their offerings, or over a shared one's.
CREATE TABLE IF NOT EXISTS offering_settings (
  offering TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);
-- Access tokens for gated repositories, by hub (huggingface, modelscope). In
-- self.db, one an administrator shares; in user.db, the user's own.
CREATE TABLE IF NOT EXISTS hub_tokens (
  hub   TEXT PRIMARY KEY,
  token TEXT NOT NULL
);
-- Offerings declared the same model, in preferred order (members: a JSON list of offering IDs).
CREATE TABLE IF NOT EXISTS model_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  members    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Redirects and their bookkeeping, in self.db only. */
export const REDIRECT_SCHEMA = `
-- A replaced offering points at its replacement; a removed one (to_id NULL) is a tombstone.
-- label: the old offering's endpoint label and model, for the notice.
CREATE TABLE IF NOT EXISTS offering_redirects (
  from_id    TEXT PRIMARY KEY,
  to_id      TEXT,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- The users who haven't rewritten their lists for a redirect yet. A redirect
-- with no pending user left is deleted.
CREATE TABLE IF NOT EXISTS redirect_pending (
  from_id TEXT NOT NULL,
  user    TEXT NOT NULL,
  PRIMARY KEY (from_id, user)
);
-- The shared offerings each user's lists name, refreshed when they change, so
-- Clean up can say where a shared model is used and pruning can leave it alone.
CREATE TABLE IF NOT EXISTS shared_refs (
  user TEXT NOT NULL,
  ref  TEXT NOT NULL,
  PRIMARY KEY (user, ref)
);
CREATE TABLE IF NOT EXISTS shared_refs_indexed (
  user TEXT PRIMARY KEY
);
-- Old shared references (shared.<name>, model) and the offerings they became.
CREATE TABLE IF NOT EXISTS legacy_refs (
  endpoint TEXT NOT NULL,
  model    TEXT NOT NULL,
  offering TEXT NOT NULL,
  PRIMARY KEY (endpoint, model)
);
`;

/** Model choices, in user.db. An entry is a JSON list of ModelRefs. */
export const MODEL_CHOICE_SCHEMA = `
-- The profiles: the default models for each task.
CREATE TABLE IF NOT EXISTS model_profiles (
  profile TEXT NOT NULL CHECK (profile IN ('cloud', 'local', 'custom')),
  task    TEXT NOT NULL,
  entry   TEXT NOT NULL,
  PRIMARY KEY (profile, task)
);
-- A thread's own choice for a task, which beats the preset.
CREATE TABLE IF NOT EXISTS thread_models (
  pool   TEXT NOT NULL,
  thread TEXT NOT NULL,
  task   TEXT NOT NULL,
  entry  TEXT NOT NULL,
  PRIMARY KEY (pool, thread, task)
);
-- Models the user starred; pickers show them first.
CREATE TABLE IF NOT EXISTS starred_offerings (
  offering TEXT PRIMARY KEY
);
-- General threads switched to local-only. Private threads are always local-only.
CREATE TABLE IF NOT EXISTS local_only_threads (
  thread TEXT PRIMARY KEY
);
-- A thread's own profile (cloud or custom, general threads only, kept one
-- release for rollback) and its own preset, thinking setting and Fallback
-- switch (null follows the user's default), and the most context it plans
-- for (null: the model's whole window). voice_cloud, the old Voice to
-- cloud switch, is no longer read; a later release drops it.
CREATE TABLE IF NOT EXISTS thread_choices (
  thread      TEXT PRIMARY KEY,
  profile     TEXT,
  preset      TEXT,
  thinking    TEXT,
  voice_cloud INTEGER,
  fallback    INTEGER,
  context     INTEGER
);
-- Which model answered each call, and why a fallback was used. Never prompt text.
CREATE TABLE IF NOT EXISTS model_calls (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  pool     TEXT NOT NULL,
  thread   TEXT NOT NULL,
  task     TEXT NOT NULL,
  offering TEXT NOT NULL,
  label    TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  kind     TEXT NOT NULL,
  fallback TEXT,
  note     TEXT,
  -- The turn's counts and times, once it ends: never text.
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  window        INTEGER,
  ttft_ms       INTEGER,
  gen_ms        INTEGER,
  processed     INTEGER,
  -- A speech call's seconds of audio, heard or spoken: never the audio or its text.
  audio_seconds REAL
);
`;

/** Named model presets and the two columns' state, in user.db (docs/briefs/model-presets.md). An entries value is a JSON object of `{ task: Entry }`. */
export const PRESET_SCHEMA = `
-- A named map of task to entry, with a scope: private takes local models only,
-- general mixes local and cloud. builtin is null for user presets. Names are
-- unique per user ignoring case (the index).
CREATE TABLE IF NOT EXISTS model_presets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('private', 'general')),
  builtin    TEXT CHECK (builtin IN ('local', 'cloud')),
  entries    TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS model_presets_name ON model_presets (lower(name));
-- The two columns' state: the preset each follows, or (when preset is null)
-- its Custom entries and the preset those came from, for Save to.
CREATE TABLE IF NOT EXISTS model_columns (
  column      TEXT PRIMARY KEY CHECK (column IN ('private', 'general')),
  preset      TEXT,
  from_preset TEXT,
  entries     TEXT NOT NULL DEFAULT '{}'
);
`;

/** Adds the turn measurements and speech columns to tables made before them. */
export function upgradeCalls(db: Db): void {
  for (const c of ["prompt_tokens", "output_tokens", "window", "ttft_ms", "gen_ms", "processed"]) {
    if (!hasColumn(db, "model_calls", c)) db.exec(`ALTER TABLE model_calls ADD COLUMN ${c} INTEGER`);
  }
  if (!hasColumn(db, "model_calls", "audio_seconds")) db.exec("ALTER TABLE model_calls ADD COLUMN audio_seconds REAL");
  if (!hasColumn(db, "thread_choices", "voice_cloud")) db.exec("ALTER TABLE thread_choices ADD COLUMN voice_cloud INTEGER");
  if (!hasColumn(db, "thread_choices", "fallback")) db.exec("ALTER TABLE thread_choices ADD COLUMN fallback INTEGER");
  if (!hasColumn(db, "thread_choices", "preset")) db.exec("ALTER TABLE thread_choices ADD COLUMN preset TEXT");
}

/** The settings key holding the id of the preset migrated from the custom profile (so a rename doesn't break the rollback mirror). */
export const MIXED_PRESET = "presets.mixed";

/**
 * Mirrors the presets and columns back into the legacy `model_profiles` table
 * and the `general_profile` setting, kept one release so a rollback keeps the
 * user's choices: built-in Local with local, Cloud with cloud, the migrated
 * Mixed preset with custom, and the General column's preset with the default
 * where it is one of those.
 */
export function syncLegacy(db: Db): void {
  const entries = (id: string) => {
    const r = db.prepare("SELECT entries FROM model_presets WHERE id = ?").get(id) as { entries: string } | undefined;
    return r ? JSON.parse(r.entries) as Record<string, unknown> : undefined;
  };
  const write = (profile: string, table: Record<string, unknown> | undefined) => {
    db.prepare("DELETE FROM model_profiles WHERE profile = ?").run(profile);
    if (!table) return;
    const ins = db.prepare("INSERT OR REPLACE INTO model_profiles (profile, task, entry) VALUES (?, ?, ?)");
    for (const [task, e] of Object.entries(table)) ins.run(profile, task, JSON.stringify(e));
  };
  write("local", entries("builtin.local"));
  write("cloud", entries("builtin.cloud"));
  const mixed = (db.prepare("SELECT value FROM settings WHERE key = ?").get(MIXED_PRESET) as { value: string } | undefined)?.value;
  write("custom", mixed ? entries(mixed) : undefined);
  const col = db.prepare("SELECT preset FROM model_columns WHERE column = 'general'").get() as { preset: string | null } | undefined;
  const preset = col?.preset ?? null;
  const legacy = preset === "builtin.cloud" ? "cloud" : preset === mixed ? "custom" : null;
  if (legacy) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('general_profile', ?)").run(legacy);
}

const hasColumn = (db: Db, table: string, column: string) =>
  !!db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
const hasTable = (db: Db, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** Adds the columns later versions gave `endpoints`, to a table made before them. */
export function upgradeEndpoints(db: Db): void {
  for (const [column, type] of [["down_since", "TEXT"], ["addresses", "TEXT"], ["pin", "TEXT"], ["paused_at", "TEXT"]] as const) {
    if (!hasColumn(db, "endpoints", column)) db.exec(`ALTER TABLE endpoints ADD COLUMN ${column} ${type}`);
  }
}

type Pair = { endpoint: string; model: string; offering: string };

/**
 * Moves a database from endpoints named by their label, `endpoint_models`
 * and `{ endpoint, model }` choices to permanent IDs and lists of offerings,
 * all in one transaction, so an interrupted migration leaves the old tables
 * as they were. `legacy` receives the old pairs and their offerings inside
 * that transaction (self.db keeps them for users still locked); `shared`
 * maps a pair this database doesn't hold. Returns the choices whose models
 * no longer existed, which are dropped, for the notice.
 */
export function migrate(db: Db, o: { legacy?: (pairs: Pair[]) => void; shared?: (endpoint: string, model: string) => string | undefined } = {}): string[] {
  const endpoints = hasTable(db, "endpoint_models");
  const choices = hasTable(db, "model_profiles") && hasColumn(db, "model_profiles", "endpoint");
  upgradeEndpoints(db);
  if (!endpoints && !choices) return [];
  db.pragma("foreign_keys = OFF");
  try {
    return db.transaction(() => {
      const pairs = endpoints ? moveEndpoints(db) : [];
      o.legacy?.(pairs);
      const own = new Map(pairs.map((p) => [`${p.endpoint}\u0000${p.model}`, p.offering]));
      return choices ? moveChoices(db, (e, m) => own.get(`${e}\u0000${m}`) ?? o.shared?.(e, m)) : [];
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function moveEndpoints(db: Db): Pair[] {
  const now = new Date().toISOString();
  const pairs: Pair[] = [];
  const ids = new Map((db.prepare("SELECT id FROM endpoints").all() as { id: string }[]).map((r) => [r.id, randomUUID()]));
  const insert = db.prepare("INSERT INTO offerings (id, endpoint, model, found, hand, manual, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rows = db.prepare("SELECT * FROM endpoint_models").all() as { endpoint: string; model: string; context_window: number | null; tools: number | null; manual: number }[];
  for (const r of rows) {
    const endpoint = ids.get(r.endpoint);
    if (!endpoint) continue;
    const facts = JSON.stringify({ ...(r.context_window ? { contextWindow: r.context_window } : {}), ...(r.tools === null ? {} : { tools: r.tools === 1 }) });
    const offering = randomUUID();
    insert.run(offering, endpoint, r.model, r.manual ? "{}" : facts, r.manual ? facts : "{}", r.manual, now);
    pairs.push({ endpoint: r.endpoint, model: r.model, offering });
  }
  const rename = db.prepare("UPDATE endpoints SET id = ? WHERE id = ?");
  for (const [old, fresh] of ids) rename.run(fresh, old);
  db.exec("DROP TABLE endpoint_models");
  return pairs;
}

function moveChoices(db: Db, lookup: (endpoint: string, model: string) => string | undefined): string[] {
  const dropped: string[] = [];
  const entry = (endpoint: string, model: string) => {
    const offering = lookup(endpoint, model);
    if (!offering) dropped.push(`${endpoint}/${model}`);
    return offering && JSON.stringify([{ offeringId: offering }]);
  };
  db.exec("ALTER TABLE model_profiles RENAME TO model_profiles_v1; ALTER TABLE thread_models RENAME TO thread_models_v1");
  db.exec(MODEL_CHOICE_SCHEMA);
  for (const r of db.prepare("SELECT * FROM model_profiles_v1").all() as { profile: string; task: string; endpoint: string; model: string }[]) {
    const e = entry(r.endpoint, r.model);
    if (e) db.prepare("INSERT INTO model_profiles (profile, task, entry) VALUES (?, ?, ?)").run(r.profile, r.task, e);
  }
  for (const r of db.prepare("SELECT * FROM thread_models_v1").all() as { pool: string; thread: string; task: string; endpoint: string; model: string }[]) {
    const e = entry(r.endpoint, r.model);
    if (e) db.prepare("INSERT INTO thread_models (pool, thread, task, entry) VALUES (?, ?, ?, ?)").run(r.pool, r.thread, r.task, e);
  }
  db.exec("DROP TABLE model_profiles_v1; DROP TABLE thread_models_v1");
  return dropped;
}
