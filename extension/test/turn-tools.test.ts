import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { CALL_THE_TOOL, CARRY_ON, createTurnToolsExtension, EMPTY_REPLY, TEXT_TOOL_CALL, MAX_TURN_TOOL_CALLS, TURN_TOOL_NOTICE, WRAP_UP } from "../src/turn-tools.ts";
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
      for (const name of ["search", "other", "threads", "bash"]) pi.registerTool({ name, label: name, description: name,
        parameters: Type.Object({ query: Type.Optional(Type.String()), command: Type.Optional(Type.String()), nested: Type.Optional(Type.Object({ a: Type.Number(), b: Type.Number() })) }),
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

it("refuses a third identical threads read by saying the thread's end wakes her", async () => {
  const read = { name: "threads", args: { query: "t:seeds", action: "read" } };
  const r = await scenario([read, read, read]);
  expect(r.executed).toBe(2);
  expect(r.results[2]).toContain("You already read this thread twice");
  expect(r.results[2]).toContain("wakes this thread, so you can end your turn now");
});

it("lets a plain sleep repeat, and a call made again after one, since time has passed, but not a repeat with no sleep between", async () => {
  const sleep = { name: "bash", args: { command: "sleep 60" } };
  const cat = { name: "bash", args: { command: "cat package.json" } };
  expect((await scenario([sleep, sleep, sleep, sleep])).executed).toBe(4);
  expect((await scenario([sleep, cat, sleep, cat, sleep, cat, sleep, cat])).executed).toBe(8);
  expect((await scenario([cat, cat, cat])).executed).toBe(2);
  const status = { name: "bash", args: { command: "sleep 60 && git status" } };
  expect((await scenario([status, status, status])).executed).toBe(2);
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

/** Her replies, in order, to one prompt: what each request asked and what the thread shows. */
async function replies(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-empty-reply-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "think", reasoning: true }] });
  const asked: string[] = [];
  /** The thinking level each request went with. */
  const levels: string[] = [];
  let level = () => "";
  faux.setResponses(responses.map((r) => (ctx: { messages: unknown[] }) => { asked.push(JSON.stringify(ctx.messages)); levels.push(level()); return r; }));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [createTurnToolsExtension(), pi => {
      pi.registerProvider(faux.provider);
      level = () => pi.getThinkingLevel();
    }] });
  try {
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" });
    try {
      await session.bindExtensions({});
      await session.setModel(faux.getModel());
      session.setThinkingLevel("medium");
      await session.prompt("Build the terrain");
      const entries = session.sessionManager.getEntries();
      return { asked, levels, after: session.thinkingLevel, shown: toMessages("test", "general", entries.map((data, n) => ({ data, n, createdAt: "2026-10-20" }))) };
    } finally { session.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("asks her once to carry on after a reply with only thinking", async () => {
  const r = await replies([fauxAssistantMessage(fauxThinking("I'll write the terrain module next.")), fauxAssistantMessage("Terrain done.")]);
  expect(r.asked).toHaveLength(2);
  expect(r.asked[1]).toContain(CARRY_ON);
  const shown = JSON.stringify(r.shown);
  expect(shown).toContain("Terrain done.");
  expect(shown).not.toContain(CARRY_ON);
  expect(r.shown.some((m) => m.error)).toBe(false);
});

it("retries without thinking after thinking that ran to the reply limit, then thinks as before", async () => {
  const r = await replies([fauxAssistantMessage(fauxThinking("Planning the scaffold at length."), { stopReason: "length" }), fauxAssistantMessage("Scaffold written.")]);
  expect(r.asked).toHaveLength(2);
  expect(r.levels).toEqual(["medium", "off"]);
  expect(r.after).toBe("medium");
  expect(JSON.stringify(r.shown)).toContain("Scaffold written.");
});

it("keeps thinking on for the retry when the reply stopped on its own", async () => {
  const r = await replies([fauxAssistantMessage(fauxThinking("I'll write the terrain module next.")), fauxAssistantMessage("Terrain done.")]);
  expect(r.levels).toEqual(["medium", "medium"]);
});

it("fails the turn visibly when the retry has only thinking too", async () => {
  const r = await replies([fauxAssistantMessage(fauxThinking("Planning.")), fauxAssistantMessage(fauxThinking("Still planning.")), fauxAssistantMessage("never asked")]);
  expect(r.asked).toHaveLength(2);
  expect(r.shown.at(-1)).toMatchObject({ role: "assistant", error: EMPTY_REPLY });
});

const AS_TEXT = "Merging now.\n<tool_call>\n<function=bash>\n<parameter=command>\ngit merge main\n</parameter>\n</function>\n</tool_call>";

it("asks her once to make a tool call she wrote as text, instead of ending the turn", async () => {
  const r = await replies([fauxAssistantMessage(AS_TEXT), fauxAssistantMessage("Merged.")]);
  expect(r.asked).toHaveLength(2);
  expect(r.asked[1]).toContain(CALL_THE_TOOL);
  const shown = JSON.stringify(r.shown);
  expect(shown).toContain("Merged.");
  expect(shown).not.toContain(CALL_THE_TOOL);
  expect(r.shown.some((m) => m.error)).toBe(false);
});

it.each([
  ["GLM's arg_key and arg_value, closed", "Checking.\n<tool_call>bash\n<arg_key>command</arg_key>\n<arg_value>git status</arg_value>\n</tool_call>"],
  ["GLM's arg_key and arg_value, cut off", "Checking.\n<tool_call>bash<arg_key>command</arg_key><arg_value>npm test"],
  ["GLM's arg_key and arg_value, unwrapped", "Checking.\nbash<arg_key>command</arg_key><arg_value>ls</arg_value>"],
  ["Hermes' JSON, cut off", 'Checking.\n<tool_call>\n{"name": "bash", "arguments": {"command": "ls"'],
  ["Qwen's function, cut off in its tool_call", "Checking.\n<tool_call>\n<function=bash>\n<parameter=command>\nls"],
  ["a bare function, cut off", "Checking.\n<function=bash>\n<parameter=command>\nls"],
])("counts %s as a call written as text", async (_name, text) => {
  const r = await replies([fauxAssistantMessage(text), fauxAssistantMessage("Done.")]);
  expect(r.asked).toHaveLength(2);
  expect(r.asked[1]).toContain(CALL_THE_TOOL);
});

it("asks once about a call written as text after her thinking, in the shape one server sent", async () => {
  const text = "<tool_call> <function=bash> <parameter=command> cd /workspace/repos/lyrica && git status </tool_call>";
  const r = await replies([fauxAssistantMessage([fauxThinking("Check the status first."), { type: "text", text }]), fauxAssistantMessage("Clean.")]);
  expect(r.asked).toHaveLength(2);
  expect(r.asked[1]).toContain(CALL_THE_TOOL);
});

it("fails the turn visibly when the retry writes its call as text too, and leaves ordinary replies alone", async () => {
  const twice = await replies([fauxAssistantMessage(AS_TEXT), fauxAssistantMessage(AS_TEXT)]);
  expect(twice.asked).toHaveLength(2);
  expect(JSON.stringify(twice.shown)).toContain(TEXT_TOOL_CALL);
  const plain = await replies([fauxAssistantMessage("Use `<tool_call>` tags only when the model needs them.")]);
  expect(plain.asked).toHaveLength(1);
  // A tag named in prose, with no call after it, is text too.
  const prose = await replies([fauxAssistantMessage("Some servers leave a <tool_call> tag in the reply.")]);
  expect(prose.asked).toHaveLength(1);
  // A call she quotes in code is her answer, not a call.
  const quoted = await replies([fauxAssistantMessage(`The leak looks like this:\n\n\`\`\`\n${AS_TEXT}\n\`\`\`\n\nand \`<function=x><parameter=a>1</parameter></function>\` inline.`)]);
  expect(quoted.asked).toHaveLength(1);
  expect(quoted.shown.some((m) => m.error)).toBe(false);
});
