// Dictation and Lyrica's voice: the models folder finds Whisper and Kokoro,
// and host-api passes /v1/audio requests through, counting audio, keeping
// nothing, and cancelling when the client goes away.
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QWEN_CLONE_VOICES, scanTextModels, type TextModel } from "../src/library.ts";
import { CPU_OPTION, batchOf, contextOf, defaultGpu, options, sizes, validate, type GpuSettings } from "../src/placement.ts";
import { Runtime, wavSeconds } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Speech } from "../src/speech.ts";
import { WhisperCpp } from "../src/whispercpp.ts";
import { StateFile } from "../src/state.ts";
import { FakeBackend, FakeGpus } from "./fakes.ts";
import { call, lyrica, pair, startHost } from "./helpers.ts";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

const MARKER = "quokka-lantern-9931";
const KOKORO = "lyrica/huggingface/onnx-community/Kokoro-82M-v1.1-zh-ONNX";
const WHISPER = "lyrica/huggingface/openai/whisper-large-v3-turbo";
const VOXTRAL = "lyrica/huggingface/mistralai/Voxtral-Mini-4B-Realtime-2602";

function modelsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-models-"));
  mkdirSync(join(dir, KOKORO, "onnx"), { recursive: true });
  mkdirSync(join(dir, KOKORO, "voices"), { recursive: true });
  writeFileSync(join(dir, KOKORO, "onnx/model.onnx"), Buffer.from([0x08, 0x08, 0, 0]));
  writeFileSync(join(dir, KOKORO, "onnx/model_q8f16.onnx"), Buffer.from([0x08, 0x08]));
  writeFileSync(join(dir, KOKORO, "config.json"), JSON.stringify({ vocab: { a: 1, "ㄅ": 2 } }));
  // English, Mandarin, and a Japanese voice the speech server can't read.
  for (const v of ["af_heart", "bm_george", "zf_xiaoxiao", "jf_alpha"]) writeFileSync(join(dir, KOKORO, `voices/${v}.bin`), Buffer.alloc(1024));
  mkdirSync(join(dir, WHISPER), { recursive: true });
  writeFileSync(join(dir, WHISPER, "config.json"), JSON.stringify({ architectures: ["WhisperForConditionalGeneration"], max_target_positions: 448, decoder_layers: 4, d_model: 1280, decoder_attention_heads: 20 }));
  writeFileSync(join(dir, WHISPER, "model.safetensors"), Buffer.alloc(16));
  mkdirSync(join(dir, VOXTRAL), { recursive: true });
  writeFileSync(join(dir, VOXTRAL, "config.json"), JSON.stringify({ architectures: ["VoxtralRealtimeForConditionalGeneration"], downsample_factor: 4, audio_config: { num_hidden_layers: 32, hidden_size: 1280, num_attention_heads: 32, num_key_value_heads: 32, head_dim: 64, sliding_window: 750 }, text_config: { sliding_window: 8192, max_position_embeddings: 131072, num_hidden_layers: 26, hidden_size: 3072, num_attention_heads: 32, num_key_value_heads: 8, head_dim: 128 } }));
  writeFileSync(join(dir, VOXTRAL, "consolidated.safetensors"), Buffer.alloc(16));
  return dir;
}

/** One second of 16 kHz mono 16-bit silence, as a WAV file. */
function wav(seconds = 1): Buffer {
  const data = 16000 * 2 * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data, 40);
  return Buffer.concat([h, Buffer.alloc(data)]);
}

/** A fake speech server and vLLM: PCM in two chunks, a transcript, and what they were sent. */
async function fakeAudio() {
  const seen: { path: string; body: Buffer; type: string }[] = [];
  let closed = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ path: req.url!, body, type: req.headers["content-type"] ?? "" });
    if (req.url === "/v1/audio/speech") {
      const { input } = JSON.parse(body.toString());
      res.writeHead(200, { "content-type": "audio/pcm;rate=24000" });
      res.write(Buffer.alloc(24000 * 2)); // one second
      if (input.includes("SLOW")) return void res.on("close", () => closed++);
      return void res.end(Buffer.alloc(24000)); // and half a second
    }
    if (req.url === "/v1/audio/transcriptions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "hello" }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, closed: () => closed, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

class AudioBackend extends FakeBackend {
  private readonly at: string;
  constructor(gpus: FakeGpus, at: string) {
    super(gpus);
    this.at = at;
  }
  override url() {
    return this.at;
  }
}

describe("the models folder", () => {
  it("finds Whisper and Voxtral for dictation and Kokoro's voices in the languages Lyrica speaks", () => {
    const models = scanTextModels(modelsFolder());
    expect(models.map((m) => [m.id, m.kind, m.server, m.format])).toEqual([
      [VOXTRAL, "transcribe", "vllm", "safetensors"],
      [KOKORO, "speak", "speech", "onnx"],
      [WHISPER, "transcribe", "vllm", "safetensors"],
    ]);
    expect(models[0]!.capabilities.transcribe).toBe(true);
    expect(models[0]!.contextLength).toBe(131072);
    models.shift();
    expect(models[0]!.onnx).toBe("onnx/model.onnx");
    expect(models[0]!.capabilities.speak).toEqual({
      voices: [{ id: "af_heart", language: "en" }, { id: "bm_george", language: "en" }, { id: "zf_xiaoxiao", language: "zh" }],
    });
    expect(models[1]!.capabilities.transcribe).toBe(true);
    expect(models[1]!.contextLength).toBe(448);
  });

  it("sizes Voxtral's cache as vLLM does, and gives it a share that fits a 16 or 24 GB card", () => {
    const voxtral = { ...scanTextModels(modelsFolder()).find((m) => m.id === VOXTRAL)!, size: 8_874_376_582 };
    const auto = { placement: { mode: "auto" as const } };
    // vLLM 0.32 on a 3090 with its default batch of 2,048: 3.83 GiB at 3,456 tokens, 5.72 GiB at 16k and at 32k.
    const kv = (contextLength: number, batchSize?: number) => sizes(voxtral, { ...auto, contextLength, batchSize }).kv / 2 ** 30;
    expect(kv(3456, 2048)).toBeCloseTo(3.83, 1);
    expect(kv(16384, 2048)).toBeCloseTo(5.72, 1);
    expect(kv(32768, 2048)).toBeCloseTo(5.72, 1);
    // Lyrica's batch of 512 keeps it near 2.3 GiB, whatever the context.
    expect(batchOf(voxtral, auto)).toBe(512);
    expect(kv(16384)).toBeCloseTo(2.3, 1);
    const share = (gb: number) =>
      options(voxtral, auto, [{ index: 0, name: "GPU", vendor: "nvidia", total: gb * 2 ** 30, used: 0 }], () => defaultGpu())[0]!.share;
    expect(contextOf(voxtral, auto)).toBe(16384);
    expect(share(24)).toBe(0.6);
    expect(share(16)).toBe(0.85);
  });

  it("measures a WAV clip from its header", () => {
    expect(wavSeconds(wav(2))).toBe(2);
    expect(wavSeconds(Buffer.from("not audio"))).toBe(0);
  });
});

describe("voice placement", () => {
  const gpus = [0, 1].map((index) => ({ index, name: "GPU", vendor: "nvidia" as const, total: 24 * 1024 ** 3, used: 0 }));
  const all = (): GpuSettings => ({ excluded: false, keepFree: 0, servers: ["llamacpp", "vllm", "speech"] });
  const kokoro = (): TextModel => scanTextModels(modelsFolder()).find((m) => m.kind === "speak")!;

  it("takes one GPU or Auto, and only Auto when voices run on the CPU", () => {
    expect(validate(kokoro(), { placement: { mode: "gpus", gpus: [1] } }, gpus, all)).toEqual({ placement: { mode: "gpus", gpus: [1] } });
    expect(() => validate(kokoro(), { placement: { mode: "gpus", gpus: [0, 1] } }, gpus, all)).toThrow("A voice model runs on one GPU.");
    expect(() => validate(kokoro(), { placement: { mode: "auto" }, contextLength: 4096 }, gpus, all)).toThrow("contextLength isn't a setting for a voice model");
    expect(validate(kokoro(), { placement: { mode: "auto" } }, [], all, true)).toEqual({ placement: { mode: "auto" } });
    expect(() => validate(kokoro(), { placement: { mode: "gpus", gpus: [0] } }, gpus, all, true)).toThrow("run on the CPU on this host");
  });

  it("allows speech on GPUs saved before it existed, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-state-"));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ gpuSettings: { 0: { excluded: false, servers: ["llamacpp", "vllm"] }, 1: { excluded: false, servers: ["llamacpp"] } }, usage: { m: { requests: 1, promptTokens: 0, completionTokens: 0, images: 0, seconds: 1 } } }));
    const state = new StateFile(dir);
    expect(state.get().gpuSettings[0]!.servers).toEqual(["llamacpp", "vllm", "speech"]);
    expect(state.get().gpuSettings[1]!.servers).toEqual(["llamacpp"]);
    expect(state.get().usage.m!.audioSeconds).toBe(0);
    // Taken off again by hand, it stays off.
    state.update((s) => void (s.gpuSettings[0]!.servers = ["llamacpp", "vllm"]));
    expect(new StateFile(dir).get().gpuSettings[0]!.servers).toEqual(["llamacpp", "vllm"]);
  });
});

describe("/v1/audio", () => {
  async function stack(cpu: boolean) {
    const models = modelsFolder();
    const audio = await fakeAudio();
    open.push({ close: () => audio.server.close() });
    const lines: string[] = [];
    const log = (event: string, fields?: object) => void lines.push(JSON.stringify({ event, ...fields }));
    const h = await startHost({ log, modelsDir: models });
    open.push(h.host);
    const gpus = new FakeGpus([24]);
    const backend = new AudioBackend(gpus, audio.url);
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: backend, vllm: backend, speech: backend }, state: h.host.state, log, cpuServers: cpu ? ["speech"] : [] });
    h.host.runtime = new Runtime({ scheduler, modelsDir: models, state: h.host.state, log });
    await h.host.runtime.start();
    const me = lyrica();
    const code: string = await new Promise((resolve) => {
      http.request({ host: "127.0.0.1", port: h.local, path: "/dashboard/pairing", method: "POST", headers: { host: "127.0.0.1:7236" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d).code));
      }).end();
    });
    const pinned = await pair(h.tls, me, code);
    const api = (path: string, more: object = {}) => call({ port: h.tls, path, identity: me, pinned, ...more });
    return { ...h, me, pinned, api, audio, backend, gpus, lines };
  }

  it("lists the voices, speaks on the CPU, and counts the audio, with no text in logs or on disk", async () => {
    const s = await stack(true);
    const listed = await s.api("/host/v1/models");
    const kokoro = listed.body.models.find((m: { id: string }) => m.id === KOKORO);
    expect(kokoro).toMatchObject({ kind: "speak", server: "speech", format: "onnx", contextLength: null });
    expect(kokoro.capabilities.speak.voices).toContainEqual({ id: "zf_xiaoxiao", language: "zh" });
    expect((await s.api("/host/v1/status")).body.cpuServers).toEqual(["speech"]);

    const spoken = await s.api("/v1/audio/speech", { body: { model: KOKORO, input: MARKER, voice: "zf_xiaoxiao" } });
    expect(spoken.status).toBe(200);
    expect(spoken.headers["content-type"]).toBe("audio/pcm;rate=24000");
    // Loaded with no GPU, and only the fields it reads passed on.
    expect(s.backend.calls).toEqual([`load ${KOKORO}@`]);
    expect(JSON.parse(s.audio.seen[0]!.body.toString())).toEqual({ model: KOKORO, input: MARKER, voice: "zf_xiaoxiao", speed: 1 });

    const usage = await s.api("/host/v1/usage");
    expect(usage.body.models).toEqual([{ id: KOKORO, requests: 1, promptTokens: 0, completionTokens: 0, images: 0, audioSeconds: 1.5, seconds: expect.any(Number) }]);
    expect(s.lines.join("\n")).not.toContain(MARKER);
    for (const f of readdirSync(s.dataDir)) expect(readFileSync(join(s.dataDir, f), "utf8")).not.toContain(MARKER);
  });

  it("refuses a voice the model doesn't have, a speed out of range and the wrong kind of model", async () => {
    const s = await stack(true);
    const voice = await s.api("/v1/audio/speech", { body: { model: KOKORO, input: "hi", voice: "jf_alpha" } });
    expect(voice.status).toBe(400);
    expect(voice.body.error.message).toContain("af_heart, bm_george, zf_xiaoxiao");
    const speed = await s.api("/v1/audio/speech", { body: { model: KOKORO, input: "hi", voice: "af_heart", speed: 9 } });
    expect(speed.body.error).toMatchObject({ code: "invalid", message: "speed is from 0.25 to 4." });
    const format = await s.api("/v1/audio/speech", { body: { model: KOKORO, input: "hi", voice: "af_heart", response_format: "mp3" } });
    expect(format.status).toBe(400);
    const kind = await s.api("/v1/audio/speech", { body: { model: WHISPER, input: "hi", voice: "af_heart" } });
    expect(kind.body.error.message).toBe("That model is for dictation, not speech.");
    expect(s.audio.seen).toEqual([]);
  });

  it("passes dictation to vLLM as it was sent, and counts the clip's length", async () => {
    const s = await stack(false);
    const form = new FormData();
    form.set("file", new Blob([wav(3)], { type: "audio/wav" }), "clip.wav");
    form.set("model", WHISPER);
    form.set("language", "zh");
    const r = new Request("http://x", { method: "POST", body: form });
    const raw = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get("content-type")!;

    const heard = await s.api("/v1/audio/transcriptions", { raw, headers: { "content-type": type } });
    expect(heard.status).toBe(200);
    expect(heard.body).toEqual({ text: "hello" });
    expect(s.audio.seen[0]!.body.equals(raw)).toBe(true);
    expect(s.audio.seen[0]!.type).toBe(type);
    expect(s.backend.calls).toEqual([`load ${WHISPER}@0`]);
    expect((await s.api("/host/v1/usage")).body.models[0]).toMatchObject({ id: WHISPER, requests: 1, audioSeconds: 3 });

    const json = await s.api("/v1/audio/transcriptions", { body: { model: WHISPER } });
    expect(json.body.error.message).toContain("multipart/form-data");
  });

  it("stops speaking when the client goes away", async () => {
    const s = await stack(true);
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port: s.tls, path: "/v1/audio/speech", method: "POST", headers: { "content-type": "application/json" }, key: s.me.key, cert: s.me.cert, rejectUnauthorized: false, agent: false },
        (res) => res.once("data", () => (req.destroy(), resolve())),
      );
      req.on("error", () => {});
      req.end(JSON.stringify({ model: KOKORO, input: "SLOW", voice: "af_heart" }));
      setTimeout(() => reject(new Error("no audio")), 5000);
    });
    for (let i = 0; i < 100 && !s.audio.closed(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.audio.closed()).toBe(1);
  });
});

const QWEN_CV = "lyrica/huggingface/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice";
const QWEN_BASE = "lyrica/huggingface/Qwen/Qwen3-TTS-12Hz-1.7B-Base";

/** Qwen3-TTS CustomVoice and Base folders, and one whose speech tokenizer hasn't arrived yet. */
function qwenFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyrica-models-"));
  const folder = (id: string, config: object, tokenizer = true) => {
    mkdirSync(join(dir, id, "speech_tokenizer"), { recursive: true });
    writeFileSync(join(dir, id, "config.json"), JSON.stringify({ model_type: "qwen3_tts", ...config }));
    writeFileSync(join(dir, id, "model.safetensors"), Buffer.alloc(1000));
    if (tokenizer) writeFileSync(join(dir, id, "speech_tokenizer/model.safetensors"), Buffer.alloc(200));
  };
  folder(QWEN_CV, { tts_model_type: "custom_voice", talker_config: { spk_id: { vivian: 3065, uncle_fu: 3010, ryan: 3061 } } });
  folder(QWEN_BASE, { tts_model_type: "base", talker_config: { spk_id: {} } });
  folder("lyrica/partial", { tts_model_type: "base" }, false);
  return dir;
}

describe("Qwen3-TTS voices", () => {
  it("are found in CustomVoice (its speakers) and Base (the built-in clips) folders, each in both languages", () => {
    const models = scanTextModels(qwenFolder());
    expect(models.map((m) => [m.id, m.kind, m.server, m.format, m.qwenTts, m.size])).toEqual([
      [QWEN_BASE, "speak", "speech", "safetensors", "base", 1200],
      [QWEN_CV, "speak", "speech", "safetensors", "custom_voice", 1200],
    ]);
    const ids = (m: TextModel, language: string) => m.capabilities.speak!.voices.filter((v) => v.language === language).map((v) => v.id);
    expect(ids(models[0]!, "en")).toEqual(["Friend"]);
    expect(ids(models[0]!, "zh")).toEqual(["Friend"]);
    expect(ids(models[1]!, "en")).toEqual(["Vivian", "Uncle_Fu", "Ryan"]);
    expect(ids(models[1]!, "zh")).toEqual(["Vivian", "Uncle_Fu", "Ryan"]);
    // Placement counts what the server holds beyond the files: the CUDA graphs, and Base's speaker encoder.
    expect(sizes(models[0]!, {} as Parameters<typeof sizes>[1]).weights).toBe(Math.round(1200 * 1.1 + 1024 ** 3));
  });

  it("clone the clips the Qwen3-TTS image carries, each with its transcript", () => {
    const voices = readdirSync(new URL("../speech-qwen/voices", import.meta.url).pathname).sort();
    expect(voices).toEqual(QWEN_CLONE_VOICES.flatMap((v) => [`${v}.txt`, `${v}.wav`]).sort());
  });

  it("load on their own server, on a GPU, and Kokoro's on its own", async () => {
    const sent: { at: string; path?: string; body: unknown }[] = [];
    const serve = async (at: string) => {
      const server = http.createServer(async (req, res) => {
        let d = "";
        for await (const c of req) d += c;
        if (req.url === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
        sent.push({ at, path: req.url, body: JSON.parse(d) });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      open.push({ close: () => server.close() });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const kokoroUrl = await serve("kokoro");
    const qwenUrl = await serve("qwen");
    const speech = new Speech({ url: kokoroUrl, qwenUrl, models: "/models" });
    const qwen = scanTextModels(qwenFolder()).find((m) => m.qwenTts === "custom_voice")!;
    const kokoro = scanTextModels(modelsFolder()).find((m) => m.kind === "speak")!;
    await speech.load(qwen, { ...CPU_OPTION, gpus: [1] });
    await speech.load(kokoro, { ...CPU_OPTION, gpus: [0] });
    await speech.unload(qwen);
    await speech.reset();
    expect(sent).toEqual([
      { at: "qwen", path: "/load", body: { name: QWEN_CV, folder: `/models/${QWEN_CV}`, device: 1 } },
      { at: "kokoro", path: "/load", body: { name: KOKORO, folder: `/models/${KOKORO}`, file: "onnx/model.onnx", device: 0 } },
      { at: "qwen", path: "/unload", body: { name: QWEN_CV } },
      { at: "kokoro", path: "/reset", body: {} },
      { at: "qwen", path: "/reset", body: {} },
    ]);
    // Kokoro's server down: Qwen's still lets go, and the failure is still reported.
    sent.length = 0;
    const kokoroDown = new Speech({ url: "http://127.0.0.1:1", qwenUrl, models: "/models" });
    await expect(kokoroDown.reset()).rejects.toThrow();
    expect(sent).toEqual([{ at: "qwen", path: "/reset", body: {} }]);
    expect(speech.url(qwen)).toBe(qwenUrl);
    expect(speech.url(kokoro)).toBe(kokoroUrl);
    // Never on the CPU, and not at all on a host without NVIDIA GPUs.
    await expect(speech.load(qwen, CPU_OPTION)).rejects.toMatchObject({ status: 503, code: "model_unavailable" });
    const noNvidia = new Speech({ url: kokoroUrl, models: "/models" });
    await expect(noNvidia.load(qwen, { ...CPU_OPTION, gpus: [0] })).rejects.toMatchObject({ status: 503, code: "model_unavailable", message: expect.stringMatching(/NVIDIA/) });
  });
});

describe("the speech server's client", () => {
  it("loads on a GPU or the CPU, and answers model_unavailable when the server fails or is gone", async () => {
    const sent: unknown[] = [];
    const server = http.createServer(async (req, res) => {
      let d = "";
      for await (const c of req) d += c;
      if (req.url === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      sent.push({ path: req.url, ...JSON.parse(d) });
      if (JSON.parse(d).name === "broken") return void res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unavailable", message: "The voice model has no vocabulary." } }));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    open.push({ close: () => server.close() });
    const speech = new Speech({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, models: "/models" });
    const kokoro = scanTextModels(modelsFolder()).find((m) => m.kind === "speak")!;
    await speech.load(kokoro, { ...CPU_OPTION, gpus: [1] });
    await speech.load(kokoro, CPU_OPTION);
    expect(sent).toEqual([
      { path: "/load", name: KOKORO, folder: `/models/${KOKORO}`, file: "onnx/model.onnx", device: 1 },
      { path: "/load", name: KOKORO, folder: `/models/${KOKORO}`, file: "onnx/model.onnx", device: "cpu" },
    ]);
    await expect(speech.load({ ...kokoro, id: "broken" }, CPU_OPTION)).rejects.toMatchObject({ status: 503, code: "model_unavailable", message: "The voice model has no vocabulary." });
    const gone = new Speech({ url: "http://127.0.0.1:1", models: "/models" });
    await expect(gone.unload(kokoro)).rejects.toMatchObject({ status: 503, code: "model_unavailable" });
  });
});

describe("dictation on whisper.cpp", () => {
  const WHISPER_CPP = "lyrica/huggingface/ggerganov/whisper.cpp/ggml-large-v3-turbo-q8_0.bin";
  /** The models folder with a whisper.cpp file, and one named like it that isn't. */
  function withWhisperCpp(): string {
    const dir = modelsFolder();
    mkdirSync(join(dir, WHISPER_CPP, ".."), { recursive: true });
    const magic = Buffer.alloc(4);
    magic.writeUInt32LE(0x67676d6c);
    writeFileSync(join(dir, WHISPER_CPP), Buffer.concat([magic, Buffer.alloc(60)]));
    writeFileSync(join(dir, WHISPER_CPP, "..", "ggml-pickled.bin"), Buffer.concat([Buffer.from([0x80, 0x04]), Buffer.alloc(62)]));
    return dir;
  }

  it("lists a whisper.cpp file by its magic, under the GPUs' speech setting", () => {
    const models = scanTextModels(withWhisperCpp());
    const found = models.filter((m) => m.server === "whispercpp");
    expect(found.map((m) => [m.id, m.kind, m.format])).toEqual([[WHISPER_CPP, "transcribe", "ggml"]]);
    expect(found[0]!.capabilities.transcribe).toBe(true);
    const gpus = [{ index: 0, name: "GPU", vendor: "nvidia" as const, total: 16 * 1024 ** 3, used: 0 }];
    const all = (): GpuSettings => ({ excluded: false, keepFree: 0, servers: ["llamacpp", "speech"] });
    expect(() => validate(found[0]!, { placement: { mode: "auto" }, contextLength: 448 }, gpus, all)).toThrow("contextLength isn't a setting for a dictation model");
  });

  it("is listed only on a host that runs whisper.cpp, where it is the dictation server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrica-state-"));
    const gpus = new FakeGpus([16]);
    const serves = (whispercpp: boolean) => {
      const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: new FakeBackend(gpus), vllm: new FakeBackend(gpus), ...(whispercpp ? { whispercpp: new FakeBackend(gpus) } : {}) }, state: new StateFile(dir), log: () => {} });
      const runtime = new Runtime({ scheduler, modelsDir: withWhisperCpp(), state: new StateFile(dir), log: () => {} });
      runtime.scan();
      return { dictation: scheduler.dictation, listed: runtime.models.some((m) => m.id === WHISPER_CPP) };
    };
    expect(serves(true)).toEqual({ dictation: "whispercpp", listed: true });
    expect(serves(false)).toEqual({ dictation: "vllm", listed: false });
  });

  it("loads a second whisper.cpp model in place of the first, and the first again when asked", async () => {
    const dir = withWhisperCpp();
    const second = WHISPER_CPP.replace("q8_0", "q5_0");
    writeFileSync(join(dir, second), readFileSync(join(dir, WHISPER_CPP)));
    const gpus = new FakeGpus([16]);
    const whispercpp = new FakeBackend(gpus);
    const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp: new FakeBackend(gpus), vllm: new FakeBackend(gpus), whispercpp }, state: new StateFile(mkdtempSync(join(tmpdir(), "lyrica-state-"))), log: () => {} });
    await scheduler.start([]);
    const [a, b] = [WHISPER_CPP, second].map((id) => scanTextModels(dir).find((m) => m.id === id)!);
    await scheduler.pin(a!, true);
    await scheduler.run(b!, "chat", async () => {});
    await scheduler.run(a!, "chat", async () => {});
    expect(whispercpp.calls).toEqual([`load ${WHISPER_CPP}@0`, `unload ${WHISPER_CPP}`, `load ${second}@0`, `unload ${second}`, `load ${WHISPER_CPP}@0`]);
  });

  it("starts whisper-server for the model and GPU, and fails a load whose server exits", async () => {
    const server = http.createServer((req, res) => void res.writeHead(req.url === "/health" ? 200 : 404).end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    open.push({ close: () => server.close() });
    const serving = mkdtempSync(join(tmpdir(), "lyrica-serving-"));
    const status = join(serving, "status.json");
    const whisper = new WhisperCpp(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { serving, status, models: "/models", startMs: 3000 });
    const model = scanTextModels(withWhisperCpp()).find((m) => m.server === "whispercpp")!;
    const asked = () => JSON.parse(readFileSync(join(serving, "whisper.json"), "utf8"));
    expect(asked()).toEqual({ run: false });
    // Stands in for gate.sh: reports the attempt it started, then that it exited.
    const gate = (exited?: number) => {
      const timer = setInterval(() => {
        const a = asked();
        if (a.run) writeFileSync(status, JSON.stringify({ attempt: a.attempt, ...(exited !== undefined ? { exited } : {}) }));
      }, 20);
      return () => clearInterval(timer);
    };
    let stop = gate();
    await whisper.load(model, { ...CPU_OPTION, gpus: [1] });
    stop();
    expect(asked()).toMatchObject({ run: true, args: ["-m", `/models/${WHISPER_CPP}`, "--device", "1"] });
    expect(whisper.url(model)).toMatch(/^http:/);
    expect(() => whisper.url({ ...model, id: "other.bin" })).toThrow("running another model");
    writeFileSync(status, "{}");
    await whisper.unload(model);
    expect(asked()).toEqual({ run: false });
    stop = gate(1);
    await expect(whisper.load(model, { ...CPU_OPTION, gpus: [0] })).rejects.toMatchObject({ status: 503, code: "model_unavailable", message: "whisper.cpp couldn't load this model." });
    stop();
    expect(asked()).toEqual({ run: false });
  });
});
