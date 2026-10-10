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
  title?: string;
  /** Bumped when stored messages must be reloaded (turn end, reset). */
  reload: number;
  /** How many of `items` are stored and go once the reload arrives. */
  ended: number;
  /** Bumped, per subagent thread, when its stored work changes, so an open transcript reloads. */
  subagents: Record<string, number>;
}

export const initialLive: Live = { busy: false, queued: [], permissions: [], items: [], errors: [], reload: 0, ended: 0, subagents: {} };

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
      // A turn that ended while we were away: reload to pick it up.
      const missed = !e.busy && s.items.length > 0;
      return { ...s, busy: e.busy, queued: e.queued, permissions: e.permissions,
        ...(missed && { reload: s.reload + 1, ended: s.items.length }) };
    }
    case "reset":
      return { ...s, items: [], ended: 0, reload: s.reload + 1 };
    case "rewound":
      return { ...s, items: e.resend !== undefined ? [{ role: "user", text: e.resend }] : [], ended: 0, errors: [], reload: s.reload + 1 };
    case "sent":
      return { ...s, items: [...s.items, { role: "user", text: e.text }] };
    case "turn_start":
      return { ...s, busy: true, errors: [] };
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
    case "title":
      return { ...s, title: e.title };
    case "turn_end":
      // A subagent's request outlives the parent's turn: it ends with its own permission_end.
      return { ...s, busy: false, permissions: s.permissions.filter((p) => p.subagent), reload: s.reload + 1, ended: s.items.length };
    case "stored":
      return { ...s, items: s.items.slice(s.ended), ended: 0 };
    case "stopping":
      return { ...s, queued: [] };
    case "notice":
      return { ...s, items: [...s.items, { role: "notice", text: e.text, status: e.status, threads: e.threads }] };
    case "refresh":
      return { ...s, reload: s.reload + 1, ended: s.items.length };
    case "delegation": {
      const { threadId, type } = e.event;
      return STORED.includes(type) ? { ...s, subagents: { ...s.subagents, [threadId]: (s.subagents[threadId] ?? 0) + 1 } } : s;
    }
    case "usage":
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
