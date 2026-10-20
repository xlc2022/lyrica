import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@lyrica/core";
import { CHECK_ROUNDS, CHECKS_FAILED, CHECKS_NOTICE, createChecksExtension, tail, type ChecksOptions } from "../src/checks.ts";

/** She edits once, then says done after every message; the checks pass from round `passFrom` (never when 0). */
async function scenario(o: { passFrom?: number; edit?: boolean; thinking?: boolean; options?: Partial<ChecksOptions>; output?: string; reject?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-checks-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "coder" }] });
  const runs: string[][] = [];
  const seen: string[] = [];
  let round = 0;
  const target = { secrets: () => ["sekret-token"], run: async (argv: string[]) => {
    runs.push(argv);
    if (o.reject) throw new Error(o.reject);
    const ok = !!o.passFrom && round >= o.passFrom;
    return { code: ok ? 0 : 1, stdout: Buffer.from(ok ? "all good\n" : o.output ?? "FAIL track.test.ts\nexpected surface\n"), stderr: Buffer.alloc(0) };
  } } as unknown as ExecutionTarget;
  const done = (ctx: { messages: unknown[] }) => {
    round++;
    seen.push(JSON.stringify(ctx.messages.slice(-1)));
    return fauxAssistantMessage(o.thinking ? fauxThinking("The track renders now.") : "Done: the track renders.");
  };
  faux.setResponses([
    () => fauxAssistantMessage(o.edit === false ? "Nothing to change." : fauxToolCall("write", { path: "a.ts" }), { stopReason: o.edit === false ? "stop" : "toolUse" }),
    ...Array.from({ length: 6 }, () => done),
  ]);
  const options: ChecksOptions = { checks: () => ["npm test"], code: () => true, plan: () => false, checkouts: () => ["/workspace/repos/game"], target: () => target, ...o.options };
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [createChecksExtension(options), pi => {
      pi.registerProvider(faux.provider);
      pi.registerTool({ name: "write", label: "write", description: "write", parameters: Type.Object({ path: Type.String() }),
        execute: async () => ({ content: [{ type: "text", text: "written" }], details: {} }) });
    }] });
  try {
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" });
    try {
      await session.bindExtensions({});
      await session.setModel(faux.getModel());
      await session.prompt("Fix the track");
      const entries = session.sessionManager.getEntries() as { type: string; customType?: string; content?: unknown; display?: boolean }[];
      const notices = entries.filter((e) => e.type === "custom_message" && e.customType === CHECKS_NOTICE).map((e) => String(e.content));
      const told = entries.filter((e) => e.type === "custom_message" && e.customType === CHECKS_FAILED);
      return { runs, notices, told, seen, round };
    } finally { session.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("project checks", () => {
  it("run the person's commands in each checkout when she ends a turn after a change, and keep her going until they pass", async () => {
    const r = await scenario({ passFrom: 2 });
    expect(r.runs[0]).toEqual(["sh", "-c", 'cd "$1" && sh -c "$2" 2>&1', "sh", "/workspace/repos/game", "npm test"]);
    expect(r.notices).toEqual(["Checks failed: `npm test`", "Checks passed: `npm test`"]);
    // She saw the failure's output, unseen by the person, and answered again.
    expect(r.told).toHaveLength(1);
    expect(r.seen[1]).toContain("expected surface");
    expect(r.round).toBe(2);
  });

  it(`stop after ${CHECK_ROUNDS} failing rounds and ask her to say plainly it isn't done`, async () => {
    const r = await scenario({ passFrom: 0 });
    expect(r.notices).toHaveLength(CHECK_ROUNDS);
    expect(r.seen[CHECK_ROUNDS]).toContain("still fail after 3 rounds");
    expect(r.round).toBe(CHECK_ROUNDS + 1);
  });

  it("don't run without a change, outside code mode, in Plan mode or without checks", async () => {
    for (const o of [{ edit: false }, { options: { code: () => false } }, { options: { plan: () => true } }, { options: { checks: () => [] } }]) {
      const r = await scenario({ passFrom: 1, ...o });
      expect(r.runs).toEqual([]);
      expect(r.notices).toEqual([]);
    }
  });

  it("don't run on a reply with only thinking: it doesn't end her work", async () => {
    const r = await scenario({ passFrom: 1, thinking: true });
    expect(r.runs).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("run once in the thread's folder when it has no checkout", async () => {
    const r = await scenario({ passFrom: 1, options: { checkouts: () => [] } });
    expect(r.runs[0]).toEqual(["sh", "-c", "npm test 2>&1"]);
    expect(r.notices).toEqual(["Checks passed: `npm test`"]);
  });

  it("keep the end of a long output", () => {
    const out = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(tail(out).split("\n")).toHaveLength(60);
    expect(tail(out)).toMatch(/line 199$/);
    expect(tail("x".repeat(9000))).toHaveLength(4000);
  });

  it("mask the thread's secrets in what she is told, and say plainly when a check ran out of time", async () => {
    const masked = await scenario({ passFrom: 2, output: "FAIL: token sekret-token rejected\n" });
    const told = String(masked.told[0]!.content);
    expect(told).toContain("FAIL: token");
    expect(told).not.toContain("sekret-token");
    const slow = await scenario({ reject: "timeout:600" });
    expect(String(slow.told[0]!.content)).toContain("(stopped after 10 minutes)");
    expect(String(slow.told[0]!.content)).not.toContain("timeout:600");
  });
});
