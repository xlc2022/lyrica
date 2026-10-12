// Who gets each GPU's memory (DESIGN, "The host manages each GPU's VRAM").
// Each model has a placement: one GPU, several, or Auto. A GPU can hold
// several models of any mix; a model split over several GPUs counts against
// each and loads only when all have room. Requests wait in one queue, served
// chat first, then images, then background work; a request waiting for room
// holds its GPUs against lower ones. Idle models are unloaded least recently
// used first, never a pinned one or one in use. A model that can't fit fails
// with a plain reason instead of running out of memory.
import { HostError } from "./http.ts";
import type { Backend } from "./backends.ts";
import type { Gpu, GpuMonitor } from "./gpus.ts";
import type { TextModel } from "./library.ts";
import type { Logger } from "./log.ts";
import {
  CPU_OPTION, defaultGpu, neverFits, options, placementKey, serverOf, sizes, SERVER_NAMES, SERVERS,
  type GpuSettings, type ModelSettings, type Option, type Server,
} from "./placement.ts";
import type { StateFile } from "./state.ts";

export type Priority = "chat" | "image" | "background";
export const PRIORITIES: Priority[] = ["chat", "image", "background"];

const RANK: Record<Priority, number> = { chat: 0, image: 1, background: 2 };
const GIB = 1024 ** 3;

export const paused = () => new HostError(503, "paused", "The model host is paused.");
const restarting = () => new HostError(503, "restarting", "The model host is restarting.");
const cancelled = () => new HostError(499, "cancelled", "The request was cancelled.");

interface Loaded {
  model: TextModel;
  option: Option;
  /** Bytes it takes on each of its GPUs: measured, else expected. */
  vram: Record<number, number>;
  settings: ModelSettings;
  ready: boolean;
  active: number;
  lastUsed: number;
}

interface Job {
  model: TextModel;
  priority: Priority;
  seq: number;
  /** A fixed GPU (ComfyUI's), instead of the model's placement. */
  gpu?: number;
  resolve: (l: Loaded) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** The GPUs it is waiting for, once known: for the queue counts and the busy message. */
  waitingOn: number[];
}

export interface SchedulerOptions {
  monitor: GpuMonitor;
  backends: { llamacpp: Backend; vllm: Backend; comfyui?: Backend; speech?: Backend };
  state: StateFile;
  log: Logger;
  now?: () => number;
  /** Longest wait in the queue, per priority, in ms. */
  waitLimits?: Record<Priority, number>;
  /** The servers this host runs on its GPUs (a Vulkan host runs llama.cpp only). */
  servers?: Server[];
  /**
   * Servers that run on the CPU here instead: speech, on a host without
   * CUDA. Their models take no GPU memory and need no placement.
   */
  cpuServers?: Server[];
  /** How the servers reach the GPUs, for the status. */
  gpuBackend?: "cuda" | "rocm" | "vulkan" | null;
  /**
   * The servers that can use an integrated GPU's shared memory: llama.cpp on
   * Vulkan, or on ROCm with unified memory. The others see its carve-out only.
   */
  sharedMemory?: Server[];
}

export type HostRunState = "running" | "pausing" | "paused" | "restarting";

type Plan = { option: Option; evict: Loaded[] } | { wait: number[] } | HostError;

export class Scheduler {
  private readonly o: SchedulerOptions;
  private readonly now: () => number;
  private readonly limits: Record<Priority, number>;
  private readonly loaded = new Map<string, Loaded>();
  private queue: Job[] = [];
  private gpus: Gpu[] = [];
  private seq = 0;
  private pumping = false;
  private again = false;
  private changing = 0;
  runState: HostRunState = "running";
  /** What went wrong the last time the host paused, restarted or reset: shown in the status. */
  problems: string[] = [];
  /** Pause, resume and restart run one after another. */
  private transition: Promise<unknown> = Promise.resolve();

  constructor(o: SchedulerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.limits = o.waitLimits ?? { chat: 120_000, image: 300_000, background: 900_000 };
  }

  /** Reads the GPUs, clears the servers, and loads pinned models unless paused. */
  async start(models: TextModel[]): Promise<void> {
    this.gpus = await this.o.monitor.read();
    await Promise.all(Object.values(this.o.backends).map((b) => b?.reset())).catch(() => {});
    if (this.o.state.get().paused) this.runState = "paused";
    else await this.loadPins(models);
  }

  get gpuBackend(): "cuda" | "rocm" | "vulkan" | null {
    return this.o.gpuBackend ?? null;
  }

  /** The servers this host runs on its GPUs. */
  get servers(): Server[] {
    return (this.o.servers ?? SERVERS).filter((s) => !this.cpuServers.includes(s));
  }

  /** The servers this host runs on the CPU. */
  get cpuServers(): Server[] {
    return this.o.cpuServers ?? [];
  }

  onCpu(model: TextModel): boolean {
    return this.cpuServers.includes(serverOf(model));
  }

  /**
   * The GPUs as one server sees them: an integrated GPU offers a server that
   * can't use shared memory its carve-out only.
   */
  gpusFor(server: Server): Gpu[] {
    if (this.o.sharedMemory?.includes(server)) return this.gpus;
    return this.gpus.map((g) => (g.carveOut ? { ...g, total: g.carveOut.total, used: g.carveOut.used } : g));
  }

  async validationGpus(server: Server): Promise<Gpu[]> {
    await this.readGpus();
    return this.gpusFor(server).map((g) => ({ ...g, used: Math.max(0, g.used - [...this.loaded.values()].reduce((n, l) => n + (l.vram[g.index] ?? 0), 0)) }));
  }

  /** A router child disappeared; the next request must load it again. */
  missing(id: string): void {
    this.loaded.delete(id);
  }

  gpuSettings(index: number): GpuSettings {
    const gpu = this.gpus.find((g) => g.index === index);
    // An integrated GPU beside a discrete one is left out unless it's chosen:
    // it shares system memory, and the server may not support it. On ROCm it
    // runs llama.cpp only by default: vLLM and images would see its carve-out
    // alone.
    const beside = gpu?.integrated === true && this.gpus.some((g) => !g.integrated);
    const servers = gpu?.integrated && this.gpuBackend === "rocm" ? (["llamacpp"] as Server[]) : defaultGpu().servers;
    const saved = this.o.state.get().gpuSettings[index] ?? { ...defaultGpu(), servers, excluded: beside };
    return { ...saved, servers: saved.servers.filter((s) => this.servers.includes(s)) };
  }

  settings(model: TextModel): ModelSettings {
    return this.o.state.get().models[model.id] ?? { placement: { mode: "auto" } };
  }

  private pinned(id: string): boolean {
    return this.o.state.get().pins.includes(id);
  }

  private backend(model: TextModel): Backend {
    if (model.server === "comfyui") {
      if (!this.o.backends.comfyui) throw new HostError(503, "model_unavailable", "This host has no image server.");
      return this.o.backends.comfyui;
    }
    if (model.server === "speech") {
      if (!this.o.backends.speech) throw new HostError(503, "model_unavailable", "This host has no speech server.");
      return this.o.backends.speech;
    }
    return model.server === "vllm" ? this.o.backends.vllm : this.o.backends.llamacpp;
  }

  private async readGpus(): Promise<Gpu[]> {
    this.gpus = await this.o.monitor.read().catch(() => this.gpus);
    return this.gpus;
  }

  /** The ways this job's model may run. */
  private optionsFor(job: { model: TextModel; gpu?: number }): Option[] {
    if (this.onCpu(job.model)) return [CPU_OPTION];
    const s = this.settings(job.model);
    const gpus = this.gpusFor(serverOf(job.model));
    if (job.gpu === undefined) return options(job.model, s, gpus, (i) => this.gpuSettings(i));
    // ComfyUI: its one GPU, which must allow images.
    const g = gpus.find((x) => x.index === job.gpu);
    const gs = this.gpuSettings(job.gpu);
    if (!g || gs.excluded || !gs.servers.includes(serverOf(job.model))) return [];
    return [{ gpus: [g.index], split: null, parallel: null, share: null, need: { [g.index]: sizes(job.model, s).weights + GIB / 2 } }];
  }

  /** What a model takes on each GPU of an option: measured with that placement, else expected. */
  private needOf(model: TextModel, o: Option): Record<number, number> {
    return this.o.state.get().vram[`${model.id}@${placementKey(o)}`] ?? o.need;
  }

  /**
   * Runs `fn` with the model loaded and counted as in use, after waiting its
   * turn in the queue.
   */
  async run<T>(model: TextModel, priority: Priority, fn: (url: string) => Promise<T>, gpu?: number, signal?: AbortSignal): Promise<T> {
    if (this.runState === "paused" || this.runState === "pausing") throw paused();
    if (this.runState === "restarting") throw restarting();
    if (model.remoteCode) throw new HostError(403, "refused", "This model needs trust_remote_code, which the host never allows.");
    const loaded = await new Promise<Loaded>((resolve, reject) => {
      if (signal?.aborted) return reject(cancelled());
      const job: Job = {
        model, priority, gpu, seq: this.seq++, resolve, reject, waitingOn: [],
        timer: setTimeout(() => {
          this.queue = this.queue.filter((j) => j !== job);
          reject(new HostError(503, "busy", `The GPU is busy with ${this.busyWith(job.waitingOn)}.`));
          this.kick();
        }, this.limits[priority]),
      };
      // A request whose client has gone leaves the queue and loads nothing.
      signal?.addEventListener("abort", () => {
        if (this.queue.includes(job)) this.finish(job, cancelled());
      });
      this.queue.push(job);
      this.queue.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq);
      this.kick();
    });
    try {
      return await fn(this.backend(model).url(model));
    } finally {
      loaded.active--;
      loaded.lastUsed = this.now();
      this.kick();
    }
  }

  private busyWith(gpus: number[]): string {
    const on = [...this.loaded.values()].filter((l) => (l.active > 0 || !l.ready) && l.option.gpus.some((g) => !gpus.length || gpus.includes(g)));
    const kinds = on.map((l) => l.model.kind);
    if (kinds.includes("chat")) return "a chat model";
    if (kinds.includes("embedding")) return "an embedding model";
    if (kinds.includes("image")) return "image generation";
    if (kinds.includes("transcribe") || kinds.includes("speak")) return "speech";
    return "other work";
  }

  private activeCount(): number {
    let n = 0;
    for (const l of this.loaded.values()) n += l.active;
    return n;
  }

  private kick(): void {
    void this.pump();
  }

  /** Starts what can start, in priority order. One pump at a time; it runs again if asked meanwhile. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        await this.readGpus();
        // GPUs a higher-priority request is waiting for, which lower ones may not take.
        const held = new Set<number>();
        for (const job of [...this.queue]) {
          if (!this.queue.includes(job)) continue;
          const l = this.loaded.get(job.model.id);
          if (l?.ready) {
            this.begin(job, l);
            continue;
          }
          if (l) {
            job.waitingOn = l.option.gpus;
            l.option.gpus.forEach((g) => held.add(g));
            continue;
          }
          // Nothing loads unless the host is running.
          if (this.runState !== "running") {
            this.finish(job, this.runState === "restarting" ? restarting() : paused());
            continue;
          }
          const plan = this.plan(job, held);
          if (plan instanceof HostError) {
            this.finish(job, plan);
            continue;
          }
          if ("wait" in plan) {
            job.waitingOn = plan.wait;
            plan.wait.forEach((g) => held.add(g));
            continue;
          }
          try {
            for (const e of plan.evict) await this.unload(e);
            await this.load(job.model, plan.option);
          } catch (e) {
            this.finish(job, e instanceof HostError ? e : new HostError(503, "model_unavailable", "The model server couldn't load this model."));
          }
          this.again = true; // memory changed: look at the queue again from the top
          break;
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Where the job's model can load now, unloading idle models least recently
   * used first; or which GPUs it must wait for; or why it can never fit.
   */
  private plan(job: Pick<Job, "model" | "gpu">, held: Set<number>): Plan {
    const model = job.model;
    const opts = this.optionsFor(job);
    const s = this.settings(model);
    if (!opts.length) {
      return new HostError(413, "too_big", job.gpu !== undefined ? `GPU ${job.gpu} doesn't allow images.` : `No GPU allows ${SERVER_NAMES[serverOf(model)]} for this model.`);
    }
    const loadedOn = (g: number) => [...this.loaded.values()].filter((l) => l.option.gpus.includes(g));
    const view = this.gpusFor(serverOf(model));
    const free = (g: number) => {
      const gpu = view.find((x) => x.index === g)!;
      return gpu.total - gpu.used - this.gpuSettings(g).keepFree;
    };
    const deficitOf = (o: Option) => {
      const need = this.needOf(model, o);
      return (evicted: Set<Loaded>) => o.gpus.some((g) => need[g]! > free(g) + [...evicted].reduce((n, l) => n + (l.vram[g] ?? 0), 0));
    };
    // A way that can't work even on empty GPUs is out, whatever unloading
    // could free (on an integrated GPU, a model may sit in shared memory that
    // this server can't use).
    const empty = view.map((g) => ({ ...g, used: 0 }));
    const possible = opts.filter((o) => !neverFits(model, s, o, empty, (i) => this.gpuSettings(i)));
    if (!possible.length) return new HostError(413, "too_big", neverFits(model, s, opts[0]!, empty, (i) => this.gpuSettings(i))!);
    const usable = possible.filter((o) => !o.gpus.some((g) => held.has(g)));
    // A way that needs no unloading beats one that does, whatever its order.
    const roomy = usable.find((o) => !deficitOf(o)(new Set()));
    if (roomy) return { option: roomy, evict: [] };
    let waitFor: number[] | null = null;
    for (const o of usable) {
      const deficit = deficitOf(o);
      const idle = [...new Set(o.gpus.flatMap(loadedOn))].filter((l) => l.ready && l.active === 0 && !this.pinned(l.model.id)).sort((a, b) => a.lastUsed - b.lastUsed);
      const evict = new Set<Loaded>();
      for (const l of idle) {
        if (!deficit(evict)) break;
        evict.add(l);
      }
      if (!deficit(evict)) return { option: o, evict: [...evict] };
      // Would it fit once the busy models are done?
      const all = new Set([...new Set(o.gpus.flatMap(loadedOn))].filter((l) => !this.pinned(l.model.id)));
      if (!deficit(all) && !waitFor) waitFor = o.gpus;
    }
    if (waitFor) return { wait: waitFor };
    // Every way is on GPUs held for others: wait for those, so it's counted in their queues.
    if (!usable.length) return { wait: [...new Set(possible.flatMap((o) => o.gpus))] };
    // It can never fit: say why, for the first way it could have run.
    const o = opts[0]!;
    const reason = neverFits(model, s, o, empty, (i) => this.gpuSettings(i));
    if (reason) return new HostError(413, "too_big", reason);
    const gb = (n: number) => (n / GIB).toFixed(1);
    const need = this.needOf(model, o);
    const g = o.gpus.find((i) => need[i]! > free(i) + loadedOn(i).filter((l) => !this.pinned(l.model.id)).reduce((n, l) => n + (l.vram[i] ?? 0), 0)) ?? o.gpus[0]!;
    const gpu = view.find((x) => x.index === g)!;
    const pinned = loadedOn(g).filter((l) => this.pinned(l.model.id)).reduce((n, l) => n + (l.vram[g] ?? 0), 0);
    const others = gpu.used - loadedOn(g).reduce((n, l) => n + (l.vram[g] ?? 0), 0);
    return new HostError(413, "too_big", `This model needs about ${gb(need[g]!)} GB on GPU ${g}; it has ${gb(gpu.total)} GB, of which ${gb(pinned)} GB is pinned and ${gb(Math.max(others, 0))} GB is used by other programs and ${gb(this.gpuSettings(g).keepFree)} GB is kept free.`);
  }

  private begin(job: Job, l: Loaded): void {
    l.active++;
    l.lastUsed = this.now();
    clearTimeout(job.timer);
    this.queue = this.queue.filter((j) => j !== job);
    job.resolve(l);
  }

  private finish(job: Job, error: HostError): void {
    clearTimeout(job.timer);
    this.queue = this.queue.filter((j) => j !== job);
    job.reject(error);
  }

  private async load(model: TextModel, o: Option, settings = this.settings(model)): Promise<void> {
    const before = Object.fromEntries((await this.readGpus()).map((g) => [g.index, g.used]));
    const key = `${model.id}@${placementKey(o)}`;
    const entry: Loaded = { model, option: o, vram: { ...this.needOf(model, o) }, settings, ready: false, active: 0, lastUsed: this.now() };
    this.loaded.set(model.id, entry);
    this.changing++;
    try {
      await this.backend(model).load(model, o, settings);
    } catch (e) {
      this.loaded.delete(model.id);
      throw e;
    } finally {
      this.changing--;
    }
    entry.ready = true;
    // Measured per GPU on the first load with this placement. vLLM's share is what it reserves.
    if (this.o.state.get().vram[key] === undefined && model.server !== "vllm" && o.gpus.length) {
      const after = await this.readGpus();
      const measured: Record<number, number> = {};
      for (const g of o.gpus) measured[g] = (after.find((x) => x.index === g)?.used ?? 0) - (before[g] ?? 0);
      if (Object.values(measured).every((n) => n > 0)) {
        entry.vram = measured;
        this.o.state.update((s) => {
          s.vram[key] = measured;
        });
      }
    }
    this.o.log("loaded", { model: model.id, gpus: o.gpus.join(",") });
  }

  private async unload(l: Loaded): Promise<void> {
    this.changing++;
    try {
      await this.backend(l.model).unload(l.model);
    } finally {
      this.changing--;
    }
    this.loaded.delete(l.model.id);
    this.o.log("unloaded", { model: l.model.id });
  }

  /** Loads a model now (the load API), queued like a chat request. */
  async loadNow(model: TextModel): Promise<void> {
    await this.run(model, "chat", async () => {});
  }

  async unloadNow(id: string): Promise<void> {
    const l = this.loaded.get(id);
    if (!l) return;
    if (l.active > 0 || !l.ready) throw new HostError(409, "in_use", "The model is in use.");
    await this.unload(l);
  }

  /** Applies a model's saved settings now: unloads it if idle and loads it again. */
  async reload(model: TextModel): Promise<void> {
    const previous = this.loaded.get(model.id);
    if (!previous) return;
    if (previous.active > 0 || !previous.ready) throw new HostError(409, "in_use", "The model is in use.");
    if (this.runState !== "running") throw paused();
    await this.readGpus();
    if (this.pumping || previous.active > 0 || this.loaded.get(model.id) !== previous) throw new HostError(409, "in_use", "The model host is loading or serving a model.");
    this.pumping = true;
    this.changing++;
    try {
      // Count the old instance as reclaimable, including when pinned.
      this.loaded.delete(model.id);
      const view = this.gpus;
      this.gpus = view.map((g) => ({ ...g, used: Math.max(0, g.used - (previous.vram[g.index] ?? 0)) }));
      let plan: Plan;
      try {
        plan = this.plan({ model }, new Set());
      } finally {
        this.gpus = view;
        this.loaded.set(model.id, previous);
      }
      if (plan instanceof HostError) throw plan;
      if ("wait" in plan) throw new HostError(503, "busy", "The GPU is busy with other work.");
      await this.unload(previous);
      try {
        for (const l of plan.evict) await this.unload(l);
        await this.load(model, plan.option);
      } catch (e) {
        this.saveSettings(model, previous.settings);
        // A failed restoration must not hide the replacement's load error.
        await this.load(model, previous.option, previous.settings).catch((r) =>
          this.o.log("restore failed", { model: model.id, error: r instanceof Error ? r.name : "error", message: r instanceof Error ? r.message : "" }),
        );
        throw e;
      }
    } finally {
      this.changing--;
      this.pumping = false;
      this.kick();
    }
  }

  async pin(model: TextModel, pinned: boolean): Promise<void> {
    this.o.state.update((s) => {
      s.pins = s.pins.filter((p) => p !== model.id);
      if (pinned) s.pins.push(model.id);
    });
    if (pinned && this.runState === "running") await this.loadNow(model);
  }

  private async loadPins(models: TextModel[]): Promise<void> {
    for (const id of this.o.state.get().pins) {
      const model = models.find((m) => m.id === id);
      if (!model) continue;
      await this.loadNow(model).catch((e) => this.o.log("pin not loaded", { model: id, code: e instanceof HostError ? e.code : "error" }));
    }
  }

  /** Changes a GPU's settings; models it may no longer hold are unloaded first. */
  async setGpu(index: number, next: GpuSettings): Promise<void> {
    if (!this.gpus.some((g) => g.index === index)) throw new HostError(404, "not_found", "No such GPU.");
    const leaving = [...this.loaded.values()].filter((l) => l.option.gpus.includes(index) && (next.excluded || !next.servers.includes(serverOf(l.model))));
    if (leaving.some((l) => l.active > 0 || !l.ready)) throw new HostError(409, "in_use", "A model on that GPU is in use.");
    for (const l of leaving) await this.unload(l);
    this.o.state.update((s) => {
      s.gpuSettings[index] = next;
    });
  }

  saveSettings(model: TextModel, s: ModelSettings): void {
    this.o.state.update((st) => {
      st.models[model.id] = s;
      // Context, KV type, layers and batch change what it takes: measure again.
      for (const k of Object.keys(st.vram)) if (k.startsWith(`${model.id}@`)) delete st.vram[k];
    });
  }

  get knownGpus(): Gpu[] {
    return this.gpus;
  }

  private rejectQueued(error: () => HostError): void {
    for (const job of [...this.queue]) this.finish(job, error());
  }

  /** Resolves when nothing is running, loading or unloading. */
  private async idle(): Promise<void> {
    while (this.activeCount() > 0 || this.changing > 0 || this.pumping) await new Promise((r) => setTimeout(r, 50));
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const run = this.transition.then(step, step);
    this.transition = run.catch(() => {});
    return run;
  }

  /** Unloads every model on every GPU, noting what couldn't be. */
  private async unloadAll(): Promise<void> {
    this.problems = [];
    for (const l of [...this.loaded.values()]) {
      await this.unload(l).catch(() => {
        this.loaded.delete(l.model.id);
        this.problems.push(`GPU ${l.option.gpus.join(" and ")}: couldn't unload ${l.model.id}; it may still hold memory.`);
      });
    }
    for (const [name, b] of Object.entries(this.o.backends)) {
      await b?.reset().catch((e: Error) => this.problems.push(`${name}: ${e.message}`));
    }
  }

  /**
   * Refuses new work at once, lets the running jobs and loads finish, then
   * unloads every model. Answers right away; the state is "pausing" until
   * then. Survives a restart.
   */
  async pause(): Promise<void> {
    if (this.runState === "paused" || this.runState === "pausing") return;
    this.o.state.update((s) => {
      s.paused = true;
    });
    this.runState = "pausing";
    this.rejectQueued(paused);
    void this.serial(async () => {
      await this.idle();
      await this.unloadAll();
      this.runState = "paused";
      this.o.log("paused", { problems: this.problems.length });
    });
  }

  async resume(models: TextModel[]): Promise<void> {
    await this.serial(async () => {
      if (this.runState === "running") return;
      this.o.state.update((s) => {
        s.paused = false;
      });
      this.problems = [];
      this.runState = "running";
      this.o.log("resumed", {});
      // Inside the same step, so a pause that follows waits for these loads, then unloads them.
      await this.loadPins(models);
    });
  }

  async restart(models: TextModel[]): Promise<void> {
    await this.serial(async () => {
      const was = this.runState === "pausing" ? "paused" : this.runState;
      this.runState = "restarting";
      this.rejectQueued(restarting);
      await this.idle();
      await this.unloadAll();
      // A pause asked for during the restart wins.
      this.runState = was === "running" && !this.o.state.get().paused ? "running" : "paused";
      if (this.runState === "running") await this.loadPins(models);
    });
  }

  async status(): Promise<object[]> {
    await this.readGpus();
    return this.gpus.map((g) => {
      const queue = { chat: 0, image: 0, background: 0 };
      for (const j of this.queue) if (j.waitingOn.includes(g.index)) queue[j.priority]++;
      return {
        index: g.index,
        name: g.name,
        vendor: g.vendor,
        integrated: g.integrated === true,
        settings: this.gpuSettings(g.index),
        vram: { total: g.total, used: g.used, ...(g.carveOut ? { carveOut: g.carveOut } : {}) },
        models: [...this.loaded.values()]
          .filter((l) => l.option.gpus.includes(g.index))
          .map((l) => ({
            id: l.model.id,
            kind: l.model.kind,
            state: l.ready ? "loaded" : "loading",
            gpus: l.option.gpus,
            pinned: this.pinned(l.model.id),
            busy: l.active > 0,
            vram: l.vram[g.index] ?? null,
            lastUsed: new Date(l.lastUsed).toISOString(),
          })),
        queue,
      };
    });
  }

  /**
   * Measures a model whose server loads during the job (ComfyUI), from the
   * memory used before it: `fn` runs the job, and the first run with its
   * placement is measured.
   */
  async measuring<T>(model: TextModel, fn: () => Promise<T>): Promise<T> {
    const entry = this.loaded.get(model.id);
    if (!entry) return fn();
    const key = `${model.id}@${placementKey(entry.option)}`;
    if (this.o.state.get().vram[key] !== undefined) return fn();
    const before = Object.fromEntries((await this.readGpus()).map((g) => [g.index, g.used]));
    const result = await fn();
    const after = await this.readGpus();
    const measured: Record<number, number> = {};
    for (const g of entry.option.gpus) measured[g] = (after.find((x) => x.index === g)?.used ?? 0) - (before[g] ?? 0);
    if (Object.values(measured).every((n) => n > 0)) {
      entry.vram = measured;
      this.o.state.update((s) => {
        s.vram[key] = measured;
      });
    }
    return result;
  }

  /** Unloads models of a kind idle for longer than `ms` (ComfyUI keeps its parts in memory after a job). */
  async unloadIdle(kind: TextModel["kind"], ms: number): Promise<void> {
    for (const l of [...this.loaded.values()]) {
      if (l.model.kind === kind && l.ready && l.active === 0 && this.now() - l.lastUsed > ms) await this.unload(l).catch(() => {});
    }
  }

  /** Where a model is, for the library listing. */
  placement(id: string): { state: "loading" | "loaded"; gpus: number[] } | null {
    const l = this.loaded.get(id);
    return l ? { state: l.ready ? "loaded" : "loading", gpus: l.option.gpus } : null;
  }
}
