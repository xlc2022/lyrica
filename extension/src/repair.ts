import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// Principle 2: a small model's tool call that is nearly right runs rather than
// failing on its shape (docs/briefs/code-evidence.md, part C; from opencode's
// tool-input repair). Pi coerces numbers, booleans and strings by schema; this
// parses an object or array sent as a JSON string, and runs a call to a tool
// named as another harness names it under her own tool's name.

/** Names other harnesses give her tools: each runs as the tool it maps to when no tool has the name. */
export const TOOL_ALIASES: Record<string, string> = {
  read_file: "read", write_file: "write", str_replace: "edit", apply_edit: "edit", shell: "bash", terminal: "bash", run_command: "bash",
};

/** A tool call a server left in the reply's text, in Qwen's XML (closing tags optional) or Hermes' JSON. */
const TEXT_CALL_BLOCK = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;

/**
 * The calls written as text in `text`, outside code, with the text left around them; undefined when
 * there is none, or when one can't be read (the turn tool limits then ask her to make it as a call).
 */
export function textToolCalls(text: string): { calls: { name: string; arguments: Record<string, unknown> }[]; rest: string } | undefined {
  // A call she quotes in a fenced block or an inline span is meant as text.
  const code: string[] = [];
  const hidden = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (m) => `\u0000${code.push(m) - 1}\u0000`);
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let unread = false;
  const rest = hidden.replace(TEXT_CALL_BLOCK, (_m, body: string) => {
    const call = readCall(body);
    if (call) calls.push(call); else unread = true;
    return "";
  });
  if (!calls.length || unread) return undefined;
  return { calls, rest: rest.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)]!).trim() };
}

function readCall(body: string): { name: string; arguments: Record<string, unknown> } | undefined {
  const xml = /^\s*<function=([\w.-]+)>([\s\S]*?)(?:<\/function>\s*)?$/.exec(body);
  if (xml) {
    const args: Record<string, unknown> = {};
    const parts = xml[2]!.split(/<parameter=([\w.-]+)>/);
    if (parts[0]!.trim()) return undefined;
    for (let i = 1; i < parts.length; i += 2) args[parts[i]!] = parts[i + 1]!.replace(/<\/parameter>\s*$/, "").trim();
    return { name: xml[1]!, arguments: args };
  }
  try {
    const j = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown };
    if (typeof j.name === "string" && j.arguments && typeof j.arguments === "object" && !Array.isArray(j.arguments)) return { name: j.name, arguments: j.arguments as Record<string, unknown> };
  } catch { /* not JSON */ }
  return undefined;
}

/** Pi's error for a tool no extension registered. */
const NOT_FOUND = /^Tool (\S+) not found$/;

/** The schema's type, under an Optional wrapper or a nullable union. */
function schemaType(schema: unknown): string | undefined {
  const s = schema as { type?: unknown; anyOf?: unknown[] } | undefined;
  if (!s) return undefined;
  if (typeof s.type === "string") return s.type;
  if (Array.isArray(s.anyOf)) return s.anyOf.map(schemaType).find((t) => t === "object" || t === "array");
  return undefined;
}

/**
 * `args` with each string argument whose schema wants an object or array
 * parsed, when it parses to that type; anything else is left as it came.
 */
export function parsedArguments(args: unknown, parameters: unknown): unknown {
  const props = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || !args || typeof args !== "object" || Array.isArray(args)) return args;
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const want = schemaType(props[key]);
    if (want !== "object" && want !== "array") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { continue; }
    if (want === "array" ? !Array.isArray(parsed) : !parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    (out ??= { ...(args as Record<string, unknown>) })[key] = parsed;
  }
  return out ?? args;
}

/**
 * Repairs her tool calls as each reply ends, before Pi validates them: a JSON
 * string where an object or array is wanted is parsed, and a call to a tool
 * named as another harness names it runs as hers, told so in its result. A
 * name nothing matches lists her active tools in the error, as it is recorded.
 */
export function createRepairExtension(): ExtensionFactory {
  return (pi) => {
    /** Calls renamed this run, by ID: the name she used and the tool it ran as. */
    const renamed = new Map<string, { from: string; to: string }>();
    pi.on("agent_start", () => renamed.clear());
    pi.on("message_end", (e) => {
      const m = e.message;
      // Pi answers a call to a tool nothing registered before any hook runs: the answer is reworded as it is recorded.
      if (m.role === "toolResult") {
        if (!m.isError) return;
        const text = m.content.find((c) => c.type === "text")?.text ?? "";
        const missing = NOT_FOUND.exec(text.trim())?.[1];
        if (!missing) return;
        return { message: { ...m, content: [{ type: "text" as const, text: `There is no ${missing} tool. Your tools: ${pi.getActiveTools().join(", ")}.` }] } };
      }
      if (m.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") return;
      const tools = new Map(pi.getAllTools().map((t) => [t.name, t]));
      const active = new Set(pi.getActiveTools());
      let changed = false;
      let from = m.content;
      // Calls a small model wrote as text (its server didn't parse them) run, when every one names a tool she has on now;
      // stored as calls, her history holds no text call for her to copy.
      if (!m.content.some((c) => c.type === "toolCall")) {
        const found = m.content.map((c) => (c.type === "text" ? textToolCalls(c.text) : undefined));
        const named = found.flatMap((f) => f?.calls ?? []);
        if (!named.length || !named.every((c) => active.has(c.name) || (TOOL_ALIASES[c.name] !== undefined && !tools.has(c.name) && active.has(TOOL_ALIASES[c.name]!)))) return;
        let n = 0;
        from = m.content.flatMap((c, i) => {
          const f = found[i];
          if (!f) return [c];
          return [...(f.rest ? [{ ...c, text: f.rest }] : []), ...f.calls.map((call) => ({ type: "toolCall" as const, id: `text_call_${Date.now().toString(36)}_${n++}`, name: call.name, arguments: call.arguments as never }))];
        });
        changed = true;
      }
      if (!from.some((c) => c.type === "toolCall")) return;
      const content = from.map((c) => {
        if (c.type !== "toolCall") return c;
        let call = c;
        const alias = TOOL_ALIASES[c.name];
        // Only to a tool she has now: one that is off is named as it was, and the error lists what she has.
        if (alias && !tools.has(c.name) && active.has(alias)) {
          renamed.set(c.id, { from: c.name, to: alias });
          call = { ...call, name: alias };
        }
        const args = parsedArguments(call.arguments, tools.get(call.name)?.parameters);
        if (args !== call.arguments) call = { ...call, arguments: args as typeof call.arguments };
        if (call !== c) changed = true;
        return call;
      });
      return changed ? { message: { ...m, content, ...(from !== m.content ? { stopReason: "toolUse" as const } : {}) } } : undefined;
    });
    pi.on("tool_result", (e) => {
      const ran = renamed.get(e.toolCallId);
      if (!ran) return;
      renamed.delete(e.toolCallId);
      return { content: [...e.content, { type: "text" as const, text: `There is no ${ran.from} tool, so this ran as ${ran.to}. Call ${ran.to} next time.` }] };
    });
  };
}
