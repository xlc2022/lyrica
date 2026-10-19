import type { ExecutionTarget, ThreadGitRepository } from "@lyrica/core";

/** Read once per turn, without a model or a network request. */
export async function codeRepositories(target: ExecutionTarget, repositories: Pick<ThreadGitRepository, "name" | "path">[], pulls: string[] = []): Promise<string | undefined> {
  if (!repositories.length) return undefined;
  const lines: string[] = [];
  for (const repo of repositories) {
    if (!target.run) { lines.push(`${repo.name}: repository status unavailable`); continue; }
    try {
      const run = (args: string[]) => target.run!(["git", "-C", repo.path, ...args], { timeoutMs: 5000 });
      const branch = await run(["branch", "--show-current"]);
      if (branch.code !== 0) throw new Error("repository unavailable");
      const base = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      const baseName = base.code === 0 ? base.stdout.toString().trim() : undefined;
      const commits = baseName ? await run(["log", "-10", "--format=%s", `${baseName}..HEAD`, "--"]) : undefined;
      lines.push(`${repo.name}: ${branch.stdout.toString().trim() || "detached HEAD"}${baseName ? ` (base ${baseName})` : " (base unknown)"}`);
      if (commits?.code === 0 && commits.stdout.length) lines.push(commits.stdout.toString().trim());
    } catch { lines.push(`${repo.name}: repository status unavailable`); }
  }
  return [...lines, ...pulls].join("\n");
}
