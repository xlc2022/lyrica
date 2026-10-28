import { describe, expect, it } from "vitest";
import { HostedThread } from "../src/hosted.ts";
import { imagePart, toMessages, videoPart } from "../src/messages.ts";
import type { ThreadEvent } from "../src/api.ts";
import { DELEGATE_MESSAGE } from "@lyrica/extension";

const image = { type: "image" as const, paths: ["/workspace/images/result.png"], model: "workstation/Art", tier: "quality" as const };
const details = { image };

describe("image message metadata (principle 1)", () => {
  it("attaches the image part to the assistant message that made the tool call", () => {
    const messages = toMessages("web/a", "general", [
      { n: 1, createdAt: "2026-10-12", data: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "i1", name: "image", arguments: { action: "create" } }] } } },
      { n: 2, createdAt: "2026-10-12", data: { type: "message", message: { role: "toolResult", toolCallId: "i1", toolName: "image", content: [{ type: "text", text: "Saved result.png." }, { type: "image", data: "bytes", mimeType: "image/png" }], details } } },
    ]);
    expect(messages[0]?.parts).toContainEqual(image);
    expect(JSON.stringify(messages)).not.toContain('"data":"bytes"');
  });
  it("sends image paths/model/tier on tool_end without the image bytes", () => {
    const events: ThreadEvent[] = [];
    // Only the event adapter is exercised: no socket or Pi session is needed.
    const hosted = Object.create(HostedThread.prototype) as { forward(e: unknown): void; emit(e: ThreadEvent): void; pool: string };
    hosted.pool = "general"; hosted.emit = e => { events.push(e); };
    hosted.forward({ type: "tool_execution_end", toolCallId: "i1", toolName: "image", isError: false,
      result: { content: [{ type: "text", text: "Saved result.png." }, { type: "image", data: "bytes", mimeType: "image/png" }], details } });
    expect(events[0]).toMatchObject({ type: "tool_end", image });
    expect(JSON.stringify(events)).not.toContain('"data":"bytes"');
  });
  it("shows a clip's path and facts in stored and live messages, without its bytes or poster", () => {
    const video = { type: "video" as const, path: "/workspace/videos/clip.mp4", model: "workstation/Clip", width: 1280, height: 704, duration: 5.04, audio: false };
    const result = { content: [{ type: "text", text: "Saved clip.mp4. Its first frame:" }, { type: "image", data: "bytes", mimeType: "image/png" }], details: { video } };
    const messages = toMessages("web/a", "general", [
      { n: 1, createdAt: "2026-10-28", data: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "v1", name: "image", arguments: { action: "video" } }] } } },
      { n: 2, createdAt: "2026-10-28", data: { type: "message", message: { role: "toolResult", toolCallId: "v1", toolName: "image", ...result } } },
    ]);
    expect(messages[0]?.parts).toContainEqual(video);
    const events: ThreadEvent[] = [];
    const hosted = Object.create(HostedThread.prototype) as { forward(e: unknown): void; emit(e: ThreadEvent): void; pool: string };
    hosted.pool = "general"; hosted.emit = e => { events.push(e); };
    hosted.forward({ type: "tool_execution_end", toolCallId: "v1", toolName: "image", isError: false, result });
    expect(events[0]).toMatchObject({ type: "tool_end", video });
    expect(JSON.stringify([messages, events])).not.toContain('"data":"bytes"');
    expect(videoPart("image", { video: { ...video, path: 17 } })).toBeUndefined();
    expect(videoPart("read", { video })).toBeUndefined();
  });
  it("shows a clip made in the background as hers, stored and live, and a failed one as a notice", () => {
    const video = { type: "video" as const, path: "/workspace/videos/clip.mp4", model: "workstation/Clip", width: 1280, height: 704, duration: 5.04, audio: false };
    const messages = toMessages("web/a", "general", [
      { n: 1, createdAt: "2026-10-28", data: { type: "custom_message", customType: DELEGATE_MESSAGE, content: "The clip is ready.", display: true, details: { status: "clip", video, id: "a" } } },
      { n: 2, createdAt: "2026-10-28", data: { type: "custom_message", customType: DELEGATE_MESSAGE, content: "The clip failed: out of memory", display: true, details: { status: "clip-failed", id: "b" } } },
    ]);
    expect(messages.map((m) => [m.role, m.parts])).toEqual([
      ["assistant", [video]],
      ["notice", [{ type: "delegation", text: "The clip failed: out of memory", status: "clip-failed" }]],
    ]);
    const events: ThreadEvent[] = [];
    const hosted = Object.create(HostedThread.prototype) as { delivered(c: unknown, d: unknown): void; emit(e: ThreadEvent): void; pool: string; noticed: Set<string>; started(): undefined };
    hosted.pool = "general"; hosted.emit = e => { events.push(e); }; hosted.noticed = new Set(); hosted.started = () => undefined;
    hosted.delivered("The clip is ready.", { status: "clip", video, id: "c" });
    expect(events[0]).toMatchObject({ type: "notice", status: "clip", video });
  });
  it("ignores malformed metadata and another tool's metadata", () => {
    expect(imagePart("read", details)).toBeUndefined();
    expect(imagePart("image", { image: { ...image, paths: [17] } })).toBeUndefined();
    expect(imagePart("image", { image: { ...image, tier: "unknown" } })).toBeUndefined();
  });
});

it("projects refusal codes in stored and live markers, without provider text or bytes", () => {
  const imageRefusal = { code: "image_refusal", offeringId: "art", endpointId: "ep" };
  const result = { content: [{ type: "text", text: "Image generation was refused (image_refusal)." }], details: { imageRefusal }, isError: true };
  const messages = toMessages("web/a", "general", [
    { n: 1, createdAt: "2026-10-12", data: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "i1", name: "image", arguments: { action: "create" } }] } } },
    { n: 2, createdAt: "2026-10-12", data: { type: "message", message: { role: "toolResult", toolCallId: "i1", toolName: "image", ...result } } },
    { n: 3, createdAt: "2026-10-12", data: { type: "custom_message", customType: "lyrica-image-retry", content: result.content, details: { toolCallId: "retry", args: { action: "create" }, result } } },
  ]);
  expect(messages[0]?.parts[0]).toMatchObject({ isError: true, imageRefusal });
  expect(messages[1]?.parts[0]).toMatchObject({ toolCallId: "retry", isError: true, imageRefusal });
  const hosted = Object.create(HostedThread.prototype) as { forward(e: unknown): void; emit(e: ThreadEvent): void; pool: string };
  const events: ThreadEvent[] = []; hosted.pool = "general"; hosted.emit = e => events.push(e);
  hosted.forward({ type: "tool_execution_end", toolCallId: "i1", toolName: "image", isError: true, result });
  expect(events[0]).toMatchObject({ type: "tool_end", imageRefusal });
});
