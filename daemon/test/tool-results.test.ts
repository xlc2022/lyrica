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

it("keeps a failed command's last line under its cut output, so its row says why", () => {
  // A machine check whose last program wasn't there: the first lines, then the exit line.
  const text = ["=== uname ===", "Linux nautica", "=== os-release ===", 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"', 'NAME="Debian GNU/Linux"', 'VERSION_ID="13"', "=== docker ps ===", "bash: line 1: docker: command not found", "", "Command exited with code 127"].join("\n");
  const short = shortResult([{ type: "text", text }], "bash", true);
  expect(short).toBe(`${text.split("\n").slice(0, 6).join("\n")}…\nCommand exited with code 127`);
  expect(shortResult([{ type: "text", text }], "bash")).toBe(`${text.split("\n").slice(0, 6).join("\n")}…`);
});
