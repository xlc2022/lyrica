import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@lyrica/core";
import { codeRepositories } from "../src/code-repositories.ts";

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
