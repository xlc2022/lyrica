# Handoff: the PR review thread

**Status:** Handoff note for a fresh PR review session (AGENTS.md, PR
review restarts past about 100k tokens). Rewritten 2026-10-19 11:05Z at main
0c16f6e. Session ids and routine ids live in the project's team memory,
not here.

## The role

AGENTS.md, Workflow, is the rule; read it first. In short:

- Review each pull request that needs it (AGENTS.md, Review and merge,
  step 1, as narrowed by #347): the daemon, `core/`, `host/` and install,
  `nix/`, `extension/`, `persona/`, migrations, CI, security and the cloud
  boundary, anything touching PRINCIPLES, DESIGN, the contracts or
  docs/ux.md, and every pull request from her account. Docs-only and small
  `web/`-only pull requests no longer need it.
- Say **verified** with the full commit SHA only when the PR meets its
  brief, AGENTS.md and the docs; otherwise send findings. Reply to the
  thread that asked, in the same turn, with send_message.
- Own PRINCIPLES.md, DESIGN.md, docs/contracts.md and docs/ux.md; record
  settled decisions in docs PRs.
- The routine "Lyrica GitHub pickup" fires into this thread every 2 h at
  :46. It lists open PRs on `lyrica/*` branches and open issues labelled
  `claude`, skips items with a "Picked up by Claude's project" comment,
  reviews new PRs (never merges `[dry run]` ones), sends new issues to the
  coordinator, and comments "Picked up by Claude's project" with the
  footer. With nothing new it posts nothing.

## How reviews were done

- `git fetch -q origin main '+refs/pull/N/head:refs/remotes/pr/N'`, then
  `git diff origin/main...pr/N`; a new head is checked as
  `git diff <old head> pr/N`, and a merge of main with
  `git show --remerge-diff pr/N` (empty means no conflict resolved).
- Tests: check out detached, `npm run -s typecheck`, then the touched test
  files one at a time with `npx vitest run <file>` (one suite at a time,
  AGENTS.md, Checks). Return to the thread's branch after.
- The weekly contracts and UX drift check can go to a Sonnet worker for
  the comparison; check each finding against the code before acting. The
  local clone is shallow, so fetch with enough depth to cover the week.
- If a PR commits a `node_modules` symlink, a checkout replaces the real
  one; test from a `git worktree` in the sc## State at handoff

Nothing is waiting on this thread. Verified today and merged by their
threads: #352 (code mode), #355, #359, #360, #361, #362, #364, #365 and
#367. #357 (host Update in the contracts, web and daemon docs) came from
the 10-19 drift check and merged here. Open at handoff: #366 (question
card, web-side, Live sync thread), not sent here for review.

Schema steps: user.db's next step is 15, pool.db's next is 10 and
self.db's next is 4 (#352 took user 14 and pool 9).

Patterns worth checking on every agent-loop PR, from today's findings:

- A value Pi reads once when a session opens (compaction settings, model
  windows) goes stale when something changes mid-thread; #362 needed its
  compaction reserve read from the live model.
- A default window or reply cap that grows can push `max_tokens` past
  what a server serves; #365 needed vLLM's `max_model_len` read.
- Always-on prompt lines count against the window-edge budget: run
  daemon/test/context.test.ts whenever guidance text changes.

## Known open points

- #343's LM Studio REST shapes were checked against a fake; a real
  reload check passed on the test machine on 10-19, but whether a load
  with only `context_length` keeps LM Studio's other saved load settings
  is still unchecked.
- #359: a change to general's page about the user wakes a full private
  sleep run even with no private activity. Accepted for now; the owner
  was told. If it proves noisy, run only consolidation for that reason.
- E2E flakes on main: treat a red e2e on a PR that doesn't touch the web
  as evidence to check, not a blocker by itself. #364 split web.spec.ts
  into web-admin, web-chat and web-projects specs, so old line numbers no
  longer apply.
