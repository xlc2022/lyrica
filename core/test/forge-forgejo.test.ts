import { describe, expect, it } from "vitest";
import { forgejoPullRequest } from "../src/forge/forgejo.ts";
import type { ForgejoAnswers } from "../src/forge/forgejo.ts";

// Recorded answers are made-up fixtures (AGENTS.md): the watching account is
// lyrica-bot, reviewers are Ada and Sam. No real data, no network.
const HEAD = "cd".repeat(20);

const answers = (over: Partial<ForgejoAnswers> = {}): ForgejoAnswers => ({
  pull: { number: 7, state: "open", merged: false, merged_at: null, head: { sha: HEAD } },
  status: { state: "", statuses: [] },
  reviews: [],
  comments: [],
  ...over,
});

describe("the Forgejo/Gitea module", () => {
  it("reads the combined status, Actions and external CI alike", () => {
    const pull = forgejoPullRequest("forgejo", answers({
      status: { state: "failure", statuses: [
        { id: 1, context: "checks/build", status: "success" },
        { id: 2, context: "e2e", status: "pending" },
        { id: 3, context: "external/lint", status: "warning" }, // yellow is not green
        { id: 4, context: "deploy", status: "failure" },
        { id: 5, context: "reporter", status: "error" },
      ] },
    }));
    expect(pull).toEqual({
      number: 7,
      state: "open",
      head: HEAD,
      checks: [
        { id: "forgejo:status:checks/build", name: "checks/build", result: "passed" },
        { id: "forgejo:status:e2e", name: "e2e", result: null },
        { id: "forgejo:status:external/lint", name: "external/lint", result: "failed" },
        { id: "forgejo:status:deploy", name: "deploy", result: "failed" },
        { id: "forgejo:status:reporter", name: "reporter", result: "failed" },
      ],
      reviews: [],
    });
  });

  it("qualifies IDs by kind, so a Gitea host's answers read as Gitea's", () => {
    const pull = forgejoPullRequest("gitea", answers({
      status: { state: "success", statuses: [{ id: 1, context: "build", status: "success" }] },
      reviews: [{ id: 21, reviewer: { login: "ada" }, state: "APPROVED", submitted_at: "2026-10-12T09:00:00Z" }],
    }));
    expect(pull.checks[0]?.id).toBe("gitea:status:build");
    expect(pull.reviews[0]?.id).toBe("gitea:review:21");
  });

  it("maps review states across the two forges' spellings and skips unsubmitted ones", () => {
    const pull = forgejoPullRequest("forgejo", answers({
      reviews: [
        { id: 21, reviewer: { login: "ada" }, state: "approved", submitted_at: "2026-10-12T09:00:00Z" },
        { id: 22, reviewer: { login: "sam" }, state: "REQUEST_CHANGES", submitted_at: "2026-10-12T09:05:00Z" }, // Gitea's spelling
        { id: 23, reviewer: { login: "ada" }, state: "changes_requested", submitted_at: "2026-10-12T09:07:00Z" }, // Forgejo's
        { id: 24, reviewer: { login: "sam" }, state: "pending", submitted_at: "0001-01-01T00:00:00Z" }, // not submitted yet
        { id: 25, reviewer: { login: "sam" }, state: "commented", created_at: "2026-10-12T09:10:00Z" }, // no submitted_at to read
      ],
    }));
    expect(pull.reviews).toEqual([
      { id: "forgejo:review:21", author: "ada", kind: "approved", at: "2026-10-12T09:00:00Z" },
      { id: "forgejo:review:22", author: "sam", kind: "changesRequested", at: "2026-10-12T09:05:00Z" },
      { id: "forgejo:review:23", author: "ada", kind: "changesRequested", at: "2026-10-12T09:07:00Z" },
      { id: "forgejo:review:25", author: "sam", kind: "commented", at: "2026-10-12T09:10:00Z" },
    ]);
  });

  it("tells a comment on a review's diff line from one on the pull itself", () => {
    const pull = forgejoPullRequest("forgejo", answers({
      comments: [
        { id: 41, user: { login: "sam" }, created_at: "2026-10-12T09:15:00Z" },
        { id: 42, user: { login: "ada" }, created_at: "2026-10-12T09:20:00Z", pull_review_id: 3 },
        { id: 43, user: { login: "lyrica-bot" }, created_at: "2026-10-12T09:25:00Z", pull_review_id: 0 }, // her own; kept here
      ],
    }));
    expect(pull.reviews).toEqual([
      { id: "forgejo:comment:41", author: "sam", kind: "comment", at: "2026-10-12T09:15:00Z" },
      { id: "forgejo:comment:42", author: "ada", kind: "reviewComment", at: "2026-10-12T09:20:00Z" },
      { id: "forgejo:comment:43", author: "lyrica-bot", kind: "comment", at: "2026-10-12T09:25:00Z" },
    ]);
  });

  it("reads a merged pull from the flag or the timestamp, and refuses what it can't classify", () => {
    const byFlag = forgejoPullRequest("forgejo", answers({ pull: { number: 7, state: "closed", merged: true, head: { sha: HEAD } } }));
    expect(byFlag.state).toBe("merged");
    const byStamp = forgejoPullRequest("gitea", answers({ pull: { number: 7, state: "closed", merged: false, merged_at: "2026-10-12T12:00:00Z", head: { sha: HEAD } } }));
    expect(byStamp.state).toBe("merged");
    expect(() => forgejoPullRequest("forgejo", answers({ status: { state: "", statuses: [{ id: 1, context: "ci", status: "half-done" }] } })))
      .toThrow(/unknown combined status/);
  });
});
