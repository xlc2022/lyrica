import { describe, expect, it } from "vitest";
import { speeds } from "@lyrica/core";
import { ContextMeter, contextLines, keepRecentFor, linesFor, prepareLine, reserveFor, statusLine, type Section } from "../src/index.ts";

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
    // Pinned messages count as their own part.
    const pinned = new ContextMeter();
    pinned.setPrompt([section("persona", 4000), section("pinned", 2400)], 0);
    pinned.measure(undefined, 32_768, 1000);
    expect(pinned.report()!.parts.find((p) => p.name === "pinned")!.tokens).toBe(600);
    const r = measured(9000).report()!;
    expect(r).toMatchObject({ tokens: 9000, window: 32_768, percent: 27, reserve: reserveFor(32_768), free: 32_768 - 9000 - reserveFor(32_768) });
    // Persona and topics outweigh the page about the user, as their sizes say.
    const part = (n: string) => r.parts.find((p) => p.name === n)!.tokens;
    expect(part("persona")).toBeGreaterThan(part("about"));
  });

  it("puts Pi's own compaction past the 90% line, and keeps a quarter of the window", () => {
    expect(reserveFor(131_072) / 131_072).toBeCloseTo(0.08, 2);
    // At least 5,120 from 20k up: pi-ai keeps 4,096 spare when it sizes a reply, so a reply always gets 1,024.
    expect(reserveFor(32_768)).toBe(5120);
    expect(reserveFor(16_384)).toBe(1311);
    expect(reserveFor(1_000_000)).toBe(16_384);
    expect(keepRecentFor(8192)).toBe(2048);
  });
});

describe("her context lines", () => {
  it("are numbers only, and the 75% and 90% lines appear at those points and not before", () => {
    expect(statusLine(measured(21_000).report()!)).toBe("Context 64% of 32k · 6.6k free · 38 tok/s · 2.1k tok/s prompt");
    const line = (pct: number) => prepareLine(measured(Math.round((pct / 100) * 131_072), 131_072).report()!);
    expect(line(74)).toBeUndefined();
    expect(line(75)).toMatch(/^Your context is filling up\. Finish the current step, save what matters with remember, then call threads with action "compact" and a summary/);
    expect(line(89)).toMatch(/filling up/);
    expect(line(90)).toMatch(/^Your context is nearly full\. Compact now/);
    expect(contextLines(measured(10_000))).not.toMatch(/\n/);
    expect(contextLines(measured(30_000)).split("\n")).toHaveLength(2);
    // Nothing before the first measured turn.
    expect(contextLines(new ContextMeter())).toBe("");
  });

  it("follow Pi's edge on small windows, so she hears before Pi compacts", () => {
    expect(linesFor(131_072)).toEqual({ prepare: 75, compact: 90 });
    // 32k: the 5,120 floor puts Pi's edge at 84.4%.
    expect(linesFor(32_768)).toEqual({ prepare: 67.4, compact: 82.4 });
    expect(linesFor(1_000_000)).toEqual({ prepare: 75, compact: 90 });
    // 8k: the 1,024 floor puts Pi's edge at 87.5%.
    expect(linesFor(8192)).toEqual({ prepare: 70.5, compact: 85.5 });
    const line = (pct: number) => prepareLine(measured(Math.round((pct / 100) * 8192), 8192).report()!);
    expect(line(70)).toBeUndefined();
    expect(line(70.5)).toMatch(/filling up/);
    expect(line(85)).toMatch(/filling up/);
    expect(line(85.5)).toMatch(/Compact now/);
    expect(linesFor(8192).compact).toBeLessThan(100 - (reserveFor(8192) / 8192) * 100);
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

describe("every request's reads", () => {
  it("includes cached reads on every request while context remains the last prompt", async () => {
    const { registerContext } = await import("../src/context.ts");
    const handlers = new Map<string, (...args: any[]) => any>();
    const pi = { on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) };
    const meter = new ContextMeter();
    registerContext(pi as any, meter);
    handlers.get("agent_start")!();
    for (const usage of [{ input: 10, cacheRead: 20, cacheWrite: 5, output: 3 }, { input: 5, cacheRead: 40, cacheWrite: 2, output: 4 }]) {
      handlers.get("before_provider_request")!();
      handlers.get("message_end")!({ message: { role: "assistant", usage } });
    }
    handlers.get("agent_end")!({}, { model: { contextWindow: 1000 }, getContextUsage: () => ({ tokens: 47 }), sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [{ type: "compaction" }, { type: "message" }, { type: "compaction" }] } });
    expect(meter.takePace()).toMatchObject({ promptTokens: 47, readTokens: 82, outputTokens: 7, processed: 22 });
    // The total is what is left after the branch's compactions, and the report says how many there were.
    expect(meter.report()).toMatchObject({ tokens: 47, compactions: 2 });
  });
});


describe("requested compaction at Pi’s threshold", () => {
  it("waits for the host, without deferring overflow recovery or ordinary automatic compaction", async () => {
    const { registerContext } = await import("../src/context.ts");
    const handlers = new Map<string, (...args: any[]) => any>();
    const meter = new ContextMeter();
    registerContext({ on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } as any, meter);
    const compact = handlers.get("session_before_compact")!;
    expect(compact({ reason: "threshold" })).toBeUndefined();
    for (const pending of [{ summary: "Her summary" }, { notes: "Her notes" }]) {
      meter.pending = pending;
      expect(compact({ reason: "threshold" })).toEqual({ cancel: true });
      expect(meter.pending).toBe(pending);
      expect(compact({ reason: "overflow" })).toBeUndefined();
      expect(compact({ reason: "manual" })).toBeUndefined();
    }
  });
});
