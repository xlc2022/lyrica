// The speech server (host/speech/server.py): voice models loaded and
// unloaded through its own small API, on one GPU or the CPU. Its
// OpenAI-compatible /v1/audio/speech is what runtime.ts passes requests to.
import { HostError } from "./http.ts";
import type { Backend } from "./backends.ts";
import type { TextModel } from "./library.ts";
import type { Option } from "./placement.ts";

export interface SpeechOptions {
  url: string; // e.g. http://speech:8000
  models: string; // the models folder as the speech server sees it
  loadTimeoutMs?: number;
}

const unavailable = (message = "The speech server didn't answer.") => new HostError(503, "model_unavailable", message);

export class Speech implements Backend {
  private readonly o: Required<SpeechOptions>;

  constructor(o: SpeechOptions) {
    this.o = { loadTimeoutMs: 5 * 60_000, ...o };
  }

  private async post(path: string, body: unknown, timeoutMs = 60_000): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.o.url + path, {
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
    if (!model.onnx) throw new HostError(400, "invalid", "That isn't a voice model.");
    await this.post("/load", { name: model.id, folder: `${this.o.models}/${model.id}`, file: model.onnx, device: at.gpus.length ? at.gpus[0] : "cpu" }, this.o.loadTimeoutMs);
  }

  async unload(model: TextModel): Promise<void> {
    await this.post("/unload", { name: model.id });
  }

  url(): string {
    return this.o.url;
  }

  async reset(): Promise<void> {
    await this.post("/reset", {});
  }
}
