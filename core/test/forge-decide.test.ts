import { describe, expect, it } from "vitest";
import { decide } from "../src/forge/decide.ts";
import type { CheckResult, ForgePollResult, ForgePullRequest, ForgeReview, ForgeWatchState } from "../src/forge/types.ts";

// Made-up fixtures (AGENTS.md): the watching account is lyrica-bot; Ada and Sam
// are other accounts. decide takes the common shape, so no forge answers here.
const HEAD_A = "ab".repeat(20);
const HEAD_B = "cd".repeat(20);

const check = (name: string, result: CheckResult | null): ForgePullRequest["checks"][number] => ({ id: `t:${name}`, name, result });
const review = (id: string, author: string, kind: ForgeReview["kind"], at = "2026-10-12T10:30:00Z"): ForgeReview => ({ id, author, kind, at });

const pull = (over: Partial<ForgePullRequest> = {}): ForgePollResult =>
  ({ kind: "snapshot", pull: { number: 7, state: "open", head: HEAD_A, checks: [], reviews: [], ...over } });

// A watch before its first successful poll: created at 10:00, no head yet.
const fresh = (over: Partial<ForgeWatchState> = {}): ForgeWatchState =>
  ({ head: null, headSince: "2026-10-12T10:00:00Z", notifiedHeads: [], seenReviews: [], ...over });

const run = (last: ForgeWatchState, poll: ForgePollResult, now = "2026-10-12T10:05:00Z") =>
  decide({ number: 7, account: "lyrica-bot", now, last, poll });

describe("decide", () => {
  it("gives one turn with the right note when every check on the head has finished", () => {
    const out = run(fresh(), pull({ checks: [check("build", "passed"), check("e2e", "failed")] }));
    expect(out.stop).toBe(false);
    expect(out.note).toEqual({
      number: 7,
      head: HEAD_A,
      ci: { kind: "finished", checks: [{ name: "build", result: "passed" }, { name: "e2e", result: "failed" }] },
      reviews: [],
      tokenUnreadable: false,
    });
    expect(out.next).toEqual({ head: HEAD_A, headSince: "2026-10-12T10:05:00Z", notifiedHeads: [HEAD_A], seenReviews: [] });
  });

  it("waits while a check still runs, and never wakes twice for one head", () => {
    const waiting = run(fresh(), pull({ checks: [check("build", "passed"), check("e2e", null)] }));
    expect(waiting.note).toBeNull();
    expect(waiting.next.head).toBe(HEAD_A);

    const finished = run(waiting.next, pull({ checks: [check("build", "passed"), check("e2e", "cancelled")] }), "2026-10-12T10:10:00Z");
    expect(finished.note?.ci).toEqual({ kind: "finished", checks: [{ name: "build", result: "passed" }, { name: "e2e", result: "cancelled" }] });

    // A re-run on the same commit, finished again, doesn't wake her twice.
    const rerun = run(finished.next, pull({ checks: [check("build", "passed"), check("e2e", "passed")] }), "2026-10-12T10:20:00Z");
    expect(rerun.note).toBeNull();
  });

  it("starts the wait again on a new head", () => {
    const done = run(fresh(), pull({ checks: [check("build", "passed")] }));
    const pushed = run(done.next, pull({ head: HEAD_B, checks: [check("build", null)] }), "2026-10-12T10:30:00Z");
    expect(pushed.note).toBeNull(); // the new head's checks are still running
    expect(pushed.next).toEqual({ head: HEAD_B, headSince: "2026-10-12T10:30:00Z", notifiedHeads: [HEAD_A], seenReviews: [] });

    const finished = run(pushed.next, pull({ head: HEAD_B, checks: [check("build", "passed")] }), "2026-10-12T10:40:00Z");
    expect(finished.note?.head).toBe(HEAD_B);
    expect(finished.next.notifiedHeads).toEqual([HEAD_A, HEAD_B]);
  });

  it("notes no checks fifteen minutes after a head appears, once", () => {
    const early = run(fresh(), pull(), "2026-10-12T10:14:00Z"); // first sight restarts the clock at now
    expect(early.note).toBeNull();

    const soon = run({ ...fresh(), head: HEAD_A }, pull(), "2026-10-12T10:14:59Z");
    expect(soon.note).toBeNull();

    const late = run({ ...fresh(), head: HEAD_A }, pull(), "2026-10-12T10:15:00Z");
    expect(late.note?.ci).toEqual({ kind: "noChecks" });
    expect(late.next.notifiedHeads).toEqual([HEAD_A]);

    // Checks that turn up late on a head already noted don't wake her again.
    const later = run(late.next, pull({ checks: [check("build", "passed")] }), "2026-10-12T10:40:00Z");
    expect(later.note).toBeNull();
  });

  it("gives one turn for a review or comment from another account, grouped by author and kind", () => {
    const out = run(fresh(), pull({ reviews: [
      review("r1", "ada", "commented"),
      review("r2", "sam", "approved"),
      review("r3", "ada", "commented", "2026-10-12T10:40:00Z"),
    ] }));
    expect(out.note?.ci).toBeNull();
    expect(out.note?.reviews).toEqual([
      { author: "ada", kind: "commented", count: 2 },
      { author: "sam", kind: "approved", count: 1 },
    ]);
    expect(out.next.seenReviews).toEqual(["r1", "r2", "r3"]);

    // The next poll sees the same reviews again and wakes nothing.
    const again = run(out.next, pull({ reviews: [review("r1", "ada", "commented")] }), "2026-10-12T10:50:00Z");
    expect(again.note).toBeNull();
    expect(again.next.seenReviews).toEqual(["r1", "r2", "r3"]); // no duplicates
  });

  it("never wakes for her own events, but marks them seen (logins are case-insensitive)", () => {
    const out = run(fresh(), pull({ reviews: [review("r1", "Lyrica-Bot", "comment"), review("r2", "lyrica-bot", "approved")] }));
    expect(out.note).toBeNull();
    expect(out.next.seenReviews).toEqual(["r1", "r2"]);
  });

  it("shares one wake between a finished check and a new review in the same poll", () => {
    const out = run(fresh(), pull({ checks: [check("build", "passed")], reviews: [review("r1", "sam", "changesRequested")] }));
    expect(out.note).toEqual({
      number: 7,
      head: HEAD_A,
      ci: { kind: "finished", checks: [{ name: "build", result: "passed" }] },
      reviews: [{ author: "sam", kind: "changesRequested", count: 1 }],
      tokenUnreadable: false,
    });
  });

  it("ends the watch silently when the pull is merged or closed", () => {
    for (const state of ["merged", "closed"] as const) {
      const out = run(fresh(), pull({ state }));
      expect(out.stop).toBe(true);
      expect(out.note).toBeNull();
    }
  });

  it("ends the watch with one note when the token can't read the pull", () => {
    for (const status of [401, 403, 404] as const) {
      const seen = run(fresh({ head: HEAD_A }), { kind: "unreadable", status });
      expect(seen.stop).toBe(true);
      expect(seen.note).toEqual({ number: 7, head: HEAD_A, ci: null, reviews: [], tokenUnreadable: true });

      const never = run(fresh(), { kind: "unreadable", status });
      expect(never.note?.head).toBeNull(); // the token was never readable
    }
  });

  it("still wakes for a review after the no-checks note, on the same head", () => {
    const noted = run({ ...fresh(), notifiedHeads: [HEAD_A] }, pull(), "2026-10-12T10:30:00Z");
    expect(noted.note).toBeNull(); // noChecks already told her about this head
    const reviewed = run(noted.next, pull({ reviews: [review("r1", "ada", "comment")] }), "2026-10-12T10:35:00Z");
    expect(reviewed.note?.ci).toBeNull();
    expect(reviewed.note?.reviews).toEqual([{ author: "ada", kind: "comment", count: 1 }]);
  });
});
