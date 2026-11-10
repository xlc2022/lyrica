# Brief: routine titles and purpose (#924)

## Goal and smallest version

The existing thread popover and Settings → Routines identify tasks, not just
when they run. Serves principles 1 (real friction), 6 (review is easy) and
8 (reuse the existing surface). No scheduling changes, new dialog, visible
explanation captions or dashboard.

## Contract

- Add optional `title` (80 characters, one line) and `description` (300
  characters) to a routine, encrypted in its own pool. Expand-only nullable
  columns; no rewriting notes, schedules, IDs or firing times. Old readers
  retain their columns and the minimum reader stays unchanged.
- `threads routine add` accepts both fields. Reuse `title`, add
  `description`. An `edit` routine action changes these metadata fields only,
  so existing tasks can be labelled without removing or rescheduling them.
  Validate and remove credentials at the storage boundary. Tool listings
  include explicit metadata but never note text.
- Existing owner-authenticated routine listings gain title and description;
  the execution note stays excluded. Listings retain existing pool/thread
  visibility checks. No extracting task text or parsing titles from notes.
- Legacy fallback: the source thread title plus `Routine <id>` identifies the
  row; its tooltip honestly says that it runs the saved instructions here
  (or in a new thread). It does not pretend to know the task's purpose.
  Explicit metadata replaces this fallback when edited. This is deliberately
  less specific than the saved instructions, not an automatic disclosure of
  them. No deployment-specific names or live routine text enters this PR.

## Layout and interaction

Reuse RoutineRows, wake-item, routine-facts and the existing `wl`/`preview`
explanatory tooltip pattern. Title first (14 px); below it schedule with
numbers in mono, next time or Paused; retain Pause/Resume and Remove at the
right. Settings retains its source-thread link as a separate fact. Long
names wrap inside the text column, not over the actions.

The title's explanation is a `role=tooltip` preview described by
`aria-describedby`, reachable by keyboard focus and touch (tap focuses the
word); hover reveals it on pointer devices. Escape dismisses the tooltip
before closing the outer routine popover. No new action button or icon.
Rules: UX §2 typography, §3 controls, §4 noun labels/no captions, §6 existing
routine home and existing explanatory tooltip convention.

## Checks and docs

Metadata round trips and metadata-only edits; legacy fallback; migration
from every released pool schema; API note exclusion and existing visibility;
UI title/tooltip in both surfaces, keyboard/touch, long title, paused state
and unchanged actions. Run typecheck, npm test, build, web e2e one suite at
a time; shot.ts desktop/phone light/dark captures and inspect. Update routine
contracts, delegation, memory schema, daemon, web, UX and original routine
brief wherever made stale. Boundary paths: pool storage and migrations;
owner approval is required before merging.

## Handoff

Done: Review and UI review accepted the contract/layout before implementation.
Optional encrypted labels, metadata-only edits, explicit note-free projections,
independent legacy fallbacks and shared title/tooltips are implemented. Numeric
IDs remain in tool listings, including labelled rows; tool-definition size
budgets are preserved. Migration and round-trip tests cover old and new data.
Typecheck, 1,953 unit tests and build pass. The routine browser test passes
at both widths, including hover-only and focused/touch Escape ordering;
all 16 screenshot states were refreshed and inspected. Full desktop-chat and
phone-chat each pass 32 tests and fail the upload/composer expectation test;
the exact same test fails at both widths on clean base b66648ae after an
independent install/build. It is an evidenced baseline failure, not skipped
or loosened here.
Next: commit/open PR and send its exact head to both reviewers. Full results
and screenshot evidence belong on the PR. No owner approval or merge yet.
Open: exact-head verification, green CI and owner boundary approval. A red
CI run remains blocking even if it repeats the baseline upload failure.
