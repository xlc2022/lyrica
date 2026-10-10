// Dictation's recorder: the microphone's context, and the clip's limit.
import { describe, expect, it } from "vitest";
import { join, openContext } from "../src/Voice.tsx";

class FakeContext {
  static made: number[] = [];
  readonly sampleRate: number;
  closed = false;
  constructor(opts?: { sampleRate?: number }) { this.sampleRate = opts?.sampleRate ?? 48_000; FakeContext.made.push(this.sampleRate); }
  close() { this.closed = true; return Promise.resolve(); }
  createMediaStreamSource() {
    // Firefox: a microphone connects only to a context at the device's own rate.
    if (this.sampleRate !== 48_000) throw Object.assign(new Error("not supported"), { name: "NotSupportedError" });
    return { connect: () => undefined };
  }
}

describe("dictation", () => {
  it("falls back to the default-rate context where the microphone won't connect at 16 kHz", () => {
    FakeContext.made = [];
    const { ctx } = openContext({} as MediaStream, FakeContext);
    expect(FakeContext.made).toEqual([16_000, 48_000]);
    expect(ctx.sampleRate).toBe(48_000);
  });

  it("cuts a clip at ten minutes, at 16 kHz and after resampling", () => {
    const tenMinutes = 600 * 16_000;
    const long = [new Float32Array(tenMinutes), new Float32Array(16_000)];
    expect(join(long, 16_000).length).toBe(tenMinutes);
    const at48 = [new Float32Array(600 * 48_000 + 48_000 * 3)];
    expect(join(at48, 48_000).length).toBe(tenMinutes);
    // A short clip keeps every sample, resampled.
    expect(join([new Float32Array(4800)], 48_000).length).toBe(1600);
  });
});
