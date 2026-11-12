import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionTarget, ToolOps } from "@lyrica/core";
import { SAVED_REF, saveBeforeDiscard } from "../src/workspace.ts";

// Work git is about to throw away is saved first, against a real repository.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A target whose bash runs here, in `cwd`. */
function localTarget(cwd: string): ExecutionTarget {
  const exec: ToolOps["bash"]["exec"] = (command, dir, { onData }) => new Promise((resolve) => {
    const p = spawn("bash", ["-c", command], { cwd: dir });
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => resolve({ exitCode: code }));
  });
  return { name: "sandbox", cwd: async () => cwd, ops: () => ({ bash: { exec } }) as unknown as ToolOps, folders: () => [] };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } }).trim();

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "saved-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(d, "a.txt"), "one\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "first");
  return d;
}

const saved = (d: string) => git(d, "for-each-ref", "--format=%(refname)", SAVED_REF).split("\n").filter(Boolean);

describe("saved before discarding", () => {
  it("keeps changed, staged and untracked files, and leaves the tree and index as they were", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "two\n");
    writeFileSync(join(d, "staged.txt"), "staged\n");
    git(d, "add", "staged.txt");
    writeFileSync(join(d, "new.txt"), "new\n");
    writeFileSync(join(d, "ignored.txt"), "ignored\n");
    const status = git(d, "status", "--porcelain");
    await saveBeforeDiscard(localTarget(d), ["."]);
    expect(git(d, "status", "--porcelain")).toBe(status);
    const [ref] = saved(d);
    expect(ref).toMatch(/^refs\/lyrica\/saved\/\d{8}T\d{6}Z-[0-9a-f]{7}$/);
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
    await saveBeforeDiscard(localTarget(d), ["."]);
    expect(saved(d)).toEqual([]);
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    dirs.push(plain);
    await expect(saveBeforeDiscard(localTarget(plain), [".", "missing"])).resolves.toBeUndefined();
  });
});
