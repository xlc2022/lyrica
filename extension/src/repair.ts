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
      if (m.role !== "assistant" || !m.content.some((c) => c.type === "toolCall")) return;
      const tools = new Map(pi.getAllTools().map((t) => [t.name, t]));
      const active = new Set(pi.getActiveTools());
      let changed = false;
      const content = m.content.map((c) => {
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
      return changed ? { message: { ...m, content } } : undefined;
    });
    pi.on("tool_result", (e) => {
      const ran = renamed.get(e.toolCallId);
      if (!ran) return;
      renamed.delete(e.toolCallId);
      return { content: [...e.content, { type: "text" as const, text: `There is no ${ran.from} tool, so this ran as ${ran.to}. Call ${ran.to} next time.` }] };
    });
  };
}
