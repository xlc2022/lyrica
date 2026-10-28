// Shared vocabulary from docs/contracts.md.

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";
/** What a model preset may hold: private is local models only; general mixes freely. */
export type PresetScope = "private" | "general";
/** The Models page's two columns. */
export type Column = "private" | "general";

export const TASKS = [
  "chat", "code", "subagent.cheap", "subagent.strong", "compaction",
  "title", "watching", "embedding", "sleep.consolidate", "sleep.dream", "sleep.wake",
  "vision", "image.create", "image.edit", "image.upscale", "video", "speech.transcribe", "speech.speak",
] as const;
export type Task = (typeof TASKS)[number];
/** Each task as people read it, as the Models page names it: for messages that reach the interface. */
export const TASK_NAMES: Record<Task, string> = {
  chat: "Main conversation", code: "Coding", "subagent.cheap": "Cheap subagents", "subagent.strong": "Strong subagents", compaction: "Compaction",
  title: "Titles", watching: "Watching threads", embedding: "Embeddings", "sleep.consolidate": "Sleep: consolidate", "sleep.dream": "Sleep: dream", "sleep.wake": "Sleep: wake",
  vision: "Look at images", "image.create": "Images", "image.edit": "Image edits", "image.upscale": "Image upscaling", video: "Videos", "speech.transcribe": "Dictation", "speech.speak": "Read aloud",
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
/** The level threads think at unless the person chooses another. */
export const DEFAULT_THINKING: ThinkingLevel = "medium";

export interface CallContext {
  userId: string;
  pool: Pool;
  /** The thread's local-only switch. Always true for private. */
  localOnly: boolean;
  /** Which preset a general thread uses. Absent means its column. Ignored in private and local-only threads unless the preset is private. */
  preset?: string;
  /** The thread's own ordered lists, which beat the preset. */
  overrides?: Partial<Record<Task, ModelRef[]>>;
  /** The thread's thinking setting. */
  thinking?: ThinkingLevel;
  /** Nobody chose the thinking level (neither the thread nor the user's default): it is DEFAULT_THINKING. */
  thinkingUnset?: boolean;
  /** Fallback: a later model in a task's list may answer when the first can't. Absent is on. */
  fallback?: boolean;
  /** The most context the thread plans for, below its model's window. Absent is the whole window. */
  contextLimit?: number;
}
