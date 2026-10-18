# Brief: Push notifications

**Status:** Built in three runs; ready for review and the operator’s full-suite run.

**Branch:** `feature/push`. **Built by:** Codex on the test machine.
**Read first:** AGENTS.md, PRINCIPLES.md (2, 8, 10), DESIGN.md (Settings,
Notifications), docs/contracts.md (Notifications), docs/daemon.md,
docs/ux.md (Settings, Anything waiting for the user), and
docs/briefs/question-card.md.

## Goal

The user's phone buzzes when something waits on them: a question card, a
permission or approval, a share, a persona change to approve. It buzzes
only then. They are away most of the time, and the Notifications page only
helps once they open it. This is roadmap item 3, and its first step is a
webhook, as the roadmap says. Web Push comes later, once installs serve
HTTPS.

- Principle 6: the user decides, so the ask has to reach them.
- Principle 2: the push leaves the server, so it carries no words from
  memory or threads.
- Principle 8: one small module in lyricad, with no new process and no new
  dependency.

## In scope

**A. What fires.** A push fires for a new item on the user's Notifications
page with `decision && type !== "sleep"`, and for nothing else. Today those
are questions, permissions, shares, persona suggestions, persona changes
waiting for an administrator's approval, and a project thread's Waiting on
you. Items from the night are marked `decision: true` too
(daemon/src/notifications.ts), but they are not an ask the user is
blocking, so they are excluded by type.

- The rule is structural: lyricad diffs each unlocked user's decision ids
  against the ids it has already pushed. A new type with `decision: true`
  is covered without a code change.
- The diff runs on lyricad's existing tick and also right after the events
  that make decisions: a question asked, a permission request, a share. Use
  whichever hook exists, but the tick must catch everything on its own.
- Items that appear within one 30-second window go out as one push.
- Pushes are at most one a minute per user. Items held back by that limit
  join the next push.
- An item is pushed once. Pushed ids live in user.db
  (`push_sent (id, at)`), so a restart doesn't push them again. Prune rows
  after 30 days, and prune ids no longer on the page. An item that clears
  and comes back with the same id (a thread waits, the user answers, it
  waits again) therefore pushes again. That is intended: it is a new ask.
- A locked server can't read the page, so nothing pushes while it is
  locked. On unlock, it pushes what is new since, as one push, by the same
  rule as below.
- **First enable.** When the user saves a URL (and on unlock), decisions
  already waiting and not in `push_sent` go out as one push, by the usual
  phrases, and are then recorded. A user who just turned push on gets one
  ping that shows it works.
- Hidden threads, and pools the display has off, are left out, exactly as
  the page leaves them out. Reuse `notifications()`.

**B. The payload.** Only fixed phrases and counts, never text from memory or
threads. That means no question, no thread title, no pool name and no
detail.

- Title "Lyrica". Body for one item, keyed by `NotificationType` in one
  exported table `PUSH_PHRASES`:

  | Type | Body |
  | --- | --- |
  | `question` | "A question is waiting." |
  | `permission` | "A permission is waiting." |
  | `share` | "A share is waiting." |
  | `suggestion` | "A suggested persona change is waiting." |
  | `approval` | "A persona change waits for approval." |
  | `update` (Waiting on you) | "A thread is waiting on you." |
  | any other type | "Something is waiting." |

  For more than one item: "<n> things are waiting."
- The format is ntfy's: a plain-text body with `Title`, `Click` and `Tags`
  headers. Any receiver that accepts a plain-text POST works.
- `Click` is off by default, because a link tells the receiver (ntfy.sh
  is a third party) the install's address. A checkbox **Include a link**
  turns it on. The link is the address the user saved the setting from
  (`location.origin` when they press Save) plus the fixed path
  `/notifications`, never the user id. Add that route to the web app: it
  redirects to the signed-in user's Notifications page, or to sign-in.
- An optional token is sent as `Authorization: Bearer <token>`, for a
  private ntfy server or a self-hosted receiver.
- The request goes out from lyricad with a 10-second timeout, over HTTPS
  only. Plain `http:` is allowed only for a host on the operator's own
  network, by `resolveHost`/`inOwnNetwork` in core/src/workspace/index.ts
  (export what's needed; don't copy it), and only for administrators. A
  non-admin user on a multi-user install may use only HTTPS to a public
  host.
- For http and https alike, refuse loopback, link-local and lyricad's own
  listen addresses, so a push can't reach a host API or lyricad itself.
- Check at Save and resolve again at every send, since DNS can change in
  between. A send whose host now fails the check counts as a failure.
- It is retried twice, with backoff. Failures log the status code and
  host, never the URL's path, since an ntfy topic in the path acts as a
  secret.

**C. Settings.** A new section, **Push**, after Appearance in Settings. Add
its row to docs/ux.md.

- **URL**, for example `https://ntfy.sh/<topic>`, and **Token** (optional,
  masked) are stored in the encrypted user.db `settings`. Neither is ever
  returned in full after saving: the URL shows its host and a masked path,
  and the token shows as set.
- **Send a test** sends "Test from Lyrica." and shows the result inline as
  Sent, or the status code and reason.
- **Turn off** clears the URL and token.
- **Include a link**, off by default, as in B.
- The line "Pushes say only that something waits, never what. A link
  shows the receiver this server's address." sits as the section's tooltip and its visually hidden description, per ux.md.
- The status line shows the last failure: "Last push failed at 14:02:
  403", with the time in mono. A success clears it.

**D. Contracts.** Pin these in docs/contracts.md:

- `GET/PUT/DELETE /api/u/:userId/push`. The body is `{ url, token?, link:
  boolean, origin }`. GET returns `{ host, path (masked), set: boolean,
  token: boolean, link: boolean, lastFailure?: { at, status } }`.
- `PUSH_PHRASES` (B), and the `/notifications` web route.
- `POST …/push/test` returns 204, or 502 with `{ status, reason }`.
- `PushSettings` and `PUSH_LIMITS`: window 30 s, minimum gap 60 s,
  timeout 10 s, 2 retries.
- The user.db step that adds `push_sent`. Take the next free step, and
  renumber if main takes it first.

## Out of scope

- Web Push and service workers, which wait for HTTPS installs.
- Email, and quiet hours.
- Choosing per type what pushes.
- Pushes for non-decision items: progress, sleep notes and finished
  downloads.
- Any message text in a push, ever.

## Done when

- The payload test fails if any text from a thread, question or title
  appears in a push. Check it against a fixture question whose words are
  unique.
- A new question pushes once. A restart doesn't push it again. Two
  questions within the window go as one push, "2 things are waiting.".
- A hidden thread's question doesn't push, and neither do items from the
  night.
- Every type in `PUSH_PHRASES` has a test, and an unknown type gets
  "Something is waiting.".
- Saving a URL with two decisions waiting sends one push, "2 things are
  waiting.", and nothing more for them.
- No `Click` header unless Include a link is on, and then it ends in
  `/notifications` with no user id.
- A locked server sends nothing. After unlock it sends what is new.
- `http:` to a public host is refused at Save, and so is `http:` from a
  non-admin. Loopback and link-local are refused for both schemes, at
  Save and again at send. The token is never returned by GET.
- Send a test works against a fake receiver, and a failing receiver shows
  Last push failed.
- The migration has a test from every released user schema.
- Playwright covers the Push section at 1280 and 390 px: save, test, the
  failure line and turn off.
- docs/contracts.md, daemon.md, web.md, ux.md and DESIGN (Settings) are
  updated in the same PR. Tell Operator docs to add an ntfy set-up note
  after the merge.

## Handoff notes

Run 1 (`19b7926`) built core storage, sender, decision diff, routes, landing
redirect, core/daemon tests and contracts. Main merged at `ef31914`; run 2
(`b3e2ee8`) built Settings → Push and web unit tests, updating UX and web
docs. Run 3 adds the browser check at 1280 and 390 px, DESIGN Settings and
daemon documentation, web test documentation and this handoff. Principles
6, 2 and 8 are the reason for the feature. No production controls or model
tools were added in run 3. Existing controls follow UX §6’s Push row,
§3’s button styles, §4’s tooltip explanation, §7’s form and §8’s phone rules.

Main’s named presets and columns are retained: Images uses current model
configuration and the welcome Backend card has preset coverage. No model
profile API is introduced. `push_sent` is user.db step 11, after project
drafts (9) and usage totals (10), with migration coverage from every prior
released user schema.

Validation: build, typecheck and diff whitespace checks pass. Under the
shared `/tmp/lyrica-tests.lock`, the focused core/daemon/web push and welcome
card run passes 22 tests across four files. The two Playwright Push checks
pass (phone and desktop): Save captures origin, masks credentials and clears
inputs; reload keeps the saved view; a local fake receiver accepts a test,
then refuses it with 403; the failure line appears with a mono time; success
clears it; Turn off persists across reload. Phone action targets reach 44 px
and neither width overflows. The browser test intercepts the Push API
contract, forwarding test POSTs only to a loopback fake receiver; real daemon
routes, encrypted persistence, privacy, DNS validation and restart behavior
are exercised by `daemon/test/push.test.ts`, rather than bypassing production
loopback restrictions. No real push service, paid API, plan endpoint or
LM Studio was called. The full suite is left to the operator as requested.

Screenshots were saved and visually checked at
`shots/push-settings-1280.png` and `shots/push-settings-390.png`; both show
the Push section and failure line. `shots/` is ignored and untracked.
UNTRACKED `web/playwright.local.config.ts` uses ports 7351–7353 and the
supplied sandbox Chromium executable. Never commit it or the screenshots.
Reproduce from `web/` after building:
`SCREENSHOTS=../shots flock /tmp/lyrica-tests.lock npx playwright test -c playwright.local.config.ts -g 'Push settings:' --project=phone --project=desktop`.

Next: the operator runs the full suite, commits and pushes; PR review and
UI review verify the head, then CI and merge follow the normal workflow.
After merge, tell Operator docs to add an ntfy setup note: Settings → Push,
URL and optional token, Send a test, opt-in link revealing the install origin,
and destination restrictions described in docs/daemon.md and contracts.md.
This is a pending handoff, not a message already delivered. Web Push, email,
quiet hours and per-type choices remain out of scope. No open design questions.
