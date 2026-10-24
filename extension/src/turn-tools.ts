import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CHILD_WAKES } from "@lyrica/core";
import { setToolsOff } from "./gate.ts";

// Principles 1 and 2: stop real tool loops in the runtime, independently of the prompt.
export const MAX_TURN_TOOL_CALLS = 100;
export const MAX_SAME_TOOL_RUN = 25;
export const MAX_IDENTICAL_TOOL_CALLS = 3;
export const TURN_TOOL_NOTICE = "lyrica-tool-limit";
/** Told to her, unseen, once the limit stops her tools: the person gets a reply, never only the notice. */
export const TURN_TOOL_WRAP_UP = "lyrica-tool-limit-wrap-up";
export const WRAP_UP = "You reached this turn's tool limit, so your tools are off for the rest of this turn. Reply now in a few lines: what you did, where things stand, and what's left.";
/** Told to her, unseen, after a reply with only thinking in it: no text and no tool call. */
export const EMPTY_REPLY_RETRY = "lyrica-empty-reply-retry";
export const CARRY_ON = "Your last reply had only thinking in it: no text and no tool call. Carry on from there: make the tool call you meant to, or write your reply.";
/** Shown, and reported as the turn's error, when the retry came back empty too. */
export const EMPTY_REPLY_NOTICE = "lyrica-empty-reply";
export const EMPTY_REPLY = "The model replied with only its thinking, twice: no answer and no tool call.";
/** Told to her, unseen, after a reply whose tool call came through as text, so nothing ran. */
export const TEXT_TOOL_CALL_RETRY = "lyrica-text-tool-call-retry";
export const CALL_THE_TOOL = "Your last reply wrote a tool call as text, so it didn't run. Make that call as a tool call, or write your reply without it.";
/** Shown, as a `lyrica-empty-reply` notice, when the retry wrote its call as text too. */
export const TEXT_TOOL_CALL = "The model wrote its tool call as text, twice, so it didn't run.";
/**
 * A tool call a server left in the reply's text: closed in any format; GLM's `<arg_key>…</arg_key><arg_value>`
 * pairs, wrapped or not; or a call cut off unclosed at the reply's end (Hermes' JSON, Qwen's `<function=`).
 */
const TEXT_CALL = new RegExp([
  /<tool_call>[\s\S]*?<\/tool_call>/,
  /<function=[\w.-]+>[\s\S]*?<\/function>/,
  /<arg_key>[^<]*<\/arg_key>\s*<arg_value>/,
  /<tool_call>\s*(?:\{|<function=)/,
  /<function=[\w.-]+>\s*<parameter=/,
].map((r) => r.source).join("|"));
/** Text outside code: a call she quotes in a fenced block or an inline span is meant as text. */
const outsideCode = (text: string) => text.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "");
/** Written into a thread whose turn a restart cut off, shown as that turn's error. */
export const INTERRUPTED_NOTICE = "lyrica-interrupted";
export const INTERRUPTED = "Interrupted when Lyrica restarted, before this turn finished. Send a message to go on.";

/** A `threads read`: reading a working child again only waits for what its end will bring anyway. */
const isThreadRead = (tool: string, args: unknown) => tool === "threads" && (args as { action?: unknown } | null)?.action === "read";

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
    let empty = 0, asText = 0;
    /** The thinking level to go back to after a retry without thinking. */
    let thinking: ThinkingLevel | null = null;
    const repeats = new Map<string, number>();
    const refused = new Map<string, string>();
    // Back on as the run ends: the next prompt's first request is built before agent_start.
    pi.on("agent_end", (_e, ctx) => {
      if (notified) setToolsOff(pi, ctx, "tool-limit", []);
      if (thinking) pi.setThinkingLevel(thinking);
      thinking = null;
    });
    pi.on("agent_start", () => {
      calls = run = empty = asText = 0; last = why = ""; stopped = notified = wrapped = false;
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
      if (count >= MAX_IDENTICAL_TOOL_CALLS) refused.set(e.toolCallId, isThreadRead(e.toolName, e.args)
        ? `You already read this thread twice with these arguments. If it is still working: ${CHILD_WAKES}`
        : "You already have this result: this tool was called with identical arguments twice. Answer or try something different.");
      if (calls >= MAX_TURN_TOOL_CALLS) { stopped = true; why = `Turn stopped after \`${calls}\` tool calls.`; }
      else if (run >= MAX_SAME_TOOL_RUN) { stopped = true; why = `Turn stopped after \`${run}\` calls in a row to \`${e.toolName}\`.`; }
    });
    pi.on("tool_call", e => {
      const reason = refused.get(e.toolCallId);
      if (reason) return { block: true, reason };
    });
    pi.on("turn_end", (e, ctx) => {
      // A reply with only thinking ends the run with nothing said or done: once, she carries on; again, the turn fails visibly.
      const m = e.message;
      if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted"
        && !m.content.some((c) => c.type === "toolCall" || (c.type === "text" && c.text.trim()))) {
        if (++empty === 1) {
          // Thinking that ran until the reply limit would only do it again: the retry goes without it.
          if (m.stopReason === "length" && pi.getThinkingLevel() !== "off") {
            thinking = pi.getThinkingLevel();
            pi.setThinkingLevel("off");
          }
          pi.sendMessage({ customType: EMPTY_REPLY_RETRY, content: CARRY_ON, display: false }, { deliverAs: "followUp", triggerTurn: true });
          return;
        }
        if (empty === 2) return { entries: [{ type: "custom_message", customType: EMPTY_REPLY_NOTICE, content: EMPTY_REPLY, display: true }] };
      }
      // A tool call left in the text would end the run as her reply: once, she makes it as a call; again, the turn fails visibly.
      if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && !stopped
        && !m.content.some((c) => c.type === "toolCall") && m.content.some((c) => c.type === "text" && TEXT_CALL.test(outsideCode(c.text)))) {
        if (++asText === 1) {
          pi.sendMessage({ customType: TEXT_TOOL_CALL_RETRY, content: CALL_THE_TOOL, display: false }, { deliverAs: "followUp", triggerTurn: true });
          return;
        }
        if (asText === 2) return { entries: [{ type: "custom_message", customType: EMPTY_REPLY_NOTICE, content: TEXT_TOOL_CALL, display: true }] };
      }
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
