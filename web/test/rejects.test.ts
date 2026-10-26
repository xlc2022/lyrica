import { describe, expect, it } from "vitest";
import type { MessagePart } from "../src/api.ts";
import { rejectedPath, sortImages, type TurnEntry } from "../src/rejects.ts";

const A = "/workspace/images/aaaaaaaa-0000-0000-0000-000000000000.png";
const B = "/workspace/images/bbbbbbbb-0000-0000-0000-000000000000.png";
const C = "/workspace/images/cccccccc-0000-0000-0000-000000000000.png";
const made = (path: string, model = "Flux"): MessagePart => ({ type: "image", paths: [path], model, tier: "fast" });
const tool = (id: string, args: unknown, isError = false): MessagePart => ({ type: "tool", toolCallId: id, name: "image", args, result: "ok", isError });
const hers = (key: string, ...parts: MessagePart[]): TurnEntry => ({ key, parts });
const user = (key: string): TurnEntry => ({ key, user: true });

describe("her rejected image attempts", () => {
  it("folds a turn's rejects into one group where the first was, and shows the last attempt on its own", () => {
    const out = sortImages([user("u"), hers("1", made(A)), hers("2", tool("r1", { action: "reject", images: [A] })), hers("3", made(B)),
      hers("4", tool("r2", { action: "reject", images: ["images/bbbbbbbb-0000-0000-0000-000000000000.png"] })), hers("5", made(C))]);
    expect(out.get("1")!.groups.get(0)).toEqual([
      { type: "image", paths: [rejectedPath(A)], model: "Flux", tier: "fast" },
      { type: "image", paths: [rejectedPath(B)], model: "Flux", tier: "fast" },
    ]);
    expect(out.get("1")!.parts.get(0)).toBeNull();
    expect(out.get("3")!.parts.get(0)).toBeNull();
    expect(out.get("3")!.groups.size).toBe(0);
    expect(out.get("5")!.parts.get(0)).toEqual(made(C));
  });

  it("shows a picked earlier attempt last, with its first part's facts, and keeps a failed reject's image in place", () => {
    const out = sortImages([user("u"), hers("1", made(A, "Flux")), hers("2", tool("r", { action: "reject", images: [A] })), hers("3", made(B, "Z-Image")),
      hers("4", tool("x", { action: "reject", images: [B] }, true)),
      hers("5", tool("r2", { action: "reject", images: [B] }), tool("p", { action: "pick", image: rejectedPath(A) }), { type: "image", paths: [A], model: "", picked: true })]);
    expect(out.get("1")!.parts.get(0)).toBeNull();
    expect(out.get("3")!.groups.get(0)).toEqual([{ type: "image", paths: [rejectedPath(B)], model: "Z-Image", tier: "fast" }]);
    expect(out.get("5")!.parts.get(2)).toEqual({ type: "image", paths: [A], model: "Flux", tier: "fast", picked: true });
  });

  it("keeps each turn's rejects in that turn, and marks them deleted once she clears them", () => {
    const out = sortImages([user("u1"), hers("1", made(A)), hers("2", tool("r", { action: "reject", images: [A] })), hers("3", made(B)),
      user("u2"), hers("4", tool("c", { action: "clear_rejected" }))]);
    expect(out.get("1")!.groups.get(0)).toEqual([{ type: "image", paths: [rejectedPath(A)], model: "Flux", tier: "fast", deleted: true }]);
    expect(out.get("3")!.parts.get(0)).toEqual(made(B));
  });
});
