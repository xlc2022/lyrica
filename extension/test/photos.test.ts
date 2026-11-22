import { describe, expect, it } from "vitest";
import { withModels } from "../../core/test/helpers.ts";
import { markPhoto, modelRuntimeFor, PHOTO_LEFT_OUT } from "../src/index.ts";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A turn whose tool result holds an image, marked as a photo of the user or not. */
const turn = (photo: boolean) => ({
  messages: [
    { role: "user" as const, content: "edit my photo", timestamp: 1 },
    { role: "assistant" as const, content: [{ type: "toolCall" as const, id: "c1", name: "image", arguments: {} }], api: "openai-completions", provider: "x", model: "x",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" as const, timestamp: 2 },
    { role: "toolResult" as const, toolCallId: "c1", toolName: "image", isError: false, timestamp: 3,
      content: [{ type: "text" as const, text: "Saved images/a.png." }, { type: "image" as const, data: PNG, mimeType: "image/png" }],
      details: photo ? markPhoto({ image: {} }) : { image: {} } },
  ],
});

/** What the server got as the tool result's content. */
const sent = (requests: { messages: { role: string; content?: unknown }[] }[]) => JSON.stringify(requests.at(-1)!.messages.filter((m) => m.role !== "system"));

describe("a photo of the user in a tool result", () => {
  async function send(endpoint: "cloud" | "local", photo: boolean, photos?: () => boolean) {
    const s = await withModels();
    const runtime = await modelRuntimeFor(s.models, s.ctx(), photos ? { photos } : {});
    const ep = endpoint === "cloud" ? s.openrouter : s.gpu;
    const id = endpoint === "cloud" ? "deepseek/deepseek-4.1-flash" : "qwen3.8-27b";
    const model = { ...runtime.getModel(ep.id, id)!, input: ["text", "image"] as ("text" | "image")[] };
    await runtime.streamSimple(model, turn(photo)).result();
    return sent((endpoint === "cloud" ? s.cloud : s.local).requests);
  }

  it("is left out of a cloud model's request unless the photo setting allows it now", async () => {
    const never = await send("cloud", true);
    expect(never).not.toContain(PNG);
    expect(never).toContain(PHOTO_LEFT_OUT.slice(1, 40));
    expect(await send("cloud", true, () => false)).not.toContain(PNG);
    expect(await send("cloud", true, () => true)).toContain(PNG);
  });

  it("reaches a local model, and an image that isn't one reaches a cloud model", async () => {
    expect(await send("local", true)).toContain(PNG);
    expect(await send("cloud", false)).toContain(PNG);
  });
});
