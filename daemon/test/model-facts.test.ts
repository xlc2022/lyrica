import { describe, expect, it } from "vitest";
import type { CallInfo, PaceInfo } from "../src/api.ts";
import { MODEL_FACTS_WINDOW_MS, modelFacts } from "../src/model-facts.ts";

// Synthetic rows only: no text of any real conversation, and nothing copied from real data.
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const MIN = 60_000;
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

function call(over: Partial<CallInfo> & { offeringId: string }): CallInfo {
  return { at: iso(-60 * MIN), pool: "general", threadId: "t1", task: "chat", label: "Model", endpointName: "Endpoint", kind: "local", ...over };
}
/** The same model copy, recorded at a moment relative to the request. */
const at = (id: string, msFromNow: number, over: Partial<CallInfo> = {}): CallInfo => call({ offeringId: id, at: iso(msFromNow), ...over });
/** A turn's measurements; `speeds` leaves `tokPerSec` out when a time is too short to mean anything. */
const pace = (tokPerSec?: number): PaceInfo => ({
  promptTokens: 100, outputTokens: 50, window: 8192, ttftMs: 400, genMs: 1000, processed: 100,
  ...(tokPerSec !== undefined ? { tokPerSec } : {}),
});

describe("model facts for the last 24 hours", () => {
  it("counts rows inside the window at both ends and leaves out those outside, in the future or unreadable", () => {
    const r = modelFacts([
      at("in-old", -MODEL_FACTS_WINDOW_MS),         // exactly 24 hours ago: in
      at("in-now", 0),                               // the moment of the request: in
      at("out-early", -MODEL_FACTS_WINDOW_MS - 1),   // a millisecond older: out
      at("out-future", MIN),                         // the future says nothing about this day: out
      call({ offeringId: "bad-time", at: "not a date" }),
    ], ["general"], NOW);
    expect(r.models.map((m) => m.offeringId)).toEqual(["in-now", "in-old"]);
  });

  it("reports the window as its bounds and the pools it was given, with no models from nothing", () => {
    expect(modelFacts([], ["general", "private"], NOW)).toEqual({ since: iso(-MODEL_FACTS_WINDOW_MS), until: iso(0), pools: ["general", "private"], models: [], calls: [] });
  });

  it("uses the clock of the request when none is given", () => {
    const r = modelFacts([call({ offeringId: "x", at: new Date().toISOString() })], ["general"]);
    expect(r.models.map((m) => m.offeringId)).toEqual(["x"]);
    expect(Date.parse(r.since)).toBe(Date.parse(r.until) - MODEL_FACTS_WINDOW_MS);
  });

  it("counts every row once, whatever its task, and only in the pools shown", () => {
    const r = modelFacts([
      call({ offeringId: "a", task: "chat" }), call({ offeringId: "a", task: "code" }), call({ offeringId: "a", task: "title" }),
      call({ offeringId: "b", pool: "general" }), call({ offeringId: "b", pool: "private" }),
      call({ offeringId: "c", pool: "private", task: "sleep.dream" }),
    ], ["general"], NOW);
    expect(r.models.map((m) => [m.offeringId, m.calls])).toEqual([["a", 3], ["b", 1]]);
  });

  it("keeps two copies of one label apart by offering ID, naming each from its newest row", () => {
    const r = modelFacts([
      at("copy-1", -5 * MIN, { label: "GLM 4.6V", endpointName: "LM Studio" }),
      at("copy-1", -3 * MIN, { label: "GLM 4.6V Fast", endpointName: "Llama.cpp" }),
      at("copy-2", -1 * MIN, { label: "GLM 4.6V Fast", endpointName: "vLLM" }),
    ], ["general"], NOW);
    expect(r.models).toEqual([
      { offeringId: "copy-1", label: "GLM 4.6V Fast", endpointName: "Llama.cpp", kind: "local", calls: 2, speedSamples: 0, promptSamples: 0, outputTokens: 0, fallbacks: 0 },
      { offeringId: "copy-2", label: "GLM 4.6V Fast", endpointName: "vLLM", kind: "local", calls: 1, speedSamples: 0, promptSamples: 0, outputTokens: 0, fallbacks: 0 },
    ]);
  });

  it("sorts by label, then by offering ID", () => {
    const r = modelFacts([
      call({ offeringId: "z", label: "b model" }), call({ offeringId: "a", label: "b model" }), call({ offeringId: "m", label: "a model" }),
    ], ["general"], NOW);
    expect(r.models.map((m) => [m.label, m.offeringId])).toEqual([["a model", "m"], ["b model", "a"], ["b model", "z"]]);
  });

  it("medians recorded speeds, averaging the central pair when there are an even number", () => {
    const odd = modelFacts(["10", "30", "20"].map((s, i) => at("odd", -(i + 1) * MIN, { pace: pace(Number(s)) })), ["general"], NOW);
    expect(odd.models.map((m) => [m.speedSamples, m.medianTokPerSec])).toEqual([[3, 20]]);

    const even = modelFacts(["10", "40", "20", "30"].map((s, i) => at("even", -(i + 1) * MIN, { pace: pace(Number(s)) })), ["general"], NOW);
    expect(even.models.map((m) => [m.speedSamples, m.medianTokPerSec])).toEqual([[4, 25]]);

    const pair = modelFacts([at("pair", -MIN, { pace: pace(10.1) }), at("pair", -2 * MIN, { pace: pace(10.2) })], ["general"], NOW);
    expect(pair.models[0]!.speedSamples).toBe(2);
    expect(pair.models[0]!.medianTokPerSec).toBeCloseTo(10.15);
  });

  it("reports speed as unavailable rather than zero when nothing measured it, and still counts the calls", () => {
    const r = modelFacts([
      call({ offeringId: "no-pace" }),
      call({ offeringId: "zero", pace: pace(0) }),
      call({ offeringId: "nan", pace: pace(Number.NaN) }),
      call({ offeringId: "infinite", pace: pace(Number.POSITIVE_INFINITY) }),
      call({ offeringId: "negative", pace: pace(-1) }),
    ], ["general"], NOW);
    expect(r.models.map((m) => [m.offeringId, m.calls, m.speedSamples, m.medianTokPerSec])).toEqual([
      ["infinite", 1, 0, undefined], ["nan", 1, 0, undefined], ["negative", 1, 0, undefined], ["no-pace", 1, 0, undefined], ["zero", 1, 1, 0],
    ]);
    const without = r.models.find((m) => m.offeringId === "no-pace")!;
    expect("medianTokPerSec" in without).toBe(false);
    expect(r.models.find((m) => m.offeringId === "infinite")!.speedSamples).toBe(0);
  });

  it("counts recorded fallback markers, and never reads one out of a note", () => {
    const r = modelFacts([
      call({ offeringId: "f", fallback: "GLM 4.6V was down" }),
      call({ offeringId: "f", fallback: "GLM 4.6V was too slow" }),
      call({ offeringId: "f", note: "fallback to a cheaper model; the request errored and retried" }),
      call({ offeringId: "f", fallback: "" }),
      call({ offeringId: "f", fallback: "   " }),
    ], ["general"], NOW);
    expect(r.models.map((m) => [m.offeringId, m.calls, m.fallbacks])).toEqual([["f", 5, 2]]);
  });

  it("adds up output and medians prompt speed over paced rows only", () => {
    const r = modelFacts([
      at("p", -3 * MIN, { pace: { ...pace(30), promptTokPerSec: 400 } }),
      at("p", -2 * MIN, { pace: { ...pace(), promptTokPerSec: 600 } }),
      at("p", -1 * MIN),
    ], ["general"], NOW);
    expect(r.models.map((m) => [m.outputTokens, m.promptSamples, m.medianPromptTokPerSec, m.speedSamples])).toEqual([[100, 2, 500, 1]]);
  });

  it("gives each row in the window as numbers for the charts, newest first, with no thread, note or fallback text", () => {
    const r = modelFacts([
      at("a", -2 * MIN, { task: "title", pace: pace(40), threadId: "secret-thread", note: "a note", fallback: "the first was down" }),
      at("a", -25 * 60 * MIN, { pace: pace(10) }),
      at("b", -1 * MIN, { task: "watching" }),
      at("c", -1 * MIN, { pool: "private" }),
    ], ["general"], NOW);
    expect(r.calls).toEqual([
      { at: iso(-1 * MIN), offeringId: "b", task: "watching" },
      { at: iso(-2 * MIN), offeringId: "a", task: "title", outputTokens: 50, tokPerSec: 40, fallback: true },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/secret-thread|a note|was down/);
  });

  it("reads past any preview limit: every row and every model given counts", () => {
    const many = Array.from({ length: 120 }, (_, i) => at(`model-${i % 60}`, -(i + 1) * MIN));
    const r = modelFacts(many, ["general"], NOW);
    expect(r.models).toHaveLength(60);
    expect(r.models.reduce((n, m) => n + m.calls, 0)).toBe(120);
  });
});
