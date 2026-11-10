import { describe, expect, it } from "vitest";
import { callLine, tokens } from "../src/CallStats.tsx";

describe("the request's counts in place of the dots", () => {
  it("says tokens whole below 10,000, then in thousands", () => {
    expect([tokens(812), tokens(9_999), tokens(48_213), tokens(131_072)]).toEqual(["812", "9,999", "48.2k", "131k"]);
  });

  it("shows llama.cpp's read of the new tokens, then what it writes", () => {
    const reading = callLine({ ms: 3_000, prompt: 48_213, cached: 46_001, read: 1_340, readRate: 1_840 }, 3)!;
    expect(reading.text).toBe("Reading 1,340 of 2,212 new · 1,840 tok/s");
    expect(reading.tip).toContain("48.2k prompt tokens, 46.0k from cache");
    expect(callLine({ ms: 9_000, prompt: 48_213, cached: 46_001, read: 2_212, output: 412, outputRate: 38.4, writing: "thinking" }, 9)!.text)
      .toBe("Thinking · 412 tokens · 38.4 tok/s");
  });

  it("falls back to the prompt's estimate and a clock, then a counted output, on a server that says nothing", () => {
    expect(callLine({ ms: 12_000, prompt: 48_213 }, 12)!.text).toBe("Prompt 48.2k · 12 s");
    const counted = callLine({ ms: 15_000, prompt: 48_213, output: 412, counted: true, writing: "tool" }, 15)!;
    expect(counted.text).toBe("Writing a tool call · ≈412 tokens");
    expect(counted.tip).toContain("counted from the text");
  });

  it("leaves the dots while nothing is known", () => {
    expect(callLine({ ms: 100 }, 0)).toBeUndefined();
  });
});
