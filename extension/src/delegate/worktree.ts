import { posix } from "node:path";
import type { ExecutionTarget, Grant } from "@lyrica/core";

/** One writer's own checkout of one granted repository. */
export interface Worktree { repo: string; path: string; branch: string }

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

async function sh(target: ExecutionTarget, command: string, signal?: AbortSignal): Promise<{ ok: boolean; out: string }> {
  const chunks: Buffer[] = [];
  const { exitCode } = await target.ops().bash.exec(command, await target.cwd(), { onData: (d) => chunks.push(d), signal, timeout: 60 });
  return { ok: exitCode === 0, out: Buffer.concat(chunks).toString().trim() };
}

/**
 * A `git worktree` per writer for every writable grant, in the parent's
 * folder in the home workspace, made by running git where the parent's tools
 * run. When that isn't possible (no writable grants, a writable grant that
 * isn't the top of a git repository, or an SSH target), the reason, and the
 * writers run one at a time.
 */
export async function makeWorktrees(target: ExecutionTarget, grants: Grant[], runId: string, writers: number, signal?: AbortSignal): Promise<Worktree[][] | string> {
  const repos = grants.filter((g) => g.writable).map((g) => g.path);
  if (target.name !== "sandbox") return `worktrees need the sandbox, and this thread works on ${target.name}`;
  if (!repos.length) return "this thread has no writable folders, only its scratch folder";
  for (const repo of repos) {
    // Marked, because a networked sandbox may add its own lines to the output.
    const top = await sh(target, `cd ${quote(repo)} && test -d .git && echo "TOP=$(git rev-parse --show-toplevel)"`, signal);
    if (!top.ok || /^TOP=(.*)$/m.exec(top.out)?.[1] !== repo) return `${repo} isn't the top of a git repository${top.out ? ` (${top.out.slice(0, 300)})` : ""}`;
  }
  const base = posix.join(await target.cwd(), "worktrees");
  const all: Worktree[][] = [];
  for (let i = 1; i <= writers; i++) {
    const mine: Worktree[] = [];
    for (const repo of repos) {
      const wt = { repo, path: posix.join(base, `${runId}-${i}`, posix.basename(repo)), branch: `lyrica/${runId}-${i}` };
      const r = await sh(target, `mkdir -p ${quote(posix.dirname(wt.path))} && git -C ${quote(repo)} worktree add -q -b ${quote(wt.branch)} ${quote(wt.path)}`, signal);
      if (!r.ok) throw new Error(`couldn't make a worktree of ${repo}: ${r.out}`);
      mine.push(wt);
    }
    all.push(mine);
  }
  return all;
}

/** The writer's grants: each repository's .git (for commits), and its other folders as they were. */
export function worktreeGrants(grants: Grant[], mine: Worktree[]): Grant[] {
  return grants.map((g) => (mine.some((w) => w.repo === g.path) ? { path: `${g.path}/.git`, writable: true } : g));
}

export function worktreeNote(mine: Worktree[]): string {
  return mine.map((w) => `${w.repo}: worktree ${w.path}, branch ${w.branch}`).join("\n");
}
