// The look tool: a model that can see uses its own eyes and isn't offered look; one that can't asks the thread's
// vision model, which gets only the images and the question, and the privacy rules for photos of the user hold.
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CloudModelForbidden, NoModel } from "@lyrica/core";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

/** A plain grey PNG of the given size, made here. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

let sent: { systemPrompt: string; messages: { content: { type: string; text?: string; data?: string }[] }[] } | undefined;
vi.mock("../src/models.ts", async (original) => ({
  ...(await original<object>()),
  modelRuntimeFor: async () => ({ streamSimple: (_m: unknown, context: typeof sent) => { sent = context; return "stream"; } }),
  piModelFor: () => ({ model: { contextWindow: 8192 } }),
}));
vi.mock("../src/context.ts", async (original) => ({
  ...(await original<object>()),
  timedReply: async () => ({ reply: { stopReason: "stop", content: [{ type: "text", text: "A red bicycle by a canal." }] } }),
}));
const { createLookExtension, fitImage, imageSize, imageTokens, registerVisionGuard, MAX_IMAGE_TOKENS, NO_VISION, USE_LOOK } = await import("../src/index.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;
function setup(o: { cloud?: boolean; localOnly?: boolean; portrait?: boolean; policy?: "never" | "ask" | "always"; allow?: boolean; window?: number } = {}) {
  const handlers = new Map<string, Handler[]>();
  let tool!: ToolDefinition;
  let active = ["read", "look"];
  const pi = {
    on: (name: string, h: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], h]); },
    registerTool: (t: ToolDefinition) => { tool = t; },
    getAllTools: () => [{ name: "read" }, { name: "look" }],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const asked: unknown[] = [];
  const recorded: unknown[] = [];
  const needs: { tokens?: number }[] = [];
  const models = {
    // As the router does: a model whose context window is smaller than the need is passed over.
    callWithFallback: async (_task: string, _ctx: unknown, need: { tokens?: number }, call: (r: unknown) => Promise<unknown>) => {
      needs.push(need);
      if (o.window && need.tokens! > o.window) throw new NoModel(`no model for Look at images can answer now (qwen3.5-4b: its context window (${o.window} tokens) is smaller than the conversation)`);
      return call({ label: "qwen3.5-4b", endpoint: { kind: o.cloud ? "cloud" : "local", name: o.cloud ? "router" : "box" } });
    },
    recordCall: (_u: string, c: unknown) => { recorded.push(c); }, recordPace: () => {},
  };
  const settings = { photoCloudPolicy: () => o.policy ?? "ask", photoCloudApproved: () => false, approvePhotoCloud: () => {} };
  createLookExtension({
    models: models as never, threadId: "web/a",
    call: () => ({ userId: "u", pool: "general", localOnly: !!o.localOnly }),
    files: { read: async () => ({ input: { bytes: new Uint8Array([1, 2, 3]), type: "image/png" }, portrait: !!o.portrait }) } as never,
    frames: async (_p, n) => Array.from({ length: n }, (_, i) => ({ at: i * 2 + 1, bytes: Buffer.from("jpg"), type: "image/jpeg" })),
    settings: () => settings as never,
    approve: async (r) => { asked.push(r); return !!o.allow; },
  })(pi);
  registerVisionGuard(pi);
  const fire = (name: string, ctx: unknown, event: unknown = {}) => Promise.all((handlers.get(name) ?? []).map((h) => h(event, ctx)));
  const look = (args: object) => tool.execute("call-1", args as never, undefined, undefined, { hasUI: false } as never) as Promise<{ content: { text: string }[]; details: { images: number } }>;
  return { fire, look, active: () => active, asked, recorded, needs, tool: () => tool };
}
const blind = { model: { input: ["text"] } };
const seeing = { model: { input: ["text", "image"] } };

describe("the look tool", () => {
  it("is offered only while the thread's model can't see, so a model with vision uses its own", async () => {
    const s = setup();
    await s.fire("session_start", seeing);
    expect(s.active()).not.toContain("look");
    await s.fire("model_select", blind);
    expect(s.active()).toContain("look");
    await s.fire("before_agent_start", seeing);
    expect(s.active()).not.toContain("look");
  });

  it("shows the vision model only the images and the question, and hands back its words", async () => {
    const s = setup();
    const r = await s.look({ paths: ["/workspace/uploads/a.png"], question: "What is this?" });
    expect(r.content[0]!.text).toBe("qwen3.5-4b sees:\n\nA red bicycle by a canal.");
    const content = sent!.messages[0]!.content;
    expect(sent!.messages).toHaveLength(1);
    expect(content.map((c) => c.type)).toEqual(["text", "text", "image"]);
    expect(content[0]!.text).toBe("What is this?");
    expect(s.recorded).toMatchObject([{ task: "vision", threadId: "web/a", images: 1 }]);
  });

  it("shows a clip as stills, each saying when it comes from", async () => {
    const s = setup();
    const r = await s.look({ paths: ["/workspace/videos/walk.mp4"], question: "What happens?", frames: 3 });
    expect(r.details.images).toBe(3);
    expect(sent!.messages[0]!.content.filter((c) => c.text?.startsWith("At ")).map((c) => c.text)).toEqual(["At 1 s:", "At 3 s:", "At 5 s:"]);
  });

  it("sees the images of the latest tool result, such as a browse screenshot that has no path", async () => {
    const s = setup({ cloud: true });
    await expect(s.look({ question: "?", recent: true })).rejects.toThrow(/No tool result/);
    await s.fire("tool_result", blind, { toolName: "browse", content: [{ type: "text", text: "shot" }, { type: "image", data: "c2hvdA==", mimeType: "image/png" }], isError: false });
    // A screenshot isn't a photo of the user: a cloud vision model gets it without asking.
    const r = await s.look({ question: "What does the page say?", recent: true });
    expect(r.details.images).toBe(1);
    expect(sent!.messages[0]!.content.find((c) => c.type === "image")!.data).toBe("c2hvdA==");
    expect(s.asked).toEqual([]);
  });

  it("sends an image larger than 2,000 pixels shrunk, as Pi's read does, and a small one as it is", async () => {
    const big = await fitImage(png(3000, 1500), "image/png", "big.png");
    expect(imageSize(Buffer.from(big.data, "base64"))).toEqual({ width: 2000, height: 1000 });
    const small = png(64, 64);
    expect((await fitImage(small, "image/png", "small.png")).data).toBe(small.toString("base64"));
  });

  it("passes over a vision model whose context window can't hold the images, and says so before any call", async () => {
    const one = setup();
    await one.look({ paths: ["/workspace/a.png"], question: "?" });
    const many = setup();
    await many.look({ paths: ["/workspace/a.mp4", "/workspace/b.mp4"], question: "?", frames: 16 });
    // 32 stills need far more room than one image.
    expect(many.needs[0]!.tokens! - one.needs[0]!.tokens!).toBeGreaterThan(31 * 500);
    sent = undefined;
    await expect(setup({ window: 16_384 }).look({ paths: ["/workspace/a.mp4", "/workspace/b.mp4", "/workspace/c.mp4"], question: "?", frames: 16 }))
      .rejects.toThrow(/48 images need about \d+ tokens.*give fewer images, clips or frames/);
    expect(sent).toBeUndefined();
  });

  it("sizes an image by its pixels, as the vision model's encoder does", () => {
    const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
    // A JPEG: SOI, an APP0 segment, then the frame header with height and width.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x00, 0x02, 0x00, 3, 0, 0, 0, 0]);
    expect(imageTokens(png)).toBe(2025);
    expect(imageTokens(jpeg)).toBe(256);
    // A 12 MP photo is scaled down to the encoder's most; an unreadable image is taken as that big.
    png.writeUInt32BE(4000, 16); png.writeUInt32BE(3000, 20);
    expect(imageTokens(png)).toBe(MAX_IMAGE_TOKENS);
    expect(imageTokens(new Uint8Array([1, 2, 3]))).toBe(MAX_IMAGE_TOKENS);
  });

  it("never sends a local-only thread's images to a cloud model", async () => {
    await expect(setup({ cloud: true, localOnly: true }).look({ paths: ["/workspace/a.png"], question: "?" })).rejects.toBeInstanceOf(CloudModelForbidden);
  });

  it("asks before a photo of the user goes to a cloud model, and refuses under Never", async () => {
    const s = setup({ cloud: true, portrait: true });
    await expect(s.look({ paths: ["/photos-of-me/me.png"], question: "?" })).rejects.toThrow(/wasn't approved/);
    expect(s.asked).toMatchObject([{ tool: "look" }]);
    await expect(setup({ cloud: true, portrait: true, policy: "never" }).look({ paths: ["/photos-of-me/me.png"], question: "?" })).rejects.toThrow(/aren't allowed/);
    // A local vision model needs no question.
    const local = setup({ portrait: true });
    await local.look({ paths: ["/photos-of-me/me.png"], question: "?" });
    expect(local.asked).toEqual([]);
  });

  it("tells a model without vision to look rather than describe an image a tool returned", async () => {
    const s = setup();
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const guarded = (await s.fire("tool_result", blind, { toolName: "image", content: [image], isError: false })).find(Boolean);
    expect(guarded).toMatchObject({ content: [image, { text: USE_LOOK }] });
    // With no look tool, she says she couldn't look.
    await s.fire("session_start", seeing);
    const plain = (await s.fire("tool_result", blind, { toolName: "image", content: [image], isError: false })).find(Boolean);
    expect(plain).toMatchObject({ content: [image, { text: NO_VISION }] });
  });
});
