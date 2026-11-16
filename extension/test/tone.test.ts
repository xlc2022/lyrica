import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { liftTones, MAX_TONE, ToneScanner, type ToneNote } from "../src/tone.ts";

function scan(chunks: string[]) {
  const notes: ToneNote[] = [];
  const s = new ToneScanner((at, note) => notes.push({ at, note }));
  const text = chunks.map((c) => s.push(c)).join("") + s.finish();
  return { text, notes };
}

describe("tone notes lifted out of her reply", () => {
  const reply = "<tone>gently amused</tone>\nHa, that is funny.\n\n<tone>quiet and tender</tone> I missed you. a < b <to be sure>.";
  const want = { text: "Ha, that is funny.\n\nI missed you. a < b <to be sure>.", notes: [{ at: 0, note: "gently amused" }, { at: 20, note: "quiet and tender" }] };

  it("never lets a tag through, whole or split at any point across chunks", () => {
    expect(scan([reply])).toEqual(want);
    for (let i = 1; i < reply.length; i++) {
      for (let j = i; j < reply.length; j += 7) expect(scan([reply.slice(0, i), reply.slice(i, j), reply.slice(j)]), `${i}/${j}`).toEqual(want);
    }
    // One character at a time.
    expect(scan([...reply])).toEqual(want);
  });

  it("keeps a paragraph break when a note ends one, drops a tag left half-written, and leaves a long one as written", () => {
    expect(scan(["Done.<tone>bright</tone>\n\nNext."])).toEqual({ text: "Done.\n\nNext.", notes: [{ at: 5, note: "bright" }] });
    expect(scan(["Hello.", "<tone>sa"])).toEqual({ text: "Hello.", notes: [] });
    const long = `<tone>${"x".repeat(MAX_TONE + 10)}</tone> after`;
    expect(scan([long])).toEqual({ text: long, notes: [] });
  });

  it("reads crafted text in linear time", () => {
    for (const unit of ["<tone>", "<tone>x</tone>", "<ton", `<tone>${"y".repeat(MAX_TONE)}`]) {
      const crafted = unit.repeat(Math.ceil(65536 / unit.length));
      const started = performance.now();
      scan([crafted]);
      scan(crafted.match(/[\s\S]{1,7}/g)!);
      expect(performance.now() - started, unit).toBeLessThan(500);
    }
  });

  it("lifts tags out of every event and the final message, and keeps the notes by the message Pi stores", async () => {
    const source = createAssistantMessageEventStream();
    const base: AssistantMessage = { role: "assistant", content: [], api: "openai-completions", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
    let text = "";
    const partial = () => ({ ...base, content: [{ type: "text" as const, text }] });
    const notes: ToneNote[] = [];
    let stored: AssistantMessage | undefined;
    const out = liftTones(source, notes, (m) => { stored = m; });
    source.push({ type: "start", partial: { ...base } });
    source.push({ type: "text_start", contentIndex: 0, partial: partial() });
    for (const delta of ["<to", "ne>warm</to", "ne>Hi there."]) { text += delta; source.push({ type: "text_delta", contentIndex: 0, delta, partial: partial() }); }
    source.push({ type: "text_end", contentIndex: 0, content: text, partial: partial() });
    source.push({ type: "done", reason: "stop", message: partial() });
    source.end();
    const seen: string[] = [];
    for await (const e of out) seen.push(JSON.stringify(e));
    expect(seen.join("\n")).not.toMatch(/warm|<to/);
    const message = await out.result();
    expect(message.content).toEqual([{ type: "text", text: "Hi there." }]);
    expect(notes).toEqual([{ at: 0, note: "warm" }]);
    expect(stored).toBe(message);
  });
});
