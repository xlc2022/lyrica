import { describe, expect, it } from "vitest";
import { TEXT_STARTERS, listStarters, starterFiles, type StarterHost } from "../src/text-starters.ts";

const GiB = 2 ** 30;
const gpu = (gb: number, servers = ["llamacpp", "vllm", "speech"]) => ({ vram: { total: gb * GiB }, settings: { servers, keepFree: 0, excluded: false } });
const host = (o: Partial<StarterHost> = {}): StarterHost => ({ servers: ["llamacpp", "vllm", "speech"], cpuServers: [], dictation: "vllm", gpus: [gpu(24)], systemRam: { allowance: 0 }, ...o });
const byId = (list: ReturnType<typeof listStarters>) => new Map(list.map((s) => [s.id, s]));

describe("text starters", () => {
  it("lists only what the host's servers run, with one dictation server", () => {
    const ids = listStarters(host({ servers: ["llamacpp"] }), new Set(), new Set()).map((s) => s.id);
    expect(ids).toContain("qwen3.8-27b");
    expect(ids).not.toContain("kokoro-82m");
    expect(ids).not.toContain("voxtral-mini-4b-realtime");
    const cmp = listStarters(host({ dictation: "whispercpp" }), new Set(), new Set()).map((s) => s.id);
    expect(cmp).toContain("whisper-large-v3-turbo-cpp");
    expect(cmp).not.toContain("whisper-large-v3-turbo");
  });

  it("says where each would run: GPUs, GPUs and system RAM, the CPU, or too big", () => {
    const one = byId(listStarters(host(), new Set(), new Set()));
    expect(one.get("qwen3.8-27b")!.fits).toBe("gpu");
    expect(one.get("glm-5.3-flash-q3")!.fits).toBe("too_big");
    // llama.cpp splits over both GPUs and can spill into the allowance; the others use one GPU.
    const two = byId(listStarters(host({ gpus: [gpu(96), gpu(96)], systemRam: { allowance: 64 * GiB } }), new Set(), new Set()));
    expect(two.get("glm-5.3-flash-q3")!.fits).toBe("gpu");
    expect(two.get("glm-5.3-flash-q4")!.fits).toBe("ram");
    const cpu = byId(listStarters(host({ cpuServers: ["speech"] }), new Set(), new Set()));
    expect(cpu.get("kokoro-82m")!.fits).toBe("cpu");
  });

  it("lists the SGLang starter only where SGLang runs, fitting across the GPUs that allow vLLM", () => {
    const two = { gpus: [gpu(96), gpu(96)] };
    expect(listStarters(host(two), new Set(), new Set()).map((s) => s.id)).not.toContain("glm-5.3-flash-nvfp4");
    const nvfp4 = byId(listStarters(host({ ...two, engines: ["sglang"] }), new Set(), new Set())).get("glm-5.3-flash-nvfp4")!;
    expect(nvfp4).toMatchObject({ server: "vllm", engine: "sglang", vision: true, fits: "gpu" });
    expect(byId(listStarters(host({ gpus: [gpu(96)], engines: ["sglang"] }), new Set(), new Set())).get("glm-5.3-flash-nvfp4")!.fits).toBe("too_big");
  });

  it("marks a starter here once its model is in the folder, and downloading while its files are on the way", () => {
    const qwen = TEXT_STARTERS.find((s) => s.id === "qwen3.5-9b")!;
    const list = byId(listStarters(host(), new Set([qwen.model]), new Set(["lyrica/huggingface/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"])));
    expect(list.get("qwen3.5-9b")!.state).toBe("here");
    expect(list.get("qwen3-embedding-0.6b")!.state).toBe("downloading");
    expect(list.get("qwen3.5-4b")!.state).toBe("available");
    expect(list.get("qwen3.5-9b")).toMatchObject({ variantOf: "Qwen3.5", variant: "9B", vision: true });
  });

  it("downloads the files not here yet, and refuses a starter whose repository lost one", () => {
    const s = TEXT_STARTERS.find((x) => x.id === "whisper-large-v3-turbo")!;
    const files = starterFiles(s, { files: [
      { path: "model.safetensors", allowed: true, present: false },
      { path: "config.json", allowed: true, present: true },
      { path: "tokenizer.json", allowed: true, present: false },
      { path: "README.md", allowed: true, present: false },
    ] });
    expect(files).toEqual(["model.safetensors", "tokenizer.json"]);
    expect(() => starterFiles(s, { files: [] })).toThrow(/no longer has model.safetensors/);
  });
});
