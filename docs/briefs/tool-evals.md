# Brief: Question cards and checklists on every model

**Status:** brief in review. **Branch:** `feature/tool-evals`. **Built by:**
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
  - a step given as a bare string becomes a `todo` step.
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

When a turn would end with a reply whose last paragraph is a question, the
reply lists 2 to 4 options (lines starting `-`, `*`, `1.`, `1)` or `A)`),
the thread can ask, no question is open, and the turn made no `ask` call,
the daemon queues one follow-up through Pi's `agent.followUp`. Its text is
fixed: "Your reply ends with a question offering options. If the person must
choose before you can go on, put it on a card with threads ask, and don't
repeat it in prose; otherwise carry on." This happens at most once a turn.
The check is structural, on the reply's shape, and never reads the reply
into a log.

#304 rejected a controller that keeps taking turns. This is different: it
adds at most one follow-up, only when that shape appears and the tool to fix
it exists. If review finds a follow-up too costly on cloud
models, the alternative is to do it on local endpoints only, which costs no
quota.

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
- daemon: a turn ending in a prose question with options gets exactly one
  follow-up and none on the next turn. One that ends in a question without
  options, or that already asked, gets none.

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

- **Done:** brief.
- **Next:** PR review of the brief, then the Codex build on the test
  machine, queued after push notifications.
