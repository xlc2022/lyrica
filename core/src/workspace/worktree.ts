import { posix } from "node:path";
import type { ExecutionTarget } from "./ops.ts";
import type { Grant } from "./settings.ts";

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
 * writers run one at a time. `placement` gives project threads their own
 * folder and branch; `reuse` restores a resolved thread on that branch.
 */
export async function makeWorktrees(target: ExecutionTarget, grants: Grant[], runId: string, writers: number, signal?: AbortSignal, placement?: { branch: string; directory: string; reuse?: boolean }): Promise<Worktree[][] | string> {
  const repos = grants.filter((g) => g.writable).map((g) => g.path);
  if (target.name !== "sandbox") return `worktrees need the sandbox, and this thread works on ${target.name}`;
  if (!repos.length) return "this thread has no writable folders, only its scratch folder";
  for (const repo of repos) {
    // Marked, because a networked sandbox may add its own lines to the output.
    const top = await sh(target, `cd ${quote(repo)} && test -d .git && echo "TOP=$(git rev-parse --show-toplevel)"`, signal);
    if (!top.ok || /^TOP=(.*)$/m.exec(top.out)?.[1] !== repo) return `${repo} isn't the top of a git repository${top.out ? ` (${top.out.slice(0, 300)})` : ""}`;
  }
  for (const repo of placement?.reuse ? [] : repos) {
    const merging = await sh(target, `git -C ${quote(repo)} rev-parse -q --verify MERGE_HEAD`, signal);
    if (merging.ok) return `${repo} is mid-merge`;
  }
  if (new Set(repos.map((r) => posix.basename(r))).size !== repos.length) return "writable repositories have the same folder name";
  const base = posix.join(await target.cwd(), "worktrees");
  const all: Worktree[][] = [];
  try {
    for (let i = 1; i <= writers; i++) {
      const mine: Worktree[] = [];
      all.push(mine);
      for (const repo of repos) {
        const wt = { repo, path: posix.join(placement?.directory ?? posix.join(base, `${runId}-${i}`), posix.basename(repo)), branch: placement?.branch ?? `lyrica/${runId}-${i}` };
        if (placement?.reuse && (await sh(target, `test -e ${quote(`${wt.path}/.git`)}`)).ok) { mine.push(wt); continue; }
        const existing = placement?.reuse && (await sh(target, `git -C ${quote(repo)} show-ref --verify --quiet ${quote(`refs/heads/${wt.branch}`)}`, signal)).ok;
        const checkout = existing ? `${quote(wt.path)} ${quote(wt.branch)}` : `-b ${quote(wt.branch)} ${quote(wt.path)}`;
        const r = await sh(target, `mkdir -p ${quote(posix.dirname(wt.path))} && git -c core.hooksPath=/dev/null -C ${quote(repo)} worktree add -q ${checkout}`, signal);
        if (!r.ok) throw new Error(`couldn't make a worktree of ${repo}: ${r.out}`);
        mine.push(wt);
      }
    }
  } catch (err) {
    await removeWorktrees(target, all.flat());
    throw err;
  }
  return all;
}

/** The writer's grants: each repository's .git (for commits), and its other folders as they were. */
export function worktreeGrants(grants: Grant[], mine: Worktree[], readOriginal = false): Grant[] {
  return grants.flatMap((g) => mine.some((w) => w.repo === g.path)
    ? [...readOriginal ? [{ ...g, writable: false }] : [], { path: `${g.path}/.git`, writable: g.writable }] : [g]);
}

/**
 * Removes a writer's worktrees, keeping their branches. One with changes that
 * weren't committed is kept, and the note says where, unless `force`.
 */
export async function removeWorktrees(target: ExecutionTarget, mine: Worktree[], force = false): Promise<string> {
  const lines: string[] = [];
  for (const w of mine) {
    const r = await sh(target, `git -c core.hooksPath=/dev/null -C ${quote(w.repo)} worktree remove${force ? " --force" : ""} ${quote(w.path)} && rmdir ${quote(posix.dirname(w.path))}`);
    lines.push(r.ok || !(await sh(target, `test -e ${quote(w.path)}`)).ok
      ? `${w.repo}: its commits are on branch ${w.branch}.`
      : `${w.repo}: its commits are on branch ${w.branch}; its worktree ${w.path} was kept, because it has changes that weren't committed.`);
  }
  return lines.join("\n");
}

/**
 * What a checkout holds that no remote has: files changed and not committed,
 * and commits on no remote (counted only when it has one). Undefined when
 * there's nothing, or it isn't a repository.
 */
export async function unsaved(target: ExecutionTarget, path: string): Promise<string | undefined> {
  const r = await sh(target, `cd ${quote(path)} && echo "CHANGED=$(git status --porcelain | wc -l) AHEAD=$(if test -n "$(git remote)"; then git rev-list --count HEAD --not --remotes; else echo 0; fi)"`);
  const m = /CHANGED=\s*(\d+) AHEAD=\s*(\d+)/.exec(r.out);
  if (!r.ok || !m) return undefined;
  const [changed, ahead] = [Number(m[1]), Number(m[2])];
  const parts = [...(changed ? [`${changed} file${changed === 1 ? "" : "s"} not committed`] : []), ...(ahead ? [`${ahead} commit${ahead === 1 ? "" : "s"} not pushed`] : [])];
  return parts.length ? parts.join(", ") : undefined;
}

export function worktreeNote(mine: Worktree[]): string {
  return mine.map((w) => `${w.repo}: worktree ${w.path}, branch ${w.branch}`).join("\n");
}
