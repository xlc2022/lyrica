# Brief: Charts on the Status page

**Status:** Merged as #587 (1041f4e), with #588 (f85d730). The operator asked for Status to be more useful,
with charts and analytics, and to refresh itself or have a refresh button
(2026-10-26), and picked the full set plus model hosts.

**Read first:** docs/briefs/status-model-facts.md (what the facts mean),
`daemon/src/model-facts.ts`, `web/src/ModelCallFacts.tsx`, `web/src/charts.ts`,
docs/ux.md (Recorded model activity, and what the server is doing now).

## Why

Status listed each model's calls and median speed as text, and a model that
only wrote titles read "Median speed Unavailable", because titles and project
chat looks were never timed. Principle 1: what she and the operator see about
her models matches what they did. Principle 8: no new setting, table or
dependency; the facts were already recorded and the chart library already ships.

## What it does

- `modelFacts` adds each copy's kind, output tokens and median prompt speed, and
  `calls[]`: each row's time, offering, task, output, speed and fallback mark.
  No thread, note or text; only the administrator's own shown pools, as before.
- `timedReply` (extension, `context.ts`) reads a one-shot request to its end with
  the turn's `PaceTracker`; a title and a project chat's look record their pace.
- Status: Updated time and Refresh, re-read every minute while visible and on
  focus; Last sleep and Memory facts; Model hosts (state and GPU blocks); one
  legend and four charts (calls and output per hour, speed per call, calls by
  task); a row per model copy. Charts are drawn live by Vega-Lite with a hover
  tip, in the one chart look, hours on the user's own clock.

## Out of scope

A range picker, longer history than retention keeps, errors or retries (not
recorded), other users' activity.

## Acceptance

Unit tests cover the new facts, the per-row points carrying no text, the pace
of a one-shot request, hour buckets and series colours. The admin e2e checks
the table, that each chart draws, Refresh and focus re-reads, the hosts block and
no horizontal scroll on a phone. docs/ux.md, docs/web.md, docs/daemon.md,
docs/models.md and docs/contracts.md describe it.

## Handoff

Done: everything above, merged as #587 and #588. Open: none.
