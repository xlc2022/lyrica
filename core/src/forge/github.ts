// CI wakes (docs/briefs/ci-wakes.md part A): GitHub's recorded answers for one
// pull — the pull, its head's check runs and combined status, its reviews,
// review comments and issue comments — turned into the common shape, so the
// rest of the watcher doesn't know which forge it is (principles 6 and 7).
// Pure: the poller has already fetched every page; nothing here does I/O or
// reads a clock. Bodies are made-up in tests; real ones never reach disk.

import type { CheckResult, ForgeCheck, ForgePullRequest, ForgeReview } from "./types.ts";

/** The parsed bodies of the calls (brief step 3), lists already joined across pages. */
export interface GitHubAnswers {
  /** GET /repos/{owner}/{repo}/pulls/{number} */
  pull: unknown;
  /** GET /repos/{owner}/{repo}/commits/{head}/check-runs, its `check_runs` list */
  checkRuns: unknown;
  /** GET /repos/{owner}/{repo}/commits/{head}/status, the combined status */
  status: unknown;
  /**
   * GET /repos/{owner}/{repo}/commits/{head}/check-suites, its `check_suites` list. A workflow whose
   * later jobs wait on an earlier one has no runs for them yet; its suite stays unfinished until they end.
   */
  checkSuites?: unknown;
  /** GET /repos/{owner}/{repo}/pulls/{number}/reviews */
  reviews: unknown;
  /** GET /repos/{owner}/{repo}/pulls/{number}/comments — inline review comments */
  reviewComments: unknown;
  /** GET /repos/{owner}/{repo}/issues/{number}/comments */
  issueComments: unknown;
}

type Obj = Record<string, unknown>;

function asObj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Obj;
}

function asList(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} is not a list`);
  return v;
}

function strOf(o: Obj, key: string, what: string): string {
  const s = o[key];
  if (typeof s !== "string" || s === "") throw new Error(`${what}.${key} is missing`);
  return s;
}

function numOf(o: Obj, key: string, what: string): number {
  const n = o[key];
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${what}.${key} is not a whole number`);
  return n;
}

/** The first of `keys` holding a string, for GitHub's optional timestamps. */
function timeOf(o: Obj, keys: string[], what: string): string {
  for (const key of keys) {
    const s = o[key];
    if (typeof s === "string" && s !== "") return s;
  }
  throw new Error(`${what} has no ${keys.join(" or ")}`);
}

function loginOf(o: Obj, what: string): string {
  return strOf(asObj(o.user ?? null, `${what}.user`), "login", `${what}.user`);
}

/** A check run's conclusion; null means still waiting. Unknown values throw —
 * guessing here could compute a false "all finished" and wake her too early. */
function runResult(conclusion: string): CheckResult | null {
  switch (conclusion) {
    case "success": return "passed";
    case "neutral": case "skipped": return "passed"; // neutral and skipped count as passed (types.ts)
    case "failure": return "failed";
    case "cancelled": return "cancelled";
    case "timed_out": return "timedOut";
    case "stale": return "cancelled"; // GitHub gave up on a run left incomplete: it won't finish
    case "action_required": return null; // waiting on a person, not finished
    default: throw new Error(`unknown check-run conclusion "${conclusion}"`);
  }
}

function statusResult(state: string): CheckResult | null {
  switch (state) {
    case "success": return "passed";
    case "failure": case "error": return "failed";
    case "pending": return null;
    default: throw new Error(`unknown commit-status state "${state}"`);
  }
}

/** A submitted review's kind, or null to skip it. Dismissed and pending reviews
 * are not a fresh opinion, so they don't wake her; an unknown state is skipped
 * too — one odd review must not block the whole snapshot the way an unknown
 * check result would (it can only miss a wake, never invent one). */
function reviewKind(state: string): ForgeReview["kind"] | null {
  switch (state) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changesRequested";
    case "COMMENTED": return "commented";
    default: return null;
  }
}

function comment(entry: unknown, kind: ForgeReview["kind"], idPrefix: string): ForgeReview {
  const o = asObj(entry, `${idPrefix} entry`);
  return { id: `${idPrefix}:${numOf(o, "id", idPrefix)}`, author: loginOf(o, idPrefix), kind, at: timeOf(o, ["created_at"], idPrefix) };
}

/** The common shape for one GitHub pull (brief step 3): checks from both the
 * check runs and the combined status, reviews and comments with her own kept —
 * decide is what excludes them by account. */
export function githubPullRequest(answers: GitHubAnswers): ForgePullRequest {
  const pull = asObj(answers.pull, "pull");
  const rawState = strOf(pull, "state", "pull");
  if (rawState !== "open" && rawState !== "closed") throw new Error(`unknown pull state "${rawState}"`);
  const merged = pull.merged === true || typeof pull.merged_at === "string";

  const checks = new Map<string, ForgeCheck>();
  for (const entry of asList(asObj(answers.checkRuns, "check runs").check_runs ?? [], "check runs")) {
    const o = asObj(entry, "check run");
    const conclusion = o.conclusion;
    if (conclusion !== null && conclusion !== undefined && typeof conclusion !== "string") {
      throw new Error("check run .conclusion is not a string");
    }
    const id = `gh:check-run:${numOf(o, "id", "check run")}`;
    checks.set(id, {
      id,
      name: strOf(o, "name", "check run"),
      result: conclusion === null || conclusion === undefined ? null : runResult(conclusion),
    });
  }
  // An unfinished suite with runs is pending as a whole, so a poll between a workflow's jobs isn't "all finished".
  // Suites with no runs (an installed app that never reports) are left out: they stay queued for ever.
  for (const entry of asList(answers.checkSuites ?? [], "check suites")) {
    const o = asObj(entry, "check suite");
    if (o.status === "completed" || !(typeof o.latest_check_runs_count === "number" && o.latest_check_runs_count > 0)) continue;
    const id = `gh:check-suite:${numOf(o, "id", "check suite")}`;
    const app = o.app && typeof o.app === "object" ? (o.app as { name?: unknown }).name : undefined;
    checks.set(id, { id, name: typeof app === "string" && app ? app : "check suite", result: null });
  }
  for (const entry of asList(asObj(answers.status, "combined status").statuses ?? [], "combined status")) {
    const o = asObj(entry, "commit status");
    const context = strOf(o, "context", "commit status");
    checks.set(`gh:status:${context}`, { id: `gh:status:${context}`, name: context, result: statusResult(strOf(o, "state", "commit status")) });
  }

  const reviews: ForgeReview[] = [];
  for (const entry of asList(answers.reviews, "reviews")) {
    const o = asObj(entry, "review");
    const kind = reviewKind(strOf(o, "state", "review"));
    if (kind === null) continue;
    reviews.push({ id: `gh:review:${numOf(o, "id", "review")}`, author: loginOf(o, "review"), kind, at: timeOf(o, ["submitted_at", "created_at"], "review") });
  }
  for (const entry of asList(answers.reviewComments, "review comments")) reviews.push(comment(entry, "reviewComment", "gh:review-comment"));
  for (const entry of asList(answers.issueComments, "issue comments")) reviews.push(comment(entry, "comment", "gh:issue-comment"));

  return {
    number: numOf(pull, "number", "pull"),
    state: merged ? "merged" : rawState,
    ...mergedByOf(pull.merged_by),
    ...(pull.draft === true ? { draft: true as const } : {}),
    head: strOf(asObj(pull.head, "pull.head"), "sha", "pull.head"),
    checks: [...checks.values()],
    reviews,
  };
}

/** Who merged the pull, when the forge says; anything else reads as unknown. */
function mergedByOf(user: unknown): { mergedBy?: string } {
  const login = user && typeof user === "object" ? (user as { login?: unknown }).login : undefined;
  return typeof login === "string" && login ? { mergedBy: login } : {};
}
