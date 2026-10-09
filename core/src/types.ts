// Shared vocabulary from docs/contracts.md. The Models thread fills in the
// router; Core only needs its shapes.

export type Pool = "general" | "private";
export type Interface = "web" | "cli" | "matrix" | "forum" | "sleep";

export type Task =
  | "chat" | "subagent.cheap" | "subagent.strong" | "compaction"
  | "title" | "embedding" | "sleep.consolidate" | "sleep.dream" | "sleep.wake";

export interface CallContext {
  userId: string;
  pool: Pool;
  localOnly: boolean;
  overrides?: Partial<Record<Task, string>>;
}
