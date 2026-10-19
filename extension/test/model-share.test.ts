import { createAssistantMessageEventStream, fauxAssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { concurrentLimit, markOverflow, modelShare, shareModel } from "../src/model-share.ts";

describe("a local model shared by threads", () => {
  it("runs as many at once as the operator's tiers allow", () => {
    expect([131_072, 199_999, 200_000, 262_144, 499_999, 500_000, 1_048_576].map((w) => concurrentLimit(w))).toEqual([1, 1, 2, 2, 2, 4, 4]);
    // Never more than the server's own slots.
    expect(concurrentLimit(1_048_576, 2)).toBe(2);
  });

  it("holds back a request that wouldn't fit beside the running ones, until one ends", async () => {
    const key = "studio\u0000flash";
    const a = await shareModel(key, 140_000, 262_144);
    const b = await shareModel(key, 60_000, 262_144);
    let third = false;
    const c = shareModel(key, 100_000, 262_144).then((r) => { third = true; return r; });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(modelShare(key)).toMatchObject({ running: 2, waiting: 1 });
    b();
    await Promise.resolve();
    // Two are allowed, but 140k + 100k still fits in 262k.
    expect(third).toBe(true);
    (await c)();
    a();
    expect(modelShare(key)).toEqual({ running: 0, waiting: 0, used: 0 });
  });

  it("runs a request bigger than the rest alone, and lets an aborted wait go", async () => {
    const key = "studio\u0000big";
    const a = await shareModel(key, 30_000, 131_072);
    const stop = new AbortController();
    const waiting = shareModel(key, 20_000, 131_072, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(modelShare(key).waiting).toBe(0);
    a();
    const alone = await shareModel(key, 400_000, 131_072);
    expect(modelShare(key).running).toBe(1);
    alone();
  });
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
