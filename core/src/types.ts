// Shared vocabulary from docs/contracts.md. The Memory and Models threads fill
// in PoolView and the router; Core only needs their shapes.

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

/** Store handles for one thread. Only `openThreadView` (Memory thread) hands these out. */
export interface PoolView {
  readonly pool: Pool;
}
