# Update progress on the Updates card

Serves principle 1 (real use hit a real wall: the first in-app update on
production showed no progress) and principle 6 (make review easy: the
operator sees where an update is and why it failed without opening the
journal), within DESIGN.md "Updates and self-editing".

## Problem

The first real in-app update showed only "An update is running." on the
Updates card: one state word at most, no sense of how far it had got, and
a failed build's output only in the journal. The card also came back idle
right after Update was pressed, so it didn't follow at all; #793 fixed
that part (a waiting request shows as the step it starts with).

## What to build

- **Updater.** `set_state` keeps `steps` in `state.json` for an update
  (a state with its tag): each state it went through with `started` and
  `ended`, the one it failed in marked `failed`. A fetch with a tag starts
  them over; a check or an asked-for rollback drops them. An automatic
  rollback keeps the tag and marks the probation step failed. `fail` takes the output's last 40 lines (the
  fetch's git error, the build log, the smoke test's checks) as `output`,
  at most 8,000 characters. Never message text: the build user can't read
  her data and the smoke test runs in a scratch home.
- **lyricad.** `Updates.state` passes `steps` (with a tag) and `output`
  (only while failed). A waiting request's `since` is the request file's
  time, so the page can tell the updater hasn't started.
- **Web.** A box under Update in the state line's place, per docs/ux.md
  §6 "Updates": tag, state word, the six steps as a checklist with
  durations, a stalled-request warning after a minute, and after a failure
  the reason and the output in a code block with Copy, which the operator
  can fold away (asked for in review).

Out of scope: a live build log while it runs (the step and its time are
enough to see it's moving), and host updates (Models → Hosts has its own
state line).

## Handoff

Done: updater steps and output, lyricad passthrough, the box, docs
(ux.md, web.md, daemon.md, contracts.md), updater, API and e2e tests.
Next: UI review and PR review. Open: nothing.
