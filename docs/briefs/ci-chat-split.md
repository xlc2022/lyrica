# Brief: the chat e2e spec in two files

**Status:** Merged as #872 (e652a9a6).

**Branch:** `claude/project-thread-5aac8y-chat`. **Asked for:** by the
operator, 2026-11-09, after [ci-nix-job.md](ci-nix-job.md) left the chat
e2e job and the check job as CI's two longest.

**Serves:** principle 8 (budgets): a pull request pays the e2e time on
every push.

## Problem

After #864 each e2e job runs one spec file, and a spec's tests run one
after another against one lyricad, so a spec's own length is its job's
floor. `web-chat.spec.ts` held 60 tests, 3.4 minutes in Playwright at
each size on the hosted runner, and its job took 5 min 23 s, about two of
them setting the runner up; the other two specs took 3:51 and 2:52.

## Change

`web-chat.spec.ts` is two files of about equal length, measured test by
test on 2026-11-09:

- `web-chat.spec.ts` keeps the first 31 tests: a thread's messages and
  cards, tool runs, child threads, models and modes, skills, portraits,
  uploads.
- `web-workspace.spec.ts` takes the other 29, in their old order: the
  composer and header, search, memory, settings, accounts, machines and
  users, project threads and subagents, sources and pictures.

Every test enters on its own (`enter()` unlocks and logs in as needed),
so the cut needs no setup moved; the few tests that expect an empty page
("Machines lists none", "Git accounts lists none") keep the tests that
fill it after them. The cut falls on time, not on topic: the same split
by topic would leave the halves 2:1.

`playwright.config.ts` lists the new spec, so it gets its own lyricad at
each size (ports 17341 to 17349 now), and the e2e job's matrix gains
`workspace`. Expected: the e2e jobs at about 3:45 each, and the run bounded
by the check job (about 5:30).

Out of scope: splitting the check job's unit tests, the next lever.

## Docs

docs/ci.md, docs/web.md, AGENTS.md (the projects a spec runs in),
web/playwright.config.ts and web/e2e/helpers.ts comments.

## Handoff

Done: the split, the matrix, the docs; merged 2026-11-09. Measured on
main's first run with this and #875 (b4a94032): `e2e (chat)` 3:27,
`e2e (workspace)` 3:01, where the one chat job took 5:23; on the PR's
run, 3:33 and 2:58. The PR needed one re-run of `e2e (projects)`, which
failed on the phone test at `web-projects.spec.ts:427` (a sidebar scrim
intercepting a click after "Hide threads"), in a spec this change did not
touch. Open questions: none.
