import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkReadable, Keyring, Memory, migrate, MigrationFailed, MIN_READER, openEncrypted, SCHEMA, schemaOf, SchemaTooNew, STEPS, Users, WorkspaceSettings,
  type Db, type DbKind, type MigrationStep,
} from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratchDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-migrations-"));
  dirs.push(dir);
  return openEncrypted(join(dir, "x.db"), { raw: Buffer.alloc(32, 7) });
}

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const rowCounts = (db: Db) => Object.fromEntries(tables(db).map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n]));

/** A few rows of what a database at that kind holds, by code: never real data. */
const SEED: Record<DbKind, (db: Db) => void> = {
  self: (db) => {
    db.prepare("INSERT INTO users (id, login, admin, profile, wrapped_key, created_at) VALUES ('u1', 'tester', 1, '{}', '{}', '2026-01-01')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('sleep.time', '04:00')").run();
    db.prepare("INSERT INTO workspace_paths (user_id, pool, path) VALUES ('u1', 'general', '/srv/music')").run();
  },
  user: (db) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    db.prepare("INSERT INTO pinned_threads (pool, thread, pinned_at) VALUES ('general', 'web/a', '2026-01-01')").run();
    db.prepare("INSERT INTO child_threads (pool, thread, parent, started_at) VALUES ('general', 'web/b', 'web/a', '2026-01-01')").run();
  },
  pool: (db) => {
    db.prepare("INSERT INTO threads (id, interface, title, created_at) VALUES ('web/a', 'web', 'A test thread', '2026-01-01')").run();
  },
};

const KINDS: DbKind[] = ["self", "user", "pool"];

describe("schema versions", () => {
  it("gives a new database of each kind this release's version and oldest reader, and checks it", () => {
    for (const kind of KINDS) {
      const db = scratchDb();
      expect(migrate(db, kind)).toEqual({ from: 0, to: SCHEMA[kind] });
      expect(schemaOf(db)).toEqual({ version: SCHEMA[kind], minReader: MIN_READER[kind] });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // Already current: nothing runs.
      expect(migrate(db, kind)).toEqual({ from: SCHEMA[kind], to: SCHEMA[kind] });
      db.close();
    }
  });

  it("builds each database at every released schema, migrates it without losing rows, and the release before still opens it after an expand", () => {
    for (const kind of KINDS) {
      for (let v = 1; v <= SCHEMA[kind]; v++) {
        const db = scratchDb();
        migrate(db, kind, {}, STEPS[kind].filter((s) => s.version <= v));
        SEED[kind](db);
        const before = rowCounts(db);
        migrate(db, kind);
        const after = rowCounts(db);
        for (const [table, n] of Object.entries(before)) expect(after[table], `${kind} v${v} → ${SCHEMA[kind]}: ${table}`).toBe(n + (kind === "user" && v < 5 && table === "settings" ? 1 : 0));
        const previous = STEPS[kind].filter((s) => s.version < SCHEMA[kind]);
        const current = STEPS[kind].find((s) => s.version === SCHEMA[kind])!;
        if (previous.length && !current.contract) expect(() => checkReadable(db, kind, previous)).not.toThrow();
        db.close();
      }
    }
  });

  it("refuses a database a newer release contracted: SchemaTooNew, at unlock and for pools, never mistaken for a wrong passphrase", async () => {
    const db = scratchDb();
    migrate(db, "pool");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'min_reader'").run(String(SCHEMA.pool + 1));
    expect(() => migrate(db, "pool")).toThrow(SchemaTooNew);
    expect(() => checkReadable(db, "pool")).toThrow(SchemaTooNew);
    db.close();

    const keyring = await freshKeyring();
    keyring.self().prepare("UPDATE meta SET value = ? WHERE key = 'min_reader'").run(String(SCHEMA.self + 1));
    await expect(keyring.unlockSelf("passphrase")).rejects.toBeInstanceOf(SchemaTooNew);
    await expect(keyring.unlockSelf("wrong")).rejects.toThrow("wrong password");
  });

  it("refuses a pool database a newer release contracted when a thread opens it", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const memory = new Memory(keyring, users);
    memory.openOwnerView(ada.id).close();
    const pool = openEncrypted(join(users.userDir(ada.id), "general.db"), { raw: keyring.subkey(ada.id, "pool:general") });
    pool.prepare("UPDATE meta SET value = ? WHERE key = 'min_reader'").run(String(SCHEMA.pool + 1));
    pool.close();
    expect(() => memory.openOwnerView(ada.id)).toThrow(SchemaTooNew);
  });

  it("opens a database a newer release only expanded, as it is", () => {
    const db = scratchDb();
    migrate(db, "user");
    db.exec("CREATE TABLE later (x TEXT)");
    db.pragma(`user_version = ${SCHEMA.user + 1}`);
    expect(migrate(db, "user")).toEqual({ from: SCHEMA.user + 1, to: SCHEMA.user + 1 });
    expect(tables(db)).toContain("later");
    db.close();
  });
});

describe("user step 3 (MCP servers)", () => {
  it("gives every thread from each released schema an empty list of servers, and the release before still opens it", () => {
    for (let v = 1; v < 3; v++) {
      const db = scratchDb();
      migrate(db, "user", {}, STEPS.user.filter((s) => s.version <= v));
      db.prepare("INSERT INTO thread_workspaces (thread_id, grants, mode) VALUES ('web/a', '[]', 'auto')").run();
      migrate(db, "user");
      expect(db.prepare("SELECT mcp_servers FROM thread_workspaces WHERE thread_id = 'web/a'").get()).toEqual({ mcp_servers: "[]" });
      expect(new WorkspaceSettings(db, () => ({ general: [], private: [] })).thread("web/a").mcpServers).toEqual([]);
      expect(tables(db)).toContain("mcp_servers");
      expect(() => checkReadable(db, "user", STEPS.user.filter((s) => s.version < 3))).not.toThrow();
      db.close();
    }
  });
});

describe("user step 5 (portrait-photo cloud choice)", () => {
  it("expands every released user schema with Ask once a day and preserves an existing choice", () => {
    for (let v = 1; v < 5; v++) for (const policy of [undefined, "never", "always"]) {
      const db = scratchDb();
      migrate(db, "user", {}, STEPS.user.filter(s => s.version <= v));
      SEED.user(db);
      if (policy) db.prepare("INSERT INTO settings (key, value) VALUES ('images.photos.cloud', ?)").run(policy);
      migrate(db, "user");
      const settings = new WorkspaceSettings(db, () => ({ general: [], private: [] }));
      expect(settings.photoCloudPolicy()).toBe(policy ?? "ask");
      expect(settings.photoCloudApproved("2026-10-12")).toBe(false);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toEqual({ value: "v" });
      expect(schemaOf(db)).toEqual({ version: SCHEMA.user, minReader: MIN_READER.user });
      expect(() => checkReadable(db, "user", STEPS.user.filter(s => s.version <= v))).not.toThrow();
      db.close();
    }
  });
});

describe("a migration that fails", () => {
  const base = STEPS.pool;
  const failing = (run: MigrationStep["run"]): MigrationStep[] => [...base, { version: SCHEMA.pool + 1, run }];

  it("halfway through leaves the database as it was", () => {
    const db = scratchDb();
    migrate(db, "pool");
    SEED.pool(db);
    const before = { schema: schemaOf(db), tables: tables(db), rows: rowCounts(db) };
    expect(() => migrate(db, "pool", {}, failing((d) => {
      d.exec("ALTER TABLE threads ADD COLUMN later TEXT; CREATE TABLE later (x TEXT); DELETE FROM threads");
      throw new Error("stopped halfway");
    }))).toThrow("stopped halfway");
    expect({ schema: schemaOf(db), tables: tables(db), rows: rowCounts(db) }).toEqual(before);
    expect(db.prepare("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'later'").get()).toBeUndefined();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("that breaks a foreign key is MigrationFailed and commits nothing", () => {
    const db = scratchDb();
    migrate(db, "pool");
    const before = schemaOf(db);
    expect(() => migrate(db, "pool", {}, failing((d) => {
      d.exec("CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (p TEXT REFERENCES parent (id)); INSERT INTO child VALUES ('nobody')");
    }))).toThrow(MigrationFailed);
    expect(schemaOf(db)).toEqual(before);
    expect(tables(db)).not.toContain("child");
    db.close();
  });
});

describe("pre-release databases", () => {
  it("come up to the first release's schema in place, keeping what they held", async () => {
    const home = mkdtempSync(join(tmpdir(), "lyrica-migrations-"));
    dirs.push(home);
    const keyring = new Keyring(home, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
    await keyring.initSelf("passphrase");
    const self = keyring.self();
    self.exec("DROP TABLE meta; PRAGMA user_version = 0");
    self.prepare("INSERT INTO settings (key, value) VALUES ('sleep.time', '05:30')").run();
    await keyring.unlockSelf("passphrase");
    expect(schemaOf(keyring.self())).toEqual({ version: SCHEMA.self, minReader: MIN_READER.self });
    expect(keyring.self().prepare("SELECT value FROM settings WHERE key = 'sleep.time'").get()).toEqual({ value: "05:30" });
  });
});


describe("pool step 6 (routines)", () => {
  it("expands every released pool schema and keeps the previous readers and thread data", () => {
    for (let version = 1; version < 6; version++) {
      const db = scratchDb();
      const previous = STEPS.pool.filter(s => s.version <= version);
      migrate(db, "pool", {}, previous);
      SEED.pool(db);
      migrate(db, "pool");
      expect(schemaOf(db)).toEqual({ version: SCHEMA.pool, minReader: MIN_READER.pool });
      expect(() => checkReadable(db, "pool", previous)).not.toThrow();
      expect(db.prepare("SELECT title FROM threads WHERE id = 'web/a'").get()).toEqual({ title: "A test thread" });
      expect((db.prepare("PRAGMA table_info(routines)").all() as { name: string }[]).map(r => r.name)).toEqual(["id", "thread", "schedule", "note", "new_thread", "paused", "next_at", "last_at", "created_at"]);
      db.prepare("INSERT INTO routines (thread, schedule, note, next_at, created_at) VALUES ('web/a', '{}', 'A synthetic note.', '2026-01-02', '2026-01-01')").run();
      expect(db.prepare("SELECT new_thread, paused, last_at FROM routines").get()).toEqual({ new_thread: 0, paused: 0, last_at: null });
      db.prepare("DELETE FROM threads WHERE id = 'web/a'").run();
      expect(db.prepare("SELECT * FROM routines").all()).toEqual([]);
      db.close();
    }
  });
});

describe("pool step 7 (watches)", () => {
  it("expands every released pool schema with an empty watch table, keeps the previous readers and thread data, and removes a watch with its thread", () => {
    for (let version = 1; version < 7; version++) {
      const db = scratchDb();
      const previous = STEPS.pool.filter(s => s.version <= version);
      migrate(db, "pool", {}, previous);
      SEED.pool(db);
      migrate(db, "pool");
      expect(schemaOf(db)).toEqual({ version: SCHEMA.pool, minReader: MIN_READER.pool });
      expect(() => checkReadable(db, "pool", previous)).not.toThrow();
      expect(db.prepare("SELECT title FROM threads WHERE id = 'web/a'").get()).toEqual({ title: "A test thread" });
      expect((db.prepare("PRAGMA table_info(watches)").all() as { name: string }[]).map(r => r.name)).toEqual(
        ["id", "thread", "repo", "kind", "host", "account", "number", "head", "head_since", "notified_heads", "seen_reviews", "webhook_at", "created_at"]);
      db.prepare("INSERT INTO watches (thread, repo, kind, host, account, number, head_since, created_at) VALUES ('web/a', 'ada/lyrica', 'forgejo', 'forge.lan', 'forge', 12, '2026-01-02', '2026-01-01')").run();
      expect(db.prepare("SELECT head, notified_heads, seen_reviews, webhook_at FROM watches").get()).toEqual({ head: null, notified_heads: "[]", seen_reviews: "[]", webhook_at: null });
      db.prepare("DELETE FROM threads WHERE id = 'web/a'").run();
      expect(db.prepare("SELECT * FROM watches").all()).toEqual([]);
      db.close();
    }
  });
});

describe("user step 6 (project command rules)", () => {
  it("expands every released schema and preserves project settings and old readers", () => {
    for (let version = 1; version < 6; version++) {
      const db = scratchDb();
      const previous = STEPS.user.filter(s => s.version <= version);
      migrate(db, "user", {}, previous);
      db.prepare("INSERT INTO project_settings (pool, thread, paused, thinking) VALUES ('general', 'web/project', 1, 'high')").run();
      migrate(db, "user");
      const settings = new WorkspaceSettings(db, () => ({ general: [], private: [] }));
      expect(settings.commandRules("general", "web/project")).toEqual([]);
      settings.addCommandRule("general", "web/project", { prefix: "npm test", decision: "ask" });
      settings.addCommandRule("general", "web/project", { prefix: "npm test", decision: "allow" });
      expect(settings.commandRules("general", "web/project")).toEqual([{ prefix: "npm test", decision: "allow" }]);
      expect(settings.commandRules("private", "web/project")).toEqual([]);
      expect(db.prepare("SELECT paused, thinking FROM project_settings").get()).toEqual({ paused: 1, thinking: "high" });
      expect(schemaOf(db)).toEqual({ version: SCHEMA.user, minReader: MIN_READER.user });
      expect(() => checkReadable(db, "user", previous)).not.toThrow();
      db.close();
    }
  });
});

describe("user step 8 (model presets)", () => {
  /** The legacy profiles and a thread's choice of each, as an old release wrote them. */
  const seedProfiles = (db: Db) => {
    const list = (offering: string) => JSON.stringify([{ offeringId: offering }]);
    const put = db.prepare("INSERT INTO model_profiles (profile, task, entry) VALUES (?, ?, ?)");
    put.run("local", "chat", list("off-local"));
    put.run("cloud", "chat", list("off-cloud"));
    put.run("custom", "chat", list("off-custom"));
    put.run("custom", "title", JSON.stringify({ same: "subagent.cheap" }));
    db.prepare("INSERT INTO settings (key, value) VALUES ('general_profile', 'custom')").run();
    db.prepare("INSERT INTO thread_choices (thread, profile) VALUES ('web/cloud', 'cloud'), ('web/custom', 'custom'), ('web/local', 'local')").run();
  };

  it("turns each released schema's profiles into presets, keeps the legacy tables for a rollback, and the release before still opens it", () => {
    for (let version = 1; version < 8; version++) {
      const db = scratchDb();
      const previous = STEPS.user.filter((s) => s.version <= version);
      migrate(db, "user", {}, previous);
      seedProfiles(db);
      migrate(db, "user");

      const preset = (id: string) => db.prepare("SELECT name, scope, builtin, entries FROM model_presets WHERE id = ?").get(id) as { name: string; scope: string; builtin: string | null; entries: string };
      expect(preset("builtin.local")).toEqual({ name: "Local", scope: "private", builtin: "local", entries: JSON.stringify({ chat: [{ offeringId: "off-local" }] }) });
      expect(preset("builtin.cloud")).toEqual({ name: "Cloud", scope: "general", builtin: "cloud", entries: JSON.stringify({ chat: [{ offeringId: "off-cloud" }] }) });
      const mixed = db.prepare("SELECT id, name, scope, builtin, entries FROM model_presets WHERE builtin IS NULL").get() as { id: string; name: string; scope: string; builtin: null; entries: string };
      expect(mixed).toEqual({ id: mixed.id, name: "Mixed", scope: "general", builtin: null, entries: JSON.stringify({ chat: [{ offeringId: "off-custom" }], title: { same: "subagent.cheap" } }) });
      // The Private column follows Local; the General column follows the old default (custom → Mixed).
      expect(db.prepare("SELECT preset FROM model_columns WHERE column = 'private'").get()).toEqual({ preset: "builtin.local" });
      expect(db.prepare("SELECT preset FROM model_columns WHERE column = 'general'").get()).toEqual({ preset: mixed.id });
      // A thread's cloud/custom choice became the matching preset; local follows its column again.
      expect(db.prepare("SELECT preset FROM thread_choices WHERE thread = 'web/cloud'").get()).toEqual({ preset: "builtin.cloud" });
      expect(db.prepare("SELECT preset FROM thread_choices WHERE thread = 'web/custom'").get()).toEqual({ preset: mixed.id });
      expect(db.prepare("SELECT preset FROM thread_choices WHERE thread = 'web/local'").get()).toEqual({ preset: null });
      // The legacy tables and settings stay, so a rollback keeps the user's choices.
      expect(db.prepare("SELECT count(*) AS n FROM model_profiles").get()).toEqual({ n: 4 });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'general_profile'").get()).toEqual({ value: "custom" });
      expect(schemaOf(db)).toEqual({ version: SCHEMA.user, minReader: 1 });
      expect(() => checkReadable(db, "user", previous)).not.toThrow();
      db.close();
    }
  });

  it("without a custom profile, the General column follows Cloud and no Mixed preset is made", () => {
    const db = scratchDb();
    migrate(db, "user", {}, STEPS.user.filter((s) => s.version < 8));
    db.prepare("INSERT INTO model_profiles (profile, task, entry) VALUES ('local', 'chat', ?)").run(JSON.stringify([{ offeringId: "off-local" }]));
    migrate(db, "user");
    expect(db.prepare("SELECT preset FROM model_columns WHERE column = 'general'").get()).toEqual({ preset: "builtin.cloud" });
    expect(db.prepare("SELECT count(*) AS n FROM model_presets WHERE builtin IS NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'presets.mixed'").get()).toEqual({ n: 0 });
    db.close();
  });
});


describe("user step 9 (project welcome drafts)", () => {
  it("expands every released user schema, retaining project settings and previous readers", () => {
    for (let v = 0; v < 9; v++) {
      const db = scratchDb();
      if (v) {
        migrate(db, "user", {}, STEPS.user.filter(s => s.version <= v));
        db.prepare("INSERT INTO project_settings (pool, thread, paused, model, thinking) VALUES ('private', 'web/project', 1, NULL, 'off')").run();
      }
      if (v >= 6) db.prepare("UPDATE project_settings SET command_rules = ?").run(JSON.stringify([{ prefix: "npm test", decision: "ask" }]));
      if (v >= 8) db.prepare("INSERT INTO thread_choices (thread, preset) VALUES ('web/project', 'builtin.local')").run();
      migrate(db, "user");
      if (v >= 6) expect(db.prepare("SELECT command_rules FROM project_settings").get()).toEqual({ command_rules: JSON.stringify([{ prefix: "npm test", decision: "ask" }]) });
      if (v >= 8) expect(db.prepare("SELECT preset FROM thread_choices WHERE thread = 'web/project'").get()).toEqual({ preset: "builtin.local" });
      if (!v) db.prepare("INSERT INTO project_settings (pool, thread, paused) VALUES ('private', 'web/project', 1)").run();
      expect(db.prepare("SELECT paused, draft_goal, draft_instructions FROM project_settings").get()).toEqual({ paused: 1, draft_goal: null, draft_instructions: null });
      db.prepare("UPDATE project_settings SET draft_goal = ?, draft_instructions = ?").run("Grow herbs", "Keep a planting diary");
      migrate(db, "user");
      expect(db.prepare("SELECT draft_goal, draft_instructions FROM project_settings").get()).toEqual({ draft_goal: "Grow herbs", draft_instructions: "Keep a planting diary" });
      expect(() => checkReadable(db, "user", STEPS.user.filter(s => s.version <= 8))).not.toThrow();
      db.close();
    }
  });
});

describe("user step 10 (spend share)", () => {
  it("preserves every released user schema and adds nullable read counts and empty totals", () => {
    for (let version = 1; version < 10; version++) {
      const db = scratchDb();
      const previous = STEPS.user.filter(s => s.version <= version);
      migrate(db, "user", {}, previous);
      db.prepare("INSERT INTO model_calls (at, pool, thread, task, offering, label, endpoint, kind, prompt_tokens, output_tokens) VALUES ('2026-01-01', 'general', 'web/a', 'chat', 'old', 'Old', 'test', 'local', 12, 3)").run();
      migrate(db, "user");
      expect(schemaOf(db)).toEqual({ version: SCHEMA.user, minReader: MIN_READER.user });
      expect(() => checkReadable(db, "user", previous)).not.toThrow();
      expect(db.prepare("SELECT read_tokens, prompt_tokens, output_tokens FROM model_calls").get()).toEqual({ read_tokens: null, prompt_tokens: 12, output_tokens: 3 });
      expect(db.prepare("SELECT * FROM call_totals").all()).toEqual([]);
      db.close();
    }
  });
});


describe("user step 11 (push delivery IDs)", () => {
  it("expands every released user schema without changing old rows or reader compatibility", () => {
    for (let version = 1; version < 11; version++) {
      const db = scratchDb();
      const previous = STEPS.user.filter(s => s.version <= version);
      migrate(db, "user", {}, previous);
      SEED.user(db);
      migrate(db, "user");
      expect(db.prepare("SELECT * FROM push_sent").all()).toEqual([]);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toEqual({ value: "v" });
      expect(schemaOf(db)).toEqual({ version: SCHEMA.user, minReader: MIN_READER.user });
      expect(() => checkReadable(db, "user", previous)).not.toThrow();
      db.close();
    }
  });

  it("keeps existing delivery records when the additive step runs again", () => {
    const db = scratchDb();
    migrate(db, "user", {}, STEPS.user.filter(s => s.version < 11));
    // An older-schema fixture can retain this independent, newer table.
    STEPS.user.find(s => s.version === 11)!.run(db, {});
    db.prepare("INSERT INTO push_sent (id, at) VALUES ('question:test', 123)").run();
    migrate(db, "user");
    expect(db.prepare("SELECT * FROM push_sent").all()).toEqual([{ id: "question:test", at: 123 }]);
    expect(schemaOf(db)).toEqual({ version: SCHEMA.user, minReader: MIN_READER.user });
    expect(() => checkReadable(db, "user", STEPS.user.filter(s => s.version < 11))).not.toThrow();
    db.close();
  });
});

describe("pool step 8 (question pointers)", () => {
  it("expands every released pool schema, keeps old readers and stores no question text", () => {
    for (let version = 1; version < 8; version++) {
      const db = scratchDb();
      const previous = STEPS.pool.filter(s => s.version <= version);
      migrate(db, "pool", {}, previous);
      SEED.pool(db);
      migrate(db, "pool");
      expect(() => checkReadable(db, "pool", previous)).not.toThrow();
      expect((db.prepare("PRAGMA table_info(questions)").all() as { name: string }[]).map(r => r.name)).toEqual(["thread", "n", "asked", "closed", "answer"]);
      db.prepare("INSERT INTO questions (thread, n, asked) VALUES ('web/a', 3, '2026-01-01')").run();
      expect(() => db.prepare("INSERT INTO questions (thread, n, asked) VALUES ('web/a', 4, '2026-01-01')").run()).toThrow();
      db.prepare("DELETE FROM threads WHERE id = 'web/a'").run();
      expect(db.prepare("SELECT * FROM questions").all()).toEqual([]);
      db.close();
    }
  });
});
