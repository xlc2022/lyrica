import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlamaCpp, Vllm } from "../src/backends.ts";
import { ggufBytes } from "../src/gguf.ts";
import { scanTextModels } from "../src/library.ts";
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
    }),
  );
  mkdirSync(join(dir, "shared"), { recursive: true });
  writeFileSync(join(dir, "shared/embed-Q8_0.gguf"), ggufBytes({ "general.architecture": "qwen3", "qwen3.pooling_type": 3, "tokenizer.ggml.model": "gpt2" }));
  // An image model's GGUF has no tokenizer: not a text model.
  writeFileSync(join(dir, "shared/flux-Q4.gguf"), ggufBytes({ "general.architecture": "flux" }));
  mkdirSync(join(dir, "vllm/Qwen3-32B"), { recursive: true });
  writeFileSync(join(dir, "vllm/Qwen3-32B/config.json"), JSON.stringify({ architectures: ["Qwen3ForCausalLM"], max_position_embeddings: 32768 }));
  writeFileSync(join(dir, "vllm/Qwen3-32B/model.safetensors"), Buffer.alloc(16));
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
    expect(qwen.identity).toEqual({ basename: "Qwen3", sizeLabel: "8B", finetune: null, baseModels: [{ name: "Qwen3 8B Base", organization: "Qwen", repoUrl: null }] });
    expect(qwen.capabilities).toEqual({ tools: true, vision: false, embedding: false, reasoning: ["off", "on"] });
    expect(qwen.contextLength).toBe(40960);
    expect(models[3]!.remoteCode).toBe(true);
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

    // llama.cpp got a preset for the model on GPU 0.
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain(`[${id}]\nmodel = /models/${id}\ndevice = CUDA0\nsplit-mode = none\nc = 32768\nn-gpu-layers = 999\nflash-attn = auto`);
    const status = await call({ port: s.tls, path: "/host/v1/status", identity: s.me, pinned });
    expect(status.body.gpus[0].models[0]).toMatchObject({ id, state: "loaded", busy: false });

    const usage = await call({ port: s.tls, path: "/host/v1/usage", identity: s.me, pinned });
    expect(usage.body.models).toEqual([{ id, requests: 2, promptTokens: 14, completionTokens: 6, images: 0, seconds: expect.any(Number) }]);

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
    const saved = await put({ placement: { mode: "gpus", gpus: [0] }, contextLength: 16384, kvCacheType: "q8_0", parallel: 2 });
    expect(saved.body).toMatchObject({ contextLength: 16384, maxContextLength: 40960, placement: { mode: "gpus", gpus: [0] } });
    const got = await call({ port: s.tls, path: `/host/v1/models/settings?model=${encodeURIComponent(id)}`, identity: s.me, pinned });
    expect(got.body.settings).toEqual({ placement: { mode: "gpus", gpus: [0] }, contextLength: 16384, kvCacheType: "q8_0", parallel: 2 });
    await call({ port: s.tls, path: "/host/v1/models/load", identity: s.me, pinned, body: { model: id } });
    await put({ placement: { mode: "gpus", gpus: [0] }, contextLength: 8192 });
    // Saved settings wait for the next load; Reload applies them now.
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain("c = 16384");
    await call({ port: s.tls, path: "/host/v1/models/reload", identity: s.me, pinned, body: { model: id } });
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).toContain("c = 8192");
    expect(readFileSync(join(s.serving, "llamacpp.ini"), "utf8")).not.toContain("cache-type-k");
  });

  it("refuses a model that would need remote code", async () => {
    const s = await stack();
    const pinned = await paired(s);
    const reply = await call({ port: s.tls, path: "/v1/chat/completions", identity: s.me, pinned, body: { model: "vllm/remote", messages: [] } });
    expect(reply.body.error.code).toBe("refused");
  });
});

describe("the compose files", () => {
  it("give every model server the none log driver and keep their scratch space in memory", () => {
    for (const vendor of ["nvidia", "amd"]) {
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
      expect(services.length, vendor).toBeGreaterThanOrEqual(2);
    }
  });
});
