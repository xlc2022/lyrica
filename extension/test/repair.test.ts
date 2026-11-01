import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createRepairExtension, parsedArguments } from "../src/repair.ts";

/** One reply making `calls`; each tool records what it ran with, and `results` is what she was told back. */
async function scenario(calls: { name: string; args: JsonObject }[]) {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-repair-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "small" }] });
  const ran: { name: string; args: unknown }[] = [];
  const results: string[] = [];
  faux.setResponses([() => fauxAssistantMessage(calls.map((c) => fauxToolCall(c.name, c.args)), { stopReason: "toolUse" }), () => fauxAssistantMessage("Done")]);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true,
    extensionFactories: [createRepairExtension(), (pi) => {
      pi.registerProvider(faux.provider);
      const tool = (name: string, parameters: ReturnType<typeof Type.Object>) => pi.registerTool({ name, label: name, description: name, parameters,
        execute: async (_id, args) => { ran.push({ name, args }); return { content: [{ type: "text", text: `${name} ok` }], details: {} }; } });
      tool("read", Type.Object({ path: Type.String() }));
      tool("edit", Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) }));
      tool("bash", Type.Object({ command: Type.String(), env: Type.Optional(Type.Object({}, { additionalProperties: Type.String() })) }));
    }] });
  try {
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: "builtin" });
    try {
      await session.bindExtensions({});
      await session.setModel(faux.getModel());
      await session.prompt("go");
      // What she was told back, as the conversation records it.
      for (const m of session.messages) if (m.role === "toolResult") results.push(`${m.toolName}: ${m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ")}`);
      return { ran, results };
    } finally { session.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("tool-call repair", () => {
  it("parses an object or array sent as a JSON string, and leaves the rest alone", () => {
    const parameters = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({})), env: Type.Optional(Type.Object({})), note: Type.String() });
    const edits = [{ oldText: "a", newText: "b" }];
    expect(parsedArguments({ path: "x", edits: JSON.stringify(edits), env: '{"A":"1"}', note: '{"kept":true}' }, parameters))
      .toEqual({ path: "x", edits, env: { A: "1" }, note: '{"kept":true}' });
    // A string that parses to the wrong shape, or not at all, is left for validation to describe.
    expect(parsedArguments({ path: "x", edits: '{"oldText":"a"}' }, parameters)).toEqual({ path: "x", edits: '{"oldText":"a"}' });
    expect(parsedArguments({ path: "x", edits: "[not json" }, parameters)).toEqual({ path: "x", edits: "[not json" });
    const same = { path: "x", edits };
    expect(parsedArguments(same, parameters)).toBe(same);
  });

  it("applies an edit whose edits came as a JSON string", async () => {
    const edits = [{ oldText: "a", newText: "b" }];
    const r = await scenario([{ name: "edit", args: { path: "x.ts", edits: JSON.stringify(edits) } }]);
    expect(r.ran).toEqual([{ name: "edit", args: { path: "x.ts", edits } }]);
    expect(r.results).toEqual(["edit: edit ok"]);
  });

  it("runs a tool named as another harness names it, and says so; a name nothing matches lists her tools", async () => {
    const r = await scenario([{ name: "read_file", args: { path: "a.ts" } }, { name: "run_command", args: { command: "ls", env: '{"A":"1"}' } }, { name: "grep_files", args: { path: "." } }]);
    expect(r.ran).toEqual([{ name: "read", args: { path: "a.ts" } }, { name: "bash", args: { command: "ls", env: { A: "1" } } }]);
    expect(r.results).toEqual([
      "read: read ok There is no read_file tool, so this ran as read. Call read next time.",
      "bash: bash ok There is no run_command tool, so this ran as bash. Call bash next time.",
      "grep_files: There is no grep_files tool. Your tools: read, edit, bash.",
    ]);
  });
});
