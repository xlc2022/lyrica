import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { setToolsOff } from "./gate.ts";

// Principles 1 and 2: stop real tool loops in the runtime, independently of the prompt.
export const MAX_TURN_TOOL_CALLS = 100;
export const MAX_SAME_TOOL_RUN = 25;
export const MAX_IDENTICAL_TOOL_CALLS = 3;
export const TURN_TOOL_NOTICE = "lyrica-tool-limit";
/** Told to her, unseen, once the limit stops her tools: the person gets a reply, never only the notice. */
export const TURN_TOOL_WRAP_UP = "lyrica-tool-limit-wrap-up";
export const WRAP_UP = "You reached this turn's tool limit, so your tools are off for the rest of this turn. Reply now in a few lines: what you did, where things stand, and what's left.";

function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${normalized((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** One budget per prompt/agent run, including every model continuation and nested tool call. */
export function createTurnToolsExtension(): ExtensionFactory {
  return pi => {
    let calls = 0, run = 0, last = "", stopped = false, notified = false, why = "";
    let wrapped = false;
    const repeats = new Map<string, number>();
    const refused = new Map<string, string>();
    // Back on as the run ends: the next prompt's first request is built before agent_start.
    pi.on("agent_end", (_e, ctx) => { if (notified) setToolsOff(pi, ctx, "tool-limit", []); });
    pi.on("agent_start", () => {
      calls = run = 0; last = why = ""; stopped = notified = wrapped = false;
      repeats.clear(); refused.clear();
    });
    // This event precedes schema validation, so malformed and unknown calls count too.
    pi.on("tool_execution_start", e => {
      if (stopped) { refused.set(e.toolCallId, `Turn stopped after ${calls} tool calls.`); return; }
      calls++;
      run = e.toolName === last ? run + 1 : 1;
      last = e.toolName;
      const key = `${e.toolName}:${normalized(e.args)}`;
      const count = (repeats.get(key) ?? 0) + 1;
      repeats.set(key, count);
      if (count >= MAX_IDENTICAL_TOOL_CALLS) refused.set(e.toolCallId, "You already have this result: this tool was called with identical arguments twice. Answer or try something different.");
      if (calls >= MAX_TURN_TOOL_CALLS) { stopped = true; why = `Turn stopped after \`${calls}\` tool calls.`; }
      else if (run >= MAX_SAME_TOOL_RUN) { stopped = true; why = `Turn stopped after \`${run}\` calls in a row to \`${e.toolName}\`.`; }
    });
    pi.on("tool_call", e => {
      const reason = refused.get(e.toolCallId);
      if (reason) return { block: true, reason };
    });
    pi.on("turn_end", (e, ctx) => {
      if (!stopped) return;
      // Her wrap-up came back with tool calls anyway: end there.
      if (notified) {
        if (!wrapped && e.message.role === "assistant" && e.message.content.some((c) => c.type === "toolCall")) { wrapped = true; ctx.abort(); }
        return;
      }
      notified = true;
      // After results are persisted, one more reply with no tools, so the person hears where things stand.
      setToolsOff(pi, ctx, "tool-limit", pi.getAllTools().map((t) => t.name));
      return { entries: [
        { type: "custom_message", customType: TURN_TOOL_NOTICE, content: why, display: true },
        { type: "custom_message", customType: TURN_TOOL_WRAP_UP, content: WRAP_UP, display: false },
      ] };
    });
  };
}
