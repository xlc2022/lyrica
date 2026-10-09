import { realpathSync, statSync } from "node:fs";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";
import { Forbidden, type User, type Users } from "../users.ts";
import { cleanPath, overlaps } from "./settings.ts";

/** In self.db, so only an administrator decides them and no user can widen their own. */
export const PATHS_SCHEMA = `
-- Host folders an administrator lets each user grant, per pool.
CREATE TABLE IF NOT EXISTS workspace_paths (
  user_id TEXT NOT NULL,
  pool    TEXT NOT NULL,
  path    TEXT NOT NULL,
  PRIMARY KEY (user_id, pool, path)
);
`;

/** The folders each user may grant to their threads, kept in self.db. */
export class AllowedPaths {
  /** `runtime` is LYRICA_HOME: no allowed folder may overlap it. */
  constructor(private readonly db: Db, private readonly users: Users, private readonly runtime: string) {
    db.exec(PATHS_SCHEMA);
  }

  list(userId: string): Record<Pool, string[]> {
    const rows = this.db.prepare("SELECT pool, path FROM workspace_paths WHERE user_id = ? ORDER BY path").all(userId) as { pool: Pool; path: string }[];
    return { general: rows.filter((r) => r.pool === "general").map((r) => r.path), private: rows.filter((r) => r.pool === "private").map((r) => r.path) };
  }

  /** Lets `userId` grant `path` in `pool`. It must be a real directory, with no symlinks on the way. */
  allow(actor: User, userId: string, pool: Pool, path: string): void {
    this.mustBeAdmin(actor);
    path = cleanPath(path);
    if (!statSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
    if (realpathSync(path) !== path) throw new Error(`${path} goes through a symlink; use ${realpathSync(path)}`);
    if (overlaps(path, cleanPath(realpathSync(this.runtime)))) throw new Error(`${path} overlaps Lyrica's runtime directory`);
    const otherPool = pool === "general" ? "private" : "general";
    const other = this.list(userId)[otherPool].find((p) => overlaps(path, p));
    if (other) throw new Error(`${path} overlaps ${other}, which is in the ${otherPool} list`);
    this.db.prepare("INSERT OR IGNORE INTO workspace_paths (user_id, pool, path) VALUES (?, ?, ?)").run(userId, pool, path);
  }

  disallow(actor: User, userId: string, pool: Pool, path: string): void {
    this.mustBeAdmin(actor);
    const n = this.db.prepare("DELETE FROM workspace_paths WHERE user_id = ? AND pool = ? AND path = ?").run(userId, pool, cleanPath(path)).changes;
    if (!n) throw new Error(`${path} is not in the ${pool} list`);
  }

  private mustBeAdmin(actor: User): void {
    if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change which folders a user may grant");
  }
}
