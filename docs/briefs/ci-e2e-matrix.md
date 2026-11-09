# Brief: one e2e job per spec file

**Status:** Merged as #864 (e9be3641).

**Branch:** `claude/project-thread-5aac8y-e2e`. **Asked for:** by the
operator, 2026-11-09, after the split in
[ci-split-check.md](ci-split-check.md) left Playwright as CI's critical path.

**Serves:** principle 8 (budgets): a pull request pays the e2e time on
every push.

## Problem

After #833 the `e2e` job took 9.5 minutes: 255 tests, seven Playwright
projects on one 4-core runner, 8.6 minutes in Playwright itself. A spec's
tests run one after another against one lyricad, so the chat spec's 8.1
minutes (at each size) was the floor, and seven browsers on four cores
stretched every spec.

## Change

`e2e` is a matrix over the spec files: `e2e (chat)`, `e2e (projects)` and
`e2e (admin)`, each running its phone and desktop projects; the setup page
rides with `projects`, the shortest. `web/playwright.config.ts` reads
`E2E_PROJECTS` (comma-separated project names) and keeps only those
projects and their lyricads, so a job starts two servers, not seven; an
unknown name fails at once. The same variable serves a developer running
one project, where `--project` alone still started all seven. Each job's
trace artifact is `e2e-traces-<spec>-<attempt>`.

Out of scope: splitting `web-chat.spec.ts` into two files, which is the
only way below the chat spec's own length; and splitting the unit tests,
which saves nothing while e2e is the longer job.

## Docs

docs/ci.md, AGENTS.md (running one e2e test), docs/web.md.

## Handoff

Done: the matrix, the config variable, the docs, merged. The PR's own run
took 6 min 34 s from start to end (was 9 min 43 s after #833): e2e chat
5 min 23 s, admin 3 min 51 s, projects 2 min 52 s, check 4 min 40 s, nix
6 min 23 s. The nix job is now the longest, and most of its time is
restoring the Nix store cache (1 to 6 minutes across runs), so the chat
spec needs no split until that is shorter. Open questions: none.
