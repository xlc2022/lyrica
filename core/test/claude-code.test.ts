import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Users, Workspace, type Pool } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

// Claude Code on the user's Claude plan (docs/workspace.md, "Claude Code"):
// which runs get the token, and what the `claude` wrapper (claude.sh) runs.

const TOKEN = "sk-ant-oat01-made-up-for-tests-only";

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
  await users.authenticate("li", "pw");
  const localOnly = new Set<string>();
  const workspace = new Workspace(keyring, users, { excludePorts: [], restricted: (_u, pool, thread) => pool === "private" || localOnly.has(thread) });
  const thread = (threadId: string, pool: Pool = "general") => ({ userId: li.id, pool, threadId });
  return { workspace, settings: workspace.settings(li.id), thread, localOnly };
}

describe("Claude Code's token", () => {
  it("reaches only a general thread's runs with the switch on, a saved token and a way to Anthropic, never a local-only or private one", async () => {
    const { workspace, settings, thread, localOnly } = await setup();
    settings.startThread("code", "general");
    expect(settings.thread("code").claudeCode).toBe(false);
    settings.setThread("code", "general", { claudeCode: true });
    // No token saved yet.
    expect(workspace.claudeEnv(thread("code"))).toEqual({});
    expect(() => settings.setClaudeCodeToken("not a token")).toThrow(/claude setup-token/);
    settings.setClaudeCodeToken(TOKEN);
    expect(workspace.claudeEnv(thread("code"))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(workspace.forThread(thread("code")).claudeCode()).toBe(true);

    // The switch off, another thread, or no way to api.anthropic.com: nothing.
    expect(workspace.claudeEnv(thread("other"))).toEqual({});
    settings.setThread("code", "general", { internet: false });
    expect(workspace.claudeEnv(thread("code"))).toEqual({});
    settings.setThread("code", "general", { hosts: ["api.anthropic.com"] });
    expect(workspace.claudeEnv(thread("code")).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);

    // Local-only, itself or through a parent.
    localOnly.add("code");
    expect(workspace.claudeEnv(thread("code"))).toEqual({});
    localOnly.delete("code");
    settings.inheritSettings("code", "child", "general");
    expect(workspace.claudeEnv(thread("child")).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    localOnly.add("code");
    expect(workspace.claudeEnv(thread("child"))).toEqual({});
    localOnly.delete("code");

    // A child is never wider than its parent, and the parent turning it off takes it at once.
    settings.setThread("code", "general", { claudeCode: false });
    expect(workspace.claudeEnv(thread("child"))).toEqual({});
    expect(() => settings.setThread("child", "general", { claudeCode: true })).toThrow(/parent thread has Claude Code off/);

    // Never in a private thread; and Remove takes it from every run.
    expect(() => settings.setThread("p", "private", { claudeCode: true })).toThrow(/private thread can't use Claude Code/);
    settings.setThread("code", "general", { claudeCode: true });
    settings.setClaudeCodeToken(null);
    expect(workspace.claudeEnv(thread("code"))).toEqual({});
  });

  it("is never given when the workspace isn't told which threads are local-only", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const li = await users.createUser("li", "pw", profile("Ada"), { admin: true });
    await users.authenticate("li", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    workspace.settings(li.id).setClaudeCodeToken(TOKEN);
    workspace.settings(li.id).setThread("code", "general", { claudeCode: true });
    expect(workspace.claudeEnv({ userId: li.id, pool: "general", threadId: "code" })).toEqual({});
  });
});

describe("the claude wrapper", () => {
  const WRAPPER = fileURLToPath(new URL("../src/workspace/claude.sh", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "lyrica-claude-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, "real");
  mkdirSync(real);
  // A stand-in that prints what it was given.
  writeFileSync(join(real, "claude"), '#!/bin/sh\necho "args=$*"\necho "config=$CLAUDE_CONFIG_DIR sandbox=$IS_SANDBOX key=${ANTHROPIC_API_KEY:-none} token=$CLAUDE_CODE_OAUTH_TOKEN"\n');
  chmodSync(join(real, "claude"), 0o755);
  const run = (path: string) => execFileSync("/bin/sh", [WRAPPER, "-p", "fix the tests"], {
    encoding: "utf8", env: { PATH: path, CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-other" },
  });

  it("runs the real program past itself, with its notes in the thread's folder and no prompts of its own", () => {
    const out = run(`/run/lyrica/bin:${real}`);
    expect(out).toContain("args=--permission-mode bypassPermissions -p fix the tests");
    // The plan's token, never another key that would bill elsewhere.
    expect(out).toContain(`config=/workspace/.claude sandbox=1 key=none token=${TOKEN}`);
  });

  it("says so when Claude Code isn't installed", () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(() => run(`/run/lyrica/bin:${empty}`)).toThrow(/isn't installed on this server/);
  });
});
