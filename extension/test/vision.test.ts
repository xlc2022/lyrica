import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_VISION, registerVisionGuard } from "../src/index.ts";

// A model without vision once reported a screenshot it never saw: Pi's read had
// returned the image as a success with a note, and she described it anyway.

type Handler = (event: unknown, ctx: unknown) => unknown;
function guard() {
  let handler!: Handler;
  registerVisionGuard({ on: (_name: string, h: Handler) => { handler = h; } } as unknown as ExtensionAPI);
  const image = { type: "image", data: "aGk=", mimeType: "image/png" };
  const note = { type: "text", text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]" };
  return {
    run: (input: string[], content: unknown[], toolName = "read") => handler({ type: "tool_result", toolName, content, isError: false, input: {} }, { model: { input } }) as { content: { text?: string }[]; isError: boolean } | undefined,
    image, note,
  };
}

describe("an image her model can't see", () => {
  it("fails a read and tells her plainly not to describe it", () => {
    const g = guard();
    const r = g.run(["text"], [g.note, g.image])!;
    expect(r.isError).toBe(true);
    expect(r.content.at(-1)!.text).toBe(NO_VISION);
    // Another tool's image (one she made, say) keeps its outcome, with the same warning.
    expect(g.run(["text"], [g.image], "image")).toMatchObject({ isError: false, content: [g.image, { text: NO_VISION }] });
  });

  it("leaves a model with vision, and results without images, alone", () => {
    const g = guard();
    expect(g.run(["text", "image"], [g.image])).toBeUndefined();
    expect(g.run(["text"], [{ type: "text", text: "plain" }])).toBeUndefined();
  });
});
