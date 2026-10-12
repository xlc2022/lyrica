import { FROM_PARENT, LYRICA_REACTS, ROUTINE, WAKEUP, WATCHING, type Reaction as StoredReaction } from "@lyrica/core";
import { DELEGATE_MESSAGE, TURN_TOOL_NOTICE, OPENING, USER_MESSAGE } from "@lyrica/extension";
import type { Message, MessagePart, Pool, Reaction, ThreadRef, Told } from "./api.ts";

// Stored Pi entries as the web UI shows them, and the memory markers that both
// stored messages and the live stream carry.

const RESULT_LINES = 6;
const RESULT_CHARS = 600;

type Content = string | { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
interface PiMessage { role: string; content?: Content; toolCallId?: string; toolName?: string; isError?: boolean; model?: string; stopReason?: string; errorMessage?: string; customType?: string; details?: unknown }

/** Image result metadata only: the PNG bytes remain in Pi's encrypted tool result and home. */
export function imagePart(tool: string, details: unknown): Extract<MessagePart, { type: "image" }> | undefined {
  if (tool !== "image") return undefined;
  const p = (details as { image?: unknown } | undefined)?.image;
  if (!p || typeof p !== "object") return undefined;
  const i = p as { type?: unknown; paths?: unknown; model?: unknown; tier?: unknown };
  if (i.type !== "image" || !Array.isArray(i.paths) || !i.paths.length || !i.paths.every(p => typeof p === "string") || typeof i.model !== "string") return undefined;
  if (i.tier !== undefined && i.tier !== "fast" && i.tier !== "quality") return undefined;
  return { type: "image", paths: i.paths, model: i.model, ...(i.tier ? { tier: i.tier } : {}) };
}

/** A run's subagent threads, from its records: a background run's result names only the run. */
export type RunThreads = (runId: string) => string[];

/**
 * The subagent threads a `delegate` result (or a delivered result) belongs to,
 * in the parent's pool: named in its details, or found by its run.
 */
export function delegateThreads(tool: string, details: unknown, pool: Pool, runThreads?: RunThreads): ThreadRef[] | undefined {
  if (tool !== "delegate" && tool !== "threads") return undefined;
  const d = (details ?? {}) as { threads?: unknown; runId?: unknown };
  const ids = Array.isArray(d.threads) ? d.threads.filter((id): id is string => typeof id === "string")
    : typeof d.runId === "string" && runThreads ? runThreads(d.runId) : [];
  return ids.length ? ids.map((id) => ({ pool, id })) : undefined;
}
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

/** In a subagent's thread, who sent its "user" messages: Lyrica, or a user by their current name. */
export interface SubagentThread { userName(userId: string): string }

/**
 * Folds a page of stored entries into messages: tool results join their
 * calls; recall joins the reply it fed. In a subagent's thread, each "user"
 * message says whether Lyrica or a user sent it.
 */
/** Stored reactions as the API shows them to the user whose thread it is. */
export function toReactions(raw: StoredReaction[] | undefined, userId: string): Reaction[] | undefined {
  const out = (raw ?? []).map((r) => ({ emoji: r.emoji, you: r.by.includes(userId), her: r.by.includes(LYRICA_REACTS) })).filter((r) => r.you || r.her);
  return out.length ? out : undefined;
}

/** `opts.userId`: whose view it is, so reactions show as `you` and `her`; without it they are left out. */
export function toMessages(threadId: string, pool: Pool, entries: { n: number; data: unknown; createdAt: string; pinned?: boolean; reactions?: StoredReaction[] }[], runThreads?: RunThreads, subagent?: SubagentThread, opts: { parent?: string; userId?: string } = {}): Message[] {
  const out: Message[] = [];
  const calls = new Map<string, { part: Extract<MessagePart, { type: "tool" }>; owner: Message }>();
  let pendingRecall: string[] = [];
  for (const { n, data, createdAt, pinned, reactions: stored } of entries) {
    const reactions = opts.userId ? toReactions(stored, opts.userId) : undefined;
    const e = data as PiEntry;
    if (e.type === "custom_message" && e.customType === TURN_TOOL_NOTICE) {
      out.push({ id: `e:${threadId}#${n}`, n, createdAt, role: "notice", parts: [{ type: "text", text: textOf(e.content) }] });
      continue;
    }
    if (e.type === "custom_message" && e.customType === "lyrica-turn") {
      pendingRecall = turnRecall(e.content);
      continue;
    }
    if (e.type === "custom_message" && e.customType === DELEGATE_MESSAGE) {
      const details = (e as { details?: unknown }).details;
      // A look at a project's threads, kept without a turn (watch.ts): shown as a look, never as a notice card.
      const look = (details as { status?: unknown } | undefined)?.status === "watching" ? WATCHING.exec(textOf(e.content)) : null;
      if (look) {
        const text = textOf(e.content).slice(look[0].length);
        out.push({ id: `e:${threadId}#${n}`, n, createdAt, role: "user", from: { kind: "watching", told: toldLines(text) }, parts: [{ type: "text", text }] });
        continue;
      }
      const part = delegationPart(e.content, details);
      const threads = delegateThreads("delegate", details, pool, runThreads);
      out.push({ id: `e:${threadId}#${n}`, n, createdAt, role: "notice", parts: [threads ? { ...part, threads } : part] });
      continue;
    }
    if (e.type === "custom_message" && e.customType === USER_MESSAGE) {
      // Only lyricad writes these: the text after the line naming the user is theirs.
      const userId = String(((e as { details?: { userId?: unknown } }).details ?? {}).userId ?? "");
      const text = textOf(e.content).replace(/^[^\n]*\n\n/, "");
      out.push({ id: `e:${threadId}#${n}`, n, createdAt, role: "user", from: { kind: "user", userId, name: subagent?.userName(userId) ?? "" }, parts: [{ type: "text", text }] });
      continue;
    }
    if (e.type === "compaction") {
      // Hers or Pi's: a marker, Compacted · 41k → 6k, that expands to the summary.
      const c = e as unknown as { summary?: string; tokensBefore?: number; details?: { after?: unknown } };
      const after = typeof c.details?.after === "number" ? c.details.after : undefined;
      out.push({ id: `e:${threadId}#${n}`, n, createdAt, role: "notice", parts: [{ type: "compacted", before: c.tokensBefore ?? 0, ...(after !== undefined ? { after } : {}), summary: c.summary ?? "" }] });
      continue;
    }
    const m = e.type === "message" ? e.message : undefined;
    if (!m) continue;
    const base = { id: `e:${threadId}#${n}`, n, createdAt, ...(pinned ? { pinned: true } : {}), ...(reactions?.length ? { reactions } : {}) };
    if (m.role === "user") {
      if (textOf(m.content) === OPENING) continue; // a thread started from a sleep item: she speaks first
      // Only a child thread has a parent's messages, or in a project a sibling's; lyricad refuses the mark on anything else.
      const marked = opts.parent ? FROM_PARENT.exec(textOf(m.content)) : null;
      if (marked) {
        const from = marked[1] === opts.parent ? { kind: "parent" as const, threadId: marked[1]! } : { kind: "thread" as const, threadId: marked[1]! };
        out.push({ ...base, role: "user", from, parts: [{ type: "text", text: textOf(m.content).slice(marked[0].length) }] });
        continue;
      }
      const routine = ROUTINE.exec(textOf(m.content));
      if (routine) {
        out.push({ ...base, role: "user", from: { kind: "routine", schedule: routine[1]! }, parts: [{ type: "text", text: textOf(m.content).slice(routine[0].length) }] });
        continue;
      }
      // A wake-up's note to herself; lyricad refuses the mark on anything a user sends.
      const wakeup = WAKEUP.exec(textOf(m.content));
      if (wakeup) {
        out.push({ ...base, role: "user", from: { kind: "wakeup", setAt: wakeup[1]!, ...(wakeup[2] ? { dueAt: wakeup[2] } : {}) }, parts: [{ type: "text", text: textOf(m.content).slice(wakeup[0].length) }] });
        continue;
      }
      // lyricad refuses the mark on anything a user sends.
      const watching = WATCHING.exec(textOf(m.content));
      if (watching) {
        const text = textOf(m.content).slice(watching[0].length);
        // A look that raised something carries its Told lines; an older look, which was always a turn, doesn't.
        const told = /^Told /m.test(text) ? { told: toldLines(text) } : {};
        out.push({ ...base, role: "user", from: { kind: "watching", ...told }, parts: [{ type: "text", text }] });
        continue;
      }
      out.push({ ...base, role: "user", ...(subagent ? { from: { kind: "lyrica" as const } } : {}), parts: [{ type: "text", text: textOf(m.content) }] });
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
      const threads = delegateThreads(call.part.name, m.details, pool, runThreads);
      if (threads) call.part.threads = threads;
      const image = !m.isError ? imagePart(call.part.name, m.details) : undefined;
      if (image) call.owner.parts.push(image);
      call.owner.parts.push(...markersFor(call.part.name, call.part.args, textOf(m.content)));
    }
  }
  return out;
}

/** What delegate delivers into a thread: a background run's result or question. A look (status `watching`) also says who it told. */
export function delegationPart(content: unknown, details: unknown): Extract<MessagePart, { type: "delegation" }> {
  const d = (details ?? {}) as { runId?: unknown; status?: unknown };
  const text = textOf(content as Content);
  return {
    type: "delegation", text,
    ...(typeof d.runId === "string" ? { runId: d.runId } : {}), ...(typeof d.status === "string" ? { status: d.status } : {}),
    ...(d.status === "watching" ? { told: toldLines(text) } : {}),
  };
}

/** The `Told [t:<id>]: "<line>"` lines of a look (watch.ts): the threads it told, and what. */
export function toldLines(text: string): Told[] {
  // One line per tell: `JSON.stringify` escapes any newline in the told text, so `.*` reaches the closing quote.
  return [...text.matchAll(/^Told \[t:([^\]\s]+)\]: (".*")$/gm)].flatMap((m) => {
    try { return [{ threadId: m[1]!, text: JSON.parse(m[2]!) as string }]; } catch { return []; }
  });
}

/** A model or endpoint failure, in plain words. */
export function plainError(message: string): string {
  if (/ECONNREFUSED|fetch failed|Connection error|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(message)) {
    return `The model's endpoint didn't answer (${message}).`;
  }
  return message;
}
