import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { openRelay, Users, Workspace, type Pool } from "../src/index.ts";
import { freshKeyring, profile } from "./helpers.ts";

// Claude Code on the user's Claude plan (docs/workspace.md, "Claude Code"):
// which runs get Claude Code, the relay that keeps the token out of the
// sandbox, and what the `claude` wrapper (claude.sh) runs.

const TOKEN = "sk-ant-oat01-made-up-for-tests-only";

async function setup() {
  const keyring = await freshKeyring();
  const users = new Users(keyring);
  const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
  await users.authenticate("ada", "pw");
  const localOnly = new Set<string>();
  const workspace = new Workspace(keyring, users, { excludePorts: [], restricted: (_u, pool, thread) => pool === "private" || localOnly.has(thread) });
  const thread = (threadId: string, pool: Pool = "general") => ({ userId: ada.id, pool, threadId });
  return { workspace, settings: workspace.settings(ada.id), thread, localOnly };
}

describe("Claude Code's token", () => {
  it("is given to the relay of only a general thread's runs with the switch on, a saved token and a way to Anthropic, never a local-only or private one", async () => {
    const { workspace, settings, thread, localOnly } = await setup();
    settings.startThread("code", "general");
    expect(settings.thread("code").claudeCode).toBe(false);
    settings.setThread("code", "general", { claudeCode: true });
    // No token saved yet.
    expect(workspace.credentialsFor(thread("code")).anthropic).toBeUndefined();
    expect(() => settings.setClaudeCodeToken("not a token")).toThrow(/claude setup-token/);
    settings.setClaudeCodeToken(TOKEN);
    expect(workspace.credentialsFor(thread("code")).anthropic).toBe(TOKEN);
    expect(workspace.forThread(thread("code")).claudeCode()).toBe(true);

    // The switch off, another thread, or no way to api.anthropic.com: nothing.
    expect(workspace.credentialsFor(thread("other")).anthropic).toBeUndefined();
    settings.setThread("code", "general", { internet: false });
    expect(workspace.credentialsFor(thread("code")).anthropic).toBeUndefined();
    settings.setThread("code", "general", { hosts: ["api.anthropic.com"] });
    expect(workspace.credentialsFor(thread("code")).anthropic).toBe(TOKEN);

    // Local-only, itself or through a parent.
    localOnly.add("code");
    expect(workspace.credentialsFor(thread("code")).anthropic).toBeUndefined();
    localOnly.delete("code");
    settings.inheritSettings("code", "child", "general");
    expect(workspace.credentialsFor(thread("child")).anthropic).toBe(TOKEN);
    localOnly.add("code");
    expect(workspace.credentialsFor(thread("child")).anthropic).toBeUndefined();
    localOnly.delete("code");

    // A child is never wider than its parent, and the parent turning it off takes it at once.
    settings.setThread("code", "general", { claudeCode: false });
    expect(workspace.credentialsFor(thread("child")).anthropic).toBeUndefined();
    expect(() => settings.setThread("child", "general", { claudeCode: true })).toThrow(/parent thread has Claude Code off/);

    // Never in a private thread; and Remove takes it from every run.
    expect(() => settings.setThread("p", "private", { claudeCode: true })).toThrow(/private thread can't use Claude Code/);
    settings.setThread("code", "general", { claudeCode: true });
    settings.setClaudeCodeToken(null);
    expect(workspace.credentialsFor(thread("code")).anthropic).toBeUndefined();
  });

  it("is never given when the workspace isn't told which threads are local-only", async () => {
    const keyring = await freshKeyring();
    const users = new Users(keyring);
    const ada = await users.createUser("ada", "pw", profile("Ada"), { admin: true });
    await users.authenticate("ada", "pw");
    const workspace = new Workspace(keyring, users, { excludePorts: [] });
    workspace.settings(ada.id).setClaudeCodeToken(TOKEN);
    workspace.settings(ada.id).setThread("code", "general", { claudeCode: true });
    expect(workspace.credentialsFor({ userId: ada.id, pool: "general", threadId: "code" }).anthropic).toBeUndefined();
  });
});

describe("the claude wrapper", () => {
  const WRAPPER = fileURLToPath(new URL("../src/workspace/claude.sh", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "lyrica-claude-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, "real");
  mkdirSync(real);
  // A stand-in that prints what it was given.
  writeFileSync(join(real, "claude"), '#!/bin/sh\necho "args=$*"\necho "config=$CLAUDE_CONFIG_DIR sandbox=$IS_SANDBOX key=${ANTHROPIC_API_KEY:-none} token=$CLAUDE_CODE_OAUTH_TOKEN base=$ANTHROPIC_BASE_URL"\n');
  chmodSync(join(real, "claude"), 0o755);
  const run = (path: string) => execFileSync("/bin/sh", [WRAPPER, "-p", "fix the tests"], {
    encoding: "utf8", env: { PATH: path, CLAUDE_CODE_OAUTH_TOKEN: "capability", ANTHROPIC_BASE_URL: "http://127.0.0.1:4100", ANTHROPIC_API_KEY: "sk-other" },
  });

  it("runs the real program past itself, with its notes in the thread's own folder for them and no prompts of its own", () => {
    const out = run(`/run/lyrica/bin:${real}`);
    expect(out).toContain("args=--permission-mode bypassPermissions -p fix the tests");
    // The run's capability and relay, never another key that would bill elsewhere.
    expect(out).toContain("config=/run/lyrica/claude sandbox=1 key=none token=capability base=http://127.0.0.1:4100");
  });

  it("says so when Claude Code isn't installed", () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(() => run(`/run/lyrica/bin:${empty}`)).toThrow(/isn't installed on this server/);
  });
});

describe("the relay", () => {
  it("passes only its run's /v1/ requests to Anthropic, with the token swapped in, and nothing once closed", async () => {
    const seen: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => { seen.push({ url: req.url, headers: req.headers, body }); res.writeHead(200, { "content-type": "text/event-stream" }).end("data: ok\n\n"); });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    try {
      const relay = await openRelay({ anthropic: TOKEN, reaches: () => true, internet: true, upstreams: { "api.anthropic.com": `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` } });
      const base = `http://127.0.0.1:${relay.port}`;
      const send = (path: string, bearer: string) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "x-api-key": "sk-other", "anthropic-beta": "oauth-2025-04-20" }, body: "{}" });
      expect((await send("/v1/messages", "made-up")).status).toBe(401);
      expect((await send("/elsewhere", relay.capability)).status).toBe(401);
      expect(seen).toEqual([]);
      const ok = await send("/v1/messages?beta=true", relay.capability);
      expect(await ok.text()).toBe("data: ok\n\n");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ url: "/v1/messages?beta=true", body: "{}", headers: { authorization: `Bearer ${TOKEN}`, "anthropic-beta": "oauth-2025-04-20" } });
      expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
      expect(relay.capability).not.toContain(TOKEN);
      relay.close();
      await expect(send("/v1/messages", relay.capability)).rejects.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      upstream.close();
    }
  });
});
