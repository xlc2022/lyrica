// A real git repository and a target whose bash runs on this machine, for the tests of work saved before git discards it.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionTarget, ToolOps } from "@lyrica/core";
import { SAVED_REF } from "../src/workspace.ts";

export const dirs: string[] = [];
export const cleanRepos = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); };

/** A target whose bash runs here, in `cwd`. */
export function localTarget(cwd: string): ExecutionTarget {
  const exec: ToolOps["bash"]["exec"] = (command, dir, { onData }) => new Promise((resolve) => {
    const p = spawn("bash", ["-c", command], { cwd: dir });
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => resolve({ exitCode: code }));
  });
  return { name: "sandbox", cwd: async () => cwd, ops: () => ({ bash: { exec } }) as unknown as ToolOps, folders: () => [] };
}

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } }).trim();

export function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "saved-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(d, "a.txt"), "one\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "first");
  return d;
}

export const saved = (d: string) => git(d, "for-each-ref", "--format=%(refname)", SAVED_REF).split("\n").filter(Boolean);
