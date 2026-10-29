import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_SCRIPT, setupOutcome } from "../src/workspace/setup.ts";

// The script runs here with plain sh, not in the sandbox: what it decides doesn't depend on bwrap, and fake installers on its PATH record each run.
let dir: string, clone: string, bin: string;
const runs = () => { try { return readFileSync(join(dir, "runs"), "utf8").trim().split("\n"); } catch { return []; } };
const fake = (name: string, body = "") => {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${join(dir, "runs")}\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const setup = (command = "", skip = "") => {
  const r = spawnSync("sh", ["-c", SETUP_SCRIPT, "sh", clone, command, skip], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  return { code: r.status, stderr: r.stderr };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lyrica-setup-"));
  clone = join(dir, "clone");
  bin = join(dir, "bin");
  mkdirSync(join(clone, ".git"), { recursive: true });
  mkdirSync(bin);
  fake("npm", "mkdir -p node_modules");
  fake("pnpm");
  fake("yarn");
  fake("uv");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a clone's dependencies", () => {
  it("installs from the lockfile once, again when it changes or the packages are gone, and not without one", () => {
    expect(setup().code).toBe(0);
    expect(runs()).toEqual([]);
    writeFileSync(join(clone, "package-lock.json"), "{}");
    expect(setup().code).toBe(0);
    expect(setup().code).toBe(0);
    expect(runs()).toEqual(["npm ci --ignore-scripts --no-audit --no-fund"]);
    writeFileSync(join(clone, "package-lock.json"), '{"a":1}');
    setup();
    rmSync(join(clone, "node_modules"), { recursive: true });
    setup();
    expect(runs()).toHaveLength(3);
  });

  it("picks pnpm, yarn (by its version) and uv by their lockfiles, never running install scripts", () => {
    const picked = (files: string[]) => {
      rmSync(clone, { recursive: true });
      mkdirSync(join(clone, ".git"), { recursive: true });
      for (const f of files) writeFileSync(join(clone, f), "");
      rmSync(join(dir, "runs"), { force: true });
      setup();
      return runs()[0];
    };
    expect(picked(["pnpm-lock.yaml"])).toBe("pnpm install --frozen-lockfile --ignore-scripts");
    expect(picked(["yarn.lock"])).toBe("yarn install --frozen-lockfile --ignore-scripts");
    expect(picked(["yarn.lock", ".yarnrc.yml"])).toBe("yarn install --immutable --mode=skip-build");
    expect(picked(["uv.lock", "requirements.txt"])).toBe("uv sync --frozen");
  });

  it("runs the project's setup command in place of the lockfile's, again when the command changes", () => {
    writeFileSync(join(clone, "package-lock.json"), "{}");
    fake("make");
    setup("make deps");
    setup("make deps");
    setup("make all");
    expect(runs()).toEqual(["make deps", "make all"]);
  });

  it("keeps no record of a failed install, and skips only the hash it is told failed before", () => {
    writeFileSync(join(clone, "package-lock.json"), "{}");
    fake("npm", "echo 'npm ERR! 404 Not Found - left-pad' >&2; exit 1");
    const failed = setup();
    expect(failed.code).toBe(1);
    const outcome = setupOutcome("ada/garden", failed, (s) => s);
    expect(outcome).toMatchObject({ kind: "failed", problem: "ada/garden: dependencies didn't install (`npm ci --ignore-scripts --no-audit --no-fund` exited 1). Its last lines:\n    npm ERR! 404 Not Found - left-pad" });
    const key = (outcome as { key: string }).key;
    expect(setupOutcome("ada/garden", setup("", key), (s) => s)).toEqual({ kind: "same", key });
    expect(runs()).toHaveLength(1);
    expect(setupOutcome("ada/garden", setup("", "0".repeat(64)), (s) => s).kind).toBe("failed");
    expect(runs()).toHaveLength(2);
  });

  it("says plainly when the installer isn't there, and masks the run's secrets", () => {
    writeFileSync(join(clone, "pnpm-lock.yaml"), "");
    rmSync(join(bin, "pnpm"));
    const r = setup();
    expect(r.code).toBe(127);
    expect(setupOutcome("ada/garden", r, (s) => s).kind === "failed" && (setupOutcome("ada/garden", r, (s) => s) as { problem: string }).problem)
      .toMatch(/^ada\/garden: dependencies didn't install \(`pnpm install --frozen-lockfile --ignore-scripts` exited 127, a program it needs isn't installed in the sandbox\)\. Its last lines:\n {4}.*pnpm/);
    const leaked = { code: 1, stderr: `lyrica-setup ${"a".repeat(64)} npm ci\nfetch https://tok3n@registry failed\n` };
    expect(setupOutcome("ada/garden", leaked, (s) => s.replaceAll("tok3n", "[credential hidden]"))).toMatchObject({ problem: expect.stringContaining("https://[credential hidden]@registry") });
  });
});
