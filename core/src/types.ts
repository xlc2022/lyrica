// Shared vocabulary from docs/contracts.md.

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";

export const TASKS = [
  "chat", "subagent.cheap", "subagent.strong", "compaction",
  "title", "embedding", "sleep.consolidate", "sleep.dream", "sleep.wake",
] as const;
export type Task = (typeof TASKS)[number];

/** One model on one endpoint, by its permanent offering ID. The same model on two endpoints is two offerings. */
export interface ModelRef { offeringId: string }

export interface CallContext {
  userId: string;
  pool: Pool;
  /** The thread's local-only switch. Always true for private. */
  localOnly: boolean;
  overrides?: Partial<Record<Task, ModelRef>>;
}
