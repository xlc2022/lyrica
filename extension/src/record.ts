import { randomBytes } from "node:crypto";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MEMORY_TOOLS, type NewEntry, type PoolStore } from "@lyrica/core";

// Threads live in the pool database, never in Pi session files. Pi saves a
// message only after its message_end listeners run, so user entries are copied
// in a microtask after that append, before the model runs. Other entries are
// copied at turn and agent boundaries. Pi entry IDs make copying idempotent.
// Memory tools (MEMORY_TOOLS): what they wrote is indexed where it was written.

/** What a thread started from a sleep item is prompted with, so she speaks first. Never shown or indexed. */
export const OPENING = "(The conversation is starting. Speak first.)";

interface EntrySource { getEntries(): SessionEntry[] }

/** Stores every Pi entry the thread doesn't have yet. Returns how many were new. */
export function syncEntries(source: EntrySource, store: PoolStore, threadId: string): number {
  const have = store.storedPiIds(threadId);
  let added = 0;
  for (const entry of source.getEntries()) {
    if (have.has(entry.id)) continue;
    store.appendEntry(threadId, toStoredEntry(entry), entry.timestamp);
    added++;
  }
  return added;
}

/** For lyricad: records a hosted session's entries as they finish. Returns the unsubscribe function. */
export function recordEntries(session: AgentSession, store: PoolStore, threadId: string): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "user") {
      queueMicrotask(() => {
        // A failure here (a locked store, a database error) must not take lyricad down: the turn's own sync retries.
        try {
          syncEntries(session.sessionManager, store, threadId);
        } catch (err) {
          console.error(`recording a sent message failed (${(err as Error)?.name ?? "Error"}); it is recorded at the turn's end`);
        }
      });
    }
    if (event.type === "turn_end" || event.type === "agent_end" || event.type === "compaction_end") syncEntries(session.sessionManager, store, threadId);
  });
}

/**
 * Appends a user message to a stored thread, after its last entry, as Pi
 * stores one: her next session on the thread loads it with the rest.
 */
export function appendUserMessage(store: PoolStore, threadId: string, text: string): void {
  appendMessage(store, threadId, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

/** Appends a reply no Pi session made (Claude Code's, in its subagent thread), as Pi stores an assistant's. */
export function appendReply(store: PoolStore, threadId: string, text: string, model: string): void {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  appendMessage(store, threadId, { role: "assistant", content: [{ type: "text", text }], api: "claude-code", provider: "claude-code", model, usage, stopReason: "stop", timestamp: Date.now() });
}

function appendMessage(store: PoolStore, threadId: string, message: object): void {
  const last = store.loadEntries(threadId).filter((e) => (e as { type?: string }).type !== "session").at(-1) as { id: string } | undefined;
  const entry = { type: "message", id: randomBytes(4).toString("hex"), parentId: last?.id ?? null, timestamp: new Date().toISOString(), message } as unknown as SessionEntry;
  store.appendEntry(threadId, toStoredEntry(entry), entry.timestamp);
}

/** A shown notice of Lyrica's own (`customType`) at the end of a stored thread with no live session. */
export function appendNotice(store: PoolStore, threadId: string, customType: string, text: string): void {
  const last = store.loadEntries(threadId).filter((e) => (e as { type?: string }).type !== "session").at(-1) as { id: string } | undefined;
  const entry = {
    type: "custom_message", id: randomBytes(4).toString("hex"), parentId: last?.id ?? null, timestamp: new Date().toISOString(),
    customType, content: text, display: true,
  } as unknown as SessionEntry;
  store.appendEntry(threadId, toStoredEntry(entry), entry.timestamp);
}

/**
 * Searchable text for an entry: what was said, tool calls by name and
 * arguments, and tool output. Lyrica's own per-turn context (recall, time)
 * and her memory tools' calls and results are stored but not searchable, so
 * recall never finds echoes of memory.
 */
export function toStoredEntry(entry: SessionEntry): NewEntry {
  if (entry.type !== "message") return { piId: entry.id, role: entry.type, data: entry, text: "" };
  const m = entry.message as { role: string; content?: unknown; toolName?: string };
  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const text = (parts as { type: string; text?: string; name?: string; arguments?: unknown }[])
    .map((p) => (p.type === "text" ? p.text : p.type === "toolCall" && !MEMORY_TOOLS.has(p.name!) ? `${p.name}(${JSON.stringify(p.arguments)})` : undefined))
    .filter(Boolean)
    .join("\n");
  if (m.role === "toolResult") return { piId: entry.id, role: m.role, data: entry, text: MEMORY_TOOLS.has(m.toolName ?? "") ? "" : `${m.toolName}: ${text}` };
  return { piId: entry.id, role: m.role, data: entry, text: m.role === "user" && text === OPENING ? "" : text };
}
