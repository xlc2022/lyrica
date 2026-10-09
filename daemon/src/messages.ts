import type { Message, MessagePart } from "./api.ts";

// Stored Pi entries as the web UI shows them, and the memory markers that both
// stored messages and the live stream carry.

const RESULT_LINES = 6;
const RESULT_CHARS = 600;

type Content = string | { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
interface PiMessage { role: string; content?: Content; toolCallId?: string; toolName?: string; isError?: boolean; model?: string; stopReason?: string; errorMessage?: string; customType?: string }
interface PiEntry { type: string; message?: PiMessage; customType?: string; content?: Content }

/** The first few lines of a tool's output. */
export function shortResult(content: unknown): string {
  const text = textOf(content as Content);
  const lines = text.split("\n");
  let short = lines.slice(0, RESULT_LINES).join("\n");
  if (short.length > RESULT_CHARS) short = short.slice(0, RESULT_CHARS);
  return short.length < text.length ? `${short}…` : short;
}

function textOf(content: Content | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

const ID = /\[((?:general\/)?(?:[ntpej]:[^\]\s]+|wake))\]/g;

/** Memory IDs recalled: the ids at the start of each line of a `<recall>` section or a recall result. */
export function recalledIds(text: string): string[] {
  const ids = text.split("\n").map((l) => /^\[((?:general\/)?(?:[ntpej]:[^\]\s]+|wake))\] \(/.exec(l.trim())?.[1]).filter((x): x is string => !!x);
  return [...new Set(ids)];
}

export type Marker = Extract<MessagePart, { type: "recall" | "remember" }>;

/** The memory markers a finished tool call makes: notes saved, memories found or read. */
export function markersFor(tool: string, args: unknown, result: string): Marker[] {
  if (tool === "remember") {
    const ids = [...(/^Saved (.*)\.$/.exec(result.trim())?.[1] ?? "").matchAll(/n:[\w-]+/g)].map((m) => m[0]);
    return ids.length ? [{ type: "remember", ids }] : [];
  }
  if (tool === "recall") {
    const ids = recalledIds(result);
    return ids.length ? [{ type: "recall", ids }] : [];
  }
  if (tool === "read_memory") {
    const id = (args as { id?: unknown })?.id;
    return typeof id === "string" ? [{ type: "recall", ids: [id] }] : [];
  }
  return [];
}

/** The ids in the per-turn context message (`lyrica-turn`), which holds automatic recall. */
export function turnRecall(content: unknown): string[] {
  const text = textOf(content as Content);
  const recall = /<recall>([\s\S]*?)<\/recall>/.exec(text)?.[1] ?? "";
  return recalledIds(recall);
}

/** Folds a page of stored entries into messages: tool results join their calls; recall joins the reply it fed. */
export function toMessages(threadId: string, entries: { n: number; data: unknown; createdAt: string }[]): Message[] {
  const out: Message[] = [];
  const calls = new Map<string, { part: Extract<MessagePart, { type: "tool" }>; owner: Message }>();
  let pendingRecall: string[] = [];
  for (const { n, data, createdAt } of entries) {
    const e = data as PiEntry;
    if (e.type === "custom_message" && e.customType === "lyrica-turn") {
      pendingRecall = turnRecall(e.content);
      continue;
    }
    const m = e.type === "message" ? e.message : undefined;
    if (!m) continue;
    const base = { id: `e:${threadId}#${n}`, n, createdAt };
    if (m.role === "user") {
      out.push({ ...base, role: "user", parts: [{ type: "text", text: textOf(m.content) }] });
    } else if (m.role === "assistant") {
      const msg: Message = { ...base, role: "assistant", parts: [], ...(m.model ? { model: m.model } : {}) };
      if (pendingRecall.length) msg.parts.push({ type: "recall", ids: pendingRecall });
      pendingRecall = [];
      for (const p of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content ?? "" }]) {
        if (p.type === "text" && p.text) msg.parts.push({ type: "text", text: p.text });
        if (p.type === "thinking" && p.thinking) msg.parts.push({ type: "thinking", text: p.thinking });
        if (p.type === "toolCall" && p.id) {
          const part = { type: "tool" as const, toolCallId: p.id, name: p.name ?? "", args: p.arguments };
          msg.parts.push(part);
          calls.set(p.id, { part, owner: msg });
        }
      }
      if (m.stopReason === "error" && m.errorMessage) msg.error = plainError(m.errorMessage);
      out.push(msg);
    } else if (m.role === "toolResult" && m.toolCallId) {
      const call = calls.get(m.toolCallId);
      if (!call) continue;
      call.part.result = shortResult(m.content);
      call.part.isError = !!m.isError;
      call.owner.parts.push(...markersFor(call.part.name, call.part.args, textOf(m.content)));
    }
  }
  return out;
}

/** A model or endpoint failure, in plain words. */
export function plainError(message: string): string {
  if (/ECONNREFUSED|fetch failed|Connection error|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(message)) {
    return `The model's endpoint didn't answer (${message}).`;
  }
  return message;
}
