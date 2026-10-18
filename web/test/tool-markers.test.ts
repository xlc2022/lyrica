import { describe, expect, it } from "vitest";
import { summarizeArgs } from "../src/Messages.tsx";

describe("a tool call's marker line", () => {
  it("is empty for a call she is still writing, and the main argument once it runs", () => {
    expect(summarizeArgs({})).toBe("");
    expect(summarizeArgs({ machine: "nas" })).toBe("");
    expect(summarizeArgs({ command: "ls -la\nmore" })).toBe("ls -la");
    expect(summarizeArgs({ action: "start", vm: "101" })).toBe("start 101");
  });
});
