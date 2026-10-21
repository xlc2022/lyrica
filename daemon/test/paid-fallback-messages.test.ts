import { expect, it } from "vitest";
import { PAID_FALLBACK } from "@lyrica/extension";
import { toMessages } from "../src/messages.ts";

const said = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const reply = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content, model: "paid/thinker", stopReason: "stop" } });

it("puts a paid fallback's line under the turn's last reply, and only that turn's", () => {
  const entries = [
    { type: "custom", customType: PAID_FALLBACK, data: { model: "router/paid/thinker", from: "router/free/thinker:free", reason: "it no longer exists" } },
    said("Hello"),
    reply([{ type: "toolCall", id: "c1", name: "recall", arguments: {} }]),
    { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "recall", content: "nothing" } },
    reply([{ type: "text", text: "Hi." }]),
    said("Again"),
    reply([{ type: "text", text: "Hi again." }]),
  ].map((data, i) => ({ n: i + 1, createdAt: "2026-10-21", data }));
  const replies = toMessages("web/a", "general", entries).filter((m) => m.role === "assistant");
  expect(replies.map((m) => m.paid)).toEqual([undefined, "router/paid/thinker costs money. It answered because router/free/thinker:free was skipped (no longer exists).", undefined]);
});

it("keeps one line per turn when Pi retries, and drops it when the retry lands on a free model", () => {
  const paid = (from: string) => ({ type: "custom", customType: PAID_FALLBACK, data: { model: "router/paid/thinker", from, reason: "it no longer exists" } });
  const failed = { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "connection reset" } };
  const entries = [
    paid("gpu/a"), said("One"), failed, paid("gpu/b"), reply([{ type: "text", text: "First." }]),
    paid("gpu/c"), said("Two"), failed, { type: "custom", customType: PAID_FALLBACK, data: { cleared: true } }, reply([{ type: "text", text: "Second." }]),
    paid("gpu/d"), said("Three"), reply([{ type: "text", text: "Third." }]),
  ].map((data, i) => ({ n: i + 1, createdAt: "2026-10-21", data }));
  const lines = toMessages("web/a", "general", entries).filter((m) => m.role === "assistant").map((m) => m.paid?.match(/gpu\/\w/)?.[0]);
  expect(lines).toEqual([undefined, "gpu/b", undefined, undefined, "gpu/d"]);
});
