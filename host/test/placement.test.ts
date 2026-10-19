import { describe, expect, it } from "vitest";
import { autoContext, concurrentOf, defaultGpu, validate, type GpuSettings } from "../src/placement.ts";
import type { Gpu } from "../src/gpus.ts";
import { GIB, textModel } from "./fakes.ts";

const gpu = (index: number, gb: number, name = "RTX 3090"): Gpu => ({ index, name, vendor: "nvidia", total: gb * GIB, used: GIB });
const all = (i: number): GpuSettings => (void i, defaultGpu());

describe("requests a chat model serves at once", () => {
  const auto = { placement: { mode: "auto" as const } };
  const llama = textModel("llama", 20, { contextLength: 1_048_576 });
  const vllm = textModel("vllm", 20, { server: "vllm", format: "safetensors", contextLength: 1_048_576 });

  it("go by the context it is served with: 1 below 200k, 2 from 200k, 4 from 500k", () => {
    expect(concurrentOf(llama, { ...auto, contextLength: 131_072 })).toBe(1);
    expect(concurrentOf(llama, { ...auto, contextLength: 262_144 })).toBe(2);
    expect(concurrentOf(vllm, { ...auto, contextLength: 524_288 })).toBe(4);
  });

  it("follow its own setting, and are null for other models", () => {
    expect(concurrentOf(llama, { ...auto, contextLength: 131_072, parallel: 3 })).toBe(3);
    expect(concurrentOf(vllm, { ...auto, contextLength: 131_072, maxSeqs: 8, parallel: 3 })).toBe(8);
    expect(concurrentOf(textModel("embed", 1, { kind: "embedding" }), auto)).toBeNull();
  });
});

describe("placements, as they are saved", () => {
  const gpus = [gpu(0, 24), gpu(1, 24), gpu(2, 96, "RTX PRO 6000")];
  const llama = textModel("llama", 20, { contextLength: 131072, kvPerToken: 2 * 64 * 8 * 128 });
  const vllm = textModel("vllm", 20, { server: "vllm", format: "safetensors", contextLength: 131072 });

  it("subtracts memory used by other programs at save time", () => {
    const m = textModel("near-limit", 21);
    const body = { placement: { mode: "auto" } };
    expect(() => validate(m, body, [{ ...gpu(0, 24), used: 0 }], all)).not.toThrow();
    expect(() => validate(m, body, [{ ...gpu(0, 24), used: GIB }], all)).toThrow();
  });

  it("accepts Auto, one GPU, or several with a split", () => {
    expect(validate(llama, { placement: { mode: "auto" } }, gpus, all).placement).toEqual({ mode: "auto" });
    expect(() => validate(llama, { placement: { mode: "gpus", gpus: [2] }, contextLength: 65536 }, gpus, all)).not.toThrow();
    expect(() => validate(llama, { placement: { mode: "gpus", gpus: [0, 1], split: [1, 1] } }, gpus, all)).not.toThrow();
  });

  it("refuses GPUs that don't allow the server, or are left out", () => {
    const noVllm = (i: number): GpuSettings => (i === 2 ? { ...defaultGpu(), servers: ["llamacpp"] } : defaultGpu());
    expect(() => validate(vllm, { placement: { mode: "gpus", gpus: [2] } }, gpus, noVllm)).toThrow("GPU 2 doesn't allow vLLM.");
    const out = (i: number): GpuSettings => ({ ...defaultGpu(), excluded: i === 0 });
    expect(() => validate(llama, { placement: { mode: "gpus", gpus: [0] } }, gpus, out)).toThrow("GPU 0 is left out.");
  });

  it("refuses a model too big for its GPUs even when empty, and a context too big for them", () => {
    expect(() => validate(textModel("huge", 40), { placement: { mode: "gpus", gpus: [0] } }, gpus, all)).toThrow(/needs about .* GB on GPU 0, which has 22\.5 GB to give/);
    // 20 GB of weights fit on a 24 GB GPU; 128k of KV cache (32 GB) doesn't.
    expect(() => validate(llama, { placement: { mode: "gpus", gpus: [0] }, contextLength: 131072 }, gpus, all)).toThrow(/A context of 131072 tokens needs about .* GB more than GPU 0 has; lower the context length\./);
    expect(() => validate(llama, { placement: { mode: "auto" }, contextLength: 262144 }, gpus, all)).toThrow("trained for 131072 tokens");
  });

  it("refuses tensor parallel over GPUs that don't match", () => {
    expect(() => validate(vllm, { placement: { mode: "gpus", gpus: [0, 2], parallel: "tensor" } }, gpus, all)).toThrow("Tensor parallel needs matching GPUs");
    expect(() => validate(vllm, { placement: { mode: "gpus", gpus: [0, 2], parallel: "pipeline" } }, gpus, all)).not.toThrow();
  });

  it("refuses a vLLM context that doesn't fit in its memory share", () => {
    const one = { mode: "gpus", gpus: [0] };
    expect(() => validate(vllm, { placement: one, memoryShare: 0.5 }, gpus, all)).toThrow(/weights need about .* more than vLLM's share of 12\.0 GB; raise the memory share/);
    // 20 GB of weights fit in 95% of 24 GB; 128k of KV cache beside them doesn't.
    expect(() => validate(vllm, { placement: one, memoryShare: 0.95, contextLength: 8192 }, gpus.map((g) => ({ ...g, used: 0 })), all)).not.toThrow();
    expect(() => validate(vllm, { placement: one, memoryShare: 0.95, contextLength: 131072 }, gpus, all)).toThrow(/A context of 131072 tokens needs about .* GB more than vLLM's share of GPU 0; lower the context length\./);
  });

  it("bounds split ratios, and needs flash attention for a quantized KV cache", () => {
    for (const split of [[1e400, 1], [0, 1], [0.001, 1], [1, -1]]) {
      expect(() => validate(llama, { placement: { mode: "gpus", gpus: [0, 1], split } }, gpus, all)).toThrow("split must give a ratio from 0.01 to 1000");
    }
    expect(() => validate(llama, { placement: { mode: "auto" }, kvCacheType: "q8_0" }, gpus, all)).toThrow("needs flashAttention set to on");
    expect(() => validate(llama, { placement: { mode: "auto" }, kvCacheType: "q4_0", flashAttention: "on" }, gpus, all)).not.toThrow();
  });

  it("refuses settings for the other server, and unknown ones", () => {
    expect(() => validate(vllm, { placement: { mode: "auto" }, gpuLayers: 40 }, gpus, all)).toThrow("gpuLayers is for llama.cpp models.");
    expect(() => validate(llama, { placement: { mode: "auto" }, memoryShare: 0.5 }, gpus, all)).toThrow("memoryShare is for vLLM models.");
    expect(() => validate(llama, { placement: { mode: "auto" }, rope: 2 }, gpus, all)).toThrow("Unknown setting: rope.");
  });
});

describe("the context with none saved", () => {
  // 20 GB of weights and 256 KB of f16 KV cache a token: 1 GB per 4096 tokens.
  const llama = textModel("llama", 20, { contextLength: 131072, kvPerToken: 2 * 64 * 8 * 128 });
  const auto = { placement: { mode: "auto" as const } };
  const empty = (gb: number) => [{ ...gpu(0, gb), used: 0 }];

  it("is the largest that fits, up to what the model was trained for", () => {
    // 23.5 GB to give, less 21 GB of weights and 0.5 GB for the server: 2 GB of cache.
    expect(autoContext(llama, auto, empty(24), all)).toBe(8192);
    expect(autoContext(llama, auto, empty(96), all)).toBe(131072);
    // A save with no context is checked at that one, so it passes where 32k wouldn't.
    expect(() => validate(llama, auto, empty(24), all)).not.toThrow();
    expect(() => validate(llama, { ...auto, contextLength: 32768 }, empty(24), all)).toThrow("lower the context length");
  });

  it("stays at 32k when nothing fits or the model's length is unknown", () => {
    expect(autoContext(textModel("huge", 40, { contextLength: 131072 }), auto, empty(24), all)).toBe(32768);
    expect(autoContext(textModel("small", 4, { contextLength: null }), auto, empty(24), all)).toBe(32768);
    expect(autoContext(textModel("short", 4, { contextLength: 8192 }), auto, empty(24), all)).toBe(8192);
  });
});
