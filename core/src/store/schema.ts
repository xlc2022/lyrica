/** A pool database (general.db or private.db). Owned by the Memory component alone. */
export const POOL_SCHEMA = `
-- One conversation. parent: the thread it was forked, branched, delegated or exported from;
-- subagent: delegated, so the UI shows it in its parent's chat; child: started by Lyrica from its
-- parent (threads start); cut: the highest entry number a rewind removed, so entry IDs are never reused.
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  interface  TEXT NOT NULL,
  parent     TEXT,
  subagent   INTEGER NOT NULL DEFAULT 0,
  child      INTEGER NOT NULL DEFAULT 0,
  title      TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  unlogged   INTEGER NOT NULL DEFAULT 0,
  cut        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Pi session entries, as Pi wrote them. unlogged: written while the thread wasn't logged;
-- orig: the entry this one was copied from by an export; pinned: the user pinned it, so it stays in
-- her context word for word.
CREATE TABLE IF NOT EXISTS entries (
  thread     TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,
  pi_id      TEXT NOT NULL,
  role       TEXT NOT NULL,
  data       TEXT NOT NULL,
  text       TEXT NOT NULL,
  unlogged   INTEGER NOT NULL,
  orig       TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread, n),
  UNIQUE (thread, pi_id)
);
-- Small facts, one per note. origin: lyrica, sleep or user.
CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  about         TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL,
  author        TEXT NOT NULL,
  superseded_by TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- Her understanding of one subject. folders: JSON list of paths it describes;
-- flagged: something it cited was deleted, so the next sleep rewrites it.
CREATE TABLE IF NOT EXISTS pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  text       TEXT NOT NULL,
  folders    TEXT NOT NULL DEFAULT '[]',
  origin     TEXT NOT NULL,
  author     TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0,
  flagged    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Her orientation, rewritten by sleep. One row.
CREATE TABLE IF NOT EXISTS wake (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  text       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Sleep's reflections and dreams.
CREATE TABLE IF NOT EXISTS journal (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Every version of every note, page, WAKE and journal entry, with who wrote it.
CREATE TABLE IF NOT EXISTS revisions (
  id         INTEGER PRIMARY KEY,
  item       TEXT NOT NULL,
  body       TEXT NOT NULL,
  author     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_item ON revisions (item, id);
-- Derived from the inline citations in the text; rebuilt on every write.
CREATE TABLE IF NOT EXISTS citations (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS citations_dst ON citations (dst);
-- A deleted memory, without its text, so sleep doesn't extract it again.
CREATE TABLE IF NOT EXISTS tombstones (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  sources    TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
-- One sleep run. until: entries written before it are covered; phases: JSON of each phase's thread and
-- whether it finished. The watermark is the latest until whose consolidate finished.
CREATE TABLE IF NOT EXISTS sleep_runs (
  id          TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL,
  skip_reason TEXT,
  until       TEXT NOT NULL,
  phases      TEXT NOT NULL DEFAULT '{}',
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
-- What she'd like to raise after a night: a thought, a question or a persona suggestion. source: what
-- it came from (a journal entry, a page, a proposal); thread: the chat started from it.
CREATE TABLE IF NOT EXISTS sleep_items (
  id         TEXT PRIMARY KEY,
  run        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  source     TEXT,
  thread     TEXT,
  dismissed  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Full-text index (derived) over notes, pages, journal and logged entries.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (
  id UNINDEXED, kind UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2'
);
`;

/** Brings an older pool database up to POOL_SCHEMA. */
export const POOL_UPGRADES = [
  { check: "SELECT 1 FROM pragma_table_info('threads') WHERE name = 'subagent'", sql: "ALTER TABLE threads ADD COLUMN subagent INTEGER NOT NULL DEFAULT 0" },
  { check: "SELECT 1 FROM pragma_table_info('threads') WHERE name = 'child'", sql: "ALTER TABLE threads ADD COLUMN child INTEGER NOT NULL DEFAULT 0" },
  { check: "SELECT 1 FROM pragma_table_info('threads') WHERE name = 'cut'", sql: "ALTER TABLE threads ADD COLUMN cut INTEGER NOT NULL DEFAULT 0" },
  { check: "SELECT 1 FROM pragma_table_info('entries') WHERE name = 'pinned'", sql: "ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" },
];
