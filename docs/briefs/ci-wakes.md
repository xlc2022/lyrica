# Brief: CI results wake the thread that opened the pull request

**Branch:** `feature/ci-wakes`. **Asked for:** by the user, 2026-10-13.
Not roadmap work; it waits behind the first real install like the rest
unless the user says otherwise.

**Serves:** principle 6 (trust her judgment; make review easy): she already
knows how to read a failing check and fix it (`extension/src/git.md`), but
nothing tells her when to look. Principle 7: the guarantee is one sentence,
"a pull request she opened wakes her thread when its checks finish", held by
`lyricad`, not by asking the model to remember a wake-up.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md ("Wake-ups",
"Routines"), docs/workspace.md ("Credentials", "Her own code"),
docs/contracts.md (threads and wake-ups), `daemon/src/wakeups.ts`,
`core/src/workspace/relay.ts`, `extension/src/git.md`.

## Problem

Today she waits on CI only by setting `threads later` herself
(docs/briefs/lyrica-project.md, "To wait on CI"). Nothing in the code
listens for check results: no webhook, no poller. If she forgets the
wake-up, or sets it too early, a red pull request sits until someone
notices.

## Change

1. **Who is watched.** When the relay forwards a successful
   `POST /repos/{owner}/{repo}/pulls` for a run (GitHub's API, which `gh pr
   create` uses), `lyricad` records a PR watch: the repository, the pull
   request number, and the thread the run belongs to. The relay passes on
   only those three facts, never the request or response body. A thread
   that opens a pull request by another route isn't watched; that's
   accepted.
2. **Where it lives.** A watch is stored in the thread's pool, like a
   wake-up, reached through `openThreadView`. Watches load at unlock and
   leave memory at Lock; a locked user's watches aren't polled, and are
   checked once at unlock.
3. **Polling, not webhooks.** `lyricad` sits on the tailnet, so GitHub
   can't reach it. Every 2 minutes, for each watch of an unlocked user, it
   asks GitHub's API, with the account token it already holds for that
   repository: the pull request (state, head commit), then that commit's
   check runs and combined status. It sends `If-None-Match` with the last
   ETag, so unchanged answers cost no rate limit.
4. **What wakes the thread.** Once every check on the head commit has
   finished, the thread gets one turn, marked like a wake-up, with a note
   `lyricad` writes: the pull request number, the commit's short hash, and
   each check's name and result (passed, failed, cancelled, timed out). No
   log text; she reads logs herself with `gh run view --log-failed`. One
   wake per head commit: a new push starts the wait again, a re-run on the
   same commit doesn't wake her twice. No checks reported 15 minutes after
   the head commit changed: one note saying so.
5. **When it stops.** The pull request is merged or closed, the thread is
   deleted, or the repository leaves the thread. Merged or closed ends the
   watch without a turn.
6. **Guards.** The wake-up guards hold: nothing while the project is
   paused, the at-once limit, and the 24-a-day cap per thread shared with
   wake-ups and routines. At most 10 watches per thread; an eleventh
   pull request isn't watched and her next turn there is told so once.
   A token the API refuses (401, 403, 404) ends the watch with one note
   saying the account's token can't read the checks.
7. **What the user sees.** Nothing new to set. The woken turn shows as a
   wake-up in the thread, as wake-ups do now. No new control, so nothing
   new in docs/ux.md.
8. **Her instructions.** `extension/src/git.md` drops "wait for CI" as a
   chore she must schedule: after opening a pull request she ends her turn
   and is woken when the checks finish. `threads later` stays for anything
   else.

Only GitHub this round. Forgejo/Gitea (`tea`) has a similar API and can
follow the same pattern later.

## Docs to update in the same PR

DESIGN.md (a "CI wakes" bullet next to "Wake-ups"), docs/contracts.md
(the watch store and the relay's new record), docs/workspace.md ("Her own
code": what wakes her), docs/briefs/lyrica-project.md (replace "To wait on
CI … she sets a wake-up" in the handoff and her instructions),
`extension/src/git.md`, and docs/briefs/repositories.md if its out-of-scope
line still reads as if nothing watches CI. The PR body says which.

## Tests

- A relayed `POST …/pulls` creates one watch for that run's thread; any
  other relayed request creates none, and nothing of the body is kept.
- All checks finished on the head commit gives one turn with the right
  note; still running gives none; a second poll of the same finished
  commit gives none; a new head commit waits again.
- Merged or closed ends the watch with no turn. A 403 ends it with one note.
- A paused project, a locked user and the daily cap hold the wake.
- Watches survive a restart and aren't polled while their user is locked.

GitHub's API is a local fake in tests; no network.

## Out of scope

Webhooks, review comments and review requests waking her (a natural next
step on the same watch), re-running jobs, auto-merge, Forgejo/Gitea, and
pull requests opened outside the relay.

## Build

Codex on lunasa through the Lunasa thread, one test run at a time.

## Handoff notes

(The building thread fills this in if it stops before it's done.)
