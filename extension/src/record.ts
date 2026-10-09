import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { NewEntry, PoolStore } from "@lyrica/core";

// Threads live in the pool database, never in Pi session files. Pi saves a
// message only after its message_end listeners run, so entries are copied over
// at turn and agent boundaries, by Pi entry ID, which makes copying idempotent.

// Memory tools, sleep's included: what they wrote is indexed where it was written.
const MEMORY_TOOLS = new Set(["remember", "recall", "read_memory", "write_page", "write_journal", "write_wake", "raise", "propose_persona"]);

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
    if (event.type === "turn_end" || event.type === "agent_end") syncEntries(session.sessionManager, store, threadId);
  });
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
