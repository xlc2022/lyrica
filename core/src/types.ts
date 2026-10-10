// Shared vocabulary from docs/contracts.md.

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";

export const TASKS = [
  "chat", "subagent.cheap", "subagent.strong", "compaction",
  "title", "embedding", "sleep.consolidate", "sleep.dream", "sleep.wake",
  "image.create", "image.edit",
] as const;
export type Task = (typeof TASKS)[number];

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
}
