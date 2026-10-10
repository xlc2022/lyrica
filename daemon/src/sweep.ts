import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMounted } from "@lyrica/core";
import type { Services } from "./lyricad.ts";

// The nightly sweep: what removing turns and forgetting threads leave behind
// in a user's home workspace. It logs counts only, never a path or a name.

export const SWEEP_AGE_MS = 30 * 864e5;

export interface SweepCounts { snapshots: number; records: number; folders: number; worktrees: number }

/**
 * For one user whose home workspace is mounted: snapshots and change records
 * older than 30 days; the folders of threads that no longer exist; and
 * worktrees of subagent runs that aren't live and haven't changed in 30 days.
 */
export function sweepUser(s: Services, userId: string, now = new Date()): SweepCounts {
  const counts: SweepCounts = { snapshots: 0, records: 0, folders: 0, worktrees: 0 };
  const home = s.workspace.homeDir(userId);
  if (!isMounted(home)) return counts;
  const old = new Date(now.getTime() - SWEEP_AGE_MS);
  const c = s.workspace.changes(userId).sweep(old);
  counts.snapshots = c.snapshots;
  counts.records = c.records;

  const threadsDir = join(home, "threads");
  if (!existsSync(threadsDir)) return counts;
  const o = s.memory.openOwnerView(userId);
  let exists: (id: string) => boolean;
  try {
    const ids = new Set([...o.general.listThreads({ includeHidden: true }), ...o.private.listThreads({ includeHidden: true })].map((t) => t.id));
    exists = (id) => ids.has(id);
  } finally {
    o.close();
  }
  const paths = s.workspace.allowedPaths.list(userId);
  const allowed = [...paths.general, ...paths.private];
  // Each worktree in a run's folder, so git forgets it before the folder goes.
  const forgetRun = (runDir: string) => {
    try { for (const repo of readdirSync(runDir)) forgetWorktree(join(runDir, repo), allowed); } catch { /* not a folder */ }
  };
  const live = new Set((["general", "private"] as const).flatMap((pool) => s.delegation.store.liveRuns(userId, pool)));
  for (const name of readdirSync(threadsDir)) {
    const dir = join(threadsDir, name);
    let id: string;
    try { id = decodeURIComponent(name); } catch { continue; }
    // A thread made since the list was read may have a new folder already.
    if (!exists(id) && statSync(dir).mtimeMs < now.getTime() - 60_000) {
      const runs = join(dir, "worktrees");
      if (existsSync(runs)) for (const w of readdirSync(runs)) forgetRun(join(runs, w));
      rmSync(dir, { recursive: true, force: true });
      counts.folders++;
      continue;
    }
    const worktrees = join(dir, "worktrees");
    if (!existsSync(worktrees)) continue;
    for (const w of readdirSync(worktrees)) {
      const run = /^(.+)-\d+$/.exec(w)?.[1];
      if (!run || live.has(run)) continue;
      if (statSync(join(worktrees, w)).mtime > old) continue;
      forgetRun(join(worktrees, w));
      rmSync(join(worktrees, w), { recursive: true, force: true });
      counts.worktrees++;
    }
  }
  return counts;
}

/**
 * Removes git's record of a worktree the sweep is about to remove (its
 * folder in the repository's .git/worktrees), so git no longer counts its
 * branch as checked out and a later removal can delete it. This is what
 * `git worktree prune` does, but prune can't run here: the records name the
 * worktrees as the sandbox saw them, so it would take every live one too.
 * Only a record in a folder the user may grant, with no symlinks on the way,
 * that names this worktree back. Returns whether it removed one.
 */
export function forgetWorktree(path: string, allowed: string[]): boolean {
  try {
    const admin = /^gitdir: (\/.+?)\n?$/.exec(readFileSync(join(path, ".git"), "utf8"))?.[1];
    const repo = admin && /^(\/.+)\/\.git\/worktrees\/[^/]+$/.exec(admin)?.[1];
    if (!admin || !repo || !allowed.some((a) => repo === a || repo.startsWith(`${a.replace(/\/+$/, "")}/`))) return false;
    if (realpathSync(admin) !== admin || !lstatSync(admin).isDirectory()) return false;
    // …/worktrees/<run>-<i>/<repository>/.git, as the sandbox saw it.
    const back = readFileSync(join(admin, "gitdir"), "utf8").trim();
    if (!back.endsWith(`/worktrees/${basename(dirname(path))}/${basename(path)}/.git`)) return false;
    rmSync(admin, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
