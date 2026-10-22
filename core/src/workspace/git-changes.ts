import { posix } from "node:path";
import type { ExecutionTarget } from "./ops.ts";

// The changes view (docs/ux.md §6, "The changes a thread made"): what a
// thread's checkout holds against its base branch, read with fixed git argv
// where its tools run, for the web's Changes dialog. Nothing is written,
// stored or logged; the texts go to the user's own browser and nowhere else.

/** One file the branch changed, against its base, or in one commit. */
export interface ChangedFile {
  path: string;
  /** For a rename: where it was. */
  oldPath?: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
  /** git counts no lines for it. */
  binary?: boolean;
}

export interface ChangeCommit { hash: string; subject: string; author: string; at: string }

/** One checkout's changes: its commits since the base, and every file changed since it, uncommitted work included. */
export interface RepositoryChanges {
  /** The repository's name ("owner/name" for a clone, the folder's name for a granted checkout). */
  name: string;
  /** The checkout, as the sandbox sees it; the key of the other calls. */
  path: string;
  /** Empty on a detached head. */
  branch: string;
  /** The base the branch is compared with (origin's default branch), or undefined when none is known. */
  base?: string;
  /** Newest first, at most `COMMITS`. */
  commits: ChangeCommit[];
  /** The working tree differs from the last commit. */
  uncommitted: boolean;
  files: ChangedFile[];
}

/** Both sides of one file, as text; absent where the file didn't exist on that side. */
export interface FileSides { before?: string; after?: string; binary?: boolean; tooLarge?: boolean }

export const COMMITS = 100;
/** A side bigger than this isn't sent. */
export const SIDE_LIMIT = 512 * 1024;
const TIMEOUT_MS = 15_000;

export class ChangesUnavailable extends Error {}

/** Lines of `git diff --numstat -M -z` (or `git show` with them), each file once. */
export function parseNumstat(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(p);
    if (!m) continue;
    const binary = m[1] === "-";
    const added = binary ? 0 : Number(m[1]), removed = binary ? 0 : Number(m[2]);
    if (m[3] === "") {
      // A rename: the two paths follow as their own fields.
      const oldPath = parts[++i] ?? "", path = parts[++i] ?? "";
      if (path) files.push({ path, oldPath, kind: "renamed", added, removed, ...(binary ? { binary } : {}) });
      continue;
    }
    files.push({ path: m[3]!, kind: "modified", added, removed, ...(binary ? { binary } : {}) });
  }
  return files;
}

/** The commits of `git log` in the format `LOG_FORMAT`, in git's order. */
export function parseLog(out: string): ChangeCommit[] {
  return out.split("\x1e").flatMap((rec) => {
    const [hash, subject, author, at] = rec.replace(/^\n/, "").split("\x1f");
    return hash && at ? [{ hash, subject: subject ?? "", author: author ?? "", at }] : [];
  });
}

export const LOG_FORMAT = "--format=%H%x1f%s%x1f%an%x1f%cI%x1e";

type Run = (args: string[]) => Promise<{ code: number | null; out: string }>;

function runner(target: ExecutionTarget, repo: string): Run {
  if (!target.run) throw new ChangesUnavailable("this thread's tools run where git can't be read");
  return async (args) => {
    const r = await target.run!(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, ...args], { timeoutMs: TIMEOUT_MS });
    return { code: r.code, out: r.stdout.toString() };
  };
}

/** Origin's default branch as a ref ("origin/main"), or the first of the usual names that exists. */
async function baseOf(run: Run): Promise<string | undefined> {
  const head = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  for (const name of ["origin/main", "origin/master", "main", "master"]) {
    if ((await run(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).code === 0) return name;
  }
  return undefined;
}

/** `added` and `deleted` where a side is missing: numstat alone can't tell a new file from a changed one. */
async function withKinds(run: Run, from: string, files: ChangedFile[]): Promise<ChangedFile[]> {
  if (!files.length) return files;
  const before = await run(["ls-tree", "-r", "-z", "--name-only", from, "--"]);
  const had = new Set(before.code === 0 ? before.out.split("\0") : []);
  return files.map((f) => (f.kind === "renamed" || had.has(f.path) ? f : { ...f, kind: "added" }));
}

/** Files git doesn't track yet, counted as added, with their line counts (each read once; at most 200). */
async function untracked(run: Run, repo: string): Promise<ChangedFile[]> {
  const r = await run(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (r.code !== 0) return [];
  const paths = r.out.split("\0").filter(Boolean).slice(0, 200);
  const out: ChangedFile[] = [];
  for (const path of paths) {
    const d = await run(["diff", "--numstat", "--no-index", "-z", "--", "/dev/null", posix.join(repo, path)]);
    const f = parseNumstat(d.out)[0];
    out.push({ path, kind: "added", added: f?.added ?? 0, removed: 0, ...(f?.binary ? { binary: true } : {}) });
  }
  return out;
}

/** Everything the branch holds against its base, uncommitted work included. */
export async function repositoryChanges(target: ExecutionTarget, repo: { name: string; path: string }): Promise<RepositoryChanges> {
  const run = runner(target, repo.path);
  const branch = await run(["branch", "--show-current"]);
  if (branch.code !== 0) throw new ChangesUnavailable(`${repo.name} can't be read now`);
  const base = await baseOf(run);
  const mergeBase = base ? await run(["merge-base", base, "HEAD"]) : undefined;
  const from = mergeBase?.code === 0 && mergeBase.out.trim() ? mergeBase.out.trim() : "HEAD";
  const log = from === "HEAD" ? { code: 0, out: "" } : await run(["log", `-${COMMITS}`, LOG_FORMAT, `${from}..HEAD`, "--"]);
  const status = await run(["status", "--porcelain", "-z", "--untracked-files=normal"]);
  const numstat = await run(["diff", "--numstat", "-M", "-z", from, "--"]);
  const deleted = await run(["diff", "--name-only", "--diff-filter=D", "-z", from, "--"]);
  const gone = new Set(deleted.code === 0 ? deleted.out.split("\0") : []);
  const tracked = (await withKinds(run, from, parseNumstat(numstat.out))).map((f) => (gone.has(f.path) ? { ...f, kind: "deleted" as const } : f));
  const files = [...tracked, ...(await untracked(run, repo.path))].sort((a, b) => a.path.localeCompare(b.path));
  return {
    name: repo.name, path: repo.path, branch: branch.out.trim(), ...(base ? { base } : {}),
    commits: parseLog(log.code === 0 ? log.out : ""), uncommitted: status.code === 0 && status.out.length > 0, files,
  };
}

/** The working tree's own changes against the last commit, `WORKING` in place of a commit's hash. */
export const WORKING = "working";

/** One commit's files, or the uncommitted ones. */
export async function commitFiles(target: ExecutionTarget, repo: string, hash: string): Promise<ChangedFile[]> {
  const run = runner(target, repo);
  if (hash === WORKING) {
    const numstat = await run(["diff", "--numstat", "-M", "-z", "HEAD", "--"]);
    if (numstat.code !== 0) throw new ChangesUnavailable(`${repo} can't be read now`);
    const deleted = await run(["diff", "--name-only", "--diff-filter=D", "-z", "HEAD", "--"]);
    const gone = new Set(deleted.code === 0 ? deleted.out.split("\0") : []);
    const tracked = (await withKinds(run, "HEAD", parseNumstat(numstat.out))).map((f) => (gone.has(f.path) ? { ...f, kind: "deleted" as const } : f));
    return [...tracked, ...(await untracked(run, repo))].sort((a, b) => a.path.localeCompare(b.path));
  }
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new ChangesUnavailable("not a commit");
  const r = await run(["show", "--numstat", "-M", "-z", "--format=", "--diff-filter=ACDMR", hash, "--"]);
  if (r.code !== 0) throw new ChangesUnavailable("that commit can't be read");
  const files = parseNumstat(r.out);
  const kinds = await run(["show", "--name-status", "-z", "--format=", "--diff-filter=AD", hash, "--"]);
  const status = new Map<string, string>();
  if (kinds.code === 0) {
    const parts = kinds.out.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1]!, parts[i]!);
  }
  return files.map((f) => (status.get(f.path) === "A" ? { ...f, kind: "added" as const } : status.get(f.path) === "D" ? { ...f, kind: "deleted" as const } : f)).sort((a, b) => a.path.localeCompare(b.path));
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/**
 * A file's two sides: against the base (`commit` "all": the base's version and the working tree's), uncommitted
 * (WORKING: the last commit's and the working tree's) or in one commit (its parent's version and its own). A side
 * that doesn't exist is left out.
 */
export async function fileSides(target: ExecutionTarget, repo: string, path: string, oldPath: string | undefined, commit: string): Promise<FileSides> {
  if (!target.run) throw new ChangesUnavailable("this thread's tools run where git can't be read");
  for (const p of [path, oldPath ?? path]) if (p.startsWith("/") || p.split("/").includes("..")) throw new ChangesUnavailable("not a path in the repository");
  const run = runner(target, repo);
  const sideOf = async (argv: string[]): Promise<Buffer | undefined> => {
    const r = await target.run!(argv, { timeoutMs: TIMEOUT_MS });
    return r.code === 0 ? r.stdout : undefined;
  };
  const show = (ref: string, p: string) => sideOf(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, "show", `${ref}:${p}`]);
  let before: Buffer | undefined, after: Buffer | undefined;
  if (commit === "all" || commit === WORKING) {
    const base = commit === "all" ? await baseOf(run) : undefined;
    const mb = base ? await run(["merge-base", base, "HEAD"]) : undefined;
    const from = mb?.code === 0 && mb.out.trim() ? mb.out.trim() : "HEAD";
    before = await show(from, oldPath ?? path);
    // A symlink reads as its target's path, as git keeps it, never as what it points at.
    after = await sideOf(["sh", "-c", 'if [ -L "$1" ]; then readlink -- "$1"; else cat -- "$1"; fi', "sh", posix.join(repo, path)]);
  } else {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new ChangesUnavailable("not a commit");
    before = await show(`${commit}^`, oldPath ?? path);
    after = await show(commit, path);
  }
  if ((before && isBinary(before)) || (after && isBinary(after))) return { binary: true };
  if ((before?.length ?? 0) > SIDE_LIMIT || (after?.length ?? 0) > SIDE_LIMIT) return { tooLarge: true };
  return { ...(before ? { before: before.toString("utf8") } : {}), ...(after ? { after: after.toString("utf8") } : {}) };
}
