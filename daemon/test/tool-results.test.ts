import { expect, it } from "vitest";
import { shortResult } from "../src/messages.ts";

it("keeps a tool's first lines, and more of a read so its card can show the file", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `    line ${i}`).join("\n");
  const content = [{ type: "text", text: lines }];
  expect(shortResult(content, "bash")).toBe(`${lines.split("\n").slice(0, 6).join("\n")}…`);
  const read = shortResult(content, "read");
  expect(read).toBe(`${lines.split("\n").slice(0, 60).join("\n")}…`);
  expect(read.startsWith("    line 0\n    line 1")).toBe(true);
  expect(shortResult([{ type: "text", text: "x".repeat(7000) }], "read")).toHaveLength(6001);
});
