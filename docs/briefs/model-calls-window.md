# Model calls window

**Status:** Built on `claude/project-thread-v48zw0`; in review.

Serves principles 1 (experience before infrastructure) and 8 (small surface):
the operator asked for Administration → Status's Model calls card to reach
back up to a month, with a way to narrow the time.

## What it does

- **Window.** A segmented control **24 h | 7 d | 30 d** in the card's head
  (24 h each time Status opens). A drag across either bar chart, or a click on
  one bar and then another (a tap on a phone), narrows the card to those bars;
  **Clear** goes back. The head names the window ("last 7 days", or the span's
  start and end). Reset still starts the count at the moment it was pressed.
- **Bars.** An hour each up to a day and a half, 6 hours up to 10 days, a day
  beyond, on the user's clock, so a chart holds about 24 to 30 bars. Speed dots
  shrink past a day and a half.
- **API.** `GET …/admin/status?from=&to=` (ISO). lyricad holds `to` to now and
  `from` to no earlier than 31 days ago (`factsWindow`); `modelFacts` gains
  `from`, so the page can tell a Reset inside the window.
- **Retention.** Nightly `ModelStore.prune` keeps every `model_calls` record of
  the last 31 days, never fewer than the latest 500 (a quiet user keeps their
  recent ones) nor more than 20,000. Records are counts and times only, about
  250 bytes each, so a busy month is a few MB per user. Rows that go are folded
  into `call_totals` first, as before, so thread usage doesn't change. No
  schema change and no migration.

Out of scope: daily rollups (they can't give the speed dots or medians),
windows longer than a month, a keyboard way to narrow (the three windows are
keyboard reachable).

Privacy: unchanged. Records hold no text, stay in each user's encrypted
`user.db`, and Private rows show only where the Private pool is shown.

## Handoff

Done: core retention, daemon window, web picker and narrowing, unit and e2e
tests, docs (ux, web, models, contracts). Next: review fixes. Open: none.
