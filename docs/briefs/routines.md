# Brief: Routines

**Thread:** Roadmap (coordinates). **Branch:** `feature/routines`.
**Built by:** Codex on the test machine, and the local model for part A
(below). The Roadmap thread reviews each part before it goes to PR review.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md "Projects"
(Wake-ups and Routines), docs/contracts.md, docs/delegation.md "Wake-ups",
docs/ux.md (the Routines rows), and the wake-ups code this reuses:
`daemon/src/wakeups.ts`, `extension/src/threads.ts` (`later`),
`core/src/threads.ts` (`WAKEUP_LIMITS`), `core/src/store/pool.ts`
(`wakeups`), `core/src/migrations.ts`, `daemon/test/wakeups.test.ts`.

## Goal

The user asks her for something on a schedule, and it happens: a morning
CI check in a project thread, a weekday check-in in a chat, a birthday.
Previously she had to chain one-shot wake-ups and re-arm each one. Serves
principle 1 (the user notices it this month)
and principle 8: no new tool or process, it extends `threads` and lyricad's
tick.

## In scope

**A. Schedule maths** (the local model, reviewed by Codex). One pure
function in `core/src/routines.ts`: `nextRun(schedule, after: Date): Date`.
Schedules: `daily` at HH:MM, `weekdays` at HH:MM, `weekly` on a day at
HH:MM, `yearly` on MM-DD at HH:MM (29 February fires on 28 February in
other years), `every` N hours (1 to 168, counted from when it was set).
Times are in lyricad's local time zone; a time skipped by a DST change
fires at the next valid minute, and a repeated hour fires once. Unit tests
for each kind and both DST edges. Also `parseSchedule` and `describe` (the
words the facts line shows, such as "Weekdays 08:00").

**B. Storage and firing** (Codex).
- An expand-only pool migration step adding a `routines` table: id,
  thread, schedule (JSON), note, opens a new thread (0/1), paused (0/1),
  next_at, last_at, created_at. Encrypted with the pool like `wakeups`. A
  migration test from every released schema.
- `daemon/src/routines.ts` beside `wakeups.ts`, on the same tick. A due
  routine starts a turn in its thread marked `[Routine, <describe>]` with
  its note, or, when it opens a new thread, starts one in the same place
  (the project, or the thread list) with the note as its first turn.
- Guards, per DESIGN: waits while its project is paused; counts against the
  at-once limit; skipped (and next_at moved on) while its last run is still
  working; a locked user's missed runs fire once at unlock, saying how
  many were due; a thread's wake-ups and routines share
  `WAKEUP_LIMITS.perDay`: 24 fires in a rolling day. At the cap, routines
  advance to their next run and wake-ups wait.

**C. Her side** (Codex). `threads routine` actions in the existing
`threads` tool: `add` (schedule, note, new thread or not), `list`,
`pause`/`resume`, `remove`. At most 10 routines per thread. A short
guideline line beside `WAKEUP_GUIDELINE`: routines are for what the user
asked to happen regularly; a one-off later is a wake-up.

**D. Web** (Codex; UI review judges it). Per docs/ux.md: **Routine** with
the next time in the thread's facts line, a popover listing them with
Pause and Remove; a Routine marker in the conversation like Woke up;
**Settings → Routines** after MCP servers: every routine of the user, its
thread linked, schedule, next time in mono, Pause and Remove.

**E. Docs** (the local model drafts, Codex checks against the code).
docs/delegation.md (a Routines section after Wake-ups), docs/contracts.md,
docs/web.md, and the status table in docs/briefs/design.md. Every doc the
change makes stale is updated and listed in the PR description.

## Out of scope

A calendar or event import; reminders (wake-ups); push notifications;
one thread setting a routine on another thread; routines a user didn't
ask for.

## Done when

`npm run typecheck` and `npm test` pass; tests cover the schedule maths,
each guard, a private-pool routine staying on local models, a routine
opening a new thread, and the migration. No message text or notes reach
disk outside the encrypted pool.

## Handoff notes

Parts A–E are built on `feature/routines`, including the docs check against
the code. Left: open the PR, then PR review and UI review of its head commit.
Serves principles 1 and 8: recurring turns use the existing tool and daemon tick.
