// stable-diffusion.cpp's sd-server, which makes images in place of ComfyUI
// when the image GPU is a CMP 100-210 (docs/briefs/cmp-100-210.md). It takes
// its model as start-up arguments, so host/sdcpp/gate.sh starts it for the
// recipe host-api names in serving/sdcpp.json and stops it when none is
// loaded. Jobs go through its native API; results come back in the response
// and nothing is saved.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poll, writeAtomic, type Backend } from "./backends.ts";
import { HostError, invalid } from "./http.ts";
import type { TextModel } from "./library.ts";
import type { Recipe } from "./recipes.ts";
import type { Values } from "./templates.ts";

const unavailable = () => new HostError(503, "model_unavailable", "stable-diffusion.cpp didn't answer.");
const CALL_MS = 30_000;

/** The templates sd.cpp can make images for, and its flag for each text encoder slot. */
const TEMPLATES = new Set(["z-image", "qwen-image", "krea2", "flux", "sdxl"]);
const ENCODERS: Record<string, string> = { qwen3: "--llm", "qwen2.5vl": "--llm", qwen3vl: "--llm", t5: "--t5xxl", clip_l: "--clip_l", clip_g: "--clip_g" };
/** ComfyUI's sampler and scheduler names as sd.cpp names them; others take sd.cpp's default. */
const SAMPLERS: Record<string, string> = {
  euler: "euler", euler_ancestral: "euler_a", heun: "heun", dpm_2: "dpm2", dpmpp_2s_ancestral: "dpm++2s_a", dpmpp_2m: "dpm++2m",
  dpmpp_2m_sde: "dpm++2m_sde", lms: "lms", ipndm: "ipndm", ipndm_v: "ipndm_v", lcm: "lcm", res_multistep: "res_multistep", er_sde: "er_sde",
};
const SCHEDULERS: Record<string, string> = {
  normal: "discrete", simple: "simple", karras: "karras", exponential: "exponential", sgm_uniform: "sgm_uniform", kl_optimal: "kl_optimal", beta: "beta",
};

/**
 * sd-server's arguments for a recipe's parts, under /models. Throws when sd.cpp
 * can't make it here: another template, LoRAs, or a part it has no flag for.
 * `fullRate`: the card's FP16 tensor cores run at full rate (a CMP unlocked
 * since boot), as gate.sh reports.
 */
export function sdcppArgs(r: Pick<Recipe, "template" | "parts" | "loras">, models: string, fullRate = false): string[] {
  const cant = (why: string) => invalid(`This host makes images with stable-diffusion.cpp, which can't run this recipe: ${why}.`);
  if (!TEMPLATES.has(r.template)) throw cant(`it has no ${r.template} support here`);
  if (r.loras.length) throw cant("LoRAs aren't supported");
  // Throttled tensor cores: weights become Q8_0 as they load, for the card's
  // int8 units, and flash attention, which would use the tensor cores, is off.
  // At full rate they become F16, with flash attention on: 2.5 times as fast.
  // A GGUF main model keeps its quantisation either way, as a larger one may not fit.
  const main = r.parts.find((p) => p.role === "checkpoint" || p.role === "diffusion");
  const args = ["--flash-attn", fullRate ? "on" : "off"];
  if (!main?.file?.endsWith(".gguf")) args.push("--type", fullRate ? "f16" : "q8_0");
  for (const p of r.parts) {
    if (!p.file) continue;
    const flag = p.role === "checkpoint" ? "-m" : p.role === "diffusion" ? "--diffusion-model" : p.role === "vae" ? "--vae" : p.role === "text_encoder" ? ENCODERS[p.slot ?? ""] : undefined;
    if (!flag) throw cant(`it has a ${p.role}${p.slot ? ` (${p.slot})` : ""} part`);
    args.push(flag, join(models, p.file));
  }
  return args;
}

/** A create request as sd-server's native img_gen body. */
export function sdcppJob(template: string, v: Values): object {
  const sample: Record<string, unknown> = {
    sample_steps: v.steps,
    guidance: { txt_cfg: v.cfg, ...(template === "flux" ? { distilled_guidance: v.guidance } : {}) },
  };
  if (SAMPLERS[String(v.sampler)]) sample.sample_method = SAMPLERS[String(v.sampler)];
  if (SCHEDULERS[String(v.scheduler)]) sample.scheduler = SCHEDULERS[String(v.scheduler)];
  // ComfyUI's shift for these flow models is sd.cpp's flow shift.
  if (template === "z-image" || template === "qwen-image") sample.flow_shift = v.shift;
  return {
    prompt: v.prompt, negative_prompt: v.negativePrompt, width: v.width, height: v.height, seed: v.seed,
    batch_count: v.count, sample_params: sample, output_format: "png",
  };
}

export class SdCpp implements Backend {
  private readonly base: string;
  private readonly state: string;
  private readonly status: string;
  private readonly timeoutMs: number;
  private readonly startMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** Each recipe's arguments, set before its job; and the recipe sd-server runs, with the arguments it started with. */
  private readonly args = new Map<string, string[]>();
  private running: { id: string; args: string[] } | null = null;

  constructor(base: string, gate: { serving: string; status: string }, timeoutMs = 30 * 60_000, startMs = 10 * 60_000) {
    this.base = base;
    this.state = join(gate.serving, "sdcpp.json");
    this.status = gate.status;
    this.timeoutMs = timeoutMs;
    this.startMs = startMs;
    this.ask(null);
  }

  private ask(run: { attempt: string; args: string[] } | null): void {
    writeAtomic(this.state, JSON.stringify(run ? { run: true, ...run } : { run: false }));
  }

  /** What gate.sh says: the attempt it started, its exit code once it has exited, and the tensor cores' rate. */
  private gate(): { attempt?: string; exited?: number; tensor?: "full" | "throttled" } {
    try {
      return JSON.parse(readFileSync(this.status, "utf8"));
    } catch {
      return {};
    }
  }

  /** Whether the card's FP16 tensor cores run at full rate, for sdcppArgs. */
  fullRate(): boolean {
    return this.gate().tensor === "full";
  }

  /** Sets a recipe's arguments, before its job. */
  prepare(id: string, args: string[]): void {
    this.args.set(id, args);
  }

  /** Runs `fn` after what's queued, so a start and a job never overlap. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async call(path: string, body?: object): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method: body ? "POST" : "GET",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(CALL_MS),
    }).catch(() => {
      throw unavailable();
    });
  }

  /** Starts sd-server with the recipe's arguments, unless it already runs with them. */
  private async start(id: string): Promise<void> {
    const args = this.args.get(id);
    if (!args) throw new HostError(503, "model_unavailable", "stable-diffusion.cpp has no arguments for this recipe.");
    if (this.running?.id === id && JSON.stringify(this.running.args) === JSON.stringify(args) && this.gate().exited === undefined) return;
    const attempt = randomUUID();
    this.running = null;
    this.ask({ attempt, args });
    try {
      await poll(async () => {
        const g = this.gate();
        if (g.attempt !== attempt) return false;
        if (g.exited !== undefined) throw new HostError(503, "model_unavailable", "stable-diffusion.cpp couldn't load this recipe.");
        const res = await fetch(`${this.base}/sdcpp/v1/models/status`, { signal: AbortSignal.timeout(5_000) });
        const { state } = (await res.json()) as { state?: string };
        if (state === "error") throw new HostError(503, "model_unavailable", "stable-diffusion.cpp couldn't load this recipe.");
        return state === "ready";
      }, this.startMs, "stable-diffusion.cpp");
      this.running = { id, args };
    } catch (e) {
      this.ask(null);
      throw e;
    }
  }

  // As a scheduler backend: sd-server holds one recipe at a time. A job for
  // another recipe, or for one whose parts changed, starts it again first.
  load(model: TextModel): Promise<void> {
    return this.serial(() => this.start(model.id));
  }

  unload(model: TextModel): Promise<void> {
    return this.serial(async () => {
      if (this.running && this.running.id !== model.id) return;
      this.running = null;
      this.ask(null);
      await poll(async () => this.gate().attempt === undefined, 60_000, "stable-diffusion.cpp");
    });
  }

  url(): string {
    return this.base;
  }

  async reset(): Promise<void> {
    this.running = null;
    this.ask(null);
  }

  /** Why images can't be made, or null; sd.cpp has no check of its own to report. */
  get problem(): string | null {
    return null;
  }

  /** Runs one create job and returns its PNGs; a job that is cancelled or times out is cancelled in sd-server too. */
  create(id: string, template: string, values: Values, signal?: AbortSignal): Promise<Buffer[]> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      await this.start(id);
      return this.job(template, values, signal);
    });
  }

  private async job(template: string, values: Values, signal?: AbortSignal): Promise<Buffer[]> {
    const res = await this.call("/sdcpp/v1/img_gen", sdcppJob(template, values));
    if (!res.ok) throw new HostError(503, "model_unavailable", "stable-diffusion.cpp refused the job.");
    const { id } = (await res.json()) as { id: string };
    let finished = false;
    try {
      const until = Date.now() + this.timeoutMs;
      while (Date.now() < until) {
        signal?.throwIfAborted();
        const job = (await (await this.call(`/sdcpp/v1/jobs/${encodeURIComponent(id)}`)).json()) as {
          status: string; result?: { images?: { b64_json: string }[] } | null; error?: { code?: string } | null;
        };
        if (job.status === "completed") {
          finished = true;
          return (job.result?.images ?? []).map((i) => Buffer.from(i.b64_json, "base64"));
        }
        // The error's code says what broke; its message stays out, as it can carry the prompt.
        if (job.status === "failed" || job.status === "cancelled") {
          finished = true;
          throw new HostError(503, "model_unavailable", `stable-diffusion.cpp failed to make the image (${job.error?.code ?? job.status}).`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new HostError(503, "busy", "The image took too long.");
    } catch (e) {
      if (signal?.aborted) throw new HostError(503, "model_unavailable", "The request was cancelled.");
      throw e;
    } finally {
      if (!finished) await this.call(`/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, {}).catch(() => {});
    }
  }
}
