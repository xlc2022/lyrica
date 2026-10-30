// What a thread's event stream says is happening now, before it is stored.
// Pure, so it can be tested without a browser.
import type { ContextInfo, GpuWait, Making, Message, MessagePart, PermissionRequest, ThreadEvent, ThreadRef, ThreadStep, Told, WakeupInfo } from "./api.ts";

export type LiveItem =
  | { role: "user"; text: string; afterN?: number }
  /** `error`: why this reply failed, shown under it as its stored copy shows it. */
  | { role: "assistant"; model?: string; parts: MessagePart[]; error?: string }
  /** Delivered into the thread, such as a background subagent run's result. */
  | { role: "notice"; text: string; status?: string; threads?: ThreadRef[]; told?: Told[] };

export interface Live {
  busy: boolean;
  /** Follow-ups waiting for the running turn. */
  queued: string[];
  permissions: PermissionRequest[];
  /** Images and clips being made, by image call: their placeholders, until each is made or fails. */
  making: Record<string, Making>;
  /** This turn's messages so far. Cleared once the stored messages are reloaded. */
  items: LiveItem[];
  /** Plain-words errors from the latest turn that belong to no reply of it. */
  errors: string[];
  /** No model could be reached: what was tried. Any waiting message is in `queued`, and goes when one answers. */
  offline?: { task: string; tried: { label: string; reason: string }[] };
  title?: string;
  /** Bumped when stored messages must be reloaded (turn end, reset). */
  reload: number;
  /** Bumped at each finished tool call: the Files panel beside the thread reloads its folders, since a call may have written one. */
  tools: number;
  /** How many of `items` are stored and go once the reload arrives. */
  ended: number;
  /** Bumped, per subagent thread, when its stored work changes, so an open transcript reloads. */
  subagents: Record<string, number>;
  /** Bumped when the thread's settings change elsewhere, such as an approved plan switching its mode. */
  settings: number;
  /** In a project chat: bumped when one of its threads changes state, so its card and the Threads count reload. */
  children: number;
  /** The wake-ups waiting, as the stream last said; the settings' list until then. */
  wakeups?: WakeupInfo[];
  /** Her checklist for the thread, as the stream last said; the thread summary's until then. */
  steps?: ThreadStep[];
  /**
   * The context as the last turn left it, for the header's Context meter. Null once turns are rewound or
   * reset: nothing has measured what is left until the next turn, and the settings' reading is from before.
   */
  context?: ContextInfo | null;
  /** A reply waiting for a model host's GPU: what it waits for, shown in place of "is thinking". */
  gpuWait?: GpuWait;
}

export const initialLive: Live = { busy: false, queued: [], permissions: [], making: {}, items: [], errors: [], reload: 0, tools: 0, ended: 0, subagents: {}, settings: 0, children: 0 };

/** One part's identity and content, so a tail that grew is told from one that didn't. */
function partKey(p: MessagePart): string {
  if (p.type === "text") return `t:${p.text}`;
  if (p.type === "thinking") return `h:${p.text}`;
  if (p.type === "tool") return `o:${p.toolCallId}:${p.name}:${JSON.stringify(p.args)}:${p.result ?? ""}:${p.isError ?? false}`;
  if (p.type === "recall" || p.type === "remember") return `${p.type}:${p.ids.join(",")}`;
  if (p.type === "image") return `i:${p.paths.join(",")}`;
  if (p.type === "video") return `v:${p.path}`;
  if (p.type === "delegation") return `d:${p.text}:${p.status ?? ""}:${p.runId ?? ""}`;
  if (p.type === "compacted") return `c:${p.summary}`;
  return `u:${JSON.stringify(p)}`;
}

/**
 * The conversation's tail as one key: the last message in order, with what it holds. An arrival is a
 * different key from the last one seen, so a reply streaming into an existing tail counts, a message
 * another tab appended while she was scrolled up counts, and opening older history above the reader
 * does not.
 */
export function tailKey(messages: Message[], live: Live): string {
  const items = live.items.length > 0 ? live.items : messages;
  const last = items[items.length - 1];
  if (!last) return "∅";
  const parts = "parts" in last ? last.parts : [{ type: "text" as const, text: "text" in last && last.text ? last.text : "" }];
  const body = parts.map((p) => partKey(p)).join("|");
  // Stored tails carry their entry identity, so a second identical message is a new arrival; live tails
  // carry the count they were appended at, which only grows.
  const who = "id" in last ? `${last.id}#${last.n}` : `#${items.length}`;
  return `${who}:${last.role}:${body}`;
}

/** A subagent's events that mean its thread has new stored messages. */
const STORED: string[] = ["started", "usage", "question", "note", "finished", "stopped", "interrupted"];

export type LiveAction =
  | ThreadEvent
  /** She sent a message that started a turn. */
  | { type: "sent"; text: string; afterN?: number }
  /** The stored messages were reloaded, so the live copy can go. */
  | { type: "stored" }
  /** She pressed Stop; lyricad drops the queue, and its text went back to the composer. */
  | { type: "stopping" }
  /** The stored messages changed outside a turn, such as a subagent's work in its own thread. */
  | { type: "refresh" };

export function liveReducer(s: Live, e: LiveAction): Live {
  switch (e.type) {
    case "hello": {
      // Idle: any turn that ended before the stream opened, or while we were
      // away, is stored now, but the messages may have been fetched before it
      // ended. Reload to pick it up.
      return { ...s, busy: e.busy, queued: e.queued, permissions: e.permissions, making: Object.fromEntries((e.making ?? []).map((m) => [m.toolCallId, m])),
        gpuWait: e.gpuWait, ...(!e.busy && { reload: s.reload + 1, ended: s.items.length }) };
    }
    case "reset":
      return { ...s, items: [], making: {}, ended: 0, reload: s.reload + 1, context: null };
    case "rewound":
      return { ...s, items: [], ended: 0, errors: [], reload: s.reload + 1, context: null };
    case "sent":
      return { ...s, items: [...s.items, { role: "user", text: e.text, ...(e.afterN !== undefined && { afterN: e.afterN }) }] };
    case "turn_start":
      return { ...s, busy: true, errors: [], offline: undefined };
    case "message_start":
      // A model answering (a retry that got through, say) means one can be reached.
      return { ...s, offline: undefined, items: [...s.items, { role: "assistant", model: e.model, parts: [] }] };
    case "text":
    case "thinking":
      return withParts(s, (parts) => {
        const last = parts.at(-1);
        if (last && last.type === e.type) return [...parts.slice(0, -1), { type: e.type, text: last.text + e.delta }];
        return [...parts, { type: e.type, text: e.delta }];
      });
    case "tool_call":
      return withParts(s, (parts) => parts.some((p) => p.type === "tool" && p.toolCallId === e.toolCallId) ? parts
        : [...parts, { type: "tool", toolCallId: e.toolCallId, name: e.name, args: {} }]);
    case "tool_start":
      // A call already shown as written gets its arguments in place.
      return withParts(s, (parts) => parts.some((p) => p.type === "tool" && p.toolCallId === e.toolCallId)
        ? parts.map((p) => p.type === "tool" && p.toolCallId === e.toolCallId ? { ...p, name: e.name, args: e.args } : p)
        : [...parts, { type: "tool", toolCallId: e.toolCallId, name: e.name, args: e.args }]);
    case "making": {
      const { type: _, ...m } = e;
      return { ...s, making: { ...s.making, [m.toolCallId]: m } };
    }
    case "made": {
      const { [e.toolCallId]: _, ...making } = s.making;
      return { ...s, making };
    }
    case "tool_end":
      return withParts({ ...s, tools: s.tools + 1 }, (parts) => parts.flatMap((p) =>
        p.type === "tool" && p.toolCallId === e.toolCallId
          ? [{ ...p, result: e.result, isError: e.isError, ...(e.imageRefusal && { imageRefusal: e.imageRefusal }), ...(e.threads && { threads: e.threads }), ...(e.root && { root: e.root }) }, ...(e.image ? [e.image] : []), ...(e.video ? [e.video] : [])]
          : [p]));
    case "recall":
    case "remember":
      return withParts(s, (parts) => [...parts, { type: e.type, ids: e.ids }]);
    case "permission":
      return { ...s, permissions: [...s.permissions.filter((p) => p.requestId !== e.requestId), stripType(e)] };
    case "permission_end":
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== e.requestId) };
    case "queue": {
      // Steered into the running turn: it shows where Pi takes it (received).
      if (e.steered) return { ...s, queued: e.queued };
      // A follow-up that leaves the queue is now being answered.
      const taken = s.queued.slice(0, Math.max(0, s.queued.length - e.queued.length));
      return { ...s, queued: e.queued, items: [...s.items, ...taken.map((text) => ({ role: "user" as const, text }))] };
    }
    case "received":
      // From another thread or a look, where it reached the turn; drawn by its mark.
      return { ...s, items: [...s.items, { role: "user", text: e.text }] };
    case "error": {
      // A reply's own error goes under that reply, so a retry that goes on writes below it instead of above it.
      const last = s.items.length > s.ended ? s.items.at(-1) : undefined;
      if (e.reply && last?.role === "assistant") return { ...s, items: [...s.items.slice(0, -1), { ...last, error: e.message }] };
      return { ...s, errors: [...s.errors, e.message] };
    }
    case "offline":
      // A message she sent that no model took now waits in the queue, so it isn't shown twice.
      // Held messages may have been joined into one, so a message matches the whole text or a blank-line-bounded piece of it.
      return { ...s, offline: { task: e.task, tried: e.tried }, items: s.items.filter((i, n) => n < s.ended || i.role !== "user" || !s.queued.some((q) => `\n\n${q}\n\n`.includes(`\n\n${i.text}\n\n`))) };
    case "title":
      return { ...s, title: e.title };
    case "settings":
      return { ...s, settings: s.settings + 1 };
    case "child":
      return { ...s, children: s.children + 1 };
    case "wakeups":
      return { ...s, wakeups: e.wakeups };
    case "steps":
      return { ...s, steps: e.steps };
    case "turn_end":
      // A subagent's request outlives the parent's turn: it ends with its own permission_end.
      return { ...s, busy: false, gpuWait: undefined, permissions: s.permissions.filter((p) => p.subagent), reload: s.reload + 1, ended: s.items.length };
    case "stored":
      return { ...s, items: s.items.slice(s.ended), ended: 0 };
    case "stopping":
      return { ...s, queued: [], offline: undefined };
    case "notice":
      // A clip made in the background shows as hers, as it does once the thread reloads.
      if (e.video) return { ...s, items: [...s.items, { role: "assistant", parts: [e.video] }] };
      return { ...s, items: [...s.items, { role: "notice", text: e.text, status: e.status, threads: e.threads, told: e.told }] };
    case "refresh":
      return { ...s, reload: s.reload + 1, ended: s.items.length };
    case "delegation": {
      const { threadId, type } = e.event;
      return STORED.includes(type) ? { ...s, subagents: { ...s.subagents, [threadId]: (s.subagents[threadId] ?? 0) + 1 } } : s;
    }
    case "context":
      return { ...s, context: e.context };
    case "gpu_wait":
      return { ...s, gpuWait: e.wait ?? undefined };
    // The compaction marker appears when the messages reload.
    case "usage":
    case "compacted":
    case "reactions":
      return s;
  }
}

/** Applies `fn` to the parts of the message being written, starting one if needed. */
function withParts(s: Live, fn: (parts: MessagePart[]) => MessagePart[]): Live {
  const items = [...s.items];
  const last = items.at(-1);
  if (last?.role === "assistant") items[items.length - 1] = { ...last, parts: fn(last.parts) };
  else items.push({ role: "assistant", parts: fn([]) });
  return { ...s, items };
}

function stripType({ type: _, ...rest }: { type: "permission" } & PermissionRequest): PermissionRequest {
  return rest;
}

/** Live user copies already present in the stored page, matched once each in send order. */
export function storedUserItems(items: LiveItem[], messages: Message[]): Set<number> {
  const hidden = new Set<number>();
  let matchedN = 0;
  items.forEach((item, i) => {
    if (item.role !== "user" || item.afterN === undefined) return;
    const stored = messages.find((m) => m.n > Math.max(item.afterN!, matchedN) && m.role === "user" && !m.from
      && m.parts.filter((p) => p.type === "text").map((p) => p.text).join("") === item.text);
    if (stored) { hidden.add(i); matchedN = stored.n; }
  });
  return hidden;
}

/**
 * Stored messages the live stream is showing too. A view that opens while a turn runs (the first send from
 * New thread opens its thread mid-turn) can load her stored message and then stream it as well. A stored
 * message that shares a tool call with a live one is left to the live copy until the turn's end replaces it.
 */
export function storedLiveCopies(items: LiveItem[], messages: Message[]): Set<number> {
  const calls = new Set(items.flatMap((i) => i.role === "assistant" ? i.parts.flatMap((p) => p.type === "tool" ? [p.toolCallId] : []) : []));
  return new Set(calls.size ? messages.filter((m) => m.role === "assistant" && m.parts.some((p) => p.type === "tool" && calls.has(p.toolCallId))).map((m) => m.n) : []);
}
