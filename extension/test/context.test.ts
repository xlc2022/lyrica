import { describe, expect, it } from "vitest";
import { speeds } from "@lyrica/core";
import { ContextMeter, contextLines, keepRecentFor, prepareLine, reserveFor, statusLine, type Section } from "../src/index.ts";

const section = (name: Section["name"], chars: number): Section => ({ name, text: "x".repeat(chars), budget: chars, truncated: false, place: "system" });

/** A meter that has measured one turn of `tokens` in a `window`. */
function measured(tokens: number, window = 32_768) {
  const meter = new ContextMeter();
  meter.setPrompt([section("persona", 4000), section("topics", 2000), section("about", 1200), section("wake", 800), section("recall", 1600), section("time", 60)], 3000);
  meter.measure(tokens, window, 5000, speeds({ promptTokens: tokens, outputTokens: 380, window, ttftMs: 2000, genMs: 10_000, processed: 4200 }));
  return meter;
}

describe("the context breakdown", () => {
  it("scales the estimated parts to the measured total, then adds the reserve and free space to fill the window", () => {
    for (const tokens of [3000, 9000, 20_001]) {
      const r = measured(tokens).report()!;
      const used = r.parts.filter((p) => p.name !== "reserve" && p.name !== "free").reduce((a, p) => a + p.tokens, 0);
      expect(used).toBe(tokens);
      expect(r.parts.reduce((a, p) => a + p.tokens, 0)).toBe(r.window);
      expect(r.parts.map((p) => p.name)).toEqual(["persona", "about", "memory", "pinned", "recall", "tools", "conversation", "reserve", "free"]);
      expect(r.parts.find((p) => p.name === "pinned")!.tokens).toBe(0);
    }
    const r = measured(9000).report()!;
    expect(r).toMatchObject({ tokens: 9000, window: 32_768, percent: 27, reserve: reserveFor(32_768), free: 32_768 - 9000 - reserveFor(32_768) });
    // Persona and topics outweigh the page about the user, as their sizes say.
    const part = (n: string) => r.parts.find((p) => p.name === n)!.tokens;
    expect(part("persona")).toBeGreaterThan(part("about"));
  });

  it("puts Pi's own compaction past the 90% line, and keeps a quarter of the window", () => {
    expect(reserveFor(32_768) / 32_768).toBeCloseTo(0.08, 2);
    expect(reserveFor(1_000_000)).toBe(16_384);
    expect(keepRecentFor(8192)).toBe(2048);
  });
});

describe("her context lines", () => {
  it("are numbers only, and the 75% and 90% lines appear at those points and not before", () => {
    expect(statusLine(measured(21_000).report()!)).toBe("Context 64% of 32k · 9.1k free · 38 tok/s · 2.1k tok/s prompt");
    const line = (pct: number) => prepareLine(measured(Math.round((pct / 100) * 32_768)).report()!);
    expect(line(74)).toBeUndefined();
    expect(line(75)).toMatch(/^Your context is filling up\. Finish the current step, save what matters with remember, then call threads/);
    expect(line(89)).toMatch(/filling up/);
    expect(line(90)).toMatch(/^Your context is nearly full\. Compact now/);
    expect(contextLines(measured(10_000))).not.toMatch(/\n/);
    expect(contextLines(measured(30_000)).split("\n")).toHaveLength(2);
    // Nothing before the first measured turn.
    expect(contextLines(new ContextMeter())).toBe("");
  });

  it("estimate the total after a compaction until the next response measures it", () => {
    const meter = measured(28_000);
    meter.compacted(6000);
    const r = meter.report()!;
    expect(r.tokens).toBe(6000);
    expect(r.parts.filter((p) => p.name !== "reserve" && p.name !== "free").reduce((a, p) => a + p.tokens, 0)).toBe(6000);
    expect(prepareLine(r)).toBeUndefined();
  });

  it("hand each turn's pace over once, for its call record", () => {
    const meter = measured(9000);
    expect(meter.takePace()).toMatchObject({ outputTokens: 380, tokPerSec: 38, promptTokPerSec: 2100 });
    expect(meter.takePace()).toBeUndefined();
    expect(meter.report()!.pace).toMatchObject({ tokPerSec: 38 });
  });
});
