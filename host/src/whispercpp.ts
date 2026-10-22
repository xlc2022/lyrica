// whisper.cpp's whisper-server: dictation on a host with a CMP 100-210, whose
// sm_70 vLLM can't run (docs/briefs/cmp-whisper.md). It takes its model as
// start-up arguments, so host/whispercpp/gate.sh starts it for the model and
// GPU host-api names in serving/whisper.json and stops it when none is
// loaded. It answers OpenAI's /v1/audio/transcriptions itself.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poll, writeAtomic, type Backend } from "./backends.ts";
import { HostError } from "./http.ts";
import type { TextModel } from "./library.ts";
import type { Option } from "./placement.ts";

const cant = () => new HostError(503, "model_unavailable", "whisper.cpp couldn't load this model.");

export class WhisperCpp implements Backend {
  private readonly base: string;
  private readonly o: { serving: string; status: string; models: string; startMs?: number };
  private readonly state: string;
  private running: string | null = null;

  constructor(base: string, o: { serving: string; status: string; models: string; startMs?: number }) {
    this.base = base;
    this.o = o;
    this.state = join(o.serving, "whisper.json");
    this.ask(null);
  }

  private ask(run: { attempt: string; args: string[] } | null): void {
    writeAtomic(this.state, JSON.stringify(run ? { run: true, ...run } : { run: false }));
  }

  /** What gate.sh says: the attempt it started, and its exit code once it has exited. */
  private gate(): { attempt?: string; exited?: number } {
    try {
      return JSON.parse(readFileSync(this.o.status, "utf8"));
    } catch {
      return {};
    }
  }

  // One model at a time: loading another replaces the one running.
  async load(model: TextModel, at: Option): Promise<void> {
    const attempt = randomUUID();
    this.running = null;
    this.ask({ attempt, args: ["-m", `${this.o.models}/${model.id}`, "--device", String(at.gpus[0] ?? 0)] });
    try {
      await poll(async () => {
        const g = this.gate();
        if (g.attempt !== attempt) return false;
        if (g.exited !== undefined) throw cant();
        const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(5_000) });
        return res.ok;
      }, this.o.startMs ?? 5 * 60_000, "whisper.cpp");
      this.running = model.id;
    } catch (e) {
      this.ask(null);
      throw e;
    }
  }

  async unload(model: TextModel): Promise<void> {
    if (this.running !== model.id) return;
    this.running = null;
    this.ask(null);
    await poll(async () => this.gate().attempt === undefined, 60_000, "whisper.cpp");
  }

  url(model: TextModel): string {
    if (this.running !== model.id) throw new HostError(503, "model_unavailable", "whisper.cpp is running another model; try again.");
    return this.base;
  }

  async reset(): Promise<void> {
    this.running = null;
    this.ask(null);
  }
}
