import { describe, expect, it } from "vitest";
import { cleanAsk, cleanSteps, normalizeThreadArguments } from "../src/threads.ts";
const ask = { question: "Which?", options: [{ label: "Keep", consequence: "Keeps it." }, { label: "Remove", consequence: "Removes it." }], recommended: 0 };
describe("thread arguments", () => {
  it("repairs only the listed unambiguous shapes", () => {
    expect(cleanAsk({ ...ask, options: JSON.stringify(ask.options), recommended: "KEEP" })).toEqual(ask);
    for (const [state, expected] of Object.entries({ in_progress: "doing", "in progress": "doing", active: "doing", started: "doing", pending: "todo", "not started": "todo", complete: "done", completed: "done", finished: "done" })) {
      expect(cleanSteps(JSON.stringify([{ text: "Check", state: state.toUpperCase() }]))).toEqual([{ text: "Check", state: expected }]);
    }
    expect(cleanSteps(["Check"])).toEqual([{ text: "Check", state: "todo" }]);
    expect(normalizeThreadArguments({ options: "{}" })).toEqual({ options: "{}" });
  });
  it("names fields and positions, never echoes input text, and includes a valid shape", () => {
    const cases: [string, () => unknown][] = [
      ["question", () => cleanAsk({ ...ask, question: "" })],
      ["options", () => cleanAsk({ ...ask, options: "secret" })],
      ["options[1]", () => cleanAsk({ ...ask, options: [ask.options[0], "secret"] })],
      ["options[1].label", () => cleanAsk({ ...ask, options: [ask.options[0], { label: 7 }] })],
      ["options[1].consequence", () => cleanAsk({ ...ask, options: [ask.options[0], { label: "Other" }] })],
      ["options[1].label", () => cleanAsk({ ...ask, options: [ask.options[0], ask.options[0]] })],
      ["recommended", () => cleanAsk({ ...ask, recommended: "secret" })],
      ["context", () => cleanAsk({ ...ask, context: 7 })],
      ["steps", () => cleanSteps("secret")],
      ["steps[0]", () => cleanSteps([null])],
      ["steps[0].text", () => cleanSteps([{ text: null, state: "todo" }])],
      ["steps[0].state", () => cleanSteps([{ text: "Check", state: "secret" }])],
      ["steps", () => cleanSteps(Array(13).fill("Check"))],
    ];
    for (const [field, run] of cases) {
      try { run(); throw new Error("Expected refusal"); } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain(field); expect(message).toContain("received"); expect(message).toContain("Example: threads("); expect(message).not.toContain("secret");
      }
    }
  });
});
