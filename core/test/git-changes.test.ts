// The changes view's reads (git-changes.ts): a real repository on this machine, git run by argv as the sandbox
// would run it, and what the view shows of it: the branch against its base, each commit, uncommitted work.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commitFiles, fileSides, parseLog, parseNumstat, repositoryChanges, WORKING, type ExecutionTarget } from "../src/index.ts";

const local = { name: "sandbox", run: async (argv: string[]) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
} } as unknown as ExecutionTarget;

const dir = mkdtempSync(join(tmpdir(), "changes-"));
const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Ada", "-c", "user.email=ada@example.test", ...args]).toString();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the changes a thread made", () => {
  it("reads the branch against its base: commits, the files, uncommitted work, both sides of a file", async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "b.txt"), "gone soon\n");
    writeFileSync(join(dir, "c.txt"), "to be moved\n");
    git("add", "-A"); git("commit", "-q", "-m", "Start");
    git("checkout", "-q", "-b", "feature/view");
    writeFileSync(join(dir, "a.txt"), "one\ntwo changed\nthree\n");
    unlinkSync(join(dir, "b.txt"));
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    git("mv", "c.txt", "moved.txt");
    git("add", "-A"); git("commit", "-q", "-m", "Change things");
    writeFileSync(join(dir, "a.txt"), "one\ntwo changed\nthree\nfour\n");
    writeFileSync(join(dir, "untracked.txt"), "not yet\nadded\n");
    writeFileSync(join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

    const r = await repositoryChanges(local, { name: "garden/controller", path: dir });
    expect(r.branch).toBe("feature/view");
    expect(r.base).toBe("main");
    expect(r.commits.map((c) => c.subject)).toEqual(["Change things"]);
    expect(r.commits[0]!.author).toBe("Ada");
    expect(r.uncommitted).toBe(true);
    expect(r.files.map((f) => [f.path, f.kind, f.added, f.removed])).toEqual([
      ["a.txt", "modified", 2, 1], ["b.txt", "deleted", 0, 1], ["moved.txt", "renamed", 0, 0], ["new.txt", "added", 1, 0],
      ["pic.png", "added", 0, 0], ["untracked.txt", "added", 2, 0],
    ]);
    expect(r.files.find((f) => f.path === "moved.txt")?.oldPath).toBe("c.txt");
    expect(r.files.find((f) => f.path === "pic.png")?.binary).toBe(true);

    const commit = await commitFiles(local, dir, r.commits[0]!.hash);
    expect(commit.map((f) => [f.path, f.kind])).toEqual([["a.txt", "modified"], ["b.txt", "deleted"], ["moved.txt", "renamed"], ["new.txt", "added"]]);
    const working = await commitFiles(local, dir, WORKING);
    expect(working.map((f) => [f.path, f.kind, f.added])).toEqual([["a.txt", "modified", 1], ["pic.png", "added", 0], ["untracked.txt", "added", 2]]);

    expect(await fileSides(local, dir, "a.txt", undefined, "all")).toEqual({ before: "one\ntwo\nthree\n", after: "one\ntwo changed\nthree\nfour\n" });
    expect(await fileSides(local, dir, "a.txt", undefined, WORKING)).toEqual({ before: "one\ntwo changed\nthree\n", after: "one\ntwo changed\nthree\nfour\n" });
    expect(await fileSides(local, dir, "a.txt", undefined, r.commits[0]!.hash)).toEqual({ before: "one\ntwo\nthree\n", after: "one\ntwo changed\nthree\n" });
    expect(await fileSides(local, dir, "b.txt", undefined, "all")).toEqual({ before: "gone soon\n" });
    expect(await fileSides(local, dir, "moved.txt", "c.txt", "all")).toEqual({ before: "to be moved\n", after: "to be moved\n" });
    expect(await fileSides(local, dir, "untracked.txt", undefined, "all")).toEqual({ after: "not yet\nadded\n" });
    expect(await fileSides(local, dir, "pic.png", undefined, "all")).toEqual({ binary: true });
    symlinkSync("a.txt", join(dir, "link.txt"));
    expect(await fileSides(local, dir, "link.txt", undefined, "all")).toEqual({ after: "a.txt\n" });
    await expect(fileSides(local, dir, "../etc/passwd", undefined, "all")).rejects.toThrow("not a path");
    await expect(commitFiles(local, dir, "HEAD; rm -rf /")).rejects.toThrow("not a commit");
  });

  it("reads a pull request's head branch when the checkout sits behind on its base", async () => {
    // A clone on `main` while the pull request's work is on its head branch, in a worktree of the same clone:
    // the checked-out branch reads as nothing against the base, the head branch holds the changes.
    const sub = join(dir, "pull");
    execFileSync("git", ["init", "-q", "-b", "main", sub]);
    const inSub = (...args: string[]) => execFileSync("git", ["-C", sub, "-c", "user.name=Ada", "-c", "user.email=ada@example.test", ...args]).toString();
    writeFileSync(join(sub, "a.txt"), "one\n");
    inSub("add", "-A"); inSub("commit", "-q", "-m", "Start");
    inSub("branch", "feature/sort");
    writeFileSync(join(sub, "a.txt"), "one\ntwo\n"); inSub("add", "-A"); inSub("commit", "-q", "-m", "Merged since");
    execFileSync("git", ["-C", sub, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    inSub("checkout", "-q", "feature/sort");
    writeFileSync(join(sub, "a.txt"), "one\ntwo changed\n");
    writeFileSync(join(sub, "sort.ts"), "export const byName = (a: string, b: string) => a.localeCompare(b);\n");
    inSub("add", "-A"); inSub("commit", "-q", "-m", "The table sorts by its heads");
    inSub("checkout", "-q", "main");

    const empty = await repositoryChanges(local, { name: "garden/controller", path: sub });
    expect(empty.branch).toBe("main");
    expect(empty.files).toEqual([]);
    expect(empty.commits).toEqual([]);

    const pull = await repositoryChanges(local, { name: "garden/controller", path: sub }, "feature/sort");
    expect(pull.branch).toBe("feature/sort");
    expect(pull.base).toBe("origin/main");
    expect(pull.commits.map((c) => c.subject)).toEqual(["The table sorts by its heads"]);
    expect(pull.uncommitted).toBe(false);
    expect(pull.files.map((f) => [f.path, f.kind, f.added, f.removed])).toEqual([["a.txt", "modified", 1, 0], ["sort.ts", "added", 1, 0]]);

    expect(await fileSides(local, sub, "a.txt", undefined, "all", "feature/sort")).toEqual({ before: "one\n", after: "one\ntwo changed\n" });
    // The working tree stays the checked-out branch's: "all" reads the head branch, WORKING still reads the
    // local commit and the working tree, even with the pull request's head branch off the checkout.
    writeFileSync(join(sub, "a.txt"), "one\ntwo\nlocal edit\n");
    expect(await fileSides(local, sub, "a.txt", undefined, "all", "feature/sort")).toEqual({ before: "one\n", after: "one\ntwo changed\n" });
    expect(await fileSides(local, sub, "a.txt", undefined, WORKING, "feature/sort")).toEqual({ before: "one\ntwo\n", after: "one\ntwo\nlocal edit\n" });
    // A head branch the checkout is on, or one that isn't there, reads as before.
    writeFileSync(join(sub, "a.txt"), "one\ntwo\n");
    const onHead = await repositoryChanges(local, { name: "garden/controller", path: sub }, "main");
    expect(onHead.branch).toBe("main");
    expect(onHead.files).toEqual([]);
    const absent = await repositoryChanges(local, { name: "garden/controller", path: sub }, "feature/elsewhere");
    expect(absent.branch).toBe("main");
    expect(absent.files).toEqual([]);
  });

  it("parses numstat with renames and binaries, and the log format", () => {
    expect(parseNumstat(["3\t1\ta.txt", "-\t-\tpic.png", "0\t0\t", "old/c.txt", "new/c.txt", ""].join("\0"))).toEqual([
      { path: "a.txt", kind: "modified", added: 3, removed: 1 },
      { path: "pic.png", kind: "modified", added: 0, removed: 0, binary: true },
      { path: "new/c.txt", oldPath: "old/c.txt", kind: "renamed", added: 0, removed: 0 },
    ]);
    expect(parseLog("abc\x1fFix it\x1fAda\x1f2026-10-22T01:00:00+00:00\x1e\ndef\x1fStart\x1fSam\x1f2026-10-21T01:00:00+00:00\x1e\n")).toEqual([
      { hash: "abc", subject: "Fix it", author: "Ada", at: "2026-10-22T01:00:00+00:00" },
      { hash: "def", subject: "Start", author: "Sam", at: "2026-10-21T01:00:00+00:00" },
    ]);
  });
});
