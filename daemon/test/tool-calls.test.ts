import { describe, expect, it } from "vitest";
import { MAX_REPLY_TOOL_CALLS } from "../../extension/src/tool-stream.ts";
import { fakeOpenAI, type Reply } from "../../core/test/fake-openai.ts";
import type { ThreadEvent, ThreadSummary } from "../src/api.ts";
import { browser, daemon, enc, localModel, login, runtime } from "./helpers.ts";

const steps = (n: number): Reply => ({ tools: Array.from({ length: n }, (_, i) => ({ name: "threads", args: { action: "steps", steps: [{ text: `Step ${i}`, state: "todo" }] } })) });

/** A general thread on a fake local model that answers from `replies`, in order. */
async function setup() {
  const rt = await runtime();
  const dm = await daemon(rt);
  await browser(dm.base).post("/api/unlock", { passphrase: "passphrase" });
  const ada = await login(dm.base, "ada", "pw");
  const model = await fakeOpenAI({ label: "local", models: [{ id: "qwen3.8-27b" }] });
  await localModel(ada, rt.ada.id, model.baseUrl);
  const replies: Reply[] = [];
  model.respond(() => replies.shift() ?? { text: "ok" });
  const thread = (await ada.post<ThreadSummary>(`/api/u/${rt.ada.id}/threads`, { pool: "general", title: "Build" })).body;
  const path = `/api/u/${rt.ada.id}/threads/general/${enc(thread.id)}`;
  const stream = ada.events(`${path}/events`);
  await stream.ready;
  const say = async (text: string): Promise<ThreadEvent[]> => {
    const from = stream.events.length;
    expect((await ada.post(`${path}/messages`, { text })).status).toBe(200);
    await stream.until((e) => e.type === "turn_end", from);
    return stream.events.slice(from).map((e) => e.event);
  };
  return { replies, say };
}

describe("tool calls on the stream", () => {
  it("show as the model starts writing them, then run with their arguments", async () => {
    const { replies, say } = await setup();
    replies.push(steps(2), { text: "Done." });
    const events = await say("plan it");
    const at = (type: string, id: string) => events.findIndex((e) => e.type === type && "toolCallId" in e && e.toolCallId === id);
    for (const id of ["call_1", "call_2"]) {
      expect(events.filter((e) => e.type === "tool_call" && e.toolCallId === id)).toEqual([{ type: "tool_call", toolCallId: id, name: "threads" }]);
      expect(at("tool_call", id)).toBeLessThan(at("tool_start", id));
      expect(events[at("tool_start", id)]).toMatchObject({ args: { action: "steps" } });
    }
    // Both are shown before the first one runs.
    expect(at("tool_call", "call_2")).toBeLessThan(at("tool_start", "call_1"));
  });

  it("show a runaway reply's calls while it streams; the reply then stops and none runs", async () => {
    const { replies, say } = await setup();
    replies.push(steps(MAX_REPLY_TOOL_CALLS + 5));
    const events = await say("plan it");
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(MAX_REPLY_TOOL_CALLS);
    expect(events.some((e) => e.type === "tool_start" || e.type === "tool_end")).toBe(false);
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining(`more than ${MAX_REPLY_TOOL_CALLS} tool calls`) });
  });
});
