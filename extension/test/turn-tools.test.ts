import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createTurnToolsExtension, MAX_TURN_TOOL_CALLS, TURN_TOOL_NOTICE, WRAP_UP } from "../src/turn-tools.ts";
import { createImageExtension, type ImageTools } from "../src/images.ts";
import { toMessages } from "../../daemon/src/messages.ts";

async function scenario(calls: { name: string; args: JsonObject }[], prompts = 1, batch = false) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-tool-limit-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "loop" }] });
  let executed = 0, requested = 0;
  const results: string[] = [];
  const asked: string[] = [];
  /** The tools she's offered now: the transcript declares them on system messages. */
  const offered = (ctx: { messages: unknown[] }) => {
    const on = new Set<string>();
    for (const m of ctx.messages as { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[]) {
      if (m.role !== "system") continue;
      for (const t of m.toolsAdded ?? []) on.add(t.name);
      for (const t of m.toolsRemoved ?? []) on.delete(typeof t === "string" ? t : (t as { name: string }).name);
    }
    return on.size;
  };
  /** Past the cap her tools are off, and she writes where things stand. */
  const wrapUp = (ctx: { messages: unknown[] }) => (offered(ctx) ? undefined : (asked.push(JSON.stringify(ctx.messages.slice(-3))), fauxAssistantMessage("Stopped at the limit: half done.")));
  const responses = calls.map(c => (ctx: { messages: unknown[] }) => { requested++; return wrapUp(ctx) ?? fauxAssistantMessage(fauxToolCall(c.name, c.args), { stopReason: "toolUse" }); }).concat([() => { requested++; return fauxAssistantMessage("Done"); }]);
  faux.setResponses(batch ? [() => { requested++; return fauxAssistantMessage(calls.map(c => fauxToolCall(c.name, c.args)), { stopReason: "toolUse" }); }, (ctx: { messages: unknown[] }) => { requested++; return wrapUp(ctx) ?? fauxAssistantMessage("tools still on"); }] : responses);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [createTurnToolsExtension(), pi => {
      pi.registerProvider(faux.provider);
      for (const name of ["search", "other"]) pi.registerTool({ name, label: name, description: name,
        parameters: Type.Object({ query: Type.String(), nested: Type.Optional(Type.Object({ a: Type.Number(), b: Type.Number() })) }),
        execute: async () => { executed++; return { content: [{ type: "text", text: "result" }], details: {} }; } });
    }, createImageExtension({ enabled: () => { executed++; throw new Error("must not execute"); } } as unknown as ImageTools)] });
  try {
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" });
    try {
      await session.bindExtensions({});
      await session.setModel(faux.getModel());
      session.subscribe(e => { if (e.type === "tool_execution_end") results.push(JSON.stringify(e.result)); });
      for (let n = 0; n < prompts; n++) await session.prompt("Use tools");
      const entries = session.sessionManager.getEntries();
      const notices = entries.filter(e => e.type === "custom_message" && e.customType === TURN_TOOL_NOTICE);
      const shown = toMessages("test", "general", entries.map((data, n) => ({ data, n, createdAt: "2026-10-12" })));
      return { executed, requested, results, notices, shown, asked };
    } finally { session.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("ends a looping model at the per-turn cap, shows the notice, and lets her say where things stand", async () => {
  const r = await scenario(Array.from({ length: 110 }, (_, i) => ({ name: i % 2 ? "search" : "other", args: { query: String(i) } })));
  expect(r.executed).toBe(MAX_TURN_TOOL_CALLS);
  // One more request, with no tools, for her reply.
  expect(r.requested).toBe(MAX_TURN_TOOL_CALLS + 1);
  expect(r.asked).toHaveLength(1);
  expect(r.asked[0]).toContain(WRAP_UP);
  expect(r.notices).toHaveLength(1);
  const shown = JSON.stringify(r.shown);
  expect(shown).toContain("Turn stopped after `100` tool calls.");
  expect(shown).toContain("Stopped at the limit: half done.");
  expect(shown).not.toContain(WRAP_UP);
});

it("refuses the third identical call despite different object key order", async () => {
  const r = await scenario([
    { name: "search", args: { query: "same", nested: { a: 1, b: 2 } } },
    { name: "search", args: { nested: { b: 2, a: 1 }, query: "same" } },
    { name: "search", args: { query: "same", nested: { a: 1, b: 2 } } },
  ]);
  expect(r.executed).toBe(2);
  expect(r.results[2]).toContain("already have this result");
  expect(r.requested).toBe(4);
  expect(r.notices).toHaveLength(0);
});

it("ends after 25 consecutive calls to the same tool with changing arguments", async () => {
  const r = await scenario(Array.from({ length: 30 }, (_, i) => ({ name: "search", args: { query: String(i) } })));
  expect(r.executed).toBe(25);
  expect(r.requested).toBe(26);
  expect(JSON.stringify(r.shown)).toContain("Turn stopped after `25` calls in a row to `search`.");
});

it("validates missing required fields before executing", async () => {
  const r = await scenario([{ name: "image", args: {} }]);
  expect(r.executed).toBe(0);
  expect(r.results[0]).toContain('Validation failed for tool');
  expect(r.results[0]).toContain("action");
});


it("blocks calls past the cap within a single batch", async () => {
  const r = await scenario(Array.from({ length: 110 }, (_, i) => ({ name: i % 2 ? "search" : "other", args: { query: String(i) } })), 1, true);
  expect(r.executed).toBe(100);
  expect(r.requested).toBe(2);
  expect(r.asked).toHaveLength(1);
  expect(r.notices).toHaveLength(1);
});

it("resets the budget on the next prompt", async () => {
  // The 26th response is her wrap-up; the 27th call runs on the next prompt.
  const r = await scenario(Array.from({ length: 27 }, (_, i) => ({ name: "search", args: { query: String(i) } })), 2);
  expect(r.executed).toBe(26);
  expect(r.notices).toHaveLength(1);
  expect(r.requested).toBe(28);
});
