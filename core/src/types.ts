// Shared vocabulary from docs/contracts.md.

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";

export const TASKS = [
  "chat", "subagent.cheap", "subagent.strong", "compaction",
  "title", "embedding", "sleep.consolidate", "sleep.dream", "sleep.wake",
  "image.create", "image.edit", "speech.transcribe", "speech.speak",
] as const;
export type Task = (typeof TASKS)[number];
/** Each task as people read it, as the Models page names it: for messages that reach the interface. */
export const TASK_NAMES: Record<Task, string> = {
  chat: "Main conversation", "subagent.cheap": "Cheap subagents", "subagent.strong": "Strong subagents", compaction: "Compaction",
  title: "Titles", embedding: "Embeddings", "sleep.consolidate": "Sleep: consolidate", "sleep.dream": "Sleep: dream", "sleep.wake": "Sleep: wake",
  "image.create": "Images", "image.edit": "Image edits", "speech.transcribe": "Dictation", "speech.speak": "Read aloud",
};

/**
 * One model on one endpoint, by its permanent offering ID (the same model on
 * two endpoints is two offerings), or a model group, which expands in place
 * into its members.
 */
export type ModelRef = { offeringId: string } | { groupId: string };

/** How hard a model thinks, where it can. */
export type ThinkingLevel = "off" | "low" | "medium" | "high";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

export interface CallContext {
  userId: string;
  pool: Pool;
  /** The thread's local-only switch. Always true for private. */
  localOnly: boolean;
  /** Which profile a general thread uses. Ignored in private and local-only threads, which always use local. */
  profile?: "cloud" | "custom";
  /** The thread's own ordered lists, which beat the profile. */
  overrides?: Partial<Record<Task, ModelRef[]>>;
  /** The thread's thinking setting. */
  thinking?: ThinkingLevel;
  /** Voice to cloud: the user's audio may go to a cloud model. Absent is off. */
  voiceCloud?: boolean;
  /** Fallback: a later model in a task's list may answer when the first can't. Absent is on. */
  fallback?: boolean;
}
