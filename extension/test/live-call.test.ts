import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCallMeter, liveFields, type LiveCall } from "../src/live-call.ts";

describe("a thread's model request, live", () => {
  afterEach(() => vi.useRealTimers());

  const meter = () => {
    let now = 1_000;
    const sent: (LiveCall | null)[] = [];
    const m = new LiveCallMeter((c) => sent.push(c), () => now, 500);
    return { m, sent, tick: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); } };
  };

  it("reads llama.cpp's prompt progress and per-token timings, each new phase at once and changes at most every 500 ms", () => {
    vi.useFakeTimers();
    const { m, sent, tick } = meter();
    m.request(48_000);
    expect(sent.at(-1)).toEqual({ ms: 0, prompt: 48_000 });
    tick(100);
    // processed counts the cached tokens too. The read starting is sent at once; its progress waits its turn.
    m.chunk({ choices: [], prompt_progress: { total: 48_213, cache: 46_001, processed: 46_341, time_ms: 200 } });
    expect(sent.at(-1)).toEqual({ ms: 100, prompt: 48_213, cached: 46_001, read: 340, readRate: 1700 });
    tick(100);
    m.chunk({ choices: [], prompt_progress: { total: 48_213, cache: 46_001, processed: 47_341, time_ms: 728 } });
    expect(sent).toHaveLength(2);
    tick(400);
    expect(sent.at(-1)).toEqual({ ms: 600, prompt: 48_213, cached: 46_001, read: 1_340, readRate: 1840.7 });
    m.delta("thinking", 9);
    m.chunk({ choices: [{ delta: { reasoning_content: "x" } }], timings: { predicted_n: 1, predicted_per_second: 38.42, prompt_n: 2_212, cache_n: 46_001, prompt_per_second: 1_790 } });
    expect(sent.at(-1)).toMatchObject({ writing: "thinking" });
    tick(500);
    expect(sent.at(-1)).toEqual({ ms: 1_100, prompt: 48_213, cached: 46_001, read: 1_340, readRate: 1840.7, output: 1, outputRate: 38.4, writing: "thinking" });
    m.end();
    expect(sent.at(-1)).toBeNull();
    // Nothing after the end, not even a timer's flush.
    tick(1_000);
    expect(sent.at(-1)).toBeNull();
  });

  it("counts the output from its characters where the server says nothing, and takes vLLM's counts where it does", () => {
    vi.useFakeTimers();
    const { m, sent, tick } = meter();
    m.request(1_000);
    m.delta("tool", 40);
    expect(sent.at(-1)).toEqual({ ms: 0, prompt: 1_000, output: 10, counted: true, writing: "tool" });
    tick(500);
    m.chunk({ choices: [{ delta: {} }], usage: { prompt_tokens: 1_042, completion_tokens: 12, total_tokens: 1_054 } });
    expect(sent.at(-1)).toEqual({ ms: 500, prompt: 1_042, output: 12, writing: "tool" });
    // A server that counts only at the end says 0 on the way.
    m.request(2_000);
    m.chunk({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    tick(500);
    expect(sent.at(-1)).toEqual({ ms: 0, prompt: 2_000 });
  });

  it("asks llama.cpp and vLLM to say more, and no other server", () => {
    expect(liveFields({ server: "llama.cpp" }, {})).toEqual({ return_progress: true, timings_per_token: true });
    expect(liveFields({ llamaServer: true }, {})).toEqual({ return_progress: true, timings_per_token: true });
    expect(liveFields({ server: "vllm" }, { stream_options: { include_usage: true } })).toEqual({ stream_options: { include_usage: true, continuous_usage_stats: true } });
    expect(liveFields({}, {})).toEqual({});
  });
});
