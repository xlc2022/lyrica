// CI wakes (docs/briefs/ci-wakes.md part A): the Forgejo/Gitea module. Both
// speak the same API under /api/v1, so one module serves both kinds; `kind`
// only qualifies IDs. Turns the recorded answers — the pull, its head's
// combined status (Actions and external CI both report there), the pull's
// reviews and the issue's comments — into the common shape (principles 6 and
// 7). Pure: the poller has already fetched every page; nothing here does I/O.

import type { CheckResult, ForgeCheck, ForgeKind, ForgePullRequest, ForgeReview } from "./types.ts";
import { asList, asObj, mergedByOf, numOf, type Obj, strOf, timeOf } from "./parse.ts";

/** The parsed bodies of the four calls (brief step 3), lists already joined across pages. */
export interface ForgejoAnswers {
  /** GET /api/v1/repos/{owner}/{repo}/pulls/{number} */
  pull: unknown;
  /** GET /api/v1/repos/{owner}/{repo}/commits/{head}/status, the combined status */
  status: unknown;
  /** GET /api/v1/repos/{owner}/{repo}/pulls/{number}/reviews */
  reviews: unknown;
  /** GET /api/v1/repos/{owner}/{repo}/issues/{number}/comments — plain and review comments alike */
  comments: unknown;
}

function loginOf(user: unknown, what: string): string {
  return strOf(asObj(user, what), "login", what);
}

/** A combined-status report; null means still waiting. Unknown values throw —
 * guessing here could compute a false "all finished" and wake her too early. */
function statusResult(status: string): CheckResult | null {
  switch (status) {
    case "success": return "passed";
    // The common shape has no warning; yellow is not green, so it reads as
    // failed rather than hiding a reporter's concern from the note.
    case "warning": case "failure": case "error": return "failed";
    case "pending": case "unknown": return null;
    default: throw new Error(`unknown combined status "${status}"`);
  }
}

/** A submitted review's kind, or null to skip it. Gitea says REQUEST_CHANGES
 * where GitHub says CHANGES_REQUESTED; both are accepted, case-insensitively,
 * as the serialisation differs between versions. Pending and dismissed reviews
 * are not a fresh opinion; an unknown state is skipped too — one odd review
 * must not block the whole snapshot (it can only miss a wake, never invent one). */
function reviewKind(state: string): ForgeReview["kind"] | null {
  switch (state.toUpperCase()) {
    case "APPROVED": return "approved";
    case "REQUEST_CHANGES": case "CHANGES_REQUESTED": return "changesRequested";
    case "COMMENTED": return "commented";
    default: return null;
  }
}

/** The common shape for one Forgejo or Gitea pull (brief step 3): checks from
 * the combined status, reviews and comments with her own kept — decide is what
 * excludes them by account. A comment carrying a pull_review_id was made on a
 * review's diff line, so it reads as a review comment. */
export function forgejoPullRequest(kind: Extract<ForgeKind, "forgejo" | "gitea">, answers: ForgejoAnswers): ForgePullRequest {
  const pull = asObj(answers.pull, "pull");
  const rawState = strOf(pull, "state", "pull");
  if (rawState !== "open" && rawState !== "closed") throw new Error(`unknown pull state "${rawState}"`);
  const merged = pull.merged === true || typeof pull.merged_at === "string";

  const checks = new Map<string, ForgeCheck>();
  for (const entry of asList(asObj(answers.status, "combined status").statuses ?? [], "combined status")) {
    const o = asObj(entry, "status");
    const context = strOf(o, "context", "status");
    const id = `${kind}:status:${context}`;
    checks.set(id, { id, name: context, result: statusResult(strOf(o, "status", "status")) });
  }

  const reviews: ForgeReview[] = [];
  for (const entry of asList(answers.reviews, "reviews")) {
    const o = asObj(entry, "review");
    const reviewAs = reviewKind(strOf(o, "state", "review"));
    if (reviewAs === null) continue;
    reviews.push({
      id: `${kind}:review:${numOf(o, "id", "review")}`,
      author: loginOf(o.reviewer, "review.reviewer"),
      kind: reviewAs,
      at: timeOf(o, ["submitted_at", "created_at"], "review"),
    });
  }
  for (const entry of asList(answers.comments, "comments")) {
    const o = asObj(entry, "comment");
    const onReview = typeof o.pull_review_id === "number" && o.pull_review_id > 0;
    reviews.push({
      id: `${kind}:comment:${numOf(o, "id", "comment")}`,
      author: loginOf(o.user, "comment.user"),
      kind: onReview ? "reviewComment" : "comment",
      at: timeOf(o, ["created_at"], "comment"),
    });
  }

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
