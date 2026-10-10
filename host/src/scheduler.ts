// Who gets each GPU's memory. Each GPU has a role (a whole GPU for one vLLM
// model, or shared by llama.cpp models), a queue served chat first, then
// images, then background work, and its loaded models. Idle models are
// unloaded least recently used first, never a pinned one or one in use. A
// model that can't fit fails with a plain reason instead of running out of
// memory.
import { HostError } from "./http.ts";
import type { Backend } from "./backends.ts";
import type { Gpu, GpuMonitor } from "./gpus.ts";
import type { TextModel } from "./library.ts";
import type { Logger } from "./log.ts";
import type { StateFile } from "./state.ts";

export type Priority = "chat" | "image" | "background";
export const PRIORITIES: Priority[] = ["chat", "image", "background"];
export type Role = "vllm" | "shared";

const RANK: Record<Priority, number> = { chat: 0, image: 1, background: 2 };
const GIB = 1024 ** 3;
/** Kept free on a shared GPU for the servers' own buffers. */
const HEADROOM = GIB / 2;

export const paused = () => new HostError(503, "paused", "The model host is paused.");
const restarting = () => new HostError(503, "restarting", "The model host is restarting.");

interface Loaded {
  model: TextModel;
  vram: number;
  ready: boolean;
  active: number;
  lastUsed: number;
}

interface Job {
  model: TextModel;
  priority: Priority;
  at: number;
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  index: number;
  loaded: Map<string, Loaded>;
  queue: Job[];
  pumping: boolean;
  /** A load or unload is under way. */
  changing: boolean;
}

export interface SchedulerOptions {
  monitor: GpuMonitor;
  backends: { llamacpp: Backend; vllm: Backend; comfyui?: Backend };
  state: StateFile;
  log: Logger;
  now?: () => number;
  /** Longest wait in a queue, per priority, in ms. */
  waitLimits?: Record<Priority, number>;
}

export type HostRunState = "running" | "pausing" | "paused" | "restarting";

export class Scheduler {
  private readonly o: SchedulerOptions;
  private readonly now: () => number;
  private readonly limits: Record<Priority, number>;
  private readonly slots = new Map<number, Slot>();
  private gpus: Gpu[] = [];
  private seq = 0;
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
    for (const g of this.gpus) this.slots.set(g.index, { index: g.index, loaded: new Map(), queue: [], pumping: false, changing: false });
    await Promise.all([this.o.backends.llamacpp.reset(), this.o.backends.vllm.reset()]).catch(() => {});
    if (this.o.state.get().paused) this.runState = "paused";
    else await this.loadPins(models);
  }

  role(gpu: number): Role {
    return this.o.state.get().roles[gpu] ?? "shared";
  }

  private pinned(id: string, gpu?: number): boolean {
    return this.o.state.get().pins.some((p) => p.model === id && (gpu === undefined || p.gpu === gpu));
  }

  private backend(model: TextModel): Backend {
    if (model.server === "comfyui") {
      if (!this.o.backends.comfyui) throw new HostError(503, "unavailable", "This host has no image server.");
      return this.o.backends.comfyui;
    }
    return model.server === "vllm" ? this.o.backends.vllm : this.o.backends.llamacpp;
  }

  /**
   * What the model is expected to take: measured once loaded, else an
   * estimate of its weights, buffers and a KV cache for its context (up to
   * the 32k cap, about 2 GB).
   */
  private need(model: TextModel): number {
    const kv = model.kind === "chat" ? (Math.min(model.contextLength ?? 8192, 32768) / 32768) * 2 * GIB : 0;
    return this.o.state.get().vram[model.id] ?? Math.round(model.size * 1.1 + GIB + kv);
  }

  private async gpu(index: number): Promise<Gpu> {
    this.gpus = await this.o.monitor.read();
    const g = this.gpus.find((x) => x.index === index);
    if (!g) throw new HostError(503, "unavailable", "That GPU isn't there any more.");
    return g;
  }

  private where(id: string): Slot | undefined {
    for (const s of this.slots.values()) if (s.loaded.has(id)) return s;
    return undefined;
  }

  /** Picks a GPU for a model that isn't loaded. */
  private place(model: TextModel, prefer?: number): Slot {
    const pin = this.o.state.get().pins.find((p) => p.model === model.id);
    const want: Role = model.server === "vllm" ? "vllm" : "shared";
    const fits = [...this.slots.values()].filter((s) => this.role(s.index) === want);
    if (!fits.length) {
      throw new HostError(413, "too_big", want === "vllm" ? "No GPU is set aside for vLLM models." : "No GPU is shared for llama.cpp models.");
    }
    const chosen = prefer ?? pin?.gpu;
    if (chosen !== undefined) {
      const slot = fits.find((s) => s.index === chosen);
      if (!slot) throw new HostError(400, "invalid", `GPU ${chosen} doesn't take this kind of model.`);
      return slot;
    }
    if (want === "vllm") return fits.find((s) => [...s.loaded.values()].every((l) => l.active === 0)) ?? fits[0]!;
    // The shared GPU with the most memory free or freeable now.
    const room = (s: Slot) => {
      const g = this.gpus.find((x) => x.index === s.index);
      const idle = [...s.loaded.values()].filter((l) => !this.pinned(l.model.id) && l.active === 0).reduce((n, l) => n + l.vram, 0);
      return g ? g.total - g.used + idle : 0;
    };
    return fits.reduce((a, b) => (room(b) > room(a) ? b : a));
  }

  /**
   * Runs `fn` with the model loaded and counted as in use, after waiting its
   * turn in the GPU's queue.
   */
  async run<T>(model: TextModel, priority: Priority, fn: (url: string) => Promise<T>, gpu?: number, signal?: AbortSignal): Promise<T> {
    if (this.runState === "paused" || this.runState === "pausing") throw paused();
    if (this.runState === "restarting") throw restarting();
    if (model.remoteCode) throw new HostError(403, "refused", "This model needs trust_remote_code, which the host never allows.");
    const slot = this.where(model.id) ?? this.place(model, gpu);
    await new Promise<void>((resolve, reject) => {
      const job: Job = {
        model,
        priority,
        at: this.now(),
        seq: this.seq++,
        resolve,
        reject,
        timer: setTimeout(() => {
          slot.queue = slot.queue.filter((j) => j !== job);
          reject(new HostError(503, "busy", `The GPU is busy with ${this.busyWith(slot)}.`));
          void this.pump(slot);
        }, this.limits[priority]),
      };
      // A request whose client has gone leaves the queue and loads nothing.
      signal?.addEventListener("abort", () => {
        if (slot.queue.includes(job)) this.finish(slot, job, new HostError(499, "cancelled", "The request was cancelled."));
      });
      if (signal?.aborted) return reject(new HostError(499, "cancelled", "The request was cancelled."));
      slot.queue.push(job);
      slot.queue.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq);
      void this.pump(slot);
    });
    const loaded = slot.loaded.get(model.id)!;
    try {
      return await fn(this.backend(model).url(model));
    } finally {
      loaded.active--;
      loaded.lastUsed = this.now();
      void this.pump(slot);
    }
  }

  private busyWith(slot: Slot): string {
    const kinds = [...slot.loaded.values()].filter((l) => l.active > 0 || !l.ready).map((l) => l.model.kind);
    if (kinds.includes("chat")) return "a chat model";
    if (kinds.includes("embedding")) return "an embedding model";
    if (kinds.includes("image")) return "image generation";
    return "other work";
  }

  private activeCount(): number {
    let n = 0;
    for (const s of this.slots.values()) for (const l of s.loaded.values()) n += l.active;
    return n;
  }

  /** Starts what can start, in priority order. Only one pump runs per GPU. */
  private async pump(slot: Slot): Promise<void> {
    if (slot.pumping) return;
    slot.pumping = true;
    try {
      while (slot.queue.length) {
        const job = slot.queue[0]!;
        const loaded = slot.loaded.get(job.model.id);
        if (loaded?.ready) {
          this.begin(slot, job, loaded);
          continue;
        }
        // Nothing loads unless the host is running.
        if (this.runState !== "running") {
          this.finish(slot, job, this.runState === "restarting" ? restarting() : paused());
          continue;
        }
        // The head needs its model loaded; everything behind it waits.
        const plan = await this.makeRoom(slot, job.model);
        if (plan === "wait") break;
        if (plan instanceof HostError) {
          this.finish(slot, job, plan);
          continue;
        }
        try {
          await this.load(slot, job.model);
        } catch (e) {
          this.finish(slot, job, e instanceof HostError ? e : new HostError(503, "unavailable", "The model server couldn't load this model."));
        }
      }
    } finally {
      slot.pumping = false;
    }
  }

  private begin(slot: Slot, job: Job, loaded: Loaded): void {
    loaded.active++;
    loaded.lastUsed = this.now();
    this.finish(slot, job);
  }

  private finish(slot: Slot, job: Job, error?: HostError): void {
    clearTimeout(job.timer);
    slot.queue = slot.queue.filter((j) => j !== job);
    if (error) job.reject(error);
    else job.resolve();
  }

  /**
   * Makes room for `model` on the GPU: unloads idle models, least recently
   * used first, if that is enough. Returns "wait" when only busy models
   * stand in the way, or the error when it can never fit.
   */
  private async makeRoom(slot: Slot, model: TextModel): Promise<"ready" | "wait" | HostError> {
    const all = [...slot.loaded.values()];
    if (this.role(slot.index) === "vllm") {
      const g = await this.gpu(slot.index);
      // vLLM reserves 90% of the GPU; the weights must fit in it with room for a KV cache.
      if (model.size * 1.1 > g.total * 0.9) {
        return new HostError(413, "too_big", `This model needs about ${(model.size * 1.1 / GIB).toFixed(1)} GB; vLLM on GPU ${slot.index} has ${(g.total * 0.9 / GIB).toFixed(1)} GB.`);
      }
      if (all.some((l) => l.active > 0)) return "wait";
      for (const l of all) await this.unload(slot, l);
      return "ready";
    }
    const g = await this.gpu(slot.index);
    const need = this.need(model);
    const idle = all.filter((l) => l.active === 0 && l.ready && !this.pinned(l.model.id)).sort((a, b) => a.lastUsed - b.lastUsed);
    const busy = all.filter((l) => (l.active > 0 || !l.ready) && !this.pinned(l.model.id));
    const free = g.total - g.used - HEADROOM;
    const idleRoom = idle.reduce((n, l) => n + l.vram, 0);
    const busyRoom = busy.reduce((n, l) => n + l.vram, 0);
    if (need > free + idleRoom + busyRoom) {
      const pinned = all.filter((l) => this.pinned(l.model.id)).reduce((n, l) => n + l.vram, 0);
      const gb = (n: number) => (n / GIB).toFixed(1);
      return new HostError(413, "too_big", `This model needs about ${gb(need)} GB; GPU ${slot.index} has ${gb(g.total)} GB, of which ${gb(pinned)} GB is pinned and ${gb(g.used - all.reduce((n, l) => n + l.vram, 0))} GB is used by other programs.`);
    }
    let room = free;
    for (const l of idle) {
      if (room >= need) break;
      await this.unload(slot, l);
      room += l.vram;
    }
    return room >= need ? "ready" : "wait";
  }

  private async load(slot: Slot, model: TextModel): Promise<void> {
    const before = (await this.gpu(slot.index)).used;
    const entry: Loaded = { model, vram: this.need(model), ready: false, active: 0, lastUsed: this.now() };
    slot.loaded.set(model.id, entry);
    slot.changing = true;
    try {
      await this.backend(model).load(model, slot.index);
    } catch (e) {
      slot.loaded.delete(model.id);
      throw e;
    } finally {
      slot.changing = false;
    }
    entry.ready = true;
    if (this.o.state.get().vram[model.id] === undefined && this.role(slot.index) === "shared") {
      const measured = (await this.gpu(slot.index)).used - before;
      if (measured > 0) {
        entry.vram = measured;
        this.o.state.update((s) => {
          s.vram[model.id] = measured;
        });
      }
    }
    this.o.log("loaded", { model: model.id, gpu: slot.index, vram: entry.vram });
  }

  private async unload(slot: Slot, l: Loaded): Promise<void> {
    slot.changing = true;
    try {
      await this.backend(l.model).unload(l.model);
    } finally {
      slot.changing = false;
    }
    slot.loaded.delete(l.model.id);
    this.o.log("unloaded", { model: l.model.id, gpu: slot.index });
  }

  /** Loads a model now (the load API), queued like a chat request. */
  async loadNow(model: TextModel, gpu?: number): Promise<void> {
    await this.run(model, "chat", async () => {}, gpu);
  }

  async unloadNow(id: string): Promise<void> {
    const slot = this.where(id);
    const l = slot?.loaded.get(id);
    if (!slot || !l) return;
    if (l.active > 0 || !l.ready) throw new HostError(409, "in_use", "The model is in use.");
    await this.unload(slot, l);
  }

  async pin(model: TextModel, gpu: number, pinned: boolean): Promise<void> {
    if (!pinned) {
      this.o.state.update((s) => {
        s.pins = s.pins.filter((p) => p.model !== model.id);
      });
      return;
    }
    if (model.server !== "llamacpp" || this.role(gpu) !== "shared") throw new HostError(400, "invalid", "Only llama.cpp models on a shared GPU can be pinned.");
    const at = this.where(model.id);
    if (at && at.index !== gpu) await this.unloadNow(model.id);
    this.o.state.update((s) => {
      s.pins = s.pins.filter((p) => p.model !== model.id);
      s.pins.push({ model: model.id, gpu });
    });
    if (this.runState === "running") await this.loadNow(model, gpu);
  }

  private async loadPins(models: TextModel[]): Promise<void> {
    for (const p of this.o.state.get().pins) {
      const model = models.find((m) => m.id === p.model);
      if (!model || !this.slots.has(p.gpu)) continue;
      await this.loadNow(model, p.gpu).catch((e) => this.o.log("pin not loaded", { model: p.model, code: e instanceof HostError ? e.code : "error" }));
    }
  }

  async setRole(gpu: number, role: Role): Promise<void> {
    const slot = this.slots.get(gpu);
    if (!slot) throw new HostError(404, "not_found", "No such GPU.");
    if ([...slot.loaded.values()].some((l) => l.active > 0 || !l.ready)) throw new HostError(409, "in_use", "The GPU is in use.");
    for (const l of [...slot.loaded.values()]) await this.unload(slot, l);
    this.o.state.update((s) => {
      s.roles[gpu] = role;
      s.pins = s.pins.filter((p) => p.gpu !== gpu);
    });
  }

  private rejectQueued(error: () => HostError): void {
    for (const slot of this.slots.values()) for (const job of [...slot.queue]) this.finish(slot, job, error());
  }

  /** Resolves when nothing is running, loading or unloading. */
  private async idle(): Promise<void> {
    while (this.activeCount() > 0 || [...this.slots.values()].some((s) => s.changing || s.pumping)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const run = this.transition.then(step, step);
    this.transition = run.catch(() => {});
    return run;
  }

  /** Unloads every model on every GPU, noting what couldn't be. */
  private async unloadAll(): Promise<void> {
    this.problems = [];
    for (const slot of this.slots.values()) {
      for (const l of [...slot.loaded.values()]) {
        await this.unload(slot, l).catch(() => this.problems.push(`GPU ${slot.index}: couldn't unload ${l.model.id}; it may still hold memory.`));
      }
    }
    for (const [name, b] of Object.entries(this.o.backends)) {
      await b?.reset().catch((e: Error) => this.problems.push(`${name}: ${e.message}`));
    }
  }

  /**
   * Refuses new work at once, lets the running jobs finish, then unloads
   * every model. Answers right away; the state is "pausing" until then.
   * Survives a restart.
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
    });
    void this.loadPins(models);
  }

  async restart(models: TextModel[]): Promise<void> {
    await this.serial(async () => {
      const was = this.runState === "pausing" ? "paused" : this.runState;
      this.runState = "restarting";
      this.rejectQueued(restarting);
      await this.idle();
      await this.unloadAll();
      this.runState = was === "running" ? "running" : "paused";
    });
    if (this.runState === "running") await this.loadPins(models);
  }

  async status(): Promise<object[]> {
    this.gpus = await this.o.monitor.read().catch(() => this.gpus);
    return this.gpus.map((g) => {
      const slot = this.slots.get(g.index);
      const queue = { chat: 0, image: 0, background: 0 };
      for (const j of slot?.queue ?? []) queue[j.priority]++;
      return {
        index: g.index,
        name: g.name,
        vendor: g.vendor,
        role: this.role(g.index),
        vram: { total: g.total, used: g.used },
        models: [...(slot?.loaded.values() ?? [])].map((l) => ({
          id: l.model.id,
          kind: l.model.kind,
          state: l.ready ? "loaded" : "loading",
          pinned: this.pinned(l.model.id),
          busy: l.active > 0,
          vram: this.o.state.get().vram[l.model.id] ?? null,
          lastUsed: new Date(l.lastUsed).toISOString(),
        })),
        queue,
      };
    });
  }

  /** Unloads models of a kind idle for longer than `ms` (ComfyUI keeps its parts in memory after a job). */
  async unloadIdle(kind: TextModel["kind"], ms: number): Promise<void> {
    for (const slot of this.slots.values()) {
      for (const l of [...slot.loaded.values()]) {
        if (l.model.kind === kind && l.ready && l.active === 0 && this.now() - l.lastUsed > ms) await this.unload(slot, l).catch(() => {});
      }
    }
  }

  /** Where a model is, for the library listing. */
  placement(id: string): { state: "loading" | "loaded"; gpu: number } | null {
    const slot = this.where(id);
    const l = slot?.loaded.get(id);
    return slot && l ? { state: l.ready ? "loaded" : "loading", gpu: slot.index } : null;
  }
}
