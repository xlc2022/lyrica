import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlamaCpp, Vllm } from "../src/backends.ts";
import { ggufBytes } from "../src/gguf.ts";
import { familyParsers, scanTextModels, templateCapabilities } from "../src/library.ts";
import { stdoutLog, type Logger } from "../src/log.ts";
import { Runtime } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { FakeGpus, fakeLlamaRouter } from "./fakes.ts";
import { call, lyrica, pair, startHost } from "./helpers.ts";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

const MARKER = "zebra-marmalade-4417";

function modelsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-models-"));
  mkdirSync(join(dir, "lyrica/huggingface/Qwen/Qwen3-8B-GGUF"), { recursive: true });
  writeFileSync(
    join(dir, "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"),
    ggufBytes({
      "general.architecture": "qwen3",
      "general.basename": "Qwen3",
      "general.size_label": "8B",
      "general.base_model.count": 1,
      "general.base_model.0.name": "Qwen3 8B Base",
      "general.base_model.0.organization": "Qwen",
      "qwen3.context_length": 40960,
      "tokenizer.ggml.model": "gpt2",
      "tokenizer.chat_template": "{% if tools %}...{% endif %}{% if enable_thinking %}<think>{% endif %}",
      "general.sampling.temp": 0.7,
      "general.sampling.top_p": 0.8,
      "general.sampling.top_k": 20,
    }),
  );
  mkdirSync(join(dir, "shared"), { recursive: true });
  writeFileSync(join(dir, "shared/embed-Q8_0.gguf"), ggufBytes({ "general.architecture": "qwen3", "qwen3.pooling_type": 3, "tokenizer.ggml.model": "gpt2" }));
  // An image model's GGUF has no tokenizer: not a text model.
  writeFileSync(join(dir, "shared/flux-Q4.gguf"), ggufBytes({ "general.architecture": "flux" }));
  mkdirSync(join(dir, "vllm/Qwen3-32B"), { recursive: true });
  writeFileSync(join(dir, "vllm/Qwen3-32B/config.json"), JSON.stringify({ architectures: ["Qwen3ForCausalLM"], max_position_embeddings: 32768 }));
  writeFileSync(join(dir, "vllm/Qwen3-32B/model.safetensors"), Buffer.alloc(16));
  writeFileSync(join(dir, "vllm/Qwen3-32B/generation_config.json"), JSON.stringify({ temperature: 0.6, top_p: 0.95, top_k: 20, repetition_penalty: 1.05, do_sample: true }));
  mkdirSync(join(dir, "vllm/remote"), { recursive: true });
  writeFileSync(join(dir, "vllm/remote/config.json"), JSON.stringify({ architectures: ["X"], auto_map: { AutoModel: "x.X" } }));
  writeFileSync(join(dir, "vllm/remote/model.safetensors"), Buffer.alloc(16));
  // A sharded model with a shard still missing isn't offered yet.
  mkdirSync(join(dir, "vllm/half"), { recursive: true });
  writeFileSync(join(dir, "vllm/half/config.json"), JSON.stringify({ architectures: ["Qwen3ForCausalLM"] }));
  writeFileSync(join(dir, "vllm/half/model-00001-of-00002.safetensors"), Buffer.alloc(16));
  writeFileSync(join(dir, "vllm/half/model.safetensors.index.json"), JSON.stringify({ weight_map: { a: "model-00001-of-00002.safetensors", b: "model-00002-of-00002.safetensors" } }));
  writeFileSync(join(dir, "shared/big-00001-of-00002.gguf"), ggufBytes({ "general.architecture": "llama", "tokenizer.ggml.model": "gpt2" }));
  return dir;
}

describe("the models folder", () => {
  it("finds GGUF and vLLM text models with their identity and capabilities", () => {
    const models = scanTextModels(modelsFolder());
    expect(models.map((m) => [m.id, m.kind, m.server])).toEqual([
      ["lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", "chat", "llamacpp"],
      ["shared/embed-Q8_0.gguf", "embedding", "llamacpp"],
      ["vllm/Qwen3-32B", "chat", "vllm"],
      ["vllm/remote", "chat", "vllm"],
    ]);
    const qwen = models[0]!;
    expect(qwen.identity).toEqual({ basename: "Qwen3", sizeLabel: "8B", finetune: null, baseModels: [{ name: "Qwen3 8B Base", organization: "Qwen", repoUrl: null }], sourceRepo: null });
    expect(qwen.capabilities).toEqual({ tools: true, vision: false, embedding: false, reasoning: ["off", "on"], opensThinking: true });
    expect(qwen.contextLength).toBe(40960);
    // The sampling its publisher recommends, which its server uses when a request sets none.
    expect(qwen.sampling).toEqual({ temperature: 0.7, topP: 0.8, topK: 20 });
    expect(models[2]!.sampling).toEqual({ temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.05 });
    expect(models[1]!.sampling).toBeUndefined();
    expect(models[3]!.remoteCode).toBe(true);
  });

  it("lists a model's vision projector and MTP file as its companions, never as models of their own", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-models-"));
    const repo = join(dir, "lyrica/huggingface/org/Model-GGUF");
    mkdirSync(join(repo, "Q4_K_M"), { recursive: true });
    mkdirSync(join(repo, "MTP"), { recursive: true });
    const chat = { "general.architecture": "qwen3", "qwen3.context_length": 40960, "tokenizer.ggml.model": "gpt2" };
    writeFileSync(join(repo, "Q4_K_M/Model-Q4_K_M.gguf"), ggufBytes(chat));
    writeFileSync(join(repo, "Model-Q8_0.gguf"), ggufBytes(chat));
    writeFileSync(join(repo, "mmproj-F32.gguf"), ggufBytes({ "general.architecture": "clip" }));
    writeFileSync(join(repo, "mmproj-F16.gguf"), ggufBytes({ "general.architecture": "clip" }));
    writeFileSync(join(repo, "MTP/mtp-Model-Q4_K_M.gguf"), ggufBytes(chat));
    writeFileSync(join(repo, "MTP/mtp-Model-Q8_0.gguf"), ggufBytes(chat));
    // A model with its own MTP layers needs no file.
    writeFileSync(join(dir, "Built-in-MTP.gguf"), ggufBytes({ ...chat, "qwen3.nextn_predict_layers": 1 }));
    const models = scanTextModels(dir);
    const base = "lyrica/huggingface/org/Model-GGUF";
    expect(models.map((m) => [m.id, m.mmproj, m.mtp ?? null, !!m.builtInMtp, m.capabilities.vision])).toEqual([
      ["Built-in-MTP.gguf", null, null, true, false],
      [`${base}/Model-Q8_0.gguf`, `${base}/mmproj-F16.gguf`, `${base}/MTP/mtp-Model-Q8_0.gguf`, false, true],
      [`${base}/Q4_K_M/Model-Q4_K_M.gguf`, `${base}/mmproj-F16.gguf`, `${base}/MTP/mtp-Model-Q4_K_M.gguf`, false, true],
    ]);
  });
});

describe("routing /v1 to the model servers", () => {
  async function stack(logger?: Logger) {
    const models = modelsFolder();
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const router = await fakeLlamaRouter();
    open.push({ close: () => router.server.close() });
    const lines: string[] = [];
    const log: Logger = logger ?? ((event, fields) => void lines.push(JSON.stringify({ event, ...fields })));
    const h = await startHost({ log, modelsDir: models });
    open.push(h.host);
    const gpus = new FakeGpus([24]);
    const llamacpp = new LlamaCpp({ url: router.url, serving, models: "/models", device: (i) => `CUDA${i}` });
    const vllm = new Vllm({ url: "http://127.0.0.1:1/{port}", serving, models: "/models" });
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp, vllm }, state: h.host.state, log });
    h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log });
    await h.host.runtime.start();
    return { ...h, me: lyrica(), lines, serving, router, gpus };
  }

  async function paired(s: Awaited<ReturnType<typeof stack>>) {
    const http = await import("node:http");
    const code: string = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: s.local, path: "/dashboard/pairing", method: "POST", headers: { host: "127.0.0.1:7236" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d).code));
      });
      r.end();
    });
    return pair(s.tls, s.me, code);
  }

  it("loads the model, streams the answer and counts tokens, with no text in logs or on disk", async () => {
    const s = await stack();
    const pinned = await paired(s);
    const id = "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";

    const listed = await call({ port: s.tls, path: "/v1/models", identity: s.me, pinned });
    expect(listed.body.data.map((m: { id: string }) => m.id)).toContain(id);

    const streamed = await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: id, stream: true, messages: [{ role: "user", content: MARKER }] } });
    expect(streamed.status).toBe(200);
    expect(streamed.body).toContain(MARKER);
    expect(streamed.body).toContain("[DONE]");

    const plain = await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: id, messages: [{ role: "user", content: MARKER }] } });
    expect(plain.body.choices[0].message.content).toBe(`echo: ${MARKER}`);

    s.router.status.set(id, "unloaded");
    const missing = await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: id, stream: true, messages: [{ role: "user", content: "retry" }] } });
    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe("model_unavailable");
    expect(s.host.runtime!.scheduler.placement(id)).toBeNull();
    await s.host.runtime!.scheduler.loadNow(scanTextModels(modelsFolder()).find((m) => m.id === id)!);

    // llama.cpp got a preset for the model on GPU 0, at its trained 40960 tokens: with none saved, the largest that fits.
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain(`[${id}]\nmodel = /models/${id}\ndevice = CUDA0\nsplit-mode = none\nc = 40960\nn-gpu-layers = 999\nflash-attn = auto\nparallel = 1\nkv-unified = true`);
    const status = await call({ port: s.tls, path: "/host/v1/status", identity: s.me, pinned });
    expect(status.body.gpus[0].models[0]).toMatchObject({ id, state: "loaded", busy: false });

    const usage = await call({ port: s.tls, path: "/host/v1/usage", identity: s.me, pinned });
    expect(usage.body.models).toEqual([{ id, requests: 2, promptTokens: 14, completionTokens: 6, images: 0, audioSeconds: 0, seconds: expect.any(Number) }]);

    expect(s.lines.join("\n")).not.toContain(MARKER);
    for (const f of readdirSync(s.dataDir)) expect(readFileSync(join(s.dataDir, f), "utf8")).not.toContain(MARKER);
    for (const f of readdirSync(s.serving)) expect(readFileSync(join(s.serving, f), "utf8")).not.toContain(MARKER);
  });

  it("writes no prompt text to its real output or anywhere on disk, on success and on errors", async () => {
    // Capture what the process itself prints, with host-api's real logger.
    const printed: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => (printed.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const s = await stack(stdoutLog);
      const pinned = await paired(s);
      const id = "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
      const ask = (content: string, extra = {}) => call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: id, messages: [{ role: "user", content }], ...extra } });
      expect((await ask(MARKER)).status).toBe(200);
      expect((await ask(`${MARKER} FAIL`)).status).toBe(500);
      await ask(`${MARKER} BREAK`, { stream: true }).catch(() => null);
      // A cut-off answer doesn't leave the model busy.
      await new Promise((r) => setTimeout(r, 50));
      expect(((await s.host.runtime!.scheduler.status())[0] as any).models[0].busy).toBe(false);
      expect((await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: `${MARKER}.gguf`, messages: [] } })).status).toBe(404);
      expect((await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: id, messages: [{ content: MARKER }], [MARKER]: 1 } })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      s.host.runtime!.flush();
      for (const dir of [s.dataDir, s.serving]) {
        for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
          if (f.isFile()) expect(await readFile(join(f.parentPath, f.name), "latin1")).not.toContain(MARKER);
        }
      }
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    expect(printed.join("")).toContain('"event":"loaded"');
    expect(printed.join("")).not.toContain(MARKER);
  });

  it("refuses work while paused, and says so plainly", async () => {
    const s = await stack();
    const pinned = await paired(s);
    expect((await call({ port: s.tls, path: "/host/v1/pause", identity: s.me, pinned, body: {} })).status).toBe(200);
    const reply = await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: "shared/embed-Q8_0.gguf", input: "x" } });
    expect(reply.status).toBe(400); // the wrong endpoint for an embedding model is checked first
    const embed = await call({ port: s.tls, path: "/v1/embeddings", identity: s.me, pinned, body: { model: "shared/embed-Q8_0.gguf", input: "x" } });
    expect(embed.status).toBe(503);
    expect(embed.body.error).toEqual({ code: "paused", message: "The model host is paused." });
    expect(s.host.state.get().paused).toBe(true);
  });

  it("serves /v1 to paired clients only, not to the dashboard", async () => {
    const s = await stack();
    const http = await import("node:http");
    const status: number = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: s.local, path: "/v1/models", headers: { host: "127.0.0.1:7236" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      r.end();
    });
    expect(status).toBe(403);
  });

  it("saves a model's settings, refuses an impossible placement, and applies them on Reload", async () => {
    const s = await stack();
    const pinned = await paired(s);
    const id = "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
    const put = (settings: object) => call({ port: s.tls, path: "/host/v1/models/settings", method: "PUT", identity: s.me, pinned, body: { model: id, settings } });
    expect((await put({ placement: { mode: "gpus", gpus: [3] } })).body.error.message).toBe("There's no GPU 3.");
    const saved = await put({ placement: { mode: "gpus", gpus: [0] }, contextLength: 16384, kvCacheType: "q8_0", flashAttention: "on", parallel: 2 });
    expect(saved.body).toMatchObject({ contextLength: 16384, maxContextLength: 40960, placement: { mode: "gpus", gpus: [0] } });
    const got = await call({ port: s.tls, path: `/host/v1/models/settings?model=${encodeURIComponent(id)}`, identity: s.me, pinned });
    expect(got.body.settings).toEqual({ placement: { mode: "gpus", gpus: [0] }, contextLength: 16384, kvCacheType: "q8_0", flashAttention: "on", parallel: 2 });
    await call({ port: s.tls, path: "/host/v1/models/load", identity: s.me, pinned, body: { model: id } });
    await put({ placement: { mode: "gpus", gpus: [0] }, contextLength: 8192 });
    // Saved settings wait for the next load; Reload applies them now.
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain("c = 16384");
    await call({ port: s.tls, path: "/host/v1/models/reload", identity: s.me, pinned, body: { model: id } });
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain("c = 8192");
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).not.toContain("cache-type-k");
  });

  it("serves a stretched model with llama.cpp's YaRN flags, and a stretch past the card's only when asked for anyway", async () => {
    const s = await stack();
    const pinned = await paired(s);
    const id = "lyrica/huggingface/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf";
    const put = (settings: object, anyway?: boolean) => call({ port: s.tls, path: "/host/v1/models/settings", method: "PUT", identity: s.me, pinned, body: { model: id, settings, ...(anyway ? { anyway } : {}) } });
    const stretch = (factor: number) => ({ placement: { mode: "auto" }, contextLength: 65536, stretch: { type: "yarn", factor, originalContext: 32768 } });
    expect((await put(stretch(2))).status).toBe(200);
    const got = await call({ port: s.tls, path: `/host/v1/models/settings?model=${encodeURIComponent(id)}`, identity: s.me, pinned });
    expect(got.body).toMatchObject({ contextLength: 65536, maxContextLength: 81920, trainedContextLength: 40960, recommended: null, stretchUntested: false });
    await call({ port: s.tls, path: "/host/v1/models/load", identity: s.me, pinned, body: { model: id } });
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain("c = 65536\nrope-scaling = yarn\nrope-scale = 2\nyarn-orig-ctx = 32768\n");
    // The card documents 2: a stretch of 3 is refused until asked for anyway.
    s.host.state.update((st) => {
      st.recommended[id] = { native: 32768, factor: 2, originalContext: 32768, stretched: 65536, source: { hub: "huggingface", repo: "Qwen/Qwen3-8B", revision: "r1", at: "2026-10-12T00:00:00Z" } };
    });
    const above = await put(stretch(3));
    expect(above.body.error).toEqual({ code: "above_recommended", message: "Qwen documents 2." });
    expect((await put(stretch(3), true)).status).toBe(200);
  });

  it("refuses a model that would need remote code", async () => {
    const s = await stack();
    const pinned = await paired(s);
    const reply = await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: "vllm/remote", messages: [] } });
    expect(reply.body.error.code).toBe("refused");
  });
});

describe("the vLLM backend", () => {
  const model = { id: "m", kind: "chat", server: "vllm", format: "safetensors", size: 1, contextLength: 4096, remoteCode: false } as never;
  const at = { gpus: [0], split: null, parallel: null, share: 0.5, need: { 0: 1 } };

  it("stops waiting as soon as the supervisor says the server exited", async () => {
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const statusPath = join(serving, "status.json");
    const vllm = new Vllm({ url: "http://127.0.0.1:1/{port}", serving, models: "/models", statusPath });
    const started = Date.now();
    const loading = vllm.load(model, at, { placement: { mode: "auto" } });
    const { attempt, maxNumSeqs } = JSON.parse(readFileSync(join(serving, "vllm.json"), "utf8")).servers.m;
    // Served at 4096 tokens, it takes one request at a time.
    expect(maxNumSeqs).toBe(1);
    writeFileSync(statusPath, JSON.stringify({ failed: { m: { attempt, exitCode: 1, crashes: 1 } } }));
    await expect(loading).rejects.toThrow("vLLM couldn't start m");
    expect(Date.now() - started).toBeLessThan(10_000);
    // It is taken out of the supervisor's file, so it isn't retried.
    expect(JSON.parse(readFileSync(join(serving, "vllm.json"), "utf8")).servers).toEqual({});
  });

  it("removes chat templates no model uses any more", async () => {
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const llama = new LlamaCpp({ url: "http://127.0.0.1:1", serving, models: "/models", device: (i) => `CUDA${i}`, loadTimeoutMs: 50 });
    await llama.load({ ...(model as object), server: "llamacpp", format: "gguf" } as never, at, { placement: { mode: "auto" }, chatTemplate: "{{ x }}" }).catch(() => {});
    expect(readdirSync(join(serving, "templates", "llamacpp"))).toEqual([]);
  });
});

describe("the compose files", () => {
  it("add only environment variables in the ROCm overlays", () => {
    for (const overlay of ["hsa", "apu"]) {
      const text = readFileSync(new URL(`../compose.${overlay}.yaml`, import.meta.url), "utf8");
      const keys = text.split("\n").filter((l) => /^ {4}[a-z_]+:/.test(l)).map((l) => l.trim().split(":")[0]);
      expect(new Set(keys), overlay).toEqual(new Set(["environment"]));
    }
  });

  it("give every model server the none log driver and keep their scratch space in memory", () => {
    for (const vendor of ["nvidia", "amd", "vulkan"]) {
      const text = readFileSync(new URL(`../compose.${vendor}.yaml`, import.meta.url), "utf8");
      const anchor = text.split("\nservices:")[0]!;
      expect(anchor, vendor).toMatch(/logging: \{ driver: none \}/);
      // Every service but host-api takes the anchor, and has tmpfs for its scratch space.
      const services = text.split("\nservices:")[1]!.split(/\n  (?=[a-z-]+:\n)/).slice(1);
      for (const block of services) {
        const name = block.split(":")[0]!;
        if (name === "host-api") continue;
        expect(block, `${vendor} ${name}`).toContain("<<: *server");
        expect(block, `${vendor} ${name}`).toMatch(/tmpfs:/);
      }
      expect(services.length, vendor).toBeGreaterThanOrEqual(vendor === "vulkan" ? 1 : 2);
    }
  });
});

it("refuses a llama.cpp child that died during loading", async () => {
  const router = await fakeLlamaRouter("unloaded");
  open.push({ close: () => new Promise<void>((r) => router.server.close(() => r())) });
  const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
  const backend = new LlamaCpp({ url: router.url, serving, models: "/models", device: () => "CUDA0", loadTimeoutMs: 1000 });
  const model = scanTextModels(modelsFolder())[0]!;
  await expect(backend.load(model, { gpus: [0], split: null, parallel: null, share: null, need: {} }, { placement: { mode: "auto" } })).rejects.toMatchObject({ code: "model_unavailable" });
});

it("selects family parsers without advertising unknown tool formats", () => {
  expect(familyParsers("Qwen3_5ForConditionalGeneration")).toEqual({ toolCallParser: "hermes", reasoningParser: "qwen3" });
  expect(familyParsers("qwen2")).toEqual({ toolCallParser: "hermes" });
  expect(familyParsers("Unknown")).toEqual({});
});

it("uses DeepSeek reasoning only for R1 models", () => {
  expect(familyParsers("deepseek_v3")).toEqual({ toolCallParser: "deepseek_v3" });
  expect(familyParsers("deepseek_r1")).toEqual({ toolCallParser: "deepseek_v3", reasoningParser: "deepseek_r1" });
  expect(familyParsers("deepseek_v3", "DeepSeek-R1-Distill")).toEqual({ toolCallParser: "deepseek_v3", reasoningParser: "deepseek_r1" });
});

it("offers a thinking switch only for templates that read enable_thinking, and says which open the tag", () => {
  expect(templateCapabilities("{% if enable_thinking %}<think>{% endif %}").reasoning).toEqual(["off", "on"]);
  // DeepSeek R1's template opens <think> itself: the model always thinks, so there's nothing to switch.
  expect(templateCapabilities("{{ '<|Assistant|>' }}<think>\n")).toMatchObject({ reasoning: null, opensThinking: true });
  expect(templateCapabilities("{{ messages }}").reasoning).toBeNull();
});

it("uses the Llama tool parser only for Llama 3.x families", () => {
  for (const family of ["llama3", "llama-3", "llama3.1", "Llama_3_2ForCausalLM"]) {
    expect(familyParsers(family)).toEqual({ toolCallParser: "llama3_json" });
  }
  for (const family of ["llama", "llama2", "llama-2"]) expect(familyParsers(family)).toEqual({});
  // Llama 3's config.json says only "llama": the model's name decides.
  expect(familyParsers("llama", "Meta-Llama-3.1-8B-Instruct")).toEqual({ toolCallParser: "llama3_json" });
  expect(familyParsers("llama", "Llama-2-7b-chat-hf")).toEqual({});
});

it("reads vLLM parsers and tool support from config families", () => {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-families-"));
  for (const [name, config] of Object.entries({ qwen25: { model_type: "qwen2", architectures: ["Qwen2ForCausalLM"] }, qwen3: { architectures: ["Qwen3ForCausalLM"] }, llama2: { model_type: "llama2", architectures: ["LlamaForCausalLM"] }, llama: { model_type: "llama", architectures: ["LlamaForCausalLM"] }, "DeepSeek-R1": { model_type: "deepseek_v3", architectures: ["DeepseekV3ForCausalLM"] }, unknown: { model_type: "unknown", architectures: ["UnknownForCausalLM"] } })) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "config.json"), JSON.stringify(config));
    writeFileSync(join(dir, name, "model.safetensors"), Buffer.alloc(16));
    writeFileSync(join(dir, name, "chat_template.jinja"), "{% if tools %}tools{% endif %}");
  }
  const models = scanTextModels(dir);
  expect(models.find((m) => m.id === "qwen25")).toMatchObject({ toolCallParser: "hermes", capabilities: { tools: true } });
  expect(models.find((m) => m.id === "qwen25")!.reasoningParser).toBeUndefined();
  expect(models.find((m) => m.id === "qwen3")).toMatchObject({ toolCallParser: "hermes", reasoningParser: "qwen3", capabilities: { tools: true } });
  for (const id of ["unknown", "llama2", "llama"]) {
    expect(models.find((m) => m.id === id)!.capabilities.tools).toBe(false);
    expect(models.find((m) => m.id === id)!.toolCallParser).toBeUndefined();
  }
  expect(models.find((m) => m.id === "DeepSeek-R1")!.reasoningParser).toBe("deepseek_r1");
});
