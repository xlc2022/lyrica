import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@lyrica/core";
import { checkoutsOf, codeRepositories, repoRules, RULES_HEADING, RULES_PER_REPO } from "../src/code-repositories.ts";

/** Runs argv on this machine, as the sandbox would in the thread's folders. */
const local = { run: async (argv: string[]) => {
  const r = spawnSync(argv[0]!, argv.slice(1));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
} } as unknown as ExecutionTarget;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rules-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

describe("code repository context", () => {
  it("reads branch and ten subjects against origin’s base, using argv and cached checks", async () => {
    const calls: string[][] = [];
    const target = { run: async (argv: string[]) => {
      calls.push(argv);
      const output = argv.includes("branch") ? "feature/fix\n" : argv.includes("symbolic-ref") ? "origin/main\n" : "Fix addition\nAdd check\n";
      return { code: 0, stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
    } } as unknown as ExecutionTarget;
    const context = await codeRepositories(target, [{ name: "garden/controller", path: "/workspace/repos/a;echo unsafe" }], ["garden/controller PR #4: tests: passed"]);
    expect(context).toContain("feature/fix (base origin/main)");
    expect(context).toContain("Fix addition\nAdd check");
    expect(context).toContain("PR #4: tests: passed");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(["git", "-C", "/workspace/repos/a;echo unsafe", "log", "-10", "--format=%s", "origin/main..HEAD", "--"]);
    expect(await codeRepositories(target, [])).toBeUndefined();
  });
  it("reports an unavailable clone without blocking a turn", async () => {
    const target = { run: async () => { throw new Error("missing"); } } as unknown as ExecutionTarget;
    expect(await codeRepositories(target, [{ name: "garden/controller", path: "/missing" }])).toBe("garden/controller: repository status unavailable");
  });
});

describe("repository rules in code turns", () => {
  it("reads AGENTS.md from each checkout once, and lists nested ones", async () => {
    const a = repo({ "AGENTS.md": "Run npm test before committing.\n", "web/AGENTS.md": "Use the design tokens.\n", "src/x.ts": "" });
    mkdirSync(join(a, "src", "deep"), { recursive: true });
    const rules = await repoRules(local, [a, join(a, "src")]);
    expect(rules).toContain(RULES_HEADING);
    expect(rules).toContain(`<repository path="${a}" file="AGENTS.md">\nRun npm test before committing.`);
    expect(rules).toContain("Nested instructions (read the one for a folder before working in it): web/AGENTS.md");
    // The same repository through a subfolder isn't read twice.
    expect(rules!.split("<repository ").length).toBe(2);
  });

  it("falls back to CLAUDE.md and expands its @ lines inside the repository only", async () => {
    const b = repo({ "CLAUDE.md": "@docs/rules.md\n@../outside.md\nKeep diffs small.\n", "docs/rules.md": "Tabs, not spaces." });
    const rules = await repoRules(local, [b]);
    expect(rules).toContain('file="CLAUDE.md"');
    expect(rules).toContain("Tabs, not spaces.\n@../outside.md\nKeep diffs small.");
  });

  it("cuts a long file at a line end, naming where the rest is, and skips what isn't a repository", async () => {
    const c = repo({ "AGENTS.md": "rule line\n".repeat(2000) });
    const rules = await repoRules(local, ["/nonexistent", c]);
    expect(rules).toContain(`… (cut here: read the rest in ${c}/AGENTS.md)`);
    expect(rules!.length).toBeLessThan(RULES_PER_REPO + 1000);
    expect(await repoRules(local, ["/nonexistent"])).toBeUndefined();
    expect(await repoRules(local, [repo({ "README.md": "hi" })])).toBeUndefined();
  });

  it("finds a thread's checkouts: worktrees over the folders they replace, clones, writable grants", () => {
    const s = { grants: [{ path: "/srv/game", writable: true }, { path: "/srv/site", writable: true }, { path: "/srv/docs", writable: false }],
      threadWork: { worktrees: [{ repo: "/srv/game", path: "/workspace/worktrees/game" }] } };
    expect(checkoutsOf(s, [{ path: "/workspace/repos/lyrica" }])).toEqual(["/workspace/worktrees/game", "/workspace/repos/lyrica", "/srv/site"]);
  });
});
