# Brief: Recall relevance

**Status:** Merged as #340 (176903a).

**Thread:** Recall relevance. **Branch:** `claude/project-thread-qwhegg`.
**Model:** Opus. **Read first:** AGENTS.md, docs/memory.md.

## Problem

She brought unrelated work into small talk. Asked "Hi Lyrica, do you have a
body?", she answered, then raised a test repo's default branch, and in an
earlier thread claimed the same question had been asked "last week".

Causes, checked in the code:

- Automatic recall OR's the message's words and always injects the top five
  hits, however weak. "Hi Lyrica, do you have a body?" became `hi OR lyrica
  OR body`. Her name is in nearly everything, and the tokenizer splits
  `lyrica-relay-test` into `lyrica relay test`, so the greeting matched the
  branch conversation.
- Recall hits carried no date, so she guessed when an earlier conversation
  happened.
- Nothing told her that recall and WAKE are background. WAKE lists what's
  unresolved and sits in every conversation.

The slips "you're pointed me at" and "call up a web" are in no persona file or
prompt: they come from the serving model.

## In scope

1. Automatic recall leaves out her name (`selfName`) and greetings, and keeps
   a hit only when it holds at least two of the message's words, when the
   message has three or more. A two-word floor on shorter messages dropped
   relevant hits ("how is the sourdough starter?" lost "Rye flour works best
   for my starter").
2. Every recall hit shows its date.
3. One `recall` guideline: recall and WAKE are background; she raises other
   work only when the message is about it or the person asks what's open,
   and doesn't guess a date.

Principles: 1 (the user noticed it in conversation) and 5 (spend the effort
on recall quality). Budgets unchanged.

## Out of scope

Embeddings or other ranking changes; WAKE's content; the thread titler, which
improves once replies stay on topic.

## Handoff

Done: all three, with tests in `core/test/store.test.ts` and
`extension/test/pins.test.ts`; docs/memory.md and docs/contracts.md updated.
Merged as #340. Open: whether the two-word floor drops useful recall in
practice; the evals would show it.
