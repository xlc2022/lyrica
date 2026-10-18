import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";

// Principles 1 and 2: two runtime guards for OpenAI-compatible endpoints (local
// servers and model hosts), where weak models and strict servers meet.

/** More tool calls than this in one reply is a runaway: the reply ends with an error. */
export const MAX_REPLY_TOOL_CALLS = 32;

/**
 * Every tool's parameters as `"type": "object"`: LM Studio refuses a request
 * whose tool parameters lack it (an MCP server's schema, say), and the whole
 * turn fails with a 400. A schema that already says so is passed as it is.
 */
export function objectTools(context: TranscriptContext): TranscriptContext {
  const loose = (t: Tool) => (t.parameters as { type?: unknown }).type !== "object";
  if (!context.messages.some((m) => m.role === "system" && m.toolsAdded?.some(loose))) return context;
  const fix = (t: Tool): Tool => loose(t)
    ? { ...t, parameters: { ...t.parameters, type: "object", properties: (t.parameters as { properties?: object }).properties ?? {} } as Tool["parameters"] } : t;
  return { ...context, messages: context.messages.map((m) => m.role === "system" && m.toolsAdded ? { ...m, toolsAdded: m.toolsAdded.map(fix) } : m) };
}

/**
 * Ends a reply that streams more than MAX_REPLY_TOOL_CALLS tool calls, and
 * stops the request so the server stops generating. Tool calls show only once
 * a reply ends, so a model repeating one call would otherwise stream hundreds
 * with nothing to see, then run them all.
 */
export function capToolCalls(source: AssistantMessageEventStream, stop: () => void): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let calls = 0;
    for await (const event of source) {
      if (event.type === "toolcall_start" && ++calls > MAX_REPLY_TOOL_CALLS) {
        stop();
        const content = event.partial.content.filter((b) => b.type !== "toolCall");
        out.push({ type: "error", reason: "error", error: { ...event.partial, content, stopReason: "error",
          errorMessage: `The model sent more than ${MAX_REPLY_TOOL_CALLS} tool calls in one reply, so the reply was stopped and none of them ran.` } });
        break;
      }
      out.push(event);
    }
    out.end();
  })();
  return out;
}
