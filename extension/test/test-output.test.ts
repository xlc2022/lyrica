import { describe, expect, it } from "vitest";
import { TRIM_FROM, trimTestOutput } from "../src/test-output.ts";

describe("test output", () => {
  it("keeps a long run's failures and its last lines, and leaves out the passing ones", () => {
    const passing = Array.from({ length: 300 }, (_, i) => ` ✓ test/file${i}.test.ts (3 tests) 12ms`);
    const failure = [" FAIL  test/web.test.ts > the composer > keeps the draft", "AssertionError: expected 'a' to be 'b'", " ❯ test/web.test.ts:41:7"];
    const summary = Array.from({ length: 40 }, (_, i) => `summary ${i}`);
    const out = trimTestOutput([...passing.slice(0, 150), ...failure, ...passing.slice(150), ...summary, "Command exited with code 1"].join("\n"))!;
    expect(out).toContain("AssertionError: expected 'a' to be 'b'");
    expect(out).toContain(" ❯ test/web.test.ts:41:7");
    expect(out).toContain("Command exited with code 1");
    expect(out).toContain("summary 39");
    expect(out).not.toContain("file0.test.ts");
    expect(out.split("\n").length).toBeLessThan(80);
    expect(out.split("\n")[0]).toMatch(/^\[Test output trimmed: \d+ of 344 lines left out/);
  });
  it("leaves a short run whole", () => {
    expect(trimTestOutput(Array.from({ length: TRIM_FROM }, () => "ok").join("\n"))).toBeUndefined();
  });
});
