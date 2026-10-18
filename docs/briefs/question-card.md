# Brief: Question card

**Status:** Approved to build; not started.

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
- The result tells her the question is on a card and to end her turn there.
  She carries on only once a later turn brings the answer.

**B. State.** The thread is waiting on the user while its question is open.

- In a project's thread this is today's `needsYou`, so the state, the parent
  card, the pending bar and the parent wake all work as they already do.
  `ask` replaces `message({ to: "parent", needsYou: true })` as the way to
  ask the user. `needsYou` stays as it is.
- In any other thread, `ThreadSummary.question` is set, and the sidebar
  shows Waiting on you.
- A thread has at most one open question. A new `ask` withdraws the open one,
  and its card reads **Withdrawn**.
- Store a pointer only: the thread, the entry number of the tool call, the
  time asked, and when it closes, the chosen index or "words" or
  "withdrawn". This is a new pool.db step, `questions`. The text stays only
  in the thread's encrypted log, which `notifications` and the card read
  through the existing thread reader. Nothing in plain text, and no text in
  the table. If main has taken the next pool step before this merges,
  renumber.

**C. Answering.**

- `POST …/threads/:pool/:id/questions/:n/answer { option }` posts the user's
  message `<label>`. It carries a reply mark, `[Answer to q:<n>]`, which only
  lyricad writes, so she knows which question it answers. The message starts
  a turn as any user message does.
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
  questions, because two questions never share options.

**E. Guidance.** Add a few lines to the thread guidelines:

- Ask only for a fork that changes the user's goal, an output they will
  notice, or a step no one can undo.
- Ask once, on the card, and don't repeat the question in prose.
- Put the recommended option first.
- Keep working on the recommended option where the step can be undone, and
  stop where it can't.

## Out of scope

- Push notifications (item 3).
- A free-text field on the card, since typing in the thread already answers.
- More than one open question per thread.
- Questions from subagents.
- Questions asked by a routine run, which works as before.

## Done when

- `cleanAsk` refuses each limit, and accepts 2 and 4 options.
- A project's thread that asks shows Waiting on you on its parent card,
  wakes the project chat once, and appears in Notifications. A tap there
  answers it, and the thread wakes with `<label>` and the mark.
- In a plain chat: ask, then a typed answer closes the question as "words".
  Ask twice and the first card reads Withdrawn.
- A second tap on an answered question gets 409.
- The pool migration has a test from every released pool schema and keeps
  older readers working.
- Playwright on desktop and phone covers the card, a tap, the collapsed
  state and Notifications.
- docs/delegation.md, contracts, daemon, web and ux.md, plus this brief's
  handoff note, are updated in the same PR.

## Handoff notes

(None yet.)
