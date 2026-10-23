import { describe, expect, it } from "vitest";
import { forgejoPullRequest } from "../src/forge/forgejo.ts";
import { githubPullRequest } from "../src/forge/github.ts";
import type { GitHubAnswers } from "../src/forge/github.ts";

// Recorded answers are made-up fixtures (AGENTS.md): the watching account is
// lyrica-bot, reviewers are Ada and Sam. No real data, no network.
const HEAD = "ab".repeat(20);

const answers = (over: Partial<GitHubAnswers> = {}): GitHubAnswers => ({
  pull: { number: 7, state: "open", merged: false, merged_at: null, head: { sha: HEAD } },
  checkRuns: { total_count: 0, check_runs: [] },
  status: { state: "pending", statuses: [] },
  reviews: [],
  reviewComments: [],
  issueComments: [],
  ...over,
});

describe("the GitHub module", () => {
  it("merges check runs and combined statuses into one list of results", () => {
    const pull = githubPullRequest(answers({
      checkRuns: { total_count: 5, check_runs: [
        { id: 11, name: "build", status: "completed", conclusion: "success" },
        { id: 12, name: "lint", status: "in_progress", conclusion: null },
        { id: 13, name: "audit", status: "completed", conclusion: "timed_out" },
        { id: 14, name: "triage", status: "completed", conclusion: "neutral" },
        { id: 15, name: "docs-preview", status: "completed", conclusion: "skipped" },
      ] },
      status: { state: "failure", statuses: [
        { context: "ci/travis", state: "success" },
        { context: "codecov/patch", state: "failure" },
        { context: "deploy/prod", state: "error" },
        { context: "wip", state: "pending" },
      ] },
    }));
    expect(pull).toEqual({
      number: 7,
      state: "open",
      head: HEAD,
      checks: [
        { id: "gh:check-run:11", name: "build", result: "passed" },
        { id: "gh:check-run:12", name: "lint", result: null },
        { id: "gh:check-run:13", name: "audit", result: "timedOut" },
        { id: "gh:check-run:14", name: "triage", result: "passed" }, // neutral counts as passed
        { id: "gh:check-run:15", name: "docs-preview", result: "passed" }, // skipped too
        { id: "gh:status:ci/travis", name: "ci/travis", result: "passed" },
        { id: "gh:status:codecov/patch", name: "codecov/patch", result: "failed" },
        { id: "gh:status:deploy/prod", name: "deploy/prod", result: "failed" },
        { id: "gh:status:wip", name: "wip", result: null },
      ],
      reviews: [],
    });
  });

  it("reads cancelled and action-required runs, and merged and closed pulls", () => {
    const pull = githubPullRequest(answers({
      checkRuns: { total_count: 2, check_runs: [
        { id: 16, name: "e2e", status: "completed", conclusion: "cancelled" },
        { id: 17, name: "hold", status: "completed", conclusion: "action_required" }, // waiting on a person
      ] },
    }));
    expect(pull.checks).toEqual([
      { id: "gh:check-run:16", name: "e2e", result: "cancelled" },
      { id: "gh:check-run:17", name: "hold", result: null },
    ]);
    const merged = githubPullRequest(answers({ pull: { number: 7, state: "closed", merged: true, merged_at: "2026-10-12T12:00:00Z", head: { sha: HEAD } } }));
    expect(merged.state).toBe("merged");
    expect(merged.mergedBy).toBeUndefined();
    expect(githubPullRequest(answers({ pull: { number: 7, state: "closed", merged: true, merged_by: { login: "sam" }, head: { sha: HEAD } } })).mergedBy).toBe("sam");
    const closed = githubPullRequest(answers({ pull: { number: 7, state: "closed", merged: false, merged_at: null, head: { sha: HEAD } } }));
    expect(closed.state).toBe("closed");
  });

  it("collects reviews and both comment kinds, keeping her own for decide to exclude", () => {
    const pull = githubPullRequest(answers({
      reviews: [
        { id: 21, user: { login: "ada" }, state: "APPROVED", submitted_at: "2026-10-12T09:00:00Z" },
        { id: 22, user: { login: "sam" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-12T09:05:00Z" },
        { id: 23, user: { login: "ada" }, state: "COMMENTED", submitted_at: "2026-10-12T09:10:00Z" },
        { id: 24, user: { login: "sam" }, state: "DISMISSED", submitted_at: "2026-10-12T09:12:00Z" }, // not a fresh opinion
      ],
      reviewComments: [{ id: 31, user: { login: "sam" }, created_at: "2026-10-12T09:15:00Z" }],
      issueComments: [
        { id: 41, user: { login: "lyrica-bot" }, created_at: "2026-10-12T09:20:00Z" }, // her own; kept here
        { id: 42, user: { login: "ada" }, created_at: "2026-10-12T09:25:00Z" },
      ],
    }));
    expect(pull.reviews).toEqual([
      { id: "gh:review:21", author: "ada", kind: "approved", at: "2026-10-12T09:00:00Z" },
      { id: "gh:review:22", author: "sam", kind: "changesRequested", at: "2026-10-12T09:05:00Z" },
      { id: "gh:review:23", author: "ada", kind: "commented", at: "2026-10-12T09:10:00Z" },
      { id: "gh:review-comment:31", author: "sam", kind: "reviewComment", at: "2026-10-12T09:15:00Z" },
      { id: "gh:issue-comment:41", author: "lyrica-bot", kind: "comment", at: "2026-10-12T09:20:00Z" },
      { id: "gh:issue-comment:42", author: "ada", kind: "comment", at: "2026-10-12T09:25:00Z" },
    ]);
  });

  it("refuses answers it cannot classify rather than guessing a result", () => {
    expect(() => githubPullRequest(answers({
      checkRuns: { total_count: 1, check_runs: [{ id: 18, name: "x", status: "completed", conclusion: "exploded" }] },
    }))).toThrow(/unknown check-run conclusion/);
    expect(() => githubPullRequest(answers({
      status: { state: "", statuses: [{ context: "ci", state: "half-done" }] },
    }))).toThrow(/unknown commit-status state/);
    expect(() => githubPullRequest(answers({ pull: "not a body" }))).toThrow(/pull is not an object/);
  });

  it("and the Forgejo module turn equivalent answers into the same shape", () => {
    const gh = githubPullRequest(answers({
      checkRuns: { total_count: 1, check_runs: [{ id: 11, name: "build", status: "completed", conclusion: "success" }] },
      status: { state: "pending", statuses: [{ context: "wip", state: "pending" }] },
      reviews: [{ id: 21, user: { login: "ada" }, state: "APPROVED", submitted_at: "2026-10-12T09:00:00Z" }],
    }));
    const fj = forgejoPullRequest("forgejo", {
      pull: { number: 7, state: "open", merged: false, merged_at: null, head: { sha: HEAD } },
      status: { state: "success", statuses: [
        { id: 1, context: "build", status: "success" },
        { id: 2, context: "wip", status: "pending" },
      ] },
      reviews: [{ id: 21, reviewer: { login: "ada" }, state: "approved", submitted_at: "2026-10-12T09:00:00Z" }],
      comments: [],
    });
    // IDs carry each forge's prefix by design; everything else must agree.
    expect(gh.checks.map(({ name, result }) => ({ name, result })))
      .toEqual(fj.checks.map(({ name, result }) => ({ name, result })));
    expect(gh.reviews.map(({ author, kind, at }) => ({ author, kind, at })))
      .toEqual(fj.reviews.map(({ author, kind, at }) => ({ author, kind, at })));
  });
});
