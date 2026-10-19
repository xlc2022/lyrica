import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMounted, type FileChanges, type Pool } from "@lyrica/core";
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
  const exists = threadExists(s, userId);
  const allowed = allowedOf(s, userId);
  const forgetRun = (runDir: string) => forgetRunWorktrees(runDir, allowed);
  const live = new Set((["general", "private"] as const).flatMap((pool) => s.delegation.store.liveRuns(userId, pool)));
  // Claude Code's folders (Workspace.claudeDir) go with their thread too.
  const claudeDir = join(home, "claude");
  for (const name of existsSync(claudeDir) ? readdirSync(claudeDir) : []) {
    let id: string;
    try { id = decodeURIComponent(name); } catch { continue; }
    if (exists(id) || statSync(join(claudeDir, name)).mtimeMs >= now.getTime() - 60_000) continue;
    rmSync(join(claudeDir, name), { recursive: true, force: true });
    counts.folders++;
  }
  for (const name of readdirSync(threadsDir)) {
    const dir = join(threadsDir, name);
    let id: string;
    try { id = decodeURIComponent(name); } catch { continue; }
    // A thread made since the list was read may have a new folder already.
    if (!exists(id) && statSync(dir).mtimeMs < now.getTime() - 60_000) {
      if (removeThreadFolder(dir, allowed)) counts.folders++;
      continue;
    }
    const worktrees = join(dir, "worktrees");
    if (!existsSync(worktrees)) continue;
    for (const w of readdirSync(worktrees)) {
      const run = /^(.+)-\d+$/.exec(w)?.[1];
      if (existsSync(join(worktrees, w, ".git")) || !run || live.has(run)) continue;
      if (statSync(join(worktrees, w)).mtime > old) continue;
      forgetRun(join(worktrees, w));
      rmSync(join(worktrees, w), { recursive: true, force: true });
      counts.worktrees++;
    }
  }
  return counts;
}

/**
 * Removes the files of threads just forgotten, at once rather than at the next
 * sweep: the records of what her calls changed and their snapshots, each
 * thread's folder under `threads/` (its run worktrees forgotten by git first)
 * and its Claude Code folder. Only while the home is mounted; otherwise the
 * sweep takes the folders later. Returns how many folders went.
 */
export function forgetThreadFiles(s: Services, userId: string, pool: Pool, threads: string[]): number {
  const home = s.workspace.homeDir(userId);
  if (!threads.length || !isMounted(home)) return 0;
  return forgetFiles(home, s.workspace.changes(userId), pool, threads, allowedOf(s, userId), threadExists(s, userId));
}

/** Whether a thread with this id is in either pool: folders are named by id alone. */
function threadExists(s: Services, userId: string): (id: string) => boolean {
  const o = s.memory.openOwnerView(userId);
  try {
    const ids = new Set([...o.general.listThreads({ includeHidden: true }), ...o.private.listThreads({ includeHidden: true })].map((t) => t.id));
    return (id) => ids.has(id);
  } finally {
    o.close();
  }
}

/**
 * forgetThreadFiles in a mounted home. A folder whose id a thread in the
 * other pool still has is kept, as the sweep keeps it.
 */
export function forgetFiles(home: string, changes: FileChanges, pool: Pool, threads: string[], allowed: string[], exists: (id: string) => boolean): number {
  changes.forget(changes.forThreads(pool, threads).map((c) => c.id));
  let n = 0;
  for (const id of threads) {
    if (exists(id)) continue;
    const name = encodeURIComponent(id);
    if (!name || name === "." || name === "..") continue;
    const dir = join(home, "threads", name);
    if (existsSync(dir) && removeThreadFolder(dir, allowed)) n++;
    const claude = join(home, "claude", name);
    if (existsSync(claude)) { rmSync(claude, { recursive: true, force: true }); n++; }
  }
  return n;
}

function allowedOf(s: Services, userId: string): string[] {
  const paths = s.workspace.allowedPaths.list(userId);
  return [...paths.general, ...paths.private];
}

/** Each worktree in a run's folder, so git forgets it before the folder goes. */
function forgetRunWorktrees(runDir: string, allowed: string[]): void {
  try { for (const repo of readdirSync(runDir)) forgetWorktree(join(runDir, repo), allowed); } catch { /* not a folder */ }
}

function removeThreadFolder(dir: string, allowed: string[]): boolean {
  const runs = join(dir, "worktrees");
  // A run's folder holds one worktree per repository; a code thread's own worktrees sit there directly. Either way the branches keep the commits.
  if (existsSync(runs)) for (const w of readdirSync(runs)) {
    if (existsSync(join(runs, w, ".git"))) forgetWorktree(join(runs, w), allowed);
    else forgetRunWorktrees(join(runs, w), allowed);
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
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
    // …/worktrees/<run>-<i>/<repository>/.git, or a code thread's /thread-workspaces/<thread>/worktrees/<repository>/.git, as the sandbox saw it.
    const back = readFileSync(join(admin, "gitdir"), "utf8").trim();
    const own = basename(dirname(path)) === "worktrees" ? `/${basename(dirname(dirname(path)))}/worktrees/${basename(path)}/.git` : undefined;
    if (!back.endsWith(`/worktrees/${basename(dirname(path))}/${basename(path)}/.git`) && !(own && back.endsWith(own))) return false;
    rmSync(admin, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
