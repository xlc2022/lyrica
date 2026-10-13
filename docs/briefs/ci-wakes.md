# Brief: CI results and reviews wake the thread that opened the pull request

**Branch:** `feature/ci-wakes`. **Approved:** by the user, 2026-10-13, to
build now (ahead of the first real install).

**Serves:** principle 6 (trust her judgment; make review easy): she already
knows how to read a failing check and fix it (`extension/src/git.md`), but
nothing tells her when to look. Principle 7: the guarantee is one sentence,
"a pull request she opened wakes her thread when its checks finish or
someone reviews it", held by
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

1. **Who is watched.** When the relay forwards a successful pull request
   create for a run, `lyricad` records a PR watch: the repository, the pull
   request number, and the thread the run belongs to. The relay passes on
   only those three facts, never the request or response body. A thread
   that opens a pull request by another route isn't watched; that's
   accepted. The create is `POST /repos/{owner}/{repo}/pulls` on GitHub's
   API (`gh pr create`) and `POST /api/v1/repos/{owner}/{repo}/pulls` on
   Forgejo and Gitea (`tea pr create`), the paths the relay already
   recognises per forge kind.
2. **Where it lives.** A watch is stored in the thread's pool, like a
   wake-up, reached through `openThreadView`. Watches load at unlock and
   leave memory at Lock; a locked user's watches aren't polled, and are
   checked once at unlock.
3. **Polling, not webhooks.** `lyricad` sits on the tailnet, so a forge
   can't reach it. Every 2 minutes, for each watch of an unlocked user, it
   asks the forge's API, with the account token it already holds for that
   repository: the pull request (state, head commit), the head commit's
   checks, and the pull request's reviews and comments.
   - GitHub: the pull, the commit's check runs and combined status, the
     pull's reviews, review comments and issue comments. It sends
     `If-None-Match` with the last ETag, so unchanged answers cost no rate
     limit.
   - Forgejo and Gitea (same API under `/api/v1`): the pull, the commit's
     combined status (Actions and external CI both report there), the
     pull's reviews and the issue's comments.
   One module per forge turns those answers into one shape (pull state,
   head commit, checks with results, reviews and comments with author,
   kind and time), so the rest of the watcher doesn't know which forge it
   is.
4. **What wakes the thread.** Once every check on the head commit has
   finished, the thread gets one turn, marked like a wake-up, with a note
   `lyricad` writes: the pull request number, the commit's short hash, and
   each check's name and result (passed, failed, cancelled, timed out). No
   log text; she reads logs herself with `gh run view --log-failed`. One
   wake per head commit: a new push starts the wait again, a re-run on the
   same commit doesn't wake her twice. No checks reported 15 minutes after
   the head commit changed: one note saying so.
5. **Reviews wake her too.** A review (approved, changes requested,
   commented), a review comment or a comment on the pull request from
   anyone but her own account gives one turn. The note names who, what
   kind, and how many comments; not their text, which she reads with
   `gh pr view --comments` or `tea`. Everything new in one poll is one
   wake, and a check result and a review in the same poll share it.
6. **When it stops.** The pull request is merged or closed, the thread is
   deleted, or the repository leaves the thread. Merged or closed ends the
   watch without a turn.
7. **Guards.** The wake-up guards hold: nothing while the project is
   paused, the at-once limit, and the 24-a-day cap per thread shared with
   wake-ups and routines. At most 10 watches per thread; an eleventh
   pull request isn't watched and her next turn there is told so once.
   A token the API refuses (401, 403, 404) ends the watch with one note
   saying the account's token can't read the checks.
8. **What the user sees.** Nothing new to set. The woken turn shows as a
   wake-up in the thread, as wake-ups do now. No new control, so nothing
   new in docs/ux.md.
9. **Her instructions.** `extension/src/git.md` drops "wait for CI" as a
   chore she must schedule: after opening a pull request she ends her turn
   and is woken when the checks finish or a review comes in. `threads
   later` stays for anything else. A forge kind `other` isn't watched.

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
- A new review or comment from another account gives one turn; her own
  comments give none; a review and a finished check in one poll give one.
- The GitHub and Forgejo/Gitea modules turn recorded API answers into the
  same shape.
- Merged or closed ends the watch with no turn. A 403 ends it with one note.
- A paused project, a locked user and the daily cap hold the wake.
- Watches survive a restart and aren't polled while their user is locked.

Each forge's API is a local fake in tests; no network.

## Out of scope

Webhooks, review requests (someone asking her to review), re-running
jobs, auto-merge, forge kind `other`, and pull requests opened outside
the relay.

## Build

Two parts, run side by side (Qwen is on a separate machine from lunasa):

- **Part A, Qwen** (the user agreed, 2026-10-13): the two forge modules
  and the decide step, as pure functions with their own tests. Input is
  recorded API answers plus the watch's last state; output is the common
  shape and either nothing or the wake note. No I/O, no daemon wiring.
  Codex reviews it before it merges into the branch.
- **Part B, Codex** on lunasa: the relay record, the watch store, the
  poller, the wake through the wake-up path, `git.md` and every doc
  above. It codes against Part A's types, agreed first in a short
  `forge` types file committed before either part starts.

One test run at a time on lunasa, through the install thread's queue.

## Handoff notes

(The building thread fills this in if it stops before it's done.)
