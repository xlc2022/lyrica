/** Shared CI-wake contract (principles 6 and 7; docs/briefs/ci-wakes.md). */
export type ForgeKind = "github" | "forgejo" | "gitea";

/** A terminal check result; neutral and skipped checks count as passed. */
export type CheckResult = "passed" | "failed" | "cancelled" | "timedOut";

/** A check on the current head; queued and running checks are pending. */
export interface ForgeCheck {
  /** Stable source-qualified ID, distinguishing check runs from statuses. */
  id: string;
  name: string;
  /** Null until the check finishes; adapters normalize terminal conclusions. */
  result: CheckResult | null;
}

/** A submitted review or comment; bodies never enter the common shape. */
export interface ForgeReview {
  /** Source-qualified ID, unique across reviews and both comment kinds. */
  id: string;
  /** Forge account login, used to exclude the watching account's own events. */
  author: string;
  kind: "approved" | "changesRequested" | "commented" | "reviewComment" | "comment";
  /** Submission/creation time as a UTC ISO timestamp. */
  at: string;
}

/** Complete metadata snapshot after collecting all pages from a supported forge. */
export interface ForgePullRequest {
  number: number;
  state: "open" | "closed" | "merged";
  /** Full commit hash; checks belong only to this head. */
  head: string;
  checks: ForgeCheck[];
  /** Submitted reviews, review comments and pull request comments. */
  reviews: ForgeReview[];
}

/** Persisted decision state; timestamps are UTC ISO strings. */
export interface ForgeWatchState {
  /** Null before the first successful poll. */
  head: string | null;
  /** Watch creation until the first head; then when each new head was observed. */
  headSince: string;
  /** All heads already notified, including the no-checks timeout. */
  notifiedHeads: string[];
  /** Review/comment IDs already handled, including the account's own events. */
  seenReviews: string[];
}

/** Polling failures that end a watch; transient failures stay in the poller. */
export type ForgePollResult =
  | { kind: "snapshot"; pull: ForgePullRequest }
  | { kind: "unreadable"; status: 401 | 403 | 404 };

/** Pure decide input; the caller supplies time and the watching account login. */
export interface ForgeDecideInput {
  number: number;
  account: string;
  /** Current time as a UTC ISO timestamp; no clock access in the decide step. */
  now: string;
  last: ForgeWatchState;
  poll: ForgePollResult;
}

/** One metadata-only note, combining all new CI and review events in a poll. */
export interface ForgeWakeNote {
  number: number;
  /** Full hash for rendering a short hash; null if the token was never readable. */
  head: string | null;
  ci: { kind: "finished"; checks: { name: string; result: CheckResult }[] }
    | { kind: "noChecks" }
    | null;
  /** Counts grouped by author and kind, never comment text. */
  reviews: { author: string; kind: ForgeReview["kind"]; count: number }[];
  tokenUnreadable: boolean;
}

/** Save next state and queue the note together; wake-up guards may defer delivery. */
export interface ForgeDecideOutput {
  next: ForgeWatchState;
  /** Closed/merged pulls stop silently; unreadable tokens stop with one note. */
  stop: boolean;
  note: ForgeWakeNote | null;
}

/** No I/O: adapters normalize answers before this decision function is called. */
export type ForgeDecide = (input: ForgeDecideInput) => ForgeDecideOutput;
