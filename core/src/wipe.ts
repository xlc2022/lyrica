import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import type { Keyring } from "./keyring.ts";
import type { Users } from "./users.ts";

// Wiping memory (DESIGN.md, "Wiping memory"): every user's general and private
// pools go, with what their threads left in user.db, self.db and the home
// workspace. Users, passwords, keys, endpoints, models, machines, accounts,
// settings and Lyrica's persona stay. Nothing deleted is logged.

/** user.db tables that hold threads, projects or what came from them. Every other user.db table is kept. */
export const WIPED_USER_TABLES = [
  "call_totals", "child_threads", "file_changes", "file_origins", "local_only_threads", "model_calls", "panel_files", "persona_drafts",
  "pinned_threads", "project_settings", "push_sent", "started_suggestions", "subagent_runs", "thread_choices",
  "thread_groups", "thread_models", "thread_prefs", "thread_workspaces",
] as const;

/** user.db tables a wipe keeps: settings, endpoints and models, machines, accounts, roles, skills. */
export const KEPT_USER_TABLES = [
  "delegate_roles", "delegate_workflows", "endpoints", "git_accounts", "hub_tokens", "machines", "mcp_servers", "meta",
  "model_columns", "model_groups", "model_presets", "model_profiles", "offering_settings", "offerings", "settings", "skills",
  "starred_offerings",
] as const;

// Users whose user.db rows still wait for the wipe, and users whose home workspace does.
const PENDING = "wipe.pending";
const HOME = "wipe.home";

/**
 * The part that needs no user's key: deletes every user's general.db and
 * private.db, threads in transit between users and persona suggestions sent
 * to administrators, and marks every user as waiting for `finishWipe` (their
 * user.db, once their key is in memory) and `homeWiped` (their home
 * workspace, once it is mounted). Running work must be stopped first.
 * Returns how many users it covered.
 */
export function wipePools(keyring: Keyring, users: Users): number {
  const self = keyring.self();
  const all = users.all();
  const ids = JSON.stringify(all.map((u) => u.id));
  self.transaction(() => {
    self.prepare("DELETE FROM thread_shares").run();
    self.prepare("DELETE FROM persona_proposals").run();
    for (const key of [PENDING, HOME]) self.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, ids);
  })();
  for (const u of all) {
    const dir = users.userDir(u.id);
    if (!existsSync(dir)) continue;
    // The pool and its journal or WAL files: a fresh, empty pool is made at the next open.
    for (const name of readdirSync(dir)) if (/^(general|private)\.db(-.*)?$/.test(name)) rmSync(join(dir, name), { force: true });
  }
  return all.length;
}

/** Whether this user's user.db still waits for a wipe to finish. */
export function wipePending(self: Db, userId: string): boolean {
  return list(self, PENDING).includes(userId);
}

/** Whether this user's home workspace still waits for a wipe's thread folders to go. */
export function homeWipePending(self: Db, userId: string): boolean {
  return list(self, HOME).includes(userId);
}

/** Deletes the user's user.db rows about threads (WIPED_USER_TABLES), overwriting the deleted text, and clears their mark. */
export function finishWipe(self: Db, userId: string, userDb: Db): void {
  userDb.pragma("secure_delete = ON");
  userDb.transaction(() => { for (const t of WIPED_USER_TABLES) userDb.prepare(`DELETE FROM ${t}`).run(); })();
  drop(self, PENDING, userId);
}

/** The user's thread folders are gone: clears their home mark. */
export function homeWiped(self: Db, userId: string): void {
  drop(self, HOME, userId);
}

function list(self: Db, key: string): string[] {
  const row = self.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as string[] : [];
}

function drop(self: Db, key: string, userId: string): void {
  const left = list(self, key).filter((id) => id !== userId);
  if (left.length) self.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(left), key);
  else self.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
