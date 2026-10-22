import { createAssistantMessageEventStream, fauxAssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { markOverflow, modelShare, sharedStream, shareModel } from "../src/model-share.ts";

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
    expect(modelShare(scope, key)).toEqual({ running: 0, waiting: 0, used: 0 });
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
