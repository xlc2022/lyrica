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

/** self.db `settings` key: her own code's checkout, granted to general threads only (docs/workspace.md, "Her own code"). */
const CHECKOUT_KEY = "workspace.checkout";

/** The folders each user may grant to their threads, kept in self.db. */
export class AllowedPaths {
  /** `runtime` is LYRICA_HOME: no allowed folder may overlap it. */
  constructor(private readonly db: Db, private readonly users: Users, private readonly runtime: string) {}

  /**
   * The user's folders, without any that overlap a folder never granted or
   * the runtime directory, or, in the private list, her checkout: the check
   * before every sandbox run then refuses them, whenever they were listed.
   */
  list(userId: string): Record<Pool, string[]> {
    const rows = this.db.prepare("SELECT pool, path FROM workspace_paths WHERE user_id = ? ORDER BY path").all(userId) as { pool: Pool; path: string }[];
    const checkout = this.checkout();
    const runtime = cleanPath(realpathSync(this.runtime));
    const ok = (r: { pool: Pool; path: string }) => !this.never(r.path, runtime) && !(r.pool === "private" && checkout && overlaps(r.path, checkout));
    return { general: rows.filter((r) => r.pool === "general" && ok(r)).map((r) => r.path), private: rows.filter((r) => r.pool === "private" && ok(r)).map((r) => r.path) };
  }

  /** Lets `userId` grant `path` in `pool`. It must be a real directory, with no symlinks on the way. */
  allow(actor: User, userId: string, pool: Pool, path: string): void {
    this.mustBeAdmin(actor);
    path = this.grantable(path);
    const checkout = this.checkout();
    if (pool === "private" && checkout && overlaps(path, checkout)) throw new Error(`${path} overlaps her code's checkout, which only general threads may have`);
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

  /** Her own code's checkout, if an administrator named one. Only a general thread that has it granted gets her GitHub token. */
  checkout(): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CHECKOUT_KEY) as { value: string } | undefined)?.value;
  }

  /** Names the folder that holds her checkout, or none. It can't be in any user's private list. */
  setCheckout(actor: User, path: string | null): void {
    this.mustBeAdmin(actor);
    if (path === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(CHECKOUT_KEY);
      return;
    }
    path = this.grantable(path);
    const row = this.db.prepare("SELECT path FROM workspace_paths WHERE pool = 'private'").all() as { path: string }[];
    const clash = row.find((r) => overlaps(path, r.path));
    if (clash) throw new Error(`${path} overlaps ${clash.path}, which is in a private list`);
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(CHECKOUT_KEY, path);
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
