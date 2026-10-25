# Status model facts

Issue #557. Serves principles 1 (experience before infrastructure), 7 (plain
guarantees) and 8 (small surface).

Administration → Status adds plain-text per-model call counts, median recorded
generation speed and recorded fallback counts for the last 24 hours. Existing
Status facts stay. No charts, dependencies, timers, range picker or new tracking.

## Recorded meaning and coverage

- Only the authenticated administrator's own `model_calls` rows, in pools shown
  by their display settings, just as Call history. No other user's records.
  Pool visibility, not the Hidden thread filter, controls this metadata view.
- Read every retained row without a preview/page cap, then select timestamps in
  the inclusive interval from 24 hours before the request through the request.
  Nightly pruning keeps only the latest 500 records per user across pools;
  all records retained between prunes are read, including any past 500. This is
  **retained history, not a complete day's activity**. Folded token totals have
  neither timestamps nor pace/fallback evidence and cannot fill these gaps.
- One record counts once, grouped by permanent offering ID (each model copy on
  an endpoint). All recorded tasks count; a hosted turn's retries rewrite its
  record, and its tool requests update cumulative pace, not separate calls.
  Calls recorded without pace count too; Claude Code relay totals have no call
  records and are excluded. Deleted/pruned records are not recoverable here.
- Generation speed uses existing `pace.tokPerSec`, derived from recorded output
  tokens divided by generation milliseconds, only for positive output and at
  least 50 ms. Median across all available rates in the window; even sample
  counts average the central pair. Show the sample count; no sample means
  **Unavailable**, never zero. Duration alone is not speed.
- Fallbacks count nonempty recorded `fallback` markers. `recordCall` writes this
  from the first skipped resolution candidate, including eligibility/health
  skips. This is not a count of retries, failed attempts, or errors. No marker
  means no *recorded* fallback; notes are never searched to infer one.

## Acceptance

Synthetic tests cover counts, the window, medians, fallback semantics, missing
measurements, empty data, privacy/pool scope and reading past preview limits.
Status renders the retained-history scope and all model copies as plain facts,
wrapping at phone width. Screenshots from `web/e2e/shot.ts` cover empty and
populated states on desktop and phone. Typecheck and tests run serially.

Update docs/ux.md, docs/web.md, docs/daemon.md, docs/models.md and the API
contract alongside the implementation. No schema change or CODEOWNERS path
change is needed. Draft PR → exact-head Review and UI verification + green CI
→ ready → Claude exact-head approval → merge.
