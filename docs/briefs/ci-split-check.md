# Brief: the unit tests and the e2e tests as two CI jobs

**Status:** Built, in review.

**Branch:** `claude/project-thread-5aac8y`. **Asked for:** by the operator,
2026-11-08, after an audit of the workflow.

**Serves:** principle 8 (budgets): a pull request's checks cost wall-clock
time on every push, and the `check` job was the whole critical path.

## Problem

The `check` job ran the typecheck, the unit tests and the Playwright tests
in one line on one runner: about 14.5 minutes, of which the unit tests
took 4.5 and Playwright 9. The `nix` job (6 to 11 minutes) and
`host-stack` (3.5) always finished first, so every run waited on `check`.

## Change

`check` keeps the typecheck and the unit tests. A new `e2e` job builds the
web UI, installs Chromium and runs the Playwright tests, with the same
failure steps as before (the `e2e-traces-<attempt>` artifact and the
failed pages printed in the log). Both run when `changes` says the diff
touches code, and both install the same packages, so the lyricad the
tests drive finds the same runner. Setting up the second runner costs
about a minute; the run should end about 10 minutes after it starts
instead of 14.5. Nothing is cut: the artifact step stays, since it is the
only way to read an e2e failure without re-running it.

Out of scope: stripping the self-hosted runner paths from the workflows
and docs/ci.md (offered in the audit, not asked for).

## Docs

docs/ci.md and docs/guides/ci-runners.md name the two jobs. If `check` is
a required status check in the repository's branch protection, `e2e` must
be added beside it, or a red Playwright run would not block a merge.

## Handoff

Done: the split, the docs. Next: PR review, then measure a few runs and
record the time here. Open questions: none.
