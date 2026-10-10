import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
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
  const live = new Set((["general", "private"] as const).flatMap((pool) => s.delegation.store.liveRuns(userId, pool)));
  for (const name of readdirSync(threadsDir)) {
    const dir = join(threadsDir, name);
    let id: string;
    try { id = decodeURIComponent(name); } catch { continue; }
    if (!exists(id)) {
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
      rmSync(join(worktrees, w), { recursive: true, force: true });
      counts.worktrees++;
    }
  }
  return counts;
}
