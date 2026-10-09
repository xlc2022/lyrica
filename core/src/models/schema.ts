/** Endpoint tables. In self.db they hold the shared endpoints; in user.db, the user's own. */
export const ENDPOINT_SCHEMA = `
-- A model server. kind is declared by whoever adds it (cloud or local), never inferred.
CREATE TABLE IF NOT EXISTS endpoints (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('cloud', 'local')),
  api        TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  api_key    TEXT,
  created_at TEXT NOT NULL
);
-- The models an endpoint serves, from /v1/models or entered by hand (manual = 1).
CREATE TABLE IF NOT EXISTS endpoint_models (
  endpoint       TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  context_window INTEGER,
  tools          INTEGER,
  manual         INTEGER NOT NULL,
  PRIMARY KEY (endpoint, model)
);
`;

/** Model choices, in user.db. */
export const MODEL_CHOICE_SCHEMA = `
-- The cloud and local profiles: the default model for each task.
CREATE TABLE IF NOT EXISTS model_profiles (
  profile  TEXT NOT NULL CHECK (profile IN ('cloud', 'local')),
  task     TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model    TEXT NOT NULL,
  PRIMARY KEY (profile, task)
);
-- A thread's own choice for a task, which beats the profile.
CREATE TABLE IF NOT EXISTS thread_models (
  pool     TEXT NOT NULL,
  thread   TEXT NOT NULL,
  task     TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model    TEXT NOT NULL,
  PRIMARY KEY (pool, thread, task)
);
-- General threads switched to local-only. Private threads are always local-only.
CREATE TABLE IF NOT EXISTS local_only_threads (
  thread TEXT PRIMARY KEY
);
`;
