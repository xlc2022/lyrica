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
3. **Polling.** `lyricad` sits on the tailnet, so a public forge can't
   reach it, and GitHub is polled (a forge on the tailnet also gets
   webhooks, step 4). Every 2 minutes, for each watch of an unlocked user, it
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
   Staying inside rate limits: one request at a time per token; honour
   `Retry-After` and, on GitHub, `x-ratelimit-reset`; poll every 10
   minutes instead of 2 while fewer than a fifth of the token's hourly
   requests remain; never retry a refused request sooner than the forge
   says.
4. **Webhooks from a forge on a private network.** A Forgejo or Gitea
   account's host can be any name (the operator's own domain pointing at
   tailnet addresses is fine). Its webhook is offered when that name
   resolves to a private address: 10/8, 172.16/12, 192.168/16, the
   tailnet's 100.64/10, or fd00::/8 (with loopback and RFC 1918, as
   inOwnNetwork). It's resolved again at each use, and
   a name that now resolves publicly loses the Webhook row and falls back
   to polling. The forge sends webhooks to `POST /hooks/forge/{account}`
   on the listener `tailscale serve` already fronts, so the forge's
   machine must be on the tailnet; nothing becomes public, and "never
   funnel" stands.
   - Forgejo and Gitea refuse webhooks to private addresses by default.
     The operator adds `lyricad`'s tailnet name or `100.64.0.0/10` to
     `[webhook] ALLOWED_HOST_LIST` in the forge's `app.ini`; the guide
     says so.
   - Each Forgejo or Gitea Git account gets a random webhook secret,
     stored like its token. A request must carry a valid
     `X-Forgejo-Signature` or `X-Gitea-Signature` (HMAC-SHA256 of the
     body, compared in constant time); anything else gets 401 and does
     nothing.
   - A webhook is only a nudge: a signed one polls that repository's
     watches at once. Its body is read for the repository name and then
     dropped, never stored or logged, so a forged or replayed hook can
     at worst cause one extra poll.
   - Polling stays as the fallback. A repository whose webhook arrived
     in the last 24 hours is polled every 10 minutes instead of 2.
   - Setup is the operator's, once per repository, in the forge's own
     settings: the URL and secret, events pull request, pull request
     review, pull request comment and status. Her token can't add
     webhooks.
5. **What wakes the thread.** Once every check on the head commit has
   finished, the thread gets one turn, marked like a wake-up, with a note
   `lyricad` writes: the pull request number, the commit's short hash, and
   each check's name and result (passed, failed, cancelled, timed out). No
   log text; she reads logs herself with `gh run view --log-failed`. One
   wake per head commit: a new push starts the wait again, a re-run on the
   same commit doesn't wake her twice. No checks reported 15 minutes after
   the head commit changed: one note saying so.
6. **Reviews wake her too.** A review (approved, changes requested,
   commented), a review comment or a comment on the pull request from
   anyone but her own account gives one turn. The note names who, what
   kind, and how many comments; not their text, which she reads with
   `gh pr view --comments` or `tea`. Everything new in one poll is one
   wake, and a check result and a review in the same poll share it.
7. **When it stops.** The pull request is merged or closed, the thread is
   deleted, or the repository leaves the thread. Merged or closed ends the
   watch without a turn.
8. **Guards.** The wake-up guards hold: nothing while the project is
   paused, the at-once limit, and the 24-a-day cap per thread shared with
   wake-ups and routines. At most 10 watches per thread; an eleventh
   pull request isn't watched and her next turn there is told so once.
   A token the API refuses (401, 403, 404) ends the watch with one note
   saying the account's token can't read the checks.
9. **What the user sees.** The woken turn shows as a wake-up in the
   thread, as wake-ups do now. One new place: a Forgejo or Gitea
   account's drawer in Settings → Git accounts shows **Webhook**, the URL
   and the secret, read-only with copy. It needs a row in docs/ux.md and
   UI review.
10. **Her instructions.** `extension/src/git.md` drops "wait for CI" as a
   chore she must schedule: after opening a pull request she ends her turn
   and is woken when the checks finish or a review comes in. `threads
   later` stays for anything else. A forge kind `other` isn't watched.

## Docs to update in the same PR

DESIGN.md (a "CI wakes" bullet next to "Wake-ups"), docs/contracts.md
(the watch store and the relay's new record), docs/workspace.md ("Her own
code": what wakes her), docs/briefs/lyrica-project.md (replace "To wait on
CI … she sets a wake-up" in the handoff and her instructions),
`extension/src/git.md`, and docs/briefs/repositories.md if its out-of-scope
line still reads as if nothing watches CI, docs/ux.md (the Webhook row),
docs/daemon.md (the hooks route), and the operator guide on Git accounts
for adding the webhook (tell Operator docs). The PR body says which.

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
- A Forgejo/Gitea host resolving to each private range gets the Webhook
  row; one resolving to a public address doesn't, and polls.
- A correctly signed webhook polls that repository at once; a missing or
  wrong signature gets 401 and polls nothing; the body isn't kept.
- A 429 or `Retry-After` delays the next request as the forge says;
  low remaining requests slow polling to 10 minutes.
- Merged or closed ends the watch with no turn. A 403 ends it with one note.
- A paused project, a locked user and the daily cap hold the wake.
- Watches survive a restart and aren't polled while their user is locked.

Each forge's API is a local fake in tests; no network.

## Out of scope

Webhooks from GitHub or any forge off the tailnet (Funnel, tunnels,
`gh webhook forward`), review requests (someone asking her to review), re-running
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
  poller, the webhook route and secret, the account drawer row, the wake through the wake-up path, `git.md` and every doc
  above. It codes against Part A's types, agreed first in a short
  `forge` types file committed before either part starts.

One test run at a time on lunasa, through the install thread's queue.

## Handoff notes

2026-10-13, Codex on lunasa — Part B is built and its tests are green.
Nothing is committed or pushed; the user will.

What landed:

- `daemon/src/forge-watch.ts`: the poller. The relay record
  (`Workspace.onPullCreate` → `ForgeWatcher.record`) stores a watch in the
  thread's pool (pool step 7, `WATCHES_SCHEMA`); lyricad's tick polls each
  unlocked user's due watches through `core/models`-only forge fetch, joins
  the pages into a snapshot, runs Part A's `decideWatch`, and hands the note to
  the wake-up path via `settleWatch` + `wakeups.wake`. One request at a time
  per token (`enqueue`), Retry-After and `x-ratelimit-reset` honoured, and
  ten-minute polling once a token is low or the repo is webhooked.
- The webhook: signed `POST /hooks/forge/{account}` on the tailscale-serve
  listener only (404 off the tailnet), HMAC-SHA256 with
  `timingSafeEqual`, one secret per Git account (`webhook_secret` in user
  step 7), and a `webhook` nudge that triggers an immediate poll and eases
  the watch to ten minutes. The account drawer gains the Webhook row
  (docs/ux.md row written), and `git.md` covers it.
- Part A was reviewed against `core/src/forge/types.ts` and the brief and
  needed no changes: its three flagged behaviours (unknown check states
  throw, Gitea `warning` maps to failed, rate-limit back-off left to Part B)
  are all intentional and covered by its tests. The poller treats module
  throws as transient and does the back-off itself.

One real bug found and fixed in Part B: `noteRate` clobbered
`remaining`/`limit`/`resetAt` to 0 when a response carried no
`x-ratelimit-*` header, because `Number(null) === 0`. It now only overwrites
on present, finite headers; a missing header says nothing.

Test results (fakes only, no network, no real names; `--pool=forks
--maxWorkers=2`, one batch at a time):

- `daemon/test/forge-watch.test.ts` — 15 passed.
- `core/test/forge-github.test.ts`, `forge-forgejo.test.ts`,
  `forge-decide.test.ts`, `relay.test.ts`, `store.test.ts`,
  `migrations.test.ts` — 67 passed (Part A's tests plus the touched core
  tests).
- `core/test/forge.test.ts`, `core/test/workspace.test.ts`,
  `core/test/settings.test.ts`, `daemon/test/wakeups.test.ts`,
  `daemon/test/routines.test.ts` — 52 passed, 4 skipped.
- `npm run typecheck` — clean.
