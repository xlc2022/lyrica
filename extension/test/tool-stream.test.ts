import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { withModels } from "../../core/test/helpers.ts";
import { modelRuntimeFor } from "../src/models.ts";
import { MAX_REPLY_TOOL_CALLS } from "../src/tool-stream.ts";

async function setup() {
  const s = await withModels();
  const runtime = await modelRuntimeFor(s.models, s.models.callContext(s.ada.id, "private", "test"));
  return { ...s, runtime, model: runtime.getModel(s.gpu.id, "qwen3.8-27b")! };
}
const ask = { role: "user" as const, content: "Make an image.", timestamp: 0 };

describe("tool guards for OpenAI-compatible endpoints (principles 1 and 2)", () => {
  it("sends every tool's parameters as an object, as LM Studio requires", async () => {
    const s = await setup();
    s.local.reply({ text: "Done." });
    const loose = { name: "loose", description: "An MCP tool with a bare union", parameters: Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]) };
    const strict = { name: "strict", description: "Already an object", parameters: Type.Object({ a: Type.String() }) };
    await s.runtime.streamSimple(s.model, { messages: [ask], tools: [loose, strict] }).result();
    const sent = s.local.requests.at(-1)!.tools as unknown as { function: { name: string; parameters: { type?: string; anyOf?: unknown } } }[];
    expect(sent.map((t) => t.function.parameters.type)).toEqual(["object", "object"]);
    expect(sent[0]!.function.parameters.anyOf).toBeDefined();
  });

  it("stops a reply with a runaway of tool calls before any of them runs", async () => {
    const s = await setup();
    const calls = Array.from({ length: MAX_REPLY_TOOL_CALLS + 8 }, () => ({ name: "image", args: {} }));
    s.local.reply({ tools: calls });
    const message = await s.runtime.streamSimple(s.model, { messages: [ask] }).result();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(`more than ${MAX_REPLY_TOOL_CALLS} tool calls`);
    expect(message.content.some((b) => b.type === "toolCall")).toBe(false);
  });

  it("passes a reply with as many tool calls as allowed", async () => {
    const s = await setup();
    s.local.reply({ tools: Array.from({ length: MAX_REPLY_TOOL_CALLS }, (_, i) => ({ name: "read", args: { path: `f${i}` } })) });
    const message = await s.runtime.streamSimple(s.model, { messages: [ask] }).result();
    expect(message.stopReason).toBe("toolUse");
    expect(message.content.filter((b) => b.type === "toolCall")).toHaveLength(MAX_REPLY_TOOL_CALLS);
  });
});
