import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlamaCpp } from "../src/backends.ts";
import { ggufBytes } from "../src/gguf.ts";
import type { Gpu } from "../src/gpus.ts";
import { scanTextModels } from "../src/library.ts";
import { defaultGpu, options, validate, type GpuSettings } from "../src/placement.ts";
import { fakeLlamaRouter, GIB, textModel } from "./fakes.ts";

const gpu = (index: number, gb: number): Gpu => ({ index, name: "RTX PRO 6000", vendor: "nvidia", total: gb * GIB, used: 0 });
const all = (i: number): GpuSettings => (void i, defaultGpu());
// 134 GB of files, 23 GB of them a per-layer embedding table llama.cpp never puts on the GPUs.
const flash = () => textModel("flash", 134, { layers: 48, layerTable: 23 * GIB });
const s = { placement: { mode: "auto" as const }, contextLength: 8192 };

describe("a per-layer embedding table", () => {
  it("isn't counted on the GPUs, wherever it is read from", () => {
    const [o] = options(flash(), s, [gpu(0, 128)], all);
    expect(o!.need[0]!).toBeLessThan(120 * GIB);
    expect(o!.ram).toBeUndefined();
  });

  it("kept in RAM takes from the allowance, and is refused without one", () => {
    const [o] = options(flash(), { ...s, layerTable: "ram" }, [gpu(0, 128)], all, 32 * GIB);
    expect(o!.ram).toBe(23 * GIB);
    // Loaded without mmap, the input embeddings llama.cpp keeps on the CPU come with it; Off for spilling doesn't stop it.
    const withInput = textModel("flash", 134, { layers: 48, layerTable: 23 * GIB, inputBytes: 2 * GIB });
    expect(options(withInput, { ...s, layerTable: "ram", systemRam: false }, [gpu(0, 128)], all, 32 * GIB)[0]!.ram).toBe(25 * GIB);
    expect(() => validate(flash(), { ...s, layerTable: "ram" }, [gpu(0, 128)], all, false, 0)).toThrow(/allowance, which is off/);
    expect(() => validate(flash(), { ...s, layerTable: "ram" }, [gpu(0, 128)], all, false, 16 * GIB)).toThrow(/23\.0 GB of system RAM/);
    expect(validate(flash(), { ...s, layerTable: "ram" }, [gpu(0, 128)], all, false, 32 * GIB)).toMatchObject({ layerTable: "ram" });
    // llama.cpp keeps a table of 4 GiB or less loaded anyway.
    expect(() => validate(textModel("small", 10, { layerTable: 3 * GIB }), { ...s, layerTable: "ram" }, [gpu(0, 128)], all, false, 32 * GIB)).toThrow(/over 4 GiB/);
  });

  it("adds to what a spilled model keeps in RAM", () => {
    const m = textModel("moe", 60, { layers: 48, layerTable: 10 * GIB, expertLayers: Array.from({ length: 48 }, () => GIB) });
    const [disk] = options(m, s, [gpu(0, 24)], all, 64 * GIB);
    const [ram] = options(m, { ...s, layerTable: "ram" }, [gpu(0, 24)], all, 64 * GIB);
    expect(disk!.cpuMoe).toBeGreaterThan(0);
    expect(ram!.cpuMoe).toBe(disk!.cpuMoe);
    expect(ram!.ram! - disk!.ram!).toBe(10 * GIB);
  });

  it("kept in RAM is loaded whole, not read from the file as needed", async () => {
    const router = await fakeLlamaRouter();
    const serving = mkdtempSync(join(tmpdir(), "lyrica-table-serving-"));
    const llama = new LlamaCpp({ url: router.url, serving, models: "/models", device: (i) => `CUDA${i}` });
    const at = { gpus: [0], split: null, parallel: null, share: null, need: { 0: 100 * GIB } };
    try {
      await llama.load(textModel("ram.gguf", 134, { layerTable: 23 * GIB }), { ...at, ram: 23 * GIB }, { ...s, layerTable: "ram" });
      await llama.load(textModel("disk.gguf", 134, { layerTable: 23 * GIB }), at, s);
      const ini = readFileSync(join(serving, "llamacpp.ini"), "utf8");
      expect(ini).toMatch(/\[ram\.gguf\][^[]*lazy-mode = off\nload-mode = none\n/);
      expect(ini.match(/lazy-mode/g)).toHaveLength(1);
    } finally {
      router.server.close();
    }
  });

  it("is read from a GGUF's tensor offsets", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-table-gguf-"));
    const header = ggufBytes(
      { "general.architecture": "gemma4", "tokenizer.ggml.model": "gpt2", "gemma4.block_count": 2 },
      { "token_embd.weight": [4, 4], "per_layer_token_embd.weight": [8, 4], "blk.0.attn_q.weight": [4, 4] },
      { "token_embd.weight": 0, "per_layer_token_embd.weight": 512, "blk.0.attn_q.weight": 4608 },
    );
    const start = Math.ceil(header.length / 32) * 32;
    writeFileSync(join(dir, "ple.gguf"), Buffer.concat([header, Buffer.alloc(start - header.length + 5120)]));
    const [m] = scanTextModels(dir);
    expect(m).toMatchObject({ layers: 2, layerTable: 4096, inputBytes: 512 });
    expect(m!.expertLayers).toBeUndefined();
  });
});
