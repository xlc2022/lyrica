import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_VISION, registerVisionGuard } from "../src/index.ts";
import { IMAGE_BYTES, IMAGE_LEFT_OUT, leaveOutOldImages, SWITCHED, type VisionFallback } from "../src/vision.ts";

// A model without vision once reported a screenshot it never saw: Pi's read had
// returned the image as a success with a note, and she described it anyway.

type Handler = (event: unknown, ctx: unknown) => unknown;
function guard(fallback?: VisionFallback, switches = true) {
  const handlers = new Map<string, Handler>();
  const handler: Handler = (e, ctx) => handlers.get("tool_result")!(e, ctx);
  const set: unknown[] = [];
  registerVisionGuard({ on: (name: string, h: Handler) => { handlers.set(name, h); }, setModel: async (m: unknown) => { set.push(m); return switches; } } as unknown as ExtensionAPI, fallback);
  const image = { type: "image", data: "aGk=", mimeType: "image/png" };
  const note = { type: "text", text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]" };
  return {
    run: (input: string[], content: unknown[], toolName = "read") => handler({ type: "tool_result", toolName, content, isError: false, input: {} }, { model: { input } }) as Promise<{ content: { text?: string }[]; isError: boolean } | undefined>,
    image, note, set, context: (messages: unknown[]) => handlers.get("context_with_system")!({ type: "context_with_system", messages }, {}) as { messages: unknown[] } | undefined,
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

// A thread that made and looked at about 45 large images sent every one of them in every request: past 64 MiB the
// model host refused each request ("The request is too large."), at about 130k of a 1M-token window, every turn after.
describe("images in a request", () => {
  const MiB = 1 << 20;
  const shot = (mib: number, n: number) => ({ role: "toolResult", content: [{ type: "text", text: `images/${n}.png` }, { type: "image", data: "x".repeat(mib * MiB), mimeType: "image/png" }] });
  const imagesOf = (messages: unknown[]) => (messages as { content: { type: string; text?: string }[] }[]).flatMap((m) => m.content.filter((b) => b.type === "image" || b.text === IMAGE_LEFT_OUT).map((b) => b.type));
  const bytes = (messages: unknown[]) => (messages as { content: { type: string; data?: string }[] }[]).flatMap((m) => m.content).reduce((a, b) => a + (b.type === "image" ? b.data!.length : 0), 0);

  it("leaves the oldest out of the request once they pass the budget, keeping the newest and the text beside each", () => {
    const messages = Array.from({ length: 45 }, (_, i) => shot(3, i));
    const out = leaveOutOldImages(messages);
    expect(bytes(out)).toBeLessThanOrEqual(IMAGE_BYTES);
    expect(bytes(out)).toBeGreaterThan(IMAGE_BYTES / 2);
    const kinds = imagesOf(out);
    expect(kinds).toHaveLength(45);
    expect(kinds.at(-1)).toBe("image");
    // Oldest first, never a gap: every image left out is older than every image kept.
    expect(kinds.lastIndexOf("text")).toBeLessThan(kinds.indexOf("image"));
    // The path she can read again stays; the stored messages are untouched.
    expect((out[0] as { content: { text?: string }[] }).content[0]!.text).toBe("images/0.png");
    expect(bytes(messages)).toBe(45 * 3 * MiB);
  });

  it("changes nothing under the budget, and the cut moves only now and then, so the request's start stays cacheable", () => {
    const few = Array.from({ length: 5 }, (_, i) => shot(3, i));
    expect(leaveOutOldImages(few)).toBe(few);
    const g = guard();
    expect(g.context(few)).toBeUndefined();
    expect(g.context(Array.from({ length: 20 }, (_, i) => shot(3, i)))!.messages).toHaveLength(20);
    // One image more each request: the number left out steps up in pages, not by one each time.
    const left = Array.from({ length: 30 }, (_, n) => imagesOf(leaveOutOldImages(Array.from({ length: n + 1 }, (_, i) => shot(1, i)))).filter((k) => k === "text").length);
    const changes = left.filter((v, i) => i > 0 && v !== left[i - 1]!).length;
    expect(left.at(-1)).toBeGreaterThan(0);
    expect(changes).toBeLessThan(left.filter((v) => v > 0).length / 3);
  });

  it("keeps the newest image even when it alone is over the budget", () => {
    const out = leaveOutOldImages([shot(2, 0), shot(30, 1)]);
    expect(imagesOf(out)).toEqual(["text", "image"]);
  });
});
