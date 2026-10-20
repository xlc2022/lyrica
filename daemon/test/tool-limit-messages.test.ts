import { expect, it } from "vitest";
import { EMPTY_REPLY, EMPTY_REPLY_NOTICE, TURN_TOOL_NOTICE } from "@lyrica/extension";
import { HostedThread } from "../src/hosted.ts";
import { toMessages } from "../src/messages.ts";
import type { ThreadEvent } from "../src/api.ts";

const text = "Turn stopped after `100` tool calls.";

it("a stored tool-limit entry comes back as a notice of kind limit, by its kind, not its words", () => {
  const messages = toMessages("web/a", "general", [
    { n: 1, createdAt: "2026-10-12", data: { type: "custom_message", customType: TURN_TOOL_NOTICE, content: text, display: true } },
  ]);
  expect(messages[0]).toMatchObject({ role: "notice", parts: [{ type: "delegation", text, status: "limit" }] });
});

it("a tool-limit entry appended live is emitted as a notice of kind limit", () => {
  const events: ThreadEvent[] = [];
  const hosted = Object.create(HostedThread.prototype) as { forward(e: unknown): void; emit(e: ThreadEvent): void; pool: string };
  hosted.pool = "general"; hosted.emit = (e) => { events.push(e); };
  hosted.forward({ type: "entry_appended", entry: { type: "custom_message", customType: TURN_TOOL_NOTICE, content: text } });
  expect(events).toContainEqual({ type: "notice", text, status: "limit" });
});

it("replies with only thinking, twice, fail the turn live and show as that reply's error after reload", () => {
  const events: ThreadEvent[] = [];
  const hosted = Object.create(HostedThread.prototype) as { forward(e: unknown): void; emit(e: ThreadEvent): void; pool: string };
  hosted.pool = "general"; hosted.emit = (e) => { events.push(e); };
  hosted.forward({ type: "entry_appended", entry: { type: "custom_message", customType: EMPTY_REPLY_NOTICE, content: EMPTY_REPLY } });
  expect(events).toContainEqual({ type: "error", message: EMPTY_REPLY });
  const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "planning" }], stopReason: "stop" };
  const messages = toMessages("web/a", "general", [
    { n: 1, createdAt: "2026-10-20", data: { type: "message", message: thinking } },
    { n: 2, createdAt: "2026-10-20", data: { type: "message", message: thinking } },
    { n: 3, createdAt: "2026-10-20", data: { type: "custom_message", customType: EMPTY_REPLY_NOTICE, content: EMPTY_REPLY, display: true } },
  ]);
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ role: "assistant", error: EMPTY_REPLY });
});
