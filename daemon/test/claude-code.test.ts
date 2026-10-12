import { describe, expect, it } from "vitest";
import type { ClaudeCodeStatus, ThreadSettings, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, login, runtime } from "./helpers.ts";

// Settings → Claude Code and the thread's switch (docs/workspace.md, "Claude Code").

const TOKEN = "sk-ant-oat01-made-up-for-tests-only";

describe("Claude Code", () => {
  it("keeps the token without ever showing it back, and keeps the switch out of a local-only thread", async () => {
    const rt = await runtime();
    const { base, logs } = await daemon(rt);
    await browser(base).post("/api/unlock", { passphrase: "passphrase" });
    const li = await login(base, "li", "pw");
    const url = `/api/u/${rt.li.id}/claude-code`;

    expect((await li.get<ClaudeCodeStatus>(url)).body.token).toBe(false);
    expect((await li.put(url, { token: "short" })).status).toBe(400);
    const saved = await li.put<ClaudeCodeStatus>(url, { token: TOKEN });
    expect(saved.body.token).toBe(true);
    expect(JSON.stringify((await li.get(url)).body)).not.toContain(TOKEN);

    const thread = (await li.post<ThreadSummary>(`/api/u/${rt.li.id}/threads`, { pool: "general" })).body;
    const path = `/api/u/${rt.li.id}/threads/general/${enc(thread.id)}/settings`;
    expect((await li.get<ThreadSettings>(path)).body.claudeCode).toBe(false);
    expect((await li.patch<ThreadSettings>(path, { claudeCode: true })).body.claudeCode).toBe(true);
    // Local-only and Claude Code don't go together, in either order.
    expect((await li.patch(path, { localOnly: true })).status).toBe(400);
    expect((await li.patch<ThreadSettings>(path, { claudeCode: false, localOnly: true })).body).toMatchObject({ claudeCode: false, localOnly: true, claudeCodeOffered: false });
    expect((await li.patch(path, { claudeCode: true })).status).toBe(400);

    expect((await li.del<ClaudeCodeStatus>(url)).body.token).toBe(false);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
