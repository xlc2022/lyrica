import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Downloader } from "../src/fetch/downloads.ts";
import { isPublic } from "../src/fetch/guard.ts";
import { huggingFace, modelScope } from "../src/fetch/hubs.ts";
import { Net } from "../src/fetch/net.ts";
import { ggufBytes } from "../src/gguf.ts";
import { scanTextModels } from "../src/library.ts";
import { contextOf, defaultGpu, sizes, validate, type GpuSettings } from "../src/placement.ts";
import { parseRecipe, parseRepo } from "../src/recommended.ts";
import type { Gpu } from "../src/gpus.ts";
import { GIB, fakeHub, textModel } from "./fakes.ts";

// Context stretching (DESIGN.md, Model settings): YaRN as a serving setting,
// the fit check by the layers that hold a KV cache, and the card's recipe.
// The cards below are written for these tests in the shape publishers use;
// none is copied from a real repository.

const gpu = (index: number, gb: number): Gpu => ({ index, name: "RTX PRO 6000", vendor: "nvidia", total: gb * GIB, used: GIB });
const all = (i: number): GpuSettings => (void i, defaultGpu());
const gpus = [gpu(0, 96)];
const auto = { mode: "auto" } as const;

describe("stretch, as it is saved", () => {
  const llama = textModel("hybrid", 17, { contextLength: 262144, kvPerToken: 2 * 16 * 2 * 256 });
  const vllm = textModel("dense", 17, { server: "vllm", format: "safetensors", contextLength: 32768, kvPerToken: 2 * 64 * 8 * 128 });

  it("raises the context's limit to the trained length times the factor, and no further", () => {
    const s = validate(llama, { placement: auto, contextLength: 1_010_000, stretch: { type: "yarn", factor: 4 }, kvCacheType: "q8_0", flashAttention: "on" }, gpus, all);
    // The original context defaults to the trained length.
    expect(s.stretch).toEqual({ type: "yarn", factor: 4, originalContext: 262144 });
    expect(contextOf(llama, s)).toBe(1_010_000);
    expect(() => validate(llama, { placement: auto, contextLength: 300_000 }, gpus, all)).toThrow("This model was trained for 262144 tokens of context at most.");
    expect(() => validate(llama, { placement: auto, contextLength: 600_000, stretch: { type: "yarn", factor: 2 } }, gpus, all))
      .toThrow("This model was trained for 262144 tokens; with a stretch of 2 it serves 524288 at most.");
  });

  it("takes whole factors from 1 to 8 for llama.cpp, any for vLLM, and YaRN only", () => {
    expect(() => validate(llama, { placement: auto, stretch: { type: "yarn", factor: 2.5 } }, gpus, all)).toThrow("whole number from 1 to 8 for llama.cpp");
    expect(() => validate(llama, { placement: auto, stretch: { type: "yarn", factor: 9 } }, gpus, all)).toThrow("whole number from 1 to 8");
    expect(() => validate(llama, { placement: auto, stretch: { type: "dynamic", factor: 2 } }, gpus, all)).toThrow("stretch.type must be yarn.");
    expect(() => validate(llama, { placement: auto, stretch: { type: "yarn", factor: 2, beta: 1 } }, gpus, all)).toThrow("Unknown stretch field: beta.");
    expect(validate(llama, { placement: auto, stretch: { type: "yarn", factor: 1 } }, gpus, all).stretch).toBeUndefined();
    expect(validate(vllm, { placement: auto, contextLength: 81920, stretch: { type: "yarn", factor: 2.5, originalContext: 32768 } }, gpus, all).stretch?.factor).toBe(2.5);
  });

  it("refuses a stretch on an embedding model, and on one whose trained length is unknown unless the original context is given", () => {
    const embed = textModel("embed", 1, { kind: "embedding" });
    expect(() => validate(embed, { placement: auto, stretch: { type: "yarn", factor: 2 } }, gpus, all)).toThrow("Only chat models can be stretched.");
    const unknown = textModel("unknown", 1, { contextLength: null });
    expect(() => validate(unknown, { placement: auto, stretch: { type: "yarn", factor: 2 } }, gpus, all)).toThrow("give the original context to stretch from");
    const given = validate(unknown, { placement: auto, contextLength: 65536, stretch: { type: "yarn", factor: 2, originalContext: 32768 } }, gpus, all);
    expect(contextOf(unknown, given)).toBe(65536);
  });

  it("refuses a stretched context whose KV cache doesn't fit, with the memory reason", () => {
    // A dense model holds KV in every layer: a million tokens won't fit on a 24 GB card.
    const dense = textModel("dense", 17, { contextLength: 262144, kvPerToken: 2 * 64 * 8 * 128 });
    expect(() => validate(dense, { placement: auto, contextLength: 1_000_000, stretch: { type: "yarn", factor: 4 } }, [gpu(0, 24)], all))
      .toThrow(/A context of 1000000 tokens needs about .* GB more than GPU 0 has; lower the context length\./);
  });
});

describe("the KV cache of a hybrid model", () => {
  it("counts only the layers that hold one, from config.json and from a GGUF", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-hybrid-"));
    mkdirSync(join(dir, "hybrid"));
    // 64 layers: 16 blocks of three linear-attention layers and one attention layer.
    const layer_types = Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? "full_attention" : "linear_attention"));
    writeFileSync(join(dir, "hybrid/config.json"), JSON.stringify({
      architectures: ["Qwen3_5ForConditionalGeneration"],
      text_config: { num_hidden_layers: 64, hidden_size: 5120, num_attention_heads: 24, num_key_value_heads: 4, head_dim: 256, layer_types, max_position_embeddings: 262144 },
    }));
    writeFileSync(join(dir, "hybrid/model.safetensors"), Buffer.alloc(16));
    writeFileSync(join(dir, "hybrid.gguf"), ggufBytes({
      "general.architecture": "qwen35", "tokenizer.ggml.model": "gpt2", "general.source.huggingface.repository": "org/hybrid",
      "qwen35.block_count": 64, "qwen35.full_attention_interval": 4, "qwen35.context_length": 262144,
      "qwen35.embedding_length": 5120, "qwen35.attention.head_count": 24, "qwen35.attention.head_count_kv": 4, "qwen35.attention.key_length": 256,
    }));
    const found = scanTextModels(dir);
    const gguf = found.find((m) => m.format === "gguf");
    const folder = found.find((m) => m.format === "safetensors");
    expect(folder!.kvPerToken).toBe(2 * 16 * 4 * 256);
    expect(gguf!.kvPerToken).toBe(2 * 16 * 4 * 256);
    expect(gguf!.identity.sourceRepo).toBe("org/hybrid");
    // A million tokens at q8_0: about 33 GB, not four times that.
    const kv = sizes(gguf!, { placement: auto, contextLength: 1_000_000, stretch: { type: "yarn", factor: 4, originalContext: 262144 }, kvCacheType: "q8_0" }).kv;
    expect(kv / GIB).toBeGreaterThan(30);
    expect(kv / GIB).toBeLessThan(35);
  });
});

// Three cards, in the shapes publishers write them.
const HYBRID_CARD = [
  "# A hybrid model", "", "Native context: 262,144 tokens. For longer texts, turn on YaRN in config.json:", "",
  "```json", "{", "    ...,", '    "rope_parameters": {', '        "rope_type": "yarn",', '        "factor": 4.0,', '        "original_max_position_embeddings": 262144', "    }", "}", "```", "",
  "With llama.cpp:", "", "```shell", "llama-server -m model.gguf -c 1010000 --rope-scaling yarn --rope-scale 4 --yarn-orig-ctx 262144", "```",
].join("\n");
const DENSE_CARD = [
  "# A dense model", "", "Add rope_scaling for up to 131,072 tokens:", "",
  "```json", "{", '  "rope_scaling": {', '    "rope_type": "yarn",', '    "factor": 4.0,', '    "original_max_position_embeddings": 32768', "  }", "}", "```", "",
  "```shell", "vllm serve org/dense --rope-scaling '{\"rope_type\":\"yarn\",\"factor\":4.0,\"original_max_position_embeddings\":32768}' --max-model-len 131072", "```",
].join("\n");
const PLAIN_CARD = "# A quantization\n\nQ4_K_M of org/base. See the base model's card for usage.\n";

describe("the card's recipe", () => {
  it("reads the native length, the factor and the stretched length", () => {
    expect(parseRecipe({ max_position_embeddings: 262144 }, HYBRID_CARD, "llamacpp")).toEqual({ native: 262144, factor: 4, originalContext: 262144, stretched: 1_010_000 });
    expect(parseRecipe({ max_position_embeddings: 40960 }, DENSE_CARD, "vllm")).toEqual({ native: 32768, factor: 4, originalContext: 32768, stretched: 131072 });
  });

  it("leaves a card with no recipe at its native length, and reads YaRN shipped on in config.json", () => {
    expect(parseRecipe({ max_position_embeddings: 32768 }, PLAIN_CARD, "llamacpp")).toEqual({ native: 32768 });
    expect(parseRecipe(null, PLAIN_CARD, "llamacpp")).toBeNull();
    expect(parseRecipe({ max_position_embeddings: 131072, rope_scaling: { type: "yarn", factor: 4, original_max_position_embeddings: 32768 } }, null, "vllm"))
      .toEqual({ native: 32768, factor: 4, originalContext: 32768, stretched: 131072 });
  });

  it("rounds a factor to llama.cpp's whole steps", () => {
    const card = "```\nllama-server -c 1010000 --yarn-orig-ctx 262144\n```";
    expect(parseRecipe({ max_position_embeddings: 262144 }, card, "llamacpp")?.factor).toBe(4);
  });

  it("reads a repository as a person or a GGUF names it", () => {
    expect(parseRepo("org/model")).toEqual({ hub: "huggingface", repo: "org/model" });
    expect(parseRepo("modelscope:org/model")).toEqual({ hub: "modelscope", repo: "org/model" });
    expect(parseRepo("https://huggingface.co/org/model")).toEqual({ hub: "huggingface", repo: "org/model" });
    expect(parseRepo("https://modelscope.cn/models/org/model")).toEqual({ hub: "modelscope", repo: "org/model" });
    expect(parseRepo("../etc/passwd")).toBeNull();
  });
});

describe("reading a card through fetch", () => {
  const open: { close(): unknown }[] = [];
  afterEach(async () => {
    for (const o of open.splice(0)) await o.close();
  });

  async function downloader(opts: Parameters<typeof fakeHub>[0]) {
    const hub = await fakeHub(opts);
    open.push(hub);
    const net = new Net({ allowed: (a) => a === "127.0.0.1" || a === "::1" || isPublic(a), ca: hub.ca });
    const models = mkdtempSync(join(tmpdir(), "lyrica-read-"));
    const d = new Downloader({
      models, data: mkdtempSync(join(tmpdir(), "lyrica-read-data-")), net,
      hubs: { huggingface: huggingFace(net, hub.base), modelscope: modelScope(net, hub.base) }, log: () => {}, free: () => 1e12,
    });
    return { d, models };
  }

  it("returns README.md as text with its revision, and writes nothing", async () => {
    const { d, models } = await downloader({ readme: HYBRID_CARD });
    const read = await d.readFile("huggingface", "org/repo", undefined, "README.md");
    expect(read).toMatchObject({ revision: "abc123", text: HYBRID_CARD, card: { baseModel: ["org/base"] } });
    expect(scanTextModels(models)).toEqual([]);
    expect(d.record()).toEqual([]);
  });

  it("refuses a file over 1 MB, and any file but the three a lookup reads", async () => {
    const { d } = await downloader({ readme: "x".repeat(2 * 1024 * 1024) });
    await expect(d.readFile("huggingface", "org/repo", undefined, "README.md")).rejects.toThrow("README.md is larger than 1 MB.");
    await expect(d.readFile("huggingface", "org/repo", undefined, "modeling.py")).rejects.toThrow("Only config.json, generation_config.json, README.md can be read.");
    // A card is readable, and still never downloadable.
    await expect(d.request({ source: "huggingface", repo: "org/repo", files: ["README.md"] })).rejects.toThrow("Only GGUF, safetensors and ONNX files");
  });
});
