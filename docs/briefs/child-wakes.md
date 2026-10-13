# Brief: Child threads wake an idle parent

**Branch:** `feature/child-wakes`. **Approved:** by the user, 2026-10-13.

**Read first:** AGENTS.md, PRINCIPLES.md, DESIGN.md (child threads),
docs/delegation.md ("Child threads", "Told when a child ends"),
docs/contracts.md (the threads section near "once per user, checked on
start"), `daemon/src/children.ts`, `extension/src/delegate/tool.ts`.

## Problem

A child thread finished without messaging its parent. The daemon did tell the
parent ("finished without a report"), and the user then told the child to
report, but both are delivered by `Delegation.deliver`, and `deliverVia` in
`extension/src/delegate/tool.ts` appends them to an idle parent without
starting a turn. The parent never looks, so the work looks lost. A weak local
model also skips the "post an update when you finish" guideline.

## Change

1. What wakes an idle parent, for one turn (`triggerTurn: true`): a child's
   question or `needsYou` message, the daemon's notes ("finished without a
   report", "stopped with an error", "didn't start"), and a child's report
   at the end of its task (its turn ends idle after it messaged the parent,
   so the parent hears that it is done). Plain progress updates are appended
   as today and wake nobody. Subagent run results keep today's behaviour.
2. Guards. The wake-up guards hold: nothing while the project is paused, the
   concurrency limit holds, and a bad end wakes its parent once until the
   child reports or the person writes in it (`noticed`). Coalescing: while a
   woken parent turn is queued or running, more child messages join it
   instead of adding turns.
   No loop: a parent turn started by a child's message can't start a turn in
   that child through its own reply. The reply is appended, and the child
   sees it on its next turn or when the person writes in it.
3. Tighten the child guideline in `core/src/threads.ts`
   (`PROJECT_THREAD_GUIDELINES`, and the equivalent for children outside a
   project): "Always end with a message to the parent: the result, or what
   blocked you."

## Principle

Principle 1 (long work doesn't swallow a conversation) needs the parent to
hear of finished work. Don't rely on the model alone: the daemon note plus the
wake is the structural part.

## Docs to update in the same PR

docs/delegation.md (delivery section and "Told when a child ends"),
docs/contracts.md (threads/delivery lines), DESIGN.md child-thread bullet,
and docs/briefs/child-threads.md if it describes the old behaviour. The PR
body says which.

## Tests

Idle parent gets a turn when a child asks, ends with a report, or ends without
a report; a progress update, a paused project and a repeated bad end do not
wake; a subagent result into an idle parent still doesn't. Three quick child
messages give at most one parent turn. A parent woken by a child that replies
to it starts no child turn.

## Build

Codex on lunasa, one at a time through the install thread's test queue; no
parallel test runs.

## Handoff notes

(The building thread fills this in if it stops before it's done.)
