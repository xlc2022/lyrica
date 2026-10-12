import { realpathSync, statSync } from "node:fs";
import type { Db } from "../db.ts";
import type { Pool } from "../types.ts";
import { Forbidden, type User, type Users } from "../users.ts";
import { cleanPath, overlaps } from "./settings.ts";

/**
 * Never grantable: the built-in Caddy's runtime directory (sandboxes run as
 * lyricad's user, which is in its group, so a grant there would hand them
 * Caddy's admin socket), the releases, and the updater's state and snapshots
 * (root's; docs/daemon.md, "Updates"). Update requests are written inside
 * LYRICA_HOME, which is refused as the runtime directory.
 */
export const NEVER_GRANTED = ["/run/lyrica-caddy", "/opt/lyrica", "/var/lib/lyrica-update", "/var/lib/lyrica-snapshots"];

/** The folders each user may grant to their threads, kept in self.db. */
export class AllowedPaths {
  /** `runtime` is LYRICA_HOME: no allowed folder may overlap it. */
  constructor(private readonly db: Db, private readonly users: Users, private readonly runtime: string) {}

  /**
   * The user's folders, without any that overlap a folder never granted or
   * the runtime directory: the check before every sandbox run then refuses
   * them, whenever they were listed.
   */
  list(userId: string): Record<Pool, string[]> {
    const rows = this.db.prepare("SELECT pool, path FROM workspace_paths WHERE user_id = ? ORDER BY path").all(userId) as { pool: Pool; path: string }[];
    const runtime = cleanPath(realpathSync(this.runtime));
    const ok = (r: { pool: Pool; path: string }) => !this.never(r.path, runtime);
    return { general: rows.filter((r) => r.pool === "general" && ok(r)).map((r) => r.path), private: rows.filter((r) => r.pool === "private" && ok(r)).map((r) => r.path) };
  }

  /** Lets `userId` grant `path` in `pool`. It must be a real directory, with no symlinks on the way. */
  allow(actor: User, userId: string, pool: Pool, path: string): void {
    this.mustBeAdmin(actor);
    path = this.grantable(path);
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

  /** The folder never granted, or the runtime directory, that `path` overlaps. */
  private never(path: string, runtime = cleanPath(realpathSync(this.runtime))): string | undefined {
    return NEVER_GRANTED.find((n) => overlaps(path, n)) ?? (overlaps(path, runtime) ? "Lyrica's runtime directory" : undefined);
  }

  /** `path` cleaned, if an administrator may list it: no folder never granted, a real directory, no symlinks. */
  private grantable(path: string): string {
    path = cleanPath(path);
    const never = this.never(path);
    if (never) throw new Error(`${path} overlaps ${never}, which is never granted`);
    if (!statSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
    if (realpathSync(path) !== path) throw new Error(`${path} goes through a symlink; use ${realpathSync(path)}`);
    return path;
  }

  private mustBeAdmin(actor: User): void {
    if (!this.users.get(actor.id)?.admin) throw new Forbidden("only an administrator can change which folders a user may grant");
  }
}
