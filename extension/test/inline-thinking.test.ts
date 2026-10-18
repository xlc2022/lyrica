import { describe, expect, it } from "vitest";
import { normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { withModels } from "../../core/test/helpers.ts";
import { streamWithInlineThinking } from "../src/inline-thinking.ts";
import { modelRuntimeFor, startsMidThought } from "../src/models.ts";

async function setup(reasoning = false) {
  const s = await withModels();
  if (reasoning) s.models.setCapabilities(s.ada, s.localRef.offeringId, { reasoning: ["low", "high"] });
  const runtime = await modelRuntimeFor(s.models, s.models.callContext(s.ada.id, "private", "test"));
  const model = runtime.getModel(s.gpu.id, "qwen3.8-27b")!;
  return { ...s, runtime, model };
}
const context = { messages: [{ role: "user" as const, content: "Tell a tale.", timestamp: 0 }] };
async function collect(stream: ReturnType<typeof streamSimple>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}
function parts(events: AssistantMessageEvent[]) {
  return events.filter((e) => e.type === "text_delta" || e.type === "thinking_delta").map((e) => ({ type: e.type, index: e.contentIndex, delta: e.delta }));
}

describe("inline thinking in the Pi runtime", () => {
  it("leaves dedicated reasoning and plain replies byte-identical to Pi", async () => {
    for (const reasoning of [false, true]) {
      const s = await setup(reasoning);
      for (const deltas of [[{ content: "Ada sails." }, { content: " The sea is calm." }], [{ reasoning_content: "Consider the tide." }, { content: "Ada sails." }]]) {
        s.local.reply({ deltas }, { deltas });
        const native = await collect(streamSimple(s.model as never, normalizeContext(context), { apiKey: "none" }));
        const wrapped = await collect(s.runtime.streamSimple(s.model, context));
        const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => ["timestamp", "durationMs"].includes(key) ? undefined : v));
        expect(stable(wrapped)).toEqual(stable(native));
        if ("reasoning_content" in deltas[0]!) {
          expect(wrapped.message.content).toMatchObject([{ type: "thinking", thinking: "Consider the tide." }, { type: "text", text: "Ada sails." }]);
          expect(parts(wrapped.events)).toEqual([{ type: "thinking_delta", index: 0, delta: "Consider the tide." }, { type: "text_delta", index: 1, delta: "Ada sails." }]);
        }
      }
    }
  });

  it("streams a reasoning model's plain reply live with thinking off", async () => {
    const s = await setup(true);
    s.local.reply({ text: "Ada sails.", slowMs: 200 });
    const stream = s.runtime.streamSimple(s.model, context);
    let firstText: string | undefined;
    for await (const event of stream) {
      if (event.type === "text_delta" && firstText === undefined) {
        const block = event.partial.content[event.contentIndex]!;
        firstText = block.type === "text" ? block.text : undefined;
      }
    }
    // If held until text_end, the first event's partial already contains the whole reply.
    expect(firstText).toBe("Ada");
    expect((await stream.result()).content).toEqual([{ type: "text", text: "Ada sails." }]);
  });

  it.each([false, true])("splits tags across chunks and keeps indices and final blocks aligned (reasoning=%s)", async (reasoning) => {
    const s = await setup(reasoning);
    s.local.reply({ deltas: ["<th", "ink>Consider", " the tide.</th", "ink>\n", "  Ada sails."].map((content) => ({ content })) });
    const result = await collect(s.runtime.streamSimple(s.model, context));
    expect(result.message.content).toEqual([{ type: "thinking", thinking: "Consider the tide." }, { type: "text", text: "Ada sails." }]);
    expect(parts(result.events)).toEqual([
      { type: "thinking_delta", index: 0, delta: "Consider" },
      { type: "thinking_delta", index: 0, delta: " the tide." },
      { type: "text_delta", index: 1, delta: "Ada sails." },
    ]);
    expect(result.events.filter((e) => e.type.endsWith("_start") || e.type.endsWith("_end")).map((e) => e.type)).toEqual(["thinking_start", "thinking_end", "text_start", "text_end"]);
  });

  it("streams a plain reply live with thinking on when the template doesn't open the tag", async () => {
    const s = await setup(true);
    s.local.reply({ text: "Ada sails.", slowMs: 200 });
    const stream = s.runtime.streamSimple(s.model, context, { reasoning: "low" });
    let firstText: string | undefined;
    for await (const event of stream) {
      if (event.type === "text_delta" && firstText === undefined) {
        const block = event.partial.content[event.contentIndex]!;
        firstText = block.type === "text" ? block.text : undefined;
      }
    }
    expect(firstText).toBe("Ada");
  });

  it("holds for a mid-thought start only where the template opens the tag", () => {
    const o = { opensThinking: true } as never;
    expect(startsMidThought(o, undefined)).toBe(true);
    expect(startsMidThought({ opensThinking: true, reasoning: ["medium"] } as never, "off")).toBe(false);
    expect(startsMidThought({ opensThinking: true, reasoning: ["medium"] } as never, "medium")).toBe(true);
    expect(startsMidThought({ reasoning: ["medium"] } as never, "high")).toBe(false);
  });

  it("puts an R1-style reply with only </think> in the reasoning marker, with no thinking requested", async () => {
    const s = await setup();
    s.local.reply({ deltas: ["Consider", " the tide.</th", "ink>\n Ada sails."].map((content) => ({ content })) });
    const result = await collect(streamWithInlineThinking(s.model as never, normalizeContext(context), { apiKey: "none" }, true));
    expect(result.message.content).toEqual([{ type: "thinking", thinking: "Consider the tide." }, { type: "text", text: "Ada sails." }]);
    expect(parts(result.events)).toEqual([{ type: "thinking_delta", index: 0, delta: "Consider the tide." }, { type: "text_delta", index: 1, delta: "Ada sails." }]);
  });

  it("releases held text when the server's own reasoning starts late", async () => {
    const s = await setup();
    s.local.reply({ deltas: [{ content: "\n" }, { reasoning_content: "Consider the tide." }, { content: "Ada sails." }] });
    const result = await collect(streamWithInlineThinking(s.model as never, normalizeContext(context), { apiKey: "none" }, true));
    expect(result.message.content.filter((b) => b.type === "thinking")).toMatchObject([{ thinking: "Consider the tide." }]);
    expect(result.message.content.filter((b) => b.type === "text").map((b) => b.type === "text" && b.text).join("")).toBe("\nAda sails.");
    for (const [index, block] of result.message.content.entries()) {
      const deltas = parts(result.events).filter((e) => e.index === index).map((e) => e.delta).join("");
      expect(deltas).toBe(block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "");
    }
  });

  it("flushes an unfinished tag as text and preserves text before explicit thinking", async () => {
    const s = await setup();
    s.local.reply({ deltas: ["Ada ", "sails.<thi", "nk>Tide</think>\n", "Calm<thi"].map((content) => ({ content })) });
    const result = await collect(s.runtime.streamSimple(s.model, context));
    expect(result.message.content).toEqual([{ type: "text", text: "Ada sails." }, { type: "thinking", thinking: "Tide" }, { type: "text", text: "Calm<thi" }]);
    for (const [index, block] of result.message.content.entries()) {
      const deltas = parts(result.events).filter((e) => e.index === index).map((e) => e.delta).join("");
      expect(deltas).toBe(block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "");
    }
  });
});
