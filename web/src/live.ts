// What a thread's event stream says is happening now, before it is stored.
// Pure, so it can be tested without a browser.
import type { MessagePart, PermissionRequest, ThreadEvent, ThreadRef } from "./api.ts";

export type LiveItem =
  | { role: "user"; text: string }
  | { role: "assistant"; model?: string; parts: MessagePart[] }
  /** Delivered into the thread, such as a background subagent run's result. */
  | { role: "notice"; text: string; status?: string; threads?: ThreadRef[] };

export interface Live {
  busy: boolean;
  /** Follow-ups waiting for the running turn. */
  queued: string[];
  permissions: PermissionRequest[];
  /** This turn's messages so far. Cleared once the stored messages are reloaded. */
  items: LiveItem[];
  /** Plain-words errors from the latest turn. */
  errors: string[];
  /** No model could be reached: what was tried. Any waiting message is in `queued`, and goes when one answers. */
  offline?: { task: string; tried: { label: string; reason: string }[] };
  title?: string;
  /** Bumped when stored messages must be reloaded (turn end, reset). */
  reload: number;
  /** How many of `items` are stored and go once the reload arrives. */
  ended: number;
  /** Bumped, per subagent thread, when its stored work changes, so an open transcript reloads. */
  subagents: Record<string, number>;
  /** Bumped when the thread's settings change elsewhere, such as an approved plan switching its mode. */
  settings: number;
  /** In a project chat: bumped when one of its threads changes state, so its card and the Threads count reload. */
  children: number;
}

export const initialLive: Live = { busy: false, queued: [], permissions: [], items: [], errors: [], reload: 0, ended: 0, subagents: {}, settings: 0, children: 0 };

/** A subagent's events that mean its thread has new stored messages. */
const STORED: string[] = ["started", "usage", "question", "note", "finished", "stopped", "interrupted"];

export type LiveAction =
  | ThreadEvent
  /** She sent a message that started a turn. */
  | { type: "sent"; text: string }
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
      return { ...s, busy: e.busy, queued: e.queued, permissions: e.permissions,
        ...(!e.busy && { reload: s.reload + 1, ended: s.items.length }) };
    }
    case "reset":
      return { ...s, items: [], ended: 0, reload: s.reload + 1 };
    case "rewound":
      return { ...s, items: [], ended: 0, errors: [], reload: s.reload + 1 };
    case "sent":
      return { ...s, items: [...s.items, { role: "user", text: e.text }] };
    case "turn_start":
      return { ...s, busy: true, errors: [], offline: undefined };
    case "message_start":
      return { ...s, items: [...s.items, { role: "assistant", model: e.model, parts: [] }] };
    case "text":
    case "thinking":
      return withParts(s, (parts) => {
        const last = parts.at(-1);
        if (last && last.type === e.type) return [...parts.slice(0, -1), { type: e.type, text: last.text + e.delta }];
        return [...parts, { type: e.type, text: e.delta }];
      });
    case "tool_start":
      return withParts(s, (parts) => [...parts, { type: "tool", toolCallId: e.toolCallId, name: e.name, args: e.args }]);
    case "tool_end":
      return withParts(s, (parts) => parts.map((p) =>
        p.type === "tool" && p.toolCallId === e.toolCallId ? { ...p, result: e.result, isError: e.isError, ...(e.threads && { threads: e.threads }) } : p));
    case "recall":
    case "remember":
      return withParts(s, (parts) => [...parts, { type: e.type, ids: e.ids }]);
    case "permission":
      return { ...s, permissions: [...s.permissions.filter((p) => p.requestId !== e.requestId), stripType(e)] };
    case "permission_end":
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== e.requestId) };
    case "queue": {
      // A follow-up that leaves the queue is now being answered.
      const taken = s.queued.slice(0, Math.max(0, s.queued.length - e.queued.length));
      return { ...s, queued: e.queued, items: [...s.items, ...taken.map((text) => ({ role: "user" as const, text }))] };
    }
    case "error":
      return { ...s, errors: [...s.errors, e.message] };
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
    case "turn_end":
      // A subagent's request outlives the parent's turn: it ends with its own permission_end.
      return { ...s, busy: false, permissions: s.permissions.filter((p) => p.subagent), reload: s.reload + 1, ended: s.items.length };
    case "stored":
      return { ...s, items: s.items.slice(s.ended), ended: 0 };
    case "stopping":
      return { ...s, queued: [], offline: undefined };
    case "notice":
      return { ...s, items: [...s.items, { role: "notice", text: e.text, status: e.status, threads: e.threads }] };
    case "refresh":
      return { ...s, reload: s.reload + 1, ended: s.items.length };
    case "delegation": {
      const { threadId, type } = e.event;
      return STORED.includes(type) ? { ...s, subagents: { ...s.subagents, [threadId]: (s.subagents[threadId] ?? 0) + 1 } } : s;
    }
    // The context meter is not built yet; the compaction marker appears when the messages reload.
    case "usage":
    case "context":
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
