import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Scheduler, type Priority } from "../src/scheduler.ts";
import { StateFile } from "../src/state.ts";
import { FakeBackend, FakeGpus, GIB, textModel } from "./fakes.ts";

function setup(totals = [24], opts: { waitLimits?: Record<Priority, number>; dir?: string; servers?: ("llamacpp" | "vllm" | "images")[] } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "lyrica-sched-"));
  const gpus = new FakeGpus(totals);
  const llamacpp = new FakeBackend(gpus);
  const vllm = new FakeBackend(gpus);
  const state = new StateFile(dir);
  const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp, vllm }, state, log: () => {}, waitLimits: opts.waitLimits, servers: opts.servers });
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

  it("fails at once with a plain reason when a model can never fit", async () => {
    const { scheduler } = setup([24]);
    await scheduler.start([]);
    await scheduler.pin(textModel("pinned", 10), true);
    const err = await scheduler.run(textModel("huge", 15), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("too_big");
    expect(err.message).toMatch(/needs about 16\.8 GB on GPU 0; it has 24\.0 GB, of which 11\.5 GB is pinned and 1\.0 GB is used by other programs/);
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

  it("measures a model's VRAM on its first load", async () => {
    const { scheduler, state } = setup([24]);
    await scheduler.start([]);
    await scheduler.loadNow(textModel("m", 10));
    // Weights, a KV cache for its 8k context, and the server's buffers, measured on GPU 0.
    expect(state.get().vram["m@0"]).toEqual({ 0: Math.round(10 * GIB * 1.05) + GIB / 2 + GIB / 2 });
  });

  it("measures again after a model's settings change", async () => {
    const { scheduler, state } = setup([24]);
    await scheduler.start([]);
    const m = textModel("m", 10);
    await scheduler.loadNow(m);
    expect(state.get().vram["m@0"]).toBeDefined();
    scheduler.saveSettings(m, { placement: { mode: "auto" }, contextLength: 16384 });
    expect(state.get().vram["m@0"]).toBeUndefined();
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

  it("on a Vulkan host, offers llama.cpp only", async () => {
    const { scheduler } = setup([24], { servers: ["llamacpp"] });
    await scheduler.start([]);
    expect(scheduler.gpuSettings(0).servers).toEqual(["llamacpp"]);
    const err = await scheduler.run(textModel("v", 4, { server: "vllm", format: "safetensors" }), "chat", async () => {}).catch((e) => e);
    expect(err.message).toBe("No GPU allows vLLM for this model.");
    await scheduler.loadNow(textModel("m", 4));
  });
});

