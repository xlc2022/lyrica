// Principle 8: a local model re-reads the whole conversation whenever the top of
// her prompt changes, so the top stays as the model has it until a compaction
// rebuilds it; what changed since goes in the turn's messages.
import { createHash } from "node:crypto";
import { getCurrentSystemMessage, getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Each turn's message: opening, recall, time and the topics routed for the first time. */
export const TURN_MESSAGE = "lyrica-turn";
/** A turn's message with the sections of the top that changed since she was last told. */
export const TOP_MESSAGE = "lyrica-top";

/** Pi's own sections, which follow its options rather than ours. */
const PI_SECTIONS = new Set(["preamble", "cwd", "project_context", "addendum", "rules", "docs"]);

/** What each section or topic held when she was last told it, by a short hash: kept on the turn's messages, so a reopened session knows. */
export type Told = Record<string, string | null>;

const hash = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 16);

/** Told as these sections hold. */
export const toldOf = (sections: Record<string, string>): Told => Object.fromEntries(Object.entries(sections).map(([n, t]) => [n, hash(t)]));

/**
 * The latest message of this type since the top was built ("none" if there is
 * none), or undefined when the top is to be rebuilt: a new thread, or the
 * first turn since a compaction.
 */
export function sinceTop(ctx: ExtensionContext, customType: string): { details?: { told?: Told } } | "none" | undefined {
  const sm = ctx.sessionManager;
  if (!sm) return undefined;
  const branch = sm.getBranch();
  const compaction = branch.findLastIndex((e) => e.type === "compaction");
  const turn = branch.findLastIndex((e) => e.type === "custom_message" && e.customType === TURN_MESSAGE);
  if (turn < 0 || compaction > turn) return undefined;
  const at = branch.findLastIndex((e) => e.type === "custom_message" && e.customType === customType);
  return at > compaction ? branch[at] as { details?: { told?: Told } } : "none";
}

/** The topics to send this turn: each routed for the first time since the top was built. */
export function freshTopics(ctx: ExtensionContext, topics: { id: string; text: string }[]): { topics: { id: string; text: string }[]; told: Told } {
  const last = sinceTop(ctx, TURN_MESSAGE);
  const told = typeof last === "object" ? last.details?.told ?? {} : {};
  const fresh = topics.filter((t) => told[t.id] !== hash(t.text));
  return { topics: fresh, told: { ...told, ...Object.fromEntries(fresh.map((t) => [t.id, hash(t.text)])) } };
}

/** The top the model has now: its persona core, its tools, and its sections as the extensions set them, untagged. */
function heldTop(ctx: ExtensionContext): { preamble?: string; tools: Tool[]; sections: Record<string, string> } | undefined {
  const sm = ctx.sessionManager;
  const { messages } = buildSessionContext(sm.getEntries(), sm.getLeafId());
  const system = getCurrentSystemMessage(messages);
  if (!system?.sections) return undefined;
  const sections: Record<string, string> = {};
  for (const [name, text] of Object.entries(system.sections)) {
    if (PI_SECTIONS.has(name) || text == null) continue;
    const open = `<${name}>\n`, close = `\n</${name}>`;
    sections[name] = text.startsWith(open) && text.endsWith(close) ? text.slice(open.length, -close.length) : text;
  }
  return { ...(system.sections.preamble ? { preamble: system.sections.preamble } : {}), tools: getCurrentTools(messages), sections };
}

/** What changed since she was last told: each section that differs, in full, and a line for each that went. */
export function topUpdates(told: Told, sections: Record<string, string>): { text: string; told: Told } {
  const next: Told = { ...told };
  const parts: string[] = [];
  for (const [name, text] of Object.entries(sections)) {
    const h = hash(text);
    if (told[name] === h) continue;
    next[name] = h;
    parts.push(`<${name}>\n${text}\n</${name}>`);
  }
  for (const name of Object.keys(told)) {
    if (name in sections || told[name] === null) continue;
    next[name] = null;
    parts.push(`<${name}> no longer applies.`);
  }
  const text = parts.length ? `These sections of your system prompt changed; each replaces the one above and any earlier update:\n\n${parts.join("\n\n")}` : "";
  return { text, told: next };
}

/**
 * Holds the top: registered after every extension that sets sections, it puts
 * back the sections the model has, so Pi sends no change, and tells her what
 * changed. With nothing held (a new thread, or after a compaction), or when
 * the persona core or the tools changed (which the model re-reads anyway),
 * Pi sends the sections as they are now.
 */
export function createTopExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      const last = sinceTop(ctx, TOP_MESSAGE);
      const top = last && heldTop(ctx);
      const options = event.systemPromptOptions;
      // The tools as the model sees them: name, description and parameters (Pi adds fields of its own to the transcript's).
      const active = new Set(pi.getActiveTools());
      const seen = (t: Pick<Tool, "name" | "description" | "parameters">) => JSON.stringify([t.name, t.description, t.parameters]);
      const tools = new Set(pi.getAllTools().filter((t) => active.has(t.name)).map(seen));
      const same = top && top.tools.length === tools.size && top.tools.every((t) => tools.has(seen(t)));
      if (!last || !top || !same || top.preamble !== options.customPrompt) return undefined;
      const held = top.sections;
      const updates = topUpdates(typeof last === "object" ? last.details?.told ?? toldOf(held) : toldOf(held), options.sections ?? {});
      options.sections = held;
      return updates.text ? { message: { customType: TOP_MESSAGE, content: updates.text, display: false, details: { told: updates.told } } } : undefined;
    });
  };
}
