import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_VISION, registerVisionGuard } from "../src/index.ts";
import { SWITCHED, type VisionFallback } from "../src/vision.ts";

// A model without vision once reported a screenshot it never saw: Pi's read had
// returned the image as a success with a note, and she described it anyway.

type Handler = (event: unknown, ctx: unknown) => unknown;
function guard(fallback?: VisionFallback, switches = true) {
  let handler!: Handler;
  const set: unknown[] = [];
  registerVisionGuard({ on: (_name: string, h: Handler) => { handler = h; }, setModel: async (m: unknown) => { set.push(m); return switches; } } as unknown as ExtensionAPI, fallback);
  const image = { type: "image", data: "aGk=", mimeType: "image/png" };
  const note = { type: "text", text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]" };
  return {
    run: (input: string[], content: unknown[], toolName = "read") => handler({ type: "tool_result", toolName, content, isError: false, input: {} }, { model: { input } }) as Promise<{ content: { text?: string }[]; isError: boolean } | undefined>,
    image, note, set,
  };
}

describe("an image her model can't see", () => {
  it("fails a read and tells her plainly not to describe it", async () => {
    const g = guard();
    const r = (await g.run(["text"], [g.note, g.image]))!;
    expect(r.isError).toBe(true);
    expect(r.content.at(-1)!.text).toBe(NO_VISION);
    // Another tool's image (one she made, say) keeps its outcome, with the same warning.
    expect(await g.run(["text"], [g.image], "image")).toMatchObject({ isError: false, content: [g.image, { text: NO_VISION }] });
  });

  it("leaves a model with vision, and results without images, alone", async () => {
    const g = guard();
    expect(await g.run(["text", "image"], [g.image])).toBeUndefined();
    expect(await g.run(["text"], [{ type: "text", text: "plain" }])).toBeUndefined();
    // A text file, or command output, that quotes Pi's note is just text.
    expect(await g.run(["text"], [{ type: "text", text: `const note = "${g.note.text}";` }])).toBeUndefined();
    expect(await g.run(["text"], [g.note], "bash")).toBeUndefined();
    // Pi's note alone, on a read of an image, still fails it.
    expect(await g.run(["text"], [g.note])).toMatchObject({ isError: true });
  });

  it("switches a subagent to a local model with vision, keeping the image, and warns as before when there is none", async () => {
    const vision = { id: "gpu/vl" };
    const g = guard(async () => ({ model: vision as never, label: "qwen3.8-27b" }));
    const r = (await g.run(["text"], [g.note, g.image]))!;
    expect(g.set).toEqual([vision]);
    expect(r).toEqual({ isError: false, content: [{ type: "text", text: "Read image file [image/png]" }, g.image, { type: "text", text: SWITCHED("qwen3.8-27b") }] });
    expect((await guard(async () => undefined).run(["text"], [g.note, g.image]))!.content.at(-1)!.text).toBe(NO_VISION);
    // A model that can't be switched to (no key for its provider) leaves the warning too.
    expect((await guard(async () => ({ model: vision as never, label: "x" }), false).run(["text"], [g.note, g.image]))!.content.at(-1)!.text).toBe(NO_VISION);
  });
});
