import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@lyrica/core";
import { CHECK_ROUNDS, CHECKS_FAILED, CHECKS_NOTICE, createChecksExtension, tail, type ChecksOptions } from "../src/checks.ts";
import { EVIDENCE_CONTINUE, EVIDENCE_NOTICE, EVIDENCE_ROUNDS, judgePrompt, parseVerdict, type EvidenceResult } from "../src/evidence.ts";

/**
 * She edits once, then says done after every message; the checks pass from round `passFrom` (never when 0).
 * `judge`: the evidence check's answers in turn (the last one again after that), each judged prompt kept in `judged`.
 */
async function scenario(o: { passFrom?: number; edit?: boolean; thinking?: boolean; options?: Partial<ChecksOptions>; output?: string; reject?: string; judge?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-checks-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "coder" }] });
  const runs: string[][] = [];
  const seen: string[] = [];
  let round = 0;
  const target = { secrets: () => ["sekret-token"], run: async (argv: string[]) => {
    if (argv[0] === "git") return { code: 0, stdout: Buffer.from("abc1234\n"), stderr: Buffer.alloc(0) };
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
  const judged: string[] = [];
  const judge = o.judge ? async (prompt: { system: string; user: string }) => { judged.push(prompt.user); return o.judge![Math.min(judged.length, o.judge!.length) - 1]!; } : undefined;
  const options: ChecksOptions = { checks: () => ["npm test"], code: () => true, plan: () => false, checkouts: () => ["/workspace/repos/game"], target: () => target,
    ...(judge ? { judge, codeTask: () => "Code task\nRender the track" } : {}), ...o.options };
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
      const entries = session.sessionManager.getEntries() as { type: string; customType?: string; content?: unknown; display?: boolean; details?: unknown }[];
      const notices = entries.filter((e) => e.type === "custom_message" && e.customType === CHECKS_NOTICE).map((e) => String(e.content));
      const told = entries.filter((e) => e.type === "custom_message" && e.customType === CHECKS_FAILED);
      const evidence = entries.filter((e) => e.type === "custom_message" && e.customType === EVIDENCE_NOTICE).map((e) => e.details as EvidenceResult);
      const asked = entries.filter((e) => e.type === "custom_message" && e.customType === EVIDENCE_CONTINUE).map((e) => String(e.content));
      return { runs, notices, told, seen, round, judged, evidence, asked };
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

  it(`stop after ${CHECK_ROUNDS} failing rounds, ask her to say plainly it isn't done, and report it for her parent`, async () => {
    const reports: string[] = [];
    const r = await scenario({ passFrom: 0, options: { exhausted: (report) => reports.push(report) } });
    expect(r.notices).toHaveLength(CHECK_ROUNDS);
    expect(r.seen[CHECK_ROUNDS]).toContain("still fail after 3 rounds");
    expect(r.round).toBe(CHECK_ROUNDS + 1);
    // Once, on the last round: which command failed, where, at which commit, and how.
    expect(reports).toEqual(["$ npm test (in /workspace/repos/game, at abc1234)\nFAIL track.test.ts\nexpected surface"]);
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

describe("the evidence check", () => {
  const notShown = '{"verdict":"continue","reason":"The test output shows FAIL track.test.ts, so the tests don\'t all pass.","next":"Fix the failing test and run npm test again."}';

  it("sends a reply the tool results don't bear out back to her, unseen, and shows it as not shown", async () => {
    const r = await scenario({ passFrom: 1, judge: [notShown, '{"verdict":"done"}'] });
    // The judge saw the request, the task, the write and its result, and her reply as a claim.
    expect(r.judged).toHaveLength(2);
    expect(r.judged[0]).toContain("<request>\nFix the track\n</request>");
    expect(r.judged[0]).toContain("<task>\nCode task\nRender the track\n</task>");
    expect(r.judged[0]).toContain('## Call 1: write {"path":"a.ts"}\nwritten');
    expect(r.judged[0]).toContain("<reply>\nDone: the track renders.\n</reply>");
    expect(r.evidence).toEqual([{ ok: false, reason: "The test output shows FAIL track.test.ts, so the tests don't all pass." }, { ok: true, reason: "The tool results bear the reply out." }]);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain("Next: Fix the failing test and run npm test again.");
    expect(r.asked[0]).toContain("judged again when you end your turn");
    // She saw it and answered again; the checks ran again on that reply.
    expect(r.seen[1]).toContain("isn't borne out");
    expect(r.round).toBe(2);
    expect(r.notices).toEqual(["Checks passed: `npm test`", "Checks passed: `npm test`"]);
  });

  it(`stops after ${EVIDENCE_ROUNDS} rounds, the last one asking her to say what is unverified, and runs without checks`, async () => {
    const other = '{"verdict":"continue","reason":"No screenshot was taken."}';
    const r = await scenario({ options: { checks: () => [] }, judge: [notShown, other, '{"verdict":"done"}'] });
    expect(r.runs).toEqual([]);
    expect(r.asked).toHaveLength(EVIDENCE_ROUNDS);
    expect(r.asked[1]).toContain("This is the last round");
    expect(r.evidence.map((e) => e.ok)).toEqual([false, false]);
    // Her third reply isn't judged again.
    expect(r.judged).toHaveLength(EVIDENCE_ROUNDS);
    expect(r.round).toBe(EVIDENCE_ROUNDS + 1);
  });

  it("ends the rounds when the same reason comes twice", async () => {
    const r = await scenario({ options: { checks: () => [] }, judge: [notShown] });
    expect(r.asked).toHaveLength(1);
    expect(r.evidence.map((e) => e.ok)).toEqual([false, false]);
    expect(r.round).toBe(2);
  });

  it("counts an answer it can't read, or a judge that fails, as done, and says so", async () => {
    const r = await scenario({ options: { checks: () => [] }, judge: ["I think it's fine."] });
    expect(r.evidence).toEqual([{ ok: true, reason: "The evidence check's answer couldn't be read, so the reply stands." }]);
    expect(r.asked).toEqual([]);
    const failed = await scenario({ options: { checks: () => [], judge: async () => { throw new Error("every model is away"); } } });
    expect(failed.evidence).toEqual([{ ok: true, reason: "The evidence check couldn't run (every model is away), so the reply stands." }]);
  });

  it("runs no judge without a file change, in Plan mode, or while the checks fail", async () => {
    for (const o of [{ edit: false }, { options: { plan: () => true } }, { passFrom: 0 }]) {
      const r = await scenario({ judge: [notShown], ...o });
      expect(r.judged).toEqual([]);
      expect(r.evidence).toEqual([]);
    }
  });

  it("reads a verdict out of an answer, and keeps the newest calls when there are many", () => {
    expect(parseVerdict('Sure: {"verdict":"continue","reason":"x","next":"y"} there')).toEqual({ verdict: "continue", reason: "x", next: "y" });
    expect(parseVerdict('{"verdict":"done"}')).toEqual({ verdict: "done", reason: "" });
    expect(parseVerdict('{"verdict":"maybe"}')).toBeUndefined();
    expect(parseVerdict("done")).toBeUndefined();
    const calls = Array.from({ length: 100 }, (_, i) => ({ name: "bash", args: { command: `echo ${i}` }, output: "x".repeat(3000), isError: i === 99 }));
    const { user } = judgePrompt({ request: "r", calls, reply: "done" });
    expect(user).toContain("## Call 100: bash");
    expect(user).toContain("(failed)");
    expect(user).not.toContain("## Call 20:");
    expect(user).toContain("(result left out for length)");
    expect(user.length).toBeLessThan(70_000);
  });
});
