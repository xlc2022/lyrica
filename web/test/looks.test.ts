import { describe, expect, it } from "vitest";
import type { Message } from "../src/api.ts";
import { foldLooks, raisedIn, toldIn } from "../src/looks.ts";

const look = (id: string, from: Extract<Message["from"], { kind: "watching" }>): Message => ({ id, n: 1, createdAt: "", role: "user", from, parts: [{ type: "text", text: "In [t:a]: it posted an update." }] });
const turn = (id: string, ...texts: string[]): Message => ({
  id, n: 2, createdAt: "", role: "assistant",
  parts: texts.map((text, i) => ({ type: "tool" as const, toolCallId: `c${i}`, name: "threads", args: { action: "message", text }, threads: [{ pool: "general" as const, id: `t${i}` }] })),
});

describe("a look at the project's threads", () => {
  it("counts what it told from its own record, and leaves her next turn's messages as her own", () => {
    const l = look("l", { kind: "watching", told: [{ threadId: "a", text: "Add tulips." }, { threadId: "b", text: "Stop." }] });
    const { told, folded } = foldLooks([l, turn("t", "Another thing.")], "general");
    expect(told.get("l")).toEqual([
      { threads: [{ pool: "general", id: "a" }], text: "Add tulips." },
      { threads: [{ pool: "general", id: "b" }], text: "Stop." },
    ]);
    expect(folded.size).toBe(0);
  });

  it("shows no told when the look told no thread, even if her next turn messaged one", () => {
    const { told, folded } = foldLooks([look("l", { kind: "watching", told: [] }), turn("t", "Hello.")], "general");
    expect(told.get("l")).toEqual([]);
    expect(folded.size).toBe(0);
  });

  it("counts an older look by her next turn's messages, and folds that turn into it", () => {
    const { told, folded } = foldLooks([look("l", { kind: "watching" }), turn("t", "One.", "Two.")], "general");
    expect(told.get("l")?.map((t) => t.text)).toEqual(["One.", "Two."]);
    expect([...folded]).toEqual(["t"]);
  });

  it("reads the told and raised lines of a look's text", () => {
    const text = 'In [t:a]: it posted.\n\nTold [t:b]: "Say \\"hi\\"."\nRaised: "Is this right?"';
    expect(toldIn(text, "general")).toEqual([{ threads: [{ pool: "general", id: "b" }], text: 'Say "hi".' }]);
    expect(raisedIn(text)).toBe("Is this right?");
    expect(raisedIn("In [t:a]: it posted.\n\nTold no thread.")).toBeUndefined();
  });
});
