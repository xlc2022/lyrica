# Brief: the unit tests in three shards

**Status:** Merged as #875 (b4a94032).

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
take about 3:50). The operator chose three.

Expected: the run bounded by the e2e jobs, about 3:45 after #872.

Out of scope: a duration-aware split (a committed timings file or a
custom sequencer), which would balance better at the cost of code to
maintain.

## Docs

docs/ci.md.

## Handoff

Done: the matrix, the docs; merged 2026-11-09. Measured on the PR's
run: 65 files in each shard, 712, 632 and 618 tests, Vitest 98 s, 78 s
and 116 s, the jobs 2:22, 1:58 and 2:34; on main's first run with this
and #872 (b4a94032), 2:12, 1:54 and 1:59. That run's jobs took 3:47 from
first start to last end, where the audit began at about 15 minutes: the
nix and host-stack jobs (3:46 each) and the e2e jobs (3:01 to 3:34) now
end together, so the next second off needs all of them. Open questions:
none.
