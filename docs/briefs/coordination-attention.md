# Brief: coordination attention, not a lock (#988)

**Branch:** `lyrica/coordination-attention`. **Built by:** the project thread.
**Read first:** AGENTS.md, PRINCIPLES.md (1, 2, 6), DESIGN.md "Question
cards", docs/contracts.md (Child threads, Question cards),
docs/delegation.md (a project's threads), docs/daemon.md (Question cards),
docs/briefs/question-card.md, docs/briefs/lyrica-project.md.

## Goal and smallest version

A builder that tells its project chat it is waiting on the person can still
be answered by that chat. Since #980, `needs_you` alone made a thread
unreachable: the coordinator's reply was saved without a turn, so the
builder asking "who should put this to the person?" got no answer, and the
coordinator couldn't even resolve the thread. The one authoritative
decision card a person answers stays exactly as protected as it is.

Smallest version, no schema, no new control:

- **Bare `needsYou` is attention/status.** A thread that only set the flag
  takes the project chat's message as a normal turn, and that message
  settles the flag, so its card stops saying *Waiting on you*.
- **A card is a lock.** An open question card (its own `threads ask`, or a
  root step) or a pending tool permission keeps #980's protections: another
  thread's message is held (`Delivery` `held`), another thread can't resolve
  the wait away, a parent's `threads stop` leaves the question open, and
  only the person's answer, words or Stop closes it.
- **Nothing is authorized by prose.** A "she approved" line in a message
  stays a message; the answer that releases a card is the tap or typed
  answer on it, through its own route.
- **Who asks whom is guidance, not machinery.** A builder that needs to
  know who presents a decision asks the project chat
  (`message({ to: "parent", question: true })`); the decision itself goes on
  its own card (`threads ask`), which the person answers from the project
  chat's thread card. No duplicate coordinator question, no relaying of
  approvals between threads.

Serves principles 1 (friction seen in use), 2 (the boundary stays the card,
enforced in the daemon, not in what a message says) and 6 (she can answer
her thread without the owner becoming a postbox).

## What it reuses

`child_threads.needs_you`, the `questions` pointer and its answer route,
`ThreadsHost.message`/`Delivery`, `HostedThread.appendParent` and the
existing project-card rendering. `waitsOnPerson` loses one term instead of
growing a new one; the clear is the shape that lived in `message` before
#980, kept behind the card check.

## Out of scope

Cross-thread answer transfers, a second question per thread, relaying an
approval into a card, push notifications, and #986's chat scroll. No `web/`
code changes: the states and cards a person sees are already documented in
docs/ux.md. What was added in `web/` is coverage (below), not a control.

## Checks and docs

Synthetic only: bare attention takes the coordinator's reply and clears
only that flag; a question card holds an agent's message and an agent's yes
can't close it; the person's answer through the answer route releases the
child; a pending permission still holds; a parent can resolve a
bare-attention thread and can't resolve one with a card open. Homes:
`daemon/test/child-wakes.test.ts` (units) and the project integration test
in `daemon/test/projects.test.ts`. `npm run typecheck`, `npm test` one
suite at a time, then the focused browser check at both widths
(`E2E_PROJECTS=phone-admin,desktop-admin npx playwright test
-c web/playwright.config.ts -g 'bare waiting status'`). Docs this makes
stale: `core/src/threads.ts` and `extension/src/threads.ts` guidance and held
text, DESIGN.md, docs/contracts.md, docs/daemon.md, docs/delegation.md,
docs/briefs/question-card.md, docs/briefs/lyrica-project.md, and this brief's
handoff note.

## Handoff

Done: `ChildThreads.waitsOnPerson` is the card and the permission only, and
`ChildThreads.message` clears a bare `needs_you` when the project chat
answers the thread (as it did before #980). Two details a reviewer will ask
about: a sibling thread's message reaches the thread but settles nothing,
since the project chat is the one that decides who asks; and a look's line
is sent as the project chat's message (`tellFromProject`), so it settles
the status too. Guidance in `core/src/threads.ts`, the `held` reply text in
`extension/src/threads.ts`, DESIGN.md, docs/contracts.md, docs/daemon.md,
docs/delegation.md and docs/briefs/lyrica-project.md say the same. Nothing
in `web/` changed: the states and cards are the ones already documented in
docs/ux.md.

Tests: bare attention takes the project chat's reply, clears only that flag
and lets the chat resolve the thread; a question card and a root step's card
hold an agent's message and refuse its resolve; a pending permission still
holds; the person's answer through `POST …/questions/:n/answer` releases the
child (`daemon/test/child-wakes.test.ts`, the project integration test in
`daemon/test/projects.test.ts`).

Browser: `web/e2e/web-admin.spec.ts`, "a project thread's bare waiting status
answers to its chat, while its card waits for the person", at 1280 and 390 px
against a real lyricad. It watches one project thread card live, no reload:
the bare status shows Waiting on you with its line, the project chat's reply
reaches the thread and settles it; then the thread's own card shows in the
project chat, the chat's prose is kept without a turn and the one card stays
pending, and a tap on it answers. It needs two fake-model directives in
`web/e2e/serve.ts`: `need: <text>` posts the bare status, and
`start need: <title>` starts a thread whose task does. Screenshots of the
waiting, settled, card-open and card-answered states at both widths were
read; overflow checks pass.

Next: exact-head review, then merge. Open: none; the scope is the owner's,
settled 2026-11-11 in #988.
