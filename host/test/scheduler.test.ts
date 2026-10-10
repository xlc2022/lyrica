import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Scheduler, type Priority } from "../src/scheduler.ts";
import { StateFile } from "../src/state.ts";
import { FakeBackend, FakeGpus, GIB, textModel } from "./fakes.ts";

function setup(totals = [24], opts: { waitLimits?: Record<Priority, number>; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "lyrica-sched-"));
  const gpus = new FakeGpus(totals);
  const llamacpp = new FakeBackend(gpus);
  const vllm = new FakeBackend(gpus);
  const state = new StateFile(dir);
  const scheduler = new Scheduler({ monitor: gpus, backends: { llamacpp, vllm }, state, log: () => {}, waitLimits: opts.waitLimits });
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
    await scheduler.pin(pinned, 0, true);
    const busy = hold(scheduler, textModel("busy", 4));
    await busy.started;
    await scheduler.run(textModel("older", 4), "chat", async () => {});
    await scheduler.run(textModel("newer", 4), "chat", async () => {});
    // 24 GB, 1 GB baseline, 4 models of about 4.4 GB: a 5 GB model needs one gone.
    await scheduler.run(textModel("next", 5), "chat", async () => {});
    expect(llamacpp.calls.filter((c) => c.startsWith("unload"))).toEqual(["unload older"]);
    expect(state.get().pins).toEqual([{ model: "pinned", gpu: 0 }]);
    busy.release();
  });

  it("fails at once with a plain reason when a model can never fit", async () => {
    const { scheduler } = setup([24]);
    await scheduler.start([]);
    await scheduler.pin(textModel("pinned", 10), 0, true);
    const err = await scheduler.run(textModel("huge", 15), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("too_big");
    expect(err.message).toMatch(/needs about 18\.0 GB; GPU 0 has 24\.0 GB, of which 11\.0 GB is pinned/);
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
    expect(state.get().vram.m).toBe(Math.round(10 * GIB * 1.1));
  });

  it("swaps the model on a vLLM GPU only when it is idle", async () => {
    const { scheduler, vllm } = setup([80, 24]);
    await scheduler.start([]);
    await scheduler.setRole(0, "vllm");
    const a = textModel("a", 30, { server: "vllm", format: "safetensors" });
    const b = textModel("b", 30, { server: "vllm", format: "safetensors" });
    const holder = hold(scheduler, a);
    await holder.started;
    let ran = false;
    const second = scheduler.run(b, "chat", async () => void (ran = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);
    holder.release();
    await second;
    expect(vllm.calls).toEqual(["load a@0", "unload a", "load b@0"]);
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
    await first.scheduler.pin(pinned, 0, true);
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
    await scheduler.pin(pinned, 0, true);
    await scheduler.pause();
    await scheduler.resume([pinned]);
    await until(() => gpus.loaded.has("pinned"));
    expect(scheduler.runState).toBe("running");
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
    await scheduler.setRole(0, "vllm");
    const err = await scheduler.run(textModel("huge", 30, { server: "vllm" }), "chat", async () => {}).catch((e) => e);
    expect(err.code).toBe("too_big");
  });
});

