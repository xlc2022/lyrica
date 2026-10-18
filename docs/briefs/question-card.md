# Brief: Question card

**Status:** Merged as #322 (bc2f89b). Handoff notes below are history.

**Branch:** `feature/question-card`. **Built by:** Codex on the test machine.
**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md, docs/delegation.md
(child threads, projects, States), docs/contracts.md (Child threads,
Notifications), docs/ux.md (§ Anything in the conversation waiting for an
answer, Anything waiting for the user, A thread of a project), docs/web.md.

## Goal

When a thread needs the user, it asks one question with two to four options
and one recommended. The user answers with one tap, in the chat, on the
project chat's card for that thread, or in Notifications, and doesn't have to
read the thread back to know what is being asked. This is roadmap item 2.
Principle 6, because the user is away most of the time, and principle 1,
because the answer is an ordinary message in her memory. Push (item 3) comes
later and will fire on these.

## In scope

**A. The tool action.** Add `ask` to the `threads` tool:

```ts
ask({ question, options: { label, consequence }[], recommended, context? })
```

- `question` is 1 to 300 characters. `context` is optional, up to 1200.
- `options` holds 2 to 4 entries. Each `label` is 1 to 40 characters and
  each `consequence` 1 to 200. Labels are unique, compared ignoring case.
- `recommended` is the index of one option.
- Put the limits in an exported `ASK_LIMITS` and check them in a pure
  `cleanAsk` that refuses bad input with a plain error. The guard is
  structural and does not depend on the model.
- `paramsFor` offers `ask` in every hosted thread except an ordinary child
  thread, which keeps asking its parent with `message({ question: true })`.
  Subagents don't get the `threads` tool at all.
- The result says the question is on a card. It then says what E says: carry
  on with the recommended option if that step can be undone, and otherwise
  end the turn. The answer arrives in a later turn.
- Principle 8: `ask`'s fields and description stay to one short line each.
  The size ceilings in `extension/test/threads.test.ts` are raised only as
  far as needed, and the PR names the new numbers.
- Routine and wake-up turns run in the thread itself, so they may ask too.

**B. State.** The thread is waiting on the user while its question is open.

- In a project's thread this is today's `needsYou`, so the state, the parent
  card, the pending bar and the parent wake all work as they already do.
  `ask` replaces `message({ to: "parent", needsYou: true })` as the way to
  ask the user. `needsYou` stays as it is.
- In any other thread, `ThreadSummary.question` is set, and the sidebar
  shows Waiting on you.
- A thread has at most one open question. A new `ask` withdraws the open
  one, and so do resolving or stopping the thread. Its card reads
  **Withdrawn**.
- A tap, a typed answer and a withdrawal each close the question and set
  `needs_you` to 0 in the same transaction. The parent card, the sidebar
  and Notifications then stop showing Waiting on you at once, without
  waiting for her next message. Today `needs_you` changes only on the
  child's next message, or on resolve or reopen.
- Store a pointer only: the thread, the entry number of the tool call, the
  time asked, and when it closes, the chosen index or "words" or
  "withdrawn". This is a new pool.db step, `questions`. The text stays only
  in the thread's encrypted log, which `notifications` and the card read
  through the existing thread reader. Nothing in plain text, and no text in
  the table. If main has taken the next pool step before this merges,
  renumber.

**C. Answering.**

- `POST …/threads/:pool/:id/questions/:n/answer { option }` posts the user's
  message `<label>`. It carries a reply mark, `[Answer to q:<n>]`, so she
  knows which question it answers. The message starts a turn as any user
  message does.
- The mark is `ANSWER` in `core/src/threads.ts`, next to `FROM_PARENT` and
  `WATCHING`, and is guarded the same way. A typed or API message that
  starts with it is refused with 400 in `daemon/src/routes.ts` and by
  `MarkedText` in `daemon/src/hosted.ts`. Only lyricad writes it.
- The route answers 404 for an unknown question, or one in another thread.
- Any message the user types in the thread while the question is open
  closes it as "words". The text goes through unchanged.
- An answered, word-answered or withdrawn question refuses a tap with 409.

**D. Where it shows.** Follow docs/ux.md; add the rows below to it.

- **In the conversation:** a card, as for other things waiting for an
  answer. Its title is the question and the context is muted under it. Each
  option is a button with its consequence as a line beneath. The recommended
  option is the one primary and is marked "Recommended". On a phone the
  buttons stack full width at `--tap` height.
  - Answered: the card collapses to the question and the chosen label, with
    a check.
  - Answered in words: "Answered in words."
  - Withdrawn: "Withdrawn."
  - The pending bar covers an open question.
- **In the project chat's thread card:** "Waiting on you" with the question
  as what it waits on, and the option buttons at its foot. A tap answers
  without leaving the project chat.
- **In Notifications:** a new type, `question`, counted under Needs a
  decision. Its title is the question and its detail the recommended
  option's consequence. Its actions are the option buttons, with the
  recommended one first, plus Open thread. The bulk bar offers nothing for
  questions, because two questions never share options. A private thread's
  question shows under Where = Private, as other decisions do.

**E. Guidance.** Add a few lines to the thread guidelines:

- Ask only for a fork that changes the user's goal, an output they will
  notice, or a step no one can undo.
- Ask once, on the card, and don't repeat the question in prose.
- Put the recommended option first.
- Keep working on the recommended option where the step can be undone, and
  stop where it can't.

**F. Contracts.** Pin these shapes in docs/contracts.md:

- `ThreadSummary.question?: { n: number; asked: string }`: the entry number
  of the open question's tool call and the time it was asked. The card and
  Notifications read the text from the log.
- `NotificationType` gains `question`. Its id is `question:<pool>/<thread>/<n>`
  and `decision` is true. Its actions are one `POST …/questions/:n/answer`
  per option, with `{ option }`, then Open thread.
- `POST /api/u/:userId/threads/:pool/:id/questions/:n/answer { option }`
  answers 204, 404 for an unknown question, 409 once it is closed, and 400
  for an option out of range.
- The `ANSWER` mark, and `Message.from.kind` stays `user`.
- The `threads` `ask` action and `ASK_LIMITS`.

## Out of scope

- Push notifications (item 3).
- A free-text field on the card, since typing in the thread already answers.
- More than one open question per thread.
- Questions from subagents.

## Done when

- `cleanAsk` refuses each limit, and accepts 2 and 4 options.
- A project's thread that asks shows Waiting on you on its parent card,
  wakes the project chat once, and appears in Notifications. A tap there
  answers it, and the thread wakes with `<label>` and the mark.
- In a plain chat: ask, then a typed answer closes the question as "words".
  Ask twice and the first card reads Withdrawn.
- A second tap on an answered question gets 409. A typed message starting
  with `[Answer to q:` gets 400.
- Resolving a thread withdraws its question, and the parent card drops
  Waiting on you at once.
- The pool migration has a test from every released pool schema and keeps
  older readers working.
- Playwright on desktop and phone covers the card, a tap, the collapsed
  state and Notifications.
- docs/delegation.md, contracts, daemon, web and ux.md, plus this brief's
  handoff note, are updated in the same PR.

## Handoff notes

Run 1 (`1515302`) built the tool, encrypted question pointers (pool step 8),
answer route and marker guards, notifications and core/daemon coverage.
Run 2 (`2f84679`) built conversation and project cards, sidebar/pending state,
Notifications actions and web unit coverage, with contracts, UX and web docs.
Main is merged at `c17203a`; model configuration uses presets and columns,
including the Backend card, with no model-profile routes introduced here.
No user.db migration was added by this feature.

Run 3 completes e2e fixtures and browser coverage, DESIGN, delegation,
daemon and web documentation, and this handoff. Principles 1 and 6 remain
the reason for the change. The existing controls follow UX §6’s question,
project-thread and Notifications rows; §3’s option-button exception and §8’s
phone targets apply. No new production control was added in run 3. The
`threads` definition ceilings are 3900 plain, 2900 ordinary child, 4650
project chat and 3600 project thread (serialized characters, strict upper
bounds), with no additional model-facing tool.

Validation: build and typecheck pass. The locked focused Vitest run passed
44 tests across core questions and migrations, daemon questions, extension
threads, web questions and welcome cards. All six browser checks pass at
both widths. They exercise real
lyricad and only local fake model endpoints: taps in chat, Notifications and
project cards; collapsed cards across reload; typed answers; one project
wake; replacement and Resolve; duplicate-answer 409 and forged-marker 400;
and private Notifications without bulk answers. Screenshots in ignored
`shots/` show open, answered, Notifications and project-card states at 1280
and 390 px; overflow checks and phone button measurements pass.

Local execution uses UNTRACKED `web/playwright.local.config.ts`, ports
7351–7353 and the supplied Chromium executable. Never commit that file or
`shots/`. Run browser coverage from `web/` with
`SCREENSHOTS=../shots flock /tmp/lyrica-tests.lock npx playwright test -c playwright.local.config.ts -g 'question cards|private question Notifications' --project=phone --project=desktop`.

Merged as #322 after review fixes: only Stop and Resolve withdraw a
question, and `needs_you` moves only when a question opens or closes.
Push notifications, card free-text inputs, multiple open questions and
subagent questions remain out of scope. No open design questions.
