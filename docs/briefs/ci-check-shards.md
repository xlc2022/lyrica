# Brief: the unit tests in three shards

**Status:** Built, in review.

**Branch:** `claude/project-thread-5aac8y-check`. **Asked for:** by the
operator, 2026-11-09, after [ci-chat-split.md](ci-chat-split.md) left the
check job as CI's longest.

**Serves:** principle 8 (budgets): a pull request pays the unit tests'
time on every push.

## Problem

The check job took 5:23: 45 seconds of setup and typecheck, then 4:38 of
Vitest. Its 195 test files add up to 11 minutes of work on the runner's
three workers, and four files (the daemon's children, projects and updater
tests, and the core sandbox tests) are a third of that.

## Change

The check job is a matrix of three shards, `check (1)` to `check (3)`,
each running `npm test -- --shard=N/3`. Vitest deals the files out by a
hash of each file's path, so a new test file joins a shard on its own and
the workflow never lists files. The typecheck runs in the first shard
only, so a type error shows once.

Measured against the last run's per-file times, today's shards hold 205,
151 and 321 seconds of work, so the slowest should take about 3 minutes;
the balance drifts as files come and go. The other ways considered: four
shards (about 2:35, one more runner per push) and a split by folder (the
daemon's tests alone are two thirds of the work, so that job would still
take about 3:50). Three shards were the recommendation.

Expected: the run bounded by the e2e jobs, about 3:45 after #872.

Out of scope: a duration-aware split (a committed timings file or a
custom sequencer), which would balance better at the cost of code to
maintain.

## Docs

docs/ci.md.

## Handoff

Done: the matrix, the docs.
Next: PR review, then record the measured time here. Open questions: none.
