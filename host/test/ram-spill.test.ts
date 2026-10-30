import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlamaCpp } from "../src/backends.ts";
import { ggufBytes } from "../src/gguf.ts";
import type { Gpu } from "../src/gpus.ts";
import { scanTextModels } from "../src/library.ts";
import { defaultGpu, layersBySplit, options, ramMost, sizes, validate, type GpuSettings } from "../src/placement.ts";
import { Scheduler } from "../src/scheduler.ts";
import { StateFile } from "../src/state.ts";
import { FakeBackend, FakeGpus, fakeLlamaRouter, GIB, textModel } from "./fakes.ts";

const gpu = (index: number, gb: number): Gpu => ({ index, name: "RTX 3090", vendor: "nvidia", total: gb * GIB, used: 0 });
const all = (i: number): GpuSettings => (void i, defaultGpu());
/** `gb` of experts over a model's layers, none in its first `dense` ones. */
const experts = (layers: number, gb: number, dense = 0) => Array.from({ length: layers }, (_, l) => (l < dense ? 0 : (gb * GIB) / (layers - dense)));

describe("keeping part of a model in system RAM", () => {
  it("leaves a model that fits its GPUs alone", () => {
    const m = textModel("m", 10, { layers: 40, expertLayers: experts(40, 8) });
    const [o] = options(m, { placement: { mode: "auto" } }, [gpu(0, 24)], all, 32 * GIB);
    expect(o).toMatchObject({ gpus: [0] });
    expect(o!.ram).toBeUndefined();
  });

  it("moves only the experts the GPU lacks room for, before whole layers", () => {
    const m = textModel("moe", 30, { layers: 48, expertLayers: experts(48, 27) });
    const [o] = options(m, { placement: { mode: "auto" }, contextLength: 8192 }, [gpu(0, 24)], all, 32 * GIB);
    expect(o!.cpuMoe).toBeGreaterThan(0);
    expect(o!.cpuMoe).toBeLessThan(48);
    expect(o!.gpuLayers).toBeUndefined();
    // On the GPU: no more than its room (24 GB less the 0.5 GB kept free).
    expect(o!.need[0]!).toBeLessThanOrEqual(23.5 * GIB);
    // In RAM: about what the GPU lacked, never all the experts.
    expect(o!.ram!).toBeLessThan(10 * GIB);
  });

  it("moves whole layers of a dense model", () => {
    const m = textModel("dense", 30, { layers: 60 });
    const [o] = options(m, { placement: { mode: "auto" }, contextLength: 8192 }, [gpu(0, 24)], all, 32 * GIB);
    expect(o!.cpuMoe).toBeUndefined();
    expect(o!.gpuLayers).toBeGreaterThan(40);
    expect(o!.gpuLayers).toBeLessThan(60);
    expect(o!.need[0]!).toBeLessThanOrEqual(23.5 * GIB);
  });

  it("on two GPUs that both lack room, keeps each GPU's layers within it", () => {
    // 100 GB over two 48 GB GPUs: both lack room, and only the layers each holds can relieve it.
    const m = textModel("big", 100, { layers: 80, expertLayers: experts(80, 85) });
    const s = { placement: { mode: "auto" as const }, contextLength: 8192 };
    const both = options(m, s, [gpu(0, 48), gpu(1, 48)], all, 64 * GIB).find((o) => o.gpus.length === 2)!;
    expect(both.cpuMoe).toBeGreaterThan(0);
    // Check against the layers each GPU holds under the split llama.cpp is given.
    const counts = layersBySplit(80, both.split!);
    const base = (sizes(m, s).weights + sizes(m, s).kv - 85 * GIB) / 80;
    const layerBytes = (l: number) => base + (l < both.cpuMoe! ? 0 : (85 * GIB) / 80);
    let l = 0;
    for (const [k, c] of counts.entries()) {
      let held = 0;
      for (let i = 0; i < c; i++) held += layerBytes(l++);
      expect(held + GIB / 2).toBeLessThanOrEqual(47.5 * GIB);
      expect(both.need[k]!).toBeLessThanOrEqual(47.5 * GIB);
    }
  });

  it("with a split set by hand, moves experts until the GPU holding the later layers fits too", () => {
    const m = textModel("big", 100, { layers: 80, expertLayers: experts(80, 85) });
    const s = { placement: { mode: "gpus" as const, gpus: [0, 1], split: [1, 1] }, contextLength: 8192 };
    const [o] = options(m, s, [gpu(0, 48), gpu(1, 48)], all, 64 * GIB);
    expect(o!.split).toEqual([40, 40]);
    // GPU 1 holds layers 40 to 79: they only lose weight once n-cpu-moe reaches past 40.
    expect(o!.cpuMoe).toBeGreaterThan(40);
    for (const i of [0, 1]) expect(o!.need[i]!).toBeLessThanOrEqual(47.5 * GIB);
  });

  it("counts no relief from dense first layers", () => {
    const dense = textModel("glm", 30, { layers: 48, expertLayers: experts(48, 27, 3) });
    const even = textModel("moe", 30, { layers: 48, expertLayers: experts(48, 27) });
    const s = { placement: { mode: "auto" as const }, contextLength: 8192 };
    const [a] = options(dense, s, [gpu(0, 24)], all, 32 * GIB);
    const [b] = options(even, s, [gpu(0, 24)], all, 32 * GIB);
    // The first three layers move nothing, so it takes three more layers to free the same room.
    expect(a!.cpuMoe).toBeGreaterThan(b!.cpuMoe!);
    expect(a!.need[0]!).toBeLessThanOrEqual(23.5 * GIB);
  });

  it("never spills when the allowance is off or the model says Off", () => {
    const m = textModel("moe", 30, { layers: 48, expertLayers: experts(48, 27) });
    expect(options(m, { placement: { mode: "auto" }, contextLength: 8192 }, [gpu(0, 24)], all, 0)[0]!.ram).toBeUndefined();
    expect(options(m, { placement: { mode: "auto" }, contextLength: 8192, systemRam: false }, [gpu(0, 24)], all, 32 * GIB)[0]!.ram).toBeUndefined();
    expect(() => validate(m, { placement: { mode: "auto" }, contextLength: 8192, systemRam: false }, [gpu(0, 24)], all, false, 32 * GIB)).toThrow(/needs about/);
  });

  it("refuses at save a spill past the allowance, with both numbers", () => {
    const m = textModel("moe", 40, { layers: 48, expertLayers: experts(48, 36) });
    expect(() => validate(m, { placement: { mode: "auto" }, contextLength: 8192 }, [gpu(0, 24)], all, false, 8 * GIB)).toThrow(/system RAM besides its GPUs, more than the host's allowance of 8\.0 GB/);
    expect(validate(m, { placement: { mode: "auto" }, contextLength: 8192 }, [gpu(0, 24)], all, false, 32 * GIB)).toMatchObject({ contextLength: 8192 });
  });

  it("counts layers left off the GPUs by hand", () => {
    const m = textModel("dense", 30, { layers: 60 });
    const [o] = options(m, { placement: { mode: "auto" }, contextLength: 8192, gpuLayers: 30 }, [gpu(0, 24)], all);
    expect(o!.gpuLayers).toBe(30);
    expect(o!.ram!).toBeGreaterThan(15 * GIB);
  });

  it("leaves the system and llama.cpp's prompt cache their part of memory", () => {
    expect(ramMost(96 * GIB)).toBe(76 * GIB);
    expect(ramMost(32 * GIB)).toBe(16 * GIB);
    expect(ramMost(8 * GIB)).toBe(0);
  });
});

describe("the system RAM allowance", () => {
  function setup(totals = [24]) {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-ram-"));
    const gpus = new FakeGpus(totals);
    const llamacpp = new FakeBackend(gpus);
    const state = new StateFile(dir);
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp, vllm: new FakeBackend(gpus) }, state, log: () => {}, memoryBytes: 96 * GIB });
    return { scheduler, llamacpp, state };
  }

  it("is off until set, and refuses more than the machine can give", async () => {
    const { scheduler } = setup();
    await scheduler.start([]);
    const m = textModel("moe", 30, { layers: 48, expertLayers: experts(48, 27), contextLength: 8192 });
    await expect(scheduler.loadNow(m)).rejects.toMatchObject({ code: "too_big" });
    await expect(scheduler.setRamAllowance(80 * GIB)).rejects.toMatchObject({ code: "invalid" });
    await scheduler.setRamAllowance(32 * GIB);
    await scheduler.loadNow(m);
    expect(scheduler.ramStatus()).toMatchObject({ total: 96 * GIB, most: 76 * GIB, allowance: 32 * GIB, models: [{ id: "moe" }] });
    expect(scheduler.ramStatus().used).toBeGreaterThan(0);
  });

  it("is shared: a spilled model unloads an idle one to make room in it", async () => {
    const { scheduler, llamacpp } = setup([24, 24]);
    await scheduler.start([]);
    await scheduler.setRamAllowance(12 * GIB);
    // Each needs about 8 GB of system RAM on one GPU.
    const a = textModel("a", 30, { layers: 48, expertLayers: experts(48, 27), contextLength: 8192 });
    const b = textModel("b", 30, { layers: 48, expertLayers: experts(48, 27), contextLength: 8192 });
    scheduler.saveSettings(a, { placement: { mode: "gpus", gpus: [0] }, contextLength: 8192 });
    scheduler.saveSettings(b, { placement: { mode: "gpus", gpus: [1] }, contextLength: 8192 });
    await scheduler.loadNow(a);
    await scheduler.loadNow(b);
    expect(llamacpp.calls).toEqual(["load a@0", "unload a", "load b@1"]);
  });

  it("says why when pinned models hold it", async () => {
    const { scheduler } = setup([24, 24]);
    await scheduler.start([]);
    await scheduler.setRamAllowance(12 * GIB);
    const a = textModel("a", 30, { layers: 48, expertLayers: experts(48, 27), contextLength: 8192 });
    const b = textModel("b", 30, { layers: 48, expertLayers: experts(48, 27), contextLength: 8192 });
    scheduler.saveSettings(a, { placement: { mode: "gpus", gpus: [0] }, contextLength: 8192 });
    scheduler.saveSettings(b, { placement: { mode: "gpus", gpus: [1] }, contextLength: 8192 });
    await scheduler.pin(a, true);
    await expect(scheduler.loadNow(b)).rejects.toThrow(/system RAM; the allowance is 12\.0 GB, of which .* GB is pinned/);
  });

  it("unloads spilled models when lowered below what they use", async () => {
    const { scheduler, llamacpp } = setup();
    await scheduler.start([]);
    await scheduler.setRamAllowance(32 * GIB);
    const m = textModel("moe", 30, { layers: 48, expertLayers: experts(48, 27), contextLength: 8192 });
    await scheduler.loadNow(m);
    await scheduler.setRamAllowance(0);
    expect(llamacpp.calls.at(-1)).toBe("unload moe");
    expect(scheduler.ramStatus()).toMatchObject({ allowance: 0, used: 0 });
  });
});

describe("what llama.cpp is told", () => {
  it("writes the experts kept in system RAM, or the layers on the GPUs", async () => {
    const router = await fakeLlamaRouter();
    const serving = mkdtempSync(join(tmpdir(), "lyrica-ram-serving-"));
    const llama = new LlamaCpp({ url: router.url, serving, models: "/models", device: (i) => `CUDA${i}` });
    const at = { gpus: [0], split: null, parallel: null, share: null, need: { 0: 20 * GIB } };
    try {
      await llama.load(textModel("moe.gguf", 30, { layers: 48 }), { ...at, ram: 10 * GIB, cpuMoe: 18 }, { placement: { mode: "auto" } });
      await llama.load(textModel("dense.gguf", 30, { layers: 60 }), { ...at, ram: 10 * GIB, gpuLayers: 41 }, { placement: { mode: "auto" } });
      const ini = readFileSync(join(serving, "llamacpp.ini"), "utf8");
      expect(ini).toMatch(/\[moe\.gguf\][^[]*n-gpu-layers = 999\nflash-attn = auto\nn-cpu-moe = 18\n/);
      expect(ini).toMatch(/\[dense\.gguf\][^[]*n-gpu-layers = 41\n/);
      expect(ini.match(/n-cpu-moe/g)).toHaveLength(1);
    } finally {
      router.server.close();
    }
  });
});

describe("reading a GGUF's experts", () => {
  it("counts the bytes of expert tensors from their offsets", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-ram-gguf-"));
    const header = ggufBytes(
      { "general.architecture": "qwen3moe", "tokenizer.ggml.model": "gpt2", "qwen3moe.block_count": 3 },
      { "blk.0.attn_q.weight": [4, 4], "blk.0.ffn_up_exps.weight": [8, 4, 4], "blk.1.ffn_down_exps.weight": [8, 4, 4] },
      { "blk.0.attn_q.weight": 0, "blk.0.ffn_up_exps.weight": 1024, "blk.1.ffn_down_exps.weight": 5120 },
    );
    const start = Math.ceil(header.length / 32) * 32;
    writeFileSync(join(dir, "moe.gguf"), Buffer.concat([header, Buffer.alloc(start - header.length + 9216)]));
    const [m] = scanTextModels(dir);
    // Layer 0's expert runs to layer 1's; layer 2 is dense.
    expect(m).toMatchObject({ layers: 3, expertLayers: [4096, 4096, 0] });
  });
});
