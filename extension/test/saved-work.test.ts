import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveBeforeDiscard, saveBeforeRemove, savedNote } from "../src/workspace.ts";
import { cleanRepos, dirs, git, localTarget, repo, saved } from "./git-repo.ts";

// Work git is about to throw away is saved first, against a real repository.

afterEach(cleanRepos);


describe("saved before discarding", () => {
  it("keeps changed, staged and untracked files, and leaves the tree and index as they were", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "two\n");
    writeFileSync(join(d, "staged.txt"), "staged\n");
    git(d, "add", "staged.txt");
    writeFileSync(join(d, "new.txt"), "new\n");
    writeFileSync(join(d, "ignored.txt"), "ignored\n");
    const status = git(d, "status", "--porcelain");
    const saves = await saveBeforeDiscard(localTarget(d), ["."]);
    expect(git(d, "status", "--porcelain")).toBe(status);
    const [ref] = saved(d);
    expect(ref).toMatch(/^refs\/lyrica\/saved\/\d{8}T\d{6}Z-[0-9a-f]{7}$/);
    // What she is told: the ref, and how to bring the work back.
    expect(saves).toEqual([{ dir: d, ref }]);
    expect(savedNote(saves)).toContain(`git checkout ${ref} -- .`);
    expect(git(d, "show", `${ref}:a.txt`)).toBe("two");
    expect(git(d, "show", `${ref}:staged.txt`)).toBe("staged");
    expect(git(d, "show", `${ref}:new.txt`)).toBe("new");
    expect(git(d, "ls-tree", "--name-only", ref!)).not.toContain("ignored.txt");
    // What the save is for: after a hard reset and a clean, it brings the work back.
    git(d, "reset", "-q", "--hard");
    git(d, "clean", "-qfd");
    git(d, "checkout", ref!, "--", ".");
    expect(readFileSync(join(d, "new.txt"), "utf8")).toBe("new\n");
  });

  it("saves nothing in a clean repository or a folder that isn't one", async () => {
    const d = repo();
    expect(await saveBeforeDiscard(localTarget(d), ["."])).toEqual([]);
    expect(saved(d)).toEqual([]);
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    dirs.push(plain);
    await expect(saveBeforeDiscard(localTarget(plain), [".", "missing"])).resolves.toEqual([]);
  });

  it("keep a deleted checkout's unsaved work and unpushed commits in a bundle outside it, which a fresh clone fetches back", async () => {
    const origin = repo();
    const parent = mkdtempSync(join(tmpdir(), "parent-"));
    dirs.push(parent);
    git(parent, "clone", "-q", origin, "work");
    const work = join(parent, "work");
    writeFileSync(join(work, "b.txt"), "committed here only\n");
    git(work, "add", "b.txt");
    git(work, "commit", "-q", "-m", "unpushed");
    writeFileSync(join(work, "a.txt"), "changed\n");
    const bundles = join(parent, "saved");
    const saves = await saveBeforeRemove(localTarget(parent), ["work"], bundles);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.dir).toBe(work);
    expect(saves[0]!.bundle).toMatch(new RegExp(`^${bundles}/work-\\d{8}T\\d{6}Z\\.bundle$`));
    rmSync(work, { recursive: true, force: true });
    // Starting over: a fresh clone, then what the note says.
    git(parent, "clone", "-q", origin, "again");
    const again = join(parent, "again");
    git(again, "fetch", "-q", saves[0]!.bundle!, "+refs/heads/*:refs/lyrica/restored/*", "+refs/lyrica/saved/*:refs/lyrica/saved/*");
    expect(git(again, "show", "refs/lyrica/restored/main:b.txt")).toBe("committed here only");
    const [ref] = saved(again);
    git(again, "checkout", ref!, "--", ".");
    expect(readFileSync(join(again, "a.txt"), "utf8")).toBe("changed\n");
    expect(savedNote(saves)).toContain(saves[0]!.bundle!);
  });

  it("bundle nothing for a clean, pushed checkout or a folder with none", async () => {
    const origin = repo();
    const parent = mkdtempSync(join(tmpdir(), "parent-"));
    dirs.push(parent);
    git(parent, "clone", "-q", origin, "work");
    expect(await saveBeforeRemove(localTarget(parent), ["work", "missing"], join(parent, "saved"))).toEqual([]);
    // Deleting the folder the bundles would go to saves nothing, rather than a bundle that goes with it.
    writeFileSync(join(parent, "work", "a.txt"), "changed\n");
    expect(await saveBeforeRemove(localTarget(parent), ["."], join(parent, "saved"))).toEqual([]);
  });
});
