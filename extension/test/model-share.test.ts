import { createAssistantMessageEventStream, fauxAssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { KEEP_WARM_MS, markOverflow, MAX_PASSED_MS, modelShare, sharedStream, shareModel } from "../src/model-share.ts";

const scope = {};

describe("a local model shared by threads", () => {
  it("runs as many at once as the server's slots, or as fit when it reports none", async () => {
    const key = "studio\u0000slots";
    const held = [await shareModel(scope, key, 10_000, 262_144, undefined, 2), await shareModel(scope, key, 10_000, 262_144, undefined, 2)];
    let third = false;
    const c = shareModel(scope, key, 10_000, 262_144, undefined, 2).then((r) => { third = true; return r; });
    await Promise.resolve();
    // Two slots: the third waits though it fits.
    expect(third).toBe(false);
    held.pop()!();
    await Promise.resolve();
    expect(third).toBe(true);
    (await c)();
    held.pop()!();

    // No slots reported: everything that fits runs at once.
    const many = await Promise.all(Array.from({ length: 8 }, () => shareModel(scope, key, 10_000, 131_072)));
    expect(modelShare(scope, key)).toMatchObject({ running: 8, waiting: 0 });
    for (const r of many) r();
  });

  it("holds back a request that wouldn't fit beside the running ones, until one ends", async () => {
    const key = "studio\u0000flash";
    const a = await shareModel(scope, key, 140_000, 262_144);
    const b = await shareModel(scope, key, 60_000, 262_144);
    let third = false;
    const c = shareModel(scope, key, 100_000, 262_144).then((r) => { third = true; return r; });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(modelShare(scope, key)).toMatchObject({ running: 2, waiting: 1 });
    b();
    await Promise.resolve();
    // 140k + 100k fits in 262k.
    expect(third).toBe(true);
    (await c)();
    a();
    expect(modelShare(scope, key)).toEqual({ running: 0, waiting: 0, used: 0, kept: 0 });
  });

  it("runs a request bigger than the rest alone, and lets an aborted wait go", async () => {
    const key = "studio\u0000big";
    const a = await shareModel(scope, key, 30_000, 131_072);
    const stop = new AbortController();
    const waiting = shareModel(scope, key, 120_000, 131_072, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(modelShare(scope, key).waiting).toBe(0);
    a();
    const alone = await shareModel(scope, key, 400_000, 131_072);
    expect(modelShare(scope, key).running).toBe(1);
    alone();
  });
});

it("gives a share back when its request aborts or throws, and keeps each daemon's apart", async () => {
  const key = "studio\u0000stall";
  const stop = new AbortController();
  await shareModel(scope, key, 10_000, 131_072, stop.signal);
  // Another daemon in the same process (a restart) starts with none held.
  expect(modelShare({}, key).running).toBe(0);
  stop.abort();
  expect(modelShare(scope, key).running).toBe(0);

  const failed = (reason: "aborted" | "error", message: string) => ({ type: "error" as const, reason, error: { ...fauxAssistantMessage(""), stopReason: reason, errorMessage: message } });
  const out = sharedStream(shareModel(scope, key, 10_000, 131_072), () => { throw new Error("no socket"); }, failed);
  const events = [];
  for await (const e of out) events.push(e);
  expect(events).toMatchObject([{ type: "error", reason: "error", error: { errorMessage: "no socket" } }]);
  expect(modelShare(scope, key).running).toBe(0);
});

it("makes LM Studio's shared-cache error an overflow Pi compacts for", async () => {
  const source = createAssistantMessageEventStream();
  const error = { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: "500 Context size has been exceeded." };
  expect(isContextOverflow(error)).toBe(false);
  source.push({ type: "error", reason: "error", error });
  source.end();
  const out = [];
  for await (const e of markOverflow(source)) out.push(e);
  expect(out[0]!.type === "error" && isContextOverflow(out[0]!.error)).toBe(true);
});

describe("a local model with fewer slots than busy threads", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("keeps a thread's slot for its next call, then gives it to the next in line", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const key = "studio\u0000warm";
      const [ada, sam] = [{}, {}];
      const ask = (holder: object) => shareModel(scope, key, 10_000, 262_144, undefined, 1, holder);
      const first = await ask(ada);
      let samIn = false;
      const samWait = ask(sam).then((r) => { samIn = true; return r; });
      first();
      await Promise.resolve();
      // Ada's tools run; her slot stays hers, and Sam waits.
      expect(samIn).toBe(false);
      expect(modelShare(scope, key)).toMatchObject({ running: 0, kept: 1, waiting: 1 });
      // Her next call takes it at once, ahead of Sam.
      const second = await ask(ada);
      expect(samIn).toBe(false);
      second();
      // Past the keep, Sam gets it.
      vi.advanceTimersByTime(KEEP_WARM_MS);
      await Promise.resolve();
      expect(samIn).toBe(true);

      (await samWait)();
      vi.advanceTimersByTime(KEEP_WARM_MS);
      expect(modelShare(scope, key)).toEqual({ running: 0, waiting: 0, used: 0, kept: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops keeping slots, and passing over, for a request that has waited too long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const key = "studio\u0000starve";
      const [ada, sam] = [{}, {}];
      const ask = (holder: object) => shareModel(scope, key, 10_000, 262_144, undefined, 1, holder);
      let held = await ask(ada);
      let samIn = false;
      const samWait = ask(sam).then((r) => { samIn = true; return r; });
      // Ada calls again and again within the keep: Sam waits, but not past MAX_PASSED_MS.
      for (let t = 0; t < MAX_PASSED_MS; t += 10_000) {
        held();
        vi.advanceTimersByTime(10_000);
        held = await ask(ada);
      }
      expect(samIn).toBe(false);
      held();
      await Promise.resolve();
      expect(samIn).toBe(true);
      expect(modelShare(scope, key).kept).toBe(0);
      (await samWait)();
      vi.advanceTimersByTime(KEEP_WARM_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps no slot for an aborted call, or where the server reports no slots", async () => {
    const key = "studio\u0000nokeep";
    const ada = {};
    const stop = new AbortController();
    await shareModel(scope, key, 10_000, 262_144, stop.signal, 1, ada);
    stop.abort();
    expect(modelShare(scope, key)).toMatchObject({ running: 0, kept: 0 });
    (await shareModel(scope, key, 10_000, 262_144, undefined, undefined, ada))();
    expect(modelShare(scope, key)).toMatchObject({ running: 0, kept: 0 });
    await tick();
  });
});
