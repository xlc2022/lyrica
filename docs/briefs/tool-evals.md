# Brief: Question cards and checklists on every model

**Status:** Merged as #326 (8183255). Handoff notes below are history. **Branch:** `feature/tool-evals` (Codex), opened from `claude/agent-loop-reliability-661bmo`. **Built by:**
Codex on the test machine; the Agent loop thread (Opus) owns review and the PR.
**Read first:** AGENTS.md, PRINCIPLES.md, docs/briefs/question-card.md,
docs/briefs/truthful-continuation.md, docs/contracts.md (Child threads, the
`threads` tool), `evals/subagent-or-child.eval.ts`.

## Goal

The user asked how every model Lyrica uses, small local ones included, can
use question cards (`threads ask`) and the thread checklist (`threads steps`).
Every model already gets the same tool definitions. What differs is how well
it fills them in, and today a malformed call gets either Pi's generic schema
error or a short one from `cleanAsk`/`cleanSteps`. The user approved two
steps: specific, correctable errors (with a fallback for a question asked in
prose), and evals that show which models manage it. Principles 1 (a failure
seen in use) and 3 (lean on Pi's own hooks). Per AGENTS.md, structure is
used here instead of more prompt text.

## Change

### 1. Accept what is unambiguous, say exactly what is wrong otherwise

Small models often send a nested array as a JSON string, use a near-synonym
for an enum value, or name the recommended option instead of giving its index.
Pi validates a call against the schema before `execute`, so those fail as
`steps.0.state: must be equal to one of the allowed values`, which doesn't name
the allowed values.

- **One normalizer in core** (`core/src/threads.ts`), used both by the
  `threads` tool's `prepareArguments` (Pi runs it before validation) and by
  `cleanAsk`, because `readAsk` rebuilds the card from the stored raw call. It
  makes only these changes:
  - `options` or `steps` given as a JSON string that parses to an array
    becomes that array;
  - a step's `state` of `in_progress`, `in progress`, `active` or `started`
    becomes `doing`, `pending` or `not started` becomes `todo`, and
    `complete`, `completed` or `finished` becomes `done` (ignoring case);
  - a `recommended` that is a string equal, ignoring case, to exactly one
    option's label becomes that option's index;
  - a step given as a bare string becomes `{ text: <string>, state: "todo" }`.
  Nothing else is guessed. A missing consequence, for example, stays an error.
- **Specific errors**, thrown from `prepareArguments` before Pi's
  validation, or from `cleanAsk`/`cleanSteps`. Each one names the field and
  the position, says what was received (its type, never its text) and what is
  allowed, and ends with a one-line shape of a valid call. For example:
  `options[2] is a string; each option is { label, consequence }. Example:
  threads({ action: "ask", question, options: [{ label, consequence }, …],
  recommended: 0 })`, or `steps[1].state is not one of todo, doing, done`.
  It covers only `ask` and `steps`; other actions keep their current errors.
- An error is a tool result marked as an error (Pi already does this for a
  throw), so the model can correct the call on its next step in the same turn.
  No new retry logic.

### 2. A question asked in prose instead of on a card

A reply has the prose-question shape when it ends in either of these:
- a paragraph that is a question, followed only by its 2 to 4 list items;
- 2 to 4 list items followed only by a closing question.

List items are lines starting `-`, `*`, `1.`, `1)` or `A)`. A list in the
middle of a reply that ends with an unrelated question doesn't count.

The extension checks the shape on the `turn_end` whose assistant message has
no tool calls, and only when all of these hold:
- the thread can ask;
- no question is open;
- the turn made no `ask` call;
- it hasn't sent this follow-up already in this turn.

It then sends one follow-up the way delegate results are sent
(`extension/src/delegate/tool.ts`):
`pi.sendMessage({ customType: "lyrica-ask-nudge", content, display: false },
{ deliverAs: "followUp", triggerTurn: true })`. Its text is fixed: "Your reply
ends with a question offering options. If the person must choose before you
can go on, put it on a card with threads ask, and don't repeat it in prose;
otherwise carry on."

- `display: false`, so the person's conversation never shows it as if
  someone had typed it. No docs/ux.md change.
- It is synced into the thread's entries like any custom message, and
  context assembly drops `lyrica-ask-nudge` messages from earlier turns, so it
  costs nothing after the turn that used it.
- The check reads the reply's shape only and logs nothing of its text.

It runs on every model: approval was for every model, and it fires at most
once a turn, only on that shape, and only before the person has been asked.
It differs from the controller #304 rejected because it adds at most one
follow-up, and only when the tool that fixes the problem exists. (If the
extra call ever matters on cloud models, it could be limited to local
endpoints, which spend no quota.)

### 3. Evals that run against any model

Two scenarios, in the style of `evals/subagent-or-child.eval.ts`, with
made-up requests only:

- `evals/question-card.eval.ts`: three requests with a real fork, where a
  step can't be undone or the goal changes ("delete the old backups or move
  them?"), expecting a valid `threads ask`; and three plain questions,
  expecting no card.
- `evals/checklist.eval.ts`: three multi-step jobs, expecting a valid
  `threads steps` early in the turn; and three quick answers, expecting no
  checklist.

Each records the first relevant call, whether it passed validation the first
time, and, if it didn't, whether the model's corrected call after the error
passed. The run stops at the first valid call, or after one correction, so
nothing is asked or changed for real. The scripted run, with the fake model,
always runs in `npm run evals`. A real model needs `LYRICA_EVAL_BASE_URL` and
`LYRICA_EVAL_MODEL`, plus optional `LYRICA_EVAL_API_KEY`. A new
`LYRICA_EVAL_KIND=local` registers the endpoint as local, so an LM Studio or
llama.cpp model gets the same request shape as in use (`objectTools`,
`LOCAL_COMPAT`). A miss is evidence about that model, not a broken build.

## Tests

- core: the normalizer's accepted shapes, and each specific error (field,
  position, no echoed text).
- extension: a fake model sends `ask` with options as a JSON string and gets
  a card; sends a bad state and gets the specific error, then a corrected call
  succeeds in the same turn.
- extension: a turn ending in each of the two prose-question shapes gets
  exactly one hidden follow-up, and the next turn gets none and no longer
  carries it. A list mid-reply followed by an unrelated question, a question
  without options, or a turn that already asked gets none.

## Out of scope

- Running the evals on real models. LM Studio models need the user's
  explicit go, and cloud models spend quota and need the user's yes.
- Routing by eval result (marking a model as not tool-capable), which was
  step 4 of the plan and is not approved.
- Changing the tool descriptions or the definition ceilings.

## Docs

docs/contracts.md (the `threads` tool: what `ask` and `steps` accept and
the follow-up), docs/delegation.md where it describes question cards and
checklists, `evals/` as listed in docs/contracts.md, and this brief's
handoff.

## Handoff

- **Done:** the normalizer and specific errors for `ask` and `steps`, the
  hidden follow-up for a prose question, and both evals, with tests and
  docs. Built by Codex on the test machine with fake models only; the
  daemon checklist test now expects the specific `steps[0].state` error.
  Typecheck, the touched tests and `npm run evals` (14 passed, 5 optional
  real-model checks skipped) pass.
- **LM Studio run (2026-10-18, test machine, qwen3.8-flash-next, 28c010b):**
  question card: 2 of 3 forks asked with a valid card the first time, and
  none needed a correction. The third ("publish publicly or keep private,
  ask before publishing") got a plain reply with no card and no
  prose-question shape. No plain question got a card. Checklist: the job
  that was reported made a valid `steps` call the first time, and no quick
  question got a checklist. All requests returned 200.
- **Next:** cloud models wait on the user's yes, because they spend quota.
  No code change follows from this run.
