// The speech servers: Kokoro's (host/speech/server.py), on one GPU or the
// CPU, and Qwen3-TTS's (host/speech-qwen/server.py), on one NVIDIA GPU. Both
// load and unload voice models through the same small API, and their
// OpenAI-compatible /v1/audio/speech is what runtime.ts passes requests to.
// A Qwen3-TTS model goes to the second, every other voice model to the first.
import { HostError } from "./http.ts";
import { poll, type Backend } from "./backends.ts";
import type { TextModel } from "./library.ts";
import type { Option } from "./placement.ts";

export interface SpeechOptions {
  url: string; // e.g. http://speech:8000
  /** The Qwen3-TTS speech server, on a host with NVIDIA GPUs; e.g. http://speech-qwen:8000. */
  qwenUrl?: string;
  models: string; // the models folder as the speech server sees it
  loadTimeoutMs?: number;
  /** How long a load waits for the server to answer, while it starts again. */
  startMs?: number;
}

const unavailable = (message = "The speech server didn't answer.") => new HostError(503, "model_unavailable", message);

export class Speech implements Backend {
  private readonly o: Required<Omit<SpeechOptions, "qwenUrl">> & Pick<SpeechOptions, "qwenUrl">;

  constructor(o: SpeechOptions) {
    this.o = { loadTimeoutMs: 5 * 60_000, startMs: 60_000, ...o };
  }

  /** The server for a model: Qwen3-TTS's for a Qwen3-TTS model, else Kokoro's. */
  private serverFor(model: TextModel): string {
    if (!model.qwenTts) return this.o.url;
    if (!this.o.qwenUrl) throw new HostError(503, "model_unavailable", "Qwen3-TTS voices need an NVIDIA GPU, and this host has none.");
    return this.o.qwenUrl;
  }

  private async post(path: string, body: unknown, timeoutMs = 60_000, base = this.o.url): Promise<void> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    if (res.ok) return;
    const answer: any = await res.json().catch(() => null);
    // Its messages are plain sentences about the model, never text it was asked to read.
    throw unavailable(typeof answer?.error?.message === "string" ? answer.error.message : undefined);
  }

  async load(model: TextModel, at: Option): Promise<void> {
    if (!model.onnx && !model.qwenTts) throw new HostError(400, "invalid", "That isn't a voice model.");
    const base = this.serverFor(model);
    if (model.qwenTts && !at.gpus.length) throw new HostError(503, "model_unavailable", "Qwen3-TTS voices run on a GPU, and none is free for them here.");
    // A server that let go of its GPU exits once nothing is loaded; Docker starts it again.
    await poll(async () => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })).ok, this.o.startMs, "The speech server");
    const folder = `${this.o.models}/${model.id}`;
    await this.post("/load", model.qwenTts
      ? { name: model.id, folder, device: at.gpus[0] }
      : { name: model.id, folder, file: model.onnx, device: at.gpus.length ? at.gpus[0] : "cpu" }, this.o.loadTimeoutMs, base);
  }

  async unload(model: TextModel): Promise<void> {
    await this.post("/unload", { name: model.id }, undefined, this.serverFor(model));
  }

  url(model: TextModel): string {
    return this.serverFor(model);
  }

  /** Both servers: each one that answers lets go of everything. */
  async reset(): Promise<void> {
    // Both, even when one is down, so neither keeps its GPU.
    const bases = this.o.qwenUrl ? [undefined, this.o.qwenUrl] : [undefined];
    const failed = (await Promise.allSettled(bases.map((base) => this.post("/reset", {}, undefined, base)))).find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}
