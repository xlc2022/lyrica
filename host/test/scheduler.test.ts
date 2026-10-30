import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Logger } from "../src/log.ts";
import { HostError } from "../src/http.ts";
import { Scheduler, type Priority, type QueuePhase } from "../src/scheduler.ts";
import { StateFile } from "../src/state.ts";
import { FakeBackend, FakeGpus, GIB, textModel } from "./fakes.ts";

type Srv = "llamacpp" | "vllm" | "images";
function setup(totals = [24], opts: { waitLimits?: Record<Priority, number>; dir?: string; servers?: Srv[]; gpuBackend?: "rocm" | "vulkan"; sharedMemory?: Srv[]; log?: Logger } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "lyrica-sched-"));
  const gpus = new FakeGpus(totals);
  const llamacpp = new FakeBackend(gpus);
  const vllm = new FakeBackend(gpus);
  const state = new StateFile(dir);
  const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp, vllm }, state, log: opts.log ?? (() => {}), waitLimits: opts.waitLimits, servers: opts.servers, gpuBackend: opts.gpuBackend, sharedMemory: opts.sharedMemory });
  return { dir, gpus, llamacpp, vllm, state, scheduler };
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Starts a request that holds the model until `release` is called. */
function hold(s: Scheduler, model: ReturnType<typeof textModel>, priority: Priority = "chat") {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((ok, fail) => {
    s.run(model, priority, () => {
      ok();
      return done;
    }).catch(fail);
  });
  return { started, release };
}

describe("the GPU queue", () => {
  it("keeps the serving instance when reload cannot fit", async () => {
    const { scheduler, llamacpp } = setup();
    await scheduler.start([]);
    const m = textModel("m", 10, { contextLength: 1048576 });
    await scheduler.pin(m, true);
    scheduler.saveSettings(m, { placement: { mode: "auto" }, contextLength: 1048576 });
    await expect(scheduler.reload(m)).rejects.toMatchObject({ code: "too_big" });
    expect(scheduler.placement(m.id)?.state).toBe("loaded");
    expect(llamacpp.calls).toEqual(["load m@0"]);
    await scheduler.run(m, "chat", async () => {});
  });

  it("restores previous settings when the replacement load fails", async () => {
    const { scheduler, llamacpp, state, dir } = setup();
    await scheduler.start([]);
    const m = textModel("m", 4, { contextLength: 32768 });
    await scheduler.loadNow(m);
    scheduler.saveSettings(m, { placement: { mode: "auto" }, contextLength: 16384 });
    const load = llamacpp.load.bind(llamacpp);
    const contexts: (number | undefined)[] = [];
    let first = true;
    llamacpp.load = async (model, at, settings?: { contextLength?: number }) => {
      contexts.push(settings?.contextLength);
      if (first) {
        first = false;
        throw new HostError(503, "model_unavailable", "load failed");
      }
      await load(model, at);
    };
    await expect(scheduler.reload(m)).rejects.toMatchObject({ code: "model_unavailable" });
    // Restored with no saved context: served at the largest that fits, its trained 32768.
    expect(contexts).toEqual([16384, 32768]);
    expect(scheduler.placement(m.id)?.state).toBe("loaded");
    expect(scheduler.settings(m)).toEqual({ placement: { mode: "auto" } });
    expect(new StateFile(dir).get().models[m.id]).toEqual(state.get().models[m.id]);
    await scheduler.unloadNow(m.id);
    await scheduler.loadNow(m);
    expect(contexts).toEqual([16384, 32768, 32768]);
  });

  it("reports the replacement error when restoring also fails", async () => {
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const { scheduler, llamacpp } = setup([24], { log: (event, fields) => void events.push([event, fields]) });
    await scheduler.start([]);
    const m = textModel("m", 4);
    await scheduler.loadNow(m);
    scheduler.saveSettings(m, { placement: { mode: "auto" }, contextLength: 16384 });
    const original = new HostError(503, "model_unavailable", "replacement failed");
    let attempts = 0;
    llamacpp.load = async () => {
      throw ++attempts === 1 ? original : new Error("restore failed");
    };
    await expect(scheduler.reload(m)).rejects.toBe(original);
    expect(attempts).toBe(2);
    expect(scheduler.settings(m)).toEqual({ placement: { mode: "auto" } });
    expect(events).toContainEqual(["restore failed", { model: "m", error: "Error", message: "restore failed" }]);
  });

  it("validates against other programs, subtracting the host's loaded models", async () => {
    const { scheduler } = setup();
    await scheduler.start([]);
    await scheduler.loadNow(textModel("m", 10));
    expect((await scheduler.validationGpus("llamacpp"))[0]!.used).toBe(GIB);
  });

  it("serves chat, then images, then background work", async () => {
    const { scheduler } = setup([24]);
    await scheduler.start([]);
    const big = textModel("big", 12);
    const holder = hold(scheduler, big);
    await holder.started;
    // Each needs the big model gone first, so they queue.
    const order: string[] = [];
    const want = (id: string, p: Priority) => scheduler.run(textModel(id, 12), p, async () => void order.push(id));
    const jobs = [want("background", "background"), want("image", "image"), want("chat", "chat")];
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    holder.release();
    await Promise.all(jobs);
    expect(order).toEqual(["chat", "image", "background"]);
  });

  it("unloads idle models least recently used first, never pinned or busy ones", async () => {
    const { scheduler, llamacpp, state } = setup([24]);
    await scheduler.start([]);
    const pinned = textModel("pinned", 4);
    await scheduler.pin(pinned, true);
    const busy = hold(scheduler, textModel("busy", 4));
    await busy.started;
    await scheduler.run(textModel("older", 4), "chat", async () => {});
    await scheduler.run(textModel("newer", 4), "chat", async () => {});
    // 24 GB, 1 GB baseline and 0.5 GB kept free; 4 models of about 5.2 GB: a 5 GB model needs one gone.
    await scheduler.run(textModel("next", 5), "chat", async () => {});
    expect(llamacpp.calls.filter((c) => c.startsWith("unload"))).toEqual(["unload older"]);
    expect(state.get().pins).toEqual(["pinned"]);
    busy.release();
  });

  it("waits for an unloaded model's memory to come back before loading the next", async () => {
    const { scheduler, llamacpp, gpus } = setup([24]);
    await scheduler.start([]);
    await scheduler.run(textModel("first", 14), "chat", async () => {});
    // The server says it unloaded at once, but its process lets go of the memory a moment later.
    llamacpp.unload = async (model) => {
      llamacpp.calls.push(`unload ${model.id}`);
      const held = gpus.loaded.get(model.id)!;
      gpus.loaded.set(`${model.id} (exiting)`, held);
      gpus.loaded.delete(model.id);
      setTimeout(() => gpus.loaded.delete(`${model.id} (exiting)`), 600);
    };
    await scheduler.run(textModel("second", 14), "chat", async () => {});
    expect(llamacpp.calls).toEqual(["load first@0", "unload first", "load second@0"]);
  });

  it("waits while an unloaded model frees its memory in steps, as ComfyUI does", async () => {
    const { scheduler, llamacpp, gpus } = setup([24]);
    await scheduler.start([]);
    await scheduler.run(textModel("edit", 18), "chat", async () => {});
    // The server answers before it frees anything; then most goes, and the rest is held a while longer.
    llamacpp.unload = async (model) => {
      llamacpp.calls.push(`unload ${model.id}`);
      setTimeout(() => {
        gpus.loaded.delete(model.id);
        gpus.loaded.set(`${model.id} (freeing)`, { 0: 7 * GIB });
      }, 100);
      setTimeout(() => gpus.loaded.set(`${model.id} (freeing)`, { 0: 6 * GIB }), 400);
      setTimeout(() => gpus.loaded.delete(`${model.id} (freeing)`), 1000);
    };
    await scheduler.run(textModel("create", 16), "chat", async () => {});
    expect(llamacpp.calls).toEqual(["load edit@0", "unload edit", "load create@0"]);
  });

  it("fails at once with a plain reason when a model can never fit", async () => {
    const { scheduler } = setup([24]);
    await scheduler.start([]);
    await scheduler.pin(textModel("pinned", 10), true);
    const err = await scheduler.run(textModel("huge", 15), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("too_big");
    expect(err.message).toMatch(/needs about 16\.8 GB on GPU 0; it has 24\.0 GB, of which 11\.5 GB is pinned and 1\.0 GB is used by other programs and 0\.5 GB is kept free/);
  });

  it("says what the GPU is busy with when the wait runs out", async () => {
    const { scheduler } = setup([24], { waitLimits: { chat: 50, image: 50, background: 50 } });
    await scheduler.start([]);
    const holder = hold(scheduler, textModel("chatting", 15));
    await holder.started;
    const err = await scheduler.run(textModel("other", 10), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("busy");
    expect(err.message).toBe("The GPU is busy with a chat model.");
    holder.release();
  });

  it("keeps a request with its own wait limit past its priority's, saying what it waits for", async () => {
    const { scheduler } = setup([24], { waitLimits: { chat: 50, image: 50, background: 50 } });
    await scheduler.start([]);
    const holder = hold(scheduler, textModel("chatting", 15));
    await holder.started;
    const phases: QueuePhase[] = [];
    const abort = new AbortController();
    let ran = false;
    const waiting = scheduler.run(textModel("other", 10), "chat", async () => { ran = true; }, undefined, abort.signal, { waitLimit: 60_000, phase: (p) => phases.push(p) });
    await new Promise((r) => setTimeout(r, 150));
    expect(phases[0]).toEqual({ state: "waiting", busyWith: "a chat model" });
    holder.release();
    await waiting;
    expect(ran).toBe(true);
    expect(phases.at(-1)).toEqual({ state: "loading" });
  });

  it("takes a request with a long wait limit out of the queue when its client goes", async () => {
    const { scheduler, llamacpp } = setup([24]);
    await scheduler.start([]);
    const holder = hold(scheduler, textModel("chatting", 15));
    await holder.started;
    const abort = new AbortController();
    const waiting = scheduler.run(textModel("other", 10), "chat", async () => {}, undefined, abort.signal, { waitLimit: 60_000 }).catch((e) => e);
    abort.abort();
    expect((await waiting).code).toBe("cancelled");
    holder.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(llamacpp.calls).not.toContain("load other@0");
  });

  it("measures a model's VRAM on its first load", async () => {
    const { scheduler, state } = setup([24]);
    await scheduler.start([]);
    await scheduler.loadNow(textModel("m", 10));
    // Weights, a KV cache for its 8k context, and the server's buffers, measured on GPU 0.
    expect(state.get().vram["m@0~8192"]).toEqual({ 0: Math.round(10 * GIB * 1.05) + GIB / 2 + GIB / 2 });
  });

  it("remeasures first-use buffers so an idle model can be evicted for images", async () => {
    const { scheduler, state, gpus, llamacpp } = setup([24]);
    await scheduler.start([]);
    const chat = textModel("chat", 17);
    await scheduler.loadNow(chat);
    const initial = state.get().vram["chat@0~8192"]![0]!;
    await scheduler.run(chat, "chat", async () => {
      gpus.loaded.get("chat")![0] = initial + 1.9 * GIB;
    });
    expect(state.get().vram["chat@0~8192"]![0]).toBe(initial + 1.9 * GIB);
    // 21.7 GB fits with the real 1 GB baseline and 0.5 GB reserve,
    // but not if the chat server's 1.9 GB growth is treated as another program.
    const image = textModel("image", 21.2 / 1.1, { kind: "image", contextLength: 0 });
    await scheduler.run(image, "image", async () => {});
    expect(llamacpp.calls).toEqual(["load chat@0", "unload chat", "load image@0"]);
    expect(gpus.on("chat")).toEqual([]);
    expect(gpus.on("image")).toEqual([0]);
  });

  it("runs a model its measurement fits, though its estimate no longer would", async () => {
    const { scheduler, state } = setup([24]);
    await scheduler.start([]);
    const m = textModel("m", 10);
    await scheduler.loadNow(m);
    await scheduler.unloadNow("m");
    state.update((s) => {
      s.vram["m@0~8192"] = { 0: 4 * GIB };
    });
    await scheduler.setGpu(0, { ...scheduler.gpuSettings(0), keepFree: 13 * GIB });
    expect(scheduler.neverFits({ model: m })).toBeNull();
    await scheduler.run(m, "chat", async () => {});
  });

  it("keeps the larger first-use measurement across reloads without counting growth twice", async () => {
    const { scheduler, state, gpus } = setup();
    await scheduler.start([]);
    const m = textModel("m", 10);
    await scheduler.loadNow(m);
    const initial = state.get().vram["m@0~8192"]![0]!;
    const serve = () => scheduler.run(m, "chat", async () => {
      gpus.loaded.get("m")![0] = initial + GIB;
    });
    await serve();
    await scheduler.unloadNow("m");
    await scheduler.loadNow(m);
    await serve();
    expect(state.get().vram["m@0~8192"]![0]).toBe(initial + GIB);
  });

  it("does not attribute another model's request growth to the first model", async () => {
    const { scheduler, state, gpus } = setup();
    await scheduler.start([]);
    const a = textModel("a", 4);
    const b = textModel("b", 4);
    await scheduler.loadNow(a);
    await scheduler.loadNow(b);
    const initial = state.get().vram["a@0~8192"]![0]!;
    await scheduler.run(a, "chat", async () => {
      await scheduler.run(b, "chat", async () => {
        gpus.loaded.get("b")![0]! += GIB;
      });
    });
    expect(state.get().vram["a@0~8192"]![0]).toBe(initial);
  });

  it("measures again after a model's settings change", async () => {
    const { scheduler, state } = setup([24]);
    await scheduler.start([]);
    const m = textModel("m", 10);
    await scheduler.loadNow(m);
    // With no context saved, the measurement names the automatic one.
    expect(state.get().vram["m@0~8192"]).toBeDefined();
    scheduler.saveSettings(m, { placement: { mode: "auto" }, contextLength: 16384 });
    expect(Object.keys(state.get().vram)).toEqual([]);
  });

  it("measures again when the automatic context moves, and sizes it around a pinned model", async () => {
    const { scheduler, state } = setup([24]);
    await scheduler.start([]);
    // 256 KB of f16 KV cache a token: 1 GB per 4096 tokens.
    const chat = textModel("chat", 4, { contextLength: 131072, kvPerToken: 2 * 64 * 8 * 128 });
    const contexts = () => Object.keys(state.get().vram).map((k) => Number(k.split("~")[1])).sort((a, b) => b - a);
    await scheduler.loadNow(chat);
    await scheduler.unloadNow("chat");
    // Keeping 4 GB free moves the automatic context, so it is measured again under its own name.
    await scheduler.setGpu(0, { ...scheduler.gpuSettings(0), keepFree: 4 * 1024 ** 3 });
    await scheduler.loadNow(chat);
    await scheduler.unloadNow("chat");
    // A pinned model is never unloaded, so the automatic context leaves room for it, and both load.
    await scheduler.pin(textModel("pinned", 8, { contextLength: 4096 }), true);
    await scheduler.loadNow(chat);
    expect([scheduler.placement("pinned")?.state, scheduler.placement("chat")?.state]).toEqual(["loaded", "loaded"]);
    const [alone, keepFree, besidePin] = contexts().filter((c) => c > 4096);
    expect(alone).toBeGreaterThan(keepFree!);
    expect(keepFree).toBeGreaterThan(besidePin!);
  });

  it("on Auto, uses a GPU with room before unloading anything from a bigger one", async () => {
    const { scheduler, llamacpp } = setup([48, 24]);
    await scheduler.start([]);
    await scheduler.loadNow(textModel("big", 40));
    await scheduler.run(textModel("small", 8), "chat", async () => {});
    expect(llamacpp.calls).toEqual(["load big@0", "load small@1"]);
  });

  it("runs two vLLM models side by side on one GPU, within their memory shares", async () => {
    const { scheduler, vllm, state } = setup([80, 24]);
    await scheduler.start([]);
    const models = ["a", "b", "c"].map((id) => textModel(id, 10, { server: "vllm", format: "safetensors" }));
    for (const m of models) scheduler.saveSettings(m, { placement: { mode: "gpus", gpus: [0] }, memoryShare: 0.4 });
    await scheduler.loadNow(models[0]!);
    await scheduler.loadNow(models[1]!);
    expect(vllm.calls).toEqual(["load a@0", "load b@0"]);
    expect(vllm.placements.get("b")!.share).toBe(0.4);
    // A third doesn't fit beside them: the least recently used goes.
    await scheduler.loadNow(models[2]!);
    expect(vllm.calls).toEqual(["load a@0", "load b@0", "unload a", "load c@0"]);
    void state;
  });

  it("splits a model too big for one GPU over two, only when both have room, and frees both", async () => {
    const { scheduler, gpus, llamacpp } = setup([24, 24]);
    await scheduler.start([]);
    const small = textModel("small", 10);
    scheduler.saveSettings(small, { placement: { mode: "gpus", gpus: [1] } });
    const holder = hold(scheduler, small);
    await holder.started;
    const big = textModel("big", 30);
    let ran = false;
    const split = scheduler.run(big, "chat", async () => void (ran = true));
    await new Promise((r) => setTimeout(r, 30));
    // GPU 0 has room but GPU 1 doesn't while the small model is busy: it waits for both.
    expect(ran).toBe(false);
    expect(gpus.on("big")).toEqual([]);
    holder.release();
    await split;
    expect(gpus.on("big")).toEqual([0, 1]);
    expect(llamacpp.placements.get("big")!.split).toEqual([23.5 * GIB, 23.5 * GIB]);
    expect(llamacpp.calls).toEqual(["load small@1", "unload small", "load big@0+1"]);
    await scheduler.unloadNow("big");
    expect(gpus.on("big")).toEqual([]);
  });

  it("refuses a model that needs remote code", async () => {
    const { scheduler } = setup([24]);
    await scheduler.start([]);
    const err = await scheduler.run(textModel("x", 1, { server: "vllm", remoteCode: true }), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("refused");
  });
});

describe("pause", () => {
  it("finishes the current job, unloads everything, and refuses work", async () => {
    const { scheduler, gpus } = setup([24]);
    await scheduler.start([]);
    const holder = hold(scheduler, textModel("a", 4));
    await holder.started;
    const queued = scheduler.run(textModel("b", 30), "chat", async () => {}).catch((e) => e);
    await scheduler.pause();
    expect(scheduler.runState).toBe("pausing");
    expect((await queued).code).toBe("paused");
    expect((await scheduler.run(textModel("c", 1), "chat", async () => {}).catch((e) => e)).code).toBe("paused");
    expect(gpus.loaded.size).toBe(1);
    holder.release();
    await until(() => scheduler.runState === "paused");
    expect(gpus.loaded.size).toBe(0);
    expect(scheduler.problems).toEqual([]);
  });

  it("survives a restart, and resume loads the pinned models again", async () => {
    const first = setup([24]);
    await first.scheduler.start([]);
    const pinned = textModel("pinned", 2);
    await first.scheduler.pin(pinned, true);
    await first.scheduler.pause();
    await until(() => first.scheduler.runState === "paused");

    const again = setup([24], { dir: first.dir });
    await again.scheduler.start([pinned]);
    expect(again.scheduler.runState).toBe("paused");
    expect(again.gpus.loaded.size).toBe(0);
    expect((await again.scheduler.run(pinned, "chat", async () => {}).catch((e) => e)).code).toBe("paused");
    await again.scheduler.resume([pinned]);
    await new Promise((r) => setTimeout(r, 20));
    expect(again.scheduler.runState).toBe("running");
    expect([...again.gpus.loaded.keys()]).toEqual(["pinned"]);
  });

  it("lets a load in progress finish, then unloads it: paused means nothing in VRAM", async () => {
    const { scheduler, gpus, llamacpp } = setup([24]);
    await scheduler.start([]);
    llamacpp.loadMs = 100;
    const loading = scheduler.run(textModel("slow", 4), "chat", async () => {}).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.pause();
    await until(() => scheduler.runState === "paused");
    await loading;
    expect(gpus.loaded.size).toBe(0);
  });

  it("says so when pausing couldn't free a GPU", async () => {
    const { scheduler, llamacpp } = setup([24]);
    await scheduler.start([]);
    await scheduler.loadNow(textModel("stuck", 4));
    llamacpp.unload = async () => {
      throw new Error("no");
    };
    llamacpp.reset = async () => {
      throw new Error("llama.cpp couldn't unload 1 model.");
    };
    await scheduler.pause();
    await until(() => scheduler.runState === "paused");
    expect(scheduler.problems).toEqual(["GPU 0: couldn't unload stuck; it may still hold memory.", "llamacpp: llama.cpp couldn't unload 1 model."]);
  });

  it("runs a pause and a quick resume one after the other", async () => {
    const { scheduler, gpus } = setup([24]);
    await scheduler.start([]);
    const pinned = textModel("pinned", 2);
    await scheduler.pin(pinned, true);
    await scheduler.pause();
    await scheduler.resume([pinned]);
    await until(() => gpus.loaded.has("pinned"));
    expect(scheduler.runState).toBe("running");
  });
});

describe("pause during a restart", () => {
  it("wins: the host ends paused with nothing loaded", async () => {
    const { scheduler, gpus, llamacpp } = setup([24]);
    await scheduler.start([]);
    const pinned = textModel("pinned", 2);
    await scheduler.pin(pinned, true);
    llamacpp.loadMs = 50;
    const restarting = scheduler.restart([pinned]);
    await scheduler.pause();
    await restarting;
    await until(() => scheduler.runState === "paused");
    await new Promise((r) => setTimeout(r, 100));
    expect(scheduler.runState).toBe("paused");
    expect(gpus.loaded.size).toBe(0);
    expect((await scheduler.run(pinned, "chat", async () => {}).catch((e) => e)).code).toBe("paused");
  });
});

describe("requests", () => {
  it("drops a queued request whose client has gone, without loading its model", async () => {
    const { scheduler, llamacpp } = setup([24]);
    await scheduler.start([]);
    const holder = hold(scheduler, textModel("big", 15));
    await holder.started;
    const abort = new AbortController();
    const gone = scheduler.run(textModel("other", 10), "chat", async () => {}, undefined, abort.signal).catch((e) => e);
    abort.abort();
    expect((await gone).code).toBe("cancelled");
    holder.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(llamacpp.calls).not.toContain("load other@0");
  });

  it("refuses a vLLM model too big for its GPU", async () => {
    const { scheduler } = setup([24]);
    await scheduler.start([]);
    const err = await scheduler.run(textModel("huge", 30, { server: "vllm" }), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("too_big");
  });

  it("puts nothing on a GPU that is left out or doesn't allow the server", async () => {
    const { scheduler, gpus } = setup([24, 24]);
    await scheduler.start([]);
    await scheduler.setGpu(0, { servers: ["llamacpp"], keepFree: GIB / 2, excluded: true });
    await scheduler.setGpu(1, { servers: ["images"], keepFree: GIB / 2, excluded: false });
    const err = await scheduler.run(textModel("m", 4), "chat", async () => {}).catch((e) => e);
    expect(err.message).toBe("No GPU allows llama.cpp for this model.");
    await scheduler.setGpu(1, { servers: ["llamacpp"], keepFree: GIB / 2, excluded: false });
    await scheduler.loadNow(textModel("m", 4));
    expect(gpus.on("m")).toEqual([1]);
  });

  it("leaves an integrated GPU out beside a discrete one, until it's included", async () => {
    const { scheduler, gpus } = setup([16, 32]);
    gpus.gpus[1]!.integrated = true;
    await scheduler.start([]);
    expect(scheduler.gpuSettings(1).excluded).toBe(true);
    expect(scheduler.gpuSettings(0).excluded).toBe(false);
    // 20 GB fits only on the integrated GPU, which is left out.
    expect((await scheduler.run(textModel("big", 20), "chat", async () => {}).catch((e) => e)).code).toBe("too_big");
    await scheduler.setGpu(1, { servers: ["llamacpp"], keepFree: GIB / 2, excluded: false });
    await scheduler.loadNow(textModel("big", 20));
    expect(gpus.on("big")).toEqual([1]);
  });

  it("on ROCm, plans an integrated GPU's shared memory only for llama.cpp with unified memory", async () => {
    // A 780M alone: a 2 GB carve-out and 30 GB of shared memory.
    const { scheduler, gpus } = setup([32], { gpuBackend: "rocm", sharedMemory: ["llamacpp"] });
    Object.assign(gpus.gpus[0]!, { integrated: true, used: 0, carveOut: { total: 2 * GIB, used: 0 } });
    await scheduler.start([]);
    expect(scheduler.gpuSettings(0).servers).toEqual(["llamacpp"]);
    await scheduler.loadNow(textModel("m", 10));
    expect(gpus.on("m")).toEqual([0]);
    // vLLM, allowed by hand, sees the carve-out only.
    await scheduler.setGpu(0, { servers: ["llamacpp", "vllm"], keepFree: GIB / 2, excluded: false });
    const err = await scheduler.run(textModel("v", 4, { server: "vllm", format: "safetensors" }), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("too_big");
    expect(scheduler.gpusFor("vllm")[0]!.total).toBe(2 * GIB);
    // Without unified memory, llama.cpp sees the carve-out only too.
    const plain = setup([32], { gpuBackend: "rocm" });
    Object.assign(plain.gpus.gpus[0]!, { integrated: true, used: 0, carveOut: { total: 2 * GIB, used: 0 } });
    await plain.scheduler.start([]);
    expect((await plain.scheduler.run(textModel("m", 10), "chat", async () => {}).catch((e) => e)).code).toBe("too_big");
  });

  it("never puts vLLM on a CMP 100-210, whose sm_70 its PyTorch has no kernels for", async () => {
    const { scheduler, gpus } = setup([16, 24]);
    gpus.gpus[0]!.pciId = "10de:1df4";
    await scheduler.start([]);
    expect(scheduler.gpuSettings(0).servers).toEqual(["llamacpp", "images", "speech"]);
    // Not even when allowed by hand.
    await scheduler.setGpu(0, { servers: ["llamacpp", "vllm", "images", "speech"], keepFree: GIB / 2, excluded: false });
    expect(scheduler.gpuSettings(0).servers).toEqual(["llamacpp", "images", "speech"]);
    expect(scheduler.gpuSettings(1).servers).toContain("vllm");
    const v = textModel("v", 4, { server: "vllm", format: "safetensors" });
    await scheduler.loadNow(v);
    expect(gpus.on("v")).toEqual([1]);
    // With the other GPU closed to it, the reason names the card.
    await scheduler.setGpu(1, { servers: ["llamacpp"], keepFree: GIB / 2, excluded: false });
    const err = await scheduler.run(textModel("w", 4, { server: "vllm", format: "safetensors" }), "chat", async () => {}).catch((e) => e);
    expect(err.message).toBe("vLLM can't run on a CMP 100-210, and no other GPU here allows it.");
  });

  it("on a Vulkan host, offers llama.cpp only", async () => {
    const { scheduler } = setup([24], { servers: ["llamacpp"] });
    await scheduler.start([]);
    expect(scheduler.gpuSettings(0).servers).toEqual(["llamacpp"]);
    const err = await scheduler.run(textModel("v", 4, { server: "vllm", format: "safetensors" }), "chat", async () => {}).catch((e) => e);
    expect(err.message).toBe("No GPU allows vLLM for this model.");
    await scheduler.loadNow(textModel("m", 4));
  });
});

